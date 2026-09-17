import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./mac-attention-qualification.mjs',import.meta.url),'utf8');
const jxa=readFileSync(new URL('./mac-attention-ax.jxa',import.meta.url),'utf8');
const check=(ok,label)=>{if(!ok)throw Error(label);};
const expected='B35_NATIVE_PHASE:banner-46c70df10127cef6';
function helper(options={}){
 const node=(role,title,children=[])=>({AXRole:role,AXTitle:title,AXDescription:'',AXValue:'',AXChildren:children,AXEnabled:true});
 const field=node('AXTextArea','Message B35'),button=node('AXButton','Send message'),app=node('AXApplication','Murage',[field,button]);button.AXEnabled=options.buttonEnabled??true;
 let clock=0,set=false,reads=0;const events=[],dollar=x=>x;
 Object.assign(dollar,{AXIsProcessTrusted:()=>true,AXUIElementCreateApplication:()=>app,AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:()=>0,
  AXUIElementCopyAttributeValue:(e,k,r)=>{if(options.roleError&&k==='AXRole')return -25202;if(set&&e===field&&k==='AXValue'){if(options.readError)return -25204;r[0]=++reads<=(options.delayReads??0)?'':Object.hasOwn(options,'readback')?options.readback:field.AXValue;return 0;}if(!Object.hasOwn(e,k))return -25205;r[0]=e[k];return 0;},
  AXUIElementCopyActionNames:(_e,r)=>{r[0]=['AXPress'];return 0;},AXUIElementIsAttributeSettable:(_e,_k,r)=>{r[0]=options.settable??true;return options.settableCode??0;},
  AXUIElementSetAttributeValue:(e,k,v)=>{events.push({kind:'set',value:v});set=true;e[k]=v;return options.setCode??0;},AXUIElementPerformAction:()=>{events.push({kind:'press'});return options.pressCode??0;}});
 const run=runInNewContext(jxa+';run',{Application:()=>({processes:{whose:()=>[{}]},keystroke:()=>assert.fail('no keyboard fallback')}),ObjC:{import(){},bindFunction(){},deepUnwrap:x=>x},$:dollar,Ref:()=>[],Date:{now:()=>clock},delay:()=>{clock+=1000;}});
 return{events,app,button,query:c=>JSON.parse(run([JSON.stringify({pid:123,roles:['AXTextArea','AXTextField'],label:'Message B35',...c})]))};
}
test('composer exact AXValue setter waits for full readback and refuses incomplete input without click',()=>{
 for(const options of [{},{delayReads:2}]){const h=helper(options),r=h.query({op:'type',text:expected});assert.equal(r.ok,true);assert.equal(r.observed.readback,expected);assert.equal(h.events.filter(e=>e.kind==='set').length,1);}
 for(const options of [{readback:expected.slice(4)},{readback:''},{readback:null},{settable:false},{settableCode:-25205},{setCode:-25204},{readError:true}]){const h=helper(options),r=h.query({op:'type',text:expected});assert.equal(r.ok,false,JSON.stringify(options));assert.ok(r.observed);assert.equal(h.events.filter(e=>e.kind==='press').length,0);}
 const h=helper({buttonEnabled:false});assert.equal(h.query({op:'press',roles:['AXButton'],label:'Send message',requireEnabled:true}).ok,false);assert.equal(h.events.length,0);
});
test('Send enabled readback refuses before native click and rechecks at AX action',async()=>{
 const fn=/async function press\(pid,label,roles=\['AXButton'\],extra=\{\}\)\{[\s\S]*?\n\}/.exec(source)[0],calls=[];
 const press=runInNewContext('('+fn+')',{until:async cb=>cb(),ax:(_pid,c)=>{calls.push(c.op);return c.op==='count'?{ok:true,count:1}:{ok:true,enabled:false};},record(){},check});
 await assert.rejects(press(123,'Send message'),/SEND_ENABLED/);assert.deepEqual(calls,['count','state']);assert.ok(source.includes("label==='Send message'?{requireEnabled:true}"));
});
test('one full accepted trigger passes; none waits and truncated or duplicate messages refuse',()=>{
 const fn=/function receivedTrigger\(before,after,expected\)\{[\s\S]*?\n\}/.exec(source)[0],received=runInNewContext('('+fn+')',{check});
 const old={id:'old',kind:'text',role:'user',text:'old'},fresh={id:'new',kind:'text',role:'user',text:expected};
 assert.equal(received([old],[old],expected),null);assert.deepEqual(received([old],[old,fresh],expected),fresh);
 for(const rows of [[{...fresh,text:expected.slice(4)}],[fresh,{...fresh,id:'duplicate'}]])assert.throws(()=>received([old],rows,expected),/EXACT_RECEIVED_TRIGGER/);
 const regexText=source.split('const match=')[1].split('.exec(promptText(prompt))')[0],peer=runInNewContext(regexText);assert.equal(peer.exec(expected)[1],'banner');assert.equal(peer.exec(expected.slice(4)),null);assert.ok(source.includes('B35_PHASE_MISSING'));assert.ok(source.includes('Math.max(0,startedDeadline-Date.now())'));
});
test('trigger never sends after setter refusal and preserves exact received evidence before started wait',async()=>{
 const fn=/async function trigger\(s,kind\)\{[\s\S]*?\n\}/.exec(source)[0],messages=/function triggerMessages\(value\)\{[^\n]*\}/.exec(source)[0],received=/function receivedTrigger\(before,after,expected\)\{[\s\S]*?\n\}/.exec(source)[0];
 for(const typed of [false,true]){let requests=0;const calls=[],s={pid:123,port:12345,runId:'46c70df10127cef6',control:'/owned',bots:{banner:{id:'b',threadId:'t',name:'B35'}}};
 const trigger=runInNewContext(messages+';'+received+';('+fn+')',{check,notificationObserver:null,startNotificationObserver:async options=>{assert.equal(options.port,12345);assert.equal(options.botId,'b');assert.equal(options.threadId,'t');calls.push('observer-ready');return{stop:async()=>({closed:true})};},notice:()=>({text:''}),selectBot:async(_s,k)=>calls.push('select-'+k),api:async()=>({messages:++requests===1?[]:[{id:'new',kind:'text',role:'user',text:expected}]}),ax:()=>({ok:typed}),record:label=>calls.push(label),press:async(_pid,label)=>calls.push(label==='Send message'?'send':'press-'+label),until:async(cb,_ms,label)=>{calls.push(label);const result=await cb();check(result,label);return result;},existsSync:()=>true,path:{join:(...x)=>x.join('/')},writeFileSync:()=>calls.push('release'),openPendingInbox:async()=>calls.push('open-inbox'),readPendingInbox:async()=>({settled:true,pending:calls.includes('release'),sourceLabel:'B35'}),pending:async()=>({pending:true}),triggerFailureEvidence:async()=>calls.push('diagnostics')});
 if(!typed){await assert.rejects(trigger(s,'banner'),/COMPOSER_banner/);assert.ok(!calls.includes('send'));assert.ok(!calls.includes('observer-ready'));assert.ok(calls.includes('diagnostics'));}else{await trigger(s,'banner');assert.equal(calls.filter(x=>x==='send').length,1);assert.ok(calls.indexOf('open-inbox')<calls.indexOf('observer-ready'));assert.ok(calls.indexOf('observer-ready')<calls.indexOf('release'));assert.ok(calls.includes('release'));assert.ok(calls.indexOf('received-trigger')<calls.indexOf('SYNTHETIC_STARTED_banner'));}
 }
});

