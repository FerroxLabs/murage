import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./mac-attention-qualification.mjs',import.meta.url),'utf8');
const jxa=readFileSync(new URL('./mac-attention-ax.jxa',import.meta.url),'utf8');
const fn=/async function settingsTree\(pid,label\)\{[\s\S]*?\n\}/.exec(source)[0];
const failure={ok:false,error:'AX-read',code:-25204,attribute:'AXRole',visited:1,elapsedMs:1083};
const complete={ok:true,elements:[{role:'AXCheckBox',names:['Needs your attention'],value:1}],visited:2};
function fixture(results,{elapsed=1083,stopping=false}={}){
 let clock=0;const calls=[],records=[],writes=[],samples=[];
 const read=runInNewContext('('+fn+')',{
  Date:{now:()=>clock},stopping,
  load:()=>({exe:'/owned/Murage',private:'/owned/private'}),
  run:()=>{throw Error('No native execution in fixture');},redactSecretsInLine:x=>x,
  captureMainSample:input=>{samples.push(input);return {ok:true,diagnosticOnly:true};},
  ax:(pid,command,options)=>{calls.push({pid,command:JSON.parse(JSON.stringify(command)),options});clock+=Math.min(elapsed,options.timeout);return results[Math.min(calls.length-1,results.length-1)];},
  writeFileSync:(_path,text)=>writes.push(JSON.parse(text)),path:{join:(...x)=>x.join('/')},E:'/evidence',
  record:(step,value)=>records.push({step,...value}),pause:async ms=>{clock+=ms;},
  check:(ok,label)=>{if(!ok)throw Error(label);},
 });
 return {read,calls,records,writes,samples,time:()=>clock};
}
test('Settings retries only the recorded read failure and returns the complete tree',async()=>{
 const f=fixture([failure,complete]);assert.equal(await f.read(123,'settings'),complete);
 assert.equal(f.calls.length,2);assert.equal(f.records.filter(r=>r.step==='settings-tree-read').length,2);assert.equal(f.writes[0].attribute,'AXRole');
 assert.equal(f.samples.length,1);assert.equal(f.samples[0].pid,123);assert.equal(f.samples[0].deadline,15000);
 assert(f.calls.every(c=>c.pid===123&&c.command.op==='tree'&&c.command.settingsReadiness===true));
 assert(f.calls[1].options.timeout<f.calls[0].options.timeout);
});
test('persistent read failure shares one 15 second deadline and retains each attempt',async()=>{
 const f=fixture([failure],{elapsed:3000});await assert.rejects(f.read(123,'settings'),/AX_TREE_settings/);
 assert.equal(f.time(),15000);assert.equal(f.calls.length,f.records.filter(r=>r.step==='settings-tree-read').length);assert.equal(f.calls.length,f.writes.length);
 assert.equal(f.samples.length,1);
 assert(f.calls.length>1);assert(f.calls.every(c=>c.command.op==='tree'));
});
test('permission, structural, malformed and other errors fail immediately',async()=>{
 for(const result of [{ok:false,error:'AX-client-not-trusted'},{ok:false,error:'AX-limit'}, {ok:false,error:'osascript'}, {...failure,code:-25205},{ok:false,error:'AX-press',code:-25204}]){
  const f=fixture([result,complete]);await assert.rejects(f.read(123,'settings'),/AX_TREE_settings/);assert.equal(f.calls.length,1);
 }
});
test('stopped fixture cannot issue a readiness query',async()=>{
 const f=fixture([complete],{stopping:true});await assert.rejects(f.read(123,'settings'),/AX_TREE_settings/);assert.equal(f.calls.length,0);
});
test('3 second messaging applies only to read-only Settings tree; native actions keep 1 second',()=>{
 const timeouts=[],node={AXRole:'AXApplication',AXTitle:'Murage',AXDescription:'',AXValue:'',AXChildren:[]},dollar=x=>x;
 Object.assign(dollar,{AXIsProcessTrusted:()=>true,AXUIElementCreateApplication:()=>node,AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:(_e,seconds)=>{timeouts.push(seconds);return 0;},AXUIElementCopyAttributeValue:(e,k,r)=>{if(!(k in e))return -25205;r[0]=e[k];return 0;}});
 const run=runInNewContext(jxa+';run',{ObjC:{import(){},bindFunction(){},deepUnwrap:x=>x},$:dollar,Ref:()=>[]});
 const query=c=>JSON.parse(run([JSON.stringify({pid:123,...c})]));
 assert(query({op:'tree',settingsReadiness:true}).ok);assert(query({op:'tree'}).ok);
 assert.equal(query({op:'press',settingsReadiness:true}).error,'AX-settings-read-contract');
 assert.deepEqual(timeouts,[3,1]);
});
test('Settings actions remain single and native permission checks are retained',()=>{
 const settings=/async function settings\(s,changes\)\{[^\n]*\}/.exec(source)[0];
 assert.equal((settings.match(/press\(s.pid,'App settings'\)/g)||[]).length,1);
 assert(settings.includes("await settingsTree(s.pid,'notification-settings-ready')"));
 assert(source.includes("const t=await settingsTree(s.pid,'notification-settings')"));
 for(const gate of ['RENDERER_NOTIFICATION_PERMISSION_DENIED','RENDERER_NOTIFICATION_PERMISSION_UNAVAILABLE','RENDERER_NOTIFICATION_PERMISSION','PREFERENCES_CONFIRMED'])assert(source.includes(gate));
 assert(!source.includes('windowSelector'));
});
