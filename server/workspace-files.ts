// Workspace discovery (R3-T1), bounded read, revision-conditioned Markdown
// write and explicit save-version (F4-T1).
// Contract: shared/workspace-files.ts and docs/plans/0152-CONTRACTS.md.
//
// Authority, in order, on every request:
// 1. Desktop proof (U-04). Everyone else gets the hidden-route answer.
// 2. The client names a bot + conversation only. The root is re-derived from
//    the store with the same rules dispatch uses (TaskRecord.cwd pinning,
//    room pinnedCwd), and must also be one of the scopes Files and
//    register_artifact already authorize (`artifactScopes`). A root that is
//    not authorized is never read. The one exception is a conversation that
//    has not run yet and would get its managed task workspace: it lists as
//    empty and nothing is created, pinned or read.
// 3. Legacy tasks pinned to `cwd: null`, cloud runs, HOME, an ancestor of
//    HOME, the filesystem root and Murage's data folder (outside the desks
//    under `workspaces/`) answer a state and are never read.
// 4. Paths use the artifact store's rules (server/artifacts.ts). Hidden and
//    private setup/memory names are not listed. Links are listed as `link`
//    and never followed; ancestors are re-checked after every directory read.
// Discovery is not authorship: entries carry no producer, run or author.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, opendirSync, readFileSync, readSync, realpathSync,
  renameSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactError, artifactRelativePathParts, artifactSourceFingerprint, artifactWorkspaceIdentity, authorizedArtifactRoot, isPrivateWorkspaceName,
  registerArtifact, type ArtifactScope,
} from "./artifacts.ts";
import type { Artifact } from "../shared/artifacts.ts";
import { ProjectFolderLeaseError, type ProjectFolderLeases } from "./project-folder-leases.ts";
import type { Store } from "./store.ts";
import { SURFACE_QUERY, SURFACE_SECRET_QUERY } from "./sse-visibility.ts";
import {
  WORKSPACE_CURSOR_MAX_LENGTH, WORKSPACE_FILE_ERROR_STATUS, WORKSPACE_FILES_ROUTE_PREFIX, WORKSPACE_FILES_ROUTES, WORKSPACE_LIST_PAGE_SIZE,
  WORKSPACE_SEARCH_MAX_DEPTH, WORKSPACE_SEARCH_MAX_ENTRIES, WORKSPACE_SEARCH_QUERY_MAX_LENGTH, WORKSPACE_TEXT_MAX_BYTES,
  isFileRevision, isWorkspaceRelativePath, isWorkspaceScopeRef,
  type FileRevision, type SaveReceipt, type WorkspaceEntry, type WorkspaceFileErrorBody, type WorkspaceFileErrorCode, type WorkspaceListRequest,
  type WorkspaceListResponse, type WorkspaceNativeFile, type WorkspaceNewline, type WorkspaceReadRequest, type WorkspaceReadResult, type WorkspaceRootInfo,
  type WorkspaceRootState, type WorkspaceSaveVersionRequest, type WorkspaceSaveVersionResponse, type WorkspaceScopeRef,
  type WorkspaceSearchRequest, type WorkspaceSearchResponse, type WorkspaceWriteRequest,
} from "../shared/workspace-files.ts";
import { hiddenRoute, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
import { sha256Hex, workspaceRevisionOf } from "./workspace-revision.ts";

/** Server facts a lane may need. Adding a field is a one-line change to the
 * deps object in server/index.ts; routing itself never changes. */
export interface WorkspaceFilesDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  /** Same scope resolver Files and register_artifact already use. */
  artifactScopes: () => ArtifactScope[];
  /** F4-T1: the in-process writer registry every local bot turn holds on its
   * working folder for the whole turn (`projectTurnLeases.folders` in
   * server/index.ts). A save takes a short exclusive lease on the workspace
   * for its commit window. Without it an overwrite cannot prove that no bot
   * is writing, so it is refused (Save a copy still works). */
  projectFolders?: Pick<ProjectFolderLeases, "acquireRestore" | "release">;
}

/** Names read from one directory per request, hidden and private included.
 * A larger directory lists its first names and answers `incomplete`. */
export const WORKSPACE_DIRECTORY_SCAN_LIMIT = 10_000;
const ROUTINES_FILE_MAX_BYTES = 16 * 1024 * 1024;
const NO_STORE = { "cache-control": "no-store" } as const;

export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;
  readonly currentRevision?: FileRevision;
  constructor(code: WorkspaceFileErrorCode, message: string, currentRevision?: FileRevision) {
    super(message); this.code = code; this.currentRevision = currentRevision;
  }
  get status(): number { return WORKSPACE_FILE_ERROR_STATUS[this.code]; }
}
function fail(code: WorkspaceFileErrorCode, message: string): never { throw new WorkspaceFileError(code, message); }

const UNAVAILABLE = "This conversation's workspace is unavailable.";
const ROOT_CHANGED = "The workspace changed while it was being read. Refresh and try again.";
const STALE = "The workspace changed since this list was loaded. Refresh to continue.";
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const sameNode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fold = (value: string) => value.normalize("NFC").toLowerCase();
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cleanLabel = (value: string) => value.replace(/\p{Cc}/gu, " ").trim().slice(0, 100);

/** Opaque identity of one observed regular file state: the canonical root,
 * the path, the lstat fingerprint and, within the text limit, the SHA-256 of
 * its bytes (server/workspace-revision.ts says why metadata alone is not
 * enough). F4-T1 recomputes it from a fresh lstat and compares; the client
 * never parses it. Undefined when the file is no longer that state or cannot
 * be read: no revision is issued for a state nobody could verify. `bytes`
 * must be exactly the verified content of `stat` when given. */
export function workspaceFileRevision(root: string, relativePath: string, stat: Stats, bytes?: Uint8Array): FileRevision | undefined {
  const result = workspaceRevisionOf(root, relativePath, stat, bytes);
  return result.ok ? result.revision : undefined;
}

export interface ResolvedWorkspace {
  info: WorkspaceRootInfo;
  /** Canonical real root, present only for state "ready" with a directory. */
  root?: string;
  rootStat?: Stats;
  /** Ready managed task workspace that dispatch has not created yet. */
  pending: boolean;
}

function identityOf(path: string | undefined): string | undefined {
  if (typeof path !== "string") return undefined;
  try { return artifactWorkspaceIdentity(path); } catch { return undefined; }
}

/** A cloud run pins its task to `cwd: null` exactly like a legacy task. The
 * routine run ledger is the only durable record that tells them apart; when
 * it has been pruned the task answers "no-dedicated-workspace", which is
 * equally never read. */
