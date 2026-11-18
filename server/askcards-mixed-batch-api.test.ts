// Mixed connector requests must carry their strictest stop through production
// card construction and both Cloud-home respond routes. The fake CLI requests
// permission only: no connector call, email, deletion or payment is executed.
import { fixtureDisplayApi } from "./testing/display-fixture.ts";
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { CloudSessions } from './cloud-sessions.ts';

const origin = 'https://home.example.test';
let fixture: VerificationServer, db: DatabaseSync;
const credentials: Record<string, Record<string, string>> = {};
const evidence: unknown[] = [];
const displayApi = fixtureDisplayApi(() => join(fixture.info.dataDir, "messages.db"), (method: string, path: string, body?: unknown, ...extra: unknown[]) => {
  if (typeof extra[0] !== 'string') throw new Error('fixture caller missing');
  return rawFixtureApi(extra[0], method, path, body);
});
const api = (who: string, method: string, path: string, body?: unknown) => displayApi(method, path, body, who);
async function rawFixtureApi(who: string, method: string, path: string, body?: unknown) {
  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, { method, headers: {
      host: 'home.example.test', origin, 'content-type': 'application/json', ...credentials[who],
      ...(encoded ? { 'content-length': String(Buffer.byteLength(encoded)) } : {}),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(encoded);
  });
  evidence.push({ who, method, path, body, result });
  return result;
}

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    cloud: { publicOrigin: origin, bootstrapSecret: 'fixture-mixed-batch-bootstrap-32-characters' },
    instrumentationSource: `
      process.env.NODE_ENV = "test";
      globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true;
      import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
      import { registerHooks } from 'node:module';
      const control = await import(${JSON.stringify(new URL('./cloud-home/control-state-verification.fixture.mjs', import.meta.url).href)});
      control.installVerificationControl(${JSON.stringify(origin)});
      // The engine transport runs the repository CLI locally in this isolated
      // fixture, rather than invoking the Cloud image's privileged launcher.
      // index.ts, the approval builder, identity and answer gates stay intact.
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/server/composio.ts')) return { format: 'module', shortCircuit: true, source:
          'export * from ' + JSON.stringify(url + '?fixture-original') + ';' +
          'export const turnConnectedAppsReady = async () => true;' +
          'export const mcpIntegration = async () => ({command:process.execPath,args:[${JSON.stringify(fileURLToPath(new URL("./testing/inert-mcp-server.mjs", import.meta.url)))}],env:{}});'
        };
        const loaded = next(url, context);
        if (!['/drivers/claude.ts', '/drivers/cli-mount-relay.ts', '/cloud-home/turn-process.ts', '/server/procs.ts'].some(path => url.endsWith(path))) return loaded;
        return { ...loaded, source: String(loaded.source).replaceAll('process.env.MURAGE_CLOUD_ROLE', '"fixture"') };
      } });
      process.env.FAKE_CLAUDE_PERM_TOOL = 'mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL';
      process.env.FAKE_CLAUDE_PERM_INPUT_FILE = join(process.env.MURAGE_DATA_DIR, 'mixed-batch-input.json');
    `,
  });
  db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const sessions = new CloudSessions(db, undefined, origin);
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const pem = key.export({ type: 'spki', format: 'pem' }).toString();
  for (const scope of ['owner-desktop', 'browser'] as const) {
    const id = randomUUID(), now = Date.now();
    db.prepare('INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)')
      .run(id, 'fixture-owner', scope, pem, pem, now, now);
    if (scope === 'browser') {
      const keyHash = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
      db.prepare('INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)')
        .run(id, JSON.stringify({ kind: 'remembered-owner', keyHash, proof: 'email', stepUpAt: now, ticketNonce: 'fixture-nonce' }),
          'remembered-owner', now, now + 86400000, keyHash, now);
    }
    const { accessToken } = sessions.issue(id);
    credentials[scope] = scope === 'browser' ? { cookie: `__Host-murage=${accessToken}` } : { authorization: `Bearer ${accessToken}` };
    expect(sessions.device(id)?.factor).toBe(scope === 'browser' ? 'remembered-owner' : false);
  }
}, 120000);

