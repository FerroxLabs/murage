// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (MAIN-RULING SQLITE-1022 item 1a, "witness per site"; owner: q1022-sqlite-opus). One row per memory site that removes
// owner-visible text on messages.db's server connection: the real entry point runs on the real handle (database()), and every row it
// removes or rewrites in the probed table is written while that connection is at secure_delete=ON (testing/secure-delete-probe.ts).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { probeSecureDelete, type SecureDeleteProbe } from "../testing/secure-delete-probe.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { forgetBotLearningData } from "./evolution-forgetting.ts";
import { forgetMemory } from "./forget.ts";
import { deletePipRecord } from "./identity.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { INLINE_REVOCATION, memoryRevocationIdle, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { applyRecordTombstone } from "./restore.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { SCRUB_PASS_TABLE, setScrubLogClearer, setScrubRewriteFinisher, stepScrubPass } from "./scrub-pass.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const inline = { ...INLINE_REVOCATION };
let probes: SecureDeleteProbe[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); setScrubLogClearer(async () => true); setScrubRewriteFinisher(null); });
useOutsideStoreFixture();
afterEach(() => { for (const probe of probes) probe.stop(); probes = []; stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); setScrubRewriteFinisher(null); setScrubLogClearer(null); closeDatabase(); });

const watch = (table: string, on: "DELETE" | { update: string } = "DELETE") => { const probe = probeSecureDelete(database(), table, on); probes.push(probe); return probe; };
const modes = () => probes.flatMap(probe => probe.modes);
/** The same probe on INSERT (a site whose only own writes there are inserts: the bot deletion's deny rows). */
function watchInsert(table: string) {
  const db = database(), name = `sd_probe_insert_${table}`, seen: number[] = [];
  db.function(name, () => { seen.push(Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete)); return null; });
  db.exec(`CREATE TEMP TRIGGER ${name} AFTER INSERT ON main.${table} BEGIN SELECT ${name}(); END`);
  probes.push({ modes: seen, stop: () => { try { db.exec(`DROP TRIGGER IF EXISTS temp.${name}`); } catch { /* handle closed */ } } });
}

/** backfill-ancestry.test.ts: an owner record with its source (bot "bot", thread "chat"). */
function ownerRecord(): string {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  const access = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  const text = "The harbour gate code is ZQX-site-marker.";
  storeAnchorMessage(database(), "older", "m1", text, "user", 1);
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
/** learning-forgetting.test.ts seed(): sources a and b, lessons resting on them (bot "bot", thread "thread"). */
function learning() {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] });
  transaction(db => { for (const id of ["a", "b"]) captureSource(db, { id, threadId: "thread", messageId: `m-${id}`, kind: "text", speaker: "owner", outcome: "recorded", text: `words ${id}` }); });
  const db = database();
  const lesson = (id: string, state: string, source: string) => db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,evidence,created_at) VALUES(?,1,'bot','bot','note','be brief','feedback',?,?,1)").run(id, state, JSON.stringify([{ kind: "source", id: source, revision: 1 }]));
  lesson("applied", "active", "a"); lesson("pending", "suggested", "a"); lesson("other", "active", "b");
  db.prepare("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,correction,state,scope,created_at) VALUES('fa','bot','thread','m-a','-',2,'too long','lesson','bot',1)").run();
}
/** pip-p2-b1.test.ts synthetic(): one PIP row of `kind` in bot "moss"'s scope. */
function pipRow(kind: string): { id: string; scopeId: string } {
  reconcileMemoryRoster({ bots: [{ id: "moss", threadId: "private" }], groups: [] });
  const scopeId = String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key='moss'").get()!.id);
  const id = `identity:synthetic-${kind}-d`;
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'assistant-inference','active',0,?,NULL,NULL,?)").run(id, scopeId, kind, `A ${kind} row ZQX-site-marker.`, Date.now(), Date.now());
  database().prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis='pip:self; test row' WHERE record_id=? AND record_version=1").run(id);
  return { id, scopeId };
}
/** scrub-pass.test.ts legacyFile(): a file as 1.0.3 left it, number-bearing text in records and source payloads, no scrub row. */
function legacyFile() {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] });
  const RAW = "Card 4111 1111 1111 1111 for travel, account ending 4471."; // secret-scan: fixture
  const db = database();
  captureSource(db, { id: "legacy", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text: RAW });
  let job = "";
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) { job = work.id; publishMemoryWork(work, "fixture", captureWork(work)); }
  refreshMemoryCheckpoint(job);
  for (const row of db.prepare("SELECT rowid AS rid,payload FROM memory_source_versions").all()) {
    const payload = JSON.parse(String(row.payload)); payload.text = RAW;
    db.prepare("UPDATE memory_source_versions SET payload=? WHERE rowid=?").run(JSON.stringify(payload), Number(row.rid));
  }
  db.prepare("UPDATE memory_records SET text=? WHERE kind='source'").run(RAW);
  db.prepare(`DELETE FROM ${SCRUB_PASS_TABLE}`).run();
}

