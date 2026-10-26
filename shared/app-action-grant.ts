// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What "Always allow" remembers for a connected-app call, and for a tool whose
// name names no one action.
//
// A remembered grant used to be the bare tool name. Every connected-app action
// runs through one execute tool, and an ACP engine (Fuigo) files every MCP
// call under the kind "other", so one press of "Always allow" on "Gmail: fetch
// emails" also answered sending mail, posting to Slack and anything else any
// MCP tool did. A grant now names exactly the one action the card showed:
//
//   - a connected-app action: `app-action:<SLUG>` (the app and the action,
//     e.g. `app-action:GMAIL_SEND_EMAIL`), read from the engine's structured
//     call; a call of several rows is remembered as the SET of its rows'
//     keys, one per distinct action (AMEND-13 Rule 78), never the wrapper;
//   - a tool on a custom or external MCP mount, on any engine:
//     `acp-tool:v2:<mountId>/<tool>`, Rule 59 encoded (APP-GRANT-DESIGN-FINAL
//     .AGREED-r10.md Rule 32), so the grant follows the mount across engines
//     and Codex aliases and two servers offering the same action never share
//     one;
//   - a connected-app lookup: `mcp__murage_connectors__APPS_<LOOKUP>`, in
//     that one spelling on every engine;
//   - nothing at all when the call cannot be named that reliably (a model
//     written title, an unrecognised shape, a row it cannot read whole, the
//     remote shell, an identity that cannot be proven). The card then offers
//     no standing grant, like a question.
//
// Every reader here fails closed (lanes/release103/APP-GRANT-FAIL-CLOSED.md):
// an identity is proven against the F4 records of the mounts the engine
// loads for this turn, by exact engine name, never read from a name's shape; a wrapper is opened to a fixed point under
// a cap; a scan that runs out says so. The grant key and the stop line read
// the one `resolveCall` result, so they judge the same innermost identity.
//
// Older grants not in a shape this writes are dropped at load (server/store.ts,
// shared/app-action-words.ts isStaleGrant).

import { CONNECTED_APPS_SERVER, exposedToolName, serviceToolName } from "./connected-app-names.ts";
import { dispatchedCall, slugOf } from "./connected-app-calls.ts";
import { APP_ACTION_PREFIX, APP_LOOKUPS, isGenericTool, ownAppTool } from "./app-action-words.ts";
import { SCAN_DEPTH, SCAN_NODES, SCAN_TOTAL, WRAP_DEPTH } from "./scan-limits.ts";
import { acpToolKey, isMountRecord, isOwnConnector, type McpMountRecord } from "./mount-identity.ts";

/** Which driver filed the ask; its Rule 55 contract table applies. */
export type EngineKind = "claude" | "codex" | "pi" | "acp" | "antigravity";

/** The engine's own facts about a permission ask (server/contracts.ts
 * request.opened): its structured call, its stamped identity, its ACP kind,
 * the mounts the driver handed it, and whether the driver cut the input. */
export interface GrantCall {
  toolCall?: { name: string; input: unknown };
  toolIdentity?: { namespace: string; name: string; kind?: string };
  toolKind?: string;
  /** F4 (Rule 54): the MCP servers this engine loads for this turn, as the
   * driver that mounted or enumerated them recorded them. An MCP identity is
   * proven against these records by exact `engineName` and nothing else. */
  mcpMounts?: readonly McpMountRecord[];
  /** The driver cut the input it reports: what it shows is not the whole call. */
  truncated?: boolean;
  /** F5 (Rule 55): a field the contract needs was absent on the wire. */
  inputMissing?: string;
  /** The driver that filed the ask (Rule 55's per-driver tables). */
  engine?: EngineKind;
  /** 1.0.4 F1: the driver runs this command tool's text under PowerShell
   * (Codex and ACP engines on Windows pin `powershell.exe -Command`), so the
   * text is read, and its "Always allow" keyed, as PowerShell's. */
  commandShell?: "pwsh";
}

/** The execute tool every app action runs through, by its internal id. */
const EXECUTE = serviceToolName("APPS_MULTI_EXECUTE_TOOL");
const SLUG = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
/** How many wrappers (`use_tool` inside `use_tool`) are opened before the
 * call is held unread (shared/scan-limits.ts, the one copy). */
export { WRAP_DEPTH };

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Rule 8: the namespaces a stamp may carry. Anything else is unproven until
 * a driver change adds it with its own reader. */
