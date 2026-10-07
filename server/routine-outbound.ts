// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Outbound routine classification (bot learning, batch B4; design 12; Tier 1 allowlist 3.7).
// Read-only over a Routine: it never edits one. The decision is STRUCTURAL: the
// permission mode, always-allow entries, the delivery target, a room goal or a
// watch. The words of the instruction are never read for intent (that was a
// blocklist that could not converge). A routine counts as outbound when it can
// reach someone other than the owner, and when it is unclear the answer is
// "outbound" so a learned change becomes a one-tap suggestion instead of applying.
import type { Routine } from "./routines.ts";

export type OutboundReason = "room-goal" | "non-owner-audience" | "write-tool-mounted" | "no-instructions" | "unknown-delivery" | "unknown-tools";
export interface RoutineOutbound { outbound: boolean; reasons: OutboundReason[] }

/** `context.writeToolsMounted`: the caller's answer from the connected-app
 * action catalogue (any step mounts a send, post, publish, pay or book action).
 * `context.deliversToOwnOnly`: false when the run's delivery target is not the
 * owner's own thread or device. Unknown (undefined) counts as outbound (design 12: when unsure, outbound). */
export function classifyRoutineOutbound(routine: Pick<Routine, "prompt" | "target" | "instructionHistory" | "instructionRevision">, context: { writeToolsMounted?: boolean; deliversToOwnOnly?: boolean } = {}): RoutineOutbound {
  const reasons = new Set<OutboundReason>();
  const prompt = typeof routine.prompt === "string" ? routine.prompt.trim() : "";
  if (!prompt) reasons.add("no-instructions");
  if (routine.target === "room-goal") reasons.add("room-goal");
  if (context.writeToolsMounted) reasons.add("write-tool-mounted");
  else if (context.writeToolsMounted !== false) reasons.add("unknown-tools");
  if (context.deliversToOwnOnly === false) reasons.add("non-owner-audience");
  else if (context.deliversToOwnOnly !== true) reasons.add("unknown-delivery");
  return { outbound: reasons.size > 0, reasons: [...reasons] };
}

/** What decides whether a skill may change on its own (Tier 1 allowlist 3.7): the facts about every context that can run it. */
export interface RunContextFacts {
  /** The bot and its tasks ask before acting (no Auto, Full access or no-limits). */
  asksFirst: boolean;
  /** Always-allow entries on the bot or any of its tasks. */
  alwaysAllowCount: number;
  /** The audience is the workspace owner alone. */
  ownerOnly: boolean;
  /** The bot runs in a room or a room goal. */
  inRoom: boolean;
  /** The bot is bound to Telegram, Slack, Discord or another channel. */
  channelBound: boolean;
}
/** Contained means: every context that can run it asks first, has nothing always-allowed, serves the owner alone, and has no room or channel.
 * No contexts at all is unknown, and unknown is not contained. The words of the skill are never read. */
export function contextsContained(contexts: readonly RunContextFacts[]): boolean {
  return contexts.length > 0 && contexts.every(context => context.asksFirst && context.alwaysAllowCount === 0 && context.ownerOnly && !context.inRoom && !context.channelBound);
}
