// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How long one connected-app call may run, and how it is named while it does.
//
// Engines give MCP calls their own deadlines (Grok 6000 s, Codex a week,
// Claude its own), so a call the broker stopped answering held a turn for as
// long as the engine was willing to wait, with "working in your connected
// apps" as the only sign of life. The stdio bridge every engine mounts
// (server/connector-proxy.ts) bounds each call by what it does instead: a
// lookup (search, schemas, connection status, the tool list) answers in
// seconds; an action runs an app's own API and may take longer. Flux allows
// 285 s per broker request (FLUX_CAP_COMPOSIO_MCP_TIMEOUT_SECONDS), so both
// bounds sit well inside it. For a lookup the bound is the whole call. For an
// action it is only the bot's wait: the action keeps running on the server,
// which never sends the same action twice and keeps its result for the bot to
// collect (server/connected-app-operations.ts).
//
// Product copy never names the connection service.

export const CONNECTED_APP_LOOKUP_TIMEOUT_MS = 30_000;
export const CONNECTED_APP_ACTION_TIMEOUT_MS = 120_000;
/** How much longer the server's relay waits than the bridge, so the bridge's
 * clear answer is the one the bot gets. */
export const CONNECTED_APP_RELAY_GRACE_MS = 15_000;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/** The bare service tool id ("COMPOSIO_MULTI_EXECUTE_TOOL"), from either an
 * MCP name or an engine's namespaced one ("composio__COMPOSIO_SEARCH_TOOLS"). */
function serviceTool(name: string): string {
  return name.replace(/^mcp__/, "").replace(/^[a-z0-9_-]*?__/i, "").toUpperCase();
}

/** Whether a call only looks something up (no app action runs). */
export function isConnectedAppLookup(name: string): boolean {
  const tool = serviceTool(name);
  return /^COMPOSIO_/.test(tool) && /SEARCH|SCHEMA|LIST|CONNECTION|WAIT_FOR/.test(tool.slice("COMPOSIO_".length));
}

/** The bound for one JSON-RPC message to the connected-apps server. */
export function connectedAppCallTimeoutMs(message: unknown, limits: { lookupMs?: number; actionMs?: number } = {}): number {
  const lookup = limits.lookupMs ?? CONNECTED_APP_LOOKUP_TIMEOUT_MS;
  const action = limits.actionMs ?? CONNECTED_APP_ACTION_TIMEOUT_MS;
  const msg = object(message);
  if (msg?.method !== "tools/call") return lookup;
  const name = String(object(msg.params)?.name ?? "");
  return isConnectedAppLookup(name) || isConnectedAppStatusTool(name) ? lookup : action;
}

const APP_WORDS: Record<string, string> = {
  GMAIL: "Gmail", GOOGLECALENDAR: "Google Calendar", GOOGLEDRIVE: "Google Drive", GOOGLEDOCS: "Google Docs",
  GOOGLESHEETS: "Google Sheets", GOOGLESUPER: "Google", OUTLOOK: "Outlook", SLACK: "Slack", NOTION: "Notion",
  GITHUB: "GitHub", LINEAR: "Linear", HUBSPOT: "HubSpot", SALESFORCE: "Salesforce", DISCORD: "Discord",
  TWITTER: "X", LINKEDIN: "LinkedIn", DROPBOX: "Dropbox", ASANA: "Asana", TRELLO: "Trello", JIRA: "Jira",
};

/** "GMAIL_FETCH_EMAILS" said as an app and an action. */
function appAction(slug: string): { app: string; action: string } | null {
  const parts = slug.trim().toUpperCase().split("_").filter(Boolean);
  if (parts.length < 2 || !/^[A-Z0-9_]+$/.test(slug.trim().toUpperCase())) return null;
  const head = parts[0]!;
  const app = APP_WORDS[head] ?? `${head.charAt(0)}${head.slice(1).toLowerCase()}`;
  return { app, action: parts.slice(1).join(" ").toLowerCase() };
}

/** The app actions one call runs, from its arguments: the slugs a multi-run
 * names, or the single tool slug. Empty for lookups and unknown shapes. */
