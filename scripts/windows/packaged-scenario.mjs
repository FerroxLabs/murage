import {verifyStagedPackage,assertPhysicalPath} from './package-identity.mjs';
// Real packaged app driver. No routes, IPC handlers, updater or browser engines are replaced.
import nodeAssert from 'node:assert/strict';
let assertionCount=0,lastRecordedAssertion=0;
const assert=(...args)=>{const answer=nodeAssert(...args);assertionCount++;return answer;};
assert.equal=(...args)=>{const answer=nodeAssert.equal(...args);assertionCount++;return answer;};
assert.match=(...args)=>{const answer=nodeAssert.match(...args);assertionCount++;return answer;};
import { _electron } from '@playwright/test';
import { createServer } from 'node:http';
import {createNativeLauncher} from './native-launcher.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { seedTermsAccepted } from '../control-murage.ts';
import { handleToolCall } from '../mcp-server.ts';
import { desktopGroups } from './receipt-pair.mjs';
import { validateFeed, fixtureEngineEntry } from './fixture-feed.mjs';
const here=dirname(fileURLToPath(import.meta.url)), repo=resolve(here,'../..');
const options=JSON.parse(readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
const {executable,fixture,feedDirectory,kind}=options;
assert.equal(process.platform,'win32');
assert.match(process.env.MURAGE_GATE_RUN_PREFIX ?? '',/^MurageCI-[a-f0-9]{32}-$/);
assert.equal(process.env.MURAGE_GATE_CREATE_JOB,undefined);
const nativeLauncher=createNativeLauncher();
await nativeLauncher.run(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-File',join(here,'admission-check.ps1')],30000);
for(const p of [executable,fixture,feedDirectory,options.node,repo])assertPhysicalPath(p,'C:\\murage-ci');
const evidence=join(fixture,'evidence'); mkdirSync(evidence,{recursive:true});
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2));
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest=validateFeed(feedDirectory,executable,options.commit);
const {commit}=manifest.identity;
const node=options.node;
const pe=readFileSync(node), offset=pe.readUInt32LE(0x3c);
assert.equal(pe.readUInt16LE(offset+24+68),3,'MCP must use a console-subsystem node.exe');
const env={};
for(const key of ['SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','TZ','COMPUTERNAME','USERNAME','MURAGE_GATE_RUN_PREFIX','MURAGE_GATE_JOB_NAME','MURAGE_GATE_TASK_HELPER','MURAGE_GATE_NATIVE_BROKER']) if(process.env[key]) env[key]=process.env[key];
let home,data;
if(kind==='desktop') {
 home=join(fixture,'home'); data=join(fixture,'data');
 Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData','Roaming'),LOCALAPPDATA:join(home,'AppData','Local'),MURAGE_DATA_DIR:data,MURAGE_USER_DATA:join(fixture,'user-data')});
} else {
 assert.equal(process.env.COMPUTERNAME?.toLowerCase(),'gate-win-nogit'); assert.equal(process.env.USERNAME,'murage-gate');
 for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) if(process.env[key]) env[key]=process.env[key];
 home=env.USERPROFILE; data=join(home,'.murage');
 assert(!existsSync(data),'handoff requires a fresh gate user default profile');
}
Object.assign(env,{PATH:dirname(node),TEMP:join(fixture,'temp'),TMP:join(fixture,'temp'),MURAGE_ANNOUNCEMENTS_URL:'off',MURAGE_PUSH_RELAY_URL:'off'});
for(const p of [home,data,env.APPDATA,env.LOCALAPPDATA,env.MURAGE_USER_DATA,env.TEMP].filter(Boolean)) mkdirSync(p,{recursive:true});
seedTermsAccepted(data);
json(join(data,'whats-new.json'),{seen:['1.0.19',manifest.version],lastVersion:'1.0.19'});
const echoLog=join(evidence,'echo-protocol.jsonl'), modeFile=join(fixture,'echo-mode'); writeFileSync(modeFile,'echo');
const fake=join(repo,'server','testing','fake-codex-app-server.ts');
const fallbackMarker=join(evidence,'shell-fallback.txt');
const shellCli=join(fixture,'gate-echo.cmd');
writeFileSync(shellCli,`@echo off\r\necho shell-fallback-entered>>"${fallbackMarker}"\r\n"${node}" "${join(here,'echo-mcp.mjs')}" "${echoLog}" "${modeFile}"\r\n`);
env.PATH=`${fixture};${dirname(node)}`;
const mountsFile=join(evidence,'engine-mounts.jsonl');
const engineEntry=join(fixture,'fake-engine-entry.mjs');
// Observe only these two non-secret fixture mounts, then run the existing fake unchanged.
writeFileSync(engineEntry,fixtureEngineEntry(pathToFileURL(fake).href,mountsFile));
const environment={FAKE_CUSTOM_TOOL_SERVER:'gateecho',FAKE_CODEX_MODE:'happy',FAKE_CODEX_UNIQUE_THREADS:'1',WINSCEN_ECHO:'parent-value'};
const claudeDump=join(evidence,'claude-chain.json');
const instances=Object.fromEntries(['direct','shell'].map(name=>[name,{driver:'codex',environment:{...environment,WINSCEN_ENGINE_KIND:name},config:{cli:`"${node}" --experimental-strip-types "${engineEntry}"`,fullAuto:true}}]));
instances.claude={driver:'claudeAgent',environment:{...environment,FAKE_CUSTOM_TOOL_SERVER:'gatechain',FAKE_CLAUDE_MODE:'happy',FAKE_CLAUDE_DUMP:claudeDump},config:{cli:`"${node}" --experimental-strip-types "${join(repo,'server/testing/fake-claude-cli.ts')}"`}};
json(join(data,'config.json'),{engineDiscovery:'explicit',instances,mcpServers:{
 gatechain:{command:node,args:[join(here,'echo-mcp.mjs'),echoLog,modeFile],env:{WINSCEN_ECHO:'override-confirmed',WINSCEN_CMD_CHAIN:'1'},enabled:true},
 gateecho:{command:node,args:[join(here,'echo-mcp.mjs'),echoLog,modeFile],env:{WINSCEN_ECHO:'override-confirmed'},enabled:true},
 // The extensionless command has no .exe. CreateProcess returns ENOENT; the
 // packaged Codex collision launcher retries through cmd, which resolves .cmd.
 gatefallback:{command:'gate-echo',args:[],env:{WINSCEN_ECHO:'override-confirmed'},enabled:true}
}});
const updateConfig=join(dirname(executable),'resources','app-update.yml');
const originalFeed=readFileSync(updateConfig);
// This is the supported electron-builder generic feed configuration, outside app.asar.
const localFeedConfig=`provider: generic\nurl: ${manifest.feedUrl}\nchannel: latest\nupdaterCacheDirName: murage-gate-updater\n`;
const requests=[]; let app,page; const groups=[];
const feed=createServer((req,res)=>{
 requests.push({at:Date.now(),url:req.url});
 let name;try{name=decodeURIComponent(new URL(req.url,manifest.feedUrl).pathname).slice(1);}catch{res.writeHead(400);res.end();return;}
 if(name==='page') {res.setHeader('content-type','text/html');res.end('<!doctype html><title>Murage gate local page</title><h1>gate navigation confirmed</h1>');return;}
 if(!['latest.yml',manifest.installer,`${manifest.installer}.blockmap`].includes(name)){res.writeHead(404);res.end();return;}
 try {const bytes=readFileSync(join(feedDirectory,name));res.setHeader('content-length',bytes.length);res.end(bytes);} catch {res.writeHead(404);res.end();}
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=120000) {const end=Date.now()+ms;let last;do{last=await fn();if(last)return last;await delay(250);}while(Date.now()<end);throw new Error(`timeout: ${label}`);}
const native=(file,args,timeout=300000)=>nativeLauncher.run(file,args,timeout);
const ps=join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
async function launch() {
 app=await _electron.launch({executablePath:executable,args:[],env,timeout:120000});
 assert.equal(await app.evaluate(({app})=>app.isPackaged),true);
 assert.equal(await app.evaluate(({app})=>app.getVersion()),'1.0.19');
 page=await until(async()=>app.windows().find(p=>p.url().startsWith('http://127.0.0.1:')),'packaged main window');
 await page.waitForFunction(()=>window.muragebox?.updater);
 await page.evaluate(()=>{window.__gateUpdates=[];window.muragebox.updater.onState(s=>window.__gateUpdates.push(s));});
}
async function stopApp(){if(app){await app.close();app=null;}}
async function api(method,path,body){
 const answer=await page.evaluate(async({method,path,body})=>{const r=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},{method,path,body});
 assert(answer.status>=200&&answer.status<300,`${method} ${path}: ${JSON.stringify(answer)}`);return answer.body;
}
const call=(name,args)=>handleToolCall(name,args,(path,opts={})=>api(opts.method??'GET',path,opts.body?JSON.parse(opts.body):undefined));
const logs=()=>existsSync(echoLog)?readFileSync(echoLog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function bot(instance='direct') {
 const {bot}=await api('POST','/api/bots',{name:`Gate ${instance}`,modelSelection:{instanceId:instance,model:instance==='claude'?'claude-sonnet-5':'gpt-fake-default'}});
 await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false,autoApprove:true});return bot;
}
async function send(b,text){return call('send_bot_message',{bot_id:b.id,text});}
async function settle(b){const r=await call('wait_for_conversation',{target_type:'bot',target_id:b.id,timeout_seconds:120});assert.equal(r.status,'settled',JSON.stringify(r));return r;}
async function messages(b){return call('get_bot_messages',{bot_id:b.id,limit:30});}
const timings=new Map();
async function control(group,edge) {
 const id=randomBytes(16).toString('hex'),request=join(fixture,'observer-request.json'),response=join(fixture,'observer-response.json');
 const pending=join(fixture,'observer-request.pending');json(pending,{id,group,edge});renameSync(pending,request);
 await until(()=>{if(!existsSync(response))return false;const r=JSON.parse(readFileSync(response,'utf8').replace(/^\uFEFF/,''));if(r.id!==id)return false;unlinkSync(response);return true;},'visible console positive control',20000);
}
async function snapshot(name,edge) {
 await native(ps,['-NoProfile','-File',join(here,'snapshot.ps1'),'-Kind',kind,'-File',join(evidence,`${name}-${edge}-snapshot.json`)]);
}
async function begin(name){await snapshot(name,'before');await control(name,'start');timings.set(name,Date.now());}
async function record(name,result,artifacts=[]) {
 const endedAt=Date.now();await control(name,'end');await snapshot(name,'after');artifacts.push(`evidence/${name}-before-snapshot.json`,`evidence/${name}-after-snapshot.json`);const passed=assertionCount-lastRecordedAssertion;nodeAssert(passed>0);lastRecordedAssertion=assertionCount;json(join(evidence,`${name}.json`),result);groups.push({name,startedAt:timings.get(name),endedAt,passed,failed:0,skipped:0,artifacts:[`evidence/${name}.json`,...artifacts]});}
