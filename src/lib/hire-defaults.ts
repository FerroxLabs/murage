// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L6A part 2: hire in one sentence (UX-FIRSTRUN-SCALE-1012 section 1.2 and
// 1.8, build plan L6A). The owner says what the bot should do; the sheet
// suggests a short name nobody on the team has yet, and the sentence becomes
// the bot's description, which is the job it is given. Pure, so the sheet and
// its tests share one rule.

/** Short, friendly names, tried in order; the first one free is suggested. */
export const HIRE_NAMES = ["Juno", "Ivy", "Milo", "Nova", "Otto", "Wren", "Remy", "Iris", "Theo", "Mara", "Felix", "Hazel"] as const;

/** The fewest characters a job sentence needs before Hire is offered. */
export const HIRE_SENTENCE_MIN = 3;
/** The longest job sentence kept; the server's description takes far more, this keeps the sheet one sentence. */
export const HIRE_SENTENCE_MAX = 500;
/** The longest name kept. */
export const HIRE_NAME_MAX = 60;

/**
 * The first suggested name no visible or archived bot already carries
 * (compared without case or spaces at the ends). When every name is taken,
 * the first one with the lowest free number: "Juno 2".
 */
export function suggestHireName(taken: ReadonlyArray<string>): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  const free = HIRE_NAMES.find((name) => !used.has(name.toLowerCase()));
  if (free) return free;
  for (let n = 2; ; n += 1) {
    const candidate = `${HIRE_NAMES[0]} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The sentence as it will be saved: one line, spaces folded, cut to the maximum. */
export function hireSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, HIRE_SENTENCE_MAX);
}

/** Whether Hire can go ahead: a job of a few words. An empty name is not a
 *  stop; the suggested name is used (hireProfile). */
export function hireReady(sentence: string): boolean {
  return hireSentence(sentence).length >= HIRE_SENTENCE_MIN;
}

export interface HireProfile {
  name: string;
  description: string;
}

/** What POST /api/bots receives: only the name and the job. The engine is
 *  the server's birth rule (BIRTH-FUIGO), never picked here. */
export function hireProfile(sentence: string, name: string, taken: ReadonlyArray<string>): HireProfile {
  const cleanName = name.replace(/\s+/g, " ").trim().slice(0, HIRE_NAME_MAX) || suggestHireName(taken);
  return { name: cleanName, description: hireSentence(sentence) };
}
