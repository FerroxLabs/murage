import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CONNECTED_APP_TOOLS, ACCESS_LEVELS, connectedAppLevelsSchema, connectedAppDecisionsSchema, withAccountTools, type AccessGrant, type AccessLevel, type ConnectedAppAccess, type ConnectedAppDecision, type ConnectedAppLevels, type LevelCap, type LevelEntry } from "../shared/bot-access.ts";
import { VERIFIED_READ_TOOLS } from "../shared/connected-app-read-tools.ts";
import { isConnectedAppStatusTool } from "../shared/connected-app-calls.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import type { InventoryServices } from "./connected-inventory.ts";
import { RosterPostCommitError, type BotRecord, type Store } from "./store.ts";
// AG0 r4 (designs/1021-ag0/DESIGN-r4.md) per-app levels: storage fence (4.1-4.2), the
// legacy projection (4.4), the one writer (4.5), admission (5.1), the levels relay path
// (5.2, fact 1) and the owner actions set-account / set-switches / clear-floor (7).
// Legacy bots (no levels record, or a record the fence rejects) never reach this module's
// verdicts: server/bot-access.ts keeps today's code for them byte for byte.

/** Reviewed (toolkit, slug) pairs proven by W28 to run on exactly the named account.
 * Empty until qualification runs: every row on a gated toolkit is refused (fact 1). */
const QUALIFIED = new Set<string>();
export const EXACT_ACCOUNT_QUALIFIED: ReadonlySet<string> = QUALIFIED;
const pair = (toolkit: string, slug: string) => toolkit + "\0" + slug;
/** Tests only: stand in for W28 results. Refused outside vitest; returns the undo. */
export function qualifyForTesting(pairs: ReadonlyArray<{ toolkit: string; slug: string }>): () => void {
  if (!process.env.VITEST) throw new Error("qualifyForTesting is for tests only");
  const added = pairs.map((item) => pair(item.toolkit, item.slug.toUpperCase())).filter((key) => !QUALIFIED.has(key));
  for (const key of added) QUALIFIED.add(key);
  return () => { for (const key of added) QUALIFIED.delete(key); };
}
const RANK: Record<AccessLevel, number> = { none: 0, read: 1, full: 2 };
type Holder = BotRecord & { connectedAppLevels?: unknown; connectedAppDecisions?: unknown };
type Admission = { tools: "any" | ReadonlySet<string>; change: boolean };
export type Levels = ConnectedAppLevels;

function fail(message: string, status = 403, extra: Record<string, unknown> = {}): never { throw Object.assign(new Error(message), { status, ...extra }); }

// ---- Slug ownership (fact 1 rule 3): only Murage's reviewed lists, never a name split.
const OWNER = new Map<string, string | null>();
const READS = new Map<string, Set<string>>();
const CHANGES = new Map<string, Set<string>>();
for (const entry of [...CONNECTED_APP_TOOLS.map((tool) => ({ toolkit: tool.toolkit, tool: tool.tool, read: !tool.writes })), ...VERIFIED_READ_TOOLS.map((tool) => ({ toolkit: tool.toolkit, tool: tool.tool, read: true }))]) {
  const slug = entry.tool.toUpperCase();
  const known = OWNER.get(slug);
  OWNER.set(slug, known === undefined || known === entry.toolkit ? entry.toolkit : null);
  const into = entry.read ? READS : CHANGES;
  if (!into.has(entry.toolkit)) into.set(entry.toolkit, new Set());
  into.get(entry.toolkit)!.add(slug);
}
// A slug reviewed as a read anywhere is a read; a catalog write is a change.
for (const [toolkit, slugs] of CHANGES) for (const slug of slugs) if (READS.get(toolkit)?.has(slug)) slugs.delete(slug);
/** The toolkit that owns `slug` by the reviewed lists, or null (unknown or claimed by two). */
export function slugToolkit(slug: string): string | null { return OWNER.get(slug.toUpperCase()) ?? null; }
export function isReadSlug(toolkit: string, slug: string): boolean { return !!READS.get(toolkit)?.has(slug.toUpperCase()); }
export function readSlugs(toolkit: string): readonly string[] { return [...(READS.get(toolkit) ?? [])].sort(); }
/** Catalog and reviewed operations of a toolkit, each with whether it changes something. */
function knownOps(toolkit: string): Array<{ slug: string; change: boolean }> {
  return [...[...(READS.get(toolkit) ?? [])].map((slug) => ({ slug, change: false })), ...[...(CHANGES.get(toolkit) ?? [])].map((slug) => ({ slug, change: true }))];
}

// ---- 4.2 The fence: one predicate decides which rule applies.
export function levelsOf(bot: BotRecord): Levels | null {
  const raw = (bot as Holder).connectedAppLevels;
  if (raw === undefined) return null;
  const parsed = connectedAppLevelsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const policy = botAccessPolicy(bot);
  return policy.revision >= 1 && parsed.data.atRevision === policy.revision && parsed.data.roleBinding === policy.roleBinding ? parsed.data : null;
}
export function decisionsOf(bot: BotRecord): ConnectedAppDecision[] {
  const parsed = connectedAppDecisionsSchema.safeParse((bot as Holder).connectedAppDecisions);
  return parsed.success ? parsed.data : [];
}

