// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HighLevelClient } from './client.ts';
import { HeldRequest } from './held-request.ts';
import { operationSpec } from './operations/registry.ts';
import * as privatePassword from './users-create-password.ts';
import { usersCreateRecipientVerified } from './users-create-policy.ts';
import { validHighLevelPassword } from '../../shared/highlevel-password.ts';
import { HighLevelLeakGuardV2 } from '../testing/highlevel-leak-guard-v2.ts';
import { highLevelHarness, FAKE_LOCATION_ID, FAKE_COMPANY_ID } from '../testing/fake-highlevel.ts';
beforeEach(() => vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'true'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const reviewed = { companyId: FAKE_COMPANY_ID, email: 'private@fixture.test', firstName: 'Private', lastName: 'Fixture',
  type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] };
it('recipient flag is strictly opt in, including a missing value', () => {
  for (const value of [undefined, '', 'false', '1', 'TRUE']) {
    const env = value === undefined ? {} : { HL_USERSCREATE_RECIPIENT_VERIFIED: value };
    expect(usersCreateRecipientVerified(env)).toBe(false);
  }
  expect(usersCreateRecipientVerified({ HL_USERSCREATE_RECIPIENT_VERIFIED: 'true' })).toBe(true);
});
it('private OS generator returns policy-valid 32 byte buffers and supports caller clearing', () => {
  for (let i = 0; i < 128; i++) {
    const bytes = privatePassword.generatePrivateUserPassword();
    try { expect(bytes.length === 32 && validHighLevelPassword(bytes.toString('ascii'))).toBe(true); }
    finally { bytes.fill(0); }
  }
});
it.each(['success', 'echo', 'refusal', 'redirect', 'timeout', 'disconnect', 'stop-after-send'] as const)(
  'one bounded TLS call and finally clears owned password and request buffers: %s', async mode => {
    const h = highLevelHarness();
    const secret = `Aa4!${randomBytes(20).toString('hex')}`;
    const owned = Buffer.from(secret), guard = new HighLevelLeakGuardV2([secret]);
    const generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockReturnValue(owned);
    let wire: Uint8Array | undefined, calls = 0, barrier = false;
    const client = new HighLevelClient({ leases: h.leases, deadlineMs: 50, fetch: (async (input, init) => {
      calls++; wire = init!.body as Uint8Array;
      expect(barrier && generate.mock.calls.length === 1).toBe(true);
      const url = new URL(String(input));
      expect(url.origin).toBe('https://services.leadconnectorhq.com'); expect(url.pathname).toBe('/users/');
      expect(init!.redirect).toBe('manual'); expect(init!.signal).toBeDefined();
      const body = JSON.parse(Buffer.from(wire).toString('utf8'));
      expect(body.password === secret).toBe(true);
      if (mode === 'timeout') return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('fixed timeout')), { once: true });
      });
      if (mode === 'disconnect') throw new Error('fixed disconnect');
      if (mode === 'stop-after-send') h.stop();
      return new Response(JSON.stringify(mode === 'echo' ? { user: { id: secret, ...reviewed } }
        : mode === 'refusal' ? { message: secret } : { user: { id: 'user_private', ...reviewed } }),
      { status: mode === 'refusal' ? 400 : mode === 'redirect' ? 302 : 201 });
    }) as typeof fetch });
    const held = HeldRequest.freeze(operationSpec('users.create')!, { path: '/users/', resource: `location:${FAKE_LOCATION_ID}`,
      body: { kind: 'json', value: reviewed } }, { locationId: FAKE_LOCATION_ID, companyId: FAKE_COMPANY_ID });
    const ctx = { connection: h.leases.views.get('hl_conn_1')!, signal: h.signals.signalFor(h.claim), assertActive() {},
      onDispatch: async () => { expect(generate).not.toHaveBeenCalled(); barrier = true; } };
    try {
      const result = await client.sendHeldWithPrivatePassword(ctx, held, held.frozen.requestDigest).catch(error => error);
      // Boolean assertions never print a synthetic secret, even in intentional mutants.
      expect(guard.wrapSink('tool_context', (value: unknown) => value)(result) !== undefined).toBe(true);
      expect(JSON.stringify(result).includes(secret) || String(result).includes(secret)).toBe(false);
      expect(mode === 'success' || mode === 'stop-after-send' ? !(result instanceof Error) : result instanceof Error).toBe(true);
      expect(calls).toBe(1); expect(generate).toHaveBeenCalledTimes(1);
      expect(owned.every(byte => byte === 0)).toBe(true);
      expect(wire !== undefined && wire.every(byte => byte === 0)).toBe(true);
      await expect(client.sendHeldWithPrivatePassword(ctx, held, held.frozen.requestDigest)).rejects.toThrow();
      expect(calls).toBe(1);
    } finally { owned.fill(0); h.stop(); }
  });
it('cancelled admission never allocates a credential', async () => {
  const h = highLevelHarness(), generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
  const held = HeldRequest.freeze(operationSpec('users.create')!, { path: '/users/', resource: `location:${FAKE_LOCATION_ID}`,
    body: { kind: 'json', value: reviewed } }, { locationId: FAKE_LOCATION_ID, companyId: FAKE_COMPANY_ID });
  h.stop();
  try {
    await expect(h.client.sendHeldWithPrivatePassword({ connection: h.leases.views.get('hl_conn_1')!, signal: h.signals.signalFor(h.claim),
      assertActive() {}, onDispatch: async () => {} }, held, held.frozen.requestDigest)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled(); expect(h.api.requests).toHaveLength(0);
  } finally { h.stop(); }
});
