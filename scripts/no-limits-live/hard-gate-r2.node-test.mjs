import {createRequestIndex} from './request-index.mjs';
import {declaredRequests} from './declared-requests.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeOperationEvidence,operationCompleted,availabilityEvidence} from './native-operation-evidence.mjs';
import {hashInput} from './oracle-class.mjs';
import {createNdjsonReader} from './ndjson-reader.mjs';
import {releasePlan} from './fakes/release-plan.mjs';
import {installBindings} from './bindings.mjs';
const input={command:'echo fixture'};
const start={eventId:'start',type:'item.started',itemType:'tool',provider:'fuigoAgent',providerInstanceId:'fuigo',threadId:'t',turnId:'g',itemId:'shell',toolKind:'execute',title:'echo fixture',input};
const end={...start,type:'item.completed',ok:true};
const spec={requests:[{engine:'fuigoAgent',tool:'Bash',inputHash:hashInput(input),class:'run'}]};
const receipt={taps:[{type:'request',engine:'fuigoAgent',tool:'Bash',threadId:'t',generation:'g',inputHash:hashInput(input)}]};
test('H1 permission receipt and an unrelated browser completion never prove shell execution',()=>{
 const browser={...start,itemId:'browser',toolKind:'other',title:'agent_browser_open',input:{url:'http://fixture/'}};
 for(const events of [[start],[start,browser,{...browser,type:'item.completed',ok:true}]]){
  assert.equal(nativeOperationEvidence(spec,receipt,events).count,0);
  assert.equal(operationCompleted({tool:'Bash',input},events),false);
 }
});
test('H1 exact successful completion is required even with matching permission receipts',()=>{
 for(const events of [[{...start,input:{command:'wrong'}},{...end,input:{command:'wrong'}}],[start,{...end,input:{command:'wrong'}}],[start,{...end,ok:false}],[start,{...end,turnId:'other'}],[start,end,end]]){
  assert.equal(nativeOperationEvidence(spec,receipt,events).count,0);
  assert.equal(operationCompleted({tool:'Bash',input},events),false);
 }
 assert.deepEqual(nativeOperationEvidence(spec,receipt,[start,end]),{count:1,errors:[]});
 assert.equal(operationCompleted({tool:'Bash',input},[start,end]),true);
 assert.equal(operationCompleted({tool:'Bash',input:{command:'echo fixture\r\n'}},[start,end]),true);
});
test('H3 ACP command titles and native identities bind shell input and normalized file paths',()=>{
 for(const event of [start,{...start,toolKind:undefined,title:'Bash'},{...start,toolKind:undefined,title:'a command title',toolIdentity:{name:'shell'}}]){
  assert.equal(operationCompleted({tool:'Bash',input},[event,{...event,type:'item.completed',ok:true}]),true);
 }
 const file={...start,toolKind:'edit',title:'fixture.txt',input:{path:'/work/fixture.txt',content:'fixture'}};
 assert.equal(operationCompleted({tool:'Write',input:{file_path:'./fixture.txt',content:'fixture'}},[file,{...file,type:'item.completed',ok:true}],'/work'),true);
 assert.equal(operationCompleted({tool:'Write',input:{file_path:'other.txt',content:'fixture'}},[file,{...file,type:'item.completed',ok:true}],'/work'),false);
});
test('H2 missing-input native binding sends the empty form and rejects a populated command',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r2-availability-'));
 try{
  let sent;const empty={...start,input:{}};
  const f={data:root};installBindings(f);
  const client={turn:async(_bot,text)=>{sent=text;return {threadIds:['t'],events:[]};}};
  const run=async events=>{writeFileSync(join(root,'nolim-native-events.ndjson'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');return f.workflowFixtures['unavailable-shell-missing-input']({client,bot:{},cwd:'/work',spec:{availabilityWitness:{tool:'shell',shape:'missing-input'}}});};
  assert.equal((await run([empty,{...empty,type:'item.completed',ok:true}])).proof,true);
  assert.deepEqual(releasePlan(sent).steps,[{kind:'tool',tool:'Bash',input:{}}]);
  assert.equal((await run([start,end])).proof,false);
  assert.equal(availabilityEvidence({tool:'shell',shape:'missing-input'},[empty]),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('H3 routine wake release instructions retain the peer reply marker',()=>{
 assert.equal(releasePlan('S3_DELEGATE peer').steps[0].input.message,'S3_PEER_REPLY');
 assert.equal(releasePlan('S3_PEER_REPLY').steps[0].text,'S3_PEER_REPLY');
 assert.deepEqual(releasePlan('S3_DELEGATE peer\nDelivered result: S3_PEER_REPLY').steps,[{kind:'text',text:'S3_PEER_REPLY'}]);
});
test('M1 append reader parses each row once and keeps partial UTF-8 lines until complete',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r2-log-'));try{
  const file=join(root,'log.ndjson');writeFileSync(file,'');let parsed=0;
  const read=createNdjsonReader(file,{onRow:()=>parsed++});
  appendFileSync(file,'{"threadId":"old","value":1}\n');assert.equal(read(['old']).length,1);
  for(let n=0;n<20;n++)assert.equal(read(['new']).length,0);
  assert.equal(parsed,1);
  appendFileSync(file,'{"threadId":"new",');assert.equal(read(['new']).length,0);
  appendFileSync(file,'"value":2}\n');assert.equal(read(['new']).length,1);assert.equal(parsed,2);
  writeFileSync(file,'');assert.deepEqual(read(['old']),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('H2 native empty approval input is declared only for the missing-command form',()=>{
 const missing=declaredRequests('Use exactly the Bash tool once with this input: {}. Do not substitute',{driver:'codex'},{expected:'RUN'});
 const populated=declaredRequests('Run exactly: echo fixture',{driver:'codex'},{expected:'RUN'});
 assert.ok(missing.some(r=>r.tool==='shell'&&r.inputHash===hashInput(null)));
 assert.ok(!populated.some(r=>r.inputHash===hashInput(null)));
});
test('M1 indexed registration lookup retains colon-bearing request ids and the newest matching request',()=>{
 const index=createRequestIndex(),a={type:'request',threadId:'t',providerInstanceId:'engine',requestId:'inner:r'};
 index.add(a);assert.equal(index.find('t','engine:g:inner:r'),a);
 const b={...a,requestId:'r'};index.add(b);assert.equal(index.find('t','engine:g:inner:r'),b);
 assert.equal(index.find('other','engine:g:inner:r'),undefined);
 assert.equal(index.find('t','wrong:g:inner:r'),undefined);
 index.clear();assert.equal(index.find('t','engine:g:inner:r'),undefined);
});

test('M1 final surface reads reject incomplete log rows',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r2-partial-'));try{
  const file=join(root,'log.ndjson');writeFileSync(file,'{"threadId":"t"');
  assert.throws(createNdjsonReader(file,{requireComplete:true}),/Incomplete fixture log row/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('M1 malformed log rows remain failures on repeated reads',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r2-malformed-'));try{
  const file=join(root,'log.ndjson');writeFileSync(file,'not json\n');
  const read=createNdjsonReader(file);assert.throws(read);assert.throws(read);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('M1 same-length rewrites invalidate cached rows beyond the suffix checkpoint',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r2-rewrite-'));try{
  const file=join(root,'log.ndjson'),row={threadId:'t',value:'original',padding:'x'.repeat(600)};
  writeFileSync(file,JSON.stringify(row)+'\n');const read=createNdjsonReader(file);
  assert.equal(read(['t'])[0].value,'original');
  writeFileSync(file,JSON.stringify({...row,value:'modified'})+'\n');
  assert.equal(read(['t'])[0].value,'modified');
 }finally{rmSync(root,{recursive:true,force:true});}
});
