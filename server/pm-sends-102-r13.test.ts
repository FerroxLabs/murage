// Astra r12 P2 x3 (+ convergence): finished-request recovery work follows PENDING work, never history; a held provider job
// keeps its hold through polling and Files publication.
// (1) shared-result delivery and (2) fan-out recovery read a persisted owed set (room_request_owed), seeded once for existing
// rows and kept current by triggers on every writer; each probe runs against 1k and 100k historical rows and asserts the plan,
// the rows visited and that the one-time backfill does not run again. (3) image-operations: see the last test.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { ImageOperations } from "./image-operations.ts";
import { ImageGenerationService } from "./image-generation.ts";
import { fenceRestoredSql, sqlRowRestoreHeld } from "./restore-fence.ts";
import { roomRequest } from "./room-requests.ts";
import { BACKFILL_NAME, OWED_FANOUT_SQL, OWED_SHARED_SQL, backfillRoomRequestOwed, initializeRoomRequestOwed, settleOwedFanouts, settleOwedSharedResults } from "./room-request-owed.ts";
import { initializeProjectTables } from "./project-tables.ts";

const faults = vi.hoisted(() => ({ saveImage: 0 }));
vi.mock("./attachments.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./attachments.ts")>();
  return { ...actual, saveImage: (...args: Parameters<typeof actual.saveImage>) => {
    if (faults.saveImage > 0) { faults.saveImage--; throw Object.assign(new Error("attachments storage is full"), { status: 507 }); }
    return actual.saveImage(...args);
  } };
});

