// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who may call which native HighLevel tool (GAP-HIGHLEVEL-109 section 7). The order is fixed:
//   1. a live bot whose connected apps are on, and an explicit native grant naming this connection and tool. Generic
//      unrestricted mode supplies no native membership: the native check comes before that shortcut
//      (server/bot-access.ts assertConnectedAppCall returns early for unrestricted bots);
//   2. a browser-confirmed connection (connected or degraded). A pending, reconnecting or disconnected one gives
//      nothing, whatever grants exist;
//   3. draft-only bots run verified reads only, as server/bot-access.ts does for every connected app;
//   4. a change needs the grant's `propose` ceiling, and the generic restricted `allowWrites:false` stays a further
//      ceiling. Every change then goes to exact review (actions.ts); nothing here approves one.
// The grant record is bound to the bot's role: a role change leaves it stale, as server/bot-access-role.ts does for
// generic grants. External relays never discover or run a native name (highlevelRelayRefusal, filterRelayToolList).
import {
  HIGHLEVEL_HELPER_NAMES,
  HIGHLEVEL_TOOL_NAMES,
  highlevelBotAccessSchema,
  isHighLevelWrite,
  isNativeHighLevelName,
  type HighLevelAnyToolName,
  type HighLevelBotAccess,
  type NativeGrant,
} from "../../shared/highlevel.ts";
import { accessRoleBinding, botAccessPolicy, type AccessRole } from "../bot-access-role.ts";
import type { HighLevelConnectionView } from "./client.ts";

export interface HighLevelAccessBot extends AccessRole {
  name?: string;
  draftOnly?: boolean;
  /** The owner-saved native grants (HighLevelBotAccess); anything else grants nothing. */
  highlevelAccess?: unknown;
}

export type HighLevelRefusalCode =
  | "bot_unavailable" | "not_granted" | "choose_connection" | "connection_not_ready" | "draft_only" | "read_only" | "writes_blocked";

export type HighLevelDecision =
  | { ok: true; grant: NativeGrant; connection: HighLevelConnectionView; write: boolean; policyRevision: number; roleBinding: string; accessRevision: number }
  | { ok: false; code: HighLevelRefusalCode; text: string };

export const HIGHLEVEL_DRAFT_ONLY_REFUSAL = "This bot prepares drafts and does not change records. It can read the CRM; give the owner the draft to review.";

/** The bot's native grants as they stand now, or null: unparsable, saved for another role, or for another bot. */
export function nativeAccessFor(bot: HighLevelAccessBot): HighLevelBotAccess | null {
  if (bot.highlevelAccess === undefined) return null;
  const parsed = highlevelBotAccessSchema.safeParse(bot.highlevelAccess);
  if (!parsed.success) return null;
  if (parsed.data.roleBinding !== accessRoleBinding(bot)) return null;
  return { ...parsed.data, grants: parsed.data.grants.filter((grant) => grant.botId === bot.id) };
}

const refused = (code: HighLevelRefusalCode, text: string): Extract<HighLevelDecision, { ok: false }> => ({ ok: false, code, text });
const refuse = (code: HighLevelRefusalCode, text: string): HighLevelDecision => refused(code, text);

/** Which grant a call uses: the named connection, or the only one granting this tool. Never a guess between two. */
export function selectGrant(access: HighLevelBotAccess | null, tool: string, connectionId?: string): NativeGrant | HighLevelRefusalCode {
  const granting = (access?.grants ?? []).filter((grant) => (grant.tools as readonly string[]).includes(tool));
  if (connectionId !== undefined) return granting.find((grant) => grant.accountId === connectionId) ?? "not_granted";
  if (granting.length === 1) return granting[0]!;
  return granting.length === 0 ? "not_granted" : "choose_connection";
}

/** The verdict for one CRM call. Helpers are not CRM calls; see helpersVisible. */
export async function authorizeHighLevelCall(input: {
  /** The bot as stored now; read again after the connection status await so a grant changed meanwhile counts. */
  bot: () => HighLevelAccessBot | undefined;
  tool: string;
  connectionId?: string;
  connection: (connectionId: string) => Promise<HighLevelConnectionView | undefined>;
}): Promise<HighLevelDecision> {
  const { tool } = input;
  const initial = decide(input.bot(), tool, input.connectionId);
  if ("ok" in initial) return initial;
  const connection = await input.connection(initial.grant.accountId);
  // Everything is decided again from the bot as it is after the await.
  const current = decide(input.bot(), tool, input.connectionId);
  if ("ok" in current) return current;
  if (current.grant.accountId !== initial.grant.accountId) return refuse("not_granted", "The bot's HighLevel access changed while this call ran. Run it again.");
  return finish(current, connection, tool);
}

type Selected = { bot: HighLevelAccessBot; grant: NativeGrant; access: HighLevelBotAccess };

