// S5-DATADIR-PATHS r4.1 section 7 through the real consumers (C1, C2, C3, WT1-WT4, 1c): this file owns its DATA_DIR (per-file HOME).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { resetDataRootsForTest, bootDataRoots, comparable, WorkspaceTreeError } from "./data-roots.ts";
import { ensureTaskWorkspace, ensureWorkspace, loadMemory, memoryFileRevision, saveMemoryFile, taskWorkspacePath } from "./workspace.ts";
import { localSetupFailureOf, LocalSetupError } from "./local-setup-failure.ts";
import { admitFinalCwd, admitStoredCwd, cwdConstructors, turnFileRoot, turnWorkspacesSnapshot, WORKING_FOLDER_MISSING_TEXT } from "./turn-paths.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WS = join(DATA_DIR, "workspaces");
// A recorded previous root is absolute on the host platform (section 2 lexical form).
const OLD_ROOT = process.platform === "win32" ? "C:\\gone\\old\\.murage" : "/gone/old/.murage";
let elsewhere = "";
beforeEach(() => {
  // a link left by an earlier case is unlinked, never followed (removeTempDirSync judges a link by its target)
  if (lstatOrNull(WS)?.isSymbolicLink()) rmSync(WS); else if (lstatOrNull(WS)) removeTempDirSync(WS);
  elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-other-volume-")));
  // each case starts with no root record: a link recorded by an earlier case is another computer's (D5e)
  rmSync(join(DATA_DIR, ".murage-root.json"), { force: true });
  resetDataRootsForTest(undefined);
});
afterEach(() => { if (lstatOrNull(WS)?.isSymbolicLink()) rmSync(WS); removeTempDirSync(elsewhere); resetDataRootsForTest(undefined); });
function lstatOrNull(path: string) { try { return lstatSync(path); } catch { return null; } }
// Windows grants directory junctions to every user but file symlinks only with a privilege: link directories as junctions there.
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";
const linkRoot = () => { const T = join(elsewhere, "ws"); mkdirSync(T); mkdirSync(DATA_DIR, { recursive: true }); symlinkSync(T, WS, DIR_LINK); bootDataRoots(); return T; };

it("D5d: a linked workspaces root runs turns, creates desks and reads and saves notebooks under T, with no card", () => {
  const T = linkRoot();
  for (let turn = 0; turn < 20; turn++) ensureTaskWorkspace("bot-a", `t${turn % 3}`);
  expect(lstatSync(join(T, "bot-a", "threads", "t0")).isDirectory()).toBe(true);
  expect(readFileSync(join(T, "bot-a", "MEMORY.md"), "utf8")).toContain("# Memory");
  const saved = saveMemoryFile("bot-a", "# Memory\nlinked root works\n", memoryFileRevision("bot-a"));
  expect(saved.saved).toBe(true);
  expect(readFileSync(join(T, "bot-a", "MEMORY.md"), "utf8")).toContain("linked root works");
  expect(loadMemory("bot-a")?.text).toContain("linked root works");
});

it("D5d on a PLAIN root: a regular MEMORY.md reads and saves as at b17 (Astra r4 H3)", () => {
  bootDataRoots();
  ensureWorkspace("bot-p");
  expect(saveMemoryFile("bot-p", "# Memory\nplain\n", memoryFileRevision("bot-p")).saved).toBe(true);
  expect(loadMemory("bot-p")?.text).toContain("plain");
});

it("D5: a linked bot folder, memory folder or MEMORY.md link refuses with the link text and writes nothing through it", () => {
  bootDataRoots(); mkdirSync(WS, { recursive: true });
  const target = join(elsewhere, "target"); mkdirSync(target);
  symlinkSync(target, join(WS, "bot-l"), DIR_LINK);
  const error = (() => { try { ensureTaskWorkspace("bot-l", "t"); } catch (e) { return e; } })();
  expect(error).toBeInstanceOf(WorkspaceTreeError);
  expect(localSetupFailureOf(error)).toBe("working-folder");
  expect((error as Error).message).toContain("never writes through a link");
  expect(readdirSync(target)).toEqual([]);
  mkdirSync(join(WS, "bot-m")); symlinkSync(target, join(WS, "bot-m", "memory"), DIR_LINK);
  expect(() => ensureWorkspace("bot-m")).toThrow(WorkspaceTreeError);
  expect(readdirSync(target)).toEqual([]);
});

// This one needs a FILE symlink, which Windows only allows with the symlink privilege, so it runs on POSIX only.
it.skipIf(process.platform === "win32")("D5c: a dangling MEMORY.md link is refused, link and target untouched; absent MEMORY.md is created by temp + rename", () => {
  bootDataRoots(); mkdirSync(join(WS, "bot-d", "memory"), { recursive: true });
  const dangling = join(elsewhere, "nope.md");
  symlinkSync(dangling, join(WS, "bot-d", "MEMORY.md"));
  expect(() => ensureWorkspace("bot-d")).toThrow(WorkspaceTreeError);
  expect(existsSync(dangling)).toBe(false);
  expect(lstatSync(join(WS, "bot-d", "MEMORY.md")).isSymbolicLink()).toBe(true);
  ensureWorkspace("bot-e");
  expect(lstatSync(join(WS, "bot-e", "MEMORY.md")).isFile()).toBe(true);
});

it("D5c: an absent MEMORY.md is created by temp + rename on every platform", () => {
  bootDataRoots(); mkdirSync(join(WS, "bot-f", "memory"), { recursive: true });
  ensureWorkspace("bot-f");
  expect(lstatSync(join(WS, "bot-f", "MEMORY.md")).isFile()).toBe(true);
});

