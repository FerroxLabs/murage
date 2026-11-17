// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NATIVE WINS (HL-S2-WRITES design (e), Sean 11-03). A bot the owner gave Murage's own HighLevel connection never sees or
// runs HighLevel through the generic connected-apps relay, in any mode, whatever the state of that connection:
//   - native-granted = any stored native grant for this bot (whatever the connection state, a stale role binding
//     included). A native bot (native tools mount) also needs that connection active; that is runtime.mountsFor.
//   - Composio HighLevel = toolkit `highlevel` or `highlevel_location`, or any slug starting `HIGHLEVEL_`. No
//     location-id match and no exception.
//   - Every rule here runs before the `unrestricted` shortcut in server/bot-access.ts. Bots with no native grant are
//     unchanged; highlevelRelayRefusal (native names on the relay) still applies to every bot.
import { connectedAppToolId } from "../../shared/connected-app-calls.ts";
import { nativeAccessFor, type HighLevelAccessBot } from "./access.ts";

export const HIGHLEVEL_NATIVE_WINS_REFUSAL = "This bot uses Murage's own HighLevel connection.";
export const HIGHLEVEL_RECONNECT_LINE = "HighLevel needs reconnecting. Ask the owner to reconnect HighLevel in Settings.";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The refusal a native-granted bot gets, with the reconnect line when its HighLevel connection is down or pending. */
export function nativeWinsRefusalText(connectionActive = true): string {
  return connectionActive ? HIGHLEVEL_NATIVE_WINS_REFUSAL : `${HIGHLEVEL_NATIVE_WINS_REFUSAL} ${HIGHLEVEL_RECONNECT_LINE}`;
}

/** Any stored native HighLevel grant for this bot. Fail closed: a record that does not parse still counts when it holds
 * a grant that is not plainly another bot's. */
export function nativeHighLevelGranted(bot: { id: string; highlevelAccess?: unknown } | null | undefined): boolean {
  if (!bot || !object(bot.highlevelAccess)) return false;
  const grants = bot.highlevelAccess.grants;
  if (!Array.isArray(grants)) return false;
  return grants.some((grant) => !object(grant) || typeof grant.botId !== "string" || grant.botId === bot.id);
}

/** Whether the bot's native HighLevel connection can carry a call now (connected or degraded), as runtime.mountsFor
 * decides it, from the owner's one connection view. False = down, pending or missing: the reconnect line applies. */
export function highlevelConnectionActiveFor(bot: HighLevelAccessBot | undefined, view: { connectionId: string; state: string } | null | undefined): boolean {
  if (!bot || !view || (view.state !== "connected" && view.state !== "degraded")) return false;
  return (nativeAccessFor(bot)?.grants ?? []).some((grant) => grant.accountId === view.connectionId);
}

/** A Composio HighLevel toolkit or slug, in any case. */
export function isComposioHighLevelId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const id = value.trim().toLowerCase();
  return id === "highlevel" || id === "highlevel_location" || id.startsWith("highlevel_");
}

const MAX_DEPTH = 64;

/** Whether any nested string (value or key) names Composio HighLevel. Too deep to read counts as naming it. */
export function mentionsComposioHighLevel(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === "string") return isComposioHighLevelId(value);
  if (Array.isArray(value)) return value.some((item) => mentionsComposioHighLevel(item, depth + 1));
  if (object(value)) return Object.entries(value).some(([key, item]) => isComposioHighLevelId(key) || mentionsComposioHighLevel(item, depth + 1));
  return false;
}

/** Any `sync_response_to_workbench` at any depth whose value is not exactly `false`. */
function syncsToWorkbench(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => syncsToWorkbench(item, depth + 1));
  if (!object(value)) return false;
  return Object.entries(value).some(([key, item]) => (key === "sync_response_to_workbench" && item !== false) || syncsToWorkbench(item, depth + 1));
}

const WORKBENCH = /^COMPOSIO_(REMOTE_WORKBENCH|REMOTE_BASH_TOOL)$/;
const PROXY_EXECUTE = /^COMPOSIO_PROXY_EXECUTE$/;
const SEARCH_TOOLS = /^COMPOSIO_SEARCH_TOOLS$/;

const toolCalls = (input: unknown): Array<{ name: string; tool: string; args: unknown }> => {
  const out: Array<{ name: string; tool: string; args: unknown }> = [];
  // MULTI_EXECUTE can nest another meta-tool. Read the same explicit name
  // and arguments shape at every level, not only the outer JSON-RPC call.
  const visit = (value: unknown, depth = 0): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (!object(value)) return;
    const params = value.method === "tools/call" && object(value.params) ? value.params : undefined;
    const name = params ? String(params.name ?? "") : typeof value.tool_slug === "string" ? value.tool_slug : undefined;
    if (name !== undefined) out.push({ name, tool: connectedAppToolId(name), args: params ? params.arguments : value.arguments });
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(input);
  return out;
};