// Synthetic AX tree only: these cases establish fail-closed observation semantics,
// not Chromium/macOS role mapping or a native notification outcome.
const observe=runInNewContext('('+ /function inboxObservation\(t,sourceLabel\)\{[\s\S]*?\n\}/.exec(source)[0]+')',{check,texts:t=>t.elements.flatMap(n=>[...n.names,typeof n.value==='string'?n.value:'']).filter(Boolean)});
function inboxTree({rows=[['B35 banner run · B35 banner','Approval requested','Pending','Open request']],extra=[],summary=true}={}){
 const elements=[],add=(role,names,parent=-1)=>{const n={index:elements.length,parent,role,names,value:null};elements.push(n);return n.index;};
 if(summary)add('AXStaticText',['While you were away: 1 unread on this page. '+rows.length+' matching items.']);add('AXStaticText',['Page 1 of 1']);
 for(const text of extra)add('AXStaticText',[text]);const list=add('AXList',['Inbox items']);
 for(const row of rows){const item=add('AXGroup',[],list);for(const text of row)add('AXStaticText',[text],item);}
 return{elements};
}
test('owner Inbox requires one complete settled exact source row and refuses stale or ambiguous evidence',()=>{
 const label='B35 banner run · B35 banner';
 assert.equal(observe(inboxTree(),label).pending,true);
 assert.equal(observe(inboxTree({rows:[]}),label).pending,false);
 assert.equal(observe(inboxTree({extra:['Updating Inbox…']}),label),null);
 assert.equal(observe(inboxTree({summary:false}),label),null);
 for(const text of ['Displayed items may be stale.','Inbox could not load. Use Refresh to check the current source.'])assert.throws(()=>observe(inboxTree({extra:[text]}),label),/INBOX_ERROR_OR_STALE/);
 assert.throws(()=>observe(inboxTree({rows:[[label,'Approval requested','Pending'],[label,'Approval requested','Pending']]}),label),/INBOX_AMBIGUOUS/);
 assert.throws(()=>observe(inboxTree({rows:[[label,'Approval requested','Resolved','Open request']]}),label),/INBOX_EXACT_PENDING/);
 const separate=inboxTree({rows:[[label,'Pending','Open request'],['Other','Approval requested']]});assert.throws(()=>observe(separate,label),/INBOX_EXACT_PENDING/);
 const pages=inboxTree();pages.elements.find(n=>n.names.includes('Page 1 of 1')).names=['Page 1 of 2'];assert.throws(()=>observe(pages,label),/INBOX_COMPLETE_PAGE/);
 assert.equal(observe(inboxTree({extra:['Tools, approvals may be stale']}),label).pending,true);
 assert.ok(!source.includes("api(s,'/api/inbox"));
});
test('recorded R16 fragmented AXStaticText status and page runs are observed without selector widening',()=>{
 const raw=(elements)=>({elements});
 const base=[
  {index:0,parent:-1,role:'AXApplication',names:[],value:null},
  {index:1,parent:0,role:'AXStaticText',names:[],value:'While you were away: '},
  {index:2,parent:0,role:'AXStaticText',names:[],value:'0'},
  {index:3,parent:0,role:'AXStaticText',names:[],value:' unread on this page. '},
  {index:4,parent:0,role:'AXStaticText',names:[],value:'0'},
  {index:5,parent:0,role:'AXStaticText',names:[],value:' matching items.'},
  {index:6,parent:0,role:'AXGroup',names:[],value:null},
  {index:7,parent:0,role:'AXStaticText',names:[],value:'Page '},
  {index:8,parent:0,role:'AXStaticText',names:[],value:'1'},
  {index:9,parent:0,role:'AXStaticText',names:[],value:' of '},
  {index:10,parent:0,role:'AXStaticText',names:[],value:'1'},
  {index:11,parent:0,role:'AXList',names:['Inbox items'],value:null}
 ];
 assert.equal(observe(raw(base),'B35 banner').pending,false);
 const cross=structuredClone(base);cross[4].parent=11;assert.equal(observe(raw(cross),'B35 banner'),null);
 const nonstatic=structuredClone(base);nonstatic[3].role='AXGroup';assert.equal(observe(raw(nonstatic),'B35 banner'),null);
 const nonstring=structuredClone(base);nonstring[3].value=1;assert.equal(observe(raw(nonstring),'B35 banner'),null);
});
test('pending remounts owner Inbox before every settled read and closes without opening request',async()=>{
 const fn=/async function pending\(s,kind,ms=10000\)\{[\s\S]*?\n\}/.exec(source)[0],calls=[];
 const pending=runInNewContext('('+fn+')',{openPendingInbox:async()=>calls.push('open'),until:async cb=>cb(),readPendingInbox:async()=>{calls.push('read');return{pending:false,settled:true};},press:async(_pid,label)=>calls.push(label)});
 assert.equal((await pending({pid:123},'banner')).pending,false);assert.deepEqual(calls,['open','read','Close Inbox']);
});
test('exact request card requires synthetic marker and both enabled decision controls',async()=>{
 const fn=/async function exactRequestCard\(s,kind\)\{[\s\S]*?\n\}/.exec(source)[0];
 for(const enabled of [true,false]){const controls=[];const exact=runInNewContext('('+fn+')',{until:async(cb)=>check(cb(),'marker'),texts:()=>['B35_SYNTHETIC_NO_EXECUTION_banner_run'],tree:()=>({}),state:(_pid,label)=>{controls.push(label);return{enabled};},check});if(enabled){await exact({pid:123,runId:'run'},'banner');assert.deepEqual(controls,['Deny','Allow once']);}else await assert.rejects(exact({pid:123,runId:'run'},'banner'),/REQUEST_DECISION_ENABLED/);}
});

