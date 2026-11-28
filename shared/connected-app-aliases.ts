// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23): a bot calls a connected-app action by its plain name
// (`gmail_send_email`) instead of building a MULTI_EXECUTE batch. One pure
// resolver (`aliasCall`) turns the plain call into the canonical execute body;
// the bridge (dispatch) and the ask intake (`aliasAsk`, card side) both run it,
// so what the owner is asked is what runs. Design: designs/F11-V3-APP-ALIASES-1023.md.
//
// OWNERS: card side (aliasAsk, one intake call in server/harness/bus.ts) and
// dispatch side (the bridge in server/connector-proxy.ts, the relay in
// server/index.ts): the 1.0.23 F11-V3 builder lane.

import { CONNECTED_APP_TOOLS } from "./bot-access.ts";
import { resolveCall, type EngineKind, type GrantCall } from "./app-action-grant.ts";
import { CONNECTED_APP_EXECUTE_TOOL, CONNECTOR_ALIASES_ENV, exposedToolName } from "./connected-app-names.ts";
import { boundedToolInput } from "../server/approval-text.ts";

export { CONNECTOR_ALIASES_ENV, CONNECTOR_ALIASES_HEADER } from "./connected-app-names.ts";

/** Engines that get aliases in 1.0.23 (design §Alias table). `acp` is out for every ACP agent. `pi` is out until it is
 * proven: Pi refuses every connector-mounted turn (server/drivers/pi.ts), so no Pi ask has a W11 row that drives a real
 * dispatch; add it back together with that row (server/drivers/alias-ask-dispatch-1023.test.ts). `antigravity` is out until it
 * is proven the same way: W11 dispatch is proven on the real vendor CLI (server/drivers/alias-ask-dispatch-real-1023.test.ts) and
 * no Antigravity CLI binary can run in the offline witness, so its asks stay raw (v1.0.20) until a real-agy row exists. */
export const ALIAS_ENGINES: ReadonlySet<EngineKind> = new Set<EngineKind>(["claude", "codex", "chat"]);
/** The bridge's environment marked for an engine that gets plain-name app tools. */
export function withConnectorAliases<T extends { env: Record<string, string> }>(mount: T): T {
  return { ...mount, env: { ...mount.env, [CONNECTOR_ALIASES_ENV]: "1" } };
}
/** Provider driver kinds to the engine kind their asks carry (`toolEngine`). */
const DRIVER_ENGINE: Readonly<Record<string, EngineKind>> = {
  claudeAgent: "claude", codex: "codex", piAgent: "pi", antigravityAgent: "antigravity",
  grok: "chat", minimax: "chat", "openai-compat": "chat",
};
/** Whether a provider driver's bridge mount carries the alias flag. */
export function driverGetsAliases(driverKind: string | undefined): boolean {
  const engine = driverKind === undefined ? undefined : DRIVER_ENGINE[driverKind];
  return engine !== undefined && ALIAS_ENGINES.has(engine);
}

/** alias (`gmail_send_email`) to catalog row; derived, never hand-kept. */
export const CONNECTED_APP_ALIASES: ReadonlyMap<string, { slug: string; toolkit: string; writes: boolean; label: string }> = new Map(
  CONNECTED_APP_TOOLS.map((row) => [row.tool.toLowerCase(), { slug: row.tool, toolkit: row.toolkit, writes: row.writes, label: row.label }] as const),
);

const ACCOUNT = /^[A-Za-z0-9_.-]+$/;
const DEPTH_CAP = 200;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Keys that would pick or override the connected account (moved from server/bot-access.ts so the relay and
 * `aliasCall` share one copy). A structure deeper than the cap is refused. */
export function forbiddenAuthArguments(value: unknown, depth = 0): boolean {
  if (depth > DEPTH_CAP) return true;
  if (Array.isArray(value)) return value.some((item) => forbiddenAuthArguments(item, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    /^(account|account_id|connected_account_id|connectedAccountId|custom_auth_params|customAuthParams|auth_config_id|authentication|authorization|api_key)$/i.test(key) || forbiddenAuthArguments(item, depth + 1));
}

export interface ExecuteBody {
  tools: Array<{ tool_slug: string; account: string; arguments: Record<string, unknown> }>;
  sync_response_to_workbench: false;
}

/** Whether a name is exactly an alias (case-sensitive). */
export const isAliasName = (name: unknown): name is string => typeof name === "string" && CONNECTED_APP_ALIASES.has(name);

/** Existing refusal wording of the execute row reader (shared/app-action-grant.ts executeRows); no new strings. */
const WHY_SHAPE = "its list of actions is missing, empty or not in the shape Murage reads";
const WHY_ACCOUNT = "action 1 names an account Murage cannot read";
const WHY_FIELD = "action 1 carries a field Murage does not read";

/**
 * PURE: the canonical execute body for a plain-name call, or why it is refused.
 * `undefined` when `tool` is not exactly an alias (the tool part AFTER mount proof).
 * Runs the same in every mode: an account override inside `arguments` would run
 * on an account the card did not show.
 */
export function aliasCall(tool: string, input: unknown): { body: ExecuteBody } | { refused: string } | undefined {
  const row = CONNECTED_APP_ALIASES.get(tool);
  if (!row) return undefined;
  if (!isObject(input)) return { refused: WHY_SHAPE };
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("account") || !keys.includes("arguments")) return { refused: WHY_SHAPE };
  const { account } = input;
  if (typeof account !== "string" || account.length < 1 || account.length > 180 || !ACCOUNT.test(account)) return { refused: WHY_ACCOUNT };
  const args = input.arguments;
  if (!isObject(args)) return { refused: WHY_SHAPE };
  // the guard reads `arguments` only: the alias input itself must carry `account`
  if (forbiddenAuthArguments(args) || (row.toolkit === "gmail" && args.user_id !== undefined && args.user_id !== "me")) return { refused: WHY_FIELD };
  return { body: { tools: [{ tool_slug: row.slug, account, arguments: args }], sync_response_to_workbench: false } };
}

