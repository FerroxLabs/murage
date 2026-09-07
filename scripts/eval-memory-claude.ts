// Root-operated, sequential P10 Claude cohort. Default is plan-only.
// --execute-as-root-owner explicitly delegates root's sole ledger writes to
// this process: reserve600c, await ONE guarded child, validate usage, settle a
// conservative upper cost, then continue. Any uncertainty stops without retry.
// Reuses the accepted P07 exact-00 proof; at most14 new inference requests.
// Collected answers remain PENDING_MANUAL_REVIEW under the frozen rubric.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateNativeBudget } from "./verify-memory-native.ts";

const ROOT=fileURLToPath(new URL("..",import.meta.url)),args=process.argv.slice(2);
function option(name:string){const at=args.indexOf(name);if(at<0||!args[at+1]||args[at+1].startsWith("--"))throw Error(`Required ${name}`);return args[at+1];}
function read(path:string){return JSON.parse(readFileSync(path,"utf8"));}
function atomic(path:string,value:unknown){const temporary=`${path}.${randomUUID()}.tmp`;writeFileSync(temporary,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600,flush:true});renameSync(temporary,path);}
function nonnegative(value:unknown):asserts value is number{assert(Number.isSafeInteger(value)&&Number(value)>=0,"Incomplete native usage; retain reservation");}
function conservativeCents(proof:any):number{
  assert.equal(proof.forwarded,1);assert.equal(proof.upstreamStatus,200);assert.equal(proof.result?.subtype,"success");assert.equal(proof.result.numTurns,1);
  const models=proof.result.modelUsage;assert(models&&Object.keys(models).length===1,"Unknown billed model set; retain reservation");
  const usage=models["claude-sonnet-5"];assert(usage&&usage.canonicalModel==="claude-sonnet-5"&&usage.provider==="firstParty");
  for(const key of ["inputTokens","outputTokens","cacheReadInputTokens","cacheCreationInputTokens","webSearchRequests"])nonnegative(usage[key]);
  assert.equal(usage.webSearchRequests,0);assert(usage.outputTokens>0&&usage.outputTokens<=512);
  const inputs=usage.inputTokens+usage.cacheReadInputTokens+usage.cacheCreationInputTokens;assert(inputs>0&&inputs<=1000000);
  assert(Number.isFinite(proof.result.totalCostUsdEstimate)&&proof.result.totalCostUsdEstimate>=0);
  // Highest documented cache-write charge for EVERY input token plus 10%
  // geography, even if the actual request used lower prices/no caching.
  const upper=(inputs*4+usage.outputTokens*10)/1000000*1.1;
  const cents=Math.ceil(Math.max(upper,proof.result.totalCostUsdEstimate)*100);
  assert(cents>0&&cents<=600,"Usage exceeds reservation; stop for root reconciliation");return cents;
}
async function runChild(argv:string[]):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,["--experimental-strip-types",join(ROOT,"scripts/verify-memory-claude.ts"),...argv],{cwd:ROOT,stdio:["ignore","inherit","inherit"]});
    let interrupted=false;
    const stop=()=>{interrupted=true;child.kill("SIGTERM");};process.once("SIGINT",stop);process.once("SIGTERM",stop);
    child.once("error",reject);child.once("close",code=>{process.off("SIGINT",stop);process.off("SIGTERM",stop);if(code===0&&!interrupted)resolve();else reject(Error(`Native case stopped (exit ${code}); reservation retained, no retry`));});
  });
}
async function main(){
  const profile=option("--profile-directory"),budgetPath=resolve(option("--budget-file")),reusePath=resolve(option("--reuse-proof"));
  const corpusPath=join(ROOT,"server/memory/testing/corpus.json"),corpus=read(corpusPath),corpusSha256=createHash("sha256").update(readFileSync(corpusPath)).digest("hex");
  const cases=corpus.answerCases.filter((row:any)=>row.driver==="claude");assert.equal(cases.length,15);assert.equal(cases[0].queryId,"exact-00");
  const reused=read(reusePath),budget=read(budgetPath);validateNativeBudget(budget);
  assert.equal(reused.queryId,"exact-00");assert.equal(reused.corpusSha256,corpusSha256);conservativeCents(reused);
  assert(reused.answer.includes("source-00")&&/\b(two|2)\b/i.test(reused.answer),"Prior exact-00 proof did not pass its answer checks");
  assert(budget.settlements.some((row:any)=>row.reservationId===reused.reservationId),"Prior proof must already be settled by root");
  if(!args.includes("--execute-as-root-owner")){
    console.log(JSON.stringify({operation:"plan-only",newCalls:14,reuse:reusePath,cases:cases.slice(1).map((row:any)=>({id:row.id,queryId:row.queryId})),reservationPerCallCents:600,ledgerOwner:"root",evaluationKind:"pinned-reference answer evaluation",answerRubricStatus:"PENDING_MANUAL_REVIEW",paidCalls:0}));return;
  }
  const lock=`${budgetPath}.claude-cohort.lock`,owner=randomUUID(),output=join(dirname(budgetPath),"p10-claude-cohort.json");
  writeFileSync(lock,owner,{flag:"wx",mode:0o600});
  const results:any[]=[{...cases[0],proofPath:reusePath,reused:true,answer:reused.answer,transportStatus:"PRIOR_P07_PASS_REUSED",answerRubricStatus:"PENDING_MANUAL_REVIEW"}];
  const save=()=>atomic(output,{corpusSha256,evaluationKind:"pinned-reference answer evaluation; separate from240-query retrieval",answerRubricStatus:"PENDING_MANUAL_REVIEW",results,remainingCaseIds:cases.filter((row:any)=>!results.some(result=>result.id===row.id)).map((row:any)=>row.id)});
  const updateBudget=(change:(next:any)=>void)=>{
    const original=readFileSync(budgetPath,"utf8"),next=JSON.parse(original);validateNativeBudget(next);change(next);validateNativeBudget(next);
    assert.equal(readFileSync(budgetPath,"utf8"),original,"Concurrent ledger edit; stopping");atomic(budgetPath,next);
  };
  try{
    save();
    for(const answerCase of cases.slice(1)){
      const reservationId=`p10-claude-${answerCase.id}`,proofPath=join(dirname(budgetPath),`claude-${reservationId}.proof.json`);
      const existing=read(budgetPath).reservations.find((row:any)=>row.id===reservationId||row.answerCaseId===answerCase.id&&row.driver==="claude");
      // Never silently retry or rename an earlier attempt, settled or otherwise.
      assert(!existing,`Case ${answerCase.id} already has an attempt; root must reuse/reconcile it explicitly`);
      assert(!existsSync(proofPath),`Case ${answerCase.id} already has evidence; no automatic replacement`);
      updateBudget(next=>{next.reservations.push({id:reservationId,package:"P10",turns:1,maximumCostCents:600,answerCaseId:answerCase.id,queryId:answerCase.queryId,driver:"claude"});});
      console.log(JSON.stringify({caseId:answerCase.id,status:"reserved",maximumCostCents:600}));
      await runChild(["--profile-directory",profile,"--budget-file",budgetPath,"--reservation-id",reservationId,"--query-id",answerCase.queryId]);
      const proof=read(proofPath);
      assert.equal(proof.reservationId,reservationId);assert.equal(proof.queryId,answerCase.queryId);assert.equal(proof.answerCaseId,answerCase.id);assert.equal(proof.corpusSha256,corpusSha256);assert.equal(proof.transportStatus,"PASS");
      assert.equal(proof.answerRubricStatus,"PENDING_MANUAL_REVIEW");assert.equal(proof.evaluationKind,"pinned-reference answer evaluation");
      const maximumSettledCents=conservativeCents(proof);
      updateBudget(next=>{assert(!next.settlements.some((row:any)=>row.reservationId===reservationId));next.settlements.push({reservationId,actualCostCents:maximumSettledCents,basis:"conservative upper bound from validated native token usage, not authoritative invoice"});});
      results.push({...answerCase,proofPath,reused:false,answer:proof.answer,transportStatus:"PASS",answerRubricStatus:"PENDING_MANUAL_REVIEW",conservativeCostCents:maximumSettledCents});save();
      console.log(JSON.stringify({caseId:answerCase.id,status:"collected-awaiting-manual-rubric",conservativeCostCents:maximumSettledCents}));
    }
    console.log(JSON.stringify({ok:true,collectionOnly:true,cases:results.length,newCalls:14,output,answerRubricStatus:"PENDING_MANUAL_REVIEW"}));
  }finally{save();if(existsSync(lock)&&readFileSync(lock,"utf8")===owner)rmSync(lock);}
}
main().catch(error=>{console.error(error instanceof Error?error.message:"CLAUDE_COHORT_FAILED");process.exitCode=1;});
