import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { RosterPostCommitError, Store, type BotRecord } from "./store.ts";
import { assertConnectedAppCall, assertStoredConnectedAppAccess, connectedAppsListScope, restrictedConnectorTools } from "./bot-access.ts";
import { applyLevelsAction, commitAccess, levelsOf, levelsOwnerView, lowered, qualifyForTesting, seedLevels, type Levels } from "./bot-access-levels.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import { CONNECTED_APP_TOOLS, connectedAppAccessSchema } from "../shared/bot-access.ts";
import type { InventoryServices } from "./connected-inventory.ts";
import { VERIFIED_READ_TOOLS } from "../shared/connected-app-read-tools.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// AG0 r4 row group 1 witnesses (designs/1021-ag0/DESIGN-r4.md section 10). Every check runs
// the shipped relay check (assertConnectedAppCall) and the shipped owner action
// (applyLevelsAction) on a real Store; nothing in bot-access*.ts is mocked.
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
let undo: Array<() => void> = [];
afterEach(() => { for (const step of undo.splice(0)) step(); vi.restoreAllMocks(); });

const svc = (...accounts: Array<[string, string?, string?]>) => ({ connected: true, pending: false, status: "ACTIVE", accounts: accounts.map(([id, alias, status]) => ({ id, ...(alias ? { alias } : {}), status: status ?? "ACTIVE" })) });
const inventory: InventoryServices = { gmail: svc(["ca_mail_a", "work"], ["ca_mail_b", "home"]), slack: svc(["ca_chat_a", "team"]), notion: svc(["ca_note_a", "wiki"]) };
const settled = (services: InventoryServices = inventory, extra: Partial<{ settled: boolean; complete: boolean }> = {}) => async () => ({ services, settled: true, complete: true, ...extra });
const call = (rows: Array<Record<string, unknown>>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: rows } } });
const row = (tool_slug: string, account?: string) => ({ tool_slug, ...(account !== undefined ? { account } : {}), arguments: {} });
const verdict = (bot: BotRecord, input: unknown, options: { noLimits?: boolean; inventory?: InventoryServices | null } = { inventory }) => { try { assertConnectedAppCall(bot, input, options); return "ok"; } catch (error) { return (error as Error).message; } };
function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Pepper", section: "Studio" });
  return { store, bot, fresh: () => store.bot(bot.id)! };
}
const allCatalogQualified = () => undo.push(qualifyForTesting(CONNECTED_APP_TOOLS.map((tool) => ({ toolkit: tool.toolkit, slug: tool.tool }))));
const base = (bot: BotRecord, entry: { level: string; tools?: string[] } | null = null) => { const levels = levelsOf(bot) ?? seedLevels(bot); return { entry, newAccounts: levels.newAccounts, allowWrites: levels.allowWrites }; };
const switchBase = (bot: BotRecord) => { const { newAccounts, allowWrites } = base(bot); return { newAccounts, allowWrites }; };
async function setAccount(store: Store, bot: BotRecord, toolkit: string, accountId: string, level: string, extra: Record<string, unknown> = {}) {
  const current = store.bot(bot.id)!;
  const levels = levelsOf(current) ?? seedLevels(current);
  const entry = levels.accounts.find((item) => item.toolkit === toolkit && item.accountId === accountId) ?? null;
  return applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(current).revision, base: base(current, entry && { level: entry.level, ...(entry.tools ? { tools: entry.tools } : {}) }), toolkit, accountId, level, ...extra }, { readSettled: settled(), remembered: inventory, rememberedComplete: true });
}
const legacyRestricted = (revision: number, bot: BotRecord, grants: Array<{ toolkit: string; accountId: string; tools: string[] }>, allowWrites = true) => ({ revision, roleBinding: botAccessPolicy(bot).roleBinding, mode: "restricted" as const, allowWrites, grants, requests: [], denials: [] });

