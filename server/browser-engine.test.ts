import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_BROWSER_VERSION, agentBrowserReleaseUrl, resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { agentBrowserIntegration, browserEngineEncryptionKey, browserEngineStatus, browserSessionId, closeAgentBrowserSession, installAgentBrowserBinary, pinnedBinaryPath, resolveAgentBrowserBinary, verifyAgentBrowserBinary } from "./browser-engine.ts";

const scratch: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "murage-browser-test-")); scratch.push(path); return path; }
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixtureAsset(body: Buffer) { return { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length }; }

describe("optional browser resolver and installation", () => {
  it("resolves explicit executable before PATH, rejects bad override and directories", () => {
    const dataDir = temporary();
    const name = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
    const pathBinary = join(dataDir, name);
    const override = join(dataDir, "override");
    writeFileSync(pathBinary, "fixture", { mode: 0o700 });
    writeFileSync(override, "fixture", { mode: 0o700 });
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir } })).toBe(pathBinary);
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: override } })).toBe(override);
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: dataDir } })).toBeNull();
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: join(dataDir, "missing") } })).toBeNull();
    expect(browserEngineStatus({ dataDir, env: { PATH: dataDir } })).toMatchObject({ kind: "ready", version: null, runtimeVerified: false });
    if (process.platform !== "win32") {
      chmodSync(override, 0o600);
      expect(resolveAgentBrowserBinary({ dataDir, env: { MURAGE_AGENT_BROWSER_PATH: override } })).toBeNull();
    }
  });
  it("does not trust a tampered file merely because it occupies the pinned path", () => {
    const dataDir = temporary();
    const pinned = pinnedBinaryPath(dataDir);
    mkdirSync(join(pinned, ".."), { recursive: true });
    writeFileSync(pinned, "wrong binary", { mode: 0o700 });
    expect(resolveAgentBrowserBinary({ dataDir, env: {} })).toBeNull();
    expect(browserEngineStatus({ dataDir, env: {}, platform: "freebsd" })).toMatchObject({ kind: "unavailable", installable: false });
  });
  it("retains all seven release pins and the exact version URL", () => {
    for (const [platform, arch, musl] of [["darwin", "arm64", false], ["darwin", "x64", false], ["linux", "arm64", false], ["linux", "x64", false], ["linux", "arm64", true], ["linux", "x64", true], ["win32", "x64", false]] as const) {
      const asset = resolveAgentBrowserReleaseAsset(platform, arch, musl)!;
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(asset.bytes).toBeGreaterThan(12_000_000);
      expect(agentBrowserReleaseUrl(asset)).toBe(platform === "win32"
        ? "https://github.com/milind-soni/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.1/agent-browser-win32-x64-0.36.0-omb.1.exe"
        : `https://github.com/vercel-labs/agent-browser/releases/download/v0.36.0/${asset.asset}`);
    }
  });
  it("promotes only exact size/digest downloads, preserving an existing binary on rejection", async () => {
    const dataDir = temporary();
    const body = Buffer.from("fixture executable bytes");
    const asset = fixtureAsset(body);
    const destination = await installAgentBrowserBinary({ dataDir, asset, fetchImpl: async () => new Response(body) });
    expect(readFileSync(destination)).toEqual(body);
    for (const bad of [Buffer.from("short"), Buffer.alloc(body.length, 1), Buffer.alloc(body.length + 1)]) {
      await expect(installAgentBrowserBinary({ dataDir, asset, fetchImpl: async () => new Response(bad) })).rejects.toThrow(/size|SHA-256/u);
      expect(readFileSync(destination)).toEqual(body);
    }
    expect(readdirSync(join(destination, ".."))).toEqual([process.platform === "win32" ? "agent-browser.exe" : "agent-browser"]);
  });
  it("cancels an oversized streaming response before consuming more bytes", async () => {
    const dataDir = temporary();
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
    await expect(installAgentBrowserBinary({ dataDir, asset: fixtureAsset(Buffer.from("tiny")), fetchImpl: async () => new Response(stream) })).rejects.toThrow(/pinned size/u);
    expect(cancelled).toBe(true);
    expect(existsSync(pinnedBinaryPath(dataDir))).toBe(false);
  });
});

