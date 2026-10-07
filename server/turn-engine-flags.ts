// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The turn-engine flags (SPEC-P section 14, lane E1), in `config.json`
// `features`. Every one defaults to on, which is the shipped behaviour; off
// is a kill switch that never deletes or strands a row (the flag-transition
// table in SPEC-P 14):
//   roomsThreadAdmission  off: the old `bot.busy` test, plus the queue
//   roomsQueue            off: new owner sends use the in-memory queue; rows
//                         already queued are still dispatched
//   roomsMentionChain     off: the one-hop @mention chain runs nowhere (on, it
//                         runs only in rooms marked `mentionChain: true`)
//   projectsAutonomy      off: no wakes, no card runs (conversation only)
//   projectsAutoWake      off: results post but wake nobody
// A restore rebuilds `features`, so every flag comes back at its default.
import type { AppConfig } from "./config.ts";

export const TURN_ENGINE_FLAGS = [
  "roomsThreadAdmission",
  "roomsQueue",
  "roomsMentionChain",
  "projectsAutonomy",
  "projectsAutoWake",
  "projectsParallelCards",
] as const;
export type TurnEngineFlag = (typeof TURN_ENGINE_FLAGS)[number];

export function turnEngineFlag(cfg: Pick<AppConfig, "features">, flag: TurnEngineFlag): boolean {
  return (cfg.features as Record<string, unknown> | undefined)?.[flag] !== false;
}

/** The served projection (the config route is an allowlist). */
export function turnEngineFlagProjection(cfg: Pick<AppConfig, "features">): Record<TurnEngineFlag, boolean> {
  return Object.fromEntries(TURN_ENGINE_FLAGS.map((flag) => [flag, turnEngineFlag(cfg, flag)])) as Record<TurnEngineFlag, boolean>;
}