describe("AG0 levels: relay admission (W1, W2, W3, W5, W10, W26, W27)", () => {
  it("W1/W27: Every app bot, Gmail A No access: A refused; ungated Slack still runs; Gmail B paused by the gate", async () => {
    const { store, bot, fresh } = setup();
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toBe("ok");
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(levelsOf(fresh())).not.toBeNull();
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_a")]))).toBe("This bot has no access to this account.");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toBe("ok");
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_b")]))).toMatch(/hasn't yet checked that gmail runs each request/);
    // One refused row refuses the whole call.
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a"), row("GMAIL_FETCH_EMAILS", "ca_mail_a")]))).toBe("This bot has no access to this account.");
  });
  it("W2: workbench, connection tools, a direct slug, a row with no account and a row naming an alias are refused", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const blocked = /only run the app operations its owner chose/;
    expect(verdict(fresh(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: {} } })).toMatch(blocked);
    expect(verdict(fresh(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: {} } })).toMatch(blocked);
    expect(verdict(fresh(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SLACK_SEND_MESSAGE", arguments: {} } })).toMatch(blocked);
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE")]))).toBe("Name the account by its ID; the tool list shows them.");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "team")]))).toBe("That account is not connected.");
  });
  it("W3: Read only refuses a change before the gate; an unreviewed slug is refused as unknown; a verified read is admitted", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_mail_a")]))).toBe("This account is set to Read only for this bot.");
    expect(verdict(fresh(), call([row("GMAIL_LIST_EVERYTHING", "ca_mail_a")]))).toMatch(/can't tell which app this is for/);
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_chat_a")]))).toMatch(/can't tell which app this is for/);
    undo.push(qualifyForTesting([{ toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS" }]));
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_a")]))).toBe("ok");
  });
  it("W4 slice: one account ID filed under two apps is refused", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    allCatalogQualified();
    const twice = { ...inventory, slack: svc(["ca_chat_a"], ["ca_mail_a"]) };
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_a")]), { inventory: twice })).toBe("Murage can't tell which app this account belongs to.");
  });
  it("W5: a limited levels bot with no inventory gets the loading text; a legacy unrestricted bot is unaffected", async () => {
    const { store, bot, fresh } = setup();
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "anything")]), { inventory: null })).toBe("ok");
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]), { inventory: null })).toBe("Connected apps are still loading. Try again in a moment.");
  });
  it("W10: a No limits turn is allowed with No access; Connected apps off is still refused first", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_mail_a")]), { noLimits: true, inventory })).toBe("ok");
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_mail_a")]), { noLimits: false, inventory })).toBe("This bot has no access to this account.");
    store.patchBot(bot.id, { composio: false });
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_mail_a")]), { noLimits: true, inventory })).toMatch(/Connected apps are off/);
  });
  it("W26: Only chosen refuses a new account; Every app admits an untouched app's new account without qualification", async () => {
    const { store, bot, fresh } = setup();
    const grown = { ...inventory, slack: svc(["ca_chat_a"], ["ca_chat_new"]) };
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_new")]), { inventory: grown })).toBe("ok");
    allCatalogQualified();
    const current = fresh();
    await applyLevelsAction(store, bot.id, { action: "set-switches", revision: botAccessPolicy(current).revision, base: switchBase(current), newAccounts: "none" }, { remembered: inventory, rememberedComplete: true });
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_new")]), { inventory: grown })).toBe("This bot has no access to this account.");
  });
  it("6.2/6.4: the tool list names admitted account IDs only, and the list scope moves with the inventory", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const tools = restrictedConnectorTools(fresh(), 7, false, inventory)!;
    const accounts = (tools.result.tools[0] as { inputSchema: { properties: { tools: { items: { properties: { account: { enum: string[] } } } } } } }).inputSchema.properties.tools.items.properties.account.enum;
    expect(accounts).toEqual(expect.arrayContaining(["ca_mail_b", "ca_chat_a", "ca_note_a"]));
    expect(accounts).not.toContain("ca_mail_a");
    expect(connectedAppsListScope(fresh(), 0, false, inventory).revision).not.toBe(connectedAppsListScope(fresh(), 0, false, null).revision);
  });
});

