import { isLearnableSource, learnableSourceSettings } from "./learnable.ts";
import { learningWriteDecision, learningSourceBot, learningEvidenceScopes, type LearningWriteDecision } from "./learning-guard.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import type { DatabaseSync } from "node:sqlite";
import { readMemoryLearning } from "./learning-policy.ts";

export function learningReviewReason(reason:string):string {
  const reasons:Record<string,string>={
    "needs-owner-approval":"This memory needs you before it is used.",
    "private-into-shared":"This memory came from a private chat. Review it before sharing it here.",
    "cross-partition":"The cited sources belong to different audiences. Review this memory before using it.",
    "cross-scope":"The source belongs to another audience. Review this memory before using it.",
    "retired-partition":"This audience is no longer active. Review this memory before using it.",
    "bot-paused":"Learning from this bot is paused.","chats-off":"Learning from chats is off.","channels-off":"Learning from connected channels is off.",
    "not-owner-audience":"This source is not from an owner conversation.","not-owner-speaker":"This source was not written by the owner.",
    "not-active":"The source has not finished capture or is no longer active.","source-gone":"The source is no longer available.","tombstoned":"The source was forgotten.",
    "excluded-thread":"Learning from this conversation is excluded.","tool-results-nightly-only":"Tool results are not learned through this path.","settlement":"Turn status is not an owner statement.","project-budget-reached":"The project learning allowance has been reached.",
    "default-review":"This learning connection asks you first. Open Needs you to approve this memory.","review-mode":"Asking you first is on. Open Needs you to approve this memory.",
    "automatic-off":"Automatic learning is off. Open Needs you to approve this memory.",
    "correction-review":"This memory corrects an earlier memory. Approve the correction in Needs you.",
  };
  return reasons[reason]??(reason.startsWith("origin-")?"This source was not an attended owner message. Review it before using it.":"This memory could not be confirmed. Review it before using it.");
}
/** A reason already stored on a candidate held before 1.0.2 still says "Needs review"; it reads as "Needs you" from here on. */
export function storedReviewReason(basis:string):string {
  return basis.replaceAll("Needs review","Needs you").replace("Review this memory in Needs you before using it.","This memory needs you before it is used.");
}
export function holdMemoryCandidate(db:DatabaseSync,id:string,reason:string){
  db.prepare("UPDATE memory_record_details SET confidence_basis=? WHERE record_id=? AND record_version=1 AND EXISTS(SELECT 1 FROM memory_records r WHERE r.id=memory_record_details.record_id AND r.version=memory_record_details.record_version AND r.state='candidate')").run(learningReviewReason(reason),id);
  return false;
}
export function ownerLearningRefusal(db:DatabaseSync,evidence:ReadonlyArray<{sourceId:string;revision:number}>):string|undefined {
  for(const h of evidence){const result=isLearnableSource(db,h.sourceId,h.revision);if(!result.learnable)return result.reason;}
}
export function invitedCanonRefusal(db:DatabaseSync,evidence:ReadonlyArray<{sourceId:string;revision:number}>,invitation:{sourceId:string;revision:number},botId?:string):string|undefined {
 const refusal=ownerLearningRefusal(db,[invitation]);if(refusal)return refusal;
 const invited=db.prepare("SELECT s.thread_id,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?").get(invitation.sourceId,invitation.revision)!;
 const invitedAt=JSON.parse(String(invited.payload)).occurredAt;
 let newest=-1;
 for(const h of evidence){
  if(h.sourceId===invitation.sourceId)continue;
  const source=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?").get(h.sourceId,h.revision);
  if(!source)return "not-active";
  const payload=JSON.parse(String(source.payload));
  if(source.speaker==="tool"||source.kind==="tool-outcome")return "tool-results-nightly-only";
  if(source.speaker==="owner"||String(source.speaker).startsWith("person:")){
   const result=isLearnableSource(db,h.sourceId,h.revision);if(!result.learnable)return result.reason;
  }else{
   // Unlabelled assistant replies belong only to the bot owning this thread.
   if(!botId||source.kind!=="text"||(source.speaker!==botId&&!(source.speaker==="assistant"&&learningSourceBot(String(source.thread_id))?.id===botId)))return "not-owner-speaker";
   const binding=db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='source-origin' AND subject_id=? AND state='granted'").get(h.sourceId);
   const kind=(payload.origin??(binding?JSON.parse(String(binding.intent)):null))?.kind??"unknown";
   const result=learnableSourceSettings(db,source,kind);if(!result.learnable)return result.reason;
  }
  if(!source.thread_id||source.thread_id!==invited.thread_id)return "invitation-thread";
  if(!Number.isSafeInteger(payload.occurredAt))return "invitation-order";
  newest=Math.max(newest,payload.occurredAt);
 }
 if(!Number.isSafeInteger(invitedAt)||invitedAt>=newest)return "invitation-order";
}
export type MemoryClaimType = "owner-statement" | "observation" | "inference" | "character-canon" | "procedure";

