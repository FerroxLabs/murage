// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What a team import hands back, and the two helpers the sidebar needs from
// it (its undo and its toast). They live apart from TeamLibraryPanel so the
// sidebar can say how an import went without carrying the whole library
// panel in the first paint (spec §6); the panel loads when it opens.

/** One bot a replace-import put away, and everything the undo needs to put
 *  it back exactly as it was.
 *
 *  `chiefOfStaff` alone was not enough. The org chart is three fields read
 *  together (src/lib/bot-role.ts) — leading something, leading the WHOLE
 *  workspace, leading nothing — so a record that remembers only the first
 *  can only ever restore the first: the workspace Chief of Staff was
 *  archived and came back a section lead, demoted by an Undo button with
 *  nothing said. The harness now sends the tier alongside the role. */
export interface ArchivedTeamBot {
  id: string;
  chiefOfStaff: boolean;
  /** Which chair this bot held. `null` = led nothing. Absent only in a
   *  payload from a harness older than this field. */
  chiefTier?: "workspace" | "section" | null;
}

/** The PATCH body that puts one archived bot back.
 *
 *  `chiefTier` reaches the wire as `chiefScope`, the same rename
 *  `botRolePatch` makes — and the tier is stated explicitly rather than
 *  left out, because an omitted scope means "leave the tier as it is", and
 *  "as it is" is exactly the thing an archive is not trusted to remember.
 *
 *  Restoring a Chief while a DIFFERENT bot now holds the workspace chair is
 *  refused by the harness with 409 and a sentence naming the incumbent.
 *  That refusal is the point: seating two would break the one invariant the
 *  chart has, and silently restoring her as a section lead would repeat the
 *  demotion this type exists to stop. */
export function archivedRestorePatch(bot: ArchivedTeamBot): {
  hidden: false;
  chiefOfStaff?: true;
  chiefScope?: "workspace" | "section";
} {
  if (!bot.chiefOfStaff) return { hidden: false };
  return {
    hidden: false,
    chiefOfStaff: true,
    // A payload with no tier (older harness) keeps the old meaning: a bare
    // election, which the harness reads as a section lead.
    ...(bot.chiefTier ? { chiefScope: bot.chiefTier } : {}),
  };
}

/** One skill the imported profile declared and the import could not
 *  deliver. `install` means the bot never got it; `enable` means it landed
 *  but is switched off — a smaller failure, and worth telling apart. */
export interface TeamImportSkillError {
  botId: string;
  botName: string;
  skillId: string;
  stage: "install" | "enable";
  error: string;
}

export interface TeamImportResult {
  name: string;
  members: number;
  importedBotIds: string[];
  importedGroupIds: string[];
  importedRoutineIds: string[];
  archived: ArchivedTeamBot[];
  /** Empty when everything the profile declared arrived. A short import is
   *  reported rather than logged: the harness used to answer 201 and print
   *  the failure to its own stderr, so a team quietly landed with fewer
   *  skills than it advertised. */
  skillErrors: TeamImportSkillError[];
}

/** The shape of a short import, for a caller that has a sentence to write.
 *  `unavailable` never arrived at all; `disabled` arrived but would not
 *  switch on. Both are unusable, and they are counted apart because they
 *  are not the same thing to say to somebody. */
export function teamImportSkillSummary(result: {
  skillErrors: TeamImportSkillError[];
}): { failed: number; unavailable: number; disabled: number } {
  const unavailable = result.skillErrors.filter((entry) => entry.stage === "install").length;
  return {
    failed: result.skillErrors.length,
    unavailable,
    disabled: result.skillErrors.length - unavailable,
  };
}
