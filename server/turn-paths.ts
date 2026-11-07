// Phase 1 turn admission (designs/S5-DATADIR-PATHS.md r4.1 sections 2, 3 and 4): sites 1, 1b, 1c and 3.
// Order in the turn path: rootFor (DR3, snapshot) -> admitStoredPaths (section 2 on cwd) -> ensureTaskWorkspace
// (WT1-WT3) -> preparePinnedProcedures (C3, same snapshot) -> pinTaskCwd -> resources -> spawn with the canonical cwd (DR5).
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { rootFor, ownedPath, WorkspaceTreeError, type RootSnapshot } from "./data-roots.ts";
import { rebaseStoredPath, type Constructors } from "./stored-paths.ts";
import { LocalSetupError } from "./local-setup-failure.ts";
import { partitionRoots, threadPartition, type Partition } from "./execution-audience.ts";
import { botWorkspacePath, taskWorkspacePath } from "./workspace.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";

export const WORKING_FOLDER_MISSING_TEXT = "This conversation's working folder is missing or cannot be opened, so the turn did not start. Choose its folder again, or start a new conversation.";
export const DATA_DIR_MOVED_TEXT = "Murage's data folder was moved, and this conversation's folder could not be matched to the new location, so the turn did not start.";

/** The one server log line a refused turn setup writes (1c, D19). Never a path. */
export function logTurnSetupRefused(code: string, threadId: string): void {
  console.warn(`turn-setup-refused code=${code} thread=${/^[\w-]+$/.test(threadId) ? threadId : "invalid"}`);
}

const PARTITION_KINDS = ["team", "project", "rooms"] as const;

/** Section 2 cwd constructors (sites 1, 1b, 3), in a fixed order so index i at P pairs with index i at DATA_DIR. */
export function cwdConstructors(bot: Pick<BotRecord, "id">, threadId: string, extra: { sharedTeamId?: string; partition?: Partition; groupId?: string } = {}): Constructors {
  return (root: string) => {
    const values: Array<string | undefined> = [];
    const attempt = (make: () => string) => { try { values.push(make()); } catch { values.push(undefined); } };
    attempt(() => taskWorkspacePath(root, bot.id, threadId));
    attempt(() => join(botWorkspacePath(root, bot.id), "threads", threadId));
    const partition = extra.partition;
    if (partition && partition.kind !== "home") attempt(() => join(partitionRoots(bot as BotRecord, partition, root)[0]!, "threads", threadId));
    else values.push(undefined);
    if (extra.sharedTeamId) attempt(() => partitionRoots(bot as BotRecord, { kind: "team", teamId: extra.sharedTeamId! } as Partition, root)[0]!);
    else values.push(undefined);
    if (extra.groupId) {
      for (const kind of PARTITION_KINDS.slice(1)) {
        attempt(() => partitionRoots(bot as BotRecord, (kind === "project" ? { kind: "project", groupId: extra.groupId! } : { kind: "isolated", threadId: extra.groupId! }) as Partition, root)[0]!);
      }
    }
    return values;
  };
}

/** Section 2 outcome for a stored cwd: kept, rewritten in its own record, or a data-dir-moved refusal. */
export function admitStoredCwd(stored: string | null | undefined, constructors: Constructors, rewrite: (next: string) => void): string | null | undefined {
  if (typeof stored !== "string") return stored;
  const outcome = rebaseStoredPath(stored, constructors);
  if ("refused" in outcome) throw new LocalSetupError("data-dir-moved", DATA_DIR_MOVED_TEXT);
  if ("path" in outcome) {
    rewrite(outcome.path);
    console.warn("data-dir-rebase kind=cwd count=1");
    return outcome.path;
  }
  return stored;
}

/** Sites 1 and 1b: rebase the task's stored cwd before ensureTaskWorkspace. */
export function admitTaskStoredCwd(store: Pick<Store, "bot" | "taskByThread" | "patchTask">, botId: string, threadId: string): void {
  const bot = store.bot(botId);
  const task = bot ? store.taskByThread(botId, threadId) : undefined;
  if (!bot || !task || typeof task.cwd !== "string") return;
  let partition: Partition | undefined;
  try { partition = bot.partitionedAt !== undefined ? threadPartition(bot, threadId) : undefined; } catch { partition = undefined; }
  admitStoredCwd(task.cwd, cwdConstructors(bot, threadId, { partition, sharedTeamId: task.sharedWork?.teamId }), next => store.patchTask(botId, threadId, { cwd: next }));
}

/** Site 3: a room's pinnedCwd (task form or the room's own). */
export function admitGroupStoredCwd(store: Pick<Store, "rebaseGroupPinnedCwd">, group: GroupRecord, bot: Pick<BotRecord, "id">, threadId: string): void {
  const task = group.tasks?.find(item => item.threadId === threadId);
  const stored = task ? task.pinnedCwd : group.pinnedCwd;
  if (typeof stored !== "string") return;
  admitStoredCwd(stored, cwdConstructors(bot, threadId, { groupId: group.id }), next => store.rebaseGroupPinnedCwd(group.id, task ? threadId : undefined, stored, next));
}

/** The canonical form of a lexical path below DATA_DIR/workspaces under this turn's snapshot (DR5); other paths unchanged. */
export function canonicalUnderRoot(path: string, snapshot: RootSnapshot | undefined): string {
  if (!snapshot || snapshot.state !== "ok") return path;
  const rel = relative(snapshot.lexical, path);
  if (rel === "") return snapshot.canonical;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../")) return path;
  return join(snapshot.canonical, rel);
}

/** 1c + WT3: the final cwd of a turn. A managed cwd (under DATA_DIR) is walked by ownedPath with the turn's snapshot;
 * any cwd must then exist as a folder, else the working-folder card with the 1c text. Returns the spawn cwd (DR5). */
export function admitFinalCwd(cwd: string, snapshot: RootSnapshot | undefined): string {
  const rel = relative(DATA_DIR, cwd);
  const managed = !(isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../"));
  let spawnCwd = cwd;
  if (managed) {
    try { spawnCwd = ownedPath(cwd, { create: false, snapshot }).canonical; }
    catch (error) { if (error instanceof WorkspaceTreeError) throw error; throw new LocalSetupError("working-folder", WORKING_FOLDER_MISSING_TEXT, { cause: error }); }
  }
  let ok = false;
  try { ok = lstatSync(spawnCwd).isDirectory() || (!managed && safeIsDir(spawnCwd)); } catch { ok = false; }
  if (!ok) throw new LocalSetupError("working-folder", WORKING_FOLDER_MISSING_TEXT);
  return spawnCwd;
}
function safeIsDir(path: string): boolean {
  // a user cwd outside DATA_DIR may itself be a link the owner chose; it must resolve to a folder
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** DR5: the file selection of a turn (prepareOutputDestination). A managed root is taken from the turn's snapshot (canonical T/<rest>),
 * so a link retargeted after the check cannot move it; a user root is returned as is. */
export function turnFileRoot(root: string, managed: boolean, snapshot: RootSnapshot | undefined): string {
  return managed ? canonicalUnderRoot(root, snapshot) : root;
}

/** The workspaces snapshot a turn keeps for every later step (DR3, DR5). */
export function turnWorkspacesSnapshot(): RootSnapshot { return rootFor("workspaces", { create: true }); }
