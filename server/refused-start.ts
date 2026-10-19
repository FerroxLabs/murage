// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot's turn refused before it began (an unsupported setting, a closed gate) writes nothing of its own in that bot's conversation. Both hand-off
// paths that start a turn for another bot (a delegation and a synchronous ask) record the full explanation there, where the owner reads it, before
// the bot that asked is told only the kind of failure (one of the five codes).
import { ERROR_MESSAGE_MAX } from "../shared/provider-error.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";
import { murageLine } from "./murage-line.ts";

export function recordRefusedStart(store: { appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message }, threadId: string, why: string): Message {
  const detail = redactSecretsInText(why);
  return store.appendMessage(threadId, murageLine({ role: "bot", kind: "activity", tool: { name: `error: ${detail.slice(0, ERROR_MESSAGE_MAX)}`, ok: false, errorDetails: detail.slice(0, 4096) } }));
}
