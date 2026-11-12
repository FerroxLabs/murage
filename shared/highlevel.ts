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

/** The twelve tools that only read. HL-S2 ships these alone (MurageMain 11-04): no change tool is ever listed, mounted,
 * pre-allowed or granted. Changes are row HL-S2-WRITES-DESIGN. */
export const HIGHLEVEL_READ_TOOL_NAMES: readonly HighLevelToolName[] = HIGHLEVEL_TOOL_NAMES.filter((name) => !HIGHLEVEL_WRITE_TOOLS.has(name));

// Frozen S0 contract with C1 grant implementations.
export const HIGHLEVEL_FAMILIES = ["contacts", "opportunities", "conversations", "calendars", "automations", "location", "users", "forms", "payments", "social", "funnels", "blogs", "courses", "media", "documents", "saas", "snapshots"] as const;
export type Family = typeof HIGHLEVEL_FAMILIES[number];
export type Risk = "R" | "C" | "D";
export type FamilyLevel = "off" | "read" | "change" | "full";
export type OperationId = `${Family}.${string}`;
export const HIGHLEVEL_FAMILY_TOOLS = Object.fromEntries(HIGHLEVEL_FAMILIES.map((family) => [family, `HIGHLEVEL_${family.toUpperCase()}`])) as Readonly<Record<Family, `HIGHLEVEL_${Uppercase<string>}`>>;
export const HIGHLEVEL_ITEM_FAILED = "HighLevel step did not finish. The note below says what happened.";

export function levelCovers(level: FamilyLevel, risk: Risk): boolean {
  return ["R", "C", "D"].includes(risk) && (level === "full" || (level === "change" && (risk === "R" || risk === "C")) || (level === "read" && risk === "R"));
}
export function defaultHighLevelFamilies(): Record<Family, FamilyLevel> {
  return Object.fromEntries(HIGHLEVEL_FAMILIES.map((family) => [family, ["users", "payments", "saas", "snapshots"].includes(family) ? "off" : "read"])) as Record<Family, FamilyLevel>;
}
export function highlevelToolTitle(name: unknown, _operation?: unknown): string {
  // S0's fixed family title never echoes a caller's operation or arguments.
  const family = HIGHLEVEL_FAMILIES.find((family) => HIGHLEVEL_FAMILY_TOOLS[family] === name || `mcp__highlevel__${HIGHLEVEL_FAMILY_TOOLS[family]}` === name);
  return family ? `HighLevel: ${family}` : "HighLevel";
}
export const highlevelFamiliesSchema = z.object(Object.fromEntries(HIGHLEVEL_FAMILIES.map((family) => [family, z.enum(["off", "read", "change", "full"])])) as Record<Family, z.ZodEnum<{ off: "off"; read: "read"; change: "change"; full: "full" }>>).strict();
const operationIdSchema = z.string().max(180).refine((value): value is OperationId => {
  const [family, ...parts] = value.split(".");
  return (HIGHLEVEL_FAMILIES as readonly string[]).includes(family!) && parts.length > 0 && parts.every((part) => /^[A-Za-z][A-Za-z0-9]*$/.test(part));
}).transform((value) => value as OperationId);

// Frozen F0 authority contract.
export interface EffectiveGrant {
  accountId: string; botId: string; revision: number; ceiling: HighLevelCeiling;
  families: Readonly<Record<Family, FamilyLevel>>;
  operations: Readonly<Partial<Record<Family, readonly OperationId[]>>>;
  legacy: boolean;
}
export interface EffectiveHighLevelAccess {
  grantsVersion: 2; synthesized: boolean; revision: number; roleBinding: string;
  grants: readonly EffectiveGrant[]; denyRules: readonly string[];
}
const familyOperationsSchema = z.object(Object.fromEntries(HIGHLEVEL_FAMILIES.map(family => [family,
  z.array(operationIdSchema).max(1000).refine(ops => ops.every(op => op.startsWith(family + "."))).optional(),
])) as Record<Family, z.ZodOptional<z.ZodArray<typeof operationIdSchema>>>).strict();
export const highlevelDenyRulesSchema = z.array(z.string().refine(rule => {
  if ((Object.values(HIGHLEVEL_FAMILY_TOOLS) as readonly string[]).includes(rule)) return true;
  if (["HIGHLEVEL:R", "HIGHLEVEL:C", "HIGHLEVEL:D", "HIGHLEVEL:SEND", "HIGHLEVEL:S"].includes(rule)) return true;
  return rule.startsWith("HIGHLEVEL:") && operationIdSchema.safeParse(rule.slice(10)).success;
})).max(64).transform(rules => [...new Set(rules.map(rule => rule === "HIGHLEVEL:S" ? "HIGHLEVEL:SEND" : rule))]);
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
/** A native connection's account id: "hl_" plus an opaque id (section 5, LocationConnection). */
export const highlevelAccountIdSchema = z.string().min(4).max(180).regex(/^hl_[A-Za-z0-9_-]+$/);