function cloudRunRecorded(dataDir: string, scope: WorkspaceScopeRef): boolean {
  try {
    const path = join(dataDir, "routines.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > ROUTINES_FILE_MAX_BYTES) return false;
    const runs = (JSON.parse(readFileSync(path, "utf8")) as { runs?: unknown } | null)?.runs;
    return Array.isArray(runs) && runs.some(run => {
      if (!run || typeof run !== "object") return false;
      const { runOn, botId, threadId } = run as Record<string, unknown>;
      return runOn === "cloud" && botId === scope.botId && threadId === scope.threadId;
    });
  } catch { return false; }
}

/** Re-derive and authorize the root for one bot conversation. Never creates,
 * pins or reads workspace contents. */
export function resolveWorkspaceRoot(deps: WorkspaceFilesDeps, scope: WorkspaceScopeRef): ResolvedWorkspace {
  const bot = deps.store.bots.find(item => item.id === scope.botId);
  if (!bot) fail("scope-unavailable", UNAVAILABLE);
  const botName = cleanLabel(bot.name) || "Workspace";
  const answer = (state: WorkspaceRootState, label = botName, managed = false): ResolvedWorkspace => ({ info: { scope, state, label, managed }, pending: false });
  const taskWorkspace = join(deps.dataDir, "workspaces", scope.botId, "threads", scope.threadId);
  let candidate: string | undefined, direct = false;
  const tasks: Array<{ threadId: string; cwd?: string | null; resumeCursors?: Record<string, unknown> }> = bot.tasks ?? [{ threadId: bot.threadId, cwd: undefined, resumeCursors: bot.resumeCursors }];
  const task = tasks.find(item => item.threadId === scope.threadId);
  if (task) {
    direct = true;
    if (task.cwd === null) return answer(cloudRunRecorded(deps.dataDir, scope) ? "remote" : "no-dedicated-workspace");
    if (typeof task.cwd === "string") candidate = task.cwd;
    // Store.pinTaskCwd: a task that already has a provider session pins to
    // null (home) on its next turn; that is not a dedicated workspace.
    else if (Object.keys(task.resumeCursors ?? {}).length > 0) return answer("no-dedicated-workspace");
    else candidate = bot.cwd ?? taskWorkspace;
  } else {
    for (const group of deps.store.groups) {
      if (!group.memberIds.includes(scope.botId)) continue;
      const roomTask = (group.tasks ?? [{ threadId: group.threadId, pinnedCwd: group.pinnedCwd }]).find(item => item.threadId === scope.threadId);
      if (!roomTask) continue;
      const pinned = roomTask.pinnedCwd === undefined ? group.cwd : roomTask.pinnedCwd;
      candidate = pinned ?? join(deps.dataDir, "workspaces", scope.botId);
      break;
    }
    if (!candidate) fail("scope-unavailable", UNAVAILABLE);
  }
  const identity = identityOf(candidate);
  const managed = direct && identity !== undefined && identity === identityOf(taskWorkspace);
  const authorized = identity !== undefined && deps.artifactScopes().some(item => item.botId === scope.botId && item.threadId === scope.threadId
    && item.threadAvailable !== false && identityOf(item.workspaceRoot) === identity);
  // Not yet dispatched: dispatch will create and pin exactly this folder.
  const predictedManaged = managed && task !== undefined && task.cwd === undefined;
  if (!authorized && !predictedManaged) fail("scope-unavailable", UNAVAILABLE);
  const murageOwned = managed || identity === identityOf(join(deps.dataDir, "workspaces", scope.botId));
  let root: string;
  try { root = authorizedArtifactRoot(candidate); }
  catch (error) {
    if (managed && errno(error) === "ENOENT") return { info: { scope, state: "ready", label: botName, managed: true }, pending: true };
    // Filesystem root, HOME or a non-absolute folder: not a dedicated workspace.
    if (error instanceof ArtifactError && error.status === 403) return answer("no-dedicated-workspace");
    return answer("unavailable", murageOwned ? botName : cleanLabel(basename(candidate)) || botName, managed);
  }
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  let home: string | undefined;
  try { home = realpathSync.native(homedir()); } catch { home = undefined; }
  if (home !== undefined && within(home, root)) return answer("no-dedicated-workspace");
  // Murage's own data folder (database, config, saved copies, other state)
  // is never listed, whatever folder a bot or room was pointed at. Only the
  // desks under `workspaces/` inside it are workspaces.
  const dataRoot = identityOf(deps.dataDir);
  if (dataRoot !== undefined && (within(dataRoot, root) || (within(root, dataRoot) && !root.startsWith(join(dataRoot, "workspaces") + sep)))) {
    return answer("no-dedicated-workspace");
  }
  let rootStat: Stats;
  try { rootStat = lstatSync(root); } catch { return answer("unavailable", botName, managed); }
  const label = murageOwned ? botName : cleanLabel(basename(root)) || botName;
  return { info: { scope, state: "ready", label, displayPath: root, managed }, root, rootStat, pending: false };
}

function requireReady(resolved: ResolvedWorkspace): void {
  const state = resolved.info.state;
  if (state === "no-dedicated-workspace") fail("no-dedicated-workspace", "This older conversation has no dedicated workspace. Its home folder is not listed.");
  if (state === "remote") fail("remote-workspace", "These files are stored on a remote computer and are not available locally.");
  if (state !== "ready") fail("scope-unavailable", UNAVAILABLE);
}

interface Child { name: string; directory: boolean }

/** Visible children of one directory in read order. Hidden and private
 * setup/memory names are skipped; the scan limit counts every name read. */
function readChildren(path: string): { children: Child[]; truncated: boolean } {
  const handle = opendirSync(path), children: Child[] = [];
  let read = 0, truncated = false;
  try {
    for (let dirent = handle.readSync(); dirent !== null; dirent = handle.readSync()) {
      if (read++ >= WORKSPACE_DIRECTORY_SCAN_LIMIT) { truncated = true; break; }
      if (dirent.name.startsWith(".") || isPrivateWorkspaceName(dirent.name, true)) continue;
      children.push({ name: dirent.name, directory: dirent.isDirectory() });
    }
  } finally { handle.closeSync(); }
  return { children, truncated };
}

function describeEntry(root: string, relativePath: string, child: Child): WorkspaceEntry {
  const base = { name: child.name, relativePath };
  // A legal on-disk name that the path contract cannot address (for example
  // one containing ":") is shown, but cannot be opened or searched into.
  if (!isWorkspaceRelativePath(relativePath)) return { ...base, kind: child.directory ? "directory" : "other", state: "unsupported" };
  let stat: Stats;
  try { stat = lstatSync(join(root, ...relativePath.split("/"))); }
  catch (error) { return { ...base, kind: child.directory ? "directory" : "file", state: errno(error) === "ENOENT" ? "missing" : "unsupported" }; }
  const modifiedAt = Math.trunc(stat.mtimeMs);
  if (stat.isSymbolicLink()) return { ...base, kind: "link", state: "unsupported" };
  if (stat.isDirectory()) return { ...base, kind: "directory", state: "local", modifiedAt };
  if (!stat.isFile()) return { ...base, kind: "other", state: "unsupported" };
  // Hard-linked files cannot be saved or edited safely; no revision invites it.
  if (stat.nlink !== 1) return { ...base, kind: "file", state: "unsupported", bytes: stat.size, modifiedAt };
  // A file that changed under this listing or cannot be read is still listed,
  // without a revision until a listing can observe one state of it.
  const revision = workspaceFileRevision(root, relativePath, stat);
  return { ...base, kind: "file", state: "local", bytes: stat.size, modifiedAt, ...(revision ? { revision } : {}) };
}

function encodeCursor(prefix: string, value: unknown): string {
  return prefix + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(cursor: string, prefix: string): Record<string, unknown> {
  const invalid = () => fail("invalid-request", "This list continuation is not valid. Refresh to start again.");
  if (cursor.length > WORKSPACE_CURSOR_MAX_LENGTH || !cursor.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(cursor.slice(prefix.length))) invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8")); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function directoryParts(directory: string): string[] {
  if (directory === "") return [];
  if (!isWorkspaceRelativePath(directory)) fail("invalid-path", "Use a folder path inside this workspace.");
  try { return artifactRelativePathParts(directory); }
  catch (error) {
    if (error instanceof ArtifactError && error.status === 403) fail("private-file", "Private setup and memory folders are not listed.");
    fail("invalid-path", "Use a folder path inside this workspace.");
  }
}

/** lstat every segment from the root; no link is followed. */
function observeDirectoryPath(root: string, rootStat: Stats, parts: string[]): Array<{ path: string; stat: Stats }> {
  const observed: Array<{ path: string; stat: Stats }> = [];
  let path = root;
  try {
    const now = lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameNode(now, rootStat)) fail("root-changed", ROOT_CHANGED);
    observed.push({ path, stat: now });
    for (const part of parts) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail("linked-file", "Linked folders are not opened.");
      if (!stat.isDirectory()) fail("invalid-path", "That path is not a folder.");
      observed.push({ path, stat });
    }
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") fail(observed.length ? "not-found" : "root-changed", observed.length ? "That folder was not found in this workspace." : ROOT_CHANGED);
    if (errno(error) === "EACCES" || errno(error) === "EPERM") fail("not-found", "That folder could not be read.");
    fail("root-changed", ROOT_CHANGED);
  }
  return observed;
}
function assertUnchanged(observed: Array<{ path: string; stat: Stats }>): void {
  for (const { path, stat } of observed) {
    let now: Stats;
    try { now = lstatSync(path); } catch { fail("root-changed", ROOT_CHANGED); }
    if (now.isSymbolicLink() || !now.isDirectory() || !sameNode(now, stat)) fail("root-changed", ROOT_CHANGED);
  }
}

