import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBindings } from './bindings.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';

// Retain the original three test declarations (four cases), including both
// negative proofs. Only their fixtures moved from prepareAppDenial to the
// stopped-server seed/restart/review lifecycle; their expectations still apply.
// Bind the current stopped-server seed/restart/review lifecycle to a real
// temporary bots file. The independent connector log contains actual fixture
// calls, so a generic MCP receipt or a missing effect cannot prove execution.
function fixture(root, { generic = false, effect = true } = {}) {
  const botFile = join(root, 'bots.json'), actions = join(root, 's3-state', 'app-actions.ndjson');
  mkdirSync(join(root, 's3-state'));
  writeFileSync(botFile, JSON.stringify([{ id: 'fixture', connectedAppAccess: { revision: 1, denials: [], grants: [] } }]));
  const read = () => JSON.parse(readFileSync(botFile, 'utf8'))[0];
  const captured = () => existsSync(actions) ? readFileSync(actions, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let prepared;
  const c = {
    messages: async () => [],
    api: async (method) => {
      const bot = read();
      if (method === 'PUT') {
        const source = bot.connectedAppAccess.grants.length ? 'grant-revoked' : 'request-denied';
        bot.connectedAppAccess = { ...bot.connectedAppAccess, mode: 'restricted', grants: [], denials: [{ id: 'saved-denial', source, toolkit: 'gmail', accountId: 'fixture-account', tools: ['GMAIL_SEND_EMAIL'] }] };
        writeFileSync(botFile, JSON.stringify([bot]));
      }
      return { enabled: true, policy: bot.connectedAppAccess };
    },
    turn: async (_bot, text) => {
      const request = JSON.parse(Buffer.from(text.split(':')[1], 'base64url'));
      if (effect) appendFileSync(actions, JSON.stringify({ id: request.id, ruleId: request.ruleId, executed: true, tool: generic ? 'write' : 'GMAIL_SEND_EMAIL', input: generic ? { text: 'fixture' } : { accountId: 'fixture-account', to: 'fixture@example.test', body: 'inert fixture' } }) + '\n');
      return { cards: [], messages: [], events: [{ type: 'item.started', itemType: 'tool', itemId: 'app', toolIdentity: { name: generic ? 'mcp__fixture__write' : 'mcp__fixture__connected_app_write' }, input: generic ? { text: 'fixture' } : { toolkit: 'gmail', tool_slug: 'GMAIL_SEND_EMAIL', accountId: 'fixture-account', text: 'fixture' } }, { type: 'item.completed', itemType: 'tool', itemId: 'app', ok: true }], request };
    },
  };
  const f = { data: root, restart: async seed => { seed(root); const policy = read().connectedAppAccess; prepared = policy.grants.length ? 'grant-revoked' : policy.denials[0]?.source; } };
  return { c, bindings: installBindings(f), prepared: () => prepared, read, captured };
}
for (const [id, source] of [['deny-app-denied', 'request-denied'], ['deny-app-revoked', 'grant-revoked']])
test(`${id} binds a real persisted denial fixture and observes its inert app effect`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gnl-app-binding-')), f = fixture(root);
  try {
    const result = await f.bindings[id]({ client: f.c, bot: { id: 'fixture', threadId: 'thread' }, spec: { id }, cwd: root });
    assert.equal(f.prepared(), source); assert.equal(result.proof, true); assert.equal(result.witness.source, source);
    assert.equal(result.permissionRuleWitness.ruleInstalled, true); assert.equal(result.permissionRuleWitness.actionExecuted, true);
    assert.equal(f.read().connectedAppAccess.denials[0].source, source);
    assert.equal(f.read().connectedAppAccess.denials[0].id, result.witness.ruleId);
    assert.equal(result.permissionRuleWitness.source, id);
    // MAIN RULING 2026-11-13 wipe-only: saved app denials cannot card at No limits.
    assert.equal(result.obs.cards.length, 0);
    assert.deepEqual(f.captured(), [{ id, ruleId: result.witness.ruleId, executed: true, tool: 'GMAIL_SEND_EMAIL', input: { accountId: 'fixture-account', to: 'fixture@example.test', body: 'inert fixture' } }]);
  } finally { safeWipeSync(root); }
});
test('a generic MCP effect cannot prove a connected-app denial target was exercised', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gnl-app-wrong-target-')), f = fixture(root, { generic: true });
  try {
    const result = await f.bindings['deny-app-denied']({ client: f.c, bot: { id: 'fixture', threadId: 'thread' }, spec: { id: 'deny-app-denied' } });
    assert.equal(result.proof, false);
    assert.equal(result.permissionRuleWitness.ruleInstalled, true);
    assert.equal(result.permissionRuleWitness.actionExecuted, false);
    assert.equal(f.read().connectedAppAccess.denials[0].id, result.witness.ruleId);
    assert.equal(result.obs.events[0].toolIdentity.name, 'mcp__fixture__write');
    assert.equal(result.obs.events[1].ok, true);
    assert.deepEqual(f.captured(), [{ id: 'deny-app-denied', ruleId: result.witness.ruleId, executed: true, tool: 'write', input: { text: 'fixture' } }]);
  } finally { safeWipeSync(root); }
});
test('an app tool receipt without its independently captured effect cannot prove execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gnl-app-no-effect-')), f = fixture(root, { effect: false });
  try {
    const result = await f.bindings['deny-app-denied']({ client: f.c, bot: { id: 'fixture', threadId: 'thread' }, spec: { id: 'deny-app-denied' } });
    assert.equal(result.proof, false);
    assert.equal(result.permissionRuleWitness.ruleInstalled, true);
    assert.equal(result.permissionRuleWitness.actionExecuted, false);
    assert.equal(f.read().connectedAppAccess.denials[0].id, result.witness.ruleId);
    assert.equal(result.obs.events[0].toolIdentity.name, 'mcp__fixture__connected_app_write');
    assert.equal(result.obs.events[1].ok, true);
    assert.deepEqual(f.captured(), []);
  } finally { safeWipeSync(root); }
});
