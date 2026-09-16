import { readMemoryLearning } from "./learning-policy.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { ensureScope } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { procedureCandidateHash, validateProcedureEvaluationReceipt, procedureSnapshotDigest, type ProcedureReviewSnapshot, type ProcedureEvaluationReceipt } from "./procedure-review.ts";

export const memoryEvolutionFieldsSchema=z.object({
  extraction:z.object({classificationGuidance:z.string().refine(text=>Buffer.byteLength(text)<=2048&&!text.includes("\0"),"Guidance exceeds the fixed limit")}).strict(),
  retrieval:z.object({semanticBandRatio:z.number().finite().min(0.5).max(1),rareFacetDivisor:z.number().int().min(2).max(8)}).strict(),
}).strict();
export type MemoryEvolutionFields=z.infer<typeof memoryEvolutionFieldsSchema>;
export type MemoryEvolutionPolicy=Readonly<{revision:string;extraction:Readonly<MemoryEvolutionFields["extraction"]>;retrieval:Readonly<MemoryEvolutionFields["retrieval"]>}>;
const freeze=(revision:string,fields:MemoryEvolutionFields):MemoryEvolutionPolicy=>Object.freeze({revision,extraction:Object.freeze({...fields.extraction}),retrieval:Object.freeze({...fields.retrieval})});
export const DEFAULT_MEMORY_EVOLUTION_POLICY=freeze("baseline",{extraction:{classificationGuidance:""},retrieval:{semanticBandRatio:0.8,rareFacetDivisor:4}});
const CURRENT="memory-evolution-policy",PREFIX="memory-evolution-policy:";
interface PolicyRevision {schema:1;revision:string;parentRevision:string;fields:MemoryEvolutionFields;contentHash:string;origin:"evaluated"|"rollback";createdAt:number;receiptId?:string;snapshotDigest?:string;candidateHash?:string;corpus?:{kind:"synthetic"|"sanitized";corpusDigest:string;holdoutDigest:string};rollbackOf?:string}
function readRevision(revision:string):PolicyRevision {
  if(!/^[\w:-]{1,200}$/.test(revision))throw Error("MEMORY_EVOLUTION_REVISION_UNAVAILABLE");
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND state='granted'").get(PREFIX+revision);
  if(!row)throw Error("MEMORY_EVOLUTION_REVISION_UNAVAILABLE");
  const stored=JSON.parse(String(row.intent)) as PolicyRevision,fields=memoryEvolutionFieldsSchema.parse(stored.fields);
  if(stored.schema!==1||stored.revision!==revision||stored.contentHash!==procedureCandidateHash(JSON.stringify(fields)))throw Error("MEMORY_EVOLUTION_REVISION_CHANGED");
  return {...stored,fields};
}
export function readMemoryEvolutionPolicy(revision?:string):MemoryEvolutionPolicy {
  const row=revision?undefined:database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND state='granted'").get(CURRENT);
  const selected=revision??(row?String(JSON.parse(String(row.intent)).revision):"baseline");
  if(selected==="baseline")return DEFAULT_MEMORY_EVOLUTION_POLICY;
  return freeze(selected,readRevision(selected).fields);
}
const corpusSchema=z.object({kind:z.enum(["synthetic","sanitized"]),corpusDigest:z.string().regex(/^[a-f0-9]{64}$/),holdoutDigest:z.string().regex(/^[a-f0-9]{64}$/),family:z.enum(["recall","classification"]).optional()}).strict();
type CorpusGrant=z.infer<typeof corpusSchema>;
export interface MemoryEvolutionAdmission {readonly id:string}
const admissions=new WeakMap<object,CorpusGrant>();
const grantId=(corpus:CorpusGrant)=>`memory-evolution-corpus:${procedureCandidateHash(JSON.stringify(corpus))}`;
function learningPermitsEvolution():boolean {
  const learning=readMemoryLearning(database());
  return ["capture","active"].includes(memoryState().mode)&&learning.automaticProcedures&&!learning.reviewMode;
}
/** Only the authenticated desktop operation admits a whole selected corpus.
 * A digest of holdout alone cannot authorize private training examples. */
export function admitMemoryEvolutionCorpus(ticket:object,input:CorpusGrant):MemoryEvolutionAdmission {
  requireMemoryOwner(ticket);const corpus=corpusSchema.parse(input),id=grantId(corpus);
  transaction(db=>{
    const scope=ensureScope("workspace",memoryState().installationId);
    db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE subject_type='system' AND subject_id='memory-evolution-corpus' AND coalesce(json_extract(intent,'$.family'),'legacy')=? AND id!=?").run(corpus.family??"legacy",id);
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','memory-evolution-corpus',0,'granted',?) ON CONFLICT(id) DO UPDATE SET state='granted',intent=excluded.intent").run(id,scope,JSON.stringify(corpus));
  });
  const admission=Object.freeze({id});admissions.set(admission,corpus);return admission;
}
/** Restart resumes only a persisted owner grant under current learning controls. */
export function resumeMemoryEvolutionAdmission(id:string):MemoryEvolutionAdmission|null {
  if(!learningPermitsEvolution())return null;
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='system' AND subject_id='memory-evolution-corpus' AND state='granted'").get(id);
  if(!row)return null;
  const parsed=corpusSchema.safeParse(JSON.parse(String(row.intent)));if(!parsed.success||grantId(parsed.data)!==id)return null;
  const admission=Object.freeze({id});admissions.set(admission,parsed.data);return admission;
}
function currentAdmission(admission:MemoryEvolutionAdmission):CorpusGrant {
  const expected=admissions.get(admission);
  const resumed=resumeMemoryEvolutionAdmission(admission.id),current=resumed?admissions.get(resumed):undefined;
  if(!expected||!current||JSON.stringify(current)!==JSON.stringify(expected))throw Error("MEMORY_EVOLUTION_ADMISSION_REQUIRED");
  return current;
}