// ---- 8.1 Seed from the legacy record (never wider, never narrower than today).
export function seedLevels(bot: BotRecord): Levels {
  const policy = botAccessPolicy(bot);
  const base = { v: 1 as const, atRevision: Math.max(1, policy.revision), roleBinding: policy.roleBinding };
  if (policy.mode === "unrestricted") {
    // An unrestricted record ignores its stored write switch (bot-access.ts legacy path); so does the seed.
    return { ...base, newAccounts: "all", allowWrites: true, accounts: [] };
  }
  const union = new Map<string, { toolkit: string; accountId: string; tools: Set<string> }>();
  for (const grant of policy.grants) {
    const key = grant.toolkit + "\0" + grant.accountId;
    if (!union.has(key)) union.set(key, { toolkit: grant.toolkit, accountId: grant.accountId, tools: new Set() });
    for (const tool of grant.tools) union.get(key)!.tools.add(tool);
  }
  const accounts: LevelEntry[] = [...union.values()].map(({ toolkit, accountId, tools }) => {
    const sorted = [...tools].sort();
    const writes = sorted.some((tool) => CONNECTED_APP_TOOLS.some((known) => known.toolkit === toolkit && known.tool === tool && known.writes));
    return { toolkit, accountId, level: writes ? "full" : "read", tools: sorted.slice(0, 30) };
  });
  return { ...base, newAccounts: "none", allowWrites: policy.allowWrites, accounts };
}

// ---- 5.1 Admission, the one evaluation.
function intersect(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (!a) return b && [...b]; if (!b) return [...a];
  return a.filter((tool) => b.includes(tool));
}
/** min of two caps (4.7 r4): lower level, tool lists intersected; empty or read-without-a-read is canonical No access. */
export function minCap(toolkit: string, a: LevelCap, b: LevelCap): LevelCap {
  const level = RANK[a.level] <= RANK[b.level] ? a.level : b.level;
  if (level === "none") return { level: "none" };
  let tools = intersect(a.tools, b.tools);
  if (level === "read" && tools) tools = tools.filter((tool) => isReadSlug(toolkit, tool));
  if (tools && !tools.length) return { level: "none" };
  if (level === "read" && !tools && !readSlugs(toolkit).length) return { level: "none" };
  return tools ? { level, tools: [...new Set(tools)].sort() } : { level };
}
function defaultCap(levels: Levels): LevelCap { return levels.newAccounts === "all" ? { level: "full" } : { level: "none" }; }
/** The saved choice that governs one account: its entry, else the app's Reconnect floor, else the default. */
export function capFor(levels: Levels, toolkit: string, accountId: string): LevelCap {
  const entry = levels.accounts.find((item) => item.toolkit === toolkit && item.accountId === accountId);
  if (entry) return entry.tools ? { level: entry.level, tools: entry.tools } : { level: entry.level };
  const floor = levels.newAccountFloors?.find((item) => item.toolkit === toolkit);
  if (floor && !floor.accountKey.includes(accountId) && !floor.applied.includes(accountId)) return minCap(toolkit, floor.cap, defaultCap(levels));
  return defaultCap(levels);
}
export function admission(levels: Levels, toolkit: string, accountId: string): Admission {
  const cap = capFor(levels, toolkit, accountId);
  if (cap.level === "none") return { tools: new Set(), change: false };
  const reads = readSlugs(toolkit);
  if (cap.level === "read") return { tools: new Set(cap.tools ? cap.tools.filter((tool) => reads.includes(tool.toUpperCase())) : reads), change: false };
  if (!levels.allowWrites) return { tools: new Set(cap.tools ? cap.tools.filter((tool) => reads.includes(tool.toUpperCase())) : reads), change: false };
  return { tools: cap.tools ? new Set(cap.tools) : "any", change: true };
}
/** Is one operation admitted? The slug must belong to the toolkit by the reviewed lists. */
export function admits(levels: Levels, toolkit: string, accountId: string, slug: string): boolean {
  const upper = slug.toUpperCase();
  if (slugToolkit(upper) !== toolkit) return false;
  const granted = admission(levels, toolkit, accountId);
  const change = !isReadSlug(toolkit, upper);
  return (granted.tools === "any" || granted.tools.has(upper)) && (!change || granted.change);
}
/** Fully open (4.4): Every app, writes on, no narrowing entry and no floor. */
export function fullyOpen(levels: Levels): boolean {
  return levels.newAccounts === "all" && levels.allowWrites && !(levels.newAccountFloors?.length) && levels.accounts.every((entry) => entry.level === "full" && !entry.tools);
}
export function effectiveLevel(levels: Levels, toolkit: string, accountId: string): AccessLevel {
  const granted = admission(levels, toolkit, accountId);
  if (granted.change) return "full";
  return granted.tools === "any" || granted.tools.size ? "read" : "none";
}
/** Exact-account gate (fact 1, r4): the stored choices can admit two accounts of the app differently. */
export function gated(levels: Levels, toolkit: string): boolean {
  return levels.newAccounts === "none" || levels.accounts.some((entry) => entry.toolkit === toolkit) || !!levels.newAccountFloors?.some((floor) => floor.toolkit === toolkit);
}
export type AppAccess = { rule: "legacy"; kind: "open" | "limited"; onlyChosen: boolean } | { rule: "levels"; kind: "open" | "limited"; onlyChosen: boolean; levels: Levels };
export function appAccessFor(bot: BotRecord): AppAccess {
  const levels = levelsOf(bot);
  if (!levels) { const policy = botAccessPolicy(bot); return { rule: "legacy", kind: policy.mode === "unrestricted" ? "open" : "limited", onlyChosen: policy.mode === "restricted" }; }
  return { rule: "levels", kind: fullyOpen(levels) ? "open" : "limited", onlyChosen: levels.newAccounts === "none", levels };
}

