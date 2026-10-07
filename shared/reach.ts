// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reach predicate, shared by the harness and the settings UI so the
// "Can talk to" direction label can never drift from what the server allows.
/** Sections are persisted as display labels, so exact trimmed labels are
 * their identity. Missing/blank means the unsectioned (General) team. */
export const sectionKey = (section?: string | null): string => section?.trim() || "";

/** The four fields the roster predicate reads. Structural rather than
 * `BotRecord` so the Chief's prompt builder (chief-of-staff.ts) can share
 * one predicate without pulling the whole store type into it. */
export interface ReachableBot {
  section?: string | null;
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
  individual?: boolean;
}

/** The one Chief above the team leaders, if the workspace has elected one. */
export const isWorkspaceChief = (bot: ReachableBot): boolean =>
  bot.chiefOfStaff === true && bot.chiefScope === "workspace";

/** A bot that works alone under the Chief, with no team leader above it.
 * The `chiefOfStaff` half of the test is not redundant with the store's
 * invariant: this predicate also runs over structural records that never
 * passed through the store (wire bots in the prompt builder, hand-written
 * payloads), and the two roles must never both apply to one bot. The role
 * that carries a team wins, the same way it does at load. */
export const isIndividualAssistant = (bot: ReachableBot): boolean =>
  bot.individual === true && bot.chiefOfStaff !== true;

/** Who a bot may see, name, ask, delegate to, and schedule work for.
 *
 * The org chart as a predicate. Two branches hang off the one workspace
 * Chief — Chief ⇄ team leaders (each of whom owns their own members), and
 * Chief ⇄ individual assistants (each alone in its own group, with no
 * leader in between). Same-section contact is unchanged.
 *
 * NO LONGER a strict superset of the section rule, and the comment that
 * said so is now wrong. It held while the only extra edges were Chief ⇄
 * team lead: both ends of those were already `chiefOfStaff`, so no bot
 * gained a peer it could not already coordinate with. The individual-
 * assistant edge is a genuinely new CLASS of edge — an ordinary non-leading
 * bot becomes reachable across section boundaries. It stays narrow: exactly
 * one peer (the workspace Chief), only in both directions of that one pair,
 * and only while the bot carries the explicit `individual` flag a human set.
 *
 * What is still true, and is what the tests pin: with no workspace Chief
 * elected, every clause below the first is unreachable, so the predicate is
 * exactly `sectionKey(a) === sectionKey(b)`. Electing nobody changes
 * nothing; marking somebody individual while nobody is Chief changes
 * nothing either.
 *
 * Deliberately NOT a visibility filter. `hidden` and self-contact are left
 * to each call site, because four of the gates that call this never had a
 * hidden check and two report a different error for self — folding either
 * in here would quietly change what an ordinary bot may do. */
export function canReach(from: ReachableBot, to: ReachableBot): boolean {
  if (sectionKey(from.section) === sectionKey(to.section)) return true;
  if (isWorkspaceChief(from) && to.chiefOfStaff === true) return true;
  if (from.chiefOfStaff === true && isWorkspaceChief(to)) return true;
  if (isWorkspaceChief(from) && isIndividualAssistant(to)) return true;
  if (isIndividualAssistant(from) && isWorkspaceChief(to)) return true;
  return false;
}


export type ReachAllow = { mode: "team" | "all" | "list"; botIds?: string[] };
export type ContactBot = ReachableBot & { id: string; hidden?: boolean; messageAllow?: ReachAllow };

/** Can `from` start a contact with `to` under their teams and `from`'s own
 * Can talk to setting (project membership is checked separately). */
export function canStartContact(from: ContactBot, to: ContactBot, options: { ownerAudience?: boolean } = {}): boolean {
  if (from.id === to.id) return false;
  if (canReach(from, to)) return true;
  if (from.messageAllow?.mode === "all") return options.ownerAudience !== false && !to.hidden;
  return from.messageAllow?.mode === "list" && (from.messageAllow.botIds ?? []).includes(to.id);
}

export type Direction = "one-way" | "two-way";
/** Contact between a and b as the owner sees it: who can start with whom. */
export function contactState(a: ContactBot, b: ContactBot): "none" | "a-to-b" | "b-to-a" | "both" {
  const ab = canStartContact(a, b), ba = canStartContact(b, a);
  return ab && ba ? "both" : ab ? "a-to-b" : ba ? "b-to-a" : "none";
}
