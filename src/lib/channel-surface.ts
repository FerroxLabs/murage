// The words and the small decisions the channel and project screens share.
//
// They live here rather than in the components for one practical reason: a
// component in this app reaches for `window` the moment it is imported, so
// anything that wants to be tested on its own has to sit outside one. The
// happier consequence is that the two screens cannot drift apart on what
// they call things, because there is one copy of each word.
import type { ChannelProject, ChannelProjectStatus } from "../../shared/project";
import { localeCode, t } from "./i18n";

export const CHANNEL_DETAILS_SECTIONS = ["about", "members", "files", "memory"] as const;
export type ChannelDetailsSection = (typeof CHANNEL_DETAILS_SECTIONS)[number];

export const CHANNEL_DETAILS_SECTION_LABELS: Record<ChannelDetailsSection, string> = {
  about: "About",
  members: "Members",
  files: "Files",
  memory: "Memory",
};

/** What a person reads when a channel is a project and when it is not. The
 * two words are the only difference between the two, and they are stated
 * once, here, so no screen can drift into calling it something else. */
export function channelNoun(group: { channelProject?: ChannelProject }): string {
  return group.channelProject ? "project" : "channel";
}

/** What a channel remembers, said as a sentence rather than as a scope id
 * and a row count. */
export function roomMemorySentence(name: string, count: number): string {
  if (count === 0) return `Nothing is remembered from ${name} yet.`;
  if (count === 1) return `One thing is remembered from ${name}.`;
  return `${count} things are remembered from ${name}.`;
}

/** One plain line under the status word, so the word is never the only clue.
 * Written as something a person would say out loud about the work. */
/** What a person reads for a status code, in the language in effect now.
 * The English constants in shared/project.ts stay the server's and the codes'. */
export const channelProjectStatusLabel = (status: ChannelProjectStatus): string => t(`projects.status.${status}`);
export const channelProjectStatusNote = (status: ChannelProjectStatus): string => t(`projects.statusNote.${status}`);

export const PROJECT_STATUS_NOTES: Record<ChannelProjectStatus, string> = {
  active: "Being worked on now.",
  paused: "Set down for the moment. Nothing is lost.",
  done: "The work is finished. The chat stays here.",
};

/** The last line of a project's overview: when it started, and when it
 * finished if it has. Dates only. Nothing here counts anything. */
export function projectTimingLine(project: { startedAt: number; completedAt?: number }): string {
  // English keeps the device's own date style, as it always did; another language follows the app language.
  const code = localeCode();
  const day = (at: number) => new Date(at).toLocaleDateString(code === "en" ? undefined : code, { day: "numeric", month: "long", year: "numeric" });
  return project.completedAt
    ? t("projects.timing.startedFinished", { start: day(project.startedAt), end: day(project.completedAt) })
    : t("projects.timing.started", { date: day(project.startedAt) });
}
