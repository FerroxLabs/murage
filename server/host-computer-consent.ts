import {noLimitsAppliesTo,type NoLimitsOrigin} from './no-limits-origin.ts';
import type {PermissionSetting} from './permission-inheritance.ts';
import { serviceQueue, waitForProducerApproval, producerBase } from "./narrow-denials.ts";
// One-time, per-bot confirmation before a bot on the Auto computer
// destination first acts on THIS computer.
//
// On macOS a bot that never chose a computer (`computer` unset, "Auto") is
// handed the owner's own screen, mouse and keyboard (server/local-routing.ts).
// That is the established behaviour and it stays, but the first time such a
// bot actually acts on the screen, the owner is asked once for that bot and
// the answer is remembered on the bot record (`hostComputerConsent`).
//
// What this is NOT:
//   * a per-action approval. It is asked once per bot, and "Allow" is kept.
//     Per-action approval cards (local-computer scope) are unchanged.
//   * a question for a bot the owner explicitly set to "This computer". That
//     setting is already the owner's choice; it is never asked.
//   * asked at mount time. Mounting the tools touches nothing; the card is
//     raised only when a tool call would reach the host driver.
//
// The card rides the same options-card flow as peer approvals: it carries a
// requestId and is answered through the two respond routes, which call
// `resolveHostComputerConsent` before forwarding anything to a provider.
import { newId } from "./contracts.ts";
import { botUsesHostComputer } from "./local-routing.ts";
import { dismissStaleToolCards, type ApprovalBus, type StaleCardKind } from "./peer-approval.ts";
import type { BotRecord } from "./store.ts";

/** The card's tool identity. Never a real tool: nothing can grant it. */
export const HOST_CONSENT_TOOL = "local_computer_consent";

/** "ask": not decided yet, ask on first touch. "allowed" / "declined": the
 *  owner's remembered answer (or a grandfathered "allowed"). */
export type HostComputerConsent = "ask" | "allowed" | "declined";

export function isHostComputerConsent(value: unknown): value is HostComputerConsent {
  return value === "ask" || value === "allowed" || value === "declined";
}

/** Where this bot stands before a host action. "not-needed" covers every bot
 *  whose destination is not the Auto-reaches-this-computer case: explicit
 *  "local" (the owner chose it), any other destination, and Auto on a
 *  platform where Auto never reaches the host. An absent value is "ask". */
export function hostConsentState(
  bot: Pick<BotRecord, "computer" | "hostComputerConsent">,
  hostPlatform: NodeJS.Platform = process.platform,
): "not-needed" | HostComputerConsent {
  if (bot.computer !== undefined || !botUsesHostComputer(undefined, hostPlatform)) return "not-needed";
  return isHostComputerConsent(bot.hostComputerConsent) ? bot.hostComputerConsent : "ask";
}

/** Auto must not mount this computer for a bot whose owner said no. */
export function autoHostDeclined(bot: Pick<BotRecord, "computer" | "hostComputerConsent"> & PermissionSetting, origin?: NoLimitsOrigin): boolean {
  return bot.computer === undefined && bot.hostComputerConsent === "declined" && !noLimitsAppliesTo(origin,bot);
}

/** Grandfathering, evaluated once per bot record (when the field is absent).
 *  A bot that has already used this computer is not surprised with a prompt
 *  for something that already works. Evidence, any of:
 *   - it is explicitly on "This computer" (the owner's own choice);
 *   - Auto mode is on for it or one of its tasks while its destination is
 *     Auto — switching that on required the "Auto mode on this computer"
 *     warning (`acknowledgeLocalAuto`), which is the same consent;
 *   - one of its conversations holds an allowed "Local computer approval"
 *     card, i.e. the owner already let it act on this computer.
 *  Anything else starts at "ask". */
export function grandfatheredHostComputerConsent(
  bot: Pick<BotRecord, "computer" | "autoApprove" | "threadId" | "tasks">,
  threadsWithAllowedHostActions: ReadonlySet<string>,
): "allowed" | "ask" {
  if (bot.computer === "local") return "allowed";
  if (bot.computer === undefined && (bot.autoApprove === true || bot.tasks?.some((task) => task.autoApprove === true))) return "allowed";
  const threads = [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)];
  return threads.some((threadId) => threadsWithAllowedHostActions.has(threadId)) ? "allowed" : "ask";
}

export type HostConsentOutcome = "allowed" | "declined" | "waiting";

interface Pending {
  requestId: string;
  botId: string;
  threadId: string;
  messageId: string;
  /** Held open by a routine run (ApprovalBus.routineCard). */
  held: boolean;
  waiters: Set<(outcome: HostConsentOutcome) => void>;
  bus: ApprovalBus;
}

/** botId → the one open card for that bot. Concurrent actions (or two turns)
 *  share it, so the owner is never shown the same question twice. */
const pendingByBot = new Map<string, Pending>();

function settle(pending: Pending, behavior: "allow" | "deny", source: "user" | "system"): void {
  const queue=serviceQueue('host-computer');
  const item=queue.pendingApprovals().find(item=>item.ref===pending.requestId);
  if(!item)return;
  if(source==='user')void queue.answer(item.approvalId,{behavior});else void queue.stop(item.approvalId);
}

function finish(pending: Pending, outcome: HostConsentOutcome): void {
  pendingByBot.delete(pending.botId);
  if (pending.held) {
    const answer = outcome === "allowed" ? "allow" : outcome === "declined" ? "deny" : "none";
    try { pending.bus.routineCard?.closed(pending.threadId, pending.requestId, answer); } catch { /* delivery never changes authority */ }
  }
  for (const waiter of pending.waiters) waiter(outcome);
  pending.waiters.clear();
}