/** One directory at a time, 200 entries per page, directories first, then
 * code-unit name order. The cursor is bound to the directory revision. */
export function listWorkspaceDirectory(deps: WorkspaceFilesDeps, request: WorkspaceListRequest): WorkspaceListResponse {
  const { scope, directory } = request;
  const parts = directoryParts(directory);
  const resolved = resolveWorkspaceRoot(deps, scope);
  requireReady(resolved);
  const offsetFor = (directoryRevision: string, total: number) => {
    if (request.cursor === undefined) return 0;
    const value = decodeCursor(request.cursor, "l1.");
    if (Object.keys(value).length !== 2 || typeof value.r !== "string" || !Number.isSafeInteger(value.i) || (value.i as number) < 1) fail("invalid-request", "This list continuation is not valid. Refresh to start again.");
    if (value.r !== directoryRevision) fail("cursor-stale", STALE);
    return Math.min(value.i as number, total);
  };
  if (resolved.pending || !resolved.root || !resolved.rootStat) {
    if (parts.length) fail("not-found", "That folder was not found in this workspace.");
    const directoryRevision = `d1.${digest(JSON.stringify(["pending", scope.botId, scope.threadId]))}`;
    offsetFor(directoryRevision, 0);
    return { scope, root: resolved.info, directory, directoryRevision, entries: [], incomplete: false };
  }
  const root = resolved.root, observed = observeDirectoryPath(root, resolved.rootStat, parts), target = observed.at(-1)!;
  let read: ReturnType<typeof readChildren>;
  try { read = readChildren(target.path); }
  catch (error) {
    if (errno(error) === "EACCES" || errno(error) === "EPERM") fail("not-found", "That folder could not be read.");
    fail("root-changed", ROOT_CHANGED);
  }
  assertUnchanged(observed);
  const keyed = read.children.map(child => ({ child, key: `${child.directory ? 0 : 1}/${child.name}` })).sort((a, b) => byKey(a.key, b.key));
  const directoryRevision = `d1.${digest(JSON.stringify([root, scope.botId, scope.threadId, directory, target.stat.dev, target.stat.ino, read.truncated, keyed.map(item => item.key)]))}`;
  const offset = offsetFor(directoryRevision, keyed.length), next = Math.min(offset + WORKSPACE_LIST_PAGE_SIZE, keyed.length);
  const entries = keyed.slice(offset, next).map(({ child }) => describeEntry(root, directory ? `${directory}/${child.name}` : child.name, child));
  // describeEntry lstats through the folder chain: re-check it so a folder
  // swapped for a link during this page cannot report outside metadata.
  assertUnchanged(observed);
  const more = next < keyed.length;
  return { scope, root: resolved.info, directory, directoryRevision, entries, ...(more ? { cursor: encodeCursor("l1.", { r: directoryRevision, i: next }) } : {}), incomplete: more || read.truncated };
}

interface Frame { relative: string; depth: number; children: Child[]; index: number }

/** User-triggered file-name search of the authorized workspace only: no
 * content reads, depth 8, 2,000 names examined and 200 matches per request,
 * then a continuation. Pre-order walk in code-unit order; the cursor holds
 * the index path of the last examined entry plus a hash of its path. */