/** Rules 2 and 4 for a native-granted bot: refuse the WHOLE message (every message of a batch) when any tool name, slug
 * or toolkit anywhere in its arguments is Composio HighLevel (MULTI_EXECUTE tools[], GET_TOOL_SCHEMAS,
 * MANAGE_CONNECTIONS included), and every workbench, remote bash or sync-to-workbench call. True = refuse. */
export function nativeWinsCallRefused(input: unknown): boolean {
  for (const call of toolCalls(input)) {
    if (isComposioHighLevelId(call.name) || isComposioHighLevelId(call.tool)) return true;
    if (WORKBENCH.test(call.tool)) return true;
    if (syncsToWorkbench(call.args)) return true;
    if (mentionsComposioHighLevel(call.args)) return true;
  }
  return false;
}

/** Whether the message holds a COMPOSIO_PROXY_EXECUTE call (rule 3 needs a live account lookup for it). */
export function hasProxyExecute(input: unknown): boolean {
  return toolCalls(input).some((call) => PROXY_EXECUTE.test(call.tool));
}

const ACCOUNT_KEY = /^(connected_account_id|connectedAccountId|account_id|accountId|account)$/;
const HIGHLEVEL_HOST = /(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*(?:gohighlevel|highlevel|leadconnectorhq|leadconnector|msgsndr)\.com(?![a-z0-9-])/i;

function collect(value: unknown, visit: (key: string | null, item: unknown) => void, key: string | null = null, depth = 0): void {
  if (depth > MAX_DEPTH) { visit("__too_deep__", undefined); return; }
  visit(key, value);
  if (Array.isArray(value)) for (const item of value) collect(item, visit, key, depth + 1);
  else if (object(value)) for (const [inner, item] of Object.entries(value)) collect(item, visit, inner, depth + 1);
}

/** Rule 3 for a native-granted bot: COMPOSIO_PROXY_EXECUTE is refused when its connected account (looked up live) is a
 * HighLevel account, its endpoint host is HighLevel or LeadConnector, or the account cannot be resolved. */
export async function nativeWinsProxyRefused(input: unknown, accountToolkit: (accountId: string) => Promise<string | null | undefined>): Promise<boolean> {
  for (const call of toolCalls(input)) {
    if (!PROXY_EXECUTE.test(call.tool)) continue;
    const accounts: string[] = [];
    let unreadable = false;
    let host = false;
    collect(call.args, (key, item) => {
      if (key === "__too_deep__") unreadable = true;
      if (typeof item === "string") {
        if (HIGHLEVEL_HOST.test(item)) host = true;
        // URL normalizes encoded host characters before a proxy can send them.
        try { if (HIGHLEVEL_HOST.test(new URL(item).hostname)) host = true; } catch { /* relative endpoint or ordinary argument */ }
      }
      if (key !== null && ACCOUNT_KEY.test(key)) {
        if (typeof item === "string" && item.trim()) accounts.push(item.trim());
        else if (item !== undefined && item !== null && !object(item) && !Array.isArray(item)) unreadable = true;
      }
    });
    if (unreadable || host || accounts.length === 0) return true;
    for (const account of accounts) {
      let toolkit: string | null | undefined;
      try { toolkit = await accountToolkit(account); } catch { return true; }
      if (!toolkit || isComposioHighLevelId(toolkit)) return true;
    }
  }
  return false;
}

/** NATIVE WINS rule 3 for one relayed call (HL-S2-WRITES H4). `check` runs the live account lookup when the bot holds a native
 *  grant now; `assert` runs at every point the call or its answer could take effect (right before dispatch, after the reply,
 *  before a receipt) and refuses a proxy call whose bot holds a native grant that `check` did not see pass. So a grant added
 *  while the call waited (broker readiness, the app's reply) wins: nothing is dispatched, or the reply is discarded and no
 *  receipt is written. Bots with no native grant and calls with no proxy are unchanged. */
export function nativeWinsProxyGuard(options: {
  body: unknown;
  bot: () => { id: string; highlevelAccess?: unknown } | null | undefined;
  accountToolkit: () => Promise<(accountId: string) => Promise<string | null | undefined>>;
  refusal: () => Error;
}): { check: () => Promise<void>; assert: () => void; refused: () => boolean } {
  const proxy = hasProxyExecute(options.body);
  let passed = false;
  const refused = () => proxy && !passed && nativeHighLevelGranted(options.bot());
  return {
    check: async () => {
      if (!proxy || !nativeHighLevelGranted(options.bot())) return;
      try {
        const toolkit = await options.accountToolkit();
        if (await nativeWinsProxyRefused(options.body, toolkit)) throw options.refusal();
        passed = true;
      } catch { throw options.refusal(); }
    },
    assert: () => { if (refused()) throw options.refusal(); },
    refused,
  };
}

/** /api/internal/connectors/request for a native-granted bot: any HighLevel toolkit refuses the whole request. */
export function nativeWinsConnectorRequestRefused(slugs: readonly string[]): boolean {
  return slugs.some(isComposioHighLevelId);
}

/** A stored result for a native-granted bot: refused when its provenance names Composio HighLevel or is incomplete. */
export function nativeWinsStoredRefused(used: { requirements: ReadonlyArray<{ tool: string; account?: string }>; complete: boolean }): boolean {
  if (!used.complete || !used.requirements.length) return true;
  return used.requirements.some((requirement) => isComposioHighLevelId(requirement.tool) || WORKBENCH.test(connectedAppToolId(requirement.tool)) || PROXY_EXECUTE.test(connectedAppToolId(requirement.tool)));
}

/** Whether a relay reply must be filtered for a native-granted bot: it answers tools/list or COMPOSIO_SEARCH_TOOLS. */
export function nativeWinsFiltersReply(input: unknown): boolean {
  return (Array.isArray(input) ? input : [input]).some((message) => object(message) && message.method === "tools/list")
    || toolCalls(input).some((call) => SEARCH_TOOLS.test(call.tool));
}

/** An object that names Composio HighLevel itself: one of its own string values, or one level down (a nested toolkit). */
const namesHighLevel = (item: Record<string, unknown>): boolean => Object.values(item).some((value) =>
  isComposioHighLevelId(value) || (object(value) && Object.values(value).some(isComposioHighLevelId)));

function strip(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isComposioHighLevelId(item) && !(object(item) && namesHighLevel(item)))
      .map((item) => strip(item, depth + 1));
  }
  if (object(value)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isComposioHighLevelId(key)).map(([key, item]) => [key, strip(item, depth + 1)]));
  }
  return value;
}

