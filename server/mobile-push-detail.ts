// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.5 detail: the title and body are rebuilt when the phone asks, from
// the message as it is now, with the builders notify() uses, and with the
// preferences as they are now. Anything that cannot be rebuilt is the
// generic text, which is a complete outcome of its own.
import { PHONE_COPY } from "../shared/phone-copy.ts";
import { GENERIC_TEXT, RESOLVED_TEXT } from "../shared/mobile-push.ts";
import { applyNotificationPreferences } from "../shared/notification-preferences.ts";
import { buildNotification, type NotifyBot } from "./notify.ts";
import type { PushEventRow } from "./mobile-push-store.ts";

export interface DetailWorld {
  bot(botId: string): NotifyBot | undefined;
  message(threadId: string, messageId: string | null): { text?: string; card?: { title?: string; subtitle?: string; pushBody?: string } } | undefined;
  prefs: unknown;
  /** Explicit consent on this phone's binding, never the desktop default. */
  previewContent?: boolean;
  /** The live phone job behind a device-job push (its operationId), if it is still known. Only the capability is read, never the arguments. */
  /** X1, belt and braces: whether the thread has used the owner's phone now, for a row written before the mark. Throwing counts as marked. */
  phoneMarked?(threadId: string): boolean;
  deviceJob?(operationId: string): { capability: string } | undefined;
}

export function pushDetail(event: PushEventRow, world: DetailWorld, now: Date): { title: string; body: string } {
  const generic = GENERIC_TEXT[event.category] ?? GENERIC_TEXT.question;
  if (event.category === "resolved") return { title: generic.title, body: RESOLVED_TEXT[event.resolvedBy ?? "elsewhere"] };
  // Bot calls (contract v2, design 5.5): the call kinds are closed text at
  // every preview setting, before any preference or message is read.
  if (event.category === "call" || event.category === "call-note") return GENERIC_TEXT[event.category];
  const kind = event.kind;
  if (kind === "call" || kind === "call-note") return GENERIC_TEXT[kind];
  // X1: before previewContent, the bot or any message is read. A row stamped when its thread had used the phone, or a thread marked now,
  // is the fixed generic text. Resolutions and calls above, and device jobs below, use fixed text and keep their own rules.
  if (event.category !== "device-job") {
    let marked = event.phoneUsed;
    if (!marked) { try { marked = world.phoneMarked?.(event.threadId) === true; } catch { marked = true; } }
    if (marked) return generic;
  }
  // A phone job reads the same fixed sentence for every previewContent: the
  // bot's name and the kind of access, never what the job would do (F17).
  if (event.category === "device-job") {
    try {
      const noun = event.requestId ? (PHONE_COPY.capabilityNoun as Record<string, string>)[world.deviceJob?.(event.requestId)?.capability ?? ""] : undefined;
      const bot = world.bot(event.botId);
      if (!noun || !bot) return generic;
      return { title: generic.title, body: `${bot.name}${PHONE_COPY.pushWants[0]}${noun}${PHONE_COPY.pushWants[1]}` };
    } catch {
      return generic;
    }
  }
  // A world that throws (a closed database, preferences that no longer
  // parse) is one more thing that is missing, not an error for the phone.
  try {
    if (world.previewContent !== true) return generic;
    const bot = world.bot(event.botId);
    const message = world.message(event.threadId, event.messageId);
    if (!bot || !message) return generic;
    const detail = message.card?.pushBody ?? message.card?.subtitle ?? message.card?.title ?? message.text ?? "";
    if (kind === "device-job") return generic;
    const frame = buildNotification(kind, bot, event.threadId, detail);
    if (!frame) return generic;
    const shown = applyNotificationPreferences(frame, world.prefs, now);
    // Content withheld reads exactly as the push did: this category's
    // generic text, not the preference filter's own sentence.
    if (!shown || shown.privatePreview) return generic;
    return { title: shown.title, body: shown.body };
  } catch {
    return generic;
  }
}
