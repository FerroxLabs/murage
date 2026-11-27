// Owner: sc-safety-rd (focused/touched by-ID comparison under MAIN D2).
// Owner: MAIN (full integration related-set/full-suite train comparison).
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {reviewedPrechecks} from './reviewed-prechecks.mjs';
import { safeWipeSync } from '../../../server/testing/safe-wipe.mjs';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const base=resolve(process.env.SC_BASE_DIR??''),out=resolve(process.env.SC_OUT??'');
if(!process.env.SC_BASE_DIR||!process.env.SC_OUT||!relative(root,base).startsWith('..')||!relative(root,out).startsWith('..')||out==='/dev'||out.startsWith('/dev/'))throw Error('External baseline and evidence directories required');
const requested=JSON.parse(process.env.SC_FOCUSED_FILES_JSON??'[]');
if(!requested.length||new Set(requested).size!==requested.length)throw Error('Explicit distinct focused/touched test inventory required');
// The integration fixture's unsafe double cast is replaced by checked fields
// under G8. Include every direct consumer of that authorization fixture.
const files=[...new Set([...requested,'server/shared-work.test.ts','server/channels/permission-approvals.test.ts',
 'server/channels/permission-service.test.ts','server/host-computer-consent.test.ts','server/telegram-approvals.test.ts'])];
mkdirSync(out,{recursive:true});
await reviewedPrechecks(root,out);
const runs={};
for(const[side,cwd]of [['head',root],['base',base]]){
 const scratch=mkdtempSync(join(out,`${side}-env-`)),home=join(scratch,'home'),data=join(scratch,'data'),config=join(scratch,'gitconfig');
 mkdirSync(home);mkdirSync(data);writeFileSync(config,'');
 const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:home,CI:'1',LANG:'C.UTF-8',TZ:'UTC',NO_COLOR:'1',FORCE_COLOR:'0',NODE_OPTIONS:'--max-old-space-size=12000',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',MURAGE_E2E_DATA_DIR:data,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
 const selected=files.filter(file=>existsSync(join(cwd,file))),absent=files.filter(file=>!selected.includes(file));
 const report=join(out,`${side}.json`),log=join(out,`${side}.log`),started=Date.now();
 env.SC_ASSERTION_IDENTITY_REPORT=join(out,`${side}-assertions.json`);
 try{
  const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...selected,'--reporter=json',`--reporter=${join(root,'scripts/verification/sc-safety/assertion-reporter.mjs')}`,`--outputFile=${report}`],{cwd,env,encoding:'utf8',timeout:3600000,maxBuffer:64*1024*1024});
  writeFileSync(log,(run.stdout??'')+(run.stderr??''));
  let suites=[];try{suites=JSON.parse(readFileSync(report,'utf8')).testResults;}catch{}
  const rows=suites.flatMap(suite=>(suite.assertionResults??[]).map(test=>({id:`${relative(cwd,suite.name)} :: ${test.fullName}`,status:test.status})));
  const reportedFiles=suites.map(suite=>relative(cwd,suite.name));
  runs[side]={runtimeErrors:suites.filter(suite=>suite.status==='failed'&&!(suite.assertionResults??[]).length).map(suite=>relative(cwd,suite.name)),status:run.status,signal:run.signal,error:run.error?.message,elapsed:Date.now()-started,selected,absent,unreported:selected.filter(file=>!reportedFiles.includes(file)),rows,
   sourceHashes:Object.fromEntries(selected.map(file=>[file,createHash('sha256').update(readFileSync(join(cwd,file))).digest('hex')]))};
  writeFileSync(join(out,`${side}-by-id.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 }finally{safeWipeSync(scratch, { within: out });}
 process.stdout.write(`SC_FOCUSED_${side.toUpperCase()} ${runs[side].rows.length} IDs\n`);
}
const group=rows=>{const result=new Map();for(const row of rows)result.set(row.id,[...(result.get(row.id)??[]),row.status]);return result;};
const baseline=group(runs.base.rows),head=group(runs.head.rows),newFailures=[],missing=[],nonexecution=[];
for(const[id,statuses]of head){
 if(statuses.filter(status=>status==='failed').length>(baseline.get(id)??[]).filter(status=>status==='failed').length)newFailures.push(id);
 if(statuses.some(status=>status!=='passed'&&status!=='failed')&&baseline.has(id)&&baseline.get(id).every(status=>status==='passed'||status==='failed'))nonexecution.push(id);
}
for(const[id,statuses]of baseline)if((head.get(id)?.length??0)<statuses.length)missing.push(id);
const count=rows=>Object.fromEntries(['passed','failed','pending','skipped'].map(status=>[status,rows.filter(row=>row.status===status).length]));
const report={scope:'MAIN D2 focused + acceptance + touched test files; full suite belongs to MAIN',runtime:process.version,files,
 base:{...runs.base,rows:undefined,ids:runs.base.rows.length,counts:count(runs.base.rows)},head:{...runs.head,rows:undefined,ids:runs.head.rows.length,counts:count(runs.head.rows)},NEW:newFailures.length,missing:missing.length,newFailures,missingIds:missing,newNonexecutionIds:nonexecution};
report.pass=!newFailures.length&&!missing.length&&!nonexecution.length&&!runs.head.absent.length&&['base','head'].every(side=>!runs[side].error&&!runs[side].signal&&!runs[side].unreported.length&&!runs[side].runtimeErrors.length&&runs[side].rows.length>0);
writeFileSync(join(out,'FOCUSED-COMPARISON.json'),JSON.stringify(report,null,2));
process.stdout.write(`SC_SAFETY_FOCUSED_REPORT\n${JSON.stringify(report)}\n`);
process.exitCode=report.pass?0:1;
