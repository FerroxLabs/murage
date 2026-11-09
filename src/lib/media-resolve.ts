import { mediaHintForPath, type MediaHint } from "./composer-attachments.ts";
import { MEDIA_ROUTES, type MediaAsset, type MediaResolveResponse } from "../../shared/media-assets";
import { workspaceFilePath } from "./workspace-links.ts";
import { isFileRevision, isOutputNamespacePath, isWorkspaceRelativePath, OUTPUT_NAMESPACE, WORKSPACE_FILES_ROUTES, type FileRevision, type WorkspaceScopeRef, type WorkspaceEntry } from "../../shared/workspace-files";

export type MediaUnplayableReason = "missing" | "changed" | "denied" | "unsupported";
export type LocalMediaNotReady = { state: "unavailable"; why: "outside" | "remote" | "not-listed" | "unanswered" } | { state: "unplayable"; asset: MediaAsset; reason: MediaUnplayableReason } | { state: "exhausted" };
export type LocalMediaResolution = LocalMediaNotReady | { state: "ready"; asset: MediaAsset; url: string; expiresAt?: number; relativePath: string; canonicalKey: string; generation: number };
export type LocalMediaRequest = { scope: WorkspaceScopeRef } & ({ absolutePath: string; relativePath?: never } | { relativePath: string; absolutePath?: never });
export type MediaApi = (path: string, init?: RequestInit) => Promise<any>;
export const MEDIA_LIST_MAX_PAGES = 5;
export const MEDIA_RESOLVE_CACHE_MS = 60_000;
export const LOCAL_MEDIA_DEADLINE_MS = 15_000;
const unavailable = (why: Extract<LocalMediaNotReady, {state: "unavailable"}>["why"]): LocalMediaResolution => ({ state: "unavailable", why });
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