/** `aliasCall` over a JSON-RPC tools/call: the message the bridge relays instead, or the refusal. */
export function aliasMessage(message: { id?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: unknown } }):
  { message: Record<string, unknown> } | { refused: string } | undefined {
  const name = message.params?.name;
  if (!isAliasName(name)) return undefined;
  const called = aliasCall(name, message.params?.arguments);
  if (!called) return undefined;
  if ("refused" in called) return called;
  const { id, params } = message as { id?: unknown; params: { _meta?: unknown } };
  return { message: { ...message, id, method: "tools/call", params: { name: CONNECTED_APP_EXECUTE_TOOL, arguments: called.body, ...(params._meta !== undefined ? { _meta: params._meta } : {}) } } };
}

/** The tool name an engine files for the execute call, in the spelling its alias name used. */
function swapAlias(text: string, alias: string): string {
  const at = text.lastIndexOf(alias);
  if (at < 0 || at + alias.length !== text.length) return text;
  const before = text.slice(0, at);
  if (before && !/[_:./\s]$/.test(before)) return text;
  const legacy = /(^|[^a-z0-9])composio($|[_:./\s])/i.test(before);
  const upper = legacy ? CONNECTED_APP_EXECUTE_TOOL : exposedToolName(CONNECTED_APP_EXECUTE_TOOL);
  // Pi joins server and tool with one underscore, lower case; every other engine keeps the upper-case id
  return /[^_]_$/.test(before) && before === before.toLowerCase() ? `${before}${upper.toLowerCase()}` : `${before}${upper}`;
}

/** The event fields a permission ask carries (server/contracts.ts request.opened). */
interface AskEvent {
  type: string;
  requestType?: string;
  tool?: string;
  summary?: string;
  toolInput?: string;
  toolCall?: { name: string; input: unknown };
  toolIdentity?: unknown;
  toolKind?: string;
  mcpMounts?: GrantCall["mcpMounts"];
  toolEngine?: EngineKind;
}

/**
 * The card-side rewrite, run ONCE where the server takes a driver's ask into the bus
 * (server/harness/bus.ts), before any reader sees it. An own-connector alias call
 * (mount proven by F4, engine in ALIAS_ENGINES) becomes the event the same engine files
 * for the equal raw execute call, in every field the card or a reader looks at.
 * Anything else (not an alias, not proven own, a refused call) comes back unchanged.
 * Card side only: the engine's own call and the reply it gets back are never touched.
 */
export function aliasAsk<E extends AskEvent>(event: E): E {
  if (event.type !== "request.opened" || event.requestType !== "permission") return event;
  if (!event.toolEngine || !ALIAS_ENGINES.has(event.toolEngine)) return event;
  const resolved = resolveCall({ toolCall: event.toolCall, toolIdentity: event.toolIdentity as GrantCall["toolIdentity"], toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine });
  if (resolved.kind !== "mcp" || !resolved.own) return event;
  const called = aliasCall(resolved.tool, resolved.input);
  if (!called || "refused" in called) return event;
  const alias = resolved.tool;
  const identity = event.toolIdentity as { namespace?: unknown; name?: unknown } | undefined;
  const patch: Partial<AskEvent> = {};
  if (event.toolCall) patch.toolCall = { name: swapAlias(event.toolCall.name, alias), input: called.body };
  if (typeof event.tool === "string") patch.tool = swapAlias(event.tool, alias);
  if (typeof event.summary === "string") {
    // Claude files the input as its summary (JSON, cut at 200): the raw execute call's summary is that of the body
    const filed = JSON.stringify(resolved.input);
    patch.summary = filed !== undefined && event.summary === filed.slice(0, 200) ? JSON.stringify(called.body).slice(0, 200) : swapAlias(event.summary, alias);
  }
  // the card shows the body whether or not the driver filed a preview: the account and recipient are always in it
  const text = boundedToolInput(called.body);
  if (text !== undefined) patch.toolInput = text;
  if (identity && typeof identity.name === "string") patch.toolIdentity = { ...identity, name: swapAlias(identity.name, alias) };
  const out = Object.create(Object.getPrototypeOf(event), Object.getOwnPropertyDescriptors(event)) as E;
  return Object.assign(out, patch);
}

/** The server-side name of a bare-alias call under an own prefix, for the stop line's unproven check. */
export function ownPrefixedAlias(name: string): string | undefined {
  const bare = name.replace(/^(?:mcp__(?:murage_connectors|composio)__|(?:murage_connectors|composio)(?:__|_))/, "");
  return bare !== name && CONNECTED_APP_ALIASES.has(bare) ? bare : undefined;
}
