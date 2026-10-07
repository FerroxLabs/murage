// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Spec §3.5 detail: the title and body are rebuilt when the phone asks, from
// the message as it is now, with the builders notify() uses, and with the
// preferences as they are now. Anything that cannot be rebuilt is the
// generic text, which is a complete outcome of its own.
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
}

export function pushDetail(event: PushEventRow, world: DetailWorld, now: Date): { title: string; body: string } {
  const generic = GENERIC_TEXT[event.category] ?? GENERIC_TEXT.question;
  if (event.category === "resolved") return { title: generic.title, body: RESOLVED_TEXT[event.resolvedBy ?? "elsewhere"] };
  // A world that throws (a closed database, preferences that no longer
  // parse) is one more thing that is missing, not an error for the phone.
  try {
    if (world.previewContent !== true) return generic;
    const bot = world.bot(event.botId);
    const message = world.message(event.threadId, event.messageId);
    if (!bot || !message) return generic;
    const detail = message.card?.pushBody ?? message.card?.subtitle ?? message.card?.title ?? message.text ?? "";
    const frame = buildNotification(event.kind, bot, event.threadId, detail);
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
