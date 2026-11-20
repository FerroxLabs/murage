// SPDX-License-Identifier: AGPL-3.0-or-later
// Review blockers through authenticated tools, with only a fake engine and connection source.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnBoundProxy } from './testing/bound-proxy-fixture.ts';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { waitForExit } from './testing/cleanup.ts';
import { FAKE_FLUX_BROKER_INSTRUMENTATION } from './testing/fake-flux-broker.ts';

let fixture: VerificationServer;
let desktop: Record<string, string> = {};
const evidence: unknown[] = [];
async function api(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...desktop, ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = { status: response.status, body: await response.json() as any };
  // Tokens and fake turn dumps never enter evidence.
  evidence.push({ method, path, ...result });
  return result;
}
const messages = async (id: string) => (await api('GET', `/api/threads/${id}/messages?limit=200`)).body.messages as any[];
const entry = (name: string) => JSON.parse(readFileSync(join(fixture.info.dataDir, 'config.json'), 'utf8')).mcpServers[name];
async function withTurn(level: 'ask' | 'auto' | 'full' | 'unlimited', run: (bot: any, env: Record<string, string>, existing: Set<string>) => Promise<void>) {
  const instances = (await api('GET', '/api/instances')).body.instances;
  const model = instances.find((x: any) => x.instanceId === 'verification').models.options[0].id;
  const made = await api('POST', '/api/bots', { name: 'Review ' + level, modelSelection: { instanceId: 'verification', model } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  expect((await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: true, autoReview: 'off' })).status).toBe(200);
  if (level === 'unlimited' || level === 'full') expect((await raiseLevel(api, bot.id, { fullAccess: true, noLimits: level === 'unlimited', acknowledgeNoLimits: true, acknowledgeFullAccess: true })).status).toBe(200);
  else {
    const flags = { autoApprove: level === 'auto', fullAccess: false, noLimits: false };
    expect((await api('PATCH', `/api/bots/${bot.id}`, { settingsScope: 'defaults', ...flags })).status).toBe(200);
    expect((await api('PATCH', `/api/bots/${bot.id}/tasks/${bot.threadId}`, flags)).status).toBe(200);
  }
  // New bots already carry an intake card before this turn. Track it by id;
  // every card the turn or these requests add must still be detected.
  const existing = new Set<string>((await messages(bot.threadId)).map(m => m.id));
  expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_hold_authority__ review-' + bot.id })).status).toBe(202);
  let env: Record<string, string> = {};
  try {
    await expect.poll(() => {
      try {
        const line = readFileSync(fixture.fixtureDumpLogPath, 'utf8').split('\n').find(line => line.includes('review-' + bot.id));
        if (!line) return false;
        const servers = withTurnSecrets(JSON.parse(line)).mcpConfig.mcpServers;
        env = { ...servers.agents.env, MURAGE_CONNECTORS_TOKEN: servers.murage_connectors?.env.MURAGE_CONNECTORS_TOKEN };
        return Boolean(env.MURAGE_COMMS_TOKEN);
      } catch { return false; }
    }, { timeout: 30000 }).toBe(true);
    await run(bot, env, existing);
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}
async function tool(env: Record<string, string>, name: string, args: unknown) {
  const child = await spawnBoundProxy('agents', process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./drivers/agents-proxy.ts', import.meta.url))], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('agents proxy timeout: ' + errors)), 20000);
      lines.on('line', line => { const value = JSON.parse(line); if (value.id === 91) resolve(value); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const reply = await response;
    evidence.push({ tool: name, reply });
    return reply.result;
  } finally { clearTimeout(timer); lines.close(); await waitForExit(child, { signal: 'SIGTERM' }); }
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { dumpLog: true, instrumentationSource: FAKE_FLUX_BROKER_INSTRUMENTATION + `
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
  ` });
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret')).body.secret };
  // This suite exercises app review and credentials; cold recall has separate gates.
  expect((await api('POST', '/api/memory/action', { action: 'configure', mode: 'off' })).status).toBe(200);
  evidence.length = 0;
}, 90000);
afterAll(async () => {
  const destination = process.env.GNL_REVIEW_EVIDENCE_DIR ? join(process.env.GNL_REVIEW_EVIDENCE_DIR, String(process.pid)) : undefined;
  if (destination) {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'workflow.json'), JSON.stringify({ fixture: fixture?.info, evidence }, null, 2));
    if (fixture) copyFileSync(fixture.info.logPath, join(destination, 'server.log'));
  }
  await fixture?.close();
});
// 1.0.20 hlstrip: Murage's own HighLevel (and its grant route) is removed; the No limits plain line stays for any app request.
it('REVIEW-H1 No limits connector requests answer a plain line without cards', async () => {
  await withTurn('unlimited', async (bot, env, existing) => {
    for (const items of [[{ slug: 'gmail' }], [{ slug: 'gmail' }, { slug: 'slack' }]]) {
      const reply = await api('POST', '/api/internal/connectors/request', { botId: bot.id, threadId: bot.threadId, items }, env.MURAGE_CONNECTORS_TOKEN);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body).toMatchObject({ pending: false, messageIds: [], message: `${items.map(item => item.slug).join(', ')} is disconnected; turn it on in App Settings → Connections → Connected apps.` });
    }
    expect((await messages(bot.threadId)).filter(m => !existing.has(m.id) && (m.card || m.secret || m.connector))).toHaveLength(0);
  });
});
it('REVIEW-H2 No limits MCP add returns a plain unavailable line with no setup cards', async () => {
  await withTurn('unlimited', async (bot, env, existing) => {
    const reply = await tool(env, 'add_mcp_server', { name: 'review-notes', command: 'node', env_keys: ['NOTES_TOKEN'] });
    expect(reply).toEqual({ content: [{ type: 'text', text: 'review-notes is off; turn it on and set its keys in App Settings → Connections → Your MCP servers.' }], isError: false });
    const stored = entry('review-notes');
    expect(stored).toMatchObject({ enabled: false, pendingEnv: ['NOTES_TOKEN'] });
    expect((await messages(bot.threadId)).filter(m => !existing.has(m.id) && (m.card || m.secret || m.connector))).toHaveLength(0);
  });
});
it('REVIEW-H2 No limits missing MCP credential returns a plain unavailable line without an owner wait', async () => {
  await withTurn('ask', async (_bot, env) => {
    expect((await tool(env, 'add_mcp_server', { name: 'review-key', command: 'node', env_keys: ['NOTES_TOKEN'] })).content[0].text).toBe('Saved review-key switched off');
  });
  await withTurn('unlimited', async (bot, env, existing) => {
    const stored = entry('review-key');
    const requested = await tool(env, 'request_credential', { credential_id: `mcp:review-key:NOTES_TOKEN:${stored.rev}` });
    expect(requested).toEqual({ content: [{ type: 'text', text: 'review-key is unavailable because its key is missing; set its keys and turn it on in App Settings → Connections → Your MCP servers.' }], isError: false });
    expect((await messages(bot.threadId)).filter(m => !existing.has(m.id) && (m.card || m.secret || m.connector))).toHaveLength(0);
  });
});
for (const level of ['ask', 'auto', 'full'] as const) it(`REVIEW lower ${level} preserves MCP setup cards and wait`, async () => {
  await withTurn(level, async (bot, env) => {
    const name = 'review-' + level;
    expect((await tool(env, 'add_mcp_server', { name, command: 'node', env_keys: ['NOTES_TOKEN'] })).content[0].text).toBe(`Saved ${name} switched off`);
    const stored = entry(name);
    const reply = await tool(env, 'request_credential', { credential_id: `mcp:${name}:NOTES_TOKEN:${stored.rev}` });
    expect(reply.content[0].text).toContain('End this turn; Murage will resume the task after they save or decline.');
    const rows = await messages(bot.threadId);
    expect(rows.some(m => m.card?.kind === 'mcpEnable')).toBe(true);
    expect(rows.some(m => m.secret?.target === `mcp:${name}:NOTES_TOKEN:${stored.rev}`)).toBe(true);
  });
});
