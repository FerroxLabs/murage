// Harness/mutant consumer owner: gnl-harness-r10. Native protocol producers: MAIN.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import ts from 'typescript';
import {releaseEngines} from './release-engines.mjs';
import {shippedEngineSpecs} from './engine-inventory.mjs';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const out=resolve(process.argv[2]);
if(out.startsWith(process.cwd()+sep)||out==='/dev'||out.startsWith('/dev/'))throw Error('Evidence outside the checkout required');
mkdirSync(out,{recursive:true});
const base=resolve('scripts/no-limits-live'),configs=releaseEngines();
const nodeTest='scripts/no-limits-live/saved-app-r10.node-test.mjs',structure='scripts/no-limits-live/mount-structure-r10.node-test.mjs',apiTest='scripts/no-limits-live/saved-app-r10.test.mjs';
const quoteRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Find the boundary client through each generated CLI's local module graph.
// The engine list and the shared-implementation mapping are never hand-pinned.
function implementation(file,seen=new Set()){
 if(seen.has(file))return;seen.add(file);const source=readFileSync(file,'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let call;
 const visit=n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)==='createMountedTools'&&n.arguments.length>=2)call??=n;ts.forEachChild(n,visit);};visit(ast);
 if(call)return {file,source,mutated:source.slice(0,call.arguments[1].getStart(ast))+'async()=>true'+source.slice(call.arguments[1].end)};
 const children=[];
 const imports=n=>{if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier))children.push(n.moduleSpecifier.text);if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))children.push(n.arguments[0].text);ts.forEachChild(n,imports);};imports(ast);
 for(const path of children.filter(path=>path.startsWith('.'))){
  const found=implementation(resolve(dirname(file),path),seen);if(found)return found;
 }
}
function nativeImplementation(){
 const file=join(base,'native-source.mjs'),source=readFileSync(file,'utf8');
 // The generated callbacks contain each protocol's native permission wait.
 // Replace the entire callback value via the native-play injection seam.
 return {file,source,mutated:source.replaceAll('beforeMounted:', 'beforeMountedUnused:')
  .replaceAll('{mounts:', '{beforeMounted:async()=>true,mounts:')};
}
const mutants=[];
for(const spec of shippedEngineSpecs()){
 const config=configs[spec.id];
 if(config.cli){const m=['piAgent','museCode','antigravityAgent'].includes(spec.driver)?nativeImplementation():implementation(config.cli);if(!m)throw Error('Boundary implementation absent: '+spec.id);mutants.push({id:`bypass-${spec.id}`,kind:'native-behavior',...m,test:nodeTest,pattern:`^saved-app catalogue ${quoteRegex(spec.id)} refusal$`});}
 else if(spec.driver==='boxAgent'){
  // MAIN RULING 1114-GNL-HARNESS-BOUNDARY: reject imports, not call syntax.
  const file=join(base,'fakes/box-service.mjs'),source=readFileSync(file,'utf8');
  mutants.push({id:`bypass-${spec.id}`,kind:'structure-only-no-box-mount',file,source,mutated:source+"\nimport '../mounted-tools.mjs';\n",test:structure,pattern:'mount structure enumerates'});
 }else{
  // API fakes return function-call protocol only. Their actual mount consumer
  // is the shipped chat runtime; remove its permission wait for this engine's
  // refusal control, retaining the real tool transport and operation result.
  const file=resolve('server/drivers/openai-chat.ts'),source=readFileSync(file,'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let statement;
  const visit=n=>{if(ts.isVariableStatement(n)&&n.getText(ast).startsWith('let decision = await new Promise<Decision>'))statement=n;ts.forEachChild(n,visit);};visit(ast);
  if(!statement)throw Error('Native API permission wait absent');
  mutants.push({id:`bypass-${spec.id}`,kind:'real-api-consumer',file,source,mutated:source.slice(0,statement.getStart(ast))+"let decision: Decision = {behavior:'allow'};"+source.slice(statement.end),test:apiTest,pattern:`^saved-app API ${quoteRegex(spec.id)} refusal$`,vitest:true});
 }
}
for(const [id,name,before,after,test,pattern] of [
 ['operation-without-permission','bindings.mjs',"if(!savedAppPermissionEvidence(spec,snapshot,events,engine))",'if(false)',nodeTest,'saved-app binding rejects'],
 ['export-raw-mount','mounted-tools.mjs','async function mountedTool(','export async function mountedTool(',structure,'mount structure enumerates'],
]){const file=join(base,name),source=readFileSync(file,'utf8');if(!source.includes(before))throw Error('Mutation anchor absent: '+id);mutants.push({id,kind:'structure-or-binding',file,source,mutated:source.replace(before,after),test,pattern});}
// Review-round mutations exercise each former structural blind spot and the
// native fail-open condition, rather than counting parse/import errors.
for(const [id,name,before,after,test,pattern,vitest] of [
 ['antigravity-missing-hook-allows','native-source.mjs','detail.input},i,true,true)===null','detail.input},i,true)===null',nodeTest,'saved-app explicit native allow'],
 ['permission-operation-join-lost','bindings.mjs',"&&completedOperations(events).some(op=>op.threadId===requests[0].threadId&&op.turnId===requests[0].generation&&op.provider===engine.driver&&op.providerInstanceId===engine.id&&bareTool(op.tool)==='GMAIL_SEND_EMAIL'&&hashInput(op.input)===inputHash)",'',nodeTest,'saved-app binding joins'],
 // MAIN RULING 1114-GNL-HARNESS-BOUNDARY: replace the retired syntax
 // matcher mutants with fail-open mutations of the import boundary itself.
 ['dependency-graph-omitted','mount-structure-r10.mjs','   pending.push(child);','   // mutation: omit allowlisted dependencies',structure,'mount structure audits allowlisted helper'],
 ['dynamic-import-ignored','mount-structure-r10.mjs',"callee.kind===ts.SyntaxKind.ImportKeyword||",'false||',structure,'mount structure rejects forbidden dynamic'],
 ['require-import-ignored','mount-structure-r10.mjs',"ts.isIdentifier(callee)&&callee.text==='require'",'false',structure,'mount structure rejects forbidden require'],
 ['re-export-ignored','mount-structure-r10.mjs',"ts.isExportDeclaration(node)&&node.moduleSpecifier",'false',structure,'mount structure rejects forbidden re-export'],
]){
 const file=join(base,name),source=readFileSync(file,'utf8');if(!source.includes(before))throw Error('Mutation anchor absent: '+id);
 mutants.push({id,kind:'review-boundary',file,source,mutated:source.replace(before,after),test,pattern,vitest});
}
for(const spec of shippedEngineSpecs().filter(s=>!configs[s.id].cli&&s.driver!=='boxAgent')){
 const file=resolve(apiTest),source=readFileSync(file,'utf8'),before="integrations:mode==='never-consulted'?{}:{custom:{'gnl-app':f.mount}}";
 if(!source.includes(before))throw Error('Missing unconsulted API control');
 mutants.push({id:`never-consulted-${spec.id}`,kind:'control-coverage',file,source,mutated:source.replace(before,"integrations:{custom:{'gnl-app':f.mount}}"),test:apiTest,pattern:`^saved-app API ${quoteRegex(spec.id)} never-consulted$`,vitest:true});
}
// Actual forbidden dependencies added to a fake. No loader/import error counts:
// the module is read as data and the ordinary boundary assertion must fail.
for(const [id,addition] of [
 ['forbidden-static',"import {spawn} from 'node:child_process';"],
 ['forbidden-dynamic',"const raw=import('../mounted-tools.mjs');"],
 ['forbidden-require',"const raw=require('node:child_process');"],
 ['forbidden-re-export',"export * from '../mounted-tools.mjs';"],
]){
 const file=join(base,'fakes/common.mjs'),source=readFileSync(file,'utf8');
 mutants.push({id,kind:'forbidden-import',file,source,mutated:source+'\n'+addition+'\n',test:structure,pattern:'mount structure enumerates'});
}
{
 const file=join(base,'native-play.mjs'),source=readFileSync(file,'utf8');
 const before='play(value,{...options,gatedHandle})';
 if(!source.includes(before))throw Error('Raw parameter mutation anchor absent');
 mutants.push({id:'raw-mount-parameter',kind:'parameter-boundary',file,source,mutated:source.replace(before,'play(value,{...options,gatedHandle:options.mounts})'),test:structure,pattern:'mount structure raw mount parameter'});
}
const report={releaseGate:false,catalogue:shippedEngineSpecs().map(s=>s.id),mutants:[],verdict:'FAIL'};
for(const m of mutants){
 const run=phase=>{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const args=m.vitest?['node_modules/vitest/vitest.mjs','run',m.test,'-t',m.pattern]:['--experimental-strip-types','--test','--test-reporter=tap',`--test-name-pattern=${m.pattern}`,m.test];
  const result=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');writeFileSync(join(out,`${m.id}-${phase}.log`),output);
  return {exit:result.status,output};
 };
 let control,mutant;try{
  control=run('control');
  if(control.exit===0){writeFileSync(m.file,m.mutated);mutant=run('mutant');}
 }finally{writeFileSync(m.file,m.source);}
 const activated=Boolean(mutant),behavioral=activated&&(/not ok \d+ - (saved-app |mount structure)/.test(mutant.output)||m.vitest&&/FAIL .*saved-app API/.test(mutant.output))&&!/(SyntaxError|does not provide an export|ERR_MODULE_NOT_FOUND)/.test(mutant.output);
 const record={id:m.id,kind:m.kind,controlExit:control.exit,activated,mutantExit:mutant?.exit,behavioral,killed:control.exit===0&&mutant?.exit===1&&behavioral};
 report.mutants.push(record);console.log(JSON.stringify(record));console.log(mutant?.output??control.output);
}
report.verdict=report.mutants.length===mutants.length&&report.mutants.every(m=>m.killed)?'PASS':'FAIL';
writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');console.log('GNL_R10_MUTATION_REPORT '+JSON.stringify(report));console.log(JSON.stringify({verdict:report.verdict,killed:report.mutants.filter(m=>m.killed).length,total:mutants.length}));
if(report.verdict!=='PASS')process.exitCode=1;
