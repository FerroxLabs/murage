import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runScenario} from './run.mjs';
import {fieldStarts} from './field-plan.mjs';
import {scenarioCommand} from './platform.mjs';
test('cron reads use the owned fixture path on Linux, macOS and Windows',()=>{
 for(const platform of ['linux','darwin','win32']){
  const home=platform==='win32'?'C:\\owned\\home':'/owned/home',cwd=platform==='win32'?'C:\\owned\\work':'/owned/work';
  const command=scenarioCommand('cron-read-runs',{platform,home,cwd,root:cwd});
  assert.ok(command.includes(home),command);assert.match(command,/cron/);
 }
});
test('MCP field identity survives the actual namespace/name normalization',()=>{
 const input={text:'fixture'},event={type:'item.started',itemType:'tool',itemId:'mcp',toolIdentity:{namespace:'mcp',name:'fixture__write'},input};
 assert.equal(fieldStarts({tool:'mcp__fixture__write',input},{events:[event]}).length,1);
});
async function field(outside,missingCompletion=false,wrongInput=false){
 const root=mkdtempSync(join(tmpdir(),'gnl-field-turn-')),home=join(root,'home'),work=join(root,'work'),empty=join(root,'gitconfig');
 mkdirSync(home);mkdirSync(join(home,'.ssh'));mkdirSync(work);writeFileSync(empty,'');const calls=[];
 const c={bot:async()=>({id:'fixture',threadId:'thread'}),messages:async()=>[],stop:async()=>{},decisions:()=>[],ledger:{forThreads:()=>[],problems:()=>[]},
  turn:async(_bot,text)=>{calls.push(text);const target=text.includes('Use exactly the Bash'),itemId=target?'target':'outside';return {complete:true,ended:true,cards:[],errors:[],threadIds:['thread'],events:[
   {type:'item.started',itemType:'tool',itemId,toolIdentity:{name:target?'Bash':'WebFetch'},input:{command:wrongInput?'echo substituted':'pwd'}},
   ...(!target||!missingCompletion?[{type:'item.completed',itemType:'tool',itemId,ok:true}]:[]),
   // The outside read completed; that must not certify an unfinished write.
   ...(target&&missingCompletion?[{type:'item.completed',itemType:'tool',itemId:'outside',ok:true}]:[])]};}};
 try{
  const row=await runScenario({root,home,work,client:c,gitEnv:{...process.env,GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty},observeRow:async()=>({verdict:'PASS'})},
   {id:'fixture'},{id:'field',actor:'owner',level:'unlimited',expected:'RUN',tool:'Bash',input:{command:'pwd'},outside},{url:'http://fixture.invalid'});
  return {calls,row};
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('earlier-turn outside data is read in a completed separate turn',async()=>{
 const {calls,row}=await field('earlier-turn');assert.equal(calls.length,2);assert.match(calls[0],/browser/);assert.doesNotMatch(calls[0],/Use exactly the Bash/);
 assert.match(calls[1],/Use exactly the Bash/);assert.equal(row.verdict,'PASS',row.errors.join('; '));
});
test('same-turn outside data and exact field input remain one turn',async()=>{
 const {calls,row}=await field('same-turn');assert.equal(calls.length,1);assert.match(calls[0],/browser/);assert.match(calls[0],/Use exactly the Bash/);assert.equal(row.verdict,'PASS');
});
test('a completed outside read cannot prove an unfinished field operation',async()=>{
 const {row}=await field('earlier-turn',true);assert.equal(row.verdict,'FAIL');assert.equal(row.actionProven,false);
});
test('a different command cannot prove the exact field input',async()=>{
 const {row}=await field('same-turn',false,true);assert.equal(row.verdict,'FAIL');assert.equal(row.actionProven,false);
});
