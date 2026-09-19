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

export function standingContextPrompt(
  bot: { id: string; section?: string },
  opts: { ownerAudience: boolean; fileTools: boolean },
): string {
  if (!opts.ownerAudience) return "";
  return sectionContextSystemPrompt(bot.section) + memorySystemPrompt(bot.id, { fileTools: opts.fileTools });
}

/** Structured-memory sources the standing context already carries whole.
 * Murage's memory imports MEMORY.md and team briefs as searchable chunks;
 * recall skips chunks resting only on these so a fact is not sent twice.
 * A notebook over its load budget is only partly in the prompt, so its
 * chunks stay recallable. Empty when the standing context is withheld. */
export function standingContextSourceIds(bot: { id: string; section?: string }, ownerAudience: boolean): string[] {
  if (!ownerAudience) return [];
  const { notebook, brief } = notebookSourceIds(bot.id, bot.section);
  return [...(notebook && !loadMemory(bot.id)?.truncated ? [notebook] : []), ...(brief ? [brief] : [])];
}
