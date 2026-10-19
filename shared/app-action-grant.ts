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
//     call and only when that call runs exactly one action;
//   - a tool on a custom or external MCP mount, on any engine:
//     `acp-tool:v2:<mountId>/<tool>`, Rule 59 encoded (APP-GRANT-DESIGN-FINAL
//     .AGREED-r10.md Rule 32), so the grant follows the mount across engines
//     and Codex aliases and two servers offering the same action never share
//     one;
//   - a connected-app lookup: `mcp__murage_connectors__APPS_<LOOKUP>`, in
//     that one spelling on every engine;
//   - nothing at all when the call cannot be named that reliably (a model
//     written title, an unrecognised shape, several actions at once, the
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
export type EngineKind = "claude" | "codex" | "pi" | "acp";

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

/** The grant for one of Murage's own connected-app tools, by its service id. */
function ownGrant(app: string, args: unknown): string | null {
  if (APP_LOOKUPS[app] !== undefined) return `mcp__${CONNECTED_APPS_SERVER}__${exposedToolName(app)}`;
  if (app !== EXECUTE) return null;
  const dispatched = dispatchedCall(EXECUTE, args);
  if (!dispatched.wellFormed || dispatched.rows.length !== 1) return null;
  const slug = slugOf(dispatched.rows[0])?.trim().toUpperCase();
  return slug && SLUG.test(slug) && ownAppTool(slug) === undefined ? `${APP_ACTION_PREFIX}${slug}` : null;
}

/**
 * The grant "Always allow" remembers for this ask, when the ask is a
 * connected-app call or a tool named only by a generic kind:
 *   - a key naming the one action (or lookup, or stamped MCP tool) it runs;
 *   - null when no single action can be named: offer no standing grant;
 *   - undefined for every other tool, whose grant is decided as before.
 */
export function actionGrantKey(tool: string, call?: GrantCall): string | null | undefined {
  const generic = isGenericTool(tool);
  const resolved = resolveCall(call);
  switch (resolved.kind) {
    case "unproven":
      return null;
    case "mcp": {
      if (resolved.own) {
        const app = ownAppTool(`mcp__${CONNECTED_APPS_SERVER}__${resolved.tool}`);
        return app === undefined ? null : ownGrant(app, resolved.input);
      }
      // Murage's other own servers keep the keys they are judged by today
      // (`ask_bot:@Helper`, the tool's own name)
      if (resolved.provenance === "own") return undefined;
      // Rules 32, 50: a custom or external tool is keyed by its mount's
      // identity, so the grant follows the mount across engines and aliases
      return isGenericTool(resolved.tool) ? null : acpToolKey(resolved.mountId, resolved.tool);
    }
    case "engine":
      return generic || ownAppTool(tool) !== undefined ? null : undefined;
    case "unstamped": {
      const name = (call?.toolCall?.name ?? tool).trim();
      const app = ownAppTool(name);
      if (app !== undefined) return ownGrant(app, call?.toolCall?.input);
      return generic || ownAppTool(tool) !== undefined ? null : undefined;
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
