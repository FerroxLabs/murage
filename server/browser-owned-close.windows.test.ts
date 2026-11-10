import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { closeOwnedBrowser, ownedClosePlatform } from "./browser-owned-close.ts";
const fixture = vi.hoisted(() => ({ reply: "", legacyJobStop: vi.fn(() => { throw new Error("jobStop needs a Local\\murage-pip- name"); }) }));
vi.mock("./engine-exclusion.ts", () => ({ loadExclusionAddon: () => ({ jobStop: fixture.legacyJobStop }) }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_command, _args, _options, callback) => callback(null, fixture.reply, "")),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it("Windows browser fallback uses the engine's pinned job and validates its exhaustion proof", async () => {
  vi.spyOn(ownedClosePlatform, "current").mockReturnValue("win32");
  mkdirSync(".ownership-fixtures", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".ownership-fixtures/windows-"));
  const launchId = "0123456789abcdef";
  const ownerFile = join(dir, "fixture.owner.json");
  const spec = { command: "/fixture/engine", args: [], env: { AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_LAUNCH_ID: launchId } };
  writeFileSync(ownerFile, JSON.stringify({ v: 1, session: "fixture", launchId, daemon: { pid: 123, start: "1", exe: spec.command }, group: { kind: "job", name: `Local\\agent-browser-${launchId}` } }));
  try {
    const proof = { launchId, groupExhausted: true, treeExhausted: true, outsideSeen: 0, unconfirmed: null };
    fixture.reply = JSON.stringify(proof);
    await expect(closeOwnedBrowser(spec, 123)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledWith(spec.command, ["launch-group", "--owner-file", ownerFile, "--stop"], expect.objectContaining({ windowsHide: true, timeout: 15_000, maxBuffer: 65536 }), expect.any(Function));
    expect(fixture.legacyJobStop).not.toHaveBeenCalled();
    for (const invalid of [{ ...proof, launchId: "fedcba9876543210" }, { ...proof, treeExhausted: false }, { ...proof, unconfirmed: "tree_lingering" }]) {
      fixture.reply = JSON.stringify(invalid);
      await expect(closeOwnedBrowser(spec, 123)).rejects.toThrow();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