// ---- Fact 1 rules 1-2: the account names one ACTIVE ID filed under exactly one toolkit.
export function accountToolkit(inventory: InventoryServices, accountId: string): { toolkit: string } | { refused: string } {
  const homes = Object.entries(inventory).filter(([, service]) => service.accounts.some((account) => account.id === accountId));
  if (homes.length > 1) return { refused: "Murage can't tell which app this account belongs to." };
  const home = homes[0];
  if (!home || home[1].accounts.find((account) => account.id === accountId)!.status.toUpperCase() !== "ACTIVE") return { refused: "That account is not connected." };
  return { toolkit: home[0] };
}

// ---- 5.2 The explicit path for a limited levels bot.
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const requestMeta = z.object({ progressToken: z.union([z.string().max(256), z.number().int().safe()]).optional() }).strict();
const EXECUTE_FIELDS = ["tools", "thought", "sync_response_to_workbench", "current_step", "current_step_metric", "session_id"];
/** One row's verdict, in check order (5.2): app and account, admission, then the gate. */
function assertLevelsRow(levels: Levels, inventory: InventoryServices, row: { tool_slug: string; account: string }): void {
  const home = accountToolkit(inventory, row.account);
  if ("refused" in home) fail(home.refused);
  const toolkit = (home as { toolkit: string }).toolkit;
  const owner = slugToolkit(row.tool_slug);
  if (owner !== toolkit) fail("Murage can't tell which app this is for. Murage can only use the operations it knows for this app.");
  const cap = capFor(levels, toolkit, row.account);
  if (cap.level === "none") fail("This bot has no access to this account.");
  const change = !isReadSlug(toolkit, row.tool_slug);
  if (change && cap.level === "read") fail("This account is set to Read only for this bot.");
  if (change && !levels.allowWrites) fail("The owner has turned off sending, creating and deleting for this bot.");
  if (!admits(levels, toolkit, row.account, row.tool_slug)) fail("This operation is not in the list the owner chose for this account.");
  if (gated(levels, toolkit) && !EXACT_ACCOUNT_QUALIFIED.has(pair(toolkit, row.tool_slug.toUpperCase()))) fail(`Murage hasn't yet checked that ${toolkit} runs each request on the account it names, so it didn't run.`);
}
/** Called by assertConnectedAppCall after the off, No limits and draft-only checks. */
export function assertLevelsCall(_bot: BotRecord, levels: Levels, input: unknown, inventory: InventoryServices | null | undefined, forbidden: (args: Record<string, unknown>, toolkit: string) => boolean): void {
  if (fullyOpen(levels)) return;
  if (!object(input)) fail("Restricted connected-app access requires one explicit tool request.");
  const message = input as Record<string, unknown>;
  if (["initialize", "notifications/initialized", "initialized", "tools/list", "ping"].includes(String(message.method))) return;
  if (message.method !== "tools/call" || !object(message.params)) fail("This connected-app operation is not allowed by the owner's choices.");
  const params = message.params as Record<string, unknown>;
  if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key)) || params._meta !== undefined && !requestMeta.safeParse(params._meta).success) fail("Unsupported connected-app request fields.");
  // Collecting the outcome of this bot's own earlier action runs nothing new; its result is checked at delivery (6.4).
  if (isConnectedAppStatusTool(String(params.name ?? ""))) return;
  if (params.name !== "COMPOSIO_MULTI_EXECUTE_TOOL" || !object(params.arguments)) fail("This bot can only run the app operations its owner chose. Dynamic, workbench and connection tools are blocked.");
  const args = params.arguments as Record<string, unknown>;
  if (Object.keys(args).some((key) => !EXECUTE_FIELDS.includes(key))) fail("Unsupported connected-app execution fields.");
  if (args.sync_response_to_workbench !== undefined && args.sync_response_to_workbench !== false) fail("Workbench execution is unavailable for this bot.");
  if (!Array.isArray(args.tools) || !args.tools.length || args.tools.length > 50) fail("Choose at least one connected-app tool.");
  if (!inventory) fail("Connected apps are still loading. Try again in a moment.");
  // One refused row refuses the whole call before dispatch.
  for (const item of args.tools as unknown[]) {
    if (!object(item) || typeof item.tool_slug !== "string" || !object(item.arguments)) fail("Each tool needs its name, the account ID and arguments.");
    if (Object.keys(item as Record<string, unknown>).some((key) => !["tool_slug", "account", "arguments"].includes(key))) fail("Unsupported connected-app tool fields.");
    if (typeof item.account !== "string" || !item.account) fail("Name the account by its ID; the tool list shows them.");
    const row = item as { tool_slug: string; account: string; arguments: Record<string, unknown> };
    assertLevelsRow(levels, inventory!, row);
    if (forbidden(row.arguments, slugToolkit(row.tool_slug)!)) fail("Tool arguments cannot override the approved connected account.");
  }
}
/** 6.4 stored results: every requirement names an ID still ACTIVE and admitted now. */
export function assertLevelsStored(levels: Levels, used: { requirements: ReadonlyArray<{ tool: string; account?: string }>; complete: boolean }, inventory: InventoryServices | null | undefined): void {
  if (fullyOpen(levels)) return;
  if (!used.complete || !used.requirements.length) fail("This stored result cannot be matched to approved tools for this bot.");
  if (!inventory) fail("Couldn't check this app's connection just now. Ask again in a moment.");
  for (const call of used.requirements) {
    if (!call.account) fail("This stored result cannot be matched to approved tools for this bot.");
    assertLevelsRow(levels, inventory!, { tool_slug: call.tool, account: call.account! });
  }
}

