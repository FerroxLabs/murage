// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class Murage chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { CACHE_MAX_AGE_MS, cacheEnvFromProcess, clearMountIncomplete, CONNECTOR_LIST_DEADLINE_MS, markMountIncomplete, markMountReady, type MountRef, INITIAL_TOOLS_ASK_HARNESS, INITIAL_TOOLS_IN_FILE, initialToolsFileName, privateCacheDir as privateDirOf, pruneCacheDir, generationLabel, readCacheEntry, readGeneration, removeCacheEntry, writeCacheEntry } from "./connector-cache.ts";
import { STANDARD_SESSION_TOOLS } from "./composio-standard-tools.ts";
import { CRED_FILE_ENV, turnSecret } from "./turn-credential.ts";
import { markMcpListedAfterFlush } from "./mcp-listed.ts";
import {
  CONNECTED_APP_RELAY_GRACE_MS,
  CONNECTED_APP_STATUS_TOOL,
  CONNECTED_APP_STATUS_TOOL_DEFINITION,
  CONNECTED_APP_WAIT_HEADER,
  connectedAppActionCall,
  connectedAppCallTimeoutMs,
  connectedAppTimeoutText,
} from "../shared/connected-app-calls.ts";

type Json = Record<string, unknown>;

const UPSTREAM = process.env.MURAGE_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.MURAGE_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.MURAGE_BOT_ID ?? "";
const THREAD_ID = process.env.MURAGE_THREAD_ID ?? "";
const token = () => turnSecret("MURAGE_CONNECTORS_TOKEN");
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
/** The upstream session is opened behind the local initialize answer; a call
 * that needs it waits this long at most, then goes without it. */
const INITIALIZE_RELAY_TIMEOUT_MS = 10_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;
// Per-call bounds (shared/connected-app-calls.ts). The env overrides exist for
// tests and the perf rig only; the bridge is the one place every engine's
// connected-app call passes, so the bound holds for Grok, Claude, Codex and
// Fuigo alike, however long the engine itself would wait.
const positive = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const CALL_LIMITS = {
  lookupMs: positive(process.env.MURAGE_CONNECTOR_LOOKUP_TIMEOUT_MS),
  actionMs: positive(process.env.MURAGE_CONNECTOR_ACTION_TIMEOUT_MS),
};
// An action's wait is the server's: it answers "still running" with a handle
// at the bound this bridge sends it. The bridge waits a grace longer, so the
// server's answer is the one the bot gets.
const ACTION_GRACE_MS = positive(process.env.MURAGE_CONNECTOR_GRACE_MS) ?? CONNECTED_APP_RELAY_GRACE_MS;
const timedOut = (error: unknown): boolean =>
  error instanceof DeadlineError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
const REOPEN_TIMEOUT_MS = 15_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(turnSecret("MURAGE_CONNECTOR_UPSTREAM_HEADERS") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** How long a first tools/list (nothing remembered for this account) is HELD
 * for the real list. Codex and Grok do not list again after a
 * `list_changed`, so whatever the first answer holds is what the engine has for
 * the whole session: the real list is worth waiting for, within what every
 * engine allows a server to initialize: the limits Murage configures for
 * Pi, Codex and Claude are at least twice this (ENGINE_MCP_LIST_LIMIT_MS) and
 * Grok's is 70 s. Only when this runs out are the bundled tools served, with a notice
 * (see DEGRADED_NOTICE). It is an ABSOLUTE bound on the whole list operation,
 * session recovery and the harness's own provisional answers included. */
const TOOLS_LIST_LIVE_MS = Number(process.env.MURAGE_CONNECTOR_TOOLS_LIST_MS) > 0 ? Math.min(Number(process.env.MURAGE_CONNECTOR_TOOLS_LIST_MS), CONNECTOR_LIST_DEADLINE_MS) : CONNECTOR_LIST_DEADLINE_MS;
/** While held, a provisional answer from the harness (it answers its own 4 s cold wait with the bundled tools) is asked again this often. */
const HELD_RETRY_MS = 750;
/** Said to the model, once, when only the bundled tools could be offered. No service name. */
const DEGRADED_NOTICE = "Some connected-app tools are still loading and are checked again next turn.";
/** The background fetch that refreshes the remembered list. */
const TOOLS_LIST_BACKGROUND_MS = 60_000;
/** A call made while only the stand-in list was served waits this long for the real one. */
const STILL_LOADING_WAIT_MS = 8_000;
const STILL_LOADING_TEXT = "Connected apps are still loading. Try again in a moment.";

// ── Absolute deadlines ───────────────────────────────────────────────
// Every upstream operation carries ONE absolute deadline (epoch ms). Whatever
// the operation does on the way (open a session, send the initialized notice,
// retry after a 404) spends from that one budget; nothing starts a fresh
// relative timer. `relay(message, deadlineAt)` is the contract.
class DeadlineError extends Error {
  constructor() { super("connector service did not answer in time"); }
}
const deadlineIn = (ms: number): number => Date.now() + ms;
const timeLeft = (deadlineAt: number): number => deadlineAt - Date.now();
/** Resolves with the promise's value, or `expired` once the deadline passes (the promise is left to settle on its own). */
function raceDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T | typeof expired> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<typeof expired>((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, timeLeft(deadlineAt))); }),
  ]).finally(() => clearTimeout(timer));
}
const expired = Symbol("deadline");

