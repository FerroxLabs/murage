// S5-DATADIR-PATHS r4.1 C9 (D5j, D5j-r): conversation deletion asks the workspaces root before EVERY attempt.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ConversationDeletions, WorkspacesRootBlockedError } from "./conversation-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let base = "";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); base = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-deletion-"))); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); removeTempDirSync(base); });
const desk = (root: string) => { const dir = join(root, "bot-a", "threads", "doomed"); mkdirSync(dir, { recursive: true }); return dir; };
function linked() {
  const data = join(base, "data"), T = join(base, "volume-t"), U = join(base, "volume-u");
  mkdirSync(data, { recursive: true });
  const atT = desk(T), atU = desk(U);
  symlinkSync(T, join(data, "workspaces"), "dir");
  return { data, T, U, atT, atU, deletions: new ConversationDeletions({ dataDir: data, database: () => database() }) };
}
const retarget = (data: string, to: string) => { rmSync(join(data, "workspaces")); symlinkSync(to, join(data, "workspaces"), "dir"); };

it("D5j: with the linked root ok, the desk under T is deleted", async () => {
  const f = linked();
  const entry = f.deletions.begin({ threadIds: ["doomed"] });
  expect(entry.desks.map(item => item.botId)).toEqual(["bot-a"]);
  await f.deletions.finish(entry);
  expect(existsSync(f.atT)).toBe(false);
});

it("D5j: begin while the root is changed is refused before its record is written; nothing deleted under either folder", () => {
  const f = linked();
  f.deletions.begin({ threadIds: ["other"] }); // first sight of the link
  retarget(f.data, f.U);
  expect(() => f.deletions.begin({ threadIds: ["doomed"] })).toThrow(WorkspacesRootBlockedError);
  expect(f.deletions.pending().some(item => item.threadIds.includes("doomed"))).toBe(false);
  expect(existsSync(f.atT) && existsSync(f.atU)).toBe(true);
});

it("D5j-r: a pending record, then the root retargeted -> the attempt removes nothing and stays pending; put back -> the retry deletes under the reference T only", async () => {
  const f = linked();
  const entry = f.deletions.begin({ threadIds: ["doomed"] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  retarget(f.data, f.U);
  await expect(f.deletions.finish(entry)).rejects.toBeInstanceOf(WorkspacesRootBlockedError);
  await expect(f.deletions.finish(entry)).rejects.toBeInstanceOf(WorkspacesRootBlockedError);
  expect(existsSync(f.atT) && existsSync(f.atU)).toBe(true);
  expect(f.deletions.pending().find(item => item.id === entry.id)?.blockedBy).toBe("workspaces-root");
  expect(warn.mock.calls.filter(call => String(call[0]) === `conversation-delete-pending code=workspaces-root id=${entry.id}`)).toHaveLength(2);
  retarget(f.data, f.T);
  const back = f.deletions.pending().find(item => item.id === entry.id)!;
  await f.deletions.finish(back);
  expect(f.deletions.pending().some(item => item.id === entry.id)).toBe(false);
  expect(existsSync(f.atT)).toBe(false);
  expect(existsSync(f.atU)).toBe(true);
});
