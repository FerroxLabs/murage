// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The native HighLevel CRM's fixed names and bot grant shape, shared by the server and the app
// (GAP-HIGHLEVEL-109 sections 5 and 7). The twenty CRM tool names are ported from OpenMausBot
// shared/highlevel.ts; the two helpers are Murage's own.
import { z } from "zod";

/** The toolkit slug a native grant names. */
export const HIGHLEVEL_TOOLKIT = "highlevel";

/** The MCP server name bots see (tools arrive as mcp__highlevel__HIGHLEVEL_<ACTION>). */
export const HIGHLEVEL_MCP_SERVER = "highlevel";

/** The twenty CRM tools. Order is the advertised order. */
export const HIGHLEVEL_TOOL_NAMES = [
  "HIGHLEVEL_SEARCH_CONTACTS",
  "HIGHLEVEL_GET_CONTACT",
  "HIGHLEVEL_CREATE_CONTACT",
  "HIGHLEVEL_UPDATE_CONTACT",
  "HIGHLEVEL_ADD_TAGS",
  "HIGHLEVEL_REMOVE_TAGS",
  "HIGHLEVEL_LIST_NOTES",
  "HIGHLEVEL_ADD_NOTE",
  "HIGHLEVEL_LIST_TASKS",
  "HIGHLEVEL_ADD_TASK",
  "HIGHLEVEL_LIST_PIPELINES",
  "HIGHLEVEL_SEARCH_OPPORTUNITIES",
  "HIGHLEVEL_GET_OPPORTUNITY",
  "HIGHLEVEL_CREATE_OPPORTUNITY",
  "HIGHLEVEL_UPDATE_OPPORTUNITY",
  "HIGHLEVEL_SEARCH_CONVERSATIONS",
  "HIGHLEVEL_READ_CONVERSATION",
  "HIGHLEVEL_LIST_CALENDARS",
  "HIGHLEVEL_LIST_EVENTS",
  "HIGHLEVEL_GET_LOCATION",
] as const;

/** Local helpers: a bot's own grants and its own actions. They read Murage state, never the CRM. */
export const HIGHLEVEL_HELPER_NAMES = ["HIGHLEVEL_LIST_CONNECTIONS", "HIGHLEVEL_ACTION_STATUS"] as const;

export type HighLevelToolName = (typeof HIGHLEVEL_TOOL_NAMES)[number];
export type HighLevelHelperName = (typeof HIGHLEVEL_HELPER_NAMES)[number];
export type HighLevelAnyToolName = HighLevelToolName | HighLevelHelperName;

/** Every reviewed change. Fixed by name, never inferred from a verb: everything else in the twenty only reads. */
export const HIGHLEVEL_WRITE_TOOLS: ReadonlySet<HighLevelToolName> = new Set<HighLevelToolName>([
  "HIGHLEVEL_CREATE_CONTACT",
  "HIGHLEVEL_UPDATE_CONTACT",
  "HIGHLEVEL_ADD_TAGS",
  "HIGHLEVEL_REMOVE_TAGS",
  "HIGHLEVEL_ADD_NOTE",
  "HIGHLEVEL_ADD_TASK",
  "HIGHLEVEL_CREATE_OPPORTUNITY",
  "HIGHLEVEL_UPDATE_OPPORTUNITY",
]);

export function isHighLevelToolName(name: unknown): name is HighLevelToolName {
  return typeof name === "string" && (HIGHLEVEL_TOOL_NAMES as readonly string[]).includes(name);
}

export function isHighLevelHelperName(name: unknown): name is HighLevelHelperName {
  return typeof name === "string" && (HIGHLEVEL_HELPER_NAMES as readonly string[]).includes(name);
}

/** Any native name, helpers included. External relays must never discover or run one of these. */
export function isNativeHighLevelName(name: unknown): name is HighLevelAnyToolName {
  return isHighLevelToolName(name) || isHighLevelHelperName(name);
}

export function isHighLevelWrite(name: string): boolean {
  return HIGHLEVEL_WRITE_TOOLS.has(name as HighLevelToolName);
}

const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
/** A native connection's account id: "hl_" plus an opaque id (section 5, LocationConnection). */
export const highlevelAccountIdSchema = z.string().min(4).max(180).regex(/^hl_[A-Za-z0-9_-]+$/);

/** read: verified reads only. propose: reads, plus changes the owner approves one by one. There is no third level. */
export const HIGHLEVEL_CEILINGS = ["read", "propose"] as const;
export type HighLevelCeiling = (typeof HIGHLEVEL_CEILINGS)[number];

/** One bot's access to one connection: the existing grant shape plus bot, revision and ceiling. */
export const nativeGrantSchema = z.object({
  toolkit: z.literal(HIGHLEVEL_TOOLKIT),
  accountId: highlevelAccountIdSchema,
  tools: z.array(z.enum(HIGHLEVEL_TOOL_NAMES)).min(1).max(HIGHLEVEL_TOOL_NAMES.length),
  botId: identifier,
  revision: z.number().int().nonnegative(),
  ceiling: z.enum(HIGHLEVEL_CEILINGS),
}).strict();
export type NativeGrant = z.infer<typeof nativeGrantSchema>;

/** A bot's native grants as one record. roleBinding is accessRoleBinding(bot) when the owner saved them: a role
 * change leaves the record stale, so it grants nothing until the owner saves again (server/bot-access-role.ts). */
export const highlevelBotAccessSchema = z.object({
  revision: z.number().int().nonnegative(),
  roleBinding: z.string().min(1).max(128),
  grants: z.array(nativeGrantSchema).max(50),
}).strict();
export type HighLevelBotAccess = z.infer<typeof highlevelBotAccessSchema>;