it("WT4: a changed root is worded data-root-changed; an unavailable one keeps the working-folder card with its text", () => {
  const T = linkRoot(); ensureWorkspace("bot-c");
  rmSync(WS); const U = join(elsewhere, "u"); mkdirSync(U); symlinkSync(U, WS, DIR_LINK);
  const changed = (() => { try { ensureWorkspace("bot-c"); } catch (e) { return e; } })();
  expect(localSetupFailureOf(changed)).toBe("data-root-changed");
  expect(readdirSync(U)).toEqual([]);
  rmSync(WS); symlinkSync(join(elsewhere, "missing"), WS, DIR_LINK);
  const gone = (() => { try { ensureWorkspace("bot-c"); } catch (e) { return e; } })();
  expect(localSetupFailureOf(gone)).toBe("working-folder");
  expect((gone as Error).message).toContain("cannot be opened right now");
  rmSync(WS); symlinkSync(T, WS, DIR_LINK);
  expect(() => ensureWorkspace("bot-c")).not.toThrow();
});

it("1c: a missing cwd ends with the working-folder card text; D6 the same for a user cwd outside DATA_DIR", () => {
  bootDataRoots();
  const gone = join(elsewhere, "gone-project");
  const error = (() => { try { admitFinalCwd(gone, undefined); } catch (e) { return e; } })();
  expect(error).toBeInstanceOf(LocalSetupError);
  expect((error as LocalSetupError).localFailure).toBe("working-folder");
  expect((error as Error).message).toBe(WORKING_FOLDER_MISSING_TEXT);
  const desk = ensureTaskWorkspace("bot-f", "t");
  // DR5: the spawn cwd is canonical; on win32 the lease case-folds DATA_DIR, so compare comparable forms.
  expect(comparable(admitFinalCwd(desk, undefined))).toBe(comparable(desk));
});

it("D1/D3 through admitStoredCwd: a recorded previous desk is rebased and rewritten once; other ids refuse with data-dir-moved", () => {
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: `${OLD_ROOT}`, previous: [] }));
  bootDataRoots();
  const writes: string[] = [];
  const stored = `${OLD_ROOT}/workspaces/bot-g/threads/t1`;
  const next = admitStoredCwd(stored, cwdConstructors({ id: "bot-g" }, "t1"), value => writes.push(value));
  expect(next).toBe(taskWorkspacePath(DATA_DIR, "bot-g", "t1"));
  expect(writes).toEqual([next]);
  const refused = (() => { try { admitStoredCwd(`${OLD_ROOT}/workspaces/bot-g/threads/OTHER`, cwdConstructors({ id: "bot-g" }, "t1"), () => {}); } catch (e) { return e; } })();
  expect(localSetupFailureOf(refused)).toBe("data-dir-moved");
  rmSync(join(DATA_DIR, ".murage-root.json"));
});

it("D5m-r end to end (driver ruling 05:02Z): plain workspaces deleted mid-boot -> the next turn recreates it, the desk is made, the spawn cwd admitted and the notebook saves", () => {
  mkdirSync(WS, { recursive: true }); bootDataRoots();
  ensureTaskWorkspace("bot-r", "t1", turnWorkspacesSnapshot());
  removeTempDirSync(WS);
  const next = turnWorkspacesSnapshot();
  expect(next.state).toBe("ok");
  const desk = ensureTaskWorkspace("bot-r", "t1", next);
  const spawnCwd = admitFinalCwd(desk, next);
  expect(lstatSync(spawnCwd).isDirectory()).toBe(true);
  expect(lstatSync(WS).isSymbolicLink()).toBe(false);
  expect(saveMemoryFile("bot-r", "# Memory\nrecreated\n", memoryFileRevision("bot-r")).saved).toBe(true);
  expect(loadMemory("bot-r")?.text).toContain("recreated");
});

it("D5m-r link variant end to end: plain workspaces deleted then replaced by a link -> the next turn is data-root-changed, nothing written under the target", () => {
  mkdirSync(WS, { recursive: true }); bootDataRoots();
  ensureTaskWorkspace("bot-s", "t1", turnWorkspacesSnapshot());
  removeTempDirSync(WS);
  symlinkSync(elsewhere, WS, DIR_LINK);
  const error = (() => { try { ensureTaskWorkspace("bot-s", "t1", turnWorkspacesSnapshot()); } catch (e) { return e; } })();
  expect(error).toBeInstanceOf(WorkspaceTreeError);
  expect(localSetupFailureOf(error)).toBe("data-root-changed");
  expect(readdirSync(elsewhere)).toEqual([]);
});

it("D5i canonical spawn (DR5): the link retargeted after the turn's check and before spawn -> the spawn cwd and the file selection stay under the old T", () => {
  const T = linkRoot();
  const U = join(elsewhere, "other"); mkdirSync(join(U, "bot-a", "threads", "t1"), { recursive: true });
  const snapshot = turnWorkspacesSnapshot();
  expect(snapshot.state).toBe("ok");
  const desk = ensureTaskWorkspace("bot-a", "t1", snapshot);
  // the seam: between the DR3 check and the spawn the root link now points at U
  rmSync(WS); symlinkSync(U, WS, DIR_LINK);
  const spawnCwd = admitFinalCwd(desk, snapshot);
  expect(spawnCwd).toBe(join(T, "bot-a", "threads", "t1"));
  const selection = turnFileRoot(taskWorkspacePath(DATA_DIR, "bot-a", "t1"), true, snapshot);
  expect(realpathSync.native(selection)).toBe(join(T, "bot-a", "threads", "t1"));
  // a user root is never rewritten
  expect(turnFileRoot("/elsewhere/project", false, snapshot)).toBe("/elsewhere/project");
  expect(readdirSync(join(U, "bot-a", "threads", "t1"))).toEqual([]);
});
