// Owners: recall-s1s2g owns proof and room consumers; warm-keep owns retained identity.
import {expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {proofWorld} from './session-proof-world.ts';
for(const engine of ['claude','acp'] as const)for(const change of ['scope','withheld','withheld-generated','missing-receipt','missing-lineage'] as const)it(`T-G room ${engine} ${change}: replay keeps allowed context and refuses the old session`,async()=>{
 const patchHook=`
  process.env.FAKE_CLAUDE_MENTION_MARKER='__fixture_source_reply__';process.env.FAKE_CLAUDE_MENTION_REPLY='The fixture greenhouse marker is violet.';
  process.env.FAKE_ACP_MENTION_MARKER='__fixture_source_reply__';process.env.FAKE_ACP_MENTION_REPLY='The fixture greenhouse marker is violet.';
  const {registerHooks:patchHooks}=await import('node:module');
  patchHooks({load(url,ctx,next){const r=next(url,ctx);let s=String(r.source);
   if(url.endsWith('/server/index.ts')) {
    // MAIN RULING 1115-RECALL-S1S2H-ITEMS A: create generated evidence through the real lineage writer.
    const setup=\`if(req.url?.startsWith('/fixture/generated-record?')){void(async()=>{try{
     const params=new URL(req.url,'http://fixture').searchParams,threadId=params.get('thread'),botId=params.get('bot'),sourceId=params.get('source');
     const source=database().prepare('SELECT s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?').get(sourceId);
     if(!source)throw new Error('fixture generated source missing');
     const registry=new InternalCapabilities();registry.begin(botId,threadId,'fixture-record',threadHumanPrincipal(threadId));
     const token=registry.mint({botId,threadId,generation:'fixture-record',kind:'memory',depth:0,skillAuthoring:false,humanPrincipal:threadHumanPrincipal(threadId)});
     const access=await new RecallReadiness().access(()=>memoryAccess(registry,registry.resolve('Bearer '+token),()=>store),new AbortController().signal);
     const {saveMemoryCandidate}=await import('./memory/authority.ts');
     const id=saveMemoryCandidate('The fixture greenhouse marker is violet.',[{sourceId,revision:Number(source.revision),startByte:0,endByte:Buffer.byteLength(JSON.parse(String(source.payload)).text)}],'fixture-generated-reference',access);
     database().prepare("UPDATE memory_records SET state='active',owner_pinned=1 WHERE id=?").run(id);
     registry.revokeAll();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id}));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));}})();return;}\`;
    s=s.replace('const server = createServer((req, res) => {','const server = createServer((req, res) => {'+setup);
    const needle='const access=await admittedRecallAccess(recallReadiness,bot.id,threadId,internalGeneration,memoryRedispatch>0&&memoryCause==="changed");';
    s=s.replace(needle,needle+\`const patchFile=join(DATA_DIR,'fixture-withhold');if(existsSync(patchFile)){const patch=JSON.parse(readFileSync(patchFile,'utf8'));store.patchMessage(patch.threadId,patch.id,{withheldFromBots:true});unlinkSync(patchFile);}\`);
   }return {...r,source:s};}});
 `;
 const w=await proofWorld(engine,'none',patchHook);try{
  const bot=await w.bot();
  const {group:room}=await w.api('POST','/api/groups',{name:'Fixture room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}});
  let recordId='fixture-room-record';
  const send=async(text:string)=>{const count=async()=>(await w.api('GET',`/api/threads/${room.threadId}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text'&&m.text).length;const before=await count();await w.api('POST',`/api/groups/${room.id}/messages`,{text});await expect.poll(count,{timeout:45000}).toBe(before+1).catch(error=>{console.error('fixture room blocked '+JSON.stringify(w.read(db=>({views:db.prepare('SELECT view_id,generation,state,scope_count FROM memory_recall_views').all(),pins:db.prepare("SELECT view_id,generation,record_id,state FROM memory_recall_view_records WHERE record_id=?").all(recordId),sourceLines:db.prepare('SELECT message_id,mem_lsn,footprint FROM memory_line_lineage WHERE thread_no=(SELECT no FROM memory_thread_no WHERE thread_id=?)').all(sourceThread)}))));throw error;});await expect.poll(async()=>(await w.api('GET','/api/bots?messages=0')).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:15000}).not.toBe(true);};
  // MAIN RULING 1115-RECALL-S1S2H-ITEMS A: retain the owner-source witness and add another room's generated reply.
  let sourceThread=bot.threadId;
  if(change==='withheld-generated') {
   const {group:other}=await w.api('POST','/api/groups',{name:'Fixture source room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}});
   sourceThread=other.threadId;
   const scopes=w.read(db=>db.prepare("SELECT id FROM memory_scopes WHERE (kind='room' AND owner_key=?) OR (kind='conversation' AND owner_key=?)").all(other.id,other.threadId));expect(scopes).toHaveLength(2);
   for(const scope of scopes)await w.api('POST','/api/memory/action',{action:'bind',scopeId:scope.id,subjectType:'room',subjectId:room.id});
   const before=(await w.api('GET',`/api/threads/${sourceThread}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').length;
   await w.api('POST',`/api/groups/${other.id}/messages`,{text:'__fixture_source_reply__'});
   await expect.poll(async()=>(await w.api('GET',`/api/threads/${sourceThread}/messages?limit=100`)).messages.filter((m:any)=>m.role==='bot'&&m.kind==='text').length,{timeout:45000}).toBe(before+1);
   await expect.poll(async()=>(await w.api('GET','/api/bots?messages=0')).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:15000}).not.toBe(true);
  } else await w.acceptedTurn(bot,'The fixture greenhouse marker is violet.');
  const source=w.read(db=>db.prepare("SELECT s.id,s.scope_id,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.thread_id=? AND s.speaker=? AND s.kind='text' AND json_extract(v.payload,'$.text') LIKE '%greenhouse marker is violet%' ORDER BY s.rowid LIMIT 1").get(sourceThread,change==='withheld-generated'?bot.id:'owner'));expect(source).toBeTruthy();
  // MAIN RULING 1115-RECALL-S1S2H-ITEMS A: preserve the owner-source setup and all recall assertions; generated records inherit real evidence edges.
  if(change==='withheld-generated')recordId=(await w.api('POST',`/fixture/generated-record?thread=${room.threadId}&bot=${bot.id}&source=${encodeURIComponent(String(source!.id))}`)).id;
  else w.write(db=>{db.prepare("INSERT INTO memory_records VALUES('fixture-room-record',1,?,'constraint','The fixture greenhouse marker is violet.','owner-statement','active',1,1,NULL,NULL,1)").run(source!.scope_id);db.prepare("INSERT INTO memory_evidence VALUES('fixture-room-record',1,?,?,0,?)").run(source!.id,source!.revision,Buffer.byteLength(JSON.parse(String(source!.payload)).text));});
  await send('Keep the ordinary room context. What is the greenhouse marker?');const old=w.session(room.threadId);expect(old).toBeTruthy();
  expect(w.read(db=>db.prepare("SELECT 1 FROM memory_disclosures WHERE thread_id=? AND native_session=? AND record_versions LIKE ?").get(room.threadId,old,'%'+recordId+'%'))).toBeTruthy();
  // Establish a durable successful checkpoint before changing old context.
  await send('Keep the second allowed room line and the greenhouse marker.');expect(w.session(room.threadId)).toBe(old);
  const at=w.log().length;
  if(change==='scope') {
    await w.api('POST','/api/memory/action',{action:'configure',excludedThreadIds:[bot.threadId]});
    // MAIN RULING 1115-RECALL-R4 (GrokBuild)
    // Real configure/revoke owns the denial ledgers and the delivered receipt.

  }
  if(change==='withheld'||change==='withheld-generated'){const message=w.read(db=>db.prepare('SELECT message_id FROM memory_sources WHERE id=?').get(source!.id));writeFileSync(join(w.fixture.info.dataDir,'fixture-withhold'),JSON.stringify({threadId:sourceThread,id:message!.message_id}));}
  if(change==='missing-receipt')w.write(db=>db.prepare('DELETE FROM memory_disclosures WHERE thread_id=? AND native_session=?').run(room.threadId,old));
  if(change==='missing-lineage')w.write(db=>db.prepare('DELETE FROM memory_session_lineage WHERE thread_id=? AND native_session=?').run(room.threadId,old));
  await send('Continue with allowed room context.');expect(w.session(room.threadId)).not.toBe(old);
  const resets=w.log().slice(at).split('\n').filter(l=>l.includes('memory continuation reset'));expect(resets).toHaveLength(1);
  expect(resets[0]).toMatch(({scope:/scope-left-view|writetime-deny-session/,withheld:/changed:line|writetime-/,'withheld-generated':/changed:line|writetime-/, 'missing-receipt':/no-receipts/,'missing-lineage':/no-session-lineage/})[change]);
  const dump=engine==='claude'?await import('node:fs').then(fs=>fs.readFileSync(w.fixture.fixtureDumpLogPath,'utf8')):JSON.stringify(w.rpc().filter(r=>r.method==='session/prompt'));
  expect(dump).toContain('ordinary room context');
  const lastPrompt=engine==='claude'?JSON.parse(dump.trim().split('\n').at(-1)!).prompt:JSON.stringify(w.rpc().filter(r=>r.method==='session/prompt').at(-1));
  if(change==='scope'||change==='withheld'||change==='withheld-generated')expect(lastPrompt).not.toContain('greenhouse marker is violet');
 }finally{await w.fixture.close();}
},180000);

for(const engine of ['claude','acp'] as const)for(const size of [300,3000])it(`T-LONG ${engine} ${size}: fifty captured room turns and every adapter proof stay bounded`,async()=>{
 const instrumentation=`
  const {registerHooks:proofHooks}=await import('node:module');
  proofHooks({load(url,ctx,next){const r=next(url,ctx);let s=String(r.source);
   if(url.endsWith('/server/memory/session-proof.ts')) {
    s=s.replace('export function proveRetainedSession(', 'function fixtureProof(');
    s+='\\nexport function proveRetainedSession(...args:Parameters<typeof fixtureProof>){const result=fixtureProof(...args);console.warn("fixture proof meter "+JSON.stringify(sessionProofMeter()));if(result.kind==="fresh"&&result.reason==="changed:record"){const k=args[1];console.warn("fixture changed cited records "+JSON.stringify(database().prepare("SELECT DISTINCT r.id,r.kind FROM memory_session_check_cites c JOIN memory_records r ON r.id=c.ref_id JOIN memory_session_change_log l ON l.id=?||r.id JOIN memory_session_checks p ON p.thread_id=c.thread_id AND p.driver_instance=c.driver_instance AND p.native_session=c.native_session WHERE c.thread_id=? AND c.driver_instance=? AND c.native_session=? AND l.seq>p.log_seq").all("record:",k.threadId,k.driverInstance,k.nativeSession)));}return result;}';
   }
   if(url.endsWith('/server/memory/bundle.ts'))s+="\\nexport function fixtureCloneBundle(bundle){assertMemoryBundle(bundle,bundles.get(bundle).access);const next=Object.freeze({...bundle,bundleId:randomUUID()});bundles.set(next,bundles.get(bundle));bundleCheckedAt.set(next,bundleCheckedAt.get(bundle));return next;}";
   if(url.endsWith('/server/index.ts')) {
    // MAIN RULING 1115-RECALL-S1S2H-ITEMS B: prepare history outside every provider reply deadline.
    const setup=\`if(req.url?.startsWith('/fixture/seed-long?')){void(async()=>{try{
     const params=new URL(req.url,'http://fixture').searchParams,threadId=params.get('thread'),botId=params.get('bot');
     const session=database().prepare('SELECT native_session FROM memory_disclosures WHERE thread_id=? AND native_session IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(threadId)?.native_session;
     if(!session)throw new Error('fixture retained session missing');
     const registry=new InternalCapabilities();registry.begin(botId,threadId,'fixture-setup',threadHumanPrincipal(threadId));
     const token=registry.mint({botId,threadId,generation:'fixture-setup',kind:'memory',depth:0,skillAuthoring:false,humanPrincipal:threadHumanPrincipal(threadId)});
     const access=await new RecallReadiness().access(()=>memoryAccess(registry,registry.resolve('Bearer '+token),()=>store),new AbortController().signal);
     const instance={instanceId:'verification'};
     const disclosure=await import('./memory/disclosures.ts');
     const {captureSource:fixtureCapture}=await import('./memory/capture.ts');
     const {saveMemoryCandidate:fixtureCandidate}=await import('./memory/authority.ts');
     const fixtureRecords=[];
     for(let n=0;n<20;n++){
      const words='Retained fixture reference '+n;
      const message=store.appendMessage(threadId,{role:'user',kind:'text',text:words});
      const source='message:'+threadId+':'+message.id;
      fixtureCapture(database(),{id:source,threadId,messageId:message.id,kind:'text',speaker:'owner',outcome:'recorded',text:words});
      const revision=Number(database().prepare('SELECT revision FROM memory_sources WHERE id=?').get(source)?.revision);
      if(!revision)throw new Error('fixture capture missing');
      const record=fixtureCandidate(words,[{sourceId:source,revision,startByte:0,endByte:Buffer.byteLength(words)}],'fixture-reference-'+n,access);
      database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);fixtureRecords.push(record);
     }
     const fixtureFrames=[];
     for(const record of fixtureRecords){
      const frame=await buildMemoryBundle('Retained fixture reference',access,{async search(){return {hits:[{id:record,version:1,score:1,lexical:true}],vectorRows:0};}},{allowance:LineageAllowance.tool()});
      if(!frame.recordVersions.some(ref=>ref.id===record))throw new Error('fixture reference was not recalled');fixtureFrames.push(frame);
     }
     const {fixtureCloneBundle}=await import('./memory/bundle.ts');
     // Producer owner: recall-fix-c. Consumer owner: recall-fix-c (bounded room-history witness).
     // Historical turns publish bounded receipt batches and advance their real
     // reader checkpoint between batches, before the measured provider turns.
     const proof=await import('./memory/session-proof.ts');
     for(let offset=0;offset<${size};offset+=32){
      for(let n=offset;n<Math.min(offset+32,${size});n++){
       const frame=fixtureCloneBundle(fixtureFrames[n%20]);
       disclosure.prepareMemoryDisclosure(frame,access,instance.instanceId);disclosure.bindMemoryDisclosureSession(frame.bundleId,session);disclosure.deliverMemoryDisclosure(frame.bundleId,access);
      }
      proof.seedSessionChecksSlice(access);proof.seedSessionChecksSlice(access);
      await new Promise(resolve=>setImmediate(resolve));
     }
     registry.revokeAll();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));}})();return;}\`;
    s=s.replace('const server = createServer((req, res) => {','const server = createServer((req, res) => {'+setup);
   }
   return {...r,source:s};}});
 `;
 const w=await proofWorld(engine,'none',instrumentation);try{
  const bot=await w.bot();const {group:room}=await w.api('POST','/api/groups',{name:'Fixture long room',memberIds:[bot.id],setup:{bulletin:'',defaultResponder:{kind:'member',botId:bot.id}}});
  const send=async(text:string)=>{const count=async()=>w.read(db=>Number(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=? AND role='bot' AND kind='text' AND text!=''").get(room.threadId)!.n));const before=await count();await w.api('POST',`/api/groups/${room.id}/messages`,{text});await expect.poll(count,{timeout:45000}).toBe(before+1);await expect.poll(async()=>(await w.api('GET','/api/bots?messages=0')).bots.find((b:any)=>b.id===bot.id)?.busy,{timeout:15000}).not.toBe(true);};
  await send('Establish the long fixture session.');const old=w.session(room.threadId);
  await w.api('POST',`/fixture/seed-long?thread=${room.threadId}&bot=${bot.id}`);expect(w.session(room.threadId)).toBe(old);
  expect(w.read(db=>Number(db.prepare('SELECT count(*) AS n FROM memory_disclosures WHERE thread_id=? AND native_session=?').get(room.threadId,old)!.n))).toBeGreaterThanOrEqual(size);
  const start=w.log().length;
  for(let n=0;n<50;n++){
   const before=w.read(db=>Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(room.threadId)!.n));
   const at=w.log().length;await send(`Captured long fixture turn ${n+1}.`);expect(w.session(room.threadId)).toBe(old);
   expect(w.read(db=>Number(db.prepare('SELECT count(*) AS n FROM memory_sources WHERE thread_id=?').get(room.threadId)!.n))).toBeGreaterThan(before);
   const meters=w.log().slice(at).split('\n').filter(l=>l.startsWith('fixture proof meter ')).map(l=>JSON.parse(l.slice('fixture proof meter '.length)));
   expect(meters.length).toBeGreaterThan(1);for(const meter of meters)expect(meter.rows+meter.seeks).toBeLessThanOrEqual(200);
  }
  expect(w.log().slice(start)).not.toContain('memory continuation reset');
 }finally{await w.fixture.close();}
},480000);
