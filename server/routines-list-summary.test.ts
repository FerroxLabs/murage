// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RoutineManager, type RoutineRun } from './routines.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

it('R5 run summaries cache history reads and refresh after real run transitions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-summary-'));
  let now = Date.parse('2026-11-12T08:00:00Z'), thread = '';
  const manager = new RoutineManager({ file: join(dir, 'routines.json'), now: () => now, emit: () => {}, botState: () => 'ready',
    createTask: () => ({ threadId: thread = 'summary-' + now }), startTurn: async () => {} });
  try {
    const routine = manager.create({ botId: 'summary-bot', name: 'Summary', prompt: 'Fixture', enabled: false, schedule: { type: 'interval', everyMinutes: 60, anchorAt: now } });
    const settle = async (ok: boolean) => {
      now += 60_000; manager.runNow(routine.id); await manager.tick();
      manager.handleRuntimeEvent({ eventId: thread, provider: 'fake', threadId: thread, createdAt: new Date(now).toISOString(), type: 'turn.completed', ok, ...(ok ? {} : { stopReason: 'crashed' }) });
    };
    await settle(false);
    expect(manager.latestRunForRoutine(routine.id)?.status).toBe('failed');
    expect(manager.listRoutines()[0].failureStreak).toBe(1);
    // Observe actual history iteration, independent of wall-clock speed.
    // Observe the canonical store; runs is now an explicit owner facade.
    const history = (manager as unknown as { runStore: Set<RoutineRun> }).runStore;
    const iterate = history[Symbol.iterator].bind(history); let visits = 0;
    history[Symbol.iterator] = function* (): Generator<RoutineRun, undefined> { for (const run of iterate()) { visits++; yield run; } return undefined; };
    manager.latestRunForRoutine(routine.id); visits = 0;
    for (let i = 0; i < 105; i++) { manager.listRoutines(); manager.latestRunForRoutine(routine.id); }
    expect(visits).toBe(0);
    const copy = manager.latestRunForRoutine(routine.id)!; copy.status = 'cancelled';
    expect(manager.latestRunForRoutine(routine.id)?.status).toBe('failed');
    manager.update(routine.id, { botId: 'next-owner' });
    expect(manager.latestRunForRoutine(routine.id, 'next-owner')).toBeUndefined();
    expect(manager.latestRunForRoutine(routine.id, 'summary-bot')?.status).toBe('failed');
    await settle(true);
    expect(manager.latestRunForRoutine(routine.id, 'next-owner')?.status).toBe('completed');
    expect(manager.latestRunForRoutine(routine.id, 'summary-bot')?.status).toBe('failed');
    expect(manager.latestRunForRoutine(routine.id)?.status).toBe('completed');
    expect(manager.listRoutines()[0].failureStreak).toBeUndefined();
    expect(visits).toBeGreaterThan(0);
  } finally { manager.stop(); removeTempDirSync(dir); }
});

it('H1 summary history visits stay constant across transitions and listings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-summary-transitions-'));
  const manager = new RoutineManager({ file: join(dir, 'routines.json'), emit: () => {}, botState: () => 'ready', createTask: () => ({ threadId: 'unused' }), startTurn: async () => {} });
  try {
    const routine = manager.create({ botId: 'b', name: 'History', prompt: 'Fixture', enabled: false, schedule: { type: 'interval', everyMinutes: 60, anchorAt: 1 } });
    const memory = manager as unknown as { runs: RoutineRun[] };
    memory.runs = Array.from({ length: 4000 }, (_, i) => ({ id: 'history-'+i, routineId: routine.id, botId: 'b', status: i % 5 ? 'failed' : 'completed', createdAt: i, scheduledFor: i, finishedAt: i } as RoutineRun));
    manager.listRoutines();
    let visits = 0;
    const history = memory.runs, store = (manager as unknown as { runStore: Set<RoutineRun> }).runStore;
    // The owner boundary may retire its bounded slice above the history cap.
    expect(history.at(-1)?.id).toBe('history-3999');
    const iterate = store[Symbol.iterator].bind(store);
    store[Symbol.iterator] = function* (): Generator<RoutineRun, undefined> { for (const run of iterate()) { visits++; yield run; } return undefined; };
    for (let i = 0; i < 20; i++) {
      const run = history.at(-1)!;
      run.status = i % 2 ? 'failed' : 'completed';
      run.finishedAt = 5000 + i;
      expect(manager.latestRunForRoutine(routine.id)?.id).toBe(run.id);
      expect(manager.listRoutines()[0].failureStreak).toBe(i % 2 ? 4 : undefined);
    }
    expect(visits).toBe(0);
  } finally { manager.stop(); removeTempDirSync(dir); }
});

it('incremental summaries preserve outcome order, ties, receipt owners and history deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'murage-summary-order-'));
  const manager = new RoutineManager({ file: join(dir, 'routines.json'), emit: () => {}, botState: () => 'ready', createTask: () => ({ threadId: 'unused' }), startTurn: async () => {} });
  try {
    const routine = manager.create({ botId: 'b', name: 'Order', prompt: 'Fixture', enabled: false, schedule: { type: 'interval', everyMinutes: 60, anchorAt: 1 } });
    const memory = manager as unknown as { runs: RoutineRun[] };
    memory.runs = Array.from({ length: 180 }, (_, i) => ({ id: 'order-'+i, routineId: routine.id, botId: i % 2 ? 'b' : 'c', target: 'bot', status: i % 7 ? 'failed' : 'completed', createdAt: i % 13, scheduledFor: i % 11, finishedAt: i % 17 } as RoutineRun));
    const check = () => {
      const runs = [...memory.runs];
      const attempts = runs.filter(r => r.status === 'failed' || r.status === 'completed').sort((a,b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.createdAt - a.createdAt);
      const success = attempts.findIndex(r => r.status === 'completed');
      expect(manager.listRoutines()[0].failureStreak ?? 0).toBe(success < 0 ? attempts.length : success);
      for (const owner of [undefined, 'b', 'c', 'watch-owner']) {
        const expected = runs.filter(r => owner === undefined || (r.watch?.ownerBotId ?? r.botId) === owner).sort((a,b) => b.scheduledFor - a.scheduledFor)[0];
        expect(manager.latestRunForRoutine(routine.id, owner)?.id).toBe(expected?.id);
      }
    };
    check();
    for (let i = 0; i < 100; i++) {
      const run = memory.runs[(i * 37) % memory.runs.length];
      run.status = i % 3 ? 'failed' : 'completed'; run.finishedAt = i % 19;
      run.scheduledFor = i % 11; run.botId = i % 2 ? 'b' : 'c';
      if (i % 9 === 0) run.watch = { ownerBotId: 'watch-owner' } as RoutineRun['watch'];
      check();
    }
    for (let i = 0; i < 10; i++) { manager.deleteRun(memory.runs[i * 3].id); check(); }
    memory.runs.length = 10; check();
    memory.runs.push({ ...memory.runs[0], id: 'appended', scheduledFor: 999, status: 'failed', finishedAt: 999 }); check();
  } finally { manager.stop(); removeTempDirSync(dir); }
});
