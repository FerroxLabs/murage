// Executed in network-none test containers; controls and mutants use disposable source copies.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const source=process.cwd(),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-r3-mutants-')),results=[];
const extract=s=>s.slice(s.indexOf('function authority('),s.indexOf('\nconst targetOf=',s.indexOf('function authority(')));
try{
 for(const file of JSON.parse(readFileSync('evidence/gnl-prod/fixture-files.json','utf8'))){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));}
 // The historical inventory predates imports added to the current runtime.
 // Controls and mutants must both run against the complete current modules.
 for(const directory of ['server','shared'])cpSync(join(source,directory),join(root,directory),{recursive:true});
 cpSync(join(source,'server/product-routine-ceiling-api.test.ts'),join(root,'server/product-routine-ceiling-api.test.ts'));
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const cases=[
  {id:'H2-real-service-projection',file:'server/index.ts',tests:['server/product-routine-ceiling-api.test.ts'],pattern:'H2 real ask',mutate:s=>s.replace('const effective = live && applyResolvedRoutineCeilings(live, [ceiling, opts?.continuationPermissionMode, opts?.askerWakeCeiling]);','const effective = live;')},
  {id:'H1-recover-before-checks',file:'server/decision/implementation.ts',tests:['server/decision/product-origin.test.ts'],pattern:'H1 owner-owned thread',mutate:s=>s.replace(extract(s),readFileSync('evidence/gnl-prod-r3/unsafe-authority.txt','utf8'))},
  {id:'H2-service-ceiling',file:'server/routine-permissions.ts',tests:['server/routine-permissions.test.ts'],pattern:'survives service, continuation',mutate:s=>s.replace('effectiveRoutinePermissionMode({ permissionMode, permissionExplicit: true }, effective)','effectiveRoutinePermissionMode({ permissionMode }, effective)')},
  {id:'H2-peer-queued-wake',file:'server/routine-permissions.ts',tests:['server/routine-permissions.test.ts'],pattern:'survives immediate peer',mutate:s=>s.replace('effectiveRoutinePermissionMode({ ...parentRun, permissionExplicit: true }, peer)','effectiveRoutinePermissionMode({ permissionMode: parentRun.permissionMode }, peer)')},
  {id:'H2-durable-project-ceiling',file:'server/routine-permissions.ts',tests:['server/project-routine-approval-107.test.ts'],pattern:'H2 No limits preserves',mutate:s=>s.replace('effectiveRoutinePermissionMode(input.run, actor)','effectiveRoutinePermissionMode({permissionMode:input.run.permissionMode}, actor)')},
  {id:'P1-managed-Ask',file:'server/drivers/antigravity.ts',tests:['server/drivers/antigravity-auto.test.ts'],pattern:'P1 managed Ask',mutate:s=>s.replace('(!managedAsks || relayUnavailable)','true')},
  {id:'P-MUSE-immediate-terminal',file:'server/drivers/muse-code.ts',tests:['server/drivers/muse-code.test.ts'],pattern:'P-MUSE acknowledged',mutate:s=>s.replace('!active.nativeTurnId || active.pendingAnswerDeliveries > 0','!active.nativeTurnId')},
  {id:'P-MUSE-transcript',file:'server/drivers/muse-code.ts',tests:['server/drivers/muse-code.test.ts'],pattern:'P-MUSE delivers',mutate:s=>s.replace('turn.transcript?.length ? [renderDriverReplay(turn.transcript, turn.replayMetadata), "", "[Latest message:]", turn.text].join("\\n") : turn.text','turn.text')},
 ];
 const selected=new Set(process.argv.slice(3));
 for(const id of selected)if(!cases.some(c=>c.id===id))throw Error('unknown mutant: '+id);
 for(const c of cases.filter(c=>!selected.size||selected.has(c.id))){
  const path=join(root,c.file),original=readFileSync(path,'utf8');
  const run=name=>{const r=spawnSync('pnpm',['exec','vitest','run',...c.tests,'--testNamePattern',c.pattern,'--maxWorkers=1'],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:20*1024*1024});const log=(r.stdout??'')+(r.stderr??'');writeFileSync(join(out,name+'.log'),log);return {status:r.status,error:r.error?.message,log};};
  const control=run(c.id+'-control');if(control.status!==0)throw Error(c.id+' control failed');
  const mutant=c.mutate(original);if(mutant===original)throw Error(c.id+' seam missing');
  try{writeFileSync(path,mutant);const killed=run(c.id);results.push({id:c.id,control:control.status,mutant:killed.status,killed:killed.status!==0&&killed.log.includes('AssertionError')});}
  finally{writeFileSync(path,original);}
  writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));
  if(!results.at(-1).killed)throw Error(c.id+' survived');
 }
}finally{if(!root.startsWith(join(tmpdir(),'gnl-r3-mutants-')))throw Error('Unexpected root');rmSync(root,{recursive:true,force:true});}