export const STAMP_NAMESPACES: readonly string[] = ["mcp", "fuigo_build"];
/** Rule 8, 1.0.4: the engine tools read in a namespace of their own, each by
 * its exact name and the ACP kind it is filed under. Fuigo's (and Grok
 * Build's) whole-file write is the OpenCode `write` tool their preset adds
 * (fuigo-tools opencode/write: namespace `opencode`, sent as kind `edit` with
 * `locations: [file_path]` and rawInput `{file_path, content}`), so it is
 * judged like any edit: the edit contract, the stop line and the guards read
 * its path and body. Fuigo's patch tool is Codex's apply_patch (fuigo-tools
 * codex/apply_patch: namespace `codex`, sent as kind `edit` with rawInput
 * `{patch}` and no locations); the ACP driver reads the patch with the one
 * apply_patch reader (shared/apply-patch.ts) and files every place it writes
 * or removes as the call's paths, or the call as unread (r#7, 1.0.7). Every
 * other name in such a namespace stays unproven. */
const STAMPED_TOOLS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ["opencode", new Map([["write", "edit"]])],
  ["codex", new Map([["apply_patch", "edit"]])],
]);
/** Rule 9: the ACP kinds that identify an unstamped ask by themselves. */
export const ACP_IDENTIFYING_KINDS: readonly string[] = ["execute", "edit", "read", "delete", "move", "search", "fetch"];

/** The tool an ask really runs, as far as the engine's own facts prove it. */
export type ResolvedCall =
  /** an engine that names the tool itself (Claude, Codex, Pi) and the name is not an MCP name */
  | { kind: "unstamped" }
  /** an identity this cannot prove: no grant, and the stop line stops */
  | { kind: "unproven"; why: string }
  /** an MCP tool on exactly one of this turn's F4 records */
  | { kind: "mcp"; server: string; tool: string; own: boolean; mountId: string; provenance: McpMountRecord["provenance"]; name: string; input: unknown }
  /** one of the engine's own tools: stamped, named inside a wrapper, or (ACP without a stamp) by its protocol kind */
  | { kind: "engine"; name: string; input: unknown; wrapped: boolean; byKind?: boolean };

/**
 * Rules 11 and 30: the server part of `<server>__<tool>` is the text before
 * the FIRST `__`, the tool everything after it, verbatim; the server must
 * equal exactly one record's `engineName`. Two records that are both a
 * `__`-delimited prefix of the name make the split ambiguous: unproven,
 * nothing picks the longer one. A string says why there is no record.
 */
export function mountOf(name: string, mounts: readonly McpMountRecord[] | undefined): { record: McpMountRecord; tool: string } | string {
  if (!mounts) return "the turn's mounts are not known";
  const valid = mounts.filter(isMountRecord);
  if (valid.length !== mounts.length) return "a mount record this cannot read";
  const prefixes = valid.filter((record) => name.startsWith(`${record.engineName}__`));
  if (prefixes.length > 1) return "the name fits more than one mount";
  const at = name.indexOf("__");
  if (at <= 0) return "the name names no server";
  const server = name.slice(0, at);
  const tool = name.slice(at + 2);
  const matches = valid.filter((record) => record.engineName === server);
  if (matches.length !== 1) return matches.length ? "the name fits more than one mount" : "no mount of this turn is named";
  if (!tool) return "the name names no tool";
  return { record: matches[0]!, tool };
}

function mcpCall(name: string, input: unknown, mounts: readonly McpMountRecord[] | undefined): ResolvedCall {
  const mount = mountOf(name, mounts);
  if (typeof mount === "string") return { kind: "unproven", why: mount };
  const { record, tool } = mount;
  // Rule 51: `muragebox` is the permission broker's transport, never a model
  // tool; its question tool reaches the owner through the question path.
  if (record.mountId === "own:muragebox") return { kind: "unproven", why: "the permission broker is never called as a tool" };
  return {
    kind: "mcp", server: record.engineName, tool, own: isOwnConnector(record), mountId: record.mountId, provenance: record.provenance,
    name: `${record.engineName}__${tool}`, input,
  };
}

/** A wrapper's inner call: exactly one tool name and one input object (Fuigo
 * adds its `variant` tag). Anything else is not read. */
