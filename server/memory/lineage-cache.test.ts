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
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld, recordRestsOnWithheldMessage, replayRowsRead } from "./replay-lineage.ts";
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
