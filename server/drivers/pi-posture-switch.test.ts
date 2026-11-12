import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PiDriver } from './pi.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('R7 Pi keeps the next tool on the live approval path after a level switch', async () => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'pi-posture-'));
 const cli = fileURLToPath(new URL('../testing/fake-pi-cli.ts', import.meta.url)); chmodSync(cli, 0o755);
 const instance = await PiDriver.create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: { FAKE_PI_MODE: 'gate', FAKE_PI_GATE_TWICE: '1', FAKE_PI_GATE_CALL: JSON.stringify({ tool: 'bash', input: { command: 'echo fixture' } }) }, config: { cli, fullAuto: false } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 try {
  await instance.adapter.sendTurn({ threadId: 'pi-switch', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  const first = await recorder.until(e => e.type === 'request.opened');
  ask = false;
  await instance.adapter.respondToRequest('pi-switch', String(first.requestId), { behavior: 'deny' });
  const next = await recorder.until(e => e.type === 'request.opened' && e.requestId !== first.requestId);
  await instance.adapter.respondToRequest('pi-switch', String(next.requestId), { behavior: 'allow' });
  await recorder.until(e => e.type === 'turn.completed');
  expect(recorder.events.some(e => e.type === 'request.resolved' && e.requestId === next.requestId && e.behavior === 'allow')).toBe(true);
 } finally { recorder.stop(); await instance.dispose(); await removeTempDir(scratch); }
});
