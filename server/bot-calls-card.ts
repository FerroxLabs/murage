// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2, sections 5.2 and 8): the call card of one intent. One row per intent, with the
// stable id `botcall-<intentId>`, rewritten in place by every transition that owes a card. It is written through the store
// (appendMessage / patchMessage), synchronously, inside the transition's transaction (a52a9b431), never deferred. Words
// verbatim from design 8; the card's buttons and the History view are phase 5.
import { CALL_COPY } from "../shared/bot-calls-contract.ts";
import type { CallIntent } from "./bot-calls-machine.ts";
import { murageLine } from "./murage-line.ts";
import type { Message } from "./store.ts";

export const callCardId = (intentId: string): string => `botcall-${intentId}`;

/** The card's words for the intent as it is now; null when the state owes no card (ringing, live, seen, dropped). */
export function callCardText(intent: CallIntent, botName: string, clock: (ms: number) => string): string | null {
  const when = clock(intent.rangAt ?? intent.createdAt);
  if (intent.state === "waiting") return `${botName} needs you`;
  if (intent.state !== "done") return null;
  switch (intent.outcome) {
    case "texted": return `${botName} needs you`;
    case "late": return `${botName} would have called you at ${when}, while Murage wasn't running.`;
    case "missed": case "text_instead": return `${botName} tried to call you at ${when}`;
    case "declined": return `${botName} tried to call you at ${when}\n${CALL_COPY.declined}`;
    case "answered": return intent.receipt.ended === "lost" ? `${botName} called you at ${when}\n${CALL_COPY.dropped}` : `${botName} called you at ${when}`;
    case "cancelled": return CALL_COPY.stoppedByYou;
    case "restored": return CALL_COPY.endedByRestore;
    default: return null;
  }
}

/** The row (new) or the patch (existing) for the intent's card. */
export function callCardRow(intent: CallIntent, botName: string, clock: (ms: number) => string, now: number):
  (Pick<Message, "role" | "kind" | "text" | "actorKind" | "botCall"> & { murageLine: true }) | null {
  const text = callCardText(intent, botName, clock);
  if (text === null) return null;
  const step = intent.receipt.steps.find((s) => s.check === "call");
  const minutes = step?.detail !== undefined ? Number(step.detail) : undefined;
  return {
    role: "bot", kind: "text", actorKind: "murage", murageLine: true, text,
    botCall: { intentId: intent.id, botId: intent.botId, state: intent.state, outcome: intent.outcome, tier: intent.tier, at: now,
      ...(minutes !== undefined && Number.isFinite(minutes) ? { minutes } : {}), ...(intent.receipt.ended ? { ended: intent.receipt.ended } : {}) },
  };
}

/** Writes the card through the store: patch the intent's row, or append it under its stable id. Throws on a failed write,
 * so the transition rolls back (CallEffects contract). */
export function writeCallCard(store: {
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
  appendMessage(threadId: string, input: Omit<Message, "id" | "at"> & { at?: number }, stableId?: string): Message;
}, intent: CallIntent, botName: string, clock: (ms: number) => string, now: number): void {
  const row = callCardRow(intent, botName, clock, now);
  if (!row) return;
  const id = callCardId(intent.id);
  if (store.patchMessage(intent.threadId, id, row)) return;
  store.appendMessage(intent.threadId, murageLine(row) as Omit<Message, "id" | "at">, id);
}

/** The opener (design 8): "Hi {first name}, it's {bot}. {fact sentence}. Want the details?" */
/** The owner's first name for the opener (design 8): the first word of the profile name, letters, marks, apostrophes and
 * hyphens only, at most 40 characters; null when there is none ("Hi, it's Scout."). */
export function ownerFirstName(profileName: unknown): string | null {
  if (typeof profileName !== "string") return null;
  const first = profileName.trim().split(/\s+/)[0] ?? "";
  const clean = first.replace(/[^\p{L}\p{M}'\u2019-]/gu, "").slice(0, 40);
  return /\p{L}/u.test(clean) ? clean : null;
}
export function callOpener(intent: CallIntent, o: { firstName: string | null; botName: string; ago: (ms: number) => string; clock: (ms: number) => string;
  routineName?: string | null; watchName?: string | null; taskName?: string | null; senderName?: string | null; channel?: string | null }): string {
  const hi = o.firstName ? `Hi ${o.firstName}, it's ${o.botName}.` : `Hi, it's ${o.botName}.`;
  const ago = o.ago(intent.factAt);
  let fact: string;
  switch (intent.factKind) {
    case "timed": fact = `You asked me to call you at ${o.clock(intent.factAt)}.`; break;
    case "watch.changed": fact = `${o.watchName ?? "Your watch"} changed ${ago}.`; break;
    case "webhook.event": fact = `An event arrived for ${o.routineName ?? "your routine"}.`; break;
    case "channel.message": fact = `A message came in from ${o.senderName ?? "someone on your list"}${o.channel ? ` on ${o.channel}` : ""}.`; break;
    case "turn.ended": fact = `${o.taskName ?? "Your task"} has finished.`; break;
    case "routine.failed": case "routine.needs_you": fact = `Your routine ${o.routineName ?? ""} reported a problem ${ago}.`.replace("routine  ", "routine "); break;
    default: fact = intent.line ? `${o.botName} thinks you're needed now. ${o.botName} says: ${intent.line}.` : `${o.botName} thinks you're needed now.`;
  }
  return `${hi} ${fact} Want the details?`;
}