export function searchWorkspace(deps: WorkspaceFilesDeps, request: WorkspaceSearchRequest): WorkspaceSearchResponse {
  const { scope } = request;
  if (typeof request.query !== "string") fail("invalid-request", "Enter a file name to search for.");
  const trimmed = request.query.trim();
  if (!trimmed || trimmed.length > WORKSPACE_SEARCH_QUERY_MAX_LENGTH || /\p{Cc}/u.test(trimmed)) fail("invalid-request", "Enter a file name to search for.");
  const needle = fold(trimmed);
  const resolved = resolveWorkspaceRoot(deps, scope);
  requireReady(resolved);
  const binding = digest(JSON.stringify(["search", scope.botId, scope.threadId, resolved.root ?? "pending", needle])).slice(0, 22);
  let position: { path: number[]; hash: string; incomplete: boolean } | undefined;
  if (request.cursor !== undefined) {
    const value = decodeCursor(request.cursor, "s1.");
    const path = value.p;
    if (Object.keys(value).length !== 4 || typeof value.b !== "string" || typeof value.h !== "string" || typeof value.f !== "boolean"
      || !Array.isArray(path) || path.length < 1 || path.length > WORKSPACE_SEARCH_MAX_DEPTH
      || !path.every(index => Number.isSafeInteger(index) && index >= 0 && index < WORKSPACE_DIRECTORY_SCAN_LIMIT)) fail("invalid-request", "This search continuation is not valid. Search again.");
    if (value.b !== binding) fail("cursor-stale", STALE);
    position = { path: path as number[], hash: value.h, incomplete: value.f };
  }
  if (resolved.pending || !resolved.root || !resolved.rootStat) {
    if (position) fail("cursor-stale", STALE);
    return { scope, root: resolved.info, query: trimmed, entries: [], incomplete: false, scanned: 0 };
  }
  const root = resolved.root;
  let incomplete = position?.incomplete ?? false;
  const load = (relative: string): Child[] | undefined => {
    const path = relative ? join(root, ...relative.split("/")) : root;
    try {
      // realpath equal to the joined path means no link anywhere in the chain.
      const before = lstatSync(path);
      if (!before.isDirectory() || before.isSymbolicLink() || realpathSync.native(path) !== path) { incomplete = true; return undefined; }
      const read = readChildren(path);
      const after = lstatSync(path);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameNode(before, after) || realpathSync.native(path) !== path) { incomplete = true; return undefined; }
      if (read.truncated) incomplete = true;
      return read.children.sort((a, b) => byKey(a.name, b.name));
    } catch { incomplete = true; return undefined; }
  };
  try {
    const now = lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameNode(now, resolved.rootStat)) fail("root-changed", ROOT_CHANGED);
  } catch (error) { if (error instanceof WorkspaceFileError) throw error; fail("root-changed", ROOT_CHANGED); }
  const rootChildren = load("");
  if (!rootChildren) fail("root-changed", ROOT_CHANGED);
  const stack: Frame[] = [{ relative: "", depth: 1, children: rootChildren, index: 0 }];
  const descend = (frame: Frame, child: Child, relative: string) => {
    if (!child.directory || !isWorkspaceRelativePath(relative)) return;
    if (frame.depth >= WORKSPACE_SEARCH_MAX_DEPTH) { incomplete = true; return; }
    const children = load(relative);
    if (children) stack.push({ relative, depth: frame.depth + 1, children, index: 0 });
  };
  if (position) {
    let relative = "";
    for (const [step, index] of position.path.entries()) {
      const frame = stack.at(-1)!, child = frame.children[index];
      if (!child) fail("cursor-stale", STALE);
      frame.index = index + 1;
      relative = relative ? `${relative}/${child.name}` : child.name;
      if (step === position.path.length - 1) {
        if (digest(relative).slice(0, 22) !== position.hash) fail("cursor-stale", STALE);
        descend(frame, child, relative);
      } else {
        if (!child.directory || frame.depth >= WORKSPACE_SEARCH_MAX_DEPTH) fail("cursor-stale", STALE);
        const children = load(relative);
        if (!children) fail("cursor-stale", STALE);
        stack.push({ relative, depth: frame.depth + 1, children, index: 0 });
      }
    }
  }
  const entries: WorkspaceEntry[] = [];
  let scanned = 0, last: { path: number[]; relative: string } | undefined, cursor: string | undefined;
  for (;;) {
    while (stack.length && stack.at(-1)!.index >= stack.at(-1)!.children.length) stack.pop();
    if (!stack.length) break;
    if (last && (scanned >= WORKSPACE_SEARCH_MAX_ENTRIES || entries.length >= WORKSPACE_LIST_PAGE_SIZE)) {
      cursor = encodeCursor("s1.", { b: binding, p: last.path, h: digest(last.relative).slice(0, 22), f: incomplete });
      incomplete = true;
      break;
    }
    const frame = stack.at(-1)!, child = frame.children[frame.index++]!;
    const relative = frame.relative ? `${frame.relative}/${child.name}` : child.name;
    scanned++;
    last = { path: stack.map(item => item.index - 1), relative };
    if (fold(child.name).includes(needle)) {
      const entry = describeEntry(root, relative, child);
      // The folder was link-free when it was read; a match is reported only
      // if it still is, so a swap cannot report metadata from outside.
      const parent = frame.relative ? join(root, ...frame.relative.split("/")) : root;
      let linkFree = false;
      try { linkFree = realpathSync.native(parent) === parent; } catch { linkFree = false; }
      if (linkFree) entries.push(entry); else incomplete = true;
    }
    descend(frame, child, relative);
  }
  try {
    const now = lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameNode(now, resolved.rootStat)) fail("root-changed", ROOT_CHANGED);
  } catch (error) { if (error instanceof WorkspaceFileError) throw error; fail("root-changed", ROOT_CHANGED); }
  return { scope, root: resolved.info, query: trimmed, entries, ...(cursor ? { cursor } : {}), incomplete, scanned };
}

// ---------------------------------------------------------------------------
// F4-T1: bounded read, revision-conditioned Markdown write, save-version.
//
// The on-disk bytes are canonical. A read reports what it saw (BOM, newline
// style, strict UTF-8) and the revision of exactly that file state. A write
// happens only when the owner explicitly saves (never on a timer), only for a
// Markdown file, and only if the file is still at the revision the draft was
// based on; otherwise it answers `revision-conflict` with the revision now on
// disk and leaves the file alone. `baseRevision: null` is an exclusive create
// (Save a copy) and never replaces an existing file.
//
// Competing writers, honestly:
// - Murage's own bot turns hold a writer lease on their working folder for
//   the whole turn. An overwrite takes a short exclusive lease on the
//   workspace for its commit window, so while any bot turn is using an
//   overlapping folder the save answers `bot-writing` (held, nothing written)
//   and a bot turn cannot start inside the commit window.
// - Other programs do not take Murage leases. The file's identity is checked
//   again immediately before the atomic rename, which narrows but cannot close
//   that race: there is no universal compare-and-swap on ordinary files.
// - The prior revision is kept as a saved version in Files before it is
//   replaced, so an overwrite is always recoverable. If it cannot be kept,
//   nothing is overwritten.
// ---------------------------------------------------------------------------

