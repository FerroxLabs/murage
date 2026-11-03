// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineManager, type ManagedEngineInstance } from "./engine-management.ts";
import { CLAUDE_RELEASES, claudeNativeTarget, codexNativeTarget, extractTarPackage, extractZipPackage, nativeInstallEnv, type NativeRun } from "./engine-native-install.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeTempDir(root))); vi.unstubAllEnvs(); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// A Windows file system keeps no execute bit: chmod there cannot set 0o700, and a stat reads 0o666. So the owner-only and
// executable modes are checked on a Mac or Linux host, and a Mac or Linux package (whose rg must carry its execute bit, or it
// is refused) is installed only there. A Windows host installs the Windows package, the one it would really get.
const POSIX_HOST = process.platform !== "win32";
const HOST_PACKAGE: NodeJS.Platform = POSIX_HOST ? "linux" : "win32";
const scratch = async () => { const root = await mkdtemp(join(tmpdir(), "murage-native-install-")); roots.push(root); return root; };

function bodyOf(bytes: Uint8Array, chunks = 3): Response {
  const size = Math.ceil(bytes.length / chunks) || 1;
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.subarray(at, at + size));
    controller.close();
  } }));
}

function claudeFixture(options: { binary?: Uint8Array; checksum?: string; size?: number; state?: string; version?: string | null; busy?: () => boolean; found?: boolean; run?: NativeRun } = {}) {
  const binary = options.binary ?? Buffer.from("claude native binary bytes");
  const manifest = { version: "2.1.316", platforms: { "darwin-arm64": { binary: "claude", checksum: options.checksum ?? sha(binary), size: options.size ?? binary.length } } };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url === `${CLAUDE_RELEASES}/latest`) return new Response("2.1.316\n");
    if (url === `${CLAUDE_RELEASES}/2.1.316/manifest.json`) return new Response(JSON.stringify(manifest));
    if (url === `${CLAUDE_RELEASES}/2.1.316/darwin-arm64/claude`) return bodyOf(binary);
    throw new Error(`unexpected ${url}`);
  });
  const instance: ManagedEngineInstance = { instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: options.state ?? "unavailable", version: options.version ?? null } };
  const seen: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; mode?: number; bytes?: string }> = [];
  const run = vi.fn<NativeRun>(async (command, args, cwd, env) => {
    seen.push({ command, args, env, mode: (await stat(command)).mode & 0o777, bytes: sha(await readFile(command)) });
    if (options.run) return options.run(command, args, cwd, env);
    if (options.found !== false) { instance.snapshot.state = "available"; instance.snapshot.version = "2.1.316 (Claude Code)"; }
    return "ok";
  });
  const resetProbes = vi.fn();
  return { binary, calls, fetchStub, instance, run, seen, resetProbes, make: (root: string) => new EngineManager({ root, getInstance: async id => id === "claude" ? instance : undefined,
    isBusy: options.busy ?? (() => false), activate: vi.fn(), platform: "darwin", arch: "arm64", fetch: fetchStub as typeof fetch, run, resetProbes, envPath: "/usr/bin" }) };
}

