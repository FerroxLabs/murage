import { bindServiceTurn } from '../service-no-limits.ts';
import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OperationSpec } from './operations/registry.ts';
import { fixtureSpec, fixtureHeld } from '../testing/highlevel-r4-fixtures.ts';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, afterEach, vi } from 'vitest';
import * as hostModule from './host.ts';
import { HighLevelActions, MemoryActionJournal } from './actions.ts';
import { highLevelHarness, scriptCrm, until } from '../testing/fake-highlevel.ts';
import { setCloudIdentity } from '../cloud-request-identity.ts';
import { desktopSurfaceSecret } from '../sse-visibility.ts';
import { ownerAppSurface } from '../owner-app.ts';
import { cloudRouteDecision } from '../route-policy.ts';

// Missing S0/C2 exports fail by assertion on the frozen base, not by module resolution.
const path = './review-cards.ts';
const cardsModule = existsSync(new URL(path, import.meta.url)) ? await import(path) : {};
const requireCards = () => { expect(typeof cardsModule.HighLevelReviewCards).toBe('function'); return cardsModule; };
const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1, locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
const SENTINEL = 'secret CRM body 29e671';
function fixture(actions = new HighLevelActions()) {
  const mod = requireCards();
  const rows: any[] = [];
  const patches: Array<{ threadId: string; id: string; patch: unknown }> = [];
  const cards = new mod.HighLevelReviewCards({ actions, store: {
    appendMessage: (_thread: string, row: any) => { const next = { ...row, id: String(rows.length) }; rows.push(next); return next; },
    messageById: (_thread: string, id: string) => rows.find(row => row.id === id),
    patchMessage: (threadId: string, id: string, patch: any) => { patches.push({ threadId, id, patch }); return Object.assign(rows.find(row => row.id === id), patch); },
  }, waiting: () => {} });
  const review = actions.propose(context, 'HIGHLEVEL_ADD_NOTE', { contactId: 'contact_1', body: SENTINEL }, fixtureActionDetail({ recordRefs: ['contactId:contact_1'], fields: ['body'], held: fixtureHeld('contacts.notes.create') }, context));
  cards.opened({ threadId: 'thread', botId: 'bot', generation: 'turn' }, review);
  return { actions, cards, rows, patches, review, request: `highlevel-${review.actionId}` };
}
afterEach(() => vi.unstubAllEnvs());

