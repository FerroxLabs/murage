// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: producer contract MAIN; consumer and inert regressions wfp-b.
import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,symlinkSync,unlinkSync,renameSync,realpathSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTempDir} from '../testing/cleanup.ts';
import {registeredWipeProjects} from '../wipe/registry.ts';
import {known,opaque,type Invocation,type WipeEffect,type WipeContext} from '../wipe/types.ts';
import {effectRecord} from '../wipe/effect-records.ts';
import {effectRecordsOf,effectsOf} from '../wipe/programs.ts';
import {peel} from '../wipe/invocation.ts';
import {inspectWipe,inspectNativeWipe} from '../wipe-breaker.ts';
import {extractInspectedOperation} from '../no-limits-operation.ts';
import {wipeFingerprint} from './wipe-fingerprint.ts';
import {approvedEvidenceCovers,inspectReleaseWipes} from './release-guard.ts';
import {guardEngineRelease} from './provider-release.ts';
import {fixture,d,baseRun} from './fixture.ts';
import {effectTree,executingPermissionFixture} from '../testing/wipe-execution.test-helper.ts';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){registeredWipeProjects.drop(root);await removeTempDir(root);}});
function scratch(){
 const cwd=mkdtempSync(join(tmpdir(),'effect-record-'));roots.push(cwd);
 for(const name of ['A','B','inner'])mkdirSync(join(cwd,name));
 registeredWipeProjects.replace(cwd,[join(cwd,'A'),join(cwd,'B')]);
 symlinkSync(join(cwd,'A'),join(cwd,'link'),process.platform==='win32'?'junction':'dir');
 symlinkSync(join(cwd,'A'),join(cwd,'inner/link'),process.platform==='win32'?'junction':'dir');
 return cwd;
}
function operation(tool:string,text:string,cwd:string){
 const result=extractInspectedOperation({tool,input:tool==='Bash'?{command:text,cwd}:{code:text,cwd}});
 if(result.kind==='incomplete')throw Error('issued operation required');return result.exactOperation;
}
const repros=[
 ['interpreter','subprocess.run(["python3","-c","import shutil; shutil.rmtree(\'link/\')"])'],
 ['disk','subprocess.run(["sh","-c","mkfs.ext4 link"])'],
] as const;
it.each(repros)('review repro %s binds v4 complete child provenance and same-path replacement',(_name,text)=>{
 const cwd=scratch(),op=operation('python',text,cwd),initial={decisions:[],wipes:inspectReleaseWipes(op)};
 expect(initial.wipes).toHaveLength(1);
 expect(initial.wipes[0]).toMatchObject({completeness:'complete'});
 expect(JSON.parse(initial.wipes[0].fingerprint!).version).toBe(4);
 expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'A')));
 expect(approvedEvidenceCovers(initial,initial)).toBe(true);
 renameSync(join(cwd,'A'),join(cwd,'old'));mkdirSync(join(cwd,'A'));
 const fresh={decisions:[],wipes:inspectReleaseWipes(op)};
 expect(fresh.wipes[0].resolvedTargets).toEqual(initial.wipes[0].resolvedTargets);
 expect(approvedEvidenceCovers(fresh,initial)).toBe(false);
});
it.each(repros)('review repro %s stale inode answer holds, refreshed approval delivers once',async(_name,text)=>{
 const cwd=scratch(),input={code:text,cwd},f=fixture();
 try{
  const h=f.open('inode-review',input,{tool:'python',toolCall:{name:'python',input}}),card=d.decide(h,baseRun);
  expect(card.kind).toBe('card');if(card.kind!=='card')throw Error('card required');
  await d.presentApproval(card.ref,{title:'Wipe',subtitle:'Inert fixture'});
  renameSync(join(cwd,'A'),join(cwd,'old'));mkdirSync(join(cwd,'A'));
  await d.answerApproval(card.ref,{behavior:'allow'});expect(f.respond).not.toHaveBeenCalled();
  const pending=d.openApprovals('t');expect(pending).toHaveLength(1);
  await expect(d.answerApproval(card.ref,{behavior:'allow'})).rejects.toThrow('unissued-approval-ref');
  await d.answerApproval(pending[0].ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();
  await d.answerApproval(pending[0].ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();
  expect(d.openApprovals('t')).toHaveLength(0);
 }finally{f.dispose();}
});
const payloads=['rm -rf link/','mkfs.ext4 link','dd of=link'];
const wrappers=[
 ['sh -c',(body:string)=>`sh -c ${JSON.stringify(body)}`],
 ['python subprocess',(body:string)=>`python3 -c ${JSON.stringify(`subprocess.run(["sh","-c",${JSON.stringify(body)}])`)}`],
 ['node spawn',(body:string)=>`node -e ${JSON.stringify(`require('child_process').spawn('sh', ['-c',${JSON.stringify(body)}])`)}`],
 ['env',(body:string)=>`env ${body}`],
 ['exec',(body:string)=>`exec ${body}`],
] as const;
for(const [name,wrap]of wrappers)it.each(payloads)(`records retain nested ${name} destination: %s`,body=>{
 const cwd=scratch(),text=wrap(body),context:WipeContext={cwd,env:{},pathPort:{realpath:path=>path===join(cwd,'link')||path===join(cwd,'link/')?join(cwd,'A'):null,isBlockDevice:()=>true,stat:()=>({dev:7,ino:9})},registry:{contains:()=>true}};
 const scan=inspectWipe(text,context);expect(scan.hit).not.toBeNull();expect(scan.records.length).toBeGreaterThan(0);
 const record=scan.records.find(record=>record.effect.k===(body.startsWith('dd')?'device-write':body.startsWith('mkfs')?'disk-tool':'delete'));
 expect(record).toBeDefined();expect(record!.origin.program).toBe(body.split(' ')[0]);expect(record!.origin.cwd).toMatchObject({s:cwd});
 expect(record!.binding.kind).toBe('targets');
 const fingerprint=wipeFingerprint(operation('Bash',text,cwd),scan.hit!.rule,context,scan.records);
 expect(fingerprint.completeness).toBe('complete');expect(fingerprint.resolvedTargets).toContain(join(cwd,'A'));
});
it('records bind child cwd alternatives and env -C rather than the outer cwd',()=>{
 const cwd=scratch(),text='env -C inner sh -c "mkfs.ext4 link"',op=operation('Bash',text,cwd);
 const initial={decisions:[],wipes:inspectReleaseWipes(op)};
 expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'A')));
 const scan=inspectWipe(text,{cwd,env:{}});expect(scan.records[0].origin.cwd).toMatchObject({s:join(cwd,'inner')});
 unlinkSync(join(cwd,'inner/link'));symlinkSync(join(cwd,'B'),join(cwd,'inner/link'),process.platform==='win32'?'junction':'dir');
 const fresh={decisions:[],wipes:inspectReleaseWipes(op)};expect(approvedEvidenceCovers(fresh,initial)).toBe(false);
 const inv:Invocation={program:'mkfs.ext4',argv:[known('link')],rawArgv:[],redirects:[],cwd:{...known(cwd),values:[cwd,join(cwd,'inner')],candidates:[cwd,join(cwd,'inner')]},dialect:'sh'};
 const bound=wipeFingerprint(op,'disk-erase',{cwd},[effectRecord({k:'disk-tool',tool:'mkfs.ext4'},inv)]);
 expect(bound.resolvedTargets).toContain(realpathSync(join(cwd,'A')));expect(bound.resolvedTargets).toContain(realpathSync(join(cwd,'B')));
});
it('changing only destructive child two invalidates coverage',()=>{
 const cwd=scratch();symlinkSync(join(cwd,'A'),join(cwd,'second'),process.platform==='win32'?'junction':'dir');
 const op=operation('python','subprocess.run(["sh","-c","mkfs.ext4 link; mkfs.ext4 second"])',cwd);
 const initial={decisions:[],wipes:inspectReleaseWipes(op)};
 unlinkSync(join(cwd,'second'));symlinkSync(join(cwd,'B'),join(cwd,'second'),process.platform==='win32'?'junction':'dir');
 const fresh={decisions:[],wipes:inspectReleaseWipes(op)};expect(approvedEvidenceCovers(fresh,initial)).toBe(false);
});
it.each(['cmd /c format X:','powershell -Command "Format-Volume -DriveLetter X"'])('Windows selectors bind injected inert identities: %s',text=>{
 const cwd='C:\\fixture',context:WipeContext={cwd,env:{},platform:'win32',pathPort:{realpath:path=>/^X:[\\/]?$/i.test(path)?'X:\\':null,isBlockDevice:()=>false,stat:()=>({dev:2,ino:3})}};
 const scan=inspectWipe(text,context);expect(scan.hit?.rule).toBe('disk-erase');
 const op=operation('Bash',text,cwd),initial=wipeFingerprint(op,'disk-erase',context,scan.records);
 expect(initial.completeness).toBe('complete');expect(initial.resolvedTargets).toContain('X:\\');
 const unresolved=wipeFingerprint(op,'disk-erase',{...context,pathPort:{realpath:()=>null,isBlockDevice:()=>false}},scan.records);
 expect(unresolved.completeness).toBe('unknown-target');
});
it('unrelated option paths and executable identity cannot make a targetless disk complete',()=>{
 const cwd=scratch(),text='mkfs.ext4 -L A',scan=inspectWipe(text,{cwd,env:{}});
 expect(scan.hit?.rule).toBe('disk-erase');expect(scan.records[0].binding.kind).toBe('unknown-target');
 expect(wipeFingerprint(operation('Bash',text,cwd),'disk-erase',{cwd},scan.records).completeness).toBe('unknown-target');
});
it('unknown matching fingerprints need v4 completeness and exact-operation evidence',()=>{
 const cwd=scratch(),op=operation('Bash','diskpart clean',cwd),initial={decisions:[],wipes:inspectReleaseWipes(op)};
 expect(initial.wipes[0].completeness).toBe('unknown-target');expect(approvedEvidenceCovers(initial,initial)).toBe(true);
 for(const field of ['completeness','exactOperation'] as const){
  const legacy={decisions:[],wipes:initial.wipes.map(wipe=>({...wipe,[field]:undefined}))};expect(approvedEvidenceCovers(legacy,legacy)).toBe(false);
 }
 const changed={decisions:[],wipes:inspectReleaseWipes(operation('Bash','diskpart clean changed-token',cwd))};
 expect(approvedEvidenceCovers(changed,initial)).toBe(false);
});
it('unknown cached evidence from a different operation retains one card until its exact answer',async()=>{
 const cwd=scratch(),input={command:'diskpart clean',cwd},f=fixture();
 try{
  const h=f.open('unknown-cache',input),card=d.decide(h,baseRun);expect(card.kind).toBe('card');if(card.kind!=='card')throw Error('card required');
  await d.presentApproval(card.ref,{title:'Wipe',subtitle:'Inert fixture'});
  await d.answerApproval(card.ref,{behavior:'allow',updatedInput:{command:'diskpart clean changed-token',cwd}});
  expect(f.respond).not.toHaveBeenCalled();const pending=d.openApprovals('t');expect(pending).toHaveLength(1);
  for(let attempt=0;attempt<3;attempt++){expect(d.decide(h,baseRun).kind).toBe('card');expect(d.openApprovals('t')).toHaveLength(1);}
  await expect(d.answerApproval(card.ref,{behavior:'allow'})).rejects.toThrow('unissued-approval-ref');
  await d.answerApproval(pending[0].ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();expect(d.openApprovals('t')).toHaveLength(0);
 }finally{f.dispose();}
});
it('every variant has an immutable binding; normalization and roles remain a projection',()=>{
 const inv:Invocation={program:'rm',argv:[known('-rf'),known('link/')],rawArgv:[],redirects:[],cwd:known(scratch()),dialect:'sh',env:new Map([['HOME','fixture']])};
 const effects:WipeEffect[]=[{k:'git-clean',target:known('.')},{k:'delete',target:known('.'),recursive:true},{k:'move-away',source:known('.')},{k:'sync-wipe',dest:known('.')},{k:'device-write',target:known('.')},{k:'disk-tool',tool:'rm'},{k:'write',target:known('.')},{k:'uncertain-operands',program:'rm',words:[opaque('unknown')]}];
 for(const effect of effects){const record=effectRecord(effect,inv);expect(Object.isFrozen(record)).toBe(true);expect(Object.isFrozen(record.origin.argv)).toBe(true);expect(record.binding.kind).toMatch(/targets|unknown-target/);}
 const records=effectRecordsOf(inv),legacy=effectsOf(inv);expect(legacy).toEqual(Object.assign(records.map(record=>record.effect),{roles:records.roles}));
 if(inv.cwd.k==='known')inv.cwd.s='changed';inv.argv.push(known('changed'));expect(records[0].origin.cwd).not.toMatchObject({s:'changed'});expect(records[0].origin.argv).toHaveLength(2);
 const state={home:'',env:new Map<string,string|undefined>(),cwd:known('/fixture'),dialect:'sh' as const,depth:0};
 expect(peel([known('find'),known('.'),known('-exec'),known('mkfs.ext4'),known('link'),known(';')],state).flatMap(effectRecordsOf)[0].origin.program).toBe('mkfs.ext4');
});
it('native records use the same exhaustive target binding',()=>{
 const cwd=scratch(),scan=inspectNativeWipe([{op:'delete',path:join(cwd,'A'),recursive:true,followFinal:true}],'delete',{}, {cwd});
 expect(scan.hit).not.toBeNull();expect(scan.records[0].binding.kind).toBe('targets');expect(scan.records[0].origin.cwd).toMatchObject({s:cwd});
});
it.each(['printf "rm -rf link/"','# mkfs.ext4 link','mkfs.ext4 --help','rm -rf build/','printf x > ordinary.txt',"python3 -c \"import shutil as s; s.rmtree('link/')\""] )('RUN controls stay wipe-only: %s',text=>{
 const cwd=scratch();expect(inspectWipe(text,{cwd,env:{}}).hit).toBeNull();expect(inspectReleaseWipes(operation('Bash',text,cwd))).toHaveLength(0);
});
it('isolated documented fixture refreshes a nested disk card and delivers the exact approved operation once',async()=>{
 const {launchVerificationServer,runControlMurage}=await import('../../scripts/control-murage.ts');
 const {openSse}=await import('../testing/sse.ts');
 const {writeFileSync,readFileSync}=await import('node:fs');
 const evidence=process.env.WIPE_WORKFLOW_EVIDENCE??'/tmp/wfp-workflow';mkdirSync(evidence,{recursive:true});
 const cwd=scratch(),input={command:`python3 -c ${JSON.stringify('import subprocess; '+repros[1][1])}`,cwd};
 mkdirSync(join(cwd,'bin'));
 writeFileSync(join(cwd,'bin','mkfs.ext4'),'#!/bin/sh\nprintf "formatted fixture" > "$1/disk-effect.txt"\n',{mode:0o755});
 const server=await launchVerificationServer(process.env,undefined,{instrumentationSource:executingPermissionFixture(input)});
 const commands:unknown[]=[];
 const control=async(command:string,...args:string[])=>{
  const argv=[command,...args,'--url',server.info.url];commands.push(argv);
  const result=await runControlMurage(argv,{env:{MURAGE_DATA_DIR:server.info.dataDir}});
  writeFileSync(join(evidence,command+'-'+commands.length+'.json'),JSON.stringify(result));return result as any;
 };
 let headers:Record<string,string>={},stream:Awaited<ReturnType<typeof openSse>>|undefined;
 const api=async(method:string,path:string,body?:unknown,expectedStatus?:number):Promise<any>=>{
  const response=await fetch(server.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();commands.push({method,path,body,status:response.status,result});if(expectedStatus===undefined)expect(response.ok).toBe(true);else expect(response.status).toBe(expectedStatus);return result;
 };
 try{
  writeFileSync(join(evidence,'launch.json'),JSON.stringify(server.info));expect(await control('doctor')).toMatchObject({ok:true});
  headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).secret};
  const created=await control('new-bot','--name','Fingerprint fixture'),bot={...created.bot,threadId:created.bot.activeTaskId};
  await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'});
  const {raiseLevel}=await import('../testing/raise-level.ts');
  expect(await raiseLevel(async(method,path,body)=>({status:200,body:await api(method,path,body)}),bot.id,{noLimits:true,acknowledgeNoLimits:true})).toMatchObject({status:200});
  stream=await openSse(server.info.url+'/api/events');await stream.until(frame=>frame.kind==='hello');
  await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__ inert nested disk',threadId:bot.threadId});
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'needs-user'});
  const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=40`);
  const cards=messages.messages.filter((message:any)=>message.card?.requestHandle&&!message.card.answered);expect(cards).toHaveLength(1);
  expect(cards[0].card.options).toEqual(['Run',"Don't"]);
  expect(cards[0].card.subtitle).toContain('mkfs.ext4 link');
  unlinkSync(join(cwd,'link'));symlinkSync(join(cwd,'B'),join(cwd,'link'),process.platform==='win32'?'junction':'dir');
  // MAIN RULING 1115-WFP-EXACT-APPROVAL: changed destination holds; the existing public route reports undelivered approval as HTTP 503.
  await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:cards[0].card.requestHandle,action:'allow'},503);
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'needs-user'});
  const refreshed=await api('GET',`/api/threads/${bot.threadId}/messages?limit=40`);
  const pending=refreshed.messages.filter((message:any)=>message.card?.requestHandle&&!message.card.answered);expect(pending).toHaveLength(1);
  expect(pending[0].card.requestHandle).not.toBe(cards[0].card.requestHandle);
  expect(refreshed.messages.some((message:any)=>message.text==='permission: allowed')).toBe(false);
  expect(existsSync(join(cwd,'effect-log'))).toBe(false);
  await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:pending[0].card.requestHandle,action:'allow'});
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'settled'});
  const transcript=await control('messages','--bot',bot.id,'--limit','40');
  expect(transcript.messages.filter((message:any)=>message.text==='permission: allowed')).toHaveLength(1);
  expect(readFileSync(join(cwd,'effect-log'),'utf8').trim().split('\n').map(line=>JSON.parse(line))).toEqual([input]);
  expect(existsSync(join(cwd,'B','disk-effect.txt'))).toBe(true);
  expect(readFileSync(join(cwd,'B','disk-effect.txt'),'utf8')).toBe('formatted fixture');
  expect(existsSync(join(cwd,'A','disk-effect.txt'))).toBe(false);
  console.info('WFP_WORKFLOW',JSON.stringify({cards:1,staleDelivered:0,refreshedDelivered:1}));
 }finally{
  stream?.close();await server.close();writeFileSync(join(evidence,'commands.json'),JSON.stringify(commands));writeFileSync(join(evidence,'server.log'),readFileSync(server.info.logPath));
 }
},150000);

it('unknown native handoff consumes its exact answer once and cached digest cannot replay it',async()=>{
 const cwd=scratch(),input={command:'diskpart clean',cwd},f=fixture();let native:boolean|undefined;
 try{
  const h=f.open('unknown-native',input),card=d.decide(h,baseRun);expect(card.kind).toBe('card');if(card.kind!=='card')throw Error('card required');
  await d.presentApproval(card.ref,{title:'Wipe',subtitle:'Inert fixture'});
  f.respond.mockImplementation(async target=>{native=guardEngineRelease(target);return {state:native?'accepted':'failed'};});
  await d.answerApproval(card.ref,{behavior:'allow'});expect(native).toBe(true);expect(f.respond).toHaveBeenCalledOnce();expect(d.openApprovals('t')).toHaveLength(0);
  const target={threadId:'t',requestId:'unknown-native',turnId:'turn',providerInstanceId:'p'};
  for(let attempt=0;attempt<3;attempt++){expect(guardEngineRelease(target)).toBe(false);expect(d.openApprovals('t')).toHaveLength(1);}
  expect(f.respond).toHaveBeenCalledOnce();
 }finally{f.dispose();}
});

it('native move records retain destination identity alongside the destructive source',()=>{
 const cwd=scratch(),result=extractInspectedOperation({tool:'move_file',input:{source:join(cwd,'A'),destination:join(cwd,'B'),cwd}});
 if(result.kind==='incomplete')throw Error('native move required');
 const initial={decisions:[],wipes:inspectReleaseWipes(result.exactOperation)};
 expect(initial.wipes).toHaveLength(1);expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'B')));
 renameSync(join(cwd,'B'),join(cwd,'oldB'));mkdirSync(join(cwd,'B'));
 expect(approvedEvidenceCovers({decisions:[],wipes:inspectReleaseWipes(result.exactOperation)},initial)).toBe(false);
});

it('No limits keeps a safe updated input automatic after a wipe card',async()=>{
 const cwd=scratch(),f=fixture();
 try{
  const h=f.open('safe-update',{command:'diskpart clean',cwd}),card=d.decide(h,baseRun);
  expect(card.kind).toBe('card');if(card.kind!=='card')throw Error('wipe card required');
  await d.presentApproval(card.ref,{title:'Wipe',subtitle:'Inert fixture'});
  const updatedInput={command:'printf fixture',cwd};
  await d.answerApproval(card.ref,{behavior:'allow',updatedInput});
  expect(f.respond).toHaveBeenCalledOnce();expect(f.respond.mock.calls[0][1]).toMatchObject({behavior:'allow',updatedInput});
  expect(d.openApprovals('t')).toHaveLength(0);
 }finally{f.dispose();}
});

// BLOCK 1: interpreter moves must bind the destination independently of source.
const moveCases=[
 ['shutil.move','python',"import shutil; shutil.move('A', 'link/')"],
 ['os.rename','python',"import os; os.rename('A', 'link/')"],
 ['os.replace','python',"import os; os.replace('A', 'link/')"],
 ['fs.renameSync','node',"fs.renameSync('A', 'link/')"],
 ['fs.promises.rename','node',"fs.promises.rename('A', 'link/')"],
 ['FileUtils.mv','Bash',`ruby -e ${JSON.stringify("FileUtils.mv('A', 'link/')")}`],
 ['bare FileUtils.mv','Bash',`ruby -e ${JSON.stringify("FileUtils.mv 'A', 'link/'")}`],
 ['nested Python','Bash',`python3 -c ${JSON.stringify("import shutil; shutil.move('A', 'link/')")}`],
 ['nested Node','Bash',`node -e ${JSON.stringify("fs.renameSync('A', 'link/')")}`],
] as const;
function moveScratch(){
 const cwd=scratch();mkdirSync(join(cwd,'C'));
 unlinkSync(join(cwd,'link'));symlinkSync(join(cwd,'B'),join(cwd,'link'),process.platform==='win32'?'junction':'dir');
 return cwd;
}
function changeMoveDestination(cwd:string,change:'retarget'|'inode'){
 if(change==='retarget'){
  unlinkSync(join(cwd,'link'));symlinkSync(join(cwd,'C'),join(cwd,'link'),process.platform==='win32'?'junction':'dir');
 }else{renameSync(join(cwd,'B'),join(cwd,'old-B'));mkdirSync(join(cwd,'B'));}
}
for(const change of ['retarget','inode'] as const){
 it.each(moveCases)(`BLOCK 1 move destination ${change} invalidates coverage: %s`,(_name,tool,text)=>{
  const cwd=moveScratch(),op=operation(tool,text,cwd),initial={decisions:[],wipes:inspectReleaseWipes(op)};
  expect(initial.wipes).toHaveLength(1);expect(initial.wipes[0].completeness).toBe('complete');
  expect(approvedEvidenceCovers(initial,initial)).toBe(true);
  changeMoveDestination(cwd,change);
  const fresh={decisions:[],wipes:inspectReleaseWipes(op)};
  // Source and operation stay identical; only destination identity changes.
  expect(fresh.wipes[0].hit.rule).toBe(initial.wipes[0].hit.rule);
  expect(approvedEvidenceCovers(fresh,initial)).toBe(false);
  expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'B')));
  expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'A')));
 });
 it.each(moveCases)(`BLOCK 1 move destination ${change} stale answer delivers nothing, fresh once: %s`,async(_name,tool,text)=>{
  const cwd=moveScratch(),input=tool==='Bash'?{command:text,cwd}:{code:text,cwd},f=fixture();
  try{
   const h=f.open('move-destination',input,{tool,toolCall:{name:tool,input}}),card=d.decide(h,baseRun);
   expect(card.kind).toBe('card');if(card.kind!=='card')throw Error('card required');
   await d.presentApproval(card.ref,{title:'Wipe',subtitle:'Inert fixture'});
   changeMoveDestination(cwd,change);
   await d.answerApproval(card.ref,{behavior:'allow'});expect(f.respond).not.toHaveBeenCalled();
   const pending=d.openApprovals('t');expect(pending).toHaveLength(1);
   await expect(d.answerApproval(card.ref,{behavior:'allow'})).rejects.toThrow('unissued-approval-ref');
   await d.answerApproval(pending[0].ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();
   await d.answerApproval(pending[0].ref,{behavior:'allow'});expect(f.respond).toHaveBeenCalledOnce();
   expect(d.openApprovals('t')).toHaveLength(0);
  }finally{f.dispose();}
 });
}
it.each([['python',"shutil.move('A', computed())"],['node',"fs.renameSync('A', computed())"]])('BLOCK 1 unknown interpreter move destination is incomplete: %s',(tool,text)=>{
 const cwd=moveScratch(),op=operation(tool,text,cwd),wipes=inspectReleaseWipes(op);
 expect(wipes).toHaveLength(1);expect(wipes[0].completeness).toBe('unknown-target');
});
it('BLOCK 1 interpreter move destination keeps child cwd',()=>{
 const cwd=moveScratch();mkdirSync(join(cwd,'inner/A'));
 registeredWipeProjects.replace(cwd,[join(cwd,'A'),join(cwd,'B'),join(cwd,'inner/A')]);
 const text=`env -C inner python3 -c ${JSON.stringify("shutil.move('A', 'link/')")}`,op=operation('Bash',text,cwd);
 const initial={decisions:[],wipes:inspectReleaseWipes(op)};
 expect(initial.wipes[0].resolvedTargets).toContain(realpathSync(join(cwd,'inner/A')));
 unlinkSync(join(cwd,'inner/link'));symlinkSync(join(cwd,'C'),join(cwd,'inner/link'),process.platform==='win32'?'junction':'dir');
 expect(approvedEvidenceCovers({decisions:[],wipes:inspectReleaseWipes(op)},initial)).toBe(false);
});

it('BLOCK 1 isolated documented fixture holds a retargeted move destination and delivers fresh once',async()=>{
 const {launchVerificationServer,runControlMurage}=await import('../../scripts/control-murage.ts');
 const {openSse}=await import('../testing/sse.ts');
 const {writeFileSync,readFileSync}=await import('node:fs');
 const evidence=(process.env.WIPE_WORKFLOW_EVIDENCE??'/tmp/wfp-workflow')+'-move';mkdirSync(evidence,{recursive:true});
 const cwd=moveScratch(),input={command:`python3 -c ${JSON.stringify(moveCases[0][2])}`,cwd};
 const server=await launchVerificationServer(process.env,undefined,{instrumentationSource:executingPermissionFixture(input)});
 const commands:unknown[]=[];
 const control=async(command:string,...args:string[])=>{
  const argv=[command,...args,'--url',server.info.url];commands.push(argv);
  const result=await runControlMurage(argv,{env:{MURAGE_DATA_DIR:server.info.dataDir}});
  writeFileSync(join(evidence,command+'-'+commands.length+'.json'),JSON.stringify(result));return result as any;
 };
 let headers:Record<string,string>={},stream:Awaited<ReturnType<typeof openSse>>|undefined;
 const api=async(method:string,path:string,body?:unknown,expectedStatus?:number):Promise<any>=>{
  const response=await fetch(server.info.url+path,{method,headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();commands.push({method,path,body,status:response.status,result});if(expectedStatus===undefined)expect(response.ok).toBe(true);else expect(response.status).toBe(expectedStatus);return result;
 };
 try{
  writeFileSync(join(evidence,'launch.json'),JSON.stringify(server.info));expect(await control('doctor')).toMatchObject({ok:true});
  headers={'x-murage-surface':'desktop','x-murage-surface-secret':(await api('GET','/api/desktop-secret')).secret};
  // Register the source in the child server's roster through its public API.
  const protectedSource=await control('new-bot','--name','Protected source fixture');
  await api('PATCH',`/api/bots/${protectedSource.bot.id}`,{cwd:join(cwd,'A')});
  const created=await control('new-bot','--name','Fingerprint fixture'),bot={...created.bot,threadId:created.bot.activeTaskId};
  await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoReview:'off'});
  const {raiseLevel}=await import('../testing/raise-level.ts');
  expect(await raiseLevel(async(method,path,body)=>({status:200,body:await api(method,path,body)}),bot.id,{noLimits:true,acknowledgeNoLimits:true})).toMatchObject({status:200});
  stream=await openSse(server.info.url+'/api/events');await stream.until(frame=>frame.kind==='hello');
  await api('POST',`/api/bots/${bot.id}/messages`,{text:'__fixture_permission_tool__ inert interpreter move',threadId:bot.threadId});
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'needs-user'});
  const messages=await api('GET',`/api/threads/${bot.threadId}/messages?limit=40`);
  const cards=messages.messages.filter((message:any)=>message.card?.requestHandle&&!message.card.answered);expect(cards).toHaveLength(1);
  expect(cards[0].card.options).toEqual(['Run',"Don't"]);
  expect(cards[0].card.subtitle).toContain('shutil.move');
  unlinkSync(join(cwd,'link'));symlinkSync(join(cwd,'C'),join(cwd,'link'),process.platform==='win32'?'junction':'dir');
  // MAIN RULING 1115-WFP-EXACT-APPROVAL: changed destination holds; the existing public route reports undelivered approval as HTTP 503.
  await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:cards[0].card.requestHandle,action:'allow'},503);
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'needs-user'});
  const refreshed=await api('GET',`/api/threads/${bot.threadId}/messages?limit=40`);
  const pending=refreshed.messages.filter((message:any)=>message.card?.requestHandle&&!message.card.answered);expect(pending).toHaveLength(1);
  expect(pending[0].card.requestHandle).not.toBe(cards[0].card.requestHandle);
  expect(refreshed.messages.some((message:any)=>message.text==='permission: allowed')).toBe(false);
  expect(existsSync(join(cwd,'effect-log'))).toBe(false);
  await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:pending[0].card.requestHandle,action:'allow'});
  expect(await control('wait','--bot',bot.id,'--timeout','10')).toMatchObject({status:'settled'});
  const transcript=await control('messages','--bot',bot.id,'--limit','40');
  expect(transcript.messages.filter((message:any)=>message.text==='permission: allowed')).toHaveLength(1);
  expect(readFileSync(join(cwd,'effect-log'),'utf8').trim().split('\n').map(line=>JSON.parse(line))).toEqual([input]);
  console.info('WFP_WORKFLOW',JSON.stringify({cards:1,staleDelivered:0,refreshedDelivered:1}));
 }finally{
  stream?.close();await server.close();writeFileSync(join(evidence,'commands.json'),JSON.stringify(commands));writeFileSync(join(evidence,'server.log'),readFileSync(server.info.logPath));
 }
},150000);

it.each(['exact','retarget','cancel'] as const)('consuming IPC move proves filesystem effects, replay and %s',async mode=>{
 const cwd=moveScratch(),f=fixture(),input={command:'mv -- A link/',cwd};
 writeFileSync(join(cwd,'A','owner.txt'),'owner content');
 for(const name of ['B','C'])writeFileSync(join(cwd,name,'keep.txt'),name);
 const consumer=join(cwd,'consumer.mjs');
 writeFileSync(consumer,`
  import {execFileSync} from 'node:child_process';
  let count=0;
  process.on('message',input=>{
   if(input.cwd!==process.argv[2]||input.command!=='mv -- A link/')throw Error('unissued fixture operation');
   execFileSync('bash',['-c',input.command],{cwd:input.cwd});
   process.send({count:++count});
  });
 `);
 const child=fork(consumer,[cwd],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
 const initial=effectTree(cwd);
 let expected={...initial};
 let effects=0;
 f.respond.mockImplementation(async(target,answer)=>{
  if(answer.behavior!=='allow')return {state:'accepted'};
  if(!guardEngineRelease(target,answer.updatedInput))return {state:'failed'};
  const result=once(child,'message');child.send(answer.updatedInput??input);
  const [ack]=await result;effects=ack.count;return {state:'accepted'};
 });
 try{
  const h=f.open('ipc-move',input),out=d.decide(h,baseRun);expect(out.kind).toBe('card');
  if(out.kind!=='card')throw Error('wipe card required');
  await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Disposable move'});
  let ref=out.ref;
  if(mode==='retarget'){
   changeMoveDestination(cwd,'retarget');
   expected=effectTree(cwd);
   await d.answerApproval(ref,{behavior:'allow'});
   expect(effects).toBe(0);expect(existsSync(join(cwd,'A','owner.txt'))).toBe(true);
   expect(effectTree(cwd)).toEqual(expected);
   const pending=d.openApprovals('t');expect(pending).toHaveLength(1);ref=pending[0].ref;
  }
  if(mode==='cancel'){
   await d.cancelRequests({kind:'thread',threadId:'t'},'cancelled');
   await expect(d.answerApproval(ref,{behavior:'allow'})).resolves.toBeUndefined();
   expect(effects).toBe(0);expect(readFileSync(join(cwd,'A','owner.txt'),'utf8')).toBe('owner content');
   expect(effectTree(cwd)).toEqual(expected);
   await expect(f.respond({threadId:'t',generation:'g',requestId:'ipc-move',turnId:'turn',providerInstanceId:'p'},{behavior:'allow'},{answerId:'late-answer'})).resolves.toEqual({state:'failed'});
   expect(effectTree(cwd)).toEqual(expected);
  }else{
   await d.answerApproval(ref,{behavior:'allow'});
   const destination=mode==='retarget'?'C':'B';
   expect(effects).toBe(1);expect(existsSync(join(cwd,'A'))).toBe(false);
   expect(readFileSync(join(cwd,destination,'A','owner.txt'),'utf8')).toBe('owner content');
   for(const [path,value]of Object.entries(expected))if(path==='A'||path.startsWith('A/')){delete expected[path];expected[destination+'/'+path]=value;}
   expect(effectTree(cwd)).toEqual(expected);
   await d.answerApproval(ref,{behavior:'allow'});expect(effects).toBe(1);
   expect(effectTree(cwd)).toEqual(expected);
   mkdirSync(join(cwd,'A'));writeFileSync(join(cwd,'A','replacement.txt'),'replacement stays');
   expected=effectTree(cwd);
   expect(guardEngineRelease({threadId:'t',requestId:'ipc-move',turnId:'turn',providerInstanceId:'p'})).toBe(false);
   await expect(f.respond({threadId:'t',generation:'g',requestId:'ipc-move',turnId:'turn',providerInstanceId:'p'},{behavior:'allow'},{answerId:'late-answer'})).resolves.toEqual({state:'failed'});
   expect(effectTree(cwd)).toEqual(expected);
   expect(effects).toBe(1);expect(readFileSync(join(cwd,'A','replacement.txt'),'utf8')).toBe('replacement stays');
  }
  for(const name of ['B','C'])expect(readFileSync(join(cwd,name,'keep.txt'),'utf8')).toBe(name);
 }finally{
  const exited=once(child,'exit');child.kill();await exited;f.dispose();
 }
});
