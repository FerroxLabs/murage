import { mkdirSync, readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { _resetPending, queueDelegation, handoffRow } from './delegations.ts';
import { _resetOwnerMigration } from './pending-delegations-schema.ts';
import { _resetDrainDiagnostics } from './shared-work.ts';
import { ownerWorld } from './testing/handoff-worlds.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { BotOutsideWrites } from './bot-outside-writes.ts';
import { Store } from './store.ts';
import type { HeldPeerAuthority } from './held-peer-authority.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); _resetDrainDiagnostics(); });
afterEach(() => { _resetPending(); _resetOwnerMigration(); closeDatabase(); });
it('a later source turn cannot replace the original held provenance; transfer retries queue once', () => {
  const w = ownerWorld();
  w.bus.turnOf = () => 'later-provider';
  const held: HeldPeerAuthority = { version: 1, handoffId: 'original-held', depth: 1, notOwnerAudience: true, unattended: true,
    eventId: 'original-event', routineAuthority: { permissionMode: 'ask', triggerSource: 'schedule' }, executionAudience: null, parentRequestId: null,
    coordination: { rootId: 'original-root', path: [w.from.id, w.target.id] },
    source: { botId: w.from.id, threadId: w.from.threadId, generation: 'original-generation', providerTurnId: 'original-provider' } };
  const prepared = vi.fn(() => 'owner' as const); w.bus.prepareDelegation = prepared;
  const item = { toBotId: w.target.id, message: 'Work', depth: held.depth, notOwnerAudience: held.notOwnerAudience, unattended: held.unattended,
    eventId: held.eventId!, routineAuthority: held.routineAuthority!, coordination: held.coordination };
  const first = queueDelegation(w.bus, w.from, item, 2, w.from.threadId, undefined, held);
  expect(queueDelegation(w.bus, w.from, item, 2, w.from.threadId, undefined, JSON.parse(JSON.stringify(held)))).toEqual(first);
  expect(prepared).toHaveBeenCalledTimes(1); expect(prepared.mock.calls[0]?.at(-1)).toEqual(held);
  const kept = JSON.parse(handoffRow(first.id!)!.item);
  expect(kept).toMatchObject({ senderTurnId: 'original-provider', depth: 1, notOwnerAudience: true, unattended: true, eventId: 'original-event', routineAuthority: held.routineAuthority, coordination: held.coordination });
  expect(w.store.messagesFor(w.from.threadId).find(row => row.id === kept.sourceMessageId)).toMatchObject({ turnId: 'original-provider' });
  expect(database().prepare('SELECT count(*) n FROM pending_delegations').get()).toMatchObject({ n: 1 });
});
it('activation durably transfers held work before dispatch, and boot resumes the same item', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source.indexOf('botOutsideWrites.recoverHeldWork()')).toBeGreaterThan(source.indexOf('void runAfterListen(['));
  expect(source).toContain('botOutsideWrites.recoverHeldWork(); await botOutsideWrites.flush();');

  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const writes = new BotOutsideWrites(store, () => null);
  const bot = store.createBot({ name: 'Held' }, { staged: writes.staging('G', 'T', 'chief', 'outside', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) });
  writes.hold(bot.id, { kind: 'assign', ref: 'request-original', fromBotId: 'chief', fromThreadId: 'T', text: 'Work' });
  writes.apply([{ id: bot.id, digest: writes.review(bot.id).digest }], 'computer', 'bot-review@1');
  const restarted = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  expect(restarted.activeBot(bot.id)?.pendingHeldWork).toEqual([expect.objectContaining({ ref: 'request-original' })]);
  const dispatch = vi.fn(); const resumed = new BotOutsideWrites(restarted, () => null, { dispatch });
  resumed.recoverHeldWork(); resumed.recoverHeldWork(); await resumed.flush();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(new Store(() => ({ instanceId: 'fixture', model: 'model' })).bot(bot.id)?.pendingHeldWork).toBeUndefined();
});