describe('C2 exact desktop review', () => {
  it.each(['allow', 'deny', 'unavailable'] as const)('settling %s patches only its own card metadata and preserves conversation text', answer => {
    const { cards, review, request, rows, patches } = fixture();
    const original = structuredClone(rows[0]);
    const unrelated = { id: 'unrelated', role: 'bot', kind: 'text', text: 'Keep these conversation words.' };
    rows.push(structuredClone(unrelated));
    if (answer === 'unavailable') cards.closed(review.actionId);
    else cards.resolve('thread', request, answer, { desktop: true, reviewDigest: review.reviewDigest });
    const card = { ...original.card, answered: answer, dismissed: answer === 'unavailable' };
    expect(patches).toEqual([{ threadId: 'thread', id: original.id, patch: { card } }]);
    expect(rows).toEqual([{ ...original, card }, unrelated]);
    cards.closed(review.actionId);
    expect(patches).toHaveLength(1);
  });
  it('T2 wrong or absent digest cannot approve; generic automatic answers cannot approve', () => {
    const { actions, cards, review, request } = fixture();
    for (const approval of [undefined, { desktop: true }, { desktop: true, reviewDigest: 'wrong' }, { desktop: false, reviewDigest: review.reviewDigest }]) {
      expect(cards.resolve('thread', request, 'allow', approval)).toBe('unavailable');
      expect(actions.get(review.actionId)?.phase).toBe('awaiting_approval');
    }
    expect(cards.resolve('other-thread', request, 'allow', { desktop: true, reviewDigest: review.reviewDigest })).toBe('unavailable');
  });
  it.each(['T3 Cloud phone', 'T4 Cloud passkey and remembered browser', 'T5 paired phone and browser'])('%s cannot read or allow; Deny works', (name) => {
    const { cards, actions, review, request } = fixture();
    const cloudSurface = (scope: string, factor?: string) => { const headers = {}; setCloudIdentity(headers, { id: 'fixture', account: 'owner', scope, factor, revoked: false } as never); return ownerAppSurface(headers); };
    if (!name.startsWith('T5')) vi.stubEnv('MURAGE_CLOUD_ROLE', 'home');
    const surfaces = name.startsWith('T5') ? [{ ok: true, app: { kind: 'phone' } }, ownerAppSurface({})]
      : name.startsWith('T3') ? [cloudSurface('owner-phone')] : [cloudSurface('browser', 'passkey'), cloudSurface('browser', 'remembered-owner')];
    for (const surface of surfaces) {
      const response = cardsModule.highlevelReviewResponse(cards, review.actionId, surface);
      expect(response.status).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response)).not.toContain(SENTINEL);
      expect(cards.resolve('thread', request, 'allow', { desktop: false, reviewDigest: review.reviewDigest })).toBe('unavailable');
    }
    if (name.startsWith('T3')) expect(cloudRouteDecision('GET', `/api/highlevel/reviews/${review.actionId}`, 'owner-phone', null)).toBe('deny');
    expect(cards.resolve('thread', request, 'deny')).toBe('rejected');
    expect(actions.review(review.actionId)).toBeUndefined();
  });
  it('T6 desktop shows full values and sends exactly the approved bytes; durable rows contain no values', () => {
    const { cards, actions, review, request, rows } = fixture();
    const response = cardsModule.highlevelReviewResponse(cards, review.actionId, ownerAppSurface({ 'x-murage-surface': 'desktop', 'x-murage-surface-secret': desktopSurfaceSecret() }));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.values).toEqual({ contactId: 'contact_1', body: SENTINEL });
    expect(cards.resolve('thread', request, 'allow', { desktop: true, reviewDigest: response.body.reviewDigest })).toBe('allowed-once');
    expect(actions.beginDispatch(review.actionId, context).intent.argumentsDigest).toBe(actions.get(review.actionId)?.argumentsDigest);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    expect(JSON.stringify(rows)).not.toContain(review.reviewDigest);
  });
  it('T7 restart stales an open review and cannot send', () => {
    const journal = new MemoryActionJournal();
    const first = fixture(new HighLevelActions({ journal }));
    const restarted = new HighLevelActions({ journal }); restarted.recover();
    expect(restarted.get(first.review.actionId)?.phase).toBe('stale');
    expect(restarted.review(first.review.actionId)).toBeUndefined();
    expect(() => restarted.beginDispatch(first.review.actionId, context)).toThrow();
  });
});

const basis = (facts: any) => { const fn = (hostModule as any).highlevelApprovalBasis; expect(typeof fn).toBe('function'); return fn(facts); };
describe('C2 policy basis', () => {
  it.each(['R', 'C', 'S', 'D'].flatMap(risk => [false, true].flatMap(noLimits => [false, true].map(attended => ({ risk, noLimits, attended })))))('basis.table $risk noLimits=$noLimits attended=$attended', facts => {
    const expected = facts.noLimits ? facts.risk === 'D' ? 'owner_no_limits_attended' : 'owner_no_limits' : 'owner_exact_review';
    expect(basis(facts)).toBe(expected);
  });
  it.each(['HIGHLEVEL_CONTACTS', 'contacts.delete', 'HIGHLEVEL:D'])('basis.denyRuleDoesNotHoldNoLimits %s', rule => {
    expect(basis({ risk: 'D', noLimits: true, attended: true, tool: 'HIGHLEVEL_CONTACTS', operation: 'contacts.delete', denyRules: [rule] })).toBe('owner_no_limits_attended');
  });
  it('basis.fullAccessCards and unknown lane cards', () => {
    expect(basis({ risk: 'C', fullAccess: true, autoApprove: true, attended: true })).toBe('owner_exact_review');
  });
  it('basis.attendedLostStales at dispatch and after a lease/rate wait', () => {
    const actions = new HighLevelActions();
    expect(typeof (actions as any).approveByPolicy).toBe('function');
    for (const late of [false, true]) {
      const ctx = { ...context, basis: 'owner_no_limits_attended' as const };
      const review = actions.propose(ctx, 'HIGHLEVEL_ADD_NOTE', { body: SENTINEL }, fixtureActionDetail({ recordRefs: [], fields: ['body'], operation: 'contacts.notes.create', risk: 'D', held: fixtureHeld('contacts.notes.create') } as any, ctx));
      (actions as any).approveByPolicy(review.actionId, 'owner_no_limits_attended');
      if (late) actions.beginDispatch(review.actionId, ctx);
      expect(() => late ? actions.recordAttempt(review.actionId, 1, { ...ctx, basis: 'owner_exact_review' } as any) : actions.beginDispatch(review.actionId, { ...ctx, basis: 'owner_exact_review' } as any)).toThrow();
      expect(actions.get(review.actionId)?.phase).toBe('stale');
    }
  });
  it('outcome.credClearStalesOpen', async () => {
    const { actions, cards, review } = fixture();
    expect(typeof (actions as any).staleConnection).toBe('function');
    const decision = actions.awaitDecision(review.actionId, new AbortController().signal);
    (actions as any).staleConnection('conn', 'credentials_changed');
    expect(await decision).toBe('expired');
    expect(actions.get(review.actionId)?.phase).toBe('stale');
    expect(cards.reviewValues(review.actionId)).toBeUndefined();
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain('actions.staleConnection(connection.connectionId');
  });
  it('outcome.receiptStatusNotText even on provider failure', async () => {
    const h = operationHarness();
    const outcomes: unknown[] = [];
    expect(typeof (h.host as any).configureReview).toBe('function');
    (h.host as any).configureReview({ onOutcome: (_claim: unknown, outcome: unknown) => outcomes.push(outcome) });
    h.api.first('PUT', /\/contacts\//u, { status: 400, body: { message: SENTINEL } });
    const pending = h.call();
    await h.approveNext(); await pending;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: 'not_applied', status: 400, fields: ['firstName'] });
    expect(JSON.stringify(outcomes)).not.toContain(SENTINEL);
  });
});

