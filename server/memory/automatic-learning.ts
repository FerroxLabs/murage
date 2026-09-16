import type { DatabaseSync } from "node:sqlite";
import { readMemoryLearning } from "./learning-policy.ts";

export type MemoryClaimType = "owner-statement" | "observation" | "inference" | "character-canon" | "procedure";

/** Classifications are hints, never authority. Activation requires an exact
 * original-source statement and trusted capture provenance. Caller owns the
 * transaction and must have validated source access and revision first. */
export function activateGroundedMemory(db: DatabaseSync, id: string, claimType?: MemoryClaimType, support?: {supported:boolean;ownerInvitation?:string;ownerInvitationSourceId?:string}) {
  const record=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=1 AND state='candidate'").get(id);
  if(!record || !claimType || claimType==="inference")return false;
  const settings=readMemoryLearning(db);
  if(settings.reviewMode || !(claimType==="procedure"?settings.automaticProcedures:settings.automaticFacts))return false;
  const evidence=db.prepare(`SELECT s.*,v.payload,e.start_byte,e.end_byte FROM memory_evidence e
    JOIN memory_sources s ON s.id=e.source_id AND s.revision=e.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE e.record_id=? AND e.record_version=1`).all(id).filter(row=>row.id!==support?.ownerInvitationSourceId);
  if(evidence.length!==1)return false;
  const source=evidence[0],payload=JSON.parse(String(source.payload));
  if(source.state!=="active" || source.scope_id!==record.scope_id || source.kind==="turn" ||
    db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision))return false;
  const quote=Buffer.from(payload.text??"").subarray(Number(source.start_byte),Number(source.end_byte)).toString("utf8");
  if(quote!==record.text && !support?.supported)return false;
  const owner=source.speaker==="owner";
  const observed=source.speaker==="tool" && source.outcome==="completed" && payload.action?.verification==="tool-reported";
  if(claimType==="observation"?!observed:!owner && !(claimType==="character-canon"&&support?.supported&&support.ownerInvitation))return false;
  const kind=claimType==="character-canon"?"character-canon":claimType==="procedure"?"procedure":"fact";
  db.prepare("UPDATE memory_records SET state='active',assertion=?,kind=? WHERE id=? AND version=1")
    .run(owner?"owner-statement":kind==="character-canon"?"assistant-inference":"tool-observation",kind,id);
  db.prepare("UPDATE memory_record_details SET partition=?,claim_status='current',observed_at=?,confidence_basis=? WHERE record_id=? AND record_version=1")
    .run(kind==="character-canon"?"identity":kind==="procedure"?"procedural":"semantic",payload.occurredAt??null,
      kind==="character-canon"?"Owner-invited fictional character canon; not model autobiography or world truth":owner?(support?.supported?"Source-entailed owner statement; not independently verified":"Exact owner statement; not independently verified"):"Exact completed tool-reported outcome",id);
  db.prepare("INSERT OR IGNORE INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
  return true;
}
