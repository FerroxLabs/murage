// What the composer's leading "/" offers, and how a typed command is read
// back out of the draft.
//
// Kept pure and out of the component so the two ways of reaching the same
// send — picking Goal from the menu and typing "/goal …" — can be proved
// equivalent in a test rather than by reading JSX.
import { offersSkillCommand } from "../../shared/skill-command";

export type ComposerSlashCommandId = "goal" | "learn" | "setup";

export interface ComposerSlashCommand {
  id: ComposerSlashCommandId;
  label: `/${ComposerSlashCommandId}`;
  description: string;
}

/** One of the bot's enabled skills, run for a turn by sending `/name` (shared/skill-command.ts). */
export interface SlashSkill {
  name: string;
  description: string;
}

/** Skill rows for the slash menu: enabled skills a `/name` can reach, in name order. A name an engine command
 * already uses is left to the engine command, as the server does. */
export function skillSlashRows(skills: readonly SlashSkill[], engineCommandNames: ReadonlySet<string> = new Set()): SlashSkill[] {
  return skills
    .filter((skill) => offersSkillCommand(skill.name) && !engineCommandNames.has(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a skill row matches what was typed after the slash. */
export function slashSkillMatches(skill: SlashSkill, query: string): boolean {
  const needle = query.toLowerCase();
  return !needle || skill.name.startsWith(needle) || skill.description.toLowerCase().includes(needle);
}

export interface ComposerSlashTrigger {
  query: string;
  start: number;
  end: number;
}

/** Slash commands configure the whole send, so they are offered only at the
 * beginning of a draft and only while the first token is being typed. The
 * token takes what engine command names use too (digits, `_`, `.`, and the
 * `:` of Claude plugin commands), so the menu stays open while one is typed. */
export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /^\/([a-z0-9_.:-]*)$/i.exec(prefix);
  if (!match) return null;
  return { query: match[1] ?? "", start: 0, end: caret };
}

/** A typed `/goal …` is equivalent to selecting Goal mode from the menu.
 * null means this is an ordinary chat message; an empty string means the
 * command is present but still needs a goal description or attachment. */
export function goalTextFromComposer(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trimStart() : null;
}

/** Replace the active slash token and return the caret position immediately
 * after the inserted text. */
export function replaceComposerSlashTrigger(
  text: string,
  trigger: ComposerSlashTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}