/** Compatibility ceiling for old readers. V2 family levels and host approval policy decide each operation. */
export const HIGHLEVEL_CEILINGS = ["read", "propose"] as const;
export type HighLevelCeiling = (typeof HIGHLEVEL_CEILINGS)[number];

/** One bot's access to one connection: the existing grant shape plus bot, revision and ceiling. */
export const nativeGrantSchema = z.object({
  toolkit: z.literal(HIGHLEVEL_TOOLKIT),
  accountId: highlevelAccountIdSchema,
  // Compatibility names only. Family dispatch uses families/operations, never this projection.
  tools: z.array(z.enum(HIGHLEVEL_TOOL_NAMES)).max(HIGHLEVEL_TOOL_NAMES.length),
  families: highlevelFamiliesSchema.optional(),
  operations: z.union([familyOperationsSchema, z.array(operationIdSchema).max(1000)]).optional(),
  botId: identifier,
  revision: z.number().int().nonnegative(),
  ceiling: z.enum(HIGHLEVEL_CEILINGS),
}).strict().refine((grant) => grant.tools.length > 0 || grant.families !== undefined);
export type NativeGrant = z.infer<typeof nativeGrantSchema>;

/** A bot's native grants as one record. roleBinding is accessRoleBinding(bot) when the owner saved them: a role
 * change leaves the record stale, so it grants nothing until the owner saves again (server/bot-access-role.ts). */
export const highlevelBotAccessSchema = z.object({
  grantsVersion: z.literal(2).optional(),
  denyRules: highlevelDenyRulesSchema.optional(),
  revision: z.number().int().nonnegative(),
  roleBinding: z.string().min(1).max(128),
  grants: z.array(nativeGrantSchema).max(50),
}).strict();
export type HighLevelBotAccess = z.infer<typeof highlevelBotAccessSchema>;

const effectiveGrantSchema = z.object({
  accountId: highlevelAccountIdSchema, botId: identifier, revision: z.number().int().nonnegative(),
  ceiling: z.enum(HIGHLEVEL_CEILINGS), families: highlevelFamiliesSchema, operations: familyOperationsSchema, legacy: z.boolean(),
}).strict();
const effectiveAccessSchema = z.object({ grantsVersion: z.literal(2), synthesized: z.boolean(), revision: z.number().int().nonnegative(),
  roleBinding: z.string().min(1).max(128), grants: z.array(effectiveGrantSchema).max(50), denyRules: highlevelDenyRulesSchema,
}).strict();

/** Role and bot validation precede synthesis. Normalizing an already-effective
 * record is idempotent, so runtime and nativeAccessFor can both check authority. */
export function effectiveHighLevelAccess(value: unknown, bot: { id: string; roleBinding: string }): EffectiveHighLevelAccess | null {
  if (!bot) return null;
  const normalized = effectiveAccessSchema.safeParse(value);
  if (normalized.success) {
    if (normalized.data.roleBinding !== bot.roleBinding) return null;
    return { ...normalized.data, grants: normalized.data.grants.filter(grant => grant.botId === bot.id) };
  }
  const parsed = highlevelBotAccessSchema.safeParse(value);
  if (!parsed.success || parsed.data.roleBinding !== bot.roleBinding) return null;
  const legacy = parsed.data.grantsVersion !== 2;
  const grants: EffectiveGrant[] = [];
  for (const grant of parsed.data.grants.filter(grant => grant.botId === bot.id)) {
    const families = { ...Object.fromEntries(HIGHLEVEL_FAMILIES.map(f => [f, "off"])) } as Record<Family, FamilyLevel>;
    const operations: Partial<Record<Family, OperationId[]>> = {};
    if (legacy) {
      for (const tool of grant.tools.filter(tool => !HIGHLEVEL_WRITE_TOOLS.has(tool))) {
        const op = LEGACY_TOOL_TO_OPERATION[tool]!; const family = op.split(".")[0] as Family;
        families[family] = "read"; (operations[family] ??= []).push(op);
      }
    } else {
      if (!grant.families) continue;
      Object.assign(families, grant.families);
      if (Array.isArray(grant.operations)) {
        // Earlier C1 development rows used one global allowlist: preserve its exact ceiling.
        for (const family of HIGHLEVEL_FAMILIES) operations[family] = grant.operations.filter(op => op.startsWith(family + "."));
      } else Object.assign(operations, grant.operations ?? {});
    }
    if (!HIGHLEVEL_FAMILIES.some(f => families[f] !== "off" && (operations[f] === undefined || operations[f]!.length > 0))) continue;
    grants.push({ accountId: grant.accountId, botId: grant.botId, revision: grant.revision, ceiling: grant.ceiling, families, operations, legacy });
  }
  return { grantsVersion: 2, synthesized: legacy, revision: parsed.data.revision, roleBinding: parsed.data.roleBinding, grants, denyRules: parsed.data.denyRules ?? [] };
}

