// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture and HTTP consumer owner: r7orph-fx3. Behavior authority: MAIN G17.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_CLOSED_LATE_NOTE, PROVIDER_STOP_UNCONFIRMED_LINE } from "./direct-late-close.ts";
import { CLI_CALLER_DEADLINE_MS } from "./procs.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const file = (name: string) => join(fixture.info.dataDir, name);
const events = () => existsSync(file("setup-events"))
  ? readFileSync(file("setup-events"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  if (method === "PATCH" && /^\/api\/bots\/[^/]+$/.test(path) && body && typeof body === "object" && "browserProfile" in body) {
    const profile = (body as { browserProfile?: string }).browserProfile;
    const preview = await api("GET", path + "/browser-choice/preview?" + new URLSearchParams({ mode: "builtin", ...(profile ? { profile } : {}) }));
    body = { ...body, disclosureKey: preview.body.disclosure.disclosureKey };
  }
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const busy = async (bot: { id: string; threadId: string }) =>
  (await api("GET", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).body.task.busy;

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {registerHooks} = await import('node:module');
    const dir = process.env.MURAGE_DATA_DIR;
    globalThis.__setupEvent = event => fs.appendFileSync(path.join(dir,'setup-events'),JSON.stringify(event)+'\\n');
    const {mock}=await import('node:test');
    globalThis.__setupGate = async (threadId,phase,claim) => {
      const plan = path.join(dir,'hold-'+threadId);
      if(!fs.existsSync(plan) || fs.readFileSync(plan,'utf8')!==phase)return;
      globalThis.__setupEvent({kind:'held',threadId,phase:claim?.phase,providerTurnId:null});
      fs.writeFileSync(plan+'.waiting','');
      await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(plan+'.released')){clearInterval(timer);resolve();}},10);});
    };
    globalThis.__setupCloseThreads=new WeakMap();
    registerHooks({load(url,context,next){
      if(url.endsWith('/server/direct-late-close.ts')){
        const loaded=next(url,context);const source=String(loaded.source);
        return {...loaded,source:source.replace('    if (!input.owns() || !input.threadExists())',
          "    const setupOwns=input.owns();globalThis.__setupEvent({kind:'watch-fired',threadId:globalThis.__setupCloseThreads.get(input.closed),owns:setupOwns});if (!setupOwns || !input.threadExists())")};
      }
      if(url.endsWith('/server/drivers/claude.ts')){
        const loaded=next(url,context);const source=String(loaded.source);
        return {...loaded,source:source.replace('active.set(threadId, reservation);',"active.set(threadId, reservation); globalThis.__setupEvent({kind:'reservation',threadId,turnId,hasSession:active.has(threadId)});")};
      }
      if(!url.endsWith('/server/index.ts'))return next(url,context);
      let source=fs.readFileSync(new URL(url),'utf8');
      const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('setup fixture anchor moved');source=source.replace(from,to);};
      replace('const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {',
        "const setupActivity=store.setTaskActivity.bind(store);store.setTaskActivity=(botId,threadId,activity)=>{globalThis.__setupEvent({kind:'activity',threadId,activity});return setupActivity(botId,threadId,activity);};\\nglobalThis.__directSetupState = threadId => { const run=directRuns.get(threadId);return {busy:store.taskByThread(run?.botId,threadId)?.busy,phase:run?.phase,generation:run?.generation,ledger:run?admittedLedgerLeases.has(run.generation):false,leases:run?directRuns.heldBy(run):[]}; };\\nconst foldRuntimeEvent = (executionEvent: RuntimeEvent) => {\\n  if(executionEvent.type==='turn.completed')globalThis.__setupEvent({kind:'completion-fold',threadId:executionEvent.threadId,turnId:executionEvent.turnId});");
      replace('const foldRuntimeEvent = (executionEvent: RuntimeEvent) => {',
        "globalThis.__claimSetupResources = async threadId => { const run=directRuns.get(threadId); if(!await directRuns.acquire(run,['workspace:'+threadId,'computer:'+threadId,'browser:'+threadId]))throw Error('fixture resources refused'); };\\nconst foldRuntimeEvent = (executionEvent: RuntimeEvent) => {");
      const cancel = 'function cancelDirectTurnDispatch(';
      replace(cancel,
        "globalThis.__changeSetupOwner = (threadId,change) => { const run=directRuns.get(threadId); if(change==='delete')store.deleteBot(run.botId); else { const resources=directRuns.heldBy(run);directRuns.release(run);const next=directRuns.admit(run.botId,threadId,run.snapshot,resources);store.setTaskActivity(run.botId,threadId,'working');globalThis.__setupEvent({kind:'successor',threadId,generation:next.generation});} };\\n" + cancel);
      replace('      const ownsRejectedConversation = admitted.rejectionOwner.current();',
        '      const observedSetupProof = directTurnCancellationProofs.get(dispatchClaimId)?.get(run.generation);\\n      const ownsRejectedConversation = admitted.rejectionOwner.current();');
      if(source.includes('function retireStoppedDirectGeneration(')){
        const anchor='function retireStoppedDirectGeneration(run: DirectThreadRun<BotRecord>, botId: string, threadId: string, sameConversationGeneration: () => boolean): boolean {';
        replace(anchor,anchor+"globalThis.__setupEvent({kind:'retire-attempt',threadId,generation:run.generation});");
      }
      replace('      if(acceptedTurnCleanupFailed) {',
        "      globalThis.__setupEvent({kind:'catch-state',threadId,cleanupFailed:acceptedTurnCleanupFailed,...globalThis.__directSetupState(threadId)});\\n      if(acceptedTurnCleanupFailed) {");
      replace('  if (shouldIgnoreProviderEvent(event)) return;\\n  const attemptRun =',
        "  if (shouldIgnoreProviderEvent(event)) { globalThis.__setupEvent({kind:'completion-ignored',threadId:event.threadId,turnId:event.turnId}); return; }\\n  const attemptRun =");
      replace('      await acquireDirectTurnSlot(run);',
        "      await globalThis.__setupGate(threadId,'setup',directTurnDispatchClaims.get(threadId));\\n      await acquireDirectTurnSlot(run);");
      replace('      watchdog.dispatched(threadId, bot.id, dispatchClaimId);',
        "      await globalThis.__setupGate(threadId,'dispatching',directTurnDispatchClaims.get(threadId));\\n      watchdog.dispatched(threadId, bot.id, dispatchClaimId);");
      replace('  const claim = directTurnDispatchClaims.get(threadId);\\n  if (!claim || claim.botId!==botId) return null;',
        "  const claim = directTurnDispatchClaims.get(threadId);\\n  globalThis.__setupEvent({kind:'stop',threadId,phase:claim?.phase,currentPhase:directRuns.get(threadId)?.phase});\\n  if (!claim || claim.botId!==botId) return null;");
      replace('        admitted.dispatchErrorCalled = true;\\n        opts?.onDispatchError?.(e.message,',
        "        globalThis.__setupEvent({kind:'cancelled',threadId,phase:run.phase,currentPhase:directRuns.get(threadId)?.phase,current:directRuns.current(run),claimPhase:directTurnDispatchClaims.get(threadId)?.phase??null,providerTurnId:directRuns.get(threadId)?.providerTurnId??null,canRetry:submissionBoundary.canRetry,proofPhase:observedSetupProof?.phase??null,proofCanRetry:observedSetupProof?.canRetry??null,proofGeneration:observedSetupProof?.generation??null,generation:run.generation,currentGeneration:directRuns.get(threadId)?.generation??null,sameConversation:store.taskByThread(bot.id,threadId)===task,sameGeneration:directConversationGenerations.get(task)===run.generation,frozen:Object.isFrozen(run)});\\n        admitted.dispatchErrorCalled = true;\\n        opts?.onDispatchError?.(e.message,");
      replace('      recordMemorySettlement(threadId, dispatchClaimId, "setup-failed");',
        '      globalThis.__setupEvent({kind:"terminal-capture",threadId});\\n      recordMemorySettlement(threadId, dispatchClaimId, "setup-failed");');
      return {format:'module-typescript',shortCircuit:true,source};
    }});
    const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
    const {makeLateTerminalDriver}=await import(${JSON.stringify(new URL("./testing/fake-late-terminal-driver.ts", import.meta.url).href)});
    const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
    driver.create=async input=>{
      const instance=await create(input); const send=instance.adapter.sendTurn.bind(instance.adapter);
      const listeners=new Set();const onEvent=instance.adapter.onEvent.bind(instance.adapter);
      instance.adapter.onEvent=listener=>{listeners.add(listener);const off=onEvent(listener);return ()=>{listeners.delete(listener);off();};};
      const interrupt=instance.adapter.interruptTurn.bind(instance.adapter);
      const inflight=threadId=>path.join(dir,'inflight-'+threadId);
      const closed=new Map();
      instance.adapter.awaitTurnClose=(threadId,turnId)=>{
        const plan=inflight(threadId);if(!fs.existsSync(plan))return new Promise(()=>{});
        const settings=JSON.parse(fs.readFileSync(plan,'utf8'));
        if(settings.forget && fs.existsSync(plan+'.interrupted'))return new Promise(()=>{});
        globalThis.__setupEvent({kind:'watch-close',threadId,turnId});
        let watch=closed.get(turnId);if(!watch){watch=new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(plan+'.closed')){clearInterval(timer);resolve();}},10);timer.unref();});closed.set(turnId,watch);globalThis.__setupCloseThreads.set(watch,threadId);}
        return watch;
      };
      const commands=setInterval(()=>{
        for(const name of fs.readdirSync(dir).filter(name=>name.startsWith('inflight-') && name.endsWith('.inspect'))){
          const threadId=name.slice(9,-8);fs.unlinkSync(path.join(dir,name));globalThis.__setupEvent({kind:'inspect',threadId,...globalThis.__directSetupState(threadId)});
        }
        for(const change of ['delete','successor'])for(const name of fs.readdirSync(dir).filter(name=>name.startsWith('inflight-') && name.endsWith('.'+change))){
          fs.unlinkSync(path.join(dir,name));const threadId=name.slice(9,-change.length-1);globalThis.__changeSetupOwner(threadId,change);globalThis.__setupEvent({kind:'changed',threadId,change});
        }
        const tick=path.join(dir,'advance-setup-clock');if(fs.existsSync(tick)){fs.unlinkSync(tick);mock.timers.tick(3*5500+1);mock.timers.reset();globalThis.__setupEvent({kind:'clock-advanced'});}
      },10);commands.unref();
      instance.adapter.interruptTurn=async (threadId,turnId)=>{if(fs.existsSync(inflight(threadId))){if(turnId)fs.writeFileSync(inflight(threadId)+'.interrupted','');globalThis.__setupEvent({kind:'interrupt',threadId,turnId:turnId??null});return;}return interrupt(threadId,turnId);};
      instance.adapter.awaitTurnTeardown=async (threadId,turnId)=>{
        const plan=inflight(threadId);if(!fs.existsSync(plan))return {closeConfirmed:false};
        globalThis.__setupEvent({kind:'teardown',threadId,turnId});
        const settings=JSON.parse(fs.readFileSync(plan,'utf8'));
        if(settings.teardownGate)await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(plan+'.teardown')){clearInterval(timer);resolve();}},10);});
        globalThis.__setupEvent({kind:'teardown-resolved',threadId,turnId});
        return {closeConfirmed:settings.confirmed===true};
      };
      instance.adapter.sendTurn=async turn=>{
        globalThis.__setupEvent({kind:'adapter-submit',threadId:turn.threadId});
        const plan=inflight(turn.threadId);if(!fs.existsSync(plan))return send(turn);
        const settings=JSON.parse(fs.readFileSync(plan,'utf8'));
        if(settings.resources)await globalThis.__claimSetupResources(turn.threadId);
        if(settings.never)mock.timers.enable({apis:['setTimeout']});
        const turnId='stopping-'+turn.threadId;
        if(settings.written){
          const attempt=turn.beforeSubmit?.();
          globalThis.__setupEvent({kind:'prompt-released',threadId:turn.threadId,turnId,text:turn.text});
          turn.attemptWritten?.(attempt);turn.onEngineWrite?.();
        }
        const emit=type=>{const event={eventId:crypto.randomUUID(),type,provider:'fakeLateTerminal',providerInstanceId:instance.instanceId,createdAt:new Date().toISOString(),threadId:turn.threadId,turnId,ok:false,stopReason:'interrupted'};for(const listener of listeners)listener(event,turn.sourceContext);};
        emit('turn.started');
        globalThis.__setupEvent({kind:'inflight',threadId:turn.threadId,turnId});
        await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(plan+'.released')){clearInterval(timer);resolve();}},10);});
        if(settings.reject)throw Error('fixture setup rejected after Stop');
        if(!settings.noCompletion)emit('turn.completed');
        const replay=setInterval(()=>{if(fs.existsSync(plan+'.replay')){clearInterval(replay);emit('turn.completed');}},10);replay.unref();
        globalThis.__setupEvent({kind:'sync-completed',threadId:turn.threadId,turnId,...globalThis.__directSetupState(turn.threadId)});
        return {turnId};
      };
      return instance;
    };
    BUILT_IN_DRIVERS.push(driver);
    const configFile=path.join(dir,'config.json');const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    config.instances.setup={driver:'fakeLateTerminal'};
    const sentinelCli=path.join(dir,'sentinel-cli.mjs');
    const sentinelSource=fs.readFileSync(new URL(${JSON.stringify(new URL('./testing/direct-setup-sentinel-cli.mjs', import.meta.url).href)}),'utf8')
      .replace('await import("./fake-claude-cli.ts");','await import('+JSON.stringify(${JSON.stringify(new URL('./testing/fake-claude-cli.ts', import.meta.url).href)})+');');
    fs.writeFileSync(sentinelCli,sentinelSource,{mode:0o755});
    config.instances.blocked={driver:'claudeAgent',config:{cli:sentinelCli}};
    fs.writeFileSync(configFile,JSON.stringify(config));
  ` });
  const proof = (await api("GET", "/api/desktop-secret")).body;
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
}, 30_000);
afterAll(async () => { await fixture?.close(); });

it.each(["setup", "dispatching"])("owner Stop retires pre-provider %s without submitting and admits the next turn", async phase => {
  const created = await api("POST", "/api/bots", { name: "Setup fixture", modelSelection: { instanceId: "setup", model: "late-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  writeFileSync(file("hold-" + bot.threadId), phase);
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold before any adapter call" })).status).toBe(202);
    await expect.poll(() => existsSync(file("hold-" + bot.threadId + ".waiting")), { timeout: 5_000 }).toBe(true);
    expect(events().filter(event => event.threadId === bot.threadId && event.kind === "held")).toEqual([
      { kind: "held", threadId: bot.threadId, phase, providerTurnId: null },
    ]);
    expect(await busy(bot)).toBe(true);
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stopped.status).toBe(200);
    expect(stopped.body.ok).toBe(true);
    writeFileSync(file("hold-" + bot.threadId + ".released"), "");
    await expect.poll(() => events().some(event => event.threadId === bot.threadId && event.kind === "cancelled"), { timeout: 5_000 }).toBe(true);
    const observed = events().filter(event => event.threadId === bot.threadId);
    if (phase === "dispatching") {
      const cancelled = observed.find(event => event.kind === "cancelled");
      expect(cancelled).toMatchObject({ phase: "setup", currentPhase: "stopping", current: true,
        claimPhase: null, providerTurnId: null, proofPhase: "dispatching", proofCanRetry: true,
        sameConversation: true, sameGeneration: true, frozen: true });
      expect(cancelled.proofGeneration).toBe(cancelled.generation);
      expect(cancelled.proofGeneration).toBe(cancelled.currentGeneration);
    }
    expect(observed.filter(event => event.kind === "adapter-submit")).toEqual([]);
    expect(observed.filter(event => event.kind === "terminal-capture")).toEqual([]);
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.filter((message: any) => String(message.tool?.name ?? "").startsWith("error:"))).toEqual([]);
    expect.soft(await busy(bot), JSON.stringify(observed)).toBe(false);
    const next = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "after the stopped setup" });
    expect.soft(next.status, JSON.stringify({ observed, next: next.body })).toBe(202);

  } finally {
    writeFileSync(file("hold-" + bot.threadId + ".released"), "");
  }
});


it("W5: synchronous production completion before handback cannot settle a replacement", async () => {
  const bot = (await api("POST", "/api/bots", { name: "In-flight fixture", modelSelection: { instanceId: "setup", model: "late-1" } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const plan = file("inflight-" + bot.threadId);
  writeFileSync(plan, JSON.stringify({ confirmed: true }));
  try {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold send before handback" })).status).toBe(202);
    await expect.poll(() => events().some(event => event.kind === "inflight" && event.threadId === bot.threadId), { timeout: 5_000 }).toBe(true);
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stopped.status).toBe(200);
    expect(stopped.body.ok).toBe(true);
    expect(await busy(bot)).toBe(true);
    writeFileSync(plan + ".released", "");
    await expect.poll(() => events().some(event => event.kind === "cancelled" && event.threadId === bot.threadId), { timeout: 5_000 }).toBe(true);
    const observed = events().filter(event => event.threadId === bot.threadId);
    expect(observed.filter(event => event.kind === "completion-fold")).toHaveLength(1);
    expect(observed.filter(event => event.kind === "completion-ignored")).toHaveLength(1);
    expect(observed.find(event => event.kind === "sync-completed")).toMatchObject({ busy: true, phase: "stopping" });
    expect(observed.find(event => event.kind === "cancelled")).toMatchObject({ proofPhase: "dispatching", proofCanRetry: false, canRetry: false });
    expect(observed.filter(event => event.kind === "teardown")).toHaveLength(1);
    expect(await busy(bot)).toBe(false);
    // Hold the replacement before any adapter call while the old completion is redelivered.
    writeFileSync(file("hold-" + bot.threadId), "dispatching");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "replacement remains busy" })).status).toBe(202);
    await expect.poll(() => existsSync(file("hold-" + bot.threadId + ".waiting")), { timeout: 5_000 }).toBe(true);
    writeFileSync(plan + ".replay", "");
    await expect.poll(() => events().filter(event => event.kind === "completion-fold" && event.threadId === bot.threadId).length, { timeout: 5_000 }).toBe(2);
    expect(events().filter(event => event.kind === "completion-ignored" && event.threadId === bot.threadId)).toHaveLength(2);
    expect(await busy(bot)).toBe(true);
    expect(events().filter(event => event.threadId === bot.threadId && event.kind === "terminal-capture")).toEqual([]);
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
    expect(messages.filter((message: any) => String(message.tool?.name ?? "").startsWith("error:"))).toEqual([]);
  } finally {
    writeFileSync(plan + ".released", "");
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    writeFileSync(file("hold-" + bot.threadId + ".released"), "");
  }
});

const lines = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages.map((message: any) => message.tool?.name);
const threadEvents = (threadId: string) => events().filter(event => event.threadId === threadId);
async function inspect(threadId: string) {
  const before = threadEvents(threadId).filter(event => event.kind === "inspect").length;
  writeFileSync(file("inflight-" + threadId + ".inspect"), "");
  await expect.poll(() => threadEvents(threadId).filter(event => event.kind === "inspect").length, { timeout: 5_000 }).toBe(before + 1);
  return threadEvents(threadId).filter(event => event.kind === "inspect").at(-1);
}
async function stoppedInflight(settings: Record<string, boolean>) {
  const created = await api("POST", "/api/bots", { name: "Teardown fixture", modelSelection: { instanceId: "setup", model: "late-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const plan = file("inflight-" + bot.threadId);
  writeFileSync(plan, JSON.stringify({ resources: true, noCompletion: true, written: true, ...settings }));
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "hold exact provider teardown" })).status).toBe(202);
  await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "inflight"), { timeout: 5_000 }).toBe(true);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "prompt-released")).toEqual([
    expect.objectContaining({ text: expect.stringContaining("hold exact provider teardown") }),
  ]);
  expect(await busy(bot)).toBe(true);
  const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  expect(stopped.status).toBe(200);
  expect(stopped.body.ok).toBe(true);
  writeFileSync(plan + ".released", "");
  return { bot, plan };
}

it("W7: void interrupt waits for exact teardown before idling and releasing leases", async () => {
  const { bot, plan } = await stoppedInflight({ confirmed: true, teardownGate: true });
  try {
    await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "teardown"), { timeout: 5_000 }).toBe(true);
    expect(await busy(bot)).toBe(true);
    expect((await inspect(bot.threadId)).leases).toEqual(expect.arrayContaining(["workspace:" + bot.threadId, "computer:" + bot.threadId, "browser:" + bot.threadId]));
    expect(threadEvents(bot.threadId).filter(event => event.kind === "activity" && event.activity === "idle")).toEqual([]);
    writeFileSync(plan + ".teardown", "");
    await expect.poll(() => busy(bot), { timeout: 5_000 }).toBe(false);
    const observed = threadEvents(bot.threadId);
    expect(observed.findIndex(event => event.kind === "teardown-resolved")).toBeLessThan(observed.findIndex(event => event.kind === "activity" && event.activity === "idle"));
    expect((await inspect(bot.threadId))).toMatchObject({ leases: [], ledger: false });
    expect((await lines(bot.threadId)).filter((line: string) => line?.startsWith("error:"))).toEqual([]);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "after exact teardown" })).status).toBe(202);
  } finally { writeFileSync(plan + ".teardown", ""); }
});

it.each(["close", "forgotten-child", "delete", "successor"])("W8: retained exact turn handles %s without touching another owner", async variant => {
  const { bot, plan } = await stoppedInflight({ confirmed: false, forget: variant === "forgotten-child" });
  await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "catch-state"), { timeout: 5_000 }).toBe(true);
  expect(await busy(bot)).toBe(true);
  expect((await lines(bot.threadId)).filter((line: string) => line === PROVIDER_STOP_UNCONFIRMED_LINE)).toHaveLength(1);
  expect((await lines(bot.threadId)).filter((line: string) => line?.startsWith("error:"))).toEqual([PROVIDER_STOP_UNCONFIRMED_LINE]);
  const held = await inspect(bot.threadId);
  expect(held.leases).toEqual(expect.arrayContaining(["workspace:" + bot.threadId, "computer:" + bot.threadId, "browser:" + bot.threadId]));
  expect(held.ledger).toBe(true);
  const refused = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "refuse before exact close", noSteer: true });
  expect(refused.status).toBe(202);
  expect(refused.body).toMatchObject({ queued: true });
  expect((await inspect(bot.threadId)).generation).toBe(held.generation);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "adapter-submit")).toHaveLength(1);
  expect((await api("DELETE", `/api/bots/${bot.id}/queue/${refused.body.queueId}`)).status).toBe(200);
  if (variant === "delete" || variant === "successor") {
    writeFileSync(plan + "." + variant, "");
    await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "changed"), { timeout: 5_000 }).toBe(true);
  }
  writeFileSync(plan + ".closed", "");
  await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "watch-fired"), { timeout: 5_000 }).toBe(true);
  expect(threadEvents(bot.threadId).find(event => event.kind === "watch-fired").owns).toBe(variant !== "delete" && variant !== "successor");
  if (variant === "delete" || variant === "successor") {
    // The observation command runs after the close promise's microtask callbacks.
    const current = await inspect(bot.threadId);
    expect(threadEvents(bot.threadId).filter(event => event.kind === "activity" && event.activity === "idle")).toEqual([]);
    if (variant === "successor") {
      expect(current.busy).toBe(true);
      expect(current.generation).toBe(threadEvents(bot.threadId).find(event => event.kind === "successor").generation);
      expect(current.leases).toEqual(held.leases);
      expect((await lines(bot.threadId)).filter((line: string) => line === ENGINE_CLOSED_LATE_NOTE)).toEqual([]);
    } else expect((await api("GET", `/api/bots/${bot.id}`)).status).toBe(404);
  } else {
    await expect.poll(() => busy(bot), { timeout: 5_000 }).toBe(false);
    expect((await lines(bot.threadId)).filter((line: string) => line === ENGINE_CLOSED_LATE_NOTE)).toHaveLength(1);
    expect((await inspect(bot.threadId))).toMatchObject({ leases: [], ledger: false });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "after late close" })).status).toBe(202);
    await expect.poll(() => threadEvents(bot.threadId).filter(event => event.kind === "adapter-submit").length, { timeout: 5_000 }).toBe(2);
  }
});

it("W9: a provider that never closes retains its leases visibly beyond three deadlines", async () => {
  const { bot } = await stoppedInflight({ confirmed: false, never: true });
  await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "catch-state"), { timeout: 5_000 }).toBe(true);
  const before = await inspect(bot.threadId);
  const clocks = events().filter(event => event.kind === "clock-advanced").length;
  writeFileSync(file("advance-setup-clock"), String(3 * CLI_CALLER_DEADLINE_MS + 1));
  await expect.poll(() => events().filter(event => event.kind === "clock-advanced").length, { timeout: 5_000 }).toBe(clocks + 1);
  expect(await busy(bot)).toBe(true);
  const after = await inspect(bot.threadId);
  expect(after).toMatchObject({ generation: before.generation, phase: "stopping", leases: before.leases, ledger: true });
  expect(after.leases).toEqual(expect.arrayContaining(["workspace:" + bot.threadId, "computer:" + bot.threadId, "browser:" + bot.threadId]));
  expect((await lines(bot.threadId)).filter((line: string) => line === PROVIDER_STOP_UNCONFIRMED_LINE)).toHaveLength(1);
  expect((await lines(bot.threadId)).filter((line: string) => line?.startsWith("error:"))).toEqual([PROVIDER_STOP_UNCONFIRMED_LINE]);
  expect((await lines(bot.threadId)).filter((line: string) => line === ENGINE_CLOSED_LATE_NOTE)).toEqual([]);
  const next = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "never-close cannot admit", noSteer: true });
  expect(next.status).toBe(202); expect(next.body).toMatchObject({ queued: true });
  expect((await inspect(bot.threadId)).generation).toBe(before.generation);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "adapter-submit")).toHaveLength(1);
});

it("W11: a plain sendTurn rejection after owner Stop cannot become a silent retained run", async () => {
  const { bot } = await stoppedInflight({ reject: true });
  await expect.poll(() => threadEvents(bot.threadId).some(event => event.kind === "catch-state"), { timeout: 5_000 }).toBe(true);
  expect(await busy(bot)).toBe(true);
  const state = await inspect(bot.threadId);
  expect(state.leases).toEqual(expect.arrayContaining(["workspace:" + bot.threadId, "computer:" + bot.threadId, "browser:" + bot.threadId]));
  expect(state.ledger).toBe(true);
  expect((await lines(bot.threadId)).filter((line: string) => line === PROVIDER_STOP_UNCONFIRMED_LINE)).toHaveLength(1);
  expect((await lines(bot.threadId)).filter((line: string) => line?.startsWith("error:"))).toEqual([PROVIDER_STOP_UNCONFIRMED_LINE]);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "retire-attempt")).toEqual([]);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "terminal-capture")).toEqual([]);
  const next = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "rejection cannot admit", noSteer: true });
  expect(next.status).toBe(202); expect(next.body).toMatchObject({ queued: true });
  expect((await inspect(bot.threadId)).generation).toBe(state.generation);
  expect(threadEvents(bot.threadId).filter(event => event.kind === "adapter-submit")).toHaveLength(1);
});

it("W13: sentinel-blocked Claude reservation replays the active-profile Stop and deletion", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Reservation fixture", modelSelection: { instanceId: "blocked", model: "claude-sonnet-5" } })).body.bot;
  const sentinel = file("version-release");
  writeFileSync(sentinel + ".armed", "");
  try {
    expect((await api("PATCH", "/api/config", { browserProfiles: [{ id: "active", name: "Active" }], expectedBrowserProfiles: [] })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: "active", computer: "off", browser: false, composio: false })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep working" })).status).toBe(202);
    await expect.poll(() => busy(bot), { timeout: 5_000 }).toBe(true);
    await expect.poll(async () => existsSync(sentinel + ".waiting") || { events: threadEvents(bot.threadId), messages: (await api("GET", `/api/threads/${bot.threadId}/messages`)).body }, { timeout: 5_000 }).toBe(true);
    expect(threadEvents(bot.threadId).filter(event => event.kind === "reservation")).toEqual([expect.objectContaining({ hasSession: true })]);
    const blocked = await api("PATCH", "/api/config", { browserProfiles: [], expectedBrowserProfiles: [{ id: "active", name: "Active" }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/stop .* turn/i);
    const switched = await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: null });
    expect(switched.status).toBe(202);
    expect(switched.body.pending).toMatchObject({ mode: "builtin" });
    expect((await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id).browserProfile).toBe("active");
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    // Q1 ruling (option C): a Stop on a reservation still blocked in setup answers 200 once the unlaunched setup is confirmed closed; no engine child ever existed.
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ ok: true });
    writeFileSync(sentinel, "");
    await expect.poll(() => busy(bot), { timeout: 5_000 }).toBeFalsy();
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    expect((await api("PATCH", "/api/config", { browserProfiles: [], expectedBrowserProfiles: [{ id: "active", name: "Active" }] })).status).toBe(200);
  } finally { writeFileSync(sentinel, ""); }
});
