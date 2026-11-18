// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture producer and consumer owner: salv-plus. Execution bus and native relay producer owner: tri3-g1.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Observe real terminal delivery after the folder-lease/fold subscribers.
 * Public SSE deliberately omits native turn identities. This observer never
 * changes an event, grants authority, or releases a lease. Its files live only
 * in the caller's disposable fixture directory. The real Claude interrupt is
 * left untouched unless a test names legacyRequestedStop, which models an
 * adapter whose Stop returns once requested (legacy contract, kept as separate
 * coverage); the real child still owns its close notification.
 * `stopInterrupt` models a Stop that reaches no live child: "refuse" rejects
 * it without asking the engine; "gate" holds it (writing `stopCalled`) until
 * the test writes `stopRelease`, then asks the real engine.
 * `holdSetup` holds every Claude turn in setup, before its engine is spawned:
 * the model-resolution step writes `setupCalled` and waits for `setupRelease`.
 * `unknownCloseKnowledge` models an absent/evicted proof hint; real close receipts remain intact. */
export function stoppedTurnFixture(root: string, options: { legacyRequestedStop?: boolean; stopInterrupt?: 'refuse' | 'gate'; holdSetup?: boolean; unknownCloseKnowledge?: boolean; rejectingStop?: boolean; holdTerminalFold?: boolean; lateBind?: boolean } = {}) {
  const events = join(root, 'native-terminal-events.jsonl');
  const stopCalled = join(root, 'stop-interrupt-called'), stopRelease = join(root, 'stop-interrupt-release');
  const setupCalled = join(root, 'setup-step-called'), setupRelease = join(root, 'setup-step-release');
  const setupStep = 'stopGate.step(e, resolveClaudeTurnModel(turn.model, turnEnvironment))';
  const heldSetupStep = 'stopGate.step(e, (async()=>{const fs=process.getBuiltinModule("node:fs");fs.writeFileSync('+JSON.stringify(setupCalled)+',"called");'
    + 'while(!fs.existsSync('+JSON.stringify(setupRelease)+'))await new Promise(resolve=>setTimeout(resolve,10));return resolveClaudeTurnModel(turn.model, turnEnvironment);})())';
  const heldInterrupt = options.stopInterrupt === 'refuse'
    ? 'async()=>{throw new Error("fixture: the engine refused the Stop");}'
    : 'async(threadId,turnId)=>{const fs=process.getBuiltinModule("node:fs");fs.writeFileSync('+JSON.stringify(stopCalled)+',"called");'
      + (options.stopInterrupt === 'gate' ? 'while(!fs.existsSync('+JSON.stringify(stopRelease)+'))await new Promise(resolve=>setTimeout(resolve,10));' : '')
      + 'return interrupt(threadId,turnId);}';
  // holdTerminalFold: the first turn.completed reaches the server's folder-lease
  // subscriber and its fold only after the test writes `foldRelease` (it writes
  // `foldReady` when held), so a Stop can land once the turn's own completion
  // has started but before its lease was completed.
  const foldReady = join(root, 'terminal-fold-ready'), foldRelease = join(root, 'terminal-fold-release');
  // lateBind: every folder-lease bind of a provider turn runs only after the
  // test writes `bindRelease` (it writes `bindDone` once the real bind ran), so
  // the turn's terminal event can come first, as when sendTurn reveals its id late.
  const bindRelease = join(root, 'lease-bind-release'), bindDone = join(root, 'lease-bind-done');
  const preload = join(root, 'stopped-turn-preload.mjs');
  writeFileSync(preload, `import ${JSON.stringify(new URL('./fake-engine-server-preload.mjs', import.meta.url).href)};
import ${JSON.stringify(new URL('./mount-evidence-preload.mjs', import.meta.url).href)};
import {isMainThread} from 'node:worker_threads';
import {registerHooks} from 'node:module';
if(isMainThread) registerHooks({load(url,context,next){
  const loaded=next(url,context);
  if(!url.endsWith('/server/drivers/claude.ts')&&!url.endsWith('/server/index.ts'))return loaded;
  const source=String(loaded.source);
  const anchor=url.endsWith('/server/drivers/claude.ts')
    ? 'extra: { ...ownedTurnNames(env, stripOwned), ...claudeNames,'
    : 'bus.subscribeExecution(foldRuntimeEvent);';
  if(source.split(anchor).length!==2)throw Error('Stopped-turn fixture anchor must match exactly once');
  const addition=url.endsWith('/server/drivers/claude.ts')
    ? " ...Object.fromEntries(Object.entries({...process.env,...env}).filter(([name])=>name.startsWith('FAKE_'))),"
    : 'bus.subscribeExecution(event => { if(event.type === "turn.completed" || event.type === "session.exited") appendFileSync('+${JSON.stringify(JSON.stringify(events))}+', JSON.stringify({kind:"runtime",event:{type:event.type,threadId:event.threadId,turnId:event.turnId}})+String.fromCharCode(10)); });';
  const held=${options.holdTerminalFold ? "url.endsWith('/server/index.ts')" : "false"};
  // The lease subscriber (folder-lease completion) and the fold each hold the
  // first turn.completed; one release delivers both, in subscription order.
  const leaseAnchor='const terminalPreparations = new WeakMap<RuntimeEvent, TerminalPreparation>();';
  const foldAnchor='bus.subscribeExecution(foldRuntimeEvent);';
  if(held&&(source.split(leaseAnchor).length!==2||source.split(foldAnchor).length!==2))throw Error('Stopped-turn fixture hold anchors must match exactly once');
  const fixtureHold='const fixtureHeldDeliveries=[]; let fixtureHoldTimer;'+
    ' const fixtureHold=listener=>{ let fixtureHeld=false; return event=>{'+
    ' if(fixtureHeld||event.type!=="turn.completed")return listener(event); fixtureHeld=true;'+
    ' fixtureHeldDeliveries.push(()=>listener(event)); appendFileSync('+${JSON.stringify(JSON.stringify(foldReady))}+', "held");'+
    ' fixtureHoldTimer??=setInterval(()=>{ if(!existsSync('+${JSON.stringify(JSON.stringify(foldRelease))}+'))return; clearInterval(fixtureHoldTimer);'+
    ' for(const deliver of fixtureHeldDeliveries.splice(0))deliver(); },10); }; };';
  const leaseHold=' { const fixtureSubscribe=bus.subscribeExecution; bus.subscribeExecution=(listener,...rest)=>{'+
    ' delete bus.subscribeExecution; return fixtureSubscribe.call(bus,fixtureHold(listener),...rest); }; }';
  const lateBind=${options.lateBind ? "url.endsWith('/server/index.ts')" : "false"};
  const bindAnchor='const projectTurnLeases = new ProjectTurnLeases();';
  if(lateBind&&source.split(bindAnchor).length!==2)throw Error('Stopped-turn fixture bind anchor must match exactly once');
  const bindHold=' { const fixtureBind=projectTurnLeases.bind.bind(projectTurnLeases); projectTurnLeases.bind=(...args)=>{'+
    ' const fixtureBindTimer=setInterval(()=>{ if(!existsSync('+${JSON.stringify(JSON.stringify(bindRelease))}+'))return; clearInterval(fixtureBindTimer);'+
    ' fixtureBind(...args); appendFileSync('+${JSON.stringify(JSON.stringify(bindDone))}+', "bound"); },10); return false; }; }';
  const hold=text=>text.replace(leaseAnchor,leaseAnchor+fixtureHold+leaseHold).replace(foldAnchor,'bus.subscribeExecution(fixtureHold(foldRuntimeEvent));');
  const legacyStop=${options.legacyRequestedStop ? "url.endsWith('/server/drivers/claude.ts')" : "false"} ? String.fromCharCode(10)+
    'const fixtureCreate=ClaudeDriver.create; ClaudeDriver.create=async function(...args){'+
    'const instance=await fixtureCreate.apply(this,args), interrupt=instance.adapter.interruptTurn.bind(instance.adapter);'+
    'instance.adapter.interruptTurn=(threadId,turnId)=>{void interrupt(threadId,turnId);};return instance;};' : '';
  const stopInterrupt=${options.stopInterrupt || options.holdSetup ? "url.endsWith('/server/drivers/claude.ts')" : "false"} ? String.fromCharCode(10)+
    'const fixtureStopCreate=ClaudeDriver.create; ClaudeDriver.create=async function(...args){'+
    'const instance=await fixtureStopCreate.apply(this,args), interrupt=instance.adapter.interruptTurn.bind(instance.adapter);'+
    'instance.adapter.interruptTurn='+${JSON.stringify(heldInterrupt)}+';return instance;};' : '';
  const unknownCloseKnowledge=${options.unknownCloseKnowledge ? "url.endsWith('/server/drivers/claude.ts')" : "false"} ? String.fromCharCode(10)+
    'const fixtureUnknownCreate=ClaudeDriver.create; ClaudeDriver.create=async function(...args){'+
    'const instance=await fixtureUnknownCreate.apply(this,args);instance.adapter.knowsTurnClose=()=>undefined;return instance;};' : '';
  const holdSetup=${options.holdSetup ? "url.endsWith('/server/drivers/claude.ts')" : "false"};
  if(holdSetup&&source.split(${JSON.stringify(setupStep)}).length!==2)throw Error('Stopped-turn fixture setup anchor must match exactly once');
  const rejectingStop=${options.rejectingStop ? "url.endsWith('/server/drivers/claude.ts')" : "false"} ? String.fromCharCode(10)+
    'const fixtureRejectCreate=ClaudeDriver.create; ClaudeDriver.create=async function(...args){'+
    'const instance=await fixtureRejectCreate.apply(this,args);'+
    'instance.adapter.interruptTurn=()=>Promise.reject(new Error("fixture interrupt rejected"));return instance;};' : '';
  const setupSource=holdSetup?source.replace(${JSON.stringify(setupStep)},${JSON.stringify(heldSetupStep)}):source;
  const transformed=setupSource.replace(anchor,anchor+addition);
  const bound=lateBind?transformed.replace(bindAnchor,bindAnchor+bindHold):transformed;
  return {...loaded,source:(held?hold(bound):bound)+legacyStop+stopInterrupt+unknownCloseKnowledge+rejectingStop};
}});
`);
  return {
    args: ['--import', pathToFileURL(preload).href],
    stopCalled, stopRelease, setupCalled, setupRelease,
    foldReady, foldRelease, bindRelease, bindDone,
    terminalFrame(threadId: string) {
      if (!existsSync(events)) return undefined;
      return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).find(frame => frame.event.threadId === threadId && frame.event.turnId);
    },
  };
}
