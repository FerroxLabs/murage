import { isProjectCloseLesson } from "../project-close.ts";
import { roomRequest } from "../room-requests.ts";
import { executionStore, partitionOfScope } from "../execution-audience.ts";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { database, transaction } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import type { MemoryEvidenceHandle } from "../../shared/memory.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { activateGroundedMemory, holdMemoryCandidate, ownerLearningRefusal, invitedCanonRefusal, type MemoryClaimType } from "./automatic-learning.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { enqueueProcedureCorrectionReview } from "./procedure-review.ts";
import { isPipKind } from "./pip-kinds.ts";
import { revokeAllDisclosures, revokeRecordDisclosures } from "./revocation.ts";

const ownerTickets = new WeakSet<object>();
/** Mint only after the HTTP desktop-authority check; not exposed as an agent tool. */
export function ownerMemoryTicket() { const ticket = Object.freeze({}); ownerTickets.add(ticket); return ticket; }
export function requireMemoryOwner(ticket: object) { if (!ownerTickets.has(ticket)) throw new Error("MEMORY_OWNER_REQUIRED"); }

/** Identity writes have their own bounded imprint/reveal contract. Generic
 * corrections and audience promotion must not silently change that contract. */
export function assertGenericMemoryTarget(db:DatabaseSync,id:string,version:number){
  // I-10: a PIP kind is refused by kind as well as by partition, so no path that
  // forgets to set the partition can reach one through approve, correct, forget or promote.
  const kind=db.prepare("SELECT kind FROM memory_records WHERE id=? AND version=?").get(id,version);
  if(kind&&isPipKind(kind.kind))throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
  if(db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND record_version=? AND partition='identity'").get(id,version))throw new Error("MEMORY_IDENTITY_WRITE_REQUIRED");
}


export function saveMemoryCandidate(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, claimType?: MemoryClaimType) {
  return saveCandidate(text,evidence,key,access,claimType);
}

/** This authority is available only to a live, server-issued close lesson. */
export function saveProjectCloseLesson(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, requestId: string) {
  // The same capture fence every other save runs first (lane D).
  assertMemoryCaptureComplete(evidence,access);
  const db = database();
  const request = roomRequest(db,requestId);
  if (!request || request.state !== 'running' || request.toBotId !== access.botId || (request.targetThreadId ?? request.rootThreadId) !== access.threadId || !isProjectCloseLesson(db,request)) throw new Error('MEMORY_CLOSE_LESSON_REQUIRED');
  const scope = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(access.botId);
  if (!scope) throw new Error('MEMORY_SCOPE_DENIED');
  assertMemoryAccess(access,String(scope.id));
  // Project room evidence may be carried into this member's own candidate,
  // but unrelated private or other-project evidence cannot be relabelled.
  for (const handle of evidence) {
    const source = db.prepare("SELECT s.kind,s.owner_key FROM memory_sources e JOIN memory_scopes s ON s.id=e.scope_id WHERE e.id=?").get(handle.sourceId);
    if (source?.kind !== 'room' || source.owner_key !== request.groupId) throw new Error('MEMORY_PROJECT_EVIDENCE_REQUIRED');
  }
  const lessonKey = createHash('sha256').update(JSON.stringify([request.id,access.botId,key])).digest('hex');
  return saveCandidate(text,evidence,lessonKey,access,undefined,String(scope.id));
}
function saveCandidate(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess, claimType?: MemoryClaimType, candidateScope?: string) {
  assertMemoryAccess(access);
  if (!text.trim() || text.length > 4096 || !evidence.length || evidence.length > 20 || !/^[\w-]{1,160}$/.test(key)) throw new Error("INVALID_MEMORY_CANDIDATE");
  return transaction(db => {
    const scopes = new Set<string>();
    for (const handle of evidence) {
      const source = db.prepare("SELECT s.scope_id,s.state,s.revision,s.kind,s.outcome,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.revision,handle.sourceId);
      if (!source || source.state !== "active" || source.revision !== handle.revision || (["tool-outcome", "activity"].includes(String(source.kind)) && source.outcome === "failed")) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
      assertMemoryAccess(access,String(source.scope_id)); scopes.add(String(source.scope_id));
      const payload = JSON.parse(String(source.payload));
      if (!Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Buffer.byteLength(payload.text ?? "")) throw new Error("INVALID_MEMORY_SPAN");
      if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    }
    // Cross-scope synthesis must not implicitly expand its audience.
    if (scopes.size !== 1) throw new Error("MEMORY_PROMOTION_REQUIRED");
    const id = createHash("sha256").update(JSON.stringify([access.threadId,key])).digest("hex"), scope = candidateScope ?? [...scopes][0];
    if (partitionOfScope(scope)?.partition.kind === "general") throw new Error(`Only you can change what ${executionStore()?.bot(access.botId)?.name ?? "this bot"} knows for every team.`);
    const existing = db.prepare("SELECT text,state,scope_id FROM memory_records WHERE id=? AND version=1").get(id);
    const safeText = redactSecretsInText(text);
    if (existing) {
      const saved=db.prepare("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=1").all(id);
      const canonical=(rows:unknown[][])=>JSON.stringify(rows.map(row=>JSON.stringify(row)).sort());
      if(existing.text!==safeText || !["candidate","active"].includes(String(existing.state)) || existing.scope_id!==scope ||
        canonical(saved.map(h=>[h.source_id,h.source_revision,h.start_byte,h.end_byte]))!==canonical(evidence.map(h=>[h.sourceId,h.revision,h.startByte,h.endByte])))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
      return id;
    }
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,?,NULL,NULL,?)").run(id,scope,safeText,Date.now(),Date.now());
    for (const h of evidence) db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,h.sourceId,h.revision,h.startByte,h.endByte);
    if (!candidateScope) activateGroundedMemory(db,id,claimType);
    return id;
  });
}