/** Markdown is the only format the workspace editor writes in 0.1.52. */
export const WORKSPACE_EDITABLE_EXTENSIONS: readonly string[] = [".md", ".markdown"];
/** JSON escaping can grow text up to six times (a control character becomes
 * a six-character \u escape), plus the envelope. */
export const WORKSPACE_WRITE_BODY_MAX_BYTES = 6 * WORKSPACE_TEXT_MAX_BYTES + 64 * 1024;
const SAVE_VERSION_BODY_MAX_BYTES = 64 * 1024;
/** Hidden, so discovery never lists a half-written save. */
export const WORKSPACE_SAVE_TEMP_PREFIX = ".murage-save-";
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOT_FOUND = "That file was not found in this workspace.";
const MOVED = "The file was moved or deleted since it was opened. Save a copy to keep your changes.";
const CHANGED = "The file changed since it was opened. Your changes were not saved over it; compare, reload or save a copy.";
const CHANGED_DURING_READ = "The file changed while it was being read. Open it again.";
const BOT_WRITING = "A bot is working in this workspace right now, so the file was not saved over. Your changes are kept; save again when it finishes, or save a copy.";
const CANNOT_CONFIRM = "Murage cannot confirm that no bot is writing in this workspace, so the file was not saved over. Save a copy instead.";
const NOT_SAVED = "The file could not be saved. The original was preserved.";

function conflict(current: FileRevision | undefined, message = CHANGED): never {
  throw new WorkspaceFileError("revision-conflict", message, current);
}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function fileParts(relativePath: unknown): string[] {
  if (!isWorkspaceRelativePath(relativePath)) fail("invalid-path", "Use a file path inside this workspace.");
  try { return artifactRelativePathParts(relativePath); }
  catch (error) {
    if (error instanceof ArtifactError && error.status === 403) fail("private-file", "Private setup and memory files are not opened here.");
    fail("invalid-path", "Use a file path inside this workspace.");
  }
}

/** A ready, existing local root. A managed workspace dispatch has not created
 * yet has no files, and nothing here creates it. */
function readyRoot(deps: WorkspaceFilesDeps, scope: WorkspaceScopeRef): { root: string; rootStat: Stats; label: string } {
  const resolved = resolveWorkspaceRoot(deps, scope);
  requireReady(resolved);
  if (resolved.pending || !resolved.root || !resolved.rootStat) fail("not-found", NOT_FOUND);
  return { root: resolved.root, rootStat: resolved.rootStat, label: resolved.info.label };
}

/** Changes need the root to be one Files already authorizes for this exact
 * conversation, not only the root dispatch is predicted to create. */
function requireAuthorizedRoot(deps: WorkspaceFilesDeps, scope: WorkspaceScopeRef, root: string): void {
  const identity = identityOf(root);
  const authorized = identity !== undefined && deps.artifactScopes().some(item => item.botId === scope.botId && item.threadId === scope.threadId
    && item.threadAvailable !== false && identityOf(item.workspaceRoot) === identity);
  if (!authorized) fail("scope-unavailable", UNAVAILABLE);
}

interface ObservedFile { directories: Array<{ path: string; stat: Stats }>; path: string; stat?: Stats }

/** lstat the root, every folder and the file itself; no link is followed. */
function observeFile(root: string, rootStat: Stats, parts: string[]): ObservedFile {
  const directories: Array<{ path: string; stat: Stats }> = [];
  let path = root;
  try {
    const now = lstatSync(root);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameNode(now, rootStat)) fail("root-changed", ROOT_CHANGED);
    directories.push({ path, stat: now });
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail("linked-file", "Files inside linked folders are not opened.");
      if (!stat.isDirectory()) fail("not-found", NOT_FOUND);
      directories.push({ path, stat });
    }
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") fail(directories.length ? "not-found" : "root-changed", directories.length ? NOT_FOUND : ROOT_CHANGED);
    if (errno(error) === "EACCES" || errno(error) === "EPERM") fail("not-found", "That file could not be read.");
    fail("root-changed", ROOT_CHANGED);
  }
  const file = join(path, parts.at(-1)!);
  return { directories, path: file, stat: lstatOptional(file) };
}
function lstatOptional(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (errno(error) === "EACCES" || errno(error) === "EPERM") fail("not-found", "That file could not be read.");
    fail("root-changed", ROOT_CHANGED);
  }
}
function requireRegularFile(stat: Stats): void {
  if (stat.isSymbolicLink()) fail("linked-file", "Linked files are not opened.");
  if (!stat.isFile()) fail("not-regular-file", "Only ordinary files can be opened here.");
  if (stat.nlink !== 1) fail("not-regular-file", "Hard-linked files cannot be opened or saved here.");
}
const sameState = (a: Stats, b: Stats) => artifactSourceFingerprint(a) === artifactSourceFingerprint(b);

/** The revision (and content digest) of a state a request acts on, or the
 * refusal that state deserves. */
function requireRevision(root: string, relativePath: string, stat: Stats, bytes?: Uint8Array): { revision: FileRevision; sha256: string | null } {
  const result = workspaceRevisionOf(root, relativePath, stat, bytes);
  if (result.ok) return result;
  if (result.reason === "changed") conflict(undefined, CHANGED_DURING_READ);
  fail("not-found", "That file could not be read.");
}

/** Bytes of exactly the observed file state, or a refusal. */
function readStable(path: string, expected: Stats): Buffer {
  if (expected.size > WORKSPACE_TEXT_MAX_BYTES) fail("too-large", "This file is too large to open as text here. Download it or open it in another app.");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if (errno(error) === "ELOOP") fail("linked-file", "Linked files are not opened.");
    if (errno(error) === "ENOENT") fail("not-found", NOT_FOUND);
    fail("not-found", "That file could not be read.");
  }
  try {
    if (!sameState(fstatSync(fd), expected)) conflict(undefined, CHANGED_DURING_READ);
    const bytes = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) conflict(undefined, CHANGED_DURING_READ);
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || !sameState(fstatSync(fd), expected) || !sameState(lstatSync(path), expected)) conflict(undefined, CHANGED_DURING_READ);
    return bytes;
  } finally { closeSync(fd); }
}

