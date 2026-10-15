// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra mem-review round 2, R2-P1: the order of a session's receipts is the
// order they were written (rowid), never their created_at. A clock that went
// back, or a lookup companion dated a millisecond before its frame, must not
// decide which receipt is the session's newest. These use the real linking
// functions and the real replay.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureSource } from "./capture.ts";
import { MemoryDispatchReceipt, memoryContinuationChanged } from "./dispatch.ts";
import { linkMemoryDisclosureOutput, linkRetainedSessionOutput } from "./disclosures.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
function secretRecord() {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access());
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
const insert = (id: string, records: Array<{ id: string; version: number }>, createdAt: number) =>
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','engine','S',?,'[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',?)")
    .run(id, JSON.stringify(records), createdAt);

it("clock rollback: F1 at 1000, F2 (holding the secret) at 500; a late output linked through F1 still rests on F2", () => {
  const record = secretRecord();
  insert("F1", [], 1000);
  insert("F2", [{ id: record, version: 1 }], 500);
  linkMemoryDisclosureOutput("F1", "late");
  const linked = database().prepare("SELECT bundle_id FROM memory_disclosures WHERE output_message_ids LIKE '%late%' ORDER BY rowid").all().map(r => String(r.bundle_id));
  expect(linked).toEqual(["F1", "F2"]);
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "late")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "late")).toBe(true);
});

it("late output: a reply made on the resumed session with no receipt links under the session's last-written receipt", () => {
  const record = secretRecord();
  insert("F1", [], 1000);
  insert("F2", [{ id: record, version: 1 }], 500);
  linkRetainedSessionOutput("chat", "engine", "S", "late-retained");
  const linked = database().prepare("SELECT bundle_id FROM memory_disclosures WHERE output_message_ids LIKE '%late-retained%'").all().map(r => String(r.bundle_id));
  expect(linked).toEqual(["F2"]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "late-retained")).toBe(true);
});

it("backdated lookup companion: dated before its frame but written after it, so a retained-session reply rests on it", async () => {
  const record = secretRecord();
  const turn = access();
  const bundle = await buildMemoryBundle("", turn, empty, {allowance: LineageAllowance.tool()});
  const receipt = new MemoryDispatchReceipt(bundle, turn, "engine");
  receipt.accepted();
  database().prepare("UPDATE memory_disclosures SET native_session='S' WHERE bundle_id LIKE ?").run(`${bundle.bundleId}%`);
  receipt.noteLookup([{ id: record, version: 1, evidence: [] }], turn);
  const rows = database().prepare("SELECT bundle_id,created_at FROM memory_disclosures ORDER BY rowid").all();
  expect(String(rows[1]!.bundle_id)).toBe(`${bundle.bundleId}:lookup`);
  expect(Number(rows[1]!.created_at)).toBeLessThan(Number(rows[0]!.created_at));
  database().prepare("UPDATE memory_disclosures SET native_session='S' WHERE bundle_id LIKE ?").run(`${bundle.bundleId}%`);
  // the frame, not its companion, decides whether the session continues
  expect(memoryContinuationChanged(bundle, "chat", "engine", "S")).toBe(false);
  linkRetainedSessionOutput("chat", "engine", "S", "after-lookup");
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "after-lookup")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), "chat", "after-lookup")).toBe(true);
});

it("the session's latest frame for continuation is the last written, not the latest dated, and never a lookup companion", async () => {
  const record = secretRecord();
  const bundle = await buildMemoryBundle("", access(), empty, {allowance: LineageAllowance.tool()});
  insert("F1", [], 1000);
  expect(memoryContinuationChanged(bundle, "chat", "engine", "S")).toBe(false);
  // F2 is written later with another content set, though dated earlier: the session moved on
  insert("F2", [{ id: record, version: 1 }], 500);
  expect(memoryContinuationChanged(bundle, "chat", "engine", "S")).toBe(true);
  // a lookup companion written after F2 never stands for the frame
  insert("F2:lookup", [], 400);
  expect(memoryContinuationChanged(bundle, "chat", "engine", "S")).toBe(true);
});

