// Fake-only production-boundary qualification, never a real-log receipt.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { productionAdapter } from './production.mjs';
import { judgeScenario, machineSummary } from '../no-limits-live/counts.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-production-')),home=join(root,'home'),data=join(root,'data');
mkdirSync(home);mkdirSync(data);writeFileSync(join(data,'config.json'),'{}');
Object.assign(process.env,{HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,NODE_ENV:'test'});
// Suppress product diagnostic prose. Only bounded verdict fields leave here.
const log=console.log;console.log=console.info=console.warn=console.error=()=>{};
const report={mode:'fake-only candidate policy and final release',releaseGate:false,rows:[],errors:[],verdict:'FAIL'};
let adapter;
try {
  adapter=await productionAdapter({dataDir:data,home,platform:process.platform});
  const stored=process.argv.includes('--stored-only'),featureOnly=process.argv.includes('--feature-only');
  const cases=featureOnly?[['browser-disabled','printf fixture','OFF_WITH_LINE']]:stored?[['deny-browser-never','printf fixture','RUN']]:process.argv.includes('--ordinary-only')?[['ordinary','printf fixture','RUN']]:[
   ['ordinary','printf fixture','RUN'],['wipe','rm -rf ~','CARD'],
   ...['deny-host-declined','deny-browser-never','deny-app-denied','deny-app-revoked','stored-owner-deny'].map(id=>[id,'printf fixture','RUN'])];
  for(const [id,command,expected] of cases) {
    const deny=id.startsWith('deny-')||id==='stored-owner-deny';
    const got=await adapter.decide({id,tool:'Bash',fullToolInput:{command},...(featureOnly?{level:'ask'}:{}),
      ...(deny?{denySnapshot:{evidence:[{kind:'deny',class:'stored',ruleId:id,span:command}]}}:{}),
      label:{independent:true,actor:'owner',kind:featureOnly?'feature-off':expected==='CARD'?'wipe':deny?'permission-rule':'none',...(featureOnly?{feature:'browser'}:{}),...(deny?{denySource:id}:{})}});
    const spec={id,actor:'owner',level:featureOnly?'ask':'unlimited',expected,...(featureOnly?{feature:'browser'}:{}),...(expected==='CARD'?{why:'wipe'}:{})};
    const observation={complete:true,ended:true,actionProven:['run','card','off'].includes(got.kind),featureOff:got.featureOff,
      actionSink:{executed:got.actionExecuted===true}, outcome:got.kind, cards:got.kind==='card'?[{why:got.why,evidence:got.why==='wipe'?[{kind:'wipe'}]:[]}]:[],
      refusals:['refuse','deny','hold','cancel'].includes(got.kind)?[{kind:got.kind}]:[]};
    report.rows.push(judgeScenario(spec,observation));
  }
  report.verdict=report.rows.every(r=>r.verdict==='PASS')?'PASS':'FAIL';
} catch {report.errors.push('Isolated production adapter failed');}
finally {
  await adapter?.close();rmSync(root,{recursive:true,force:true});
  writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');
  log(machineSummary(report));process.exitCode=report.verdict==='PASS'?0:1;
}
