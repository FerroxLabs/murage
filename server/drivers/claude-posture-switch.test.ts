import { normalizeStartup } from './testing/startup-parity.ts';
import { writeFileSync } from 'node:fs';
import { mkdtempSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ClaudeDriver } from './claude.ts';
import { ensureDirs } from '../config.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('S3b Claude reads the live callback without changing BASE native mode', async () => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'claude-posture-'));
 const cli = fileURLToPath(new URL('./testing/posture-claude.mjs', import.meta.url)); chmodSync(cli, 0o755);
 const log = join(scratch, 'control.jsonl');
 process.env.FAKE_CLAUDE_CONTROL_LOG = log;
 process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({ command: 'echo fixture' });
 const instance = await ClaudeDriver.create({ instanceId: 'posture', displayName: 'Posture', enabled: true, environment: {}, config: { cli, permissionMode: 'default' } });
 const recorder = recordEvents(instance.adapter); let ask = true;
 const off = instance.adapter.onEvent(e => {
  if (e.type === 'item.started' && e.itemType === 'tool') ask = false;
  if (e.type === 'request.opened') {
   void instance.adapter.respondToRequest(e.threadId, String(e.requestId), { behavior: 'allow' });
  }
 });
 try {
  await instance.adapter.sendTurn({ threadId: 'claude-switch', cwd: fixtureBotFolder(), text: '__fixture_permission_tool__', askLevel: true, routeAsks: true,
   permissionNow: () => ask ? { askLevel: true, routeAsks: true } : { noLimits: true, stopLine: true } });
  await recorder.until(e => e.type === 'turn.completed');
  expect(ask).toBe(false);
  expect(recorder.events.some(e => e.type === 'item.completed' && e.itemType === 'tool' && e.ok !== false)).toBe(true);
  const modes = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)).filter(x => x.request?.subtype === 'set_permission_mode') : [];
  expect(modes).toEqual([]);
 } finally { off(); recorder.stop(); await instance.dispose(); delete process.env.FAKE_CLAUDE_CONTROL_LOG; delete process.env.FAKE_CLAUDE_PERM_INPUT; await removeTempDir(scratch); }
});

it.each(['ask', 'auto', 'full', 'unlimited'])('S3b BASE 292df98d spawn parity at %s', async level => {
 ensureDirs(); const scratch = mkdtempSync(join(tmpdir(), 'claude-base-'));
 const cli = fileURLToPath(new URL('../testing/fake-claude-cli.ts', import.meta.url)); chmodSync(cli, 0o755);
 const dump = join(scratch, 'dump.json'); process.env.FAKE_CLAUDE_DUMP = dump;
 const instance = await ClaudeDriver.create({ instanceId: 'parity', displayName: 'Parity', enabled: true, environment: {}, config: { cli, permissionMode: 'acceptEdits' } });
 const recorder = recordEvents(instance.adapter);
 try {
  await instance.adapter.sendTurn({ threadId: 'parity-' + level, cwd: fixtureBotFolder(), text: 'fixture',
   askLevel: level === 'ask' ? true : undefined, routeAsks: level === 'ask' || level === 'auto' ? true : undefined, stopLine: level === 'full' || level === 'unlimited' ? true : undefined, noLimits: level === 'unlimited' ? true : undefined });
  await recorder.until(e => e.type === 'turn.completed');
  const { argv } = JSON.parse(readFileSync(dump, 'utf8'));
  const snapshot = normalizeStartup(argv, fixtureBotFolder());
  if (process.env.STARTUP_CAPTURE_DIR) writeFileSync(join(process.env.STARTUP_CAPTURE_DIR, `claude-${level}.json`), JSON.stringify(snapshot, null, 2));
  else expect(snapshot).toEqual(startupBase.claudeFull[level]);
 } finally { recorder.stop(); await instance.dispose(); delete process.env.FAKE_CLAUDE_DUMP; await removeTempDir(scratch); }
});

const startupBase = JSON.parse(readFileSync(new URL("./testing/startup-base.json", import.meta.url), "utf8"));
