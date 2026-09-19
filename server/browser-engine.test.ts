import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const macAdmission = vi.hoisted(() => vi.fn());
vi.mock("./browser-macos-identity.ts", () => ({ verifyPackagedMacBrowser: macAdmission }));
import { AGENT_BROWSER_VERSION, agentBrowserReleaseUrl, resolveAgentBrowserReleaseAsset } from "./browser-engine-release.ts";
import { UNIFIED_BROWSER_SYSTEM_PROMPT, unifiedBrowserSystemPrompt, agentBrowserIntegration, browserEngineEncryptionKey, browserEngineStatus, browserSessionId, userChromeSessionId, closeAgentBrowserSession, installAgentBrowserBinary, pinnedBinaryPath, resolveAgentBrowserBinary, verifyAgentBrowserBinary } from "./browser-engine.ts";

const scratch: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "murage-browser-test-")); scratch.push(path); return path; }
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
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
    expect(macAdmission).toHaveBeenCalledWith(resources);
    macAdmission.mockReturnValue(false);
    expect(resolveAgentBrowserBinary(options)).toBeNull();
  });
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
  it("attaches to the owner's Chrome only when asked, in its own tab, without saving its cookies", () => {
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
    expect(text).toContain("Opening a different address with agent_browser_open clears the lock");
    expect(text).toContain("Never use another browser, a browser plugin, or run the browser program yourself instead");
  });
});
