import { bindServiceTurn } from '../service-no-limits.ts';
import { fixtureFamilyLevels } from './testing/family-grants.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HighLevelActions } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { FileRpcApprovalJournal } from './rpc-approval-replay.ts';
import { HighLevelLeakGuardV2 } from '../testing/highlevel-leak-guard-v2.ts';
import * as privatePassword from './users-create-password.ts';
import { validHighLevelPassword } from '../../shared/highlevel-password.ts';
import { randomBytes } from 'node:crypto';
import { HighLevelHost } from './host.ts';
import { UserCreateIdentityClaims } from './users-create-identity.ts';
import { operationSpec } from './operations/registry.ts';
import { HighLevelReviewCards } from './review-cards.ts';
import { highLevelHarness, FAKE_LOCATION_ID, FAKE_COMPANY_ID } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { captureUserCreateOutput, userCreateArtifactFiles } from '../testing/userscreate-output-capture.ts';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });
function fixture(options: { owner?: boolean; inventory?: unknown; response?: unknown; unknown?: boolean; dir?: string; recover?: boolean; password?: string } = {}) {
  vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'true');
  if (options.password) vi.spyOn(privatePassword, 'generatePrivateUserPassword').mockImplementation(() => Buffer.from(options.password!));
  const h = highLevelHarness({ deadlineMs: 3000 });
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'hlpw2-')); if (!options.dir) dirs.push(dir);
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')), now: () => h.now });
  if (options.recover) actions.recover();
  const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
  const claims = new UserCreateIdentityClaims(join(dir, 'claims.sqlite'));
  const args = { companyId: FAKE_COMPANY_ID, email: 'new@fixture.test', firstName: 'Fixture', lastName: 'User',
    type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID], permissions: { contactsEnabled: true } };
  const grant = (h.bot.highlevelAccess as any).grants[0];
  (h.bot.highlevelAccess as any).grantsVersion = 2; grant.families = fixtureFamilyLevels({ users: 'full' }); delete grant.operations.users;
  h.api.always('GET', /^\/users\/$/, { status: 200, body: options.inventory ?? { users: [] } });
  h.api.always('POST', /^\/users\/$/, options.unknown ? { status: 503, body: {} }
    : { status: 201, body: options.response ?? { user: { id: 'user_new', ...args } } });
  let owner = options.owner ?? true;
  const host = new HighLevelHost({ ...h, actions, approvalJournal, bot: () => h.bot, operationSpec, userCreateClaims: claims,
    userCreateOwner: () => owner,
    operationScopes: () => ['users.write', 'users.readonly'], approvalBasis: () => 'owner_no_limits_attended',
    onReview: (_claim, review) => {
      h.reviews.push(review);
      expect(review.basis).toBe('owner_exact_review');
      actions.approve(review.actionId, review.reviewDigest);
    } });
  const call = (changes = {}, id = 'rpc-create') => host.handle(h.claim, { jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'HIGHLEVEL_USERS', arguments: { operation: 'users.create', args: { ...args, ...changes } } } });
  return { ...h, dir, actions, approvalJournal, args, claims, host, call, setOwner: (value: boolean) => { owner = value; }, close() { h.stop(); claims.close(); } };
}
it('R1/R2 real host opens one exact ordinary review then sends one journaled complete POST', async () => {
  const h = fixture();
  try {
    const result = await h.call();
    expect(h.reviews).toHaveLength(1);
    expect(h.actions.get(h.reviews[0]!.actionId)?.outcomeCode).toBeUndefined();
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(h.api.requests.map(r => r.method)).toEqual(['GET', 'POST']);
    expect(h.api.requests[0]!.query.get('locationId')).toBe(FAKE_LOCATION_ID);
    const { password, ...body } = h.api.requests[1]!.body as Record<string, unknown>;
    expect(body).toEqual(h.args); expect(validHighLevelPassword(password)).toBe(true);
    expect(typeof password === 'string' && password.length === 32).toBe(true);
    expect(await h.call()).toEqual(result);
    expect(h.api.calls('POST').length).toBe(1);
  } finally { h.close(); }
});
it('R3 unproven desktop owner is refused before inventory, review or provider dispatch', async () => {
  const h = fixture({ owner: false });
  try {
    expect(JSON.stringify(await h.call())).toContain('Only you can add users, from the desktop app.');
    expect(h.reviews).toHaveLength(0); expect(h.api.requests).toHaveLength(0);
  } finally { h.close(); }
});
it.each([{ companyId: 'foreign' }, { locationIds: ['foreign'] }, { type: 'agency' }])('R2 foreign user authority refuses before inventory: %j', async changes => {
  const h = fixture();
  try { expect((await h.call(changes)).result).toMatchObject({ isError: true }); expect(h.api.requests).toHaveLength(0); }
  finally { h.close(); }
});
it.each(['existing', 'partial', 'foreign', 'duplicate'] as const)('R9 inventory blocks %s before review or POST', async mode => {
  const user = { id: 'old', email: 'new@fixture.test', roles: { type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] } };
  const inventory = mode === 'existing' ? { users: [user] } : mode === 'partial' ? { users: [], nextCursor: 'more' }
    : mode === 'duplicate' ? { users: [user, user] } : { users: [{ ...user, roles: { type: 'account', locationIds: ['foreign'] } }] };
  const h = fixture({ inventory });
  try { expect((await h.call()).result).toMatchObject({ isError: true }); expect(h.reviews).toHaveLength(0); expect(h.api.calls('POST').length).toBe(0); }
  finally { h.close(); }
});
it('R8/R9 new RPC after uncertain dispatch keeps the identity barrier even when inventory is empty', async () => {
  const h = fixture({ unknown: true });
  try {
    expect((await h.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect((await h.call({}, 'another-rpc')).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(h.api.calls('POST').length).toBe(1); expect(h.reviews).toHaveLength(1);
    expect(h.claims.status(FAKE_COMPANY_ID, h.args.email)).toBe('outcome_unknown');
  } finally { h.close(); }
});

it.each(['complete', 'empty', 'partial', 'contradictory'] as const)('R8/R9 restart after interrupted settlement performs one read and zero resends: %s', async mode => {
  const h = fixture();
  vi.spyOn(h.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('injected settlement interruption'); });
  await h.call(); expect(h.api.calls('POST').length).toBe(1); h.close();
  const user = { id: 'user_new', ...h.args };
  const inventory = mode === 'complete' ? { users: [user] } : mode === 'empty' ? { users: [] }
    : mode === 'partial' ? { users: [user], nextCursor: 'more' } : { users: [{ ...user, role: 'admin' }] };
  const restarted = fixture({ dir: h.dir, recover: true, inventory });
  try {
    const result = await restarted.call();
    expect(result.result).toMatchObject({ structuredContent: { outcome: mode === 'complete' ? 'applied' : 'outcome_unknown' } });
    expect(restarted.api.calls('POST').length).toBe(0); expect(restarted.api.calls('GET')).toHaveLength(1);
    expect(restarted.reviews).toHaveLength(0);
    expect(restarted.claims.status(FAKE_COMPANY_ID, h.args.email)).toBe('outcome_unknown');
  } finally { restarted.close(); }
});
it('R8 two distinct action IDs racing for the same normalized identity have one POST owner', async () => {
  const h = fixture();
  try {
    const results = await Promise.all([h.call({}, 'one'), h.call({ email: h.args.email.toUpperCase() }, 'two')]);
    expect(h.api.calls('POST').length).toBe(1); expect(h.reviews).toHaveLength(1);
    expect(results.filter(r => (r.result as any)?.structuredContent?.outcome === 'applied')).toHaveLength(1);
  } finally { h.close(); }
});
it('R10 leak guard v2 intercepts actual process output and host callbacks across restart', async () => {
  const password = `FixtureA4!${randomBytes(24).toString('hex')}`;
  const guard = new HighLevelLeakGuardV2([password]), output = captureUserCreateOutput();
  const h = fixture({ password });
  const observe = (current: ReturnType<typeof fixture>) => {
    const messages: any[] = [];
    const persist = (value: unknown) => appendFileSync(join(h.dir, 'transcript.jsonl'), JSON.stringify(value) + '\n');
    const cards = new HighLevelReviewCards({ actions: current.actions, store: {
      appendMessage: guard.wrapSink('model_context', (_thread: string, row: any) => {
        const next = { ...row, id: String(messages.length) }; messages.push(next); persist(next); return next;
      }),
      messageById: (_thread: string, id: string) => messages.find(row => row.id === id),
      patchMessage: guard.wrapSink('model_context', (_thread: string, id: string, patch: any) => {
        Object.assign(messages.find(row => row.id === id), patch); persist(patch);
      }),
    } as any, waiting() {} });
    current.host.configureReview({
      onReview: (_claim, review) => {
        current.reviews.push(review); cards.opened(current.claim, review);
        cards.resolve(current.claim.threadId, `highlevel-${review.actionId}`, 'allow', { desktop: true, reviewDigest: review.reviewDigest });
      },
      onReviewClosed: actionId => cards.closed(actionId),
      onOutcome: guard.wrapSink('event_stream', (_claim, outcome) => {
        cards.closed(outcome.actionId); persist(outcome);
      }),
    });
    const handle = current.host.handle.bind(current.host);
    vi.spyOn(current.host, 'handle').mockImplementation(async (...input) => {
      const result = await handle(...input);
      return guard.wrapSink('tool_context', value => { persist(value); return value; })(result) as typeof result;
    });
  };
  const scan = async () => {
    output.assertClean(guard);
    expect((await guard.scanFiles(userCreateArtifactFiles([h.dir]))).leaks).toBe(0);
    // Stdin keeps needles out of process arguments and evidence; grep output
    // is captured and never printed, even on an intentional mutant.
    expect(spawnSync('grep', ['-arFl', '-f', '-', '--', h.dir], { input: password + '\n' }).status).toBe(1);
  };
  try {
    // Positive controls go through the real writers, including split writes.
    console.log(Buffer.from(password).toString('base64'));
    expect(() => output.assertClean(guard)).toThrow('A secret reached a protected sink.');
    output.restore();
    const control = captureUserCreateOutput();
    process.stderr.write(password.slice(0, 9)); process.stderr.write(password.slice(9));
    expect(() => control.assertClean(guard)).toThrow('A secret reached a protected sink.');
    control.restore();
    // Fresh capture after controls. Never feed selected objects into no-op sinks.
    const actual = captureUserCreateOutput();
    output.assertClean = actual.assertClean; output.restore = actual.restore;
    observe(h);
    const result = await h.call();
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    writeFileSync(join(h.dir, 'positive-control.bin'), Buffer.from(password));
    expect(spawnSync('grep', ['-arFl', '-f', '-', '--', h.dir], { input: password + '\n' }).status).toBe(0);
    unlinkSync(join(h.dir, 'positive-control.bin'));
    await scan(); h.close(); await scan();
    const restarted = fixture({ dir: h.dir, recover: true }); observe(restarted);
    try { await restarted.call(); await scan(); }
    finally { restarted.close(); }
    await scan();
  } finally { output.restore(); h.close(); }
});

it('recipient flag defaults false and refuses all creates before inventory or approval', async () => {
  const h = fixture(); vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', undefined);
  const generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
  try {
    const result = JSON.stringify(await h.call());
    expect(result).toContain('Add this user in HighLevel to finish setting up their access.');
    expect(result).toContain('[Open HighLevel](https://app.gohighlevel.com/)');
    expect(h.api.requests).toHaveLength(0); expect(h.reviews).toHaveLength(0); expect(generate).not.toHaveBeenCalled();
  } finally { h.close(); }
});
it('recipient flag and owner are rechecked after approval before private generation', async () => {
  const h = fixture(); const generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
  h.host.configureReview({ onReview: (_claim, review) => {
    h.reviews.push(review); h.actions.approve(review.actionId, review.reviewDigest);
    vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'false');
  } });
  try {
    await h.call(); expect(h.api.calls('POST').length).toBe(0); expect(generate).not.toHaveBeenCalled();
  } finally { h.close(); }
});

it('restart reconciliation remains read-only when recipient creation flag is disabled', async () => {
  const h = fixture();
  vi.spyOn(h.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('fixture interruption'); });
  await h.call(); expect(h.api.calls('POST').length).toBe(1); h.close();
  const restarted = fixture({ dir: h.dir, recover: true, inventory: { users: [{ id: 'user_new', ...h.args }] } });
  vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'false');
  try {
    const result = await restarted.call();
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(restarted.api.calls('POST').length).toBe(0); expect(restarted.api.calls('GET')).toHaveLength(1);
    expect(restarted.reviews).toHaveLength(0);
  } finally { restarted.close(); }
});

