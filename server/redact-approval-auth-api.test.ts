// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { approvalDigest } from '../shared/approval-digest.ts';
import { proofMessage } from './approval-fresh-auth.ts';

const target = existsSync('/work/docs/verification/README.md') ? '/work/docs/verification/README.md' : resolve('docs/verification/README.md');
let fixture: VerificationServer, desktop: Record<string, string>;
const evidence: unknown[] = [];
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
const phone = { 'x-murage-companion': '1', 'x-murage-companion-token': 'c'.repeat(64),
  'x-murage-approval-device': randomUUID(), 'x-murage-approval-class': 'app', 'x-murage-approval-key': point };
async function api(method: string, path: string, body?: unknown, headers = desktop) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = { status: response.status, body: await response.json() as any };
  if (!path.includes("secret")) evidence.push({ method, path, result });
  return result;
}
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.FAKE_CLAUDE_PERM_TOOL='Bash';
    // The fake reports the decision and never executes the command.
    process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({command: ${JSON.stringify('rm -f ')} + ${JSON.stringify(target)}});
  ` });
  desktop = { 'x-murage-surface': 'desktop', 'x-murage-surface-secret': (await api('GET', '/api/desktop-secret', undefined, {})).body.secret };
}, 120_000);
afterAll(async () => {
  if (fixture) {
    const out = resolve(process.env.SC_MAIL_EVIDENCE_DIR ?? 'evidence/sc-mail-r2/approval-auth');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'workflow.json'), JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    writeFileSync(join(out, 'server.log'), readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});

it.each([false, true])('opaque Allow with task=%s signs the displayed identity and reaches the original engine exactly once', async task => {
  const model = (await api('GET', '/api/instances')).body.instances.find((row: any) => row.instanceId === 'verification').models.options[0].id;
  const bot = (await api('POST', '/api/bots', { name: 'Opaque phone approval', modelSelection: { instanceId: 'verification', model } })).body.bot;
  await api('PATCH', `/api/bots/${bot.id}`, { computer: 'off', browser: false, composio: false, autoApprove: false, fullAccess: false, autoReview: 'off' });
  let message: any;
  try {
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: '__fixture_permission_tool__' })).status).toBe(202);
    await expect.poll(async () => {
      message = (await api('GET', `/api/threads/${bot.threadId}/messages`)).body.messages.find((row: any) => row.card?.requestHandle && !row.card.answered);
      return !!message;
    }, { timeout: 15_000 }).toBe(true);
    const requestHandle = `p.${message.id}`;
    expect(message.card.requestHandle).toBe(requestHandle);
    expect(message.card.requestId).toBeUndefined();
    if (task) expect(message.card.taskAllowKey, "the fixture must actually offer a task scope").toBeTruthy();
    const path = `/api/threads/${bot.threadId}/respond`;
    const submission = { requestHandle, action: 'allow', ...(task ? { allowForTask: true } : {}) };
    const first = await api('POST', path, submission, phone);
    expect(first).toMatchObject({ status: 403, body: { code: 'fresh_auth' } });
    const challenge = first.body.challenge;
    expect(challenge.decision).toBe(task ? 'allow-task' : 'allow');
    expect(challenge.digest).toBe(await approvalDigest(bot.threadId, requestHandle, message.card));
    const signature = sign('sha256', Buffer.from(proofMessage({ threadId: bot.threadId, requestId: requestHandle, ...challenge })), { key: privateKey, dsaEncoding: 'der' }).toString('base64url');
    const signed = { ...submission, freshAuth: { nonce: challenge.nonce, signature } };
    expect(await api('POST', path, signed, phone)).toMatchObject({ status: 200, body: { outcome: 'allowed-once' } });
    expect((await api('POST', path, signed, phone)).status).toBe(409);
    await expect.poll(async () => (await api('GET', `/api/threads/${bot.threadId}/messages`)).body.messages.filter((row: any) => row.text === 'permission: allowed').length,
      { timeout: 15_000 }).toBe(1);
  } finally { await api('POST', `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}, 45_000);
