import type { SendTurnInput } from '../contracts.ts';
import { expect, it } from 'vitest';
import { musePosture } from './muse-code.ts';
it('R7 Muse reads the live Full/No limits posture as well as Ask', () => {
 let level: ReturnType<NonNullable<SendTurnInput["permissionNow"]>> = { askLevel: true };
 const turn = { askLevel: true as const, permissionNow: () => level };
 expect(musePosture(turn)).toBe('ask');
 level = { stopLine: true };
 expect(musePosture(turn)).toBe('full');
 level = {};
 expect(musePosture(turn)).toBe('auto');
});

import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MuseCodeDriver } from './muse-code.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('S3a/M70 restarts serve without immutable Ask flags and continues the stopped action', async () => {
 const scratch = mkdtempSync(join(tmpdir(), 'muse-switch-'));
 const cli = fileURLToPath(new URL('./testing/posture-muse.mjs', import.meta.url)); chmodSync(cli, 0o755);
 const log = join(scratch, 'frames.jsonl'), witness = join(scratch, 'written.txt');
 process.env.FAKE_MUSE_LOG = log; process.env.POSTURE_WITNESS = witness;
 const instance = await MuseCodeDriver.create({ instanceId: 'switch', displayName: 'Switch', enabled: true, environment: {}, config: { cli } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 try {
  await instance.adapter.sendTurn({ threadId: 'switch', cwd: fixtureBotFolder(), text: 'fixture', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  await recorder.until(e => e.type === 'turn.started');
  // Wait for native submission, not the canonical start reservation.
  await new Promise<void>((resolve, reject) => { const at = Date.now(); const timer = setInterval(() => {
   if (Date.now() - at > 10000) { clearInterval(timer); reject(Error('no native start')); }
   try { if (readFileSync(log, 'utf8').includes('"method":"turn/start"')) { clearInterval(timer); resolve(); } } catch {}
  }, 10); });
  ask = false; expect(instance.adapter.onPostureChange).toBeTypeOf('function');
  await instance.adapter.onPostureChange!('switch');
  const frames = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const launches = frames.filter(x => x.launch?.[0] === 'serve' && !x.launch.includes('--no-session-log'));
  expect(launches).toHaveLength(2); expect(launches[0].launch).toContain('--disable-shell'); expect(launches[1].launch).not.toContain('--disable-write');
  await recorder.until(e => e.type === 'turn.completed');
  expect(readFileSync(witness, 'utf8')).toContain('write after restart');
 } finally { recorder.stop(); await instance.dispose(); delete process.env.FAKE_MUSE_LOG; delete process.env.POSTURE_WITNESS; await removeTempDir(scratch); }
}, 20000);