it('ordinary users.create card requires authenticated desktop fact and the exact rendered review digest', async () => {
  const h = fixture(), messages: any[] = [];
  const cards = new HighLevelReviewCards({ actions: h.actions, store: {
    appendMessage: (_thread: string, row: any) => { const next = { ...row, id: String(messages.length) }; messages.push(next); return next; },
    messageById: (_thread: string, id: string) => messages.find(row => row.id === id),
    patchMessage: (_thread: string, id: string, patch: any) => Object.assign(messages.find(row => row.id === id), patch),
  } as any, waiting() {} });
  h.host.configureReview({ onReview: (claim, review) => {
    h.reviews.push(review); cards.opened(claim, review);
    const request = `highlevel-${review.actionId}`;
    for (const approval of [undefined, { desktop: false, reviewDigest: review.reviewDigest }, { desktop: true, reviewDigest: 'wrong' }])
      expect(cards.resolve(claim.threadId, request, 'allow', approval)).toBe('unavailable');
    expect(h.api.calls('POST').length).toBe(0);
    expect(cards.resolve(claim.threadId, request, 'allow', { desktop: true, reviewDigest: review.reviewDigest })).toBe('allowed-once');
  } });
  try {
    expect((await h.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(h.api.calls('POST').length).toBe(1);
  } finally { h.close(); }
});

it('S4 No limits routine users.create bypasses desktop attendance and exact review', async()=>{
 const h=fixture({owner:false});
 vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED','true');
 bindServiceTurn(h.claim.generation,h.claim.threadId,h.claim.botId,()=>h.capabilities.isActive(h.claim),()=>({ownerAudience:true,origin:'routine',noLimits:true}));
 try {
  expect((await h.call()).result).toMatchObject({structuredContent:{outcome:'applied'}});
  expect(h.reviews).toHaveLength(0);expect(h.api.calls('POST')).toHaveLength(1);
 }finally{h.close();}
});

 it('N3 No limits users.create with recipient readiness off never sends', async () => {
  const h = fixture({ owner: false });
  vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'false');
  bindServiceTurn(h.claim.generation, h.claim.threadId, h.claim.botId,
    () => h.capabilities.isActive(h.claim), () => ({ ownerAudience: true, origin: 'webhook', noLimits: true }));
  const generate = vi.spyOn(privatePassword, 'generatePrivateUserPassword');
  try {
    expect(JSON.stringify(await h.call())).toContain('Add this user in HighLevel');
    expect(h.api.requests).toHaveLength(0);
    expect(h.reviews).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  } finally { h.close(); }
 });