type Root = { state: "ready"; displayPath: string } | { state: "no-dedicated-workspace" | "remote" | "unanswered" };
type Listing = { state: "found"; entry: WorkspaceEntry } | { state: "absent" | "unanswered" };
const scopeKey = (scope: WorkspaceScopeRef) => JSON.stringify([scope.botId, scope.threadId]);
const requestKey = (request: LocalMediaRequest) => JSON.stringify([request.scope.botId, request.scope.threadId, request.absolutePath ?? null, request.relativePath ?? null]);
const canonicalKey = (scope: WorkspaceScopeRef, path: string) => JSON.stringify([scope.botId, scope.threadId, path]);
const query = (route: string, scope: WorkspaceScopeRef, rest: Record<string, string> = {}) => `${route}?${new URLSearchParams({ ...scope, ...rest })}`;
const sameScope = (a: any, b: WorkspaceScopeRef) => a?.botId === b.botId && a?.threadId === b.threadId;
const discoveries = new Map<string, Promise<any>>();
function shared<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const previous = discoveries.get(key); if (previous) return previous;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Shared discovery deadline")); }, LOCAL_MEDIA_DEADLINE_MS); });
  const promise = Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline]).finally(() => clearTimeout(timer));
  discoveries.set(key, promise);
  void promise.finally(() => { if (discoveries.get(key) === promise) discoveries.delete(key); }).catch(() => {});
  return promise;
}
async function workspaceRoot(api: MediaApi, scope: WorkspaceScopeRef): Promise<Root> {
  return shared<Root>(`root:${scopeKey(scope)}`, async signal => {
    try {
      const info = await api(query(WORKSPACE_FILES_ROUTES.root, scope), { signal });
      if (!sameScope(info?.scope, scope)) return { state: "unanswered" };
      if (info.state === "remote" || info.state === "no-dedicated-workspace") return { state: info.state };
      if (info.state === "ready" && typeof info.displayPath === "string" && (info.displayPath.startsWith("/") || WINDOWS_ROOT.test(info.displayPath))) return { state: "ready", displayPath: info.displayPath };
    } catch { /* Transport failure is not proof of absence. */ }
    return { state: "unanswered" };
  }).catch(() => ({ state: "unanswered" }));
}
async function listed(api: MediaApi, scope: WorkspaceScopeRef, directory: string, name: string, signal?: AbortSignal): Promise<Listing> {
  let cursor: string | undefined, revision: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MEDIA_LIST_MAX_PAGES; page++) {
    if (signal?.aborted) return { state: "unanswered" };
    let response: any;
    try { response = await shared(`list:${scopeKey(scope)}:${directory}:${cursor ?? ""}`, signal => api(query(WORKSPACE_FILES_ROUTES.list, scope, { directory, ...(cursor ? { cursor } : {}) }), { signal })); }
    catch { return { state: "unanswered" }; }
    if (!sameScope(response?.scope, scope) || response.directory !== directory || typeof response.directoryRevision !== "string" || !response.directoryRevision || typeof response.incomplete !== "boolean" || !Array.isArray(response.entries)
      || (response.cursor !== undefined && (typeof response.cursor !== "string" || !response.cursor || response.cursor.length > 1024))
      || (revision !== undefined && revision !== response.directoryRevision)) return { state: "unanswered" };
    revision = response.directoryRevision;
    for (const entry of response.entries) {
      if (!entry || typeof entry.name !== "string" || (!isWorkspaceRelativePath(entry.name) && !(entry.state === "unsupported" && ["directory", "other"].includes(entry.kind) && entry.revision === undefined)) || !entry.name || entry.name.includes("/") || entry.relativePath !== (directory ? `${directory}/${entry.name}` : entry.name) || !["file", "directory", "link", "other"].includes(entry.kind) || !["local", "missing", "unsupported"].includes(entry.state) || (entry.revision !== undefined && !isFileRevision(entry.revision))) return { state: "unanswered" };
    }
    const found = response.entries.find((entry: WorkspaceEntry) => entry.name === name);
    if (found) return { state: "found", entry: found };
    if (response.cursor === undefined) return { state: response.incomplete ? "unanswered" : "absent" };
    if (!response.incomplete || seen.has(response.cursor)) return { state: "unanswered" };
    seen.add(response.cursor); cursor = response.cursor;
  }
  return { state: "unanswered" };
}
async function fileRevision(api: MediaApi, scope: WorkspaceScopeRef, path: string, parents: boolean, signal?: AbortSignal): Promise<{ state: "found"; revision: FileRevision } | { state: "absent" | "unanswered" }> {
  const parts = path.split("/");
  if (parents) for (let i = 0; i < parts.length - 1; i++) {
    const found = await listed(api, scope, parts.slice(0, i).join("/"), parts[i]!, signal);
    if (found.state !== "found") return found;
    if (found.entry.kind !== "directory") return { state: "absent" };
    if (found.entry.state !== "local") return { state: "unanswered" };
  }
  const found = await listed(api, scope, workspaceParentDirectory(path), parts.at(-1)!, signal);
  if (found.state !== "found") return found;
  return found.entry.kind === "file" && isFileRevision(found.entry.revision) ? { state: "found", revision: found.entry.revision } : { state: "absent" };
}
interface Entry { pendingReplacements: Set<number>; generationRefs: Map<number, number>; aliases: Set<string>; subscribers: number; key: string; generation: number; at: number; pending?: Promise<LocalMediaResolution>; renewal?: Promise<LocalMediaResolution>; result?: LocalMediaResolution; replacements: Map<number, Promise<LocalMediaResolution>> }
interface Alias { key: string; at: number; promise?: Promise<LocalMediaResolution>; entry?: Entry; pending: boolean; cancelQueued?: () => void }
const entries = new Map<string, Entry>(), aliases = new Map<string, Alias>();
const listeners = new Map<string, Set<(value: LocalMediaResolution) => void>>();
let active = 0, nextGeneration = 0;
const queue: Array<() => void> = [];
function queued<T>(work: () => Promise<T>, canceled: T, alias?: Alias): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => { if (alias) alias.cancelQueued = undefined; active++; void work().then(resolve, reject).finally(() => { active--; queue.shift()?.(); }); };
    if (active < 4) start(); else {
      queue.push(start);
      if (alias) alias.cancelQueued = () => { const index = queue.indexOf(start); if (index >= 0) { queue.splice(index, 1); resolve(canceled); } };
    }
  });
}
// Insertion ordered pools contain only settled, unreferenced owners.
// Retained conversation history is never traversed by maintenance.
const eligible = new Map<string, Entry>(), negatives = new Map<string, Alias>();
function referenced(entry: Entry): boolean { return entry.subscribers > 0; }
function maintain(alias?: Alias, entry = alias?.entry): void {
  if (entry) {
    if (entry.pending || entry.renewal || referenced(entry)) eligible.delete(entry.key);
    else if (!eligible.has(entry.key)) eligible.set(entry.key, entry);
  }
  if (alias) {
    if (alias.pending || alias.entry || listeners.get(alias.key)?.size) negatives.delete(alias.key);
    else if (!negatives.has(alias.key)) negatives.set(alias.key, alias);
  }
}
function detach(alias: Alias): void {
  const entry = alias.entry;
  if (entry) { entry.aliases.delete(alias.key); entry.subscribers -= listeners.get(alias.key)?.size ?? 0; maintain(undefined, entry); }
  negatives.delete(alias.key);
}
function evict(): void {
  while (eligible.size > 256) {
    const entry = eligible.get(eligible.keys().next().value!)!;
    eligible.delete(entry.key); entries.delete(entry.key);
    for (const key of entry.aliases) { const alias = aliases.get(key); if (alias?.entry === entry) aliases.delete(key); }
  }
  while (negatives.size > 256) {
    const key = negatives.keys().next().value!; negatives.delete(key); aliases.delete(key);
  }
}
function publish(entry: Entry, result: LocalMediaResolution) {
  entry.result = result; entry.at = Date.now();
  for (const key of entry.aliases) for (const listener of listeners.get(key) ?? []) listener(result);
}
export function subscribeLocalMedia(request: LocalMediaRequest, listener: (value: LocalMediaResolution) => void): () => void {
  const key = requestKey(request), set = listeners.get(key) ?? new Set();
  const added = !set.has(listener); listeners.set(key, set); set.add(listener);
  const alias = aliases.get(key); if (added && alias?.entry) alias.entry.subscribers++;
  maintain(alias);
  let removed = false;
  return () => {
    if (removed) return; removed = true;
    const alias = aliases.get(key);
    if (set.delete(listener) && alias?.entry) alias.entry.subscribers--;
    if (!set.size) { listeners.delete(key); if (alias?.cancelQueued) { alias.cancelQueued(); detach(alias); aliases.delete(key); } }
    maintain(alias); evict();
  };
}
async function discover(request: LocalMediaRequest, api: MediaApi, signal: AbortSignal, force: boolean, alias?: Alias): Promise<LocalMediaResolution> {
  const root = await workspaceRoot(api, request.scope);
  if (signal.aborted) return unavailable("unanswered");
  if (root.state !== "ready") return unavailable(root.state === "remote" ? "remote" : root.state === "no-dedicated-workspace" ? "outside" : "unanswered");
  const path = request.absolutePath !== undefined ? workspaceRelativePath(root.displayPath, request.absolutePath) : isWorkspaceRelativePath(request.relativePath) ? request.relativePath : null;
  if (!path) return unavailable("outside");
  const paths = request.relativePath !== undefined && !isOutputNamespacePath(path) ? [`${OUTPUT_NAMESPACE}/${path}`, path] : [path];
  for (const selected of paths) {
    const found = await fileRevision(api, request.scope, selected, request.relativePath !== undefined, signal);
    if (signal.aborted || found.state === "unanswered") return unavailable("unanswered");
    if (found.state !== "found") continue;
    const key = canonicalKey(request.scope, selected);
    let entry = entries.get(key);
    if (!entry) { entry = { pendingReplacements: new Set(), generationRefs: new Map(), aliases: new Set(), subscribers: 0, key, generation: 0, at: Date.now(), replacements: new Map() }; entries.set(key, entry); }
    if (alias && alias.entry !== entry) {
      detach(alias); alias.entry = entry; entry.aliases.add(alias.key);
      entry.subscribers += listeners.get(alias.key)?.size ?? 0; maintain(alias);
    }
    if (entry.pending) return entry.pending;
    if (!force && entry.result && Date.now() - entry.at < MEDIA_RESOLVE_CACHE_MS) return entry.result;
    const owner = entry, generation = owner.generation = ++nextGeneration;
    const pending = (async (): Promise<LocalMediaResolution> => {
      let response: MediaResolveResponse;
      try { response = await api(MEDIA_ROUTES.resolve, { method: "POST", signal, body: JSON.stringify({ ref: { source: "workspace", scope: request.scope, relativePath: selected, revision: found.revision } }) }); }
      catch { return unavailable("unanswered"); }
      if (signal.aborted) return unavailable("unanswered");
      const asset = response?.asset;
      if (!asset || typeof asset.id !== "string" || !["audio", "video", "image", "file"].includes(asset.kind)) return unavailable("unanswered");
      if (asset.availability !== "ready" || !response.url) return { state: "unplayable", asset, reason: ["missing", "changed", "denied"].includes(asset.availability) ? asset.availability as MediaUnplayableReason : "unsupported" };
      return { state: "ready", asset, url: response.url, expiresAt: response.expiresAt, relativePath: selected, canonicalKey: key, generation };
    })();
    owner.pending = pending; maintain(undefined, owner);
    try { const result = await pending; publish(owner, result); return result; }
    finally { if (owner.pending === pending) owner.pending = undefined; maintain(undefined, owner); evict(); }
  }
  return unavailable("not-listed");
}
function run(request: LocalMediaRequest, api: MediaApi, force: boolean, alias?: Alias): Promise<LocalMediaResolution> {
  const controller = new AbortController();
  const boundedApi: MediaApi = (path, init) => new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Media discovery deadline"));
    if (controller.signal.aborted) { abort(); return; }
    controller.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => api(path, { ...init, signal: controller.signal })).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<LocalMediaResolution>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unavailable("unanswered")); }, LOCAL_MEDIA_DEADLINE_MS); });
  const cancelled = Symbol("cancelled discovery");
  const work = queued<LocalMediaResolution | typeof cancelled>(() => controller.signal.aborted ? Promise.resolve(unavailable("unanswered")) : Promise.race([discover(request, boundedApi, controller.signal, force, alias), timeout]), cancelled, alias);
  return Promise.race([work, timeout]).catch(() => unavailable("unanswered")).then(result => {
    // A removed queue item never asked discovery and cannot change other aliases.
    if (result === cancelled) return unavailable("unanswered");
    // Discovery can exit before resolving a new canonical generation. Keep
    // that outcome for every alias instead of exposing the previous capability.
    if (result.state === "unavailable" && alias?.entry && alias.entry.result !== result) publish(alias.entry, result);
    return result;
  }).finally(() => { clearTimeout(timer!); });
}
export function resolveLocalMedia(request: LocalMediaRequest, api: MediaApi): Promise<LocalMediaResolution> { return run(request, api, true); }
export function localMedia(request: LocalMediaRequest, api: MediaApi, now = Date.now()): Promise<LocalMediaResolution> {
  const key = requestKey(request), cached = aliases.get(key);
  if (cached && (cached.pending || now - cached.at < MEDIA_RESOLVE_CACHE_MS)) return cached.pending ? cached.promise! : cached.entry?.renewal ?? cached.entry?.pending ?? (cached.entry?.result ? Promise.resolve(cached.entry.result) : cached.promise!);
  if (cached) detach(cached);
  const alias: Alias = { key, at: now, promise: Promise.resolve(unavailable("unanswered")), pending: true };
  aliases.set(key, alias);
  alias.promise = run(request, api, !!cached, alias).finally(() => { alias.pending = false; if (alias.entry) alias.promise = undefined; maintain(alias); evict(); });
  return alias.promise;
}
export interface ImageRecoveryOwner { kind: "image"; spent: boolean; terminal: boolean; joined: Map<number, Promise<LocalMediaResolution>> }
export const imageRecoveryOwner = (): ImageRecoveryOwner => ({ kind: "image", spent: false, terminal: false, joined: new Map() });
export type MediaRecoveryOwner = ImageRecoveryOwner | { kind: "player" };
export function refreshLocalMedia(request: LocalMediaRequest, failedGeneration: number, _cause: string, owner: MediaRecoveryOwner, api: MediaApi): Promise<LocalMediaResolution> {
  if (owner.kind === "image") {
    if (owner.terminal) return Promise.resolve({ state: "exhausted" });
    const joined = owner.joined.get(failedGeneration); if (joined) return joined;
    if (owner.spent) return Promise.resolve({ state: "exhausted" });
    owner.spent = true;
  }
  const alias = aliases.get(requestKey(request)), entry = alias?.entry;
  let replacement = entry?.replacements.get(failedGeneration);
  // A delayed event without a pinned record joins the current answer, never
  // initiates another renewal of bytes it no longer owns.
  if (!replacement && entry && failedGeneration < entry.generation && entry.result) replacement = entry.renewal ?? entry.pending ?? Promise.resolve(entry.result);
  if (!replacement) {
    replacement = entry?.renewal ?? entry?.pending ?? run(request, api, true, alias);
    entry?.replacements.set(failedGeneration, replacement); entry?.pendingReplacements.add(failedGeneration);
    if (entry) void replacement.finally(() => {
      entry.pendingReplacements.delete(failedGeneration);
      if (!entry.generationRefs.has(failedGeneration)) entry.replacements.delete(failedGeneration);
    });
  }
  if (entry && !entry.renewal) {
    entry.renewal = replacement; maintain(undefined, entry);
    void replacement.finally(() => {
      if (entry.renewal === replacement) entry.renewal = undefined;
      maintain(undefined, entry); evict();
    });
  }
  if (owner.kind === "image") owner.joined.set(failedGeneration, replacement);
  if (alias) { alias.promise = replacement; alias.pending = true; void replacement.finally(() => { alias.pending = false; if (alias.entry) alias.promise = undefined; maintain(alias); evict(); }); }
  return replacement;
}
export function forgetLocalMedia(request?: LocalMediaRequest): void {
  if (!request) { aliases.clear(); entries.clear(); eligible.clear(); negatives.clear(); discoveries.clear(); rootCache.clear(); }
  else { const key = requestKey(request), entry = aliases.get(key)?.entry; const alias = aliases.get(key); if (alias) detach(alias); aliases.delete(key); if (entry && !entry.pending && !referenced(entry)) { entries.delete(entry.key); eligible.delete(entry.key); } }
}
export function playableHint(path: string): MediaHint | null { return mediaHintForPath(path); }
const rootCache = new Map<string, { at: number; promise: Promise<string | null> }>();
export function conversationWorkspaceRoot(scope: WorkspaceScopeRef, api: MediaApi, now = Date.now()): Promise<string | null> {
  const key = scopeKey(scope), previous = rootCache.get(key); if (previous && now - previous.at < MEDIA_RESOLVE_CACHE_MS) return previous.promise;
  const promise = workspaceRoot(api, scope).then(root => root.state === "ready" ? root.displayPath : null);
  rootCache.set(key, { at: now, promise }); if (rootCache.size > 64) rootCache.delete(rootCache.keys().next().value!); return promise;
}
export async function conversationLinkPath(scope: WorkspaceScopeRef, path: string, api: MediaApi): Promise<string | null> {
  const root = await conversationWorkspaceRoot(scope, api); if (!root) return null;
  if (!isOutputNamespacePath(path) && (await fileRevision(api, scope, `${OUTPUT_NAMESPACE}/${path}`, false)).state === "found") return workspaceFilePath(root, `${OUTPUT_NAMESPACE}/${path}`);
  return workspaceFilePath(root, path);
}
export function localMediaCounts(request?: LocalMediaRequest) { return { replacements: request ? aliases.get(requestKey(request))?.entry?.replacements.size ?? 0 : 0, active, queued: queue.length, entries: entries.size, eligible: eligible.size }; }
/** Deliberate new subscriber epoch; old recovery mappings remain valid for other consumers. */
export function retryLocalMedia(request: LocalMediaRequest, api: MediaApi): Promise<LocalMediaResolution> {
  const alias = aliases.get(requestKey(request));
  if (alias?.pending) return alias.promise!;
  if (!alias) return localMedia(request, api);
  alias.pending = true;
  alias.promise = run(request, api, true, alias).finally(() => { alias.pending = false; if (alias.entry) alias.promise = undefined; maintain(alias); evict(); });
  return alias.promise;
}

/** A mounted consumer pins only the generation it can still act on. */
export function retainLocalMediaGeneration(ready: Extract<LocalMediaResolution, { state: "ready" }>): () => void {
  const entry = entries.get(ready.canonicalKey), generation = ready.generation;
  if (!entry) return () => {};
  entry.generationRefs.set(generation, (entry.generationRefs.get(generation) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    const count = (entry.generationRefs.get(generation) ?? 1) - 1;
    if (count) entry.generationRefs.set(generation, count);
    else { entry.generationRefs.delete(generation); if (!entry.pendingReplacements.has(generation)) entry.replacements.delete(generation); }
  };
}
