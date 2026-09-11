// Turning a path written in a transcript into something playable (0.1.52 M3,
// F5-T3). A bot hands over "/Users/sean/desk/outputs/take-2.wav" and the user
// attaches "/Volumes/Music/demo.mp3"; neither string is authority to read
// anything, and the frozen media contract deliberately accepts no absolute
// path (shared/media-assets.ts). So the renderer never turns a path into a
// URL. It asks the harness three questions instead, and a player appears only
// when all three are answered:
//
//   1. /api/workspace-files/root  — does this conversation have a dedicated
//      workspace at all, and where is it? (The answer is the canonical root
//      the server itself resolved; a link or a stale pin never matches.)
//   2. /api/workspace-files/list  — is this exact relative path a regular file
//      inside it right now, and what revision is it? (Discovery is the only
//      thing that may issue a revision; the client never invents one.)
//   3. /api/media/resolve         — pinned to that revision, what are the real
//      bytes, and may this surface stream them? (The server sniffs the type;
//      the extension only decided whether it was worth asking.)
//
// A path outside the workspace, a private file, a link, a directory, a
// changed file or a file this conversation does not own all end the same way:
// no player, and the caller's existing safe affordance stays exactly as it
// was. Failure is never a reason to fall back to loading the path directly.
import { mediaHintForPath, type MediaHint } from "./composer-attachments.ts";
import { MEDIA_ROUTES, type MediaAsset, type MediaResolveResponse } from "../../shared/media-assets";
import {
  isWorkspaceRelativePath, WORKSPACE_FILES_ROUTES,
  type FileRevision, type WorkspaceListResponse, type WorkspaceRootInfo, type WorkspaceScopeRef,
} from "../../shared/workspace-files";

/** The renderer's view of one transcript path. `pending` is the only state
 * that ever becomes something else. */
export type LocalMediaResolution =
  /** Resolved, playable bytes and a capability URL that expires. */
  | { state: "ready"; asset: MediaAsset; url: string; expiresAt?: number }
  /** The harness knows the file but will not play it here, and said why. */
  | { state: "unplayable"; asset: MediaAsset; reason: MediaUnplayableReason }
  /** Not this conversation's file, or the harness would not say. No claim is
   * made about whether the path exists — that is the point. */
  | { state: "unavailable" };

export type MediaUnplayableReason = "missing" | "changed" | "denied" | "unsupported";

export interface LocalMediaRequest {
  scope: WorkspaceScopeRef;
  /** Exactly the string the transcript carried. */
  absolutePath: string;
}

/** Injected so tests (and the e2e fixture) drive this without a real harness.
 * Matches `api` in src/state/store.tsx: resolved body, or a thrown Error
 * carrying `status`. */
export type MediaApi = (path: string, init?: RequestInit) => Promise<any>;

/** A directory with more entries than this is not walked further looking for
 * one file; the caller keeps its plain affordance. Five pages of 200. */
export const MEDIA_LIST_MAX_PAGES = 5;
/** How long a resolution is reused for the same path. Short, because the
 * answer is about a file on disk that a bot may still be writing. The
 * capability inside it lives ten minutes (MEDIA_CAPABILITY_TTL_MS). */
export const MEDIA_RESOLVE_CACHE_MS = 60_000;

// ── Pure path arithmetic ─────────────────────────────────────────────────

const WINDOWS_ROOT = /^[a-zA-Z]:[\\/]/;

/** The workspace-relative form of `absolutePath`, or null when it is not
 * strictly inside `root`. Purely textual: it decides what to *ask*, never
 * what may be read. The server re-walks the real path with lstat and refuses
 * links, private names and anything that escapes the root regardless of what
 * this returns.
 *
 * Windows paths compare case-insensitively because its filesystems do; POSIX
 * paths do not, so "/home/Sean" never matches "/home/sean". */
export function workspaceRelativePath(root: string | undefined, absolutePath: string): string | null {
  if (!root || !absolutePath) return null;
  const windows = WINDOWS_ROOT.test(root);
  const slashes = (value: string) => (windows ? value.replace(/\\/g, "/") : value);
  const trim = (value: string) => slashes(value).replace(/\/+$/, "");
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  const base = trim(root);
  const full = slashes(absolutePath).replace(/\/+$/, "");
  if (!base || !full || fold(full) === fold(base)) return null;
  if (!fold(full).startsWith(`${fold(base)}/`)) return null;
  const relative = full.slice(base.length + 1);
  // No empty, dot, hidden or over-long segment, no backslash, colon or
  // control character — the same syntax the server's own validator applies,
  // so ".." can never survive this.
  return isWorkspaceRelativePath(relative) ? relative : null;
}

/** The directory part of a workspace-relative path ("" for the root). */
export function workspaceParentDirectory(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut < 0 ? "" : relativePath.slice(0, cut);
}

// ── The three questions ──────────────────────────────────────────────────

const query = (route: string, params: Readonly<Record<string, string>>) =>
  `${route}?${new URLSearchParams({ ...params }).toString()}`;
