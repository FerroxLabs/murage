import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createBoundedLineSplitter } from "./drivers/bounded-lines.ts";
import { GEPA_FRAME_BYTES, encodeGepaFrame, gepaChildFrameSchema, gepaEvaluationSchema, gepaStartSchema, validateGepaReflection,
  type GepaCandidate, type GepaChildFrame, type GepaEvaluation, type GepaJson, type GepaResult, type GepaStart } from "./gepa-protocol.ts";

export type GepaEvaluateFrame = Extract<GepaChildFrame,{type:"evaluate"}>;
export type GepaReflectFrame = Extract<GepaChildFrame,{type:"reflect"}>;
const notStartedErrors=new WeakSet<Error>();
/** Trusted handlers only: create this exclusively before any external call starts. */
export function gepaCallNotStarted():Error {
  const error=Error("GEPA_CALL_NOT_STARTED");notStartedErrors.add(error);return error;
}
export function isGepaCallNotStarted(error:unknown):error is Error {
  return error instanceof Error&&notStartedErrors.has(error);
}
export interface GepaCallLedger {
  lookupOrReserve(callId:string,inputHash:string,kind:"evaluate"|"reflect"):{state:"new"}|{state:"complete";value:GepaJson};
  complete(callId:string,inputHash:string,value:GepaJson):void;
  releaseNotStarted(callId:string,inputHash:string):void;
}
export interface GepaWorkerCommand {
  executable:string; args:readonly string[]; cwd:string; expectedPythonVersion:string;
  /** Explicit fixture/Electron Node mode; never inherited from a caller's environment. */
  runAsNode?:boolean;
}
export interface GepaWorkerOptions {
  command:GepaWorkerCommand; job:GepaStart; ledger:GepaCallLedger; signal:AbortSignal;
  handlers:{evaluate(frame:GepaEvaluateFrame,signal:AbortSignal):Promise<GepaEvaluation>;
    reflect(frame:GepaReflectFrame,signal:AbortSignal):Promise<string>};
}
export interface GepaWorkerOutcome {result:GepaResult;pythonVersion:string;stderr:string;stderrTruncated:boolean}
const hash=(frame:unknown)=>createHash("sha256").update(JSON.stringify(frame)).digest("hex");
const same=(a:GepaCandidate,b:GepaCandidate)=>a.instruction===b.instruction;
const sum=(scores:number[])=>scores.reduce((total,score)=>total+score,0);
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b));
const requireValue=(condition:unknown,code:string):void=>{if(!condition)throw Error(code);};
interface EvaluationObservation {frame:GepaEvaluateFrame;value:GepaEvaluation}
interface ReflectionObservation {candidate:GepaCandidate;parent:EvaluationObservation;child?:EvaluationObservation}

