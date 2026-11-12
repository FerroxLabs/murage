import {writeFileSync} from 'node:fs';
import {replayPrivateCorpus} from './private-corpus.mjs';
// Suppress before importing product code: even an exception can contain input.
console.log=console.info=console.warn=console.error=()=>{};
const [corpus,corpusSha,out]=process.argv.slice(2);
try{
 const {autoVerdict}=await import('../../server/auto-approve.ts');
 const report=await replayPrivateCorpus({corpus,corpusSha,decide:async(row,input)=>{
  const origin=row.cardClass?.origin??'other';
  const noLimitsOrigin=origin==='other'?'other-human':origin;
  const bot={id:'private-replay',autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
  return autoVerdict(bot,row.tool,row.boundedToolInput??'Recorded private operation',{
   noLimitsOrigin,fullAccessOrigin:origin,ownerStarted:origin==='owner',
   unattended:row.cardClass?.unattended!==0,automated:row.cardClass?.automated!==0,
   routineLevel:origin==='routine',channelOwner:origin==='owner-channel',outsideRead:null,
   workFolder:process.env.HOME,commandCwd:process.env.HOME,commandText:typeof input?.command==='string'?input.command:undefined,
   inputTruncated:Boolean(row.toolInputTruncated),
   call:{engine:'claude',toolCall:{name:row.tool,input},truncated:Boolean(row.toolInputTruncated)},promptFacts:{cwd:process.env.HOME,home:process.env.HOME},
  });
 }});
 const {wipeControls}=await import('../nolim-replay/ruling.mjs');
 const controls=wipeControls();let controlsPass=0;
 for(const row of controls){const command=row.fullToolInput.command;
  const got=autoVerdict({id:'wipe-control',autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true},row.tool,command,{
   noLimitsOrigin:'owner',fullAccessOrigin:'owner',ownerStarted:true,commandText:command,
   commandCwd:process.env.HOME,workFolder:process.env.HOME,promptFacts:{cwd:process.env.HOME,home:process.env.HOME},
   call:{engine:'claude',toolCall:{name:row.tool,input:row.fullToolInput}},
  });
  if(got.approve===null&&/^(delete-home|delete-root|delete-system-folder|disk-erase|fork-bomb|plainWipe)$/.test(got.rule??''))controlsPass++;
 }
 report.controls={rows:controls.length,pass:controlsPass};if(controlsPass!==controls.length)report.verdict='FAIL';
 writeFileSync(out,JSON.stringify(report)+'\n',{mode:0o600,flag:'wx'});
 process.exitCode=report.verdict==='PASS'?0:1;
}catch{
 writeFileSync(out,JSON.stringify({verdict:'FAIL',rows:0,pass:0,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:1})+'\n',{mode:0o600,flag:'wx'});
 process.exitCode=1;
}
