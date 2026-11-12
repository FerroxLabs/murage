const {test}=process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {readSurfaces,schemaPin,QUEUE_STORES,ELECTRON_ENDPOINT} from './readers.mjs';
import {observe} from './observe.mjs';
// DDL copied from r3 §3.1 and BASE messages schema, never imported from the candidate.
const approvals=`CREATE TABLE approval_records(id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, service TEXT, thread_id TEXT NOT NULL,request_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation TEXT, actor_kind TEXT NOT NULL, actor_via TEXT NOT NULL,level TEXT NOT NULL, why TEXT NOT NULL CHECK(why IN('deny','wipe','base','question','legacy')), evidence TEXT NOT NULL,registration_hash TEXT NOT NULL, deny_rev TEXT NOT NULL, chat_message_id TEXT NOT NULL, queue_kind TEXT, queue_ref TEXT,state TEXT NOT NULL CHECK(state IN('open','answered','expired','cancelled','superseded')), answer TEXT,created_at INTEGER NOT NULL, settled_at INTEGER);CREATE UNIQUE INDEX approval_open_request ON approval_records(source_kind, thread_id, request_id) WHERE state='open';`;
async function fixture(run){const dir=mkdtempSync(join(tmpdir(),'surface-readers-'));mkdirSync(join(dir,'browser-extension'));mkdirSync(join(dir,'skill-state','b'),{recursive:true});const db=new DatabaseSync(join(dir,'messages.db'));
 db.exec(`CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));${approvals}`);
 db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('t','m',1,'bot','secret',null,JSON.stringify({kind:'secret'}));
 db.exec(`CREATE TABLE email_sends(send_id TEXT,thread_id TEXT,state TEXT,approval_id TEXT);CREATE TABLE room_shares(id TEXT,status TEXT);CREATE TABLE memory_records(id TEXT,state TEXT);CREATE TABLE image_operations(id TEXT,state TEXT);`);
 writeFileSync(join(dir,'bots.json'),JSON.stringify([{id:'b',connectedAppAccess:{requests:[]}}]));
 writeFileSync(join(dir,'config.json'),JSON.stringify({mcpServers:{}}));
 writeFileSync(join(dir,'browser-extension/approvals.json'),JSON.stringify({version:1,records:[]}));
 writeFileSync(join(dir,'skill-state/b/staged.json'),JSON.stringify({writes:{}}));
 for(const file of ['channel-mirror-outbox.ndjson','nolim-protocol.ndjson','nolim-registrations.ndjson'])writeFileSync(join(dir,file),'');
 let absent=false;const server=createServer((req,res)=>{assert.equal(req.url,ELECTRON_ENDPOINT);res.writeHead(absent?404:200,{'content-type':'application/json'});res.end(JSON.stringify({open:[]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run({dir,db,missingEndpoint:()=>{absent=true;},read:()=>readSurfaces({dataDir:dir,url:`http://127.0.0.1:${server.address().port}`})});}finally{db.close();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}}
test('Q2 independent correct snapshot passes and pins both column lists',async()=>fixture(async f=>{const s=await f.read();assert.equal(s.readerSchemaPin,schemaPin);assert.equal(observe({},s).verdict,'PASS');assert.equal(s.messages.length,1);assert.match(schemaPin,/^[a-f0-9]{64}$/);assert.equal(readFileSync(new URL('./reader-schema.sha256',import.meta.url),'utf8').trim(),schemaPin);}));
for(const table of ['messages','approval_records'])test(`Q2/M90 missing ${table} fails closed`,async()=>fixture(async f=>{f.db.exec(`DROP TABLE ${table}`);const s=await f.read();assert.equal(observe({},s).verdict,'FAIL');assert.ok(s.errors.includes(`missing surface: ${table==='approval_records'?'records':'messages'}`));}));
const stores={email:['table','email_sends'],'bot-access':['file','bots.json'],phones:['table','messages'],'room-shares':['table','room_shares'],memory:['table','memory_records'],'browser-extension':['file','browser-extension/approvals.json'],'host-computer':['table','messages'],peer:['table','messages'],'event-limit':['table','messages'],image:['table','image_operations'],routine:['table','messages'],'mcp-bot':['file','config.json'],publish:['table','messages'],skill:['file','skill-state/b/staged.json']};
for(const name of QUEUE_STORES)test(`Q2 missing queue ${name} fails`,async()=>fixture(async f=>{const [kind,path]=stores[name];if(kind==='table')f.db.exec(`DROP TABLE ${path}`);else rmSync(join(f.dir,path));const s=await f.read();assert.equal(observe({},s).verdict,'FAIL');assert.ok(s.errors.includes(`missing surface: queues:${name}`));}));
test('BLOCK2 actual persisted queues read without a supplied manifest',async()=>fixture(async f=>{
 f.db.prepare('INSERT INTO email_sends VALUES(?,?,?,?)').run('send','t','awaiting_owner','email-approval');
 f.db.prepare('INSERT INTO room_shares VALUES(?,?)').run('share','pending');
 f.db.prepare('INSERT INTO memory_records VALUES(?,?)').run('memory','candidate');
 f.db.prepare('INSERT INTO image_operations VALUES(?,?)').run('image','awaiting');
 writeFileSync(join(f.dir,'bots.json'),JSON.stringify([{id:'b',connectedAppAccess:{requests:[{id:'access'}]}}]));
 writeFileSync(join(f.dir,'config.json'),JSON.stringify({mcpServers:{fixture:{command:'fixture-mcp',args:[],env:{},enabled:false,rev:'abcdef012345',pendingEnv:['KEY']}}}));
 writeFileSync(join(f.dir,'browser-extension/approvals.json'),JSON.stringify({version:1,records:[{requestId:'browser',status:'waiting'}]}));
 writeFileSync(join(f.dir,'skill-state/b/staged.json'),JSON.stringify({writes:{skill:{id:'skill'}}}));
 const s=await f.read();assert.equal(s.complete,true,JSON.stringify(s.errors));
 for(const name of ['email','bot-access','room-shares','memory','browser-extension','image','mcp-bot','skill'])assert.ok(s.queues.some(r=>r.queueKind===name),name);
 assert.equal(s.queues.find(r=>r.queueKind==='email').approvalId,'email-approval');
 assert.equal(s.queues.find(r=>r.queueKind==='browser-extension').requestId,'browser');
}));
test('BLOCK2 corrupt browser wrapper fails instead of becoming empty',async()=>fixture(async f=>{writeFileSync(join(f.dir,'browser-extension/approvals.json'),JSON.stringify({version:2,records:[]}));const s=await f.read();assert.ok(s.errors.includes('missing surface: queues:browser-extension'));}));
for(const [name,file] of [['mirrors','channel-mirror-outbox.ndjson'],['taps','nolim-protocol.ndjson'],['registrations','nolim-registrations.ndjson']])test(`Q2 missing ${name} fails`,async()=>fixture(async f=>{rmSync(join(f.dir,file));const s=await f.read();assert.equal(observe({},s).verdict,'FAIL');assert.ok(s.errors.includes(`missing surface: ${name}`));}));
test('Q2 missing Electron black-box endpoint fails',async()=>fixture(async f=>{f.missingEndpoint();const s=await f.read();assert.equal(observe({},s).verdict,'FAIL');assert.ok(s.errors.includes('missing surface: electron'));}));
test('BLOCK2 durable message-backed queues expose their actual pending cards',async()=>fixture(async f=>{
 const tools={phones:'phone_calendar_add','host-computer':'local_computer_consent',peer:'ask_bot','event-limit':'more_handoffs',routine:'schedule_routine',publish:'publish_site'};
 for(const [name,tool] of Object.entries(tools)){
  f.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('t',name,1,'bot','options',null,JSON.stringify({kind:'options',card:{requestId:name,tool,approvalId:`approval-${name}`}}));
  f.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('t',name+'-answered',1,'bot','options',null,JSON.stringify({kind:'options',card:{requestId:name+'-closed',tool,answered:'deny'}}));
 }
 const s=await f.read();assert.equal(s.complete,true);
 for(const name of Object.keys(tools))assert.deepEqual(s.queues.filter(r=>r.queueKind===name).map(r=>[r.requestId,r.approvalId]),[[name,`approval-${name}`]]);
}));
test('BLOCK2 disabled bot-filed MCP entries need review even without credential slots',async()=>fixture(async f=>{
 writeFileSync(join(f.dir,'config.json'),JSON.stringify({mcpServers:{keyless:{command:'fixture-mcp',args:[],env:{},enabled:false,rev:'abcdef012345'},header:{url:'https://fixture.invalid/mcp',auth:'header',headers:{},pendingHeaders:['X-Fixture'],enabled:false,rev:'abcdef012346'},owner:{command:'fixture-owner',args:[],env:{},enabled:false}}}));
 const s=await f.read();assert.deepEqual(s.queues.filter(r=>r.queueKind==='mcp-bot').map(r=>r.serverName).sort(),['header','keyless']);
}));
test('BLOCK2 browser queue references bind to the independent ledger without invented fields',async()=>fixture(async f=>{
 writeFileSync(join(f.dir,'browser-extension/approvals.json'),JSON.stringify({version:1,records:[{requestId:'browser-ref',threadId:'t',messageId:'browser-message',status:'waiting'}]}));
 f.db.prepare(`INSERT INTO approval_records(id,source_kind,thread_id,request_id,bot_id,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,chat_message_id,queue_kind,queue_ref,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('browser-approval','queue','t','browser-ref','b','owner','desktop','ask','base','[]','fixture','0','browser-message','browser-extension','browser-ref','open',1);
 const s=await f.read();assert.equal(s.complete,true);assert.equal(s.queues.find(r=>r.queueKind==='browser-extension').approvalId,'browser-approval');
}));
