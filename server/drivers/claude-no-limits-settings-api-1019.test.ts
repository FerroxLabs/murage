// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated control-murage server, actual Claude driver and broker, fake CLI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../../scripts/control-murage.ts';
import { raiseLevel } from '../testing/raise-level.ts';
import { openSse } from '../testing/sse.ts';
let fixture: VerificationServer;
let headers: Record<string, string>;
const commands: unknown[] = [];
const evidence = process.env.GNL_ENGINE_EVIDENCE;
function save(name: string, value: unknown) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
}
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  commands.push({ method, path, body, status: response.status, result });
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result;
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const { claudeSigninAnswers, claudeSigninScope } = await import(${JSON.stringify(new URL('./claude.ts', import.meta.url).href)});
    const root = path.join(process.env.MURAGE_DATA_DIR, 'fixture-repo');
    const project = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.writeFileSync(project, JSON.stringify({ apiKeyHelper: '/fixture/not-executed' }));
    claudeSigninAnswers.remember(claudeSigninScope(process.platform, [{ path: project, source: 'project' }]), false);
    const file = path.join(process.env.MURAGE_DATA_DIR, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.instances.verification.config.disallowedTools = ['Read', 'Bash'];
    fs.writeFileSync(file, JSON.stringify(config));
    process.env.FAKE_CLAUDE_PERM_TOOL = 'Bash';
    process.env.FAKE_CLAUDE_PERM_INPUT_FILE = path.join(root, 'permission-input.json');
  ` });
  save('fixture-launch.json', fixture.info);
  const proof = await (await fetch(fixture.info.url + '/api/desktop-secret')).json() as { secret: string };
  headers = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret };
  const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]);
  save('doctor.json', doctor);
  expect(doctor).toMatchObject({ ok: true });
}, 120000);
afterAll(async () => {
  try {
    save('commands.json', commands);
    if (fixture && evidence && existsSync(fixture.info.logPath)) writeFileSync(join(evidence, 'server.log'), readFileSync(fixture.info.logPath));
  } finally { await fixture?.close(); }
});
it('owner No limits bypasses saved sign-in/tool denials and runs Git inspection without cards', async () => {
  const cwd = join(fixture.info.dataDir, 'fixture-repo');
  const { bot } = await api('POST', '/api/bots', { name: 'Claude launch fixture', modelSelection: { instanceId: 'verification', model: 'sonnet' } });
  await api('PATCH', `/api/bots/${bot.id}`, { cwd, computer: 'off', browser: false, composio: false, autoReview: 'off' });
  await raiseLevel(async (method, path, body) => ({ status: 200, body: await api(method, path, body) }), bot.id,
    { autoApprove: true, fullAccess: true, noLimits: true, acknowledgeNoLimits: true, acknowledgeLocalAuto: true });
  for (const [index, command] of ['git push --mirror --dry-run', 'git push --mirror -n', 'git push --dry-run --force origin main', 'git push --mirror --help', 'git push --push-option --mirror origin topic'].entries()) {
    writeFileSync(join(cwd, 'permission-input.json'), JSON.stringify({ command, cwd }));
    const stream = await openSse(fixture.info.url + '/api/events', headers);
    try {
      await stream.until(frame => frame.kind === 'hello');
      await api('POST', `/api/bots/${bot.id}/messages`, { text: '__fixture_permission_tool__', threadId: bot.threadId });
      const waited = await runControlMurage(['wait', '--bot', bot.id, '--timeout', '10', '--url', fixture.info.url]);
      const transcript = await runControlMurage(['messages', '--bot', bot.id, '--limit', '60', '--url', fixture.info.url]);
      const messages = await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`);
      save(`turn-${index}.json`, { command, waited, transcript, messages, frames: stream.frames });
      expect(waited).toMatchObject({ status: 'settled' });
      expect(messages.messages.filter((message: any) => message.card?.requestId)).toEqual([]);
      expect(JSON.stringify(messages.messages)).toContain('permission: allowed');
      const launch = JSON.parse(readFileSync(fixture.fixtureDumpPath, 'utf8')) as { argv: string[] };
      save(`launch-${index}.json`, launch);
      const at = launch.argv.indexOf('--disallowedTools');
      const denied = at < 0 ? [] : launch.argv[at + 1]!.split(',');
      expect(denied).not.toContain('Read');
      expect(denied).not.toContain('Bash');
    } finally {
      stream.close();
      await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    }
  }
}, 120000);
