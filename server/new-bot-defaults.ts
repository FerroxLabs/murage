// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workspace defaults for new bots (0.1.61 triage row 23, adapted from
// OpenMausBot e5e60ca0 #1728; its grant-carrying defaults from #1702 are not
// taken). Store.createBot applies this, so POST /api/bots, create_bot and
// Import from Hermes all get it.
import type { EffortLevel, ModelSelection } from "./contracts.ts";

/** Complete a new bot's selection with the workspace's new-bot effort. An
 * explicit effort is the caller's choice and wins; an engine that does not
 * offer the level keeps sending none rather than failing turn 1. */
export function withNewBotEffort(selection: ModelSelection, effort: EffortLevel | null | undefined, offered: readonly EffortLevel[] | undefined): ModelSelection {
  if (!effort || selection.effort !== undefined || !offered?.includes(effort)) return selection;
  return { ...selection, effort };
}