/** Validate the upstream receipt against the actual RPCs, not only its JSON shape. */
function validateResult(result:GepaResult,job:GepaStart,metrics:number,evaluations:EvaluationObservation[],reflections:ReflectionObservation[]) {
  requireValue(result.metricCalls===metrics&&result.reflectionCalls===reflections.length,"GEPA_RESULT_ACCOUNTING_INVALID");
  requireValue(result.candidates.length===result.parents.length&&result.candidates.length===result.validationScores.length,"GEPA_RESULT_ALIGNMENT_INVALID");
  requireValue(same(result.candidates[0],job.candidate)&&result.bestIndex<result.candidates.length&&same(result.bestCandidate,result.candidates[result.bestIndex]),"GEPA_RESULT_CANDIDATE_INVALID");
  const best=result.validationScores.reduce((at,score,index,scores)=>score>scores[at]?index:at,0);
  requireValue(result.bestIndex===best,"GEPA_RESULT_BEST_INVALID");
  // captureTraces requests diagnostics, not a corpus partition. GEPA may
  // evaluate proposed training candidates without collecting another trace.
  const validationIds=new Set(job.validationIds);
  const validation=evaluations.filter(item=>item.frame.caseIds.every(id=>validationIds.has(id)));
  requireValue(validation.length===result.candidates.length,"GEPA_RESULT_VALIDATION_INVALID");
  for(const [index,program] of result.candidates.entries()){
    const observation=validation[index];
    requireValue(same(program,observation.frame.candidate)&&near(result.validationScores[index],sum(observation.value.scores)/observation.value.scores.length),"GEPA_RESULT_VALIDATION_INVALID");
    requireValue(index===0?result.parents[index].length<=1&&result.parents[index].every(parent=>parent===null):result.parents[index].length===1&&result.parents[index].every(parent=>parent!==null&&parent<index),"GEPA_RESULT_PARENT_INVALID");
  }
  requireValue(result.decisionEvents.length===reflections.length*2,"GEPA_RESULT_DECISIONS_INVALID");
  let accepted=0;
  for(const [index,reflection] of reflections.entries()){
    const proposal=result.decisionEvents[index*2],decision=result.decisionEvents[index*2+1];
    requireValue(proposal.type==="proposal"&&same(proposal.candidate,reflection.candidate)&&decision.type!=="proposal"&&proposal.iteration===decision.iteration&&reflection.child,"GEPA_RESULT_DECISIONS_INVALID");
    const child=reflection.child!;
    const oldScore=sum(reflection.parent.value.scores),newScore=sum(child.value.scores);
    requireValue(JSON.stringify(child.frame.caseIds)===JSON.stringify(reflection.parent.frame.caseIds),"GEPA_RESULT_DECISIONS_INVALID");
    if(decision.type==="accepted"){
      accepted++;
      requireValue(newScore>oldScore&&near(decision.newScore,newScore)&&decision.candidateIndex===accepted&&accepted<result.candidates.length&&same(result.candidates[accepted],reflection.candidate),"GEPA_RESULT_DECISIONS_INVALID");
      requireValue(JSON.stringify(decision.parents)===JSON.stringify(result.parents[accepted])&&decision.parents.every(parent=>same(result.candidates[parent],reflection.parent.frame.candidate)),"GEPA_RESULT_PARENT_INVALID");
    }else if(decision.type==="rejected"){
      requireValue(newScore<=oldScore&&near(decision.oldScore,oldScore)&&near(decision.newScore,newScore),"GEPA_RESULT_DECISIONS_INVALID");
    }
  }
  requireValue(accepted===result.candidates.length-1,"GEPA_RESULT_DECISIONS_INVALID");
}