// ---- 4.4 Legacy projection: what an older build enforces. Never wider than the levels.
function entryGrantTools(entry: LevelEntry): string[] {
  if (entry.level === "none") return [];
  const catalog = CONNECTED_APP_TOOLS.filter((tool) => tool.toolkit === entry.toolkit && (entry.level === "full" || !tool.writes)).map((tool) => tool.tool as string);
  return entry.tools ? catalog.filter((tool) => entry.tools!.includes(tool)) : catalog;
}
export function legacyProjection(previous: ConnectedAppAccess, previousWasOpen: boolean, levels: Levels, changed: { toolkit: string; accountId: string } | null): Pick<ConnectedAppAccess, "mode" | "allowWrites" | "grants"> {
  if (fullyOpen(levels)) return { mode: "unrestricted", allowWrites: true, grants: [] };
  let grants: AccessGrant[];
  if (previousWasOpen) grants = levels.accounts.reduce<AccessGrant[]>((rows, entry) => withAccountTools(rows, entry, entryGrantTools(entry)), []);
  else {
    grants = previous.grants.map((grant) => ({ ...grant, tools: [...grant.tools] }));
    if (changed) {
      const entry = levels.accounts.find((item) => item.toolkit === changed.toolkit && item.accountId === changed.accountId);
      // No entry: the account follows the default, and the Every app default gets no grant.
      grants = withAccountTools(grants, changed, entry ? entryGrantTools(entry) : []);
    }
  }
  // Never wider than the levels: a kept row loses every tool the levels no longer admit (rows still admitted stay byte-identical).
  grants = grants.flatMap((grant) => {
    const tools = grant.tools.filter((tool) => admits(levels, grant.toolkit, grant.accountId, tool));
    return tools.length === grant.tools.length ? [grant] : tools.length ? [{ ...grant, tools }] : [];
  });
  return { mode: "restricted", allowWrites: levels.allowWrites, grants: grants.slice(0, 30) };
}

// ---- 4.5 The one writer of connectedAppAccess / connectedAppLevels / connectedAppDecisions.
/** "carry" re-stamps the current levels at the new revision; null deletes them. Returns
 * whether the write committed (a RosterPostCommitError is a committed write). */
export function commitAccess(store: Store, bot: BotRecord, legacyNext: ConnectedAppAccess, levels: Levels | null | "carry", decision?: ConnectedAppDecision, extra: Partial<BotRecord> = {}): void {
  const current = levelsOf(bot);
  const nextLevels = levels === "carry" ? (current ? { ...current, atRevision: legacyNext.revision, roleBinding: legacyNext.roleBinding } : undefined) : levels ?? undefined;
  const decisions = decision ? [...decisionsOf(bot).filter((item) => item.requestId !== decision.requestId), decision].slice(-24) : undefined;
  const patch = { ...extra, connectedAppAccess: legacyNext, connectedAppLevels: nextLevels, ...(decisions ? { connectedAppDecisions: decisions } : {}) } as Partial<BotRecord>;
  // One patchBot, one atomic bots.json write. A RosterPostCommitError propagates: each caller decides (legacy writers keep today's handling).
  store.patchBot(bot.id, patch);
}

