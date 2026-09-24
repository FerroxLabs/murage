// What a bot carries into every turn, wherever it is speaking: the shared
// brief of its sidebar section (user-written, bounded by
// SECTION_CONTEXT_MAX_BYTES) and its own MEMORY.md notebook (bounded by the
// MEMORY_MAX_LINES / MEMORY_MAX_BYTES load budget). Direct chats, delegated
// turns, routine runs and room member turns all build from this one helper,
// so a bot in a room is the same bot as in its own chat (adapted from
// OpenMausBot, which adds both blocks to every turn's system context).
//
// Both blocks are the owner's material. They ride only on turns whose human
// audience is the owner: a conversation that belongs to a linked channel
// person (Slack, Discord or Telegram) gets neither, matching the structured
// memory rule that bot and team scopes are owner-audience only.
import { notebookSourceIds } from "./memory/import.ts";
import { sectionContextSystemPrompt } from "./section-context.ts";
import { loadMemory, memorySystemPrompt } from "./workspace.ts";

//
// A turn nobody is watching (a routine, a webhook, a goal run) reads the
// notebook but is not invited to edit it: each edit waits for the owner's
// approval, so the run would stall on a note nobody asked for.
//
// The owner can switch the team brief off for one bot (`teamBrief: false`,
// from "What shapes <bot>"); its own notebook always rides.
type StandingBot = { id: string; section?: string; teamBrief?: boolean };
type StandingOptions = { ownerAudience: boolean; fileTools: boolean; unattended?: boolean };

/** The two blocks apart, for the labelled prompt (bot-shapes.ts). */
export function standingContextParts(bot: StandingBot, opts: StandingOptions): { teamBrief: string; memory: string } {
  if (!opts.ownerAudience) return { teamBrief: "", memory: "" };
  return {
    teamBrief: bot.teamBrief === false ? "" : sectionContextSystemPrompt(bot.section),
    memory: memorySystemPrompt(bot.id, { fileTools: opts.fileTools && !opts.unattended }),
  };
}

export function standingContextPrompt(bot: StandingBot, opts: StandingOptions): string {
  const parts = standingContextParts(bot, opts);
  return parts.teamBrief + parts.memory;
}

/** Structured-memory sources the standing context already carries whole.
 * Murage's memory imports MEMORY.md and team briefs as searchable chunks;
 * recall skips chunks resting only on these so a fact is not sent twice.
 * A notebook over its load budget is only partly in the prompt, so its
 * chunks stay recallable. Empty when the standing context is withheld. */
export function standingContextSourceIds(bot: StandingBot, ownerAudience: boolean): string[] {
  if (!ownerAudience) return [];
  const { notebook, brief } = notebookSourceIds(bot.id, bot.section);
  // A brief switched off for this bot is not in its prompt: recall may bring it.
  return [...(notebook && !loadMemory(bot.id)?.truncated ? [notebook] : []), ...(brief && bot.teamBrief !== false ? [brief] : [])];
}
