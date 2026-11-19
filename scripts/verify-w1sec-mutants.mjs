// Network-free regression controls and mutants in a disposable source copy.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,symlinkSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const source=realpathSync(process.cwd());
const destination=process.env.W1SEC_EVIDENCE_DIR ?? join(tmpdir(),'w1sec-evidence-'+randomUUID());
if(!destination||!isAbsolute(destination))throw Error('W1SEC_EVIDENCE_DIR must name an absolute job directory outside the repository');
const out=resolve(destination);
// Resolve existing ancestors before creating anything, including symlink aliases.
let ancestor=out;
while(!existsSync(ancestor))ancestor=dirname(ancestor);
const physical=resolve(realpathSync(ancestor),relative(ancestor,out));
if(physical===source||physical.startsWith(source+sep))throw Error('W1SEC_EVIDENCE_DIR must be outside the repository');
mkdirSync(out,{recursive:true});
if(process.argv.includes('--check-output')){console.log('External evidence directory accepted');process.exit(0);}
const root=mkdtempSync(join(tmpdir(),'w1sec-mutants-'));
const file='server/decision/pi-projection-security.test.ts',results=[];
function run(name,extraTests=[]) {
 const result=spawnSync('pnpm',['exec','vitest','run',file,...extraTests,'--maxWorkers=1','--reporter=json',`--outputFile=${join(out,name+'.json')}`],{cwd:root,encoding:'utf8',timeout:180_000,maxBuffer:20*1024*1024});
 writeFileSync(join(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 if(result.error)throw result.error;
 const report=JSON.parse(readFileSync(join(out,name+'.json'),'utf8'));
 const failures=report.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>({id:t.fullName,assertion:t.failureMessages.some(m=>/AssertionError/.test(m))})));
 return {exit:result.status,failures,testIds:report.testResults.flatMap(f=>f.assertionResults.map(t=>t.fullName))};
}
try {
 for(const directory of ['server','shared','scripts','electron','src','cloudflare'])
  cpSync(join(source,directory),join(root,directory),{recursive:true,filter:path=>!['node_modules','dist'].includes(basename(path))});
 for(const name of readdirSync(source))if(/^(package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig.*json|vite.config.ts)$/.test(name))
  cpSync(join(source,name),join(root,name));
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const control=run('control');if(control.exit!==0)throw Error('control failed');results.push({name:'control',...control});
 const implementation='server/decision/implementation.ts';
 const mutants=[
  {name:'restore-native-overflow-bypass',path:implementation,before:'const input=projected.toolCall?.input??{};',after:"if(raw&&(ownerEligible(a)||extractInspectedOperation(raw).kind==='operation'))incomplete=false; const input=projected.toolCall?.input??{};",ids:['H1 exact Pi edit projection at ask','H1 exact Pi edit projection at auto','H1 exact Pi edit projection at full','H1 a downgrade before registration',...['ask','auto','full'].map(level=>'H1 native content hashing at '+level),...['path','oldText','filePaths','localHold','toolEngine'].map(f=>'H1 losing '+f+' alone')]},
  {name:'overflow-complete-small-edit',path:implementation,before:'const input=projected.toolCall?.input??{};',after:'if(!ownerEligible(a))incomplete=true; const input=projected.toolCall?.input??{};',ids:['H1 a complete small Pi edit']},
  {name:'apply-overflow-refusal-to-no-limits',path:implementation,before:"else if((e.fault==='identity'||e.fault==='overflow')&&!owner(e))",after:"else if(e.fault==='identity'||e.fault==='overflow'||owner(e)&&e.registration.snapshot?.tool==='Edit')",ids:['H1 No limits runs the exact oversized protected Pi edit']},
  {name:'scan-projected-wipe-input',path:implementation,before:'?captureWipeInput(event):undefined;',after:'?captureWipeInput(boundedProjection(event)):undefined;',ids:['H1 No limits checks a native wipe operand beyond']},
  // MAIN RULING 1114-PI-FLOOR-FOLLOWS-AUTHORITY: capacity keeps wipe fields; size alone runs.
  {name:'allow-uncaptured-wipe-input',path:'server/decision/wipe-input.ts',before:'}catch{return captureWipeFields(value);}',after:'}catch{return freeze({} as T);}',ids:['H1 the same oversized capture path retains a real home wipe']},
  {name:'reject-ordinary-oversized-wipe-fields',path:'server/decision/wipe-input.ts',before:'}catch{return captureWipeFields(value);}',after:'}catch{return null;}',ids:['H1 No limits runs the oversized ordinary edit']},
  {name:'skip-driver-envelope-contract',path:'server/drivers/contracts.ts',before:'if (!engine && (!call || !Object.hasOwn(call, "engine"))) return OK;',after:'if (!engine) return {ok:true};',ids:['H1 missing engine metadata fails the contract and ask','H1 missing engine metadata fails the contract and full','H1 frozen BASE calls without engine metadata retain explicit refusal assertions']},
  {name:'skip-missing-engine-contract',path:'server/drivers/contracts.ts',before:'if (!engine) return bad("engine");',after:'if (!engine) return OK;',ids:['H1 missing engine metadata fails the contract and ask','H1 missing engine metadata fails the contract and full','H1 missing engine metadata cannot validate an absent or partial call','H1 frozen BASE calls without engine metadata retain explicit refusal assertions']},
 ];
 for(const m of mutants) {
  const path=join(root,m.path),original=readFileSync(path,'utf8');if(!original.includes(m.before))throw Error('missing mutant seam '+m.name);
  try {
   writeFileSync(path,original.replace(m.before,m.after));const result=run(m.name,m.tests??[]);
   const missed=m.ids.filter(id=>!result.failures.some(f=>f.id.includes(id)&&f.assertion));
   results.push({name:m.name,...result,missed,killed:result.exit!==0&&missed.length===0});
   if(result.exit===0||missed.length)throw Error('mutant survived expected assertions '+m.name+': '+missed.join(', '));
  } finally {writeFileSync(path,original);writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');}
 }
 const uncovered=control.testIds.filter(id=>!results.some(result=>result.failures.some(f=>f.id===id&&f.assertion)));
 writeFileSync(join(out,'coverage.json'),JSON.stringify({tests:control.testIds.length,mutants:mutants.length,uncovered},null,2)+'\n');
 if(uncovered.length)throw Error('Regression assertions without a killed mutant: '+uncovered.join(', '));
} finally {
 if(!root.startsWith(join(tmpdir(),'w1sec-mutants-')))throw Error('unexpected cleanup root');
 rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify(results.map(({name,exit,killed})=>({name,exit,killed}))));
