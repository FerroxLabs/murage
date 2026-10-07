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
import { type Partition, isHomePartition } from "./execution-audience.ts";
import { liveTeamLabel } from "./team-identities.ts";
import { aboutMePrompt } from "./about-me.ts";
import { notebookSourceIds } from "./memory/import.ts";
import { ownerOnly } from "./owner-audience.ts";
import { sectionContextSystemPrompt } from "./section-context.ts";
import { loadMemory, memorySystemPrompt } from "./workspace.ts";

//
// A turn nobody is watching (a routine, a webhook, a goal run) reads the
// notebook but is not invited to edit it: each edit waits for the owner's
// approval, so the run would stall on a note nobody asked for.
//
// The owner can switch the team brief off for one bot (`teamBrief: false`,
// from "What shapes <bot>"); its own notebook always rides.
//
// About me (about-me.ts), the owner's own profile, follows the same
// owner-audience rule and has the same kind of per-bot switch
// (`aboutMe: false`). It is its own layer near House Rules, not part of the
// joined standing block below.
type StandingBot = { id: string; section?: string; teamBrief?: boolean; aboutMe?: boolean };
type StandingOptions = { ownerAudience: boolean; fileTools: boolean; unattended?: boolean;
  /** A webhook turn: its payload came from outside and its reply may go
   *  back out, so the owner's private profile stays home. */
  partition?: Partition;
  webhook?: boolean };

/** The two blocks apart, for the labelled prompt (bot-shapes.ts). */
// Each block is a registered owner-audience surface (owner-audience.ts).
export function standingContextParts(bot: StandingBot, opts: StandingOptions): { aboutMe: string; teamBrief: string; memory: string } {
  const owner = opts.ownerAudience;
  const partition = opts.partition ?? { kind: "home" };
  // A team partition's brief is its live team's; an unknown or retired team has none, never General's (L3).
  const section = isHomePartition(partition) ? bot.section : partition.kind === "team" ? liveTeamLabel(partition.teamId) : undefined;
  return {
    aboutMe: ownerOnly("about-me", owner, () => bot.aboutMe === false || opts.webhook ? "" : aboutMePrompt()),
    teamBrief: ownerOnly("team-brief", owner, () => bot.teamBrief === false || section == null ? "" : sectionContextSystemPrompt(section)),
    memory: ownerOnly("memory-md", owner, () => memorySystemPrompt(bot.id, { fileTools: opts.fileTools && !opts.unattended }, partition) + (partition.kind !== "isolated" && opts.partition ? generalNotes(bot.id) : "")),
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
 * chunks stay recallable. Empty when the thread's audience is not the owner.
 * Callers pass the thread's own audience, not the turn's: a turn that is
 * withheld the standing context because nobody proved its words (origin)
 * must not recall these sources instead (0.1.61 audit). */
export function standingContextSourceIds(bot: StandingBot, ownerAudience: boolean, partition?: Partition): string[] {
  if (!ownerAudience) return [];
  const { notebook, brief, general } = notebookSourceIds(bot.id, bot.section, partition);
  // A brief switched off for this bot is not in its prompt: recall may bring it.
  return [...(partition && general && !loadMemory(bot.id,{kind:"general"})?.truncated ? [general] : []), ...(notebook && !loadMemory(bot.id, partition)?.truncated ? [notebook] : []), ...(brief && bot.teamBrief !== false ? [brief] : [])];
}

function generalNotes(botId: string): string {
  const general = loadMemory(botId, { kind: "general" });
  return general ? `\nNotes that apply to every team:\n${Buffer.from(general.text).subarray(0, 16000).toString("utf8").replace(/\uFFFD+$/, "")}` : "";
}
