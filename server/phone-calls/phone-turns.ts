// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The phone-mount records (BOT-CALLS-1020 3b), in a module with no Murage imports so internal-capabilities.ts can delete a
// generation's record when its claims are revoked. Shaped like email/email-turns.ts: listing the tools is presentation; this record
// (written only by the mount in index.ts runTurn, when phoneMount admitted the turn) is what every phone call is checked against.
// An automation run, a project-role turn or any turn the mount did not admit has no record, so a direct POST gets `not_set_up`.

import type { PhoneAskContext, PhoneAskTurn, PhoneToolClaim } from "./contracts.ts";

export type PhoneTurnRecord = { botId: string; threadId: string; intent?: string };

/** The phone-mount records by capability generation. Deleted when the generation's claims are revoked (internal-capabilities.ts). */
export const phoneTurns = new Map<string, PhoneTurnRecord>();

export function recordPhoneTurn(generation: string, record: PhoneTurnRecord): void {
  // one live generation per thread: a newer turn's record replaces any older one on the thread
  for (const [key, old] of phoneTurns) if (old.threadId === record.threadId && key !== generation) phoneTurns.delete(key);
  phoneTurns.set(generation, { botId: record.botId, threadId: record.threadId, ...(record.intent ? { intent: record.intent } : {}) });
}
/** A turn the mount did not admit: no older record on its thread stays usable. */
export function forgetPhoneThread(threadId: string): void { for (const [key, old] of phoneTurns) if (old.threadId === threadId) phoneTurns.delete(key); }
export function forgetPhoneTurn(generation: string): void { phoneTurns.delete(generation); }
export function forgetAllPhoneTurns(): void { phoneTurns.clear(); }

export function forgetPhoneIntent(intent: string): void {
  for (const [key, record] of phoneTurns) if (record.intent === intent) phoneTurns.delete(key);
}

export function admittedPhoneTurn(claim: PhoneToolClaim): PhoneTurnRecord | undefined {
  if (!claim.generation) return undefined;
  const record = phoneTurns.get(claim.generation);
  return record && record.botId === claim.botId && record.threadId === claim.threadId ? record : undefined;
}

/** The turn behind this claim was admitted by the phone mount, for the same bot and thread. */
export function phoneTurnAdmitted(claim: PhoneToolClaim): boolean { return admittedPhoneTurn(claim) !== undefined; }

export function phoneAskContext(turn?: PhoneAskTurn): PhoneAskContext | undefined {
  if (!turn) return undefined;
  const record = admittedPhoneTurn({ botId: turn.botId, threadId: turn.threadId, generation: turn.dispatchGeneration });
  return record?.intent ? { botId: record.botId, intent: record.intent } : undefined;
}
