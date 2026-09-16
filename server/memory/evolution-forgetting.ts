import type { DatabaseSync } from "node:sqlite";

/** Offline-safe cleanup of evaluation copies, shared by live forgetting and
 * restore. Original cost/digest receipts survive; copied response text does not. */
export function purgeForgottenEvolutionCopies(db: DatabaseSync): void {
  const sourceForgotten = db.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_sources WHERE id=? AND state='deleted') OR EXISTS(SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?))");
  const recordForgotten = db.prepare("SELECT 1 WHERE EXISTS(SELECT 1 FROM memory_records WHERE id=? AND version=? AND state='deleted') OR EXISTS(SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?))");
  const rows = db.prepare("SELECT id,subject_id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id IN ('gepa-job','procedure-review-pending','procedure-review','procedure-evaluation-preview','procedure-evaluation-grant','procedure-evaluation-session')").all();
  for (const row of rows) {
    let value: Record<string, any>;
    try { value = JSON.parse(String(row.intent)); } catch { value = {}; }
    const refs = [...(Array.isArray(value.evidence) ? value.evidence : []), ...(Array.isArray(value.snapshot?.evidence) ? value.snapshot.evidence : [])];
    const invalid = row.state === "revoked" || value.revoked === true || !Array.isArray(value.evidence) || refs.some(ref => {
      if (!ref || typeof ref.id !== "string" || !Number.isSafeInteger(ref.revision)) return true;
      if (ref.kind === "source") return Boolean(sourceForgotten.get(ref.id, ref.id, ref.revision));
      if (ref.kind === "record") return Boolean(recordForgotten.get(ref.id, ref.revision, ref.id, ref.revision));
      return true;
    });
    if (!invalid) continue;
    if (row.subject_id === "gepa-job") {
      for (const call of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id=?").all(String(row.id))) {
        let receipt: Record<string, unknown>;
        try { receipt = JSON.parse(String(call.intent)); } catch { receipt = {}; }
        const { value: _copiedResponse, ...metadata } = receipt;
        db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...metadata, state: "revoked" }), String(call.id));
      }
      db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...value, evidence: [], revoked: true }), String(row.id));
    } else if (row.subject_id === "procedure-evaluation-preview" || row.subject_id === "procedure-evaluation-grant" || row.subject_id === "procedure-evaluation-session") {
      db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...value, evidence: [], revoked: true, reason: "MEMORY_EVIDENCE_FORGOTTEN" }), String(row.id));
    } else {
      const { snapshot: _snapshot, receipt: _receipt, trigger: _trigger, ...metadata } = value;
      db.prepare("UPDATE memory_scope_bindings SET subject_id='procedure-review',state='revoked',intent=? WHERE id=?").run(JSON.stringify({ ...metadata, evidence: [], status: "cancelled", reason: "MEMORY_EVIDENCE_FORGOTTEN" }), String(row.id));
    }
  }
}
