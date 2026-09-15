import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureReviewSnapshot, type ProcedureEvaluationReceipt } from "./procedure-review.ts";
import { admitMemoryEvolutionCorpus, resumeMemoryEvolutionAdmission, publishMemoryEvolutionPolicy, rollbackMemoryEvolutionPolicy, readMemoryEvolutionPolicy, memoryEvolutionFieldsSchema, DEFAULT_MEMORY_EVOLUTION_POLICY, type MemoryEvolutionFields } from "./evolution-policy.ts";
import { extractCandidates, memoryExtractionMessages, type MemoryExtractionDispatch } from "./extract.ts";
import { selectMemoryEvidence } from "./relevance.ts";
import { searchMemory } from "./search.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
const roster={bots:[{id:"policy-bot",threadId:"policy-thread"}],groups:[]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);setMemoryMode("capture");});
const fields=(ratio=0.7,guidance=""):MemoryEvolutionFields=>({extraction:{classificationGuidance:guidance},retrieval:{semanticBandRatio:ratio,rareFacetDivisor:4}});
it("revokes superseded corpus grants only within their host-selected family",()=>{
  const ticket=ownerMemoryTicket(),corpus={kind:"synthetic" as const,corpusDigest:"a".repeat(64),holdoutDigest:"b".repeat(64)};
  const recall=admitMemoryEvolutionCorpus(ticket,{...corpus,family:"recall"}),classification=admitMemoryEvolutionCorpus(ticket,{...corpus,family:"classification"});
  expect(resumeMemoryEvolutionAdmission(recall.id)).not.toBeNull();expect(resumeMemoryEvolutionAdmission(classification.id)).not.toBeNull();
  const legacy=admitMemoryEvolutionCorpus(ticket,corpus);admitMemoryEvolutionCorpus(ticket,{...corpus,corpusDigest:"c".repeat(64)});expect(resumeMemoryEvolutionAdmission(legacy.id)).toBeNull();
  expect(resumeMemoryEvolutionAdmission(recall.id)).not.toBeNull();expect(resumeMemoryEvolutionAdmission(classification.id)).not.toBeNull();
});
function proposal(input=fields()){
  const policy=readMemoryEvolutionPolicy(),state=memoryState(),scopeId=ensureScope("workspace",state.installationId);
  const snapshot:ProcedureReviewSnapshot={requestId:`policy-review:${policy.revision}`,scopeId,target:{kind:"memory-policy",scopeId,ownerId:"workspace-owner",artifactId:"memory-policy",threadId:"memory-policy",baseRevision:policy.revision,bundleId:procedureCandidateHash(JSON.stringify(policy))},policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,learningRevision:readMemoryLearning(database()).revision,evidence:[],evidenceDigest:procedureCandidateHash("[]"),outcomeBasis:"source-reported"};
  const candidate=JSON.stringify(input),corpusDigest="a".repeat(64),holdoutDigest="b".repeat(64);
  const receipt:ProcedureEvaluationReceipt={id:`receipt:${policy.revision}`,requestId:snapshot.requestId,snapshotDigest:procedureSnapshotDigest(snapshot),targetDigest:procedureTargetDigest(snapshot.target),evidenceDigest:snapshot.evidenceDigest,candidate,candidateHash:procedureCandidateHash(candidate),corpusDigest,evaluator:"objective-fixture",decision:"accepted",heldout:{corpusDigest:holdoutDigest,untouched:true,cases:2,baseline:0.5,candidate:1,regressions:0},budgetRespected:true,cancelled:false};
  const admission=admitMemoryEvolutionCorpus(ownerMemoryTicket(),{kind:"synthetic",corpusDigest,holdoutDigest});return {snapshot,receipt,admission};
}
it("enforces fixed mutable fields and byte bounds without admitting budgets/access/canon",()=>{
  expect(memoryEvolutionFieldsSchema.parse(fields())).toEqual(fields());
  for(const input of [{...fields(),budget:2000},fields(0.49),fields(1.01),{...fields(),retrieval:{semanticBandRatio:0.8,rareFacetDivisor:9}},fields(0.8,"ก".repeat(700))])expect(()=>memoryEvolutionFieldsSchema.parse(input)).toThrow();
  expect(readMemoryEvolutionPolicy()).toEqual(DEFAULT_MEMORY_EVOLUTION_POLICY);
});
it("requires real owner corpus admission including training digest and resumes it without minting a ticket",()=>{
  const p=proposal();expect(()=>publishMemoryEvolutionPolicy(p.snapshot,p.receipt,{id:p.admission.id})).toThrow("ADMISSION_REQUIRED");
  expect(()=>publishMemoryEvolutionPolicy(p.snapshot,{...p.receipt,corpusDigest:"c".repeat(64)},p.admission)).toThrow("ADMISSION_REQUIRED");
  closeDatabase();const resumed=resumeMemoryEvolutionAdmission(p.admission.id)!;expect(resumed).toBeTruthy();
  const accepted=publishMemoryEvolutionPolicy(p.snapshot,p.receipt,resumed);expect(accepted.retrieval.semanticBandRatio).toBe(0.7);
  expect(publishMemoryEvolutionPolicy(p.snapshot,p.receipt,resumed).revision).toBe(accepted.revision);
  database().exec("UPDATE memory_learning_config SET settings=json_set(settings,'$.reviewMode',json('true'))");expect(resumeMemoryEvolutionAdmission(p.admission.id)).toBeNull();
});
it("rollback has fresh CAS identity and retained policies remain immutable for in-flight work",()=>{
  const original=readMemoryEvolutionPolicy(),p=proposal();const accepted=publishMemoryEvolutionPolicy(p.snapshot,p.receipt,p.admission);
  const rollback=rollbackMemoryEvolutionPolicy(ownerMemoryTicket(),accepted.revision,"baseline");expect(rollback.revision).not.toBe("baseline");expect(rollback.retrieval).toEqual(original.retrieval);
  expect(readMemoryEvolutionPolicy(accepted.revision)).toEqual(accepted);expect(original.retrieval.semanticBandRatio).toBe(0.8);
  expect(()=>publishMemoryEvolutionPolicy(p.snapshot,p.receipt,p.admission)).toThrow("MEMORY_EVOLUTION_CONFLICT");
  expect(()=>rollbackMemoryEvolutionPolicy({},rollback.revision,"baseline")).toThrow("MEMORY_OWNER_REQUIRED");
});
it("frozen classification messages sent to the extractor equal the reserved input despite a later policy publication",async()=>{
  const frozen=readMemoryEvolutionPolicy(),p=proposal(fields(0.7,"Classify completed observations separately from intentions."));let captured:MemoryExtractionDispatch|undefined;
  const source="The parcel arrived.",before=readMemoryLearning(database());
  const result=await extractCandidates(source,async(_text,_maximum,_signal,dispatch)=>{captured=dispatch;publishMemoryEvolutionPolicy(p.snapshot,p.receipt,p.admission);return "[]";},new AbortController().signal,frozen);
  expect(result.status).toBe("complete");expect(captured?.policyRevision).toBe(frozen.revision);expect(captured?.messages).toEqual(memoryExtractionMessages(source,frozen));expect(JSON.stringify(captured?.messages)).not.toContain("Classify completed observations");
  const budget=database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!;expect(JSON.parse(String(budget.intent)).input).toBe(Buffer.byteLength(JSON.stringify(captured?.messages)));
  expect(readMemoryLearning(database())).toEqual(before);expect(memoryExtractionMessages(source,readMemoryEvolutionPolicy())[0]!.content).toContain("Classify completed observations");
  expect(memoryExtractionMessages(source)[0]!.content).not.toContain("Classify completed observations");
});
it("objective held-out recall distinguishes the ratio and affects actual search-to-bundle optional context",async()=>{
  const scope=ensureScope("bot","policy-bot"),rows=[{id:"direct",text:"Shipments arrive every Tuesday.",similarity:1},{id:"synonym",text:"Stock reaches receiving each Friday.",similarity:0.72},{id:"unrelated",text:"The office paints its walls blue.",similarity:0.1}];
  const query="When do shipments arrive?";
  for(const row of rows)database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(row.id,scope,row.text);
  const registry=new InternalCapabilities(),generation=registry.begin("policy-bot","policy-thread"),token=registry.mint({botId:"policy-bot",threadId:"policy-thread",generation,depth:0,kind:"memory",skillAuthoring:false});
  const access=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster),bridge={search:async()=>({hits:rows.map((row,index)=>({id:row.id,version:1,score:1/(index+1),similarity:row.similarity})),vectorRows:3,coverageComplete:true})};
  const baseline=readMemoryEvolutionPolicy(),p=proposal(),candidate=publishMemoryEvolutionPolicy(p.snapshot,p.receipt,p.admission);
  expect(selectMemoryEvidence(query,rows,baseline).map(row=>row.id)).toEqual(["direct"]);
  expect(selectMemoryEvidence(query,rows,candidate).map(row=>row.id)).toEqual(["direct","synonym"]);
  expect((await searchMemory(query,access,bridge,{evolutionPolicy:baseline})).hits.map(row=>row.id)).toEqual(["direct"]);
  const bundle=await buildMemoryBundle(query,access,bridge,{evolutionPolicy:candidate});expect(bundle.evidence.map(row=>row.id)).toEqual(["direct","synonym"]);expect(bundle.evolutionPolicyRevision).toBe(candidate.revision);
  expect(bundle.tokenCount).toBeLessThanOrEqual(2048);expect(bundle.text).not.toContain("walls blue");
  expect(selectMemoryEvidence("Find ticket INC-431",[{text:"INC-432 is closed",similarity:1}],candidate)).toEqual([]);
});

it("a resumed consolidation source retains the original classification policy across slices",async()=>{
  const text="a".repeat(20000);
  captureSource(database(),{id:"long-source",threadId:"policy-thread",kind:"text",speaker:"owner",outcome:"recorded",text});
  const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
  const p=proposal(fields(0.7,"New classification guidance")),seen:string[]=[];
  const first=await consolidateMemorySource(work.id,async(_text,_limit,_signal,dispatch)=>{seen.push(dispatch!.policyRevision);publishMemoryEvolutionPolicy(p.snapshot,p.receipt,p.admission);return "[]";},new AbortController().signal);
  expect(first.status).toBe("partial");closeDatabase();
  const second=await consolidateMemorySource(work.id,async(_text,_limit,_signal,dispatch)=>{seen.push(dispatch!.policyRevision);expect(JSON.stringify(dispatch!.messages)).not.toContain("New classification guidance");return "[]";},new AbortController().signal);
  expect(second.status).toBe("complete");expect(seen).toEqual(["baseline","baseline"]);expect(readMemoryEvolutionPolicy().extraction.classificationGuidance).toBe("New classification guidance");
});
