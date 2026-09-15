import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { admitMemoryEvolutionCorpus, publishMemoryEvolutionPolicy, readMemoryEvolutionPolicy, rollbackMemoryEvolutionPolicy } from "./evolution-policy.ts";
import { evaluateProcedureWithGepa, type ProcedureEvaluatorOptions } from "./gepa-evaluator.ts";
import { memoryRecallCorpus, recallPolicyEvaluator } from "./gepa-recall-corpus.ts";
import { classificationPolicyEvaluator, memoryClassificationCorpus } from "./gepa-classification-corpus.ts";
import { procedureOutcomeCorpus, procedureOutcomeEvaluator } from "./gepa-procedure-corpus.ts";
import type { ProcedureReviewSnapshot } from "./procedure-review.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const worker = fileURLToPath(new URL("../../native/gepa/gepa-worker.py", import.meta.url));
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
function setup() {
  const policy = readMemoryEvolutionPolicy(), corpus = memoryRecallCorpus(), ticket = ownerMemoryTicket();
  const admission = admitMemoryEvolutionCorpus(ticket, { kind: "synthetic", corpusDigest: hash(corpus), holdoutDigest: hash([corpus.id, corpus.version, corpus.groupBy, corpus.holdout]) });
  const state = memoryState(), scopeId = ensureScope("workspace", state.installationId);
  const snapshot: ProcedureReviewSnapshot = { requestId: "actual-gepa-policy", scopeId, target: { kind: "memory-policy", scopeId, ownerId: "workspace-owner", artifactId: "memory-policy", baseRevision: policy.revision, threadId: "memory-policy", bundleId: hash(policy) }, evidenceDigest: hash([]), evidence: [], policyRevision: state.policyRevision, deletionEpoch: state.deletionEpoch, learningRevision: readMemoryLearning(database()).revision, outcomeBasis: "source-reported" };
  let reflections = 0;
  const options: ProcedureEvaluatorOptions = {
    command: { executable: process.env.MURAGE_GEPA_PYTHON ?? "/not-admitted/python", args: ["-I", worker], cwd: DATA_DIR, expectedPythonVersion: process.env.MURAGE_GEPA_PYTHON_VERSION ?? "0.0.0" },
    workerDigest: createHash("sha256").update(readFileSync(worker)).digest("hex"), evaluatorId: "synthetic-recall-groups-v1-scripted-reflection", seedInstruction: JSON.stringify({ extraction: policy.extraction, retrieval: policy.retrieval }), corpus,
    budget: { totalUsd: 0, evaluationPerCaseUsd: 0, reflectionUsd: 0, authorityReference: "isolated-synthetic-no-provider" },
    evaluate: recallPolicyEvaluator({ extraction: policy.extraction, retrieval: policy.retrieval }),
    reflect: async () => ({ text: "```\n" + JSON.stringify({ extraction: policy.extraction, retrieval: { semanticBandRatio: ++reflections === 1 ? 0.5 : 0.7, rareFacetDivisor: 4 } }) + "\n```", costUsd: 0 }),
    assertCurrent: value => { const current = memoryState(); if (current.policyRevision !== value.policyRevision || current.deletionEpoch !== value.deletionEpoch || readMemoryEvolutionPolicy().revision !== value.target.baseRevision) throw Error("SOURCE_REVOKED"); },
  };
  return { options, snapshot, policy, admission, ticket, reflections: () => reflections };
}
it("rejects leaked split groups and an unpriced configured dollar ceiling before any worker or provider", async () => {
  const f = setup();
  f.options.corpus.holdout[0].groups.person = f.options.corpus.train[0].groups.person;
  await expect(evaluateProcedureWithGepa(f.snapshot, f.options, new AbortController().signal)).rejects.toThrow("GEPA_CORPUS_GROUP_OVERLAP");
  f.options.corpus = memoryRecallCorpus(); f.options.budget.reflectionUsd = null;
  await expect(evaluateProcedureWithGepa(f.snapshot, f.options, new AbortController().signal)).rejects.toThrow("GEPA_COST_AUTHORITY_REQUIRED");
  expect(f.reflections()).toBe(0);
});
it.skipIf(!process.env.MURAGE_GEPA_PYTHON || !process.env.MURAGE_GEPA_PYTHON_VERSION).each([true, false])("actual pinned GEPA improves untouched groups and preserves cost-known=%s through publication and rollback", async (costKnown) => {
  const f = setup();
  if (!costKnown) {
    f.options.budget.totalUsd = null;
    f.options.budget.reflectionUsd = null;
    const reflect = f.options.reflect;
    f.options.reflect = async (...args) => ({ ...await reflect(...args), costUsd: null });
  }
  const receipt = await evaluateProcedureWithGepa(f.snapshot, f.options, new AbortController().signal);
  expect(f.reflections()).toBe(2);
  expect(receipt).toMatchObject({ decision: "accepted", accounting: { actualCostUsd: costKnown ? 0 : null, costKnown, metricCalls: 16, reflectionCalls: 2 }, heldout: { untouched: true, cases: 2, candidate: 1, regressions: 0 } });
  expect(receipt.heldout.baseline).toBeLessThan(receipt.heldout.candidate);
  const published = publishMemoryEvolutionPolicy(f.snapshot, receipt, f.admission);
  expect(readMemoryEvolutionPolicy().retrieval.semanticBandRatio).toBe(0.7);
  const restored = rollbackMemoryEvolutionPolicy(f.ticket, published.revision, "baseline");
  expect(restored.retrieval).toEqual(f.policy.retrieval); expect(restored.revision).not.toBe("baseline");
  expect(() => publishMemoryEvolutionPolicy(f.snapshot, receipt, f.admission)).toThrow("MEMORY_EVOLUTION_CONFLICT");
}, 40_000);

