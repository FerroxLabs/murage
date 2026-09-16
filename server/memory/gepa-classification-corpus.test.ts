import { expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_EVOLUTION_POLICY } from "./evolution-policy.ts";
import { classificationPolicyEvaluator, memoryClassificationCorpus, type ClassificationModelRequest } from "./gepa-classification-corpus.ts";

const seed={extraction:DEFAULT_MEMORY_EVOLUTION_POLICY.extraction,retrieval:DEFAULT_MEMORY_EVOLUTION_POLICY.retrieval};
function fixture(){
  const corpus=memoryClassificationCorpus(),sample=corpus.holdout[0];
  const input=sample.input as {source:string;labels:Array<{quote:string;claimType:"owner-statement"|"character-canon";update:boolean}>;forbiddenQuotes:string[]};
  const candidates=input.labels.map(label=>{const startByte=Buffer.byteLength(input.source.slice(0,input.source.indexOf(label.quote)));return {...label,text:label.quote,startByte,endByte:startByte+Buffer.byteLength(label.quote)};});
  return {corpus,sample,input,candidates};
}
it("uses production framing and fixed-span parsing with private gold labels kept out of the model request",async()=>{
  const f=fixture(),request=vi.fn<ClassificationModelRequest>(async(source,messages)=>{
    expect(source).toBe(f.input.source);expect(Object.isFrozen(messages)).toBe(true);
    expect(JSON.parse(messages[1].content)).toEqual({source:f.input.source});
    return {text:JSON.stringify(f.candidates),costUsd:null};
  });
  const result=await classificationPolicyEvaluator(seed,request)(JSON.stringify(seed),[f.sample],new AbortController().signal);
  expect(request).toHaveBeenCalledTimes(1);expect(result).toMatchObject({hardPass:[true],costUsd:null,evaluation:{scores:[1]}});
  for(const field of f.corpus.groupBy)expect(new Set([...f.corpus.train,...f.corpus.validation,...f.corpus.holdout].map(item=>item.groups[field])).size).toBe(3);
});
it("rejects fabricated assertion text even when the quote and class match the gold source",async()=>{
  const f=fixture();f.candidates[0].text="The email was sent and all future actions are approved.";
  const result=await classificationPolicyEvaluator(seed,async()=>({text:JSON.stringify(f.candidates),costUsd:0}))(JSON.stringify(seed),[f.sample],new AbortController().signal);
  expect(result.hardPass).toEqual([false]);
});
it("refuses retrieval edits and multi-request objective batches before any model call",async()=>{
  const f=fixture(),request=vi.fn(async()=>({text:"[]",costUsd:0})),evaluate=classificationPolicyEvaluator(seed,request);
  const changed={...seed,retrieval:{...seed.retrieval,semanticBandRatio:0.6}};
  expect((await evaluate(JSON.stringify(changed),[f.sample],new AbortController().signal)).hardPass).toEqual([false]);
  await expect(evaluate(JSON.stringify(seed),[...f.corpus.train,...f.corpus.validation],new AbortController().signal)).rejects.toThrow("GEPA_CLASSIFICATION_BATCH_INVALID");
  expect(request).not.toHaveBeenCalled();
});