test('Tools resolves fresh native semantic identity across pending1 to pending0 before its one action',async()=>{
 const openSource=/async function openPendingInbox\(s\)\{[\s\S]*?\n\}/.exec(source)[0];
 const pressSource=source.slice(source.indexOf('async function press(pid,label,roles='),source.indexOf('\nfunction key('));
 const h=helper();h.app.AXChildren=[h.button];h.button.AXRole='AXPopUpButton';h.button.AXTitle='Tools, 1 pending approvals, items need attention';
 const calls=[];
 const press=runInNewContext('('+pressSource+')',{check,record(){},until:async cb=>{check(await cb(),'UNIQUE');},ax:(_pid,c)=>{
  calls.push(c);const result=h.query(c);
  if(c.op==='count')h.button.AXTitle='Tools, 0 pending approvals';
  return result;
 }});
 const open=runInNewContext('('+openSource+')',{tree:()=>({elements:[{role:'AXPopUpButton',names:[h.button.AXTitle]}]}),press:async(pid,label,roles,extra)=>{if(label==='Pending approvals')return;await press(pid,label,roles,extra);}});
 await open({pid:123});assert.equal(h.events.filter(e=>e.kind==='press').length,1);
 assert.deepEqual(calls.map(c=>c.op),['count','press']);assert(calls.every(c=>c.tools===true&&c.requireEnabled===true&&c.label==='Tools'&&c.roles[0]==='AXPopUpButton'));
});
test('Tools grammar rejects unrelated, disabled and ambiguous controls before action',()=>{
 const command={op:'press',roles:['AXPopUpButton'],label:'Tools',tools:true,requireEnabled:true};
 for(const name of ['Tools','Tools, 0 pending approvals','Tools, 12 pending approvals, items need attention','Tools, approvals may be stale']){const h=helper();h.app.AXChildren=[h.button];h.button.AXRole='AXPopUpButton';h.button.AXTitle=name;assert.equal(h.query({...command,op:'count'}).enabled,true);assert.equal(h.query(command).ok,true);}
 for(const mutation of [h=>{h.button.AXTitle='Toolshed';},h=>{h.button.AXTitle='Tools, 0 pending approvals unexpected';},h=>{h.button.AXRole='AXButton';},h=>{h.button.AXEnabled=false;},h=>{h.app.AXChildren.push({...h.button});}]){
  const h=helper();h.app.AXChildren=[h.button];h.button.AXRole='AXPopUpButton';h.button.AXTitle='Tools, 0 pending approvals';mutation(h);assert.equal(h.query(command).ok,false);assert.equal(h.events.length,0);
 }
 const h=helper();h.app.AXChildren=[h.button];h.button.AXRole='AXPopUpButton';h.button.AXTitle='Tools, 0 pending approvals';h.button.AXEnabled=false;assert.equal(h.query({...command,op:'count'}).enabled,false);
 assert.equal(h.query({...command,roles:['AXButton']}).error,'AX-tools-contract');
});

