// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra mem-review round 6 P2: a procedure evidence verdict reached while the lineage repair had failed (replay of unrepaired threads is
// withheld) must not be served after the repair succeeds, and lineage writes must move the stamp the verdict rests on.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { ancestryUnrepaired, closeDatabase, database, retryAncestryRepair, setRepairRetryBaseMs, setRepairRunnerForTest } from "../database.ts";
import { captureSource } from "./capture.ts";
import { provenanceStamp } from "./provenance-stamp.ts";
import { setMemoryMode } from "./repository.ts";
import { assertSkillProcedureEvidence, type SkillProcedureContext } from "../skills.ts";

beforeEach(() => {
  setRepairRunnerForTest(null); setRepairRetryBaseMs(1_000_000_000);
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture");
});
const put = (id: string, at: number, extra: Record<string, unknown> = {}, role = "bot") =>
  database().prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,?,'text','t',?)").run(id, at, role, JSON.stringify({ id, at, role, kind: "text", text: "t", ...extra }));

function fixture() {
  put("U", 10, { parentId: null }, "user"); put("C", 30, { parentId: "U" });
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('F1','chat','engine','S','[]','[]','[\"C\"]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',?)").run(Date.now());
  database().prepare("INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES('F1','chat','C')").run();
  captureSource(database(), { id: "message:chat:C", threadId: "chat", messageId: "C", kind: "text", speaker: "bot", outcome: "recorded", text: "a reply" });
  const scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='message:chat:C'").get()!.scope_id);
  const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [scopeId] };
  return { context, items: [{ kind: "source" as const, id: "message:chat:C", revision: 1, scopeId }] };
}
const verdict = (context: SkillProcedureContext, items: ReturnType<typeof fixture>["items"]) => {
  try { assertSkillProcedureEvidence(context, items); return "ok"; } catch (error) { return (error as Error).message; }
};

it("evidence judged during a failed repair is rejected; once the repair succeeds the next check re-evaluates and accepts", () => {
  const { context, items } = fixture();
  database().exec("DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-lineage-backfill-%'");
  setRepairRunnerForTest(() => { throw new Error("database is locked"); });
  closeDatabase(); database();
  expect(ancestryUnrepaired(database())).toBe(true);
  expect(verdict(context, items)).toBe("PROCEDURE_EVIDENCE_REVOKED");
  expect(verdict(context, items), "and the cached answer agrees").toBe("PROCEDURE_EVIDENCE_REVOKED");
  setRepairRunnerForTest(null);
  retryAncestryRepair();
  expect(ancestryUnrepaired(database())).toBe(false);
  expect(verdict(context, items)).toBe("ok");
});

it("a lineage write moves the provenance stamp, an unrelated message does not", () => {
  const db = database();
  const before = provenanceStamp(db);
  put("Z", 5, { parentId: null }, "user");
  expect(provenanceStamp(db)).toBe(before);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('chat','Z','')").run();
  const afterRoot = provenanceStamp(db);
  expect(afterRoot).not.toBe(before);
  db.prepare("DELETE FROM messages WHERE thread_id='chat' AND id='Z'").run();
  expect(provenanceStamp(db)).not.toBe(afterRoot);
});