function persist(record:PolicyRevision) {
  const db=database(),scope=ensureScope("workspace",memoryState().installationId);
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','memory-evolution-revision',0,'granted',?)").run(PREFIX+record.revision,scope,JSON.stringify(record));
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','memory-evolution-policy',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(CURRENT,scope,JSON.stringify({schema:1,revision:record.revision}));
}
export function publishMemoryEvolutionPolicy(snapshot:ProcedureReviewSnapshot,receipt:ProcedureEvaluationReceipt,admission:MemoryEvolutionAdmission):MemoryEvolutionPolicy {
  validateProcedureEvaluationReceipt(snapshot,receipt);
  const corpus=currentAdmission(admission);
  if(corpus.corpusDigest!==receipt.corpusDigest||corpus.holdoutDigest!==receipt.heldout.corpusDigest||snapshot.evidence.length||snapshot.target.kind!=="memory-policy"||snapshot.target.artifactId!=="memory-policy"||snapshot.target.threadId!=="memory-policy"||snapshot.target.ownerId!=="workspace-owner"||receipt.decision!=="accepted")throw Error("MEMORY_EVOLUTION_ADMISSION_REQUIRED");
  const fields=memoryEvolutionFieldsSchema.parse(JSON.parse(receipt.candidate));
  return transaction(()=>{
    const current=readMemoryEvolutionPolicy();
    if(current.revision!=="baseline"){
      const prior=readRevision(current.revision);
      if(prior.receiptId===receipt.id&&prior.candidateHash===receipt.candidateHash&&prior.snapshotDigest===procedureSnapshotDigest(snapshot)&&prior.contentHash===procedureCandidateHash(JSON.stringify(fields)))return current;
    }
    if(current.revision!==snapshot.target.baseRevision)throw Error("MEMORY_EVOLUTION_CONFLICT");
    const state=memoryState();if(state.policyRevision!==snapshot.policyRevision||state.deletionEpoch!==snapshot.deletionEpoch||readMemoryLearning(database()).revision!==snapshot.learningRevision)throw Error("MEMORY_EVOLUTION_AUTHORITY_CHANGED");
    if(snapshot.target.bundleId!==procedureCandidateHash(JSON.stringify(current))||snapshot.scopeId!==snapshot.target.scopeId||database().prepare("SELECT id FROM memory_scopes WHERE kind='workspace' AND owner_key=?").get(state.installationId)?.id!==snapshot.target.scopeId)throw Error("MEMORY_EVOLUTION_TARGET_MISMATCH");
    const revision=`evaluated:${randomUUID()}`;
    persist({schema:1,revision,parentRevision:current.revision,fields,contentHash:procedureCandidateHash(JSON.stringify(fields)),origin:"evaluated",createdAt:Date.now(),receiptId:receipt.id,candidateHash:receipt.candidateHash,snapshotDigest:procedureSnapshotDigest(snapshot),corpus});
    return freeze(revision,fields);
  });
}
export function rollbackMemoryEvolutionPolicy(ticket:object,expectedRevision:string,targetRevision:string):MemoryEvolutionPolicy {
  requireMemoryOwner(ticket);
  return transaction(()=>{
    const current=readMemoryEvolutionPolicy();if(current.revision!==expectedRevision)throw Error("MEMORY_EVOLUTION_CONFLICT");
    const target=readMemoryEvolutionPolicy(targetRevision),fields=memoryEvolutionFieldsSchema.parse({extraction:target.extraction,retrieval:target.retrieval}),revision=`rollback:${randomUUID()}`;
    persist({schema:1,revision,parentRevision:current.revision,fields,contentHash:procedureCandidateHash(JSON.stringify(fields)),origin:"rollback",createdAt:Date.now(),rollbackOf:targetRevision,...targetRevision!=="baseline"?{corpus:readRevision(targetRevision).corpus}:{}});
    return freeze(revision,fields);
  });
}
export function memoryEvolutionHistory(ticket:object) {
  requireMemoryOwner(ticket);
  const current=readMemoryEvolutionPolicy();
  const rows=database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-evolution-revision' AND state='granted' ORDER BY rowid DESC").all();
  return {current,revisions:rows.map(row=>{const record=JSON.parse(String(row.intent)) as PolicyRevision;return {...record,fields:readMemoryEvolutionPolicy(record.revision)};})};
}
