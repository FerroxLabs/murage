/**
 * Frozen 0.1.52 contract (K0): authorized workspace discovery, bounded read
 * and revision-conditioned Markdown write.
 *
 * Consumers: server/workspace-files.ts (R3-T1 discovery, F4-T1 read/write),
 * src Files/WorkspacePane/DocumentSession/MarkdownEditor (R3-T2, F4-T2..T4).
 *
 * Authority rules that every implementation keeps:
 * - A client names a scope (bot + conversation) and a validated relative
 *   path. It never sends an absolute path or a workspace root. The server
 *   re-resolves the root with the same resolver used at dispatch on every
 *   request; a cursor or revision never confers file authority by itself.
 * - Discovery is not authorship. A listed file carries no producer/run.
 * - Links are listed as `link` and are never followed or opened.
 */
import type { Artifact } from "./artifacts.ts";

/** U-02: new regular files written directly under this directory of a
 * Murage-managed dedicated task workspace are published at the end of a
 * successful turn. Custom working folders, projects and HOME never are. */
export const OUTPUT_NAMESPACE = "outputs";

export const WORKSPACE_FILES_ROUTE_PREFIX = "/api/workspace-files";
export const WORKSPACE_FILES_ROUTES = {
  /** GET ?botId&threadId -> WorkspaceRootInfo */
  root: `${WORKSPACE_FILES_ROUTE_PREFIX}/root`,
  /** GET ?botId&threadId&directory&cursor -> WorkspaceListResponse */
  list: `${WORKSPACE_FILES_ROUTE_PREFIX}/list`,
  /** GET ?botId&threadId&query&cursor -> WorkspaceSearchResponse */
  search: `${WORKSPACE_FILES_ROUTE_PREFIX}/search`,
  /** GET ?botId&threadId&path -> WorkspaceReadResult */
  read: `${WORKSPACE_FILES_ROUTE_PREFIX}/read`,
  /** GET ?botId&threadId&path -> WorkspaceNativeFile (F4-T5; the Electron
   * main process only, never the renderer) */
  native: `${WORKSPACE_FILES_ROUTE_PREFIX}/native`,
  /** POST WorkspaceWriteRequest -> SaveReceipt */
  write: `${WORKSPACE_FILES_ROUTE_PREFIX}/write`,
  /** POST WorkspaceSaveVersionRequest -> WorkspaceSaveVersionResponse */
  saveVersion: `${WORKSPACE_FILES_ROUTE_PREFIX}/save-version`,
} as const;

/** R3-T1 bounds (Files discovery research F1). */
export const WORKSPACE_LIST_PAGE_SIZE = 200;
export const WORKSPACE_SEARCH_MAX_ENTRIES = 2_000;
export const WORKSPACE_SEARCH_MAX_DEPTH = 8;
export const WORKSPACE_SEARCH_QUERY_MAX_LENGTH = 200;
export const WORKSPACE_CURSOR_MAX_LENGTH = 1_024;
export const WORKSPACE_PATH_MAX_LENGTH = 2_048;
export const WORKSPACE_PATH_SEGMENT_MAX_LENGTH = 255;
/** F4-T1 bounded text read and write (larger files: preview/download/open). */
export const WORKSPACE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkspaceScopeRef { botId: string; threadId: string }

declare const fileRevisionBrand: unique symbol;
/** Opaque server-issued identity of one observed file state. Clients only
 * echo it back; they never parse or construct one. */
export type FileRevision = string & { readonly [fileRevisionBrand]: "FileRevision" };

/** `no-dedicated-workspace`: legacy task pinned to cwd null (never scan HOME).
 * `remote`: files live on a remote/cloud computer and are not readable here. */
export type WorkspaceRootState = "ready" | "no-dedicated-workspace" | "remote" | "unavailable";

export interface WorkspaceRootInfo {
  scope: WorkspaceScopeRef;
  state: WorkspaceRootState;
  /** Friendly label, for example the bot workspace name. */
  label: string;
  /** Resolved location for the owner's accessible detail affordance only. */
  displayPath?: string;
  /** True only for a Murage-managed dedicated task workspace (U-02). */
  managed: boolean;
}

export type WorkspaceEntryKind = "file" | "directory" | "link" | "other";
export type WorkspaceEntryState = "local" | "missing" | "unsupported";

export interface WorkspaceEntry {
  name: string;
  /** Relative to the resolved workspace root, "/"-separated. */
  relativePath: string;
  kind: WorkspaceEntryKind;
  state: WorkspaceEntryState;
  bytes?: number;
  modifiedAt?: number;
  /** Present for regular files only. */
  revision?: FileRevision;
}

export interface WorkspaceListRequest {
  scope: WorkspaceScopeRef;
  /** "" is the workspace root. */
  directory: string;
  cursor?: string;
}

export interface WorkspaceListResponse {
  scope: WorkspaceScopeRef;
  root: WorkspaceRootInfo;
  directory: string;
  /** Changes when the listed directory changes; a stale cursor is refused. */
  directoryRevision: string;
  entries: WorkspaceEntry[];
  cursor?: string;
  /** More entries exist beyond this page or the listing could not finish. */
  incomplete: boolean;
}

export interface WorkspaceSearchRequest {
  scope: WorkspaceScopeRef;
  query: string;
  cursor?: string;
}

export interface WorkspaceSearchResponse {
  scope: WorkspaceScopeRef;
  root: WorkspaceRootInfo;
  query: string;
  entries: WorkspaceEntry[];
  cursor?: string;
  /** The entry/depth budget ended before the walk finished. */
  incomplete: boolean;
  scanned: number;
}

export type WorkspaceNewline = "lf" | "crlf" | "mixed" | "none";