// ── What the engine is shown: the one place a list is decorated ───────
/** EVERY tools/list answer this bridge sends (remembered, live, the stand-in
 * served first, and the one that follows a provisional list) is passed through
 * here, and nothing else changes a list's tools. Add list-wide additions (for
 * example a connected-app check action) here, once. */
function decorateToolsList(tools: unknown[], degraded = false): unknown[] {
  // The bridge's own outcome-check tool is on every list, including the stand-in and remembered ones; added once.
  const listed = tools.some((tool) => (tool as { name?: unknown } | null)?.name === CONNECTED_APP_STATUS_TOOL);
  if (!listed) tools = [...tools, CONNECTED_APP_STATUS_TOOL_DEFINITION];
  if (!degraded) return tools;
  // Only the bundled stand-in was offered: say so where the model reads (once, on the first tool).
  let marked = false;
  return tools.map((tool) => {
    if (marked || !tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const description = (tool as Json).description;
    marked = true;
    return { ...(tool as Json), description: typeof description === "string" && description ? `${DEGRADED_NOTICE} ${description}` : DEGRADED_NOTICE };
  });
}
const listToolsOf = (result: Json | undefined): unknown[] => (Array.isArray(result?.tools) ? (result!.tools as unknown[]) : []);
function toolsReply(id: unknown, result: Json, meta?: Json, degraded = false): Json {
  const { _meta: upstreamMeta, ...rest } = result;
  const merged = { ...((upstreamMeta as Json | undefined) ?? {}), ...(meta ?? {}) };
  return { jsonrpc: "2.0", id, result: { ...rest, tools: decorateToolsList(listToolsOf(result), degraded), ...(Object.keys(merged).length ? { _meta: merged } : {}) } };
}
/** The initial list: what the harness supplied for this bot's access (for a
 * restricted bot, only its approved accounts), else the bundled standard tools.
 * A long list arrives through a private file (the sentinel), never cut down:
 * the file is named by identity and revision, so a list for another access
 * revision is never read. NULL when the supplied list cannot be had (the file
 * is gone, unreadable or for another revision, or the harness could not hand
 * it over): a bot with approved apps is never handed an empty list for that;
 * the caller asks the harness for the authoritative one instead. */
function initialTools(askedGeneration: string): unknown[] | null {
  const supplied = turnSecret("MURAGE_CONNECTOR_INITIAL_TOOLS");
  if (!supplied) return [...STANDARD_SESSION_TOOLS];
  // The handoff is bound to the connection generation it was built for (the
  // harness names it; else the one this list operation began under). After a
  // disconnect it is never reused: the caller fetches the authoritative list.
  if (!handoffIsCurrent(askedGeneration)) return null;
  if (supplied === INITIAL_TOOLS_ASK_HARNESS) return null;
  try {
    if (supplied === INITIAL_TOOLS_IN_FILE) {
      const scope = currentScope();
      const dir = scope ? privateDirOf(cacheEnvFromProcess(), false) : null;
      const entry = scope && dir ? readCacheEntry(dir, initialToolsFileName(scope)) : null;
      return entry && entry.revision === scope!.revision && Array.isArray(entry.tools) ? (entry.tools as unknown[]) : null;
    }
    const parsed: unknown = JSON.parse(supplied);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return null;
}
function handoffIsCurrent(askedGeneration: string): boolean {
  const now = currentGeneration();
  const built = turnSecret("MURAGE_CONNECTOR_INITIAL_GENERATION");
  // A handoff that names no generation is not usable; "" (none written yet) is the explicit initial value.
  return now === askedGeneration && built !== "" && built === generationLabel(now);
}
/** The bundled stand-in is what the engine would be left with (nothing supplied for a restricted bot). */
const offersBundledStandIn = (): boolean => !turnSecret("MURAGE_CONNECTOR_INITIAL_TOOLS");

// ── The remembered list ─────────────────────────────────────────────
// Filed under an identity the HARNESS supplies (stable account + bot, one
// digest) and checked against an access revision it also supplies (the bot's
// grants and switches). The rotating turn token plays no part. Both ride in
// the per-turn credential file, so a warm process sees the current ones; an
// empty pair (between turns, or an old launcher) means nothing is remembered.
interface ListScope { identity: string; revision: string }
const IDENTITY_SHAPE = /^[a-f0-9]{16,64}$/;
function currentScope(): ListScope | null {
  const identity = turnSecret("MURAGE_CONNECTOR_IDENTITY");
  const revision = turnSecret("MURAGE_CONNECTOR_REVISION");
  return IDENTITY_SHAPE.test(identity) && revision && revision.length <= 128 ? { identity, revision } : null;
}
const scopeKey = (scope: ListScope | null): string => (scope ? `${scope.identity}|${scope.revision}` : "");
let memoryList: { scope: ListScope; generation: string; tools: unknown[]; at: number } | null = null;

/** The connection generation the harness announces BEFORE it purges (a
 * disconnect or sign-out). Read at the start of every list operation and
 * checked again before anything is stored or shown: a reply that began under
 * an older generation never recreates what the purge removed. "" without a folder. */
function currentGeneration(): string {
  const dir = privateDirOf(cacheEnvFromProcess(), false);
  return dir ? readGeneration(dir) : "";
}
function readDiskList(scope: ListScope, generation: string): unknown[] | null {
  const dir = privateDirOf(cacheEnvFromProcess(), false);
  if (!dir) return null;
  const parsed = readCacheEntry(dir, `${scope.identity}.json`);
  if (!parsed || parsed.revision !== scope.revision || (typeof parsed.generation === "string" ? parsed.generation : "") !== generation) return null;
  return Array.isArray(parsed.tools) && parsed.tools.length ? (parsed.tools as unknown[]) : null;
}
function writeDiskList(scope: ListScope, generation: string, tools: unknown[]): void {
  const dir = privateDirOf(cacheEnvFromProcess(), true);
  if (!dir) return;
  const name = `${scope.identity}.json`;
  writeCacheEntry(dir, name, JSON.stringify({ revision: scope.revision, generation, tools }));
  // A purge that began while this was being written would otherwise leave it behind.
  if (readGeneration(dir) !== generation) removeCacheEntry(dir, name);
}
/** Expired entries go even when nothing is written: once at start and hourly. */
function startCachePruning(): void {
  const sweep = () => { const dir = privateDirOf(cacheEnvFromProcess(), false); if (dir) pruneCacheDir(dir, Date.now(), true); };
  sweep();
  setInterval(sweep, 3600_000).unref();
}
function rememberedFor(scope: ListScope | null, generation: string): unknown[] | null {
  if (!scope) return null;
  if (memoryList && scopeKey(memoryList.scope) === scopeKey(scope) && memoryList.generation === generation && Date.now() - memoryList.at <= CACHE_MAX_AGE_MS) return memoryList.tools;
  memoryList = null; // another account, bot, access revision or connection generation: never served
  const disk = readDiskList(scope, generation);
  if (disk) memoryList = { scope, generation, tools: disk, at: Date.now() };
  return disk;
}
/** Publish a real list under the scope and generation it was ASKED under, and
 * only while both are still current. Returns whether they were. */
function stillCurrent(askedUnder: ListScope | null, askedGeneration: string): boolean {
  return scopeKey(askedUnder) === scopeKey(currentScope()) && askedGeneration === currentGeneration();
}
function publishList(askedUnder: ListScope | null, askedGeneration: string, result: Json): boolean {
  if (!stillCurrent(askedUnder, askedGeneration)) return false;
  const tools = listToolsOf(result);
  if (askedUnder && tools.length) {
    memoryList = { scope: askedUnder, generation: askedGeneration, tools, at: Date.now() };
    writeDiskList(askedUnder, askedGeneration, tools);
    if (askedGeneration !== currentGeneration()) { memoryList = null; return false; }
  }
  return true;
}

/** True once a real (not stand-in, not provisional) list has been seen this session. */
let realListSeen = false;
/** The engine was given only the stand-in list (nothing real yet). */
let servedBundledOnly = false;
let refreshingList: { key: string; promise: Promise<void> } | null = null;
/** Ask the upstream for the real list in the background; remember it, and tell
 * the engine to list again when it differs from what was served. */
function refreshToolsList(): Promise<void> {
  const asked = currentScope();
  const askedGeneration = currentGeneration();
  const key = `${scopeKey(asked)}|${askedGeneration}`;
  if (refreshingList && refreshingList.key === key) return refreshingList.promise;
  const promise = (async () => {
    try {
      const response = await relay({ jsonrpc: "2.0", id: `murage-tools-bg-${randomUUID()}`, method: "tools/list" }, deadlineIn(TOOLS_LIST_BACKGROUND_MS));
      if (!response || response.error !== undefined || isProvisional(response)) { void followProvisionalList(); return; }
      if (!publishList(asked, askedGeneration, response.result as Json)) return; // the access or connections changed under it: discard
      realListSeen = true;
      noteAuthoritativeAvailable(askedGeneration);
      announceIfChanged(response);
    } catch { void followProvisionalList(); /* probes again with backoff while the engine holds the stand-in */ } finally {
      if (refreshingList?.key === key) refreshingList = null;
    }
  })();
  refreshingList = { key, promise };
  return promise;
}
/** The list the engine holds differs from this real one: tell it to list again. */
function announceIfChanged(response: Json): void {
  const json = toolsJsonOf(response);
  if (json === servedToolsJson) return;
  servedToolsJson = json;
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}
const mountRef = (): MountRef | null => {
  const scope = currentScope();
  return scope ? { cache: cacheEnvFromProcess(), identity: scope.identity, revision: scope.revision, thread: THREAD_ID } : null;
};
/** The engine was handed a provisional list: the driver starts a fresh mount at the next turn. */
function noteProvisionalServed(): void { provisionalOutstanding = true; watchCredentialsForTurnStart(); const ref = mountRef(); if (ref) markMountIncomplete(ref); }
/** The engine holds a real list: nothing to recover. */
function noteRealServed(): void { provisionalOutstanding = false; const ref = mountRef(); if (ref) clearMountIncomplete(ref); }
/** The engine holds a stand-in (or a provisional list) and no real list has reached it. */
let provisionalOutstanding = false;
/** The real list was just cached under `generation` while the engine still holds the
 * stand-in: ONLY now may the driver replace the engine (one recycle, onto a list that
 * is there). A discovery that keeps failing never gets here, so it never recycles. */
function noteAuthoritativeAvailable(generation: string): void {
  if (!provisionalOutstanding) return;
  const ref = mountRef();
  if (ref) markMountReady(ref, generation);
}

/** What one discovery ended with. */
type Discovery =
  | { kind: "real" | "provisional" | "error"; response: Json }
  | { kind: "unreadable" | "expired" }
  | { kind: "threw"; error: unknown };
/** The discovery running for a scope and connection generation. Concurrent and
 * retried list requests for the same ones await THIS one (single flight), so a
 * retry gets the first request's answer instead of starting a new wait. */
let pendingDiscovery: { key: string; deadlineAt: number; promise: Promise<Discovery> } | null = null;
function discover(asked: ListScope | null, askedGeneration: string, deadlineAt: number, relayId: unknown): Promise<Discovery> {
  const key = `${scopeKey(asked)}|${askedGeneration}`;
  if (pendingDiscovery && pendingDiscovery.key === key && timeLeft(pendingDiscovery.deadlineAt) > 0) return pendingDiscovery.promise;
  const run = async (): Promise<Discovery> => {
    try {
      for (;;) {
        const raced = await raceDeadline(relay({ jsonrpc: "2.0", id: relayId, method: "tools/list" }, deadlineAt), deadlineAt);
        if (raced === expired) return { kind: "expired" };
        if (!raced) return { kind: "unreadable" };
        if (raced.error !== undefined) return { kind: "error", response: raced };
        if (!isProvisional(raced)) return { kind: "real", response: raced };
        // The harness answered before its own source did. A list it served from
        // an older revision is as good as it gets and is followed; the bundled
        // one is held against, until the deadline.
        if (!isBundledProvisional(raced)) return { kind: "provisional", response: raced };
        if (timeLeft(deadlineAt) <= HELD_RETRY_MS) return { kind: "expired" };
        await new Promise((resolve) => setTimeout(resolve, HELD_RETRY_MS));
      }
    } catch (error) {
      return { kind: "threw", error };
    }
  };
  const entry = { key, deadlineAt, promise: run().finally(() => { if (pendingDiscovery === entry) pendingDiscovery = null; }) };
  pendingDiscovery = entry;
  return entry.promise;
}

/** One line per tools/list this bridge answers: what the engine was given, how many tools, and the
 * upstream HTTP status when there was one. Never a token, a header or a tool argument. */
function logList(outcome: "real" | "remembered" | "provisional" | "standin" | "error", toolCount: number, http?: number): void {
  try { process.stderr.write(`[murage-connectors] tools/list outcome=${outcome} tools=${toolCount}${http ? ` http=${http}` : ""}\n`); } catch { /* logging never fails a list */ }
}
const httpStatusOf = (error: unknown): number | undefined => {
  const match = error instanceof Error ? /^connector service returned HTTP (\d{3})/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
};

/** tools/list. A remembered list answers at once and is refreshed behind. With
 * none, the first list is HELD (TOOLS_LIST_LIVE_MS, ONE absolute deadline: the
 * hold, session recovery, the harness's provisional bundled answers and any
 * authoritative fetch all spend from it) for the real one, because Codex and
 * Grok never list again. Only then the initial list answers, so the server
 * still mounts, and the turn is told some tools are still loading; the mount
 * is marked so the driver starts a fresh one at the next turn. The scope and
 * connection generation are captured before anything is fetched, and checked
 * again before anything is SENT. */
async function answerToolsList(id: unknown): Promise<void> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const deadlineAt = deadlineIn(TOOLS_LIST_LIVE_MS);
  const asked = currentScope();
  const askedGeneration = currentGeneration();
  const remembered = rememberedFor(asked, askedGeneration);
  // Revalidated against the generation as it is NOW, at the moment of sending.
  if (remembered && stillCurrent(asked, askedGeneration)) {
    const reply = toolsReply(id, { tools: remembered });
    servedToolsJson = toolsJsonOf({ result: { tools: remembered } });
    engineHoldsBundled = false;
    noteRealServed();
    logList("remembered", remembered.length);
    send(reply);
    void refreshToolsList();
    return;
  }
  if (remembered) { memoryList = null; sendInitialList(id, deadlineAt, askedGeneration); return; }
  let found: Discovery | typeof expired = expired;
  for (;;) {
    found = await raceDeadline(discover(asked, askedGeneration, deadlineAt, id), deadlineAt);
    // A discovery joined from an earlier request may have ended before this one's deadline: ask again.
    if (found !== expired && found.kind === "expired" && timeLeft(deadlineAt) > HELD_RETRY_MS) continue;
    break;
  }
  if (found === expired || found.kind === "expired") { sendInitialList(id, deadlineAt, askedGeneration); return; }
  if (found.kind === "threw") {
    const http = httpStatusOf(found.error);
    // The service refusing the list (a 4xx: sign-in, access, a request limit) is a decision, not an outage: answered as an error, but the
    // mount is marked incomplete so the next turn (and the readiness check) starts it again.
    if (http !== undefined && http >= 400 && http < 500 && http !== 404 && http !== 408 && http !== 425) {
      noteProvisionalServed();
      logList("error", 0, http);
      throw found.error;
    }
    // Any other upstream failure (an HTTP error, a slow or unreachable service) never mounts nothing:
    // the engine gets the initial list, the mount is marked incomplete and the real list follows.
    sendInitialList(id, deadlineAt, askedGeneration, http);
    return;
  }
  // An error reply or an unreadable one on the first list is never the engine's whole catalogue.
  if (found.kind === "unreadable" || found.kind === "error") { sendInitialList(id, deadlineAt, askedGeneration); return; }
  // The fence applies to what is SENT, not only to what is kept: a reply
  // fetched under a scope or connection generation that is no longer
  // current is discarded, and the engine is shown the current initial list.
  if (!stillCurrent(asked, askedGeneration)) { sendInitialList(id, deadlineAt, askedGeneration); return; }
  if (!("response" in found)) { sendInitialList(id, deadlineAt, askedGeneration); return; }
  const response = found.response;
  if (found.kind === "provisional") {
    servedToolsJson = toolsJsonOf(response);
    engineHoldsBundled = false;
    noteProvisionalServed();
    void followProvisionalList();
    logList("provisional", listToolsOf(response.result as Json).length);
    send(toolsReply(id, response.result as Json));
    return;
  }
  // A publication that lost the race with a disconnect (or an access change) is not shown either.
  if (!publishList(asked, askedGeneration, response.result as Json)) { sendInitialList(id, deadlineAt, askedGeneration); return; }
  realListSeen = true;
  servedToolsJson = toolsJsonOf(response);
  engineHoldsBundled = false;
  noteRealServed();
  logList("real", listToolsOf(response.result as Json).length);
  send(toolsReply(id, response.result as Json));
}
/** True once the engine was handed the bundled stand-in and has not been given a real list since. */
let engineHoldsBundled = false;
/** The notice goes on the first successful tool result of such a session, once. */
let degradedNoticeOwed = false;
/** The initial list for the CURRENT scope, marked provisional; the real one follows.
 * When the supplied approved list cannot be had, the harness is asked for the
 * authoritative one with what is left of the SAME deadline (it answers a
 * restricted bot's list from policy at once); if even that fails, the mount
 * fails recoverably: an error now, a fresh process (and so a fresh handover)
 * on the next turn. Never an empty list. */
function sendInitialList(id: unknown, deadlineAt: number, askedGeneration: string, http?: number): void {
  const initial = initialTools(askedGeneration);
  if (!initial) { void sendAuthoritativeList(id, deadlineAt); return; }
  servedBundledOnly = true;
  const degraded = offersBundledStandIn();
  if (degraded) { engineHoldsBundled = true; degradedNoticeOwed = true; }
  const reply = toolsReply(id, { tools: initial }, { [PROVISIONAL_TOOLS_META]: true }, degraded);
  // What the engine actually holds (notice included), so ANY real list differs from it and is announced.
  servedToolsJson = JSON.stringify(listToolsOf(reply.result as Json));
  noteProvisionalServed();
  logList("standin", initial.length, http);
  send(reply);
  void refreshToolsList();
}
/** sendAuthoritativeList is still fetching the answer to a tools/list. */
let authoritativeListPending = false;
async function sendAuthoritativeList(id: unknown, deadlineAt: number): Promise<void> {
  authoritativeListPending = true;
  try { await sendAuthoritativeListNow(id, deadlineAt); } finally { authoritativeListPending = false; }
}
async function sendAuthoritativeListNow(id: unknown, deadlineAt: number): Promise<void> {
  const asked = currentScope();
  const askedGeneration = currentGeneration();
  if (timeLeft(deadlineAt) > 0) {
    const found = await raceDeadline(discover(asked, askedGeneration, deadlineAt, id), deadlineAt);
    if (found !== expired && found.kind === "real" && stillCurrent(asked, askedGeneration)
      && publishList(asked, askedGeneration, found.response.result as Json)) {
      realListSeen = true;
      servedToolsJson = toolsJsonOf(found.response);
      engineHoldsBundled = false;
      noteRealServed();
      logList("real", listToolsOf(found.response.result as Json).length);
      send(toolsReply(id, found.response.result as Json));
      markMcpListedAfterFlush();
      return;
    }
  }
  logList("error", 0);
  const failure = jsonRpcError(id, RECOVERABLE_MOUNT_TEXT);
  process.stdout.write(`${JSON.stringify(failure)}\n`, () => process.exit(1));
}
const RECOVERABLE_MOUNT_TEXT = "Connected apps could not be loaded this turn. They will be ready next turn.";

let upstreamSessionId = "";
/** The background upstream initialize (and its initialized notice): settles
 * when the session is open or the attempt ended. Nothing the engine waits on
 * to mount the tools (initialize, tools/list) waits for it. */
let upstreamOpening: Promise<void> = Promise.resolve();
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** The harness marks a tools/list answer provisional (its `_meta`) when it is
 * the bundled standard list served before the connection service answered, or
 * a remembered list from before the user's connected apps changed. Either way
 * a refresh is already running there; this bridge asks again until a real
 * answer comes, and when its tools differ it tells the engine to list again
 * (`notifications/tools/list_changed`), so an already-mounted client is never
 * left with the provisional list. */
const PROVISIONAL_TOOLS_META = "murage/provisional"; // the same key as composio.ts
/** Set beside it when the answer is the bundled stand-in (not an older real list). Same key as composio.ts. */
const PROVISIONAL_BUNDLED_META = "murage/provisional-bundled";
const isBundledProvisional = (response: Json | null): boolean =>
  ((response?.result as Json | undefined)?._meta as Json | undefined)?.[PROVISIONAL_BUNDLED_META] === true;
/** Probe delays while the engine holds the stand-in: 2 s, doubling, never above 30 s. The probe
 * runs as long as the engine does and the stand-in is outstanding, so a discovery that keeps
 * failing is retried gently instead of ever replacing the warm engine. */
const FOLLOW_TOOLS_EVERY_MS = 2_000;
const FOLLOW_TOOLS_MAX_MS = 30_000;
let servedToolsJson = "";
let followingTools = false;
const isProvisional = (response: Json | null): boolean =>
  ((response?.result as Json | undefined)?._meta as Json | undefined)?.[PROVISIONAL_TOOLS_META] === true;
/** What the engine would be shown for this answer (decorated), as one comparable string. */
const toolsJsonOf = (response: Json | null): string => JSON.stringify(decorateToolsList(listToolsOf(response?.result as Json | undefined)));
/** How often a running probe checks that the turn and the connection it started under still stand. */
const PROBE_WATCH_MS = 500;
/** The probe may run only while a turn's credentials are present (they are emptied at every turn end,
 * disconnect and sign-out) and the connection generation is the one it started under. */
const probeWanted = (startedGeneration: string): boolean =>
  provisionalOutstanding && token() !== "" && currentGeneration() === startedGeneration;
async function followProvisionalList(): Promise<void> {
  if (followingTools) return;
  if (!provisionalOutstanding || token() === "") return; // idle: a new active turn restarts it (see resumeProbeForActiveTurn)
  followingTools = true;
  const startedGeneration = currentGeneration();
  const stop = new AbortController();
  // One watcher covers both the wait and the in-flight request: it ends them the moment the turn ends
  // (credentials cleared) or the connection generation changes. It makes no network request itself.
  const watcher = setInterval(() => { if (!probeWanted(startedGeneration)) stop.abort(); }, PROBE_WATCH_MS);
  watcher.unref();
  try {
    for (let attempt = 0; probeWanted(startedGeneration); attempt++) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(FOLLOW_TOOLS_EVERY_MS * 2 ** Math.min(attempt, 8), FOLLOW_TOOLS_MAX_MS));
        function done(): void { clearTimeout(timer); stop.signal.removeEventListener("abort", done); resolve(); }
        stop.signal.addEventListener("abort", done, { once: true });
      });
      if (stop.signal.aborted || !probeWanted(startedGeneration)) return;
      const asked = currentScope();
      const askedGeneration = currentGeneration();
      let response: Json | null = null;
      try {
        response = await relay({ jsonrpc: "2.0", id: `murage-tools-refresh-${attempt}`, method: "tools/list" }, deadlineIn(INITIALIZE_RELAY_TIMEOUT_MS), false, stop.signal);
      } catch {
        continue;
      }
      if (stop.signal.aborted) return;
      if (!response || response.error !== undefined || isProvisional(response)) continue;
      if (!publishList(asked, askedGeneration, response.result as Json)) continue; // the access or connections changed under it
      realListSeen = true;
      noteAuthoritativeAvailable(askedGeneration);
      announceIfChanged(response);
      return;
    }
  } finally {
    clearInterval(watcher);
    stop.abort(); // nothing of this probe outlives it
    followingTools = false;
  }
}
/** A new active turn reached the bridge with the stand-in still held: bounded recovery starts again. */
function resumeProbeForActiveTurn(): void {
  if (provisionalOutstanding && !followingTools && token() !== "") void followProvisionalList();
}
/** A warm engine need not send any MCP request at the next turn's start, so the bridge also
 * learns of the new turn from the harness itself: the driver rewrites the credential file at
 * every turn start. An operating-system change event on the file's private folder (no timer,
 * nothing read until the harness writes) restarts bounded recovery. Armed only while the
 * stand-in is outstanding; it closes itself once a real list has reached the engine. */
