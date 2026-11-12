// Run the actual release CLI and isolated server with a one-row inert rig.
// The inventory and unrelated release legs are explicit fake qualification
// fixtures. Neither this report nor its tagged CLI receipts can release an app.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),out=resolve(process.argv[2]);
mkdirSync(out,{recursive:true});
const file=join(root,'server/decision/implementation.ts'),before='else if(owner(e)){';
if(!readFileSync(file,'utf8').includes(before))throw Error('Candidate mutant anchor changed');
const dir=mkdtempSync(join(tmpdir(),'gnl-cli-mutant-'));
try{
 const active=join(out,'activated'),engines=join(dir,'engines.json'),preload=join(dir,'qualification-loader.mjs');
 writeFileSync(engines,JSON.stringify({'gnl-qualification':{config:{},model:'fixture'}}));
 // Each child loads this fixture before server/index.ts. The fixed driver
 // requests precisely the marker command and writes the marker only on allow.
 const driver=readFileSync(join(root,'scripts/no-limits-live/fakes/gate-driver.mjs'),'utf8')
  .replace("import { randomUUID }", "import {writeFileSync} from 'node:fs';import {join} from 'node:path';\nimport { randomUUID }")
  .replace("const turnId=randomUUID(),requestId=randomUUID(),entry={turnId,requestId};", "const command=turn.text.split('Run exactly this shell command once: ').at(-1);const turnId=randomUUID(),requestId=randomUUID(),entry={turnId,requestId,cwd:turn.cwd,command};")
  .replace("toolIdentity:{name:'Bash'},threadId", "toolIdentity:{name:'Bash'},input:{command,cwd:turn.cwd},threadId")
  .replace("command:'printf fixture'",'command')
  .replace("emit({type:'item.completed'", "if(allowed)writeFileSync(join(entry.cwd,'action.done'),'fixture');emit({type:'item.completed'");
 const files={
  'scripts/no-limits-live/scenarios.mjs':`export const engineSpecs=[{id:'gnl-qualification',driver:'gnlFake'}];export const scenarios=[{id:'owner-qualification',actor:'owner',level:'unlimited',expected:'RUN'}];export const paritySources={};export function assertReleaseReady(){}`,
  'scripts/no-limits-live/release-legs.mjs':`export async function mandatoryLeg(){return {verdict:'PASS',qualificationOnly:true};}export async function replayLeg(){return {verdict:'PASS',rows:0,pass:0,controls:{rows:0,pass:0},qualificationOnly:true};}`,
  'scripts/no-limits-live/fakes/gate-driver.mjs':driver,
 };
 const after=`else if(owner(e) && String((r.snapshot?.input as any)?.command).startsWith('printf fixture')){outcome=approval(e,'deny',[{kind:'deny',class:'path',ruleId:'non-wipe-fixture',span:'fixture'}]);}\n ${before}`;
 writeFileSync(preload,`import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';
 const root=${JSON.stringify(pathToFileURL(root+'/').href)},files=${JSON.stringify(files)};
 registerHooks({load(url,ctx,next){
  for(const [path,source]of Object.entries(files))if(url===new URL(path,root).href)return {format:'module',source,shortCircuit:true};
  const r=next(url,ctx);let s=typeof r.source==='string'?r.source:r.source?Buffer.from(r.source).toString():'';
  if(url===new URL('scripts/no-limits-live/run.mjs',root).href)s=s.replace('PATH: process.env.PATH, SystemRoot:','NODE_OPTIONS:process.env.NODE_OPTIONS, GNL_QUALIFY_MUTANT:process.env.GNL_QUALIFY_MUTANT, PATH: process.env.PATH, SystemRoot:').replace("schema:2,gate:","schema:2,qualificationOnly:true,gate:");
  if(url===new URL('scripts/no-limits-live/observe-decisions.mjs',root).href)s+=\`\nconst {BUILT_IN_DRIVERS}=await import('../../server/drivers/builtIn.ts');const {gateDriver}=await import('./fakes/gate-driver.mjs');BUILT_IN_DRIVERS.push(gateDriver);\`;
  if(process.env.GNL_QUALIFY_MUTANT==='1'&&url===${JSON.stringify(pathToFileURL(file).href)}){if(!s.includes(${JSON.stringify(before)}))throw Error('anchor');s=s.replace(${JSON.stringify(before)},${JSON.stringify(after)});writeFileSync(${JSON.stringify(active)},'applied');}
  return s&&s!==r.source?{...r,source:s}:r;
 }});`);
 const run=(name,mutant)=>{
  const args=['--experimental-strip-types',join(root,'scripts/no-limits-live/run.mjs'),'--live','--release','--platform',process.platform,'--engines-file',engines,'--out',join(out,name)];
  if(process.env.GNL_CANDIDATE_PROOF)args.push('--candidate-proof',process.env.GNL_CANDIDATE_PROOF);
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:90000,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`,GNL_QUALIFY_MUTANT:mutant?'1':'0'}});
  writeFileSync(join(out,name+'.log'),(result.stdout??'')+(result.stderr??''));return result;
 };
 const baseline=run('baseline',false),mutant=run('mutant',true);
 const control=/GNL-RESULT rows=1 pass=1 nonwipe_cards=0 refusals=0 skipped=0/.test(baseline.stdout??'');
 const detected=/GNL-RESULT rows=1 pass=0 nonwipe_cards=1 refusals=\d+ skipped=0/.test(mutant.stdout??'');
 const killed=baseline.status===0&&control&&mutant.status===1&&detected&&existsSync(active);
 const report={mode:'release CLI with one-row fake rig and fake unrelated legs',releaseGate:false,baselineExit:baseline.status,control,mutantExit:mutant.status,detected,activated:existsSync(active),killed,verdict:killed?'PASS':'FAIL'};
 writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!killed)process.exitCode=1;
}finally{rmSync(dir,{recursive:true,force:true});}

const sourceMutants=spawnSync(process.execPath,[new URL('./qualify-source-product-mutants.mjs',import.meta.url).pathname,join(out,'source-mutants')],{cwd:root,env:{...process.env,NODE_TEST_CONTEXT:''},stdio:'inherit',timeout:600000});if(sourceMutants.status!==0)process.exitCode=1;