interface Site { site: string; at: string; run(): void | Promise<void> }
const SITES: Site[] = [
  { site: "forgetMemory (owner forget of a record)", at: "memory/forget.ts forgetInTransaction", run: () => {
    const record = ownerRecord();
    watch("memory_records", { update: "text" });
    forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  } },
  { site: "deletePipRecord (owner continuity delete)", at: "memory/identity.ts deletePipRecord", run: () => {
    const { id, scopeId } = pipRow("concern");
    watch("memory_records", { update: "text" });
    expect(deletePipRecord(id, scopeId, 1)).toEqual({ id, deleted: true });
  } },
  { site: "archiveMemoryRecord (owner archive)", at: "memory/retention.ts transition", run: () => {
    const record = ownerRecord();
    watch("memory_records", { update: "state" });
    archiveMemoryRecord(ownerMemoryTicket(), record, 1);
  } },
  { site: "applyRecordTombstone (record tombstone)", at: "memory/restore.ts applyRecordTombstone", run: () => {
    const record = ownerRecord();
    watch("memory_records", { update: "text" });
    transaction(db => applyRecordTombstone(db, record));
  } },
  { site: "stepScrubPass (scrub rewrite of stored text)", at: "memory/scrub-pass.ts walkSlice", run: () => {
    legacyFile();
    watch("memory_records", { update: "text" }); watch("memory_source_versions", { update: "payload" });
    const db = database();
    for (let n = 0; n < 10_000; n++) { const step = stepScrubPass(db, { budgetMs: 1_000 }); if (step.phase === "settle" || !step.more) return; }
    throw new Error("the scrub did not reach its settle");
  } },
  { site: "store.deleteBot (captureBotDeletion: deny rows)", at: "store.ts deleteBot", run: () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const bot = store.createBot();
    reconcileMemoryRoster({ bots: [{ id: bot.id, threadId: bot.threadId }], groups: [] });
    watchInsert("memory_deny"); // captureBotDeletion's own rows (the roster save before it rewrites bindings in its own FAST commit)
    store.deleteBot(bot.id);
  } },
  { site: "revocation job (purges learning text after a forget)", at: "memory/memory-revocation.ts tickOnce", run: async () => {
    learning();
    Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 }); // everything deferred to the durable job
    forgetMemory(ownerMemoryTicket(), { kind: "source", id: "a" });
    watch("memory_lessons", { update: "text" });
    wakeMemoryRevocation(() => database(), { retryMs: 20 });
    await memoryRevocationIdle();
  } },
  { site: "forgetBotLearningData (Forget this learning data)", at: "memory/evolution-forgetting.ts forgetBotLearningData", run: () => {
    learning();
    watch("memory_lessons"); watch("memory_feedback");
    transaction(db => forgetBotLearningData(db, DATA_DIR, "bot"));
  } },
];

it.each(SITES.map(row => [row.site, row] as const))("W1a-SITE-MEM %s: every row it removes or rewrites is written at secure_delete=ON", { timeout: 60_000 }, async (_name, row) => {
  await row.run();
  expect(modes().length, `${row.site} reached its delete (${row.at})`).toBeGreaterThan(0);
  expect(modes(), `${row.site} (${row.at}) ran at secure_delete=ON (1), not FAST (2)`).toEqual(modes().map(() => 1));
});
