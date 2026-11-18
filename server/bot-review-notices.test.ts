import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { Store } from './store.ts';
import { BotOutsideWrites } from './bot-outside-writes.ts';
import { botReviewNotice, closeBotReviewNotice } from './bot-review-notices.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { indexKeyedCardsChunk, readIndexState, writeIndexState } from './transcript-backfill.ts';
import { PERMISSION_CARD_KEYS } from '../shared/permission-card.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
it('staged review is navigation only, deduplicates across reload, and closes after owner review', () => {
  const selection = () => ({ instanceId: 'fixture', model: 'model' });
  const store = new Store(selection);
  const writes = new BotOutsideWrites(store, () => null, { reviewed: bot => closeBotReviewNotice(store, bot) });
  const bot = store.createBot({ name: 'Pending operator' }, { seedMessages: false,
    staged: writes.staging('generation', 'owner-thread', 'chief', 'outside', { autoApprove: true, fullAccess: false, noLimits: false, lead: false }) });
  const notice = botReviewNotice(store, bot)!;
  expect(notice.card?.botReviewId).toBe(bot.id);
  expect(notice.card?.options).toEqual([]);
  for (const key of [...PERMISSION_CARD_KEYS, 'tool', 'approvalId']) expect(notice.card).not.toHaveProperty(key);
  expect(bot.autoApprove).toBe(false);
  expect(bot.staged?.intended.autoApprove).toBe(true);
  expect(botReviewNotice(new Store(selection), bot)).toBeUndefined();
  const review = writes.review(bot.id);
  writes.apply([{ id: bot.id, digest: review.digest }], 'computer', 'bot-review@1');
  expect(store.bot(bot.id)?.staged).toBeUndefined();
  expect(store.bot(bot.id)?.autoApprove).toBe(true);
  expect(store.messageById(bot.threadId, notice.id)?.card?.answered).toBe('reviewed');
});
it('an unrecorded permission card is still refused', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  const bot = store.createBot({ name: 'Guard fixture' }, { seedMessages: false });
  expect(() => store.appendMessage(bot.threadId, { role: 'bot', kind: 'options', card: { title: 'Review fixture', subtitle: 'Unrecorded approval', options: [], requestId: 'unrecorded', tool: 'review_bot' } })).toThrow('card-without-approval');
});

for (const action of ['deduplicates', 'closes'] as const) it(`a persisted pre-index review notice ${action} after upgrade`, () => {
  const selection = () => ({ instanceId: 'fixture', model: 'model' });
  const store = new Store(selection);
  const writes = new BotOutsideWrites(store, () => null, { reviewed: bot => closeBotReviewNotice(store, bot) });
  const bot = store.createBot({ name: 'Legacy operator' }, { seedMessages: false,
    staged: writes.staging('generation', 'owner-thread', 'chief', 'outside', { autoApprove: true, fullAccess: false, noLimits: false, lead: false }) });
  const legacy = { id: 'legacy-review', at: 1, role: 'bot', kind: 'options', card: {
    requestId: `bot-review-${bot.id}`, botReviewId: bot.id, tool: 'review_bot', options: ['Review'],
    title: 'Legacy operator is waiting for your review', subtitle: 'Read the full bot setup before switching it on.',
  } };
  // Seed an older installation's row before its approval insert guard existed.
  const db = database();
  const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'approval_card_insert'").get()!.sql);
  db.exec('DROP TRIGGER approval_card_insert');
  try {
    db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)')
      .run(bot.threadId, legacy.id, legacy.at, legacy.role, legacy.kind, JSON.stringify(legacy));
  } finally { db.exec(trigger); }
  db.prepare('INSERT INTO open_card(thread_id,id) VALUES(?,?)').run(bot.threadId, legacy.id);
  for (const name of ['open_card', 'keyed_card']) writeIndexState(db, name, { done: 1, cursor: 1, skipped: 0 });
  expect(db.prepare("SELECT 1 FROM keyed_card WHERE family = 'botReview'").get()).toBeUndefined();
  db.prepare("DELETE FROM transcript_index_state WHERE name = 'bot_review_v1'").run();
  closeDatabase();
  const reloaded = new Store(selection);
  expect(reloaded.messageById(bot.threadId, legacy.id)?.card).toEqual(legacy.card);
  if (action === 'deduplicates') {
    expect(botReviewNotice(reloaded, reloaded.bot(bot.id)!)).toBeUndefined();
    expect(database().prepare('SELECT count(*) AS n FROM messages WHERE thread_id = ?').get(bot.threadId)!.n).toBe(1);
  } else {
    const reviewWrites = new BotOutsideWrites(reloaded, () => null, { reviewed: reviewed => closeBotReviewNotice(reloaded, reviewed) });
    const review = reviewWrites.review(bot.id);
    reviewWrites.apply([{ id: bot.id, digest: review.digest }], 'computer', 'bot-review@1');
    expect(reloaded.bot(bot.id)?.autoApprove).toBe(true);
    expect(reloaded.bot(bot.id)?.staged).toBeUndefined();
    expect(reloaded.messageById(bot.threadId, legacy.id)?.card).toEqual({ ...legacy.card, answered: 'reviewed' });
    expect(reloaded.openRequestCardRows(bot.threadId)).toEqual([]);
  }
});