function unwrap(input: unknown): { name: string; args: unknown } | null {
  const body = object(input);
  if (!body) return null;
  const names = ["tool_name", "toolName"].filter((key) => body[key] !== undefined);
  const inputs = ["tool_input", "toolInput"].filter((key) => body[key] !== undefined);
  const extra = Object.keys(body).filter((key) => ![...names, ...inputs, "variant"].includes(key));
  const name = names.length === 1 ? body[names[0]!] : undefined;
  const args = inputs.length === 1 ? object(body[inputs[0]!]) : undefined;
  if (extra.length || typeof name !== "string" || !name.trim() || !args) return null;
  return { name: name.trim(), args };
}

/** Rule 10: wrappers opened to a fixed point under WRAP_DEPTH. The inner name
 * is judged as a stamp would be: MCP-shaped must resolve to a mount,
 * engine-shaped is `engine` with `wrapped`, a generic inner name or a wrapper
 * of another shape is unproven. */
function unwrapped(input: unknown, mounts: readonly McpMountRecord[] | undefined): ResolvedCall {
  let body = input;
  for (let depth = 0; depth < WRAP_DEPTH; depth++) {
    const inner = unwrap(body);
    if (!inner) return { kind: "unproven", why: "a wrapper of a shape this does not read" };
    if (inner.name.toLowerCase() !== "use_tool") {
      if (isGenericTool(inner.name)) return { kind: "unproven", why: "a wrapper that names no tool" };
      if (inner.name.includes("__")) return mcpCall(inner.name.replace(/^mcp__/, ""), inner.args, mounts);
      return { kind: "engine", name: inner.name, input: inner.args, wrapped: true };
    }
    body = inner.args;
  }
  return { kind: "unproven", why: `a call wrapped more than ${WRAP_DEPTH} deep` };
}

/** The tool an ask runs, from the engine's own facts and this turn's mounts
 * (Rules 4, 8..11, 30). */
export function resolveCall(call: GrantCall | undefined): ResolvedCall {
  const identity = call?.toolIdentity;
  if (identity) {
    const name = typeof identity.name === "string" ? identity.name.trim() : "";
    const namespace = typeof identity.namespace === "string" ? identity.namespace.trim() : "";
    if (!namespace || !name) return { kind: "unproven", why: "a stamp this cannot read" };
    const tools = STAMPED_TOOLS.get(namespace);
    if (tools) {
      const filed = tools.get(name);
      return filed !== undefined && call?.toolKind === filed
        ? { kind: "engine", name, input: call?.toolCall?.input, wrapped: false }
        : { kind: "unproven", why: `a ${namespace} tool Murage does not read` };
    }
    if (!STAMP_NAMESPACES.includes(namespace)) return { kind: "unproven", why: "a stamp in a namespace Murage does not read" };
    if (namespace === "mcp") return mcpCall(name, call?.toolCall?.input, call?.mcpMounts);
    if (isGenericTool(name)) return unwrapped(call?.toolCall?.input, call?.mcpMounts);
    return { kind: "engine", name, input: call?.toolCall?.input, wrapped: false };
  }
  // Rule 9: an ACP ask with no stamp is named by its protocol kind, never by
  // its title; a kind outside the identifying set is unproven.
  if (call?.engine === "acp" || (call?.engine === undefined && call?.toolKind !== undefined)) {
    const kind = (call?.toolKind ?? "").trim();
    if (!ACP_IDENTIFYING_KINDS.includes(kind)) return { kind: "unproven", why: kind ? `an engine tool of kind "${kind}" names nothing it runs` : "an engine tool with no kind" };
    return { kind: "engine", name: kind, input: call?.toolCall?.input, wrapped: false, byKind: true };
  }
  // Rule 11: an unstamped engine's MCP name is decomposed structurally against F4.
  const named = call?.toolCall?.name?.trim();
  if (named && /^mcp__/.test(named) && call?.engine !== undefined) return mcpCall(named.slice("mcp__".length), call.toolCall?.input, call.mcpMounts);
  return { kind: "unstamped" };
}

/** Rule 78a: the fields one execute row may carry (the execute tool's
 * declared row shape: one slug spelling, the account, the arguments). */
const ROW_KEYS = new Set(["tool_slug", "toolSlug", "slug", "account", "arguments"]);