/** Only jobs which can still complete warrant a retry. */
export function assertMemoryCaptureComplete(evidence:ReadonlyArray<{sourceId:string;revision:number}>,access:MemoryAccess){
 const db=database();
 for(const h of evidence){
  const source=db.prepare("SELECT scope_id FROM memory_sources WHERE id=? AND revision=? AND state='active'").get(h.sourceId,h.revision);
  if(!source)continue;
  assertMemoryAccess(access,String(source.scope_id));
  const jobs=db.prepare("SELECT status FROM memory_jobs WHERE source_id=? AND source_revision=? AND stage='capture'").all(h.sourceId,h.revision);
  if(jobs.some(j=>j.status==="complete"))continue;
  if(jobs.some(j=>["pending","leased","partial","deferred"].includes(String(j.status))))throw Object.assign(new Error("Source capture is still pending. Try saving this memory again after capture finishes."),{status:409});
  throw Object.assign(new Error("This source cannot be used because its capture did not complete."),{status:400});
 }
}

/** Ground through the configured isolated text-only evaluator. The durable
 * candidate exists before optional synthesis; a changed audience/source/config
 * fences activation, while unavailable synthesis remains honestly provisional. */
export async function saveGroundedMemory(text:string,evidence:MemoryEvidenceHandle[],key:string,access:MemoryAccess,claimType:MemoryClaimType|undefined,extractor:TextOnlyExtractor|null,ownerInvitation?:MemoryEvidenceHandle,options:{budgetGate?:(scopeId:string)=>boolean}={}){
  if(ownerInvitation&&claimType!=="character-canon")throw Object.assign(new Error("Owner invitations can only support character canon."),{status:400});
  assertMemoryAccess(access);
  const cited=ownerInvitation?[...evidence,ownerInvitation]:evidence;
  assertMemoryCaptureComplete(cited,access);
  const id=saveMemoryCandidate(text,cited,key,access);
  if(!claimType||database().prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(id)?.state==="active")return id;
  const db=database(),learningRevision=readMemoryLearning(db).revision;
  if(db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=1").get(id)?.supersedes_id){transaction(()=>holdMemoryCandidate(db,id,"correction-review"));return id;}
  {
    const reason=ownerInvitation?invitedCanonRefusal(db,evidence,ownerInvitation,access.botId):ownerLearningRefusal(db,cited);
    if(reason){transaction(()=>holdMemoryCandidate(db,id,reason));return id;}
  }
  if(evidence.length!==1)return id;
  const h=evidence[0],source=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON s.id=v.source_id AND s.revision=v.revision WHERE s.id=?").get(h.sourceId)!;
  const quote=Buffer.from(JSON.parse(String(source.payload)).text).subarray(h.startByte,h.endByte).toString("utf8");
  let invitation:string|undefined;
  if(ownerInvitation){
    const invited=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON s.id=v.source_id AND s.revision=v.revision WHERE s.id=? AND s.revision=? AND s.state='active' AND s.speaker='owner'").get(ownerInvitation.sourceId,ownerInvitation.revision);
    if(!invited||invited.scope_id!==source.scope_id)throw new Error("MEMORY_INVITATION_UNAVAILABLE");
    assertMemoryAccess(access,String(invited.scope_id));
    const bytes=Buffer.from(JSON.parse(String(invited.payload)).text);
    if(ownerInvitation.startByte<0||ownerInvitation.endByte>bytes.length||ownerInvitation.endByte<=ownerInvitation.startByte)throw new Error("INVALID_MEMORY_SPAN");
    invitation=bytes.subarray(ownerInvitation.startByte,ownerInvitation.endByte).toString("utf8");
  }
  const needsGrounding=text!==quote||claimType==="character-canon"&&(source.speaker!=="owner"||Boolean(invitation));
  if(needsGrounding&&options.budgetGate&&!options.budgetGate(String(source.scope_id))){transaction(()=>holdMemoryCandidate(db,id,"project-budget-reached"));return id;}
  const support=needsGrounding?await groundMemoryClaim({text,quote,claimType,speaker:String(source.speaker),outcome:String(source.outcome),ownerInvitation:invitation},extractor,new AbortController().signal):undefined;
  return transaction(()=>{
    assertMemoryAccess(access,String(source.scope_id));assertEvidenceCurrent(db,id,1);
    if(readMemoryLearning(db).revision!==learningRevision)throw new Error("MEMORY_CONSOLIDATION_REVOKED");
    if(ownerInvitation){
      const current=db.prepare("SELECT 1 FROM memory_sources WHERE id=? AND revision=? AND state='active' AND speaker='owner'").get(ownerInvitation.sourceId,ownerInvitation.revision);
      if(!current||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(ownerInvitation.sourceId,ownerInvitation.revision))throw new Error("MEMORY_INVITATION_UNAVAILABLE");
    }
    const activated=activateGroundedMemory(db,id,claimType,support?{...support,ownerInvitation:invitation,ownerInvitationSourceId:ownerInvitation?.sourceId}:undefined,{botId:access.botId,connection:extractor?.learningConnection,reviewOnly:needsGrounding&&extractor?.reviewOnly});
    if(activated&&ownerInvitation)db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,ownerInvitation.sourceId,ownerInvitation.revision,ownerInvitation.startByte,ownerInvitation.endByte);
    if(!activated&&support&&!db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND confidence_basis IS NOT NULL").get(id))db.prepare("UPDATE memory_record_details SET confidence_basis=? WHERE record_id=? AND record_version=1 AND claim_status='provisional'").run(support.reason,id);
    return id;
  });
}

/** What the owner decides about an owner pin on the fact a correction replaces. */
export type CorrectionPinChoice = "transfer" | "unpin";
/** `changed`: the target was corrected or replaced after the proposal.
 * `unavailable`: forgotten, archived, missing or an ambiguous derivation. */
export type CorrectionTargetStatus = "current" | "changed" | "unavailable";
export interface CorrectionTargetReview {
  status: CorrectionTargetStatus;
  target: { id: string; version: number; text: string; state: string; ownerPinned: boolean; scopeId: string } | null;
}

/** The exact target version an agent-proposed correction was made against
 * (`supersedes_id` plus its single recorded derivation), or null when the
 * candidate is not a correction proposal. Approval never guesses a target. */
export function readCorrectionTarget(db: DatabaseSync, id: string, version: number): CorrectionTargetReview | null {
  const candidate = db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(id,version);
  if (!candidate || typeof candidate.supersedes_id !== "string" || !candidate.supersedes_id) return null;
  const targetId = candidate.supersedes_id;
  const links = db.prepare("SELECT parent_version FROM memory_derivations WHERE child_id=? AND child_version=? AND parent_id=?").all(id,version,targetId);
  if (links.length !== 1) return {status:"unavailable",target:null};
  const row = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(targetId,Number(links[0].parent_version));
  if (!row) return {status:"unavailable",target:null};
  const target = {id:targetId,version:Number(row.version),text:String(row.text),state:String(row.state),ownerPinned:row.owner_pinned===1,scopeId:String(row.scope_id)};
  const latest = Number(db.prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(targetId)?.version);
  const tombstoned = db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(targetId,target.version);
  if (tombstoned || target.state === "deleted" || target.state === "archived" || target.state === "candidate") return {status:"unavailable",target};
  if (latest !== target.version || target.state !== "active") return {status:"changed",target};
  return {status:"current",target};
}

/** Evidence must still be exactly what the owner reviewed: active sources at
 * the recorded revision, not tombstoned, spans inside the stored text. */
function assertEvidenceCurrent(db: DatabaseSync, id: string, version: number) {
  const handles = db.prepare("SELECT source_id,source_revision,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id,version);
  if (!handles.length) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  for (const handle of handles) {
    const source = db.prepare("SELECT s.state,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.source_revision,handle.source_id);
    if (!source || source.state !== "active" || source.revision !== handle.source_revision) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.source_id,handle.source_revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    const text = JSON.parse(String(source.payload)).text;
    if (typeof text !== "string" || Number(handle.end_byte) > Buffer.byteLength(text)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
  }
}

/** Owner approval of an agent-proposed correction (audit C1, decision U-16):
 * validate the exact recorded target version, revalidate the candidate's
 * evidence, then supersede only that target and activate the replacement in
 * one transaction. A pinned target needs an explicit transfer/unpin choice. */
export function approveCorrection(db: DatabaseSync, record: Record<string, unknown>, review: CorrectionTargetReview, options: {pin?: boolean; scopeId?: string; correctionPin?: CorrectionPinChoice}) {
  // A correction replaces one reviewed fact in its own audience. Promotion and
  // an implicit pin flag are separate owner decisions, never folded in here.
  if (options.pin !== undefined || (options.scopeId !== undefined && options.scopeId !== record.scope_id)) throw new Error("MEMORY_CORRECTION_OPTIONS_INVALID");
  if (options.correctionPin !== undefined && options.correctionPin !== "transfer" && options.correctionPin !== "unpin") throw new Error("MEMORY_CORRECTION_OPTIONS_INVALID");
  if (!review.target || review.status === "unavailable") throw new Error("MEMORY_CORRECTION_TARGET_UNAVAILABLE");
  if (review.status === "changed") throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
  const target = review.target;
  assertGenericMemoryTarget(db,target.id,target.version);
  if (target.scopeId !== record.scope_id) throw new Error("MEMORY_CORRECTION_SCOPE_MISMATCH");
  assertEvidenceCurrent(db,String(record.id),Number(record.version));
  if (target.ownerPinned && options.correctionPin === undefined) throw new Error("MEMORY_CORRECTION_PIN_CHOICE_REQUIRED");
  // The owner chose for a pin that is no longer there: the review is stale.
  if (!target.ownerPinned && options.correctionPin !== undefined) throw new Error("MEMORY_CORRECTION_PIN_CHANGED");
  const retired = db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=? AND state='active'").run(Date.now(),target.id,target.version);
  if (retired.changes !== 1) throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
  const activated = db.prepare("UPDATE memory_records SET state='active',owner_pinned=? WHERE id=? AND version=? AND state='candidate'")
    .run(target.ownerPinned && options.correctionPin === "transfer" ? 1 : 0,String(record.id),Number(record.version));
  if (activated.changes !== 1) throw new Error("MEMORY_VERSION_CONFLICT");
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  revokeRecordDisclosures(db,"approve-correction",{recordIds:[target.id,String(record.id)]});
  enqueueProcedureCorrectionReview(db,String(record.id),Number(record.version),{ownerAuthorized:true});
  return String(record.id);
}

export function approveMemory(ticket: object, id: string, version: number, options: {pin?: boolean; scopeId?: string; correctionPin?: CorrectionPinChoice} = {}) {
  requireMemoryOwner(ticket);
  return transaction(db => {
    const record = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND state='candidate'").get(id,version);
    if (!record) throw new Error("MEMORY_VERSION_CONFLICT");
    const correction = readCorrectionTarget(db,id,version);
    if (correction) return approveCorrection(db,record,correction,options);
    if (options.correctionPin !== undefined) throw new Error("MEMORY_CORRECTION_PIN_CHOICE_INVALID");
    // A candidate was never in a bundle; approving it ends only receipts that
    // somehow cite it (none, in practice). No policy change: who may read
    // what is unchanged.
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"approve",{recordIds:[id],viaSources:false});
    if (options.scopeId && options.scopeId !== record.scope_id) {
      assertGenericMemoryTarget(db,id,version);
      if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(options.scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
      const copy = randomUUID();
      db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',?,?,NULL,NULL,?)").run(copy,options.scopeId,record.kind,record.text,options.pin?1:0,Date.now(),Date.now());
      db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(id,version,copy);
      return copy;
    }
    db.prepare("UPDATE memory_records SET state='active',owner_pinned=? WHERE id=? AND version=?").run(options.pin?1:0,id,version);
    return id;
  });
}

export function correctMemory(ticket: object, id: string, version: number, text: string, options: {correctionPin?: CorrectionPinChoice} = {}) {
  requireMemoryOwner(ticket);
  if (!text.trim() || text.length > 4096) throw new Error("INVALID_MEMORY_TEXT");
  return transaction(db => {
    const row = db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if (!row || row.version !== version || row.state === "deleted") throw new Error("MEMORY_VERSION_CONFLICT");
    if(row.state==="archived")throw new Error("Restore this memory before editing it.");
    if(row.state==="superseded")throw new Error("This was replaced; edit the current version.");
    assertGenericMemoryTarget(db,id,version);
    const correction=row.state==="candidate"?readCorrectionTarget(db,id,version):null;
    if(correction){
      if(correction.status!=="current")throw new Error("The memory this corrects has changed. Forget this proposal or approve a fresh one.");
      const next=version+1;
      db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','candidate',0,?,NULL,?,?)")
        .run(id,next,row.scope_id,row.kind,redactSecretsInText(text),Date.now(),row.supersedes_id,Date.now());
      db.prepare("INSERT INTO memory_evidence SELECT record_id,?,source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").run(next,id,version);
      db.prepare("INSERT INTO memory_derivations SELECT parent_id,parent_version,child_id,? FROM memory_derivations WHERE child_id=? AND child_version=?").run(next,id,version);
      const edited=db.prepare("SELECT * FROM memory_records WHERE id=? AND version=?").get(id,next)!;
      approveCorrection(db,edited,correction,options);
      db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,version);
      db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(id,version,id,next);
      return next;
    }else if(options.correctionPin!==undefined)throw new Error("MEMORY_CORRECTION_PIN_CHOICE_INVALID");
    db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,version);
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','active',?,?,NULL,?,?)")
      .run(id,version+1,row.scope_id,row.kind,redactSecretsInText(text),row.owner_pinned,Date.now(),id,Date.now());
    db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(id,version,id,version+1);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"correct",{recordIds:[id]});
    enqueueProcedureCorrectionReview(db,id,version+1,{ownerAuthorized:true});
    return version+1;
  });
}

export function pinMemory(ticket: object, id: string, version: number, pinned: boolean) {
  requireMemoryOwner(ticket);
  transaction(db => {
    // Owner-authored continuity is delivered by its own slot, never pinned (PIP A8). Unpinning stays open: a brief
    // pinned before it became a PIP kind keeps a repair path, and the bundle delivers it in the brief slot meanwhile.
    const target = db.prepare("SELECT kind FROM memory_records WHERE id=? AND version=?").get(id,version);
    if (pinned && target && isPipKind(target.kind)) throw new Error("MEMORY_IDENTITY_NOT_PINNABLE");
    const result = db.prepare("UPDATE memory_records SET owner_pinned=? WHERE id=? AND version=? AND state='active'").run(pinned?1:0,id,version);
    if (!result.changes) throw new Error("MEMORY_VERSION_CONFLICT");
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    revokeRecordDisclosures(db,"pin",{recordIds:[id],viaSources:false});
  });
}

export function bindMemoryScope(ticket: object, scopeId: string, subjectType: "bot" | "room", subjectId: string) {
  requireMemoryOwner(ticket);
  transaction(db => {
    if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?,?,?,'granted','{}')").run(randomUUID(),scopeId,subjectType,subjectId,Number(database().prepare("SELECT policy_revision FROM memory_meta").get()?.policy_revision));
  });
}

/** Rename identity only as part of an owner-reviewed roster rename operation. */
export function renameMemoryTeam(ticket: object, oldName: string, newName: string) {
  requireMemoryOwner(ticket);
  const from = oldName.trim(), to = newName.trim();
  if (from === to) return;
  transaction(db => {
    if (db.prepare("SELECT 1 FROM memory_scopes WHERE kind='team' AND owner_key=?").get(to)) throw new Error("MEMORY_TEAM_EXISTS");
    const changed = db.prepare("UPDATE memory_scopes SET owner_key=?,revision=revision+1 WHERE kind='team' AND owner_key=?").run(to,from);
    if (!changed.changes) throw new Error("MEMORY_TEAM_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    revokeAllDisclosures(db,"team-rename");
  });
}
