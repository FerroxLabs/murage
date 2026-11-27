// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const results: unknown[] = [];
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method,
    headers: { ...desktop, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const { registerHooks, syncBuiltinESMExports } = await import('node:module');
    const { default: cp } = await import('node:child_process');
    const mark = name => fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, name), '');
    registerHooks({ load(url, context, next) {
      if (/\\/host\\/(hosted-forwarder|host-main|host-launch)\\.ts$/.test(url)) mark('loaded-fuigo-host');
      return next(url, context);
    } });
    for (const name of ['spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      const original = cp[name];
      cp[name] = function (...args) {
        if (args.slice(0, 2).flat().some(arg => typeof arg === 'string' && /host-main\\.[tj]s(?:$|["'\\s])/.test(arg))) mark('spawned-fuigo-host');
        return original.apply(this, args);
      };
    }
    syncBuiltinESMExports();
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cli = path.join(process.cwd(), 'server/testing/fake-acp-cli.ts');
    fs.chmodSync(cli, 0o755);
    fs.mkdirSync(path.join(process.env.HOME, '.fuigo'), { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME, '.fuigo', 'auth.json'), '{}');
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'owner-trust-path.txt'), path.join(process.env.HOME, '.fuigo', 'trusted_folders.toml'));
    config.instances.processReply = { driver: 'fuigoAgent', displayName: 'Fuigo fixture', config: { cli, fullAuto: false },
      environment: { FAKE_ACP_MODE: 'folder-trust', FAKE_ACP_TRUST_V: '2', FAKE_ACP_VERSION: '1.0.40',
        FAKE_ACP_MCP_READY: '1', FAKE_ACP_TRUST_DELAY_MS: '300',
        FAKE_ACP_PARENT_LOG: path.join(process.env.MURAGE_DATA_DIR, 'fuigo-parent'),
        FAKE_ACP_TRUST_LOG: path.join(process.env.MURAGE_DATA_DIR, 'process-trust.jsonl'),
        FAKE_ACP_DUMP: path.join(process.env.MURAGE_DATA_DIR, 'process-dump.json') } };
    fs.writeFileSync(file, JSON.stringify(config));
  ` });
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret')).body.secret };
}, 120_000);
afterAll(async () => {
  if (!fixture) return;
  const captures: Record<string, unknown> = {};
  const rawLog = fixture.info.logPath;
  if (existsSync(rawLog)) captures.serverLog = readFileSync(rawLog, 'utf8');
  for (const name of ['process-trust.jsonl', 'process-dump.json']) {
    const file = join(fixture.info.dataDir, name);
    if (!existsSync(file)) continue;
    captures[name] = name.endsWith('jsonl') ? readFileSync(file, 'utf8') : (({ argv, folderTrust }) => ({ argv, folderTrust }))(JSON.parse(readFileSync(file, 'utf8')));
  }
  const state = await api('GET', '/api/bots').catch(() => null);
  results.push({ finalBots: state?.body.bots?.map((bot: any) => ({ id: bot.id, busy: bot.busy, messages: bot.messages })) });
  console.info('Fuigo process verification', JSON.stringify({ fixture: fixture.info, results, captures }));
  await fixture.close();
});
it('an owner-picked folder reaches the process reply through the real server admission and loads its instructions', async () => {
  const made = await api('POST', '/api/bots', { name: 'Process reply fixture', modelSelection: { instanceId: 'processReply', model: 'fake-acp-model' } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoReview: 'off' })).status).toBe(200);
  const cwd = join(fixture.info.dataDir, 'picked-process-folder');
  mkdirSync(cwd); writeFileSync(join(cwd, 'AGENTS.md'), '# Fixture\nprocess-reply-canary\n');
  expect((await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, { cwd })).status).toBe(200);
  expect((await raiseLevel(api, bot.id, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
  const recordPath = `/api/folder-trust?bot=${bot.id}&thread=${bot.threadId}`;
  const before = (await api('GET', recordPath)).body.record;
  expect(before).toMatchObject({ decision: 'trust', source: 'picker' });
  const ownerStore = readFileSync(join(fixture.info.dataDir, 'owner-trust-path.txt'), 'utf8');
  const nativeBefore = existsSync(ownerStore) ? readFileSync(ownerStore, 'utf8') : null;
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Read the fixture instructions' })).status).toBe(202);
  let messages: any[] = [];
  await expect.poll(async () => {
    messages = (await api('GET', `/api/threads/${bot.threadId}/messages?limit=200`)).body.messages;
    return messages.some(message => message.role === 'bot' && String(message.text ?? '').includes('process-reply-canary'));
  }, { timeout: 30_000 }).toBe(true);
  expect(messages.filter(message => message.card?.folderTrust)).toHaveLength(0);
  const trace = readFileSync(join(fixture.info.dataDir, 'process-trust.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const reply = trace.find(row => row.event === 'reply');
  expect(JSON.parse(reply.raw).result).toEqual({ outcome: 'trust', scope: 'configAndCommands', duration: 'process' });
  const order = trace.filter(row => row.event === 'reply' || row.event === 'prompt').map(row => row.event);
  expect(order).toEqual(['reply', 'prompt']);
  const dump = JSON.parse(readFileSync(join(fixture.info.dataDir, 'process-dump.json'), 'utf8'));
  expect(dump.argv).not.toContain('--trust');
  expect((await api('GET', recordPath)).body.record).toEqual(before);
  expect(existsSync(ownerStore) ? readFileSync(ownerStore, 'utf8') : null).toBe(nativeBefore);
  // T-S1A-COORD-BOOT includes a real turn, with the gate and module observer active for both boot and dispatch.
  const reason = process.platform === 'win32' ? 'dump_policy_unavailable' : 'hosted_unqualified';
  const mode = readFileSync(fixture.info.logPath, 'utf8').split(/\r?\n/).find(line => line.startsWith('[fuigo-mode]'));
  expect(mode).toBe(`[fuigo-mode] mode=COORDINATOR reason=${reason} driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=0`);
  for (const name of ['spawned-fuigo-host', 'loaded-fuigo-host', 'hosted-custody.jsonl']) {
    expect(existsSync(join(fixture.info.dataDir, name)), name).toBe(false);
  }
  const parents = new Set(readFileSync(join(fixture.info.dataDir, 'fuigo-parent'), 'utf8').trim().split('\n').map(Number));
  if (process.platform === 'win32') {
    expect([...parents].every(pid => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
    expect(parents.has(fixture.info.pid)).toBe(false);
  } else {
    expect(parents).toEqual(new Set([fixture.info.pid]));
  }
  results.push({ action: 'send to owner-picked No limits folder', status: 202, instructionRead: true,
    result: JSON.parse(reply.raw).result, order, durableLaunchFlag: dump.argv.includes('--trust'),
    pickerRecordUnchanged: true, nativeStoreUnchanged: true });
}, 60_000);
