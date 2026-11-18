// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared seam for the native-crash witnesses: a fenced native reply refused on a path OUTSIDE HTTP containment must not escape
// as an unhandledRejection/uncaughtException (fatal in the server process) and must leave the turn in a defined terminal refusal.
// A listener on both events stands in for the fatal default (a listener also suppresses the exit, so the worker survives and
// no sleep is needed).
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { EventRecorder } from './events.ts';
import type { FencedRefusalRecord } from '../drivers/engine-input.ts';

export interface EscapeWatch { escaped: string[]; stop(): void }
export function watchEscapes(): EscapeWatch {
  const escaped: string[] = [];
  const onEscape = (reason: unknown) => { escaped.push(String((reason as Error)?.stack ?? reason)); };
  process.on('unhandledRejection', onEscape); process.on('uncaughtException', onEscape);
  return { escaped, stop() { process.off('unhandledRejection', onEscape); process.off('uncaughtException', onEscape); } };
}

/** Wait for the turn's terminal event (never a sleep), then assert both halves of the contract. */
export async function expectDefinedRefusal(recorder: EventRecorder, watch: EscapeWatch, turnId: string): Promise<void> {
  let ended: unknown = 'turn left open (no turn.completed within the recorder ceiling)';
  try { ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId); } catch (error) { ended = String((error as Error).message).slice(0, 300); }
  await new Promise(resolve => setImmediate(resolve));
  expect.soft(watch.escaped, 'fenced native reply escaped as an unhandled rejection/exception (fatal in the server process)').toEqual([]);
  expect(ended, 'the turn must end in a defined terminal refusal').toMatchObject({ type: 'turn.completed', ok: false });
}

/** R3 A1: exactly one turn.completed for the turn, ok:false with reason "memory-refused" (never a generic engine failure). */
export async function expectMemoryRefused(recorder: EventRecorder, watch: EscapeWatch, turnId: string): Promise<void> {
  await expectDefinedRefusal(recorder, watch, turnId);
  const ends = recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === turnId);
  expect(ends, 'exactly one terminal event for the refused turn').toHaveLength(1);
  expect(ends[0], 'the refused turn names its reason').toMatchObject({ ok: false, stopReason: 'memory-refused' });
}

/** MODEL-PIS (MC63 ruling, LLS/PIS): a pi refusal lands inside adapter.interruptTurn, after the Stop's cancelTurn and its stop note, so
 * "no cancelled, no Stop note" cannot hold for PIS. The expectation is the STOP-AFTER-CANCEL (in flight) end state: the Stop's signal row and
 * note are allowed once each, the Stop's interrupt is the ONE interruptTurn for g (adopted as the lease's close), ONE memory_refused, the
 * provider's cancelled completion is dropped at the bus (no cancelled terminal, dupTerminalRejected 1), no unconfirmed-Stop error.
 * Owner of the expectation: G0 (nc-shared); owner of the PIS witness that codes against it: G4. */
export interface PisStopCounts { stopSignal: number; stopNote: number; interruptTurn: number; memoryRefused: number; cancelledTerminals: number;
  dupTerminalRejected: number; unconfirmedStop: number }
export const PIS_STOP_EXPECTATION: Readonly<PisStopCounts> = Object.freeze({ stopSignal: 1, stopNote: 1, interruptTurn: 1, memoryRefused: 1,
  cancelledTerminals: 0, dupTerminalRejected: 1, unconfirmedStop: 0 });
export function expectPisStop(observed: PisStopCounts): void {
  expect(observed, `MODEL-PIS end state ${JSON.stringify(observed)}`).toEqual(PIS_STOP_EXPECTATION);
}

/** R3 A6: exactly one positive local record for the sink, with a final outcome (never left undefined). */
export function expectRefusalRecord(records: readonly FencedRefusalRecord[], sink: string, termination: FencedRefusalRecord['termination']): FencedRefusalRecord {
  const mine = records.filter(r => r.sink === sink);
  expect(mine, `one local refusal record for ${sink}`).toHaveLength(1);
  expect(mine[0]!.termination).toBe(termination);
  expect(mine[0]!.outcome, 'the record is completed with its outcome').toBeDefined();
  return mine[0]!;
}

/** R3 A5: the child is discharged for this refusal: the fake recorded the T-FIX cancel frame (a refusal, never an approval) before
 * it was stopped, and its process is gone. The fake flushes its dump on receipt and again in its SIGTERM handler, so no wait is needed. */
export function expectChildDischarged(dumpPath: string): void {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as { pid: number; decision: unknown };
  expect(dump.decision, 'the child received the cancel frame for the refused request').toBeTruthy();
  expect(JSON.stringify(dump.decision), 'the cancel frame is a refusal, never an approval').not.toMatch(/accept/i);
  let alive = true;
  try { process.kill(dump.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  expect(alive, 'the child process is gone once the turn ends').toBe(false);
}
