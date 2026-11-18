// Owner: sc-safety-rd (fixed historical file inventory and comparison by test ID).
// Owner: lane runner (same image, baseline archive, builds and isolated execution).
// SC_BASE_DIR=/tmp/red/7c9ce6fe SC_OUT=/tmp/node-comparison node this-file.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const base=resolve(process.env.SC_BASE_DIR??'');
const out=resolve(process.env.SC_OUT??'');
if(!process.env.SC_BASE_DIR||!process.env.SC_OUT)throw Error('SC_BASE_DIR and external SC_OUT are required');
if(!relative(root,out).startsWith('..')||out==='/dev'||out.startsWith('/dev/'))throw Error('Evidence must be outside the worktree and device tree');
if(!relative(root,base).startsWith('..'))throw Error('Baseline must be an isolated archive outside the worktree');
mkdirSync(out,{recursive:true});
// A source-preserving filesystem repair may require a separately retained
// full-file rerun. It never replaces or suppresses the original comparison.
const recoveryPath=join(dirname(out),'FIXTURE-RECOVERY.json');
if(existsSync(recoveryPath)){
 const recovery=JSON.parse(readFileSync(recoveryPath,'utf8'));
 if(!recovery.reason||!recovery.tests?.length||recovery.tests.some(file=>!/^server\/[\w/.-]+\.test\.ts$/.test(file)))throw Error('Explicit fixture recovery inventory and reason required');
 const result=spawnSync(process.execPath,[join(root,'scripts/verification/sc-safety/run-focused-comparison.mjs')],{
  cwd:root,env:{...process.env,SC_BASE_DIR:base,SC_OUT:join(dirname(out),'focused-recovery'),SC_FOCUSED_FILES_JSON:JSON.stringify(recovery.tests)},encoding:'utf8',timeout:1200000,maxBuffer:64*1024*1024});
 writeFileSync(join(out,'fixture-recovery.log'),(result.stdout??'')+(result.stderr??''));
 writeFileSync(join(out,'fixture-recovery.json'),JSON.stringify({reason:recovery.reason,tests:recovery.tests,status:result.status,error:result.error?.message},null,2));
 const preservation=spawnSync(process.execPath,[join(root,'scripts/verification/sc-safety/assertion-preservation.mjs')],{
  cwd:root,env:{...process.env,SC_PRESERVATION_BASE_DIR:join(dirname(out),'base56'),SC_PRESERVATION_FILES_JSON:readFileSync(join(dirname(out),'final-files.json'),'utf8')},encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
 writeFileSync(join(out,'PRESERVATION-recovery.json'),preservation.stdout??'');
 writeFileSync(join(out,'PRESERVATION-recovery.log'),preservation.stderr??'');
 const types=spawnSync('pnpm',['exec','tsc','-p','tsconfig.server.json','--pretty','false'],{cwd:root,env:process.env,encoding:'utf8',timeout:480000,maxBuffer:32*1024*1024});
 writeFileSync(join(out,'fixture-recovery-types.log'),(types.stdout??'')+(types.stderr??''));
 writeFileSync(join(out,'fixture-recovery-checks.json'),JSON.stringify({preservation:preservation.status,serverTypes:types.status},null,2));
 if(recovery.historicalPresence){
  const cwd=resolve(recovery.historicalPresence);
  if(!relative(root,cwd).startsWith('..')||!relative(dirname(out),cwd)||relative(dirname(out),cwd).startsWith('..'))throw Error('Historical presence fixture must be in the external evidence directory');
  const report=join(out,'C1-red.json'),identities=join(out,'C1-red-assertions.json');
  const red=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/sc-continuity-presence.test.ts','--reporter=json',`--reporter=${join(root,'scripts/verification/sc-safety/assertion-reporter.mjs')}`,`--outputFile=${report}`],{cwd,env:{...process.env,SC_ASSERTION_IDENTITY_REPORT:identities},encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
  writeFileSync(join(out,'C1-red.log'),(red.stdout??'')+(red.stderr??''));
 }
}
const files=JSON.parse(readFileSync(process.env.SC_NODE_FILES??new URL('./node-files.json',import.meta.url),'utf8'));
if(!Array.isArray(files)||files.length===0||new Set(files).size!==files.length)throw Error('Node inventory must contain distinct files');
const unescape=text=>text.replace(/&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{
  const simple={'&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'};
  return simple[entity]??String.fromCodePoint(entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10));
});
function parseJUnit(text,cwd){
 const dom=new JSDOM(text,{contentType:'application/xml'}),rows=[];
 try{
  const visit=(node,parents)=>{
   if(node.localName==='testsuite')parents=[...parents,node.getAttribute('name')??''];
   if(node.localName==='testcase'){
    const file=node.getAttribute('file')?relative(cwd,node.getAttribute('file')):'';
    const children=[...node.children].map(child=>child.localName);
    rows.push({id:`${file} :: ${[...parents,node.getAttribute('name')??''].join(' > ')}`,file,nameParts:[...parents,node.getAttribute('name')??''],
     status:children.includes('failure')||children.includes('error')||node.getAttribute('failure')?'failed':children.includes('skipped')?'skipped':'passed'});
   }
   for(const child of node.children)visit(child,parents);
  };visit(dom.window.document.documentElement,[]);return rows;
 }finally{dom.window.close();}
}

const runs={};
for(const [side,cwd]of [['base',base],['head',root]]){
  const sideOut=join(out,side);mkdirSync(sideOut,{recursive:true});
  const scratch=mkdtempSync(join(out,`${side}-env-`));
  const home=join(scratch,'home'),data=join(scratch,'data'),config=join(scratch,'gitconfig');
  mkdirSync(home);mkdirSync(data);writeFileSync(config,'');
  const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:home,CI:'1',LANG:'C.UTF-8',TZ:'UTC',NO_COLOR:'1',FORCE_COLOR:'0',
    NODE_OPTIONS:'--max-old-space-size=12000',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',MURAGE_E2E_DATA_DIR:data,
    GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config};
  for(const [input,target]of [['SC_AGE_DIR','MURAGE_BACKUP_TEST_AGE_DIR'],['SC_SHARED_DIR','PUBLIC_LEAK_GUARD_SHARED_DIR'],['SC_OPENCLAW_DIR','OPENCLAW_PACKAGE_DIR']])if(process.env[input])env[target]=process.env[input];
  const missingFiles=files.filter(file=>!existsSync(join(cwd,file)));
  const hashes=Object.fromEntries(files.filter(file=>!missingFiles.includes(file)).map(file=>[file,createHash('sha256').update(readFileSync(join(cwd,file))).digest('hex')]));
  const report=join(sideOut,'report.xml');
  try{
    const started=Date.now();
    const run=spawnSync(process.execPath,['--experimental-strip-types','--import','./server/testing/safe-wipe-preload.mjs','--test','--test-concurrency=2',
      '--test-reporter=junit',`--test-reporter-destination=${report}`,'--test-reporter=spec',`--test-reporter-destination=${join(sideOut,'tests.log')}`,
      ...files.filter(file=>!missingFiles.includes(file))],{cwd,env,encoding:'utf8',timeout:Number(process.env.SC_NODE_TIMEOUT_MS??3600000),maxBuffer:32*1024*1024});
    writeFileSync(join(sideOut,'stderr.log'),(run.stdout??'')+(run.stderr??''));
    const rows=existsSync(report)?parseJUnit(readFileSync(report,'utf8'),cwd):[];
    const missingReports=files.filter(file=>!rows.some(row=>row.file===file));
    runs[side]={status:run.status,signal:run.signal,error:run.error?.message,elapsed:Date.now()-started,missingFiles,missingReports,rows};
    writeFileSync(join(out,`${side}-by-id.jsonl`),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    writeFileSync(join(sideOut,'source-hashes.json'),JSON.stringify(hashes,null,2));
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
const group=rows=>{const map=new Map();for(const row of rows)map.set(row.id,[...(map.get(row.id)??[]),row]);return map;};
const baseline=group(runs.base.rows),head=group(runs.head.rows),newFailures=[],missing=[],nonexecution=[];
for(const[id,rows]of head){
  if(rows.filter(row=>row.status==='failed').length>(baseline.get(id)??[]).filter(row=>row.status==='failed').length)newFailures.push(id);
  if(rows.filter(row=>row.status==='skipped').length>(baseline.get(id)??[]).filter(row=>row.status==='skipped').length&&baseline.has(id))nonexecution.push(id);
}
for(const[id,rows]of baseline)if((head.get(id)?.length??0)<rows.length)missing.push(id);
const counts=rows=>Object.fromEntries(['passed','failed','skipped'].map(status=>[status,rows.filter(row=>row.status===status).length]));
const report={files:files.length,inventorySha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),runtime:process.version,
  base:{...runs.base,rows:undefined,ids:runs.base.rows.length,counts:counts(runs.base.rows)},
  head:{...runs.head,rows:undefined,ids:runs.head.rows.length,counts:counts(runs.head.rows)},
  NEW:newFailures.length,missing:missing.length,newFailures,missingIds:missing,newNonexecutionIds:nonexecution};
report.pass=!newFailures.length&&!missing.length&&!nonexecution.length&&['base','head'].every(side=>!runs[side].error&&!runs[side].signal&&!runs[side].missingFiles.length&&!runs[side].missingReports.length);
writeFileSync(join(out,'NODE-COMPARISON.json'),JSON.stringify(report,null,2));
process.stdout.write(`SC_SAFETY_NODE_REPORT\n${JSON.stringify(report)}\n`);
process.exitCode=report.pass?0:1;