import { z } from 'zod';
import { HighLevelHost, highlevelApprovalBasis, highlevelAttended } from './host.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { FileActionJournal } from './journal-file.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../testing/cleanup.ts';
import { markTurnEmailDerived, forgetAllTurnMarks } from '../email/external-marks.ts';

function operationHarness(options: { noLimits?: boolean; attended?: boolean; risk?: 'R' | 'C' | 'S' | 'D'; targets?: number; denyRules?: string[] } = {}) {
  const h = highLevelHarness(); scriptCrm(h.api);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
    grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] };
  const read = options.risk === 'R';
  const spec = fixtureSpec({
    nested: false, preflight: [],
    id: read ? 'contacts.get' : 'contacts.update', family: 'contacts', risk: options.risk ?? 'C', title: 'Update a contact',
    endpoint: HIGHLEVEL_ENDPOINTS[read ? 'contacts.get' : 'contacts.update'],
    args: z.object({ contactId: z.string(), firstName: z.string().optional() }).strict(),
    recordRefs: (args: Record<string, unknown>) => [`contactId:${args.contactId}`], fields: (args: Record<string, unknown>) => Object.keys(args).filter(key => key !== 'contactId'), targets: () => options.targets ?? 1,
    recordId: (v: any) => v.contact?.id, project: (value: unknown) => value,
  }, (args, _ctx) => ({ path: `/contacts/${args.contactId}`, resource: "", ...(read ? {} : { body: { kind: "json", value: { firstName: args.firstName } } }) }));
  h.api.always('PUT', /^\/contacts\/[^/]+$/, request => ({ status: 200, body: { contact: { id: request.path.split('/')[2] } } }));
  const facts = { noLimits: options.noLimits, attended: options.attended };
  const outcomes: unknown[] = [];
  const host = new HighLevelHost({ ...h, bot: () => h.bot,
    operationSpec: id => id === spec.id ? spec : undefined, operationScopes: () => ['contacts.readonly', 'contacts.write'],
    approvalBasis: (_claim, op, risk) => highlevelApprovalBasis({ ...facts, risk, tool: 'HIGHLEVEL_CONTACTS', operation: op.id, denyRules: options.denyRules }),
    onReview: (_claim, review) => h.reviews.push(review), onOutcome: (_claim, outcome) => outcomes.push(outcome),
  });
  const call = (contactId = 'contact_1', firstName = SENTINEL) => host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: spec.id, args: { contactId, ...(read ? {} : { firstName }) } });
  return { ...h, host, facts, outcomes, spec, call };
}

