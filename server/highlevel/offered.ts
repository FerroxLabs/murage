// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which engines HighLevel is offered on (HL-S2-WRITES (b3)). HighLevel rides the same per-turn internal-token mount as
// the phone tools, so the one table in phone-jobs-engines.ts decides both. An engine that does not mount it (Antigravity,
// OpenClaw, the chat and compat engines, boxAgent, any unknown kind) is never given a grant, its owner screen says why,
// and a bot that already holds a grant on it is told on its own turns rather than left with a grant it cannot use.
import { driverMountsPhoneJobs } from "../phone-jobs-engines.ts";

/** Whether a bot on this driver kind can use HighLevel at all. Fails closed for an unknown kind. */
export function highlevelOfferedOn(driverKind: string | undefined): boolean {
  return typeof driverKind === "string" && driverMountsPhoneJobs(driverKind);
}

/** The owner screen line and the grant refusal (approved copy, MurageMain 11-03). */
export const HIGHLEVEL_ENGINE_OWNER_LINE = "This bot's AI can't use HighLevel yet. Switch it to Fuigo or another AI.";
/** The bot's own direct turn when it holds a grant its engine cannot use (approved copy, MurageMain 11-03). */
export const HIGHLEVEL_ENGINE_TURN_LINE = "HighLevel isn't available on this bot's AI yet. Ask the owner to switch it to Fuigo or another AI.";

/** The turn line for a bot that holds a native grant on an engine without HighLevel; undefined otherwise. */
export function highlevelEngineTurnLine(input: { driverKind: string | undefined; grants: number; ownerAudience: boolean }): string | undefined {
  return input.ownerAudience && input.grants > 0 && !highlevelOfferedOn(input.driverKind) ? HIGHLEVEL_ENGINE_TURN_LINE : undefined;
}