afterAll(async () => {
  if (fixture && process.env.ASK_MIXED_EVIDENCE) {
    const dir = process.env.ASK_MIXED_EVIDENCE;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ info: fixture.info, evidence }, null, 2));
    writeFileSync(join(dir, 'server.log'), readFileSync(fixture.info.logPath));
  }
  db?.close();
  await fixture?.close();
});

const message = { tool_slug: 'GMAIL_SEND_EMAIL', account: 'fixture-account', arguments: { recipient_email: 'new@example.invalid', subject: 'Fixture', body: 'Fixture only' } };
const rows = {
  pay: { tool_slug: 'STRIPE_CREATE_PAYMENT_INTENT', account: 'fixture-account', arguments: { customer: 'cus_fixture', amount: 100, currency: 'usd' } },
  delete: { tool_slug: 'GMAIL_DELETE_MESSAGE', account: 'fixture-account', arguments: { message_id: 'fixture-message' } },
};
async function open(second?: keyof typeof rows) {
  writeFileSync(join(fixture.info.dataDir, 'mixed-batch-input.json'), JSON.stringify({ tools: [message, ...(second ? [rows[second]] : [])], sync_response_to_workbench: false }));
  const created = await api('owner-desktop', 'POST', '/api/bots', { modelSelection: { instanceId: 'verification', model: 'claude-sonnet-5' } });
  expect(created.status).toBe(201);
  const bot = created.body.bot;
  const patched = await api('owner-desktop', 'PATCH', `/api/bots/${bot.id}`, { autoApprove: false, fullAccess: false, computer: 'off', browser: false, composio: true, autoReview: 'off' });
  expect(patched.status).toBe(200);
  const started = await api('owner-desktop', 'POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_permission_tool__ request fixture permission' });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  let card: any;
  await expect.poll(async () => {
    const messages = await api('owner-desktop', 'GET', `/api/threads/${bot.threadId}/messages?limit=100`);
    card = messages.body.messages?.find((m: any) => m.card?.requestId && !m.card.answered)?.card;
    return !!card;
  }, { timeout: 20000 }).toBe(true);
  evidence.push({ bot, card, second });
  return { bot, card };
}

for (const route of ['thread', 'bot']) {
  const respondPath = (bot: any) => route === 'thread' ? `/api/threads/${bot.threadId}/respond` : `/api/bots/${bot.id}/respond`;
  for (const second of ['pay', 'delete'] as const) {
    it(`${route}: message then ${second} requires a fresh code and leaves the native request pending`, async () => {
      const { bot, card } = await open(second);
      try {
        const body = { threadId: bot.threadId, requestId: card.requestId, behavior: 'allow' };
        const refused = await api('browser', 'POST', respondPath(bot), body);
        expect(refused).toMatchObject({ status: 403, body: { code: 'email_code', label: 'allow_request' } });
        expect(card.riskReason).toBe(second);
        const pending = await api('owner-desktop', 'GET', `/api/threads/${bot.threadId}/open-cards`);
        expect(pending.body.openCards.some((c: any) => (c.requestId ?? c.card?.requestId) === card.requestId)).toBe(true);
        const events = readFileSync(join(fixture.info.dataDir, 'events', bot.threadId + '.ndjson'), 'utf8');
        expect(events).not.toContain('"type":"request.resolved"');
        expect((await api('browser', 'POST', respondPath(bot), { ...body, behavior: 'deny' })).status).toBe(200);
      } finally { await api('owner-desktop', 'POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
    }, 45000);
  }
  it(`${route}: message-only Allow remains available to the owner browser`, async () => {
    const { bot, card } = await open();
    try {
      expect(card.riskReason).toBe('message');
      expect((await api('browser', 'POST', respondPath(bot), { threadId: bot.threadId, requestId: card.requestId, behavior: 'allow' })).status).toBe(200);
    } finally { await api('owner-desktop', 'POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
  }, 45000);
  it(`${route}: the desktop can still allow a mixed batch`, async () => {
    const { bot, card } = await open('pay');
    try {
      expect((await api('owner-desktop', 'POST', respondPath(bot), { threadId: bot.threadId, requestId: card.requestId, behavior: 'allow' })).status).toBe(200);
    } finally { await api('owner-desktop', 'POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
  }, 45000);
}
