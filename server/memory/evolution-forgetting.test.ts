import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { pauseRestoredMemory } from "./restore.ts";
import { createGepaCallLedger } from "./gepa-ledger.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] }); });
it("scrubs cached optimizer responses and snapshots on forgetting and again during offline restore", () => {
  const scopeId = ensureScope("bot", "bot"), jobId = "forget-job", callId = "forget-job:reflect:1", inputHash = "b".repeat(64);
  transaction(db => captureSource(db, { id: "source", threadId: "thread", kind: "text", speaker: "owner", outcome: "completed", text: "private clause" }));
  const ledger = createGepaCallLedger({ scopeId, jobId, snapshotDigest: "a".repeat(64), evidence: [{ kind: "source", id: "source", revision: 1 }], maxMetricCalls: 24, maxReflections: 2, assertCurrent: () => {} });
  ledger.lookupOrReserve(callId, inputHash, "reflect"); ledger.complete(callId, inputHash, "```\nprivate clause\n```");
  const db = database(), originalCall = db.prepare("SELECT * FROM memory_scope_bindings WHERE id LIKE 'gepa-call:%'").get()!;
  const review = { evidence: [{ kind: "source", id: "source", revision: 1 }], snapshot: { evidence: [{ kind: "source", id: "source", revision: 1, text: "private clause" }] }, receipt: { candidate: "private clause" }, status: "complete" };
  db.prepare("INSERT INTO memory_scope_bindings VALUES('procedure-review:fixture',?,'system','procedure-review',1,'granted',?)").run(scopeId, JSON.stringify(review));
  const independent = { evidence: [], snapshot: { evidence: [] }, receipt: { candidate: "synthetic-only policy" }, status: "complete" };
  db.prepare("INSERT INTO memory_scope_bindings VALUES('procedure-review:independent',?,'system','procedure-review',1,'granted',?)").run(scopeId, JSON.stringify(independent));
  for(const subject of ["procedure-evaluation-preview","procedure-evaluation-grant","procedure-evaluation-session"]){
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,1,'granted',?)").run(`${subject}:fixture`,scopeId,subject,JSON.stringify({schema:1,evidence:review.evidence,seedHash:"a".repeat(64)}));
  }
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "source" });
  const call = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(String(originalCall.id))!;
  expect(String(call.intent)).not.toContain("private clause"); expect(JSON.parse(String(call.intent))).toMatchObject({ state: "revoked" });
  const cleaned = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='procedure-review:fixture'").get()!;
  expect(String(cleaned.intent)).not.toContain("private clause"); expect(JSON.parse(String(cleaned.intent))).toMatchObject({ status: "cancelled", reason: "MEMORY_EVIDENCE_FORGOTTEN" });
  expect(() => ledger.lookupOrReserve(callId, inputHash, "reflect")).toThrow("GEPA_LEDGER_REVOKED");
  expect(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='procedure-review:independent'").get()!.intent)).toBe(JSON.stringify(independent));
  for(const subject of ["procedure-evaluation-preview","procedure-evaluation-grant","procedure-evaluation-session"]){
    const revoked=db.prepare("SELECT subject_id,state,intent FROM memory_scope_bindings WHERE id=?").get(`${subject}:fixture`)!;
    expect(revoked).toMatchObject({subject_id:subject,state:"revoked"});
    expect(JSON.parse(String(revoked.intent))).toMatchObject({evidence:[],revoked:true,reason:"MEMORY_EVIDENCE_FORGOTTEN"});
  }
  // A restored old evaluation copy must not outrun the destination tombstone.
  db.prepare("UPDATE memory_scope_bindings SET state='granted',intent=? WHERE id=?").run(String(originalCall.intent), String(originalCall.id));
  expect(pauseRestoredMemory(db)).toBe(true);
  expect(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(String(originalCall.id))!.intent)).not.toContain("private clause");
});