export interface WorkspaceReadRequest { scope: WorkspaceScopeRef; relativePath: string }

/** Strict UTF-8 only; other encodings answer `unsupported-encoding`. */
export interface WorkspaceReadResult {
  scope: WorkspaceScopeRef;
  relativePath: string;
  revision: FileRevision;
  encoding: "utf-8";
  /** A leading UTF-8 BOM existed and was removed from `content`. */
  bom: boolean;
  /** Observed newline style; `content` keeps the original newlines. */
  newline: WorkspaceNewline;
  bytes: number;
  modifiedAt: number;
  content: string;
}
export type ReadResult = WorkspaceReadResult;

/**
 * F4-T5: what the owned Electron main process needs to hand one workspace
 * file to the operating system (open or reveal).
 *
 * The renderer never sees this. It asks the main process for a scope plus a
 * relative path; the main process adds the desktop proof, calls this route,
 * then rebuilds the path from `root` itself, walks every ancestor without
 * following a link, opens the file `O_NOFOLLOW` and refuses unless the
 * observed `identity` still matches. The server authorizes the file; the main
 * process closes the gap between that answer and the OS call.
 *
 * No bytes are returned and there is no size limit: the OS opens the file,
 * Murage does not read it.
 */
export interface WorkspaceNativeFile {
  scope: WorkspaceScopeRef;
  relativePath: string;
  /** Canonical (real) workspace root. Never shown to the renderer. */
  root: string;
  revision: FileRevision;
  bytes: number;
  /** Opaque identity of the exact observed file state. The main process
   * recomputes it from its own `fstat`; nothing else parses it. */
  identity: string;
}

export interface WorkspaceWriteRequest {
  scope: WorkspaceScopeRef;
  relativePath: string;
  /** Revision the draft was based on. `null` means exclusive create (Save a
   * copy / new file) and is refused when the path already exists. */
  baseRevision: FileRevision | null;
  /** Client-unique id; the receipt echoes it so a late response can never
   * settle another document. */
  requestId: string;
  /** Exact text to write. Newlines are written as given. */
  content: string;
  /** Prepend a UTF-8 BOM (preserve what was read). */
  bom: boolean;
  /** Client draft counter, echoed in the receipt. */
  draftRevision?: number;
}
export type WriteRequest = WorkspaceWriteRequest;

export interface SaveReceipt {
  requestId: string;
  scope: WorkspaceScopeRef;
  relativePath: string;
  previousRevision: FileRevision | null;
  revision: FileRevision;
  bytes: number;
  savedAt: number;
  draftRevision?: number;
  /** Set when the save also produced a saved version in Files. */
  artifactId?: string;
}

export interface WorkspaceSaveVersionRequest {
  scope: WorkspaceScopeRef;
  relativePath: string;
  /** The revision the owner chose; refused if the file changed since. */
  revision: FileRevision;
  name?: string;
}
export interface WorkspaceSaveVersionResponse { artifact: Artifact }

export const WORKSPACE_FILE_ERROR_STATUS = {
  "not-implemented": 501,
  "scope-unavailable": 404,
  "no-dedicated-workspace": 409,
  "remote-workspace": 409,
  "invalid-path": 400,
  "invalid-request": 400,
  "not-found": 404,
  "private-file": 403,
  "linked-file": 409,
  "not-regular-file": 409,
  "too-large": 413,
  "unsupported-encoding": 415,
  "revision-conflict": 409,
  "already-exists": 409,
  "bot-writing": 423,
  /** STOPRESTORE2: the only holder of the workspace is a turn the user already
   * stopped whose engine did not close within its budget. Retryable. */
  "workspace_stopped_turn_closing": 423,
  "root-changed": 409,
  "cursor-stale": 409,
  "quota-exceeded": 507,
  "write-failed": 500,
} as const;
export type WorkspaceFileErrorCode = keyof typeof WORKSPACE_FILE_ERROR_STATUS;
export const WORKSPACE_FILE_ERROR_CODES = Object.keys(WORKSPACE_FILE_ERROR_STATUS) as WorkspaceFileErrorCode[];

/** Every non-2xx body from /api/workspace-files/*. */
export interface WorkspaceFileErrorBody {
  error: string;
  code: WorkspaceFileErrorCode;
  /** On `revision-conflict`: the revision now on disk. */
  currentRevision?: FileRevision;
}

export function isWorkspaceFileErrorCode(value: unknown): value is WorkspaceFileErrorCode {
  return typeof value === "string" && Object.hasOwn(WORKSPACE_FILE_ERROR_STATUS, value);
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;
export function isWorkspaceScopeRef(value: unknown): value is WorkspaceScopeRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { botId, threadId } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof botId === "string" && ID.test(botId) && typeof threadId === "string" && ID.test(threadId);
}

export function isFileRevision(value: unknown): value is FileRevision {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,256}$/.test(value);
}

/** Syntax check only, mirroring server/artifacts.ts relative-path rules
 * (no absolute, backslash, colon, control characters, empty, dot or hidden
 * segments). The server still applies private-file and identity checks. */
export function isWorkspaceRelativePath(value: unknown, options: { allowRoot?: boolean } = {}): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return options.allowRoot === true;
  if (value.length > WORKSPACE_PATH_MAX_LENGTH || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith("/")) return false;
  return value.split("/").every(part => part.length > 0 && part.length <= WORKSPACE_PATH_SEGMENT_MAX_LENGTH && !part.startsWith("."));
}

/** True for a file path strictly inside the U-02 output namespace. */
export function isOutputNamespacePath(relativePath: unknown): relativePath is string {
  return isWorkspaceRelativePath(relativePath) && relativePath.split("/").length >= 2 && relativePath.split("/")[0] === OUTPUT_NAMESPACE;
}