const scopeQuery = (scope: WorkspaceScopeRef) => ({ botId: scope.botId, threadId: scope.threadId });

async function workspaceRoot(api: MediaApi, scope: WorkspaceScopeRef): Promise<WorkspaceRootInfo | null> {
  try {
    const info = await api(query(WORKSPACE_FILES_ROUTES.root, scopeQuery(scope))) as WorkspaceRootInfo;
    return info && info.state === "ready" && typeof info.displayPath === "string" ? info : null;
  } catch {
    // Every refusal shape — no dedicated workspace, a remote computer, a
    // surface that may not ask — means the same thing here.
    return null;
  }
}

/** The revision discovery currently reports for one file, or null. */
async function fileRevision(api: MediaApi, scope: WorkspaceScopeRef, relativePath: string): Promise<FileRevision | null> {
  const directory = workspaceParentDirectory(relativePath);
  const name = relativePath.slice(directory ? directory.length + 1 : 0);
  let cursor: string | undefined;
  for (let page = 0; page < MEDIA_LIST_MAX_PAGES; page++) {
    let response: WorkspaceListResponse;
    try {
      response = await api(query(WORKSPACE_FILES_ROUTES.list, { ...scopeQuery(scope), directory, ...(cursor ? { cursor } : {}) })) as WorkspaceListResponse;
    } catch {
      return null;
    }
    const entry = response?.entries?.find(item => item.name === name);
    // A link or a directory with this name is an answer, not a reason to keep
    // paging: only a regular file carries a revision.
    if (entry) return entry.kind === "file" && entry.revision ? entry.revision : null;
    cursor = response?.cursor;
    if (!cursor) return null;
  }
  return null;
}

const PLAYER_KINDS = new Set(["audio", "video"]);

function unplayableReason(asset: MediaAsset): MediaUnplayableReason {
  if (asset.availability === "missing") return "missing";
  if (asset.availability === "changed") return "changed";
  if (asset.availability === "denied") return "denied";
  return "unsupported";
}

/** Ask all three questions for one transcript path. Never throws: a caller
 * renders its own plain affordance for anything but `ready`. */
export async function resolveLocalMedia(request: LocalMediaRequest, api: MediaApi): Promise<LocalMediaResolution> {
  const root = await workspaceRoot(api, request.scope);
  if (!root) return { state: "unavailable" };
  const relativePath = workspaceRelativePath(root.displayPath, request.absolutePath);
  if (!relativePath) return { state: "unavailable" };
  const revision = await fileRevision(api, request.scope, relativePath);
  if (!revision) return { state: "unavailable" };
  let resolved: MediaResolveResponse;
  try {
    resolved = await api(MEDIA_ROUTES.resolve, {
      method: "POST",
      body: JSON.stringify({ ref: { source: "workspace", scope: request.scope, relativePath, revision } }),
    }) as MediaResolveResponse;
  } catch {
    return { state: "unavailable" };
  }
  const asset = resolved?.asset;
  if (!asset || typeof asset.id !== "string") return { state: "unavailable" };
  // A file that turned out to be an image, a document or anything else is not
  // this component's business: the caller keeps its own affordance.
  if (!PLAYER_KINDS.has(asset.kind)) return { state: "unavailable" };
  if (asset.availability !== "ready" || typeof resolved.url !== "string" || !resolved.url) {
    return { state: "unplayable", asset, reason: unplayableReason(asset) };
  }
  return { state: "ready", asset, url: resolved.url, ...(typeof resolved.expiresAt === "number" ? { expiresAt: resolved.expiresAt } : {}) };
}

// ── Cache and single flight ──────────────────────────────────────────────
//
// A transcript re-renders constantly (streaming, scrolling, a skin change).
// Three requests per file link per render would be absurd, and two players
// for the same file must not disagree, so one in-flight promise is shared and
// its answer is reused briefly.

interface CacheEntry { at: number; promise: Promise<LocalMediaResolution> }
const cache = new Map<string, CacheEntry>();
const cacheKey = (request: LocalMediaRequest) =>
  JSON.stringify([request.scope.botId, request.scope.threadId, request.absolutePath]);

/** `resolveLocalMedia`, shared and cached per conversation + path. */
export function localMedia(request: LocalMediaRequest, api: MediaApi, now = Date.now()): Promise<LocalMediaResolution> {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached && now - cached.at < MEDIA_RESOLVE_CACHE_MS) return cached.promise;
  const promise = resolveLocalMedia(request, api).catch((): LocalMediaResolution => ({ state: "unavailable" }));
  cache.set(key, { at: now, promise });
  // Bounded: a long room transcript must not pin every path it ever showed.
  while (cache.size > 256) cache.delete(cache.keys().next().value!);
  return promise;
}

/** Drop a path's cached answer — after a capability expires, or in tests. */
export function forgetLocalMedia(request?: LocalMediaRequest): void {
  if (!request) cache.clear();
  else cache.delete(cacheKey(request));
}

/** True when this path is worth asking about at all. */
export function playableHint(path: string): MediaHint | null {
  return mediaHintForPath(path);
}
