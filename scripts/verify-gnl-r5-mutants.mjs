import { archivedEvidencePath, evidencePath } from './evidence-path.mjs';
// Actual production reversions in disposable fixtures, with positive controls.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=process.cwd(),out=resolve(evidencePath('evidence/gnl-prod-r5/mutants'));mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-r5-mutants-'));
try{
 for(const entry of ['server','scripts','shared','src','electron','extensions','companion','tools','cloudflare','apps','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.ts','tsconfig.json'])cpSync(entry,join(root,entry),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const run=(id,file,pattern)=>{
  const dir=join(out,id);mkdirSync(dir,{recursive:true});
  const r=spawnSync('pnpm',['exec','vitest','run',file,...(pattern?['--testNamePattern='+pattern]:[]),'--maxWorkers=1','--reporter=json','--outputFile='+join(dir,'tests.json')],{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024,env:{...process.env,GNL_OWNER_POLICY_EVIDENCE:join(dir,'workflow')}});
  writeFileSync(join(dir,'run.log'),(r.stdout??'')+(r.stderr??''));
  if(existsSync(join(root,'.gnl-proof/evidence')))cpSync(join(root,'.gnl-proof/evidence'),join(dir,'workflow'),{recursive:true});
  const tests=JSON.parse(readFileSync(join(dir,'tests.json'))).testResults.flatMap(s=>s.assertionResults).filter(a=>a.status!=='skipped');
  return {status:r.status,tests:tests.map(a=>({id:a.fullName,status:a.status,assertionFailure:a.failureMessages.some(s=>s.includes('AssertionError'))}))};
 };
 const results=[];
 for(const kind of ['native','muse','project','run-index']){
  const file=kind==='native'?'server/product-routine-owner-policy-api.test.ts':kind==='muse'?'server/drivers/muse-code.test.ts':kind==='project'?'server/email/no-limits-1019-api.test.ts':'server/routines-tracked-save.test.ts';
  const pattern=kind==='muse'?'P-MUSE':kind==='run-index'?'R5 run identity|M2 conversation lookup':undefined;
  const control=run(kind+'-control',file,pattern);
  if(control.status!==0||control.tests.some(a=>a.status!=='passed'))throw Error(kind+' control failed');
  const path=join(root,kind==='muse'?'server/turn-context.ts':kind==='run-index'?'server/routines.ts':'server/index.ts'),original=readFileSync(path,'utf8');
  let mutated;
  if(kind==='native'){
   const start=original.indexOf('function decisionLiveLevel('),end=original.indexOf('function decisionContinuationInitiator',start);
   mutated=original.slice(0,start)+readFileSync(archivedEvidencePath('evidence/gnl-prod-r5/old-live-level.txt'),'utf8')+original.slice(end);
  }else if(kind==='muse')mutated=original.replace('return driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);','return TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);');
  else if(kind==='project')mutated=original.replace('ownerTyped: ownerTyped || authenticatedOwnerCard','ownerTyped');
  else mutated=original.replace('  runById(id: string): RoutineRun | null {','  runById(id: string): RoutineRun | null {\n    this.runIdIndex = undefined;');
  if(mutated===original)throw Error(kind+' mutation missing');
  try{
   writeFileSync(path,mutated);const mutant=run(kind+'-reverted',file,pattern);
   const failures=mutant.tests.filter(a=>a.status==='failed'),passing=mutant.tests.filter(a=>a.status==='passed');
   const killed=mutant.status!==0&&failures.length===(kind==='native'?3:kind==='muse'?4:1)&&passing.length===(kind==='native'?1:kind==='muse'?3:kind==='project'?14:1)&&failures.every(a=>a.assertionFailure);
   results.push({kind,killed,source:path.slice(root.length+1),originalSha256:createHash('sha256').update(original).digest('hex'),mutantSha256:createHash('sha256').update(mutated).digest('hex'),control,mutant});writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));
   if(!killed)throw Error(kind+' mutation survived or lost controls');
  }finally{writeFileSync(path,original);}
 }
}finally{if(!root.startsWith(join(tmpdir(),'gnl-r5-mutants-')))throw Error('Unexpected fixture root');rmSync(root,{recursive:true,force:true});}