describe('C2 host dispatch integration', () => {
  it.each(['R', 'C', 'S', 'D'] as const)('basis.table actual host %s on default, No limits, and attended lanes', async risk => {
    for (const [noLimits, attended] of [[false, false], [true, false], [true, true]]) {
      const h = operationHarness({ risk, noLimits, attended });
      const pending = h.call();
      if (risk !== 'R' && !noLimits) {
        await until(() => h.reviews.length > 0);
        expect(h.api.calls('PUT')).toHaveLength(0);
        await h.approveNext();
      }
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(h.api.calls(risk === 'R' ? 'GET' : 'PUT')).toHaveLength(1);
      expect(h.reviews).toHaveLength(0);
      if (risk !== 'R') expect(h.outcomes).toHaveLength(1);
      h.stop();
    }
  });
  it('No limits still runs ordinary changes after CRM outside content', async () => {
    const h = operationHarness({ noLimits: true });
    markTurnEmailDerived(h.claim.threadId);
    try { expect((await h.call()).isError).not.toBe(true); expect(h.reviews).toHaveLength(0); }
    finally { forgetAllTurnMarks(); h.stop(); }
  });
  it('No limits continues after attendance is lost during a lease wait', async () => {
    const h = operationHarness({ noLimits: true, attended: true, risk: 'D' });
    let release!: () => void;
    h.leases.hold = new Promise<void>(resolve => { release = resolve; });
    const pending = h.call();
    await until(() => h.leases.leaseRequests.length > 0);
    h.facts.attended = false; release();
    expect((await pending).isError).not.toBe(true);
    expect(h.api.calls('PUT')).toHaveLength(1);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ outcome: 'applied', basis: 'owner_no_limits_attended' });
    h.stop();
  });
  it('No limits ignores ordinary deny-rule review holds', async () => {
    const h = operationHarness({ noLimits: true, attended: true, denyRules: ['contacts.update'] });
    expect((await h.call()).isError).not.toBe(true);
    expect(h.reviews).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(1); h.stop();
  });
  it('fourth identical C loop escalates to D and continues at No limits', async () => {
    const h = operationHarness({ noLimits: true });
    for (let i = 0; i < 4; i++) expect((await h.call(`contact_${i}`)).isError).not.toBe(true);
    expect(h.reviews).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(4); h.stop();
  });
  it.each(['owner-channel', 'routine', 'webhook'] as const)('S4 %s No limits writes without review on the actual host', async origin => {
    const h=operationHarness({risk:'D'});
    bindServiceTurn(h.claim.generation,h.claim.threadId,h.claim.botId,()=>h.capabilities.isActive(h.claim),()=>({ownerAudience:true,origin,noLimits:true}));
    try { expect((await h.call()).isError).not.toBe(true); expect(h.reviews).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(1); }
    finally { h.stop(); }
  });
  it('bulk escalation checks full grant before proposing', async () => {
    const h = operationHarness({ noLimits: true, targets: 2 });
    (h.bot.highlevelAccess as any).grants[0].families.contacts = 'change';
    expect((await h.call()).isError).toBe(true);
    expect(h.reviews).toHaveLength(0); expect(h.api.requests).toHaveLength(0); h.stop();
  });
  it('unknown scopes refuse before credentials; unknown operations refuse without a review', async () => {
    const h = operationHarness();
    const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: () => h.spec });
    expect((await host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: h.spec.id, args: { contactId: 'contact_1' } })).isError).toBe(true);
    expect(h.leases.leaseRequests).toHaveLength(0);
    expect((await h.host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: 'contacts.missing', args: {} })).isError).toBe(true);
    h.stop();
  });
  it('T7 file journal recovers policy-approved unsent work read-only without retaining values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-c2-journal-')); const file = join(dir, 'actions.jsonl');
    const journal = new FileActionJournal(file); const actions = new HighLevelActions({ journal });
    const review = actions.propose({ ...context }, 'HIGHLEVEL_CONTACTS', { firstName: SENTINEL }, fixtureActionDetail({ recordRefs: [], fields: ['firstName'], operation: 'contacts.update', risk: 'C' }, { ...context, basis: 'owner_no_limits' }));
    const approved = actions.approveByPolicy(review.actionId, 'owner_no_limits');
    expect(readFileSync(file, 'utf8')).not.toContain(SENTINEL);
    const restarted = new HighLevelActions({ journal: new FileActionJournal(file) }); restarted.recover();
    expect(restarted.get(review.actionId)).toMatchObject({ phase: 'outcome_unknown', approvalId: approved.approvalId, dispatchAttempts: 0 });
    expect(() => restarted.beginDispatch(review.actionId, context)).toThrow();
    expect(restarted.review(review.actionId)).toBeUndefined();
    await removeTempDir(dir);
  });
  it('attended uses the owner line timestamp and live desktop, with a strict 15 minute boundary', () => {
    expect(highlevelAttended(100, true, 900100)).toBe(true);
    expect(highlevelAttended(100, true, 900101)).toBe(false);
    expect(highlevelAttended(100, false, 101)).toBe(false);
    expect(highlevelAttended(undefined, true, 101)).toBe(false);
    expect(highlevelAttended(200, true, 100)).toBe(false);
  });
});