function stalePressFixture(results,{readCost=100}={}){
 const fn=source.slice(source.indexOf('async function press(pid,label,roles='),source.indexOf('\nfunction key('));let clock=0,reads=0,actions=0;const calls=[],records=[];
 const press=runInNewContext('('+fn+')',{Date:{now:()=>clock},check,record:(step,value)=>records.push({step,...value}),until:async fn=>{const v=await fn();check(v,'UNIQUE');return v;},ax:(pid,cmd,options)=>{
  calls.push({pid,cmd,options});if(cmd.op==='count')return{ok:true,count:1};if(cmd.op==='state')return{ok:true,enabled:true};
  const result=results[Math.min(reads++,results.length-1)];clock+=Math.min(readCost,options.timeout);if(result.ok||result.actionAttempted===true)actions++;return result;
 }});return{press,calls,records,reads:()=>reads,actions:()=>actions,time:()=>clock};
}
test('AX helper reports whether the native press was attempted',()=>{
 const stale=helper({roleError:true}),a=stale.query({op:'press',roles:['AXButton'],label:'Send message',requireEnabled:true});assert.equal(a.error,'AX-read');assert.equal(a.code,-25202);assert.equal(a.actionAttempted,false);assert.equal(stale.events.length,0);
 const failed=helper({pressCode:-25202}),b=failed.query({op:'press',roles:['AXButton'],label:'Send message',requireEnabled:true});assert.equal(b.error,'AX-press');assert.equal(b.actionAttempted,true);assert.equal(failed.events.filter(e=>e.kind==='press').length,1);
});
test('pre-action stale read refreshes a fresh exact selector then performs only one action',async()=>{
 const f=stalePressFixture([{ok:false,error:'AX-read',code:-25202,attribute:'AXRole',actionAttempted:false},{ok:true}]);await f.press(123,'Observer');assert.equal(f.reads(),2);assert.equal(f.actions(),1);assert.equal(f.records.filter(x=>x.step==='press-preaction-refresh').length,1);assert(f.calls.every(x=>x.pid===123&&x.cmd.label==='Observer'));assert(f.calls[2].options.timeout<f.calls[1].options.timeout);
});
test('action failures or ambiguous responses are never retried',async()=>{
 for(const result of [{ok:false,error:'AX-press',code:-25202,actionAttempted:true},{ok:false,error:'AX-read',code:-25202,actionAttempted:true},{ok:false,error:'AX-read',code:-25202},{ok:false,error:'osascript',timedOut:true},{ok:false,error:'AX-read',code:-25204,actionAttempted:false}]){
  const f=stalePressFixture([result,{ok:true}]);await assert.rejects(f.press(123,'Observer'),/PRESS_Observer/);assert.equal(f.reads(),1);assert.equal(f.records.filter(x=>x.step==='press-preaction-refresh').length,0);
 }
});
test('stale-read attempt cap and original shared deadline fail without an action',async()=>{
 const stale={ok:false,error:'AX-read',code:-25202,attribute:'AXRole',actionAttempted:false};const attempts=stalePressFixture([stale]);await assert.rejects(attempts.press(123,'Observer'),/PRESS_Observer/);assert.equal(attempts.reads(),3);assert.equal(attempts.actions(),0);
 const deadline=stalePressFixture([stale],{readCost:9000});await assert.rejects(deadline.press(123,'Observer'),/PRESS_Observer/);assert.equal(deadline.time(),15000);assert.equal(deadline.reads(),2);assert.equal(deadline.actions(),0);
});
