import { chmodSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AntigravityDriver } from './antigravity.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('R7 Antigravity reads the new level before the next native hook', async () => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'agy-posture-'));
 const cli = fileURLToPath(new URL('../testing/fake-agy-cli.ts', import.meta.url)); chmodSync(cli, 0o755);
 process.env.FAKE_AGY_RUN_HOOKS = '1';
 process.env.FAKE_AGY_TOOL_CALLS = JSON.stringify([{ name: 'view_file', args: { AbsolutePath: join(scratch, 'a.txt') } }, { name: 'run_command', args: { CommandLine: 'echo fixture', Cwd: scratch } }]);
 const instance = await AntigravityDriver.create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: { HOME: scratch }, config: { cli, fullAuto: true } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 const off = instance.adapter.onEvent(e => {
  if (e.type === 'item.completed' && e.itemType === 'tool') ask = false;
  if (e.type === 'request.opened') void instance.adapter.respondToRequest(e.threadId, String(e.requestId), { behavior: 'allow' });
 });
 try {
  await instance.adapter.sendTurn({ threadId: 'agy-switch', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  await recorder.until(e => e.type === 'turn.completed');
  expect(recorder.events.some(e => e.type === 'request.opened' && e.tool === 'run_command')).toBe(true);
  expect(recorder.events.filter(e => e.type === 'item.completed' && e.itemType === 'tool' && e.ok === true)).toHaveLength(2);
 } finally { off(); recorder.stop(); await instance.dispose(); delete process.env.FAKE_AGY_RUN_HOOKS; delete process.env.FAKE_AGY_TOOL_CALLS; await removeTempDir(scratch); }
});

it('E3 No limits downgrade restores Ask before the next native hook', async () => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'agy-posture-'));
 const cli = fileURLToPath(new URL('../testing/fake-agy-cli.ts', import.meta.url)); chmodSync(cli, 0o755);
 process.env.FAKE_AGY_RUN_HOOKS = '1';
 process.env.FAKE_AGY_TOOL_CALLS = JSON.stringify([{ name: 'view_file', args: { AbsolutePath: join(scratch, 'a.txt') } }, { name: 'run_command', args: { CommandLine: 'echo fixture > blocked.txt', Cwd: scratch } }]);
 const instance = await AntigravityDriver.create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: { HOME: scratch }, config: { cli, fullAuto: true } });
 const recorder = recordEvents(instance.adapter); let ask = false;
 const off = instance.adapter.onEvent(e => {
  if (e.type === 'item.completed' && e.itemType === 'tool') ask = true;
  if (e.type === 'request.opened') void instance.adapter.respondToRequest(e.threadId, String(e.requestId), { behavior: 'allow' });
 });
 try {
  await instance.adapter.sendTurn({ threadId: 'agy-switch', cwd: scratch, text: 'fixture', noLimits: true, stopLine: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  await recorder.until(e => e.type === 'turn.completed');
  expect(recorder.events.some(e => e.type === 'request.opened' && e.tool === 'run_command')).toBe(false);
  expect(existsSync(join(scratch, 'blocked.txt'))).toBe(false);
 } finally { off(); recorder.stop(); await instance.dispose(); delete process.env.FAKE_AGY_RUN_HOOKS; delete process.env.FAKE_AGY_TOOL_CALLS; await removeTempDir(scratch); }
});
