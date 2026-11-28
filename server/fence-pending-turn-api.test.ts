// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Every server is control-murage's isolated fake-engine fixture. Hooks only
// observe production boundaries or inject deterministic pre-write refusals.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_REFERENCE_PREAMBLE } from "../shared/memory.ts";
import { readBotRecords } from "./bot-turn-state.ts";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
// The real background-admission producer requires its native meter in every fixture child.
import { prepareMemoryMeterFixture } from "./memory/testing/native-meter-fixture.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";
beforeAll(() => prepareMemoryMeterFixture(process.env.HOME!));
const pendingTurnWork = new Map<number, number>();
const pendingTurnSql = new Map<number, unknown>();
const roomTurnWork = new Map<number, number>();
const roomAdmittedWork = new Map<number, number>();
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

/** Cases whose pending check never settles in the fixture (its backlog is parked): the owner's turn continues at the wait's deadline (MAIN
 * ruling C1 + MAIN Q2: the exact wait does no foreground work, so only the deadline ends it). They run with a 200 ms bound instead of
 * the shipped 65 s; the bound changes how long the case takes, not what it asserts. */
/** cause 25 (TRIAGE-GROK-SPEED-1122): GROKFENCE cases keep the shipped 65 s bound but run the pending wait on a fake clock: each poll sleep
 * advances the clock by its own length and yields at once, so a wait to the deadline logs ms=65000 in seconds of real time. The logged
 * fake ms is how long the turn waited for its check before its engine was spawned. */