export function connectedAppActions(args: unknown): Array<{ app: string; action: string }> {
  let input = object(args);
  // A wrapper call (Grok's `use_tool`) carries the real arguments inside.
  const inner = object(input?.tool_input) ?? object(input?.toolInput);
  if (inner && (typeof input?.tool_name === "string" || typeof input?.toolName === "string")) input = inner;
  if (!input) return [];
  const rows = Array.isArray(input.tools) ? input.tools : [input];
  const out: Array<{ app: string; action: string }> = [];
  for (const row of rows) {
    const slug = object(row)?.tool_slug ?? object(row)?.toolSlug ?? object(row)?.slug;
    const named = typeof slug === "string" ? appAction(slug) : null;
    if (named) out.push(named);
  }
  return out;
}

/** "Gmail: fetch emails", "Gmail: fetch emails and 2 more"; undefined when
 * the call names no app action. */
export function connectedAppActionLabel(args: unknown): string | undefined {
  const actions = connectedAppActions(args);
  if (!actions.length) return undefined;
  const first = `${actions[0]!.app}: ${actions[0]!.action}`;
  return actions.length > 1 ? `${first} and ${actions.length - 1} more` : first;
}

/** The apps a call works in, for the spoken working line ("Gmail and Slack"). */
export function connectedAppNames(args: unknown): string | undefined {
  const apps = [...new Set(connectedAppActions(args).map(item => item.app))];
  if (!apps.length) return undefined;
  if (apps.length === 1) return apps[0];
  return `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
}

/** What the bot reads when a lookup ran out of time, or when the bridge
 * itself stopped waiting on an action. An action is never stopped: the
 * server keeps it running and keeps its result (server/connected-app-operations.ts),
 * so the bot is told not to send it again and how to collect the outcome. */
export function connectedAppTimeoutText(name: string, args: unknown, timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000);
  if (isConnectedAppLookup(name) || isConnectedAppStatusTool(name)) {
    const what = isConnectedAppStatusTool(name) ? "The connected app status check" : "The connected app lookup";
    return `${what} did not answer within ${seconds} seconds and was stopped. Try it once more; if it stops again, tell the user their connected apps are not answering right now.`;
  }
  const label = connectedAppActionLabel(args);
  const what = label ? `The connected app action (${label})` : "The connected app action";
  return `${what} is taking longer than ${seconds} seconds and is still running on its own. Do not run it again. Making the exact same request again returns its result once it finishes, without running it a second time. Tell the user it is still working and that you will report the outcome.`;
}

// ── What makes two action calls "the same" ────────────────────────────────
//
// The model wraps an action in commentary that changes on every retry
// (`thought`, the step labels, the session id). Those fields never change what
// the app does, so they are left out of an action's identity: the same email
// with a reworded `thought` is the same email. The documented fields are the
// ones the connected-apps execute tool declares (server/bot-access.ts lists the
// same set for restricted access). Everything under `arguments` is kept as is.
const COMMENTARY_FIELDS = new Set(["thought", "current_step", "current_step_metric", "session_id", "sessionId", "currentStep", "currentStepMetric"]);

function withoutCommentary(value: unknown): unknown {
  const record = object(value);
  if (!record) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(record)) {
    if (COMMENTARY_FIELDS.has(key)) continue;
    if (key === "tools" && Array.isArray(item)) out[key] = item.map(withoutCommentary);
    else if (key === "tool_input" || key === "toolInput") out[key] = withoutCommentary(item);
    else out[key] = item;
  }
  return out;
}

/** An action's arguments reduced to what changes the effect: the tool, the
 * account and the tool's own arguments, without the model's commentary. */
export function connectedAppEffectArgs(args: unknown): unknown {
  return withoutCommentary(args);
}

/** What an action needs the bot to be allowed to do: each tool and the account
 * it names. Kept with the operation so a later check can look at the bot's
 * grants as they are now, not as they were. */
export interface ConnectedAppRequirement { tool: string; account?: string }

const WRAPPER_TOOLS = new Set(["USE_TOOL"]);
const WRAPPER_NAME_KEYS = ["tool_name", "toolName"];
const WRAPPER_INPUT_KEYS = ["tool_input", "toolInput"];
const WRAPPER_KEYS = new Set([...WRAPPER_NAME_KEYS, ...WRAPPER_INPUT_KEYS]);
/** The fields the connected-apps execute tool declares. Anything else on it is
 * a shape this does not recognise. */
const MULTI_EXECUTE_KEYS = new Set([...COMMENTARY_FIELDS, "tools", "sync_response_to_workbench", "memory"]);
const SLUG_KEYS = ["tool_slug", "toolSlug", "slug"];

function slugOf(row: unknown): string | undefined {
  const item = object(row);
  if (!item) return undefined;
  const present = SLUG_KEYS.filter((key) => item[key] !== undefined);
  if (present.length !== 1) return undefined;
  const value = item[present[0]!];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The call exactly as it will be dispatched. The OUTER tool decides first:
 * only a wrapper tool (`use_tool`) is unwrapped, and only when its arguments
 * are exactly one tool name and one input object; only the execute tool's
 * documented shape is a "multi" call. Wrapper fields on any other tool, extra
 * fields, or two spellings of one field are `wellFormed: false`, and a caller
 * must treat what is forwarded as unclassified.
 */
export interface DispatchedCall {
  /** The tool that actually runs (bare, upper case). */
  target: string;
  /** The arguments of that tool, as forwarded. */
  body: Json | undefined;
  wellFormed: boolean;
  /** Its action rows when it is a well-formed multi-execute call. */
  rows: Json[];
}

export function dispatchedCall(name: string, args: unknown): DispatchedCall {
  const outer = serviceTool(name);
  const input = object(args);
  const broken = (target: string): DispatchedCall => ({ target, body: input, wellFormed: false, rows: [] });
  if (!input) return broken(outer);
  const keys = Object.keys(input);
  let target = outer;
  let body: Json = input;
  if (WRAPPER_TOOLS.has(outer)) {
    const names = WRAPPER_NAME_KEYS.filter((key) => input[key] !== undefined);
    const inputs = WRAPPER_INPUT_KEYS.filter((key) => input[key] !== undefined);
    const inner = inputs.length === 1 ? object(input[inputs[0]!]) : undefined;
    const innerName = names.length === 1 ? input[names[0]!] : undefined;
    if (names.length !== 1 || inputs.length !== 1 || keys.length !== 2 || typeof innerName !== "string" || !innerName.trim() || !inner) return broken(outer);
    target = serviceTool(innerName);
    body = inner;
    if (Object.keys(body).some((key) => WRAPPER_KEYS.has(key))) return { target, body, wellFormed: false, rows: [] };
  } else if (keys.some((key) => WRAPPER_KEYS.has(key))) {
    return broken(outer);
  }
  if (target !== "COMPOSIO_MULTI_EXECUTE_TOOL") return { target, body, wellFormed: true, rows: [] };
  const rows = Array.isArray(body.tools) ? body.tools : [];
  const ok = Object.keys(body).every((key) => MULTI_EXECUTE_KEYS.has(key))
    && rows.length > 0 && rows.every((row) => !!object(row) && slugOf(row) !== undefined);
  return { target, body, wellFormed: ok, rows: ok ? rows as Json[] : [] };
}

/** What an action needs the bot to be allowed to do: each tool and the account
 * it names. Taken from the call as it is dispatched; a call whose structure is
 * not recognised also contributes everything it carries, nested or not, so
 * nothing it names is missed. */
export function connectedAppRequirements(args: unknown, name = ""): ConnectedAppRequirement[] {
  const call = dispatchedCall(name, args);
  const bodies: Json[] = [];
  const outer = object(args);
  if (call.wellFormed) { if (call.body) bodies.push(call.body); }
  else {
    if (outer) bodies.push(outer);
    for (const key of WRAPPER_INPUT_KEYS) { const nested = object(outer?.[key]); if (nested) bodies.push(nested); }
    if (call.body && !bodies.includes(call.body)) bodies.push(call.body);
  }
  const out: ConnectedAppRequirement[] = [];
  for (const body of bodies) {
    const rows = Array.isArray(body.tools) ? body.tools : [body];
    for (const row of rows) {
      const item = object(row);
      const tool = item?.tool_slug ?? item?.toolSlug ?? item?.slug;
      if (typeof tool !== "string") continue;
      const account = item?.account;
      const entry: ConnectedAppRequirement = typeof account === "string" ? { tool, account } : { tool };
      if (!out.some((seen) => seen.tool === entry.tool && seen.account === entry.account)) out.push(entry);
    }
  }
  return out;
}

/** What an action used, and whether that list is the whole truth. A call whose
 * tools could not all be named (an unrecognised shape, a tool without a slug,
 * a tool the service runs on its own) is `complete: false`: a restricted bot is
 * never handed its stored result, because nothing says what it needed. */
export interface ConnectedAppProvenance { requirements: ConnectedAppRequirement[]; complete: boolean }

export function connectedAppProvenance(name: string, args: unknown): ConnectedAppProvenance {
  const call = dispatchedCall(name, args);
  const requirements = connectedAppRequirements(args, name);
  return { requirements, complete: call.target === "COMPOSIO_MULTI_EXECUTE_TOOL" && call.wellFormed && call.rows.length > 0 };
}

// ── Operations: one identity per action call ─────────────────────────────
//
// A slow action is never dispatched twice. The interactive wait ends at
// CONNECTED_APP_ACTION_TIMEOUT_MS, but the operation keeps running for up to
// CONNECTED_APP_OPERATION_LIFETIME_MS (the broker allows 285 s upstream) and
// its result is kept, so a later check, or the same request made again,
// returns the outcome instead of running the action again.

/** How long one action may run in the background. */
export const CONNECTED_APP_OPERATION_LIFETIME_MS = 300_000;
/** How long a finished action's result is kept for the bot to collect. */
export const CONNECTED_APP_RESULT_TTL_MS = 15 * 60_000;
/** After the bot has seen a result, how long the same request still returns
 * it instead of running again (an engine that resends a call it already got
 * an answer for). */
export const CONNECTED_APP_REPEAT_WINDOW_MS = 60_000;
/** How long a status check waits for a running action before answering. */
export const CONNECTED_APP_STATUS_WAIT_MS = 20_000;
/** The header the bridge uses to tell the server how long it will wait. */
export const CONNECTED_APP_WAIT_HEADER = "x-murage-wait-ms";

/** The bridge's own tool for collecting an action's outcome. */
export const CONNECTED_APP_STATUS_TOOL = "CHECK_CONNECTED_APP_ACTION";

export function isConnectedAppStatusTool(name: string): boolean {
  return serviceTool(name) === CONNECTED_APP_STATUS_TOOL;
}

/** The bare tool id used for an operation's identity. */
export function connectedAppToolId(name: string): string {
  return serviceTool(name);
}

/** Whether a JSON-RPC message runs an app action that gets an operation
 * identity: a single tools/call with an id that is not a lookup. */
export function connectedAppActionCall(message: unknown): { id: unknown; name: string; args: unknown } | null {
  const msg = object(message);
  if (!msg || msg.method !== "tools/call" || !validRequestId(msg.id)) return null;
  const params = object(msg.params);
  const name = String(params?.name ?? "");
  if (!name || isConnectedAppLookup(name) || isConnectedAppStatusTool(name)) return null;
  return { id: msg.id, name, args: params?.arguments ?? null };
}

/** A usable JSON-RPC request id: a non-empty string or a finite number. */
function validRequestId(id: unknown): boolean {
  return (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isFinite(id));
}

/** Whether a message would run an app action but cannot be given an operation
 * identity (no usable request id, or a batch that carries one). Such a message
 * must never be forwarded: nothing would record it or guard its repeat. */
export function connectedAppUnprotectedAction(message: unknown): boolean {
  if (Array.isArray(message)) return message.some((entry) => runsAppAction(entry));
  const msg = object(message);
  return msg !== undefined && runsAppAction(msg) && !validRequestId(msg.id);
}

function runsAppAction(message: unknown): boolean {
  const msg = object(message);
  if (!msg || msg.method !== "tools/call") return false;
  const name = String(object(msg.params)?.name ?? "");
  return !name || !(isConnectedAppLookup(name) || isConnectedAppStatusTool(name));
}

export const CONNECTED_APP_STATUS_TOOL_DEFINITION = {
  name: CONNECTED_APP_STATUS_TOOL,
  description:
    "Get the outcome of a connected app action that was still running when you last heard about it. " +
    "Pass the handle you were given. Use this instead of running the action again. " +
    "Set run_again to true only after you checked in the app that the action did not happen and the user still wants it; " +
    "then make the request again.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The handle from the still running message." },
      run_again: { type: "boolean", description: "Clear a finished or unknown outcome so the same request can run once more." },
    },
    required: ["handle"],
    additionalProperties: false,
  },
};

const minutes = (ms: number) => Math.round(ms / 60_000);
const what = (label: string | undefined) => label ? `The connected app action (${label})` : "The connected app action";

export function connectedAppPendingText(label: string | undefined, handle: string, repeated: boolean): string {
  return `${what(label)} is still running${repeated ? " from your earlier request; it was not started again" : ""}. Its handle is ${handle}. ` +
    `Do not run it again: it finishes on its own and its result is kept for ${minutes(CONNECTED_APP_RESULT_TTL_MS)} minutes. ` +
    `To get the result, call ${CONNECTED_APP_STATUS_TOOL} with this handle. Tell the user it is still working and that you will report the outcome.`;
}

export function connectedAppRepeatNote(label: string | undefined, handle: string, secondsAgo: number): string {
  return `${what(label)} already ran ${secondsAgo} seconds ago (handle ${handle}) and was not run again. This is its result. ` +
    `If the user wants it done a second time, call ${CONNECTED_APP_STATUS_TOOL} with this handle and run_again true, then make the request again.`;
}

export type UnknownCause = "no-answer" | "interrupted" | "result-gone";

export function connectedAppUnknownText(label: string | undefined, handle: string, cause: UnknownCause = "no-answer"): string {
  const how = cause === "interrupted"
    ? `${what(label)} was on its way to the app when Murage stopped, so it is not known whether it finished.`
    : cause === "result-gone"
      ? `${what(label)} ran and the app answered, but that answer is no longer held here, so what it said is not known.`
      : `${what(label)} was sent to the app, but no answer came back, so it is not known whether it finished.`;
  return `${how} It was not run again. ` +
    `Check in the app whether it happened before doing anything else. If it did not happen and the user still wants it, ` +
    `call ${CONNECTED_APP_STATUS_TOOL} with handle ${handle} and run_again true, then make the request again.`;
}

/** What a later request for a verified read receives: its answer from an earlier moment, said so plainly. */
export function connectedAppHistoryNote(label: string | undefined, handle: string, secondsAgo: number): string {
  return `${what(label)} was read ${secondsAgo} seconds ago (handle ${handle}). This is what it returned at that time, a record of that moment and not the current state. ` +
    `For the current state, make the request again: reads run fresh each time.`;
}

export function connectedAppReadUnknownText(label: string | undefined): string {
  return `${what(label)} was sent to the app, but no answer came back. It only reads, so it is fine to make the request again.`;
}

export function connectedAppNotClearedText(label: string | undefined): string {
  return `${what(label)} could not be cleared just now. Nothing was sent to the app. Try again in a moment.`;
}

export function connectedAppBusyText(label: string | undefined): string {
  return `${what(label)} did not run: too many connected app actions are waiting on an outcome right now. Nothing was sent to the app. ` +
    `Collect the outcomes you were given with ${CONNECTED_APP_STATUS_TOOL}, then make the request again.`;
}

export function connectedAppUnrecordedText(label: string | undefined): string {
  return `${what(label)} did not run: its record could not be saved first. Nothing was sent to the app, so it is fine to make the request again in a moment.`;
}

export function connectedAppNotSentText(label: string | undefined, reason: string): string {
  return `${what(label)} did not run: ${reason.replace(/[.\s]+$/, "")}. Nothing was sent to the app, so it is fine to make the request again.`;
}

export function connectedAppNoRecordText(handle: string): string {
  return `No connected app action with handle ${handle} is on record. Results are kept for ${minutes(CONNECTED_APP_RESULT_TTL_MS)} minutes.`;
}

export function connectedAppClearedText(label: string | undefined): string {
  return `${what(label)} was cleared. You can make the request again now.`;
}

/** What a connector call says when the Murage Worker has retired. The model
 * reads it as the tool's answer, so it names the way out rather than a code. */
export const LEGACY_BROKER_RETIRED =
  "Murage's original connected-apps service has retired, so this request did not run. Connect Flux Router, then reconnect the app under Connected apps.";
/** The same, once a working Flux Router broker has taken over. */
export const LEGACY_BROKER_RETIRED_FLUX_READY =
  "Murage's original connected-apps service has retired, and connected apps now run through Flux Router. Try the request again; if the app is missing, reconnect it under Connected apps.";
/** The Worker's per-install daily cap (it resets at 00:00 UTC). */
export const LEGACY_DAILY_LIMIT =
  "Connected apps have reached today's limit on Murage's original service, so this request did not run. The limit resets at 00:00 UTC and does not apply once your apps run through Flux Router.";
/** The plain answers the harness gives, as HTTP 200 with a JSON-RPC error, for
 * refusals the service sent as a 4xx. Each is a decision, not an outage. */
export const CONNECTED_APP_REFUSAL_ANSWERS: readonly string[] = Object.freeze([
  LEGACY_DAILY_LIMIT,
  LEGACY_BROKER_RETIRED,
  LEGACY_BROKER_RETIRED_FLUX_READY,
]);
