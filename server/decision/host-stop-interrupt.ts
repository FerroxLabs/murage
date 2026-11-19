// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DecisionEngineTarget } from './types.ts';

/** The host-stop reason of a turn the decision builder stops (never the owner's Stop). */
export const PERMISSION_UNDELIVERED_STOP_REASON = 'a tool permission could not be delivered, so nothing was run';

/** The decision transport's interrupt. A stop with a host reason is Murage's, not the owner's: the reason is noted in the
 * thread BEFORE the engine is interrupted, so the turn settling after it reads the host line, never "Stopped by you". */
export function decisionInterrupt(deps: {
  adapter(target: DecisionEngineTarget): { interruptTurn(threadId: string, turnId?: string): Promise<unknown> } | undefined;
  botFor(threadId: string): string | undefined;
  noteHostStop(threadId: string, botId: string, reason: string): void;
}): (target: DecisionEngineTarget, hostStopReason?: string) => Promise<void> {
  return async (target, hostStopReason) => {
    const adapter = deps.adapter(target);
    if (!adapter) return;
    const botId = hostStopReason ? deps.botFor(target.threadId) : undefined;
    if (hostStopReason && botId) deps.noteHostStop(target.threadId, botId, hostStopReason);
    await adapter.interruptTurn(target.threadId, target.turnId);
  };
}
