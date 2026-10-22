import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { browserEngineRefusesHost } from "./testing/browser-host.ts";
const macAdmission = vi.hoisted(() => vi.fn());
const macState = vi.hoisted(() => ({ checking: false, unfinished: false, keepChecking: false, settleTo: "ok" as "ok" | "failed" | "unfinished", waited: 0, starts: [] as unknown[], waitArgs: [] as unknown[], startsAtWait: 0 }));
vi.mock("./browser-macos-identity.ts", () => ({ verifyPackagedMacBrowser: macAdmission, verifyPackagedMacBrowserAsync: async () => true, checkPackagedMacBrowserAsync: async (...args: unknown[]) => { macState.waited++; macState.waitArgs = args; macState.startsAtWait = macState.starts.length; if (!macState.keepChecking) macState.checking = false; if (macState.settleTo === "ok") macAdmission.mockReturnValue(true); else if (macState.settleTo === "unfinished") macState.unfinished = true; return macState.settleTo; }, packagedMacBrowserState: (...args: unknown[]) => (macState.starts.push(args[2]), macState.checking) ? "checking" : macState.unfinished ? "unfinished" : macAdmission(...args) ? "ok" : "failed" }));
import { AGENT_BROWSER_VERSION, agentBrowserReleaseUrl, resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { CLAUDE_TOOL_SURFACE, renderMurageTools } from "./murage-tool-surface.ts";
import { BROWSER_CHECK_UNFINISHED_REASON, settledBrowserEngineStatus, ADMISSION_CACHE_TTL_MS, admissionWalkLimits, clearBrowserAdmissionCache, UNIFIED_BROWSER_SYSTEM_PROMPT, unifiedBrowserSystemPrompt, agentBrowserIntegration, BEFOREUNLOAD_GUARD_SCRIPT, browserEngineEncryptionKey, browserEngineStatus, packagedBrowserRefusedReason, browserSessionId, userChromeSessionId, closeAgentBrowserSession, installAgentBrowserBinary, pinnedBinaryPath, resolveAgentBrowserBinary, verifyAgentBrowserBinary } from "./browser-engine.ts";

const scratch: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "murage-browser-test-")); scratch.push(path); return path; }
afterEach(() => { clearBrowserAdmissionCache(); for (const path of scratch.splice(0)) removeTempDirSync(path); });
function fixtureAsset(body: Buffer) { return { target: "linux-x64", asset: "agent-browser-linux-x64", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length }; }