/** Rule 78: one row of an own-connector execute call, in call order. */
export interface AppActionRow {
  /** the operation slug, upper case: `GMAIL_SEND_EMAIL` */
  slug: string;
  /** its one action key: `app-action:GMAIL_SEND_EMAIL` */
  key: string;
  /** the row's own arguments, as forwarded (an object, or absent) */
  arguments: Record<string, unknown> | undefined;
  /** the connected account the row names, when it names one */
  account?: string;
}

/** Rule 78: what "Always allow" remembers for a connected-app call: the SET
 * of exact action keys, one per distinct action, never the wrapper. `rows`
 * is every execute row in call order (empty for a lookup or a custom tool),
 * so a row's findings and its key line up by index. */
export interface ActionGrantSet {
  keys: string[];
  rows: AppActionRow[];
}

/** Rule 78a: every row of a well-formed execute call, or why it cannot be
 * read whole (any row, or the list): no standing grant then, and the call is
 * unread (A13-FIX-DESIGN C3). */
function executeRows(args: unknown): AppActionRow[] | string {
  const dispatched = dispatchedCall(EXECUTE, args);
  if (!dispatched.wellFormed || !dispatched.rows.length) return "its list of actions is missing, empty or not in the shape Murage reads";
  // a reader limit reached anywhere in the call is never a reason to ignore the tail
  if (placeArgumentScan(args).cut) return "its arguments run past what Murage reads";
  const rows: AppActionRow[] = [];
  for (const [index, row] of dispatched.rows.entries()) {
    const at = `action ${index + 1}`;
    if (Object.keys(row).some((key) => !ROW_KEYS.has(key))) return `${at} carries a field Murage does not read`;
    const slug = slugOf(row)?.trim().toUpperCase();
    if (!slug || !SLUG.test(slug) || ownAppTool(slug) !== undefined) return `${at} names no action Murage can identify`;
    const rowArgs = row.arguments;
    if (rowArgs !== undefined && !object(rowArgs)) return `${at} has arguments Murage cannot read`;
    if (row.account !== undefined && (typeof row.account !== "string" || !row.account.trim())) return `${at} names an account Murage cannot read`;
    rows.push({ slug, key: `${APP_ACTION_PREFIX}${slug}`, arguments: object(rowArgs), ...(typeof row.account === "string" ? { account: row.account } : {}) });
  }
  return rows;
}

/** What the grant reader made of a call (A13-FIX-DESIGN C3): the set, and
 * when an own-connector execute call could not be read whole, why. A caller
 * that judges the call treats `unread` as unread, ahead of every grant and mode. */
export interface ActionGrantRead {
  set: ActionGrantSet | null | undefined;
  unread?: string;
}

/** The grant set for one of Murage's own connected-app tools, by its service id. */
function ownGrant(app: string, args: unknown): ActionGrantRead {
  if (APP_LOOKUPS[app] !== undefined) return { set: { keys: [`mcp__${CONNECTED_APPS_SERVER}__${exposedToolName(app)}`], rows: [] } };
  if (app !== EXECUTE) return { set: null };
  const rows = executeRows(args);
  if (typeof rows === "string") return { set: null, unread: rows };
  // Rule 78b: every row is read; identical keys are deduplicated for storage only
  return { set: { keys: [...new Set(rows.map((row) => row.key))], rows } };
}

/**
 * The grant "Always allow" remembers for this ask, when the ask is a
 * connected-app call or a tool named only by a generic kind:
 *   - a key naming the one action (or lookup, or stamped MCP tool) it runs;
 *   - null when no single action can be named: offer no standing grant;
 *   - undefined for every other tool, whose grant is decided as before.
 */
export function actionGrantKey(tool: string, call?: GrantCall): string | null | undefined {
  const set = actionGrantSet(tool, call);
  if (set === undefined || set === null) return set;
  // one key only when the call runs one distinct action; several ride as a set
  return set.keys.length === 1 ? set.keys[0]! : null;
}

/**
 * Rules 77 and 78: the grant set "Always allow" remembers for this ask, after
 * the call's mount is proven against this turn's F4 records:
 *   - one exact key per distinct action of an own-connector execute call
 *     (one OR many well-formed rows), with every row in call order;
 *   - the lookup's own key, or a custom/external tool's mount-bound key;
 *   - null when the call cannot be read or proven whole: no standing grant;
 *   - undefined for every other tool, whose grant is decided as before.
 */
export function actionGrantSet(tool: string, call?: GrantCall): ActionGrantSet | null | undefined {
  return actionGrantRead(tool, call).set;
}

