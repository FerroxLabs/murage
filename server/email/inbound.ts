// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inbound mail classes (BOT-EMAIL-MURAGE-109 5.2). One place decides what a bot may see of an inbound email: spam, blocked and
// unauthenticated mail is hidden from the bot entirely (the owner sees it under "Filtered"), and mail Flux holds for the owner reaches the
// bot as its envelope only (no subject, preview, attachment names or text).

/** Spam, blocked or unauthenticated: hidden from the bot, listed for the owner under "Filtered". */
export function isFilteredMail(message: Record<string, unknown>): boolean {
  if (message.direction === "outbound") return false;
  return message.spam === true || message.blocked === true || message.hidden === true || message.trust === "blocked"
    || message.sender_authenticated === false;
}

/** Held for the owner: the bot sees the envelope only. */
export function isHeldForOwner(message: Record<string, unknown>): boolean { return message.held_for_owner === true; }

/** Why an inbound email is filtered, for the owner's list (Murage's own words, never the sender's). */
export function filteredReason(message: Record<string, unknown>): "spam" | "blocked" | "unauthenticated" {
  if (message.spam === true) return "spam";
  if (message.blocked === true || message.hidden === true || message.trust === "blocked") return "blocked";
  return "unauthenticated";
}