let credentialWatch: FSWatcher | null = null;
/** Fallback when the operating system will not give us a watcher (limits, unsupported filesystem) or
 * the watcher dies: a bounded stat poll of the credential file, run only while the stand-in is held. */
const CRED_POLL_MS = 2_000;
let credentialPoll: ReturnType<typeof setInterval> | null = null;
let credentialPollLogged = false;
const credentialStamp = (file: string): string => {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
};
function pollCredentialsForTurnStart(file: string, why: string): void {
  if (credentialPoll || !provisionalOutstanding) return;
  if (!credentialPollLogged) { credentialPollLogged = true; process.stderr.write(`[murage-connectors] credential watcher unavailable (${why}); polling every ${CRED_POLL_MS / 1000}s while tools are being recovered\n`); }
  let last = credentialStamp(file);
  const stopPoll = (): void => { if (credentialPoll) clearInterval(credentialPoll); credentialPoll = null; };
  credentialPoll = setInterval(() => {
    if (!provisionalOutstanding) { stopPoll(); return; } // a real list reached the engine
    const now = credentialStamp(file);
    if (now !== last) { last = now; resumeProbeForActiveTurn(); }
  }, CRED_POLL_MS);
  credentialPoll.unref(); // never keeps the bridge alive: it ends with the process
}
function watchCredentialsForTurnStart(): void {
  const file = process.env[CRED_FILE_ENV];
  if (!file || credentialWatch) return;
  try {
    const watch = fsWatch(dirname(file), { persistent: false }, () => {
      if (!provisionalOutstanding) { watch.close(); if (credentialWatch === watch) credentialWatch = null; return; }
      resumeProbeForActiveTurn();
    });
    watch.on("error", () => {
      watch.close();
      if (credentialWatch === watch) credentialWatch = null;
      pollCredentialsForTurnStart(file, "watcher error");
    });
    credentialWatch = watch;
  } catch {
    pollCredentialsForTurnStart(file, "watcher could not be created");
  }
}

