// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 S1: the rows the one Settings finder shows around the ranked settings (searchSettingsIndex). Pure. A
// skill result (core C14, shared/settings-v10/skill-search.ts) opens its own sheet on the bot it names, never a page
// guessed from its title. Settings and skills only: no recent-change or request row exists (nothing produces
// one), and memory text never enters this list.
import type { SkillSearchResult } from "../../shared/settings-v10/skill-search";
import { t } from "./i18n";
import type { SettingsIndexHit } from "./settings-search";

export type FindRow =
  | { kind: "setting"; hit: SettingsIndexHit }
  | { kind: "skill"; result: SkillSearchResult };

/** Where a skill row goes: the Skills page with that skill's sheet open, on the bot the result names. */
export interface SkillOpenTarget { page: "skills"; sheet: { skillId: string }; bot?: string }

export function skillOpenTarget(result: SkillSearchResult): SkillOpenTarget {
  return { page: "skills", sheet: { skillId: result.ref.skillId }, ...(result.ref.botId ? { bot: result.ref.botId } : {}) };
}

/** Settings first, then skills. */
export function findRows(hits: readonly SettingsIndexHit[], skills: readonly SkillSearchResult[]): FindRow[] {
  return [
    ...hits.map((hit): FindRow => ({ kind: "setting", hit })),
    ...skills.map((result): FindRow => ({ kind: "skill", result })),
  ];
}

/** The line under an empty or unsatisfying result; {name} is the Chief's name. */
export function askChiefLine(chiefName: string): string {
  return t("settings.askLine.text", { chief: chiefName.trim() || "Chief" });
}
