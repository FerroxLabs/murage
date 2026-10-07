// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WHEN a bot's cloud computer is woken relative to the prompt. A turn's
// prompt must never wait for a computer the model has not asked to use yet:
// the Box proxy already resumes an archived box on the first tool call that
// finds it asleep (computer-proxy.ts resumeBox), so dispatch only waits for
// a wake when the agent itself runs on the box.

/** Longest the first computer tool call waits for an archived box to come
 * back before it errors cleanly ("asleep and did not wake in time"). */
export const BOX_LAZY_WAKE_BUDGET_MS = 90_000;

const READY_STATES = ["idle", "ready", "running"];

/** True when dispatch must await readyBox before sending the prompt. Only
 * the box-native Computer engine qualifies: its agent runs ON the box, so the
 * prompt itself needs the machine. Every engine that merely mounts the
 * computer as MCP tools defers the wake to its first tool call. */
export function awaitBoxWakeAtDispatch(input: {
  mountsCloudComputer: boolean;
  driverKind: string;
  boxState: string | undefined;
}): boolean {
  if (!input.mountsCloudComputer) return false;
  if (input.boxState === undefined || READY_STATES.includes(input.boxState)) return false;
  return input.driverKind === "boxAgent";
}

/** MURAGE_TURN_TRACE=1 prints turn-phase marks so a cold turn shows whether
 * dispatch still paid for a computer wake. */
export function turnTrace(mark: string, detail?: string): void {
  if (process.env.MURAGE_TURN_TRACE !== "1") return;
  console.log(`[turn-trace] ${mark}${detail ? ` ${detail}` : ""} t=${Date.now()}`);
}
