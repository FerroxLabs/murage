// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CAPABILITY-DB-1010 route B: the capability records for a turn that cannot
// call murage_help (no agents mount: OpenClaw with its own tools, a tool-less
// or draft-only chat-completions turn, a text-only model). The server searches
// the owner's words against CAPABILITY_ENTRIES alone and hands the engine at
// most three short lines, so every engine answers from the same records.
//
// Bounded: at most the last 400 characters of the turn are searched (the
// newest words, not a replayed history), at most 3 lines of at most 600
// characters each. Each line keeps its status, applicability, limits and the
// ask-your-bot step whole; only the answer prose is shortened to fit, so a
// "desktop only" or a workaround is never clipped off the end (Astra r2 H1).
import { CAPABILITY_ENTRIES, type CapabilityEntry } from "./capability-db.ts";
import { searchHelp } from "./help-search.ts";

export const CAPABILITY_FACTS_HEADER = "Murage facts for this question (checked product facts; if they do not cover it, say you are not sure instead of guessing):";
export const CAPABILITY_FACTS_QUESTION_CHARS = 400;
export const CAPABILITY_FACTS_LINE_CHARS = 600;
export const CAPABILITY_FACTS_MAX_LINES = 3;

const byId = new Map<string, CapabilityEntry>(CAPABILITY_ENTRIES.map((entry) => [entry.id, entry]));

/** One fact line: the essentials first and whole, the answer shortened to what is left. */
export function capabilityFactLine(entry: CapabilityEntry): string {
  const essentials = [
    `${entry.title}: ${entry.description}`,
    entry.applies,
    entry.limits,
    entry.askYourBot ? `Ask your bot: ${entry.askYourBot}` : "",
    entry.where && entry.where !== "Murage capabilities" ? `Where: ${entry.where}.` : "",
  ].filter(Boolean);
  const head = `- ${essentials[0]}`;
  const tail = essentials.slice(1).join(" ");
  const answer = entry.answer;
  const room = CAPABILITY_FACTS_LINE_CHARS - head.length - tail.length - 2;
  const shortAnswer = room <= 0 ? "" : answer.length <= room ? answer : `${answer.slice(0, Math.max(room - 1, 0)).replace(/\s+\S*$/, "")}…`;
  return [head, shortAnswer, tail].filter(Boolean).join(" ");
}

/** The facts block for a turn's text, or "" when no capability covers it. */
export function capabilityFacts(text: string, corpus: readonly CapabilityEntry[] = CAPABILITY_ENTRIES): string {
  const question = text.slice(-CAPABILITY_FACTS_QUESTION_CHARS);
  const hits = searchHelp(question, { corpus, limit: CAPABILITY_FACTS_MAX_LINES, strict: true });
  const lines = hits
    .map((hit) => (corpus === CAPABILITY_ENTRIES ? byId.get(hit.id) : corpus.find((entry) => entry.id === hit.id)))
    .filter((entry): entry is CapabilityEntry => Boolean(entry))
    .map(capabilityFactLine);
  return lines.length ? [CAPABILITY_FACTS_HEADER, ...lines].join("\n") : "";
}
