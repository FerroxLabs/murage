// Regression guards for evaluation truthfulness. These do not stand in for the
// 240-query worker/model run, 60 native answers or the ten-minute fault/load run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scoreEvidence, summarizeEvidence } from "../../scripts/eval-memory.ts";
import { validateCorpus } from "./testing/contracts.ts";

const corpus=validateCorpus(JSON.parse(readFileSync(fileURLToPath(new URL("./testing/corpus.json",import.meta.url)),"utf8")));

it("does not average a forbidden disclosure away behind a correct top hit",()=>{
  const query=corpus.queries.find(query=>query.id==="exact-00")!;
  const score=scoreEvidence(query,[...query.expected,...query.forbidden],[...query.expected,...query.forbidden]);
  expect(score.recallAt10).toBe(1);
  expect(score.forbiddenIds).toEqual(query.forbidden);
  expect(score.precisionNumerator).toBe(1);
  expect(score.precisionDenominator).toBe(3);
  const summary=summarizeEvidence([{id:query.id,family:query.family,expected:query.expected,ranked:query.expected,delivered:[...query.expected,...query.forbidden],score}]);
  expect(summary.forbiddenCases).toEqual([query.id]);
  expect(summary.failedCases).toEqual([query.id]);
});

it("does not label an errored empty response as successful no-answer abstention",()=>{
  const query=corpus.queries.find(query=>query.family==="no-answer-negation")!;
  const score=scoreEvidence(query,[],[]);
  const failed={id:query.id,family:query.family,expected:query.expected,ranked:[],delivered:[],score,error:"MEMORY_WORKER_EXITED"};
  expect(summarizeEvidence([failed]).noAnswerAbstention).toBe(0);
  expect(summarizeEvidence([{...failed,error:undefined}]).noAnswerAbstention).toBe(1);
});

it("uses a strict top-ten boundary and refuses empty or duplicate case collections",()=>{
  const query=corpus.queries.find(query=>query.id==="exact-00")!;
  const ranked=[...Array.from({length:10},(_,i)=>`distractor-${i}`),...query.expected];
  const score=scoreEvidence(query,ranked,query.expected);
  expect(score.recallAt10).toBe(0);
  const row={id:query.id,family:query.family,expected:query.expected,ranked,delivered:query.expected,score};
  expect(()=>summarizeEvidence([])).toThrow("zero cases");
  expect(()=>summarizeEvidence([row,row])).toThrow("Duplicate evaluation case identity");
  expect(summarizeEvidence([row]).failedCases).toEqual([query.id]);
});

it("keeps the frozen balanced query, native-answer and fault-protocol obligations",()=>{
  expect(corpus.queries).toHaveLength(240);
  expect(corpus.answerCases).toHaveLength(60);
  expect(corpus.faultProtocols).toHaveLength(12);
  expect(corpus.queries.filter(query=>query.family==="long-history").every(query=>query.distractorCount===1000)).toBe(true);
});