beforeEach(() => { faults.saveImage = 0; closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

const SIZES = [1_000, 100_000];
const TRIGGERS = ["room_request_owed_classify", "room_request_owed_shared_ins", "room_request_owed_shared_upd", "room_request_owed_shared_clear", "room_request_owed_fanout_ins", "room_request_owed_fanout_upd", "room_request_owed_fanout_child", "room_request_owed_gone"];

const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,outcome_note,result_message_id,created_at,finished_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
function rowInserter(db: DatabaseSync) {
  const stmt = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
  const provenance = db.prepare("INSERT OR REPLACE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  return (id: string, o: { root?: string; parent?: string | null; verb: string; to?: string | null; target?: string | null; state: string; refusal?: string | null; note?: string | null; result?: string | null; at?: number; shared?: boolean }) => {
    if (o.shared) provenance.run(id);   // shared work is recorded as such when it is created (enqueueSharedWork)
    return stmt.run(id, o.root ?? id, o.parent ?? null, "g", o.verb, o.verb === "owner_send" ? "owner" : "bot", o.to ?? null, o.target ?? null, o.state, null, o.refusal ?? null, o.note ?? null, o.result ?? null, o.at ?? 1, o.at ?? 1, "t", `key-${id}`);
  };
}
function fill(db: DatabaseSync, total: number, rows: (i: number) => void): void {
  db.exec("BEGIN");
  try { for (let i = 0; i < total; i++) rows(i); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** The database as 1.0.1 / early 1.0.2 left it: no owed set, no triggers, no backfill record. */
function asOlderRelease(db: DatabaseSync): void {
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec("DELETE FROM room_request_owed; DELETE FROM room_request_backfills");
}
const planOf = (db: DatabaseSync, sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail);
const owedCount = (db: DatabaseSync, kind: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM room_request_owed WHERE kind=?").get(kind) as { n: number }).n);

/** History a long-lived install carries, all of it finished and none of it owing anything, plus the few rows that do. */
function seedHistory(db: DatabaseSync, total: number): void {
  const insert = rowInserter(db);
  fill(db, total, i => {
    const kind = i % 4;
    if (kind === 0) insert(`h-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", refusal: "delivered" });                       // delivered shared result
    else if (kind === 1) insert(`h-${i}`, { verb: "ask", to: "b", target: "tt", state: "done" });                                    // finished, never shared work
    else if (kind === 2) { insert(`h-${i}`, { verb: "owner_send", state: "done", result: `m-${i}` }); insert(`c-${i}`, { root: `h-${i}`, parent: `h-${i}`, verb: "room_turn", to: "b", target: "t", state: "done", refusal: "delivered" }); } // fanned out
    else insert(`h-${i}`, { verb: "owner_send", state: "cancelled" });
  });
  insert("owed-result", { verb: "ask", to: "b", target: "tt", state: "done", at: total + 1, shared: true });
  insert("owed-held", { verb: "ask", to: "b", target: "tt", state: "done", at: total + 2, shared: true });
  insert("unfanned", { verb: "owner_send", state: "done", result: "m-new", at: total + 3 });
  insert("noop-fanout", { verb: "owner_send", state: "done", result: "m-gone", at: total + 4 });
  insert("kept-fanout", { verb: "owner_send", state: "done", result: "m-kept", at: total + 5 });
}

describe("owed shared results and fan-out recovery are flat from 1k to 100k historical rows", () => {
  const runs: Array<{ backfilled: number; backfilledAgain: number; sharedPlan: string[]; fanoutPlan: string[]; sharedFirst: number; sharedSecond: number; fanoutFirst: number; fanoutSecond: number; delivered: string[]; decided: string[]; owedShared: number; owedFanout: number }> = [];
  for (const total of SIZES) {
    it(`${total} historical rows: first start settles the few owed rows, the second start visits only what is still pending`, () => {
      const db = database();
      asOlderRelease(db);
      seedHistory(db, total);
      // first start after the upgrade: tables/triggers exist, backfill seeds them in bounded batches and records completion
      const backfilled = (() => { const before = Date.now(); void before; db.exec("DELETE FROM room_request_backfills"); return backfillRoomRequestOwed(db); })();
      initializeRoomRequestOwed(db);
      const marker = db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME) as { completed: number };
      expect(marker.completed).toBe(1);
      const delivered: string[] = [], decided: string[] = [];
      const shared = () => settleOwedSharedResults(db, {
        held: id => id === "owed-held",
        load: id => roomRequest(db, id) ?? undefined,
        destination: () => "dest", live: () => true, deleted: () => false,
        delivered: () => false,
        deliver: request => { delivered.push(request.id); db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=? AND state IN ('done','failed')").run(request.id); },
      });
      const fanout = () => settleOwedFanouts(db, (row, done) => {
        if (row.id === "kept-fanout") return;                           // a decision not yet possible: stays owed
        decided.push(row.id); done(row.id === "unfanned" ? () => { /* the child requests would be created here */ } : undefined);
      });
      const sharedFirst = shared(), fanoutFirst = fanout();
      // second start: nothing but the real pending rows
      const backfilledAgain = backfillRoomRequestOwed(db);
      initializeRoomRequestOwed(db);
      const sharedSecond = shared(), fanoutSecond = fanout();
      runs.push({
        backfilled, backfilledAgain, sharedPlan: planOf(db, OWED_SHARED_SQL), fanoutPlan: planOf(db, OWED_FANOUT_SQL), sharedFirst, sharedSecond, fanoutFirst, fanoutSecond,
        delivered: delivered.sort(), decided: decided.sort(), owedShared: owedCount(db, "shared_delivery"), owedFanout: owedCount(db, "fanout"),
      });
      const run = runs.at(-1)!;
      expect(run.backfilledAgain).toBe(0);                              // the backfill ran once and records it
      expect(run.delivered).toEqual(["owed-result"]);
      expect(run.sharedSecond).toBe(0);                                 // the held result was pushed an hour out: nothing is due
      expect(run.fanoutSecond).toBe(1);                                 // only the undecided one
      expect(run.owedShared).toBe(1);
      expect(run.owedFanout).toBe(1);
      for (const line of [...run.sharedPlan, ...run.fanoutPlan]) expect(line, line).not.toMatch(/^SCAN (room_requests|o|c|w|room_request_owed)\b/);
      expect(run.fanoutPlan.join(" | ")).toMatch(/SEARCH w USING (COVERING )?INDEX (sqlite_autoindex_room_request_owed_1|room_request_owed_due) \(kind=\?\)|SEARCH w USING PRIMARY KEY/);
      expect(run.sharedPlan.join(" | ")).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_room_request_owed_1|USING PRIMARY KEY/);
    });
  }
  it("the second start does the same work at 1k and at 100k", () => {
    expect(runs).toHaveLength(2);
    const [small, large] = runs as [typeof runs[number], typeof runs[number]];
    expect(large.sharedSecond).toBe(small.sharedSecond);
    expect(large.fanoutSecond).toBe(small.fanoutSecond);
    expect(large.sharedPlan).toEqual(small.sharedPlan);
    expect(large.fanoutPlan).toEqual(small.fanoutPlan);
    expect(large.backfilledAgain).toBe(small.backfilledAgain);
    expect(large.decided.filter(id => !id.startsWith("h-"))).toEqual(small.decided.filter(id => !id.startsWith("h-")));
    // the one-time work is the only thing that follows history: it is bounded and happens once
    expect(large.backfilled).toBeGreaterThan(small.backfilled);
  });
});

describe("the owed set is kept current by the database for every writer", () => {
  it("a shared result enters when the request finishes and leaves when delivered, found cancelled, or deleted", () => {
    const db = database(), insert = rowInserter(db);
    insert("a", { verb: "ask", to: "b", target: "tt", state: "queued", shared: true });
    expect(owedCount(db, "shared_delivery")).toBe(0);
    db.prepare("UPDATE room_requests SET state='done' WHERE id='a'").run();
    expect(owedCount(db, "shared_delivery")).toBe(1);
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id='a'").run();
    expect(owedCount(db, "shared_delivery")).toBe(0);
    insert("b", { verb: "ask", to: "b", target: "tt", state: "failed", shared: true });                 // inserted already terminal
    expect(owedCount(db, "shared_delivery")).toBe(1);
    db.prepare("DELETE FROM room_requests WHERE id='b'").run();
    expect(owedCount(db, "shared_delivery")).toBe(0);
    insert("w", { verb: "wake", to: "b", target: "tt", state: "done" });                  // wakes never owe a shared delivery
    insert("n", { verb: "ask", to: "b", target: null, state: "done" });                   // nowhere to deliver
    expect(owedCount(db, "shared_delivery")).toBe(0);
  });
  it("an owner send enters the fan-out set when done and leaves in the same statement as its first child request", () => {
    const db = database(), insert = rowInserter(db);
    insert("s", { verb: "owner_send", state: "running" });
    expect(owedCount(db, "fanout")).toBe(0);
    db.prepare("UPDATE room_requests SET state='done', result_message_id='m' WHERE id='s'").run();
    expect(owedCount(db, "fanout")).toBe(1);
    insert("child", { root: "s", parent: "s", verb: "room_turn", to: "b", target: "t", state: "queued" });
    expect(owedCount(db, "fanout")).toBe(0);
    // the decision is atomic with its work: a failing child insert rolls the clear back too
    insert("s2", { verb: "owner_send", state: "done", result: "m2" });
    expect(() => settleOwedFanouts(db, (_row, done) => done(() => { throw new Error("boom"); }))).toThrow("boom");
    expect(owedCount(db, "fanout")).toBe(1);
  });
});

describe("the migration is idempotent on existing data", () => {
  it("re-running the initializers on 1.0.1 / 1.0.2 data seeds once and a repeat changes nothing", () => {
    const db = database(), insert = rowInserter(db);
    asOlderRelease(db);
    for (let i = 0; i < 5; i++) insert(`r-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    insert("o", { verb: "owner_send", state: "done", result: "m" });
    initializeProjectTables(db);
    expect(owedCount(db, "shared_delivery")).toBe(5);
    expect(owedCount(db, "fanout")).toBe(1);
    const snapshot = JSON.stringify(db.prepare("SELECT * FROM room_request_owed ORDER BY kind, request_id").all());
    initializeProjectTables(db); initializeProjectTables(db);
    expect(JSON.stringify(db.prepare("SELECT * FROM room_request_owed ORDER BY kind, request_id").all())).toBe(snapshot);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'room_request_owed_%'").get()).toEqual({ n: TRIGGERS.length });
    // the old index is gone: nothing keeps non-shared history indexed
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='room_requests_shared_owed'").get()).toBeUndefined();
  });
  it("an interrupted backfill resumes from its cursor and finishes in bounded batches", () => {
    const db = database(), insert = rowInserter(db);
    asOlderRelease(db);
    for (let i = 0; i < 7; i++) insert(`r-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    db.prepare("INSERT INTO room_request_backfills(name,cursor,completed) VALUES(?,?,0)").run(BACKFILL_NAME, 3);   // 3 rows were done before the stop
    expect(backfillRoomRequestOwed(db, 2)).toBe(4);
    expect(owedCount(db, "shared_delivery")).toBe(4);
    expect(db.prepare("SELECT completed FROM room_request_backfills").get()).toEqual({ completed: 1 });
    expect(backfillRoomRequestOwed(db, 2)).toBe(0);
  });
});

describe("a held provider job keeps its hold through polling and Files publication", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);
  const catalogue = { contract: 1, kind: "image-catalogue", data: [{ id: "flux-image-gpt25-sunburst", operations: ["generate"], maxPromptChars: 32000,
    sizeRule: { kind: "list", sizes: ["1024x1024"] }, qualities: ["high", "xhigh"], qualityMode: "param", maxReferences: 4, supports: { n: 1 }, delivery: { jobs: true }, expectedSeconds: { xhigh: 120 } }] };
  function rig() {
    let pollsWork = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/images/models")) return json(catalogue);
      if (init?.method === "POST") return json({ contract: 1, kind: "image-job", id: "imgjob_42", status: "queued", poll_after_s: 5 }, { status: 202 });
      if (!pollsWork) throw new Error("ECONNRESET");
      return json({ contract: 1, kind: "image-job", id: "imgjob_42", status: "succeeded", data: [{ b64_json: PNG }] });
    });
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })), bot = store.createBot();
    const turn = () => ({ botId: bot.id, threadId: bot.threadId, generation: randomUUID(), signal: new AbortController().signal, assertActive: () => {} });
    const operations = new ImageOperations({ store, waiting: vi.fn() });
    let now = 0;
    const service = new ImageGenerationService({ resolveConnection: () => ({ id: "flux", provider: "flux", apiKey: "FAKE_R13", revision: "1" }), connectionIds: () => ["flux"], fetch: fetcher, fluxCatalogue: true, sleep: async ms => { now += ms; }, now: () => now });
    const request = { connectionId: "flux", model: "flux-image-gpt25-sunburst", quality: "xhigh", prompt: "A slow render" };
    const run = (actor: ReturnType<typeof turn>) => operations.execute(actor, "slow", request, (reserve, publish, context) =>
      service.generate(request, { reserve, publish, assertActive: actor.assertActive, signal: actor.signal, operationId: context.operationId, resumeJob: context.resumeJob, jobStarted: context.jobStarted }));
    const images = () => store.messagesFor(bot.threadId).filter(m => m.role === "bot" && m.attachments?.some(item => item.kind === "image"));
    return { store, bot, turn, operations, run, fetcher, images, polls: (on: boolean) => { pollsWork = on; } };
  }
  async function heldJob() {
    const f = rig();
    const first = f.turn();
    const started = f.run(first), refusal = expect(started).rejects.toMatchObject({ code: "job-uncertain" });
    await vi.waitFor(() => expect(f.store.messagesFor(f.bot.threadId).some(m => m.card?.tool === "generate_image" && !m.card.answered)).toBe(true));
    const card = f.store.messagesFor(f.bot.threadId).find(m => m.card?.tool === "generate_image" && !m.card.answered)!;
    f.operations.resolve(f.bot.threadId, card.card!.requestId!, "allow");
    await refusal;
    const op = database().prepare("SELECT id,state FROM image_operations").get() as { id: string; state: string };
    expect(op.state).toBe("uncertain");
    fenceRestoredSql(database(), "gen-1");
    expect(sqlRowRestoreHeld(database(), "image_operation", op.id)).toBe(true);
    return { f, op };
  }
  it("a polling failure on the owner's re-ask leaves the operation held", async () => {
    const { f, op } = await heldJob();
    await expect(f.run(f.turn())).rejects.toThrow();
    expect(sqlRowRestoreHeld(database(), "image_operation", op.id)).toBe(true);
    expect(f.images()).toHaveLength(0);
  });
  it("a Files/publication failure after a good poll leaves it held; only the fully published image releases it", async () => {
    const { f, op } = await heldJob();
    f.polls(true);
    faults.saveImage = 1;
    await expect(f.run(f.turn())).rejects.toThrow();
    expect(sqlRowRestoreHeld(database(), "image_operation", op.id)).toBe(true);
    expect(f.images()).toHaveLength(0);
    const done = await f.run(f.turn()) as { artifact: { artifactId?: string } };
    expect(done.artifact.artifactId).toBeTruthy();
    expect(sqlRowRestoreHeld(database(), "image_operation", op.id)).toBe(false);
    expect(f.images()).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);   // never a second render
  });
  it("a clean re-ask polls, publishes and then releases the hold", async () => {
    const { f, op } = await heldJob();
    f.polls(true);
    const done = await f.run(f.turn()) as { artifact: { artifactId?: string } };
    expect(done.artifact.artifactId).toBeTruthy();
    expect(sqlRowRestoreHeld(database(), "image_operation", op.id)).toBe(false);
  });
});
