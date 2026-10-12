// The replay verdict cache is kept across writes a verdict does not rest on (a message, a receipt
// with no outputs, a checkpoint version, a notebook poll) and is dropped at once by the ones it does
// rest on (a forgotten record or source, a tombstone, a policy revision, a deletion epoch, a record's
// state, a receipt that lists the reply). Work is counted in lineage rows read, which no machine changes.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { linkMemoryDisclosureOutput } from "./disclosures.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld, keptVerdictCount, recordRestsOnWithheldMessage, replayExclusions, replayRowsRead, sessionLineageBad, setVerdictLimitForTest } from "./replay-lineage.ts";
import { threadCheckpointId } from "./checkpoints.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { setMemoryMode } from "./repository.ts";
import type { Message } from "../store.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
/** A record from an owner message, a reply made with it, and the reply's verdict already cached. */
async function seeded() {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  receipt.accepted(); receipt.noteLookup([{ id: record, version: 1, evidence: [] }], turn); receipt.output("reply-1");
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
  return { record, turn };
}
/** Rows the lineage reads for one more ask of the cached verdict. */
const cost = () => { const before = replayRowsRead(); const withheld = capturedMessageWithheld("chat", "reply-1"); return { withheld, rows: replayRowsRead() - before }; };

it("two asks with an unrelated message, a new receipt, a checkpoint version and a notebook-style write between them reuse the cache", async () => {
  const { turn } = await seeded();
  expect(cost()).toEqual({ withheld: false, rows: 0 });
  appendMessage("older", { id: "unrelated", role: "user", kind: "text", text: "Something else entirely.", at: 5 } as Message);
  const another = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty), turn, "engine");
  another.accepted();
  database().prepare("INSERT INTO memory_scope_bindings VALUES('notebook-link:x',(SELECT id FROM memory_scopes LIMIT 1),'system','notebook-link',0,'granted','{}')").run();
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
  writeFileSync(`${DATA_DIR}/unrelated.txt`, "x");
  expect(cost()).toEqual({ withheld: false, rows: 0 });
});

