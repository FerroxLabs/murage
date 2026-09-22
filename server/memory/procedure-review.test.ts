import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { enqueueProcedureCorrectionReview, pendingProcedureReviews, processProcedureReview, procedureCandidateHash,
  procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt, type ProcedureReviewHost, type ProcedureReviewSnapshot, type ProcedureReviewTarget } from "./procedure-review.ts";

beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster({bots:[{id:"bot",threadId:"thread"}],groups:[]});setMemoryMode("capture");});
afterEach(()=>vi.useRealTimers());
const signal=()=>new AbortController().signal;
function scope(){return String(database().prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key='thread'").get()!.id);}
function settle(turn="turn"){
  transaction(db=>{
    captureSource(db,{id:`tool:${turn}`,threadId:"thread",turnId:turn,kind:"tool-outcome",speaker:"tool",outcome:"failed",text:"Expected output missing",action:{label:"synthetic-check",reportedOutcome:"failed",verification:"tool-reported"}});
    captureSource(db,{id:`turn:${turn}`,threadId:"thread",turnId:turn,kind:"turn",speaker:"harness",outcome:"completed",text:"Turn completed."});
  });
}
function target():ProcedureReviewTarget{return {kind:"skill",scopeId:scope(),ownerId:"bot",artifactId:"synthetic",baseRevision:"reviewed-1",threadId:"thread",bundleId:"fixture-bundle"};}
function host():ProcedureReviewHost{return {resolveTargets:()=>[target()],isTargetCurrent:()=>true,canReadEvidence:(review,evidence)=>review===evidence,canPublish:()=>true,publish:vi.fn()};}
function intent(id:string){return JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));}
async function expand(h:ProcedureReviewHost){for(const id of pendingProcedureReviews(4))await processProcedureReview(id,h,signal());return String(database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%' ORDER BY rowid DESC LIMIT 1").get()!.id);}
function receipt(snapshot:ProcedureReviewSnapshot):ProcedureEvaluationReceipt{
  const candidate="Use the observed result before claiming success.";
  return {id:"fixture-receipt",requestId:snapshot.requestId,targetDigest:procedureTargetDigest(snapshot.target),snapshotDigest:procedureSnapshotDigest(snapshot),evidenceDigest:snapshot.evidenceDigest,candidate,candidateHash:procedureCandidateHash(candidate),evaluator:"deterministic-fixture-v1",decision:"accepted",heldout:{corpusDigest:"a".repeat(64),untouched:true,cases:2,baseline:0.5,candidate:1,regressions:0},budgetRespected:true,cancelled:false};
}

it("atomically enqueues terminal revisions once and retains lifecycle versus tool outcomes",async()=>{
  settle();settle();expect(pendingProcedureReviews()).toHaveLength(1);
  const h=host(),id=await expand(h);h.evaluate=vi.fn(async (snapshot:ProcedureReviewSnapshot)=>{expect(snapshot.outcomeBasis).toBe("source-reported");expect(snapshot.evidence.map(e=>e.outcome)).toContain("failed");expect(snapshot.evidence.map(e=>e.outcome)).toContain("completed");return receipt(snapshot);});
  await processProcedureReview(id,h,signal());expect(h.evaluate).toHaveBeenCalledTimes(1);expect(h.publish).toHaveBeenCalledTimes(1);
  await processProcedureReview(id,h,signal());expect(h.evaluate).toHaveBeenCalledTimes(1);
});
it("rolls source and queue back together",()=>{
  expect(()=>transaction(db=>{captureSource(db,{id:"rollback",threadId:"thread",turnId:"rollback",kind:"turn",speaker:"harness",outcome:"completed",text:"Turn completed."});throw Error("fixture rollback");})).toThrow("fixture rollback");
  expect(database().prepare("SELECT id FROM memory_sources WHERE id='rollback'").get()).toBeUndefined();expect(pendingProcedureReviews()).toEqual([]);
});
it("defers absent evaluator and broader audience without publishing or spending",async()=>{
  settle();const h=host(),id=await expand(h);await processProcedureReview(id,h,signal());expect(intent(id).reason).toBe("procedure-evaluator-unavailable");
  h.evaluate=vi.fn(async snapshot=>receipt(snapshot));h.canPublish=()=>false;
  await processProcedureReview(id,h,signal());expect(intent(id).reason).toBe("scope-widening-unavailable");expect(h.evaluate).not.toHaveBeenCalled();expect(h.publish).not.toHaveBeenCalled();
});
it("coalesces two pending trajectories for the same artifact without duplicating source handles",async()=>{
  const h=host();settle("one");await expand(h);settle("two");await expand(h);
  const rows=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all();expect(rows).toHaveLength(1);
  const evidence=JSON.parse(String(rows[0].intent)).evidence;expect(evidence).toHaveLength(4);expect(new Set(evidence.map((e:{id:string})=>e.id)).size).toBe(4);
});
it("rejects stale sources, policy and learning revisions before any publication",async()=>{
  settle();const h=host(),id=await expand(h);h.evaluate=async snapshot=>{database().prepare("UPDATE memory_sources SET state='retired' WHERE id='tool:turn'").run();return receipt(snapshot);};
  await processProcedureReview(id,h,signal());expect(h.publish).not.toHaveBeenCalled();expect(intent(id).reason).toBe("PROCEDURE_EVIDENCE_STALE");
  database().prepare("UPDATE memory_learning_config SET revision=revision+1 WHERE id=1").run();await processProcedureReview(id,h,signal());expect(intent(id).status).toBe("cancelled");
});
it("rejects a receipt for other bytes or a holdout regression",async()=>{
  settle();const h=host(),id=await expand(h);h.evaluate=async snapshot=>({...receipt(snapshot),candidateHash:"b".repeat(64)});
  await processProcedureReview(id,h,signal());expect(intent(id).reason).toBe("PROCEDURE_RECEIPT_MISMATCH");expect(h.publish).not.toHaveBeenCalled();
  h.evaluate=async snapshot=>{const result=receipt(snapshot);result.heldout.regressions=1;return result;};
  await processProcedureReview(id,h,signal());expect(intent(id).reason).toBe("PROCEDURE_HELDOUT_REJECTED");expect(h.publish).not.toHaveBeenCalled();
});
it("reuses durable receipt after restart and recovers already committed publication",async()=>{
  settle();const h=host(),id=await expand(h);h.evaluate=vi.fn(async snapshot=>receipt(snapshot));let applied=false;
  h.publish=()=>{applied=true;throw Error("fixture acknowledgement interruption");};await processProcedureReview(id,h,signal());expect(intent(id).receipt.id).toBe("fixture-receipt");
  closeDatabase();h.wasPublished=()=>applied;h.isTargetCurrent=()=>false;await processProcedureReview(id,h,signal());expect(intent(id).status).toBe("complete");expect(h.evaluate).toHaveBeenCalledTimes(1);
});
it("direct owner correction records its own text without borrowing superseded evidence",async()=>{
  settle();database().prepare("DELETE FROM memory_scope_bindings WHERE id LIKE 'procedure-trigger:%'").run();
  transaction(db=>{db.prepare("INSERT INTO memory_records VALUES('edited',1,?,'procedure','Check the actual artifact','owner-statement','active',0,?,NULL,NULL,?)").run(scope(),Date.now(),Date.now());enqueueProcedureCorrectionReview(db,"edited",1);});
  const h=host(),id=await expand(h);h.evaluate=async snapshot=>{expect(snapshot.evidence).toMatchObject([{kind:"record",id:"edited",text:"Check the actual artifact"}]);return receipt(snapshot);};
  await processProcedureReview(id,h,signal());expect(h.publish).toHaveBeenCalledTimes(1);
});
it("settles an authorized task with no mutable procedure as no change",async()=>{
  settle();const h=host();h.resolveTargets=()=>[];const [id]=pendingProcedureReviews();await processProcedureReview(id,h,signal());expect(intent(id)).toMatchObject({status:"complete",reason:"no-applicable-procedure"});
});
it("reauthorizes unstarted reviews after learning resume but refuses revoked evidence",async()=>{
  settle();const h=host(),id=await expand(h);await processProcedureReview(id,h,signal());
  database().exec("UPDATE memory_learning_config SET revision=revision+1,settings=json_set(settings,'$.automaticProcedures',json('false'))");expect(pendingProcedureReviews()).toEqual([]);
  database().exec("UPDATE memory_learning_config SET revision=revision+1,settings=json_set(settings,'$.automaticProcedures',json('true'))");
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1; UPDATE memory_learning_config SET revision=revision+1");
  h.evaluate=async snapshot=>receipt(snapshot);await processProcedureReview(id,h,signal());expect(intent(id).status).toBe("complete");expect(h.publish).toHaveBeenCalledTimes(1);
  settle("revoked");const revoked=await expand(h);h.canReadEvidence=()=>false;
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+1");await processProcedureReview(revoked,h,signal());expect(intent(revoked).status).toBe("cancelled");expect(h.publish).toHaveBeenCalledTimes(1);
});
it("requires explicit authorization for original source scopes different from corrected record scope",async()=>{
  settle();database().prepare("DELETE FROM memory_scope_bindings WHERE id LIKE 'procedure-trigger:%'").run();
  database().prepare("INSERT INTO memory_scopes VALUES('correction-scope','bot','bot','[]',0)").run();
  transaction(db=>{db.prepare("INSERT INTO memory_records VALUES('shared-edit',1,'correction-scope','procedure','Corrected owner instruction','owner-statement','active',0,?,NULL,NULL,?)").run(Date.now(),Date.now());db.prepare("INSERT INTO memory_evidence VALUES('shared-edit',1,'tool:turn',1,0,7)").run();enqueueProcedureCorrectionReview(db,"shared-edit",1);});
  const h=host();h.canReadEvidence=(review,source)=>review===source||review==="correction-scope"&&source===scope();
  h.resolveTargets=()=>[{...target(),scopeId:"correction-scope"}];
  const id=await expand(h);h.evaluate=async snapshot=>{expect(new Set(snapshot.evidence.map(e=>e.scopeId))).toEqual(new Set(["correction-scope",scope()]));return receipt(snapshot);};
  await processProcedureReview(id,h,signal());expect(h.publish).toHaveBeenCalledTimes(1);
});
it("cancels a waiting evaluator without publishing its later result",async()=>{
  settle();const h=host(),id=await expand(h),controller=new AbortController();let finish!:(result:ProcedureEvaluationReceipt)=>void;let input!:ProcedureReviewSnapshot;
  h.evaluate=async snapshot=>{input=snapshot;return new Promise(resolve=>{finish=resolve;});};
  const work=processProcedureReview(id,h,controller.signal);controller.abort();await work;finish(receipt(input));await Promise.resolve();expect(h.publish).not.toHaveBeenCalled();expect(intent(id).reason).toBe("PROCEDURE_REVIEW_CANCELLED");
});
it("expands seventeen targets in bounded visits across restart without losing or duplicating targets",async()=>{
  settle();const h=host();h.resolveTargets=()=>Array.from({length:17},(_,i)=>({...target(),artifactId:`skill-${i}`}));
  const [trigger]=pendingProcedureReviews();await processProcedureReview(trigger,h,signal());
  expect(intent(trigger)).toMatchObject({status:"pending",targetCursor:16});
  expect(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").get()?.n).toBe(16);
  closeDatabase();h.resolveTargets=()=>Array.from({length:17},(_,i)=>({...target(),artifactId:`skill-${16-i}`}));
  await processProcedureReview(trigger,h,signal());expect(intent(trigger)).toMatchObject({status:"complete",targetCursor:17});
  expect(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").get()?.n).toBe(17);
  settle("followup");const next=String(database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-trigger:%' ORDER BY rowid DESC LIMIT 1").get()!.id);
  await processProcedureReview(next,h,signal());await processProcedureReview(next,h,signal());
  const rows=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all();expect(rows).toHaveLength(17);
  for(const row of rows)expect(JSON.parse(String(row.intent)).evidence).toHaveLength(4);
});
it("coalesces authorized conversations into their shared private bot target audience",async()=>{
  settle("first");const firstScope=scope();
  database().prepare("INSERT INTO memory_scopes VALUES('private-target','bot','bot','[]',0)").run();
  transaction(db=>captureSource(db,{id:"second-turn",threadId:"second-thread",turnId:"second",kind:"turn",speaker:"harness",outcome:"completed",text:"Turn completed."}));
  const secondScope=String(database().prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key='second-thread'").get()!.id);
  const h=host();h.resolveTargets=trigger=>[{...target(),scopeId:"private-target",threadId:trigger.threadId!,bundleId:`bundle-${trigger.threadId}`}];
  h.canReadEvidence=(review,source)=>review===source||review==="private-target"&&[firstScope,secondScope].includes(source);
  const triggers=database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-trigger:%' ORDER BY rowid").all();
  for(const row of triggers)await processProcedureReview(String(row.id),h,signal());
  const rows=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all();expect(rows).toHaveLength(1);
  const review=JSON.parse(String(rows[0].intent));expect(review.scopeId).toBe("private-target");expect(review.evidence).toHaveLength(3);
  expect(intent(String(triggers[0].id)).scopeId).toBe(firstScope);expect(intent(String(triggers[1].id)).scopeId).toBe(secondScope);
});

// A QUEUE THAT CANNOT MOVE MUST NOT COST ANYTHING.
//
// The owner's server burned two thirds of a CPU core continuously, for as
// long as it ran, while nothing at all was happening. Ninety-one procedure
// reviews sat deferred with reason PROCEDURE_MODEL_UNAVAILABLE, forty-four of
// them carrying the maximum sixty-four pieces of evidence. Once a second the
// idle poll picked one, hydrated every piece, walked each one's transitive
// provenance (up to 256 nodes, five SQL statements compiled per node), and
// only THEN asked whether there was an evaluator to hand the result to. There
// wasn't, and never would be, so it deferred for sixty seconds and did it
// again. Two snapshots of the real store eleven minutes apart both read
// ninety-one deferred: the queue was not draining, it was a treadmill.
//
// The question "is there an evaluator" needs no snapshot and costs three
// config reads. These pin that it is asked FIRST — and that a review which
// already HAS a receipt is still allowed through, because that work is done
// and only needs publishing.
// AND IT STILL HAS TO BE FOUND AND PARKED.
//
// The first version of this fix also stopped `pendingProcedureReviews` from
// offering a review while no evaluator existed. That is cheaper still, and it
// is wrong: B34's Q14 scenario pins that with no model selected BOTH reviews
// are discovered and come to rest as deferred/PROCEDURE_MODEL_UNAVAILABLE
// with attempts 0, and the memory status endpoint lists them as unstarted. A
// review nobody ever picks up stays "pending" and is never listed. The saving
// was never in skipping the review; it was in not hydrating its evidence.
it("still finds a review when no evaluator can run it, so it can be parked and listed",()=>{
  settle();settle();
  const shut:ProcedureReviewHost={...host(),evaluatorAvailable:()=>({ready:false,reason:"PROCEDURE_MODEL_UNAVAILABLE"})};
  expect(pendingProcedureReviews(4,shut)).toHaveLength(1);
});

it("never hydrates evidence for work no evaluator can take",async()=>{
  settle();
  const h=host(),id=await expand(h);
  let hydrated=0;
  const shut:ProcedureReviewHost={...h,
    canReadEvidence:(review,evidence)=>{hydrated++;return review===evidence;},
    evaluatorAvailable:()=>({ready:false,reason:"PROCEDURE_MODEL_UNAVAILABLE"})};
  await processProcedureReview(id,shut,signal());
  expect(hydrated,"the cheap question has to be asked before the expensive one").toBe(0);
  // The shape B34's Q14 scenario waits for, spelled out here too.
  expect(intent(id).status).toBe("deferred");
  expect(intent(id).reason).toBe("PROCEDURE_MODEL_UNAVAILABLE");
  expect(intent(id).snapshot).toBeUndefined();
  expect(intent(id).attempts ?? 0).toBe(0);
});

// A TRIGGER IS DISCOVERY, NOT EVALUATION.
//
// Gating the whole of processProcedureReview on "is there an evaluator" also
// gated the trigger that EXPANDS into the review rows, so with no model
// selected the queue stayed empty instead of parked: B34's Q14 scenario sat
// waiting for two reviews and saw `rv=0` until it timed out. The rows a
// trigger creates carry no trigger of their own, so they meet the gate on
// their next visit — which is where the saving was always meant to come from.
it("expands a trigger into reviews even with no evaluator, then parks those reviews",async()=>{
  settle();
  const shut:ProcedureReviewHost={...host(),evaluatorAvailable:()=>({ready:false,reason:"PROCEDURE_MODEL_UNAVAILABLE"})};
  const id=await expand(shut);
  expect(id,"the trigger still has to produce a review row").toBeTruthy();

  await processProcedureReview(id,shut,signal());
  expect(intent(id).status).toBe("deferred");
  expect(intent(id).reason).toBe("PROCEDURE_MODEL_UNAVAILABLE");
});