/** The one execute-row reader every grant, card and stop-row caller goes
 * through (A13-FIX-DESIGN C3). */
export function actionGrantRead(tool: string, call?: GrantCall): ActionGrantRead {
  const generic = isGenericTool(tool);
  const resolved = resolveCall(call);
  switch (resolved.kind) {
    case "unproven":
      return { set: null, unread: resolved.why };
    case "mcp": {
      if (resolved.own) {
        const app = ownAppTool(`mcp__${CONNECTED_APPS_SERVER}__${resolved.tool}`);
        return app === undefined ? { set: null } : ownGrant(app, resolved.input);
      }
      // Murage's other own servers keep the keys they are judged by today
      // (`ask_bot:@Helper`, the tool's own name)
      if (resolved.provenance === "own") return { set: undefined };
      // Rules 32, 50: a custom or external tool is keyed by its mount's
      // identity, so the grant follows the mount across engines and aliases
      return { set: isGenericTool(resolved.tool) ? null : { keys: [acpToolKey(resolved.mountId, resolved.tool)], rows: [] } };
    }
    case "engine":
      return { set: generic || ownAppTool(tool) !== undefined ? null : undefined };
    case "unstamped": {
      const name = (call?.toolCall?.name ?? tool).trim();
      const app = ownAppTool(name);
      if (app !== undefined) return ownGrant(app, call?.toolCall?.input);
      return { set: generic || ownAppTool(tool) !== undefined ? null : undefined };
    }
  }
}

/** The tool an ACP engine stamped (its identity, never the model-written
 * title) and the arguments it runs with, said the way the stop line reads a
 * tool: an MCP tool as `mcp__<stamped name>`, an engine tool by its stamped
 * name (wrapped or not, so a neutral title never stands in for it).
 * Undefined when the ask carries no stamp; null when the identity cannot be
 * proven, which the caller stops. */
export function stampedToolCall(call: GrantCall): { name: string; input: unknown } | null | undefined {
  const resolved = resolveCall(call);
  switch (resolved.kind) {
    case "unstamped": return undefined;
    case "unproven": return null;
    case "mcp": return { name: `mcp__${resolved.name}`, input: resolved.input };
    case "engine": return { name: resolved.name, input: resolved.input };
  }
}

/** The shell line a call's arguments carry, whatever the tool is called: a
 * `command`, `cmd`, `script` or `code` string, or an argv array of strings
 * joined. The guards read it beside the card text, so a terminal command
 * inside a wrapper or an MCP tool is judged like one the engine's own shell
 * tool asked for. Undefined when the arguments carry none. */
export function commandArgument(input: unknown): string | undefined {
  const body = object(input);
  if (!body) return undefined;
  for (const key of ["command", "cmd", "script", "code"]) {
    const raw = body[key];
    if (typeof raw === "string" && raw.trim()) return raw;
    if (Array.isArray(raw) && raw.length && raw.every((part) => typeof part === "string")) return (raw as string[]).join(" ");
  }
  return undefined;
}

/** The text of every string argument in an engine's structured call,
 * through nested objects and arrays (a connected-app run's
 * `tools[].arguments`, a wrapper's `tool_input`, a terminal tool's
 * `command`). Every string, not only the ones under a path-like key: a key
 * file can be named in a command, a script, a query or an argument list
 * (Astra r3). Policy reads the WHOLE input (Rule 37): no string is
 * shortened; `cut` only when the scan ran past its node budget, its depth or
 * its total of string text (shared/scan-limits.ts), and then the text is not
 * the whole call and the caller must not treat it as one. Empty and whole
 * when there is no structured input. */
export function placeArgumentScan(input: unknown): { text: string; cut: boolean } {
  const out: string[] = [];
  let budget = SCAN_NODES;
  let total = 0;
  let cut = false;
  const spend = (depth: number): boolean => {
    if (budget <= 0 || depth > SCAN_DEPTH) { cut = true; return false; }
    budget -= 1;
    return true;
  };
  const walk = (value: unknown, depth: number): void => {
    if (!spend(depth)) return;
    if (typeof value === "string") {
      if (total + value.length > SCAN_TOTAL) { cut = true; return; }
      total += value.length;
      out.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const body = object(value);
    if (!body) return;
    for (const inner of Object.values(body)) walk(inner, depth + 1);
  };
  walk(input, 0);
  return { text: out.join("\n"), cut };
}
