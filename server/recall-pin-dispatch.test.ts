// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: c3-memory-side (pins); consumer owner: recall-s1s2 (provider and notice regressions).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';

const cases=['lag-one','lag-600','overflow-current','overflow-lag','missing-index','out-of-view-static','out-of-view','identity-room','capacity','new-omission','exhausted','checking','long','many','cold-evidence','pin-before-submit','unrelated-commit','pin-after-write','forgotten','accounting'] as const;
for(const scenario of cases) for(const venue of (scenario==='out-of-view'?['bot','channel']:scenario==='identity-room'?['channel']:['bot']) as Array<'bot'|'channel'>) it(`S2 ${scenario} ${venue}: assert provider fields, turns and delivered notices`,async()=>{
 const instrumentationSource=`
  const {registerHooks}=await import('node:module');
  globalThis.fixtureScenario=${JSON.stringify(scenario)};
  registerHooks({load(url,context,next){
   const result=next(url,context);let text=String(result.source);
   if(url.endsWith('/server/memory/recall-view.ts')) {
    const needle='export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster): Held {';
    text=text.replace(needle,needle+\`try{const current=cache(database(),roster).get(recallContextKey(binding));if(!current)throw Error('cold');assertRecallView(database(),current.handle,binding);}catch{prepareRecallContextSync(binding.botId,binding.threadId,roster,binding.notOwnerAudience);}\`);
   }
   if(url.endsWith('/server/memory/bundle.ts')) {
    text=text.replace('  const pinAt = pinStamp();',\`
     globalThis.fixturePinAllowance=allowance;
     if(globalThis.fixtureScenario==='overflow-current'&&!globalThis.fixturePinSeeded){
      const seeded=db.prepare("SELECT scope_id FROM memory_records WHERE id='fixture-pin' AND version=1").get();
      if(seeded){globalThis.fixturePinSeeded=true;globalThis.fixturePinScope=String(seeded.scope_id);}
     }
     if(!globalThis.fixturePinSeeded) {
      globalThis.fixturePinSeeded=true;
      const scope=String(db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 LIMIT 1').get(access.view.viewId,access.view.generation).scope_id);
      globalThis.fixturePinScope=scope;
      const put=(id,words='Fixture mandatory marker',where=scope)=>db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',1,1,NULL,NULL,1)").run(id,where,words);
      put('fixture-pin');
      if(['overflow-current','overflow-lag'].includes(globalThis.fixtureScenario))for(let n=0;n<2048;n++)put('fixture-extra-'+n);
      if(['capacity','new-omission','accounting'].includes(globalThis.fixtureScenario))put('fixture-zlarge','Fixture capacity '.repeat(6000));
      if(['out-of-view','out-of-view-static'].includes(globalThis.fixtureScenario)){
       if(globalThis.fixtureScenario==='out-of-view')db.prepare("INSERT INTO memory_scopes VALUES('fixture-private-scope','conversation','fixture-private','{}',0)").run();
       put('fixture-private','Fixture secret must stay private','fixture-private-scope');
       // Publish under the new authority epoch before observing text reads.
       if(globalThis.fixtureScenario==='out-of-view')globalThis.fixturePrepare(access.botId,access.threadId,globalThis.fixtureRoster);
      }
      if(globalThis.fixtureScenario==='identity-room')db.prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='fixture-pin'").run();
      if(['long','many','accounting'].includes(globalThis.fixtureScenario)){
       if(globalThis.fixtureScenario==='accounting')put('fixture-withheld');
       const root=globalThis.fixtureScenario==='accounting'?'fixture-withheld':'fixture-pin';
       if(globalThis.fixtureScenario!=='many')for(let n=0;n<66;n++){
        put('fixture-parent-'+n);db.prepare("UPDATE memory_records SET owner_pinned=0 WHERE id=?").run('fixture-parent-'+n);
        db.prepare('INSERT INTO memory_derivations VALUES(?,1,?,1)').run('fixture-parent-'+n,n?'fixture-parent-'+(n-1):root);
       }
       else for(let n=0;n<257;n++){
        globalThis.fixtureAnchor(db,access.threadId,'fixture-message-'+n,'Fixture evidence');globalThis.fixtureCapture(db,{id:'fixture-source-'+n,threadId:access.threadId,messageId:'fixture-message-'+n,kind:'text',speaker:'owner',outcome:'recorded',text:'Fixture evidence'});
        db.prepare("INSERT INTO memory_evidence VALUES('fixture-pin',1,?,1,0,7)").run('fixture-source-'+n);
       }
      }
      if(globalThis.fixtureScenario==='cold-evidence')for(let n=0;n<8;n++){
       globalThis.fixtureAnchor(db,access.threadId,'fixture-message-'+n,'Fixture evidence');globalThis.fixtureCapture(db,{id:'fixture-source-'+n,threadId:access.threadId,messageId:'fixture-message-'+n,kind:'text',speaker:'owner',outcome:'recorded',text:'Fixture evidence'});
       db.prepare("INSERT INTO memory_evidence VALUES('fixture-pin',1,?,1,0,7)").run('fixture-source-'+n);
      }
      if(['forgotten','accounting'].includes(globalThis.fixtureScenario)){
       if(globalThis.fixtureScenario==='accounting')put('fixture-forgotten');
       db.prepare("INSERT INTO memory_tombstones VALUES('fixture-tombstone','record',?,1,NULL,0,'owner-forget',1)").run(globalThis.fixtureScenario==='accounting'?'fixture-forgotten':'fixture-pin');
      }
     }
     globalThis.fixtureStop();
     if(['lag-one','lag-600'].includes(globalThis.fixtureScenario))for(let n=0;n<(globalThis.fixtureScenario==='lag-one'?1:600);n++)globalThis.fixtureCapture(db,{id:'fixture-lag-'+n,threadId:access.threadId,kind:'text',speaker:'owner',outcome:'recorded',text:'Fixture capture '+n});
     if(globalThis.fixtureScenario==='forgotten'){db.prepare("INSERT OR IGNORE INTO memory_records VALUES('fixture-unpinned',1,?,'constraint','Fixture unpinned marker','owner-statement','active',0,1,NULL,NULL,1)").run(globalThis.fixturePinScope);db.prepare("INSERT OR IGNORE INTO memory_records VALUES('fixture-archived',1,?,'constraint','Fixture archived marker','owner-statement','archived',1,1,NULL,NULL,1)").run(globalThis.fixturePinScope);}
     if(['lag-one','lag-600','overflow-lag'].includes(globalThis.fixtureScenario))db.prepare('UPDATE memory_recall_views SET watermark=0 WHERE view_id=?').run(access.view.viewId);
     if(globalThis.fixtureScenario==='overflow-current'){db.prepare('UPDATE memory_recall_views SET watermark=(SELECT max(sequence) FROM memory_recall_changes) WHERE view_id=?').run(access.view.viewId);console.warn('fixture current projection pins='+db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=? AND pinned=1 AND state='active'").get(access.view.viewId,access.view.generation).n);}
     if(globalThis.fixtureScenario==='missing-index')db.exec('DROP INDEX IF EXISTS memory_records_pinned');
     if(globalThis.fixtureScenario==='new-omission'&&globalThis.fixtureProviderCount>0)db.prepare("INSERT OR IGNORE INTO memory_records VALUES('fixture-new-large',1,?,'constraint',?,'owner-statement','active',1,1,NULL,NULL,1)").run(globalThis.fixturePinScope,'Fixture later capacity '.repeat(6000));
     if(globalThis.fixtureScenario==='exhausted')allowance.close();
     console.warn('fixture pin setup '+globalThis.fixtureScenario);
     const pinAt = pinStamp();
    \`);
    if(globalThis.fixtureScenario==='checking')text=text.replace('    const withheld=recordRestsOnWithheldMessage(',"    throw new MemoryPinProjectionPending();const withheld=recordRestsOnWithheldMessage(");
    if(globalThis.fixtureScenario==='cold-evidence')text=text.replaceAll('throw new MemoryPinProjectionPending()', "throw (console.warn('fixture pin proof spend='+JSON.stringify({nodes:globalThis.fixturePinAllowance.spent,ms:globalThis.fixturePinAllowance.spentMs(),hit:globalThis.fixturePinAllowance.hit})),new MemoryPinProjectionPending())");
    text=text.replace('  return bundle;',\`console.warn('fixture bundle counts='+JSON.stringify({delivered:bundle.pinned.length,dropped:bundle.droppedPins?.length??0,withheld:bundle.withheldPins?.length??0}));if(globalThis.fixtureScenario==='cold-evidence')console.warn('fixture cold spend='+JSON.stringify({nodes:allowance.spent,ms:allowance.spentMs(),hit:allowance.hit}));return bundle;\`);
   }
   if(url.endsWith('/server/index.ts')){
    text=text.replace('function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {', 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {globalThis.fixtureRoster=store;');
    if(globalThis.fixtureScenario==='out-of-view')text=text.replace('function recallSetupFailure(error: unknown, held: boolean): unknown {',"function recallSetupFailure(error: unknown, held: boolean): unknown {console.warn('fixture raw failure stack='+String(error?.stack));");
    const needle='async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
    text=text.replace(needle,needle+\`
     globalThis.fixtureProviderCount=(globalThis.fixtureProviderCount??0)+1;console.warn('fixture prepared='+JSON.stringify({system:built.system,tools:Object.keys(built.integrations??{}),memory:built.memoryContext?.text,transcript:built.transcript}));
     if(globalThis.fixtureScenario==='pin-before-submit'&&!globalThis.fixtureLatePin){globalThis.fixtureLatePin=true;globalThis.fixtureAddPin();console.warn('fixture late pin');}
     if(globalThis.fixtureScenario==='unrelated-commit'){const other=new globalThis.fixtureSqlite(globalThis.fixtureFile);other.exec('CREATE TABLE IF NOT EXISTS fixture_unrelated(value TEXT)');other.exec("INSERT INTO fixture_unrelated VALUES('neutral')");other.close();console.warn('fixture unrelated commit');}
     if(globalThis.fixtureScenario==='pin-after-write'&&!globalThis.fixtureLatePin){const previous=built.onEngineWrite;built={...built,onEngineWrite:()=>{previous?.();globalThis.fixtureLatePin=true;globalThis.fixtureAddPin();built.beforePrepare?.();console.warn('fixture pin after write');}};}
    \`);
   }
   return {...result,source:text};
  }});
  await import(${JSON.stringify(new URL('./memory/settle-target.ts',import.meta.url).href)});
  const {database}=await import(${JSON.stringify(new URL('./database.ts',import.meta.url).href)});
  const {storeAnchorMessage}=await import(${JSON.stringify(new URL('./memory/testing/anchor-message.ts',import.meta.url).href)});
  const {captureSource}=await import(${JSON.stringify(new URL('./memory/capture.ts',import.meta.url).href)});
  const {prepareRecallContextSync,stopRecallViewMaintenance}=await import(${JSON.stringify(new URL('./memory/recall-view.ts',import.meta.url).href)});
  const {DatabaseSync}=await import('node:sqlite');
  globalThis.fixtureAnchor=storeAnchorMessage;globalThis.fixtureStop=stopRecallViewMaintenance;globalThis.fixtureCapture=captureSource;globalThis.fixturePrepare=prepareRecallContextSync;globalThis.fixtureSqlite=DatabaseSync;
  if(globalThis.fixtureScenario==='out-of-view-static')database().exec("INSERT INTO memory_scopes VALUES('fixture-private-scope','conversation','fixture-private','{}',0)");
  globalThis.fixtureFile=database().prepare('PRAGMA database_list').all().find(row=>row.name==='main').file;
  globalThis.fixtureAddPin=()=>database().prepare("INSERT OR IGNORE INTO memory_records VALUES('fixture-late',1,?,'constraint','Fixture late marker','owner-statement','active',1,1,NULL,NULL,1)").run(globalThis.fixturePinScope);
 `;
 const fixture=await launchVerificationServer(process.env,undefined,{separateHome:true,turnLog:{replies:['Fixture reply.','Fixture reply.','Fixture reply.']},instrumentationSource}).catch(error=>{const log=String(error).match(/see (.+\.log)/)?.[1];if(log&&existsSync(log))console.error(readFileSync(log,'utf8').slice(-12000));throw error;});
 const run=(args:string[])=>runControlMurage([...args,'--url',fixture.info.url],{env:{MURAGE_DATA_DIR:fixture.info.dataDir}}) as Promise<any>;
 try{
  const bot=(await run(['new-bot','--name','Fixture persona'])).bot;
  const id=venue==='bot'?bot.id:(await run(['new-channel','--name','Fixture room','--members',bot.id])).channel.id;
  const destination=[`--${venue}`,id];
  if(scenario==='overflow-current'){
   // Populate and finish the real pin projection before the send, rather than treating a watermark as proof of its contents.
   const db=new DatabaseSync(join(fixture.info.dataDir,'messages.db'));db.exec('PRAGMA busy_timeout=5000');
   try{
    const context=()=>db.prepare("SELECT s.scope_id,c.view_id,c.generation FROM memory_recall_contexts c JOIN memory_recall_view_scopes s USING(view_id,generation) WHERE json_extract(c.context_key,'$[0]')=? AND json_extract(c.context_key,'$[3]')=0 AND s.lineage_only=0 LIMIT 1").get(bot.id);
    await expect.poll(()=>Boolean(context()),{timeout:20_000}).toBe(true);const scope=String(context()!.scope_id);
    db.exec('BEGIN IMMEDIATE');
    try{const put=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','Fixture mandatory marker','owner-statement','active',1,1,NULL,NULL,1)");put.run('fixture-pin',scope);for(let n=0;n<2048;n++)put.run('fixture-extra-'+n,scope);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
    await expect.poll(()=>{const view=context();return view?Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=? AND pinned=1 AND state='active'").get(view.view_id,view.generation)!.n):0;},{timeout:30_000,interval:50}).toBe(2049);
   }finally{db.close();}
  }
  const send=async()=>{
   const {secret}=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
   expect((await fetch(fixture.info.url+`/api/${venue==='bot'?'bots':'groups'}/${id}/messages`,{method:'POST',headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:JSON.stringify({text:'Fixture request.'})})).status).toBe(202);
   await run(['wait',...destination,'--timeout','20']);
  };
  const refused=['overflow-current','overflow-lag','missing-index','exhausted','checking','pin-before-submit'].includes(scenario);
  const turns=()=>existsSync(fixture.fixtureTurnLogPath)?readFileSync(fixture.fixtureTurnLogPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const repeat=['capacity','new-omission','long','many','pin-after-write'].includes(scenario)?3:1;
  for(let n=0;n<repeat;n++){
   await send();
   const log=readFileSync(fixture.info.logPath,'utf8');
   expect(log).toContain('fixture pin setup '+scenario);
   if(scenario==='overflow-current')expect(log).toContain('fixture current projection pins=2049');
   const rows=await run(['messages',...destination,'--limit','60']);
   expect(JSON.stringify(rows)).not.toContain('MEMORY_RECALL_UNAVAILABLE');
   expect(turns(),log.slice(-16000)).toHaveLength(refused?0:n+1);
   if(refused){
    expect(JSON.stringify(rows)).toContain(scenario.startsWith('overflow')?'has more pinned memories than Murage can check':'pinned memory is still being prepared');
    expect((log.match(/turn dispatch recall=/g)??[])).toHaveLength(0);expect(JSON.stringify(rows)).not.toContain('Bots were not given a pinned note');
   }else{
    const prepared=[...log.matchAll(/fixture prepared=([^\n]+)/g)].map(match=>JSON.parse(match[1]));
    const request=prepared.at(-1);
    expect(rows.messages.filter((row:any)=>row.text==='Fixture reply.')).toHaveLength(n+1);
    expect(request.system).toContain('Fixture persona');expect(request.tools).toContain('agents');
    if(['lag-one','lag-600','cold-evidence','unrelated-commit','out-of-view','out-of-view-static'].includes(scenario))expect(request.memory).toContain('Fixture mandatory marker');
    if(scenario==='cold-evidence'){const spend=JSON.parse([...log.matchAll(/fixture cold spend=([^\n]+)/g)].at(-1)![1]);console.info('S2-T9 base allowance spend='+JSON.stringify(spend));expect(spend.hit).toBe(false);}
    if(scenario==='out-of-view'||scenario==='out-of-view-static')expect(request.memory).not.toContain('Fixture secret must stay private');
    if(scenario==='identity-room'||scenario==='forgotten')expect(request.memory).not.toContain('Fixture mandatory marker');
    if(scenario==='forgotten'){expect(request.memory).not.toContain('Fixture unpinned marker');expect(request.memory).not.toContain('Fixture archived marker');expect(JSON.stringify(rows)).not.toContain('Bots were not given a pinned note');}
    if(['capacity','new-omission'].includes(scenario))expect(rows.messages.filter((row:any)=>row.tool?.name?.startsWith('Murage left some pinned memories out'))).toHaveLength(n+1);
    if(['long','many'].includes(scenario))expect(rows.messages.filter((row:any)=>row.tool?.name?.startsWith('Bots were not given a pinned note'))).toHaveLength(n+1);
    if(scenario==='pin-after-write'&&n>0)expect(request.memory).toContain('Fixture late marker');
    if(scenario==='accounting'){
     const counts=JSON.parse([...log.matchAll(/fixture bundle counts=([^\n]+)/g)].at(-1)![1]);
     expect(counts).toEqual({delivered:1,dropped:1,withheld:1});expect(counts.delivered+counts.dropped+counts.withheld+1).toBe(4);
     expect(JSON.stringify(rows)).toContain('Murage left some pinned memories out');expect(JSON.stringify(rows)).toContain('Bots were not given a pinned note');
    }
   }
  }
  if(scenario==='pin-before-submit'){await send();expect(turns()).toHaveLength(1);const log=readFileSync(fixture.info.logPath,'utf8');const request=JSON.parse([...log.matchAll(/fixture prepared=([^\n]+)/g)].at(-1)![1]);expect(request.memory).toContain('Fixture mandatory marker');expect(request.memory).toContain('Fixture late marker');}
 }catch(error){console.error('fixture failed scenario='+scenario+' exit='+fixture.child.exitCode+' signal='+fixture.child.signalCode);console.error(readFileSync(fixture.info.logPath,'utf8'));throw error;}finally{await fixture.close();}
},90_000);
