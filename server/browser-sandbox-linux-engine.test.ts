// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The AppImage's Enable browser path: ONE administrator step (pkexec) that
// copies the verified bundled Chrome to /usr/local/lib/murage/browser-engine,
// root-owned with no group or other write, checks it by hash after the copy,
// and installs the one AppArmor profile that names exactly that path. The app
// launches Chrome from there and refuses a path anyone else could change.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserBundleSpec, CHROME_VERSION } from "./browser-bundle-release.ts";
import {
  enableLinuxEngineBrowser, ensureLinuxEngineChrome, isTrustedEnginePath, LINUX_ENGINE_ENABLE_SCRIPT, LINUX_ENGINE_PROFILE_FILE, LINUX_ENGINE_ROOT,
  LinuxEngineNotInstalled, linuxEngineBrowserProfile, linuxEngineChromePath, linuxEngineEnablePlan, linuxEngineInventoryText, verifyLinuxEngineCopy,
} from "./browser-sandbox-linux-engine.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) removeTempDirSync(directory); });
const temporary = (prefix: string) => { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory; };

/** The manifest inventory scripts/prepare-browser.mjs writes, for a fixture. */
function bundleInventory(root: string): unknown[] {
  const out: unknown[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), path = relative(root, file), stat = lstatSync(file);
      if (path === "manifest.json") continue;
      if (stat.isSymbolicLink()) out.push({ path, kind: "symlink", target: readlinkSync(file) });
      else if (stat.isDirectory()) { out.push({ path, kind: "directory" }); visit(file); }
      else out.push({ path, kind: "file", bytes: stat.size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
    }
  };
  visit(root);
  return out;
}
/** A browser bundle shaped like Murage's: manifest.json plus chrome/chrome-headless-shell-linux64/. */
function fakeBundle(options: { link?: boolean } = {}): { bundle: string; chrome: string } {
  const bundle = temporary("murage-home-bundle-");
  const chromeDirectory = join(bundle, "chrome", "chrome-headless-shell-linux64");
  mkdirSync(join(chromeDirectory, "locales"), { recursive: true });
  const chrome = join(chromeDirectory, "chrome-headless-shell");
  writeFileSync(chrome, "#!/bin/sh\nexit 0\n"); chmodSync(chrome, 0o755);
  writeFileSync(join(chromeDirectory, "libEGL.so"), "library");
  writeFileSync(join(chromeDirectory, "locales", "en-US.pak"), "strings");
  if (options.link) symlinkSync("libEGL.so", join(chromeDirectory, "libGLESv2.so"));
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ chrome: { executableSha256: browserBundleSpec("linux-x64").chrome.executableSha256 }, files: bundleInventory(bundle) }));
  return { bundle, chrome };
}
const profileBlock = (text: string, name: string) => new RegExp(`^profile ${name} (\\S+) flags=\\(([^)]*)\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(text);
const rules = (body: string) => body.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#") && !line.startsWith("include if exists"));
const CHROME_DIRECTORY = "chrome-headless-shell-linux64";
const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
type Inventory = Parameters<typeof verifyLinuxEngineCopy>[1];
/** The fixture bundle's Chrome folder inventory, relative to that folder. */
function chromeInventory(bundle: string): Inventory {
  const prefix = `chrome/${CHROME_DIRECTORY}/`;
  return (JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")).files as { path: string }[])
    .filter(entry => entry.path.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) })) as Inventory;
}
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("the system profile", () => {
  const template = readFileSync(new URL("../build/linux-apparmor-profile.tpl", import.meta.url), "utf8");
  it("has the .deb murage-browser profile's flags and rules", () => {
    const deb = profileBlock(template, "murage-browser")!, mine = profileBlock(linuxEngineBrowserProfile(), "murage-browser-engine")!;
    expect(mine[2]).toBe(deb[2]);
    expect(rules(mine[3]!)).toEqual(rules(deb[3]!));
    expect(rules(mine[3]!)).toEqual(["userns,"]);
    expect(linuxEngineBrowserProfile().startsWith("abi <abi/4.0>,\ninclude <tunables/global>\n")).toBe(true);
  });
  it("names only the one exact path under /usr/local/lib/murage, never a home folder or a pattern", () => {
    const profile = linuxEngineBrowserProfile(), attach = profileBlock(profile, "murage-browser-engine")![1]!;
    expect(attach).toBe(`/usr/local/lib/murage/browser-engine/${CHROME_VERSION}/chrome-headless-shell-linux64/chrome-headless-shell`);
    expect(linuxEngineChromePath()).toBe(attach);
    expect(linuxEngineChromePath("1.2.3.4", "/tmp/x")).toBe("/tmp/x/1.2.3.4/chrome-headless-shell-linux64/chrome-headless-shell");
    expect(attach).toMatch(/^\/usr\/local\/lib\/murage\/browser-engine\/\d+(\.\d+){3}\/chrome-headless-shell-linux64\/chrome-headless-shell$/u);
    expect(profile).not.toMatch(/@\{|\/home|\.local|HOME|\*/u);
    expect(LINUX_ENGINE_PROFILE_FILE).toBe("/etc/apparmor.d/murage-browser-engine");
    expect(LINUX_ENGINE_ROOT).toBe("/usr/local/lib/murage/browser-engine");
  });
  const parser = ["/usr/sbin/apparmor_parser", "/sbin/apparmor_parser"].find(file => existsSync(file));
  it.skipIf(!parser)("parses with this system's AppArmor", () => {
    const file = join(temporary("murage-engine-profile-"), "murage-browser-engine");
    writeFileSync(file, linuxEngineBrowserProfile());
    const result = spawnSync(parser!, ["--skip-kernel-load", "--skip-cache", "--debug", file], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("leaves no copy in the home folder: the module has no home path in it", () => {
    const source = readFileSync(new URL("./browser-sandbox-linux-engine.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/homedir|\.local\/share|MURAGE_HOMES|ensureLinuxHomeChrome/u);
  });
});

describe.skipIf(process.platform !== "linux")("the system copy", () => {
  /** A root folder (owned by the test user, standing in for root) holding a good copy. */
  function installedCopy() {
    const { bundle, chrome } = fakeBundle(), base = temporary("murage-engine-"), root = join(base, "lib", "murage", "browser-engine");
    mkdirSync(join(root, CHROME_VERSION), { recursive: true, mode: 0o755 });
    cpSync(dirname(chrome), join(root, CHROME_VERSION, CHROME_DIRECTORY), { recursive: true, verbatimSymlinks: true });
    for (const dir of [join(base, "lib"), join(base, "lib", "murage"), root, join(root, CHROME_VERSION), join(root, CHROME_VERSION, CHROME_DIRECTORY), join(root, CHROME_VERSION, CHROME_DIRECTORY, "locales")]) chmodSync(dir, 0o755);
    const deps = { root, trust: { owner: uid }, top: base };
    return { bundle, chrome, base, root, deps, copy: join(root, CHROME_VERSION, CHROME_DIRECTORY) };
  }

  it("is trusted only when every folder is a plain folder, owned by the administrator, with no group or other write", () => {
    const { copy, base } = installedCopy();
    expect(isTrustedEnginePath(copy, { owner: uid }, base)).toBe(true);
    expect(isTrustedEnginePath(copy, { owner: uid + 1 }, base)).toBe(false);
    for (const mode of [0o775, 0o757, 0o777]) {
      chmodSync(dirname(copy), mode);
      expect(isTrustedEnginePath(copy, { owner: uid }, base), mode.toString(8)).toBe(false);
    }
    chmodSync(dirname(copy), 0o755);
    expect(isTrustedEnginePath(join(base, "missing"), { owner: uid }, base)).toBe(false);
  });
  it("is not trusted through a link in the path", () => {
    const { copy, base, root } = installedCopy();
    const link = join(base, "link");
    symlinkSync(root, link);
    expect(isTrustedEnginePath(join(link, CHROME_VERSION, CHROME_DIRECTORY), { owner: uid }, base)).toBe(false);
    expect(isTrustedEnginePath(copy, { owner: uid }, base)).toBe(true);
  });

  it("returns the fixed path for a verified, administrator-owned copy and writes nothing itself", async () => {
    const { chrome, deps, root } = installedCopy();
    expect(await ensureLinuxEngineChrome(chrome, deps)).toBe(linuxEngineChromePath(CHROME_VERSION, root));
    const missing = temporary("murage-engine-empty-");
    await expect(ensureLinuxEngineChrome(chrome, { root: join(missing, "none"), trust: { owner: uid }, top: missing })).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
    expect(existsSync(join(missing, "none"))).toBe(false);
  });
  it("refuses a copy with a changed file, an extra file, a group-writable file, a link in the way or another owner, and asks again next time", async () => {
    const { chrome, deps, copy } = installedCopy();
    const pak = join(copy, "locales", "en-US.pak");
    writeFileSync(pak, "tampered");
    await expect(ensureLinuxEngineChrome(chrome, deps)).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
    writeFileSync(pak, "strings");
    expect(await ensureLinuxEngineChrome(chrome, deps)).toBe(linuxEngineChromePath(CHROME_VERSION, deps.root));
    const fresh = installedCopy();
    writeFileSync(join(fresh.copy, "extra.so"), "x");
    await expect(ensureLinuxEngineChrome(fresh.chrome, fresh.deps)).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
    const writable = installedCopy();
    chmodSync(join(writable.copy, "libEGL.so"), 0o664);
    await expect(ensureLinuxEngineChrome(writable.chrome, writable.deps)).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
    const other = installedCopy();
    await expect(ensureLinuxEngineChrome(other.chrome, { ...other.deps, trust: { owner: uid + 1 } })).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
    const linked = installedCopy();
    const real = join(linked.root, "real");
    cpSync(join(linked.root, CHROME_VERSION), real, { recursive: true });
    removeTempDirSync(join(linked.root, CHROME_VERSION));
    symlinkSync(real, join(linked.root, CHROME_VERSION));
    await expect(ensureLinuxEngineChrome(linked.chrome, linked.deps)).rejects.toBeInstanceOf(LinuxEngineNotInstalled);
  });
  it("refuses a bundle whose manifest is not the pinned Chrome", async () => {
    const { bundle, chrome, deps } = installedCopy();
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ chrome: { executableSha256: "0".repeat(64) }, files: [] }));
    await expect(ensureLinuxEngineChrome(chrome, deps)).rejects.toThrow(/pinned release/u);
  });

  it("verifies a copy against the manifest, with the owner and write bits when asked", () => {
    const { bundle, chrome } = fakeBundle();
    const inventory = chromeInventory(bundle), source = dirname(chrome);
    expect(verifyLinuxEngineCopy(source, inventory)).toBe(true);
    expect(verifyLinuxEngineCopy(source, inventory, { owner: uid + 1 })).toBe(false);
    writeFileSync(join(source, "extra.so"), "x");
    expect(verifyLinuxEngineCopy(source, inventory)).toBe(false);
    expect(verifyLinuxEngineCopy(join(source, "missing"), inventory)).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("the plan Enable browser hands the administrator step", () => {
  it("is the version, the profile, the manifest lines and the pinned executable hash, for a checked bundle", () => {
    const { bundle, chrome } = fakeBundle();
    const plan = linuxEngineEnablePlan(chrome);
    expect(plan.source).toBe(dirname(chrome));
    expect(plan.args).toEqual([CHROME_VERSION, linuxEngineBrowserProfile(), linuxEngineInventoryText(chromeInventory(bundle)), browserBundleSpec("linux-x64").chrome.executableSha256]);
    expect(plan.args[2]).toContain(`f\t${sha256(chrome)}\tchrome-headless-shell`);
    expect(plan.args[2]).toContain("d\tlocales");
  });
  it("refuses a bundle whose files do not match its manifest", () => {
    const { chrome } = fakeBundle();
    writeFileSync(join(dirname(chrome), "libEGL.so"), "tampered");
    expect(() => linuxEngineEnablePlan(chrome)).toThrow(/damaged/u);
  });
  it("refuses a bundle that holds a link: only files and folders are installed", () => {
    const { bundle } = fakeBundle({ link: true });
    expect(() => linuxEngineInventoryText(chromeInventory(bundle))).toThrow(/can't install/u);
  });
});

describe("Enable browser", () => {
  const plan = () => ({ source: "/bundled/chrome-headless-shell-linux64", args: ["152.0.0.1", "PROFILE", "d\tlocales", "abc"] });
  it("runs one pkexec step: the script, then the plan, with the bundled Chrome folder as the stream", async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: "" }));
    expect(await enableLinuxEngineBrowser("/bundled/chrome-headless-shell-linux64/chrome-headless-shell", { run, exists: () => true, plan })).toBe("enabled");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/usr/bin/pkexec", ["/bin/sh", "-c", LINUX_ENGINE_ENABLE_SCRIPT, "murage-enable-browser", "152.0.0.1", "PROFILE", "d\tlocales", "abc"], "/bundled/chrome-headless-shell-linux64");
  });
  it("changes nothing when the prompt is closed or refused", async () => {
    for (const code of [126, 127]) expect(await enableLinuxEngineBrowser("/x", { run: async () => ({ code, stderr: "" }), exists: () => true, plan })).toBe("cancelled");
  });
  it("says what failed and keeps the .deb alternative", async () => {
    const failure = await enableLinuxEngineBrowser("/x", { run: async () => ({ code: 1, stderr: "the copied browser does not match the browser bundle\n" }), exists: () => true, plan }).catch((error: unknown) => error) as Error & { status?: number };
    expect(failure.status).toBe(500);
    expect(failure.message).toContain("does not match the browser bundle");
    expect(failure.message).toContain("install Murage from the .deb package");
    const none = await enableLinuxEngineBrowser("/x", { exists: () => false, plan }).catch((error: unknown) => error) as Error & { status?: number };
    expect(none.status).toBe(409);
    expect(none.message).toContain("pkexec");
  });
  it("has the script copy as the administrator, check the hash after the copy, and name nothing in a home folder", () => {
    expect(LINUX_ENGINE_ENABLE_SCRIPT).toContain("root=/usr/local/lib/murage/browser-engine");
    expect(LINUX_ENGINE_ENABLE_SCRIPT).toContain("owner=root:root");
    expect(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("sha256sum")).toBeGreaterThan(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("tar --extract"));
    expect(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("sha256sum")).toBeLessThan(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("mv -T"));
    expect(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("mv -T")).toBeLessThan(LINUX_ENGINE_ENABLE_SCRIPT.indexOf("apparmor_parser --replace"));
    expect(LINUX_ENGINE_ENABLE_SCRIPT).not.toMatch(/\/home|\.local|HOME/u);
  });
});

/** The administrator script itself, run for real on a temporary tree standing in for / (the user stands in for root). */
describe.skipIf(process.platform !== "linux")("the administrator script", () => {
  const tools = ["tar", "find", "sha256sum", "awk", "mktemp", "head", "sort", "mv", "rm", "chmod", "chown", "mkdir", "dirname", "printf"];
  const haveTools = tools.every(tool => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0) && spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU");
  function setup(parser = "#!/bin/sh\necho \"$*\" >> \"$0.log\"\n") {
    const base = temporary("murage-engine-run-"), etc = join(base, "etc-apparmor.d"), bin = join(base, "bin"), root = join(base, "lib", "murage", "browser-engine");
    mkdirSync(etc); mkdirSync(bin);
    writeFileSync(join(bin, "apparmor_parser"), parser); chmodSync(join(bin, "apparmor_parser"), 0o755);
    const script = LINUX_ENGINE_ENABLE_SCRIPT.replace("owner=root:root", `owner=${uid}:${gid}`).replace("top=/\n", `top=${base}\n`).replace(`root=${LINUX_ENGINE_ROOT}`, `root=${root}`).replaceAll("/etc/apparmor.d", etc);
    const { bundle, chrome } = fakeBundle();
    const run = (overrides: { tar?: Buffer; inventory?: string; exeSha?: string; version?: string } = {}) => {
      const tar = overrides.tar ?? spawnSync("tar", ["-C", dirname(chrome), "-cf", "-", "."], { maxBuffer: 1 << 26 }).stdout;
      return spawnSync("/bin/sh", ["-c", script, "murage-enable-browser", overrides.version ?? CHROME_VERSION, linuxEngineBrowserProfile(overrides.version ?? CHROME_VERSION), overrides.inventory ?? linuxEngineInventoryText(chromeInventory(bundle)), overrides.exeSha ?? sha256(chrome)],
        { input: tar, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` }, maxBuffer: 1 << 26 });
    };
    return { base, etc, bin, root, run, bundle, chrome, final: join(root, CHROME_VERSION, CHROME_DIRECTORY), profileFile: join(etc, "murage-browser-engine") };
  }
  const leftovers = (root: string) => existsSync(root) ? readdirSync(root).filter(name => name.startsWith(".copy-")) : [];

  it.skipIf(!haveTools)("installs the checked tree and the profile, replaces an older version, and loads the profile last", () => {
    const t = setup();
    mkdirSync(join(t.root, "140.0.0.1", CHROME_DIRECTORY), { recursive: true });
    mkdirSync(join(t.root, "notes"));
    mkdirSync(join(t.root, CHROME_VERSION, "stale"), { recursive: true });
    mkdirSync(join(t.root, ".copy-old"));
    const result = t.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(t.final, "chrome-headless-shell"), "utf8")).toBe(readFileSync(t.chrome, "utf8"));
    expect(existsSync(join(t.root, CHROME_VERSION, "stale"))).toBe(false);
    expect(existsSync(join(t.root, "140.0.0.1"))).toBe(false);
    expect(existsSync(join(t.root, "notes"))).toBe(true);
    expect(leftovers(t.root)).toEqual([]);
    // dirs 0755, files 0755 or 0644, owned by the administrator, no group or other write anywhere
    const modes: string[] = [];
    const visit = (path: string) => {
      const stat = lstatSync(path);
      expect(stat.uid).toBe(uid);
      expect(stat.mode & 0o022, path).toBe(0);
      expect(stat.isSymbolicLink(), path).toBe(false);
      modes.push(`${stat.isDirectory() ? "d" : "f"}${(stat.mode & 0o7777).toString(8)}`);
      if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    };
    visit(join(t.root, CHROME_VERSION));
    expect(new Set(modes)).toEqual(new Set(["d755", "f755", "f644"]));
    expect(lstatSync(join(t.final, "chrome-headless-shell")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(t.final, "libEGL.so")).mode & 0o7777).toBe(0o644);
    expect(readFileSync(t.profileFile, "utf8")).toBe(linuxEngineBrowserProfile());
    const calls = readFileSync(join(t.bin, "apparmor_parser.log"), "utf8").trim().split("\n");
    expect(calls[0]).toMatch(/^--skip-kernel-load --skip-cache .*\.murage-browser-engine\./u);
    expect(calls[1]).toBe(`--replace --write-cache --skip-read-cache ${t.profileFile}`);
  });
  it.skipIf(!haveTools)("installs nothing when a copied file does not match the manifest hash", () => {
    const t = setup();
    const result = t.run({ inventory: linuxEngineInventoryText(chromeInventory(t.bundle)).replace(sha256(join(dirname(t.chrome), "libEGL.so")), "0".repeat(64)) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("wrong hash");
    expect(existsSync(join(t.root, CHROME_VERSION))).toBe(false);
    expect(existsSync(t.profileFile)).toBe(false);
    expect(leftovers(t.root)).toEqual([]);
  });
  it.skipIf(!haveTools)("installs nothing when the Chrome is not the pinned release", () => {
    const t = setup();
    const result = t.run({ exeSha: "0".repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pinned release");
    expect(existsSync(join(t.root, CHROME_VERSION))).toBe(false);
    expect(existsSync(t.profileFile)).toBe(false);
  });
  it.skipIf(!haveTools)("installs nothing for a stream with an extra file, a link, or a name outside its folder", () => {
    for (const mutate of [
      (dir: string) => writeFileSync(join(dir, "extra.so"), "x"),
      (dir: string) => symlinkSync("/etc", join(dir, "etc-link")),
      (dir: string) => symlinkSync("libEGL.so", join(dir, "alias.so")),
      (dir: string) => linkSync(join(dir, "libEGL.so"), join(dir, "hard.so")),
    ]) {
      const t = setup(), copy = temporary("murage-engine-stream-");
      cpSync(dirname(t.chrome), join(copy, "c"), { recursive: true, verbatimSymlinks: true });
      mutate(join(copy, "c"));
      const tar = spawnSync("tar", ["-C", join(copy, "c"), "-cf", "-", "."], { maxBuffer: 1 << 26 }).stdout;
      const result = t.run({ tar });
      expect(result.status, result.stderr).not.toBe(0);
      expect(existsSync(join(t.root, CHROME_VERSION))).toBe(false);
      expect(existsSync(t.profileFile)).toBe(false);
      expect(leftovers(t.root)).toEqual([]);
    }
    const t = setup(), copy = temporary("murage-engine-stream-");
    mkdirSync(join(copy, "in"));
    writeFileSync(join(copy, "in", "x"), "x");
    const escaped = spawnSync("tar", ["-C", join(copy, "in"), "-cf", "-", "-P", "--transform", "s,^x$,../escape,", "x"], { maxBuffer: 1 << 20 }).stdout;
    expect(t.run({ tar: escaped }).status).not.toBe(0);
    expect(existsSync(join(t.base, "lib", "murage", "escape"))).toBe(false);
  });
  it.skipIf(!haveTools)("refuses a folder on the path that is a link or that others can write, writing nothing through it", () => {
    const linked = setup(), elsewhere = join(linked.base, "elsewhere");
    mkdirSync(join(linked.base, "lib"), { recursive: true }); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(linked.base, "lib", "murage"));
    const first = linked.run();
    expect(first.status).not.toBe(0);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(linked.profileFile)).toBe(false);
    for (const mode of [0o775, 0o757]) {
      const writable = setup();
      mkdirSync(join(writable.base, "lib", "murage"), { recursive: true });
      chmodSync(join(writable.base, "lib", "murage"), mode);
      const second = writable.run();
      expect(second.status, mode.toString(8)).not.toBe(0);
      expect(second.stderr).toContain("only");
      expect(existsSync(writable.profileFile)).toBe(false);
    }
  });
  it.skipIf(!haveTools)("leaves no profile when AppArmor cannot parse it", () => {
    const t = setup("#!/bin/sh\necho 'syntax error' >&2\nexit 1\n");
    const result = t.run();
    expect(result.status).not.toBe(0);
    expect(existsSync(t.profileFile)).toBe(false);
    expect(readdirSync(t.etc)).toEqual([]);
  });
  it.skipIf(!haveTools)("rejects a version that is not digits and dots", () => {
    const t = setup();
    const result = t.run({ version: "../x" });
    expect(result.status).not.toBe(0);
    expect(existsSync(t.profileFile)).toBe(false);
  });
});