// Astra mem-review round 3: legacy sessions and legacy backfill must not be decided by clocks.
import { retainedSessionInvalid } from "./dispatch.ts";
import { noteMemoryLookup } from "./disclosures.ts";
import { backfillOutputRoots } from "./schema.ts";
import { replayExclusions } from "./replay-lineage.ts";
import { reviewKeep, reviewUndo } from "./review.ts";
import { LineageAllowance } from "./lineage-allowance.ts";

it("R3-P1: a legacy session (receipts, no lineage row) resets whatever the clocks say", () => {
  insert("L1", [], 1000);
  database().prepare("UPDATE memory_disclosures SET native_session='S' WHERE bundle_id='L1'").run();
  // lineage 'began' after the receipt, before it, and at the very same millisecond: all reset
  for (const since of [500, 1000, 5000]) {
    database().prepare("UPDATE memory_lineage_meta SET since=? WHERE id=1").run(since);
    const why: { reason?: string } = {};
    expect(retainedSessionInvalid(LineageAllowance.tool(), "chat", "engine", "S", why), `since ${since}`).toBe(true);
    expect(why.reason).toBe("pre-lineage");
  }
});

it("R3-P1: legacy backfill does not trust message times: a reply dated before the receipt reply still rests on it", () => {
  const record = secretRecord();
  const db = database();
  const msg = (id: string, at: number, role: string) => db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,?,'text','t',?)").run(id, at, role, JSON.stringify({ id, at, role, kind: "text", text: "t" }));
  insert("F1", [{ id: record, version: 1 }], 1000);
  db.prepare("UPDATE memory_disclosures SET output_message_ids='[\"A\"]' WHERE bundle_id='F1'").run();
  msg("A", 1000, "bot"); msg("B", 500, "bot"); // written in order A, B but dated B before A: no provable order
  // the upgrade's own backfill, over the legacy rows
  db.exec("DELETE FROM memory_output_roots");
  backfillOutputRoots(db);
  expect(db.prepare("SELECT message_id FROM memory_output_roots WHERE thread_id='chat'").all().map(r => String(r.message_id))).toEqual(["B"]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(new Set(replayExclusions(LineageAllowance.tool(1_000_000_000), "chat", [{ id: "A", role: "bot" }, { id: "B", role: "bot" }], null, { failClosed: true }))).toEqual(new Set(["A", "B"]));
});

it("R3-P2: a lookup companion that gains the record after the keep is seen as a later citation", async () => {
  const record = secretRecord();
  database().prepare("UPDATE memory_records SET state='candidate' WHERE id=?").run(record);
  const ticket = ownerMemoryTicket();
  insert("FR", [], 1000);
  noteMemoryLookup("FR", "FR:lookup", [], []);
  const kept = reviewKeep(ticket, roster, { actionId: "k1", id: record, version: 1 });
  expect(kept.result.status).toBe("kept");
  // the companion existed before the keep and now gains the record
  noteMemoryLookup("FR", "FR:lookup", [{ id: record, version: 1, evidence: [] }], []);
  const undone = reviewUndo(ticket, roster, { actionId: "u1", keepActionId: "k1", id: record, version: 1 });
  expect(undone.result.status).toBe("archived");
});

it("R3-P2: an old keep with no receipt sequence archives when any receipt names the record", () => {
  const record = secretRecord();
  database().prepare("UPDATE memory_records SET state='candidate' WHERE id=?").run(record);
  const ticket = ownerMemoryTicket();
  reviewKeep(ticket, roster, { actionId: "k2", id: record, version: 1 });
  database().prepare("UPDATE memory_learning_events SET detail=json_remove(detail,'$.receiptSeq') WHERE record_id=? AND kind='owner-keep'").run(record);
  insert("late", [{ id: record, version: 1 }], 100);
  expect(reviewUndo(ticket, roster, { actionId: "u2", keepActionId: "k2", id: record, version: 1 }).result.status).toBe("archived");
});