describe("Claude Code native install", () => {
  it("reads the vendor's three URLs, refuses redirects on each, checks, runs `install stable`, removes the download and re-probes", async () => {
    const root = await scratch(), f = claudeFixture(), manager = f.make(root);
    const status = await manager.install("claude");
    expect(f.calls.map(call => call.url)).toEqual([`${CLAUDE_RELEASES}/latest`, `${CLAUDE_RELEASES}/2.1.316/manifest.json`, `${CLAUDE_RELEASES}/2.1.316/darwin-arm64/claude`]);
    expect(f.calls.every(call => call.init?.redirect === "error")).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.seen[0]!.args).toEqual(["install", "stable"]);
    expect(f.seen[0]!.bytes).toBe(sha(f.binary));
    if (POSIX_HOST) expect(f.seen[0]!.mode).toBe(0o700);
    expect(await readdir(root)).toEqual([]);
    expect(f.resetProbes).toHaveBeenCalled();
    expect(status.installedVersion).toBe("2.1.316");
    expect(status.progress).toBeUndefined();
  });
  it("activates nothing: Claude finds its own place", async () => {
    const activate = vi.fn(), root = await scratch(), f = claudeFixture();
    const manager = new EngineManager({ root, getInstance: async () => f.instance, isBusy: () => false, activate, platform: "darwin", arch: "arm64", fetch: f.fetchStub as typeof fetch, run: f.run });
    await manager.install("claude");
    expect(activate).not.toHaveBeenCalled();
    expect(f.instance.cli).toBeUndefined();
  });
  it("a checksum failure runs nothing and leaves nothing", async () => {
    const root = await scratch(), f = claudeFixture({ checksum: "0".repeat(64) });
    await expect(f.make(root).install("claude")).rejects.toThrow("could not be installed");
    expect(f.run).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it("a wrong size runs nothing and leaves nothing, longer or shorter", async () => {
    for (const size of [5, 500]) {
      const root = await scratch(), f = claudeFixture({ size });
      await expect(f.make(root).install("claude")).rejects.toThrow("could not be installed");
      expect(f.run).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    }
  });
  it("a failed install still removes the download, and says nothing of the vendor's output", async () => {
    const root = await scratch(), f = claudeFixture({ run: async () => { throw new Error("/secret/path said no"); } });
    const failure = await f.make(root).install("claude").catch((error: Error) => error) as Error;
    expect(failure.message).toBe("Claude Code could not be installed. Check your connection and try again.");
    expect(await readdir(root)).toEqual([]);
  });
  it("refuses an http or unlisted manifest row before any download", async () => {
    const root = await scratch(), f = claudeFixture();
    f.fetchStub.mockImplementationOnce(async () => new Response("<html>"));
    await expect(f.make(root).install("claude")).rejects.toThrow("could not be installed");
    expect(f.fetchStub).toHaveBeenCalledOnce();
  });
  it("a redirect the fetch refuses ends the install", async () => {
    const root = await scratch(), f = claudeFixture();
    f.fetchStub.mockImplementation(async (_input, init) => { expect(init?.redirect).toBe("error"); throw new TypeError("fetch failed: unexpected redirect"); });
    await expect(f.make(root).install("claude")).rejects.toThrow("could not be installed");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("never reinstalls an engine already here, in any state", async () => {
    for (const present of [{ state: "available", version: "2.1.316" }, { state: "unavailable", version: "2.0.1" }]) {
      const root = await scratch(), f = claudeFixture(present);
      await f.make(root).install("claude");
      expect(f.fetchStub).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }
  });
  it("refuses while tasks run, and a second press while one is running", async () => {
    const root = await scratch(), f = claudeFixture({ busy: () => true });
    await expect(f.make(root).install("claude")).rejects.toThrow("running tasks");
    expect(f.fetchStub).not.toHaveBeenCalled();
    let release!: () => void;
    const held = claudeFixture({ run: () => new Promise(resolve => { release = () => resolve("ok"); }), found: false });
    const manager = held.make(root), first = manager.install("claude").catch((error: Error) => error.message);
    await vi.waitFor(() => expect(held.run).toHaveBeenCalled());
    await expect(manager.install("claude")).rejects.toThrow("running tasks");
    release();
    held.instance.snapshot.version = "2.1.316"; held.instance.snapshot.state = "available";
    await first;
  });
  it("status reports byte progress during the download without probing the engine, and says so when the launcher is not found", async () => {
    const root = await scratch(), seen: unknown[] = [];
    const f = claudeFixture({ binary: Buffer.alloc(9000, 7), found: false });
    const manager = f.make(root);
    const getInstance = vi.fn(async () => f.instance);
    (manager as unknown as { deps: { getInstance: unknown } }).deps.getInstance = getInstance;
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => { const before = getInstance.mock.calls.length; seen.push(await manager.status("claude")); expect(getInstance.mock.calls.length).toBe(before); return original(...args); });
    await expect(manager.install("claude")).rejects.toThrow("Check again");
    expect(seen).toEqual([{ supported: true, installedVersion: null, updateAvailable: false, message: "", busy: true, progress: { phase: "install", received: 9000, total: 9000 } }]);
  });
  it("clears what a crash left, on the next press", async () => {
    const root = await scratch(), f = claudeFixture();
    await writeFile(join(root, "download-left"), "stale");
    await f.make(root).install("claude");
    expect(await readdir(root)).toEqual([]);
  });
  it("names the vendor's own targets", () => {
    expect(claudeNativeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(claudeNativeTarget("win32", "arm64")).toBe("win32-arm64");
    expect(claudeNativeTarget("linux", "x64", () => false)).toBe("linux-x64");
    expect(claudeNativeTarget("linux", "arm64", () => true)).toBe("linux-arm64-musl");
    expect(claudeNativeTarget("freebsd", "x64")).toBeNull();
    expect(claudeNativeTarget("linux", "ia32")).toBeNull();
  });
});

describe("the binary's environment", () => {
  it("is an explicit list: no NODE_OPTIONS, ELECTRON_*, MURAGE_*, keys or proxies", async () => {
    vi.stubEnv("NODE_OPTIONS", "--require /evil.js"); vi.stubEnv("ELECTRON_RUN_AS_NODE", "1"); vi.stubEnv("MURAGE_DATA_DIR", "/data");
    vi.stubEnv("ANTHROPIC_API_KEY", "key"); vi.stubEnv("HTTPS_PROXY", "http://p"); vi.stubEnv("HOME", "/home/owner");
    const root = await scratch(), f = claudeFixture();
    await f.make(root).install("claude");
    const env = f.seen[0]!.env!;
    expect(env.PATH).toBe("/usr/bin"); expect(env.HOME).toBe("/home/owner");
    expect(Object.keys(env).filter(name => /^(NODE_|ELECTRON_|MURAGE_|ANTHROPIC_)|PROXY/i.test(name))).toEqual([]);
    expect(Object.keys(nativeInstallEnv({ temp: "/t", source: { NODE_OPTIONS: "x", FOO: "y" } })).sort()).toEqual(["PATH", "TEMP", "TMP", "TMPDIR"]);
  });
});

function tar(entries: Array<{ name: string; data?: Buffer; type?: string; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, data = Buffer.alloc(0), type = "0", mode = 0o755 } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0); header.write(mode.toString(8).padStart(7, "0") + "\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.write(type, 156); header.write("ustar\x0000", 257);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function zip(entries: Array<{ name: string; data?: Buffer; mode?: number }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const { name, data = Buffer.alloc(0), mode } of entries) {
    const packed = deflateRawSync(data), nameBytes = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(((mode ?? 0) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes); offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const elfX64 = () => { const elf = Buffer.alloc(64); elf.set([0x7f, 69, 76, 70, 2, 1]); elf.writeUInt16LE(0x3e, 18); return elf; };
const peX64 = () => { const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68); return pe; };

const manifest = (over: Record<string, string> = {}) => Buffer.from(JSON.stringify({ version: "1.2.0", target: "x86_64-unknown-linux-musl", entrypoint: "bin/codex", pathDir: "codex-path", ...over }));
const TAG = "https://api.github.com/repos/openai/codex/releases/tags/rust-v1.2.0";
const ASSET_HOST = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=1";
function codexFixture(options: { platform?: NodeJS.Platform; archive?: Buffer; digest?: string; size?: number; probe?: string; location?: string; busy?: () => boolean; hops?: number; activateFails?: boolean; otherClis?: (id: string) => readonly string[] } = {}) {
  const platform = options.platform ?? "linux", windows = platform === "win32";
  const target = windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-musl";
  const name = windows ? `codex-${target}.exe.zip` : `codex-package-${target}.tar.gz`;
  const archive = options.archive ?? (windows
    ? zip([{ name: "bin/", mode: 0o040755 }, { name: "codex-path/", mode: 0o040755 }, { name: "codex-path/rg.exe", data: Buffer.from("rg") }, { name: `codex-${target}.exe`, data: peX64() }, { name: "codex-package.json", data: Buffer.from(JSON.stringify({ version: "1.2.0", target, entrypoint: `codex-${target}.exe`, pathDir: "codex-path" })) }, { name: "codex-resources/codex-windows-sandbox-setup.exe", data: Buffer.from("helper") }])
    : tar([{ name: "bin/", type: "5" }, { name: "bin/codex", data: elfX64(), mode: 0o755 }, { name: "codex-path/", type: "5" }, { name: "codex-path/rg", data: Buffer.from("rg"), mode: 0o755 },
        { name: "codex-resources/bwrap", data: Buffer.from("bwrap"), mode: 0o755 }, { name: "codex-resources/NOTICE.md", data: Buffer.alloc(0) },
        { name: "codex-package.json", data: Buffer.from(JSON.stringify({ version: "1.2.0", target, entrypoint: "bin/codex", pathDir: "codex-path" })) }]));
  const url = `https://github.com/openai/codex/releases/download/rust-v1.2.0/${name}`;
  const calls: Array<{ url: string; redirect?: string }> = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const asked = String(input); calls.push({ url: asked, redirect: init?.redirect });
    if (asked.includes("registry.npmjs.org")) return new Response(JSON.stringify({ version: "1.2.0" }));
    if (asked === TAG) return new Response(JSON.stringify({ tag_name: "rust-v1.2.0", draft: false, prerelease: false, assets: [
      { name: `${name}.sig`, size: 1, digest: `sha256:${"1".repeat(64)}`, browser_download_url: `${url}.sig` },
      { name, size: options.size ?? archive.length, digest: options.digest ?? `sha256:${sha(archive)}`, browser_download_url: url }] }));
    if (asked === url) return new Response(null, { status: 302, headers: { location: options.location ?? ASSET_HOST } });
    if (asked === (options.location ?? ASSET_HOST)) return options.hops ? new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) : bodyOf(archive);
    throw new Error(`unexpected ${asked}`);
  });
  const instance: ManagedEngineInstance = { instanceId: "codex", driverKind: "codex", cli: "/preserved/old", snapshot: { state: "available", version: "codex-cli 1.0.0" } };
  const activate = vi.fn(async (_id: string, cli: string) => { if (options.activateFails) throw new Error("no"); instance.cli = cli; instance.snapshot.version = "1.2.0"; });
  const seen: Array<{ command: string; env?: NodeJS.ProcessEnv; bytes: Buffer; mode: number }> = [];
  const run = vi.fn<NativeRun>(async (command, _args, _cwd, env) => { seen.push({ command, env, bytes: await readFile(command), mode: (await stat(command)).mode & 0o777 }); return options.probe ?? "codex-cli 1.2.0"; });
  return { calls, fetchStub, instance, activate, run, seen, url, make: (root: string) => new EngineManager({ root, getInstance: async () => instance, isBusy: options.busy ?? (() => false), activate, platform, arch: "x64", fetch: fetchStub as typeof fetch, run, envPath: "/usr/bin", otherClis: options.otherClis ?? (() => []) }) };
}

describe("Codex native install", () => {
  it.skipIf(!POSIX_HOST)("takes the release's listed digest, follows GitHub's one redirect by hand, and proves --version before activating", async () => {
    const root = await scratch(), f = codexFixture();
    await f.make(root).install("codex");
    expect(f.calls.find(call => call.url === f.url)?.redirect).toBe("manual");
    expect(f.calls.find(call => call.url === ASSET_HOST)?.redirect).toBe("error");
    expect(f.seen[0]!.command.endsWith("/codex")).toBe(true);
    expect(f.seen[0]!.mode).toBe(0o700);
    expect(f.seen[0]!.bytes.equals(elfX64())).toBe(true);
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.instance.cli).toBe(f.seen[0]!.command);
    expect(await readdir(root)).toHaveLength(1);
    expect((await readdir(root))[0]).toMatch(/^codex-1\.2\.0-/);
  });
  it("runs no npm: Node is not needed", async () => {
    const root = await scratch(), f = codexFixture({ platform: HOST_PACKAGE });
    await f.make(root).install("codex");
    expect(f.run.mock.calls.map(call => call[1])).toEqual([["--version"]]);
  });
  it("keeps the Windows package together and runs the entrypoint it names", async () => {
    const root = await scratch(), f = codexFixture({ platform: "win32" });
    await f.make(root).install("codex");
    const cli = f.instance.cli!;
    expect(cli).toMatch(/codex-x86_64-pc-windows-msvc\.exe$/);
    expect(existsSync(join(cli, "..", "codex-resources", "codex-windows-sandbox-setup.exe"))).toBe(true);
    expect((await readdir(root)).filter(name => name.startsWith("download-"))).toEqual([]);
  });
  it("a checksum failure runs nothing, activates nothing, leaves nothing", async () => {
    const root = await scratch(), f = codexFixture({ digest: `sha256:${"0".repeat(64)}` });
    await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
    expect(f.run).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
    expect(f.instance.cli).toBe("/preserved/old");
    expect(await readdir(root)).toEqual([]);
  });
  it("a wrong size leaves nothing", async () => {
    const root = await scratch(), f = codexFixture({ size: 3 });
    await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
    expect(await readdir(root)).toEqual([]);
  });
  it("refuses a redirect anywhere but GitHub's asset store, over HTTPS, and any second hop", async () => {
    for (const options of [{ location: "https://evil.example/codex" }, { location: "http://release-assets.githubusercontent.com/x" }, { hops: 1 }]) {
      const root = await scratch(), f = codexFixture(options);
      await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
      expect(f.calls.some(call => call.url.includes("evil.example") && !options.location)).toBe(false);
      expect(f.calls.filter(call => call.url.startsWith("http://"))).toEqual([]);
      expect(f.run).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    }
  });
  it("a version mismatch keeps the engine and removes the candidate", async () => {
    const root = await scratch(), f = codexFixture({ probe: "codex-cli 0.0.1", platform: HOST_PACKAGE });
    await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
    expect(f.run).toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });
  it("an executable for another computer is never run", async () => {
    const archive = tar([{ name: "bin/codex", data: peX64() }, { name: "codex-path/rg", data: Buffer.from("rg") }, { name: "codex-package.json", data: manifest() }]);
    const root = await scratch(), f = codexFixture({ archive });
    await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
    expect(f.run).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(!POSIX_HOST)("takes the whole package on Mac and Linux: rg and bwrap land beside the entrypoint, and the bare asset is never asked for", async () => {
    const root = await scratch(), f = codexFixture();
    await f.make(root).install("codex");
    expect(f.url).toMatch(/\/codex-package-x86_64-unknown-linux-musl\.tar\.gz$/);
    expect(f.instance.cli).toMatch(/[\\/]bin[\\/]codex$/);
    expect((await stat(join(f.instance.cli!, "..", "..", "codex-path", "rg"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.instance.cli!, "..", "..", "codex-resources", "bwrap"))).mode & 0o777).toBe(0o700);
  });
  it("an owner on a newer Codex keeps it: nothing is fetched from the release, run or activated", async () => {
    const root = await scratch(), f = codexFixture();
    f.instance.snapshot.version = "codex-cli 9.0.0";
    await f.make(root).install("codex");
    expect(f.activate).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.url === TAG)).toBe(false);
  });
  it("a package with no rg, or a manifest for another release, is never run", async () => {
    const elf = elfX64(), rg = { name: "codex-path/rg", data: Buffer.from("rg") }, cli = { name: "bin/codex", data: elf };
    for (const archive of [tar([cli, { name: "codex-package.json", data: manifest() }]),
      tar([cli, { name: "codex-path/rg", data: Buffer.from("rg"), mode: 0o644 }, { name: "codex-package.json", data: manifest() }]),
      tar([cli, rg, { name: "codex-package.json", data: manifest({ version: "1.1.9" }) }]),
      tar([cli, rg, { name: "codex-package.json", data: manifest({ entrypoint: "codex-path/rg" }) }]), tar([cli, rg])]) {
      const root = await scratch(), f = codexFixture({ archive });
      await expect(f.make(root).install("codex")).rejects.toThrow("previous engine is unchanged");
      expect(f.run).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
    }
  });
  it("the managed package it replaced leaves once the new one is live; a custom engine stays, and a failed switch keeps the old one", async () => {
    const root = await scratch(), old = join(root, "codex-1.1.0-abc123", "bin"), f = codexFixture({ platform: HOST_PACKAGE });
    await mkdir(old, { recursive: true }); await writeFile(join(old, "codex"), "old");
    f.instance.cli = join(old, "codex");
    await f.make(root).install("codex");
    expect((await readdir(root)).filter(name => name.startsWith("codex-")).length).toBe(1);
    expect(existsSync(old)).toBe(false);
    const sharedRoot = await scratch(), both = join(sharedRoot, "codex-1.1.0-both", "bin"), s = codexFixture({ platform: HOST_PACKAGE, otherClis: () => [join(both, "codex")] });
    await mkdir(both, { recursive: true }); await writeFile(join(both, "codex"), "both");
    s.instance.cli = join(both, "codex");
    await s.make(sharedRoot).install("codex");
    expect(existsSync(join(both, "codex"))).toBe(true);
    const kept = await scratch(), mine = join(kept, "codex-1.1.0-mine", "bin"), other = codexFixture({ platform: HOST_PACKAGE });
    await mkdir(mine, { recursive: true }); await writeFile(join(mine, "codex"), "mine");
    other.instance.cli = join(mine, "codex");
    await other.make(await scratch()).install("codex");
    expect(existsSync(join(mine, "codex"))).toBe(true);
    const failing = await scratch(), held = join(failing, "codex-1.1.0-held", "bin"), stopped = codexFixture({ platform: HOST_PACKAGE, activateFails: true });
    await mkdir(held, { recursive: true }); await writeFile(join(held, "codex"), "held");
    stopped.instance.cli = join(held, "codex");
    await expect(stopped.make(failing).install("codex")).rejects.toThrow("did not complete");
    expect(existsSync(join(held, "codex"))).toBe(true);
  });
  it("tasks that start during the download stop the switch, and the candidate goes", async () => {
    let calls = 0; const root = await scratch(), f = codexFixture({ busy: () => ++calls > 1, platform: HOST_PACKAGE });
    await expect(f.make(root).install("codex")).rejects.toThrow("unchanged");
    expect(f.run).toHaveBeenCalled(); expect(calls).toBe(2); expect(f.activate).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });
  it("runs --version with a pinned env and an empty home", async () => {
    vi.stubEnv("NODE_OPTIONS", "x"); vi.stubEnv("ELECTRON_RUN_AS_NODE", "1"); vi.stubEnv("MURAGE_SECRET", "x"); vi.stubEnv("OPENAI_API_KEY", "x");
    const root = await scratch(), f = codexFixture({ platform: HOST_PACKAGE });
    await f.make(root).install("codex");
    const env = f.seen[0]!.env!;
    expect(Object.keys(env).filter(name => /^(NODE_|ELECTRON_|MURAGE_|OPENAI_)/.test(name))).toEqual([]);
    // the download folder sits under realpath(root): on a Windows runner that is the long form of an 8.3 temp path
    expect(env.HOME).toContain(await realpath(root)); expect(env.CODEX_HOME).toContain("codex-home");
  });
  it("lists a target for each computer it installs on", () => {
    expect(codexNativeTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexNativeTarget("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(codexNativeTarget("win32", "arm64")).toBeNull();
  });
});

describe("archives", () => {
  const onDisk = async (bytes: Buffer) => { const root = await scratch(), file = join(root, "archive"); await writeFile(file, bytes); return { root, file }; };
  it("tar: a path that leaves its folder refuses the archive", async () => {
    for (const name of ["../evil", "/etc/evil", "a/../../evil", "a\\evil", "bad:stream"]) {
      const { root, file } = await onDisk(tar([{ name, data: Buffer.from("x") }, { name: "codex", data: Buffer.from("y") }]));
      await expect(extractTarPackage(file, join(root, "out"))).rejects.toThrow("outside its own folder");
      expect(existsSync(join(root, "out"))).toBe(false);
      expect(existsSync(join(root, "evil"))).toBe(false);
    }
  });
  it("tar: a link or any other kind of entry is refused, wherever it sits", async () => {
    for (const entries of [[{ name: "codex", type: "2" }], [{ name: "other", type: "1" }, { name: "codex", data: Buffer.from("y") }]]) {
      const { root, file } = await onDisk(tar(entries));
      await expect(extractTarPackage(file, join(root, "out"))).rejects.toThrow("link");
    }
    const { root, file } = await onDisk(tar([{ name: "fifo", type: "6" }]));
    await expect(extractTarPackage(file, join(root, "out"))).rejects.toThrow("not a plain file");
  });
  it("tar: a pax record is skipped unread, so a path inside one places nothing", async () => {
    const pax = Buffer.from("20 path=../evil\n");
    const { root, file } = await onDisk(tar([{ name: "././@PaxHeader", type: "x", data: pax }, { name: "codex", data: Buffer.from("y") }, { name: "././@PaxHeader", type: "g", data: pax }]));
    await extractTarPackage(file, join(root, "out"));
    expect(await readdir(join(root, "out"))).toEqual(["codex"]);
    expect(existsSync(join(root, "evil"))).toBe(false);
  });
  it("tar: a duplicate, an over-long list and a cut archive are refused", async () => {
    const twice = await onDisk(tar([{ name: "codex", data: Buffer.from("y") }, { name: "codex", data: Buffer.from("z") }]));
    await expect(extractTarPackage(twice.file, join(twice.root, "out"))).rejects.toThrow();
    const many = await onDisk(tar(Array.from({ length: 513 }, (_, index) => ({ name: `f${index}`, data: Buffer.from("x") }))));
    await expect(extractTarPackage(many.file, join(many.root, "out"))).rejects.toThrow("size limit");
    const whole = tar([{ name: "codex", data: Buffer.alloc(4096, 1) }]);
    const cut = await onDisk(gzipSync(gunzipSync(whole).subarray(0, 1024)));
    await expect(extractTarPackage(cut.file, join(cut.root, "out"))).rejects.toThrow("incomplete");
  });
  it("tar: the package lands whole with its exact bytes, owner-only, and the vendor's executables stay executable", async () => {
    const { root, file } = await onDisk(tar([{ name: "bin/", type: "5" }, { name: "bin/codex", data: Buffer.alloc(1300, 3), mode: 0o755 }, { name: "readme", data: Buffer.alloc(700, 2), mode: 0o644 }, { name: "empty", data: Buffer.alloc(0), mode: 0o755 }]));
    const out = join(root, "out");
    await extractTarPackage(file, out);
    expect((await readFile(join(out, "bin/codex"))).equals(Buffer.alloc(1300, 3))).toBe(true);
    if (POSIX_HOST) {
      expect((await stat(join(out, "bin/codex"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(out, "readme"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(out, "empty"))).mode & 0o777).toBe(0o700);
    }
  });
  it("zip: a path that leaves its folder, a link, and an odd name are refused", async () => {
    for (const entry of [{ name: "../evil.exe", data: Buffer.from("x") }, { name: "/abs.exe", data: Buffer.from("x") }, { name: "a/../../evil", data: Buffer.from("x") }, { name: "bad:stream", data: Buffer.from("x") }, { name: "link", data: Buffer.from("/etc/passwd"), mode: 0o120777 }]) {
      const { root, file } = await onDisk(zip([entry]));
      const folder = join(root, "package");
      await expect(extractZipPackage(file, folder)).rejects.toThrow();
      expect(existsSync(folder)).toBe(false);
      expect(existsSync(join(root, "evil.exe"))).toBe(false);
    }
  });
});
