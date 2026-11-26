// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Execute the production Stop function with deterministic await barriers. The
// HTTP companion suite exercises route parsing with the real isolated server.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("./index.ts",import.meta.url),"utf8");
const start = source.indexOf("async function interruptDirectThread(");
const end = source.indexOf("/** Provider turns whose direct run",start);
if (start < 0 || end < 0) throw new Error("Stop test must execute the current production function");
const javascript = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText;

it.each(["browser","provider","provider-reject","frame"])("STOP-AWAITS: a replacement after %s receives no stale cleanup",async barrier=>{
  const original={botId:"bot",threadId:"thread",generation:"generation-1",phase:"running",providerTurnId:"turn-1"};
  let current={...original};
  const effects:string[]=[];
  const releaseClosed=vi.fn();
  let resume!:()=>void;
  let entered!:()=>void;
  const reached=new Promise<void>(resolve=>{entered=resolve;});
  const pause=new Promise<void>(resolve=>{resume=resolve;});
  const at=async(name:string)=>{if(barrier===name){entered();await pause;}};
  const deps={
    randomUUID:()=>"stop-token", sealDirectAttempts:()=>{}, settleDirectAttempts:()=>{}, finishDirectAttemptEffects:()=>{},
    ownerLimitContinuations:{cancel:vi.fn()}, limitApplications:{cancel:vi.fn()},
    ownWriteHolds:{stop:vi.fn()}, bus:{cancelTurn:vi.fn()},
    directRuns:{get:()=>current,current:(run:typeof original)=>current.generation===run.generation,release:()=>effects.push("release")},
    internalTurnOwners:new Map(),
    botForDirectThread:()=>({modelSelection:{instanceId:"provider"}}),
    callSpeech:{invalidate:vi.fn()},replyState:{invalidate:vi.fn()},
    cancelDirectTurnDispatch:()=>({phase:"running"}),
    stopEmailForTurn:vi.fn(),emailRuntime:{},emailGeneration:()=>"generation-1",
    closeOpenApprovals:()=>effects.push("approvals"),
    releaseBrowserCapabilityForThread:()=>at("browser"),
    registry:{get:()=>({adapter:{interruptTurn:async()=>{
      await at(barrier==="provider-reject"?"provider-reject":"provider");
      if(barrier==="provider-reject")throw new Error("provider failed");
      return {status:"stopped"};
    }}})},
    stopCloseConfirmed:()=>true,
    // LLS: no ledger refusal in this schedule (the refused-Stop join has its own witnesses)
    refusedTurnOf:()=>undefined,stopInterrupts:new Map(),refusalStopGenerations:new Set(),
    unconfirmedDirectStop:()=>new Error("unconfirmed"),
    screenPollers:new Map([["bot",{threadId:"thread"}]]),
    finalScreenFrame:()=>at("frame"),
    rememberReleasedStoppedTurn:()=>effects.push("remember"),
    watchdog:{settleSetup:()=>effects.push("watchdog")},
    replySpeakerTurns:{ended:()=>effects.push("reply-ended")},
    store:{setTaskActivity:()=>effects.push("idle")},
    trackStopAskedInterrupt:()=>{},
    // 1.0.20 STOP-CHIP: the stop line of a run with no engine turn (its own witnesses: stop-chip-phases-1020-api)
    stopWithoutEngineTurn:{arm:()=>{},noteArmed:()=>{},note:()=>{},dispatching:()=>false},
    projectTurnLeases:{releaseClosed,markStopAsked:()=>{},markStopRequested:()=>effects.push("lease")},
  };
  const stop=new Function(...Object.keys(deps),javascript+"\nreturn interruptDirectThread;")(...Object.values(deps));
  const pending=stop("bot","thread",original.generation);
  await reached;
  expect(deps.ownerLimitContinuations.cancel).toHaveBeenCalledWith("thread", original.generation);
  expect(deps.limitApplications.cancel).toHaveBeenCalledWith("thread");
  current={...original,generation:"generation-2",providerTurnId:"turn-2"};
  effects.length=0;
  resume();
  await pending;
  expect(effects).toEqual([]);
  expect(releaseClosed.mock.calls).toEqual(barrier==="provider"||barrier==="frame"?[[original.generation]]:[]);
});