/** Strict UTF-8. One leading BOM is reported and removed; anything after it,
 * including a second BOM, stays in the content exactly. */
export function decodeWorkspaceText(bytes: Uint8Array): { bom: boolean; content: string } {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try { return { bom, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes) }; }
  catch { fail("unsupported-encoding", "This file is not UTF-8 text. Download it or open it in another app."); }
}

/** A lone CR counts as mixed: the contract has no old-Mac style. */
export function workspaceNewlineStyle(text: string): WorkspaceNewline {
  let crlf = 0, other = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) { if (text.charCodeAt(index + 1) === 10) { crlf++; index++; } else other++; }
    else if (code === 10) other++;
  }
  if (!crlf && !other) return "none";
  if (crlf && other) return "mixed";
  if (crlf) return "crlf";
  return text.includes("\r") ? "mixed" : "lf";
}

/** Bounded current-file read (2 MiB, strict UTF-8, no link followed). Any
 * text file can be read for preview; only Markdown can be written back. */
export function readWorkspaceFile(deps: WorkspaceFilesDeps, request: WorkspaceReadRequest): WorkspaceReadResult {
  const { scope, relativePath } = request;
  if (!isWorkspaceScopeRef(scope)) fail("invalid-request", "Choose a bot and conversation.");
  const parts = fileParts(relativePath);
  const { root, rootStat } = readyRoot(deps, scope);
  const observed = observeFile(root, rootStat, parts);
  if (!observed.stat) fail("not-found", NOT_FOUND);
  requireRegularFile(observed.stat);
  const bytes = readStable(observed.path, observed.stat);
  assertUnchanged(observed.directories);
  const { bom, content } = decodeWorkspaceText(bytes);
  return {
    scope, relativePath, revision: requireRevision(root, relativePath, observed.stat, bytes).revision, encoding: "utf-8", bom,
    newline: workspaceNewlineStyle(content), bytes: bytes.length, modifiedAt: Math.trunc(observed.stat.mtimeMs), content,
  };
}

/**
 * F4-T5: authorize one workspace file for a native open/reveal.
 *
 * Same root resolution, link, hard-link and private-file policy as a read.
 * No size limit applies, because the operating system opens the file, not
 * Murage; only a file within the text limit is read, to name its revision
 * exactly as discovery does. The answer carries the canonical root and the
 * observed file identity so the owned main process can rebuild the path and
 * refuse if anything moved between this answer and the OS call.
 */
export function nativeWorkspaceFile(deps: WorkspaceFilesDeps, request: WorkspaceReadRequest): WorkspaceNativeFile {
  const { scope, relativePath } = request;
  if (!isWorkspaceScopeRef(scope)) fail("invalid-request", "Choose a bot and conversation.");
  const parts = fileParts(relativePath);
  const { root, rootStat } = readyRoot(deps, scope);
  requireAuthorizedRoot(deps, scope, root);
  const observed = observeFile(root, rootStat, parts);
  if (!observed.stat) fail("not-found", NOT_FOUND);
  requireRegularFile(observed.stat);
  assertUnchanged(observed.directories);
  return {
    scope, relativePath, root, revision: requireRevision(root, relativePath, observed.stat).revision,
    bytes: observed.stat.size, identity: artifactSourceFingerprint(observed.stat),
  };
}

/** Exact shape check for a write body; the path is checked separately. */
export function parseWorkspaceWriteRequest(body: unknown): WorkspaceWriteRequest {
  const invalid = (): never => fail("invalid-request", "Invalid save request.");
  if (!isRecord(body)) invalid();
  const value = body as Record<string, unknown>;
  const allowed = new Set(["scope", "relativePath", "baseRevision", "requestId", "content", "bom", "draftRevision"]);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid();
  const { scope, relativePath, baseRevision, requestId, content, bom, draftRevision } = value;
  if (!isWorkspaceScopeRef(scope) || typeof relativePath !== "string" || typeof requestId !== "string" || !REQUEST_ID.test(requestId)
    || typeof content !== "string" || typeof bom !== "boolean" || (baseRevision !== null && !isFileRevision(baseRevision))
    || (draftRevision !== undefined && (!Number.isSafeInteger(draftRevision) || (draftRevision as number) < 0))) invalid();
  // A lone surrogate would silently become U+FFFD on disk.
  if (/\p{Cs}/u.test(content as string)) fail("invalid-request", "The text contains characters that cannot be saved as UTF-8.");
  return {
    scope: { botId: (scope as WorkspaceScopeRef).botId, threadId: (scope as WorkspaceScopeRef).threadId }, relativePath: relativePath as string,
    baseRevision: baseRevision as FileRevision | null, requestId: requestId as string, content: content as string, bom: bom as boolean,
    ...(draftRevision !== undefined ? { draftRevision: draftRevision as number } : {}),
  };
}

function registerWorkspaceFile(deps: WorkspaceFilesDeps, scope: WorkspaceScopeRef, root: string, relativePath: string, name?: string): Artifact {
  const botName = deps.store.bots.find(bot => bot.id === scope.botId)?.name ?? "";
  // The exact root this request resolved and authorized, never the first
  // scope that happens to share the bot and conversation.
  return registerArtifact(deps.database(), join(deps.dataDir, "artifact-files"), { botId: scope.botId, threadId: scope.threadId, relativePath, ...(name !== undefined ? { name } : {}) },
    { owner: true, scopes: [{ botId: scope.botId, botName, threadId: scope.threadId, workspaceRoot: root }] });
}

function currentRevision(root: string, relativePath: string, path: string): FileRevision | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? workspaceFileRevision(root, relativePath, stat) : undefined;
  } catch { return undefined; }
}

/** Keep the revision about to be replaced as a saved version in Files. */
function keepPreviousRevision(deps: WorkspaceFilesDeps, scope: WorkspaceScopeRef, root: string, relativePath: string, path: string, previous: FileRevision): string {
  try { return registerWorkspaceFile(deps, scope, root, relativePath).id; }
  catch (error) {
    if (error instanceof ArtifactError && error.status === 507) fail("quota-exceeded", "The Files library is full, so the previous version could not be kept. Nothing was overwritten; free space in Files or save a copy.");
    // registerArtifact answers 409 both for a file that changed while it was
    // copied and for unsafe Files storage: only the first is a conflict.
    const now = currentRevision(root, relativePath, path);
    if (now !== previous) conflict(now);
    fail("write-failed", "The previous version could not be kept, so nothing was overwritten.");
  }
}