describe("optional browser resolver and installation", () => {
  it("admits a verified signed arm64 package with pinned version and never falls back when refused", () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    writeFileSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell"), "signed Chrome", { mode: 0o700 });
    const options = { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources, PATH: bundle } };
    macAdmission.mockReturnValue(true);
    expect(browserEngineStatus(options)).toMatchObject({ kind: "ready", version: AGENT_BROWSER_VERSION, runtimeVerified: false });
    expect(macAdmission).toHaveBeenCalledWith(resources, expect.any(String), true);
    macAdmission.mockReturnValue(false);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
  });
  // An installed app whose seal broke (a newer build copied over an older
  // one left stray files) still carries its browser. Telling the owner to
  // "install the optional browser engine" sent them the wrong way: nothing
  // they could install is ever consulted in a packaged app.
  it("says the built-in browser failed its check, and to reinstall, when the packaged one is refused", () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    macAdmission.mockReturnValue(false);
    const status = browserEngineStatus({ platform: "darwin", arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } });
    expect(status).toMatchObject({ kind: "unavailable", installable: false });
    expect(status.kind === "unavailable" && status.reason).toBe(packagedBrowserRefusedReason(resources, "darwin"));
  });
  // D6: while the signature check runs the owner sees plain "checking" copy, never the failure text.
  it("reads 'checking' while the packaged browser's signature check is still running", () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    macState.checking = true;
    try {
      const status = browserEngineStatus({ platform: "darwin", arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } });
      expect(status).toMatchObject({ kind: "unavailable", checking: true, installable: false });
      expect(status.kind === "unavailable" && status.reason).toContain("checking");
      expect(status.kind === "unavailable" && status.reason).not.toMatch(/didn't pass|Reinstall/);
    } finally { macState.checking = false; }
  });
  // 1.0.2: a check that could not finish is not a refusal. It never says "reinstall", and the next attempt asks again.
  it("gives a plain 'still checking' message, not the reinstall one, when the signature check could not finish", () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    writeFileSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell"), "signed Chrome", { mode: 0o700 });
    const options = { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } };
    macState.unfinished = true;
    try {
      const status = browserEngineStatus(options);
      expect(status).toMatchObject({ kind: "unavailable", unfinished: true, installable: false });
      expect(status.kind === "unavailable" && status.reason).toBe(BROWSER_CHECK_UNFINISHED_REASON);
      expect(status.kind === "unavailable" && status.reason).not.toMatch(/didn't pass|Reinstall|\u2014/);
    } finally { macState.unfinished = false; }
    macAdmission.mockReturnValue(false);
    const refused = browserEngineStatus(options);
    expect(refused.kind === "unavailable" && refused.reason).toBe(packagedBrowserRefusedReason(resources, "darwin"));   // a real refusal still says reinstall
    macAdmission.mockReturnValue(true);
    expect(browserEngineStatus(options).kind).toBe("ready");          // the next attempt checks again; nothing was remembered
  });
  it("lets a turn wait for a running check and then use the browser", async () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    writeFileSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell"), "signed Chrome", { mode: 0o700 });
    const options = { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } };
    macState.checking = true; macState.settleTo = "ok"; macState.waited = 0;
    try {
      expect(browserEngineStatus(options)).toMatchObject({ checking: true });
      expect(await settledBrowserEngineStatus(options)).toMatchObject({ kind: "ready" });
      expect(macState.waited).toBe(1);
    } finally { macState.checking = false; macAdmission.mockReset(); }
  });
  // 1.0.2 review: the wait reports the outcome it awaited. Its last look never starts a new signature check, and the turn can cancel it and give a short budget.
  it("ends a turn's wait without starting another check, passes the budget and cancel, and says when it could not finish", async () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    writeFileSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell"), "signed Chrome", { mode: 0o700 });
    const options = { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } };
    macState.checking = true; macState.settleTo = "unfinished"; macState.waited = 0; macState.starts = [];
    const cancelled = () => false, noted: string[] = [];
    try {
      const status = await settledBrowserEngineStatus(options, { waitMs: 20_000, cancelled, onChecking: reason => noted.push(reason) });
      expect(status).toMatchObject({ kind: "unavailable", unfinished: true });
      expect(status.kind === "unavailable" && status.reason).toBe(BROWSER_CHECK_UNFINISHED_REASON);
      expect(macState.waitArgs.slice(2)).toEqual([20_000, cancelled]);   // short budget and the turn's own cancel reach the wait
      expect(noted).toHaveLength(1); expect(noted[0]).toContain("checking");   // progress is published before waiting
      expect(macState.starts.slice(0, macState.startsAtWait).every(start => start === true)).toBe(true);   // the looks before the wait may start the check
      expect(macState.starts.length).toBeGreaterThan(macState.startsAtWait);
      expect(macState.starts.slice(macState.startsAtWait).every(start => start === false)).toBe(true);     // every look after it never does
    } finally { macState.checking = false; macState.unfinished = false; macAdmission.mockReset(); }
  });
  // Astra r2: when the wait ends "unfinished" while the shared run is still going, the awaited outcome is reported, never a fresh "checking".
  it("reports the awaited 'unfinished' outcome even though the check is still running", async () => {
    const resources = temporary(), bundle = join(resources, "browser-engine");
    mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
    writeFileSync(join(bundle, "agent-browser"), "signed engine", { mode: 0o700 });
    writeFileSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell"), "signed Chrome", { mode: 0o700 });
    const options = { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } };
    macState.checking = true; macState.keepChecking = true; macState.settleTo = "unfinished"; macState.waited = 0; macState.starts = [];
    try {
      const status = await settledBrowserEngineStatus(options, { waitMs: 1 });
      expect(status).toMatchObject({ kind: "unavailable", unfinished: true });
      expect(status.kind === "unavailable" && status.checking).toBeFalsy();
      expect(status.kind === "unavailable" && status.reason).toBe(BROWSER_CHECK_UNFINISHED_REASON);
    } finally { macState.checking = false; macState.keepChecking = false; macState.unfinished = false; macAdmission.mockReset(); }
  });
  // D6: the check is the signature, not the path. A copy under /private/tmp fails because a copy loses its seal, and the message says to move the app.
  it("tells a Mac app running outside Applications to move the original there, and a normal install to reinstall", () => {
    const outside = packagedBrowserRefusedReason("/private/tmp/Murage.app/Contents/Resources", "darwin", "/Users/alex");
    expect(outside).toContain("Move the original Murage.app into Applications");
    expect(outside).toContain("didn't pass its signature check");
    expect(packagedBrowserRefusedReason("/Applications/Murage.app/Contents/Resources", "darwin", "/Users/alex")).toBe("The browser that comes with Murage didn't pass its signature check, so it wasn't started. Reinstall Murage from the download to fix it.");
    expect(packagedBrowserRefusedReason("/Users/alex/Applications/Murage.app/Contents/Resources", "darwin", "/Users/alex")).toContain("Reinstall Murage");
    expect(packagedBrowserRefusedReason("/Applications/Murage.app-copy/Contents/Resources", "darwin", "/Users/alex")).toContain("Move the original");
    expect(packagedBrowserRefusedReason("/private/tmp/Murage.app/Contents/Resources", "linux", "/home/x")).toContain("Reinstall Murage");
    expect(outside).not.toMatch(/safe|unsafe|—/i);
  });
  describe("packaged admission cache", () => {
    // Fixtures are created "now"; the cache refuses files touched in the last
    // 2s, so these tests run with the clock a minute ahead of real time.
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 60_000); });
    afterEach(() => { vi.useRealTimers(); });
    it("does not cache a bundle touched within the last 2 seconds", () => {
      vi.useRealTimers();
      const { options } = packaged();
      macAdmission.mockReset(); macAdmission.mockReturnValue(true);
      resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(2);
    });
    // Coarse filesystem timestamps: let the clock tick between a cached admission and a tamper.
    const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    function packaged() {
      const app = temporary(), resources = join(app, "Murage.app/Contents/Resources"), bundle = join(resources, "browser-engine");
      mkdirSync(join(bundle, "chrome/chrome-headless-shell-mac-arm64"), { recursive: true });
      mkdirSync(join(app, "Murage.app/Contents/_CodeSignature"), { recursive: true });
      writeFileSync(join(app, "Murage.app/Contents/_CodeSignature/CodeResources"), "seal");
      const engine = join(bundle, "agent-browser"), chrome = join(bundle, "chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell");
      mkdirSync(join(bundle, "licenses"));
      writeFileSync(join(bundle, "manifest.json"), "{}");
      writeFileSync(engine, "signed engine", { mode: 0o700 });
      writeFileSync(chrome, "signed Chrome", { mode: 0o700 });
      return { resources, engine, chrome, options: { platform: "darwin" as const, arch: "arm64", env: { MURAGE_RESOURCES_PATH: resources } } };
    }
    it("verifies once, then skips the codesign admission for the byte-identical bundle", () => {
      const { resources, engine, options } = packaged();
      macAdmission.mockReset(); macAdmission.mockReturnValue(true);
      expect(resolveAgentBrowserBinary(options)).toBe(engine);
      expect(macAdmission).toHaveBeenCalledTimes(1);
      expect(resolveAgentBrowserBinary(options)).toBe(engine);
      expect(browserEngineStatus(options).kind).toBe("ready");
      expect(macAdmission).toHaveBeenCalledTimes(1);
      expect(macAdmission).toHaveBeenCalledWith(resources, expect.any(String), true);
    });
    it("re-verifies when the engine, Chrome, seal or app identity changes (stale cache never admits a swapped binary)", () => {
      const { engine, chrome, options } = packaged();
      macAdmission.mockReset(); macAdmission.mockReturnValue(true);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(1);
      // Same-size content swap, as an attacker would do.
      tick(); writeFileSync(engine, "evil!! engine");
      macAdmission.mockReturnValue(false);
      expect(resolveAgentBrowserBinary(options)).toBeNull();
      expect(macAdmission).toHaveBeenCalledTimes(2);
      // A refusal is never cached, and a restored-and-admitted binary is cached afresh.
      macAdmission.mockReturnValue(true);
      expect(resolveAgentBrowserBinary(options)).toBe(engine);
      expect(macAdmission).toHaveBeenCalledTimes(3);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(3);
      tick(); writeFileSync(chrome, "tampered Chrome");
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(4);
      // A permission change re-verifies too. Windows chmod only flips the read-only
      // attribute (0o700 -> 0o755 changes nothing there), so it makes the file read-only.
      tick(); chmodSync(chrome, process.platform === "win32" ? 0o444 : 0o755);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(5);
      chmodSync(chrome, 0o700); // writable again, so the scratch folder can be removed on Windows
    });
    it("re-verifies when app.asar is rewritten in place at the same size (sealed payload is keyed)", () => {
      const { resources, options } = packaged();
      const asar = join(resources, "app.asar"), unpacked = join(resources, "app.asar.unpacked/node_modules/x");
      writeFileSync(asar, "signed asar!!");
      mkdirSync(unpacked, { recursive: true });
      const native = join(unpacked, "addon.node");
      writeFileSync(native, "signed addon");
      macAdmission.mockReset(); macAdmission.mockReturnValue(true);
      resolveAgentBrowserBinary(options);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 5_000);
      tick(); writeFileSync(asar, "evil!!  asar!");
      expect(readFileSync(asar).length).toBe("signed asar!!".length);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(2);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 5_000);
      tick(); writeFileSync(native, "evil addon!");
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(3);
    });
    // Chrome loads every file under browser-engine at run time; the key walks the whole tree.
    describe("covers the whole browser-engine tree", () => {
      const siblings = ["chrome/chrome-headless-shell-mac-arm64/libGLESv2.dylib", "chrome/chrome-headless-shell-mac-arm64/resources.pak", "chrome/chrome-headless-shell-mac-arm64/icudtl.dat", "licenses/LICENSE.chromium"];
      for (const sibling of siblings) {
        it(`re-verifies when ${sibling.split("/").pop()} is swapped at the same size`, () => {
          const { resources, options } = packaged();
          const file = join(resources, "browser-engine", sibling);
          writeFileSync(file, "signed bytes");
          macAdmission.mockReset(); macAdmission.mockReturnValue(true);
          resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
          expect(macAdmission).toHaveBeenCalledTimes(1);
          vi.setSystemTime(Date.now() + 5_000);
          tick(); writeFileSync(file, "evil!! bytes");
          resolveAgentBrowserBinary(options);
          expect(macAdmission).toHaveBeenCalledTimes(2);
        });
      }
      it("re-verifies when a file is added to or removed from the tree", () => {
        const { resources, options } = packaged();
        const extra = join(resources, "browser-engine/chrome/chrome-headless-shell-mac-arm64/libextra.dylib");
        macAdmission.mockReset(); macAdmission.mockReturnValue(true);
        resolveAgentBrowserBinary(options);
        vi.setSystemTime(Date.now() + 5_000);
        tick(); writeFileSync(extra, "planted");
        resolveAgentBrowserBinary(options);
        expect(macAdmission).toHaveBeenCalledTimes(2);
      });
      it("does not cache a tree containing a symlink", () => {
        const { resources, options } = packaged();
        symlinkSync("/etc/hosts", join(resources, "browser-engine/chrome/link.dylib"));
        macAdmission.mockReset(); macAdmission.mockReturnValue(true);
        resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
        expect(macAdmission).toHaveBeenCalledTimes(2);
      });
      it("caches nothing and verifies in full when the tree exceeds the entry cap or the time budget", () => {
        const { resources, options } = packaged();
        for (let index = 0; index < 20; index++) writeFileSync(join(resources, "browser-engine/chrome", `f${index}.pak`), "x");
        macAdmission.mockReset(); macAdmission.mockReturnValue(true);
        const saved = { ...admissionWalkLimits };
        try {
          admissionWalkLimits.maxEntries = 10;
          resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
          expect(macAdmission).toHaveBeenCalledTimes(2);
          Object.assign(admissionWalkLimits, saved, { budgetMs: -1 });
          resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
          expect(macAdmission).toHaveBeenCalledTimes(4);
        } finally { Object.assign(admissionWalkLimits, saved); }
        resolveAgentBrowserBinary(options); resolveAgentBrowserBinary(options);
        expect(macAdmission).toHaveBeenCalledTimes(5); // within bounds: cached once more
      });
      it("walks a large tree within the time budget", () => {
        const { resources, options } = packaged();
        const dir = join(resources, "browser-engine/chrome/locales");
        mkdirSync(dir);
        for (let index = 0; index < 1500; index++) writeFileSync(join(dir, `l${index}.pak`), "x");
        macAdmission.mockReset(); macAdmission.mockReturnValue(true);
        resolveAgentBrowserBinary(options);
        const began = performance.now();
        resolveAgentBrowserBinary(options);
        const elapsed = performance.now() - began;
        expect(macAdmission).toHaveBeenCalledTimes(1); // 1500 files fit the cap and the budget
        console.log(`browser-engine walk of ~1500 entries: ${elapsed.toFixed(1)} ms`);
        expect(elapsed).toBeLessThan(admissionWalkLimits.budgetMs * 2);
      });
    });
    it("re-verifies after the cache lifetime", () => {
      const { options } = packaged();
      macAdmission.mockReset(); macAdmission.mockReturnValue(true);
      resolveAgentBrowserBinary(options);
      vi.setSystemTime(Date.now() + ADMISSION_CACHE_TTL_MS + 1);
      resolveAgentBrowserBinary(options);
      expect(macAdmission).toHaveBeenCalledTimes(2);
    });
  });
  it("says the built-in browser is missing, and to reinstall, when a packaged app has none", () => {
    const status = browserEngineStatus({ platform: "darwin", arch: "arm64", env: { MURAGE_RESOURCES_PATH: temporary() } });
    expect(status).toMatchObject({ kind: "unavailable", installable: false });
    expect(status.kind === "unavailable" && status.reason).toBe("The browser that comes with Murage is missing. Reinstall Murage from the download to fix it.");
  });
  it("resolves explicit executable before PATH, rejects bad override and directories", () => {
    const dataDir = temporary();
    const name = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
    const pathBinary = join(dataDir, name);
    const override = join(dataDir, process.platform === "win32" ? "override.exe" : "override");
    writeFileSync(pathBinary, "fixture", { mode: 0o700 });
    writeFileSync(override, "fixture", { mode: 0o700 });
    // Windows admits a PATH copy only by the signed-image rule (fd84fa0d6, windowsBrowserImageState), which a fixture
    // never meets; elsewhere any executable on PATH resolves.
    const windows = process.platform === "win32";
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir } })).toBe(windows ? null : pathBinary);
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: override } })).toBe(override);
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: dataDir } })).toBeNull();
    expect(resolveAgentBrowserBinary({ dataDir, env: { PATH: dataDir, MURAGE_AGENT_BROWSER_PATH: join(dataDir, "missing") } })).toBeNull();
    if (!windows) expect(browserEngineStatus({ dataDir, env: { PATH: dataDir } })).toMatchObject({ kind: "ready", version: null, runtimeVerified: false });
    else expect(browserEngineStatus({ dataDir, env: { PATH: dataDir } })).toMatchObject({ kind: "unavailable" });
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
  it("on win32 turns the engine's dead alert auto-answer off and loads the dialog tools; elsewhere leaves it on", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const make = (os: string) => {
      Object.defineProperty(process, "platform", { value: os });
      try {
        const spec = agentBrowserIntegration({ dataDir: temporary(), realmId: "realm", binaryPath: "/fixture/agent-browser", encryptionKey: "a".repeat(64), session: browserSessionId("a", "profile", "realm"), env: { PATH: "/bin" } });
        scratch.push(spec.env.AGENT_BROWSER_SOCKET_DIR!);
        return spec;
      } finally { Object.defineProperty(process, "platform", platform); }
    };
    const win = make("win32");
    expect(win.env.AGENT_BROWSER_NO_AUTO_DIALOG).toBe("1");
    expect(win.args).toEqual(["mcp", "--tools", "core,tabs", "--no-webmcp"]);
    // A real Windows host cannot pose as a POSIX one here: engine storage is checked
    // for an owner-only mode NTFS does not carry. The macOS and Linux runners cover it.
    if (process.platform === "win32") return;
    for (const os of ["darwin", "freebsd"]) {
      const spec = make(os);
      expect(spec.env.AGENT_BROWSER_NO_AUTO_DIALOG).toBeUndefined();
      expect(spec.args).toEqual(["mcp", "--tools", "core", "--no-webmcp"]);
    }
  });
  it("separates realms, profiles, colliding names, and every guest invocation", () => {
    expect(browserSessionId("a", "profile", "realm")).toBe(browserSessionId("b", "profile", "realm"));
    expect(browserSessionId("a", "", "realm")).not.toBe(browserSessionId("b", "", "realm"));
    expect(browserSessionId("a", "a/b", "realm")).not.toBe(browserSessionId("a", "a_b", "realm"));
    expect(browserSessionId("a", "profile", "realm")).not.toBe(browserSessionId("a", "profile", "restored"));
    expect(browserSessionId("a", "guest", "realm")).not.toBe(browserSessionId("a", "guest", "realm"));
    expect(() => browserSessionId("a", "p", "")).toThrow(/realm/u);
  });
  describe("beforeunload guard on Windows", () => {
    const withPlatform = <T,>(platform: string, fn: () => T): T => {
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try { return fn(); } finally { Object.defineProperty(process, "platform", real); }
    };
    const input = () => ({ dataDir: temporary(), realmId: "realm", binaryPath: "/fixture/agent-browser", encryptionKey: "a".repeat(64), session: browserSessionId("a", "profile", "realm"), env: { PATH: "/bin" } });
    it("registers the guard as an engine init script only on win32", () => {
      const win = withPlatform("win32", () => agentBrowserIntegration(input()));
      scratch.push(win.env.AGENT_BROWSER_SOCKET_DIR!);
      expect(win.env.AGENT_BROWSER_NO_AUTO_DIALOG).toBe("1");
      expect(win.env.AGENT_BROWSER_INIT_SCRIPTS).toMatch(/beforeunload-guard\.js$/u);
      expect(readFileSync(win.env.AGENT_BROWSER_INIT_SCRIPTS!, "utf8")).toBe(BEFOREUNLOAD_GUARD_SCRIPT);
      // As above: the POSIX side needs a POSIX host (owner-only storage mode).
      if (process.platform === "win32") return;
      const other = withPlatform("darwin", () => agentBrowserIntegration(input()));
      scratch.push(other.env.AGENT_BROWSER_SOCKET_DIR!);
      expect(other.env.AGENT_BROWSER_INIT_SCRIPTS).toBeUndefined();
      expect(other.env.AGENT_BROWSER_NO_AUTO_DIALOG).toBeUndefined();
    });
    it("stops the page registering or setting a beforeunload handler", () => {
      class FakeTarget { listeners: Array<[string, unknown, unknown]> = []; addEventListener(type: string, fn: unknown, opt?: unknown) { this.listeners.push([type, fn, opt]); } }
      const fakeWindow = new FakeTarget() as FakeTarget & { onbeforeunload?: unknown };
      new Function("window", "EventTarget", BEFOREUNLOAD_GUARD_SCRIPT)(fakeWindow, FakeTarget);
      // the guard's own capture listener went in through the original method, before any page script
      expect(fakeWindow.listeners.map(([t, , o]) => [t, o])).toEqual([["beforeunload", true]]);
      const calls: string[] = [];
      (fakeWindow as unknown as FakeTarget).addEventListener("beforeunload", () => calls.push("page"));
      (fakeWindow as unknown as FakeTarget).addEventListener("click", () => {});
      expect(fakeWindow.listeners.map(([t]) => t)).toEqual(["beforeunload", "click"]);
      fakeWindow.onbeforeunload = () => "leave?";
      expect(fakeWindow.onbeforeunload).toBeNull();
      let stopped = false;
      (fakeWindow.listeners[0][1] as (e: unknown) => void)({ stopImmediatePropagation: () => { stopped = true; } });
      expect(stopped).toBe(true);
    });
  });
  it.skipIf(browserEngineRefusesHost)("isolates engine storage, disables guest persistence, and does not copy ambient auth/browser overrides", () => {
    const dataDir = temporary();
    const input = { dataDir, realmId: "realm", binaryPath: "/fixture/agent-browser", encryptionKey: "a".repeat(64), session: browserSessionId("a", "profile", "realm"), env: { PATH: "/bin", AGENT_BROWSER_PROFILE: "/real/profile", TOKEN: "secret" } };
    const spec = agentBrowserIntegration(input);
    scratch.push(spec.env.AGENT_BROWSER_SOCKET_DIR!);
    // Windows also loads the dialog tools (see the win32 test above).
    expect(spec.args).toEqual(["mcp", "--tools", process.platform === "win32" ? "core,tabs" : "core", "--no-webmcp"]);
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
  it.skipIf(browserEngineRefusesHost)("attaches to the owner's Chrome only when asked, in its own tab, without saving its cookies", () => {
    const dataDir = temporary();
    const endpoint = "ws://127.0.0.1:9222/devtools/browser/4c1b0f0e-9a2d-4e8f-b1c3-5d6e7f8a9b0c";
    const input = { dataDir, realmId: "realm", binaryPath: "/fixture/agent-browser", encryptionKey: "a".repeat(64), session: userChromeSessionId("a", "realm"), env: { PATH: "/bin", AGENT_BROWSER_CDP: "http://ambient.invalid:9222" } };
    const isolated = agentBrowserIntegration(input);
    scratch.push(isolated.env.AGENT_BROWSER_SOCKET_DIR!);
    // The ambient environment never redirects a bot's browser.
    expect(isolated.env.AGENT_BROWSER_CDP).toBeUndefined();
    expect(isolated.env.AGENT_BROWSER_PIN_TAB).toBeUndefined();
    const attached = agentBrowserIntegration({ ...input, attachCdpUrl: endpoint });
    expect(attached.env.AGENT_BROWSER_CDP).toBe(endpoint);
    expect(attached.env.AGENT_BROWSER_PIN_TAB).toBe("1");
    expect(attached.env.AGENT_BROWSER_RESTORE_SAVE).toBe("never");
    expect(attached.env.AGENT_BROWSER_RESTORE).toBeUndefined();
    // Chrome asks the owner to Allow each new connection: no one-minute idle reconnects.
    expect(isolated.env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("60000");
    expect(attached.env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("1800000");
    for (const bad of ["9222", "http://127.0.0.1:9222", "ws://10.0.0.5:9222/devtools/browser/x", ""]) {
      expect(() => agentBrowserIntegration({ ...input, attachCdpUrl: bad }), bad).toThrow(/Chrome connection/u);
    }
  });
  it("keys the owner's-Chrome session apart from every isolated session of the same bot", () => {
    const key = userChromeSessionId("a", "realm");
    expect(key).toMatch(/^murage-uc-[a-f0-9]{32}$/u);
    expect(key).toBe(userChromeSessionId("a", "realm"));
    expect(key).not.toBe(userChromeSessionId("b", "realm"));
    expect(key).not.toBe(userChromeSessionId("a", "restored"));
    for (const partition of ["", "user-chrome", "a"]) expect(key).not.toBe(browserSessionId("a", partition, "realm"));
    expect(() => userChromeSessionId("a", "")).toThrow(/realm/u);
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

describe("browser prompt for a protected profile", () => {
  it("is the unchanged browser prompt while the profile is not locked", () => {
    expect(unifiedBrowserSystemPrompt(null)).toBe(UNIFIED_BROWSER_SYSTEM_PROMPT);
  });
  it("says the owner's lock is the owner's to clear, and forbids routing around it", () => {
    const text = unifiedBrowserSystemPrompt("owner-input");
    expect(text.startsWith(UNIFIED_BROWSER_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain("Your browser is locked: the owner typed or clicked in its page");
    expect(text).toContain("Take control and then Reopen blank page");
    expect(text).not.toContain("agent_browser_open with a different address");
    expect(text).toContain("never use another browser, a browser plugin, or run the browser program yourself instead");
  });
  it("tells a bot on a sensitive page it may leave it, and still forbids routing around it", () => {
    const text = unifiedBrowserSystemPrompt("sensitive-page");
    expect(text.startsWith(UNIFIED_BROWSER_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain("Your browser is locked: its page has a password, one-time-code or payment field, an embedded frame");
    // The tool is named the way the turn's engine calls it, at dispatch.
    expect(renderMurageTools(text, CLAUDE_TOOL_SURFACE, { browser: "browser" })).toContain("Opening a different address with mcp__browser__agent_browser_open clears the lock");
    expect(text).toContain("Never use another browser, a browser plugin, or run the browser program yourself instead");
  });
});

it("the browser prompt says what the bot must not do in plain words", () => {
  expect(UNIFIED_BROWSER_SYSTEM_PROMPT).not.toMatch(/safeguard|\bsafe|unsafe|safety|\u2014/i);
  expect(UNIFIED_BROWSER_SYSTEM_PROMPT).toContain("turn off a protection");
});
