// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DecisionEngineTarget } from './types.ts';
import { hostStoppedActivityName } from '../../shared/host-stop.ts';

/** The host-stop reason of a turn the decision builder stops (never the owner's Stop). */
export const PERMISSION_UNDELIVERED_STOP_REASON = 'a tool permission could not be delivered, so nothing was run';

/** 1021 Retry: the row a stop that did not land is patched to (no "stopped:" prefix, so it is not a host-stop row). */
/** A decision stop that the driver reported as resolved `stop-failed` rejects with this marker (RETRY-DESIGN-r3 D4). */
export const isStopFailed = (error: unknown): boolean => (error as { stopFailed?: unknown } | undefined)?.stopFailed === true;

export const PERMISSION_UNDELIVERED_NOT_STOPPED = 'not stopped: a tool permission could not be delivered';

/** The decision transport's interrupt. A stop with a host reason is Murage's, not the owner's: the reason is noted in the
 * thread BEFORE the engine is interrupted, so the turn settling after it reads the host line, never "Stopped by you". */
export function decisionInterrupt(deps: {
  adapter(target: DecisionEngineTarget): { interruptTurn(threadId: string, turnId?: string): Promise<unknown> } | undefined;
  botFor(threadId: string): string | undefined;
  noteHostStop(threadId: string, botId: string, reason: string): string | void;
  /** 1021 Retry: rewrite one noted row (by id) to this activity name. */
  patchHostStop?(threadId: string, rowId: string, name: string): void;
}): (target: DecisionEngineTarget, hostStopReason?: string) => Promise<void> {
  // 1021 Retry (RETRY-DESIGN-r2 STOP ROW): one stop row per undelivered ask. A stop that did not land reads "not stopped";
  // a later attempt for the same ask patches that row back to the stopped wording instead of adding a second row.
  const rows = new Map<string, string>();
  return async (target, hostStopReason) => {
    const adapter = deps.adapter(target);
    if (!adapter) return;
    const botId = hostStopReason ? deps.botFor(target.threadId) : undefined;
    const ask = JSON.stringify([target.threadId, target.requestId]);
    const undelivered = hostStopReason === PERMISSION_UNDELIVERED_STOP_REASON && !!deps.patchHostStop;
    const prior = undelivered ? rows.get(ask) : undefined;
    let rowId: string | undefined;
    if (hostStopReason && botId) {
      // MUTANT:retry-stop-row-once
      if (prior) { deps.patchHostStop!(target.threadId, prior, hostStoppedActivityName(hostStopReason)); rowId = prior; }
      else rowId = deps.noteHostStop(target.threadId, botId, hostStopReason) || undefined;
    }
    if (undelivered && rowId) { rows.set(ask, rowId); if (rows.size > 1024) rows.delete(rows.keys().next().value!); }
    // Opus r2 H2: drivers report a failed stop as a RESOLVED { closeConfirmed:false, reason:'stop-failed' } (contracts.ts
    // ProviderStopResult). That, or a throw, is a stop that did not happen: the row says so and the caller sees a rejection.
    // closeConfirmed:true, 'timeout' (it may still close) and a legacy void resolve are not provably failed: terminal for Retry.
    // RETRY-DESIGN-r3 D4/N1: only that resolved stop-failed is a stop that provably did not happen. A throw is unknown (the stop may
    // be HELD, JOINT RULING): it rejects as before, keeps the stopped row and is terminal for Retry.
    const result = await adapter.interruptTurn(target.threadId, target.turnId);
    const stop = result && typeof result === 'object' ? result as { closeConfirmed?: unknown; reason?: unknown } : undefined;
    if (stop?.closeConfirmed === false && stop.reason === 'stop-failed') {
      // MUTANT:retry-stop-row-unpatched
      if (undelivered && rowId) deps.patchHostStop!(target.threadId, rowId, PERMISSION_UNDELIVERED_NOT_STOPPED);
      throw Object.assign(new Error('stop-failed'), { stopFailed: true as const });
    }
  };
}
