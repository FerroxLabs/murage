import { archivedEvidencePath, assertExternalEvidencePath, evidencePath } from './evidence-path.mjs';
// Production and fixture reversions, confined to copied source and disposable data.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=process.cwd(),out=assertExternalEvidencePath(resolve(process.env.GNL_MUTANTS_OUT??evidencePath('evidence/afix-gnl-prod-r5/mutants')));mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'afix-gnl-mutants-')),hash=s=>createHash('sha256').update(s).digest('hex');
const only=process.argv[2];
const results=only&&existsSync(join(out,'results.json'))?JSON.parse(readFileSync(join(out,'results.json'))):[];
try{
 for(const name of ['server','scripts','shared','src','electron','extensions','companion','tools','cloudflare','apps','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.ts','tsconfig.json'])cpSync(name,join(root,name),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 // The child inherits MURAGE_EVIDENCE_ARCHIVE; no private reports enter its source copy.
 const specs=[
  {id:'muse-unconfirmed-retirement',file:'server/drivers/muse-code.ts',test:'server/drivers/muse-code.test.ts',pattern:'P-MUSE missing strict|P-MUSE strict|P-MUSE acknowledged',bad:1,good:4,mutate:s=>s.replace('const settlement = nativeConfirmed ? answerTransport.deliverySettled(threadId, requestId) : Promise.resolve();','const settlement = answerTransport.deliverySettled(threadId, requestId);')},
  {id:'muse-strict-receipt',file:'server/drivers/request-delivery.ts',test:'server/drivers/muse-code.test.ts',pattern:'P-MUSE strict|P-MUSE acknowledged',bad:2,good:2,mutate:s=>s.replace('if(transport)transport.onDeliverySettled=(t,r)=>open.get(key(t,r))?.delivery?.then(()=>{})??Promise.resolve();','if(transport)transport.onDeliverySettled=()=>Promise.resolve();')},
  {id:'copilot-launch',file:'scripts/no-limits-live/fakes/acp.mjs',workflow:true,bad:1,good:1,mutate:s=>s.replace('mounts=m.params.mcpServers?.length?m.params.mcpServers:acpLaunchMounts(process.argv.slice(2))','mounts=m.params.mcpServers??[]')},
  {id:'run-index',file:'server/routines.ts',test:'server/routines-tracked-save.test.ts',pattern:'R5 review|R5 run identity|M2 conversation lookup',bad:2,good:2,mutate:s=>s.replace('    this.updateRunIdentity(index, previous, run);','    this.updateRunIdentity(index, previous, run);\n    if(previous?.run !== run || previous?.runId !== run?.id)this.runIdIndex=undefined;')},
  {id:'project-request',file:'server/index.ts',test:'server/product-project-routine-policy-api.test.ts',bad:3,good:1,mutate:s=>s.replace('  const decisionRoomRequest = roomLineageRow;','  const decisionRoomRequest = roomTurnRequest ? roomRequest(database(), roomTurnRequest.requestId) : undefined;')},
  {id:'project-wait',file:'server/index.ts',test:'server/decision-wiring/actor-wiring.test.ts',pattern:'H-workflow project routine authority|actual live reader accepts',bad:1,good:4,mutate:s=>s.replace("!['running', 'waiting_owner'].includes(request.state) || request.toBotId !== provenance.botId","request.state !== 'running' || request.toBotId !== provenance.botId")},
  {id:'muse-browser',file:'server/drivers/muse-code.ts',test:'server/drivers/muse-code.test.ts',pattern:'H-workflow Muse|P-MUSE acknowledged',bad:1,good:2,mutate:s=>s.replace('        browserMcp: true,\n','')},
  {id:'browser-plan',file:'scripts/no-limits-live/fakes/release-plan.mjs',node:true,pattern:'long page reads|plain browser calls',bad:1,good:1,mutate:()=>JSON.parse(readFileSync(archivedEvidencePath('evidence/afix-gnl-prod-r5/plan-mutant.json'))).bytes},
  {id:'hermes-order',file:'scripts/no-limits-live/fakes/acp.mjs',node:true,pattern:'Hermes fixture|plain browser calls',bad:2,good:1,mutate:s=>s.replace("const checkedFirst=process.env.GNL_FAKE_KIND==='hermesAgent'","const checkedFirst=false")},
  {id:'native-declarations',file:'scripts/no-limits-live/declared-requests.mjs',node:true,pattern:'native empty-shell|plain browser calls',bad:1,good:1,mutate:s=>s.replace("if(engine.driver==='antigravityAgent'&&step.tool==='Bash'&&!Object.hasOwn(step.input,'command')&&cwd)requests.push({engine:engine.driver,tool:'run_command',inputHash:hashInput({cwd}),class:cls});",'')},
 ];
 const run=(spec,id)=>{
  const dir=join(out,id);mkdirSync(dir,{recursive:true});
  const args=spec.workflow?['scripts/no-limits-live/scenario-sweep.mjs','--candidate','afix-copilot-mutant','--out',join(dir,'workflow'),'--engines','copilot','--cases','cd,created-seat','--timeout','45000']:spec.node?['--experimental-strip-types','--test','--test-name-pattern='+spec.pattern,'scripts/no-limits-live/harness-afix-r5.node-test.mjs']:[join(root,'node_modules/vitest/vitest.mjs'),'run',spec.test,...(spec.pattern?['--testNamePattern='+spec.pattern]:[]),'--maxWorkers=1','--reporter=json','--outputFile='+join(dir,'tests.json')];
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:30*1024*1024,env:{...process.env,GNL_OWNER_POLICY_EVIDENCE:join(dir,'workflow')}});
  const log=(r.stdout??'')+(r.stderr??'');writeFileSync(join(dir,'run.log'),log);
  let failed,passed,assertions;
  if(spec.workflow){const report=JSON.parse(readFileSync(join(dir,'workflow/verdict.json')));failed=report.fail;passed=report.pass;assertions=report.rows.length===2&&report.errors.length===0&&report.rows.filter(r=>r.verdict==='FAIL').every(r=>r.id==='created-seat'&&r.errors.includes('engine did not create the requested seat'));}
  else if(spec.node){failed=Number(/ℹ fail (\d+)/.exec(log)?.[1]);passed=Number(/ℹ pass (\d+)/.exec(log)?.[1]);assertions=/AssertionError|ERR_ASSERTION/.test(log);}
  else {const tests=JSON.parse(readFileSync(join(dir,'tests.json'))).testResults.flatMap(s=>s.assertionResults).filter(t=>t.status!=='skipped');failed=tests.filter(t=>t.status==='failed').length;passed=tests.filter(t=>t.status==='passed').length;assertions=tests.filter(t=>t.status==='failed').every(t=>t.failureMessages.some(s=>s.includes('AssertionError')));}
  return {status:r.status,failed,passed,assertions,error:r.error?.message};
 };
 for(const spec of specs.filter(s=>!only||s.id===only)){
  const path=join(root,spec.file),original=readFileSync(path,'utf8'),mutated=spec.mutate(original);
  if(mutated===original)throw Error('Mutation anchor missing: '+spec.id);
  const control=run(spec,spec.id+'-control');
  if(control.status!==0||control.failed!==0)throw Error('Control failed: '+spec.id);
  try{
   writeFileSync(path,mutated);writeFileSync(join(out,spec.id+'-source.txt'),mutated);
   const mutant=run(spec,spec.id+'-mutant');
   const killed=mutant.status!==0&&mutant.failed===spec.bad&&mutant.passed===spec.good&&mutant.assertions;
   const testFile=spec.node?'scripts/no-limits-live/harness-afix-r5.node-test.mjs':spec.workflow?'scripts/no-limits-live/scenario-sweep.mjs':spec.test;writeFileSync(join(out,spec.id+'-assertions.txt'),readFileSync(join(root,testFile)));
   results.push({id:spec.id,file:spec.file,testFile,testSha256:hash(readFileSync(join(root,testFile))),originalSha256:hash(original),mutantSha256:hash(mutated),control,mutant,killed});
   writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));
   if(!killed)throw Error('Mutation survived or lost control: '+spec.id);
  }finally{writeFileSync(path,original);}
 }
}finally{if(!root.startsWith(join(tmpdir(),'afix-gnl-mutants-')))throw Error('Unexpected fixture root');rmSync(root,{recursive:true,force:true});}
