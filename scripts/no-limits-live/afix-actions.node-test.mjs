import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installOriginFixtures} from './origin-fixtures.mjs';
import {runR2} from './r2-scenarios.mjs';
const start=(input={command:'fixture'},itemId='action')=>({type:'item.started',itemType:'tool',itemId,toolIdentity:{name:'Bash'},input});
const done=(itemId='action',ok=true)=>({type:'item.completed',itemType:'tool',itemId,ok});
function nativeObservation(data,events,threadId){
 mkdirSync(data,{recursive:true});
 const native=events.map((event,i)=>({...event,threadId,turnId:'fixture-turn',provider:'fixture',providerInstanceId:'fixture',eventId:'fixture-'+i}));
 writeFileSync(join(data,'nolim-native-events.ndjson'),native.map(event=>JSON.stringify(event)).join('\n')+'\n');
 return {cards:[],threadIds:[threadId],events:native.map(event=>{const projected={...event};delete projected.input;return projected;})};
}
for(const origin of ['phone','channel-dm'])test(`${origin}: skipped owner command cannot borrow a successful read`,async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'gnl-action-'));try{
  for(const mode of ['unrelated','wrong-input','wrong-completion','no-effect','good']){
   const data=join(cwd,mode+'-native');
   const obs=nativeObservation(data,mode==='unrelated'?[done('read')]:[start({command:mode==='wrong-input'?'read':'fixture'}),done(mode==='wrong-completion'?'read':'action')],origin==='channel-dm'?'run-thread':'thread');
   const bot={id:'bot',threadId:'thread',autoApprove:true,fullAccess:true,noLimits:true,tasks:[{threadId:'run-thread'}]};
   // MAIN RULING: G-NL 08f11b58ed declares the exact channel ingress for accounting.
   const declarations=[];
   let runs=0;const c={events:[],declare:(threadId,text)=>declarations.push({threadId,text}),beginMessageWindow:async()=>({afterId:null}),observe:async(_bot,send)=>{await send();rmSync(join(cwd,'action.done'),{force:true});if(mode!=='no-effect')writeFileSync(join(cwd,'action.done'),'fixture');return obs;},api:async(method,path)=>{
    if(path==='/api/telegram/pair')return {code:'pair'};
    if(path==='/api/telegram/status')return {targetBotId:'bot',paired:true};
    if(path==='/api/memory/action')return {bindings:[{id:'human',revision:1}]};
    if(path==='/api/routines')return {runs:runs++? [{id:'run',botId:'bot',triggerSource:'channel',threadId:'run-thread'}]:[]};
    if(path==='/api/bots/bot')return {bot};return {};
   }};
   writeFileSync(join(cwd,'sent.jsonl'),'paired');
   const bindings=installOriginFixtures({phoneHeaders:{},channelDir:cwd,data});
   // The local transport appends its pairing receipt when the update is renamed.
   if(origin==='channel-dm'){let n=0;const api=c.api;c.api=async(...args)=>{if(args[1]==='/api/telegram/status')writeFileSync(join(cwd,'sent.jsonl'),`paired ${++n}`);return api(...args);};}
   const result=await bindings[`owner-${origin}`]({client:c,bot,spec:{actor:'owner',expected:'RUN'},command:'fixture',cwd,threads:new Set()});
   assert.equal(result.proof,mode==='good',mode);
   assert.deepEqual(declarations,origin==='channel-dm'?[{threadId:'run-thread',text:'Run exactly this shell command once: fixture. If denied, stop.'}]:[]);
  }
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
// MAIN RULING: stored-rule lane 48218a79955 requires an independently read
// installed-rule witness as well as the existing exact action/effect proof.
for(const [id,tool,input]of [['deny-host-declined','computer_screenshot',{}],['deny-browser-never','browser_navigate',{url:'http://fixture.invalid'}]])
test(`${id}: exact input, matching completion and independent effect are all required`,async()=>{
 for(const mode of ['unrelated','wrong-input','wrong-completion','no-effect','good']){
  let effect=0,saved=false;const events=[{type:'item.started',itemType:'tool',itemId:'target',toolIdentity:{name:tool},input:mode==='wrong-input'?{other:true}:input},done(mode==='wrong-completion'?'read':'target')];
  const c={api:async()=>{saved=true;return {};},turn:async()=>{if(mode==='good')effect++;return {cards:[],events:mode==='unrelated'?[done('read')]:events};}};
  const f={permissionRuleWitnesses:{[id]:async()=>({source:id,ruleInstalled:saved,actionExecuted:effect===1})},r2Targets:{[id]:{tool,input,readEffect:()=>effect}}};
  const result=await runR2({c,f,bot:{id:'fixture'},spec:{id,expected:'RUN'},cwd:'/fixture',site:{url:'http://fixture.invalid'},prompt:(_cwd,text)=>text});
  assert.equal(result.proof,mode==='good',mode);
 }
});
test('owner room command cannot pass on an unrelated completed shell operation',async()=>{
 const {platformCommands}=await import('./platform.mjs');
 const cwd=mkdtempSync(join(tmpdir(),'gnl-room-action-'));try{
  const command=platformCommands(process.platform,cwd,cwd).run;
  for(const mode of ['unrelated','wrong-input','wrong-completion','no-effect','good']){
   const data=join(cwd,mode+'-native');
   const obs=nativeObservation(data,mode==='unrelated'?[start({command:'ls'}),done()]:[start({command:mode==='wrong-input'?'ls':command}),done(mode==='wrong-completion'?'read':'action')],'room');
   const c={ownedCwds:new Map(),api:async(method)=>method==='POST'?{group:{id:'group',threadId:'room'}}:{},observe:async(_bot,send)=>{await send();rmSync(join(cwd,'action.done'),{force:true});if(mode!=='no-effect')writeFileSync(join(cwd,'action.done'),'fixture');return obs;}};
   const result=await runR2({c,f:{data},bot:{id:'bot'},spec:{id:'owner-room-turn'},cwd,prompt:(_cwd,text)=>text,threads:new Set()});
   assert.equal(result.proof,mode==='good',mode);
  }
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
