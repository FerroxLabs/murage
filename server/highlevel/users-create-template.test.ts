// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { operationSpec } from './operations/registry.ts';
import { schemas } from './operations/schemas/users.ts';
import { HeldRequest } from './held-request.ts';
import { HighLevelActions, MemoryActionJournal } from './actions.ts';
import * as privatePassword from './users-create-password.ts';
import { afterEach, beforeEach } from 'vitest';
beforeEach(() => vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'true'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
import { highLevelHarness } from '../testing/fake-highlevel.ts';
import { prepareReturnedIdentitySchema, bindReturnedIdentities } from './returned-identities.ts';

const reviewed = { companyId: 'company_1', email: 'new@fixture.test', type: 'account', role: 'user',
  locationIds: ['loc_1'], firstName: 'Fixture', lastName: 'Owner', permissions: { contactsEnabled: true } };
const context = { botId: 'bot_1', threadId: 'thread_1', turnGeneration: 'gen_1', connectionId: 'hl_conn_1',
  connectionEpoch: 1, locationId: 'loc_1', companyId: 'company_1', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'owner' };
const spec = () => operationSpec('users.create')!;
function template() {
  expect(schemas['users.create'].argsSchema.safeParse(reviewed).success).toBe(true);
  return HeldRequest.freeze(spec(), { path: '/users/', resource: 'location:loc_1', body: { kind: 'json', value: reviewed } }, context);
}
const secret = () => `Aa9!${randomBytes(24).toString('base64url')}`;
function propose(actions: HighLevelActions, held = template()) {
  return actions.propose(context, 'HIGHLEVEL_USERS', reviewed, { held, recordRefs: [], fields: Object.keys(reviewed),
    kind: 'change', risk: 'D', escalation: 'none', basis: 'owner_exact_review' });
}

it('R1 password-free user tool accepts required and optional reviewed values, rejects every credential alias', () => {
  expect(schemas['users.create'].argsSchema.safeParse(reviewed).success).toBe(true);
  for (const field of ['password', 'newPassword', 'credential', 'secret', 'token', 'apiKey', 'authorization'])
    expect(schemas['users.create'].argsSchema.safeParse({ ...reviewed, [field]: secret() }).success, field).toBe(false);
  for (const field of ['companyId', 'email', 'type', 'role', 'locationIds', 'firstName', 'lastName']) {
    const input = { ...reviewed }; delete input[field as keyof typeof input];
    expect(schemas['users.create'].argsSchema.safeParse(input).success, field).toBe(false);
  }
});
it('R1 accepts supported optional provider values in full, including the profile photo field', () => {
  const optional = { ...reviewed, profilePhoto: 'https://images.fixture.invalid/avatar.png', phone: '+15550001234',
    twilioPhone: '+15550004321', platformLanguage: 'en_US', scopes: ['contacts.write'], scopesAssignedToOnly: ['contacts.write'] };
  expect(schemas['users.create'].argsSchema.safeParse(optional).success).toBe(true);
  expect(schemas['users.create'].argsSchema.safeParse({ ...optional, firstName: 'https://unreviewed.invalid' }).success).toBe(false);
});
it('R1/R2 incomplete user template binds all non-secret fields without becoming sendable', () => {
  const held = template();
  expect(held.frozen.completionKind).toBe('private_generated_password_v1');
  expect(JSON.parse(Buffer.from(held.sendCopy().body!).toString())).toEqual(reviewed);
  expect(schemas['users.create'].bodySchema.safeParse(reviewed).success).toBe(false);
  expect(schemas['users.create'].bodySchema.safeParse({ ...reviewed, password: secret() }).success).toBe(true);
  expect(() => HeldRequest.freeze(spec(), { path: '/users/', resource: 'location:loc_1', body: { kind: 'json', value: reviewed } }, { ...context, companyId: 'foreign' })).toThrow();
});
it('R3 only exact owner approval can approve private generation', () => {
  const actions = new HighLevelActions(), review = propose(actions);
  expect(review.completionKind).toBe('private_generated_password_v1');
  expect(() => actions.approveByPolicy(review.actionId, 'owner_no_limits_attended')).toThrow();
  expect(() => actions.approve(review.actionId, 'wrong')).toThrow();
  actions.approve(review.actionId, review.reviewDigest);
  expect(actions.get(review.actionId)?.phase).toBe('approved');
});
it('R7 provider-controlled identity keys are never written to diagnostics', () => {
  const held = template(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = bindReturnedIdentities({ user: { id: 'user_new', ...reviewed, unreviewed_id: 'other' } }, held.frozen, prepareReturnedIdentitySchema(held, context.locationId));
    expect(result.status).toBe('conflict'); expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});
it('R2 review binds a versioned private policy without creating or storing a secret', () => {
  const generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
  const journal = new MemoryActionJournal(), actions = new HighLevelActions({ journal });
  const held = template(), review = propose(actions, held);
  actions.approve(review.actionId, review.reviewDigest);
  const dispatch = actions.beginDispatch(review.actionId, context);
  expect(dispatch.held).toBe(held); expect(dispatch.intent.requestDigest).toBe(review.requestDigest);
  expect(generate).not.toHaveBeenCalled();
  expect(() => actions.beginDispatch(review.actionId, context)).toThrow();
});
describe('dedicated client completion', () => {
  function fixture() {
    const h = highLevelHarness(); h.leases.views.get('hl_conn_1')!.locationId = 'loc_1'; h.leases.views.get('hl_conn_1')!.companyId = 'company_1';
    const ctx = { connection: h.leases.views.get('hl_conn_1')!, signal: h.signals.signalFor(h.claim), assertActive() { if (this.signal.aborted) throw new Error('stopped'); }, onDispatch: vi.fn(async () => {}) };
    return { ...h, ctx };
  }
  it('R2 generic send refuses before credentials; dedicated completion sends exact bytes once with redirects disabled', async () => {
    const h = fixture(), held = template(), password = secret();
    vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(password));
    h.api.always('POST', /^\/users\/$/, { status: 201, body: { user: { id: 'user_new', ...reviewed } } });
    try {
      await expect(h.client.sendHeld(h.ctx, held, held.frozen.requestDigest)).rejects.toThrow();
      expect(h.leases.leaseRequests).toHaveLength(0);
      vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockReturnValue(Buffer.from(password));
      await expect(h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest)).resolves.toMatchObject({ user: { id: 'user_new' } });
      expect(h.api.calls('POST')).toHaveLength(1);
      const body = h.api.calls('POST')[0]!.body as Record<string, unknown>;
      expect(body.password === password).toBe(true); const { password: _password, ...publicBody } = body; expect(publicBody).toEqual(reviewed);
      expect(h.api.calls('POST')[0]!.redirect).toBe('manual');
    } finally { h.stop(); }
  });
  it('R2 authority is rechecked after waits before generating or sending', async () => {
    const h = fixture(), held = template(), generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
    h.ctx.onDispatch = vi.fn(async () => { throw new Error('stopped'); });
    try {
      await expect(h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest)).rejects.toThrow();
      expect(h.api.requests).toHaveLength(0); expect(generate).not.toHaveBeenCalled();
    } finally { h.stop(); }
  });
  it('R2 rechecks the trusted company after dispatch waits', async () => {
    const h = fixture(), held = template();
    h.ctx.onDispatch = vi.fn(async () => { h.ctx.connection.companyId = 'foreign'; });
    try {
      await expect(h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest)).rejects.toThrow();
      expect(h.api.requests).toHaveLength(0);
    } finally { h.stop(); }
  });
  it('R7 secret echoes in an otherwise valid created identity or unreviewed response field never reach a result', async () => {
    for (const field of ['id', 'diagnostic']) {
      const h = fixture(), held = template(), password = secret();
      const user = { id: 'user_new', ...reviewed, [field]: Buffer.from(password).toString('base64url') };
      vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(password));
    h.api.always('POST', /^\/users\/$/, { status: 201, body: { user } });
      try {
        const result = await h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest).catch(e => e);
        expect(result instanceof Error).toBe(true);
        expect(JSON.stringify(result).includes(password)).toBe(false);
      } finally { h.stop(); }
    }
  });
  it('R7 fully percent-encoded and nested base64 secret identities are refused', async () => {
    for (const encoding of ['percent', 'base64-percent']) {
      const h = fixture(), held = template(), password = secret();
      const percent = [...Buffer.from(password)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
      const id = encoding === 'percent' ? percent : Buffer.from(percent).toString('base64url');
      vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(password));
    h.api.always('POST', /^\/users\/$/, { status: 201, body: { user: { id, ...reviewed } } });
      try {
        const result = await h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest).catch(e => e);
        expect(result instanceof Error).toBe(true);
      } finally { h.stop(); }
    }
  });
  it.each([400, 401, 408, 429, 500, 503])('R7/R8 a provider refusal with secret prose stays fixed and sends once: %s', async status => {
    const h = fixture(), held = template(), password = secret();
    vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(password));
    h.api.always('POST', /^\/users\/$/, { status, body: { message: password, cause: { password } } });
    try {
      const result = await h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest).catch(e => e);
      expect(result).toMatchObject({ outcome: 'outcome_unknown', providerDetail: undefined });
      expect(String(result).includes(password) || JSON.stringify(result).includes(password)).toBe(false);
      expect(h.api.calls('POST')).toHaveLength(1);
    } finally { h.stop(); }
  });
  it.each(['literal', 'base64', 'base64url', 'url', 'unicode'] as const)('R7 encoded secret in allowed response field is refused: %s', async encoding => {
    const h = fixture(), held = template(), password = secret();
    const echoed = encoding === 'literal' ? password : encoding === 'base64' ? Buffer.from(password).toString('base64')
      : encoding === 'base64url' ? Buffer.from(password).toString('base64url') : encoding === 'url' ? encodeURIComponent(password)
      : [...password].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(password));
    h.api.always('POST', /^\/users\/$/, { status: 201, body: { user: { id: 'user_new', ...reviewed, firstName: echoed } } });
    try {
      const error = await h.client.sendHeldWithPrivatePassword(h.ctx, held, held.frozen.requestDigest).catch(e => e);
      expect(error).toMatchObject({ outcome: 'outcome_unknown' });
      expect(JSON.stringify(error).includes(password) || String(error).includes(echoed)).toBe(false);
      expect(h.api.calls('POST')).toHaveLength(1);
    } finally { h.stop(); }
  });
});
