// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from "vitest";
import {automationForTurn,isBackgroundAutomation,turnIsBackground} from "./message-automation.ts";
it.each(["schedule","manual","webhook","channel"] as const)("stamps the real startTurn provenance for %s",kind=>{
 expect(automationForTurn({automationSource:kind},{routineId:"r",webhookId:"w",telegramConnectionId:"tg"})).toMatchObject({kind,routineId:"r",webhookId:"w",channel:"telegram",connectionId:"tg"});
});
it("preserves direct owner messages and marks control-plane continuations",()=>{
 expect(automationForTurn({origin:"desktop"})).toBeUndefined();
 expect(automationForTurn({cardContinuation:true})).toEqual({kind:"card"});
 expect(automationForTurn({commsDepth:1})).toEqual({kind:"delegation"});
 expect(automationForTurn({automation:{kind:"ask"}})).toEqual({kind:"ask"});
 expect(automationForTurn({unattended:true})).toEqual({kind:"message"});
 expect(automationForTurn({automationSource:"channel"},{channelOrigin:{platform:"slack",connectionId:"s"}})).toMatchObject({kind:"channel",channel:"slack",connectionId:"s"});
});

it("stamps project card runs even with an owner origin or unattended fallback",()=>{
 expect(automationForTurn({projectCardRun:{request:{id:"card-request"}},origin:"desktop",unattended:true})).toEqual({kind:"card"});
});


import { automationRunForTurn } from "./message-automation.ts";
it("uses the matching event or newest running run in a reused thread",()=>{
 const runs=[{id:"old",threadId:"thread",status:"completed",startedAt:1,routineId:"old-routine"},{id:"live",threadId:"thread",status:"running",startedAt:3,routineId:"new-routine",telegramConnectionId:"new-channel",event:{id:"event"}},{id:"older-live",threadId:"thread",status:"running",startedAt:2,routineId:"other"}];
 expect(automationForTurn({automationSource:"channel"},automationRunForTurn(runs,"thread"))).toMatchObject({routineId:"new-routine",connectionId:"new-channel"});
 expect(automationRunForTurn(runs,"thread","event")?.id).toBe("live");expect(automationRunForTurn(runs,"thread","missing")).toBeUndefined();expect(automationRunForTurn([runs[0]],"thread")).toBeUndefined();
});

it("routine runs (scheduled, manual, card) and memory-skill turns are background, not user activity",()=>{
 for(const kind of ["schedule","manual","card","webhook","delegation","ask","room"])expect(isBackgroundAutomation(kind)).toBe(true);
 // a manual routine run and a card routine run carry these stamps, and so does a memory-skill review turn
 expect(isBackgroundAutomation(automationForTurn({automationSource:"manual"})?.kind)).toBe(true);
 expect(isBackgroundAutomation(automationForTurn({projectCardRun:{request:{id:"r"}}})?.kind)).toBe(true);
 expect(isBackgroundAutomation(automationForTurn({memorySkillSource:"skill-review"})?.kind)).toBe(true);
});

it("a message the owner typed, or one from a channel, is user activity",()=>{
 expect(isBackgroundAutomation(automationForTurn({origin:"desktop"})?.kind)).toBe(false);
 expect(isBackgroundAutomation("channel")).toBe(false);
 expect(isBackgroundAutomation(undefined)).toBe(false);
});

import {readFileSync} from "node:fs";
it("background is told by the dispatch's own provenance, not the newest user message",()=>{
 expect(turnIsBackground({automationSource:"schedule"})).toBe(true);
 expect(turnIsBackground({automation:{kind:"manual"}})).toBe(true);
 expect(turnIsBackground({projectCardRun:{request:{id:"r"}}})).toBe(true);
 expect(turnIsBackground({},{fromKind:"routine",verb:"room_turn"})).toBe(true);
 expect(turnIsBackground({},{fromKind:"owner",verb:"routine"})).toBe(true);
 // a routine run queued behind a newer human message is still background; a human turn is not
 expect(turnIsBackground({origin:"desktop"},{fromKind:"owner",verb:"owner_send"})).toBe(false);
 expect(turnIsBackground({},null)).toBe(false);
});
it("the dispatch no longer infers background from the newest user message",()=>{
 const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
 expect(source).not.toMatch(/reverse\(\)\.find\(m => m\.role === "user"\)\?\.automation/);
 expect(source).toMatch(/turnIsBackground\(\{ \.\.\.\(opts \?\? \{\}\)/);
});

import {memberTurnProvenance} from "./message-automation.ts";
it("a card continuation after its goal went terminal is still background (no live run to lend provenance)",()=>{
 // blocked, failed or capped: the run is gone from the live set, the continuation stays background
 const automation=memberTurnProvenance({continuation:true});
 expect(automation).toEqual({kind:"card"});
 expect(turnIsBackground({automation})).toBe(true);
 // with its run still known, it carries that run's own provenance
 expect(memberTurnProvenance({continuation:true,run:{routineId:"r",triggerSource:"schedule"}})).toMatchObject({kind:"schedule",routineId:"r"});
 // a plain member turn with nothing behind it is the owner's
 expect(memberTurnProvenance({continuation:false})).toBeUndefined();
});
it("a background continuation that summons another member keeps that member's turn background",()=>{
 const continuation=memberTurnProvenance({continuation:true});
 // the summoned teammate has no continuation of its own: it inherits the summoner's provenance
 const summoned=memberTurnProvenance({continuation:false,inherited:continuation});
 expect(turnIsBackground({automation:summoned})).toBe(true);
 // and a goal's own provenance still wins over anything inherited
 expect(memberTurnProvenance({orchestration:{kind:"schedule"},inherited:{kind:"card"},continuation:true})).toEqual({kind:"schedule"});
 const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
 // the chained (recursive) member dispatch and the queued member dispatch both hand provenance down
 expect(source).toMatch(/keeps it background\n\s+turnAutomation,\n\s+\)\)\) \{/);
 expect(source).toMatch(/"request",\n\s+queuedRequestAutomation\(request, rootRow\)\);/);
 expect(source).toMatch(/opts\?\.cardContinuation \|\| turnIsBackground\(/);
});

it("a queued HUMAN room request stays foreground; only a real card continuation falls back to background",()=>{
 // kind "request" with no automation: the owner's own work, whatever prompt it carries
 const human=memberTurnProvenance({continuation:true,kind:"request"});
 expect(human).toBeUndefined();
 expect(turnIsBackground({automation:human})).toBe(false);
 // a queued request that does carry automation keeps it (inherited)
 expect(memberTurnProvenance({continuation:true,kind:"request",inherited:{kind:"schedule"}})).toEqual({kind:"schedule"});
 // a real card continuation, explicit or default, is background
 for(const kind of ["card",undefined] as const){
  const card=memberTurnProvenance({continuation:true,kind});
  expect(card).toEqual({kind:"card"});
  expect(turnIsBackground({automation:card})).toBe(true);
 }
 const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
 expect(source).toMatch(/held: heldContinuation, kind: continuationKind/);
});