/** Classifications are hints, never authority. Activation requires an exact
 * original-source statement and trusted capture provenance. Caller owns the
 * transaction and must have validated source access and revision first. */
export function activateGroundedMemory(db: DatabaseSync, id: string, claimType?: MemoryClaimType, support?: {supported:boolean;ownerInvitation?:string;ownerInvitationSourceId?:string}, run?:{botId?:string;superseding?:boolean;decision?:LearningWriteDecision;reviewOnly?:boolean;connection?:string|null}) {
  const record=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=1 AND state='candidate'").get(id);
  if(!record || !claimType || claimType==="inference")return false;
  if(record.supersedes_id&&!run?.superseding)return holdMemoryCandidate(db,id,"correction-review");
  const invitedCanon=claimType==="character-canon"&&support?.supported&&support.ownerInvitation&&support.ownerInvitationSourceId;
  const settings=readMemoryLearning(db);
  const evidence=db.prepare(`SELECT s.*,v.payload,e.start_byte,e.end_byte FROM memory_evidence e
    JOIN memory_sources s ON s.id=e.source_id AND s.revision=e.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE e.record_id=? AND e.record_version=1`).all(id).filter(row=>!invitedCanon||row.id!==support?.ownerInvitationSourceId);
  const handles=db.prepare("SELECT source_id,source_revision FROM memory_evidence WHERE record_id=? AND record_version=1").all(id).map(row=>({sourceId:String(row.source_id),revision:Number(row.source_revision)}));
  const invitation=invitedCanon?handles.find(h=>h.sourceId===support?.ownerInvitationSourceId):undefined;
  const reason=invitedCanon?(invitation?invitedCanonRefusal(db,handles,invitation,run?.botId):"not-active"):ownerLearningRefusal(db,handles);
  if(reason)return holdMemoryCandidate(db,id,reason);
  if(evidence.length!==1)return false;
  const source=evidence[0],payload=JSON.parse(String(source.payload));
  if(source.state!=="active" || source.kind==="turn" ||
    db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision))return false;
  const bot=learningSourceBot(source.thread_id===null?null:String(source.thread_id));
  const decision=learningWriteDecision(db,{writer:"activation",target:"memory",evidenceScopeIds:learningEvidenceScopes(db,id,1),sourceId:String(source.id),sourceRevision:Number(source.revision),targetScopeId:String(record.scope_id),botId:bot?.id});
  const effective=decision.decision!=="auto"?decision:run?.decision??decision;
  if(effective.decision!=="auto"){
    return holdMemoryCandidate(db,id,effective.reason);
  }
  if(run?.reviewOnly || settings.reviewMode || !(claimType==="procedure"?settings.automaticProcedures:settings.automaticFacts))return holdMemoryCandidate(db,id,run?.reviewOnly?"default-review":settings.reviewMode?"review-mode":"automatic-off");
  const quote=Buffer.from(payload.text??"").subarray(Number(source.start_byte),Number(source.end_byte)).toString("utf8");
  if(quote!==record.text && !support?.supported)return false;
  const owner=source.speaker==="owner"&&(!invitedCanon||handles.every(h=>db.prepare("SELECT speaker FROM memory_sources WHERE id=? AND revision=?").get(h.sourceId,h.revision)?.speaker==="owner"));
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
  if(!run?.superseding)recordLearningEvent(db,{kind:"activated",scopeId:String(record.scope_id),recordId:id,recordVersion:1,sourceId:String(source.id),sourceRevision:Number(source.revision),botId:bot?.id,connection:run?.connection});
  return true;
}
