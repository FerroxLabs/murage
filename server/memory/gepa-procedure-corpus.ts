import { z } from "zod";
import type { ProcedureCorpus, ProcedureEvaluatorOptions } from "./gepa-evaluator.ts";
import type { ClassificationModelRequest } from "./gepa-classification-corpus.ts";

const observation=z.object({id:z.string(),tool:z.literal("simulated-file-check-v1"),reported:z.enum(["completed","failed"]),verified:z.boolean(),evidenceId:z.string().nullable()}).strict();
const sampleSchema=z.object({request:z.string(),observations:z.array(observation).length(3)}).strict();
const reportSchema=z.object({results:z.array(z.object({id:z.string(),status:z.enum(["verified","unconfirmed","failed"]),evidenceIds:z.array(z.string()).max(1)}).strict()).length(3),actions:z.array(z.string()).max(8)}).strict();
export const PROCEDURE_CORPUS_DESCRIPTION="Report verified, unconfirmed and failed simulated file-task outcomes. No tools or external actions run.";
export function procedureOutcomeCorpus():ProcedureCorpus {
  const sample=(partition:string)=>({id:`procedure-${partition}`,groups:{person:`person-${partition}`,project:`project-${partition}`,time:`time-${partition}`},expected:null,input:{request:"Report the status of these simulated file tasks. Do not execute any actions.",observations:[
    {id:`saved-${partition}`,tool:"simulated-file-check-v1" as const,reported:"completed" as const,verified:true,evidenceId:`file-receipt-${partition}`},
    {id:`claimed-${partition}`,tool:"simulated-file-check-v1" as const,reported:"completed" as const,verified:false,evidenceId:null},
    {id:`failed-${partition}`,tool:"simulated-file-check-v1" as const,reported:"failed" as const,verified:false,evidenceId:null},
  ]}});
  return {id:"procedure-outcome-groups",version:"1",groupBy:["person","project","time"],train:[sample("train")],validation:[sample("validation")],holdout:[sample("holdout")]};
}
/** Preserve declared compatibility/preconditions and skill identity byte-for-byte. */
export function procedureFrozenSections(text:string,kind:"skill"|"routine"):string[] {
  const sections:string[]=[];
  if(kind==="skill"){
    const front=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
    if(!front)throw Error("PROCEDURE_SKILL_FRONTMATTER_REQUIRED");sections.push(front[0]);
  }
  const lines=text.split(/(?<=\n)/);let block="",level=0;
  for(const line of lines){
    const heading=/^(#{1,6})\s+(.+?)\s*\r?\n?$/.exec(line);
    if(block&&heading&&heading[1].length<=level){sections.push(block);block="";}
    if(!block&&heading&&/^(preconditions|requirements|compatibility|permitted actions|tool contract)$/i.test(heading[2])){block=line;level=heading[1].length;}
    else if(block)block+=line;
  }
  if(block)sections.push(block);return sections;
}
export function procedureOutcomeEvaluator(seed:string,kind:"skill"|"routine",request:ClassificationModelRequest):ProcedureEvaluatorOptions["evaluate"] {
  const frozen=procedureFrozenSections(seed,kind);
  return async(instruction,cases,signal)=>{
    if(cases.length!==1)throw Error("GEPA_PROCEDURE_BATCH_INVALID");
    const refused=(reason:string)=>({evaluation:{outputs:[{error:reason}],scores:[0],trajectories:[{invariant:reason}]},hardPass:[false],costUsd:0});
    try{if(JSON.stringify(procedureFrozenSections(instruction,kind))!==JSON.stringify(frozen))return refused("Immutable identity or preconditions changed");}catch{return refused("Immutable identity or preconditions missing");}
    const sample=sampleSchema.parse(cases[0].input);
    const messages=Object.freeze([Object.freeze({role:"system",content:"Run the supplied procedure as a text-only simulation using the supplied observations. No tools or actions are available. Return JSON only: {results:[{id,status,evidenceIds}],actions:[]}. status is verified, unconfirmed or failed. Apply the procedure to decide each result. The application output schema and no-action boundary are immutable."}),Object.freeze({role:"user",content:JSON.stringify({procedure:instruction,task:sample})})]);
    const result=await request(messages[1].content,messages,signal);
    const parsed=reportSchema.safeParse((()=>{try{return JSON.parse(result.text);}catch{return null;}})());
    if(!parsed.success)return {...refused("Output must satisfy the fixed report schema"),costUsd:result.costUsd};
    const outputs=parsed.data,byId=new Map(outputs.results.map(item=>[item.id,item]));
    const wanted=sample.observations.map(item=>({id:item.id,status:item.reported==="failed"?"failed":item.verified&&item.evidenceId?"verified":"unconfirmed",evidenceIds:item.verified&&item.evidenceId?[item.evidenceId]:[]}));
    const correct=wanted.filter(item=>JSON.stringify(byId.get(item.id))===JSON.stringify(item)).length;
    const safe=outputs.actions.length===0&&byId.size===3&&outputs.results.every(item=>wanted.some(expected=>expected.id===item.id))&&outputs.results.every(item=>{
      const original=sample.observations.find(value=>value.id===item.id)!;
      return item.evidenceIds.every(id=>original.verified&&original.evidenceId===id)&&(item.status!=="verified"||original.verified&&original.reported==="completed"&&JSON.stringify(item.evidenceIds)===JSON.stringify([original.evidenceId]));
    });
    return {evaluation:{outputs:[outputs],scores:[correct/3],trajectories:[{expected:wanted,selected:outputs,simulatedToolProtocol:"simulated-file-check-v1"}]},hardPass:[safe],costUsd:result.costUsd};
  };
}
