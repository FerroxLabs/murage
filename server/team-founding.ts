// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a TEAM LEAD's create_bot may put a new bot (1.0.16 TEAM-SECTION).
//
// A team lead builds client teams: "make Berwald Roofing a team of four with
// its own lead". Before this, a lead could only add to its own team, so the
// create was refused and the lead filed all four bots in its own team instead.
//
// The rule:
//   - its own team, as before;
//   - a NEW team: a name no bot or channel carries yet (archived ones count);
//   - a team it started: every bot filed under that name, archived ones too,
//     was created by this lead through create_bot, and no channel is filed
//     there. One bot the lead did not create (the owner's, another lead's, or
//     one the owner moved in) and the team is not the lead's to fill.
// Everything else is refused, and the caller is told to stop and tell the
// owner rather than file the bots somewhere else.
import { sectionKey } from "../shared/reach.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import { RESERVED_TEAM_NAMES, TEAM_NAME_MAX } from "./team-name-rules.ts";

/** How team names compare: spaces trimmed, Unicode NFC, case ignored. "Berwald" and "berwald " are one team. */
export const foldTeamName = (label: string | null | undefined) => (label ?? "").normalize("NFC").trim().toLocaleLowerCase();
const fold = foldTeamName;

/** The words every team refusal ends with, so the bot stops instead of filing the bots in its own team. */
export const TEAM_REFUSAL_NEXT_STEP = "Do not create these bots in your own team or anywhere else instead: stop and tell the owner.";

export type LeadTeamTarget =
  | { ok: true; section: string; ownTeam: boolean }
  | { ok: false; status: number; error: string };

export function leadTeamTarget(input: {
  bots: readonly Pick<BotRecord, "id" | "name" | "section" | "hidden" | "chiefOfStaff" | "createdByBotId">[];
  groups: readonly Pick<GroupRecord, "section">[];
  lead: Pick<BotRecord, "id" | "section">;
  requested: string;
  wantsLead: boolean;
}): LeadTeamTarget {
  const { bots, groups, lead, wantsLead } = input;
  const requested = input.requested.trim();
  const own = sectionKey(lead.section);
  if (!requested || fold(requested) === fold(own)) {
    // A team's lead already leads this team. Creating a second one would be
    // electing its own replacement, which is a handover a person makes.
    if (wantsLead) return { ok: false, status: 403, error: "only the workspace Chief of Staff can create a team lead" };
    return { ok: true, section: own, ownTeam: true };
  }
  const refuse = (status: number, reason: string) => ({ ok: false as const, status, error: `${reason} ${TEAM_REFUSAL_NEXT_STEP}` });
  if (requested.length > TEAM_NAME_MAX) return refuse(400, `Team names can be up to ${TEAM_NAME_MAX} characters.`);
  if ([...requested].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return refuse(400, "Team names cannot contain control characters.");
  const reserved = RESERVED_TEAM_NAMES.find((name) => fold(name) === fold(requested));
  if (reserved) return refuse(400, `"${reserved}" is a heading in the sidebar, not a team.`);
  const filed = bots.filter((bot) => fold(sectionKey(bot.section)) === fold(requested));
  const channel = groups.some((group) => fold(sectionKey(group.section)) === fold(requested));
  if (channel || filed.some((bot) => bot.createdByBotId !== lead.id)) {
    return refuse(403, `you can only create bots in your own team or in a new team you start: ${requested} is a team you did not start.`);
  }
  // Any lead already there, hidden ones included, means no second lead: electing one would demote it.
  if (wantsLead && filed.some((bot) => bot.chiefOfStaff === true)) return refuse(409, `${requested} already has a lead: create this bot without lead.`);
  // The label already on the team wins, so a near-miss spelling cannot fork it.
  return { ok: true, section: sectionKey(filed[0]?.section) || requested, ownTeam: false };
}

/**
 * The team decision for one create_bot call, made when the call arrives and made again right before the bot is
 * written (the route's createPreflight runs it after the owner's card and once more with nothing awaited before
 * createBot). While a card is open the team can gain a bot, a channel or a lead this lead did not make, or another
 * call in the same turn can be refused; each later decision sees that. The section never moves once decided: if
 * the team the call would now land in is not the one first decided, it is refused.
 */
export function leadTeamGate(input: {
  read: () => { bots: Parameters<typeof leadTeamTarget>[0]["bots"]; groups: Parameters<typeof leadTeamTarget>[0]["groups"] };
  /** The lead as stored now; undefined once it is gone. */
  lead: () => Pick<BotRecord, "id" | "section" | "chiefOfStaff"> | null | undefined;
  requested: string;
  wantsLead: boolean;
  markRefused: (team: string) => void;
  refusedTeam: () => string | undefined;
}): { decide: () => { status: number; error: string } | undefined; section: () => string | undefined } {
  let decided: { section: string | undefined } | undefined;
  const decide = () => {
    const { bots, groups } = input.read();
    const lead = input.lead();
    // Stood down (or removed) while the card was open: it no longer leads a team, so it cannot fill or start one.
    if (!lead?.chiefOfStaff) return { status: 403, error: `You are no longer a team lead, so the bot was not added. ${TEAM_REFUSAL_NEXT_STEP}` };
    const target = leadTeamTarget({ bots, groups, lead, requested: input.requested, wantsLead: input.wantsLead });
    if (!target.ok) {
      if (input.requested) input.markRefused(input.requested);
      return { status: target.status, error: target.error };
    }
    // A refusal earlier in this turn (or by a call that overlapped this one) is not followed by the bots landing in the lead's own team.
    const refused = target.ownTeam ? input.refusedTeam() : undefined;
    if (refused) {
      return { status: 409, error: `create_bot refused the team ${refused} earlier in this turn, so these bots are not added to your own team instead. Stop and tell the owner what was refused.` };
    }
    const section = target.section || undefined;
    if (decided && fold(sectionKey(section)) !== fold(sectionKey(decided.section))) {
      return { status: 409, error: `The team changed while this was waiting, so the bot was not added. ${TEAM_REFUSAL_NEXT_STEP}` };
    }
    // The label the team carries now is the one the bot is filed under, so a case variant cannot fork the team.
    decided = { section };
    return undefined;
  };
  return { decide, section: () => decided?.section };
}
