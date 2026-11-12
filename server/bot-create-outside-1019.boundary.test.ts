import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { Store, inertBot } from './store.ts';
import { createStopGate } from './drivers/stop-gate.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { TurnSubmissionBoundary } from './turn-dispatch-guard.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
const staging = () => ({ rev: 1, at: 1, generation: 'G', reason: 'turn-open' as const, byThreadId: 'T', byBotId: 'chief',
  intended: { autoApprove: true, fullAccess: false, noLimits: false, lead: true, modelSelection: { instanceId: 'intended', model: 'model' } }, heldWork: [] });
it('persists inert Susan at birth and keeps it out of submission and task admission', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'safe' }));
  const seen: boolean[] = []; store.onChange(e => { if (e.type === 'bot') seen.push(inertBot(store.bot(e.botId)!)); });
  const bot = store.createBot({ name: 'Susan' }, { staged: staging(), seedMessages: false });
  const disk = JSON.parse(readFileSync(join(DATA_DIR, 'bots.json'), 'utf8'))[0];
  expect(disk.staged).toEqual(staging()); expect(disk.autoApprove).toBe(false); expect(disk.alwaysAllow).toEqual([]);
  expect(disk.chiefOfStaff).not.toBe(true); expect(disk.modelSelection.instanceId).toBe('fixture');
  expect(disk.tasks[0].autoApprove).toBe(false); expect(seen).toEqual([true]);
  expect(store.activeBot(bot.id)).toBeNull(); expect(store.activeBots()).toEqual([]); expect(store.createTask(bot.id)).toBeNull();
  const boundary = new TurnSubmissionBoundary(() => inertBot(store.bot(bot.id)!));
  let checked = false; expect(() => boundary.beforeSubmit(() => { checked = true; })).toThrow(/review|reply/i); expect(checked).toBe(false);
});
it('a stopped answer never inherits complete reads from a plain verdict', () => {
  const events: Record<string, unknown>[] = [];
  const gate = createStopGate({ engineName: 'fixture', emit: e => events.push(e), base: () => ({}) });
  const e = gate.enter('T'); gate.ask('T'); e.finish({ ok: true, stopReason: null, readsComplete: true });
  expect(events.at(-1)?.readsComplete).toBeUndefined();
});
it('a plain terminal carries the top-level complete flag and folded Codex stop', () => {
  const events: Record<string, unknown>[] = [];
  const gate = createStopGate({ engineName: 'fixture', emit: e => events.push(e), base: () => ({}) });
  gate.enter('T').finish({ ok: true, stopReason: '', readsComplete: true, extra: { stopReason: null } });
  expect(events.at(-1)).toMatchObject({ ok: true, readsComplete: true, stopReason: null });
});
it('checks a live bot again after acceptance and before each provider write', () => {
  let staged = false; let checks = 0; let refused = false;
  const boundary = new TurnSubmissionBoundary(() => staged);
  boundary.started(); boundary.beforeSubmit(() => checks++);
  boundary.acceptedBy(() => { refused = true; }); staged = true;
  expect(() => boundary.beforeSubmit(() => checks++)).toThrow(/review/);
  expect(checks).toBe(1); expect(refused).toBe(true);
});
it('wires the live inert check into both production provider submission boundaries', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const constructors = [...source.matchAll(/new TurnSubmissionBoundary\(([^;]*)\);/g)].map(m => m[1]);
  expect(constructors).toHaveLength(2);
  for (const arg of constructors) expect(arg).toContain('store.activeBot(');
});
it('withholds an explicitly requested model from the staged record at birth', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'safe' }));
  const bot = store.createBot({ name: 'Susan', modelSelection: { instanceId: 'intended', model: 'model' } }, { staged: staging(), seedMessages: false });
  expect(bot.modelSelection.instanceId).toBe('fixture');
  expect(bot.staged?.intended.modelSelection?.instanceId).toBe('intended');
});