// ---- 7 Owner actions.
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
const rev = z.number().int().nonnegative();
const switches = z.object({ newAccounts: z.enum(["none", "all"]), allowWrites: z.boolean() }).strict();
const entryShape = z.object({ level: z.enum(ACCESS_LEVELS), tools: z.array(identifier).min(1).max(30).optional() }).strict();
export const levelsAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-account"), revision: rev, base: switches.extend({ entry: entryShape.nullable() }).strict(), toolkit: identifier, accountId: identifier, level: z.enum(ACCESS_LEVELS), tools: z.array(identifier).min(1).max(30).optional() }).strict(),
  z.object({ action: z.literal("set-switches"), revision: rev, base: switches, newAccounts: z.enum(["none", "all"]).optional(), allowWrites: z.boolean().optional(), keepCurrent: z.literal(true).optional(), except: z.array(z.object({ toolkit: identifier, accountId: identifier }).strict()).max(20).optional() }).strict(),
  z.object({ action: z.literal("clear-floor"), revision: rev, toolkit: identifier }).strict(),
]);
export type LevelsAction = z.infer<typeof levelsAction>;
export function isLevelsAction(input: unknown): boolean { return object(input) && ["set-account", "set-switches", "clear-floor"].includes(String(input.action)); }
export type SettledRead = () => Promise<{ services: InventoryServices; settled: boolean; complete: boolean }>;
/** Rows written by the levels actions; only these may be dropped at the 64-row cap. */
const LEVELS_DENIAL = "lv-";
type Denial = NonNullable<ConnectedAppAccess["denials"]>[number];
const UNFINISHED = new Set(["INITIATED", "INITIALIZING", "PENDING"]);
const sameEntry = (a: { level: string; tools?: readonly string[] } | null, b: { level: string; tools?: readonly string[] } | null) => JSON.stringify(a && { level: a.level, tools: a.tools ?? null }) === JSON.stringify(b && { level: b.level, tools: b.tools ?? null });

/** Reviewed slugs admitted for one account (the only slugs the relay can pass, fact 1 rule 3). */
export function admittedKnownSlugs(levels: Levels, toolkit: string, accountId: string): string[] {
  return knownOps(toolkit).filter((op) => admits(levels, toolkit, accountId, op.slug)).map((op) => op.slug).sort();
}
/** Known operations admitted for one account. */
function admittedOps(levels: Levels, toolkit: string, accountId: string): Set<string> {
  return new Set(knownOps(toolkit).filter((op) => admits(levels, toolkit, accountId, op.slug)).map((op) => op.slug + (op.change ? "\0write" : "\0read")));
}
function opsUnion(levels: Levels, toolkit: string, accountId: string, tools: readonly string[] | undefined): Set<string> {
  const all = admittedOps(levels, toolkit, accountId);
  for (const tool of tools ?? []) if (admits(levels, toolkit, accountId, tool)) all.add(tool.toUpperCase() + (isReadSlug(toolkit, tool) ? "\0read" : "\0write"));
  return all;
}
/** Can an admission change anything (a full level whose list holds only reads cannot)? */
function changes(granted: Admission, toolkit: string): boolean { return granted.change && (granted.tools === "any" || [...granted.tools].some((tool) => !isReadSlug(toolkit, tool))); }
/** Does `after` admit, for this account, an operation `before` did not? */
export function widens(before: Levels, after: Levels, toolkit: string, accountId: string): boolean {
  const was = admission(before, toolkit, accountId), now = admission(after, toolkit, accountId);
  if (changes(now, toolkit) && !changes(was, toolkit)) return true;
  if (now.tools === "any") return was.tools !== "any";
  const wasTools = was.tools;
  return wasTools !== "any" && [...now.tools].some((tool) => !wasTools.has(tool) && (changes(now, toolkit) || isReadSlug(toolkit, tool)));
}
function accountKeys(before: Levels, after: Levels, accounts: ReadonlyArray<{ toolkit: string; accountId: string }>) {
  const keys = new Map<string, { toolkit: string; accountId: string }>();
  for (const item of [...accounts, ...before.accounts, ...after.accounts]) keys.set(item.toolkit + "\0" + item.accountId, { toolkit: item.toolkit, accountId: item.accountId });
  // The default pseudo-account: an account of the app not seen yet.
  for (const toolkit of new Set([...[...keys.values()].map((item) => item.toolkit), ...READS.keys(), ...CHANGES.keys()])) keys.set(toolkit + "\0\0default", { toolkit, accountId: "\0default" });
  return [...keys.values()];
}
/** `lowered(before, after)` (7): some account, or the default pseudo-account, loses an operation, or Only chosen turns on. */
export function lowered(before: Levels, after: Levels, accounts: ReadonlyArray<{ toolkit: string; accountId: string }>): boolean {
  if (before.newAccounts === "all" && after.newAccounts === "none") return true;
  if (fullyOpen(before) && !fullyOpen(after)) return true;
  return accountKeys(before, after, accounts).some(({ toolkit, accountId }) => widens(after, before, toolkit, accountId));
}
/** 7 step 8: grant-revoked rows for operations the edit took away; clear rows (per pair) the edit re-admits. */
function nextDenials(previous: readonly Denial[], before: Levels, after: Levels, changed: ReadonlyArray<{ toolkit: string; accountId: string }>, revision: number, now: number, explicit?: readonly string[]): Denial[] {
  const was = new Map(changed.map((item) => [item.toolkit + "\0" + item.accountId, opsUnion(before, item.toolkit, item.accountId, explicit)]));
  const is = new Map(changed.map((item) => [item.toolkit + "\0" + item.accountId, opsUnion(after, item.toolkit, item.accountId, explicit)]));
  // An app-wide refusal (no account) is never cleared by re-admitting one account (fail-closed).
  const readmitted = (toolkit: string, accountId: string | undefined, tool: string, op: string) => !!accountId && changed.some((item) => item.toolkit === toolkit && item.accountId === accountId
    && !was.get(item.toolkit + "\0" + item.accountId)!.has(tool.toUpperCase() + "\0" + op) && admits(after, item.toolkit, item.accountId, tool) && (op === "read" ? isReadSlug(toolkit, tool) : !isReadSlug(toolkit, tool)));
  const kept: Denial[] = [];
  for (const denial of previous) {
    const tools = denial.tools.filter((tool) => !denial.ops.every((op) => readmitted(denial.toolkit, denial.accountId, tool, op)));
    if (tools.length === denial.tools.length) kept.push(denial); else if (tools.length) kept.push({ ...denial, tools });
  }
  const added: Denial[] = [];
  for (const item of changed) {
    const lost = [...was.get(item.toolkit + "\0" + item.accountId)!].filter((op) => !is.get(item.toolkit + "\0" + item.accountId)!.has(op));
    for (const op of ["read", "write"] as const) {
      const tools = [...new Set(lost.filter((key) => key.endsWith("\0" + op)).map((key) => key.split("\0")[0]!))].sort();
      for (let at = 0; at < tools.length; at += 30) added.push({ id: LEVELS_DENIAL + randomUUID(), toolkit: item.toolkit, accountId: item.accountId, tools: tools.slice(at, at + 30), ops: [op], source: "grant-revoked", at: now, revision });
    }
  }
  const all = [...kept, ...added];
  // A lowering is never refused by the 64-row cap: drop the oldest grant-revoked rows these actions wrote.
  while (all.length > 64) {
    const oldest = all.findIndex((denial) => denial.source === "grant-revoked" && denial.id.startsWith(LEVELS_DENIAL));
    if (oldest < 0) break;
    all.splice(oldest, 1);
  }
  return all;
}
function withEntry(levels: Levels, action: Extract<LevelsAction, { action: "set-account" }>): Levels {
  const tools = action.tools ? [...new Set(action.tools.map((tool) => tool.toUpperCase()))].sort() : undefined;
  const rest = levels.accounts.filter((entry) => !(entry.toolkit === action.toolkit && entry.accountId === action.accountId));
  return { ...levels, accounts: [...rest, { toolkit: action.toolkit, accountId: action.accountId, level: action.level, ...(tools ? { tools } : {}) }] };
}
export interface LevelsAnswer { postCommitError?: unknown; revision: number; rule: "levels"; newAccounts: "none" | "all"; allowWrites: boolean; lowered: boolean; changed: boolean; pausedBySave: Array<{ toolkit: string; accountId: string | null }> }
/** PUT /api/bots/:id/access for the three levels actions. Awaits the settled read only for
 * a raise or keepCurrent (5.3); everything after the await runs in one synchronous block. */