for (const globalDone of [0, 1]) it(`startup finds a legacy review beyond both scan caps with global index done=${globalDone}`, () => {
  const selection = () => ({ instanceId: 'fixture', model: 'model' });
  const store = new Store(selection);
  const writes = new BotOutsideWrites(store, () => null);
  const bot = store.createBot({ name: 'Old operator' }, { seedMessages: false,
    staged: writes.staging('generation', 'owner-thread', 'chief', 'outside', { autoApprove: true, fullAccess: false, noLimits: false, lead: false }) });
  const legacy = { id: 'old-review', at: 1, role: 'bot', kind: 'options', card: {
    requestId: `bot-review-${bot.id}`, botReviewId: bot.id, tool: 'review_bot', options: ['Review'],
    title: 'Old review', subtitle: 'Review before switching on.',
  } };
  const db = database();
  const trigger = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'approval_card_insert'").get()!.sql);
  db.exec('DROP TRIGGER approval_card_insert');
  try {
    db.exec('BEGIN');
    const add = db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)');
    add.run(bot.threadId, legacy.id, legacy.at, legacy.role, legacy.kind, JSON.stringify(legacy));
    const open = db.prepare('INSERT INTO open_card(thread_id,id) VALUES(?,?)');
    open.run(bot.threadId, legacy.id);
    for (let i = 0; i < 10_001; i++) {
      const row = { id: `filler-${i}`, at: i + 2, role: 'bot', kind: 'options', card: { requestId: `filler-${i}`, options: [] } };
      add.run(bot.threadId, row.id, row.at, row.role, row.kind, JSON.stringify(row));
      open.run(bot.threadId, row.id);
    }
    db.exec('COMMIT');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.exec(trigger); }
  writeIndexState(db, 'open_card', { done: 1, cursor: 10_002, skipped: 0 });
  writeIndexState(db, 'keyed_card', { done: globalDone, cursor: 0, skipped: 0 });
  db.prepare("DELETE FROM transcript_index_state WHERE name = 'bot_review_v1'").run();
  expect(store.cardForRequest(bot.threadId, legacy.card.requestId)).toBeUndefined();
  closeDatabase();
  const reloaded = new Store(selection);
  expect(reloaded.keyedCards(bot.threadId, 'botReview', bot.id).map(row => row.id)).toEqual([legacy.id]);
  expect(readIndexState(database(), 'bot_review_v1').done).toBe(1);
  const scan = vi.spyOn(reloaded, 'cardForRequest').mockImplementation(() => { throw new Error('legacy scan is forbidden'); });
  try {
    const count = () => database().prepare('SELECT count(*) AS n FROM messages WHERE thread_id = ?').get(bot.threadId)!.n;
    const before = count();
    expect(botReviewNotice(reloaded, reloaded.bot(bot.id)!)).toBeUndefined();
    expect(count()).toBe(before);
    const reviewWrites = new BotOutsideWrites(reloaded, () => null, { reviewed: reviewed => closeBotReviewNotice(reloaded, reviewed) });
    const review = reviewWrites.review(bot.id);
    reviewWrites.apply([{ id: bot.id, digest: review.digest }], 'computer', 'bot-review@1');
    expect(reloaded.bot(bot.id)?.autoApprove).toBe(true);
    expect(reloaded.bot(bot.id)?.staged).toBeUndefined();
    expect(reloaded.messageById(bot.threadId, legacy.id)?.card).toEqual({ ...legacy.card, answered: 'reviewed' });
    expect(reloaded.keyedCards(bot.threadId, 'botReview', bot.id)).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); }
});

it('review indexing commits bounded chunks, resumes after failure and is idempotent', () => {
  const db = database();
  db.prepare("DELETE FROM transcript_index_state WHERE name = 'bot_review_v1'").run();
  const add = db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)');
  for (const id of ['first', 'middle', 'before-failure', 'last']) {
    const row = { id, at: 1, role: 'bot', kind: 'options', card: { botReviewId: id, options: [] } };
    add.run('legacy-thread', id, 1, row.role, row.kind, JSON.stringify(row));
  }
  db.prepare("INSERT INTO keyed_card(thread_id,family,key,id) VALUES('legacy-thread','botReview','first','first')").run();
  expect(indexKeyedCardsChunk(db, 2, 'bot_review_v1')).toBe(true);
  expect(readIndexState(db, 'bot_review_v1')).toEqual({ done: 0, cursor: 2, skipped: 0 });
  expect(db.prepare("SELECT key FROM keyed_card WHERE family = 'botReview' ORDER BY key").all()).toEqual([{ key: 'first' }, { key: 'middle' }]);
  db.exec("CREATE TRIGGER fail_review_index BEFORE INSERT ON keyed_card WHEN NEW.family = 'botReview' AND NEW.key = 'last' BEGIN SELECT RAISE(ABORT, 'index write failed'); END");
  try { expect(() => indexKeyedCardsChunk(db, 2, 'bot_review_v1')).toThrow('index write failed'); }
  finally { db.exec('DROP TRIGGER fail_review_index'); }
  expect(readIndexState(db, 'bot_review_v1')).toEqual({ done: 0, cursor: 2, skipped: 0 });
  expect(db.prepare("SELECT 1 FROM keyed_card WHERE family = 'botReview' AND key = 'before-failure'").get()).toBeUndefined();
  closeDatabase();
  const reopened = database();
  expect(readIndexState(reopened, 'bot_review_v1')).toEqual({ done: 1, cursor: 4, skipped: 0 });
  expect(reopened.prepare("SELECT key FROM keyed_card WHERE family = 'botReview' ORDER BY key").all()).toEqual([{ key: 'before-failure' }, { key: 'first' }, { key: 'last' }, { key: 'middle' }]);
  expect(indexKeyedCardsChunk(reopened, 2, 'bot_review_v1')).toBe(false);
  expect(reopened.prepare("SELECT count(*) AS n FROM keyed_card WHERE family = 'botReview'").get()!.n).toBe(4);
});
