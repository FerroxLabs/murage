import {writeFileSync} from 'node:fs';
import {replayPrivateCorpus} from './private-corpus.mjs';
// Suppress before importing product code: even an exception can contain input.
console.log=console.info=console.warn=console.error=()=>{};
process.stdout.write=process.stderr.write=()=>true;
const [corpus,corpusSha,out]=process.argv.slice(2);
const publicWrite=writeFileSync;let adapter;
const save=report=>adapter?adapter.writeCounts(out,report):publicWrite(out,JSON.stringify(report)+'\n',{mode:0o600,flag:'wx'});
try{
 const {privateProductionAdapter}=await import('./private-production.mjs');
 adapter=await privateProductionAdapter({home:process.env.HOME});
 const report=await replayPrivateCorpus({corpus,corpusSha,decide:(row,input)=>adapter.decide(row,input)});
 const {wipeControls}=await import('../nolim-replay/ruling.mjs');
 const controls=wipeControls();let controlsPass=0;
 for(const row of controls){
  const got=await adapter.decide({...row,cardClass:{origin:'owner',unattended:0,automated:0},boundedToolInput:JSON.stringify(row.fullToolInput)},row.fullToolInput);
  if(got.kind==='card'&&got.cards===1&&got.why==='wipe'&&!got.refusals)controlsPass++;
 }
 await adapter.close();
 report.controls={rows:controls.length,pass:controlsPass};if(controlsPass!==controls.length)report.verdict='FAIL';
 save(report);
 process.exitCode=report.verdict==='PASS'?0:1;
}catch{
 save({verdict:'FAIL',rows:0,pass:0,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:1});
 process.exitCode=1;
}