async function turn(b,text){const before=logs().length;await send(b,text);const settled=await settle(b);const transcript=await messages(b);assert.match(JSON.stringify(transcript),/gate echo override-confirmed/);const protocol=logs().slice(before);assert(protocol.some(x=>x.method==='tools/list'));assert(protocol.some(x=>x.event==='result'));return {action:text,settled,transcript,protocol};}
async function updateDownload(){
 await page.evaluate(()=>window.muragebox.updater.check());
 await until(async()=>{const s=await page.evaluate(()=>window.__gateUpdates.at(-1));if(s?.status==='error')throw new Error(s.message);return s?.status==='available'&&s.version===manifest.version;},'local update available');
 await page.evaluate(()=>window.muragebox.updater.download());
 await until(async()=>{const s=await page.evaluate(()=>window.__gateUpdates.at(-1));if(s?.status==='error')throw new Error(s.message);return s?.status==='downloaded'&&s.version===manifest.version;},'local update downloaded',300000);
 assert(requests.some(r=>r.url.startsWith('/latest.yml')));assert(requests.some(r=>r.url.startsWith('/'+manifest.installer)));
}
let failure;
try {
 writeFileSync(updateConfig,localFeedConfig);
 await new Promise((resolve,reject)=>{feed.once('error',reject);feed.listen(18919,'127.0.0.1',resolve);});
 await launch();
 const selected=options.groups??desktopGroups;lastRecordedAssertion=assertionCount;
 if(kind==='desktop') {
  if(selected.includes('bot-turns')) {
   await begin('bot-turns');
   const b=await bot(); const first=await turn(b,'first local echo');
   writeFileSync(modeFile,'hold');const before=logs().length;await send(b,'cancel this held echo');
   await until(()=>logs().slice(before).some(x=>x.event==='held'),'held MCP call');
   const cancelled=await call('interrupt_conversation',{target_type:'bot',target_id:b.id});await settle(b);
   writeFileSync(modeFile,'echo');const next=await turn(b,'turn after cancellation');
   await record('bot-turns',{first,cancelled,next});
  }
  if(selected.includes('tools')) {
   await begin('tools');
   const direct=await turn(await bot('direct'),'execute direct CLI tool');
   const shell=await turn(await bot('shell'),'execute shell fallback CLI tool __custom_tool__:gatefallback');
   assert.match(readFileSync(fallbackMarker,'utf8'),/shell-fallback-entered/);
   const mounts={};
   for(const name of ['direct','shell']) {
    const dump=readFileSync(mountsFile,'utf8').trim().split('\n').map(JSON.parse).findLast(x=>x.kind===name);assert(dump);
    const key=name==='direct'?'gateecho':'gatefallback';
    const arg=dump.mounts.find(a=>a.startsWith(`mcp_servers.${key}.args=`));assert(arg);
    const argv=JSON.parse(arg.slice(arg.indexOf('=')+1));
    assert(argv.includes('murage-env-launch'),'must exercise packaged collision launcher');
    mounts[name]={launcher:argv[2],target:argv[4]};
    assert.equal(argv[4],name==='direct'?node:'gate-echo');
   }
   await record('tools',{direct,shell,mounts},['evidence/shell-fallback.txt','evidence/engine-mounts.jsonl']);
  }
  if(selected.includes('mcp')) {
   await begin('mcp');
   const chain=await turn(await bot('claude'),'Claude Node cmd local chain');
   const descendant=chain.protocol.find(x=>x.event==='cmd-chain');assert(descendant,'Claude must launch Node MCP then cmd.exe');assert.equal(descendant.hookInstalled,true);assert.equal(descendant.preloadInherited,true);assert.equal(descendant.status,0);assert.match(descendant.stdout,/gate-cmd-chain/);
   const b=await bot();const success=await turn(b,'MCP list and echo');
   assert(success.protocol.some(x=>x.event==='start'&&x.override==='override-confirmed'));
   writeFileSync(modeFile,'error');await send(b,'MCP error');await settle(b);const error=await messages(b);assert.match(JSON.stringify(error),/gate echo deliberate error/);
   writeFileSync(modeFile,'hold');const before=logs().length;await send(b,'MCP cancellation');
   await until(()=>logs().slice(before).some(x=>x.event==='held'),'MCP held');
   const held=logs().slice(before).find(x=>x.event==='held');
   await call('interrupt_conversation',{target_type:'bot',target_id:b.id});await settle(b);
   assert(Number.isSafeInteger(held.pid)&&held.pid>0);
   await until(async()=> (await native(ps,['-NoProfile','-Command',`@(Get-Process -Id ${held.pid} -ErrorAction SilentlyContinue).Count`],30000)).trim()==='0','MCP child stopped');
   writeFileSync(modeFile,'echo');await record('mcp',{chain,descendant,node,subsystem:3,success,error,cancelledPid:held.pid},['evidence/echo-protocol.jsonl','evidence/claude-chain.json']);
  }
  if(selected.includes('browser')) {
   await begin('browser');
   const b=await bot();await api('PATCH',`/api/bots/${b.id}`,{browser:true});
   assert(b.threadId,'browser fixture requires owned conversation thread');
   const workspace=assertPhysicalPath(join(data,'workspaces',b.id,'threads',b.threadId),fixture);mkdirSync(workspace,{recursive:true});
   const bat=assertPhysicalPath(join(workspace,'refused.bat'),fixture),batMarker=join(evidence,'bat-executed.txt');
   writeFileSync(bat,`@echo off\r\necho unexpected execution>"${batMarker}"\r\n`);
   const shellRows=[];
   const refused=await page.evaluate(async scope=>{try{await window.muragebox.workspaceFileAction(scope,'refused.bat','open');return {refused:false};}catch(e){return {refused:true,message:e.message};}},{botId:b.id,threadId:b.threadId});
   assert.equal(refused.refused,true);assert.match(refused.message,/kind of file|file type|executable|script/i);assert.equal(existsSync(batMarker),false);shellRows.push({row:'bat-refused',...refused});
   for(const url of ['javascript:alert(1)','file:///C:/murage-ci/refused.bat']){
    const refusal=await page.evaluate(async url=>{try{await window.muragebox.openExternal(url);return {refused:false};}catch(e){return {refused:true,message:e.message};}},url);
    assert.equal(refusal.refused,true,`${url} must be refused`);assert(refusal.message);shellRows.push({url,...refusal});
   }
   const exeFile=join(workspace,'refused.exe');writeFileSync(exeFile,'refusal fixture');
   const exeRefusal=await page.evaluate(async scope=>{try{await window.muragebox.workspaceFileAction(scope,'refused.exe','open');return false;}catch{return true;}},{botId:b.id,threadId:b.threadId});
   assert.equal(exeRefusal,true);shellRows.push({row:'executable-refused',refused:exeRefusal});
   const path=`/api/bots/${b.id}/browser`;
   await api('POST',path,{action:'restart'});let state=await api('POST',path,{action:'take'});
   state=await until(async()=>{const s=await api('GET',path);if(s.problem)throw new Error(s.problem);return s.connected&&s;},'packaged browser connected');
   const navigation=await api('POST',path,{action:'navigate',generation:state.generation,url:manifest.feedUrl+'page'});
   assert.equal(navigation.url,manifest.feedUrl+'page');
   const frame=await until(async()=>{const s=await api('GET',path);const f=await api('GET',`${path}/frame?generation=${s.generation}`);return f?.data&&f;},'browser screenshot');
   const bytes=Buffer.from(frame.data.replace(/^data:image\/[^;]+;base64,/,''),'base64');assert(bytes.length>100);assert(frame.width>0&&frame.height>0);
   writeFileSync(join(evidence,'browser-frame.jpg'),bytes);
   const tree=join(evidence,'browser-processes.json');
   await native(ps,['-NoProfile','-File',join(here,'job-check.ps1'),'-Mode','Snapshot','-RootPid',String(app.process().pid),'-File',tree]);
   await api('DELETE',`/api/bots/${b.id}`); // deletion retires the real native browser binding
   await stopApp(); // full shutdown closes the packaged browser and its broker
   await native(ps,['-NoProfile','-File',join(here,'job-check.ps1'),'-Mode','AssertStopped','-File',tree]);
   await record('browser',{shellRows,startup:state,navigation,frame:{width:frame.width,height:frame.height,sha256:digest(join(evidence,'browser-frame.jpg'))},shutdown:'packaged app close awaited'},['evidence/browser-frame.jpg','evidence/browser-processes.json']);
   await launch();
  }
  if(selected.includes('sentinel')) {
   await begin('sentinel');
   await native(ps,['-NoProfile','-File',join(here,'sentinel-scenario.ps1'),'-Mode','Open','-Fixture',fixture,'-Executable',executable]);
   await stopApp();
   await native(ps,['-NoProfile','-File',join(here,'sentinel-scenario.ps1'),'-Mode','Closed','-Fixture',fixture,'-Executable',executable],300000);
   const proof=JSON.parse(readFileSync(join(evidence,'sentinel-closed.json'),'utf8').replace(/^\uFEFF/,''));assert(proof.recurringRuns>=2);assert.equal(proof.lastTaskResult,0);
   await record('sentinel',{open:JSON.parse(readFileSync(join(evidence,'sentinel-open.json'),'utf8').replace(/^\uFEFF/,'')),closed:proof},['evidence/sentinel-task.xml','evidence/sentinel-recurring.xml','evidence/sentinel-view-open.json','evidence/sentinel-view-closed.json','evidence/sentinel-publication-open-manual.json','evidence/sentinel-publication-closed-manual.json','evidence/sentinel-publication-recurring-1.json','evidence/sentinel-publication-recurring-2.json']);
   await launch();
  }
  if(selected.includes('updates-isolated')) {
   await begin('updates-isolated');
   await updateDownload();
   await page.getByTestId('update-popup').getByRole('button',{name:'Restart to update',exact:true}).click();
   const refusal=await until(async()=>{const s=await page.evaluate(()=>window.__gateUpdates.at(-1));return s?.status==='error'&&s;},'isolated updater refusal');
   assert.match(refusal.message,/custom profile.*same profile launcher/i);
   await page.getByText(refusal.message,{exact:false}).first().waitFor({state:'visible'});
   await page.screenshot({path:join(evidence,'updates-refusal.png')});
   assert.equal(await app.evaluate(({app})=>app.getVersion()),'1.0.19');
   await record('updates-isolated',{requests,refusal,states:await page.evaluate(()=>window.__gateUpdates),installerStarted:false},['evidence/updates-refusal.png']);
  }
 } else {
  await begin('updates-handoff');
  assert.equal(kind,'handoff');assert.equal(process.env.COMPUTERNAME.toLowerCase(),'gate-win-nogit');
  const external='https://127.0.0.1:18919/page';
  await page.evaluate(url=>window.muragebox.openExternal(url),external);
  const shellRows=[{row:'https-opened',url:external,osDispatch:'fulfilled',browserMayOutliveRun:true}];
  await updateDownload();
  const states=await page.evaluate(()=>window.__gateUpdates);
  const oldPid=app.process().pid;
  const closed=new Promise(resolve=>app.once('close',resolve));
  await page.getByTestId('update-popup').getByRole('button',{name:'Restart to update',exact:true}).click();
  let closeTimeout;try{await Promise.race([closed,new Promise((_,reject)=>{closeTimeout=setTimeout(()=>reject(new Error('updater did not close original app')),120000);})]);}finally{clearTimeout(closeTimeout);}app=null;
  const result=await native(ps,['-NoProfile','-File',join(here,'verify-relaunch.ps1'),'-Fixture',fixture,'-Version',manifest.version,'-OldPid',String(oldPid)],300000);
  await record('updates-handoff',{shellRows,states,requests,relaunch:JSON.parse(result),user:process.env.USERNAME});
 }
} catch(error){failure=error;json(join(evidence,'failure.json'),{message:error.message,stack:error.stack});}
finally {
 try {await stopApp();}catch(e){failure??=e;}
 try {await nativeLauncher.close();}catch(e){failure??=e;}
 if(feed.listening)await new Promise(resolve=>{feed.close(resolve);feed.closeAllConnections();});
 writeFileSync(updateConfig,originalFeed);
 verifyStagedPackage(dirname(executable),manifest.identity);
 json(join(evidence,'feed-requests.json'),requests);
}
if(failure)throw failure;
// Assertions only. PowerShell adds console observation and writes the receipt after cleanup.
json(join(fixture,'assertions.json'),{kind,machine:process.env.COMPUTERNAME.toLowerCase(),...manifest.identity,sha256:digest(executable),candidateVersion:'1.0.19',updateVersion:manifest.version,updateSha256:manifest.updateSha256,fixture,executable,isolated:kind==='desktop',fakeProvidersOnly:true,user:kind==='handoff'?'murage-gate':process.env.USERNAME,groups});