const fakeFenceClock = (name: string) => name.startsWith("GROKFENCE");
const shortPendingWait = (name: string) => /owner continues after pending prefix deadline|R10 direct owner turn with|B4 R11 room with|B4 M8 retained|native replay accounts for fallback transcript|R11 a room without its rendered view|Q1 kept for outside input|T3 /.test(name);
describe("pending fence turns in an isolated server", () => {
  beforeEach(async ({ task }) => {
    const route = task.name.match(/\['?(claudeAgent|codex|customAcp|fuigoAgent|grokAgent)'?\]/)?.[1];
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
          // Park only the background upkeep once the graph is frozen. A
          // turn's own maintenance request (requestRecallViewMaintenance) stays real.
          // memv2 lane A: the upkeep is no longer a 50 ms timer. The views are kept current by the applier and the reclaimer by the
          // upkeep look, both run by a wake (server/memory/wake.ts). "Parked" must mean the same as before, no background view upkeep
          // at all, so both runs are parked by the same flag; a parked run arms nothing and the next wake asks again.
          const source=fs.readFileSync(new URL(url),'utf8'),anchor='function runRecallUpkeep(): void {'+String.fromCharCode(10)+'  if(!applierOn)return;';
          if(source.split(anchor).length!==2)throw new Error('missing recall upkeep anchor');
          const applier='function runRecallApplier(_context?: unknown,force=false): void {'+String.fromCharCode(10)+'  if(!applierOn)return;';
          if(source.split(applier).length!==2)throw new Error('missing recall applier anchor');
          return {format:'module-typescript',shortCircuit:true,source:source.replace(applier,applier+' if(globalThis.__fenceParkRecallUpkeep)return;').replace(anchor,anchor+' if(globalThis.__fenceParkRecallUpkeep)return; globalThis.__fenceUpkeepTick?.();')};
        }
        if(url.endsWith('/memory/fence-pending.ts') && ${JSON.stringify(shortPendingWait(task.name))}){
          // Both waits (settleRefusedFence and MAIN Q2's awaitExactPendingCheck, the one index.ts binds) take the short bound.
          const source=fs.readFileSync(new URL(url),'utf8'),anchor='maxMs = PENDING_FENCE_WAIT_MS';
          if(source.split(anchor).length!==3)throw new Error('missing pending wait anchors');
          return {format:'module-typescript',shortCircuit:true,source:source.replaceAll(anchor,'maxMs = 200')};
        }
        if(url.endsWith('/memory/fence-pending.ts') && ${JSON.stringify(fakeFenceClock(task.name))}){
          const source=fs.readFileSync(new URL(url),'utf8');
          // memv2 V14 (MAIN-PICK memv2-I 70af151c66): the wait no longer polls on setTimeout(resolve); the clock it measures is performance.now()
          if(source.split('performance.now()').length<3)throw new Error('missing pending wait clock anchors');
          return {format:'module-typescript',shortCircuit:true,source:'const fakeFenceClock={now:0};const performance={now:()=>fakeFenceClock.now};const setTimeout=(fn,ms)=>{fakeFenceClock.now+=ms;return globalThis.setImmediate(fn);};\\n'+source};
        }
        if(url.endsWith('/memory/revoke-marker.ts') && ${JSON.stringify(task.name.includes('FORGETRACE'))}){
          // FORGETRACE: every marker step (runner, background drain, inline closes) idles while the runner is parked, so a forget committed
          // then stays pending through the owner's next turn however the server would walk it; unparked, it walks for real.
          const source=fs.readFileSync(new URL(url),'utf8'),anchor='function detailedSlice(db: DatabaseSync, rows: number, ms: number, late: LateBuild | null, maxChanges: number, opts: MarkerSliceOptions, prune: boolean): MarkerSliceOutcome {';
          if(source.split(anchor).length!==2)throw new Error('missing marker slice anchor');
          return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,anchor+" if(globalThis.__fenceParkMarker)return {outcome:'idle'};")};
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
          source=source.replace('export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void {','export function wakeMemoryRevocation(getDb: () => DatabaseSync, next?: RevocationRunnerOptions, resume = next !== undefined): void { if(globalThis.__fenceParkRevocation)return;');
          // FORGETRACE: the bounded drain (upgrade/background steps) is parked with the runner
          // (FORGETRACE tasks only: the backlog scenarios set __fenceParkRevocation too and keep the real bounded drain)
          if(${JSON.stringify(task.name.includes('FORGETRACE'))})source=source.replace('export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean {','export function drainRevokeMarkerBounded(db: DatabaseSync, budget: { rows: number; ms: number } = SEND_FENCE_DRAIN, options: { background?: boolean } = {}): boolean { if(globalThis.__fenceParkRevocation)return false;');
          return {format:'module-typescript',shortCircuit:true,source};
        }
        if(url.endsWith('/testing/fake-late-terminal-driver.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replaceAll('text: "Hello from late"', "text: 'REVOKED_SENTINEL-' + turn.threadId").replaceAll('{ prompt: true, turnId', '{ prompt: true, payload: {text:turn.text,transcript:turn.transcript,system:turn.system,memoryContext:turn.memoryContext,images:turn.images}, turnId').replace('if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") beforeHandback();', 'if (!twoFences && input.environment.FAKE_LATE_UNKNOWN_ACTION !== "1") { beforeHandback(); if(dump)appendFileSync(dump,JSON.stringify({prompt:true,payload:{text:turn.text,transcript:turn.transcript,system:turn.system,memoryContext:turn.memoryContext,images:turn.images},turnId,threadId:turn.threadId})+String.fromCharCode(10)); }').replaceAll('emit({ type: "item.completed", itemType: "assistant_text"', 'turn.onEngineWrite?.(); emit({ type: "item.completed", itemType: "assistant_text"')};
        if(url.endsWith('/server/turn-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  return driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);','  return globalThis.__fenceNativeReplay?.() || driverKind === "museCode" || TRANSCRIPT_REPLAY_DRIVER_KINDS.includes(driverKind);')};
        if(url.endsWith('/server/working-context.ts'))return {format:'module-typescript',shortCircuit:true,source:fs.readFileSync(new URL(url),'utf8').replace('  let quoted: WorkingContextQuote[] = [];', '  input = globalThis.__fenceWorking?.(input) ?? input; let quoted: WorkingContextQuote[] = [];').replace('  return { text, quoted: text ? quoted : [], part:', '  const fixtureContext=globalThis.__fenceContext?.(input); if(fixtureContext)return fixtureContext; return { text, quoted: text ? quoted : [], part:')};
        if(url.endsWith('/server/ledger-refusal.ts')){
          // Passive: every "not launched" close of a refused lease (REVIEW H1 negative witness).
          const source=fs.readFileSync(new URL(url),'utf8'),anchor='    admissionNotLaunched(notice?: NativeTurnNoticeCode): void {';
          if(source.split(anchor).length!==2)throw new Error('missing not-launched observer anchor');
          return {format:'module-typescript',shortCircuit:true,source:source.replace(anchor,anchor+' globalThis.__fenceNotLaunched?.();')};
        }
        if(!url.endsWith('/server/index.ts'))return next(url,context);
        let source=fs.readFileSync(new URL(url),'utf8');
        source=source.replace('  const trace = beginTurnTrace(threadId);', '  if(globalThis.__seedFullFixtureHistory?.(threadId)){for(let i=0;i<60;i++)store.appendMessage(threadId,{id:"wm-history-"+i,role:"user",kind:"text",text:"Seeded exchange "+String(i).padStart(2,"0")});} const fixtureQuoted=globalThis.__seedQuotingLine?.(threadId); if(fixtureQuoted)store.appendMessage(threadId,{id:"wm-quoting",role:"user",kind:"text",text:"Fixture quoting line",replyToId:fixtureQuoted}); const fixtureTier=globalThis.__routeTier?.(threadId),historyId=globalThis.__seedRouteHistory?.(threadId); if(historyId)store.appendMessage(threadId,{id:historyId,role:"user",kind:"text",text:"EARLIER_CONVERSATION_LINE"}); if(fixtureTier){const fixtureMessage=store.appendMessage(threadId,{role:"user",kind:"text",text});opts={...opts,memoryRedispatch:fixtureTier,userMessage:fixtureMessage};} if(globalThis.__seedVisible?.(threadId)){store.appendMessage(threadId,{id:"ctx-visible",role:"bot",kind:"text",text:"VISIBLE_CONVERSATION_LINE",at:Date.now(),from:{botId,name:"fixture",color:"blue"}});} if(globalThis.__seedPrivate?.(threadId)){store.appendMessage(threadId,{id:"ctx-withheld",role:"bot",kind:"text",text:"WITHHELD_CONVERSATION_LINE",at:Date.now(),withheldFromBots:"forgotten",from:{botId,name:"fixture",color:"blue"}});} const trace = beginTurnTrace(threadId);');
        { const wait='    if (!projection || Number(projection.watermark) >= Number(projection.latest)) {'; if(source.split(wait).length!==2)throw new Error('missing bundle wait observer anchor'); source=source.replace(wait,'    globalThis.__fenceBundleWait?.(projection,remaining);'+wait); }
        { // A routine run handed to startTurn as webhook-triggered (outside input) when its scenario says so; a real webhook needs the ingress stack.
          const hand='startTurn(botId, prompt, { threadId, runOn, automationSource: triggerSource, onDispatchError'; if(source.split(hand).length!==2)throw new Error('missing routine hand-off anchor');
          source=source.replace(hand,'startTurn(botId, prompt, { threadId, runOn, automationSource: globalThis.__outsideTrigger?.(threadId) ? "webhook" : triggerSource, onDispatchError'); }
        { // T3: a revoke window that never settles (the live start-up storm) appears just before the direct turn's continuation check.
          const early='    let earlyContinuityKey: string | undefined;'; if(source.split(early).length!==2)throw new Error('missing continuation check anchor');
          source=source.replace(early,'    const stormSettlement=globalThis.__fenceSettle?.(threadId); if(stormSettlement)await stormSettlement; globalThis.__fenceStorm?.(threadId);'+early); }
        { // T3 guard: a direct turn on the bot's own thread handed in as webhook-triggered (outside input), when its scenario says so.
          const entry='  const threadId = opts?.threadId ?? defaultThreadId(profile);'; if(source.split(entry).length!==2)throw new Error('missing turn entry anchor');
          source=source.replace(entry,entry+' if(globalThis.__outsideDirect?.(threadId))opts={...opts,automationSource:"webhook"};'); }
        { const judge='      let lastResortReplay = false;\\n'; if(source.split(judge).length!==2)throw new Error('missing last-resort judge anchor'); source=source.replace(judge,'      await globalThis.__fenceHoldJudge?.(threadId, memoryLastResort);\\n'+judge); }
        { // IMGREAD: a room turn whose words nobody proved were the owner's (as an unproven origin is), when its scenario says so.
          const audience='  const roomOwnerAudience = turnAudienceIsOwner(threadId, { origin: latestUser?.origin })'; if(source.split(audience).length!==2)throw new Error('missing room audience anchor');
          source=source.replace(audience,'  const roomOwnerAudience = !globalThis.__roomUnproven?.(threadId) && turnAudienceIsOwner(threadId, { origin: latestUser?.origin })'); }
        { // cause 25: the field Grok thread holds no resume cursor (so nothing can be kept), when its scenario says so.
          const cursor='  let resumeCursor = resume ? task.resumeCursors[instanceId] : undefined;'; if(source.split(cursor).length!==2)throw new Error('missing resume cursor anchor');
          source=source.replace(cursor,'  let resumeCursor = resume && !globalThis.__noResume?.(threadId) ? task.resumeCursors[instanceId] : undefined;'); }
        source=source.replace('const memoryLastResort = (opts?.memoryRedispatch', 'const memoryLastResort = globalThis.__routeTier?.(threadId)===2 || (opts?.memoryRedispatch');
        source=source.replace('if (rootsApply && isMessageOnlyDispatch(lineage)) return;', 'if (rootsApply && isMessageOnlyDispatch(lineage) && !globalThis.__legacyCursor?.(event.threadId)) return;');
        source=source.replace('recordDefaultLearningConnection(database(),memoryExtractorInstanceId(),Boolean(fluxKey()));','globalThis.__pauseFenceMemory=()=>memoryWorker.stop(); globalThis.__resumeFenceMemory=()=>memoryWorker.start(); recordDefaultLearningConnection(database(),memoryExtractorInstanceId(),Boolean(fluxKey()));');
        // 1.0.24 q1024-forgetracerace (FRICTION F20): the notice write and release layer is deleted (no "persist"/"append" site, no
        // before-note/after-note crash site); boot still reads and scans the files an older build left, and those two sites fault.
        { const read='const notice = JSON.parse(readFileSync(file, "utf8"))'; if(source.split(read).length!==2)throw new Error('missing notice read anchor'); source=source.replace(read,'globalThis.__noticeFail?.("read"); '+read); const tipAppend='else store.appendMessage(notice.threadId, murageLine({ role: "bot", kind: "activity", ...turnId,', baseAppend='  const previous = store.messageById(notice.threadId, notice.id);', append=source.includes(tipAppend)?tipAppend:baseAppend; if(source.split(append).length!==2)throw new Error('missing notice append anchor'); source=source.replace(append,append===tipAppend?'else globalThis.__noticeFail?.("append"), store.appendMessage(notice.threadId, murageLine({ role: "bot", kind: "activity", ...turnId,':'  globalThis.__noticeFail?.("append"); '+baseAppend); }
        source=source.replace('fenceNoticeCursor = opendirSync(fenceNoticeDirectory);','globalThis.__noticeFail?.("scan"); fenceNoticeCursor = opendirSync(fenceNoticeDirectory);');
        source=source.replace('      let sessionLastLsn: number | null = null;','      if(globalThis.__retainedOnly?.(threadId))transcript=[]; let sessionLastLsn: number | null = null;');
        source=source.replace('        prompt: directPrompt,','        prompt: (globalThis.__finalLineage?.(threadId, turnLineage, turnOutputRoots.get(threadId)), directPrompt),');
        source=source.replace('        prompt: roomPrompt,','        prompt: (globalThis.__finalLineage?.(threadId, roomTurnLineage, turnOutputRoots.get(threadId)), roomPrompt),');
        source=source.replaceAll('text: turnPrompt','text: turnPrompt + '+JSON.stringify(String.fromCharCode(10)+'EXPANDED_SECRET_SENTINEL')).replaceAll('text:turnPrompt','text:turnPrompt + '+JSON.stringify(String.fromCharCode(10)+'EXPANDED_SECRET_SENTINEL'));
        source=source.replace('function commitFenceReset(botId: string, threadId: string, instanceId: string, cursor: unknown, incarnation: number | undefined): void {', 'function commitFenceReset(botId: string, threadId: string, instanceId: string, cursor: unknown, incarnation: number | undefined): void { globalThis.__fenceCrash?.(threadId,"before-reset");');
        source=source.replace('      let selectiveDropped = false;', '      if(globalThis.__fenceMemoryMount?.(threadId,integrations))threadRecallOn=true; let selectiveDropped = false;');
        source=source.replace('      let roomSelectiveDropped = false;', '      globalThis.__fenceMemoryMount?.(threadId,integrations); let roomSelectiveDropped = false;');
        source=source.replace('      let roomShownRefs: LineageRef[] = [];','      if(globalThis.__fenceMissingView?.(threadId))roomRenderedView=undefined; let roomShownRefs: LineageRef[] = [];');
        source=source.replace('      const roomRawHumanText =','      globalThis.__fenceBuilt?.(threadId, roomPrompt.parts.flatMap(part=>part.lineageOf)); const roomRawHumanText =');
        source=source.replace('      const rawHumanText =', '      globalThis.__fenceBuilt?.(threadId, directPrompt.parts.flatMap(part=>part.lineageOf)); const rawHumanText =');
        for(const name of ['Direct','Room']){
          const validate=source.includes('submissionBoundary.beforeSubmit(validate'+name+'Write)')?'validate'+name+'Write':'validate'+name+'Submission';
          const anchor='submissionBoundary.beforeSubmit('+validate+')';
          if(source.split(anchor).length!==2)throw new Error('missing submission anchor '+validate);
          // cause 25 setupRefuse: after the real validator passes, the never-settling window lands and the production send fence reads the
          // turn's own built prompt (direct only), inside the same boundary, so its refusal is the boundary's own (rebuildable, unwritten).
          source=source.replace(anchor,'submissionBoundary.beforeSubmit(() => { globalThis.__fenceRefuse?.(threadId); '+validate+'(); '+(name==='Direct'?'globalThis.__fenceSetupRefuse?.(threadId,directPrompt); ':'')+'})');
        }
        return {format:'module-typescript',shortCircuit:true,source};
      }});
      globalThis.__fenceQueueCall=name=>log('queue-calls',{name});
      globalThis.__fenceNotLaunched=()=>log('not-launched',{});
      const configFor=thread=>{const file=path.join(root,'fence-'+thread+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}};
      globalThis.__noticeFail=site=>{
        const file=path.join(root,'notice-faults');if(!fs.existsSync(file))return;
        const cfg=JSON.parse(fs.readFileSync(file,'utf8'));if(cfg.site!==site||cfg.left<=0)return;
        cfg.left--;fs.writeFileSync(file,JSON.stringify(cfg));log('notice-fault-attempts',{site});throw new Error('PRIVATE_NOTICE_FAILURE_SENTINEL');
      };
      globalThis.__dropContext=refs=>refs.some(ref=>ref.kind==='line'&&ref.threadId==='OMITTED_THREAD_ID_SENTINEL')&&fs.readdirSync(root).some(name=>name.startsWith('fence-')&&name.endsWith('.json')&&JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).dropContext&&JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).attempt>0);
      globalThis.__retainedOnly=thread=>configFor(thread).retainedOnly&&!(configFor(thread).attempt??0);
      globalThis.__outsideTrigger=thread=>configFor(thread).outsideTrigger===true;
      globalThis.__noResume=thread=>configFor(thread).noResume===true;
      globalThis.__outsideDirect=thread=>configFor(thread).outsideDirect===true;
      globalThis.__roomUnproven=thread=>configFor(thread).roomUnproven===true;
      // T3 storm: a bulk revoke seed still waiting for background admission (it cannot be walked, so no hurry settles it) holds a
      // pending window over the whole thread. settledDeny also marks the retained session itself denied (a settled revoke).
      globalThis.__fenceStorm=thread=>{
        const file=path.join(root,'fence-'+thread+'.json'),cfg=configFor(thread);if(!cfg.storm||cfg.stormed)return;
        cfg.stormed=true;fs.writeFileSync(file,JSON.stringify(cfg));
        const db=database();db.exec('BEGIN IMMEDIATE');
        try{
          const id=openBulkRevoke(db,'fixture-storm',false);
          const since=cfg.stormSince ? db.prepare('SELECT l.lsn FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id=? AND l.message_id=?').get(thread,cfg.stormSince).lsn : 1;
          db.prepare('INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)').run(thread,since,id);
          const key=db.prepare('SELECT * FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1').get(thread);
          if(cfg.settledDeny)db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,999998)').run(key.thread_id,key.driver_instance,key.native_session);
          db.exec('COMMIT');
          log('storm',{thread,session:Boolean(key)});
        }catch(error){db.exec('ROLLBACK');throw error;}
        db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
      };
      // Seeded once per thread: a refused turn's rebuilds enter startTurn again and must find the same history.
      const seeded=(thread,id)=>!!database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,id);
      globalThis.__seedFullFixtureHistory=thread=>configFor(thread).fullFixtureHistory===true&&!seeded(thread,'wm-history-0');
      globalThis.__seedQuotingLine=thread=>seeded(thread,'wm-quoting')?undefined:configFor(thread).seedQuoting;
      // WM-Q1/WM-Q2: every build reports whether the production gate (takeLastResort) made it the last resort; observed, never set.
      // WM-Q2: the last resort waits after render and before it judges its recent window.
      globalThis.__fenceHoldJudge=async (thread,lastResort)=>{log('judge-entry',{thread,lastResort});if(!configFor(thread).holdBeforeJudge||!lastResort)return;log('held-before-judge',{thread});const gate=path.join(root,'judge-'+thread);while(!fs.existsSync(gate))await new Promise(resolve=>setTimeout(resolve,50));};
      globalThis.__fenceSettle=thread=>{
        if(!configFor(thread).settleStorm)return;
        const db=database();
        const hold=db.prepare("SELECT p.revoke_id FROM memory_deny_pending p JOIN memory_revoke_jobs j USING(revoke_id) WHERE p.thread_id=? AND j.kind='bulk' AND j.state='seeding'").get(thread);
        if(!hold)throw new Error('fixture has no pending bulk check to settle');
        activateBulkRevoke(db,Number(hold.revoke_id));
        return settleRevokesForTurn(db,3000).then(()=>log('settled-storm',{thread,held:!!db.prepare('SELECT 1 FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?').get(thread,hold.revoke_id)}));
      };
      // USERBUG-SEALED-W1: the same never-settling window, opened MID-TURN (after the owner's prompt was written, so the turn already holds
      // its context) when the test drops the storm-late-flag file naming the thread (logged once to storm-late).
      const lateStorm=setInterval(()=>{
        const flag=path.join(root,'storm-late-flag');if(!fs.existsSync(flag))return;
        const thread=fs.readFileSync(flag,'utf8').trim();fs.rmSync(flag);
        const db=database();db.exec('BEGIN IMMEDIATE');
        try{const id=openBulkRevoke(db,'fixture-storm',false);db.prepare('INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,1,?)').run(thread,id);db.exec('COMMIT');}
        catch(error){db.exec('ROLLBACK');throw error;}
        db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
        log('storm-late',{thread});
      },50);lateStorm.unref();
      globalThis.__finalLineage=(thread,turn,running)=>log('final-lineage',{thread,parents:turn.parents,roots:[...(running?.roots.roots??[])],sources:running?.sources});
      globalThis.__fenceNativeReplay=()=>fs.existsSync(path.join(root,'native-replay'));
      globalThis.__fenceMissingView=thread=>configFor(thread).missingView===true;
      globalThis.__fenceCrash=(thread,site,file)=>{
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
      globalThis.__seedRouteHistory=thread=>{const cfg=configFor(thread),id=cfg.seedReplayUser?"ctx-route-replay":cfg.rebuildTier&&!cfg.noReplaySeed?"ctx-route-earlier":undefined;return route&&id&&!database().prepare("SELECT 1 FROM messages WHERE thread_id=? AND id=?").get(thread,id)?id:undefined;};
      // Every non-zero tier this harness hands to the server (the :112 redispatch injection and the :124 last-resort rewrite both read it) is logged as a route-tier-served row.
      globalThis.__routeTier=thread=>{const tier=route?(configFor(thread).rebuildTier??0):0;if(tier)log('route-tier-served',{thread,tier});return tier;};
      globalThis.__legacyCursor=thread=>configFor(thread).legacyCursor===true;
      globalThis.__seedVisible=thread=>configFor(thread).seedVisible===true&&!database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,'ctx-visible');
      globalThis.__seedPrivate=thread=>configFor(thread).seedPrivate===true&&!database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(thread,'ctx-withheld');
      const pending=new Map();
      globalThis.__fenceRefuse=thread=>{
        const kind=pending.get(thread);pending.delete(thread);
        if(kind){
          // A pending verdict now has an exact recovery obligation. Use the
          // production fence over a durable runnable job, rather than inventing
          // a verdict with no check that could ever settle.
          const db=database();db.exec('BEGIN IMMEDIATE');
          let id;
          const delay=configFor(thread).pendingDelay??0;
          try{id=openBulkRevoke(db,'fixture-pending',false);db.prepare('INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,1,?)').run(thread,id);if(!delay&&!configFor(thread).pendingDeadline)activateBulkRevoke(db,id);db.exec('COMMIT');}
          catch(error){db.exec('ROLLBACK');throw error;}
          if(configFor(thread).pendingDeadline){
            // A bulk seed still waiting for background admission cannot be walked.
            db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
            log('pending-checks',{thread,phase:'owed',at:Date.now()});
            return; // The actual dispatch prompt must hit the send fence.
          }
          if(delay){log('pending-checks',{thread,phase:'owed',at:Date.now()});setTimeout(()=>{activateBulkRevoke(db,id);log('pending-checks',{thread,phase:'runnable',at:Date.now()});},delay);}
          const head=Number(db.prepare('SELECT next FROM memory_lsn WHERE id=1').get().next);
          try{assertSendFence(buildPrompt(undefined,[promptPart('fixture carried prefix',[{kind:'prefix',threadId:thread,headLsn:head}])]),{audience:null},db);}
          catch(error){
            // cause 25: an owner turn no longer waits for the runner to close this check (it reads the verdict once and starts). These
            // scenarios pin the rebuild AFTER a check that settled, so the check closes here, between the refusal and that one read. A check
            // still open at the read is the cause 25 case (pendingDeadline); one that closes later is pendingDelay. Non-owner turns still wait for the runner.
            if(!delay&&!['outsideDirect','outsideTrigger','roomUnproven'].some(k=>configFor(thread)[k]))db.prepare('DELETE FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?').run(thread,id);
            throw error;
          }
          throw Error('fixture pending job did not refuse');
        }
      };
      // cause 25 setupRefuse (the field Grok shape): the thread's check is stuck checking:pending when the owner's prompt reaches the send
      // fence at setup. The window opens once, after the server's validator (so the prepared disclosure still holds, as on the field thread),
      // then the production fence reads the server's own built prompt and refuses checking:pending.
      globalThis.__fenceSetupRefuse=(thread,prompt)=>{
        const file=path.join(root,'fence-'+thread+'.json'),cfg=configFor(thread);if(!cfg.setupRefuse||cfg.setupRefused)return;
        cfg.setupRefused=true;fs.writeFileSync(file,JSON.stringify(cfg));
        pending.set(thread,'pending');globalThis.__fenceRefuse(thread);
        assertSendFence(prompt,{audience:null},database());
        throw Error('fixture setup fence did not refuse');
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
      const {commitRevoke,openBulkRevoke,activateBulkRevoke}=await import(${importUrl("server/memory/revoke-commit.ts")});
      const {assertSendFence}=await import(${importUrl("server/memory/send-fence.ts")});
      const {buildPrompt}=await import(${importUrl("server/memory/prompt-parts.ts")});
      const {markTurnOutside}=await import(${importUrl("server/email/external-marks.ts")});
      const {stopMemoryRevocation,memoryRevocationIdle,settleRevokesForTurn,wakeMemoryRevocation}=await import(${importUrl("server/memory/memory-revocation.ts")});
      const {maintainRecallViewSlice,setRecallBuildPaceForTest}=await import(${importUrl("server/memory/recall-view.ts")});
      // R11 (q1023-scalefin2): the measured room turn is the first to ask for the room's recall view. Whether that view was built
      // inside the turn's 300 ms wait decided between two different turns (admitted to recall, or held), whatever the backlog. The
      // case closes the build pace so no view is built: the turn is held at both sizes, the path this row measured before 1.0.22.
      // A pace below any refill never admits a build (recall-view.ts buildAdmitted); the pace's own witnesses are upgrade-catchup-1022.
      const paceTimer=setInterval(()=>{if(!fs.existsSync(path.join(root,'close-recall-pace')))return;clearInterval(paceTimer);setRecallBuildPaceForTest(-Infinity);log('recall-pace-closed',{});},10);paceTimer.unref();
      // R11b: the opposite closing, so the recall view of the room is built whatever the machine's load (buildAdmitted: Infinity admits every build).
      const openTimer=setInterval(()=>{if(!fs.existsSync(path.join(root,'open-recall-pace')))return;clearInterval(openTimer);setRecallBuildPaceForTest(Infinity);log('recall-pace-opened',{});},10);openTimer.unref();
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
        if (${JSON.stringify(task.name.includes("WM-D4"))}) instance.adapter.interruptTurn=async (...args)=>{
          const receipt=await interrupt(...args);
          log('stop-close',{thread:args[0],confirmed:receipt?.closeConfirmed===true});
          return receipt;
        };
        instance.adapter.sendTurn=async turn=>{
          const file=path.join(root,'fence-'+turn.threadId+'.json');
          const cfg=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
          if(cfg.outside)markTurnOutside(turn.threadId,'outside tool',undefined,undefined,'item:outside tool');
          const attempt=cfg.attempt??0;cfg.attempt=attempt+1;fs.writeFileSync(file,JSON.stringify(cfg));
          input.environment.FAKE_LATE_HANDBACK=cfg.late?'1':'0';
          if(cfg.refusals>attempt)pending.set(turn.threadId,'pending');
          // WM-Q1: the built turn waits here, after render and before its send fence, while the test forgets a line through the real route.
          if(cfg.holdForRevoke&&attempt===(cfg.holdAttempt??0)){log('held-for-revoke',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript});const gate=path.join(root,'release-'+turn.threadId);while(!fs.existsSync(gate))await new Promise(resolve=>setTimeout(resolve,50));}
          if(cfg.permanentMark&&!attempt){
            const db=database();
            const key=db.prepare('SELECT * FROM memory_session_lineage WHERE thread_id=? ORDER BY last_lsn DESC LIMIT 1').get(turn.threadId);
            if(!key)throw new Error('fixture requires retained session lineage');
            db.prepare('INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,999999)').run(key.thread_id,key.driver_instance,key.native_session);
            if(!cfg.unchangedGeneration)db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
            log('permanent-mark',{thread:turn.threadId,key});
          }

          // FORGETRACE: parkRunner parks the runner from this turn on (a forget committed after it stays pending); unparkRunner lets it walk.
          if(cfg.parkRunner){globalThis.__fenceParkRevocation=true;globalThis.__fenceParkMarker=true;stopMemoryRevocation();}
          if(cfg.unparkRunner){globalThis.__fenceParkRevocation=false;globalThis.__fenceParkMarker=false;wakeMemoryRevocation(()=>database(),undefined,true);}
          if(!cfg.backlog&&!cfg.parkRunner)await memoryRevocationIdle();
          if(cfg.backlog&&!attempt){
            globalThis.__fenceParkRevocation=true;stopMemoryRevocation();
            const db=database();db.exec('BEGIN IMMEDIATE');
            try{
              const cap=Number(db.prepare('SELECT next FROM memory_lsn WHERE id=1').get().next)+1;
              const insert=db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line','{}',1,?,'mark','','active')");
              const hold=db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
              // 1.0.21 closer2 (C3): a parked revoke still walking has a frontier row; 'mark' with no frontier row and no hold row is a walk that
              // wrote every mark, which a waiter may now close (memory-revocation.ts READY_REVOKE), so the backlog states what it models.
              const walking=db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,1,'{}')");
              for(let i=0;i<cfg.backlog;i++){insert.run(800001+i,cap);hold.run(800001+i);walking.run(800001+i);}
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
          turn.beforeSubmit=()=>{let submitted;if(cfg.removeAtWrite){const gone=path.join(root,'attachments','.removed');fs.mkdirSync(gone,{recursive:true});fs.writeFileSync(path.join(gone,path.basename(cfg.removeAtWrite)),'');}try { submitted=before?.(); } catch(error) { console.warn("fence fixture submission refused", error?.stack ?? error); log('refused-submits',{thread:turn.threadId,attempt,text:turn.text,...beforeQueue?{queueBefore:beforeQueue,queueAfter:queueSnapshot(),work:denyReadMeter().statements,sqlWork:Object.fromEntries(sqlWork),recordGraphBefore:beforeRecordGraph,recordGraphAfter:recordGraph()}:{}}); throw error; } log('writes',{thread:turn.threadId,attempt,text:turn.text,transcript:turn.transcript,fallback:cfg.fallbackReplay?renderDriverReplay(turn.transcript??[],turn.replayMetadata):undefined,context:turn.memoryContext,system:turn.system,images:turn.images,integrationKeys:Object.keys(turn.integrations??{}),threadRecall:turn.threadRecall===true,memory:turn.memoryContext!==undefined,...beforeQueue?{queueBefore:beforeQueue,queueAfter:queueSnapshot(),work:denyReadMeter().statements,sqlWork:Object.fromEntries(sqlWork),sqlStacks:Object.fromEntries(sqlStacks),recordGraphBefore:beforeRecordGraph,recordGraphAfter:recordGraph()}:{}});if(cfg.releaseThenRefuse&&!attempt){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);turn.onEngineWrite?.();pending.set(turn.threadId,'pending');before?.();}if(cfg.crashAtWrite&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){fs.writeFileSync(path.join(root,'fake-transport-write'),turn.text);log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');}
          // IMGREAD: hand the attempt id back, as the server's own beforeSubmit does; Codex reports its write only by that id (codex.ts attemptWritten).
          if(${JSON.stringify(task.name.includes('IMGREAD'))})return submitted;};
          if(cfg.crashAtRecovery&&attempt===1&&!fs.existsSync(path.join(root,'crashed'))){
            log('reset-disk',{thread:turn.threadId,bots:JSON.parse(fs.readFileSync(path.join(root,'bots.json'),'utf8'))});
            fs.writeFileSync(path.join(root,'crashed'),'1');process.kill(process.pid,'SIGKILL');
          }
          // cause 25 setupRefuse: the server's own submission boundary is asked during setup, before the engine is spawned or hands the
          // turn back, as on the field Grok thread (re-preparing ~1 s after send, no engine frame before the rebuild). The real Grok driver
          // (grok.ts over the scripted ACP CLI, a real child process) meets its fence after hand-back, so the fixture asks it here; the
          // refusal is the boundary's (__fenceSetupRefuse above) and the real Grok driver runs the rebuilt turn.
          if(cfg.setupRefuse&&!attempt){turn.beforeSubmit();throw new Error('fixture setup boundary did not refuse');}
          if(cfg.pendingDeadline&&!attempt)globalThis.__fenceRefuse(turn.threadId);
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
      const fake=route==='codex'?'fake-codex-app-server.ts':route==='customAcp'||route==='fuigoAgent'||route==='grokAgent'?'fake-acp-cli.ts':'fake-claude-cli.ts';
      let cli=new URL(${importUrl("server/testing/fake-claude-cli.ts")}).pathname.replace("fake-claude-cli.ts",fake);
      if(route){fs.chmodSync(cli,0o755);const {recordingCli}=await import(${importUrl("server/testing/transport-bytes.test-helper.ts")});cli=recordingCli(cli,root);}
      const warmRoute=route==='grokAgent'||route==='fuigoAgent' ? {FAKE_ACP_UNIQUE_SESSIONS:'1',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY_METHOD:route==='grokAgent'?'_x.ai/mcp_initialized':'_fuigo/mcp_initialized',FAKE_ACP_RPC_FULL_LOG:path.join(root,'wire-rpc')} : {};
      cfg.instances.fence={driver:route||'fakeLateTerminal',...(route?{config:{cli},environment:{FAKE_CLAUDE_MODE:'happy',FAKE_CLAUDE_DUMP:path.join(root,'wire-claude'),FAKE_CLAUDE_DUMP_EACH_TURN:'1',FAKE_CLAUDE_DUMP_HISTORY:path.join(root,'wire-history'),FAKE_CODEX_WARM:'1',FAKE_CODEX_DUMP:path.join(root,'wire-codex'),FAKE_ACP_TEXT_ONLY:'1',FAKE_ACP_PROMPT_DUMP:path.join(root,'wire-acp'),...warmRoute}}:{environment:{FAKE_LATE_DUMP:path.join(root,'wire-late'),FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_PLAIN_SESSION:'1',FAKE_LATE_PRE_HANDBACK_GATE:pre}})};
      if (${JSON.stringify(task.name.includes("WM-D4"))}) {
        const gate=path.join(root,'hold-session-new');
        if(!fs.existsSync(gate))fs.writeFileSync(gate,'');
        cfg.instances.fence.environment.FAKE_ACP_SESSION_NEW_GATE=gate;
      }
      if(route==='fuigoAgent'){
        const home=path.join(process.env.HOME,'.fuigo');
        fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'auth.json'),'{}');
      }
      cfg.instances.handoff={...cfg.instances.verification,environment:{FAKE_CLAUDE_MODE:'hang'}};
      if (${JSON.stringify(task.name.includes('memory recovery retains authorized integrations'))}) cfg.instances.fence.environment.FAKE_LATE_MEMORY_MCP='1';
      if (${JSON.stringify(task.name.includes('UNFENCED adapter'))}) cfg.instances.fence.environment.FAKE_LATE_FENCED_WRITES='0';
      // IMGREAD: Codex resumes its thread and does no web search (outside input would reset, not keep, the session); Fuigo reports its
      // mounted servers ready, as a settled real engine does.
      if (${JSON.stringify(task.name.includes('IMGREAD'))} && route==='codex') Object.assign(cfg.instances.fence.environment,{FAKE_CODEX_MODE:'resume',FAKE_CODEX_NO_WEB_SEARCH:'1'});
      if (route==='fuigoAgent') Object.assign(cfg.instances.fence.environment,{FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_LIST:'all:ready'});
      // The real Grok driver on the scripted ACP CLI: Grok reports its mounted servers with its own ready notification.
      if (route==='grokAgent') Object.assign(cfg.instances.fence.environment,{FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized'});
      // IMGREAD queue: a turn whose prompt says IMGREAD_HOLD waits for the gate file, so the next messages queue behind it.
      if (${JSON.stringify(task.name.includes('IMGREAD'))} && route==='claudeAgent') Object.assign(cfg.instances.fence.environment,{FAKE_CLAUDE_HOLD_MARKER:'IMGREAD_HOLD',FAKE_CLAUDE_HOLD_GATE:path.join(root,'imgread-hold-gate'),FAKE_CLAUDE_HOLD_SEEN:path.join(root,'imgread-hold-seen')});
      // USERBUG-SEALED: the held turn's engine stays up after its prompt, and the test asks it (the tool mailbox) to call a mounted tool.
      if (${JSON.stringify(task.name.includes('USERBUG-SEALED'))} && route==='claudeAgent') { fs.mkdirSync(path.join(root,'userbug-mailbox'),{recursive:true}); Object.assign(cfg.instances.fence.environment,{FAKE_CLAUDE_HOLD_MARKER:'USERBUG_HOLD',FAKE_CLAUDE_HOLD_GATE:path.join(root,'userbug-hold-gate'),FAKE_CLAUDE_HOLD_SEEN:path.join(root,'userbug-hold-seen'),FIELD_REPLAY_MAILBOX:path.join(root,'userbug-mailbox')}); }
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
  const make = async (room = false, project = false, model?: string) => {
    const grokModels = currentRoute === "grokAgent" ? (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === "fence").models : undefined;
    const bot = (await api("POST", "/api/bots", { name: "Fence fixture", modelSelection: { instanceId: "fence", model: model ?? (grokModels ? grokModels.options[0]?.id ?? grokModels.default : currentRoute === "claudeAgent" ? "claude-sonnet-5-5" : currentRoute === "codex" ? "gpt-6.1-sol" : currentRoute === "customAcp" ? "agent-default" : currentRoute === "fuigoAgent" ? "fake-acp-model" : "late-1") } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = room ? (await api("POST", "/api/groups", { name: "Fence room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } }, ...(project ? { channelProject: { goal: "Fixture project" } } : {}) })).group : undefined;
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
  const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
  const busy = async (f: { bot: { id: string }; thread: string }, room: boolean) => room
    ? Boolean((await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId)
    : (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy === true;
  const ids = async (thread: string) => new Set((await messages(thread)).map(m => m.id as string));
  // 1.0.24 q1024-forgetracerace (FRICTION-1025 F20 + F21): a fence recovery, a held recall and a last rebuild are log lines, never rows in
  // the chat. Every row flipped for it below asserts the missing row FIRST and then that turn's own log line, so a turn that never
  // recovered (or never ran) cannot pass on the missing row alone.
  const LEFT_OUT_NOTE = "Murage left remembered details out of this reply.";
  const MESSAGE_ONLY_NOTE = "Murage prepared this reply from your message, with remembered context left out.";
  const memoryNotes = async (thread: string) => (await messages(thread)).filter(m => m.memoryNote === "without-memory");
  const recoveryTiers = (thread: string) => [...readFileSync(fixture.info.logPath, "utf8").matchAll(new RegExp(`\\[memory\\] fence recovery tier=(\\d) thread=${thread} `, "g"))].map(match => Number(match[1]));
  const noticeDirectory = () => join(fixture.info.dataDir, "fence-notices");
  const noticeFiles = () => existsSync(noticeDirectory()) ? readdirSync(noticeDirectory()) : [];
  const noticeId = (thread: string, key: string) => "memory-note-" + createHash("sha256").update(thread + "\0" + key).digest("hex");
  /** What a build through 1.0.23 left on disk when it stopped between releasing a notice and writing its row: the released file. */
  const leaveNotice = (notice: { threadId: string; id: string; line: string; released: boolean; key?: string; turnId?: string; memoryReplay?: true }) => {
    mkdirSync(noticeDirectory(), { recursive: true });
    writeFileSync(join(noticeDirectory(), notice.id + ".json"), JSON.stringify({ key: "PRIVATE_NOTICE_KEY_SENTINEL", ...notice }));
  };
  /** The legacy store of a message-only session: the released note of the turn that answered `text`, keyed by that input and bound to
   * the reply's turn exactly as 1.0.23 wrote it. The current build writes no such note itself, so the heal's evidence arrives the only
   * way it still can: as the file an older build left, repaired by the real boot pass. */
  const leaveLegacyMessageOnlyNotice = async (thread: string, text: string) => {
    const shown = await messages(thread);
    const input = shown.findLast(m => m.role === "user" && m.text === text);
    const reply = shown.slice(shown.indexOf(input)).find(m => m.role === "bot" && m.kind === "text" && m.turnId);
    expect(input?.id, "the legacy input row").toBeTruthy(); expect(reply?.turnId, "the legacy reply's turn").toBeTruthy();
    const id = noticeId(thread, input.id);
    leaveNotice({ threadId: thread, id, line: MESSAGE_ONLY_NOTE, released: true, turnId: reply.turnId });
    return id;
  };
  // MAIN-RULING local-memory-budget (cause 25, Sean: no local memory check may delay an owner turn): this case asserted the owner's turn
  // waited 6 s for its check (owed -> runnable >= 6000 ms, no write while waiting). It now never waits (OWNER_PENDING_WAIT_MS = 0) and
  // takes its last resort: one write, the skip recorded, no error card; the check still settles in the background.
  it.each([false, true])("pending check that settles later does not hold the owner's turn: one last-resort write (room=%s)", async room => {
    const f = await make(room);
    scenario(f.thread, { refusals: 1, pendingDelay: 6000 });
    await api("POST", f.route, { threadId: f.thread, text: "Re-send the fixture report" });
    await expect.poll(() => rows("pending-checks").some(r => r.thread === f.thread && r.phase === "owed"), { timeout: 15000 }).toBe(true);
    await finished(f.thread);
    expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`[memory] pending fence skipped thread=${f.thread} reason=checking:pending`);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(2);
    expect(rows("writes").filter(r => r.thread === f.thread)).toHaveLength(1);
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toHaveLength(0);
    await expect.poll(() => rows("pending-checks").filter(r => r.thread === f.thread).map(r => r.phase), { timeout: 15000 }).toEqual(["owed", "runnable"]);
  }, 90000);
  it.each([false, true])("owner continues after pending prefix deadline (room=%s)", async room => {
    const f = await make(room);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" });
    await finished(f.thread);
    const previousNotes = new Set((await messages(f.thread)).map(m => m.id));
    scenario(f.thread, { refusals: 1, pendingDeadline: true });
    await api("POST", f.route, { threadId: f.thread, text: "New owner message" });
    if (!room) {
      // MAIN-RULING 2026-11-27T07:45:34Z (4), shipped REMOVAL (q1023-ownerrows CHANGED-ASSERTIONS.md; was: the pending deadline, a refused
      // send fence and a message-only/last-resort write with one left-out note): the owner's own direct turn is sent as built, once. It is
      // never refused and never waits on the pending check, so there is no deadline line, no refusal line, no rebuild and no note.
      await finished(f.thread, 2);
      const ownerLog = readFileSync(fixture.info.logPath, "utf8");
      expect(ownerLog, "no pending wait on the owner's own turn").not.toContain("pending fence settle outcome=deadline");
      expect(ownerLog, "no send-fence refusal on the owner's own turn").not.toMatch(/send fence refused \(checking:pending,/);
      expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("New owner message")), "sent once, never rebuilt").toHaveLength(1);
      expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("New owner message")), "written once").toHaveLength(1);
      const ownerShown = await messages(f.thread);
      expect(ownerShown.filter(m => m.text === "New owner message")).toHaveLength(1);
      expect(ownerShown.filter(m => m.memoryNote === "without-memory" && !previousNotes.has(m.id)), "no left-out note on the owner's own turn").toEqual([]);
      expect(ownerShown.filter(m => m.tool?.ok === false)).toEqual([]);
      return;
    }
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8"), { timeout: 15000 }).toContain("pending fence settle outcome=deadline");
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log).toMatch(/send fence refused \(checking:pending,.+refused refs: (?:own-)?prefix(?:-shown)? 1/);
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("New owner message")).length, { timeout: 6000 }).toBe(1);
    const write = rows("writes").find(r => r.thread === f.thread && r.text.includes("New owner message"));
    expect(write.attempt).toBe(1);
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's message-only last resort): the direct last rebuild of a typed turn now carries its recent
    // lines, each judged on its own. The owner's own line never waits on a pending window (deny-read.ts: owner lines are judged by their own
    // flag, tombstone and thread deny), so it is replayed; the generated reply inside the pending window stays out (REVOKED_SENTINEL below).
    // A room member's last resort is unchanged: message-only.
    if (room) {
      expect(write.transcript ?? []).toEqual([]);
      expect(JSON.stringify(write)).not.toContain("Previous fixture message");
    } else {
      expect((write.transcript ?? []).map((entry: { role: string; text: string }) => [entry.role, entry.text])).toEqual([["user", "Previous fixture message"]]);
      expect(write.text).toMatch(/^User: .*Previous fixture message/m);
    }
    expect(JSON.stringify(write)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    await finished(f.thread, 2);
    const shown = await messages(f.thread);
    expect(shown.filter(m => m.text === "New owner message")).toHaveLength(1);
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this asserted the rebuild's one left-out note on both rows. The fixture's forced refusal
    // is still rebuilt once (the write above is attempt 1); the note is a log line now, and the chat gets no row.
    expect(shown.filter(m => m.memoryNote === "without-memory" && !previousNotes.has(m.id))).toEqual([]);
    if (room) expect(recoveryTiers(f.thread), "the room's last rebuild is logged").toContain(2);
    expect(shown.filter(m => m.tool?.ok === false)).toEqual([]);
    if (!room) {
      const log = readFileSync(fixture.info.logPath, "utf8");
      expect(log).toContain(`context revoked during dispatch on thread ${f.thread}; re-preparing`);
      expect(log.split("\n").filter(line => line.includes(f.thread) && /pending fence (settle|skipped)|send fence refused \(checking:pending/.test(line)), "the owner's own turn met no pending window").toEqual([]);
      const recalls = log.split("\n").filter(line => line.includes("turn dispatch recall=") && line.includes(`thread=${f.thread}`)).map(line => /recall=([\w-]+)/.exec(line)?.[1]);
      expect(recalls.length).toBeGreaterThanOrEqual(2);
      expect(recalls.filter(recall => recall !== "full"), "every dispatch of the owner's turn recalled in full").toEqual([]);
    }
  }, 90000);
  // 1.0.20 A-3: the owner's routine is owner-originated work, not a fresh line: at the same pending deadline it takes the same message-only
  // last resort (the server frame, no stored context, no earlier text), never the refusal line.
  it("owner continues after pending prefix deadline: routine run", async () => {
    const f = await make(false);
    const made = await api("POST", "/api/routines", { botId: f.bot.id, name: "Fixture routine", prompt: "Routine fixture prompt", schedule: { type: "once", at: Date.now() + 3_600_000 } });
    const routine = made.routine;
    await api("POST", `/api/routines/${routine.id}/run`, {});
    await expect.poll(() => rows("writes").filter(r => r.text.includes("Routine fixture prompt")).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    const thread = rows("writes").find(r => r.text.includes("Routine fixture prompt")).thread;
    await finished(thread);
    const previousNotes = new Set((await messages(thread)).map(m => m.id));
    const before = rows("writes").filter(r => r.thread === thread).length;
    scenario(thread, { refusals: 1, pendingDeadline: true });
    await api("POST", `/api/routines/${routine.id}/run`, {});
    // MAIN-RULING 2026-11-27T07:45:34Z (4), shipped REMOVAL (q1023-ownerrows CHANGED-ASSERTIONS.md; was: the pending deadline line, then a
    // message-only last-resort write, attempt 1, no transcript): the owner's routine is owner-originated work and is sent as built, once:
    // no pending wait, no refusal, no rebuild.
    await expect.poll(() => rows("writes").filter(r => r.thread === thread).length, { timeout: 20000 }).toBe(before + 1);
    const write = rows("writes").filter(r => r.thread === thread).at(-1);
    expect(write.attempt, "sent on its first attempt, never rebuilt").toBe(0);
    const routineLog = readFileSync(fixture.info.logPath, "utf8");
    expect(routineLog, "no pending wait on the owner's routine").not.toContain("pending fence settle outcome=deadline");
    expect(routineLog, "no send-fence refusal on the owner's routine").not.toMatch(/send fence refused \(checking:pending,/);
    // MAIN RULING 2026-11-19: the routine's last resort carries its own task line, never only the static instruction (a run that did nothing)
    expect(write.text).toContain("Routine fixture prompt");
    expect(write.text).not.toContain("Stored context is unavailable for this turn");
    await finished(thread, 2);
    const shown = (await messages(thread)).filter(m => !previousNotes.has(m.id));
    expect(shown.filter(m => m.tool?.ok === false)).toEqual([]);
    expect(shown.filter(m => /could not start this reply|couldn't start this reply|context is no longer available/.test(`${m.text ?? ""} ${m.tool?.name ?? ""}`))).toEqual([]);
  }, 90000);
  it.each([false, true])("Stop ends a pending check wait with no rebuild or engine write (room=%s)", async room => {
    const f = await make(room);
    // cause 25 (MAIN-RULING local-memory-budget): an owner turn has no wait left to stop, so the Stop-during-the-wait contract is pinned on
    // a turn not proven the owner's (outside input / an unproven room line), whose wait is unchanged.
    scenario(f.thread, { refusals: 1, pendingDelay: 6000, ...(room ? { roomUnproven: true } : { outsideDirect: true }) });
    await api("POST", f.route, { threadId: f.thread, text: "Stop the pending fixture report" });
    await expect.poll(() => rows("pending-checks").some(r => r.thread === f.thread && r.phase === "owed"), { timeout: 15000 }).toBe(true);
    const before = await ids(f.thread);
    const stop = await api("POST", f.route.replace(/\/messages$/, "/interrupt"), { threadId: f.thread });
    // the Stop itself is answered as done (nothing is left HELD on this path)
    expect(stop).toMatchObject({ ok: true });
    await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes("pending fence settle outcome=stopped"), { timeout: 15000 }).toBe(true);
    // JOINT RULING STOP-VS-REFUSAL: the refused first attempt handed no engine turn back, so this Stop has nothing left to close and is
    // confirmed. The turn ends released and silent: no refusal row, no error card, no rebuild and no write.
    await expect.poll(() => busy(f, room), { timeout: 15000 }).toBe(false);
    const fresh = (await messages(f.thread)).filter(m => !before.has(m.id));
    console.warn("pending Stop " + JSON.stringify({ room, stop, rows: fresh.map(m => ({ role: m.role, kind: m.kind, text: m.text, tool: m.tool?.name, ok: m.tool?.ok })) }));
    expect(fresh.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(fresh.filter(m => m.role === "bot" && m.tool?.ok === false)).toEqual([]);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(1);
    expect(rows("writes").filter(r => r.thread === f.thread)).toHaveLength(0);
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toHaveLength(0);
    // released for real: the owner's next message is admitted and dispatched
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "after the stopped wait" });
    await expect.poll(() => rows("attempts").filter(r => r.thread === f.thread).at(-1)?.text ?? "", { timeout: 30000 }).toContain("after the stopped wait");
  }, 90000);
  it("a real bot handoff with outside history waits for its carried prefix check", async () => {
    const f = await make();
    scenario(f.thread, { outside: true });
    await api("POST", f.route, { threadId: f.thread, text: "Keep the earlier fixture report" });
    await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    const sender = (await api("POST", "/api/bots", { name: "Sender", modelSelection: { instanceId: "handoff", model: "sonnet" } })).bot;
    await api("POST", `/api/bots/${sender.id}/messages`, { text: "Hold for a handoff __fixture_hold_authority__" });
    let token: string | undefined, senderPid: number | undefined;
    await expect.poll(() => {
      try {
        const turn = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))) as any;
        senderPid = turn.pid;
        token = Object.values(turn.mcpConfig?.mcpServers ?? {}).map((s: any) => s.env?.MURAGE_COMMS_TOKEN).find(Boolean) as string | undefined;
        return Boolean(token);
      } catch { return false; }
    }, { timeout: 30000 }).toBe(true);
    scenario(f.thread, { refusals: 1, pendingDelay: 6000 });
    const handed = await fetch(`${fixture.info.url}/api/internal/delegate-bot`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: sender.id, fromThreadId: sender.threadId, toBotId: f.bot.id, message: "Re-sending the fixture report" }) });
    expect(handed.ok).toBe(true);
    expect((await handed.json() as any).queued).toBe(true);
    writeFileSync(join(fixture.fixtureFinishGateDir, String(senderPid)), "finish");
    await finished(f.thread, 2);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("[Delegated by @Sender"))).toHaveLength(2);
    expect(rows("writes").filter(r => r.thread === f.thread)).toHaveLength(2);
    expect(rows("pending-checks").filter(r => r.thread === f.thread).map(r => r.phase)).toEqual(["owed", "runnable"]);
    expect(readFileSync(fixture.info.logPath, "utf8")).toContain("site=turn-start:carried");
    expect(readFileSync(fixture.info.logPath, "utf8")).toContain("source=earlier turn site=turn-start:carried");
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toHaveLength(0);
  }, 120000);
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
  // mem-f6 (1.0.21): the turn's settlement row no longer waits in the capture queue; its job is written complete and owes its
  // checkpoint at once. With the worker stopped the turn therefore leaves 2 open capture jobs (prompt, reply) and 1 debt (was 3 and 0).
  // The freeze still has to wait for both kinds, which is what this case holds.
  // memv2 E3: a thread's checkpoint debt is one marker (r4: one per owed job of the turn, 3 here)
  it.each([["checkpoint debt", "hold-checkpoint", { capture: 0, debt: 1 }], ["open capture job", "hold-capture", { capture: 2, debt: 1 }]] as const)("fixture freeze waits for an outstanding %s", async (_name, hold, outstanding) => {
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
  // MAIN ruling C1 (1.0.20, reverses MAIN Q1 option A for the owner): these five cases send fresh owner text, so a retained refusal that is
  // only checking:pending is sealed unwritten and rebuilt. Their f8f3 oracles are restored verbatim: one write, one without-memory note.
  // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): one write and NO note row (the last assertion of each row); the rebuild is a log line.
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
    // ALIGNED to the shipped owner-turn removal (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL, 07:45:34Z (4); q1023-leftout CHANGED-ASSERTIONS B4 M8 row):
    // the backlog is committed in the adapter hook after the build (a forget mid-turn), and the owner's own direct turn is sent as built: the
    // forget applies from the NEXT turn. The shared-room twin of this row (below, "R10 %s native replay") keeps the strict write fence.
    expect(JSON.stringify(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))), "the owner turn is sent as built").toContain("REVOKED_SENTINEL-" + f.thread);
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
    // MAIN Q2: the turn waits passively for its pending check before its one write, and that wait's probes are counted by time, not by
    // backlog (268 v 252 statements for 10 v 1000 jobs in c1-fp2). The constant-work oracle is read at the refused submission, the
    // turn's own work before the wait (the measure the tip used); the write keeps every other f8f3 oracle.
    // ALIGNED to the shipped owner-turn removal: the owner's direct turn is never refused (no pending wait), so the same constant-work oracle
    // is read at its one release write, which carries the same work/sqlWork counters (the room twin below keeps the refused submission).
    expect(release.work, "the fixture measured the owner's release write").toBeTypeOf("number");
    pendingTurnWork.set(backlog, release.work); pendingTurnSql.set(backlog, release.sqlWork);
    if (pendingTurnWork.size === 2) expect(pendingTurnWork.get(1000), JSON.stringify(Object.fromEntries(pendingTurnSql))).toBe(pendingTurnWork.get(10));
    if (pendingTurnGraphs.size === 2) expect(pendingTurnGraphs.get(1000)).toEqual(pendingTurnGraphs.get(10));
    // ALIGNED to the shipped owner-turn removal (REMOVAL 02:36:43Z target "0 left-out notes"): the owner turn is sent as built, so it leaves no left-out note.
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !notesBefore.has(m.id))).toHaveLength(0);
  }, 90000);
  it.each([10, 1000])("B4 R11 room with %i jobs has constant operation count and no queue mutation", async backlog => {
    // q1023-scalefin2 (R11 cause, board FIXR q1022-scale-fable / q1022-scale-fin): 50 v 93 was never the backlog. The measured turn is
    // the room's first in active mode, so it is the one that asks for the room's recall view, and it waits at most 300 ms for it
    // (recall-readiness.ts; MAIN-RULING local-memory-budget: memory never delays the turn). Built in time, the turn was admitted to
    // recall (93 statements at its refused submission); not in time, it was held ("Memory wasn't ready", 50): five runs gave 93/50,
    // 93/93, 50/50, 93/50, 93/93 with the same frozen graph, and the backlog rows are written inside the engine send, after that
    // decision. The count is compared like for like now: with the build pace closed no view is built, so the turn is held at both
    // sizes (asserted below), which is what this row measured on every run before revokehealth (50 v 50).
    writeFileSync(join(fixture.info.dataDir, "close-recall-pace"), "");
    await expect.poll(() => rows("recall-pace-closed").length, { timeout: 10000 }).toBe(1);
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
    // MAIN Q2, as in the direct case above: constant work is read at the refused submission, before the passive wait.
    const refused = rows("refused-submits").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0];
    expect(refused?.work, "the fixture measured the refused submission").toBeTypeOf("number");
    // like for like: the measured turn was held (no recalled memory in its refused submission), whatever the backlog
    expect(String(refused.text).startsWith(MEMORY_REFERENCE_PREAMBLE.slice(0, 20)), "the measured room turn carried no recalled memory").toBe(false);
    roomTurnWork.set(backlog, refused.work);
    console.warn("room operation profile " + JSON.stringify({ backlog, work: writes[0].work, sql: writes[0].sqlWork }));
    if (roomTurnWork.size === 2) expect(roomTurnWork.get(1000)).toBe(roomTurnWork.get(10));
    if (roomTurnGraphs.size === 2) expect(roomTurnGraphs.get(1000)).toEqual(roomTurnGraphs.get(10));
    expect((await messages(f.thread)).filter(m => m.memoryNote && !priorNotes.has(m.id))).toEqual([]);
    expect(recoveryTiers(f.thread), "the room's last rebuild is logged").toContain(2);
  }, 90000);
  it.each([10, 1000])("B4 R11b room recall-admitted turn with %i jobs has constant operation count and no queue mutation", async backlog => {
    // The path R11 above no longer measures (its recall build is closed, so its turn is held): here the room's recall view is built
    // before the measured turn (the pace is open and an earlier active-mode room turn asked for it, so the freeze brings it to the
    // change log: viewsBehind 0), so the measured turn is ADMITTED to recall (its refused submission carries the memory reference
    // preamble, the 93-statement path where the deny-read quarantine mark is read on every turn). Its refused-submission work and the
    // rows it writes are the same at 10 and at 1000 active jobs.
    writeFileSync(join(fixture.info.dataDir, "open-recall-pace"), "");
    await expect.poll(() => rows("recall-pace-opened").length, { timeout: 10000 }).toBe(1);
    await api("POST", "/api/memory/action", { action: "configure", mode: "capture" });
    const f = await make(true); scenario(f.thread, { fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 150000 }).toBe(0);
    // an earlier active-mode room turn asks for the room's recall view, so it exists (and is brought to the change log) at the freeze
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_WARM_SENTINEL" }); await finished(f.thread, 2);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    await expect.poll(() => rows("capture-stability").at(-1)?.pending, { timeout: 150000 }).toBe(0);
    writeFileSync(join(fixture.info.dataDir, "freeze-memory"), "");
    await expect.poll(() => existsSync(join(fixture.info.dataDir, "memory-frozen")), { timeout: 150000 }).toBe(true);
    const frozen = JSON.parse(readFileSync(join(fixture.info.dataDir, "memory-frozen"), "utf8"));
    expect({ capture: frozen.capture, debt: frozen.debt, viewsBehind: frozen.viewsBehind }).toEqual({ capture: 0, debt: 0, viewsBehind: 0 });
    const queueBefore = rows("queue-calls").length;
    scenario(f.thread, { backlog, fixedGraph: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 3);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(writes[0].queueAfter).toEqual(writes[0].queueBefore);
    expect(rows("queue-calls").slice(queueBefore)).toEqual([]);
    const refused = rows("refused-submits").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))[0];
    expect(refused?.work, "the fixture measured the refused submission").toBeTypeOf("number");
    // the measured turn was ADMITTED to recall, whatever the backlog (R11 asserts the opposite for the held path)
    expect(String(refused.text).startsWith(MEMORY_REFERENCE_PREAMBLE.slice(0, 20)), `the measured room turn carried recalled memory (backlog ${backlog})`).toBe(true);
    roomAdmittedWork.set(backlog, refused.work);
    console.warn("room admitted operation profile " + JSON.stringify({ backlog, work: writes[0].work, refused: refused.work }));
    if (roomAdmittedWork.size === 2) expect(roomAdmittedWork.get(1000), "refused-submission work of a recall-admitted room turn at 1000 v 10 jobs").toBe(roomAdmittedWork.get(10));
  }, 300000);
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
    // ALIGNED to the shipped owner-turn removal (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL, 07:45:34Z (4)): the owner's own direct turn is sent as
    // built; a forget committed mid-turn applies from the next turn (shared rooms keep the strict fence, see the R10 native replay rows).
    expect(JSON.stringify(writes), "the owner turn is sent as built").toContain("REVOKED_SENTINEL-" + f.thread);
  }, 90000);
  it("Q1 negative: an UNFENCED adapter refused before hand-back is not closed as not launched (fail closed)", async () => {
    // REVIEW H1: the "not launched" close needs the boundary's own proof (fencedWrites, nothing released or confirmed, no unfenced
    // invocation). The same retained pending refusal as B4 M8, on an adapter that does not declare fencedWrites: an invoked engine is
    // never proven to have done nothing, so the lease is not closed as not launched and the thread stays held (the pre-Q1 behaviour).
    // ALIGNED to the shipped owner-turn removal (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL, 07:45:34Z (4)): the owner's own direct turn has no
    // send-fence refusal at all (it is sent as built), so the refusal this row guards exists only on a shared audience. The case runs in a
    // shared room, which keeps every fence (was: the owner's direct chat); every assertion is the base one.
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(() => busy(f, true), { timeout: 30000 }).toBe(false);
    scenario(f.thread, { backlog: 10, retainedOnly: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(() => rows("refused-submits").some(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")), { timeout: 30000 }).toBe(true);
    // The fenced cases release the thread within one poll of the refused submission; give the unfenced one well over that.
    await new Promise(resolve => setTimeout(resolve, 5000));
    await expect.poll(() => busy(f, true), { timeout: 30000, message: "the refused turn is released with its refusal (q1024-steerhang d2b07e85de, index.ts settleRefusedLeaseTerminal: an unconfirmed close releases the run, no rebuild), not held and not closed as not launched" }).toBe(false);
    // q1024-weakfix (AUDIT-WEAK ownerrows): the invocation count is read right after the thread is released (a second dispatch needs the release first), so a second dispatch to the
    // unfenced engine fails here at its own assertion, ahead of the not-launched and write checks that would otherwise hide it.
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")), "one invocation only").toHaveLength(1);
    expect(rows("not-launched"), "an unfenced invoked engine is never closed as not launched").toEqual([]);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))).toEqual([]);
  }, 120000);
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
  // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20). These rows asserted that boot wrote a released left-out notice into the chat.
  // Boot now removes that file and writes nothing. The "persist" and "append" rows are deleted with the layer they faulted (no notice
  // is written or released any more; boot only reads). A transient read or scan failure is still retried without a restart.
  it.each(["read", "scan"])("B3 boot drops a left-out notice file with no chat row, retrying a transient %s failure without restart", async site => {
    const f = await make();
    const id = "memory-note-" + "a".repeat(64);
    leaveNotice({ threadId: f.thread, id, line: LEFT_OUT_NOTE, released: true });
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site, left: 1 }));
    await fixture.restart(); await login();
    await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.id === id || m.memoryNote === "without-memory")).toEqual([]);
    expect(rows("notice-fault-attempts")).toHaveLength(1);
    const diagnostic = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("notice reconciliation"));
    expect(diagnostic.length).toBeGreaterThan(0);
    expect(diagnostic.join("\n")).not.toMatch(/PRIVATE_NOTICE|memory-note-|a{64}/);
  }, 60000);
  // What boot does with each kind of file a build through 1.0.23 can have left (the upgrade path). Only a RELEASED message-only note is
  // still written, once: it is the row isLegacyMessageOnlySession reads (turn-context.ts). Every other file is removed with no row.
  it("B3 boot repair by notice kind: only a released message-only note becomes a row, every file is removed", async () => {
    const f = await make();
    const kinds = [
      { name: "left-out", line: LEFT_OUT_NOTE, released: true },
      { name: "changed-during-reply", line: "Some remembered details changed during this reply.", released: true },
      { name: "unreleased-message-only", line: MESSAGE_ONLY_NOTE, released: false },
      { name: "message-only", line: MESSAGE_ONLY_NOTE, released: true },
      { name: "no-human", line: "Murage left stored context out of this turn.", released: true },
    ].map((kind, index) => ({ ...kind, id: "memory-note-" + String(index + 1).repeat(64) }));
    for (const kind of kinds) leaveNotice({ threadId: f.thread, id: kind.id, line: kind.line, released: kind.released, turnId: "legacy-turn-" + kind.name });
    const written = async () => Object.fromEntries(await Promise.all(kinds.map(async kind => [kind.name, (await messages(f.thread)).filter(m => m.id === kind.id).map(m => [m.memoryNote, m.tool?.name, m.tool?.ok, m.turnId])])));
    const expected = { "left-out": [], "changed-during-reply": [], "unreleased-message-only": [],
      "message-only": [["without-memory", MESSAGE_ONLY_NOTE, true, "legacy-turn-message-only"]], "no-human": [["without-memory", "Murage left stored context out of this turn.", true, "legacy-turn-no-human"]] };
    await fixture.restart(); await login();
    await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
    expect(await written()).toEqual(expected);
    // a second start finds no file and writes nothing more
    await fixture.restart(); await login();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await written()).toEqual(expected);
    expect(await memoryNotes(f.thread)).toHaveLength(2);
  }, 60000);
  it("B3 permanent notice failure stops after three attempts and preserves other files", async () => {
    const f = await make();
    const id = "memory-note-" + "b".repeat(64);
    leaveNotice({ threadId: f.thread, id, line: LEFT_OUT_NOTE, released: true });
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site: "read", left: 100 }));
    await fixture.restart(); await login();
    await expect.poll(() => rows("notice-fault-attempts").length, { timeout: 10000 }).toBe(3);
    // An exhausted entry stays on disk for the next start; no unbounded background loop.
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(rows("notice-fault-attempts")).toHaveLength(3);
    expect(noticeFiles()).toEqual([id + ".json"]);
    const diagnostic = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("notice reconciliation"));
    expect(diagnostic.join("\n")).toContain("attempts=3 failures=3 unresolved=1");
    expect(diagnostic.join("\n")).not.toMatch(/PRIVATE_NOTICE|memory-note-|b{64}/);
    // Remove the injected outage, add a released message-only file, then restart: both files are settled once. FLIPPED (F20): the
    // exhausted left-out entry is removed with no row; the message-only one is the only row written.
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site: "read", left: 0 }));
    const other = "memory-note-" + "c".repeat(64);
    leaveNotice({ threadId: f.thread, id: other, key: "second", line: MESSAGE_ONLY_NOTE, released: true });
    await fixture.restart(); await login();
    await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.id === id || m.id === other).map(m => m.id)).toEqual([other]);
  }, 60000);
  it.each([{ room: false, late: false }, { room: false, late: true }, { room: true, late: false }, { room: true, late: true }])("R11 two refusals, $room room / $late late, end message-only with no note row", async opts => {
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
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this asserted the message-only note row. The last rebuild is the tier-2 log line; no row.
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id))).toEqual([]);
    expect(recoveryTiers(f.thread).at(-1), "the last rebuild is logged at tier 2").toBe(2);
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
  // MAIN-RULING 2026-11-27T02:36:43Z REMOVAL (q1023-leftout CHANGED-ASSERTIONS.md): the owner's own direct turn is sent as built. It is never
  // refused, so the recovery's reset and note sites (before-reset, before-note, after-note) are never reached and no left-out note is owed
  // (was: a crash at each site, then one durable note, idempotent across restarts). A crash after the output (after-output) still restarts
  // the server. Privacy is unchanged: the permanent mark on the retained session (a durable deny row) keeps every later turn off it.
  // 1.0.24 q1024-forgetracerace (FRICTION F20): the note release the "before-note" and "after-note" sites crashed in is deleted with the
  // note itself, so those two rows can no longer crash anywhere; they stay as rows that no recovery site fires and nothing is owed. Every
  // row also asserts that the restart finds no notice file.
  it.each(["before-reset", "before-note", "after-note", "after-output"])("R12 crash at %s preserves privacy and idempotent note obligations", async site => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "first human input" }); await finished(f.thread);
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy).not.toBe(true);
    const priorNotes = new Set((await messages(f.thread)).filter(m => m.memoryNote === "without-memory").map(m => m.id));
    scenario(f.thread, { refusals: site === "before-reset" ? 0 : 1, permanentMark: true, unchangedGeneration: true, crashSite: site });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    if (site === "after-output") await expect.poll(() => existsSync(join(fixture.info.dataDir, "crashed")), { timeout: 60000 }).toBe(true);
    else {
      // wait for the turn to end OR the server to crash, so a recovery site that is reached fails the assertion below, not this wait
      await expect.poll(() => existsSync(join(fixture.info.dataDir, "crashed")) || rows("terminal-replies").filter(row => row.thread === f.thread && row.text === "REVOKED_SENTINEL-" + f.thread).length >= 2, { timeout: 60000 }).toBe(true);
      expect(existsSync(join(fixture.info.dataDir, "crashed")), "no recovery site is reached on the owner's turn").toBe(false);
      await finished(f.thread, 2);
    }
    expect(rows("permanent-mark")).toHaveLength(1);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT")), "the owner's turn is written once, as built").toHaveLength(1);
    await fixture.restart(); await login(); scenario(f.thread, {});
    // a second restart owes nothing either
    await fixture.restart(); await login();
    expect((await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id)), "no left-out note on the owner's own turn").toEqual([]);
    expect(noticeFiles(), "no notice obligation on disk").toEqual([]);
    await api("POST", f.route, { threadId: f.thread, text: "after boundary crash" });
    await expect.poll(() => rows("attempts").filter(r => r.thread === f.thread).at(-1)?.text).toContain("after boundary crash");
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("after boundary crash")).length).toBe(1);
    const after = rows("attempts").filter(r => r.thread === f.thread).at(-1)!;
    const before = rows("attempts").find(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"))!;
    // every site now writes the turn's output first, so each takes the original after-output rule: the marked cursor is gone, and a later
    // session may be resumed (was: resumed false for the three recovery sites)
    expect(after.cursor, "the marked session is never resumed").not.toBe(before.cursor);
  }, 180000);

  // q1023-leftout CHANGED-ASSERTIONS.md: the same mid-turn revoke as B4 M8 (backlog committed in the adapter hook, after the build), so the
  // case runs in a shared room, which keeps every fence (was: the owner's direct chat). Every assertion is unchanged.
  it.each([false, true])("R10 %s native replay accounts for fallback transcript before a real revoke", async native => {
    if (native) writeFileSync(join(fixture.info.dataDir, "native-replay"), "1");
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "earlier human input" }); await finished(f.thread);
    await expect.poll(() => busy(f, true), { timeout: 30000 }).toBe(false);
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
  // q1024-forgetrace r6 (rebased on dev/1024 01a40ecea3). MAIN-RULING 2026-11-27T02:36:43Z REMOVAL (binding, carried in by the 1.0.23 merge):
  // the owner's own direct turn is built once from the durable rows and sent; no bundle fence, no checking/pending wait, no tier rebuild, no
  // message-only last resort, no left-out note. A forget committed before the turn starts is kept out of it by the durable deny rows; a forget
  // committed mid-turn applies from the next turn. The witnesses pin both halves through the real send and forget routes on a booted server.
  const FORGETRACE_RECOVERY = (thread: string) => readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(`[memory] fence recovery tier=`) && line.includes(` thread=${thread} `));
  const forgetraceActive = () => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true }); try { return Number((db.prepare("SELECT COUNT(*) AS n FROM memory_revoke_jobs WHERE state='active'").get() as { n: number }).n); } finally { db.close(); } };
  const forgetraceSent = (thread: string, marker: string) => rows("writes").filter(r => r.thread === thread && String(r.text).includes(marker));
  // the owner's own turn as ruled: built once, sent once, no tier recovery, no refusal line or failed tool row, no left-out note, reply posted
  const forgetraceOwnerTurn = async (f: { thread: string }, marker: string, before: Set<string>) => {
    expect(rows("attempts").filter(r => r.thread === f.thread && String(r.text).includes(marker)), "owner turn built once").toHaveLength(1);
    expect(forgetraceSent(f.thread, marker), "owner turn sent once").toHaveLength(1);
    expect(FORGETRACE_RECOVERY(f.thread), "no fence recovery on the owner's own turn").toEqual([]);
    const added = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(added.filter(m => m.text === LEDGER_REFUSAL_LINE || m.tool?.ok === false).map(m => m.tool?.name ?? m.text), "no refusal line or failed tool row on the owner turn").toEqual([]);
    expect(added.filter(m => m.memoryNote).map(m => m.tool?.name ?? m.text), "no left-out note on the owner's own turn").toEqual([]);
    expect(added.some(m => m.role === "bot" && m.kind === "text" && m.text === "REVOKED_SENTINEL-" + f.thread), "the owner reply is posted").toBe(true);
  };
  // the owner's next turn on the same thread (n = replies on the thread once it ends): what it sent to the engine
  const forgetraceNextTurn = async (f: Awaited<ReturnType<typeof make>>, n: number) => {
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_AFTER input" }); await finished(f.thread, n);
    await expect.poll(() => busy(f, false), { timeout: 60000 }).toBe(false);
    const sent = forgetraceSent(f.thread, "FORGETRACE_AFTER");
    expect(sent, "the next owner turn was sent").toHaveLength(1);
    return JSON.stringify(sent);
  };
  // unpark the runner through a turn on a second owner thread and let every walk end
  const forgetraceUnpark = async () => {
    const g = await make();
    scenario(g.thread, { unparkRunner: true });
    await api("POST", g.route, { threadId: g.thread, text: "FORGETRACE_WAKE" }); await finished(g.thread);
    await expect.poll(forgetraceActive, { timeout: 90000, message: "the forget settles once the runner walks" }).toBe(0);
  };
  // W1: the forget is committed (runner parked, still walking) before the owner's turn starts. The turn reads the durable deny rows, so it never
  // carries the forgotten words, and as the owner's own turn it has no left-out note. After the walk ends memory holds no copy of the words.
  // forget=false is the control: same turns, nothing forgotten, the turn carries the earlier line, the words stay in memory.
  it.each([true, false])("FORGETRACE-W1 forget committed before the owner's turn (forget=%s): the turn never carries the words, no note, memory holds no copy after the walk", async forget => {
    const f = await make();
    scenario(f.thread, { parkRunner: true });
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_SOURCE_LINE fixture words" }); await finished(f.thread);
    await expect.poll(() => busy(f, false), { timeout: 30000 }).toBe(false);
    const source = (await messages(f.thread)).find(m => m.role === "user" && m.text === "FORGETRACE_SOURCE_LINE fixture words");
    expect(source?.id).toBeTruthy();
    const sourceId = `message:${f.thread}:${source.id}`;
    const words = () => {
      const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
      try { return Number((db.prepare("SELECT COUNT(*) AS n FROM memory_source_versions WHERE instr(payload,'FORGETRACE_SOURCE_LINE')>0").get() as { n: number }).n); }
      finally { db.close(); }
    };
    await expect.poll(words, { timeout: 30000, message: "the source line is captured before the forget" }).toBeGreaterThan(0);
    if (forget) await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: sourceId });
    const walkingAtStart = forgetraceActive();
    const before = await ids(f.thread);
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_NEXT input" }); await finished(f.thread, 2);
    await expect.poll(() => busy(f, false), { timeout: 60000 }).toBe(false);
    const sent = JSON.stringify(forgetraceSent(f.thread, "FORGETRACE_NEXT"));
    if (forget) expect(sent, "the owner turn carried a line forgotten before it started").not.toContain("FORGETRACE_SOURCE_LINE");
    else expect(sent, "control: with nothing forgotten the turn carries the earlier line").toContain("FORGETRACE_SOURCE_LINE");
    // fixture state, read at turn start and asserted after the privacy outcome (so a forget that does nothing fails at the outcome above)
    if (forget) expect(walkingAtStart, "the forget is still walking at turn start").toBeGreaterThan(0);
    await forgetraceOwnerTurn(f, "FORGETRACE_NEXT", before);
    await forgetraceUnpark();
    const copies = () => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true }); try {
      return [...db.prepare("SELECT 'source:'||source_id AS id FROM memory_source_versions WHERE source_id<>? AND instr(payload,'FORGETRACE_SOURCE_LINE')>0").all(sourceId),
        ...db.prepare("SELECT 'record:'||id AS id FROM memory_records WHERE instr(text,'FORGETRACE_SOURCE_LINE')>0").all()].map((r: any) => String(r.id).replace(f.thread, "T"));
    } finally { db.close(); } };
    const tombstoned = () => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true }); try { return Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=?").get(sourceId)); } finally { db.close(); } };
    if (!forget) { expect(tombstoned(), "control: nothing forgotten").toBe(false); expect(words(), "control: the words stay in memory").toBeGreaterThan(0); return; }
    expect(tombstoned(), "the forgotten source is tombstoned").toBe(true);
    expect(copies(), "a copy of the forgotten words is left in memory after the forget settled").toEqual([]);
  }, 240000);
  // W2: the forget lands DURING the owner's turn (after its render, before its send), through the real route. Ruled: that turn is sent as built
  // (once, no refusal, no rebuild, no note); the forget applies from the next turn, which never carries the forgotten words.
  it("FORGETRACE-W2 a forget made during the owner's turn: that turn is sent as built with no note, the next turn never carries the words", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_MID_LINE fixture words" }); await finished(f.thread);
    await expect.poll(() => busy(f, false), { timeout: 30000 }).toBe(false);
    const source = (await messages(f.thread)).find(m => m.role === "user" && m.text === "FORGETRACE_MID_LINE fixture words");
    expect(source?.id).toBeTruthy();
    const before = await ids(f.thread);
    scenario(f.thread, { holdForRevoke: true, holdAttempt: 0 });
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_MID_NEXT input" });
    await expect.poll(() => rows("held-for-revoke").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    expect(JSON.stringify(rows("held-for-revoke").find(r => r.thread === f.thread)), "the turn was rendered with the line before the forget").toContain("FORGETRACE_MID_LINE");
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${source.id}` });
    await expect.poll(forgetraceActive, { timeout: 90000, message: "the during-turn forget settles before the send" }).toBe(0);
    writeFileSync(join(fixture.info.dataDir, `release-${f.thread}`), "1");
    await finished(f.thread, 2);
    await expect.poll(() => busy(f, false), { timeout: 60000 }).toBe(false);
    await forgetraceOwnerTurn(f, "FORGETRACE_MID_NEXT", before);
    expect(JSON.stringify(forgetraceSent(f.thread, "FORGETRACE_MID_NEXT")), "ruled: the held turn is sent as it was built").toContain("FORGETRACE_MID_LINE");
    expect(await forgetraceNextTurn(f, 3), "the next owner turn carried a line forgotten during the turn before").not.toContain("FORGETRACE_MID_LINE");
  }, 240000);
  // W4: pending=true: a first forget is committed and still walking (runner parked) when the owner's turn starts, and the owner forgets a second
  // line during that turn. The turn never carries the first line, is sent once with no note, and the next turn (both walks still parked)
  // carries neither. pending=false: only the during-turn forget; the next turn never carries it.
  it.each([true, false])("FORGETRACE-W4 a forget before and a forget during the owner's turn (pending=%s): sent once with no note, the next turn carries neither", async pending => {
    const f = await make();
    if (pending) scenario(f.thread, { parkRunner: true });
    for (const text of ["FORGETRACE_MIX_A fixture words", "FORGETRACE_MIX_B fixture words"]) { await api("POST", f.route, { threadId: f.thread, text }); await finished(f.thread); await expect.poll(() => busy(f, false), { timeout: 30000 }).toBe(false); }
    const lines = (await messages(f.thread)).filter(m => m.role === "user" && String(m.text).startsWith("FORGETRACE_MIX_"));
    expect(lines).toHaveLength(2);
    const read = <T,>(sql: string, ...args: string[]) => { const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true }); try { return db.prepare(sql).get(...args) as T; } finally { db.close(); } };
    if (pending) {
      await expect.poll(() => Number(read<{ n: number }>("SELECT COUNT(*) AS n FROM memory_source_versions WHERE instr(payload,'FORGETRACE_MIX_A')>0").n), { timeout: 30000 }).toBeGreaterThan(0);
      await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${lines[0].id}` });
    }
    const walkingAtStart = forgetraceActive();
    const before = await ids(f.thread);
    scenario(f.thread, { holdForRevoke: true, holdAttempt: 0 });
    await api("POST", f.route, { threadId: f.thread, text: "FORGETRACE_MIX_NEXT input" });
    await expect.poll(() => rows("held-for-revoke").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${lines[1].id}` });
    const walkingAtSend = forgetraceActive();
    writeFileSync(join(fixture.info.dataDir, `release-${f.thread}`), "1");
    await finished(f.thread, 3);
    await expect.poll(() => busy(f, false), { timeout: 60000 }).toBe(false);
    if (pending) expect(JSON.stringify(forgetraceSent(f.thread, "FORGETRACE_MIX_NEXT")), "the owner turn carried a line forgotten before it started").not.toContain("FORGETRACE_MIX_A");
    await forgetraceOwnerTurn(f, "FORGETRACE_MIX_NEXT", before);
    expect(await forgetraceNextTurn(f, 4), "the next owner turn carried a forgotten line").not.toMatch(pending ? /FORGETRACE_MIX_[AB]/ : /FORGETRACE_MIX_B/);
    // fixture state, read at turn start and at the send and asserted after the privacy outcomes
    if (pending) { expect(walkingAtStart, "the first forget is still walking at turn start").toBeGreaterThan(0); expect(walkingAtSend, "both forgets are still walking at the send").toBeGreaterThan(0); }
    // each test boots its own isolated server, so the parked runner is not unparked here
    if (pending) expect(forgetraceActive(), "the next turn ran while the forgets were still walking").toBeGreaterThan(0);
  }, 240000);
  const missingViewRoomTurn = async () => {
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "ROOM_STORED_SENTINEL" }); await finished(f.thread);
    await expect.poll(async () => !!(await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread)?.busyBotId).toBe(false);
    scenario(f.thread, { backlog: 10, missingView: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread, 2);
    return f;
  };
  // MAIN ruling C1: the owner's room turn is rebuilt (fenced recovery), never ended on checking:pending. These are the f8f3 assertions of
  // "R11 a room without its rendered view keeps a legacy prefix until a fenced recovery", all but its `held` line, which stays below under
  // the original name: that one line fails the same way on dev/1019-frozen 3ead2c9023 and on f8f3 (the room prefix carries `held`).
  it("R11 a room without its rendered view is recovered by one fenced rebuild for the owner (MAIN C1)", async () => {
    const f = await missingViewRoomTurn();
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts.length).toBeGreaterThan(1);
    const writes = rows("writes").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("REVOKED_SENTINEL-" + f.thread);
    expect(writes[0].queueBefore).toEqual(writes[0].queueAfter);
    expect((await messages(f.thread)).filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
  }, 90000);
  it("R11 a room without its rendered view keeps a legacy prefix until a fenced recovery", async () => {
    const f = await missingViewRoomTurn();
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[0].refs.find((r: any) => r.kind === "prefix")).not.toHaveProperty("held");
  }, 90000);
  // MAIN ruling C1 keeps MAIN Q1 (option A) for everything that is neither fresh owner text nor the owner's own work. Outside input stays
  // refused: a routine run that arrives as webhook-triggered (the fixture marks the hand-off; the routine, thread and fence are real), with
  // its retained history still checking:pending, ends terminal (one attempt, no engine write, exactly one stopped-context line).
  it("Q1 kept for outside input: a webhook-triggered routine run with retained history still checking:pending ends terminal", async () => {
    const f = await make(false);
    const made = await api("POST", "/api/routines", { botId: f.bot.id, name: "Retained routine", prompt: "ROUTINE_RETAINED_PROMPT", schedule: { type: "once", at: Date.now() + 3_600_000 } });
    await api("POST", `/api/routines/${made.routine.id}/run`, {});
    await expect.poll(() => rows("writes").filter(r => r.text.includes("ROUTINE_RETAINED_PROMPT")).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    const thread = rows("writes").find(r => r.text.includes("ROUTINE_RETAINED_PROMPT")).thread as string;
    await finished(thread);
    await expect.poll(() => busy({ bot: f.bot, thread }, false), { timeout: 30000 }).toBe(false);
    const before = await ids(thread);
    const writesBefore = rows("writes").filter(r => r.thread === thread).length, attemptsBefore = rows("attempts").filter(r => r.thread === thread).length;
    scenario(thread, { backlog: 10, outsideTrigger: true });
    await api("POST", `/api/routines/${made.routine.id}/run`, {});
    // first the refused submission itself, so an idle thread read before the run even started cannot pass
    await expect.poll(() => rows("refused-submits").filter(r => r.thread === thread).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => busy({ bot: f.bot, thread }, false), { timeout: 30000 }).toBe(false);
    await expect.poll(async () => (await messages(thread)).filter(m => !before.has(m.id) && m.text === LEDGER_REFUSAL_LINE).length, { timeout: 30000 }).toBe(1);
    const fresh = (await messages(thread)).filter(m => !before.has(m.id));
    console.warn("Q1 outside-input terminal " + JSON.stringify({ attempts: rows("attempts").filter(r => r.thread === thread).length - attemptsBefore, rows: fresh.map(m => ({ role: m.role, kind: m.kind, text: m.text, note: m.memoryNote, tool: m.tool?.name })) }));
    expect(rows("attempts").filter(r => r.thread === thread)).toHaveLength(attemptsBefore + 1);
    expect(rows("writes").filter(r => r.thread === thread)).toHaveLength(writesBefore);
    expect(rows("refused-submits").filter(r => r.thread === thread)).toHaveLength(1);
    // the run's own activity rows (its marker and the outside prompt, shown masked) and the one line: no reply, no second card, no note
    expect(fresh.filter(m => m.role === "bot" && m.kind !== "activity" && m.text !== LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(fresh.filter(m => m.role === "bot" && m.kind === "activity" && m.tool?.ok === false)).toEqual([]);
    expect(fresh.filter(m => m.memoryNote === "without-memory")).toEqual([]);
    expect(JSON.stringify(fresh)).not.toContain("REVOKED_SENTINEL-" + thread);
  }, 120000);
  it.each([false, true])("A7 tier 0 working-context omission in room=%s gets one counts-only log line, no note row and no recovery", async room => {
    // Recall is outside this oracle. With it disabled, the only observed
    // omission is the working-context quote, so a missing count cannot be
    // masked by a separate recall deadline or unavailable-model notice.
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const f = await make(room); scenario(f.thread, { workingOmission: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread);
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this asserted one "Murage left remembered details out of this reply." row. The
    // omission is the counts-only log line asserted below; the chat gets no row.
    const notes = (await messages(f.thread)).filter(m => m.memoryNote === "without-memory" || m.tool?.name === LEFT_OUT_NOTE);
    expect(notes).toEqual([]);
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
  // q1023-ownerfence, MAIN-RULING 2026-11-27T02:36:43Z REMOVAL: the owner's own direct turn is built once from the durable rows and sent.
  // A forget committed while it runs (here through the real route, between render and the send fence) applies from the next turn: no
  // send-fence refusal, no rebuild, no left-out note, no last resort. A shared room under the same forget keeps every fence (room=true).
  it.each([false, true])("OWNERFENCE-W1 a line forgotten between render and send (room=%s): the owner's direct turn is sent as built, a room still refuses", async room => {
    const f = await make(room);
    await api("POST", f.route, { threadId: f.thread, text: "OWNERFENCE_SOURCE_LINE fixture words" }); await finished(f.thread);
    await expect.poll(() => busy(f, room), { timeout: 30000 }).toBe(false);
    const source = (await messages(f.thread)).find(m => m.role === "user" && m.text === "OWNERFENCE_SOURCE_LINE fixture words");
    expect(source?.id).toBeTruthy();
    const priorNotes = await ids(f.thread);
    scenario(f.thread, { holdForRevoke: true, holdAttempt: 0 });
    await api("POST", f.route, { threadId: f.thread, text: "OWNERFENCE_NEXT input" });
    await expect.poll(() => rows("held-for-revoke").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${source.id}` });
    writeFileSync(join(fixture.info.dataDir, `release-${f.thread}`), "1");
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && String(r.text).includes("OWNERFENCE_NEXT")).length, { timeout: 60000 }).toBeGreaterThan(0);
    await expect.poll(() => busy(f, room), { timeout: 60000 }).toBe(false);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && String(r.text).includes("OWNERFENCE_NEXT"));
    const writes = rows("writes").filter(r => r.thread === f.thread && String(r.text).includes("OWNERFENCE_NEXT"));
    const notes = (await messages(f.thread)).filter(m => m.memoryNote === "without-memory" && !priorNotes.has(m.id));
    const recovery = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("[memory] fence recovery") && line.includes(`thread=${f.thread} `));
    if (room) {
      // shared audience unchanged: the room's send fence refuses the forgotten line and the room rebuilds without it
      expect(attempts.length, "the room was refused at its send fence and rebuilt").toBeGreaterThan(1);
      for (const write of writes) expect(JSON.stringify(write), "the forgotten line reached the room's engine").not.toContain("OWNERFENCE_SOURCE_LINE");
      return;
    }
    expect(attempts.map(r => r.attempt), "the owner's turn was built once and never refused at the send fence").toEqual([0]);
    expect(writes).toHaveLength(1);
    await finished(f.thread, 2); // the owner's reply is posted, not dropped
    expect(notes, "no left-out note on the owner's own turn").toEqual([]);
    expect(recovery, "no fence recovery on the owner's own turn").toEqual([]);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`turn dispatch recall=withheld thread=${f.thread}`);
    // the forget applies from the next turn: it never carries the forgotten line
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "OWNERFENCE_AFTER input" });
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && String(r.text).includes("OWNERFENCE_AFTER")).length, { timeout: 60000 }).toBe(1);
    expect(JSON.stringify(rows("writes").filter(r => r.thread === f.thread && String(r.text).includes("OWNERFENCE_AFTER"))), "the next turn carried the forgotten line").not.toContain("OWNERFENCE_SOURCE_LINE");
  }, 180000);
  // q1023-ownerfence REMOVAL: with memory on, what the owner's own direct turn leaves out at build (here a forgotten working-context line) is
  // the owner's own forget: no left-out note and no recovery line; the line itself still never reaches the engine. A room keeps its note.
  it.each([false, true])("OWNERFENCE-W2 a tier 0 omission with memory on (room=%s): no left-out note on the owner's direct turn, a room logs it with no note row", async room => {
    const f = await make(room); scenario(f.thread, { workingOmission: true });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" }); await finished(f.thread);
    await expect.poll(() => busy(f, room), { timeout: 30000 }).toBe(false);
    const notes = (await messages(f.thread)).filter(m => m.memoryNote === "without-memory");
    const recovery = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("[memory] fence recovery") && line.includes(`thread=${f.thread} `));
    const writes = rows("writes").filter(r => r.thread === f.thread);
    expect(writes).toHaveLength(1);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(1);
    for (const secret of ["OMITTED_THREAD_ID_SENTINEL", "OMITTED_MESSAGE_ID_SENTINEL", "OMITTED_REMEMBERED_TEXT_SENTINEL"]) expect(JSON.stringify(writes)).not.toContain(secret);
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): the room row asserted its left-out note; the room keeps the recovery log line and writes no row.
    if (room) { expect(notes, "the room writes no left-out note either").toEqual([]); expect(recovery).toHaveLength(1); return; }
    expect(notes, "no left-out note on the owner's own turn").toEqual([]);
    expect(recovery, "no fence recovery line on the owner's own turn").toEqual([]);
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
    // SABLE-IDENTITY-1020 (replaces system "", direct AND room member): a recovery keeps the bot's instructions, never stored memory.
    expect(writes[0].system).toContain("You are Fence fixture");
    // (r2, Fable T1) no system-side sentinel here: OMITTED_REMEMBERED_TEXT_SENTINEL is message text, never a system layer, so asserting it
    // absent from the system could not fail. Stored memory out of the system is witnessed by "room recovery leaves the notebook ..." below.
    expect(writes[0].text).not.toContain("OMITTED_REMEMBERED_TEXT_SENTINEL");
    expect(writes[0].transcript ?? []).toEqual([]);
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this asserted the recovery's one note row. The recovery is logged at its tier; no row.
    expect(await memoryNotes(f.thread)).toEqual([]);
    expect(recoveryTiers(f.thread).at(-1), "the recovery is logged at its tier").toBe(tier);
    expect((await messages(f.thread)).filter(m => m.tool?.ok === false)).toEqual([]);
  }, 90000);

  // SABLE-IDENTITY-1020 r2 (Fable H1 + T1 on d0449d883c): a room member's memory-free send keeps its identity but none of its stored memory:
  // not its notebook (MEMORY.md), not the team brief, and not the project brief, whose lead decisions are derived from cited room lines that
  // the refused turn may have been refused over. Attempt 0 of the same turn is the positive control: every sentinel is on that system.
  it.each([1, 2])("room recovery leaves the notebook, team brief and project brief out of the system (tier=%s)", async tier => {
    await api("POST", "/api/memory/action", { action: "configure", mode: "off" });
    const NOTEBOOK = "ROOM_NOTEBOOK_SENTINEL", TEAM = "ROOM_TEAM_BRIEF_SENTINEL", RULES = "ROOM_OWNER_RULES_SENTINEL", DECISION = "ROOM_LEAD_DECISION_SENTINEL";
    const bot = (await api("POST", "/api/bots", { name: "Fence fixture", modelSelection: { instanceId: "fence", model: currentRoute === "claudeAgent" ? "claude-sonnet-5-5" : currentRoute === "codex" ? "gpt-6.1-sol" : currentRoute === "customAcp" ? "agent-default" : "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, section: "Fence team" });
    await api("PUT", "/api/section-context?section=Fence%20team", { text: TEAM });
    await api("PUT", `/api/bots/${bot.id}/memory`, { baseRevision: (await api("GET", `/api/bots/${bot.id}/memory`)).revision, text: `# Memory\n\n- ${NOTEBOOK}\n` });
    const group = (await api("POST", "/api/groups", { name: "Fence project", memberIds: [bot.id], channelProject: { goal: "Ship the fixture" }, setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group;
    const thread = group.threadId as string, route = `/api/groups/${group.id}/messages`;
    // The room line the lead's decision cites.
    await api("POST", route, { threadId: thread, text: "Decide on the fixture plan" }); await finished(thread);
    const cited = (await messages(thread)).find(m => m.role === "user" && m.text === "Decide on the fixture plan")?.id as string;
    expect(cited).toBeTruthy();
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const version = Number((db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM project_briefs WHERE group_id=?").get(group.id) as { v: number }).v) + 1;
      db.prepare("INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(group.id, version, "", "", RULES, "[]", JSON.stringify([{ id: "fixture-decision", text: DECISION, by: bot.id, at: Date.now(), sourceMessageIds: [cited] }]), bot.id, "lead_decision", Date.now());
    } finally { db.close(); }
    scenario(thread, { memoryReader: true, refusals: tier, ...(tier === 1 ? { dropContext: true } : {}) });
    await api("POST", route, { threadId: thread, text: "RAW_HUMAN_INPUT" }); await finished(thread, 2);
    const attempts = rows("attempts").filter(r => r.thread === thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(attempts).toHaveLength(tier + 1);
    for (const sentinel of [NOTEBOOK, TEAM, RULES, DECISION]) expect(attempts[0].system).toContain(sentinel);
    const writes = rows("writes").filter(r => r.thread === thread && r.text.includes("RAW_HUMAN_INPUT"));
    expect(writes).toHaveLength(1);
    expect(writes[0].memory).toBe(false);
    expect(writes[0].system).toContain("You are Fence fixture");
    for (const sentinel of [NOTEBOOK, TEAM, RULES, DECISION]) expect(writes[0].system).not.toContain(sentinel);
  }, 120000);

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
    if ("dropContext" in input) {
      expect(recovery[0].text, "the selective drop must actually go out message-only").not.toContain("EARLIER_CONVERSATION_LINE");
      expect(recovery[0].transcript ?? []).toEqual([]);
    } else {
      // SABLE-IDENTITY-1020 (this pin was v1.0.20's message-only tier-2): the last rebuild of a typed turn replays the recent lines judged
      // shown.
      expect(recovery[0].text, "the tier-2 rebuild of a typed turn carries the judged-shown conversation").toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    }
    // WARM-GROK-1022 D1 (this pin was "a message-only dispatch never publishes its cursor"): a tier-2 rebuild that replayed the
    // conversation keeps its session, so its cursor is published; the tier-1 selective drop still goes out message-only and publishes none.
    if ("dropContext" in input) expect(savedCursor(f), "a message-only dispatch must never publish its cursor").toBeUndefined();
    else expect(savedCursor(f), "the replay session publishes its cursor").toBeTruthy();
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "NEXT_ORDINARY_TURN" }); await finished(f.thread, 3);
    const next = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("NEXT_ORDINARY_TURN"));
    expect(next).toHaveLength(1);
    // D4: the check has settled by this turn, so the shortened replay session is refreshed and the turn still starts fresh with the
    // whole conversation (assertions below unchanged).
    // MAIN-RULING 2026-11-27T02:36:43Z REMOVAL (q1023-leftout CHANGED-ASSERTIONS.md; was toBe(true)): the owner's own direct turn has no
    // partial-replay reset any more, so the settled check never refreshes its replay session
    if (!("dropContext" in input)) expect(resets(f.thread).some(line => line.includes("reason=partial-replay-settled")), "partial-replay reset only where memory is off").toBe(mode === "off");
    if (mode === "active") {
      // REMOVAL (was resumed false + an inline replay): the owner's next turn resumes the replay session the tier-2 rebuild published
      // (savedCursor above), which already holds the earlier conversation (recovery[0].text above)
      expect(next[0].resumed, "the owner's turn resumes its published replay session").toBe(true);
      expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("NEXT_ORDINARY_TURN"))).toHaveLength(1);
      return;
    }
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
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this asserted that the live turn wrote its message-only note. No build from 1.0.24 writes
    // it; the legacy store this heal is for holds the note an older build released, which the real boot pass still repairs (the upgrade path).
    expect(await memoryNotes(f.thread)).toEqual([]);
    const legacyNote = await leaveLegacyMessageOnlyNotice(f.thread, "RAW_HUMAN_INPUT");
    scenario(f.thread, {});
    await fixture.restart(); await login();
    await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
    expect((await memoryNotes(f.thread)).map(m => [m.id, m.tool?.name]), "boot wrote the released legacy message-only note once").toEqual([[legacyNote, MESSAGE_ONLY_NOTE]]);
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
  // T3 (DESIGN-T3.md, MAIN approved): the live shape is a revoke window that does not settle inside 3 x 5 s.
  // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-26T22:27:29Z D2: "owner turns read the durable deny rows directly ... no
  // pending window"; MAIN-RULING 20:15:28Z "owner turns use the last settled view"). This row asserted the T3 keep: the owner's resumed
  // turn under such a window kept its session but was sent with nothing remembered (attempt memory-free, an empty transcript, one
  // "without-memory" left-out note). The owner's own turn now reads no pending window: same session, no reset, no rebuild, one write, and
  // the turn is dispatched with full recall and NO left-out note. A settled deny and outside input keep today's reset (the two guards below,
  // unchanged). The other rows of the T3 "kept on checking:pending" family in this file still plant this window over an owner turn and
  // are NOT re-targeted yet (q1023-denyfable NEXT.md 3).
  const resets = (thread: string) => readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(`memory continuation reset thread=${thread} `));
  it("T3 an owner's resumed turn under a revoke window that never settles keeps its session and is sent with full recall (no kept path, no left-out note)", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" });
    await finished(f.thread);
    const first = rows("writes").filter(r => r.thread === f.thread);
    expect(first).toHaveLength(1);
    const previousNotes = new Set((await messages(f.thread)).map(m => m.id));
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: "New owner message" });
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("New owner message")).length, { timeout: 45000 }).toBe(1);
    await finished(f.thread, 2);
    expect(rows("storm").filter(r => r.thread === f.thread), "the fixture must plant its window over a retained session").toEqual([{ thread: f.thread, session: true }]);
    expect(resets(f.thread)).toEqual([]);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("New owner message"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].resumed).toBe(true);
    expect(attempts[0].reset).not.toBe(true);
    const write = rows("writes").find(r => r.thread === f.thread && r.text.includes("New owner message"));
    expect(write.attempt).toBe(0);
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log).not.toContain(`context revoked during dispatch on thread ${f.thread}; re-preparing`);
    expect(log).not.toContain(`context revoked at a late submission on thread ${f.thread}; re-preparing`);
    // the owner's own turn was not "kept" memory-free, nothing was left out, and both of the thread's turns were dispatched with full recall
    expect(log).not.toContain(`memory continuation kept thread=${f.thread} `);
    const dispatched = log.split("\n").filter(line => line.includes("turn dispatch recall=") && line.includes(`thread=${f.thread}`)).map(line => /recall=([\w-]+)/.exec(line)?.[1]);
    expect(dispatched).toEqual(["full", "full"]);
    expect(log.split("\n").filter(line => line.includes("[memory] fence recovery") && line.includes(`thread=${f.thread} `))).toEqual([]);
    const shown = (await messages(f.thread)).filter(m => !previousNotes.has(m.id));
    expect(shown.filter(m => m.text === "New owner message")).toHaveLength(1);
    expect(shown.filter(m => m.memoryNote === "without-memory")).toEqual([]);
    expect(shown.filter(m => m.tool?.ok === false)).toEqual([]);
    expect(shown.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
  }, 120000);
  it("T3 guard: a settled deny of the retained session still resets it under the same window", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" });
    await finished(f.thread);
    scenario(f.thread, { storm: true, settledDeny: true });
    await api("POST", f.route, { threadId: f.thread, text: "Denied owner message" });
    await expect.poll(() => resets(f.thread).length, { timeout: 45000 }).toBeGreaterThanOrEqual(1);
    expect(rows("storm").filter(r => r.thread === f.thread)).toEqual([{ thread: f.thread, session: true }]);
    expect(resets(f.thread)[0]).not.toMatch(/reason=checking:pending$/);
    await expect.poll(() => rows("attempts").filter(r => r.thread === f.thread && r.text.includes("Denied owner message")).length, { timeout: 45000 }).toBeGreaterThanOrEqual(1);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("Denied owner message")).every(r => r.resumed === false)).toBe(true);
  }, 120000);
  it("T3 guard: outside input (a webhook-triggered direct turn) on a retained session still resets on checking:pending", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" });
    await finished(f.thread);
    scenario(f.thread, { storm: true, outsideDirect: true });
    await api("POST", f.route, { threadId: f.thread, text: "OUTSIDE_STORM_INPUT" });
    await expect.poll(() => resets(f.thread).length, { timeout: 45000 }).toBeGreaterThanOrEqual(1);
    expect(rows("storm").filter(r => r.thread === f.thread), "the fixture must plant its window over a retained session").toEqual([{ thread: f.thread, session: true }]);
    expect(resets(f.thread)[0]).toMatch(/reason=checking:pending$/);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`memory continuation kept thread=${f.thread} `);
  }, 120000);
  // IMGREAD-1020 (field, 1.0.20): a chat whose memory check was still pending could not see any attached screenshot, on Claude and on
  // Codex. T3 sends such a turn memory-free, and the memory-free dispatch dropped the turn's pictures while their tags stayed in the text.
  // These run the REAL adapters against the scripted CLIs and read the bytes that reached the engine's transport.
  const IMGREAD_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  let imgreadUploads = 0;
  const uploadPicture = async (thread: string) => {
    const bytes = Buffer.concat([IMGREAD_PNG, Buffer.from([imgreadUploads++])]);
    const r = await fetch(`${fixture.info.url}/api/attachments?threadId=${encodeURIComponent(thread)}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: bytes });
    expect(r.status).toBe(201);
    return { path: ((await r.json()) as { path: string }).path, data: bytes.toString("base64") };
  };
  const engineWire = (route: string) => {
    const file = join(fixture.info.dataDir, "wire-" + (route === "claudeAgent" ? "claude" : "codex"));
    if (!existsSync(file)) return "";
    const dump = JSON.parse(readFileSync(file, "utf8"));
    return JSON.stringify(route === "claudeAgent" ? dump.prompt : dump.calls.filter((call: any) => call.method === "turn/start").at(-1)?.params.input);
  };
  // Claude only: the fixture's scripted Codex session is not kept across the planted window (it resets on its own session proof), so the
  // kept turn cannot be reached there. The dispatch line is the same for every engine; Codex's transport is held by the rebuild case below.
  it.each(["claudeAgent"])("T3 IMGREAD [%s] the owner's attached picture reaches the engine on a turn kept while its memory check is pending", async route => {
    const f = await make(false);
    // Control, same adapter and same upload path with no pending check: the picture is sent.
    const before = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_FIRST_LOOK\n\n<attached-image path="${before.path}" />` });
    await routeFinished(f, 1);
    const firstWrite = rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_FIRST_LOOK"));
    expect(firstWrite).toHaveLength(1);
    expect(firstWrite[0].images).toEqual([{ mimeType: "image/png", data: before.data }]);
    // The field shape: a revoke window that does not settle, over the retained session.
    scenario(f.thread, { storm: true });
    const picture = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_SECOND_LOOK\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_SECOND_LOOK")).length, { timeout: 45000 }).toBe(1);
    await routeFinished(f, 2);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): under the planted window the owner's own turn is no longer "kept" memory-free;
    // it resumes its session as an ordinary turn (no kept line, no reset). The picture assertions below are unchanged.
    expect(rows("storm").filter(r => r.thread === f.thread)).toEqual([{ thread: f.thread, session: true }]);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`memory continuation kept thread=${f.thread} `);
    expect(resets(f.thread)).toEqual([]);
    const attempt = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_SECOND_LOOK"));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].resumed).toBe(true);
    expect(attempt[0].memory).toBe(false);
    const write = rows("writes").find(r => r.thread === f.thread && r.text.includes("IMGREAD_SECOND_LOOK"));
    expect(write.text).toContain(`<attached-image path="${picture.path}" />`);
    expect(write.images, "the picture the owner attached to this message must be sent with it").toEqual([{ mimeType: "image/png", data: picture.data }]);
    // And on the engine's own transport, as that engine takes a picture.
    await expect.poll(() => engineWire(route)).toContain("IMGREAD_SECOND_LOOK");
    expect(engineWire(route)).toContain(route === "claudeAgent" ? `"data":"${picture.data}"` : `data:image/png;base64,${picture.data}`);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): the turn is not memory-free any more, so the owner's own
    // earlier line rides along as context; the earlier line's PICTURE still does not (next assertion, unchanged).
    expect(JSON.stringify(write)).toContain("IMGREAD_FIRST_LOOK");
    expect(JSON.stringify(write.images)).not.toContain(before.data);
  }, 180000);
  it.each(["claudeAgent"])("IMGREAD [%s] the owner's attached picture reaches the engine on the last, message-only rebuild", async route => {
    const f = await make();
    // Two refusals at the write walk the production rebuild ladder to its last rung with the stored message and its bound picture.
    scenario(f.thread, { refusals: 2 });
    const picture = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_MESSAGE_ONLY\n\n<attached-image path="${picture.path}" />` });
    await routeFinished(f, 1);
    const last = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_MESSAGE_ONLY")).at(-1)!;
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's empty system): a memory-free send keeps the bot's instructions, never stored memory.
    expect(last.memory).toBe(false); expect(last.transcript ?? []).toEqual([]); expect(last.system).toContain("You are Fence fixture");
    const write = rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_MESSAGE_ONLY")).at(-1)!;
    expect(write.attempt, "the write that went out is the last rung's").toBe(2);
    expect(write.images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    await expect.poll(() => engineWire(route)).toContain("IMGREAD_MESSAGE_ONLY");
    expect(engineWire(route)).toContain(route === "claudeAgent" ? `"data":"${picture.data}"` : `data:image/png;base64,${picture.data}`);
  }, 180000);
  // Codex: the injected write refusals do not walk the scripted Codex CLI through the ladder, so (as CTX-ROUTE does) the fixture enters the
  // last rebuild directly. That entry appends its own message row, so the picture is one this conversation bound on the turn before.
  it.each(["codex"])("IMGREAD [%s] a picture bound to the conversation reaches the engine on the last, message-only rebuild", async route => {
    const f = await make();
    const picture = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_BOUND_LOOK\n\n<attached-image path="${picture.path}" />` });
    await routeFinished(f, 1);
    const bound = rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_BOUND_LOOK"));
    expect(bound).toHaveLength(1);
    expect(bound[0].images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    scenario(f.thread, { rebuildTier: 2 });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_MESSAGE_ONLY\n\n<attached-image path="${picture.path}" />` });
    await routeFinished(f, 2);
    const last = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_MESSAGE_ONLY")).at(-1)!;
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's message-only last resort): the last rebuild of a typed turn keeps the bot's instructions
    // and replays its recent lines judged shown, as CTX-ROUTE tier 2 does. The transcript field is not asserted: this adapter does not replay
    // it natively; the text is what goes out. The picture is still sent once (write.images below).
    expect(last.memory).toBe(false); expect(last.system).toContain("You are Fence fixture");
    // rel/1023: a replayed line that carries an image is annotated first (turn-context.ts replayImageText), so the words follow on the next line.
    expect(last.text).toMatch(/^User: \[These images were attached to an earlier message\.[^\n]*\]\n.*IMGREAD_BOUND_LOOK/m);
    expect((last.transcript ?? []).some((entry: { text: string }) => entry.text.includes("IMGREAD_BOUND_LOOK")), "the replay is the judged earlier line").toBe(true);
    const write = rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_MESSAGE_ONLY")).at(-1)!;
    expect(write.images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    await expect.poll(() => engineWire(route)).toContain("IMGREAD_MESSAGE_ONLY");
    expect(engineWire(route)).toContain(`data:image/png;base64,${picture.data}`);
    // The replayed line names the same picture: the engine still gets it once.
    expect(engineWire(route).split(picture.data).length - 1, "the picture goes to the engine once").toBe(1);
  }, 180000);
  it.each(["claudeAgent"])("IMGREAD [%s] room: the owner's attached picture reaches the member on the last, message-only rebuild", async route => {
    const f = await make(true);
    scenario(f.thread, { refusals: 2 });
    const picture = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_MESSAGE_ONLY\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    const last = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_ROOM_MESSAGE_ONLY")).at(-1)!;
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's empty system): a room member's memory-free send keeps its identity, never stored memory.
    expect(last.memory).toBe(false); expect(last.system).toContain("You are Fence fixture");
    const write = rows("writes").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_ROOM_MESSAGE_ONLY")).at(-1)!;
    expect(write.attempt).toBe(2);
    expect(write.images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    await expect.poll(() => engineWire(route)).toContain("IMGREAD_ROOM_MESSAGE_ONLY");
    expect(engineWire(route)).toContain(`"data":"${picture.data}"`);
  }, 180000);
  // IMGREAD (1.0.20 field): the T3 kept path sends the owner's text alone, but the picture the owner attached to that very message is
  // part of it, not remembered context. 1.0.20 dropped it with the remembered context (images: ... selectiveDropped ? undefined), so a
  // bot's own chat on Claude, Codex or Fuigo got the tag and "the image is already in front of you" and no image, while a Project chat
  // (the room path, never kept) still saw it. Observed at the real adapter's stdin bytes (recordingCli), the bytes the engine receives.
  const upload = async (thread: string) => {
    const response = await fetch(`${fixture.info.url}/api/attachments?threadId=${thread}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: IMGREAD_PNG });
    expect(response.status).toBe(201);
    return await response.json() as { path: string; mime: string };
  };
  /** What the engine received from the first byte after `marker` (the turn's own frame onward). PNG bytes as base64 start with iVBORw0KGgo. */
  const receivedAfter = (marker: string) => { const bytes = readFileSync(join(fixture.info.dataDir, "wire-bytes"), "utf8"); const at = bytes.lastIndexOf(marker); return at < 0 ? "" : bytes.slice(at); };
  const kept = (thread: string) => readFileSync(fixture.info.logPath, "utf8").includes(`memory continuation kept thread=${thread} `);
  it.each(["claudeAgent", "codex", "customAcp", "fuigoAgent"])("T3 IMGREAD [%s] an owner's resumed turn kept on checking:pending still hands the engine the image attached to that message", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the second turn must resume a retained session" }).toBeTruthy();
    expect(receivedAfter("Previous fixture message")).not.toContain("iVBORw0KGgo");
    const saved = await upload(f.thread);
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_OWNER_MESSAGE\n<attached-image path="${saved.path}" />` }); await routeFinished(f, 2);
    expect(rows("storm").filter(r => r.thread === f.thread), "the fixture must plant its window over a retained session").toEqual([{ thread: f.thread, session: true }]);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): the owner's own turn is not kept memory-free under the window; it resumes.
    expect(kept(f.thread), "the owner's own turn reads no pending window: no kept path").toBe(false);
    expect(resets(f.thread)).toEqual([]);
    expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("IMGREAD_OWNER_MESSAGE")).map(r => r.resumed)).toEqual([true]);
    const received = receivedAfter("IMGREAD_OWNER_MESSAGE");
    expect(received, "the turn's own frame reached the engine").toContain("IMGREAD_OWNER_MESSAGE");
    expect(received, "the attached picture's bytes reached the engine with the kept turn").toContain("iVBORw0KGgo");
    // still nothing remembered added on the kept path
    expect(received).not.toContain("Previous fixture message");
  }, 180000);
  it("T3 IMGREAD [claudeAgent] a kept turn never inlines a picture this conversation did not bind (no access beyond the attachment)", async () => {
    const other = await make();
    const foreign = await upload(other.thread);
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f)).toBeTruthy();
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_FOREIGN_MESSAGE\n<attached-image path="${foreign.path}" />` }); await routeFinished(f, 2);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): no kept path on the owner's own turn; the binding rule below is unchanged.
    expect(kept(f.thread)).toBe(false);
    expect(resets(f.thread)).toEqual([]);
    const received = receivedAfter("IMGREAD_FOREIGN_MESSAGE");
    expect(received).toContain("IMGREAD_FOREIGN_MESSAGE");
    expect(received, "a path bound to another conversation is never read into this turn").not.toContain("iVBORw0KGgo");
  }, 180000);
  it("T3 IMGREAD [claudeAgent] a room chat under the same window still hands the engine its attached image", async () => {
    const f = await make(true);
    const roomFinished = async (want: number) => {
      await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(want);
      await expect.poll(() => busy(f, true)).toBe(false);
    };
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await roomFinished(1);
    const saved = await upload(f.thread);
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_MESSAGE\n<attached-image path="${saved.path}" />` }); await roomFinished(2);
    const received = receivedAfter("IMGREAD_ROOM_MESSAGE");
    expect(received).toContain("IMGREAD_ROOM_MESSAGE");
    expect(received).toContain("iVBORw0KGgo");
  }, 180000);
  // Astra f212385: only the pictures of the message a memory-free turn carries ride with it, never a removed picture's path, never a
  // picture removed before the write, never on a line nobody proved was the owner's; a queued room turn carries its own source's picture;
  // and an actual Project (channelProject) delivers like any room. Real Claude adapter, scripted CLI, bytes read at the engine's transport.
  const holdSeen = () => existsSync(join(fixture.info.dataDir, "imgread-hold-seen"));
  const releaseHold = () => writeFileSync(join(fixture.info.dataDir, "imgread-hold-gate"), "go");
  const marked = (thread: string, marker: string, file = "writes") => rows(file).filter(r => r.thread === thread && String(r.text).includes(marker));
  it("T3 IMGREAD [claudeAgent] a drained queue kept on checking:pending sends the last line's own picture, never an earlier line's", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the batch must resume a retained session" }).toBeTruthy();
    // A held turn keeps the bot busy, so the next two messages queue and drain as one batch.
    await api("POST", f.route, { threadId: f.thread, text: "IMGREAD_HOLD this turn" });
    await expect.poll(holdSeen, { timeout: 30000 }).toBe(true);
    const a = await uploadPicture(f.thread), b = await uploadPicture(f.thread);
    expect((await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_QUEUED_A\n\n<attached-image path="${a.path}" />` })).queued).toBe(true);
    expect((await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_QUEUED_B\n\n<attached-image path="${b.path}" />` })).queued).toBe(true);
    scenario(f.thread, { storm: true });
    releaseHold();
    await expect.poll(() => marked(f.thread, "IMGREAD_QUEUED_B").length, { timeout: 60000 }).toBe(1);
    await routeFinished(f, 3);
    expect(rows("storm").filter(r => r.thread === f.thread), "the fixture must plant its window over a retained session").toEqual([{ thread: f.thread, session: true }]);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL, with 01:12:43Z "owner turns read durable deny rows, no pending
    // window"): this row asserted the owner's drained batch took the kept path and was cut to a memory-free turn of its last line and that
    // line's picture only. The owner's own turn reads no pending window, so there is no kept path and nothing is cut: the batch is written
    // once, with both queued lines, and each line's own picture reaches the engine. (Which rebuild carries it is the bundle fence's
    // business, removed for owner turns by q1023-ownerfence: not asserted here.)
    expect(kept(f.thread), "the owner's own batch reads no pending window: no kept path").toBe(false);
    expect(resets(f.thread).filter(line => line.includes("checking:pending"))).toEqual([]);
    const write = marked(f.thread, "IMGREAD_QUEUED_B")[0];
    expect(write.text, "the batch is not cut to its last line: the earlier queued line is written with it").toContain("IMGREAD_QUEUED_A");
    expect(write.images, "each queued line's own picture rides with the batch, in order").toEqual([{ mimeType: "image/png", data: a.data }, { mimeType: "image/png", data: b.data }]);
    await expect.poll(() => engineWire("claudeAgent")).toContain("IMGREAD_QUEUED_B");
    expect(engineWire("claudeAgent")).toContain(`"data":"${b.data}"`);
    expect(engineWire("claudeAgent"), "the earlier line's picture reached the engine too").toContain(`"data":"${a.data}"`);
  }, 180000);
  it.each([false, true])("IMGREAD [claudeAgent] a removed picture's path never reaches the engine on the last, message-only rebuild (room=%s)", async room => {
    const f = await make(room);
    const gone = await uploadPicture(f.thread), picture = await uploadPicture(f.thread);
    await api("POST", "/api/storage/attachments/remove", { names: [basename(gone.path)] });
    scenario(f.thread, { refusals: 2 });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_REMOVED_LOOK\n\n<attached-image path="${gone.path}" />\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    const write = marked(f.thread, "IMGREAD_REMOVED_LOOK").at(-1)!;
    expect(write.attempt, "the write that went out is the last rung's").toBe(2);
    expect(write.memory).toBe(false);
    expect(write.images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    expect(write.text).toContain(picture.path);
    expect(write.text, "the removed picture's path leaves the message-only prompt").not.toContain(gone.path);
    await expect.poll(() => engineWire("claudeAgent")).toContain("IMGREAD_REMOVED_LOOK");
    expect(engineWire("claudeAgent")).not.toContain(gone.path);
  }, 180000);
  it.each([false, true])("IMGREAD [claudeAgent] a picture removed after it was read is not sent at the adapter's write (room=%s)", async room => {
    const f = await make(room);
    const picture = await uploadPicture(f.thread);
    // The fixture removes it (storage's marker) inside the adapter's write, after collection read it and before the server's check.
    scenario(f.thread, { removeAtWrite: picture.path });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_REMOVED_AT_WRITE\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => marked(f.thread, "IMGREAD_REMOVED_AT_WRITE").length + marked(f.thread, "IMGREAD_REMOVED_AT_WRITE", "refused-submits").length, { timeout: 60000 }).toBeGreaterThan(0);
    await expect.poll(() => busy(f, room), { timeout: 60000 }).toBe(false);
    for (const write of marked(f.thread, "IMGREAD_REMOVED_AT_WRITE")) expect(JSON.stringify(write.images ?? []), "no write carries the removed picture").not.toContain(picture.data);
    expect(engineWire("claudeAgent")).not.toContain(picture.data);
    expect(marked(f.thread, "IMGREAD_REMOVED_AT_WRITE", "refused-submits").length, "the server refused the write that held it").toBeGreaterThan(0);
  }, 180000);
  it("IMGREAD [claudeAgent] room: a line nobody proved was the owner's carries no picture on the last, message-only rebuild", async () => {
    const f = await make(true);
    const picture = await uploadPicture(f.thread);
    scenario(f.thread, { refusals: 2, roomUnproven: true });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_UNPROVEN\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => marked(f.thread, "IMGREAD_ROOM_UNPROVEN").length, { timeout: 60000 }).toBeGreaterThan(0);
    await expect.poll(() => busy(f, true), { timeout: 60000 }).toBe(false);
    const write = marked(f.thread, "IMGREAD_ROOM_UNPROVEN").at(-1)!;
    expect(write.attempt, "the write that went out is the last rung's").toBe(2);
    expect(write.memory).toBe(false);
    expect(write.images ?? []).toEqual([]);
    expect(engineWire("claudeAgent")).not.toContain(picture.data);
  }, 180000);
  it("IMGREAD [claudeAgent] room: the newest line's picture never rides a queued turn that answers an earlier message", async () => {
    const f = await make(true);
    // Lane queuedhop's shape: the member is busy in another room, so the owner's message A is queued as a turn whose source is A; the
    // owner's next line B, with its own picture, is the room's newest line when A's turn runs and rebuilds to its last rung.
    const busyRoom = (await api("POST", "/api/groups", { name: "Busy room", memberIds: [f.bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: f.bot.id } } })).group;
    await api("POST", `/api/groups/${busyRoom.id}/messages`, { threadId: busyRoom.threadId, text: "IMGREAD_HOLD in the other room" });
    await expect.poll(holdSeen, { timeout: 30000 }).toBe(true);
    const a = await uploadPicture(f.thread), b = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_SOURCE_A\n\n<attached-image path="${a.path}" />` });
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_LATER_B\n\n<attached-image path="${b.path}" />` });
    await expect.poll(async () => (await messages(f.thread)).some(m => m.role === "user" && String(m.text).includes("IMGREAD_ROOM_LATER_B")), { message: "B is in the room before A's queued turn runs" }).toBe(true);
    scenario(f.thread, { refusals: 2 });
    releaseHold();
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.attempt === 2).length, { timeout: 90000 }).toBeGreaterThan(0);
    await expect.poll(() => busy(f, true), { timeout: 60000 }).toBe(false);
    const last = rows("writes").find(r => r.thread === f.thread && r.attempt === 2)!;
    expect(last.memory).toBe(false);
    expect(String(last.text), "the queued turn's last rung carries no newest-line text").not.toContain("IMGREAD_ROOM_LATER_B");
    expect(last.images ?? [], "and none of the newest line's pictures").toEqual([]);
  }, 180000);
  it("IMGREAD [claudeAgent] room: a queued turn's message-only prompt carries the picture of the message it was queued for", async () => {
    const f = await make(true);
    await api("POST", f.route, { threadId: f.thread, text: "IMGREAD_HOLD room turn" });
    await expect.poll(holdSeen, { timeout: 30000 }).toBe(true);
    const a = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_ROOM_SOURCE_A\n\n<attached-image path="${a.path}" />` });
    await api("POST", f.route, { threadId: f.thread, text: "IMGREAD_ROOM_LATER_B" });
    scenario(f.thread, { refusals: 2 });
    releaseHold();
    await expect.poll(() => marked(f.thread, "IMGREAD_ROOM_SOURCE_A").filter(r => r.attempt === 2).length, { timeout: 90000 }).toBeGreaterThan(0);
    await expect.poll(() => busy(f, true), { timeout: 60000 }).toBe(false);
    const write = marked(f.thread, "IMGREAD_ROOM_SOURCE_A").find(r => r.attempt === 2)!;
    expect(write.memory).toBe(false);
    expect(write.text, "the queued turn's message-only prompt is its own source").not.toContain("IMGREAD_ROOM_LATER_B");
    expect(write.images, "the source message's own picture rides with it").toEqual([{ mimeType: "image/png", data: a.data }]);
  }, 180000);
  it("IMGREAD [claudeAgent] Project: the owner's attached picture reaches the lead on the last, message-only rebuild", async () => {
    const f = await make(true, true);
    const group = (await api("GET", "/api/bots?messages=0")).groups.find((g: any) => g.threadId === f.thread);
    expect(group.channelProject, "an actual Project, not a plain room").toMatchObject({ goal: "Fixture project", status: "active" });
    scenario(f.thread, { refusals: 2 });
    const picture = await uploadPicture(f.thread);
    await api("POST", f.route, { threadId: f.thread, text: `IMGREAD_PROJECT_MESSAGE_ONLY\n\n<attached-image path="${picture.path}" />` });
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    const write = marked(f.thread, "IMGREAD_PROJECT_MESSAGE_ONLY").at(-1)!;
    expect(write.attempt).toBe(2); expect(write.memory).toBe(false);
    expect(write.images).toEqual([{ mimeType: "image/png", data: picture.data }]);
    await expect.poll(() => engineWire("claudeAgent")).toContain("IMGREAD_PROJECT_MESSAGE_ONLY");
    expect(engineWire("claudeAgent")).toContain(`"data":"${picture.data}"`);
  }, 180000);
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
  for (const route of ["grokAgent", "fuigoAgent", "claudeAgent"]) it.each([
    { cell: "WM-D1", restart: false },
    { cell: "WM-D1r", restart: true },
  ])(`T3 $cell [${route}] reuses a replay session while the owner check remains pending`, async ({ restart }) => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "Earlier fixture conversation" });
    await routeFinished(f, 1);
    scenario(f.thread, { rebuildTier: 2 });
    await api("POST", f.route, { threadId: f.thread, text: "Fixture recovery input" });
    await routeFinished(f, 2);
    const replay = rows("writes").find(r => r.thread === f.thread && r.text.includes("Fixture recovery input"));
    expect(JSON.stringify(replay), "the last resort carried the prior exchange").toContain("Earlier fixture conversation");
    const cursor = savedCursor(f);
    expect(cursor, "the replay session publishes a cursor").toBeTruthy();
    // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): this row read the replay mark on the last resort's note row. No note row is written now, so
    // nothing can mark the replay session as a legacy message-only one: it is reused on its own cursor (the oracles below are unchanged).
    expect(await memoryNotes(f.thread)).toEqual([]);
    expect(recoveryTiers(f.thread).at(-1), "the last resort is logged at tier 2").toBe(2);
    const databaseFile = join(fixture.info.dataDir, "messages.db");
    if (restart) {
      // The upgrade path, through the real boot pass twice: a build through 1.0.23 left this session's released message-only note
      // (boot writes that one row), and a later one left the released obligation that carries the replay mark over the row already
      // written (boot patches it, as 1.0.23 did: the mark keeps a healthy replay session from being healed as a legacy one).
      const stored = () => { const db = new DatabaseSync(databaseFile, { readOnly: true }); try { return db.prepare("SELECT json_extract(json,'$.memoryReplay') AS replay, json_extract(json,'$.turnId') AS turn FROM messages WHERE thread_id=? AND id=?").all(f.thread, id); } finally { db.close(); } };
      const id = await leaveLegacyMessageOnlyNotice(f.thread, "Fixture recovery input");
      scenario(f.thread, {});
      await fixture.restart(); await login();
      await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
      const first = stored();
      expect(first.map(row => row.replay), "boot wrote the legacy note row once, unmarked").toEqual([null]);
      leaveNotice({ threadId: f.thread, id, line: MESSAGE_ONLY_NOTE, released: true, turnId: String(first[0].turn), memoryReplay: true });
      await fixture.restart(); await login();
      await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
      expect(stored().map(row => [row.replay, row.turn]), "boot marked the same row as a replay, once").toEqual([[1, first[0].turn]]);
    }
    const priorClaude = rows("wire-history").at(-1);
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: "Fixture pending input" });
    await routeFinished(f, 3);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("Fixture pending input"));
    // ALIGNED to the shipped owner-turn removal (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL; 07:45:34Z (4) names T3 as an owner row): the owner's
    // own direct turn has no pending-check wait and no partial-replay reset, so under a window that never settles it simply continues
    // on the replay session it already has, is written once, and no kept-on-checking line and no refresh happens (the 01:12:43Z refresh flip
    // is itself superseded: the partial-replay reset is deleted for owner turns).
    expect(attempts.map(r => r.cursor), "the owner turn continues on the saved replay session").toEqual([cursor]);
    expect(attempts.map(r => r.resumed)).toEqual([true]);
    if (route === "claudeAgent") {
      const next = rows("wire-history").findLast(row => JSON.stringify(row.prompt).includes("Fixture pending input"));
      expect(next, "Claude received the owner prompt").toBeTruthy();
      const resume = next.argv.indexOf("--resume");
      expect(next.pid === priorClaude?.pid || (resume !== -1 && next.argv[resume + 1] === cursor), "Claude continued the replay session").toBe(true);
    } else {
      const prompt = rows("wire-rpc").findLast(row => row.method === "session/prompt" && JSON.stringify(row.params.prompt).includes("Fixture pending input"));
      expect(prompt?.params.sessionId, "ACP wrote the owner prompt to the saved session").toBe(cursor);
    }
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("Fixture pending input"))).toHaveLength(1);
    expect(resets(f.thread).filter(line => line.includes("checking:pending"))).toEqual([]);
    expect(resets(f.thread).some(line => line.includes("reason=partial-replay-settled")), "no partial-replay refresh on an owner turn").toBe(false);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`memory continuation kept thread=${f.thread} `);
  }, 150000);

  it("WM-D2 [grokAgent] a last resort with no replay leaves no cursor", async () => {
    const f = await make();
    scenario(f.thread, { rebuildTier: 2, noReplaySeed: true });
    await api("POST", f.route, { threadId: f.thread, text: "Fixture message without history" });
    await routeFinished(f, 1);
    const write = rows("writes").find(r => r.thread === f.thread);
    expect(write?.transcript ?? []).toEqual([]);
    expect(savedCursor(f), "a message-only rebuild left its cursor unpublished").toBeUndefined();
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "Fixture follow-up after message-only recovery" });
    await routeFinished(f, 2);
    expect(rows("attempts").find(r => r.thread === f.thread && r.text.includes("Fixture follow-up"))?.resumed).toBe(false);
  }, 120000);

  for (const route of ["grokAgent", "fuigoAgent", "claudeAgent"]) {
    it.each([
      { cell: "WM-D3", denySession: false },
      { cell: "WM-D7", denySession: true },
    ])(`T3 $cell [${route}] retires the replay session after revocation`, async ({ denySession }) => {
      const f = await make();
      await api("POST", f.route, { threadId: f.thread, text: "Earlier fixture conversation" });
      await routeFinished(f, 1);
      const priorText = rows("terminal-replies").find(r => r.thread === f.thread)?.text;
      const oldReply = (await messages(f.thread)).find(m => m.role === "bot" && m.kind === "text" && m.text === priorText);
      expect(oldReply?.text).toBeTruthy();
      scenario(f.thread, { rebuildTier: 2 });
      await api("POST", f.route, { threadId: f.thread, text: "Fixture recovery input" });
      await routeFinished(f, 2);
      const replay = rows("writes").find(r => r.thread === f.thread && r.text.includes("Fixture recovery input"));
      expect(JSON.stringify(replay), "the last resort carried the old reply").toContain(oldReply.text);
      const cursor = savedCursor(f);
      if (denySession) {
        scenario(f.thread, { storm: true, settledDeny: true });
      } else {
        await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${oldReply.id}` });
        scenario(f.thread, {});
      }
      await api("POST", f.route, { threadId: f.thread, text: "Fixture input after revocation" });
      await routeFinished(f, 3);
      expect(resets(f.thread).some(line => line.includes("deny-session")), "the replay session reached the denial reset").toBe(true);
      const next = rows("attempts").find(r => r.thread === f.thread && r.text.includes("Fixture input after revocation"));
      expect(next?.resumed).toBe(false);
      expect(savedCursor(f)).not.toEqual(cursor);
      if (!denySession) expect(next?.transcript?.map((line: { id?: string }) => line.id) ?? []).not.toContain(oldReply.id);
    }, 150000);
  }

  // WM-Q1/WM-Q2 (ASTRA ecfe16d56a, index.ts last-resort replay; ASTRA 4b40881687: reach it through production admission). A replayed entry
  // carries the excerpt of the line it replies to (transcriptText). The quoted line sits outside the last resort's recent window, so only
  // the quote carries its words. The recovery turn is refused twice at the real send fence (a pending check over the thread), the real
  // rebuild marks the third dispatch as the last resort and takeLastResort admits it: no tier or redispatch state is injected.
  const quotedLastResort = async (route: string, hold: object) => {
    const f = await make(false, false, route === "grokAgent" ? "grok-4.7" : undefined);
    await api("POST", f.route, { threadId: f.thread, text: "QUOTED_SOURCE_LINE fixture words" });
    await routeFinished(f, 1);
    const quoted = (await messages(f.thread)).find(m => m.role === "user" && m.text === "QUOTED_SOURCE_LINE fixture words");
    expect(quoted?.id).toBeTruthy();
    // The history and the quoting line are seeded when the recovery turn starts, so no engine session ever held the quoted line's words.
    scenario(f.thread, { refusals: 2, fullFixtureHistory: true, seedQuoting: quoted.id, ...hold });
    await api("POST", f.route, { threadId: f.thread, text: "Fixture recovery input" });
    return { f, quoted };
  };
  const admittedLastResort = (f: { thread: string }) => {
    expect(rows("route-tier-served").filter(r => r.thread === f.thread), "the harness injected no redispatch tier for this thread").toEqual([]);
    const refused = rows("refused-submits").filter(r => r.thread === f.thread && String(r.text).includes("Fixture recovery input"));
    expect(refused.map(r => r.attempt), "the recovery turn was refused twice at the send fence").toEqual([0, 1]);
    expect(rows("judge-entry").filter(r => r.thread === f.thread).at(-1)?.lastResort, "production admission made the third build the last resort").toBe(true);
  };

  it.each(["grokAgent", "claudeAgent"])("T3 WM-Q1 [%s] a quoted line forgotten between render and send never reaches the engine", async route => {
    // The last resort waits after render and before its send fence, while the test forgets the quoted line through the real route.
    const { f, quoted } = await quotedLastResort(route, { holdForRevoke: true, holdAttempt: 2 });
    // Held, or (when the harness injected a tier, which the next call refuses) already served.
    await expect.poll(() => rows("held-for-revoke").filter(r => r.thread === f.thread).length === 1
      || rows("route-tier-served").some(r => r.thread === f.thread), { timeout: 90000 }).toBe(true);
    admittedLastResort(f);
    const rendered = JSON.stringify(rows("held-for-revoke").find(r => r.thread === f.thread));
    expect(rendered, "the last resort rendered the quoting entry").toContain("Fixture quoting line");
    expect(rendered, "the quoting entry carried the quoted words when rendered").toContain("QUOTED_SOURCE_LINE");
    expect(rendered, "the last resort kept only its recent window").not.toContain("Seeded exchange 00");
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${quoted.id}` });
    writeFileSync(join(fixture.info.dataDir, `release-${f.thread}`), "1");
    const recovery = (file: string) => rows(file).filter(r => r.thread === f.thread && JSON.stringify(r).includes("Fixture recovery input"));
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy, { timeout: 60000 }).not.toBe(true);
    const thread = await messages(f.thread), ended = thread.slice(thread.findIndex(m => m.text === "Fixture recovery input") + 1);
    expect(recovery("writes").length > 0 || ended.some(m => m.role !== "user"), "the recovery turn ended visibly: " + JSON.stringify(ended)).toBe(true);
    for (const write of recovery("writes")) expect(JSON.stringify(write), "the forgotten quoted line reached the engine").not.toContain("QUOTED_SOURCE_LINE");
  }, 240000);

  // WM-Q2: the quoted line is forgotten after the last resort rendered its excerpt and before it judges its recent window. The entry that
  // quotes it is left out, the rest of the window is kept and the turn is written.
  it.each(["grokAgent", "claudeAgent"])("T3 WM-Q2 [%s] an entry quoting a line forgotten before the judge is left out of the last-resort replay", async route => {
    const { f, quoted } = await quotedLastResort(route, { holdBeforeJudge: true });
    // Held, or (when production admission did not make it the last resort) all four builds of this thread judged without the hold.
    await expect.poll(() => rows("held-before-judge").filter(r => r.thread === f.thread).length === 1
      || rows("judge-entry").filter(r => r.thread === f.thread && r.lastResort === false).length >= 4, { timeout: 90000 }).toBe(true);
    admittedLastResort(f);
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${quoted.id}` });
    writeFileSync(join(fixture.info.dataDir, `judge-${f.thread}`), "1");
    await expect.poll(async () => (await api("GET", `/api/bots/${f.bot.id}/tasks/${f.thread}`)).task?.busy, { timeout: 60000 }).not.toBe(true);
    const recovery = rows("writes").filter(r => r.thread === f.thread && JSON.stringify(r).includes("Fixture recovery input"));
    expect(recovery.length, "the last resort was written").toBeGreaterThan(0);
    const write = JSON.stringify(recovery);
    expect(write, "the forgotten quoted line reached the engine").not.toContain("QUOTED_SOURCE_LINE");
    expect(write, "the entry quoting the forgotten line was left out").not.toContain("Fixture quoting line");
    expect(write, "the rest of the recent window was kept").toContain("Seeded exchange 59");
  }, 240000);

  it.each(["grokAgent", "fuigoAgent", "claudeAgent"])("T3 WM-D5 [%s] restores history after the pending check settles", async route => {
    // The Grok row runs on the Grok driver's own grok-4.7 entry (drivers/acp/grok.ts, 500k context window), so its replay is sized by a
    // byte budget like Claude's and the refreshed session can reach lines older than the newest-40 floor.
    const f = await make(false, false, route === "grokAgent" ? "grok-4.7" : undefined);
    const post = async (text: string, count: number) => {
      await api("POST", f.route, { threadId: f.thread, text });
      await routeFinished(f, count);
    };
    const attempt = (text: string) => rows("attempts").find(r => r.thread === f.thread && r.text.includes(text));
    scenario(f.thread, { fullFixtureHistory: true });
    await post("Fixture setup turn", 1);
    scenario(f.thread, { rebuildTier: 2, storm: true });
    await post("Fixture short replay", 2);
    const short = JSON.stringify(attempt("Fixture short replay"));
    expect(short, "the last resort replayed its recent window").toContain("Seeded exchange 59");
    expect(short, "the last resort kept only its recent window").not.toContain("Seeded exchange 00");
    scenario(f.thread, {});
    await post("Fixture pending continuation", 3);
    // ALIGNED to the shipped owner-turn removal (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL: the pending wait and the partial-replay reset are
    // deleted for owner turns; 07:45:34Z (4)): the owner's turn under the unsettled window rides the last resort's replay cursor (as before
    // the 01:12:43Z flip, which is superseded) and no checking:pending / partial-replay-settled reset exists. What the shipped product still does
    // once the storm has settled is refresh that replay session on the next owner turn, now under its own reason, cold-withhold-unproven
    // (the last resort's history was withheld cold and never proven), and that refresh carries the history the last resort left out.
    const pendingTurn = attempt("Fixture pending continuation");
    expect(pendingTurn?.resumed, "the replay cursor sustained the owner's turn").toBe(true);
    expect(resets(f.thread).filter(line => line.includes("checking:pending") || line.includes("reason=partial-replay-settled"))).toEqual([]);
    scenario(f.thread, { settleStorm: true });
    await post("Fixture conversation after settlement", 4);
    expect(rows("settled-storm")).toContainEqual({ thread: f.thread, held: false });
    expect(resets(f.thread).some(line => line.includes("reason=cold-withhold-unproven")), "the settled check refreshed this session").toBe(true);
    expect(resets(f.thread).filter(line => line.includes("reason=partial-replay-settled"))).toEqual([]);
    const refreshed = attempt("Fixture conversation after settlement");
    expect(refreshed?.resumed).toBe(false);
    // The Fuigo fixture model has no known context window, so every direct replay there is the newest-40 floor
    // (memory/disclosures.ts replayWindow); the Claude and Grok rows have a byte budget that reaches lines older than that window.
    if (route !== "fuigoAgent") expect(JSON.stringify(refreshed), "the refreshed session carries history older than the window").toContain("Seeded exchange 00");
    expect(JSON.stringify(refreshed), "the refreshed session carries the turn sent while the check was pending").toContain("Fixture pending continuation");
    scenario(f.thread, {});
    await post("Fixture next owner message", 5);
    expect(attempt("Fixture next owner message")?.resumed).toBe(true);
  }, 150000);

  it("WM-D4 [grokAgent] confirmed Stop before session start leaves no replay cursor", async () => {
    const f = await make();
    await api("POST", f.route, { threadId: f.thread, text: "Earlier fixture conversation" });
    await routeFinished(f, 1);
    expect(savedCursor(f)).toBeTruthy();
    const gate = join(fixture.info.dataDir, "hold-session-new");
    rmSync(gate);
    scenario(f.thread, { rebuildTier: 2 });
    await api("POST", f.route, { threadId: f.thread, text: "Fixture input to stop" });
    await expect.poll(() => existsSync(gate + ".waiting")).toBe(true);
    expect(await api("POST", f.route.replace(/\/messages$/, "/interrupt"), { threadId: f.thread })).toMatchObject({ ok: true });
    await directIdle(f);
    expect(rows("stop-close"), "the Grok adapter closed before the cursor could be published").toContainEqual({ thread: f.thread, confirmed: true });
    expect(savedCursor(f), "the stopped last-resort replay leaves no cursor").toBeUndefined();
    writeFileSync(gate, "");
    scenario(f.thread, {});
    await api("POST", f.route, { threadId: f.thread, text: "Fixture input after Stop" });
    await routeFinished(f, 2);
    const next = rows("attempts").find(r => r.thread === f.thread && r.text.includes("Fixture input after Stop"));
    expect(next?.resumed).toBe(false);
    expect(JSON.stringify(next)).toContain("Earlier fixture conversation");
  }, 150000);

  // 1.0.22 userbug-sealed (owner report: almost every turn ended on "Murage closed this bot's tool connection ..." / "this conversation's
  // memory was not ready yet ..."). Owners: userbug-sealed builder owns this guard and the owner rule for a mount reply
  // (memory/send-fence.ts ownerHeldPendingProposal, witnessed in drivers/owner-pending-proposal-1022.test.ts); the recall side of a check
  // that never settles belongs to lane fix1022-recall-checking.
  // GUARD, not the fix's witness (it passes on 435d038d9c too): the real path of a tool reply on the owner's kept turn stays open under a
  // check that never settles. POST /api/bots/:id/messages on a booted server, the real Claude driver, its real mount relay and shim, the
  // real bundled agents proxy and the real release door (POST /api/internal/turn-release/v1/verdict). Only the model is scripted: the
  // CLI stand-in holds its turn after the prompt and makes the one tool call the test asks for, on its own initialized MCP session.
  it("T3 USERBUG-SEALED-E2E guard ['claudeAgent'] an owner's kept turn calls a bundled tool through the relay and the release door while its memory check never settles: the tool answers, the reply arrives, no card", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the turn must resume a retained session" }).toBeTruthy();
    const before = new Set((await messages(f.thread)).map(m => m.id));
    // The field shape: a revoke window that never settles, over the retained session.
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: "USERBUG_HOLD Reply with READY" });
    const seen = join(fixture.info.dataDir, "userbug-hold-seen");
    await expect.poll(() => existsSync(seen), { timeout: 45000, message: "the engine must hold the turn after its prompt" }).toBe(true);
    expect(rows("storm").filter(r => r.thread === f.thread), "the fixture must plant its window over a retained session").toEqual([{ thread: f.thread, session: true }]);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): no kept path on the owner's own turn; the tool path below is unchanged.
    expect(kept(f.thread), "the owner's own turn reads no pending window: no kept path").toBe(false);
    expect(resets(f.thread)).toEqual([]);
    const pid = readFileSync(seen, "utf8").trim().split("\n").at(-1)!;
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-claude"), "utf8"));
    const server = Object.keys(dump.mcpConfig?.mcpServers ?? {}).find(name => name === "agents" || name.endsWith("-agents"));
    expect(server, "the turn mounts the bundled agents server").toBeTruthy();
    // The model calls a tool: engine -> shim -> relay -> agents proxy -> release door -> relay -> engine.
    const box = join(fixture.info.dataDir, "userbug-mailbox"), response = join(box, `${pid}-call-1.json`);
    writeFileSync(join(box, `${pid}-call-1.pending`), JSON.stringify({ id: "call-1", server, name: "list_bots", args: {} }));
    renameSync(join(box, `${pid}-call-1.pending`), join(box, `${pid}-request.json`));
    await expect.poll(() => existsSync(response), { timeout: 30000, message: "the tool call must be answered while the check is still pending" }).toBe(true);
    const reply = JSON.parse(readFileSync(response, "utf8"));
    expect(reply.error, "the engine's MCP session to the tool stays open").toBeUndefined();
    expect(reply.result?.isError, "the tool's own answer, not a refusal").not.toBe(true);
    expect(reply.result?.content?.[0]?.type, "the tool's own result reaches the engine").toBe("text");
    writeFileSync(join(fixture.info.dataDir, "userbug-hold-gate"), "go");
    await routeFinished(f, 2);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(shown.filter(m => m.tool?.ok === false), "no card").toEqual([]);
    expect(shown.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    const log = readFileSync(fixture.info.logPath, "utf8");
    expect(log).not.toContain("seals the relay");
    expect(log).not.toContain("reason=mount-relay-sealed");
    expect(resets(f.thread)).toEqual([]);
  }, 180000);
  // W1 (ASTRA n4:5719: the production HTTP door on a booted server; this is the fix's witness, RED on 435d038d9c): POST
  // /api/bots/:id/messages, the real Claude driver, its mount relay and shim, the real bundled agents proxy and the release door the
  // server serves (POST /api/internal/turn-release/v1/verdict -> turn-release-door.ts handleTurnReleaseDoor). Only the model is scripted.
  // Unlike the guard above, the window that never settles opens AFTER the prompt was written, so the turn already holds its context and
  // every frame of its tool exchange is a proposal on that held context.
  it("USERBUG-SEALED-W1 ['claudeAgent'] an owner's written turn whose held context turns checking:pending forever: its tool call is answered through the HTTP release door, no seal, no card", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the turn must resume a retained session" }).toBeTruthy();
    const before = new Set((await messages(f.thread)).map(m => m.id));
    await api("POST", f.route, { threadId: f.thread, text: "USERBUG_HOLD Reply with READY" });
    const seen = join(fixture.info.dataDir, "userbug-hold-seen");
    await expect.poll(() => existsSync(seen), { timeout: 45000, message: "the engine must hold the turn after its prompt" }).toBe(true);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("Reply with READY")), "the owner's prompt was written").toHaveLength(1);
    writeFileSync(join(fixture.info.dataDir, "storm-late-flag"), f.thread);
    await expect.poll(() => rows("storm-late").filter(r => r.thread === f.thread).length, { timeout: 10000, message: "the window must open mid-turn" }).toBe(1);
    const pid = readFileSync(seen, "utf8").trim().split("\n").at(-1)!;
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-claude"), "utf8"));
    const server = Object.keys(dump.mcpConfig?.mcpServers ?? {}).find(name => name === "agents" || name.endsWith("-agents"));
    expect(server, "the turn mounts the bundled agents server").toBeTruthy();
    // The model calls a tool: engine -> shim -> relay -> agents proxy -> HTTP release door -> relay -> engine.
    const box = join(fixture.info.dataDir, "userbug-mailbox"), response = join(box, `${pid}-call-1.json`);
    writeFileSync(join(box, `${pid}-call-1.pending`), JSON.stringify({ id: "call-1", server, name: "list_bots", args: {} }));
    renameSync(join(box, `${pid}-call-1.pending`), join(box, `${pid}-request.json`));
    for (const until = Date.now() + 30000; !existsSync(response) && Date.now() < until;) await new Promise(done => setTimeout(done, 100));
    const log = () => readFileSync(fixture.info.logPath, "utf8");
    // the door first: a reply the HTTP release door (turn-release-door.ts handleTurnReleaseDoor) refuses is logged there before the relay seals
    expect(log(), "the HTTP release door refused nothing").not.toMatch(/swallowed error site=http\.turn-release\b/);
    expect(existsSync(response), "the tool call must be answered within 30 s (the relay's pending bound is 65 s)").toBe(true);
    const reply = JSON.parse(readFileSync(response, "utf8"));
    expect(reply.error, "the engine's MCP session to the tool stays open (no seal) under a check that never settles").toBeUndefined();
    expect(reply.result?.isError, "the tool's own answer, not a refusal").not.toBe(true);
    expect(reply.result?.content?.[0]?.type, "the tool's own result reaches the engine").toBe("text");
    writeFileSync(join(fixture.info.dataDir, "userbug-hold-gate"), "go");
    await routeFinished(f, 2);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(shown.filter(m => m.tool?.ok === false), "no card").toEqual([]);
    expect(shown.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(log()).not.toContain("seals the relay");
    expect(log()).not.toContain("reason=mount-relay-sealed");
  }, 180000);
  // 1.0.24 q1024-forgetracerace (FRICTION F20, which names the 1.0.20 "Some remembered details changed during this reply." line): the same
  // booted turn as W1, but what changes mid-turn is real: a line the running turn holds is forgotten through the memory route after the
  // owner's prompt was written, and the turn's tool call then goes through the release door. The tool answers, the reply is kept, and the
  // chat gets no memory row of any kind. A GUARD, not a base-RED witness: on dev/1024 4bf22c6743 this already holds, because since
  // q1023-ownerfence the owner's own direct turn is not re-judged at release, so the keep hook that wrote that line (index.ts
  // continueOwnerPending) is not reached on this route. It pins the deleted line against that hook being reached again.
  it("USERBUG-SEALED-MEMNOTE ['claudeAgent'] a line forgotten while the owner's turn runs: its tool call is answered, the reply is kept, no memory row", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the turn must resume a retained session" }).toBeTruthy();
    const source = (await messages(f.thread)).find(m => m.role === "user" && m.text === "Previous fixture message");
    expect(source?.id).toBeTruthy();
    const before = new Set((await messages(f.thread)).map(m => m.id));
    await api("POST", f.route, { threadId: f.thread, text: "USERBUG_HOLD Reply with READY" });
    const seen = join(fixture.info.dataDir, "userbug-hold-seen");
    await expect.poll(() => existsSync(seen), { timeout: 45000, message: "the engine must hold the turn after its prompt" }).toBe(true);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("Reply with READY")), "the owner's prompt was written").toHaveLength(1);
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${source.id}` });
    const pid = readFileSync(seen, "utf8").trim().split("\n").at(-1)!;
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-claude"), "utf8"));
    const server = Object.keys(dump.mcpConfig?.mcpServers ?? {}).find(name => name === "agents" || name.endsWith("-agents"));
    expect(server, "the turn mounts the bundled agents server").toBeTruthy();
    const box = join(fixture.info.dataDir, "userbug-mailbox"), response = join(box, `${pid}-call-1.json`);
    writeFileSync(join(box, `${pid}-call-1.pending`), JSON.stringify({ id: "call-1", server, name: "list_bots", args: {} }));
    renameSync(join(box, `${pid}-call-1.pending`), join(box, `${pid}-request.json`));
    for (const until = Date.now() + 30000; !existsSync(response) && Date.now() < until;) await new Promise(done => setTimeout(done, 100));
    expect(existsSync(response), "the tool call must be answered within 30 s").toBe(true);
    writeFileSync(join(fixture.info.dataDir, "userbug-hold-gate"), "go");
    await routeFinished(f, 2);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(shown.filter(m => m.memoryNote === "without-memory" || /changed during this reply|left out|Memory wasn't ready/.test(m.tool?.name ?? ""))).toEqual([]);
    expect(shown.filter(m => m.role === "bot" && m.kind === "text"), "the reply is kept").toHaveLength(1);
    expect(shown.filter(m => m.tool?.ok === false), "no card").toEqual([]);
  }, 180000);
  // 1.0.24 q1024-forgetracerace-h (ASTRA n4:9013 / n4:9100, FABLE n4:9162 / n4:9188, OPUS n4:9189): the running-pending keep hook (index.ts
  // continueOwnerPending) IS reached on the owner's direct turn when its reader is not the settled one: memory paused or off builds
  // { audience: null } and never swaps it for OWNER_TURN_READER, so every release re-judges what the turn holds. The same booted turn as
  // MEMNOTE above, with memory not active: a line the running turn holds is forgotten through the memory route after the owner's prompt
  // was written, and the turn's tool call then goes through the release door (send-fence.ts keepOwnerTurn asks the hook). The tool
  // answers, the reply is kept, the keep is one log line, and the chat gets no memory row (FRICTION F20: through 2b29e55bcc this hook
  // wrote "Some remembered details changed during this reply." here). Rows: every memory mode that is not active and still serves the
  // forget route (memory off answers that route 400, so nothing can be forgotten mid-turn there). The name carries USERBUG-SEALED
  // because the fixture arms the held engine by that name.
  it.each(["paused", "capture"])("USERBUG-SEALED-RUNPEND ['claudeAgent'] memory %s: a line forgotten while the owner's turn runs reaches the keep hook: tool answered, reply kept, one log line, no memory row", async mode => {
    await api("POST", "/api/memory/action", { action: "configure", mode });
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the turn must resume a retained session" }).toBeTruthy();
    const source = (await messages(f.thread)).find(m => m.role === "user" && m.text === "Previous fixture message");
    expect(source?.id).toBeTruthy();
    const before = new Set((await messages(f.thread)).map(m => m.id));
    await api("POST", f.route, { threadId: f.thread, text: "USERBUG_HOLD Reply with READY" });
    const seen = join(fixture.info.dataDir, "userbug-hold-seen");
    await expect.poll(() => existsSync(seen), { timeout: 45000, message: "the engine must hold the turn after its prompt" }).toBe(true);
    expect(rows("writes").filter(r => r.thread === f.thread && r.text.includes("Reply with READY")), "the owner's prompt was written").toHaveLength(1);
    const keepLines = () => readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(`[memory] held context changed during the owner turn on thread ${f.thread}; the turn continues without it`));
    expect(keepLines(), "nothing is kept before the forget").toEqual([]);
    await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${f.thread}:${source.id}` });
    const pid = readFileSync(seen, "utf8").trim().split("\n").at(-1)!;
    const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-claude"), "utf8"));
    const server = Object.keys(dump.mcpConfig?.mcpServers ?? {}).find(name => name === "agents" || name.endsWith("-agents"));
    expect(server, "the turn mounts the bundled agents server").toBeTruthy();
    const box = join(fixture.info.dataDir, "userbug-mailbox"), response = join(box, `${pid}-call-1.json`);
    writeFileSync(join(box, `${pid}-call-1.pending`), JSON.stringify({ id: "call-1", server, name: "list_bots", args: {} }));
    renameSync(join(box, `${pid}-call-1.pending`), join(box, `${pid}-request.json`));
    for (const until = Date.now() + 30000; !existsSync(response) && Date.now() < until;) await new Promise(done => setTimeout(done, 100));
    expect(existsSync(response), "the tool call must be answered within 30 s").toBe(true);
    writeFileSync(join(fixture.info.dataDir, "userbug-hold-gate"), "go");
    await routeFinished(f, 2);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(keepLines(), "the keep hook ran on this turn, once (the precondition of the row below: without it nothing is witnessed)").toHaveLength(1);
    expect(shown.filter(m => m.memoryNote !== undefined || /changed during this reply|left out|Memory wasn't ready/.test(m.tool?.name ?? "")).map(m => m.tool?.name ?? m.text), "no memory row for the keep").toEqual([]);
    expect(readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(`[memory] fence recovery tier=1 thread=${f.thread} `)).map(line => line.slice(line.indexOf("omitted="))), "the keep is this one log line").toEqual(["omitted=1 cause=changed"]);
    expect(shown.filter(m => m.role === "bot" && m.kind === "text"), "the reply is kept").toHaveLength(1);
    expect(shown.filter(m => m.tool?.ok === false), "no card").toEqual([]);
  }, 180000);
  // W3 (ASTRA pre-check r3 on 117f06c50c: the internal-route opt-in was a denylist, so the computer proxy's activity heartbeat took the owner
  // rule): the same booted turn as W1. Its tool call is answered (RED on 435d038d9c: no owner rule there), then a POST to the heartbeat
  // route (POST /api/internal/computer-activity, computer-proxy.ts) on the same live turn is NOT part of its tool exchange
  // (ownerToolExchangeRoute, consuming-turn-response.ts) and keeps the base refusal (GROK-HOLD Q-G3: conservative, no security ruling).
  // This fixture's bot has its computer off, so the turn holds no computer capability: the request carries the bundled agents proxy's
  // own token and index.ts answers it with the capability refusal, through the route's own consuming writer. That answer is what the
  // owner rule would have delivered (the denylist mutant delivers it); here it is refused like any response on held pending context.
  it("USERBUG-SEALED-W3 ['claudeAgent'] an owner's written turn under a check that never settles: its tool call is answered, a response on the heartbeat route does not take the owner rule", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the turn must resume a retained session" }).toBeTruthy();
    await api("POST", f.route, { threadId: f.thread, text: "USERBUG_HOLD Reply with READY" });
    const seen = join(fixture.info.dataDir, "userbug-hold-seen");
    await expect.poll(() => existsSync(seen), { timeout: 45000, message: "the engine must hold the turn after its prompt" }).toBe(true);
    writeFileSync(join(fixture.info.dataDir, "storm-late-flag"), f.thread);
    await expect.poll(() => rows("storm-late").filter(r => r.thread === f.thread).length, { timeout: 10000, message: "the window must open mid-turn" }).toBe(1);
    const pid = readFileSync(seen, "utf8").trim().split("\n").at(-1)!;
    const dump = withTurnSecrets(JSON.parse(readFileSync(join(fixture.info.dataDir, "wire-claude"), "utf8"))) as any;
    const server = Object.keys(dump.mcpConfig?.mcpServers ?? {}).find(name => name === "agents" || name.endsWith("-agents"))!;
    const token = dump.mcpConfig.mcpServers[server]?.env?.MURAGE_COMMS_TOKEN as string | undefined;
    expect(token, "the bundled agents proxy holds this turn's token").toBeTruthy();
    const box = join(fixture.info.dataDir, "userbug-mailbox"), response = join(box, `${pid}-call-1.json`);
    writeFileSync(join(box, `${pid}-call-1.pending`), JSON.stringify({ id: "call-1", server, name: "list_bots", args: {} }));
    renameSync(join(box, `${pid}-call-1.pending`), join(box, `${pid}-request.json`));
    for (const until = Date.now() + 30000; !existsSync(response) && Date.now() < until;) await new Promise(done => setTimeout(done, 100));
    expect(existsSync(response) && JSON.parse(readFileSync(response, "utf8")).result?.content?.[0]?.type, "the tool call is answered on the owner rule").toBe("text");
    const beat = await fetch(`${fixture.info.url}/api/internal/computer-activity`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20000) })
      .then(async r => ({ status: r.status, body: await r.text() }), error => ({ status: 0, body: String(error) }));
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T02:36:43Z REMOVAL, with 01:12:43Z): this row asserted 409 + the refusal line, a
    // response refused because the turn's held context was checking:pending, and the turn stopped by that refusal. The owner's own turn
    // reads no pending window, so its held context is not pending and no response of it is refused for that: the heartbeat route gives
    // its OWN answer (this bot has no computer: the capability refusal, 403), the turn is not stopped, and it ends with its reply and no
    // card. The allowlist itself (ownerToolExchangeRoute) is still witnessed over the whole route inventory: drivers/owner-pending-proposal-1022.test.ts.
    expect(beat, "the heartbeat route's own capability refusal, not a pending-context refusal").toEqual({ status: 403, body: JSON.stringify({ error: "capability cannot access this service" }) });
    const before = await ids(f.thread);
    writeFileSync(join(fixture.info.dataDir, "userbug-hold-gate"), "go");
    await routeFinished(f, 2);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(shown.filter(m => m.tool?.ok === false), "the heartbeat did not stop the owner's turn: no card").toEqual([]);
    expect(shown.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(resets(f.thread)).toEqual([]);
  }, 180000);
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
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's message-only tier-2): the last rebuild of a typed turn carries the seeded line, judged
    // shown and named, in the adapter's actual bytes. The transcript field is not asserted empty any more: these adapters do not replay it
    // natively (turn-context.ts), and the wire bytes above are what the engine receives.
    await expect.poll(wire).toContain("MESSAGE_ONLY_LATEST"); expect(wire()).toContain("EARLIER_CONVERSATION_LINE");
    const messageOnly = rows("attempts").filter(r => r.thread === g.thread && r.text.includes("MESSAGE_ONLY_LATEST")).at(-1)!;
    expect(messageOnly.text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    // WARM-GROK-1022 D1 (this pin was "the real adapter's message-only session must never be published"): the tier-2 rebuild replayed
    // the conversation, so the adapter's real session is kept and its cursor published.
    expect(savedCursor(g), "the real adapter's replay session publishes its cursor").toBeTruthy();
    scenario(g.thread, { seedReplayUser: true });
    await api("POST", g.route, { threadId: g.thread, text: "ROUTE_NEXT_ORDINARY" }); await routeFinished(g, 2);
    const next = rows("attempts").filter(r => r.thread === g.thread && r.text.includes("ROUTE_NEXT_ORDINARY"));
    // D4: the check has settled, so the replay session is refreshed and the next turn is still fresh (resumed false, unchanged). The Codex
    // row reaches this turn with no resume cursor (turn context builds it with resume=false, so the resumeCursor guard of the D4 check at
    // the continuation step never runs) and there is nothing to refresh; its fresh start and replayed line are still asserted below. Codex is not a WARM-GROK-1022 D row.
    // MAIN-RULING 2026-11-27T02:36:43Z REMOVAL (q1023-leftout CHANGED-ASSERTIONS.md; was toBe(true)): no partial-replay reset on the owner's own turn
    if (route !== "codex") expect(resets(g.thread).some(line => line.includes("reason=partial-replay-settled")), "no partial-replay reset on the owner's own turn").toBe(false);
    // REMOVAL (was resumed false on every route): the owner's next turn resumes the real adapter's published replay session (savedCursor above);
    // Codex has no resume cursor here, so it still starts fresh
    expect(next).toHaveLength(1); expect(next[0].resumed).toBe(route !== "codex");
    // a resumed session already holds the earlier line (its wire bytes below), so only the fresh Codex start replays it inline
    if (route === "codex") expect(next[0].text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
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
    // SABLE-IDENTITY-1020 (this pin was v1.0.20's message-only tier-2): a tier-2 last rebuild of a typed turn replays the shown earlier
    // line, as tier 1 does; only the generic tier-1 selective drop stays message-only. The withheld line below never goes out.
    if(!route&&tier===1)expect(recovered[0].text).not.toContain("EARLIER_CONVERSATION_LINE");
    if(tier===2)expect(recovered[0].text).toMatch(/^User: .*EARLIER_CONVERSATION_LINE/m);
    if(route){
      await expect.poll(wire).toContain('RAW_HUMAN_INPUT');
      expect(wire()).toContain('EARLIER_CONVERSATION_LINE');
    }
    // (1.0.24: the legacy store's message-only note arrives as the file an older build released; see CTX-HEAL)
    if (heal) { await expect.poll(() => savedCursor(f)).toBeTruthy(); await leaveLegacyMessageOnlyNotice(f.thread, "RAW_HUMAN_INPUT"); await fixture.restart(); await login(); }
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
  // cause 25 (TRIAGE-GROK-SPEED-1122; MAIN-RULING local-memory-budget: no local memory check may stop, refuse or delay an owner turn). On the
  // field thread every Grok turn (no resume cursor, so nothing is kept) was refused on a check stuck checking:pending, then waited the whole
  // 65 s bound for it before the rebuilt turn's engine was spawned. Now the owner's turn takes its last resort at once: what cannot be fenced
  // stays out, the skip is logged and the reply carries its left-out note. Outside input and the Claude kept path are unchanged.
  // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20): the left-out note is a log line; the reply carries no note row (the last assertion of ownerStartsAtOnce).
  const fenceWaitMs = () => [...readFileSync(fixture.info.logPath, "utf8").matchAll(/pending fence settle outcome=\w+ ms=(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const skipped = (thread: string) => readFileSync(fixture.info.logPath, "utf8").includes(`[memory] pending fence skipped thread=${thread} reason=checking:pending`);
  const ownerStartsAtOnce = async (room: boolean, field?: object) => {
    const f = await make(room);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" });
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(1);
    await expect.poll(() => busy(f, room), { timeout: 30000 }).toBe(false);
    const before = await ids(f.thread);
    // as on the field thread: no resume cursor is held, so nothing can be kept, and the prompt resting on the earlier lines is refused
    // before hand-back on a pending window that never settles; the refusal reaches the same rebuild the field log shows ("re-preparing")
    scenario(f.thread, field ?? { refusals: 1, pendingDeadline: true, noResume: true });
    await api("POST", f.route, { threadId: f.thread, text: "GROK_OWNER_LINE" });
    await expect.poll(() => rows("writes").filter(r => r.thread === f.thread && r.text.includes("GROK_OWNER_LINE")).length, { timeout: 30000 }).toBe(1);
    if (!room && !field) {
      // MAIN-RULING 2026-11-27T07:45:34Z (4), shipped REMOVAL (q1023-ownerrows CHANGED-ASSERTIONS.md; was: the production send fence refused the
      // first prompt, the turn re-prepared, and the reply carried a left-out note): the owner's own direct turn on the field Grok shape is sent
      // as built, once: no refusal, no re-prepare, no wait of any kind, no note. Rooms and the Grok field row below keep the strict assertions.
      await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(2);
      await expect.poll(() => busy(f, room), { timeout: 30000 }).toBe(false);
      const log = readFileSync(fixture.info.logPath, "utf8");
      expect(log, "no send-fence refusal on the owner's own turn").not.toMatch(/send fence refused \(checking:pending,/);
      expect(log, "no re-prepare on the owner's own turn").not.toContain(`context revoked during dispatch on thread ${f.thread}; re-preparing`);
      expect(rows("attempts").filter(r => r.thread === f.thread && r.text.includes("GROK_OWNER_LINE")), "sent once, never rebuilt").toHaveLength(1);
      expect(fenceWaitMs(), "fake-clock ms of any sleep in the owner's pending wait").toBe(0);
      const ownerShown = (await messages(f.thread)).filter(m => !before.has(m.id));
      expect(ownerShown.filter(m => m.text === "GROK_OWNER_LINE")).toHaveLength(1);
      expect(ownerShown.filter(m => m.role === "bot" && m.kind === "text")).toHaveLength(1);
      expect(ownerShown.filter(m => m.tool?.ok === false)).toEqual([]);
      expect(ownerShown.filter(m => m.memoryNote === "without-memory"), "no left-out note on the owner's own turn").toEqual([]);
      return;
    }
    // the scenario is real: the first prompt met the production send fence on a pending window that never settles
    // FLIPPED for the direct owner row by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): the owner's own direct turn reads no pending window,
    // so its forced refusal is not a checking:pending one, nothing is skipped and nothing is left out. Room and Grok-field rows unchanged.
    const ownerZone = !room && !field;
    if (ownerZone) expect(readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(f.thread) && /send fence refused \(checking:pending/.test(line))).toEqual([]);
    else expect(readFileSync(fixture.info.logPath, "utf8")).toMatch(/send fence refused \(checking:pending,/);
    expect(readFileSync(fixture.info.logPath, "utf8")).toContain(`context revoked during dispatch on thread ${f.thread}; re-preparing`);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("GROK_OWNER_LINE"));
    expect(attempts).toHaveLength(2);
    if (!room) expect(attempts.map(r => r.resumed)).toEqual([false, false]);
    // the spawn delay the fence added (fake clock; the shipped bound is 65,000 ms): none
    expect(fenceWaitMs(), "fake-clock ms the owner turn waited on its pending check before its engine was spawned").toBeLessThan(1000);
    // MAIN-RULING local-memory-budget: no wait at all, not a short one. The fake clock moves only when the wait sleeps, so 0 means no timer.
    expect(fenceWaitMs(), "fake-clock ms of any sleep in the owner's pending wait").toBe(0);
    expect(skipped(f.thread), "the skip is recorded (never on the owner's own direct turn: nothing to skip)").toBe(!ownerZone);
    // the rebuilt turn ran on the real engine process: the scripted CLI received the owner's line on its stdin
    if (field) await expect.poll(() => existsSync(join(fixture.info.dataDir, "wire-bytes")) && readFileSync(join(fixture.info.dataDir, "wire-bytes"), "utf8").includes("GROK_OWNER_LINE"), { timeout: 30000 }).toBe(true);
    await expect.poll(() => rows("terminal-replies").filter(r => r.thread === f.thread).length, { timeout: 60000 }).toBe(2);
    await expect.poll(() => busy(f, room), { timeout: 30000 }).toBe(false);
    const shown = (await messages(f.thread)).filter(m => !before.has(m.id));
    expect(shown.filter(m => m.text === "GROK_OWNER_LINE")).toHaveLength(1);
    expect(shown.filter(m => m.role === "bot" && m.kind === "text")).toHaveLength(1);
    expect(shown.filter(m => m.text === LEDGER_REFUSAL_LINE)).toEqual([]);
    expect(shown.filter(m => m.tool?.ok === false)).toEqual([]);
    expect(shown.filter(m => m.memoryNote === "without-memory"), "the chat gets no memory row").toEqual([]);
  };
  // The rebuild and its wait are engine-independent (index.ts rebuildRefusedDirectTurn): the fixture's engine refuses before hand-back as the
  // field Grok turn did. The real Grok driver here meets the fence only after hand-back (acp/core.ts ledger refusal), so W1G guards Grok itself.
  it("GROKFENCE-W1 a direct owner turn with no resume cursor (the field Grok shape) whose check stays checking:pending starts without the fence wait", () => ownerStartsAtOnce(false), 120000);
  // the room owner's last resort (A-3) takes the same no-wait start
  it("GROKFENCE-W1R a room owner turn whose check stays checking:pending starts without the fence wait", () => ownerStartsAtOnce(true), 120000);
  // The field shape on the real Grok driver (grok.ts over the scripted ACP CLI): the production send fence refuses the first prompt during
  // setup, before Grok hands the turn back, on a pending window that never settles; the rebuilt turn is spawned on the real Grok driver.
  // On c3f339db41 that spawn waited the whole 65,000 ms bound (fake clock); the owner's turn now starts at once and completes.
  it("GROKFENCE-W1G ['grokAgent'] a Grok owner turn with no resume cursor refused on checking:pending before hand-back spawns its rebuild at once and completes", () => ownerStartsAtOnce(false, { setupRefuse: true, pendingDeadline: true, noResume: true }), 120000);
  it("GROKFENCE-W2 outside input (a webhook-triggered run) on the same pending check is unchanged: refused at once, no skip, no write", async () => {
    const f = await make(false);
    const made = await api("POST", "/api/routines", { botId: f.bot.id, name: "Outside routine", prompt: "GROK_OUTSIDE_PROMPT", schedule: { type: "once", at: Date.now() + 3_600_000 } });
    await api("POST", `/api/routines/${made.routine.id}/run`, {});
    await expect.poll(() => rows("writes").filter(r => r.text.includes("GROK_OUTSIDE_PROMPT")).length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    const thread = rows("writes").find(r => r.text.includes("GROK_OUTSIDE_PROMPT")).thread as string;
    await finished(thread);
    await expect.poll(() => busy({ bot: f.bot, thread }, false), { timeout: 30000 }).toBe(false);
    const before = await ids(thread), writesBefore = rows("writes").filter(r => r.thread === thread).length;
    scenario(thread, { refusals: 1, pendingDeadline: true, outsideTrigger: true, noResume: true });
    await api("POST", `/api/routines/${made.routine.id}/run`, {});
    await expect.poll(async () => (await messages(thread)).filter(m => !before.has(m.id) && m.text === LEDGER_REFUSAL_LINE).length, { timeout: 60000 }).toBe(1);
    // outside input never takes the owner's last resort: its refusal is not held for a rebuild, so it neither waits nor writes
    expect(fenceWaitMs()).toBe(0);
    expect(skipped(thread)).toBe(false);
    expect(rows("writes").filter(r => r.thread === thread)).toHaveLength(writesBefore);
  }, 120000);
  it("GROKFENCE-W3 ['claudeAgent'] the kept path is unchanged: an owner's resumed turn on checking:pending keeps its session and never reaches the skip", async () => {
    const f = await make(false);
    await api("POST", f.route, { threadId: f.thread, text: "Previous fixture message" }); await routeFinished(f, 1);
    await expect.poll(() => savedCursor(f), { message: "the second turn must resume a retained session" }).toBeTruthy();
    scenario(f.thread, { storm: true });
    await api("POST", f.route, { threadId: f.thread, text: "CLAUDE_KEPT_LINE" });
    await routeFinished(f, 2);
    // FLIPPED by 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-27T01:12:43Z): the owner's resumed turn is no longer kept memory-free under the window: it
    // resumes its session with no kept line and no reset, and still never reaches the skip or a wait.
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(`memory continuation kept thread=${f.thread} `);
    expect(resets(f.thread)).toEqual([]);
    const attempts = rows("attempts").filter(r => r.thread === f.thread && r.text.includes("CLAUDE_KEPT_LINE"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].resumed).toBe(true);
    expect(skipped(f.thread)).toBe(false);
    expect(fenceWaitMs()).toBe(0);
  }, 150000);

  // 1.0.24 q1024-forgetracerace (FRICTION F20; ASTRA pre-check on 7dc320b8a4): no turn writes a notice file. The scenario of "R11 refusing
  // every tier" above: the last rebuild recovered (its tier-2 log line) and was refused too, so nothing was ever released. Through 1.0.23
  // that rebuild's prepared notice (fence-notices/<id>.json, written before the adapter could release a write) stayed on disk until the
  // next start; now the directory is never written. (Placed last so the rows above keep their line numbers.)
  it("NOTICEFILE a turn refused at every tier, its last rebuild included, leaves no notice file on disk", async () => {
    const f = await make(); scenario(f.thread, { refusals: 3 });
    await api("POST", f.route, { threadId: f.thread, text: "RAW_HUMAN_INPUT" });
    await expect.poll(async () => (await messages(f.thread)).filter(m => m.tool?.ok === false).length, { timeout: 30000 }).toBe(1);
    expect(rows("attempts").filter(r => r.thread === f.thread)).toHaveLength(3);
    expect(noticeFiles(), "no turn writes a notice file").toEqual([]);
    expect(recoveryTiers(f.thread), "the last rebuild recovered and was logged").toContain(2);
    expect(await memoryNotes(f.thread)).toEqual([]);
  }, 60000);
  // ASTRA pass 2 on 61f11a7a07: boot still APPENDS one kind of row (the released legacy message-only note), so the transient "append" fault
  // row the B3 rewrite dropped is kept for that path: the store refuses the append once, the boot pass retries without a restart, and the
  // row is written exactly once with its file removed. (The fault fires at the repair's own store.appendMessage; placed last so the rows
  // above keep their line numbers.)
  it("B3 boot repair of a released message-only note retries a transient append failure without restart, and writes the row once", async () => {
    const f = await make();
    const id = "memory-note-" + "d".repeat(64);
    leaveNotice({ threadId: f.thread, id, line: MESSAGE_ONLY_NOTE, released: true, turnId: "legacy-turn-append" });
    writeFileSync(join(fixture.info.dataDir, "notice-faults"), JSON.stringify({ site: "append", left: 1 }));
    await fixture.restart(); await login();
    await expect.poll(() => noticeFiles(), { timeout: 10000 }).toEqual([]);
    expect((await messages(f.thread)).filter(m => m.id === id).map(m => [m.memoryNote, m.tool?.name, m.turnId])).toEqual([["without-memory", MESSAGE_ONLY_NOTE, "legacy-turn-append"]]);
    expect(rows("notice-fault-attempts"), "the append was refused once").toEqual([expect.objectContaining({ site: "append" })]);
    const diagnostic = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes("notice reconciliation"));
    expect(diagnostic.join("\n")).toContain("attempts=2 failures=1 unresolved=0");
    expect(diagnostic.join("\n")).not.toMatch(/PRIVATE_NOTICE|memory-note-|d{64}/);
  }, 60000);
});
