import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createNativeBrowser } from "./browser-native-relay.ts";
import { closeOwnedBrowser, ownedClosePlatform } from "./browser-owned-close.ts";
const fixture = vi.hoisted(() => ({ reply: "", legacyJobStop: vi.fn(() => { throw new Error("jobStop needs a Local\\murage-pip- name"); }) }));
vi.mock("./engine-exclusion.ts", () => ({ loadExclusionAddon: () => ({ jobStop: fixture.legacyJobStop }) }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_command, _args, _options, callback) => callback(null, fixture.reply, "")),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it("N3 Windows browser fallback passes expected launch identity and uses the engine's pinned job and validates its exhaustion proof", async () => {
  vi.spyOn(ownedClosePlatform, "current").mockReturnValue("win32");
  const dir = mkdtempSync(join(tmpdir(), "browser-owner-win-"));
  const launchId = "0123456789abcdef";
  const ownerFile = join(dir, "fixture.owner.json");
  const spec = { command: "/fixture/engine", args: [], env: { AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: launchId } };
  writeFileSync(ownerFile, JSON.stringify({ v: 1, session: "fixture", launchId, daemon: { pid: 123, start: "1", exe: spec.command }, group: { kind: "job", name: `Local\\agent-browser-${launchId}` } }));
  try {
    const proof = { closed: true, launchId, groupExhausted: true, treeExhausted: true, outsideSeen: 0, unconfirmed: null };
    fixture.reply = JSON.stringify(proof);
    await expect(closeOwnedBrowser(spec, 123)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith(spec.command, ["close-owned", "--session", "fixture", "--launch-id", launchId, "--json"], expect.objectContaining({ windowsHide: true, timeout: 45_000, maxBuffer: 65536 }), expect.any(Function));
    expect(fixture.legacyJobStop).not.toHaveBeenCalled();
    for (const invalid of [{ ...proof, launchId: "fedcba9876543210" }, { ...proof, closed: false }, { ...proof, unconfirmed: "tree_lingering" }]) {
      fixture.reply = JSON.stringify(invalid);
      await expect(closeOwnedBrowser(spec, 123)).rejects.toThrow();
    }
  } finally { removeTempDirSync(dir); }
});

// CLI protocol double: owner reads happen at invocation, after TS validation.
// Rust's N3 contract separately exercises the portable pre-open decision seam.
it("N3 A5 integrated Windows close binds launch A before CLI can open replacement B", async () => {
  vi.spyOn(ownedClosePlatform, "current").mockReturnValue("win32");
  mkdirSync(".ownership-fixtures", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/race-"));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(sentinel, "spawn");
  const launchA = "0123456789abcdef", launchB = "fedcba9876543210";
  const ownerFile = join(dir, "fixture.owner.json");
  const spec = { command: "/fixture/engine", args: [], env: { HOME: dir,
    AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: launchA } };
  const owner = (launchId: string) => ({ v: 1, session: "fixture", launchId,
    daemon: { pid: launchId === launchB ? sentinel.pid! : sentinel.pid! + 1, start: "1", exe: spec.command },
    group: { kind: "job", name: `Local\\agent-browser-${launchId}` } });
  writeFileSync(ownerFile, JSON.stringify(owner(launchA)));
  const opened: string[] = [], terminated: string[] = [];
  vi.mocked(execFile).mockImplementationOnce(((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    writeFileSync(ownerFile, JSON.stringify(owner(launchB)));
    const current = JSON.parse(readFileSync(ownerFile, "utf8"));
    const expectedIndex = args.indexOf("--launch-id");
    if (expectedIndex >= 0 && args[expectedIndex + 1] !== current.launchId) {
      callback(new Error("launch_mismatch"), "", ""); return;
    }
    opened.push(current.launchId); terminated.push(current.launchId);
    callback(null, JSON.stringify({ launchId: current.launchId, groupExhausted: true,
      treeExhausted: true, outsideSeen: 0, unconfirmed: null }), "");
  }) as typeof execFile);
  try {
    const outcome = await createNativeBrowser(spec).close().then(() => "closed", () => "refused");
    expect(outcome).toBe("refused");
    expect(sentinel.exitCode).toBeNull(); expect(sentinel.signalCode).toBeNull();
    expect({ opened, terminated }, "reply mismatch is too late: B must never be opened").toEqual({ opened: [], terminated: [] });
  } finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) { const exit = once(sentinel, "exit"); sentinel.kill(); await exit; }
    removeTempDirSync(dir);
  }
});