it.skipIf(!process.env.MURAGE_GEPA_PYTHON || !process.env.MURAGE_GEPA_PYTHON_VERSION)("actual GEPA evaluates classification guidance through production framing/parser and publishes only the held-out improvement", async () => {
  const f=setup(),corpus=memoryClassificationCorpus();
  f.options.corpus=corpus;f.options.evaluatorId="synthetic-classification-scripted-model-v1";
  const admission=admitMemoryEvolutionCorpus(f.ticket,{kind:"synthetic",corpusDigest:hash(corpus),holdoutDigest:hash([corpus.id,corpus.version,corpus.groupBy,corpus.holdout])});
  let reflections=0,requests=0;
  f.options.reflect=async()=>({text:"```\n"+JSON.stringify({extraction:{classificationGuidance:++reflections===1?"Treat fictional history as observation.":"Preserve explicit corrections and label invited fiction as character-canon."},retrieval:f.policy.retrieval})+"\n```",costUsd:0});
  f.options.evaluate=classificationPolicyEvaluator(f.policy,async(source,messages)=>{
    // Scripted model seam: actual GEPA, immutable source framing, objective
    // labels and production parsing run. This is not semantic-model proof.
    requests++;
    const guidance=messages[0].content.split("Supplemental classification guidance")[1]??"";
    const correct=guidance.includes("Preserve explicit corrections"),bad=guidance.includes("Treat fictional history");
    const candidates=source.split("\n").filter(line=>!line.startsWith("Untrusted")&&(correct||!line.startsWith("Owner correction"))).map(line=>{
      const quote=line.slice(line.indexOf(": ")+2),startByte=Buffer.byteLength(source.slice(0,source.indexOf(quote)));
      return {text:quote,quote,startByte,endByte:startByte+Buffer.byteLength(quote),claimType:line.startsWith("Owner invitation")?(bad?"observation":"character-canon"):"owner-statement",update:line.startsWith("Owner correction")};
    });
    return {text:JSON.stringify(candidates),costUsd:0};
  });
  const receipt=await evaluateProcedureWithGepa(f.snapshot,f.options,new AbortController().signal);
  expect(reflections).toBe(2);expect(requests).toBeGreaterThan(0);
  expect(receipt).toMatchObject({decision:"accepted",heldout:{cases:1,candidate:1,regressions:0},accounting:{costKnown:true,actualCostUsd:0}});
  expect(receipt.heldout.baseline).toBeLessThan(1);
  const completedRequests=requests;closeDatabase();
  const replay=await evaluateProcedureWithGepa(f.snapshot,f.options,new AbortController().signal);
  expect(replay).toEqual(receipt);expect(requests).toBe(completedRequests);expect(reflections).toBe(2);
  publishMemoryEvolutionPolicy(f.snapshot,receipt,admission);
  expect(readMemoryEvolutionPolicy().extraction.classificationGuidance).toBe("Preserve explicit corrections and label invited fiction as character-canon.");
  expect(readMemoryEvolutionPolicy().retrieval).toEqual(f.policy.retrieval);
},65_000);

it.skipIf(!process.env.MURAGE_GEPA_PYTHON || !process.env.MURAGE_GEPA_PYTHON_VERSION)("actual GEPA improves simulated procedure outcomes while retaining the exact skill identity and preconditions",async()=>{
  const f=setup(),header="---\nname: outcome-report\ndescription: Report simulated work outcomes.\n---\n\n## Preconditions\nUse simulated-file-check-v1 observations only. No external actions.\n\n";
  const seed=header+"## Method\nTreat reported completed tasks as verified.\n";
  const good=header+"## Method\nRequire a matching verification receipt before reporting success; otherwise completed claims remain unconfirmed. Preserve failures.\n";
  f.snapshot.target={...f.snapshot.target,kind:"skill",ownerId:"fixture-bot",artifactId:"outcome-report",threadId:"fixture-thread"};
  f.options.corpus=procedureOutcomeCorpus();f.options.seedInstruction=seed;f.options.evaluatorId="synthetic-procedure-scripted-model-v1";
  let reflections=0;
  f.options.reflect=async()=>({text:"```\n"+(++reflections===1?header+"## Method\nAlways claim verification.\n":good)+"```",costUsd:0});
  f.options.evaluate=procedureOutcomeEvaluator(seed,"skill",async(_source,messages)=>{
    const input=JSON.parse(messages[1].content) as {procedure:string;task:{observations:Array<{id:string;reported:string;verified:boolean;evidenceId:string|null}>}};
    const corrected=input.procedure.includes("Require a matching verification receipt"),always=input.procedure.includes("Always claim verification");
    return {text:JSON.stringify({results:input.task.observations.map(item=>({id:item.id,status:always?"verified":item.reported==="failed"?"failed":corrected&&!item.verified?"unconfirmed":"verified",evidenceIds:item.evidenceId?[item.evidenceId]:[]})),actions:[]}),costUsd:0};
  });
  const receipt=await evaluateProcedureWithGepa(f.snapshot,f.options,new AbortController().signal);
  expect(reflections).toBe(2);expect(receipt).toMatchObject({decision:"accepted",candidate:good.trim(),heldout:{cases:1,baseline:0,candidate:1,regressions:0}});
  expect(f.options.seedInstruction).toBe(seed);
},40_000);