function textResult(id: unknown, text: string, isError = false): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } };
}

function jsonRpcError(id: unknown, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function initializeResult(id: unknown, protocolVersion: unknown): Json {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: typeof protocolVersion === "string" && protocolVersion ? protocolVersion : "2024-11-05",
      // listChanged: a provisional list (see followProvisionalList) is replaced
      // by the real one when it arrives, and the engine is told to list again.
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "murage-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id: unknown): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  // Only the frame that answers THIS request.
  //
  // The `?? frames.at(-1)` fallback forwarded a stranger: an SSE frame
  // carrying a different jsonrpc id was handed back as though it were the
  // answer, so the client never resolved the id it actually asked about and
  // waited forever. A mismatched id is a failure, and it has to be reported
  // as one rather than papered over with whatever arrived last.
  return frames.findLast((frame) => frame.id === id) ?? null;
}

/** The upstream forgot our session (a network drop, a restart there): open a
 * new one. Best effort; the retry that follows reports any failure. It spends
 * from the caller's absolute deadline (never beyond REOPEN_TIMEOUT_MS from
 * now), so recovery cannot stretch the operation that needed it. */
async function reopenUpstreamSession(deadlineAt: number, cancel?: AbortSignal): Promise<void> {
  upstreamSessionId = "";
  const reopenBy = Math.min(deadlineAt, deadlineIn(REOPEN_TIMEOUT_MS));
  try {
    await relay({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-connectors", version: "1" } },
    }, reopenBy, true, cancel);
    if (upstreamSessionId && !cancel?.aborted) await relay({ jsonrpc: "2.0", method: "notifications/initialized" }, reopenBy, true, cancel);
  } catch {
    // the retry will say what is wrong
  }
}

/** One upstream round trip that ends, session recovery included, by `deadlineAt`
 * (absolute, epoch ms). A relative timeout is never taken. */
async function relay(message: Json, deadlineAt: number = deadlineIn(RELAY_TIMEOUT_MS), retried = false, cancel?: AbortSignal): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  if (timeLeft(deadlineAt) <= 0) throw new DeadlineError();
  const sentSession = upstreamSessionId;
  const remaining = timeLeft(deadlineAt);
  const action = connectedAppActionCall(message) !== null;
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...parsedHeaders(),
      ...(upstreamSessionId ? { "mcp-session-id": upstreamSessionId } : {}),
      // How long the server may hold the bot before answering "still running".
      ...(action ? { [CONNECTED_APP_WAIT_HEADER]: String(Math.max(0, remaining - ACTION_GRACE_MS)) } : {}),
    },
    body: JSON.stringify(message),
    signal: cancel ? AbortSignal.any([AbortSignal.timeout(remaining), cancel]) : AbortSignal.timeout(remaining),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (response.status === 404 && sentSession && !retried && message.method !== "initialize") {
    // The session id we kept is dead. Forget it, open a new session, and try
    // this request once more; never twice, so a broken upstream cannot loop.
    await response.body?.cancel().catch(() => {});
    await reopenUpstreamSession(deadlineAt, cancel);
    return relay(message, deadlineAt, true, cancel);
  }
  if (!response.ok) {
    // The body, not just the number.
    //
    // Every distinct upstream failure used to collapse to a bare status: an
    // expired key, a billing hold, a disabled account and the broker's daily
    // ceiling were all "connector service returned HTTP 4xx". The broker
    // writes a real sentence — "This install has hit today's connected-app
    // request limit. It resets at 00:00 UTC." with a `code` and a
    // `retry-after` — and all of it was discarded before anyone could read
    // it. That is why a dead connector could never be diagnosed from inside
    // the app, and why a whole afternoon went into guessing which hop was
    // broken.
    //
    // Bounded and best-effort: a body that will not read must not turn a
    // useful status into an exception of its own.
    let detail = "";
    try {
      detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
    } catch {
      detail = "";
    }
    throw new Error(
      `connector service returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = parseUpstream(await readBounded(response), message.id);
  // The bridge's own status tool sits beside the service's tools, whichever path asked for the list.
  if (message.method === "tools/list" && parsed) withStatusTool(parsed);
  return parsed;
}

function withStatusTool(response: Json): void {
  const result = response.result as { tools?: unknown } | undefined;
  if (!result || !Array.isArray(result.tools)) return;
  if (result.tools.some((tool) => (tool as { name?: unknown } | null)?.name === CONNECTED_APP_STATUS_TOOL)) return;
  result.tools.push(CONNECTED_APP_STATUS_TOOL_DEFINITION);
}

interface ConnectorRequest { slug: string; alias?: string }

function connectorAdds(args: unknown): ConnectorRequest[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  const seen = new Set<string>();
  return toolkits.flatMap((item): ConnectorRequest[] => {
    if (typeof item === "string") item = { toolkit: item };
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown; alias?: unknown; account?: unknown };
    const slug = typeof row.toolkit === "string" ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    if (typeof slug !== "string" || !["add", "connect", "initiate"].includes(action)) return [];
    const requestedAlias = row.alias ?? row.account;
    if (requestedAlias !== undefined && typeof requestedAlias !== "string") throw new Error("Account alias must be text");
    const alias = requestedAlias?.trim() || requestedAlias;
    const normalizedSlug = slug.trim().toLowerCase();
    const key = JSON.stringify([normalizedSlug, alias?.toLowerCase() ?? ""]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ slug: normalizedSlug, ...(alias ? { alias } : {}) }];
  });
}

async function showConnectorCards(items: ConnectorRequest[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, items, slugs: [...new Set(items.map((item) => item.slug))], resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  resumeProbeForActiveTurn(); // a request in an active turn with the stand-in still held restarts bounded recovery
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    // After the session the background initialize opened, so it carries its id.
    if (UPSTREAM) {
      // The deadline starts when the notice is queued, so waiting behind the
      // session-opening request counts against it.
      const by = deadlineIn(INITIALIZE_RELAY_TIMEOUT_MS);
      upstreamOpening = upstreamOpening.then(() => relay(message, by)).then(() => {}, () => {});
    }
    return;
  }
  if (method === "initialize") {
    // Answered at once, from local data: the engine marks these tools ready
    // only after initialize and tools/list, and a broker round trip here held
    // every turn's connected apps behind the network (and, on a busy machine,
    // past the engine's own connect timeout). The upstream session opens in
    // the background; a tool call waits for it, bounded.
    if (UPSTREAM) upstreamOpening = relay(message, deadlineIn(INITIALIZE_RELAY_TIMEOUT_MS)).then(() => {}, () => {});
    if (id !== undefined) {
      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const requests = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (requests.length) {
      await showConnectorCards(requests);
      const labels = requests.map((item) => item.alias ? `${item.slug} (${item.alias})` : item.slug).join(", ");
      send(textResult(
        id,
        `Murage showed the user a secure connection card for ${labels}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "Murage is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  // One absolute deadline for this operation: the waits below (the stand-in
  // list's refresh, the session opening) are spent from it, not added to it.
  // A connected-app call is bounded by its own per-call limit (an action by
  // that limit plus the grace that lets the server's "still running" win).
  const callTimeoutMs = connectedAppCallTimeoutMs(message, CALL_LIMITS);
  const operationDeadline = deadlineIn(method === "tools/call" ? callTimeoutMs + (connectedAppActionCall(message) ? ACTION_GRACE_MS : 0) : RELAY_TIMEOUT_MS);
  try {
    // tools/list is answered by the harness from what it remembers and needs
    // no session; a call goes on the session the background initialize opened.
    // Once the engine has the list (real, remembered or the initial one), the
    // driver's MCP wait may end (mcp-listed.ts); an answer still being fetched
    // by sendAuthoritativeList marks it there. An upstream failure on the first list is answered with the
    // initial list (marked incomplete), never an error or an empty list; only an access refusal is an error.
    if (method === "tools/list" && id !== undefined) { await answerToolsList(id); if (!authoritativeListPending) markMcpListedAfterFlush(); return; }
    // Only the bundled list was served and the real one has not come: wait a
    // little for it, then say plainly that connected apps are still loading.
    if (method === "tools/call" && servedBundledOnly && !realListSeen) {
      await Promise.race([refreshToolsList(), new Promise((resolve) => setTimeout(resolve, STILL_LOADING_WAIT_MS))]);
      if (!realListSeen) {
        if (id !== undefined) send(textResult(id, STILL_LOADING_TEXT, true));
        return;
      }
    }
    if (method !== "tools/list") await upstreamOpening;
    const response = await relay(message, operationDeadline);
    // A request is never dropped on the floor.
    //
    // `relay()` returns null when the upstream answered with something this
    // bridge could not parse — an empty 200, or frames that never carried
    // this id. The old code simply wrote nothing to stdout, and an MCP client
    // waits on an unanswered id indefinitely. Inside an agent turn a hung
    // tool call is indistinguishable from the model thinking, so the failure
    // was invisible in the one place it mattered most.
    if (id === undefined) return;
    if (response && method === "tools/list" && response.error === undefined) {
      servedToolsJson = toolsJsonOf(response);
      if (isProvisional(response)) void followProvisionalList();
    }
    if (response && method === "tools/call" && degradedNoticeOwed && engineHoldsBundled && response.error === undefined) {
      // Said once, in the turn's own result: the bundled tools were all that could be offered.
      degradedNoticeOwed = false;
      const result = (response.result ?? {}) as Json;
      const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
      send({ ...response, result: { ...result, content: [...content, { type: "text", text: DEGRADED_NOTICE }] } });
      return;
    }
    if (response) send(response);
    else send(textResult(id, "connector service returned an unreadable response", true));
  } catch (error) {
    if (id === undefined) return;
    if (method === "tools/call" && timedOut(error)) {
      // A clear, bounded answer the bot can act on. A lookup stopped and may
      // be tried again. An action is still running on the server, which never
      // sends the same action twice, so the bot is told so, not given an error.
      const params = (message.params ?? {}) as Json;
      const action = connectedAppActionCall(message) !== null;
      send(textResult(id, connectedAppTimeoutText(String(params.name ?? ""), params.arguments, callTimeoutMs), !action));
      return;
    }
    const messageText = timedOut(error)
      ? `connected apps did not answer within ${Math.round(callTimeoutMs / 1000)} seconds`
      : error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else send(jsonRpcError(id, messageText));
  }
}

startCachePruning();
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
