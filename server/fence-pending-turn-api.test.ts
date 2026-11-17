// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Every server is control-murage's isolated fake-engine fixture. Hooks only
// observe production boundaries or inject deterministic pre-write refusals.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBotRecords } from "./bot-turn-state.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
// The real background-admission producer requires its native meter in every fixture child.
import { prepareMemoryMeterFixture } from "./memory/testing/native-meter-fixture.ts";
beforeAll(() => prepareMemoryMeterFixture(process.env.HOME!));
const pendingTurnWork = new Map<number, number>();
const pendingTurnSql = new Map<number, unknown>();
const roomTurnWork = new Map<number, number>();
const pendingTurnGraphs = new Map<number, unknown>();
const roomTurnGraphs = new Map<number, unknown>();
const pendingTurnFrozen = new Map<number, unknown>();
const roomTurnFrozen = new Map<number, unknown>();
const pendingTurnWaits = new Map<number, unknown>(), roomTurnWaits = new Map<number, unknown>();
const graphShape = (graph: Array<{ kind: string; version: number; state: string }>) => graph
  .map(({ kind, version, state }) => ({ kind, version, state }))
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.version - b.version || a.state.localeCompare(b.state));
let fixture: VerificationServer, headers: Record<string, string>;
let currentRoute: string | undefined;
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
  beforeEach(async ({ task }) => {
    const route = task.name.match(/\['?(claudeAgent|codex|customAcp)'?\]/)?.[1];
    currentRoute = route;
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'),path=await import('node:path'); const {createHash}=await import('node:crypto');
      const root=process.env.MURAGE_DATA_DIR;
      const route=${JSON.stringify(route ?? "")};
      if(route)await import(${importUrl("server/testing/fake-engine-unwrapped-preload.mjs")});
      if(route==='claudeAgent')await import(${importUrl("server/testing/claude-retained-session-preload.mjs")});
      const log=(name,row)=>fs.appendFileSync(path.join(root,name),JSON.stringify(row)+'\\n');
      const {registerHooks}=await import('node:module');
      const sqlWork=new Map(),sqlStacks=new Map();globalThis.__fenceSql=(sql,stack)=>{sqlWork.set(sql,(sqlWork.get(sql)??0)+1);const key=String(stack).split(String.fromCharCode(10)).slice(2).join(String.fromCharCode(10));sqlStacks.set(key,(sqlStacks.get(key)??0)+1);};
      registerHooks({load(url,context,next){
        if(url.endsWith('/memory/consolidate.ts')){
          const source=fs.readFileSync(new URL(url),'utf8');
          const anchor='return heldStep("memory.checkpoint", () => refreshMemoryCheckpointUnheld(completedJobId,options.maxPayloadBytes));';
          if(source.split(anchor).length!==2)throw new Error('missing checkpoint observer anchor');
          return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,'const result = globalThis.__fenceHoldCheckpoint?.() ? {status:"deferred",reason:"fixture-hold"} : heldStep("memory.checkpoint", () => refreshMemoryCheckpointUnheld(completedJobId,options.maxPayloadBytes)); globalThis.__fenceCheckpoint?.(result,completedJobId); return result;')};
        }
        if(url.endsWith('/memory/deny-read.ts')) {
          let source=fs.readFileSync(new URL(url),'utf8');
          const meter='meter.statements++; meter.sql.add(sql);';
          const begin=source.indexOf('export function refsLookup(');
          const signature='): LineageVerdict {';
          const body=source.indexOf(signature,begin);
          if(source.split(meter).length!==2||begin<0||body<0)throw new Error('missing deny reader observer anchor');
          const at=body+signature.length;
          source=source.slice(0,at)+' if(globalThis.__dropContext?.(refs))return {state:"checking",reason:"lookup-error"};'+source.slice(at);
          source=source.replace(meter,meter+' globalThis.__fenceSql?.(sql,new Error().stack);');
          return {format:'module-typescript',shortCircuit:true,source};
        }
        if(url.endsWith('/memory/recall-view.ts')){
          // Park only the background upkeep timer once the graph is frozen. A
          // turn's own maintenance request (requestRecallViewMaintenance) stays real.
          const source=fs.readFileSync(new URL(url),'utf8'),anchor='  const tick=()=>{'+String.fromCharCode(10)+'    upkeep=undefined;';
          if(source.split(anchor).length!==2)throw new Error('missing recall upkeep anchor');
          return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,anchor+' if(globalThis.__fenceParkRecallUpkeep){upkeep=setTimeout(tick,50);upkeep.unref();return;} globalThis.__fenceUpkeepTick?.();')};
        }
        if(url.endsWith('/memory/memory-revocation.ts')){
          let source=fs.readFileSync(new URL(url),'utf8');
          for(const name of ['settleRevokesForTurn','drainRevokeMarkerBounded']){
            const at=source.indexOf('export '+(name==='settleRevokesForTurn'?'async ':'')+'function '+name+'(');
            const brace=source.indexOf(' {',source.indexOf('):',at));
            if(at<0||brace<0)throw new Error('missing spy anchor '+name);
            source=source.slice(0,brace+2)+'globalThis.__fenceQueueCall?.('+JSON.stringify(name)+');'+source.slice(brace+2);
          }
          // Park the runner only after a scenario seeds its artificial backlog.
          // Configuration revokes and ordinary checkpoint refresh stay real.
          source=source.replace('export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions): void {','export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions): void { if(globalThis.__fenceParkRevocation)return;');
          return {format:'module-typescript',shortCircuit:true,source};
        }
        if(url.endsWith('/testing/fake-late-terminal-driver.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replaceAll('text: "Hello from late"', "text: 'REVOKED_SENTINEL-' + turn.threadId").replaceAll('{ prompt: true, turnId', '{ prompt: true, payload: {text:turn.text,transcript:turn.transcript,system:turn.system,memoryContext:turn.memoryContext,images:turn.images}, turnId').replace('if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") beforeHandback();', 'if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") { beforeHandback(); if(dump)appendFileSync(dump,JSON.stringify({prompt:true,payload:{text:turn.text,transcript:turn.transcript,system:turn.system,memoryContext:turn.memoryContext,images:turn.images},turnId,threadId:turn.threadId})+String.fromCharCode(10)); }').replaceAll('emit({ type: "item.completed", itemType: "assistant_text"', 'turn.onEngineWrite?.(); emit({ type: "item.completed", itemType: "assistant_text"')};
        if(url.endsWith('/server/turn-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  return driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);','  return globalThis.__fenceNativeReplay?.() || driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);')};
        if(url.endsWith('/server/working-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  let quoted: WorkingContextQuote[] = [];', '  input = globalThis.__fenceWorking?.(input) ?? input; let quoted: WorkingContextQuote[] = [];').replace('  return { text, quoted: text ? quoted : [], part:', '  const fixtureContext=globalThis.__fenceContext?.(input); if(fixtureContext)return fixtureContext; return { text, quoted: text ? quoted : [], part:')};
        if(!url.endsWith('/server/index.ts'))return next(url,context);
        let source=fs.readFileSync(new URL(url),'utf8');
        source=source.replace('  const trace = beginTurnTrace(threadId);', '  const fixtureTier=globalThis.__routeTier?.(threadId),historyId=globalThis.__seedRouteHistory?.(threadId); if(historyId)store.appendMessage(threadId,{id:historyId,role:"user",kind:"text",text:"EARLIER_CONVERSATION_LINE"}); if(fixtureTier){const fixtureMessage=store.appendMessage(threadId,{role:"user",kind:"text",text});opts={...opts,memoryRedispatch:fixtureTier,userMessage:fixtureMessage};} if(globalThis.__seedVisible?.(threadId)){store.appendMessage(threadId,{id:"ctx-visible",role:"bot",kind:"text",text:"VISIBLE_CONVERSATION_LINE",at:Date.now(),from:{botId,name:"fixture",color:"blue"}});} if(globalThis.__seedPrivate?.(threadId)){store.appendMessage(threadId,{id:"ctx-withheld",role:"bot",kind:"text",text:"WITHHELD_CONVERSATION_LINE",at:Date.now(),withheldFromBots:"forgotten",from:{botId,name:"fixture",color:"blue"}});} const trace = beginTurnTrace(threadId);');
        { const wait='    if (!projection || Number(projection.watermark) >= Number(projection.latest)) {'; if(source.split(wait).length!==2)throw new Error('missing bundle wait observer anchor'); source=source.replace(wait,'    globalThis.__fenceBundleWait?.(projection,remaining);'+wait); }
        source=source.replace('const memoryLastResort = (opts?.memoryRedispatch', 'const memoryLastResort = globalThis.__routeTier?.(threadId)===2 || (opts?.memoryRedispatch');
        source=source.replace('if (rootsApply && isMessageOnlyDispatch(lineage)) return;', 'if (rootsApply && isMessageOnlyDispatch(lineage) && !globalThis.__legacyCursor?.(event.threadId)) return;');
        source=source.replace('recordDefaultLearningConnection(database(),memoryExtractorInstanceId(),Boolean(fluxKey()));','globalThis.__pauseFenceMemory=()=>memoryWorker.stop(); globalThis.__resumeFenceMemory=()=>memoryWorker.start(); recordDefaultLearningConnection(database(),memoryExtractorInstanceId(),Boolean(fluxKey()));');
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
        source=source.replace('      let selectiveDropped = false;', '      if(globalThis.__fenceMemoryMount?.(threadId,integrations))threadRecallOn=true; let selectiveDropped = false;');
        source=source.replace('      let roomSelectiveDropped = false;', '      globalThis.__fenceMemoryMount?.(threadId,integrations); let roomSelectiveDropped = false;');
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
      globalThis.__dropContext=refs=>refs.some(ref=>ref.kind==='line'&&ref.threadId==='OMITTED_THREAD_ID_SENTINEL')&&fs.readdirSync(root).some(name=>name.startsWith('fence-')&&name.endsWith('.json')&&JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).dropContext&&JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).attempt>0);
      globalThis.__retainedOnly=thread=>configFor(thread).retainedOnly&&!(configFor(thread).attempt??0);
      globalThis.__finalLineage=(thread,turn,running)=>log('final-lineage',{thread,parents:turn.parents,roots:[...(running?.roots.roots??[])],sources:running?.sources});
      globalThis.__fenceNativeReplay=()=>fs.existsSync(path.join(root,'native-replay'));
      globalThis.__fenceMissingView=thread=>configFor(thread).missingView===true;
      globalThis.__fenceCrash=(thread,site)=>{
        if(configFor(thread).crashSite!==site||fs.existsSync(path.join(root,'crashed')))return;
        log('reset-disk',{thread,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});
        fs.writeFileSync(path.join(root,'crashed'),site);process.kill(process.pid,'SIGKILL');
      };

      // An inert reader tests omission at dispatch without granting recall authority.
      globalThis.__fenceMemoryMount=(thread,mounts)=>{
        if(!configFor(thread).memoryReader)return false;
        mounts.memory={command:process.execPath,args:[]};return true;
      };
      const builtRefs=new Map();globalThis.__fenceBuilt=(thread,refs)=>builtRefs.set(thread,refs);
      const {promptPart}=await import(${importUrl("server/memory/prompt-parts.ts")});
      globalThis.__fenceContext=input=>configFor(input.currentThreadId).dropContext&&!(configFor(input.currentThreadId).attempt??0)?{
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
      globalThis.__seedRouteHistory=thread=>{const cfg=configFor(thread),id=cfg.seedReplayUser?"ctx-route-replay":cfg.rebuildTier?"ctx-route-earlier":undefined;return route&&id&&!database().prepare("SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(thread,id)?id:undefined;};
      globalThis.__routeTier=thread=>route?(configFor(thread).rebuildTier??0):0;
      globalThis.__legacyCursor=thread=>configFor(thread).legacyCursor===true;
      globalThis.__seedVisible=thread=>configFor(thread).seedVisible===true&&!database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,'ctx-visible');
      globalThis.__seedPrivate=thread=>configFor(thread).seedPrivate===true&&!database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,'ctx-withheld');
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
      const {stopMemoryRevocation,memoryRevocationIdle}=await import(${importUrl("server/memory/memory-revocation.ts")});
      const {maintainRecallViewSlice}=await import(${importUrl("server/memory/recall-view.ts")});
      let frozenGraph=false;
      globalThis.__fenceUpkeepTick=()=>{if(frozenGraph)log('upkeep-after-freeze',{});};
      // Passive: which waits of the measured turn's bundle build found its view behind, and on what.
      globalThis.__fenceBundleWait=(projection,remaining)=>{
        if(!beforeQueue||!projection||Number(projection.watermark)>=Number(projection.latest))return;
        log('view-behind',{remaining,lag:Number(projection.latest)-Number(projection.watermark),kinds:database().prepare('SELECT kind FROM memory_recall_changes WHERE sequence>? ORDER BY sequence').all(Number(projection.watermark)).map(row=>String(row.kind))});
      };
      const queueSnapshot=()=>Object.fromEntries(['memory_revoke_jobs','memory_revoke_reached','memory_revoke_frontier'].map(table=>[table,database().prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));
      // Quiescence is read from the database, never only sampled inside the
      // checkpoint hook: a capture job's debt row lives from its completion
      // until its checkpoint publishes (jobs.ts / consolidate.ts).
      const memoryQuiet=()=>{
        const db=database();
        return {capture:Number(db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE stage='capture' AND status IN ('pending','leased','partial','deferred')").get().n),
          debt:Number(db.prepare("SELECT COUNT(*) n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").get().n)};
      };
      let lastStability;
      const logStability=()=>{const pending=memoryQuiet().capture;if(pending!==lastStability){lastStability=pending;log('capture-stability',{pending});}};
      globalThis.__fenceCheckpoint=(result)=>{
        log('checkpoints',result);
        lastStability=undefined;logStability();
      };
      const stabilityTimer=setInterval(logStability,25);stabilityTimer.unref();
      const recordGraph=()=>database().prepare("SELECT id,version,kind,text,state FROM memory_records ORDER BY id,version").all().map(({text,...row})=>({...row,textHash:createHash('sha256').update(String(text)).digest('hex')}));
      let beforeQueue,beforeRecordGraph; const terminalLogged=new Set();
      const driver=route?BUILT_IN_DRIVERS.find(driver=>driver.driverKind===route):makeLateTerminalDriver(),create=driver.create.bind(driver);
      driver.create=async input=>{
        const instance=await create(input),send=instance.adapter.sendTurn.bind(instance.adapter);
        // This driver is in-process: interrupt removes its active entry and
        // synchronously emits the terminal event, with no child left to close.
        const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
        if(!route)instance.adapter.interruptTurn=async(...args)=>{await interrupt(...args);return {closeConfirmed:true};};
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

          if(!cfg.backlog)await memoryRevocationIdle();
          if(cfg.backlog&&!attempt){
            globalThis.__fenceParkRevocation=true;stopMemoryRevocation();
            const db=database();db.exec('BEGIN IMMEDIATE');
            try{
              const cap=Number(db.prepare('SELECT next FROM memory_lsn WHERE id=1').get().next)+1;
              const insert=db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line','{}',1,?,'mark','','active')");
              const hold=db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
              for(let i=0;i<cfg.backlog;i++){insert.run(800001+i,cap);hold.run(800001+i);}
              // A real revoke commit changes the generation between build and submit.
              commitRevoke(db,{kind:'line',threadId:turn.threadId,messageIds:[],cause:'forget'});
              db.exec('COMMIT'); beforeQueue=queueSnapshot();beforeRecordGraph=recordGraph();resetDenyReadMeter();sqlWork.clear();sqlStacks.clear();
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
          log('attempts',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript,system:turn.system,resumed:turn.resumeCursor!==undefined,cursor:turn.resumeCursor,refs:builtRefs.get(turn.threadId),reset:turn.sessionReset,integrationKeys:Object.keys(turn.integrations??{}),threadRecall:turn.threadRecall===true,memory:turn.memoryContext!==undefined});
          const before=turn.beforeSubmit;
          turn.beforeSubmit=()=>{try { before?.(); } catch(error) { console.warn("fence fixture submission refused", error?.stack ?? error); throw error; } log('writes',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript,fallback:cfg.fallbackReplay?renderDriverReplay(turn.transcript??[],turn.replayMetadata):undefined,context:turn.memoryContext,system:turn.system,images:turn.images,integrationKeys:Object.keys(turn.integrations??{}),threadRecall:turn.threadRecall===true,memory:turn.memoryContext!==undefined,...beforeQueue?{queueBefore:beforeQueue,queueAfter:queueSnapshot(),work:denyReadMeter().statements,sqlWork:Object.fromEntries(sqlWork),sqlStacks:Object.fromEntries(sqlStacks),recordGraphBefore:beforeRecordGraph,recordGraphAfter:recordGraph()}:{}});if(cfg.releaseThenRefuse&&!attempt){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);turn.onEngineWrite?.();pending.set(turn.threadId,'pending');before?.();}if(cfg.crashAtWrite&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');}};
          if(cfg.crashAtRecovery&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){
            log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});
            fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');
          }
          return send(turn);
        };
        const subscribe=instance.adapter.onEvent.bind(instance.adapter);
        // Preserve the real host source; dropping it makes public text correctly refuse projection.
        instance.adapter.onEvent=listener=>subscribe((event,source)=>{
          listener(event,source);
          if(event.type==='item.completed'&&event.itemType==='assistant_text'&&!terminalLogged.has(event.eventId)){
            terminalLogged.add(event.eventId);
            log('terminal-replies',{thread:event.threadId,text:event.text});
            if(configFor(event.threadId).legacyCursor)log('legacy-lineage',{sessions:database().prepare('SELECT * FROM memory_session_lineage WHERE thread_id=?').all(event.threadId),lines:database().prepare('SELECT l.lsn,l.turn_lsn,m.id,m.role,m.json FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no JOIN messages m ON m.thread_id=t.thread_id AND m.id=l.message_id WHERE t.thread_id=? ORDER BY l.lsn DESC LIMIT 12').all(event.threadId)});
            globalThis.__fenceCrash(event.threadId,'after-output');
          }
        });
        return instance;
      };
      if(!route)BUILT_IN_DRIVERS.push(driver);
      const pre=path.join(root,'ready');fs.writeFileSync(pre,'');
      const file=path.join(root,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      const fake=route==='codex'?'fake-codex-app-server.ts':route==='customAcp'?'fake-acp-cli.ts':'fake-claude-cli.ts';
      let cli=new URL(${importUrl("server/testing/fake-claude-cli.ts")}).pathname.replace("fake-claude-cli.ts",fake);
      if(route){fs.chmodSync(cli,0o755);const {recordingCli}=await import(${importUrl("server/testing/transport-bytes.test-helper.ts")});cli=recordingCli(cli,root);}
      cfg.instances.fence={driver:route||'fakeLateTerminal',...(route?{config:{cli},environment:{FAKE_CLAUDE_MODE:'happy',FAKE_CLAUDE_DUMP:path.join(root,'wire-claude'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_DUMP_HISTORY:path.join(root,'wire-history'),FAKE_CODEX_WARM:'1',FAKE_CODEX_DUMP:path.join(root,'wire-codex'),FAKE_ACP_TEXT_ONLY:'1',FAKE_ACP_PROMPT_DUMP:path.join(root,'wire-acp')}}:{environment:{FAKE_LATE_DUMP:path.join(root,'wire-late'),FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_PRE_HANDBACK_GATE:pre}})};
      if (${JSON.stringify(task.name.includes('memory recovery retains authorized integrations'))}) cfg.instances.fence.environment.FAKE_LATE_MEMORY_MCP='1';
      fs.writeFileSync(file,JSON.stringify(cfg));
      // Quiescence witness holds. A held checkpoint returns the product's own
      // deferred outcome, so its debt row stays owed and the worker's debt
      // sweep pays it with the real checkpoint once the hold is lifted. A held
      // capture stops the real worker, so the turn's capture job stays open.
      globalThis.__fenceHoldCheckpoint=()=>fs.existsSync(path.join(root,'hold-checkpoint'));
      let captureHeld=false,captureMoving=false;
      const holdTimer=setInterval(()=>{
        const want=fs.existsSync(path.join(root,'hold-capture'));
        if(captureMoving||want===captureHeld)return;
        captureMoving=true;
        void Promise.resolve(want?globalThis.__pauseFenceMemory():globalThis.__resumeFenceMemory()).then(()=>{captureHeld=want;captureMoving=false;log('capture-hold',{held:want});});
      },10);holdTimer.unref();
      // Count comparisons get one quiescent production graph before either
      // backlog is introduced. No checkpoint implementation is replaced.
      let freezing=false;
      const freezeTimer=setInterval(()=>{
        if(freezing||!fs.existsSync(path.join(root,'freeze-memory')))return;
        freezing=true;
        let waited=false;
        const settled=()=>new Promise(resolve=>{const wait=setInterval(()=>{const q=memoryQuiet();if(!q.capture&&!q.debt){clearInterval(wait);resolve();}else if(!waited){waited=true;log('freeze-waiting',q);}},10);});
        void settled().then(()=>memoryRevocationIdle()).then(()=>globalThis.__pauseFenceMemory()).then(()=>{
          globalThis.__fenceParkRevocation=true;stopMemoryRevocation();
          const db=database();
          db.prepare("UPDATE memory_records SET owner_pinned=1 WHERE kind='checkpoint' AND state='active'").run();
          // Background view upkeep races the measured turn's first bundle wait
          // (one context per 50 ms tick). Bring every context's view to the
          // change log once, then park the timer: from here a view advances
          // only through the measured turn's own maintenance request.
          globalThis.__fenceParkRecallUpkeep=true;frozenGraph=true;
          // A context whose view is not ready (its authority moved with the
          // mode change) refuses upkeep exactly as it does on the timer; the
          // turn that needs it prepares it again. Only that refusal is skipped.
          const latest=()=>Number(db.prepare('SELECT coalesce(max(sequence),0) n FROM memory_recall_changes').get().n);
          let viewsBehind=0,viewsUnavailable=0;
          for(const view of db.prepare('SELECT c.view_id,c.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation').all()){
            try{
              let slices=0;
              while(!maintainRecallViewSlice({viewId:String(view.view_id),generation:String(view.generation),digest:String(view.digest)}))if(++slices>1000)throw new Error('fixture recall view did not settle');
              if(Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.view_id,view.generation).watermark)<latest())viewsBehind++;
            }catch(error){if(error?.message!=='MEMORY_RECALL_UNAVAILABLE')throw error;viewsUnavailable++;}
          }
          const counts=Object.fromEntries(db.prepare("SELECT kind||':'||state AS k,COUNT(*) AS n FROM memory_records GROUP BY 1 ORDER BY 1").all().map(row=>[row.k,Number(row.n)]));
          fs.writeFileSync(path.join(root,'memory-frozen'),JSON.stringify({...memoryQuiet(),viewsBehind,viewsUnavailable,records:counts}));
        }).catch(error=>{
          // A failed freeze is reported, never left to time out silently.
          fs.writeFileSync(path.join(root,'memory-frozen'),JSON.stringify({error:String(error?.message??error)}));
        });
      },10);freezeTimer.unref();
    ` }); await login();
    // Hold prompt refs constant for the operation-count comparison: automatic
    // learning from the warm-up reply must not publish extra refs mid-test.
    const memory = await api("GET", "/api/memory/status");
    await api("POST", "/api/memory/action", { action: "configure", learningRevision: memory.learning.revision, learning: { automaticFacts: false, automaticProcedures: false, learnFrom: { chats: false, channels: false } } });
    console.warn(`revokefence isolated fixture ${JSON.stringify(fixture.info)}`);
  }, 120000);
  afterEach(async ({ task }) => { if (fixture) { if(task.name.includes("CTX-"))console.warn("CTX captures "+JSON.stringify({attempts:rows("attempts"),writes:rows("writes"),legacy:rows("legacy-lineage")})); console.warn(`revokefence log ${fixture.info.logPath}\n${readFileSync(fixture.info.logPath, "utf8")}`); await fixture.close(); } });
  const make = async (room = false) => {
    const bot = (await api("POST", "/api/bots", { name: "Fence fixture", modelSelection: { instanceId: "fence", model: currentRoute === "claudeAgent" ? "claude-sonnet-5-5" : currentRoute === "codex" ? "gpt-6.1-sol" : currentRoute === "customAcp" ? "agent-default" : "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name: "Fence room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    return { bot, thread: group?.threadId ?? bot.threadId, route: group ? `/api/groups/${group.id}/messages` : `/api/bots/${bot.id}/messages` };
  };
  const finished = async (thread: string, want = 1) => {
    // Transcript GETs themselves run deny-read SQL. Observe the fake engine's
    // folded completion first so polling cannot pollute the foreground-work
    // counter between its reset and the actual transport write. Still prove
    // the completed reply was persisted through the real transcript API.
    await expect.poll(() => rows("terminal-replies").filter(row => row.thread === thread && row.text === "REVOKED_SENTINEL-" + thread).length >= want, { timeout: 60000 }).toBe(true);
    await expect.poll(async () => (await messages(thread)).filter(m => m.role === "bot" && m.kind === "text" && m.text === "REVOKED_SENTINEL-" + thread).length >= want, { timeout: 60000 }).toBe(true);
  };
  it("production capture creates and refreshes a derived checkpoint before a fenced continuation", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "First checkpoint owner evidence" });
    await finished(f.thread);
    await expect.poll(() => rows("checkpoints").filter(row => row.status === "updated").length, { timeout: 60000 }).toBeGreaterThan(0);
    const first = rows("checkpoints").filter(row => row.status === "updated").at(-1);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    await api("POST", f.route, { threadId: f.thread, text: "Second checkpoint owner evidence" });
    await finished(f.thread, 2);
    // consolidate.ts publishes each refresh as the family's next head record: same family, sequence + 1, version 1.
    const familyOf = (id: string) => id.slice(0, id.lastIndexOf(":")), sequenceOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
    await expect.poll(() => rows("checkpoints").some(row => row.status === "updated" && familyOf(row.checkpointId) === familyOf(first.checkpointId)
      && sequenceOf(row.checkpointId) === sequenceOf(first.checkpointId) + 1 && row.version === 1), { timeout: 60000 }).toBe(true);
    scenario(f.thread, { refusals: 1 });
    await api("POST", f.route, { threadId: f.thread, text: "Continue with the current checkpoint" });
    await finished(f.thread, 3);
    const attempts = rows("attempts").filter(row => row.thread === f.thread && row.text.includes("Continue with the current checkpoint"));
    expect(attempts).toHaveLength(2);
    expect(rows("writes").filter(row => row.thread === f.thread && row.text.includes("Continue with the current checkpoint"))).toHaveLength(1);
  }, 150000);
  // The freeze behind the R10/B4 count comparison must wait on the database,
  // not on a sampled counter: a completed capture whose checkpoint is still
  // owed shows zero open capture jobs, and a stopped worker shows no debt.
  it.each([["checkpoint debt", "hold-checkpoint", { capture: 0, debt: 3 }], ["open capture job", "hold-capture", { capture: 3, debt: 0 }]] as const)("fixture freeze waits for an outstanding %s", async (_name, hold, outstanding) => {
    const frozenFile = join(fixture.info.dataDir, "memory-frozen"), holdFile = join(fixture.info.dataDir, hold);
    await api("POST", "/api/memory/action", { action: "configure", mode: "capture" });
    const f = await make(); scenario(f.thread, { fixedGraph: true });
    writeFileSync(holdFile, "");
    if (hold === "hold-capture") await expect.poll(() => rows("capture-hold").at(-1)?.held, { timeout: 60000 }).toBe(true);
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    if (hold === "hold-checkpoint") {
      // The capture completes and its checkpoint is deferred: the counter the
      // old gate sampled reads zero while the debt row is still owed.
      await expect.poll(() => rows("checkpoints").filter(row => row.reason === "fixture-hold").length, { timeout: 60000 }).toBeGreaterThan(0);
      await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 60000 }).toBe(0);
    } else await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 60000 }).toBe(outstanding.capture);
    const updatedBefore = rows("checkpoints").filter(row => row.status === "updated").length;
    writeFileSync(join(fixture.info.dataDir, "freeze-memory"), "");
    await expect.poll(() => rows("freeze-waiting"), { timeout: 10000 }).toEqual([outstanding]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(existsSync(frozenFile)).toBe(false);
    expect(rows("freeze-waiting")).toEqual([outstanding]);
    rmSync(holdFile);
    await expect.poll(() => existsSync(frozenFile), { timeout: 60000 }).toBe(true);
    const frozen = JSON.parse(readFileSync(frozenFile, "utf8"));
    expect({ capture: frozen.capture, debt: frozen.debt }).toEqual({ capture: 0, debt: 0 });
    // The outstanding work was done by the real worker, not dropped.
    expect(rows("checkpoints").filter(row => row.status === "updated").length).toBeGreaterThan(updatedBefore);
    if (hold === "hold-capture") expect(rows("capture-hold").map(row => row.held)).toEqual([true, false]);
  }, 150000);
  it.each([10, 1000])("R10 direct owner turn with %i active jobs releases once without walking the queue", async backlog => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "capture" });
    const f = await make(); scenario(f.thread, { fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 60000 }).toBe(0);
    writeFileSync(join(fixture.info.dataDir, "freeze-memory"), "");
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "memory-frozen")), { timeout: 60000 }).toBe(true);
    const frozen = JSON.parse(readFileSync(join(fixture.info.dataDir, "memory-frozen"), "utf8"));
    expect({ capture: frozen.capture, debt: frozen.debt, viewsBehind: frozen.viewsBehind }).toEqual({ capture: 0, debt: 0, viewsBehind: 0 });
    pendingTurnFrozen.set(backlog, frozen.records);
    if (pendingTurnFrozen.size === 2) expect(pendingTurnFrozen.get(1000)).toEqual(pendingTurnFrozen.get(10));
    const queueBefore = rows("queue-calls").length;
    const notesBefore = new Set((await messages(f.thread)).filter(m => m.memoryNote === "without-memory").map(m => m.id));
    scenario(f.thread, { backlog, fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))).toHaveLength(1);
    expect(JSON.stringify(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")))).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")).length).toBeLessThanOrEqual(3);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    const release = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0];
    pendingTurnGraphs.set(backlog, { before: graphShape(release.recordGraphBefore), after: graphShape(release.recordGraphAfter) });
    expect(release.queueAfter).toEqual(release.queueBefore);
    console.warn("revokefence operation profile " + JSON.stringify({ backlog, work: release.work, sqlWork: release.sqlWork, sqlStacks: release.sqlStacks }));
    // No background upkeep ran on the frozen graph, and the measured turn's
    // bundle waits found the same lag whatever the backlog.
    expect(rows("upkeep-after-freeze")).toEqual([]);
    console.warn("revokefence view waits " + JSON.stringify({ backlog, frozen, behind: rows("view-behind") }));
    pendingTurnWaits.set(backlog, rows("view-behind"));
    if (pendingTurnWaits.size === 2) expect(pendingTurnWaits.get(1000)).toEqual(pendingTurnWaits.get(10));
    pendingTurnWork.set(backlog, release.work); pendingTurnSql.set(backlog, release.sqlWork);
    if (pendingTurnWork.size === 2) expect(pendingTurnWork.get(1000), JSON.stringify(Object.fromEntries(pendingTurnSql))).toBe(pendingTurnWork.get(10));
    if (pendingTurnGraphs.size === 2) expect(pendingTurnGraphs.get(1000)).toEqual(pendingTurnGraphs.get(10));
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !notesBefore.has(m.id))).toHaveLength(1);
  }, 90000);
  it.each([10, 1000])("B4 R11 room with %i jobs has constant operation count and no queue mutation", async backlog => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "capture" });
    const f = await make(true); scenario(f.thread, { fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 60000 }).toBe(0);
    writeFileSync(join(fixture.info.dataDir, "freeze-memory"), "");
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "memory-frozen")), { timeout: 60000 }).toBe(true);
    const frozen = JSON.parse(readFileSync(join(fixture.info.dataDir, "memory-frozen"), "utf8"));
    expect({ capture: frozen.capture, debt: frozen.debt, viewsBehind: frozen.viewsBehind }).toEqual({ capture: 0, debt: 0, viewsBehind: 0 });
    roomTurnFrozen.set(backlog, frozen.records);
    if (roomTurnFrozen.size === 2) expect(roomTurnFrozen.get(1000)).toEqual(roomTurnFrozen.get(10));
    const queueBefore = rows("queue-calls").length;
    const priorNotes = new Set((await messages(f.thread)).filter(m => m.memoryNote).map(m => m.id));
    scenario(f.thread, { backlog, fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    roomTurnGraphs.set(backlog, { before: graphShape(writes[0].recordGraphBefore), after: graphShape(writes[0].recordGraphAfter) });
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")).length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(writes[0].queueAfter).toEqual(writes[0].queueBefore);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    expect(rows("upkeep-after-freeze")).toEqual([]);
    console.warn("room view waits " + JSON.stringify({ backlog, frozen, behind: rows("view-behind") }));
    roomTurnWaits.set(backlog, rows("view-behind"));
    if (roomTurnWaits.size === 2) expect(roomTurnWaits.get(1000)).toEqual(roomTurnWaits.get(10));
    roomTurnWork.set(backlog, writes[0].work);
    console.warn("room operation profile " + JSON.stringify({ backlog, work: writes[0].work, sql: writes[0].sqlWork }));
    if (roomTurnWork.size === 2) expect(roomTurnWork.get(1000)).toBe(roomTurnWork.get(10));
    if (roomTurnGraphs.size === 2) expect(roomTurnGraphs.get(1000)).toEqual(roomTurnGraphs.get(10));
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
    expect(writes[0].text).toContain("RAW_HUMAN_INPUT"); expect(writes[0].text).not.toContain("EXPANDED_SECRET_SENTINEL"); expect(writes[0].text).not.toContain("ROOM_STORED_SENTINEL"); expect(writes[0].transcript ?? []).toEqual([]); expect(writes[0].memory).toBe(false); expect(writes[0].images).toBeUndefined();
    // MAIN RULING 2026-11-16T23:20Z S3B-Q2: the last rebuild (message-only) mounts no integrations at all, direct or room.
    expect(writes[0].integrationKeys).toEqual([]);
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

  it.each([false, true].flatMap(room => [1, 2].map(tier => ({ room, tier }))))("memory recovery retains authorized integrations (room=$room, tier=$tier)", async ({ room, tier }) => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make(room); scenario(f.thread, { memoryReader: true, refusals: tier, ...(tier === 1 ? { dropContext: true } : {}) });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread);
    const attempts = rows("attempts").filter(r => r.thread === f.thread);
    expect(attempts).toHaveLength(tier + 1);
    expect(attempts[0].integrationKeys).toContain("memory");
    const writes = rows("writes").filter(r => r.thread === f.thread);
    expect(writes).toHaveLength(1);
    // Tier 1 (a selective drop) keeps every authorized tool but memory. Tier 2 is the last rebuild, which mounts no integrations at all
    // (MAIN RULING 2026-11-16T23:20Z S3B-Q2: a thread or agents read would bring back the context the refusals concerned).
    if (tier === 1) expect(writes[0].integrationKeys).toContain("agents");
    else expect(writes[0].integrationKeys).toEqual([]);
    expect(writes[0].integrationKeys).not.toContain("memory");
    expect(writes[0].memory).toBe(false);
    expect(writes[0].threadRecall).toBe(false);
    expect(writes[0].system).toBe("");
    expect(writes[0].text).not.toContain("OMITTED_REMEMBERED_TEXT_SENTINEL");
    expect(writes[0].transcript ?? []).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory")).toHaveLength(1);
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toEqual([]);
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
  // ctx-rebuild: a recovery that resets the engine session must hand the new session the conversation, not only its latest message.
  const savedCursor = (f: { bot: { id: string }; thread: string }) => readBotRecords(fixture.info.dataDir).find(bot => bot.id === f.bot.id)?.tasks?.find(task => task.threadId === f.thread)?.resumeCursors.fence;
  const directIdle = async (f: { bot: { id: string }; thread: string }) => { await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true); };
  it.each(["active", "off"])("CTX-H1 a tier-one rebuild of a warm direct chat with memory %s replays the earlier conversation", async mode => {
    if (mode === "off") await api("POST", "/api/memory/action", { action: "configure", mode });
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await finished(f.thread); await directIdle(f);
    scenario(f.thread, { refusals: 1 });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0].resumed, "the refused turn must resume a warm session").toBe(true);
    expect(attempts[1].resumed).toBe(false);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    // the brand-new session is handed the earlier line as replayed conversation (not only as recalled memory) ahead of the latest message
    const text: string = writes[0].text, replayEnd = text.indexOf("[Now reply to the user's latest message:]");
    expect(replayEnd, "the rebuild must carry an inline replay").toBeGreaterThan(-1);
    expect(text.slice(0, replayEnd)).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    expect(text.slice(replayEnd)).toContain("RAW_HUMAN_INPUT");
  }, 90000);
  // With memory active the continuation check already ends an unconfirmed session; memory off has no such check, so only the unpublished
  // cursor keeps that thread from resuming a session that holds the recovery message alone.
  it.each([{ tier: 2, mode: "active", input: { refusals: 2 } }, { tier: 2, mode: "off", input: { refusals: 2 } }, { tier: 1, mode: "off", input: { refusals: 1, dropContext: true } }])("CTX-H2 the turn after a tier-$tier message-only recovery with memory $mode replays the conversation on a fresh session", async ({ mode, input }) => {
    if (mode === "off") await api("POST", "/api/memory/action", { action: "configure", mode });
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await finished(f.thread); await directIdle(f);
    scenario(f.thread, input);
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2); await directIdle(f);
    const recovery = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(recovery).toHaveLength(1);
    expect(recovery[0].text, "the recovery must actually go out message-only").not.toContain("EARLIER_CONVERSATION_LINE");
    expect(recovery[0].transcript ?? []).toEqual([]);
    expect(savedCursor(f), "a message-only dispatch must never publish its cursor").toBeUndefined();
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "NEXT_ORDINARY_TURN" }); await finished(f.thread, 3);
    const next = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("NEXT_ORDINARY_TURN"));
    expect(next).toHaveLength(1);
    expect(next[0].resumed, "the message-only session must not be resumed").toBe(false);
    const nextText: string = next[0].text, nextEnd = nextText.indexOf("[Now reply to the user's latest message:]");
    expect(nextEnd, "the next turn must carry an inline replay").toBeGreaterThan(-1);
    expect(nextText.slice(0, nextEnd)).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    expect(nextText.slice(0, nextEnd)).toMatch(/^User: .*RAW_HUMAN_INPUT/m);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("NEXT_ORDINARY_TURN"))).toHaveLength(1);
  }, 120000);

  it.each(["off", "paused", "capture"])("CTX-HEAL a persisted tier-two cursor heals once after restart with memory %s", async mode => {
    await api("POST", "/api/memory/action", { action: "configure", mode });
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await finished(f.thread); await directIdle(f);
    // Simulate the old saveCursor at the real fold, preserving its real session lineage and recovery note on disk.
    scenario(f.thread, { refusals: 2, legacyCursor: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2); await directIdle(f);
    await expect.poll(() => savedCursor(f)).toBeTruthy();
    const saved = savedCursor(f);
    expect(saved).toBeTruthy();
    expect((await messages(f.thread)).some(m => m.memoryNote === "without-memory" && m.tool?.name === "Murage prepared this reply from your message, with remembered context left out.")).toBe(true);
    scenario(f.thread, {});
    await fixture.restart(); await login();
    expect(savedCursor(f)).toEqual(saved);
    await api("POST", f.route, { threadId: f.thread, text: "HEALED_ORDINARY_TURN" }); await finished(f.thread, 3); await directIdle(f);
    const next = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("HEALED_ORDINARY_TURN"));
    expect(next).toHaveLength(1);
    expect(next[0].resumed, "legacy message-only cursor must heal on first use").toBe(false);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("HEALED_ORDINARY_TURN"));
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    expect(writes[0].text).toMatch(/^User: .*RAW_HUMAN_INPUT/m);
    expect(JSON.stringify(writes[0])).not.toContain("WITHHELD_CONVERSATION_LINE");
    // The old tier-two note must not poison the replacement session, whose own start contains the complete replay.
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "HEALTHY_CONTINUATION" }); await finished(f.thread, 4);
    const healthy = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("HEALTHY_CONTINUATION"));
    expect(healthy).toHaveLength(1);
    expect(healthy[0].resumed).toBe(true);
  }, 150000);
  it("CTX-HEAL keeps a healthy tier-one cursor after restart", async () => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await finished(f.thread); await directIdle(f);
    // A first rebuild carries history but uses the same left-out note as selective recovery: this cannot justify a heal.
    scenario(f.thread, { refusals: 1 });
    await api("POST", f.route, { threadId: f.thread, text: "HEALTHY_REBUILD" }); await finished(f.thread, 2); await directIdle(f);
    await expect.poll(() => savedCursor(f)).toBeTruthy();
    const saved = savedCursor(f);
    expect(saved).toBeTruthy();
    scenario(f.thread, {}); await fixture.restart(); await login();
    await api("POST", f.route, { threadId: f.thread, text: "HEALTHY_CONTINUATION" }); await finished(f.thread, 3);
    const next = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("HEALTHY_CONTINUATION"));
    expect(next).toHaveLength(1); expect(next[0].resumed).toBe(true); expect(next[0].cursor).toEqual(saved);
  }, 120000);

  const routeFinished = async (f: { bot: { id: string }; thread: string }, want: number) => {
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(want);
    await directIdle(f);
    expect((await messages(f.thread)).filter(m => m.role === "bot" && m.kind === "text" && m.id !== "ctx-withheld").length).toBeGreaterThanOrEqual(want);
  };
  it.each(["claudeAgent", "codex", "customAcp"])("CTX-ROUTE [%s] rebuilt history and message-only cursor suppression at the adapter write", async route => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f)).toBeTruthy();
    // Enter the production rebuild with its persisted triggering message.
    // Generic CTX-H1/H2 cover refusal orchestration; these cases use the real
    // adapters and scripted CLI transports, observing the actual prompt bytes.
    scenario(f.thread, { rebuildTier: 1 });
    await api("POST", f.route, { threadId: f.thread, text: "REBUILT_LATEST_LINE" }); await routeFinished(f, 2);
    const rebuilt = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("REBUILT_LATEST_LINE"));
    expect(rebuilt).toHaveLength(1); expect(rebuilt[0].resumed).toBe(false);
    expect(rebuilt[0].text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    const wire = () => {
      const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-" + (route === "claudeAgent" ? "claude" : route === "codex" ? "codex" : "acp")), "utf8"));
      return JSON.stringify(route === "claudeAgent" ? dump.prompt : route === "codex" ? dump.calls.filter((call: any) => call.method === "turn/start").at(-1)?.params.input : dump);
    };
    await expect.poll(wire).toContain("REBUILT_LATEST_LINE"); expect(wire()).toContain("EARLIER_CONVERSATION_LINE");
    // A separate thread exercises the message-only last-resort transport. Setup
    // seeds authorized history independently of each fake CLI's history import.
    const g = await make();
    scenario(g.thread, { rebuildTier: 2 });
    await api("POST", g.route, { threadId: g.thread, text: "MESSAGE_ONLY_LATEST" }); await routeFinished(g, 1);
    await expect.poll(wire).toContain("MESSAGE_ONLY_LATEST"); expect(wire()).not.toContain("EARLIER_CONVERSATION_LINE");
    const messageOnly = rows("attempts").filter(r => r.thread === g.thread && r.text.includes("MESSAGE_ONLY_LATEST")).at(-1)!;
    expect(messageOnly.text).not.toContain("EARLIER_CONVERSATION_LINE"); expect(messageOnly.transcript ?? []).toEqual([]);
    expect(savedCursor(g), "the real adapter's message-only session must never be published").toBeUndefined();
    scenario(g.thread, { seedReplayUser: true });
    await api("POST", g.route, { threadId: g.thread, text: "ROUTE_NEXT_ORDINARY" }); await routeFinished(g, 2);
    const next = rows("attempts").filter(r => r.thread === g.thread && r.text.includes("ROUTE_NEXT_ORDINARY"));
    expect(next).toHaveLength(1); expect(next[0].resumed).toBe(false);
    expect(next[0].text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    await expect.poll(wire).toContain("ROUTE_NEXT_ORDINARY"); expect(wire()).toContain("EARLIER_CONVERSATION_LINE");
  }, 180000);

  for (const route of [undefined,'claudeAgent','codex','customAcp'])
  it.each([{tier:1,heal:false},{tier:2,heal:false},{tier:2,heal:true}])(`CTX-PRIVACY${route ? ` ['${route}']` : ''} tier-$tier recovery, legacy heal $heal, keeps withheld conversation out of the next actual write`, async ({ tier, heal }) => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make();
    const done=async(count:number)=>{if(route)await routeFinished(f,count);else {await finished(f.thread,count);await directIdle(f);}};
    const wire=()=>{
      const dump=JSON.parse(readFileSync(join(fixture.info.dataDir,'wire-'+(route==='claudeAgent'?'claude':route==='codex'?'codex':'acp')),'utf8'));
      return JSON.stringify(route==='claudeAgent'?dump.prompt:route==='codex'?dump.calls.filter((call:any)=>call.method==='turn/start').at(-1)?.params.input:dump);
    };
    // Consume serialized frames from the CLI or fake transport's write sink, never the beforeSubmit observer.
    const frames=(marker:string)=>{
      const all=route==='claudeAgent'?rows('wire-history').map(row=>JSON.stringify(row.prompt))
        :route==='codex'?JSON.parse(readFileSync(join(fixture.info.dataDir,'wire-codex'),'utf8')).calls.filter((call:any)=>call.method==='turn/start').map((call:any)=>JSON.stringify(call.params.input))
        :route==='customAcp'?[readFileSync(join(fixture.info.dataDir,'wire-acp'),'utf8')]
        :rows('wire-late').filter(row=>row.prompt).map(row=>JSON.stringify(row.payload));
      return all.filter((frame:string)=>frame.includes(marker));
    };
    scenario(f.thread,{seedVisible:true,...(route?{seedReplayUser:true}:{})});
    await api("POST", f.route, { threadId: f.thread, text: "EARLIER_CONVERSATION_LINE" }); await done(1);
    await expect.poll(()=>frames('EARLIER_CONVERSATION_LINE').length).toBe(1);
    expect(frames('EARLIER_CONVERSATION_LINE')[0]).toContain('EARLIER_CONVERSATION_LINE');
    expect(frames('EARLIER_CONVERSATION_LINE')[0]).toContain('VISIBLE_CONVERSATION_LINE');
    if(route)await expect.poll(wire).toContain('EARLIER_CONVERSATION_LINE');
    scenario(f.thread, route?{rebuildTier:tier,legacyCursor:heal}:{refusals:tier,...(tier===1?{dropContext:true}:{}),legacyCursor:heal});
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await done(2);
    const recovered=rows("writes").filter(r=>r.thread===f.thread&&r.text.includes("RAW_HUMAN_INPUT"));
    expect(recovered).toHaveLength(1);
    if(!route||tier===2)expect(recovered[0].text).not.toContain("EARLIER_CONVERSATION_LINE");
    if(route){
      await expect.poll(wire).toContain('RAW_HUMAN_INPUT');
      if(tier===2)expect(wire()).not.toContain('EARLIER_CONVERSATION_LINE');
      else expect(wire()).toContain('EARLIER_CONVERSATION_LINE');
    }
    if (heal) { await expect.poll(() => savedCursor(f)).toBeTruthy(); await fixture.restart(); await login(); }
    // Add an independently withheld stored line before the subsequent replay.
    // Its write-time fence can rebuild again: count actual released writes.
    scenario(f.thread, { seedPrivate: true, ...(route?{seedReplayUser:true}:{}) });
    await api("POST", f.route, { threadId: f.thread, text: "PRIVACY_NEXT_ORDINARY" }); await done(3);
    const stored=await messages(f.thread);
    expect(stored.find(m => m.id === "ctx-withheld")?.text).toBe("WITHHELD_CONVERSATION_LINE");
    expect(stored.find(m=>m.id==='ctx-withheld')).toMatchObject({role:'bot',withheldFromBots:'forgotten'});
    expect(stored.find(m=>m.id==='ctx-visible')).toMatchObject({role:'bot',text:'VISIBLE_CONVERSATION_LINE'});
    expect(stored.find(m=>m.id==='ctx-visible')?.withheldFromBots).toBeUndefined();
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("PRIVACY_NEXT_ORDINARY"));
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toContain("PRIVACY_NEXT_ORDINARY");
    expect(JSON.stringify(writes[0])).not.toContain("WITHHELD_CONVERSATION_LINE");
    if(route){await expect.poll(wire).toContain('PRIVACY_NEXT_ORDINARY');expect(wire()).not.toContain('WITHHELD_CONVERSATION_LINE');}
    await expect.poll(()=>frames('PRIVACY_NEXT_ORDINARY').length).toBe(1);
    const delivered=frames('PRIVACY_NEXT_ORDINARY');
    expect(delivered).toHaveLength(1);
    // Message-only recovery may drop the whole earlier prefix; the current instruction must still be sent.
    expect(delivered[0]).toContain('PRIVACY_NEXT_ORDINARY');
    expect(delivered.join('\n')).not.toContain('WITHHELD_CONVERSATION_LINE');
    if(route){
      const received=readFileSync(join(fixture.info.dataDir,'wire-bytes'),'utf8');
      expect(received).toContain('PRIVACY_NEXT_ORDINARY');
      expect(received).toContain('VISIBLE_CONVERSATION_LINE');
      expect(received).not.toContain('WITHHELD_CONVERSATION_LINE');
    }
  }, 150000);

});