it.each([
  ["a forgotten record", (ctx: { record: string }) => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: ctx.record }); }, true],
  ["a forgotten source", () => { forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:older:m1" }); }, true],
  ["a tombstone", (ctx: { record: string }) => { database().prepare("INSERT INTO memory_tombstones VALUES('t1','record',?,NULL,NULL,1,'forgotten',1)").run(ctx.record); }, true],
  ["a deleted source", () => { database().prepare("UPDATE memory_sources SET state='deleted' WHERE id='message:older:m1'").run(); }, true],
  ["a superseded record", (ctx: { record: string }) => { database().prepare("UPDATE memory_records SET state='superseded' WHERE id=?").run(ctx.record); }, true],
  ["a receipt that lists the reply and cites the forgotten record", (ctx: { record: string }) => {
    database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('bad','chat','d',?,'[]','[\"reply-1\"]',0,0,0,'delivered',9)")
      .run(JSON.stringify([{ id: ctx.record, version: 99 }]));
  }, true],
  ["a policy revision", () => { database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1"); }, false],
  ["a deletion epoch", () => { database().exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1"); }, false],
])("%s drops the cached verdict at once", async (_name, change, expected) => {
  const ctx = await seeded();
  expect(cost().rows).toBe(0);
  change(ctx);
  const after = cost();
  expect(after.withheld).toBe(expected);
  expect(after.rows).toBeGreaterThan(0);  // judged again, not served from the cache
});

it("a record is checked once for a bundle that hydrates it twice", async () => {
  const { record } = await seeded();
  recordRestsOnWithheldMessage(record, 1);
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { recordRestsOnWithheldMessage(record, 1); } finally { (db as any).prepare = real; }
  expect(seen.filter(sql => sql.includes("WITH RECURSIVE chain"))).toEqual([]);
});

it("bundle output for a seeded set is the same cold, warm and after unrelated writes", async () => {
  const { record, turn } = await seeded();
  const snapshot = async () => { const bundle = await buildMemoryBundle("alarm", turn, { async search() { return { hits: [{ id: record, version: 1, score: 1, lexical: true }], vectorRows: 1, coverageComplete: true }; } }); return JSON.stringify({ text: bundle.text, records: bundle.recordVersions, sources: bundle.sourceVersions, pinned: bundle.pinned.length, withheld: bundle.withheldPins ?? [] }); };
  const cold = await snapshot();
  appendMessage("older", { id: "unrelated", role: "user", kind: "text", text: "Unrelated.", at: 6 } as Message);
  const warm = await snapshot();
  expect(warm).toBe(cold);
  if (process.env.LINEAGE_SNAPSHOT_OUT) writeFileSync(process.env.LINEAGE_SNAPSHOT_OUT, cold.replace(/bundle:[0-9a-f-]+/g, "bundle"));
});

// perf102 F3: what a verdict rests on, and nothing else, drops it.
const rowsFor = (thread: string, message: string) => { const before = replayRowsRead(); const withheld = capturedMessageWithheld(thread, message); return { withheld, rows: replayRowsRead() - before }; };
function receipt(id: string, records: Array<{ id: string; version: number }>, sources: Array<{ id: string; revision: number }>, outputs: string[]) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','d',?,?,?,0,0,0,'delivered',9)")
    .run(id, JSON.stringify(records), JSON.stringify(sources), JSON.stringify(outputs));
}
/** The thread's own checkpoint at version 1, and a reply whose receipt cited it, its verdict cached. */
function checkpointed() {
  const scope = String(database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  const id = threadCheckpointId(scope, "chat");
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'checkpoint','Working evidence.','assistant-inference','active',0,1,NULL,NULL,1)").run(id, scope);
  receipt("ck-1", [{ id, version: 1 }], [], ["reply-2"]);
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(false);
  expect(rowsFor("chat", "reply-2").rows).toBe(0);
  return { id, scope };
}
const roll = (id: string, scope: string, version: number) => {
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(id, version);
  database().prepare("INSERT INTO memory_records VALUES(?,?,?,'checkpoint','Working evidence.','assistant-inference','active',0,1,NULL,NULL,1)").run(id, version + 1, scope);
};

it("a checkpoint roll (every captured message) keeps a verdict that cites the thread's own checkpoint", () => {
  const { id, scope } = checkpointed();
  roll(id, scope, 1); roll(id, scope, 2);
  expect(rowsFor("chat", "reply-2")).toEqual({ withheld: false, rows: 0 });
});

it.each([
  ["the checkpoint archived with no successor", (id: string) => { database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=2").run(id); }],
  ["the cited version pinned by the owner", (id: string) => { database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=1").run(id); }],
  ["the cited version deleted", (id: string) => { database().prepare("UPDATE memory_records SET state='deleted' WHERE id=? AND version=1").run(id); }],
])("after a roll, %s drops the verdict at once", (_name, change) => {
  const { id, scope } = checkpointed();
  roll(id, scope, 1);
  expect(rowsFor("chat", "reply-2").rows).toBe(0);
  change(id);
  const after = rowsFor("chat", "reply-2");
  expect(after.withheld).toBe(true);
  expect(after.rows).toBeGreaterThan(0);
});

it("a turn settling and an unrelated source's new revision keep the verdict; a new revision of a source it rests on drops it", async () => {
  recordMemorySettlement("older", "t1", "working");
  await seeded();
  recordMemorySettlement("older", "t1", "completed");
  captureSource(database(), { id: "message:older:m2", threadId: "older", messageId: "m2", kind: "text", speaker: "owner", outcome: "recorded", text: "Unrelated." });
  database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id='message:older:m2'").run();
  expect(cost()).toEqual({ withheld: false, rows: 0 });
  database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id='message:older:m1'").run();
  const after = cost();
  expect(after.withheld).toBe(true);
  expect(after.rows).toBeGreaterThan(0);
});

it("a reply resting on another reply's verdict is dropped with it", async () => {
  const { record } = await seeded();
  captureSource(database(), { id: "message:chat:reply-1", threadId: "chat", messageId: "reply-1", kind: "text", speaker: "bot", outcome: "recorded", text: "The code is noted." });
  receipt("on-reply-1", [], [{ id: "message:chat:reply-1", revision: 1 }], ["reply-3"]);
  expect(capturedMessageWithheld("chat", "reply-3")).toBe(false);
  expect(rowsFor("chat", "reply-3").rows).toBe(0);
  // reply-1's record superseded: reply-1's verdict goes, and reply-3's with it
  database().prepare("UPDATE memory_records SET state='superseded' WHERE id=?").run(record);
  const after = rowsFor("chat", "reply-3");
  expect(after.withheld).toBe(true);
  expect(after.rows).toBeGreaterThan(0);
});

it("a verdict judged after the first prepares none of the lineage statements again", async () => {
  const { record } = await seeded();
  receipt("another", [{ id: record, version: 1 }], [], ["reply-4"]);
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { expect(capturedMessageWithheld("chat", "reply-4")).toBe(false); } finally { (db as any).prepare = real; }
  expect(seen.filter(sql => sql.includes("memory_disclosure_outputs") || sql.includes("memory_evidence"))).toEqual([]);
});

it("inside a transaction the cache serves until the transaction writes something a verdict rests on", async () => {
  const { record } = await seeded();
  const db = database();
  db.exec("BEGIN");
  try {
    expect(cost()).toEqual({ withheld: false, rows: 0 });
    db.prepare("UPDATE memory_records SET state='superseded' WHERE id=?").run(record);
    const inside = cost();
    expect(inside.withheld).toBe(true);
    expect(inside.rows).toBeGreaterThan(0);
  } finally { db.exec("ROLLBACK"); }
  // rolled back: the committed state holds, and so does its verdict
  expect(cost().withheld).toBe(false);
});

it("a reply is written to two receipts of its session, and still rests on every receipt of the session made before it", async () => {
  const { record } = await seeded();
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','grok','S',?,'[]','[]',0,0,0,'delivered',?)");
  insert.run("S-1", JSON.stringify([{ id: record, version: 1 }]), 100);
  for (let n = 2; n <= 40; n++) insert.run(`S-${n}`, "[]", 100 + n);
  linkMemoryDisclosureOutput("S-40", "late-reply");
  // only the reply's own receipt (the newest) was written
  const written = database().prepare("SELECT bundle_id FROM memory_disclosures WHERE native_session='S' AND output_message_ids LIKE '%late-reply%'").all().map(row => String(row.bundle_id));
  expect(written).toEqual(["S-40"]);
  expect(capturedMessageWithheld("chat", "late-reply")).toBe(false);
  // a receipt made later in the session is not one it rests on
  insert.run("S-41", JSON.stringify([{ id: "gone", version: 1 }]), 200);
  expect(replayExclusions("chat", [{ id: "late-reply" }], null).size).toBe(0);
  // what the session's first receipt cited changes: the reply is withheld
  database().prepare("UPDATE memory_records SET state='superseded' WHERE id=?").run(record);
  expect(capturedMessageWithheld("chat", "late-reply")).toBe(true);
});

// review r102-mem P1: making room for a verdict dropped the older verdict the new one rested on before the new one was
// registered under it, so a later change to what the older one rested on never reached the new one.
it.each([[0], [1], [2], [3]])("at the capacity boundary (%i entries spare) a reply resting on a kept reply is still withheld once the record behind it is archived", (spare) => {
  const scope = String(database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  database().prepare("INSERT INTO memory_records VALUES('rec-p1',1,?,'fact','The gate code is 9921.','assistant-inference','active',0,1,NULL,NULL,1)").run(scope);
  captureSource(database(), { id: "message:chat:reply-1", threadId: "chat", messageId: "reply-1", kind: "text", speaker: "bot", outcome: "recorded", text: "The gate code is 9921." });
  receipt("a1", [{ id: "rec-p1", version: 1 }], [], ["reply-1"]);
  receipt("b1", [], [{ id: "message:chat:reply-1", revision: 1 }], ["reply-2"]);
  try {
    expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
    setVerdictLimitForTest(keptVerdictCount() + spare);
    expect(capturedMessageWithheld("chat", "reply-2")).toBe(false);
    database().prepare("UPDATE memory_records SET state='archived' WHERE id='rec-p1'").run();
    database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
    expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
    expect(capturedMessageWithheld("chat", "reply-2")).toBe(true);
  } finally { setVerdictLimitForTest(null); }
});

// review r102-mem P2: a receipt's place in its session is the order it was written in, not its millisecond. Two receipts of
// one session with the same time, or a clock that went back between two turns, made an earlier reply "rest on" the receipt
// of the reply that cites it (a false cycle that withheld both), and the other way round a backdated one could be missed.
function sessionReceipt(id: string, records: Array<{ id: string; version: number }>, sources: Array<{ id: string; revision: number }>, outputs: string[], at: number) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','d','S-1',?,?,?,0,0,0,'delivered',?)")
    .run(id, JSON.stringify(records), JSON.stringify(sources), JSON.stringify(outputs), at);
}
it.each([
  ["the same millisecond", 50, 50],
  ["a clock that went back", 1000, 500],
  ["time in order", 50, 60],
])("two receipts of one session in %s: neither reply is withheld, and archiving the record behind the first withholds both", (_name, first, second) => {
  const scope = String(database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  database().prepare("INSERT INTO memory_records VALUES('rec-p2',1,?,'fact','The gate code is 9921.','assistant-inference','active',0,1,NULL,NULL,1)").run(scope);
  captureSource(database(), { id: "message:chat:reply-1", threadId: "chat", messageId: "reply-1", kind: "text", speaker: "bot", outcome: "recorded", text: "The gate code is 9921." });
  sessionReceipt("a1", [{ id: "rec-p2", version: 1 }], [], ["reply-1"], first);
  sessionReceipt("b1", [], [{ id: "message:chat:reply-1", revision: 1 }], ["reply-2"], second);
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(false);
  expect([...replayExclusions("chat", [{ id: "reply-1", role: "bot" }, { id: "reply-2", role: "bot" }], null)]).toEqual([]);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id='rec-p2'").run();
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(true);
});

it("a companion lookup receipt dated before its frame but written after it still counts for the replies the frame lists", () => {
  const scope = String(database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  database().prepare("INSERT INTO memory_records VALUES('rec-p2b',1,?,'fact','The gate code is 9921.','assistant-inference','active',0,1,NULL,NULL,1)").run(scope);
  sessionReceipt("f1", [], [], ["reply-1"], 100);
  sessionReceipt("f1:lookup", [{ id: "rec-p2b", version: 1 }], [], ["reply-1"], 99);
  sessionReceipt("f2", [], [], ["reply-2"], 110);
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(false);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id='rec-p2b'").run();
  database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
  expect(capturedMessageWithheld("chat", "reply-1")).toBe(true);
  expect(capturedMessageWithheld("chat", "reply-2")).toBe(true);
});

// the P1 scenario at the session level: the session's receipt-group verdicts are kept under the same rules
it.each([[0], [1], [2], [3], [5]])("session level, at the capacity boundary (%i spare): archiving the record behind a kept reply still fails the session's check", (spare) => {
  const scope = String(database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  database().prepare("INSERT INTO memory_records VALUES('rec-p1s',1,?,'fact','The gate code is 9921.','assistant-inference','active',0,1,NULL,NULL,1)").run(scope);
  captureSource(database(), { id: "message:chat:reply-1", threadId: "chat", messageId: "reply-1", kind: "text", speaker: "bot", outcome: "recorded", text: "The gate code is 9921." });
  sessionReceipt("a1", [{ id: "rec-p1s", version: 1 }], [], ["reply-1"], 10);
  sessionReceipt("b1", [], [{ id: "message:chat:reply-1", revision: 1 }], ["reply-2"], 20);
  sessionReceipt("c1", [], [{ id: "message:chat:reply-1", revision: 1 }], ["reply-3"], 30);
  try {
    expect(capturedMessageWithheld("chat", "reply-1")).toBe(false);
    setVerdictLimitForTest(keptVerdictCount() + spare);
    expect(sessionLineageBad("chat", "d", "S-1", null)).toBe(false);
    database().prepare("UPDATE memory_records SET state='archived' WHERE id='rec-p1s'").run();
    database().exec("UPDATE memory_meta SET data_revision=data_revision+1");
    expect(sessionLineageBad("chat", "d", "S-1", null)).toBe(true);
  } finally { setVerdictLimitForTest(null); }
});