export function hostConsentPendingApprovals() { return serviceQueue('host-computer').pendingApprovals(); }
function openCard(bus:ApprovalBus,bot:BotRecord,threadId:string):Pending {
  const requestId=newId();
  const pending:Pending={requestId,botId:bot.id,threadId,messageId:'',held:false,waiters:new Set(),bus};
  pendingByBot.set(bot.id,pending);
  void waitForProducerApproval(serviceQueue('host-computer'),{
    authority:bus.authorityFor?.(threadId,bot.id),ref:requestId,tool:HOST_CONSENT_TOOL,input:{scope:'local-computer'},
    action:{requestId,tool:HOST_CONSENT_TOOL,approvalScope:'local-computer',options:['Allow','Deny'],held:'Asked once for each bot on Auto.'},
    view:{title:`Let @${bot.name} use this computer?`,subtitle:`@${bot.name} is set to Auto, which on this Mac means your own screen, mouse and keyboard. Allow and Murage remembers it for this bot. Don't allow and @${bot.name} stays off this computer. You can change this later in the bot's Computer panel.`},
    base:producerBase(true),
  },{presented:(_item,messageId)=>{pending.messageId=messageId;pending.held=bus.routineCard?.opened(threadId,requestId,`Let @${bot.name} use this computer?`)===true;bus.onApproval?.(bot.id,threadId,requestId,messageId);}})
    .then(result=>finish(pending,result==='allow'?'allowed':result==='deny'?'declined':'waiting'),()=>finish(pending,'waiting'));
  return pending;
}

/** Wait (at most `waitMs`) for the owner's answer before a host action by a
 *  bot that has not been confirmed. Opens the card if none is open for the
 *  bot. Resolves "waiting" when the window passes, the caller gives up
 *  (`signal`), or the card closes unanswered; the card itself stays open
 *  until answered or cancelled. */
export function awaitHostComputerConsent(
  bus: ApprovalBus,
  bot: BotRecord,
  threadId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<HostConsentOutcome> {
  const pending = pendingByBot.get(bot.id) ?? openCard(bus, bot, threadId);
  return new Promise((resolve) => {
    let done = false;
    const complete = (outcome: HostConsentOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      pending.waiters.delete(complete);
      resolve(outcome);
    };
    const aborted = () => complete("waiting");
    const timer = setTimeout(() => complete("waiting"), waitMs);
    timer.unref?.();
    pending.waiters.add(complete);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** APPROVE-ALL (design 6.2 step 12): read only, whether this request is a waiting consent card. Settles nothing. */
export function hostComputerConsentPending(requestId: string): boolean {
  return [...pendingByBot.values()].some((entry) => entry.requestId === requestId);
}

/** Called by the respond routes BEFORE forwarding to a provider. True when
 *  the requestId was a consent card; `remember` persists the owner's answer. */
export function resolveHostComputerConsent(
  requestId: string,
  behavior: string | undefined,
  remember: (botId: string, consent: "allowed" | "declined") => void,
): boolean {
  const pending = [...pendingByBot.values()].find((entry) => entry.requestId === requestId);
  if (!pending) return false;
  if(behavior!=='allow'&&behavior!=='deny')return false;
  const item=serviceQueue('host-computer').pendingApprovals().find(item=>item.ref===requestId);
  if(!item)return false;
  if(serviceQueue('host-computer').answerNow(item.approvalId,{behavior}).state==='failed')return false;
  remember(pending.botId,behavior==='allow'?'allowed':'declined');
  return true;
}

/** A stopped turn cannot act, so its open card closes unanswered (and the
 *  next action asks again). */
export function cancelHostComputerConsentForThread(threadId: string): void {
  for (const pending of pendingByBot.values()) {
    if (pending.threadId !== threadId) continue;
    settle(pending, "deny", "system");
    finish(pending, "waiting");
  }
}

export function cancelHostComputerConsentFor(botId: string): void {
  const pending = pendingByBot.get(botId);
  if (!pending) return;
  settle(pending, "deny", "system");
  finish(pending, "waiting");
}

/** Cards left open on disk by a previous run can never be answered; settle
 *  them at boot so they do not hold a composer. */
export function dismissStaleHostConsentCards(bus: ApprovalBus, range?: { after: number; upTo: number } | "indexed", owned?: ReadonlySet<string>): number {
  const open = new Set([...pendingByBot.values()].map((pending) => pending.requestId));
  return dismissStaleToolCards(bus, [HOST_CONSENT_TOOL], (card) => !card.requestId || open.has(card.requestId), range, owned);
}
/** The same rule as a kind for settleStaleCardPage (peer-approval.ts). */
export function staleHostConsentCardKind(): StaleCardKind {
  const open = new Set([...pendingByBot.values()].map((pending) => pending.requestId));
  return { tools: [HOST_CONSENT_TOOL], keep: (card) => !card.requestId || open.has(card.requestId) };
}

/** What the bot's tool call returns when it may not act. */
export function hostConsentRefusal(outcome: Exclude<HostConsentOutcome, "allowed">, botName: string) {
  const text = outcome === "declined"
    ? `The person chose not to let ${botName} use this computer. Nothing was done on the screen. Do not retry computer actions; carry on without them or ask the person.`
    : `Waiting for the person to allow ${botName} to use this computer. A card is shown in the chat. Nothing was done on the screen. Ask them to answer it before trying again.`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** True while a consent card with this request id is open. */
export function hostConsentPending(requestId: string): boolean {
  return [...pendingByBot.values()].some((entry) => entry.requestId === requestId);
}