export async function applyLevelsAction(store: Store, botId: string, input: unknown, options: { readSettled?: SettledRead; remembered?: InventoryServices | null; rememberedComplete?: boolean; now?: number } = {}): Promise<LevelsAnswer> {
  const parsed = levelsAction.safeParse(input);
  if (!parsed.success) fail("Invalid owner access decision.", 400);
  const action = parsed.data!;
  const first = store.bot(botId);
  if (!first) fail("Bot not found.", 404);
  // Validate what the level offers before any read (step 7).
  if (action.action === "set-account") {
    if (action.level === "none" && action.tools) fail("No access carries no operations.", 400);
    if (action.level === "read" && !readSlugs(action.toolkit).length) fail("Murage has no read-only operations for this app yet.", 422);
    for (const tool of action.tools ?? []) {
      if (slugToolkit(tool) !== action.toolkit) fail("That operation doesn't belong to this app.", 422);
      if (action.level === "read" && !isReadSlug(action.toolkit, tool)) fail("That operation isn't a verified read.", 422);
    }
  }
  if (action.action === "set-switches") {
    if (action.newAccounts === undefined && action.allowWrites === undefined) fail("Choose a switch to change.", 400);
    if (action.keepCurrent && (action.newAccounts !== "none" || action.allowWrites !== undefined)) fail("Keep current apps only applies when turning on Only chosen apps.", 400);
    if (action.except && !action.keepCurrent) fail("Except only applies with Keep current apps.", 400);
  }
  const startLevels = levelsOf(first!) ?? seedLevels(first!);
  const raising = action.action === "set-account" && widens(startLevels, withEntry(startLevels, action), action.toolkit, action.accountId);
  const keepCurrent = action.action === "set-switches" && !!action.keepCurrent;
  let settled: InventoryServices | null = null;
  let settledComplete = false;
  if (raising || keepCurrent) {
    const read = await options.readSettled?.().catch(() => null);
    if (!read || !read.settled || keepCurrent && !read.complete) fail("Murage couldn't check your connected apps just now. Nothing was changed. Try again in a moment.", 503);
    settled = read!.services;
    settledComplete = read!.complete;
  }
  // ---- One synchronous block from here (7 Order).
  const bot = store.bot(botId);
  if (!bot) fail("Bot not found.", 404);
  const policy = botAccessPolicy(bot!);
  if (action.revision !== policy.revision) fail("Access changed. Review the latest settings before saving.", 409, { code: "revision" });
  const stored = levelsOf(bot!);
  const before = stored ?? seedLevels(bot!);
  if (action.action !== "clear-floor") {
    const base = action.base;
    const shownEntry = action.action === "set-account" ? before.accounts.find((entry) => entry.toolkit === action.toolkit && entry.accountId === action.accountId) ?? null : null;
    if (base.newAccounts !== before.newAccounts || base.allowWrites !== before.allowWrites || action.action === "set-account" && !sameEntry(action.base.entry, shownEntry))
      fail("Changed in another window.", 409, { code: "base", theirs: { newAccounts: before.newAccounts, allowWrites: before.allowWrites, entry: shownEntry } });
  }
  const now = options.now ?? Date.now();
  let after: Levels = { ...before, accounts: [...before.accounts], ...(before.newAccountFloors ? { newAccountFloors: before.newAccountFloors.map((floor) => ({ ...floor })) } : {}) };
  let changed: Array<{ toolkit: string; accountId: string }> = [];
  let projectionTarget: { toolkit: string; accountId: string } | null = null;
  if (action.action === "set-account") {
    if (raising) {
      const service = settled![action.toolkit];
      if (!service?.accounts.some((account) => account.id === action.accountId && account.status.toUpperCase() === "ACTIVE") || "refused" in accountToolkit(settled!, action.accountId)) fail("That account is no longer connected. Refresh and try again.", 409, { code: "not-connected" });
    }
    const tools = action.tools ? [...new Set(action.tools.map((tool) => tool.toUpperCase()))].sort() : undefined;
    const wanted: LevelEntry = { toolkit: action.toolkit, accountId: action.accountId, level: action.level, ...(tools ? { tools } : {}) };
    const isDefault = !tools && sameEntry({ level: action.level }, defaultCap(before));
    after.accounts = after.accounts.filter((entry) => !(entry.toolkit === action.toolkit && entry.accountId === action.accountId));
    if (!isDefault) {
      const at = before.accounts.findIndex((entry) => entry.toolkit === action.toolkit && entry.accountId === action.accountId);
      after.accounts.splice(at < 0 ? after.accounts.length : at, 0, wanted);
    }
    // An explicit choice on an ID a floor still covers wins from now on (4.7 G46).
    after.newAccountFloors = after.newAccountFloors?.map((floor) => floor.toolkit === action.toolkit && !floor.accountKey.includes(action.accountId) && !floor.applied.includes(action.accountId) ? { ...floor, applied: [...floor.applied, action.accountId] } : floor);
    if (after.accounts.length > 200) fail("Too many accounts to keep.", 409, { code: "too-many" });
    changed = [{ toolkit: action.toolkit, accountId: action.accountId }];
    projectionTarget = changed[0]!;
  } else if (action.action === "set-switches") {
    if (keepCurrent) {
      const kept: LevelEntry[] = [...before.accounts];
      for (const [toolkit, service] of Object.entries(settled!)) for (const account of service.accounts) {
        if (UNFINISHED.has(account.status.toUpperCase()) || kept.some((entry) => entry.toolkit === toolkit && entry.accountId === account.id)) continue;
        const cap = capFor(before, toolkit, account.id);
        kept.push({ toolkit, accountId: account.id, level: cap.level, ...(cap.tools ? { tools: cap.tools } : {}) });
      }
      for (const item of action.except ?? []) {
        const at = kept.findIndex((entry) => entry.toolkit === item.toolkit && entry.accountId === item.accountId);
        const none: LevelEntry = { toolkit: item.toolkit, accountId: item.accountId, level: "none" };
        if (at < 0) kept.push(none); else kept[at] = none;
      }
      if (kept.length > 200) fail("Too many accounts to keep.", 409, { code: "too-many" });
      after.accounts = kept;
    }
    if (action.newAccounts !== undefined) after.newAccounts = action.newAccounts;
    if (action.allowWrites !== undefined) after.allowWrites = action.allowWrites;
    const universe = new Map<string, { toolkit: string; accountId: string }>();
    for (const [toolkit, service] of Object.entries(settled ?? options.remembered ?? {})) for (const account of service.accounts) universe.set(toolkit + "\0" + account.id, { toolkit, accountId: account.id });
    for (const entry of [...before.accounts, ...after.accounts]) universe.set(entry.toolkit + "\0" + entry.accountId, { toolkit: entry.toolkit, accountId: entry.accountId });
    changed = [...universe.values()].filter((item) => JSON.stringify([...opsUnion(before, item.toolkit, item.accountId, undefined)].sort()) !== JSON.stringify([...opsUnion(after, item.toolkit, item.accountId, undefined)].sort()));
  } else {
    after.newAccountFloors = after.newAccountFloors?.filter((floor) => floor.toolkit !== action.toolkit);
  }
  if (after.newAccountFloors && !after.newAccountFloors.length) delete after.newAccountFloors;
  const previousOpen = !stored ? policy.mode === "unrestricted" : fullyOpen(before);
  const deniedBefore = policy.denials ?? [];
  const denials = nextDenials(deniedBefore, before, after, changed, policy.revision + 1, now, action.action === "set-account" ? action.tools : undefined);
  const projected = legacyProjection(policy, previousOpen, after, projectionTarget);
  // Step 9: a no-op writes nothing and never converts a legacy bot.
  const sameLevels = JSON.stringify({ ...before, atRevision: 0 }) === JSON.stringify({ ...after, atRevision: 0 });
  if (sameLevels && JSON.stringify(denials) === JSON.stringify(deniedBefore)) return { revision: policy.revision, rule: "levels", newAccounts: before.newAccounts, allowWrites: before.allowWrites, lowered: false, changed: false, pausedBySave: [] };
  const universe = Object.entries(options.remembered ?? settled ?? {}).flatMap(([toolkit, service]) => service.accounts.map((account) => ({ toolkit, accountId: account.id })));
  const wasLowered = lowered(before, after, universe);
  // Preservation (7, r4): accounts admitted and runnable before, refused by a newly gated app after.
  // A legacy bot's rows ran with no gate, so its first levels save gates every app it touches.
  const known = keepCurrent || settledComplete ? settled : options.remembered ?? settled;
  const universeKnown = Object.entries(known ?? {}).map(([toolkit]) => toolkit);
  const newlyGated = [...new Set([...universe.map((item) => item.toolkit), ...universeKnown, ...after.accounts.map((entry) => entry.toolkit)])].filter((toolkit) => gated(after, toolkit) && (!stored || !gated(before, toolkit)));
  const pausedBySave: LevelsAnswer["pausedBySave"] = [];
  for (const toolkit of newlyGated) {
    if (!known) { pausedBySave.push({ toolkit, accountId: null }); continue; }
    // An incomplete source may hide runnable accounts: say so rather than pause them silently.
    if (!(keepCurrent || settledComplete || (options.remembered ? options.rememberedComplete === true : false))) pausedBySave.push({ toolkit, accountId: null });
    for (const account of known[toolkit]?.accounts ?? []) {
      if (changed.some((item) => item.toolkit === toolkit && item.accountId === account.id)) continue;
      if (knownOps(toolkit).some((op) => admits(after, toolkit, account.id, op.slug) && !EXACT_ACCOUNT_QUALIFIED.has(pair(toolkit, op.slug)))) pausedBySave.push({ toolkit, accountId: account.id });
    }
  }
  const pureLowering = action.action === "set-account" ? !widens(before, after, action.toolkit, action.accountId) : action.action === "set-switches" && !keepCurrent && (action.allowWrites !== true && action.newAccounts !== "all");
  if (pausedBySave.length && !pureLowering) fail(`Murage can't keep ${bot!.name}'s current apps working on Only chosen apps yet: ${[...new Set(pausedBySave.map((item) => item.toolkit))].join(", ")} haven't been checked. Nothing was changed.`, 409, { code: "preservation" });
  const revision = policy.revision + 1;
  const next: ConnectedAppAccess = { ...policy, ...projected, revision, roleBinding: policy.roleBinding, requests: policy.requests, denials };
  const nextLevels: Levels = { ...after, atRevision: revision, roleBinding: policy.roleBinding };
  if (!connectedAppLevelsSchema.safeParse(nextLevels).success) fail("Couldn't save. Nothing was changed.", 500);
  // Step 10: a RosterPostCommitError means committed; the route logs it and goes on to step 11.
  let postCommitError: unknown;
  try { commitAccess(store, bot!, next, nextLevels); }
  catch (error) { if (!(error instanceof RosterPostCommitError)) throw error; postCommitError = error; }
  return { ...(postCommitError ? { postCommitError } : {}), revision, rule: "levels", newAccounts: nextLevels.newAccounts, allowWrites: nextLevels.allowWrites, lowered: wasLowered, changed: true, pausedBySave };
}

