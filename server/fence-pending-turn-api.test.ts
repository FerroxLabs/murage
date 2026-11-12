// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Every server is control-murage's isolated fake-engine fixture. Hooks only
// observe production boundaries or inject deterministic pre-write refusals.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
const pendingTurnWork = new Map<number, number>();
const pendingTurnSql = new Map<number, unknown>();
const roomTurnWork = new Map<number, number>();
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
};
const login = async () => { const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any; headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }; };
const rows = (file: string) => existsSync(join(fixture.info.dataDir, file)) ? readFileSync(join(fixture.info.dataDir, file), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).messages as any[];
const scenario = (thread: string, input: object) => writeFileSync(join(fixture.info.dataDir, `fence-${thread}.json`), JSON.stringify(input));
const importUrl = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);

describe("pending fence turns in an isolated server", () => {
  beforeEach(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'),path=await import('node:path');
      const root=process.env.MURAGE_DATA_DIR;
      const log=(name,row)=>fs.appendFileSync(path.join(root,name),JSON.stringify(row)+'\\n');
      const {registerHooks}=await import('node:module');
      const sqlWork=new Map(),sqlStacks=new Map();globalThis.__fenceSql=(sql,stack)=>{sqlWork.set(sql,(sqlWork.get(sql)??0)+1);const key=String(stack).split(String.fromCharCode(10)).slice(2).join(String.fromCharCode(10));sqlStacks.set(key,(sqlStacks.get(key)??0)+1);};
      registerHooks({load(url,context,next){
        if(url.endsWith('/memory/deny-read.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('meter.statements++; meter.sql.add(sql);','meter.statements++; meter.sql.add(sql); globalThis.__fenceSql?.(sql,new Error().stack);').replace('export function refsLookup(db: DatabaseSync, refs: readonly LineageRef[], reader: LineageReader): LineageVerdict {','export function refsLookup(db: DatabaseSync, refs: readonly LineageRef[], reader: LineageReader): LineageVerdict { if(globalThis.__dropContext?.(refs))return {state:"checking",reason:"lookup-error"};')};
        if(url.endsWith('/memory/memory-revocation.ts')){
          let source=fs.readFileSync(new URL(url),'utf8');
          for(const name of ['settleRevokesForTurn','drainRevokeMarkerBounded']){
            const at=source.indexOf('export '+(name==='settleRevokesForTurn'?'async ':'')+'function '+name+'(');
            const brace=source.indexOf(' {',source.indexOf('):',at));
            if(at<0||brace<0)throw new Error('missing spy anchor '+name);
            source=source.slice(0,brace+2)+'globalThis.__fenceQueueCall?.('+JSON.stringify(name)+');'+source.slice(brace+2);
          }
          // Background work is deliberately parked; foreground code must not
          // compensate by walking the queue. No production budgets are raised.
          source=source.replace('export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions): void {','export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions): void { return;');
          return {format:'module-typescript',shortCircuit:true,source};
        }
        if(url.endsWith('/testing/fake-late-terminal-driver.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replaceAll('text: "Hello from late"', "text: 'REVOKED_SENTINEL-' + turn.threadId")};
        if(url.endsWith('/server/turn-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  return TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);','  return globalThis.__fenceNativeReplay?.() || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);')};
        if(url.endsWith('/server/working-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  let quoted: WorkingContextQuote[] = [];', '  input = globalThis.__fenceWorking?.(input) ?? input; let quoted: WorkingContextQuote[] = [];').replace('  return { text, quoted: text ? quoted : [], part:', '  const fixtureContext=globalThis.__fenceContext?.(input); if(fixtureContext)return fixtureContext; return { text, quoted: text ? quoted : [], part:')};
        if(!url.endsWith('/server/index.ts'))return next(url,context);
        let source=fs.readFileSync(new URL(url),'utf8');
        source=source.replace('function writeFenceNotice(file: string, notice: FenceNotice): void {','function writeFenceNotice(file: string, notice: FenceNotice): void { globalThis.__noticeFail?.("persist");');
        source=source.replace('const notice = JSON.parse(readFileSync(file, "utf8")) as FenceNotice;', 'globalThis.__noticeFail?.("read"); const notice = JSON.parse(readFileSync(file, "utf8")) as FenceNotice;');
        source=source.replace('fenceNoticeCursor = opendirSync(fenceNoticeDirectory);','globalThis.__noticeFail?.("scan"); fenceNoticeCursor = opendirSync(fenceNoticeDirectory);');
        source=source.replace('  const previous = store.messageById(notice.threadId, notice.id);','  globalThis.__noticeFail?.("append");  const previous = store.messageById(notice.threadId, notice.id);');
        source=source.replace('      let sessionLastLsn: number | null = null;','      if(globalThis.__retainedOnly?.(threadId))transcript=[]; let sessionLastLsn: number | null = null;');
        source=source.replace('        prompt: directPrompt,','        prompt: (globalThis.__finalLineage?.(threadId, turnLineage, turnOutputRoots.get(threadId)), directPrompt),');
        source=source.replace('        prompt: roomPrompt,','        prompt: (globalThis.__finalLineage?.(threadId, roomTurnLineage, turnOutputRoots.get(threadId)), roomPrompt),');
        source=source.replaceAll('text: turnPrompt','text: turnPrompt + '+JSON.stringify(String.fromCharCode(10)+'EXPANDED_SECRET_SENTINEL')).replaceAll('text:turnPrompt','text:turnPrompt + '+JSON.stringify(String.fromCharCode(10)+'EXPANDED_SECRET_SENTINEL'));
        source=source.replace('function commitFenceReset(botId: string, threadId: string, instanceId: string, cursor: unknown, incarnation: number | undefined): void {', 'function commitFenceReset(botId: string, threadId: string, instanceId: string, cursor: unknown, incarnation: number | undefined): void { globalThis.__fenceCrash?.(threadId,"before-reset");');
        source=source.replace('  const previous = store.messageById(notice.threadId, notice.id);', '  globalThis.__fenceCrash?.(notice.threadId,"before-note"); const previous = store.messageById(notice.threadId, notice.id);');
        source=source.replace('  unlinkSync(file); syncParentDirectory(file);', '  globalThis.__fenceCrash?.(notice.threadId,"after-note"); unlinkSync(file); syncParentDirectory(file);');
        source=source.replace('      let roomShownRefs: LineageRef[] = [];','      if(globalThis.__fenceMissingView?.(threadId))roomRenderedView=undefined; let roomShownRefs: LineageRef[] = [];');
        source=source.replace('      const roomRawHumanText =','      globalThis.__fenceBuilt?.(threadId, roomPrompt.parts.flatMap(part=>part.lineageOf)); const roomRawHumanText =');
        source=source.replace('      const rawHumanText =', '      globalThis.__fenceBuilt?.(threadId, directPrompt.parts.flatMap(part=>part.lineageOf)); const rawHumanText =');
        for(const name of ['Direct','Room']){
          const validate=source.includes('submissionBoundary.beforeSubmit(validate'+name+'Write)')?'validate'+name+'Write':'validate'+name+'Submission';
          const anchor='submissionBoundary.beforeSubmit('+validate+')';
          if(source.split(anchor).length!==2)throw new Error('missing submission anchor '+validate);
          source=source.replace(anchor,'submissionBoundary.beforeSubmit(() => { globalThis.__fenceRefuse?.(threadId); '+validate+'(); })');
        }
        return {format:'module-typescript',shortCircuit:true,source};
      }});
      globalThis.__fenceQueueCall=name=>log('queue-calls',{name});
      const configFor=thread=>{const file=path.join(root,'fence-'+thread+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}};
      globalThis.__noticeFail=site=>{
        const file=path.join(root,'notice-faults');if(!fs.existsSync(file))return;
        const cfg=JSON.parse(fs.readFileSync(file,'utf8'));if(cfg.site!==site||cfg.left<=0)return;
        cfg.left--;fs.writeFileSync(file,JSON.stringify(cfg));log('notice-fault-attempts',{site});throw new Error('PRIVATE_NOTICE_FAILURE_SENTINEL');
      };
      globalThis.__dropContext=refs=>refs.some(ref=>ref.kind==='line'&&ref.threadId==='OMITTED_THREAD_ID_SENTINEL')&&fs.readdirSync(root).some(name=>name.startsWith('fence-')&&name.endsWith('.json')&&JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).dropContext);
      globalThis.__retainedOnly=thread=>configFor(thread).retainedOnly&&!(configFor(thread).attempt??0);
      globalThis.__finalLineage=(thread,turn,running)=>log('final-lineage',{thread,parents:turn.parents,roots:[...(running?.roots.roots??[])],sources:running?.sources});
      globalThis.__fenceNativeReplay=()=>fs.existsSync(path.join(root,'native-replay'));
      globalThis.__fenceMissingView=thread=>configFor(thread).missingView===true;
      globalThis.__fenceCrash=(thread,site)=>{
        if(configFor(thread).crashSite!==site||fs.existsSync(path.join(root,'crashed')))return;
        log('reset-disk',{thread,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});
        fs.writeFileSync(path.join(root,'crashed'),site);process.kill(process.pid,'SIGKILL');
      };

      const builtRefs=new Map();globalThis.__fenceBuilt=(thread,refs)=>builtRefs.set(thread,refs);
      const {promptPart}=await import(${importUrl("server/memory/prompt-parts.ts")});
      globalThis.__fenceContext=input=>configFor(input.currentThreadId).dropContext?{
        text:'OMITTED_REMEMBERED_TEXT_SENTINEL',quoted:[{threadId:'OMITTED_THREAD_ID_SENTINEL',messageId:'OMITTED_MESSAGE_ID_SENTINEL'}],
        part:promptPart('OMITTED_REMEMBERED_TEXT_SENTINEL',[{kind:'line',threadId:'OMITTED_THREAD_ID_SENTINEL',messageId:'OMITTED_MESSAGE_ID_SENTINEL'}]),omissions:{checking:0,changed:0,unknown:0}
      }:undefined;
      const {appendMessage}=await import(${importUrl("server/message-db.ts")});
      globalThis.__fenceWorking=input=>{
        if(!configFor(input.currentThreadId).workingOmission&&!configFor(input.currentThreadId).dropContext)return input;
        const thread='OMITTED_THREAD_ID_SENTINEL',id='OMITTED_MESSAGE_ID_SENTINEL';
        const db=database();
        if(!db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,id))appendMessage(thread,{id,role:'bot',kind:'text',text:'OMITTED_REMEMBERED_TEXT_SENTINEL',at:Date.now(),...(configFor(input.currentThreadId).dropContext?{}:{withheldFromBots:'forgotten'}),from:{botId:input.botId,name:'fixture',color:'blue'}});
        return {...input,bots:input.bots.map(bot=>bot.id===input.botId?{...bot,tasks:[...(bot.tasks??[]),{threadId:thread,title:'Omitted fixture'}]}:bot)};
      };
      const pending=new Map();
      globalThis.__fenceRefuse=thread=>{
        const kind=pending.get(thread);pending.delete(thread);
        if(kind)throw Object.assign(new Error('MEMORY_CONTEXT_REVOKED'),{fence:{state:'checking',reason:'pending'}});
      };
      // This in-process fake has no native page fetch. Register that fact so
      // the separate web-read warning cannot masquerade as a memory refusal.
      const {WEB_READ_ROUTING}=await import(${importUrl("shared/web-read-routing.ts")});
      WEB_READ_ROUTING.fakeLateTerminal={route:'in-process fixture; no native page fetch'};
      const {BUILT_IN_DRIVERS}=await import(${importUrl("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${importUrl("server/testing/fake-late-terminal-driver.ts")});
      const {denyReadMeter,resetDenyReadMeter}=await import(${importUrl("server/memory/deny-read.ts")});
      const {renderDriverReplay}=await import(${importUrl("server/turn-context.ts")});
      const {database}=await import(${importUrl("server/database.ts")});
      const {commitRevoke}=await import(${importUrl("server/memory/revoke-commit.ts")});
      const queueSnapshot=()=>Object.fromEntries(['memory_revoke_jobs','memory_revoke_reached','memory_revoke_frontier'].map(table=>[table,database().prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));
      let beforeQueue;
      const driver=makeLateTerminalDriver(),create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input),send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{
          const file=path.join(root,'fence-'+turn.threadId+'.json');
          const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
          const attempt=cfg.attempt??0;cfg.attempt=attempt+1;fs.writeFileSync(file,JSON.stringify(cfg));
          input.environment.FAKE_LATE_HANDBACK=cfg.late?'1':'0';
          if(cfg.refusals>attempt)pending.set(turn.threadId,'pending');
          if(cfg.permanentMark&&!attempt){
            const db=database();
            const key=db.prepare('SELECT * FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1').get(turn.threadId);
            if(!key)throw new Error('fixture requires retained session lineage');
            db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,999999)').run(key.thread_id,key.driver_instance,key.native_session);
            if(!cfg.unchangedGeneration)db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
            log('permanent-mark',{thread:turn.threadId,key});
          }

          if(cfg.backlog&&!attempt){
            const db=database();db.exec('BEGIN IMMEDIATE');
            try{
              const cap=Number(db.prepare('SELECT next FROM memory_lsn WHERE id=1').get().next)+1;
              const insert=db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line','{}',1,?,'mark','','active')");
              const hold=db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
              for(let i=0;i<cfg.backlog;i++){insert.run(800001+i,cap);hold.run(800001+i);}
              // A real revoke commit changes the generation between build and submit.
              commitRevoke(db,{kind:'line',threadId:turn.threadId,messageIds:[],cause:'forget'});
              db.exec('COMMIT'); beforeQueue=queueSnapshot();resetDenyReadMeter();sqlWork.clear();sqlStacks.clear();
            }catch(e){db.exec('ROLLBACK');throw e;}
          }
          if(cfg.retainedOnly&&!attempt){
            const refs=builtRefs.get(turn.threadId),{buildPrompt,promptPart}=await import(${importUrl("server/memory/prompt-parts.ts")});
            const probe=buildPrompt(undefined,[promptPart(turn.text,refs)]);
            // Isolate the prompt fence from the independent permanent-session
            // validator. This fake native sink carries old history on resume.
            const {assertSendFence}=await import(${importUrl("server/memory/send-fence.ts")});
            try{assertSendFence(probe,{audience:null},database());log('retained-fence-writes',{text:'REVOKED_SENTINEL-'+turn.threadId});}
            catch(error){if(error.message!=='MEMORY_CONTEXT_REVOKED')throw error;log('retained-fence-writes',{text:'',state:'refused'});}
          }
          log('attempts',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript,system:turn.system,resumed:turn.resumeCursor!==undefined,cursor:turn.resumeCursor,refs:builtRefs.get(turn.threadId),reset:turn.sessionReset,memory:turn.memoryContext!==undefined});
          const before=turn.beforeSubmit;
          turn.beforeSubmit=()=>{before?.();log('writes',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript,fallback:cfg.fallbackReplay?renderDriverReplay(turn.transcript??[],turn.replayMetadata):undefined,context:turn.memoryContext,system:turn.system,images:turn.images,integrationKeys:Object.keys(turn.integrations??{}),memory:turn.memoryContext!==undefined,...beforeQueue?{queueBefore:beforeQueue,queueAfter:queueSnapshot(),work:denyReadMeter().statements,sqlWork:Object.fromEntries(sqlWork),sqlStacks:Object.fromEntries(sqlStacks)}:{}});if(cfg.releaseThenRefuse&&!attempt){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);turn.onEngineWrite?.();pending.set(turn.threadId,'pending');before?.();}if(cfg.crashAtWrite&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');}};
          if(cfg.crashAtRecovery&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){
            log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});
            fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');
          }
          return send(turn);
        };
        const subscribe=instance.adapter.onEvent.bind(instance.adapter);
        instance.adapter.onEvent=listener=>subscribe(event=>{
          listener(event);
          if(event.type==='item.completed'&&event.itemType==='assistant_text')globalThis.__fenceCrash(event.threadId,'after-output');
        });
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const pre=path.join(root,'ready');fs.writeFileSync(pre,'');
      const file=path.join(root,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.fence={driver:'fakeLateTerminal',environment:{FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_PRE_HANDBACK_GATE:pre}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` }); await login();
    // Hold prompt refs constant for the operation-count comparison: automatic
    // learning from the warm-up reply must not publish extra refs mid-test.
    const memory = await api("GET", "/api/memory/status");
    await api("POST", "/api/memory/action", { action: "configure", learningRevision: memory.learning.revision, learning: { automaticFacts: false, automaticProcedures: false, learnFrom: { chats: false, channels: false } } });
    console.warn(`revokefence isolated fixture ${JSON.stringify(fixture.info)}`);
  }, 120000);
  afterEach(async () => { if (fixture) { console.warn(`revokefence log ${fixture.info.logPath}\n${readFileSync(fixture.info.logPath, "utf8")}`); await fixture.close(); } });
  const make = async (room = false) => {
    const bot = (await api("POST", "/api/bots", { name: "Fence fixture", modelSelection: { instanceId: "fence", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name: "Fence room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    return { bot, thread: group?.threadId ?? bot.threadId, route: group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages` };
  };
  const finished = async (thread: string, want = 1) => { await expect.poll(async () => (await messages(thread)).filter(m => m.role === "bot" && m.kind === "text" && m.text === "REVOKED_SENTINEL-" + thread).length >= want, { timeout: 60000 }).toBe(true); };
  it.each([10, 1000])("R10 direct owner turn with %i active jobs releases once without walking the queue", async backlog => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    const queueBefore = rows("queue-calls").length;
    const notesBefore = new Set((await messages(f.thread)).filter(m => m.memoryNote === "without-memory").map(m => m.id));
    scenario(f.thread, { backlog });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))).toHaveLength(1);
    expect(JSON.stringify(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")))).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")).length).toBeLessThanOrEqual(3);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    const release = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0];
    expect(release.queueAfter).toEqual(release.queueBefore);
    console.warn("revokefence operation profile " + JSON.stringify({ backlog, work: release.work, sqlWork: release.sqlWork, sqlStacks: release.sqlStacks }));
    pendingTurnWork.set(backlog, release.work); pendingTurnSql.set(backlog, release.sqlWork);
    if (pendingTurnWork.size === 2) expect(pendingTurnWork.get(1000), JSON.stringify(Object.fromEntries(pendingTurnSql))).toBe(pendingTurnWork.get(10));
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !notesBefore.has(m.id))).toHaveLength(1);
  }, 90000);
  it.each([10, 1000])("B4 R11 room with %i jobs has constant operation count and no queue mutation", async backlog => {
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    const queueBefore = rows("queue-calls").length;
    const priorNotes = new Set((await messages(f.thread)).filter(m => m.memoryNote).map(m => m.id));
    scenario(f.thread, { backlog });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")).length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(writes[0].queueAfter).toEqual(writes[0].queueBefore);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    roomTurnWork.set(backlog, writes[0].work);
    console.warn("room operation profile " + JSON.stringify({ backlog, work: writes[0].work, sql: writes[0].sqlWork }));
    if (roomTurnWork.size === 2) expect(roomTurnWork.get(1000)).toBe(roomTurnWork.get(10));
    expect((await messages(f.thread)).filter(m => m.memoryNote && !priorNotes.has(m.id))).toHaveLength(1);
  }, 90000);
  it("B4 M8 retained unlisted history cannot cross the prompt fence", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    scenario(f.thread, { backlog: 10, retainedOnly: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const first = rows("attempts").find(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(first.resumed).toBe(true);
    expect(first.transcript).toEqual([]);
    expect(rows("retained-fence-writes")).toHaveLength(1);
    expect(JSON.stringify(rows("retained-fence-writes"))).not.toContain("REVOKED_SENTINEL-" + f.thread);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
  }, 90000);
  it.each([false, true])("B2 dropped tier-one context leaves no output roots or turn/session parents (room=%s)", async room => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make(room); scenario(f.thread, { refusals: 1, dropContext: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread);
    const attempts = rows("attempts").filter(r => r.thread === f.thread);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].text).toContain("OMITTED_REMEMBERED_TEXT_SENTINEL");
    expect(attempts[1].text).not.toContain("OMITTED_REMEMBERED_TEXT_SENTINEL");
    // No stale cross-thread parents can be inherited by fresh replies/sessions.
    const selected = rows("final-lineage").filter(r => r.thread === f.thread).at(-1);
    expect(selected).toBeTruthy();
    expect(JSON.stringify(selected)).not.toContain("OMITTED_THREAD_ID_SENTINEL");
    expect(JSON.stringify(selected)).not.toContain("OMITTED_MESSAGE_ID_SENTINEL");
  }, 90000);
  it.each(["read", "persist", "append", "scan"])("B3 notice reconciliation retries a transient %s failure without restart", async site => {
    const f = await make();
    const id = "memory-note-" + "a".repeat(64);
    const directory = join(fixture.info.dataDir, "fence-notices");
    const { mkdirSync } = await import("node:fs"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, id + ".json"), JSON.stringify({ threadId: f.thread, key: "PRIVATE_NOTICE_KEY_SENTINEL", id, line: "Murage left remembered details out of this reply.", released: true }));
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site, left: 1 }));
    await fixture.restart(); await login();
    await expect.poll(async () => (await messages(f.thread)).filter(m => m.id === id).length, { timeout: 10000 }).toBe(1);
    expect(rows("notice-fault-attempts")).toHaveLength(1);
    expect(existsSync(join(directory, id + ".json"))).toBe(false);
    const diagnostic = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("notice reconciliation"));
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.join("\n")).not.toMatch(/PRIVATE_NOTICE|memory-note-|a{64}/);
  }, 60000);
  it("B3 permanent notice failure stops after three attempts and preserves other obligations", async () => {
    const f = await make();
    const directory = join(fixture.info.dataDir, "fence-notices");
    const { mkdirSync } = await import("node:fs"); mkdirSync(directory, { recursive: true });
    const id = "memory-note-" + "b".repeat(64);
    writeFileSync(join(directory, id + ".json"), JSON.stringify({ threadId: f.thread, key: "PRIVATE_NOTICE_KEY_SENTINEL", id, line: "Murage left remembered details out of this reply.", released: true }));
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site: "append", left: 100 }));
    await fixture.restart(); await login();
    await expect.poll(() => rows("notice-fault-attempts").length, { timeout: 10000 }).toBe(3);
    // An exhausted entry stays on disk for repair; no unbounded background loop.
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(rows("notice-fault-attempts")).toHaveLength(3);
    expect(existsSync(join(directory, id + ".json"))).toBe(true);
    const diagnostic = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("notice reconciliation"));
    expect(diagnostic.join("\n")).toContain("attempts=3 failures=3 unresolved=1");
    expect(diagnostic.join("\n")).not.toMatch(/PRIVATE_NOTICE|memory-note-|b{64}/);
    // Remove the injected outage, add a healthy obligation, then restart: both
    // are released once, including the durable exhausted entry.
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site: "append", left: 0 }));
    const other = "memory-note-" + "c".repeat(64);
    writeFileSync(join(directory, other + ".json"), JSON.stringify({ threadId: f.thread, key: "second", id: other, line: "Murage left remembered details out of this reply.", released: true }));
    await fixture.restart(); await login();
    await expect.poll(async () => (await messages(f.thread)).filter(m => m.id === id || m.id === other).length).toBe(2);
  }, 60000);
  it.each([{ room: false, late: false }, { room: false, late: true }, { room: true, late: false }, { room: true, late: true }])("R11 two refusals, $room room / $late late, end message-only with one note", async opts => {
    const f = await make(opts.room);
    if (opts.room) {
      await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
      await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    }
    const queueBefore = rows("queue-calls").length;
    const priorNotes = new Set((await messages(f.thread)).filter(m => m.memoryNote === "without-memory").map(m => m.id));
    scenario(f.thread, { refusals: 2, late: opts.late });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, opts.room ? 2 : 1);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts).toHaveLength(3);
    expect(attempts[0].text).toContain(opts.room ? "ROOM_STORED_SENTINEL" : "EXPANDED_SECRET_SENTINEL");
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")); expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("RAW_HUMAN_INPUT"); expect(writes[0].text).not.toContain("EXPANDED_SECRET_SENTINEL"); expect(writes[0].text).not.toContain("ROOM_STORED_SENTINEL"); expect(writes[0].transcript ?? []).toEqual([]); expect(writes[0].memory).toBe(false); expect(writes[0].images).toBeUndefined(); expect(writes[0].integrationKeys).toEqual([]);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id))).toHaveLength(1);
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toEqual([]);
  }, 90000);
  it.each([{ site: "reset-commit", mode: "active" }, { site: "first-write", mode: "active" }, { site: "reset-commit", mode: "off" }, { site: "first-write", mode: "off" }])("R12 $mode tier-one reset survives a $site crash without resuming old history", async ({ site, mode }) => {
    if (mode === "off") await api("POST", "/api/memory/action", { action: "configure", mode });
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "first human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    scenario(f.thread, { refusals: 1, crashAtRecovery: site === "reset-commit", crashAtWrite: site === "first-write" });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "crashed")), { timeout: 60000 }).toBe(true);
    if (site === "first-write") expect(readFileSync(join(fixture.info.dataDir, "fake-transport-write"), "utf8")).toContain("RAW_HUMAN_INPUT");
    const disk = rows("reset-disk").at(-1)!;
    const bots = Array.isArray(disk.bots) ? disk.bots : disk.bots.bots;
    expect(bots.find((b: any) => b.id === f.bot.id)?.tasks.find((t: any) => t.threadId === f.thread)?.resumeCursors.fence).toBeUndefined();
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0].resumed, "the fixture must actually retain a native session before refusal").toBe(true);
    const resumed = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0];
    expect(typeof resumed.refs.find((r: any) => r.kind === "prefix").held).toBe("number");
    await fixture.restart(); await login(); scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "after the isolated crash" });
    await expect.poll(() => rows("attempts").filter(r => r.thread === f.thread).at(-1)?.text).toContain("after the isolated crash");
    expect(rows("attempts").filter(r => r.thread === f.thread).at(-1)?.resumed).toBe(false);
  }, 120000);
  it.each(["before-reset", "before-note", "after-note", "after-output"])("R12 crash at %s preserves privacy and idempotent note obligations", async site => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "first human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    const priorNotes = new Set((await messages(f.thread)).filter(m => m.memoryNote === "without-memory").map(m => m.id));
    scenario(f.thread, { refusals: site === "before-reset" ? 0 : 1, permanentMark: true, unchangedGeneration: true, crashSite: site });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "crashed")), { timeout: 60000 }).toBe(true);
    expect(rows("permanent-mark")).toHaveLength(1);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    // The crash before reset or notice release must precede every engine write.
    if (site === "before-reset" || site === "before-note") expect(writes).toEqual([]);
    await fixture.restart(); await login(); scenario(f.thread, {});
    if (site !== "before-reset") {
      await expect.poll(async () => (await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id)).length).toBe(1);
      const note = (await messages(f.thread)).find(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id));
      expect(note.tool.ok).toBe(true);
      // A second restart must not replay the durable obligation twice.
      await fixture.restart(); await login();
      expect((await messages(f.thread)).filter(m => m.id === note.id)).toHaveLength(1);
    }
    await api("POST", f.route, { threadId: f.thread, text: "after boundary crash" });
    await expect.poll(() => rows("attempts").filter(r => r.thread === f.thread).at(-1)?.text).toContain("after boundary crash");
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("after boundary crash")).length).toBe(1);
    const after = rows("attempts").filter(r => r.thread === f.thread).at(-1)!;
    const before = rows("attempts").find(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))!;
    expect(after.cursor).not.toBe(before.cursor);
    if (site !== "after-output") expect(after.resumed).toBe(false);
  }, 120000);

  it.each([false, true])("R10 %s native replay accounts for fallback transcript before a real revoke", async native => {
    if (native) writeFileSync(join(fixture.info.dataDir, "native-replay"), "1");
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    scenario(f.thread, { backlog: 10, fallbackReplay: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    const oldReply = (await messages(f.thread)).find(m => m.text === "REVOKED_SENTINEL-" + f.thread);
    expect(attempts[0].refs.find((r: any) => r.kind === "prefix").shown).toContain(oldReply.id);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(writes[0].queueBefore).toEqual(writes[0].queueAfter);
  }, 90000);
  it("R11 a room without its rendered view keeps a legacy prefix until a fenced recovery", async () => {
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    scenario(f.thread, { backlog: 10, missingView: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[0].refs.find((r: any) => r.kind === "prefix")).not.toHaveProperty("held");
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(writes[0].queueBefore).toEqual(writes[0].queueAfter);
  }, 90000);

  it.each([false, true])("A7 tier 0 working-context omission in room=%s gets one counts-only note without recovery", async room => {
    // Recall is outside this oracle. With it disabled, the only observed
    // omission is the working-context quote, so a missing count cannot be
    // masked by a separate recall deadline or unavailable-model notice.
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make(room); scenario(f.thread, { workingOmission: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread);
    const notes = (await messages(f.thread)).filter(m => m.memoryNote === "without-memory");
    expect(notes).toHaveLength(1);
    expect(notes[0].tool).toEqual({ name: "Murage left remembered details out of this reply.", ok: true });
    const writes = rows("writes").filter(r => r.thread === f.thread);
    expect(writes).toHaveLength(1);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(1);
    const recoveryLogs = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("[memory] fence recovery"));
    expect(recoveryLogs).toHaveLength(1);
    expect(recoveryLogs[0]).toContain("tier=0");
    expect(recoveryLogs[0]).toContain("omitted=1 cause=changed");
    for (const secret of ["OMITTED_THREAD_ID_SENTINEL", "OMITTED_MESSAGE_ID_SENTINEL", "OMITTED_REMEMBERED_TEXT_SENTINEL"]) {
      expect(JSON.stringify(notes)).not.toContain(secret);
      expect(recoveryLogs.join("\n")).not.toContain(secret);
      expect(JSON.stringify(writes)).not.toContain(secret);
    }
  }, 90000);

  it("R11 refusing every tier gives one card after exactly two rebuilds", async () => {
    const f = await make(); scenario(f.thread, { refusals: 3 });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(async () => (await messages(f.thread)).filter(m => m.tool?.ok === false).length, { timeout: 30000 }).toBe(1);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(3);
    expect(rows("writes").filter(r => r.thread === f.thread)).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory")).toEqual([]);
  }, 60000);
  it("R11 a released and confirmed first write gives a card without replay", async () => {
    const f = await make(); scenario(f.thread, { releaseThenRefuse: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(async () => (await messages(f.thread)).filter(m => m.tool?.ok === false).length, { timeout: 30000 }).toBe(1);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(1);
    expect(rows("writes").filter(r => r.thread === f.thread)).toHaveLength(1);
    expect(readFileSync(join(fixture.info.dataDir, "fake-transport-write"), "utf8")).toContain("RAW_HUMAN_INPUT");
  }, 60000);

  it.each([false, true])("R11 memory-off room with memory history=%s resets before recovery writes", async history => {
    if (!history) await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    const idle = async () => { await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false); };
    await idle();
    if (history) {
      // An existing disclosure keeps a rendered floor. A room that has never
      // used memory deliberately has no floor and must keep its legacy prefix.
      await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
      await api("POST", f.route, { threadId: f.thread, text: "off-mode retained input" }); await finished(f.thread, 2); await idle();
    }
    scenario(f.thread, { refusals: 1 });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, history ? 3 : 2);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts).toHaveLength(2);
    expect(attempts[1].reset).toBe(true);
    if (history) {
      expect(typeof attempts[0].refs.find((r: any) => r.kind === "prefix").held).toBe("number");
      expect(attempts[1].refs.find((r: any) => r.kind === "prefix").held).toBeNull();
    } else {
      for (const attempt of attempts) expect(attempt.refs.find((r: any) => r.kind === "prefix")).not.toHaveProperty("held");
    }
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))).toHaveLength(1);
  }, 90000);

});
