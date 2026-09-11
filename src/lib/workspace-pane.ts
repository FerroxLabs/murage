// Workspace pane state (F4-T3): the bot-linked rail beside the chat, its
// preview/editor tabs and the transport those tabs use. Kept free of React
// and the DOM so the node renderer suite can drive every rule here.
//
// Rules the reducer keeps:
// - A single click reuses the one clean, unpinned preview tab; explicit
//   pin or edit creates a persistent tab. A dirty tab is never replaced.
// - Closing a dirty tab is refused until the owner confirms; nothing about
//   the tab changes while the question is open.
// - Every tab names its file by scope + relative path (an identity the
//   server issued), never by an absolute path. Opening another bot's file
//   never changes the selected conversation: tabs carry their own scope.
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";
import { WorkspaceFileRequestError, documentKey, type DocumentIdentity } from "@/lib/document-session";
import { workspaceUrl, type ApiCall } from "@/lib/files-view";
import {
  WORKSPACE_FILES_ROUTES,
  isWorkspaceFileErrorCode,
  type FileRevision,
  type SaveReceipt,
  type WorkspaceEntry,
  type WorkspaceListResponse,
  type WorkspaceReadResult,
  type WorkspaceScopeRef,
  type WorkspaceWriteRequest,
} from "../../shared/workspace-files";

// ── Geometry ─────────────────────────────────────────────────────────────

/** The rail can never be narrower than this: the editor toolbar wraps below it. */
export const WORKSPACE_PANE_MIN_WIDTH = 320;
export const WORKSPACE_PANE_DEFAULT_WIDTH = 440;
/** The conversation beside the rail keeps at least this much on a wide
 * screen; below `md` the rail covers the chat instead of squeezing it. */
export const WORKSPACE_PANE_MIN_CHAT_WIDTH = 360;
/** Where the width survives a reload (per browser, a convenience only). */
export const WORKSPACE_PANE_WIDTH_KEY = "murage-workspace-pane-width";

/** Clamp a requested rail width to what the container can give. With no
 * container measurement yet, only the minimum applies. */
export function clampWorkspaceWidth(width: number, containerWidth?: number): number {
  const requested = Number.isFinite(width) ? Math.round(width) : WORKSPACE_PANE_DEFAULT_WIDTH;
  const max = containerWidth && containerWidth > 0
    ? Math.max(WORKSPACE_PANE_MIN_WIDTH, containerWidth - WORKSPACE_PANE_MIN_CHAT_WIDTH)
    : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(WORKSPACE_PANE_MIN_WIDTH, requested));
}

// ── Tabs ─────────────────────────────────────────────────────────────────

export type WorkspaceTabMode = "preview" | "edit";

export interface WorkspaceTab {
  id: string;
  scope: WorkspaceScopeRef;
  relativePath: string;
  mode: WorkspaceTabMode;
  /** A pinned tab (or any edit tab) is persistent; only an unpinned preview
   * tab is reused by the next single click. */
  pinned: boolean;
  /** Unsaved text exists in this tab's editor. Set by the editor, read by
   * the reducer: a dirty tab is never replaced or closed without asking. */
  dirty: boolean;
}

export interface WorkspacePaneState {
  open: boolean;
  width: number;
  /** The document takes the whole column and the chat steps aside. */
  expanded: boolean;
  /** Below `md` the pane and the chat take turns; above it this is ignored. */
  compactView: "chat" | "workspace";
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** A close refused because the tab holds unsaved text. The pane asks. */
  closeRequest: string | null;
}

export const initialWorkspacePaneState: WorkspacePaneState = {
  open: false,
  width: WORKSPACE_PANE_DEFAULT_WIDTH,
  expanded: false,
  compactView: "chat",
  tabs: [],
  activeTabId: null,
  closeRequest: null,
};

export interface OpenWorkspaceFile {
  scope: WorkspaceScopeRef;
  relativePath: string;
  mode?: WorkspaceTabMode;
  pin?: boolean;
}

export type WorkspacePaneAction =
  /** Open (or focus) one file. A preview reuses the clean preview tab. */
  | ({ type: "open"; id?: string } & OpenWorkspaceFile)
  /** Show the rail for a conversation without opening a file. */
  | { type: "show" }
  | { type: "activate"; id: string }
  | { type: "close"; id: string; force?: boolean }
  | { type: "cancelClose" }
  | { type: "pin"; id: string }
  | { type: "setMode"; id: string; mode: WorkspaceTabMode }
  | { type: "setDirty"; id: string; dirty: boolean }
  | { type: "setOpen"; open: boolean }
  | { type: "setWidth"; width: number; containerWidth?: number }
  | { type: "setExpanded"; expanded: boolean }
  | { type: "setCompactView"; view: "chat" | "workspace" };

export function tabIdentity(tab: Pick<WorkspaceTab, "scope" | "relativePath">): DocumentIdentity {
  return { scope: { botId: tab.scope.botId, threadId: tab.scope.threadId }, relativePath: tab.relativePath };
}

