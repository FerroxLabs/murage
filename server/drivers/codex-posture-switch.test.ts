import { normalizeStartup } from './testing/startup-parity.ts';
import { writeFileSync } from 'node:fs';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CodexDriver } from './codex.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('R7 Codex next approval remains answerable after Ask to No limits', async () => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'codex-posture-'));
 const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url)); chmodSync(cli, 0o755);
 const dump = join(scratch, 'frames.json');
 process.env.FAKE_CODEX_MODE = 'parent-approval'; process.env.FAKE_CODEX_DUMP = dump;
 const instance = await CodexDriver.create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: {}, config: { cli, fullAuto: false } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 try {
  await instance.adapter.sendTurn({ threadId: 'codex-switch', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  const opened = await recorder.until(e => e.type === 'request.opened');
  ask = false;
  await instance.adapter.respondToRequest('codex-switch', String(opened.requestId), { behavior: 'allow' });
  await recorder.until(e => e.type === 'turn.completed');
  expect(JSON.parse(readFileSync(dump, 'utf8')).decision).toEqual({ decision: 'accept' });
 } finally { recorder.stop(); await instance.dispose(); delete process.env.FAKE_CODEX_MODE; delete process.env.FAKE_CODEX_DUMP; await removeTempDir(scratch); }
});

it.each(['ask', 'auto', 'full', 'unlimited'])('S3c BASE 292df98d turn/start parity at %s with no change', async level => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'codex-base-'));
 const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url)); chmodSync(cli, 0o755);
 const dump = join(scratch, 'dump.json'); process.env.FAKE_CODEX_DUMP = dump;
 const instance = await CodexDriver.create({ instanceId: 'parity', displayName: 'Parity', enabled: true, environment: {}, config: { cli, fullAuto: false } });
 const recorder = recordEvents(instance.adapter);
 try {
  await instance.adapter.sendTurn({ threadId: 'parity-' + level, cwd: fixtureBotFolder(), text: 'fixture',
   askLevel: level === 'ask' ? true : undefined, routeAsks: level === 'ask' || level === 'auto' ? true : undefined, stopLine: level === 'full' || level === 'unlimited' ? true : undefined, noLimits: level === 'unlimited' ? true : undefined });
  await recorder.until(e => e.type === 'turn.completed');
  const { calls } = JSON.parse(readFileSync(dump, 'utf8'));
  const start = calls.find((c: any) => c.method === 'turn/start').params;
  const snapshot = normalizeStartup(start, fixtureBotFolder());
  if (process.env.STARTUP_CAPTURE_DIR) writeFileSync(join(process.env.STARTUP_CAPTURE_DIR, `codex-${level}.json`), JSON.stringify(snapshot, null, 2));
  else expect(snapshot).toEqual(startupBase.codexFull[level]);
 } finally { recorder.stop(); await instance.dispose(); delete process.env.FAKE_CODEX_DUMP; await removeTempDir(scratch); }
});

it.each([false, true])('A11a answers pre-change approval before the barrier and retries with the new sandbox (early completion=%s)', async early => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'codex-barrier-'));
 const cli = fileURLToPath(new URL('./testing/posture-codex.mjs', import.meta.url)); chmodSync(cli, 0o755);
 const log = join(scratch, 'frames.jsonl'), witness = join(scratch, 'outside.txt');
 process.env.POSTURE_LOG = log; process.env.POSTURE_WITNESS = witness; process.env.POSTURE_EARLY_TERMINAL = early ? '1' : '0';
 const instance = await CodexDriver.create({ instanceId: 'barrier', displayName: 'Barrier', enabled: true, environment: {}, config: { cli, fullAuto: false } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 try {
  await instance.adapter.sendTurn({ threadId: 'barrier', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  const opened = await recorder.until(e => e.type === 'request.opened'); ask = false;
  expect(instance.adapter.onPostureChange).toBeTypeOf('function');
  const changed = instance.adapter.onPostureChange!('barrier'); const at = Date.now();
  await instance.adapter.respondToRequest('barrier', String(opened.requestId), { behavior: 'allow' }, { answerId: 'allow-base' });
  expect(Date.now() - at).toBeLessThan(1000);
  await changed; await recorder.until(e => e.type === 'turn.completed');
  const frames = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const starts = frames.filter(x => x.method === 'turn/start');
  expect(starts).toHaveLength(2); expect(starts[1].params.sandbox).toBe('danger-full-access');
  expect(starts[1].params.input[0].text).toMatch(/retry/i);
  expect(frames.findIndex(x => x.result?.decision === 'accept')).toBeLessThan(frames.findIndex(x => x.method === 'turn/interrupt'));
  expect(readFileSync(witness, 'utf8')).toContain('outside bot folder');
 } finally { recorder.stop(); await instance.dispose(); delete process.env.POSTURE_LOG; delete process.env.POSTURE_WITNESS; delete process.env.POSTURE_EARLY_TERMINAL; await removeTempDir(scratch); }
});

import { vi } from 'vitest';
import { PostureBarrier } from './posture-barrier.ts';
it('A11a blocked-item deadline preempts at ten seconds and coalesces level events', async () => {
 vi.useFakeTimers();
 try {
  const barrier = new PostureBarrier(), restart = vi.fn(async () => {});
  const first = barrier.change(restart), second = barrier.change(restart);
  await vi.advanceTimersByTimeAsync(9999); expect(restart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await Promise.all([first,second]); expect(restart).toHaveBeenCalledTimes(1);
 } finally { vi.useRealTimers(); }
});

const startupBase = JSON.parse(readFileSync(new URL("./testing/startup-base.json", import.meta.url), "utf8"));
