// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Can talk to" setting as the UI reads it. Direction is derived from both
// bots' own records with the SAME reach predicate the server enforces
// (shared/reach.ts), so the label cannot drift from what is allowed.
import type { Bot } from "@/state/store";
import { canReach, canStartContact, type ContactBot } from "../../shared/reach";

export type CanTalkMode = "team" | "all" | "list";
export type { Direction } from "../../shared/reach";

export function canTalkMode(bot: Pick<Bot, "messageAllow">): CanTalkMode {
  const mode = bot.messageAllow?.mode;
  return mode === "all" || mode === "list" ? mode : "team";
}

const asContact = (b: Bot): ContactBot => b;

/** How `other` can start a contact with `bot` today:
 *  none     - it cannot;
 *  created  - only through a grant this control wrote (removable here);
 *  fixed    - through its team or role, or its own Everyone or own pick (not removable here). */
export type ReverseKind = "none" | "created" | "fixed-team" | "fixed-theirs";
export function reverseKind(bot: Bot, other: Bot): ReverseKind {
  if (!canStartContact(asContact(other), asContact(bot))) return "none";
  if (canReach(other, bot)) return "fixed-team";
  const allow = other.messageAllow;
  if (allow?.mode === "list" && (allow.grantedBy ?? []).includes(bot.id)) return "created";
  return "fixed-theirs";
}

export type RowState = { label: "one-way" | "two-way"; kind: ReverseKind; canChange: boolean };
export function rowState(bot: Bot, other: Bot): RowState {
  const kind = reverseKind(bot, other);
  return { label: kind === "none" ? "one-way" : "two-way", kind, canChange: kind === "none" || kind === "created" };
}

/** Everyone: one label over all other bots; "mixed" when some can start back and some cannot. */
export function everyoneState(bot: Bot, others: Bot[]): { label: "one-way" | "two-way" | "mixed"; canChange: boolean } {
  const rows = others.map((o) => rowState(bot, o));
  const two = rows.filter((r) => r.label === "two-way").length;
  const label = two === 0 ? "one-way" : two === rows.length ? "two-way" : "mixed";
  return { label, canChange: rows.some((r) => r.canChange) };
}

/** Bots the setting names, among those still on the roster (a deleted bot never shows or resubmits). */
export function pickedIds(bot: Bot, others: Bot[]): string[] {
  const live = new Set(others.map((o) => o.id));
  return (bot.messageAllow?.botIds ?? []).filter((id) => live.has(id));
}
