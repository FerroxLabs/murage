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
  AXUIElementCopyAttributeValue:(e,k,r)=>{if(set&&e===field&&k==='AXValue'){if(options.readError)return -25204;r[0]=++reads<=(options.delayReads??0)?'':Object.hasOwn(options,'readback')?options.readback:field.AXValue;return 0;}if(!Object.hasOwn(e,k))return -25205;r[0]=e[k];return 0;},
  AXUIElementCopyActionNames:(_e,r)=>{r[0]=['AXPress'];return 0;},AXUIElementIsAttributeSettable:(_e,_k,r)=>{r[0]=options.settable??true;return options.settableCode??0;},
  AXUIElementSetAttributeValue:(e,k,v)=>{events.push({kind:'set',value:v});set=true;e[k]=v;return options.setCode??0;},AXUIElementPerformAction:()=>{events.push({kind:'press'});return 0;}});
 const run=runInNewContext(jxa+';run',{Application:()=>({processes:{whose:()=>[{}]},keystroke:()=>assert.fail('no keyboard fallback')}),ObjC:{import(){},bindFunction(){},deepUnwrap:x=>x},$:dollar,Ref:()=>[],Date:{now:()=>clock},delay:()=>{clock+=1000;}});
 return{events,query:c=>JSON.parse(run([JSON.stringify({pid:123,roles:['AXTextArea','AXTextField'],label:'Message B35',...c})]))};
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
 for(const typed of [false,true]){let requests=0;const calls=[],s={pid:123,runId:'46c70df10127cef6',control:'/owned',bots:{banner:{id:'b',threadId:'t',name:'B35'}}};
 const trigger=runInNewContext(messages+';'+received+';('+fn+')',{check,notice:()=>({text:''}),selectBot:async(_s,k)=>calls.push('select-'+k),api:async()=>({messages:++requests===1?[]:[{id:'new',kind:'text',role:'user',text:expected}]}),ax:()=>({ok:typed}),record:label=>calls.push(label),press:async(_pid,label)=>calls.push(label==='Send message'?'send':'press-'+label),until:async(cb,_ms,label)=>{calls.push(label);const result=await cb();check(result,label);return result;},existsSync:()=>true,path:{join:(...x)=>x.join('/')},writeFileSync:()=>calls.push('release'),openPendingInbox:async()=>calls.push('open-inbox'),readPendingInbox:async()=>({settled:true,pending:calls.includes('release'),sourceLabel:'B35'}),pending:async()=>({pending:true}),triggerFailureEvidence:async()=>calls.push('diagnostics')});
 if(!typed){await assert.rejects(trigger(s,'banner'),/COMPOSER_banner/);assert.ok(!calls.includes('send'));assert.ok(calls.includes('diagnostics'));}else{await trigger(s,'banner');assert.equal(calls.filter(x=>x==='send').length,1);assert.ok(calls.indexOf('open-inbox')<calls.indexOf('release'));assert.ok(calls.includes('release'));assert.ok(calls.indexOf('received-trigger')<calls.indexOf('SYNTHETIC_STARTED_banner'));}
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

test('recorded B35 R15 Tools popup keeps exact native role through selector and press',async()=>{
 const fn=/async function openPendingInbox\(s\)\{[\s\S]*?\n\}/.exec(source)[0];
 // Exact tools-selector.ax.json row 70 from native run B35 R15.
 const recorded={index:70,parent:69,role:'AXPopUpButton',names:['Tools, 0 pending approvals'],value:''};
 const calls=[];
 const run=elements=>runInNewContext('('+fn+')',{tree:()=>({elements}),check,press:async(pid,label,roles=['AXButton'],extra={})=>calls.push({pid,label,roles:Array.from(roles),extra:JSON.parse(JSON.stringify(extra))})});
 await run([recorded])({pid:123});
 assert.deepEqual(calls,[{pid:123,label:'Tools, 0 pending approvals',roles:['AXPopUpButton'],extra:{}},{pid:123,label:'Pending approvals',roles:['AXMenuItem'],extra:{prefix:true}}]);
 for(const elements of [[],[recorded,{...recorded,index:71}],[{...recorded,role:'AXButton'}],[{...recorded,names:['Other tools']}],[{...recorded,names:['Toolshed']}]]){const before=calls.length;await assert.rejects(run(elements)({pid:123}),/TOOLS_UNIQUE/);assert.equal(calls.length,before);}
});
