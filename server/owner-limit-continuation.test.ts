// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup owns private backup authorization and its dispatch consumer.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { OwnerLimitContinuations, LimitApplications, type OwnerLimitSnapshot } from './owner-limit-continuation.ts';

const snapshot = (): OwnerLimitSnapshot => ({ botId: 'bot', threadId: 'thread', generation: 'generation', sourceMessageId: 'source', sourceDigest: 'digest', principal: 'owner-binding-revision', policy: 'task-revision', epoch: 0 });
const selection = { instanceId: 'backup', model: 'fixture' };
function harness() {
  const db = new DatabaseSync(':memory:');
  const applications = new LimitApplications(() => db);
  let current = snapshot();
  const tickets = new OwnerLimitContinuations(s => JSON.stringify(s) === JSON.stringify(current));
  const ticket = tickets.capture(current, { admitted: true, live: true, ownerTyped: true, ownerAudience: true, unlimited: true, firstHop: true })!;
  const source = {};
  tickets.bindProvider(ticket, 'primary', source);
  const event = { threadId: 'thread', providerInstanceId: 'primary', turnId: 'provider-turn' };
  tickets.observeStarted(ticket, event, source);
  return { db, applications, tickets, ticket, source, event, get current() { return current; }, change(patch: Partial<OwnerLimitSnapshot>) { current = { ...current, ...patch }; } };
}
it('transfers exact live provider authority once, then confines it to one selected backup application', () => {
  const h = harness();
  expect(h.tickets.transferAtLimit(h.ticket, h.event, h.source, true)).toBe(h.ticket);
  expect(h.tickets.transferAtLimit(h.ticket, h.event, h.source, true)).toBeUndefined();
  const app = h.applications.prepare(h.current, selection, 'automatic');
  expect(h.tickets.select(h.ticket, app)).toBe(true);
  expect(h.tickets.claim(h.ticket, app)).toBe(true);
  expect(h.applications.claim(app)).toBe(true);
  expect(h.tickets.claim(h.ticket, app)).toBe(false);
  expect(h.applications.claim(app)).toBe(false);
  expect(h.tickets.validate(h.ticket, { ...app, to: { ...selection, model: 'unrelated-operation' } })).toBe(false);
  h.db.close();
});
it('fields, clones, recovered unlimited JSON and a restarted registry never constitute authority', () => {
  const h = harness();
  h.tickets.transferAtLimit(h.ticket, h.event, h.source, true);
  const app = h.applications.prepare(h.current, selection, 'automatic');
  for (const proof of [{ ...h.ticket }, JSON.parse(JSON.stringify(h.current)), { recoveredLevel: 'unlimited' }]) {
    expect(h.tickets.select(proof, app)).toBe(false);
    expect(h.tickets.claim(proof, app)).toBe(false);
  }
  expect(new OwnerLimitContinuations(() => true).select(h.ticket, app)).toBe(false);
  h.db.close();
});
it.each(['threadId', 'principal', 'policy', 'sourceDigest', 'epoch'] as const)('revokes after asynchronous preparation changes %s', field => {
  const h = harness(); h.tickets.transferAtLimit(h.ticket, h.event, h.source, true);
  const app = h.applications.prepare(h.current, selection, 'automatic'); h.tickets.select(h.ticket, app);
  h.change({ [field]: field === 'epoch' ? 1 : 'changed' });
  expect(h.tickets.validate(h.ticket, app)).toBe(false);
  expect(h.tickets.claim(h.ticket, app)).toBe(false);
  h.db.close();
});
it.each(['provider', 'turn', 'source', 'missing', 'activity'] as const)('rejects terminal binding mismatch: %s', mode => {
  const h = harness();
  const event = { ...h.event, ...(mode === 'provider' ? { providerInstanceId: 'other' } : mode === 'turn' ? { turnId: 'other' } : mode === 'missing' ? { turnId: undefined } : {}) };
  expect(h.tickets.transferAtLimit(h.ticket, event, mode === 'source' ? {} : h.source, mode !== 'activity')).toBeUndefined();
  h.db.close();
});
it.each(['admitted','live','ownerTyped','ownerAudience','unlimited','firstHop'] as const)('capture refuses missing %s', field => {
  const tickets = new OwnerLimitContinuations(() => true);
  expect(tickets.capture(snapshot(), { admitted: true, live: true, ownerTyped: true, ownerAudience: true, unlimited: true, firstHop: true, [field]: false })).toBeUndefined();
});
it('Stop durably fences idle applications and cannot cancel an unrelated successor generation', () => {
  const h = harness(); h.tickets.transferAtLimit(h.ticket, h.event, h.source, true);
  const app = h.applications.prepare(h.current, selection, 'automatic'); h.tickets.select(h.ticket, app);
  h.tickets.cancel('thread', 'other-generation');
  expect(h.tickets.validate(h.ticket, app)).toBe(true);
  h.tickets.cancel('thread'); h.applications.cancel('thread');
  expect(h.tickets.claim(h.ticket, app)).toBe(false);
  expect(h.applications.claim(app)).toBe(false);
  expect(new LimitApplications(() => h.db).epoch('thread')).toBe(1);
  expect(() => h.applications.prepare(h.current, selection, 'raised')).toThrow();
  h.db.close();
});
it('restart needs a fresh allowed owner action, with canonical source uniqueness across auto, raise and explicit answer', () => {
  const h = harness();
  const app = h.applications.prepare(h.current, selection, 'automatic');
  const restarted = new OwnerLimitContinuations(() => true);
  expect(restarted.authorizeRaisedCard(h.current, false)).toBeUndefined();
  const ticket = restarted.authorizeRaisedCard(h.current, true)!;
  const raised = h.applications.prepare(h.current, selection, 'raised');
  expect(raised.rowId).toBe(app.rowId); expect(raised.sendId).toBe(app.sendId);
  expect(restarted.select(ticket, raised)).toBe(true);
  expect(restarted.claim(ticket, raised)).toBe(true); expect(h.applications.claim(raised)).toBe(true);
  expect(() => h.applications.prepare(h.current, selection, 'explicit')).toThrow();
  h.db.close();
});
it('indexed authority work stays bounded as settled application history grows', () => {
  const h = harness();
  for (let i = 0; i < 2000; i++) { const s = { ...snapshot(), sourceMessageId: `history-${i}`, threadId: `history-${i}` }; const app = h.applications.prepare(s, selection, 'explicit'); h.applications.claim(app); }
  const plan = h.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM owner_limit_applications WHERE source_key=?').all('thread:source');
  expect(JSON.stringify(plan)).toContain('INDEX'); expect(JSON.stringify(plan)).not.toContain('SCAN');
  const app = h.applications.prepare(h.current, selection, 'automatic');
  expect(h.applications.get('thread', 'source')).toEqual(app);
  expect(h.applications.pending('thread')).toHaveLength(1);
  h.db.close();
});

