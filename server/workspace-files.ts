// Workspace discovery (R3-T1), bounded read and revision-conditioned write
// (F4-T1, still 501 here).
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
//    HOME and the filesystem root answer a state and are never read.
// 4. Paths use the artifact store's rules (server/artifacts.ts). Hidden and
//    private setup/memory names are not listed. Links are listed as `link`
//    and never followed; ancestors are re-checked after every directory read.
// Discovery is not authorship: entries carry no producer, run or author.
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ArtifactError, artifactRelativePathParts, artifactSourceFingerprint, artifactWorkspaceIdentity, authorizedArtifactRoot, isPrivateWorkspaceName,
  type ArtifactScope,
} from "./artifacts.ts";
import type { Store } from "./store.ts";
import { SURFACE_QUERY, SURFACE_SECRET_QUERY } from "./sse-visibility.ts";
import {
  WORKSPACE_CURSOR_MAX_LENGTH, WORKSPACE_FILE_ERROR_STATUS, WORKSPACE_FILES_ROUTE_PREFIX, WORKSPACE_FILES_ROUTES, WORKSPACE_LIST_PAGE_SIZE,
  WORKSPACE_SEARCH_MAX_DEPTH, WORKSPACE_SEARCH_MAX_ENTRIES, WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
  isWorkspaceRelativePath, isWorkspaceScopeRef,
  type FileRevision, type WorkspaceEntry, type WorkspaceFileErrorBody, type WorkspaceFileErrorCode, type WorkspaceListRequest,
  type WorkspaceListResponse, type WorkspaceRootInfo, type WorkspaceRootState, type WorkspaceScopeRef, type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
} from "../shared/workspace-files.ts";
import { hiddenRoute, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";

/** Server facts a lane may need. Adding a field is a one-line change to the
 * deps object in server/index.ts; routing itself never changes. */
export interface WorkspaceFilesDeps {
  dataDir: string;
  database: () => DatabaseSync;
  store: Store;
  /** Same scope resolver Files and register_artifact already use. */
  artifactScopes: () => ArtifactScope[];
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

/** Opaque identity of one observed regular file. F4-T1 recomputes it from a
 * fresh lstat and compares; the client never parses it. */
export function workspaceFileRevision(rootIdentity: string, relativePath: string, stat: Stats): FileRevision {
  return `r1.${digest(JSON.stringify([rootIdentity, relativePath, artifactSourceFingerprint(stat)]))}` as FileRevision;
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
  let home: string | undefined;
  try { home = realpathSync.native(homedir()); } catch { home = undefined; }
  if (home !== undefined && (home === root || home.startsWith(root.endsWith(sep) ? root : root + sep))) return answer("no-dedicated-workspace");
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
  return { ...base, kind: "file", state: "local", bytes: stat.size, modifiedAt, revision: workspaceFileRevision(root, relativePath, stat) };
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
    // F4-T1 fills bounded read, revision-conditioned write and save-version.
    if (path === WORKSPACE_FILES_ROUTES.read || path === WORKSPACE_FILES_ROUTES.write || path === WORKSPACE_FILES_ROUTES.saveVersion) {
      return errorResult("not-implemented", "Workspace file editing is not available in this build.");
    }
    return errorResult("not-found", "no such route");
  } catch (error) {
    if (error instanceof WorkspaceFileError) return errorResult(error.code, error.message, error.currentRevision);
    throw error;
  }
}