/** Private temp file beside the target, fully written and flushed. */
function stageBytes(path: string, bytes: Buffer, mode: number): Stats {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    return fstatSync(fd);
  } finally { closeSync(fd); }
}
/** Make the rename durable where the platform allows a directory fsync. */
function syncDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); } catch { /* Windows cannot fsync a directory. */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

export interface WorkspaceWriteHooks {
  /** Test seam: runs after the new bytes are staged and the prior revision is
   * kept, immediately before the final identity recheck and commit. */
  beforeCommit?: () => void;
}

/** Revision-conditioned atomic Markdown write. Never silent: a changed,
 * moved, replaced or bot-busy file is refused and left exactly as it is. */
export function writeWorkspaceMarkdown(deps: WorkspaceFilesDeps, body: WorkspaceWriteRequest | unknown, hooks: WorkspaceWriteHooks = {}): SaveReceipt {
  const request = parseWorkspaceWriteRequest(body);
  const { scope, relativePath } = request;
  const parts = fileParts(relativePath);
  if (!WORKSPACE_EDITABLE_EXTENSIONS.includes(extname(parts.at(-1)!).toLowerCase())) fail("invalid-request", "Only Markdown files can be edited here.");
  const content = Buffer.from(request.content, "utf8");
  const bytes = request.bom ? Buffer.concat([UTF8_BOM, content]) : content;
  if (bytes.length > WORKSPACE_TEXT_MAX_BYTES) fail("too-large", "This document is larger than 2 MiB and cannot be saved here.");
  const bytesSha256 = sha256Hex(bytes);
  const { root, rootStat } = readyRoot(deps, scope);
  requireAuthorizedRoot(deps, scope, root);
  const create = request.baseRevision === null;
  const leaseOwner = `workspace-save:${randomUUID()}`;
  let held = false, temp: string | undefined, committed = false;
  if (!create) {
    if (!deps.projectFolders) fail("bot-writing", CANNOT_CONFIRM);
    try { deps.projectFolders.acquireRestore(leaseOwner, root); held = true; }
    catch (error) {
      if (error instanceof ProjectFolderLeaseError && (error.code === "conflict" || error.code === "owner-in-use")) fail("bot-writing", BOT_WRITING);
      fail("root-changed", ROOT_CHANGED);
    }
  }
  try {
    const observed = observeFile(root, rootStat, parts);
    let previousRevision: FileRevision | null = null;
    if (create) {
      if (observed.stat) fail("already-exists", "A file with that name already exists. Choose another name.");
    } else {
      if (!observed.stat) fail("not-found", MOVED);
      requireRegularFile(observed.stat);
      const previous = requireRevision(root, relativePath, observed.stat);
      previousRevision = previous.revision;
      if (previousRevision !== request.baseRevision) conflict(previousRevision);
      // Saving exactly what is on disk changes nothing: no rewrite, no new
      // revision, no saved version. The revision just verified carries the
      // digest of those bytes.
      if (observed.stat.size === bytes.length && previous.sha256 === bytesSha256) {
        assertUnchanged(observed.directories);
        return receipt(request, previousRevision, previousRevision, bytes.length);
      }
    }
    const directory = observed.directories.at(-1)!.path;
    temp = join(directory, `${WORKSPACE_SAVE_TEMP_PREFIX}${randomUUID()}.tmp`);
    const staged = stageBytes(temp, bytes, create ? 0o600 : observed.stat!.mode & 0o777);
    const artifactId = create ? undefined : keepPreviousRevision(deps, scope, root, relativePath, observed.path, previousRevision!);
    hooks.beforeCommit?.();
    // Final identity recheck immediately before the atomic replacement.
    assertUnchanged(observed.directories);
    const now = lstatOptional(observed.path);
    if (create) {
      if (now) fail("already-exists", "A file with that name already exists. Choose another name.");
      try { linkSync(temp, observed.path); }
      catch (error) { if (errno(error) === "EEXIST") fail("already-exists", "A file with that name already exists. Choose another name."); throw error; }
      committed = true;
      unlinkSync(temp); temp = undefined;
    } else {
      if (!now) fail("not-found", MOVED);
      requireRegularFile(now);
      // Content included: an equal-length rewrite inside one timestamp tick
      // keeps every metadata field and must still refuse.
      const onDisk = workspaceFileRevision(root, relativePath, now);
      if (onDisk !== previousRevision) conflict(onDisk);
      renameSync(temp, observed.path);
      committed = true; temp = undefined;
    }
    syncDirectory(directory);
    // Report the committed revision. If something replaced the file in the
    // instant after the commit, say so instead of claiming that state.
    const after = lstatOptional(observed.path);
    const changedAgain = "Your changes were saved, but the file changed again right away. Open it again to see the current version.";
    if (!after || !sameNode(after, staged)) conflict(after ? currentRevision(root, relativePath, observed.path) : undefined, changedAgain);
    // Same node is not same bytes: the receipt names a revision only if it is
    // exactly the content this save wrote.
    const saved = workspaceRevisionOf(root, relativePath, after);
    if (!saved.ok || saved.sha256 !== bytesSha256) conflict(saved.ok ? saved.revision : undefined, changedAgain);
    return receipt(request, previousRevision, saved.revision, bytes.length, artifactId);
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if (committed) throw new WorkspaceFileError("revision-conflict", "Your changes were saved, but the file could not be checked afterwards. Open it again.");
    throw new WorkspaceFileError("write-failed", NOT_SAVED);
  } finally {
    if (temp !== undefined) try { unlinkSync(temp); } catch { /* already gone */ }
    if (held) deps.projectFolders!.release(leaseOwner);
  }
}

function receipt(request: WorkspaceWriteRequest, previousRevision: FileRevision | null, revision: FileRevision, bytes: number, artifactId?: string): SaveReceipt {
  return {
    requestId: request.requestId, scope: request.scope, relativePath: request.relativePath, previousRevision, revision, bytes, savedAt: Date.now(),
    ...(request.draftRevision !== undefined ? { draftRevision: request.draftRevision } : {}), ...(artifactId ? { artifactId } : {}),
  };
}

export function parseWorkspaceSaveVersionRequest(body: unknown): WorkspaceSaveVersionRequest {
  const invalid = (): never => fail("invalid-request", "Invalid save-version request.");
  if (!isRecord(body)) invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["scope", "relativePath", "revision", "name"].includes(key))) invalid();
  const { scope, relativePath, revision, name } = value;
  if (!isWorkspaceScopeRef(scope) || typeof relativePath !== "string" || !isFileRevision(revision)
    || (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 200))) invalid();
  return {
    scope: { botId: (scope as WorkspaceScopeRef).botId, threadId: (scope as WorkspaceScopeRef).threadId }, relativePath: relativePath as string,
    revision: revision as FileRevision, ...(name !== undefined ? { name: name as string } : {}),
  };
}

