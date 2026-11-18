// Harness/mutation consumer owner: gnl-harness-r9. Product contracts owner: MAIN.
// Behavioral source mutants only: every control runs unchanged before mutation.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const out=resolve(process.argv[2]??join(tmpdir(),'gnl-review-qualification'));
if(out===process.cwd()||out.startsWith(process.cwd()+sep)||out==='/dev'||out.startsWith('/dev/'))throw Error('Evidence must be outside the checkout');
mkdirSync(out,{recursive:true});
const review='scripts/no-limits-live/review-r9.node-test.mjs',earlier='scripts/no-limits-live/harness-r9.node-test.mjs';
const mutants=[
 ['reserved-app-environment','bindings.mjs','GNL_APP_DATA_DIR:data','MURAGE_DATA_DIR:data',review,'review mount'],
 ['wrong-app-data-reader','fakes/release-tool-service.mjs','process.env.GNL_APP_DATA_DIR','process.env.MURAGE_DATA_DIR',review,'review mount'],
 ['inactive-browser-profile','dedicated-bindings.mjs',"browserExtensionProfileId:profileId,baseRevision",'browserExtensionProfileId:undefined,baseRevision',review,'review browser profile'],
 ['duplicate-browser-open','fakes/release-plan.mjs',"field&&url&&text.includes('First use a browser tool to read ')",'field&&url',review,'review browser decoder'],
 ['claude-bypasses-approval','fakes/claude.mjs',"const tools=createMountedTools(config,async detail=>{",'const tools=createMountedTools(config,async detail=>{return true;',review,'review native approval: claude'],
 ['acp-bypasses-approval','fakes/acp.mjs',"createMountedTools(mounts,permission)",'createMountedTools(mounts,async()=>true)',review,'review native approval: acp'],
 ['claude-ignores-refusal','fakes/claude.mjs',"return JSON.parse(answer.result?.content?.find(c=>c.type==='text')?.text??'{}').behavior==='allow';",'return true;',review,'review native approval: claude refusal'],
 ['acp-ignores-refusal','fakes/acp.mjs',"return allowed;",'return true;',review,'review native approval: acp refusal'],
 // Restore the previous route behavior without removing an export. A real
 // advertised catalogue must reject the default Flux route behaviorally.
 ['p3-default-flux-route','release-engines.mjs',"const model=native.includes(instance?.models?.default)?instance.models.default:native[0];",'const model=instance?.models?.default;',earlier,'P3 fixture selects'],
 // Keep the function/module present, but drop the required observed contract.
 ['p4-unevidenced-na','capability-rows.mjs',"verdict:'N/A-by-capability',capabilityEvidence:evidence", "verdict:'N/A-by-capability',capabilityEvidence:undefined",earlier,'P4 capability'],
 ['p4-na-counts-as-pass','counts.mjs',"r.verdict === 'PASS'", "(r.verdict === 'PASS'||r.verdict === 'N/A-by-capability')",earlier,'P4 reports'],
 ['extension-bypasses-permission','fakes/browser-extension.mjs','await options.beforeDestination(args.url,document);','',review,'review selected extension'],
];
const report={releaseGate:false,baselines:[],mutants:[],verdict:'FAIL'};
for(const [id,file,before,after,test,pattern] of mutants){
 const scratch=mkdtempSync(join(tmpdir(),'gnl-review-mutant-'));
 try{
  const target=pathToFileURL(resolve('scripts/no-limits-live',file)).href,active=join(scratch,'activated'),loader=join(scratch,'loader.mjs');
  const source=readFileSync(new URL(target),'utf8');
  if(!source.includes(before))throw Error(`Mutation anchor unavailable: ${id}`);
  writeFileSync(loader,`import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';registerHooks({load(url,ctx,next){const result=next(url,ctx);if(url!==${JSON.stringify(target)})return result;const source=typeof result.source==='string'?result.source:Buffer.from(result.source).toString();if(!source.includes(${JSON.stringify(before)}))throw Error('Mutation anchor unavailable');writeFileSync(${JSON.stringify(active)},'activated');return {...result,source:source.replace(${JSON.stringify(before)},${JSON.stringify(after)})};}});`);
  const run=mutated=>{
   const env={...process.env};delete env.NODE_TEST_CONTEXT;
   if(mutated)env.NODE_OPTIONS=(env.NODE_OPTIONS??'')+` --import=${pathToFileURL(loader).href}`;
   const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-reporter=tap',`--test-name-pattern=${pattern}`,test],{env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
   const output=(result.stdout??'')+(result.stderr??'');writeFileSync(join(out,id+(mutated?'-mutant':'-control')+'.log'),output);
   return {result,output};
  };
  const control=run(false);
  report.baselines.push({id,exit:control.result.status,passed:control.result.status===0});
  if(control.result.status!==0){console.log(control.output);report.mutants.push({id,activated:false,killed:false,reason:'Red control'});continue;}
  const mutant=run(true),activated=existsSync(active);
  // A loader/import failure is never a kill. Require a named test failure
  // and an assertion/error from the exercised fixture behavior.
  const behavioral=/not ok \d+ - (review |P3 fixture selects|P4 capability|P4 reports)/.test(mutant.output)&&!/(SyntaxError|does not provide an export|ERR_MODULE_NOT_FOUND)/.test(mutant.output);
  const killed=activated&&mutant.result.status===1&&behavioral;
  const record={id,activated,controlExit:control.result.status,mutantExit:mutant.result.status,behavioral,killed};
  report.mutants.push(record);console.log(JSON.stringify(record));console.log(mutant.output);
 }finally{removeTempDirSync(scratch);}
}
report.verdict=report.baselines.every(b=>b.passed)&&report.mutants.length===mutants.length&&report.mutants.every(m=>m.killed)?'PASS':'FAIL';
writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
if(report.verdict!=='PASS')process.exitCode=1;