export function operationAllowed(grant: EffectiveGrant, op: OperationId, risk: Risk): boolean {
  const family = op.split(".")[0] as Family;
  return HIGHLEVEL_FAMILIES.includes(family) && levelCovers(grant.families[family], risk) &&
    (grant.operations[family] === undefined || grant.operations[family]!.includes(op));
}
export function highlevelDenyMatch(rules: readonly string[], op: OperationId, risk: Risk): boolean {
  const family = op.split(".")[0] as Family;
  return rules.some(rule => rule === HIGHLEVEL_FAMILY_TOOLS[family] || rule === `HIGHLEVEL:${op}` || rule === `HIGHLEVEL:${risk}` ||
    ((rule === "HIGHLEVEL:SEND" || rule === "HIGHLEVEL:S") && /^conversations\.send\./.test(op)));
}

export const highlevelDenyRuleSchema = z.string().max(240).refine(value =>
  /^HIGHLEVEL:(?:R|C|D|SEND|S)$/.test(value)
  || HIGHLEVEL_FAMILIES.some(f => value === HIGHLEVEL_FAMILY_TOOLS[f] || new RegExp(`^HIGHLEVEL:${f}\\.[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*)*$`).test(value)));
export const workspaceFileRefSchema: z.ZodType<{ workspaceFile: string }> = z.strictObject({
  workspaceFile: z.string().min(1).max(512).refine(value => {
    const parts = value.split("/");
    return parts.length <= 32 && parts.every(p => p.length > 0 && p.length <= 255 && p !== "." && p !== ".."
      && !/[\\:\0\r\n]/u.test(p) && !/[. ]$/u.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p));
  }),
});

export const LEGACY_TOOL_TO_OPERATION: Readonly<Record<string, OperationId>> = {
  "HIGHLEVEL_SEARCH_CONTACTS": "contacts.search",
  "HIGHLEVEL_GET_CONTACT": "contacts.get",
  "HIGHLEVEL_CREATE_CONTACT": "contacts.create",
  "HIGHLEVEL_UPDATE_CONTACT": "contacts.update",
  "HIGHLEVEL_ADD_TAGS": "contacts.tags.add",
  "HIGHLEVEL_REMOVE_TAGS": "contacts.tags.remove",
  "HIGHLEVEL_LIST_NOTES": "contacts.notes.list",
  "HIGHLEVEL_ADD_NOTE": "contacts.notes.create",
  "HIGHLEVEL_LIST_TASKS": "contacts.tasks.list",
  "HIGHLEVEL_ADD_TASK": "contacts.tasks.create",
  "HIGHLEVEL_LIST_PIPELINES": "opportunities.pipelines.list",
  "HIGHLEVEL_SEARCH_OPPORTUNITIES": "opportunities.search",
  "HIGHLEVEL_GET_OPPORTUNITY": "opportunities.get",
  "HIGHLEVEL_CREATE_OPPORTUNITY": "opportunities.create",
  "HIGHLEVEL_UPDATE_OPPORTUNITY": "opportunities.update",
  "HIGHLEVEL_SEARCH_CONVERSATIONS": "conversations.search",
  "HIGHLEVEL_READ_CONVERSATION": "conversations.messages.list",
  "HIGHLEVEL_LIST_CALENDARS": "calendars.list",
  "HIGHLEVEL_LIST_EVENTS": "calendars.events.list",
  "HIGHLEVEL_GET_LOCATION": "location.get",
};
