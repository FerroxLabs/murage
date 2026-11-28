// M6 settings from chat: witnesses W1-W18 (designs/settings-chat-1023/DESIGN.md section 7) through the M6 route functions
// index.ts mounts (cardRoute, internalRoute) on a real sqlite card store, the real catalog and the real route-policy gates.
// The writer is a fixture that follows the bot/task writer handlers' order (busy 409, multi-task 409, SV0 stale 409, then one
// save of the setting and its J0 row): it is the producer M6 calls, not the thing under test.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cloudRouteDecision, DESKTOP_ONLY_SENTENCE, routePolicy } from "../route-policy.ts";
import { CHAT_CARD_WRITER, type JournalLookup, type JournalRow, type SettingCardRecord } from "../../shared/settings-chat.ts";
import { buildCatalog, DECLARATIONS, shippedCatalogInputs, writerKey, type CatalogDeclaration, type CatalogInputs, type InventoryRecord } from "./catalog.ts";
import { openCardStore } from "./cards.ts";
import { READERS } from "./readers.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createSettingsChat, innerGate, type CardCaller, type ChatBot, type ThreadPlace, type TurnOrigin, CLOUD_NEEDS_SETTINGS } from "./routes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET_BYTES = "sk-fixture-secret-0000";
const FIXTURE_EMAIL = "owner@example.invalid";

const INVENTORY: InventoryRecord[] = [
  { id: "bot.model", label: "Model", path: "Settings > Bots > Model", scope: "bot", interaction: "immediate" },
  { id: "app.fixtureLanguage", label: "Fixture language", path: "Settings > General > Fixture language", scope: "app", interaction: "immediate" },
  { id: "app.fixtureKey", label: "Fixture API key", path: "Settings > Keys > Fixture API key", scope: "app", interaction: "immediate" },
  { id: "app.accountEmail", label: "Account email", path: "Settings > Account > Email", scope: "app", interaction: "immediate" },
  { id: "app.fixtureConfirm", label: "Fixture confirm switch", path: "Settings > General > Fixture confirm", scope: "app", interaction: "confirm" },
  { id: "app.fixtureCredits", label: "Buy fixture credits", path: "Settings > Billing > Credits", scope: "app", interaction: "immediate" },
  { id: "app.fixtureLifecycle", label: "Fixture archive", path: "Settings > General > Archive", scope: "app", interaction: "immediate" },
  { id: "app.fixtureCodeTier", label: "Fixture code-tier field", path: "Settings > General > Code tier", scope: "app", interaction: "immediate" },
];
const appWriter = (field: string, path = "/api/config") => ({ target: "app" as const, method: "PATCH" as const, path, body: (value: unknown) => ({ [field]: value }), field, surface: "any" as const, chatControl: "FixtureControl" });
const FIXTURE_DECLARATIONS: CatalogDeclaration[] = [
  ...DECLARATIONS,
  { id: "app.fixtureLanguage", writers: [appWriter("language")] },
  { id: "app.fixtureKey", writers: [appWriter("apiKey")], secret: true },
  { id: "app.accountEmail", writers: [appWriter("email")], private: true },
  { id: "app.fixtureConfirm", writers: [appWriter("confirmed")] },
  { id: "app.fixtureCredits", writers: [appWriter("credits")], purchase: true },
  // W10 row 5: a test-only writer field absent from BOT_PATCH_FIELDS, so a remembered owner meets the code tier
  { id: "app.fixtureLifecycle", writers: [appWriter("archived")], lifecycle: true },
  { id: "app.fixtureCodeTier", writers: [{ ...appWriter("notAPlainField", "/api/bots/:botId"), method: "PATCH" }] },
];
const ALL_WRITERS = FIXTURE_DECLARATIONS.flatMap(d => d.writers.map(w => ({ id: d.id, w })));
function inputs(over: Partial<CatalogInputs> = {}): CatalogInputs {
  return {
    inventory: INVENTORY, declarations: FIXTURE_DECLARATIONS, storeBuild: false,
    journalWriters: new Set([CHAT_CARD_WRITER]),
    atomic: new Set(ALL_WRITERS.map(({ id, w }) => writerKey(id, w.target))),
    chatControls: new Set(["BotModelChatControl", "FixtureControl"]),
    routes: new Set(ALL_WRITERS.map(({ w }) => `${w.method} ${w.path}`)),
    expectRoutes: new Set(ALL_WRITERS.map(({ w }) => `${w.method} ${w.path}`)),
    ...over,
  };
}