export function tabKey(tab: Pick<WorkspaceTab, "scope" | "relativePath">): string {
  return documentKey(tabIdentity(tab));
}

export function fileName(relativePath: string): string {
  return relativePath.split("/").pop() || relativePath;
}

/** The one tab a single click may reuse: an unpinned, clean preview. */
export function replaceableTab(tabs: WorkspaceTab[]): WorkspaceTab | undefined {
  return tabs.find(tab => tab.mode === "preview" && !tab.pinned && !tab.dirty);
}

function newTabId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function shown(state: WorkspacePaneState): WorkspacePaneState {
  return state.open && state.compactView === "workspace" ? state : { ...state, open: true, compactView: "workspace" };
}

export function workspacePaneReducer(state: WorkspacePaneState, action: WorkspacePaneAction): WorkspacePaneState {
  switch (action.type) {
    case "show":
      return shown(state);
    case "open": {
      const mode = action.mode ?? "preview";
      const persistent = mode === "edit" || action.pin === true;
      const key = tabKey(action);
      const existing = state.tabs.find(tab => tabKey(tab) === key);
      if (existing) {
        // Already open: focus it. Asking to edit or pin makes it persistent;
        // asking to preview an edit tab never demotes it (its text may be
        // unsaved), and a dirty preview stays exactly as it is.
        const tab = persistent && (!existing.pinned || (mode === "edit" && existing.mode !== "edit"))
          ? { ...existing, pinned: true, mode: mode === "edit" ? "edit" as const : existing.mode }
          : existing;
        return shown({
          ...state,
          tabs: tab === existing ? state.tabs : state.tabs.map(item => (item === existing ? tab : item)),
          activeTabId: existing.id,
          closeRequest: null,
        });
      }
      const tab: WorkspaceTab = {
        id: action.id ?? newTabId(),
        scope: { botId: action.scope.botId, threadId: action.scope.threadId },
        relativePath: action.relativePath,
        mode,
        pinned: persistent,
        dirty: false,
      };
      const reusable = persistent ? undefined : replaceableTab(state.tabs);
      const tabs = reusable
        ? state.tabs.map(item => (item === reusable ? tab : item))
        : [...state.tabs, tab];
      return shown({ ...state, tabs, activeTabId: tab.id, closeRequest: null });
    }
    case "activate": {
      if (!state.tabs.some(tab => tab.id === action.id)) return state;
      return shown({ ...state, activeTabId: action.id, closeRequest: null });
    }
    case "close": {
      const index = state.tabs.findIndex(tab => tab.id === action.id);
      if (index < 0) return state.closeRequest === action.id ? { ...state, closeRequest: null } : state;
      const tab = state.tabs[index]!;
      if (tab.dirty && !action.force) return state.closeRequest === tab.id ? state : { ...state, closeRequest: tab.id };
      const tabs = state.tabs.filter(item => item.id !== tab.id);
      const activeTabId = state.activeTabId === tab.id
        ? (tabs[index] ?? tabs[index - 1])?.id ?? null
        : state.activeTabId;
      return { ...state, tabs, activeTabId, closeRequest: state.closeRequest === tab.id ? null : state.closeRequest };
    }
    case "cancelClose":
      return state.closeRequest === null ? state : { ...state, closeRequest: null };
    case "pin":
      return mapTab(state, action.id, tab => (tab.pinned ? tab : { ...tab, pinned: true }));
    case "setMode":
      // An edit tab is persistent by definition; a dirty tab keeps its
      // editor, since Preview would hide the unsaved text.
      return mapTab(state, action.id, tab => {
        if (tab.mode === action.mode) return tab;
        if (action.mode === "preview" && tab.dirty) return tab;
        return { ...tab, mode: action.mode, pinned: action.mode === "edit" ? true : tab.pinned };
      });
    case "setDirty":
      return mapTab(state, action.id, tab => (tab.dirty === action.dirty ? tab : { ...tab, dirty: action.dirty }));
    case "setOpen":
      if (state.open === action.open) return action.open ? state : (state.closeRequest ? { ...state, closeRequest: null } : state);
      return { ...state, open: action.open, closeRequest: null, ...(action.open ? {} : { expanded: false }) };
    case "setWidth": {
      const width = clampWorkspaceWidth(action.width, action.containerWidth);
      return width === state.width ? state : { ...state, width };
    }
    case "setExpanded":
      return state.expanded === action.expanded ? state : { ...state, expanded: action.expanded };
    case "setCompactView":
      return state.compactView === action.view ? state : { ...state, compactView: action.view };
    default:
      return state;
  }
}

