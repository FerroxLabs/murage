// Protocol fixture only. This executable does not run or impersonate real GEPA proof.
import readline from "node:readline";
import { realpathSync } from "node:fs";
const mode=process.argv[2]??"baseline";
const send=frame=>process.stdout.write(JSON.stringify({v:1,...frame})+"\n");
let job,proposal,parentScores,childScores;
const events=[];
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const sum=values=>values.reduce((a,b)=>a+b,0);
const evaluate=(number,candidate,captureTraces)=>send({type:"evaluate",jobId:job.jobId,callId:`${job.jobId}:evaluate:${number}`,candidate,caseIds:captureTraces?job.trainIds:job.validationIds,captureTraces});
let seedScore;
function finish(candidate,score,metrics,reflections){
  const improved=candidate!==job.candidate;
  const result={type:"result",jobId:job.jobId,bestCandidate:candidate,bestIndex:improved?1:0,
    candidates:improved?[job.candidate,candidate]:[candidate],parents:improved?[[null],[0]]:[[null]],
    validationScores:improved?[seedScore,score]:[score],metricCalls:metrics,reflectionCalls:reflections,decisionEvents:events};
  if(mode==="forged-result")result.metricCalls++;
  send(result);
  if(mode==="after-result")send({type:"ready",gepaVersion:"0.1.4",pythonVersion:"3.13.13"});
  if(mode==="nonzero")process.exitCode=7;
  input.close();process.stdin.destroy();
}
const input=readline.createInterface({input:process.stdin});
input.on("line",line=>{
  const frame=JSON.parse(line);
  if(frame.type==="cancel"){process.exitCode=1;input.close();process.stdin.destroy();return;}
  if(frame.type==="start"){
    job=frame;
    if(mode==="oversize"){process.stdout.write("x".repeat(1024*1024+1));return;}
    if(mode==="wrong-job"){send({type:"evaluate",jobId:"wrong",callId:"wrong:evaluate:1",candidate:job.candidate,caseIds:job.validationIds,captureTraces:false});return;}
    if(mode==="forged-case"){send({type:"evaluate",jobId:job.jobId,callId:`${job.jobId}:evaluate:1`,candidate:job.candidate,caseIds:["hidden-holdout"],captureTraces:false});return;}
    if(mode==="exit-empty"){input.close();process.stdin.destroy();return;}
    if(mode==="stall")return;
    if(mode==="env"){
      if(process.env.OPENAI_API_KEY||process.env.PYTHONPATH||[process.env.HOME,process.env.USERPROFILE,process.env.APPDATA].some(value=>!value||realpathSync(value)!==realpathSync(process.cwd())))throw Error("fixture environment leaked");
    }
    evaluate(1,job.candidate,false);
    if(mode==="overlap")evaluate(2,job.candidate,true);
  }else if(frame.type==="evaluate-result"){
    const number=Number(frame.callId.split(":").at(-1));
    if(number===1){seedScore=mean(frame.scores);if(mode!=="reflect")finish(job.candidate,seedScore,job.validationIds.length,0);else evaluate(2,job.candidate,true);}
    else if(number===2){parentScores=frame.scores;send({type:"reflect",jobId:job.jobId,callId:`${job.jobId}:reflect:1`,prompt:"Synthetic parent diagnostics only"});}
    else if(number===3){
      childScores=frame.scores;
      if(sum(childScores)>sum(parentScores))send({type:"evaluate",jobId:job.jobId,callId:`${job.jobId}:evaluate:4`,candidate:proposal,caseIds:job.validationIds,captureTraces:true});
      else{events.push({type:"rejected",iteration:1,oldScore:sum(parentScores),newScore:sum(childScores),reason:"fixture rejected"});finish(job.candidate,seedScore,job.validationIds.length+job.trainIds.length*2,1);}
    }else if(number===4){events.push({type:"accepted",iteration:1,candidateIndex:1,newScore:sum(childScores),parents:[0]});finish(proposal,mean(frame.scores),job.validationIds.length*2+job.trainIds.length*2,1);}
  }else if(frame.type==="reflect-result"){
    proposal={instruction:/^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/.exec(frame.text.trim())[1].trim()};
    events.push({type:"proposal",iteration:1,candidate:proposal});
    // Real GEPA's child evaluation need not request a second trajectory.
    send({type:"evaluate",jobId:job.jobId,callId:`${job.jobId}:evaluate:3`,candidate:proposal,caseIds:job.trainIds,captureTraces:false});
  }
});
send({type:"ready",gepaVersion:"0.1.4",pythonVersion:mode==="wrong-ready"?"3.14.5":"3.13.13"});