const LOCAL_DESKTOP: CardCaller = { kind: "local", route: { desktop: true, companion: false, door: false, bot: false }, surface: "desktop" };
const LOCAL_PHONE: CardCaller = { kind: "local", route: { desktop: false, companion: true, door: false, bot: false }, surface: "phone" };
const OWNER_TEXT: TurnOrigin = { ownerText: true, noLimitsOrigin: "owner", depth: 0, internalEvent: false };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world(options: { catalog?: CatalogInputs; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "m6-"));
  if (!options.dir) dirs.push(dir);
  const db = new DatabaseSync(join(dir, "cards.db"));
  const tx = <T,>(op: (d: DatabaseSync) => T): T => {
    if (db.isTransaction) return op(db);
    db.exec("BEGIN IMMEDIATE");
    try { const out = op(db); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const cards = openCardStore(db, tx);
  const state = { bots: new Map<string, ChatBot>(), app: {} as Record<string, unknown>, journal: new Map<string, JournalRow>(), journalMode: "ok" as "ok" | "couldNotCheck",
    busy: new Set<string>(), generations: new Map<string, string>(), origins: new Map<string, TurnOrigin>(), places: new Map<string, ThreadPlace>(),
    posted: [] as Array<{ threadId: string; card?: SettingCardRecord; text?: string }>, writes: [] as Array<{ path: string; body: Record<string, unknown>; changeId: string }> };
  state.bots.set("dax", { id: "dax", name: "Dax", threadId: "th-dax", modelSelection: "model-a", tasks: [] });
  state.bots.set("pepper", { id: "pepper", name: "Pepper", threadId: "th-pepper", modelSelection: "model-p", tasks: [] });
  state.generations.set("th-dax", "1"); state.origins.set("th-dax:1", OWNER_TEXT); state.places.set("th-dax", "owner");
  const commit = (row: Omit<JournalRow, "at">) => state.journal.set(row.changeId, { ...row, at: Date.now() });
  const chat = createSettingsChat({
    cards, catalog: options.catalog ?? inputs(),
    bot: (id) => state.bots.get(id),
    journal: { lookup: (changeId): JournalLookup => state.journalMode === "couldNotCheck" ? { state: "couldNotCheck" } : state.journal.has(changeId) ? { state: "saved", row: state.journal.get(changeId)! } : { state: "notSaved" } },
    activeGeneration: (threadId) => state.generations.get(threadId),
    turnOrigin: (threadId, generation) => state.origins.get(`${threadId}:${generation}`),
    threadPlace: (threadId) => state.places.get(threadId) ?? "other",
    busy: (bot, target) => state.busy.has(target.kind === "task" ? `${bot.id}/${target.taskId}` : bot.id),
    postText: (threadId, text) => state.posted.push({ threadId, text }),
    postCard: (threadId, card) => state.posted.push({ threadId, card }),
    async dispatchWriter({ path, body, expect, changeId }) {
      const task = /^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/.exec(path);
      const botPath = /^\/api\/bots\/([\w-]+)$/.exec(path);
      if (task || botPath) {
        const bot = state.bots.get((task ?? botPath)![1]!)!;
        if (task) {
          const row = bot.tasks!.find(t => t.id === task[2])!;
          if (state.busy.has(`${bot.id}/${row.id}`)) return { status: 409, error: "Stop this thread before changing its settings" };
          if (row.modelSelection !== expect) return { status: 409, stale: true, live: row.modelSelection };
          row.modelSelection = body.modelSelection; state.writes.push({ path, body, changeId });
          commit({ changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "bot.model", bot: bot.id, after: body.modelSelection });
          return { status: 200 };
        }
        if (state.busy.has(bot.id)) return { status: 409, error: "the bot is working: stop it before changing models" };
        if ((bot.tasks?.length ?? 0) > 1) return { status: 409, error: "Choose a thread or edit bot defaults explicitly" };
        if (bot.modelSelection !== expect) return { status: 409, stale: true, live: bot.modelSelection };
        bot.modelSelection = body.modelSelection; state.writes.push({ path, body, changeId });
        commit({ changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "bot.model", bot: bot.id, after: body.modelSelection });
        return { status: 200 };
      }
      const [field, value] = Object.entries(body)[0]!;
      if (state.app[field] !== expect) return { status: 409, stale: true, live: state.app[field] };
      state.app[field] = value; state.writes.push({ path, body, changeId });
      commit({ changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "app.fixtureLanguage", after: value });
      return { status: 200 };
    },
  });
  const internal = (path: "find" | "show", body: unknown, claim = { threadId: "th-dax", botId: "dax", generation: "1" }) =>
    chat.internalRoute({ method: "POST", path: `/api/internal/settings-chat/${path}`, readBody: async () => body }, claim);
  const card = (cardId: string, action: "" | "apply" | "dismiss", body: unknown = {}, request: { mayApprove: boolean; caller: CardCaller } = { mayApprove: true, caller: LOCAL_DESKTOP }) =>
    chat.cardRoute({ method: action ? "POST" : "GET", path: `/api/settings-chat/cards/${cardId}${action ? `/${action}` : ""}`, readBody: async () => body }, request);
  const show = async (ref: Record<string, unknown> = { id: "bot.model", code: "chat" }, claim?: { threadId: string; botId: string; generation: string }) => {
    const answer = await internal("show", { settingRef: ref, reason: "You asked for a cheaper model." }, claim);
    return answer!;
  };
  const snapshot = () => JSON.stringify({ bots: [...state.bots.values()], app: state.app, journal: [...state.journal.keys()], cards: cards.forThread("th-dax").length + cards.forThread("th-pepper").length });
  return { dir, db, cards, state, chat, internal, card, show, snapshot };
}
const cardIdOf = (answer: { body: unknown }) => (answer.body as { cardId: string }).cardId;
const tap = (value: unknown, expectValue: unknown, cardGen = 1, changeId = `change-${Math.random().toString(36).slice(2, 12)}`) => ({ value, expect: expectValue, cardGen, changeId });

describe("M6 settings from chat", () => {
  it("W1: the tool cannot write; apply, extra keys and crafted identity keys are 400 and change nothing", async () => {
    const w = world();
    const before = w.snapshot();
    const bodies: unknown[] = [
      { action: "apply", settingRef: { id: "bot.model" }, value: "model-z" },
      { settingRef: { id: "bot.model", code: "chat" }, reason: "x", value: "model-z" },
      { settingRef: { id: "bot.model", code: "chat" }, reason: "x", apply: true },
      { settingRef: { id: "bot.model", code: "chat" }, reason: "x", thread_id: "th-pepper" },
      { settingRef: { id: "bot.model", code: "chat" }, reason: "x", bot_id: "pepper" },
      { settingRef: { id: "bot.model", code: "chat" }, reason: "x", origin: "desktop" },
      { settingRef: { id: "bot.model", code: "chat", value: "model-z" }, reason: "x" },
    ];
    for (const body of bodies) expect((await w.internal("show", body))!.status).toBe(400);
    expect((await w.internal("find", { query: "model", value: "model-z" }))!.status).toBe(400);
    expect(await w.chat.internalRoute({ method: "POST", path: "/api/internal/settings-chat/apply", readBody: async () => ({}) }, { threadId: "th-dax", botId: "dax", generation: "1" })).toBeNull();
    expect(w.snapshot()).toBe(before);
    // identity comes from the claim only: a valid show lands in the claim's thread, never another
    const ok = await w.show();
    expect(ok.status).toBe(200);
    expect(w.state.posted.map(p => p.threadId)).toEqual(["th-dax"]);
    expect(w.cards.forThread("th-pepper")).toHaveLength(0);
  });

  it("W2: apply and dismiss refuse every caller that fails mayApprove, the dismiss leg included; the owner desktop is 200", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    const before = w.snapshot();
    for (const action of ["apply", "dismiss"] as const) {
      const refused = await w.card(id, action, action === "apply" ? tap("model-c", "model-a") : {}, { mayApprove: false, caller: { kind: "cloud", scope: "browser", surface: "remote" } });
      expect(refused!.status).toBe(403);
    }
    expect(w.snapshot()).toBe(before);
    expect(w.cards.get(id)!.state).toBe("OPEN");
    expect((await w.card(id, "dismiss"))!.status).toBe(200);
    expect(w.cards.get(id)!.outcome).toBe("dismissed");
  });

  it("W3: a value changed elsewhere refuses the stale tap with VALUE_CHANGED and keeps the newer value", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    w.state.bots.get("dax")!.modelSelection = "model-b";
    const answer = await w.card(id, "apply", tap("model-c", "model-a"));
    expect(answer!.status).toBe(409);
    expect(answer!.body).toMatchObject({ code: "VALUE_CHANGED", live: "model-b" });
    expect(w.state.bots.get("dax")!.modelSelection).toBe("model-b");
    expect(w.cards.get(id)!.state).toBe("OPEN");
    expect((await w.card(id, ""))!.body).toMatchObject({ value: "model-b", expect: "model-b" });
  });

  it("W4: a process killed after the writer's commit and before settle reads SETTLED changed after restart, written once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m6-kill-")); dirs.push(dir);
    const child = join(HERE, "testing", "m6-kill-child.ts");
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", child, dir], { encoding: "utf8", timeout: 60_000 });
    expect(run.signal).toBe("SIGKILL");
    // restart: the writer's durable state is the only source; the child's memory is gone
    const disk = JSON.parse(readFileSync(join(dir, "writer.json"), "utf8")) as { settings: Record<string, { modelSelection: string }>; journal: Record<string, JournalRow>; writes: unknown[] };
    const { cardId, changeId } = JSON.parse(readFileSync(join(dir, "card.json"), "utf8")) as { cardId: string; changeId: string };
    const w = world({ dir });
    w.state.bots.get("dax")!.modelSelection = disk.settings.dax!.modelSelection;
    for (const [key, row] of Object.entries(disk.journal)) w.state.journal.set(key, row);
    expect(w.cards.get(cardId)).toMatchObject({ state: "OPEN", pendingChangeId: changeId });
    expect((await w.card(cardId, ""))!.body).toMatchObject({ card: { state: "SETTLED", outcome: "changed", changeId } });
    // the lost 200 is retried with the same changeId and the old expect: a replay, no second write
    const retry = await w.card(cardId, "apply", tap("model-c", "model-a", 1, changeId));
    expect(retry).toMatchObject({ status: 200, body: { ok: true, replay: true } });
    expect(w.state.writes).toHaveLength(0);
    expect(Object.keys(disk.journal)).toEqual([changeId]);
    expect(w.state.bots.get("dax")!.modelSelection).toBe("model-c");
  });

  it("W5: a second show supersedes the first by (id, bot); the old card refuses apply; the new card applies", async () => {
    const w = world();
    const first = cardIdOf(await w.show());
    const second = cardIdOf(await w.show({ id: "bot.model", code: "other-code", item: "x" }));
    expect(w.cards.get(first)).toMatchObject({ state: "SETTLED", outcome: "superseded" });
    const old = await w.card(first, "apply", tap("model-c", "model-a", 1));
    expect(old!.status).toBe(409);
    expect(w.state.writes).toHaveLength(0);
    expect((await w.card(second, "apply", tap("model-c", "model-a", 2)))!.status).toBe(200);
    expect(w.state.bots.get("dax")!.modelSelection).toBe("model-c");
  });

  it("W5b: the apply fence refuses a stale client cardGen and a card superseded while its apply body was read", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    const stale = await w.card(id, "apply", tap("model-c", "model-a", 2));
    expect(stale).toMatchObject({ status: 409, body: { code: "SUPERSEDED" } });
    expect(w.state.writes).toHaveLength(0);
    expect(w.cards.get(id)!.state).toBe("OPEN");
    // a show lands while the apply body is read: cardRoute already holds the OPEN record of the old card
    for (const sentGen of [1, 2]) {
      const r = world();
      const old = cardIdOf(await r.show());
      let newer = "";
      const raced = await r.chat.cardRoute({ method: "POST", path: `/api/settings-chat/cards/${old}/apply`,
        readBody: async () => { newer = cardIdOf(await r.show()); return tap("model-c", "model-a", sentGen); } }, { mayApprove: true, caller: LOCAL_DESKTOP });
      expect({ sentGen, writes: r.state.writes.length, model: r.state.bots.get("dax")!.modelSelection, code: (raced!.body as { code?: string }).code })
        .toEqual({ sentGen, writes: 0, model: "model-a", code: "SUPERSEDED" });
      expect(r.cards.get(newer)).toMatchObject({ state: "OPEN", cardGen: 2 });
    }
  });

  it("W5c: a dismiss that lands while the apply body is read closes the card; the apply writes nothing", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    const raced = await w.chat.cardRoute({ method: "POST", path: `/api/settings-chat/cards/${id}/apply`,
      readBody: async () => { await w.card(id, "dismiss"); return tap("model-c", "model-a", 1); } }, { mayApprove: true, caller: LOCAL_DESKTOP });
    expect({ status: raced!.status, writes: w.state.writes.length, model: w.state.bots.get("dax")!.modelSelection }).toEqual({ status: 409, writes: 0, model: "model-a" });
    expect(w.cards.get(id)).toMatchObject({ state: "SETTLED", outcome: "dismissed" });
  });

  it("W6: a card whose bot was archived refuses apply with WITHDRAWN and settles withdrawn", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    w.state.bots.get("dax")!.archived = true;
    const answer = await w.card(id, "apply", tap("model-c", "model-a"));
    expect(answer!.body).toMatchObject({ code: "WITHDRAWN" });
    expect(w.state.writes).toHaveLength(0);
    expect(w.cards.get(id)).toMatchObject({ state: "SETTLED", outcome: "withdrawn" });
  });

  it("W7: another bot's ref is NOT_THIS_BOT with no card; find returns no other-bot values", async () => {
    const w = world();
    const answer = await w.show({ id: "bot.model", bot: "pepper", code: "chat" });
    expect(answer.body).toMatchObject({ code: "NOT_THIS_BOT" });
    expect(w.cards.forThread("th-dax")).toHaveLength(0);
    const found = JSON.stringify((await w.internal("find", { query: "model" }))!.body);
    expect(found).not.toContain("model-p");
    expect(found).not.toContain("pepper");
  });

  it("W8: only an owner typed depth-0 turn gets a card; every other origin is OWNER_ONLY and find has no values", async () => {
    const others: TurnOrigin[] = (["unproven", "webhook", "routine", "owner-routine", "guest", "other-human", "unattended", "other"] as const)
      .map(noLimitsOrigin => ({ ownerText: noLimitsOrigin === "unproven", noLimitsOrigin, depth: 0, internalEvent: false }));
    others.push({ ...OWNER_TEXT, ownerText: false }, { ...OWNER_TEXT, depth: 1 }, { ...OWNER_TEXT, internalEvent: true }, { ...OWNER_TEXT, ownerText: false, ownerVoice: true });
    for (const origin of others) {
      const w = world();
      w.state.origins.set("th-dax:1", origin);
      expect((await w.show()).body, JSON.stringify(origin)).toMatchObject({ code: "OWNER_ONLY" });
      expect(w.cards.forThread("th-dax")).toHaveLength(0);
      const rows = ((await w.internal("find", { query: "model" }))!.body as { settings: Array<Record<string, unknown>> }).settings;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) { expect(row).not.toHaveProperty("value"); expect(row).not.toHaveProperty("valueNote"); }
    }
    const w = world();
    expect((await w.show()).body).toMatchObject({ ok: true, shown: "inline" });
  });

  it("W9: the catalog predicate: secret, private, confirm, purchase and missing producers are never inline", () => {
    const entries = buildCatalog(inputs());
    const cls = (id: string, target = "app") => entries.find(e => e.id === id && e.target === target)!.class;
    expect(cls("bot.model", "bot")).toBe("inline");
    expect(cls("app.fixtureLanguage")).toBe("inline");
    expect(cls("app.fixtureKey")).toBe("open");
    expect(cls("app.accountEmail")).toBe("open");
    expect(cls("app.fixtureConfirm")).toBe("open");
    expect(cls("app.fixtureCredits")).toBe("open");
    expect(cls("app.fixtureLifecycle")).toBe("open");
    // every registered reader is an id the shipped declarations never mark secret or private (W13)
    for (const id of Object.keys(READERS)) expect(DECLARATIONS.find(d => d.id === id && (d.secret || d.private)), id).toBeUndefined();
    expect(buildCatalog(inputs({ storeBuild: true })).find(e => e.id === "app.fixtureCredits")!.class).toBe("no");
    expect(buildCatalog(inputs({ declarations: DECLARATIONS })).find(e => e.id === "app.fixtureLanguage")!.class).toBe("open");
    for (const missing of ["journalWriters", "atomic", "chatControls", "routes", "expectRoutes"] as const)
      expect(buildCatalog(inputs({ [missing]: new Set() })).find(e => e.id === "bot.model" && e.target === "bot")!.class, missing).toBe("open");
    // Fable M1: per (id, writer target): the task target stays open until its own writer passes W4b
    const botOnly = inputs({ atomic: new Set([writerKey("bot.model", "bot")]) });
    expect(buildCatalog(botOnly).find(e => e.id === "bot.model" && e.target === "task")!.class).toBe("open");
    expect(buildCatalog(botOnly).find(e => e.id === "bot.model" && e.target === "bot")!.class).toBe("inline");
  });

  it("W9b: the shipped catalog file matches the shipped inputs on this branch (no F1, J0, SV0: nothing inline)", () => {
    const shipped = buildCatalog(shippedCatalogInputs({ routeExists: (method, path) => Boolean(routePolicy(method, path)) }));
    const file = JSON.parse(readFileSync(join(HERE, "../../shared/settings-chat-catalog.generated.json"), "utf8")) as { entries: unknown[] };
    expect(file.entries).toEqual(shipped);
    expect(shipped.filter(e => e.class === "inline")).toEqual([]);
  });

  it("W10: the inner gate runs the writer's own gates on the writer body for local and Cloud callers", async () => {
    const bot = DECLARATIONS[0]!.writers[0]!, task = DECLARATIONS[0]!.writers[1]!;
    const body = { modelSelection: "model-c" };
    // (1) local paired phone, bot writer (class desktop): DESKTOP_ONLY, no control, apply 403, unchanged
    const w = world();
    const id = cardIdOf(await w.show());
    expect((await w.card(id, "", {}, { mayApprove: true, caller: LOCAL_PHONE }))!.body).toMatchObject({ control: "open", controlNote: DESKTOP_ONLY_SENTENCE });
    expect((await w.card(id, "apply", tap("model-c", "model-a"), { mayApprove: true, caller: LOCAL_PHONE }))!.status).toBe(403);
    expect(w.state.bots.get("dax")!.modelSelection).toBe("model-a");
    // (2)(3)(4) Cloud rows equal a direct cloudRouteDecision on the writer body, steppedUp=false, context={}
    const rows: Array<[CardCaller & { kind: "cloud" }, boolean]> = [
      [{ kind: "cloud", scope: "owner-phone", surface: "desktop" }, true],
      [{ kind: "cloud", scope: "owner-browser", surface: "desktop" }, true],
      [{ kind: "cloud", scope: "browser", surface: "desktop" }, false],
    ];
    for (const [caller, allowed] of rows) {
      expect(cloudRouteDecision("PATCH", "/api/bots/dax", caller.scope, body, false, {}) === "allow").toBe(allowed);
      expect(innerGate(bot, "/api/bots/dax", body, caller).allow, caller.scope).toBe(allowed);
      const calls: unknown[][] = [];
      innerGate(bot, "/api/bots/dax", body, caller, ((...args: Parameters<typeof cloudRouteDecision>) => { calls.push(args); return cloudRouteDecision(...args); }) as typeof cloudRouteDecision);
      expect(calls).toEqual([["PATCH", "/api/bots/dax", caller.scope, body, false, {}]]);
    }
    const w2 = world();
    const id2 = cardIdOf(await w2.show());
    expect((await w2.card(id2, "apply", tap("model-c", "model-a"), { mayApprove: true, caller: rows[2]![0] }))!.body).toMatchObject({ code: "NEEDS_SETTINGS", error: CLOUD_NEEDS_SETTINGS });
    expect((await w2.card(id2, "apply", tap("model-c", "model-a"), { mayApprove: true, caller: rows[0]![0] }))!.status).toBe(200);
    // (5) remembered owner on a code-tier field: not allow; the gate uses the writer body, not {}
    const codeTier = FIXTURE_DECLARATIONS.find(d => d.id === "app.fixtureCodeTier")!.writers[0]!;
    expect(cloudRouteDecision("PATCH", "/api/bots/dax", "remembered-owner", { notAPlainField: 1 }, false, {})).not.toBe("allow");
    expect(innerGate(codeTier, "/api/bots/dax", { notAPlainField: 1 }, { kind: "cloud", scope: "remembered-owner", surface: "desktop" }).allow).toBe(false);
    // (6) local paired phone in task thread T1 of a two-task bot: the task writer's surface rule refuses
    const w3 = world();
    const dax = w3.state.bots.get("dax")!;
    dax.tasks = [{ id: "t1", threadId: "th-t1", modelSelection: "model-t1" }, { id: "t2", threadId: "th-t2", modelSelection: "model-t2" }];
    w3.state.generations.set("th-t1", "1"); w3.state.origins.set("th-t1:1", OWNER_TEXT); w3.state.places.set("th-t1", "owner");
    const t1 = cardIdOf(await w3.show(undefined, { threadId: "th-t1", botId: "dax", generation: "1" }));
    expect(innerGate(task, "/api/bots/dax/tasks/t1", body, LOCAL_PHONE)).toEqual({ allow: false, error: DESKTOP_ONLY_SENTENCE });
    expect((await w3.card(t1, "", {}, { mayApprove: true, caller: LOCAL_PHONE }))!.body).toMatchObject({ control: "open", controlNote: DESKTOP_ONLY_SENTENCE });
    expect((await w3.card(t1, "apply", tap("model-c", "model-t1"), { mayApprove: true, caller: LOCAL_PHONE }))!.status).toBe(403);
    expect(dax.tasks[0]!.modelSelection).toBe("model-t1");
  });

  it("W11: in a Store build a purchase id is absent from find and show is refused", async () => {
    const w = world({ catalog: inputs({ storeBuild: true }) });
    const rows = JSON.stringify((await w.internal("find", { query: "credits" }))!.body);
    expect(rows).not.toContain("app.fixtureCredits");
    expect((await w.show({ id: "app.fixtureCredits", code: "chat" })).body).toMatchObject({ code: "NO_HOME" });
    expect(w.cards.forThread("th-dax")).toHaveLength(0);
  });

  it("W12: a card change writes a J0 row as the owner with writer chat-card; cardByChangeId names the card's bot, app-level too", async () => {
    const w = world();
    const id = cardIdOf(await w.show({ id: "app.fixtureLanguage", code: "chat" }));
    const change = tap("es", undefined);
    expect((await w.card(id, "apply", change))!.status).toBe(200);
    expect(w.state.journal.get(change.changeId)).toMatchObject({ actor: { kind: "owner" }, writer: CHAT_CARD_WRITER });
    expect(w.state.journal.get(change.changeId)!.bot).toBeUndefined();
    expect(w.cards.cardByChangeId(change.changeId)).toEqual({ cardId: id, botId: "dax" });
  });

  it("W13: secret and private ids return no value and no tool output carries the fixture secret or email", async () => {
    const w = world();
    w.state.app.apiKey = SECRET_BYTES; w.state.app.email = FIXTURE_EMAIL;
    const outputs = [await w.internal("find", { query: "key" }), await w.internal("find", { query: "email account" }),
      await w.show({ id: "app.fixtureKey", code: "chat" }), await w.show({ id: "app.accountEmail", code: "chat" })].map(a => JSON.stringify(a!.body));
    for (const out of outputs) { expect(out).not.toContain(SECRET_BYTES); expect(out).not.toContain(FIXTURE_EMAIL); }
    const rows = (JSON.parse(outputs[0]!) as { settings: Array<Record<string, unknown>> }).settings.concat((JSON.parse(outputs[1]!) as { settings: Array<Record<string, unknown>> }).settings);
    for (const row of rows) expect(row).not.toHaveProperty("value");
  });

  it("W15: channel and group threads get text only, no card record, and a guessed id is 404", async () => {
    for (const place of ["channel", "group"] as const) {
      const w = world();
      w.state.places.set("th-dax", place);
      const answer = await w.show();
      expect(answer.body).toMatchObject({ ok: true, shown: "text" });
      expect(answer.body).not.toHaveProperty("cardId");
      expect(w.cards.forThread("th-dax")).toHaveLength(0);
      expect(w.state.posted[0]!.text).toContain("Settings > Bots > Model");
      expect((await w.card("guessed-card-id", "apply", tap("model-c", "model-a")))!.status).toBe(404);
    }
  });

  it("W16: a dropped 200 retried with the same changeId and old expect replays; couldNotCheck is 503 and writes nothing", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    const change = tap("model-c", "model-a");
    expect((await w.card(id, "apply", change))!.status).toBe(200);
    const retry = await w.card(id, "apply", change);
    expect(retry!.status).toBe(200);
    expect(retry!.body).toMatchObject({ ok: true, replay: true });
    expect(w.state.writes).toHaveLength(1);
    expect(w.state.journal.size).toBe(1);
    // the reply lost and the card not yet settled (J0 has the row): dedupe before expect
    const w2 = world();
    const id2 = cardIdOf(await w2.show());
    const lost = tap("model-c", "model-a");
    w2.state.bots.get("dax")!.modelSelection = "model-c";
    w2.state.journal.set(lost.changeId, { changeId: lost.changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "bot.model", bot: "dax", at: 1 });
    const replay = await w2.card(id2, "apply", lost);
    expect(replay!.status).toBe(200);
    expect(w2.cards.get(id2)).toMatchObject({ state: "SETTLED", outcome: "changed", changeId: lost.changeId });
    expect(w2.state.writes).toHaveLength(0);
    // couldNotCheck: 503, no write, card OPEN
    const w3 = world();
    const id3 = cardIdOf(await w3.show());
    w3.state.journalMode = "couldNotCheck";
    const checking = await w3.card(id3, "apply", tap("model-c", "model-a"));
    expect(checking!.status).toBe(503);
    expect(checking!.body).toMatchObject({ code: "COULD_NOT_CHECK" });
    expect(w3.state.writes).toHaveLength(0);
    expect(w3.cards.get(id3)!.state).toBe("OPEN");
    // self-review D2: the write landed, the reply was lost, then the card was superseded: the retry still replays 200
    const w4 = world();
    const id4 = cardIdOf(await w4.show());
    const landed = tap("model-c", "model-a");
    w4.cards.setPending(id4, landed.changeId);
    w4.state.journal.set(landed.changeId, { changeId: landed.changeId, actor: { kind: "owner" }, writer: CHAT_CARD_WRITER, settingId: "bot.model", bot: "dax", at: 1 });
    await w4.show();
    const late = await w4.card(id4, "apply", landed);
    expect(late!.status).toBe(200);
    expect(w4.cards.cardByChangeId(landed.changeId)).toEqual({ cardId: id4, botId: "dax" });
  });

  it("W17: a stale generation posts nothing; a fourth show in one turn is refused and the next turn's first is admitted", async () => {
    const w = world();
    w.state.generations.set("th-dax", "2"); w.state.origins.set("th-dax:2", OWNER_TEXT);
    expect((await w.show())!.status).toBe(401);
    expect(w.cards.forThread("th-dax")).toHaveLength(0);
    const claim2 = { threadId: "th-dax", botId: "dax", generation: "2" };
    for (const id of ["bot.model", "app.fixtureLanguage", "app.fixtureConfirm"]) expect((await w.show({ id, code: "chat" }, claim2)).status).toBe(200);
    expect((await w.show({ id: "app.fixtureKey", code: "chat" }, claim2)).body).toMatchObject({ code: "CARD_CAP" });
    w.state.generations.set("th-dax", "3"); w.state.origins.set("th-dax:3", OWNER_TEXT);
    expect((await w.show({ id: "app.fixtureKey", code: "chat" }, { ...claim2, generation: "3" })).status).toBe(200);
  });

  it("W17c: the production turn generation (InternalCapabilities, a UUID string) round-trips on the card and fences the per-turn cap", async () => {
    // Astra 1fbb27906d High: index.ts passes internalClaim.generation / activeGeneration() (strings) straight through (WIRING.md).
    const w = world();
    const caps = new InternalCapabilities();
    const first = caps.begin("dax", "th-dax");
    w.state.generations.set("th-dax", caps.activeGeneration("th-dax")!); w.state.origins.set(`th-dax:${first}`, OWNER_TEXT);
    const claim = { threadId: "th-dax", botId: "dax", generation: first };
    const shown = await w.show(undefined, claim);
    expect(shown.status).toBe(200);
    expect(w.cards.get(cardIdOf(shown))!.generation).toBe(first);
    for (const id of ["app.fixtureLanguage", "app.fixtureConfirm"]) expect((await w.show({ id, code: "chat" }, claim)).status).toBe(200);
    expect((await w.show({ id: "app.fixtureKey", code: "chat" }, claim)).body).toMatchObject({ code: "CARD_CAP" });
    const next = caps.begin("dax", "th-dax");
    w.state.generations.set("th-dax", caps.activeGeneration("th-dax")!); w.state.origins.set(`th-dax:${next}`, OWNER_TEXT);
    expect((await w.show(undefined, claim)).status).toBe(401);
    const admitted = await w.show({ id: "app.fixtureKey", code: "chat" }, { ...claim, generation: next });
    expect(admitted.status).toBe(200);
    expect(w.cards.get(cardIdOf(admitted))!.generation).toBe(next);
  });

  it("W18: busy keeps the card OPEN with the writer's sentence; a two-task bot changes only T1; its direct thread is open with no picker", async () => {
    const w = world();
    const id = cardIdOf(await w.show());
    w.state.busy.add("dax");
    expect((await w.card(id, ""))!.body).toMatchObject({ control: "inline", busy: true });
    const busy = await w.card(id, "apply", tap("model-c", "model-a"));
    expect(busy!.status).toBe(409);
    expect(busy!.body).toMatchObject({ code: "WRITER_REFUSED", error: "the bot is working: stop it before changing models" });
    expect(w.cards.get(id)!.state).toBe("OPEN");
    w.state.busy.delete("dax");
    expect((await w.card(id, "apply", tap("model-c", "model-a")))!.status).toBe(200);
    // (b) two tasks: the T1 card writes T1 only, via the task writer, never settingsScope
    const w2 = world();
    const dax = w2.state.bots.get("dax")!;
    dax.tasks = [{ id: "t1", threadId: "th-t1", modelSelection: "model-t1" }, { id: "t2", threadId: "th-t2", modelSelection: "model-t2" }];
    w2.state.generations.set("th-t1", "1"); w2.state.origins.set("th-t1:1", OWNER_TEXT); w2.state.places.set("th-t1", "owner");
    const t1 = cardIdOf(await w2.show(undefined, { threadId: "th-t1", botId: "dax", generation: "1" }));
    expect((await w2.card(t1, "apply", tap("model-c", "model-t1")))!.status).toBe(200);
    expect([dax.modelSelection, dax.tasks[0]!.modelSelection, dax.tasks[1]!.modelSelection]).toEqual(["model-a", "model-c", "model-t2"]);
    expect(w2.state.writes.map(x => [x.path, Object.keys(x.body)])).toEqual([["/api/bots/dax/tasks/t1", ["modelSelection"]]]);
    // (c) Opus r2 H1: the direct thread of a two-task bot is open, no picker; a forced apply is 403 and reaches no writer
    const direct = cardIdOf(await w2.show());
    expect((await w2.card(direct, ""))!.body).toMatchObject({ control: "open" });
    const forced = await w2.card(direct, "apply", tap("model-z", "model-a"));
    expect(forced!.status).toBe(403);
    expect(w2.state.writes).toHaveLength(1);
    expect([dax.modelSelection, dax.tasks[0]!.modelSelection, dax.tasks[1]!.modelSelection]).toEqual(["model-a", "model-c", "model-t2"]);
  });
});