function mapTab(state: WorkspacePaneState, id: string, update: (tab: WorkspaceTab) => WorkspaceTab): WorkspacePaneState {
  let changed = false;
  const tabs = state.tabs.map(tab => {
    if (tab.id !== id) return tab;
    const next = update(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

export function activeWorkspaceTab(state: WorkspacePaneState): WorkspaceTab | undefined {
  return state.tabs.find(tab => tab.id === state.activeTabId);
}

// ── Document kinds ───────────────────────────────────────────────────────

/** How the pane shows one file. `binary` never attempts a text read: it is
 * an honest open/download fallback, not a blank preview. */
export type WorkspaceDocumentKind = "markdown" | "html" | "image" | "text" | "binary";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const BINARY_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
  "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "dmg", "pkg", "exe", "msi", "bin", "iso", "jar", "class", "wasm", "so", "dylib", "dll",
  "mp3", "wav", "ogg", "m4a", "flac", "aac", "mp4", "webm", "mov", "mkv", "avi",
  "woff", "woff2", "ttf", "otf", "eot", "ico", "icns", "bmp", "tif", "tiff", "psd", "ai", "sketch", "fig",
  "sqlite", "db", "pyc", "o", "a",
]);

export function isMarkdownPath(relativePath: string): boolean {
  return /\.(md|markdown)$/i.test(relativePath);
}

export function documentKindForPath(relativePath: string): WorkspaceDocumentKind {
  if (isMarkdownPath(relativePath)) return "markdown";
  if (/\.html?$/i.test(relativePath)) return "html";
  const extension = fileName(relativePath).split(".").length > 1 ? fileName(relativePath).split(".").pop()!.toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  return "text";
}

/** A "Save a copy" name beside the original: `report.md` → `report copy.md`,
 * then `report copy 2.md`. Same folder, same extension. */
export function copyPath(relativePath: string, attempt = 0): string {
  const slash = relativePath.lastIndexOf("/");
  const directory = slash >= 0 ? relativePath.slice(0, slash + 1) : "";
  const name = relativePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${directory}${stem} copy${attempt > 0 ? ` ${attempt + 1}` : ""}${extension}`;
}

// ── Transport ────────────────────────────────────────────────────────────

/** A fetch-shaped function; injected in tests and in the e2e fixture. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

/**
 * Like `api()` in the store, but a workspace refusal keeps its `code` and
 * `currentRevision`: the DocumentSession decides what a `revision-conflict`
 * or `bot-writing` means, and it cannot from a bare message.
 */
export async function workspaceApi(path: string, init?: RequestInit, fetchImpl: FetchLike = (input, options) => fetch(input, options)): Promise<unknown> {
  await ensureDesktopSurfaceSecret();
  const response = await fetchImpl(path, {
    ...init,
    headers: { "content-type": "application/json", "x-murage-surface": "desktop", ...desktopSurfaceHeaders(), ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown; currentRevision?: unknown };
  if (response.ok) return body;
  const message = typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`;
  if (isWorkspaceFileErrorCode(body.code)) {
    throw Object.assign(
      new WorkspaceFileRequestError(body.code, message, typeof body.currentRevision === "string" ? body.currentRevision as FileRevision : undefined),
      { status: response.status },
    );
  }
  throw Object.assign(new Error(message), { status: response.status });
}

export function readWorkspaceFile(call: ApiCall, scope: WorkspaceScopeRef, relativePath: string, signal?: AbortSignal): Promise<WorkspaceReadResult> {
  return call(workspaceUrl(WORKSPACE_FILES_ROUTES.read, scope, { path: relativePath }), signal ? { signal } : undefined) as Promise<WorkspaceReadResult>;
}

export function writeWorkspaceFile(call: ApiCall, request: WorkspaceWriteRequest): Promise<SaveReceipt> {
  return call(WORKSPACE_FILES_ROUTES.write, { method: "POST", body: JSON.stringify(request) }) as Promise<SaveReceipt>;
}

/** How many listing pages a revision probe walks before giving up. */
export const WORKSPACE_PROBE_MAX_PAGES = 5;

export type RevisionProbe =
  | { state: "found"; entry: WorkspaceEntry }
  | { state: "missing" }
  /** The folder was too large to walk, or could not be listed: no claim. */
  | { state: "unknown" };

/**
 * Is the file still the revision the editor holds? Answered from the parent
 * folder's listing (a stat per entry) rather than a full read, so a 2 MiB
 * document is not re-read every few seconds just to learn nothing changed.
 */
export async function probeWorkspaceRevision(call: ApiCall, scope: WorkspaceScopeRef, relativePath: string, signal?: AbortSignal): Promise<RevisionProbe> {
  const slash = relativePath.lastIndexOf("/");
  const directory = slash >= 0 ? relativePath.slice(0, slash) : "";
  let cursor: string | undefined;
  try {
    for (let page = 0; page < WORKSPACE_PROBE_MAX_PAGES; page++) {
      const response = await call(
        workspaceUrl(WORKSPACE_FILES_ROUTES.list, scope, { directory: directory || undefined, cursor }),
        signal ? { signal } : undefined,
      ) as WorkspaceListResponse;
      const entry = response.entries.find(item => item.relativePath === relativePath);
      if (entry) return { state: "found", entry };
      if (!response.cursor) return response.incomplete ? { state: "unknown" } : { state: "missing" };
      cursor = response.cursor;
    }
  } catch (error) {
    // The file's own folder is gone: the file is too. Anything else (the
    // scope went away, a network error, a stale cursor) is not knowledge.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "not-found") return { state: "missing" };
  }
  return { state: "unknown" };
}
