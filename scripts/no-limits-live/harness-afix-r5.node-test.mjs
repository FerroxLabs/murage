import test from 'node:test';
import assert from 'node:assert/strict';
import {releasePlan} from './fakes/release-plan.mjs';
import {resolveReleaseStep,rememberReleaseResult} from './fakes/common.mjs';
import {validateHeadlessBrowserCall} from '../../server/browser-engine-policy.ts';
import {declaredRequests} from './declared-requests.mjs';
import {classifyRequest,hashInput} from './oracle-class.mjs';

test('H-workflow long page reads follow the real saved-handle contract',()=>{
 const url='http://127.0.0.1:12345/long/fixture',text=`Use browser tools to fetch ${url}. Read again with offset 12000 and report the exact end marker.`;
 const steps=releasePlan(text).steps.filter(s=>s.tool?.startsWith('agent_browser_'));
 assert.equal(steps.length,3);
 const state={};
 assert.doesNotThrow(()=>validateHeadlessBrowserCall(steps[0].tool,steps[0].input));
 assert.doesNotThrow(()=>validateHeadlessBrowserCall(steps[1].tool,steps[1].input));
 assert.deepEqual(steps[1].input,{url,length:12000,raw:true});
 assert.throws(()=>resolveReleaseStep(steps[2],state),/previous saved-page receipt/);
 const page={handle:'w-fixture',url,next_offset:12000};
 rememberReleaseResult(steps[1],{result:{structuredContent:page}},state);
 const wrapped={};rememberReleaseResult(steps[1],JSON.stringify({ok:true,result:JSON.stringify(page)+'\npage body'}),wrapped);assert.equal(wrapped.page.handle,page.handle);
 const continued=resolveReleaseStep(steps[2],state);
 assert.deepEqual(continued.input,{handle:page.handle,offset:12000});
 assert.doesNotThrow(()=>validateHeadlessBrowserCall(continued.tool,continued.input));
 const engine={driver:'cursorAgent'},spec={expected:'RUN'};
 const incidental=declaredRequests(text,engine,spec,'/owned',[page]);
 assert.equal(classifyRequest({incidental},{engine:engine.driver,tool:continued.tool,inputHash:hashInput(continued.input)}),'run');
 assert.equal(classifyRequest({incidental},{engine:engine.driver,tool:continued.tool,inputHash:hashInput({...continued.input,handle:'w-foreign'})}),null);
 assert.equal(classifyRequest({incidental:declaredRequests(text,engine,spec,'/owned')},{engine:engine.driver,tool:continued.tool,inputHash:hashInput(continued.input)}),null);
});

test('H-workflow plain browser calls keep the original open/snapshot/close sequence',()=>{
 const plan=releasePlan('Use browser tools to navigate to http://127.0.0.1:12345/fixture.');
 assert.deepEqual(plan.steps.map(s=>s.tool),['agent_browser_open','agent_browser_snapshot','agent_browser_close']);
 for(const step of plan.steps)assert.doesNotThrow(()=>validateHeadlessBrowserCall(step.tool,step.input));
});


test('H-workflow Copilot fake consumes the real launch-time MCP catalogue',async()=>{
 const {acpLaunchMounts}=await import('./mounted-tools.mjs');
 const servers={agents:{command:'node',args:['scoped-proxy'],env:{TOKEN:'fixture-only'}}};
 let path;
 assert.deepEqual(acpLaunchMounts(['--additional-mcp-config','@/owned/turn.json'],file=>{path=file;return JSON.stringify({mcpServers:servers});}),servers);
 assert.equal(path,'/owned/turn.json');assert.deepEqual(acpLaunchMounts([]),[]);
 assert.throws(()=>acpLaunchMounts(['--additional-mcp-config','bad']),/missing/);
});

test('H-workflow native empty-shell and Pi Write declarations bind exact normalized arguments',()=>{
 for(const [driver,text,tool,input] of [
  ['antigravityAgent','Use exactly the Bash tool once with this input: {}. Do not substitute','run_command',{cwd:'/owned'}],
  ['piAgent','Use exactly the Write tool once with this input: {"file_path":"fixture.txt","content":"fixture"}. Do not substitute','write',{path:'fixture.txt',content:'fixture'}],
 ]){
  const incidental=declaredRequests(text,{driver},{expected:'RUN'},'/owned');
  assert.equal(classifyRequest({incidental},{engine:driver,tool,inputHash:hashInput(input)}),'run');
  assert.equal(classifyRequest({incidental},{engine:driver,tool,inputHash:hashInput({...input,extra:'not-declared'})}),null);
 }
});

for(const allowed of [false,true])test(`H-workflow Hermes fixture emits execution only after its ${allowed?'allow':'deny'} receipt`,async()=>{
 const {spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
 const {mkdtempSync,mkdirSync,existsSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'nolim-live-harness-')),cwd=join(root,'work');mkdirSync(cwd);
 const path=new URL('./launchers/release-acp.mjs',import.meta.url);
 const child=spawn(process.execPath,[path.pathname],{cwd,env:{...process.env,NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root,GNL_FAKE_KIND:'hermesAgent'},stdio:['pipe','pipe','pipe']});
 const updates=[];let asked=0,timeout;
 try{
  const done=new Promise((resolve,reject)=>{
   timeout=setTimeout(()=>reject(Error('Fake ACP protocol deadline')),10000);
   child.once('error',reject);
   createInterface({input:child.stdout}).on('line',line=>{
    const frame=JSON.parse(line);
    if(frame.method==='session/request_permission'){
     asked++;try{assert.equal(updates.length,0,'Hermes must check before reporting an execution');}catch(error){reject(error);return;}
     child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{outcome:{optionId:allowed?'allow':'deny'}}})+'\n');
    }else if(frame.method==='session/update'&&frame.params.update.sessionUpdate.startsWith('tool_call'))updates.push(frame.params.update);
    else if(frame.id===1){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'session/prompt',params:{prompt:[{type:'text',text:'Run exactly: printf fixture > action.done. If denied, stop.'}]}})+'\n');}
    else if(frame.id===2){if(frame.error)reject(Error(frame.error.message));else resolve(frame.result);}
   });
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'session/new',params:{mcpServers:[]}})+'\n');
  await done;assert.equal(asked,1);
  assert.equal(updates.filter(u=>u.sessionUpdate==='tool_call').length,allowed?1:0);
  assert.equal(existsSync(join(cwd,'action.done')),allowed);
 }finally{clearTimeout(timeout);const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();child.kill();await exited;rmSync(root,{recursive:true,force:true});}
});
