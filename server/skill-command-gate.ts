// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When a typed `/name` runs one of the bot's skills (104 item 171): only the
// owner's own plain message in a one-to-one chat. A webhook, a routine, a
// bot-to-bot hand-off, a card continuation, a quoted reply or an engine's own
// command keeps its literal text.
export interface SkillCommandTurn {
  engineCommand: unknown;
  humanIsOwner: boolean;
  automationSource: string | undefined;
  unattended: boolean | undefined;
  commsDepth: number;
  cardContinuation: boolean | undefined;
  replyTo: unknown;
  routineRunPrompt: unknown;
}

export function skillCommandApplies(turn: SkillCommandTurn): boolean {
  return !turn.engineCommand && turn.humanIsOwner && turn.automationSource === undefined && !turn.unattended && !turn.commsDepth
    && !turn.cardContinuation && !turn.replyTo && !turn.routineRunPrompt;
}
