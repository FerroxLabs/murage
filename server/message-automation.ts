// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type {Message,MessageOrigin} from "./store.ts";
import type {RoutineRunTrigger} from "./routines.ts";
export function automationForTurn(input:{automation?:Message["automation"];automationSource?:RoutineRunTrigger;commsDepth?:number;cardContinuation?:boolean;projectCardRun?:{request:{id:string}};memorySkillSource?:string;unattended?:boolean;origin?:MessageOrigin},run?:{routineId?:string;webhookId?:string;telegramConnectionId?:string;channelOrigin?:{platform:"slack"|"discord"|"whatsapp";connectionId:string}}):Message["automation"]{
 if(input.automation)return input.automation;
 if(input.projectCardRun||input.cardContinuation||input.memorySkillSource)return {kind:"card"};
 if(input.automationSource)return {kind:input.automationSource,...(run?.routineId?{routineId:run.routineId}:{}),...(run?.webhookId?{webhookId:run.webhookId}:{}),
  ...(run?.channelOrigin?{channel:run.channelOrigin.platform,connectionId:run.channelOrigin.connectionId}:run?.telegramConnectionId?{channel:"telegram",connectionId:run.telegramConnectionId}:{})};
 if(input.commsDepth)return {kind:"delegation"};
 if(input.unattended&&!input.origin)return {kind:"message"};
 return undefined;
}

/** Exact event/run identity wins; historical runs never lend a new turn provenance. */
export function automationRunForTurn<T extends {id:string;threadId?:string;status:string;startedAt?:number;createdAt?:number;event?:{id:string}}>(runs:readonly T[],threadId:string,eventId?:string):T|undefined{
 const same=runs.filter(run=>run.threadId===threadId);
 if(eventId)return same.find(run=>run.id===eventId||run.event?.id===eventId);
 return same.filter(run=>run.status==="running").sort((a,b)=>(b.startedAt??b.createdAt??0)-(a.startedAt??a.createdAt??0)||b.id.localeCompare(a.id))[0];
}

/** Automation that ran without the owner is not user activity (warm pool): routines on a schedule
 * or run by hand, card and memory-skill runs, webhooks, delegations, asks and rooms. Their turns
 * are sent `background`, so they never mark activity, keep a spare or earn a hold. */
const BACKGROUND_AUTOMATION: ReadonlySet<string> = new Set(["schedule", "manual", "card", "webhook", "delegation", "ask", "room"]);
export const isBackgroundAutomation = (kind: string | undefined): boolean => kind !== undefined && BACKGROUND_AUTOMATION.has(kind);

/** Whether THIS dispatch is background work, from its own provenance (the routine, schedule,
 * card or delegation it was started with, or the room request it answers) and never from
 * the newest user message in the thread: a queued routine can run after a newer human
 * message was stored. */
export function turnIsBackground(input: Parameters<typeof automationForTurn>[0], request?: {fromKind?: string; verb?: string} | null): boolean {
 if (isBackgroundAutomation(automationForTurn(input)?.kind)) return true;
 return request?.fromKind === "routine" || request?.verb === "routine";
}

/** The provenance a room member turn carries. Its goal run's (orchestration) or the one it
 * inherited from the turn that summoned it (a mention chain, a queued member dispatch) wins.
 * A queued human request is never a continuation here (its kind is "request"). A card continuation (a card answer, a resumed connector or secret) belongs to its routine
 * run when that run is known, and is ALWAYS background otherwise: a goal that went terminal
 * (blocked, failed, capped) never turns its continuation into the owner's activity. */
export function memberTurnProvenance(input:{orchestration?:Message["automation"];inherited?:Message["automation"];continuation:boolean;kind?:"card"|"request";run?:Parameters<typeof automationForTurn>[1]&{triggerSource?:RoutineRunTrigger}}):Message["automation"]{
 if(input.orchestration)return input.orchestration;
 if(input.inherited)return input.inherited;
 // a queued HUMAN room request (kind "request") carries no card: it stays the owner's, foreground
 if(!input.continuation||input.kind==="request")return undefined;
 if(input.run)return automationForTurn({automationSource:input.run.triggerSource??"schedule"},input.run);
 return automationForTurn({cardContinuation:true});
}