const refusalResult = (connectionActive: boolean) => ({ content: [{ type: "text", text: nativeWinsRefusalText(connectionActive) }], isError: true });

/** One reply message with Composio HighLevel removed from its tool list or search results. Text that is not JSON and
 * mentions HighLevel, or anything still naming it after the removal, turns the result into the refusal. */
export function stripComposioHighLevel(message: unknown, connectionActive = true): unknown {
  if (Array.isArray(message)) return message.map(item => stripComposioHighLevel(item, connectionActive));
  if (!object(message) || !object(message.result)) return message;
  const result = message.result;
  let refuse = false;
  const next: Record<string, unknown> = { ...result };
  if (Array.isArray(result.tools)) next.tools = result.tools.filter((tool) => !(object(tool) && isComposioHighLevelId(tool.name)));
  if (Array.isArray(result.content)) {
    next.content = result.content.map((item) => {
      if (!object(item) || item.type !== "text" || typeof item.text !== "string") return item;
      let parsed: unknown;
      try { parsed = JSON.parse(item.text); } catch {
        if (/highlevel|leadconnector/i.test(item.text)) refuse = true;
        return item;
      }
      return { ...item, text: JSON.stringify(strip(parsed)) };
    });
  }
  for (const key of Object.keys(next)) if (key !== "content" && key !== "tools") next[key] = strip(next[key]);
  if (Array.isArray(next.tools)) next.tools = strip(next.tools);
  const leftover = (Array.isArray(next.content) ? next.content : []).some((item) => {
    if (!object(item) || typeof item.text !== "string") return mentionsComposioHighLevel(item);
    try { return mentionsComposioHighLevel(JSON.parse(item.text)); } catch { return false; }
  }) || Object.entries(next).some(([key, value]) => key !== "content" && mentionsComposioHighLevel(value));
  if (refuse || leftover) return { ...message, result: refusalResult(connectionActive) };
  return { ...message, result: next };
}

/** The relay's raw answer (JSON or an SSE stream of JSON events) with Composio HighLevel removed. Bytes that are not a
 * readable answer are replaced by the refusal: a native-granted bot is never shown a listing Murage could not read. */
export function stripComposioHighLevelBytes(contentType: string, bytes: Uint8Array, connectionActive = true): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  try {
    if (/^application\/json\b/iu.test(contentType)) {
      const parsed: unknown = JSON.parse(text);
      return encode(Array.isArray(parsed) ? parsed.map((message) => stripComposioHighLevel(message, connectionActive)) : stripComposioHighLevel(parsed, connectionActive));
    }
    if (/^text\/event-stream\b/iu.test(contentType)) {
      const out = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        try { return `data: ${JSON.stringify(stripComposioHighLevel(JSON.parse(line.slice(5)), connectionActive))}`; } catch {
          return `data: ${JSON.stringify({ jsonrpc: "2.0", id: null, result: refusalResult(connectionActive) })}`;
        }
      });
      return new TextEncoder().encode(out.join("\n"));
    }
  } catch { /* not a readable answer */ }
  return encode({ jsonrpc: "2.0", id: null, result: refusalResult(connectionActive) });
}