describe("AG0 levels: storage, seed, projection, fence (W6, W11, W12, W13, W14, W15, W20)", () => {
  it("W6: set-account keeps other entries, switches, requests and an unrelated account's two legacy rows byte-identical", async () => {
    const { store, bot, fresh } = setup();
    undo.push(qualifyForTesting([...CONNECTED_APP_TOOLS, ...VERIFIED_READ_TOOLS].map((tool) => ({ toolkit: tool.toolkit, slug: tool.tool }))));
    const rows = [{ toolkit: "gmail", accountId: "ca_mail_b", tools: ["GMAIL_FETCH_EMAILS"] }, { toolkit: "slack", accountId: "ca_chat_a", tools: ["SLACK_SEND_MESSAGE"] }, { toolkit: "gmail", accountId: "ca_mail_b", tools: ["GMAIL_SEND_EMAIL"] }];
    const request = { id: "req_fixture", requestedBy: "chief_fixture", requesterBinding: "x", targetBinding: botAccessPolicy(fresh()).roleBinding, createdAt: 1, expiresAt: 2, grants: [rows[0]!], allowWrites: false };
    store.patchBot(bot.id, { connectedAppAccess: { ...legacyRestricted(3, fresh(), rows), requests: [request] } });
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    const after = botAccessPolicy(fresh());
    expect(after.requests).toEqual([request]);
    expect(JSON.stringify(after.grants.filter((grant) => grant.accountId === "ca_mail_b"))).toBe(JSON.stringify([rows[0], rows[2]]));
    expect(after.grants.find((grant) => grant.accountId === "ca_mail_a")?.tools).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"]);
    expect(after.revision).toBe(4);
    await setAccount(store, bot, "slack", "ca_chat_a", "none");
    expect(levelsOf(fresh())!.accounts.map((entry) => entry.accountId)).toEqual(["ca_mail_b", "ca_mail_a"]);
    expect(JSON.stringify(botAccessPolicy(fresh()).grants.filter((grant) => grant.accountId === "ca_mail_b"))).toBe(JSON.stringify([rows[0], rows[2]]));
  });
  it("W11: writes off refuses a change and admits reads; an unrestricted record seeds writes on; saved full with only changes shows effective none", async () => {
    const { store, bot, fresh } = setup();
    store.patchBot(bot.id, { connectedAppAccess: { revision: 2, roleBinding: botAccessPolicy(fresh()).roleBinding, mode: "unrestricted", allowWrites: false, grants: [], requests: [] } });
    expect(seedLevels(fresh()).allowWrites).toBe(true);
    const current = fresh();
    await applyLevelsAction(store, bot.id, { action: "set-switches", revision: 2, base: switchBase(current), allowWrites: false }, { remembered: inventory, rememberedComplete: true });
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toBe("The owner has turned off sending, creating and deleting for this bot.");
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_a")]))).toBe("ok");
    await setAccount(store, bot, "gmail", "ca_mail_a", "full", { tools: ["GMAIL_SEND_EMAIL"] });
    const view = levelsOwnerView(fresh(), inventory).accounts.find((item) => item.accountId === "ca_mail_a")!;
    expect(view).toMatchObject({ saved: { level: "full", tools: ["GMAIL_SEND_EMAIL"] }, effective: "none", reason: "writes-off" });
  });
  it("W12: legacy records keep today's verdicts and today's list-scope hash input", () => {
    const { store, bot, fresh } = setup();
    const legacyHash = (record: BotRecord) => {
      const policy = botAccessPolicy(record); const restricted = policy.mode === "restricted";
      const grants = restricted ? policy.grants.map((grant) => ({ toolkit: grant.toolkit, accountId: grant.accountId, tools: [...new Set(grant.tools)].sort() })).sort((a, b) => (a.toolkit + "\0" + a.accountId).localeCompare(b.toolkit + "\0" + b.accountId)) : [];
      return createHash("sha256").update(JSON.stringify({ enabled: record.composio !== false, hidden: !!record.hidden, mode: policy.mode, allowWrites: restricted ? policy.allowWrites : null, grants, connectionEpoch: 0 })).digest("hex").slice(0, 32);
    };
    const corpus = [undefined, { revision: 1, roleBinding: botAccessPolicy(fresh()).roleBinding, mode: "unrestricted", allowWrites: false, grants: [], requests: [] }, legacyRestricted(2, fresh(), [{ toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_FETCH_EMAILS"] }, { toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_SEND_EMAIL"] }], false), { broken: true }, { ...legacyRestricted(2, fresh(), []), roleBinding: "reset" }];
    for (const record of corpus) {
      store.patchBot(bot.id, { connectedAppAccess: record as never });
      expect(levelsOf(fresh())).toBeNull();
      expect(connectedAppsListScope(fresh()).revision).toBe(legacyHash(fresh()));
      expect(connectedAppsListScope(fresh(), 0, false, inventory).revision).toBe(legacyHash(fresh()));
    }
  });
  it("W13: a restricted bot with two rows for one account keeps every catalog verdict after an unrelated set-account", async () => {
    const { store, bot, fresh } = setup();
    allCatalogQualified();
    store.patchBot(bot.id, { connectedAppAccess: legacyRestricted(5, fresh(), [{ toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_FETCH_EMAILS"] }, { toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_SEND_EMAIL"] }], true) });
    const accounts = ["ca_mail_a", "ca_mail_b", "ca_chat_a"];
    const matrix = () => CONNECTED_APP_TOOLS.flatMap((tool) => accounts.map((account) => verdict(fresh(), call([row(tool.tool, account)])) === "ok"));
    const legacy = matrix();
    await setAccount(store, bot, "notion", "ca_note_a", "read");
    expect(levelsOf(fresh())).not.toBeNull();
    expect(matrix()).toEqual(legacy);
    expect(legacy.filter(Boolean).length).toBe(2);
  });
  it("W14: an older-build write at revision+1 that keeps the sibling turns levels off; the legacy record governs", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toBe("ok");
    const policy = botAccessPolicy(fresh());
    store.patchBot(bot.id, { connectedAppAccess: { revision: policy.revision + 1, roleBinding: policy.roleBinding, mode: "restricted", allowWrites: false, grants: [], requests: [] } });
    expect((fresh() as BotRecord & { connectedAppLevels?: unknown }).connectedAppLevels).toBeDefined();
    expect(levelsOf(fresh())).toBeNull();
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toMatch(/not been approved|blocked connected-app writes/);
  });
  it("W15: the projection is never wider than the levels, parses as the legacy record, and survives a reload with the sibling", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    await setAccount(store, bot, "slack", "ca_chat_a", "full", { tools: ["SLACK_SEND_MESSAGE"] });
    const projected = fresh().connectedAppAccess!;
    expect(connectedAppAccessSchema.safeParse(projected).success).toBe(true);
    const levels = levelsOf(fresh())!;
    for (const grant of projected.grants) for (const tool of grant.tools) {
      const entry = levels.accounts.find((item) => item.toolkit === grant.toolkit && item.accountId === grant.accountId);
      expect(entry && entry.level !== "none").toBeTruthy();
      if (CONNECTED_APP_TOOLS.find((known) => known.tool === tool)!.writes) expect(entry!.level === "full" && projected.allowWrites).toBe(true);
    }
    expect(projected.mode).toBe("restricted");
    closeDatabase();
    const reloaded = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    expect(levelsOf(reloaded.bot(bot.id)!)).toEqual(levels);
  });
  it("W20: no server module patches the three access fields except commitAccess", () => {
    const dir = join(import.meta.dirname, ".");
    const offenders: string[] = [];
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.ts$/.test(file) || /\.test\.ts$|testing\//.test(file) || file === "bot-access-levels.ts" || file === "store.ts") continue;
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(/patchBot\([^;]*?(connectedAppAccess|connectedAppLevels|connectedAppDecisions)\s*:/g)) offenders.push(`${file}: ${match[0].slice(0, 80)}`);
      if (/\.connectedApp(Levels|Decisions)\s*=(?!=)/.test(text)) offenders.push(`${file}: direct assignment`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("AG0 levels: owner actions (W7, W8, W9, W19, W23, W24, W25)", () => {
  it("W7: a stale revision or a stale base is 409 and nothing is written", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    const drawnRevision = botAccessPolicy(fresh()).revision;
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const before = JSON.stringify(fresh());
    await expect(applyLevelsAction(store, bot.id, { action: "set-account", revision: drawnRevision, base: { entry: { level: "read" }, newAccounts: "all", allowWrites: true }, toolkit: "gmail", accountId: "ca_mail_a", level: "full" }, { readSettled: settled() })).rejects.toMatchObject({ status: 409, code: "revision" });
    // Fresh revision, stale base (drawn from read): still 409.
    await expect(applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(fresh()).revision, base: base(fresh(), { level: "read" }), toolkit: "gmail", accountId: "ca_mail_a", level: "full" }, { readSettled: settled() })).rejects.toMatchObject({ status: 409, code: "base" });
    // Draft from the Every app default while another window switched to Only chosen.
    const current = fresh();
    await applyLevelsAction(store, bot.id, { action: "set-switches", revision: botAccessPolicy(current).revision, base: switchBase(current), newAccounts: "none" }, { remembered: {} });
    const mid = JSON.stringify(fresh());
    await expect(applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(fresh()).revision, base: { entry: null, newAccounts: "all", allowWrites: true }, toolkit: "slack", accountId: "ca_chat_a", level: "read" }, { readSettled: settled() })).rejects.toMatchObject({ status: 409, code: "base" });
    expect(JSON.stringify(fresh())).toBe(mid);
    expect(before).not.toBe(mid);
  });
  it("W8: a raise for a gone account is 409; an unsettled read is 503 with nothing written; a lowering in that state saves; read with no read list is 422", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const before = JSON.stringify(fresh());
    const gone = { ...inventory, gmail: svc(["ca_mail_b"]) };
    const raise = () => ({ action: "set-account", revision: botAccessPolicy(fresh()).revision, base: base(fresh(), { level: "none" }), toolkit: "gmail", accountId: "ca_mail_a", level: "read" });
    await expect(applyLevelsAction(store, bot.id, raise(), { readSettled: settled(gone) })).rejects.toMatchObject({ status: 409, code: "not-connected" });
    await expect(applyLevelsAction(store, bot.id, raise(), { readSettled: settled(inventory, { settled: false }) })).rejects.toMatchObject({ status: 503 });
    await expect(applyLevelsAction(store, bot.id, raise(), { readSettled: async () => { throw new Error("backoff"); } })).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(fresh())).toBe(before);
    const lowering = { action: "set-account", revision: botAccessPolicy(fresh()).revision, base: base(fresh(), null), toolkit: "gmail", accountId: "ca_mail_b", level: "none" };
    await expect(applyLevelsAction(store, bot.id, lowering, { readSettled: settled(inventory, { settled: false }) })).resolves.toMatchObject({ changed: true });
    await expect(applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(fresh()).revision, base: base(fresh(), null), toolkit: "fixtureapp", accountId: "ca_crm_a", level: "read" }, { readSettled: settled() })).rejects.toMatchObject({ status: 422 });
  });
  it("W9: lowered() is by operations: full with read-only tools to read with the same tools is not a lowering; Only chosen on is", () => {
    const start: Levels = { v: 1, atRevision: 1, roleBinding: "b", newAccounts: "all", allowWrites: true, accounts: [{ toolkit: "gmail", accountId: "ca_mail_a", level: "full", tools: ["GMAIL_FETCH_EMAILS"] }] };
    const same: Levels = { ...start, accounts: [{ toolkit: "gmail", accountId: "ca_mail_a", level: "read", tools: ["GMAIL_FETCH_EMAILS"] }] };
    expect(lowered(start, same, [])).toBe(false);
    expect(lowered(start, { ...start, accounts: [{ toolkit: "gmail", accountId: "ca_mail_a", level: "none" }] }, [])).toBe(true);
    expect(lowered(start, { ...start, accounts: [] }, [])).toBe(false);
    expect(lowered(start, { ...start, newAccounts: "none", accounts: [...start.accounts, { toolkit: "slack", accountId: "ca_chat_a", level: "full" }] }, [])).toBe(true);
  });
  it("W19 slice: a same-revision legacy write keeps the levels; configure replaces them with exactly its grants", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const { reviewBotAccess } = await import("./bot-access.ts");
    const policy = botAccessPolicy(fresh());
    store.patchBot(bot.id, { connectedAppAccess: { ...policy } });
    expect(levelsOf(fresh())).not.toBeNull();
    reviewBotAccess(store, bot.id, { action: "configure", revision: policy.revision, mode: "restricted", allowWrites: false, grants: [{ toolkit: "gmail", accountId: "ca_mail_b", tools: ["GMAIL_FETCH_EMAILS"] }] }, [{ toolkit: "gmail", accountId: "ca_mail_b" }]);
    expect((fresh() as BotRecord & { connectedAppLevels?: unknown }).connectedAppLevels).toBeUndefined();
    expect(botAccessPolicy(fresh()).grants).toEqual([{ toolkit: "gmail", accountId: "ca_mail_b", tools: ["GMAIL_FETCH_EMAILS"] }]);
  });
  it("W23: a lowering writes one row per account and op, a raise clears exactly those pairs, an unrelated refusal survives, and the cap never refuses", async () => {
    const { store, bot, fresh } = setup();
    const unrelated = { id: "deny_slack", toolkit: "slack", accountId: "ca_chat_a", tools: ["SLACK_SEND_MESSAGE"], ops: ["write" as const], source: "request-denied" as const, at: 1, revision: 1 };
    store.patchBot(bot.id, { connectedAppAccess: { revision: 1, roleBinding: botAccessPolicy(fresh()).roleBinding, mode: "unrestricted", allowWrites: true, grants: [], requests: [], denials: [unrelated] } });
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const rows = (botAccessPolicy(fresh()).denials ?? []).filter((denial) => denial.accountId === "ca_mail_a");
    expect(rows.map((denial) => denial.ops)).toEqual([["read"], ["write"]]);
    expect(rows[1]!.tools).toEqual(["GMAIL_SEND_EMAIL"]);
    await setAccount(store, bot, "gmail", "ca_mail_a", "read");
    expect((botAccessPolicy(fresh()).denials ?? []).filter((denial) => denial.accountId === "ca_mail_a").map((denial) => denial.ops)).toEqual([["write"]]);
    await setAccount(store, bot, "gmail", "ca_mail_a", "full");
    expect(botAccessPolicy(fresh()).denials).toEqual([unrelated]);
    // At the cap, a lowering still commits.
    const filler = Array.from({ length: 63 }, (_, index) => ({ ...unrelated, id: index < 40 ? `fill_${index}` : `lv-fill_${index}`, source: index < 40 ? "request-denied" as const : "grant-revoked" as const }));
    const current = botAccessPolicy(fresh());
    store.patchBot(bot.id, { connectedAppAccess: { ...current, denials: [unrelated, ...filler] }, connectedAppLevels: { ...levelsOf(fresh())! } } as never);
    await expect(setAccount(store, bot, "gmail", "ca_mail_a", "none")).resolves.toMatchObject({ changed: true });
    expect((botAccessPolicy(fresh()).denials ?? []).length).toBeLessThanOrEqual(64);
    expect((botAccessPolicy(fresh()).denials ?? []).filter((denial) => denial.source === "request-denied").length).toBe(41);
    expect((botAccessPolicy(fresh()).denials ?? []).filter((denial) => denial.accountId === "ca_mail_a").map((denial) => denial.ops)).toEqual([["read"], ["write"]]);
  });
  it("W24: a post-commit roster failure is a committed save; a failure before the write changes nothing", async () => {
    const { store, bot, fresh } = setup();
    const original = store.patchBot.bind(store);
    const spy = vi.spyOn(store, "patchBot").mockImplementationOnce((...args) => { original(...args); throw new RosterPostCommitError(new Error("listener"), []); });
    await expect(setAccount(store, bot, "gmail", "ca_mail_a", "none")).resolves.toMatchObject({ changed: true, revision: 1 });
    expect(verdict(fresh(), call([row("GMAIL_FETCH_EMAILS", "ca_mail_a")]))).toBe("This bot has no access to this account.");
    spy.mockImplementationOnce(() => { throw new Error("disk"); });
    const before = JSON.stringify(fresh());
    await expect(setAccount(store, bot, "slack", "ca_chat_a", "none")).rejects.toThrow("disk");
    expect(JSON.stringify(fresh())).toBe(before);
  });
  it("W25: keepCurrent keeps every account's exact admission, sets except to No access and turns on Only chosen", async () => {
    const { store, bot, fresh } = setup();
    allCatalogQualified();
    undo.push(qualifyForTesting(VERIFIED_READ_TOOLS.map((tool) => ({ toolkit: tool.toolkit, slug: tool.tool }))));
    await setAccount(store, bot, "notion", "ca_note_a", "read", { tools: ["NOTION_FETCH_BLOCK_CONTENTS", "NOTION_FETCH_BLOCK_METADATA"] });
    const withNew = { ...inventory, hubspot: svc(["ca_crm_a"]), gmail: svc(["ca_mail_a"], ["ca_mail_c", undefined, "INITIATED"]) };
    const current = fresh();
    await expect(applyLevelsAction(store, bot.id, { action: "set-switches", revision: botAccessPolicy(current).revision, base: switchBase(current), newAccounts: "none", keepCurrent: true }, { readSettled: settled(withNew, { complete: false }) })).rejects.toMatchObject({ status: 503 });
    const answer = await applyLevelsAction(store, bot.id, { action: "set-switches", revision: botAccessPolicy(current).revision, base: switchBase(current), newAccounts: "none", keepCurrent: true, except: [{ toolkit: "hubspot", accountId: "ca_crm_a" }] }, { readSettled: settled(withNew), remembered: withNew, rememberedComplete: true });
    expect(answer).toMatchObject({ newAccounts: "none", lowered: true });
    const levels = levelsOf(fresh())!;
    expect(levels.accounts.find((entry) => entry.accountId === "ca_note_a")).toEqual({ toolkit: "notion", accountId: "ca_note_a", level: "read", tools: ["NOTION_FETCH_BLOCK_CONTENTS", "NOTION_FETCH_BLOCK_METADATA"] });
    expect(levels.accounts.find((entry) => entry.accountId === "ca_crm_a")?.level).toBe("none");
    expect(levels.accounts.some((entry) => entry.accountId === "ca_mail_c")).toBe(false);
    expect(verdict(fresh(), call([row("GMAIL_SEND_EMAIL", "ca_mail_a")]), { inventory: withNew })).toBe("ok");
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]), { inventory: withNew })).toBe("ok");
    expect(verdict(fresh(), call([row("NOTION_FETCH_BLOCK_CONTENTS", "ca_note_a")]), { inventory: withNew })).toBe("ok");
    expect(verdict(fresh(), call([row("NOTION_FETCH_ALL_BLOCK_CONTENTS", "ca_note_a")]), { inventory: withNew })).not.toBe("ok");
    const later = { ...withNew, slack: svc(["ca_chat_a"], ["ca_chat_late"]) };
    expect(verdict(fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_late")]), { inventory: later })).toBe("This bot has no access to this account.");
  });
  it("P1 preservation: a lowering commits and names what the gate pauses; a legacy bot's first raise that would pause rows is 409", async () => {
    const { store, bot, fresh } = setup();
    await expect(setAccount(store, bot, "gmail", "ca_mail_a", "none")).resolves.toMatchObject({ changed: true, pausedBySave: [{ toolkit: "gmail", accountId: "ca_mail_b" }] });
    const current = fresh();
    await expect(applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(current).revision, base: base(current, null), toolkit: "slack", accountId: "ca_chat_a", level: "read" }, { remembered: null })).resolves.toMatchObject({ pausedBySave: [{ toolkit: "slack", accountId: null }] });
    const legacy = setup();
    legacy.store.patchBot(legacy.bot.id, { connectedAppAccess: legacyRestricted(2, legacy.fresh(), [{ toolkit: "slack", accountId: "ca_chat_a", tools: ["SLACK_SEND_MESSAGE"] }]) });
    const before = JSON.stringify(legacy.fresh());
    await expect(setAccount(legacy.store, legacy.bot, "notion", "ca_note_a", "read")).rejects.toMatchObject({ status: 409, code: "preservation" });
    expect(JSON.stringify(legacy.fresh())).toBe(before);
    expect(verdict(legacy.fresh(), call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]))).toBe("ok");
  });
  it("P1b: an incomplete remembered inventory still warns that unseen accounts may pause", async () => {
    const { store, bot, fresh } = setup();
    const current = fresh();
    const partial = { gmail: svc(["ca_mail_a", "work"]) };
    const save = (rememberedComplete?: boolean) => applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(current).revision, base: base(current, null), toolkit: "gmail", accountId: "ca_mail_a", level: "none" }, { remembered: partial, ...(rememberedComplete === undefined ? {} : { rememberedComplete }) });
    const answer = await save(false);
    expect(answer.pausedBySave).toContainEqual({ toolkit: "gmail", accountId: null });
  });
  it("P1c: a raise that read a complete settled list does not add an unknown-account warning from a partial remembered list", async () => {
    const { store, bot, fresh } = setup();
    store.patchBot(bot.id, { connectedAppAccess: legacyRestricted(2, fresh(), [{ toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_FETCH_EMAILS"] }]) });
    const current = fresh();
    const only = { slack: svc(["ca_chat_a"]) };
    const partial = { gmail: svc(["ca_mail_a", "work"]) };
    const raise = await applyLevelsAction(store, bot.id, { action: "set-account", revision: botAccessPolicy(current).revision, base: base(current, null), toolkit: "slack", accountId: "ca_chat_a", level: "read" }, { readSettled: settled(only), remembered: partial, rememberedComplete: false });
    expect(raise.pausedBySave).not.toContainEqual({ toolkit: "gmail", accountId: null });
    expect(raise.changed).toBe(true);
  });
  it("W22c: clear-floor removes only that app's Reconnect floor and bumps the revision", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    const seeded = fresh();
    const levels = levelsOf(seeded)!;
    const floor = (toolkit: string) => ({ toolkit, from: ["ca_old"], cap: { level: "read" as const }, accountKey: ["ca_old"], applied: [] });
    commitAccess(store, seeded, botAccessPolicy(seeded), { ...levels, newAccountFloors: [floor("gmail"), floor("slack")] });
    const startRevision = botAccessPolicy(fresh()).revision;
    const answer = await applyLevelsAction(store, bot.id, { action: "clear-floor", revision: startRevision, toolkit: "gmail" }, { remembered: inventory, rememberedComplete: true });
    expect(answer).toMatchObject({ changed: true });
    expect(levelsOf(fresh())!.newAccountFloors?.map((item) => item.toolkit)).toEqual(["slack"]);
    expect(botAccessPolicy(fresh()).revision).toBe(startRevision + 1);
    await expect(applyLevelsAction(store, bot.id, { action: "clear-floor", revision: startRevision, toolkit: "slack" }, { remembered: inventory, rememberedComplete: true })).rejects.toMatchObject({ status: 409, code: "revision" });
  });
  it("W15b: keepCurrent with except never leaves a wider legacy grant behind", async () => {
    const { store, bot, fresh } = setup();
    undo.push(qualifyForTesting([...CONNECTED_APP_TOOLS, ...VERIFIED_READ_TOOLS].map((tool) => ({ toolkit: tool.toolkit, slug: tool.tool }))));
    store.patchBot(bot.id, { connectedAppAccess: legacyRestricted(2, fresh(), [{ toolkit: "gmail", accountId: "ca_mail_a", tools: ["GMAIL_FETCH_EMAILS"] }]) });
    let current = fresh();
    await applyLevelsAction(store, bot.id, { action: "set-switches", revision: 2, base: switchBase(current), newAccounts: "all" }, { remembered: inventory, rememberedComplete: true });
    current = fresh();
    await applyLevelsAction(store, bot.id, { action: "set-switches", revision: botAccessPolicy(current).revision, base: switchBase(current), newAccounts: "none", keepCurrent: true, except: [{ toolkit: "gmail", accountId: "ca_mail_a" }] }, { readSettled: settled(), remembered: inventory });
    expect(levelsOf(fresh())!.accounts.find((entry) => entry.accountId === "ca_mail_a")?.level).toBe("none");
    expect(botAccessPolicy(fresh()).grants.some((grant) => grant.accountId === "ca_mail_a")).toBe(false);
  });
  it("5.2: the status tool passes and a forged _meta is refused on the levels path", async () => {
    const { store, bot, fresh } = setup();
    await setAccount(store, bot, "gmail", "ca_mail_a", "none");
    expect(verdict(fresh(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "CHECK_CONNECTED_APP_ACTION", arguments: {} } })).toBe("ok");
    expect(verdict(fresh(), { ...call([row("SLACK_SEND_MESSAGE", "ca_chat_a")]), params: { ...call([]).params, arguments: { tools: [row("SLACK_SEND_MESSAGE", "ca_chat_a")] }, _meta: { account: "ca_mail_a" } } })).toBe("Unsupported connected-app request fields.");
  });
  it("6.4: a stored result on an account lowered since is withheld; a still-admitted one is handed back", async () => {
    const { store, bot, fresh } = setup();
    allCatalogQualified();
    await setAccount(store, bot, "slack", "ca_chat_a", "full", { tools: ["SLACK_SEND_MESSAGE"] });
    const used = { requirements: [{ tool: "SLACK_SEND_MESSAGE", account: "ca_chat_a" }], complete: true };
    expect(() => assertStoredConnectedAppAccess(fresh(), used, { inventory })).not.toThrow();
    await setAccount(store, bot, "slack", "ca_chat_a", "none");
    expect(() => assertStoredConnectedAppAccess(fresh(), used, { inventory })).toThrow("This bot has no access to this account.");
    expect(() => assertStoredConnectedAppAccess(fresh(), used, { inventory: null })).toThrow(/Couldn't check/);
  });
});