/** Owner view additions (7 step 12): the rule, both switches and per account saved vs effective. */
export function levelsOwnerView(bot: BotRecord, remembered: InventoryServices | null | undefined) {
  const stored = levelsOf(bot);
  const levels = stored ?? seedLevels(bot);
  const accounts = Object.entries(remembered ?? {}).flatMap(([toolkit, service]) => service.accounts.filter((account) => account.status.toUpperCase() === "ACTIVE").map((account) => {
    const entry = levels.accounts.find((item) => item.toolkit === toolkit && item.accountId === account.id) ?? null;
    const effective = effectiveLevel(levels, toolkit, account.id);
    const saved = entry ? { level: entry.level, ...(entry.tools ? { tools: entry.tools } : {}) } : null;
    const reason = saved && saved.level === "full" && effective === "none" && !levels.allowWrites ? "writes-off" as const
      : effective !== "none" && gated(levels, toolkit) && !fullyOpen(levels) && knownOps(toolkit).every((op) => !EXACT_ACCOUNT_QUALIFIED.has(pair(toolkit, op.slug))) ? "unchecked" as const : undefined;
    return { toolkit, accountId: account.id, label: account.alias ?? account.id, saved, effective, ...(reason ? { reason } : {}) };
  }));
  return { rule: stored ? "levels" as const : "legacy" as const, newAccounts: levels.newAccounts, allowWrites: levels.allowWrites, floors: levels.newAccountFloors ?? [], accounts };
}