describe("protected browser state", () => {
  it("creates exclusively, reuses the owner-only key, and refuses corruption without changing bytes", () => {
    const dataDir = temporary();
    const file = join(dataDir, "browser-engine-key");
    const key = browserEngineEncryptionKey(dataDir);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(browserEngineEncryptionKey(dataDir)).toBe(key);
    if (process.platform !== "win32") expect(lstatSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "corrupt");
    expect(() => browserEngineEncryptionKey(dataDir)).toThrow(/refusing to regenerate/u);
    expect(readFileSync(file, "utf8")).toBe("corrupt");
  });
  it.skipIf(process.platform === "win32")("refuses unreadable, shared-mode and symbolic-link keys", () => {
    const dataDir = temporary();
    const file = join(dataDir, "browser-engine-key");
    const key = browserEngineEncryptionKey(dataDir);
    chmodSync(file, 0);
    expect(() => browserEngineEncryptionKey(dataDir)).toThrow(/refusing to regenerate/u);
    chmodSync(file, 0o644);
    expect(() => browserEngineEncryptionKey(dataDir)).toThrow(/refusing to regenerate/u);
    expect(readFileSync(file, "utf8").trim()).toBe(key);
    const other = temporary();
    symlinkSync(file, join(other, "browser-engine-key"));
    expect(() => browserEngineEncryptionKey(other)).toThrow(/refusing to regenerate/u);
  });
  it("separates realms, profiles, colliding names, and every guest invocation", () => {
    expect(browserSessionId("a", "profile", "realm")).toBe(browserSessionId("b", "profile", "realm"));
    expect(browserSessionId("a", "", "realm")).not.toBe(browserSessionId("b", "", "realm"));
    expect(browserSessionId("a", "a/b", "realm")).not.toBe(browserSessionId("a", "a_b", "realm"));
    expect(browserSessionId("a", "profile", "realm")).not.toBe(browserSessionId("a", "profile", "restored"));
    expect(browserSessionId("a", "guest", "realm")).not.toBe(browserSessionId("a", "guest", "realm"));
    expect(() => browserSessionId("a", "p", "")).toThrow(/realm/u);
  });
  it("isolates engine storage, disables guest persistence, and does not copy ambient auth/browser overrides", () => {
    const dataDir = temporary();
    const input = { dataDir, realmId: "realm", binaryPath: "/fixture/agent-browser", encryptionKey: "a".repeat(64), session: browserSessionId("a", "profile", "realm"), env: { PATH: "/bin", AGENT_BROWSER_PROFILE: "/real/profile", TOKEN: "secret" } };
    const spec = agentBrowserIntegration(input);
    scratch.push(spec.env.AGENT_BROWSER_SOCKET_DIR!);
    expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    expect(spec.env.HOME).toContain(dataDir);
    expect(spec.env.AGENT_BROWSER_RESTORE).toBe(input.session);
    expect(spec.env.TOKEN).toBeUndefined();
    expect(spec.env.AGENT_BROWSER_PROFILE).toBeUndefined();
    const restored = agentBrowserIntegration({ ...input, realmId: "restored" });
    scratch.push(restored.env.AGENT_BROWSER_SOCKET_DIR!);
    expect(restored.env.HOME).not.toBe(spec.env.HOME);
    expect(restored.env.AGENT_BROWSER_SOCKET_DIR).not.toBe(spec.env.AGENT_BROWSER_SOCKET_DIR);
    const guest = agentBrowserIntegration({ ...input, session: browserSessionId("a", "guest", "realm") });
    expect(guest.env.AGENT_BROWSER_RESTORE_SAVE).toBe("never");
    expect(guest.env.AGENT_BROWSER_RESTORE).toBeUndefined();
  });
});

describe("owned engine process commands", () => {
  it.skipIf(process.platform === "win32")("verifies the actual version and closes only the named session with isolated env", async () => {
    const dataDir = temporary();
    const binary = join(dataDir, "fixture-engine");
    const receipt = join(dataDir, "receipt");
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'agent-browser ${AGENT_BROWSER_VERSION}'; else printf '%s\\n' "$@" > "$RECEIPT"; fi\n`, { mode: 0o700 });
    await expect(verifyAgentBrowserBinary(binary, { PATH: "/bin" })).resolves.toBeUndefined();
    await closeAgentBrowserSession({ command: binary, args: [], env: { RECEIPT: receipt, AGENT_BROWSER_SESSION: "owned-session" } });
    expect(readFileSync(receipt, "utf8")).toBe("--session\nowned-session\nclose\n");
    writeFileSync(binary, "#!/bin/sh\necho agent-browser 0.1.0\n", { mode: 0o700 });
    await expect(verifyAgentBrowserBinary(binary, { PATH: "/bin" })).rejects.toThrow(/0.36.0/u);
  });
});
