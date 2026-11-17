import { managedBotProfile } from './bot-management.ts';
import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { Store } from './store.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { BotOutsideWrites } from './bot-outside-writes.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
it('Susan and Sable Trainee persist staged, then activate together only on clean settlement', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const writes = new BotOutsideWrites(store, () => null);
  writes.ledger.open('G', 'T', 'fuigo', 'own'); writes.ledger.bind('G', 'P');
  for (const name of ['Susan', 'Sable Trainee']) {
    const staged = writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: true, fullAccess: false, noLimits: false, lead: false });
    const b = store.createBot({ name }, { staged, seedMessages: false }); writes.record(b.id);
  }
  expect(store.activeBots()).toHaveLength(0);
  writes.settle('G', { ok: true, readsComplete: true, stopReason: null });
  expect(store.activeBots().map(b => b.name).sort()).toEqual(['Sable Trainee', 'Susan']);
  expect(new Store(() => ({ instanceId: 'fixture', model: 'model' })).activeBots()).toHaveLength(2);
});
it('a late mark prevents activation and a stale review receipt changes nothing', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const writes = new BotOutsideWrites(store, () => null);
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  const b = store.createBot({ name: 'Susan' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) }); writes.record(b.id);
  const old = writes.review(b.id);
  writes.ledger.mark('T', 'web'); writes.settle('G', { ok: true, readsComplete: true, stopReason: null });
  expect(b.staged?.reason).toBe('outside');
  expect(() => writes.apply([{ id: b.id, digest: old.digest }], 'phone-app', 'bot-review-phone@1')).toThrow(/changed/i);
  const live = writes.review(b.id);
  expect(() => writes.apply([{ id: b.id, digest: live.digest }], 'cloud-phone', 'bot-review-phone@1')).toThrow(/computer|app/i);
  writes.apply([{ id: b.id, digest: live.digest }], 'phone-app', 'bot-review-phone@1');
  expect(store.activeBot(b.id)).not.toBeNull();
});
it('a write already staged outside at commit is never silently registered for clean settlement', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const writes = new BotOutsideWrites(store, () => null); writes.ledger.open('G', 'T', 'fuigo', 'own');
  const bot = store.createBot({ name: 'Outside' }, { staged: writes.staging('G', 'T', 'chief', 'outside', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }), seedMessages: false }); writes.record(bot.id);
  writes.settle('G', { ok: true, readsComplete: true, stopReason: null });
  expect(bot.staged?.reason).toBe('outside');
});
it('held work survives until the durable activation and is delivered in order', async () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const delivered: string[] = [];
  const writes = new BotOutsideWrites(store, () => null, { dispatch: (bot, work) => { expect(new Store(() => bot.modelSelection).activeBot(bot.id)).not.toBeNull(); delivered.push(work.text); } });
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  const bot = store.createBot({ name: 'Susan' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) }); writes.record(bot.id);
  for (const text of ['first', 'second']) expect(writes.hold(bot.id, { kind: 'delegate', fromBotId: 'chief', fromThreadId: 'T', text })).toBe(true);
  expect(delivered).toEqual([]);
  writes.settle('G', { ok: true, readsComplete: true, stopReason: null });
  await writes.flush(); expect(delivered).toEqual(['first', 'second']);
});
it('discard drops held work with a sender note and release leaves an unfinished write for review', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const notes: string[] = [];
  const writes = new BotOutsideWrites(store, () => null, { dropped: (_work, text) => { notes.push(text); } });
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  const bot = store.createBot({ name: 'Susan' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) }); writes.record(bot.id);
  writes.hold(bot.id, { kind: 'ask', fromBotId: 'chief', fromThreadId: 'T', text: 'hello' });
  writes.release('G'); expect(bot.staged?.reason).toBe('unsettled');
  writes.discard(bot.id); expect(store.bot(bot.id)).toBeNull(); expect(notes).toEqual(['Susan was discarded, so the work you handed it did not run.']);
});
it('two new leads never activate together at clean settlement', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const writes = new BotOutsideWrites(store, () => null);
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  for (const name of ['Susan', 'Sable']) { const bot = store.createBot({ name, section: 'Studio' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: false, fullAccess: false, noLimits: false, lead: true }) }); writes.record(bot.id); }
  writes.settle('G', { ok: true, readsComplete: true, stopReason: null });
  expect(store.activeBots().filter(b => b.chiefOfStaff)).toHaveLength(0);
});
it('an intervening owner profile edit invalidates automatic settlement', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const writes = new BotOutsideWrites(store, () => null);
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  const bot = store.createBot({ name: 'Susan' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: true, fullAccess: false, noLimits: false, lead: false }) }); writes.record(bot.id);
  store.patchBot(bot.id, { description: 'Owner edited the instructions' });
  writes.settle('G', { ok: true, readsComplete: true, stopReason: null }); expect(bot.staged).toBeDefined();
});
it('pending revisions keep live fields and approvals visible until the owner applies the exact display', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const writes = new BotOutsideWrites(store, () => null);
  const bot = store.createBot({ name: 'Sable' });
  const before = managedBotProfile(bot);
  writes.revision(bot.id, 'G', bot.threadId, bot.id, 'outside', { instructions: 'Proposed words' }, before.revision);
  expect(bot.description).not.toBe('Proposed words'); const seen = writes.review(bot.id);
  store.patchBot(bot.id, { alwaysAllow: ['tool:first'] });
  expect(() => writes.apply([{ id: bot.id, digest: seen.digest }], 'computer', 'bot-review@1')).toThrow(/changed/);
  const latest = writes.review(bot.id); writes.apply([{ id: bot.id, digest: latest.digest }], 'computer', 'bot-review@1');
  expect(bot.description).toBe('Proposed words'); expect(bot.pendingRevision).toBeUndefined(); expect(bot.alwaysAllow).toEqual(['tool:first']);
});
it('review notification opens after outside settlement and closes only after applying the current display', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const notifications: string[] = [];
  const writes = new BotOutsideWrites(store, () => null, { reviewNeeded: b => notifications.push(`review:${b.id}`), reviewed: b => notifications.push(`closed:${b.id}`) });
  writes.ledger.open('G', 'T', 'fuigo', 'own');
  const bot = store.createBot({ name: 'Susan' }, { staged: writes.staging('G', 'T', 'chief', 'turn-open', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) }); writes.record(bot.id);
  expect(notifications).toEqual([]); writes.ledger.mark('T', 'web'); writes.settle('G', {ok:true, readsComplete:true, stopReason:null});
  expect(notifications).toEqual([`review:${bot.id}`]); writes.apply([{id:bot.id,digest:writes.review(bot.id).digest}], 'computer', 'bot-review@1');
  expect(notifications).toEqual([`review:${bot.id}`, `closed:${bot.id}`]);
});
it('staged bots cannot acquire a live level, task grant or lead outside Review', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' })); const writes = new BotOutsideWrites(store, () => null);
  const bot = store.createBot({ name: 'Susan' }, { staged: writes.staging('G','T','chief','outside',{autoApprove:false,fullAccess:false,noLimits:false,lead:false}) });
  store.setPermissionLevel(bot.id, { flags: { autoApprove: true, fullAccess: true, noLimits: true } });
  store.patchTask(bot.id, bot.threadId, { autoApprove:true, alwaysAllow:['tool:unsafe'] }); store.setChiefOfStaff(bot.id);
  expect(bot.autoApprove).toBe(false); expect(bot.tasks![0].alwaysAllow ?? []).toEqual([]); expect(bot.chiefOfStaff).not.toBe(true);
});