/** Owns exactly one child. Admission of production manifest/signatures belongs to the host. */
export async function runGepaWorker(options:GepaWorkerOptions):Promise<GepaWorkerOutcome> {
  const job=gepaStartSchema.parse(options.job),command=options.command;
  requireValue(isAbsolute(command.executable)&&isAbsolute(command.cwd),"GEPA_COMMAND_INVALID");
  const directory=lstatSync(command.cwd);
  requireValue(directory.isDirectory()&&!directory.isSymbolicLink()&&/^\d+\.\d+\.\d+$/.test(command.expectedPythonVersion),"GEPA_COMMAND_INVALID");
  if(options.signal.aborted)throw Error("GEPA_CANCELLED");
  const env:NodeJS.ProcessEnv={HOME:command.cwd,USERPROFILE:command.cwd,APPDATA:command.cwd,
    PYTHONNOUSERSITE:"1",PYTHONDONTWRITEBYTECODE:"1"};
  for(const key of ["SystemRoot","TMPDIR","TEMP","TMP"] as const)if(process.env[key])env[key]=process.env[key];
  if(command.runAsNode)env.ELECTRON_RUN_AS_NODE="1";
  const child=spawn(command.executable,[...command.args],{cwd:command.cwd,env,shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const controller=new AbortController(),evaluations:EvaluationObservation[]=[],reflections:ReflectionObservation[]=[];
  let ready=false,pythonVersion="",terminal:GepaResult|undefined,pending=false,failed:Error|undefined,closed=false;
  let metrics=0,reflectionCalls=0,evaluationCalls=0,stderr=Buffer.alloc(0),stderrTruncated=false;
  let killTimer:ReturnType<typeof setTimeout>|undefined;
  const allowedTrain=new Set(job.trainIds),allowedValidation=new Set(job.validationIds);
  const errorCode=(error:unknown,fallback:string)=>error instanceof Error&&error.message!=="GEPA_CALL_NOT_STARTED"&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:fallback;
  return await new Promise<GepaWorkerOutcome>((resolve,reject)=>{
    const finishFailure=(code:string,notStarted?:Error)=>{
      if(failed||closed)return;
      failed=notStarted&&isGepaCallNotStarted(notStarted)?notStarted:Error(code);controller.abort(failed);
      // Cooperate first, then stop only this owned process if it remains alive.
      if(ready&&!child.stdin.destroyed)child.stdin.write(encodeGepaFrame({v:1,type:"cancel",jobId:job.jobId}),()=>{});
      child.kill("SIGTERM");
      killTimer=setTimeout(()=>{if(!closed)child.kill("SIGKILL");},200);killTimer.unref();
    };
    const abort=()=>finishFailure("GEPA_CANCELLED");
    options.signal.addEventListener("abort",abort,{once:true});
    if(options.signal.aborted)abort();
    const deadline=setTimeout(()=>finishFailure("GEPA_WALL_LIMIT"),job.limits.wallMs);deadline.unref();
    const active=()=>{if(failed||closed||controller.signal.aborted)throw Error("GEPA_CANCELLED");};
    const write=async(frame:unknown)=>{
      active();const text=encodeGepaFrame(frame);requireValue(Buffer.byteLength(text)<=GEPA_FRAME_BYTES,"GEPA_FRAME_LIMIT");
      await new Promise<void>((done,fail)=>child.stdin.write(text,error=>error?fail(Error("GEPA_STDIN_FAILED")):done()));
    };
    const rpc=async(frame:GepaEvaluateFrame|GepaReflectFrame)=>{
      let releasedNotStarted:Error|undefined;
      try{
        const inputHash=hash(frame),cached=options.ledger.lookupOrReserve(frame.callId,inputHash,frame.type);
        active();
        const invoke=async<T>(handler:()=>Promise<T>):Promise<T>=>{
          try{return await handler();}
          catch(error){
            if(isGepaCallNotStarted(error)){
              options.ledger.releaseNotStarted(frame.callId,inputHash);
              releasedNotStarted=error;
            }
            throw error;
          }
        };
        if(frame.type==="evaluate"){
          const value=gepaEvaluationSchema.parse(cached.state==="complete"?cached.value:await invoke(()=>options.handlers.evaluate(structuredClone(frame),controller.signal)));
          active();
          requireValue(value.outputs.length===frame.caseIds.length&&value.scores.length===frame.caseIds.length&&(frame.captureTraces?value.trajectories?.length===frame.caseIds.length:value.trajectories===null),"GEPA_EVALUATION_ALIGNMENT_INVALID");
          const reply={v:1,type:"evaluate-result",jobId:job.jobId,callId:frame.callId,...value};encodeGepaFrame(reply);
          if(cached.state==="new")options.ledger.complete(frame.callId,inputHash,value);
          const observation={frame,value};evaluations.push(observation);
          const reflection=reflections.at(-1);
          if(reflection&&!reflection.child&&frame.caseIds.every(id=>allowedTrain.has(id))){
            requireValue(same(frame.candidate,reflection.candidate)&&JSON.stringify(frame.caseIds)===JSON.stringify(reflection.parent.frame.caseIds),"GEPA_PROPOSAL_EVALUATION_INVALID");reflection.child=observation;
          }
          await write(reply);
        }else{
          const raw=cached.state==="complete"?cached.value:await invoke(()=>options.handlers.reflect(structuredClone(frame),controller.signal));
          active();requireValue(typeof raw==="string","GEPA_REFLECTION_INVALID");
          const text=validateGepaReflection(raw as string),match=/^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/.exec(text)!;
          const parent=evaluations.at(-1);
          requireValue(parent?.frame.captureTraces&&parent.frame.caseIds.every(id=>allowedTrain.has(id))&&(!reflections.length||Boolean(reflections.at(-1)!.child)),"GEPA_REFLECTION_ORDER_INVALID");
          const reply={v:1,type:"reflect-result",jobId:job.jobId,callId:frame.callId,text};encodeGepaFrame(reply);
          if(cached.state==="new")options.ledger.complete(frame.callId,inputHash,text);
          reflections.push({candidate:{instruction:match[1].trim()},parent:parent!});
          await write(reply);
        }
      }catch(error){if(releasedNotStarted===error)finishFailure("GEPA_CALL_NOT_STARTED",releasedNotStarted);else finishFailure(errorCode(error,"GEPA_RPC_FAILED"));}
      finally{pending=false;}
    };
    const lines=createBoundedLineSplitter({maxBytes:GEPA_FRAME_BYTES-1,onOverflow:()=>finishFailure("GEPA_FRAME_LIMIT"),onLine:line=>{
      if(failed||closed)return;
      try{
        // Bound nesting before recursive schemas. The child is not trusted to
        // turn malformed JSON into an unbounded recursive validation task.
        const raw:unknown=JSON.parse(line);let count=0;const stack:Array<[unknown,number]>=[[raw,0]];
        while(stack.length){const [value,depth]=stack.pop()!;requireValue(depth<=32&&++count<=50000,"GEPA_FRAME_COMPLEXITY_LIMIT");if(value&&typeof value==="object")for(const item of Object.values(value))stack.push([item,depth+1]);}
        const frame=gepaChildFrameSchema.parse(raw);
        requireValue(!terminal,"GEPA_FRAME_AFTER_RESULT");
        if(frame.type==="ready"){
          requireValue(!ready&&!pending&&frame.pythonVersion===command.expectedPythonVersion,"GEPA_READY_INVALID");
          ready=true;pythonVersion=frame.pythonVersion;void write(job).catch(()=>finishFailure("GEPA_STDIN_FAILED"));return;
        }
        requireValue(ready&&frame.jobId===job.jobId,"GEPA_JOB_INVALID");
        if(frame.type==="failed"){finishFailure(`GEPA_CHILD_${frame.code}`);return;}
        requireValue(!pending,"GEPA_RPC_OVERLAP");
        if(frame.type==="result"){
          validateResult(frame,job,metrics,evaluations,reflections);terminal=frame;return;
        }
        if(frame.type==="evaluate"){
          requireValue(frame.callId===`${job.jobId}:evaluate:${evaluationCalls+1}`,"GEPA_CALL_SEQUENCE_INVALID");
          const training=frame.caseIds.every(id=>allowedTrain.has(id)),validation=frame.caseIds.every(id=>allowedValidation.has(id));
          requireValue(new Set(frame.caseIds).size===frame.caseIds.length&&(training||validation),"GEPA_CASE_INVALID");
          if(validation)requireValue(frame.caseIds.length===job.validationIds.length,"GEPA_VALIDATION_INCOMPLETE");
          requireValue([job.candidate,...reflections.map(item=>item.candidate)].some(program=>same(program,frame.candidate)),"GEPA_CANDIDATE_UNPROPOSED");
          requireValue(metrics+frame.caseIds.length<=job.limits.maxMetricCalls,"GEPA_METRIC_LIMIT");
          metrics+=frame.caseIds.length;evaluationCalls++;
        }else{
          requireValue(frame.callId===`${job.jobId}:reflect:${reflectionCalls+1}`,"GEPA_CALL_SEQUENCE_INVALID");
          requireValue(reflectionCalls<job.limits.maxReflections,"GEPA_REFLECTION_LIMIT");reflectionCalls++;
        }
        pending=true;void rpc(frame);
      }catch(error){finishFailure(errorCode(error,"GEPA_PROTOCOL_INVALID"));}
    }});
    const decoder=new TextDecoder("utf-8",{fatal:true});
    child.stdout.on("data",(chunk:Buffer)=>{try{decoder.decode(chunk,{stream:true});lines.push(chunk);}catch{finishFailure("GEPA_UTF8_INVALID");}});
    child.stderr.on("data",(chunk:Buffer)=>{
      if(stderr.length<65536){const remaining=65536-stderr.length;stderr=Buffer.concat([stderr,chunk.subarray(0,remaining)]);if(chunk.length>remaining)stderrTruncated=true;}
      else stderrTruncated=true;
    });
    child.stdin.on("error",()=>finishFailure("GEPA_STDIN_FAILED"));
    child.on("error",()=>finishFailure("GEPA_SPAWN_FAILED"));
    child.on("close",code=>{
      closed=true;clearTimeout(deadline);if(killTimer)clearTimeout(killTimer);options.signal.removeEventListener("abort",abort);
      const partial=lines.bufferedBytes;lines.close();controller.abort();
      if(failed){reject(failed);return;}
      try{decoder.decode();}catch{reject(Error("GEPA_UTF8_INVALID"));return;}
      if(code!==0||!terminal||pending||partial){reject(Error(code!==0?"GEPA_EXIT_NONZERO":"GEPA_RESULT_INCOMPLETE"));return;}
      resolve({result:terminal,pythonVersion,stderr:stderr.toString("utf8"),stderrTruncated});
    });
  });
}