it('owner deny on an R operation opens an exact review before any provider read', async () => {
  const h = operationHarness({ risk: 'R', noLimits: true });
  h.host.configureReview({ ownerDenyRule: () => true });
  const pending = h.call(); await until(() => h.reviews.length > 0);
  expect(h.api.requests).toHaveLength(0);
  h.actions.deny(h.reviews[0]!.actionId); await pending; h.stop();
});
it('tools/list carries only authorized operation enums and old RPC names give rename guidance', async () => {
  const h = operationHarness();
  const readSpec = { ...h.spec, id: 'contacts.get', risk: 'R' } as OperationSpec;
  const host = new HighLevelHost({ ...h, bot: () => h.bot, familyOperations: family => family === 'contacts' ? [h.spec, readSpec] : [] });
  (h.bot.highlevelAccess as any).grants[0].families.contacts = 'read';
  const listed = await host.handle(h.claim, { id: 1, method: 'tools/list' }) as any;
  expect(listed.result.tools[0]).toMatchObject({ name: 'HIGHLEVEL_CONTACTS', inputSchema: { properties: { operation: { enum: ['contacts.get'] } } } });
  const legacy = await host.handle(h.claim, { id: 2, method: 'tools/call', params: { name: 'HIGHLEVEL_UPDATE_CONTACT', arguments: {} } });
  expect(JSON.stringify(legacy)).toContain('Use HIGHLEVEL_CONTACTS with operation contacts.update');
  expect(h.api.requests).toHaveLength(0); h.stop();
});
it('settled values are discarded and substring redaction is withdrawn by r2', () => {
  const actions = new HighLevelActions();
  const review = actions.propose(context, 'HIGHLEVEL_ADD_NOTE', { body: SENTINEL }, fixtureActionDetail({ fields: ['body'], recordRefs: [] }, context));
  actions.deny(review.actionId);
  expect(actions.review(review.actionId)).toBeUndefined();
  expect((actions as any).scrubKnownValues).toBeUndefined();
});

it('S4 No limits continues beyond the old 200-change ceiling', async () => {
  const h = operationHarness({ noLimits: true, attended: true });
  for (let i = 0; i < 201; i++) expect((await h.call(`contact_${i}`, `name_${i}`)).isError).not.toBe(true);
  expect((await h.call('contact_over')).isError).not.toBe(true);
  expect(h.api.calls('PUT')).toHaveLength(202); h.stop();
});
it('provider timeout is outcome_unknown once and never retries the mutation', async () => {
  const h = operationHarness({ noLimits: true });
  h.api.first('PUT', /^\/contacts\//, 'timeout');
  expect(await h.call()).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } });
  expect(h.api.calls('PUT')).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ outcome: 'outcome_unknown' }); h.stop();
});
it('a missing review delivery denies without dispatching', async () => {
  const h = operationHarness(); h.host.configureReview({ onReview: undefined });
  expect((await h.call()).isError).toBe(true);
  expect(h.api.requests).toHaveLength(0); expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ outcome: 'not_applied' }); h.stop();
});

it('sixth single send becomes D and continues at No limits', async () => {
  const h = highLevelHarness(); scriptCrm(h.api);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] };
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1' } } });
  const spec = fixtureSpec({
    nested: false, preflight: [],
    id: 'contacts.update', family: 'contacts', risk: 'C', send: true, title: 'Send a text', endpoint: HIGHLEVEL_ENDPOINTS['contacts.update']!,
    args: z.object({ contactId: z.string(), message: z.string() }).strict(), recordRefs: (args: Record<string, unknown>) => [String(args.contactId)], fields: () => ['message'], targets: () => 1,
    project: (value: unknown) => value,
  }, (args, _ctx) => ({ path: '/contacts/contact_1', resource: '', body: { kind: 'json', value: { ...args, type: 'SMS' } } }));
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: () => spec, operationScopes: () => [spec.endpoint.scope],
    approvalBasis: (_claim, _spec, risk) => highlevelApprovalBasis({ risk, noLimits: true, attended: false }), onReview: (_claim, review) => h.reviews.push(review) });
  let sendIndex = 0;
  const call = () => host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: spec.id, args: { contactId: 'contact_1', message: `${SENTINEL}${sendIndex++}` } });
  for (let i = 0; i < 5; i++) expect((await call()).isError).not.toBe(true);
  expect((await call()).isError).not.toBe(true);
  expect(h.reviews).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(6); h.stop();
});