it('a private continuation ticket cannot become a generic unlimited service claim', async () => {
  const { wiring } = await import('./decision-wiring/fixture.ts');
  const h = harness();
  h.tickets.transferAtLimit(h.ticket, h.event, h.source, true);
  const { verifyDecisionClaim } = wiring(['verifyDecisionClaim'], {
    decisionHttpProofs: new WeakMap(), internalCapabilities: { isActive: () => false },
    decisionRecoveryOpen: false, readContinuation: () => ({ level: 'unlimited' }),
  });
  expect(verifyDecisionClaim(h.ticket)).toBeUndefined();
  expect(verifyDecisionClaim({ ...h.ticket })).toBeUndefined();
  h.db.close();
});

it('a failed durable Stop still refuses every subsequent dispatch in the current process', () => {
  const h = harness(); const app = h.applications.prepare(h.current, selection, 'explicit');
  h.db.exec("CREATE TRIGGER fail_stop BEFORE INSERT ON owner_limit_epochs BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  expect(() => h.applications.cancel('thread')).toThrow('fixture storage failure');
  expect(h.applications.current(app)).toBe(false); expect(h.applications.claim(app)).toBe(false);
  h.db.close();
});

it('the limit event fold requires the exact bound provider source and complete terminal identity', async () => {
  const { LimitTurns } = await import('./limit-continuation.ts');
  const turns = new LimitTurns(), source = {};
  turns.begin({ botId:'bot',threadId:'thread',generation:'generation',providerInstanceId:'primary',selection:{instanceId:'primary',model:'fixture'},engineName:'Fixture',driverKind:'claudeAgent',viaGateway:false,sendIds:['send'],sourceMessageId:'source',sourceText:'fixture',ownerDirect:true,routine:false,onFailover:false,activity:false });
  turns.bindProvider('thread','generation','primary',source);
  const started={type:'turn.started',threadId:'thread',providerInstanceId:'primary',turnId:'provider-turn'};
  turns.observe(started,{});expect(turns.get('thread')!.providerTurnId).toBeUndefined();
  turns.observe(started,source);
  turns.observe({type:'runtime.error',threadId:'thread',providerInstanceId:'primary',turnId:'provider-turn',message:'unbound error'},{});
  expect(turns.get('thread')!.errorText).toBeUndefined();
  expect(turns.settle('thread',undefined,'primary',source)).toBeUndefined();
  expect(turns.settle('thread','provider-turn','other',source)).toBeUndefined();
  expect(turns.settle('thread','provider-turn','primary',{})).toBeUndefined();
  expect(turns.settle('thread','provider-turn','primary',source)?.sourceMessageId).toBe('source');
});

it('a stopped idle card keeps its original epoch across restart and cannot be reauthorized by a later level raise', () => {
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE approval_records(id TEXT PRIMARY KEY,thread_id TEXT,service TEXT,queue_kind TEXT,state TEXT)');
  const applications=new LimitApplications(()=>db);applications.epoch('thread');
  db.exec("INSERT INTO approval_records VALUES('card','thread','event-limit',NULL,'open')");
  expect(applications.cardCurrent('card','thread')).toBe(true);
  applications.cancel('thread');
  expect(applications.cardCurrent('card','thread')).toBe(false);
  const restarted=new LimitApplications(()=>db);
  expect(restarted.cardCurrent('card','thread')).toBe(false);
  expect(db.prepare("SELECT epoch FROM owner_limit_card_epochs WHERE approval_id='card'").get()?.epoch).toBe(0);
  db.close();
});
it('missing admission fields cannot mint an owner continuation', () => {
  expect(new OwnerLimitContinuations(()=>true).capture(snapshot(),{} as never)).toBeUndefined();
});