function decide(bot: HighLevelAccessBot | undefined, tool: string, connectionId: string | undefined): Selected | Extract<HighLevelDecision, { ok: false }> {
  if (!bot || bot.hidden || bot.composio === false) return refused("bot_unavailable", "Connected apps are off for this bot, so it cannot use HighLevel.");
  if (!(HIGHLEVEL_TOOL_NAMES as readonly string[]).includes(tool)) return refused("not_granted", "This is not a HighLevel CRM tool.");
  const access = nativeAccessFor(bot);
  const selected = selectGrant(access, tool, connectionId);
  if (selected === "choose_connection") return refused("choose_connection", "This bot can use more than one HighLevel location. Call HIGHLEVEL_LIST_CONNECTIONS and pass the connectionId to use.");
  if (typeof selected === "string") return refused("not_granted", "The owner has not given this bot this HighLevel tool for that location. They can add it in the bot's settings.");
  return { bot, grant: selected, access: access! };
}

function finish({ bot, grant: selected, access }: Selected, connection: HighLevelConnectionView | undefined, tool: string): HighLevelDecision {
  if (!connection || connection.connectionId !== selected.accountId || (connection.state !== "connected" && connection.state !== "degraded")) {
    return refuse("connection_not_ready", connection?.state === "pending_browser_confirmation"
      ? "This HighLevel location is still waiting for the owner to confirm it in their browser. Nothing can run until then."
      : "This HighLevel location is not connected right now. The owner can Reconnect it from the HighLevel CRM card.");
  }
  const write = isHighLevelWrite(tool);
  if (write && bot.draftOnly) return refuse("draft_only", HIGHLEVEL_DRAFT_ONLY_REFUSAL);
  if (write && selected.ceiling !== "propose") return refuse("read_only", "The owner lets this bot read this HighLevel location but not propose changes to it.");
  const policy = botAccessPolicy(bot);
  if (write && policy.mode === "restricted" && !policy.allowWrites) return refuse("writes_blocked", "The owner has blocked connected-app changes for this bot.");
  return { ok: true, grant: selected, connection, write, policyRevision: policy.revision, roleBinding: accessRoleBinding(bot), accessRevision: access.revision };
}

/** The tool names tools/list shows: only what a call could be allowed to run. Location readiness is checked per call. */
export function visibleHighLevelTools(bot: HighLevelAccessBot | undefined): HighLevelAnyToolName[] {
  if (!bot || bot.hidden || bot.composio === false) return [];
  const access = nativeAccessFor(bot);
  if (!access || access.grants.length === 0) return [];
  const policy = botAccessPolicy(bot);
  const writesBlocked = bot.draftOnly === true || (policy.mode === "restricted" && !policy.allowWrites);
  const names = new Set<string>();
  for (const grant of access.grants) {
    for (const tool of grant.tools) {
      if (isHighLevelWrite(tool) && (writesBlocked || grant.ceiling !== "propose")) continue;
      names.add(tool);
    }
  }
  if (names.size === 0) return [];
  return [...HIGHLEVEL_TOOL_NAMES.filter((name) => names.has(name)), ...HIGHLEVEL_HELPER_NAMES];
}

// ---- external relays ----------------------------------------------------------------------------------------------------

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const HIGHLEVEL_RELAY_REFUSAL = "HighLevel tools run only through Murage's own HighLevel connection, never through another connected-app relay.";

/** A refusal when a message for an external connected-app relay would run a native HighLevel name, directly or inside
 * a multi-execute batch; null otherwise. */
export function highlevelRelayRefusal(input: unknown): string | null {
  for (const message of Array.isArray(input) ? input : [input]) {
    if (!object(message) || message.method !== "tools/call" || !object(message.params)) continue;
    const params = message.params;
    if (isNativeHighLevelName(params.name)) return HIGHLEVEL_RELAY_REFUSAL;
    const args = object(params.arguments) ? params.arguments : {};
    for (const item of Array.isArray(args.tools) ? args.tools : []) {
      if (object(item) && isNativeHighLevelName(item.tool_slug)) return HIGHLEVEL_RELAY_REFUSAL;
    }
  }
  return null;
}

/** An external relay's tools/list result without native names, so a bot never discovers them there. */
export function filterRelayToolList<T>(result: T): T {
  if (!object(result) || !Array.isArray(result.tools)) return result;
  return { ...result, tools: result.tools.filter((tool) => !(object(tool) && isNativeHighLevelName(tool.name))) } as T;
}

const filterMessage = (message: unknown): unknown => (object(message) && object(message.result) ? { ...message, result: filterRelayToolList(message.result) } : message);

/** The relay's raw tools/list answer (JSON or an SSE stream of JSON events) with native names removed. Bytes that are
 * not a readable answer pass unchanged: they carry no tool list a bot could act on. */
export function filterRelayToolListBytes(contentType: string, bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  try {
    if (/^application\/json\b/iu.test(contentType)) {
      const parsed: unknown = JSON.parse(text);
      return new TextEncoder().encode(JSON.stringify(Array.isArray(parsed) ? parsed.map(filterMessage) : filterMessage(parsed)));
    }
    if (/^text\/event-stream\b/iu.test(contentType)) {
      const out = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        try { return `data: ${JSON.stringify(filterMessage(JSON.parse(line.slice(5))))}`; } catch { return line; }
      });
      return new TextEncoder().encode(out.join("\n"));
    }
  } catch { /* not a readable answer */ }
  return bytes;
}
