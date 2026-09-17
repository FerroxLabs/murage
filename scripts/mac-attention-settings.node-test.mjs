import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./mac-attention-qualification.mjs',import.meta.url),'utf8');
const jxa=readFileSync(new URL('./mac-attention-ax.jxa',import.meta.url),'utf8');
const fn=/async function settingsTree\(pid,label\)\{[\s\S]*?\n\}/.exec(source)[0];
const snapshot=source.slice(source.indexOf('function tree('),source.indexOf('async function settingsTree('));
const failure={ok:false,actionAttempted:false,error:'AX-read',code:-25204,attribute:'AXRole',visited:1,elapsedMs:1083};
const complete={ok:true,elements:[{role:'AXCheckBox',names:['Needs your attention'],value:1}],visited:2};
function fixture(results,{elapsed=1083,stopping=false,status=false}={}){
 let clock=0;const calls=[],records=[],writes=[];
 const read=runInNewContext(snapshot+';'+(status?'(async(pid,label)=>tree(pid,label,10000))':'('+fn+')'),{
  Date:{now:()=>clock},stopping,
  ax:(pid,command,options)=>{calls.push({pid,command:JSON.parse(JSON.stringify(command)),options});clock+=Math.min(elapsed,options.timeout);return results[Math.min(calls.length-1,results.length-1)];},
  writeFileSync:(_path,text)=>writes.push(JSON.parse(text)),path:{join:(...x)=>x.join('/')},E:'/evidence',
  record:(step,value)=>records.push({step,...value}),pause:async ms=>{clock+=ms;},
  check:(ok,label)=>{if(!ok)throw Error(label);},
 });
 return {read,calls,records,writes,time:()=>clock};
}
test('Settings retries only the recorded read failure and returns the complete tree',async()=>{
 const f=fixture([failure,complete]);assert.equal(await f.read(123,'settings'),complete);
 assert.equal(f.calls.length,2);assert.equal(f.records.length,2);assert.equal(f.writes[0].attribute,'AXRole');
 assert(f.calls.every(c=>c.pid===123&&c.command.op==='tree'&&c.command.settingsReadiness===true));
 assert(f.calls[1].options.timeout<f.calls[0].options.timeout);
});
test('persistent read failure stops at three within the original15 second deadline',async()=>{
 const f=fixture([failure],{elapsed:3000});await assert.rejects(f.read(123,'settings'),/AX_TREE_settings/);
 assert.equal(f.time(),9000);assert.equal(f.calls.length,3);assert.equal(f.calls.length,f.records.length);assert.equal(f.calls.length,f.writes.length);
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

test('recorded R31 mount-stale permission status uses same reader under original10 second deadline',async()=>{
 const stale={...failure,code:-25202,visited:551,elapsedMs:909};const f=fixture([stale,complete],{elapsed:909,status:true});assert.equal(await f.read(123,'notification-permission-requested'),complete);assert.equal(f.calls.length,2);assert(f.calls.every(x=>x.command.op==='tree'&&!x.command.settingsReadiness));assert.equal(f.calls[0].options.timeout,10000);assert.equal(f.calls[1].options.timeout,9091);
 const deadline=fixture([stale],{elapsed:6000,status:true});await assert.rejects(deadline.read(123,'status'),/AX_TREE_status/);assert.equal(deadline.time(),10000);assert.equal(deadline.calls.length,2);
});
test('shared snapshot refresh refuses ambiguous action state and has no nested retries',async()=>{
 for(const result of [{...failure,code:-25202,actionAttempted:true},{...failure,code:-25202,actionAttempted:undefined}]){const f=fixture([result,complete],{status:true});await assert.rejects(f.read(123,'status'),/AX_TREE_status/);assert.equal(f.calls.length,1);}
 const inbox=source.slice(source.indexOf('async function readPendingInbox('),source.indexOf('async function pending('));assert(!inbox.includes('for('));assert(!fn.includes('while('));assert(inbox.includes("tree(s.pid,'pending-'+kind,deadline)"));assert(source.includes("tree(s.pid,'notification-permission-requested',permissionDeadline)"));
});