/** Explicit Save version: copy the exact revision the owner chose into Files
 * (register_artifact's verified path). Refused if the file changed. The
 * saved version carries no invented producer or run. */
export function saveWorkspaceVersion(deps: WorkspaceFilesDeps, body: WorkspaceSaveVersionRequest | unknown): WorkspaceSaveVersionResponse {
  const request = parseWorkspaceSaveVersionRequest(body);
  const { scope, relativePath } = request;
  const parts = fileParts(relativePath);
  const { root, rootStat } = readyRoot(deps, scope);
  requireAuthorizedRoot(deps, scope, root);
  const observed = observeFile(root, rootStat, parts);
  if (!observed.stat) fail("not-found", NOT_FOUND);
  requireRegularFile(observed.stat);
  const chosen = requireRevision(root, relativePath, observed.stat);
  if (chosen.revision !== request.revision) conflict(chosen.revision);
  let artifact: Artifact;
  try { artifact = registerWorkspaceFile(deps, scope, root, relativePath, request.name?.trim()); }
  catch (error) {
    if (!(error instanceof ArtifactError)) throw error;
    if (error.status === 413) fail("too-large", error.message);
    if (error.status === 507) fail("quota-exceeded", error.message);
    if (error.status === 403) fail("private-file", error.message);
    const now = currentRevision(root, relativePath, observed.path);
    if (now !== request.revision) conflict(now);
    fail("write-failed", error.message);
  }
  // The copy is exactly the chosen revision: its own SHA-256 is the digest the
  // revision carries (within the text limit), and the file is still that
  // revision after the copy. Timestamps alone cannot promise this — an
  // equal-length rewrite inside one timestamp tick keeps all of them.
  if (chosen.sha256 !== null && artifact.sha256 !== chosen.sha256) conflict(currentRevision(root, relativePath, observed.path));
  assertUnchanged(observed.directories);
  const after = currentRevision(root, relativePath, observed.path);
  if (after !== request.revision) conflict(after);
  return { artifact };
}

const SURFACE_PARAMS = [SURFACE_QUERY, SURFACE_SECRET_QUERY];
function queryParams(url: URL, extra: readonly string[]): { scope: WorkspaceScopeRef; values: Record<string, string> } {
  const allowed = new Set(["botId", "threadId", ...SURFACE_PARAMS, ...extra]), values: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    if (!allowed.has(key) || all.length !== 1) fail("invalid-request", "Invalid workspace request.");
    values[key] = all[0]!;
  }
  const scope = { botId: values.botId, threadId: values.threadId };
  if (!isWorkspaceScopeRef(scope)) fail("invalid-request", "Choose a bot and conversation.");
  return { scope, values };
}

function errorResult(code: WorkspaceFileErrorCode, error: string, currentRevision?: FileRevision): DelegatedResult {
  const body: WorkspaceFileErrorBody = { error, code, ...(currentRevision ? { currentRevision } : {}) };
  return { status: WORKSPACE_FILE_ERROR_STATUS[code], headers: NO_STORE, body };
}

export async function workspaceFilesRoute(request: DelegatedRequest, deps: WorkspaceFilesDeps): Promise<DelegatedResult> {
  // U-04: desktop-only in 0.1.52. A remote or unproven caller learns nothing.
  if (!request.desktop) return hiddenRoute();
  if (request.path !== WORKSPACE_FILES_ROUTE_PREFIX && !request.path.startsWith(`${WORKSPACE_FILES_ROUTE_PREFIX}/`)) return hiddenRoute();
  try {
    const { path, url } = request;
    if (path === WORKSPACE_FILES_ROUTES.root || path === WORKSPACE_FILES_ROUTES.list || path === WORKSPACE_FILES_ROUTES.search) {
      if (request.method !== "GET") fail("invalid-request", "Workspace discovery uses GET.");
      if (path === WORKSPACE_FILES_ROUTES.root) {
        const { scope } = queryParams(url, []);
        return { status: 200, headers: NO_STORE, body: resolveWorkspaceRoot(deps, scope).info };
      }
      if (path === WORKSPACE_FILES_ROUTES.list) {
        const { scope, values } = queryParams(url, ["directory", "cursor"]);
        return { status: 200, headers: NO_STORE, body: listWorkspaceDirectory(deps, { scope, directory: values.directory ?? "", ...(values.cursor !== undefined ? { cursor: values.cursor } : {}) }) };
      }
      const { scope, values } = queryParams(url, ["query", "cursor"]);
      return { status: 200, headers: NO_STORE, body: searchWorkspace(deps, { scope, query: values.query ?? "", ...(values.cursor !== undefined ? { cursor: values.cursor } : {}) }) };
    }
    if (path === WORKSPACE_FILES_ROUTES.read || path === WORKSPACE_FILES_ROUTES.native) {
      const native = path === WORKSPACE_FILES_ROUTES.native;
      if (request.method !== "GET") fail("invalid-request", native ? "Opening a workspace file uses GET." : "Reading a workspace file uses GET.");
      const { scope, values } = queryParams(url, ["path"]);
      const relativePath = values.path ?? "";
      return { status: 200, headers: NO_STORE, body: native ? nativeWorkspaceFile(deps, { scope, relativePath }) : readWorkspaceFile(deps, { scope, relativePath }) };
    }
    if (path === WORKSPACE_FILES_ROUTES.write || path === WORKSPACE_FILES_ROUTES.saveVersion) {
      if (request.method !== "POST") fail("invalid-request", "Saving uses POST.");
      const write = path === WORKSPACE_FILES_ROUTES.write;
      let body: unknown;
      try { body = await request.readBody(write ? WORKSPACE_WRITE_BODY_MAX_BYTES : SAVE_VERSION_BODY_MAX_BYTES); }
      catch (error) {
        if ((error as { status?: unknown } | undefined)?.status === 413) fail("too-large", "This document is too large to save here.");
        fail("invalid-request", write ? "Invalid save request." : "Invalid save-version request.");
      }
      if (write) return { status: 200, headers: NO_STORE, body: writeWorkspaceMarkdown(deps, body) };
      return { status: 201, headers: NO_STORE, body: saveWorkspaceVersion(deps, body) };
    }
    return errorResult("not-found", "no such route");
  } catch (error) {
    if (error instanceof WorkspaceFileError) return errorResult(error.code, error.message, error.currentRevision);
    throw error;
  }
}
