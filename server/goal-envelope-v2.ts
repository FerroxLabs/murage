// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Goal control envelope v2: the parse side (SPEC-P 9, lane E1). Lane R
// applies it (`applyGoalEnvelopeV2`, server/project-envelope.ts) with a
// strict shape check; this module only finds it.
//
// `<murage-goal>{...}</murage-goal>`, the last complete envelope wins, and
// only in the project lead's own current turn. Everywhere the envelope is
// private protocol: it is stripped from the visible text of every turn,
// lead or not, and a non-lead turn's envelope is ignored. An envelope that
// is not JSON, or whose `v` is not 2, is reported back to the lead in one
// plain line ("Your plan could not be read: ...") and counts as a lead wake
// without progress.
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN } from "./group-goal-run.ts";

export interface ParsedGoalEnvelope {
  /** The reply with every envelope (and a dangling half of one) removed. */
  visibleText: string;
  /** The last complete envelope, parsed; absent when there is none. */
  envelope?: Record<string, unknown>;
  /** Why the last complete envelope could not be read. */
  error?: string;
}

/** Every envelope out of the text; a truncated final one too. */
export function stripGoalEnvelopes(text: string): string {
  let visible = text;
  for (;;) {
    const closeAt = visible.indexOf(GROUP_GOAL_CONTROL_CLOSE);
    if (closeAt < 0) break;
    const openAt = visible.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
    visible = openAt < 0
      ? `${visible.slice(0, closeAt)}${visible.slice(closeAt + GROUP_GOAL_CONTROL_CLOSE.length)}`
      : `${visible.slice(0, openAt)}${visible.slice(closeAt + GROUP_GOAL_CONTROL_CLOSE.length)}`;
  }
  const dangling = visible.indexOf(GROUP_GOAL_CONTROL_OPEN);
  if (dangling >= 0) visible = visible.slice(0, dangling);
  return visible.trim();
}

/** The last complete envelope in a lead's reply (SPEC-P 9). */
export function parseGoalEnvelopeV2(text: string): ParsedGoalEnvelope {
  const visibleText = stripGoalEnvelopes(text);
  const closeAt = text.lastIndexOf(GROUP_GOAL_CONTROL_CLOSE);
  if (closeAt < 0) return { visibleText };
  const openAt = text.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
  if (openAt < 0) return { visibleText };
  const raw = text.slice(openAt + GROUP_GOAL_CONTROL_OPEN.length, closeAt).trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { visibleText, error: "it is not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { visibleText, error: "it is not a JSON object" };
  const envelope = parsed as Record<string, unknown>;
  // v1 (continue, completed, needs-input, blocked) stays for channel goal runs only
  if (envelope.v !== 2) return { visibleText, error: "project goals take version 2 (\"v\": 2)" };
  return { visibleText, envelope };
}

/** The one line the lead's next wake gets for an envelope it could not use. */
export function envelopeRefusalLine(reason: string): string {
  return `Your plan could not be read: ${reason.replace(/[\r\n]+/g, " ").slice(0, 300)}`;
}

/** The room line for a plan that was read but refused (round 12: "could not
 * be read" is only for a plan that was not JSON or not version 2). */
export function envelopeNotUsedLine(leadName: string, reason: string): string {
  return `${leadName}'s plan was not used: ${reason.replace(/[\r\n]+/g, " ").slice(0, 300)}`;
}
