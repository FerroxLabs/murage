// M6 card store (owner: M6 lane). designs/settings-chat-1023/DESIGN.md section 4.
// One record per card. The one terminal path is settleSettingCard: a compare-and-set from OPEN to SETTLED in one
// transaction, idempotent for the same (outcome, changeId). No other code writes `state`.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { CardOutcome, JournalLookup, SettingCardRecord, WriterTarget } from "../../shared/settings-chat.ts";

export type Transaction = <T>(operation: (db: DatabaseSync) => T) => T;

export interface SettleResult { won: boolean; card: SettingCardRecord }

export interface NewCard {
  threadId: string;
  botId: string;
  /** The turn generation as internal-capabilities mints it (a string, randomUUID by default); stored and compared as TEXT. */
  generation: string;
  settingId: string;
  settingBot?: string;
  writerTarget: WriterTarget;
  reason: string;
}

const TABLE = "settings_chat_cards";
const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  card_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation TEXT NOT NULL,
  setting_id TEXT NOT NULL, setting_bot TEXT NOT NULL, writer_target TEXT NOT NULL, card_gen INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','SETTLED')), outcome TEXT, pending_change_id TEXT, change_id TEXT,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER)`;
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS ${TABLE}_key ON ${TABLE} (thread_id, setting_id, setting_bot, card_gen)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_turn ON ${TABLE} (thread_id, generation)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_change ON ${TABLE} (change_id)`,
];

type Row = Record<string, string | number | null>;
function toCard(row: Row): SettingCardRecord {
  return {
    cardId: String(row.card_id), threadId: String(row.thread_id), botId: String(row.bot_id), generation: String(row.generation),
    settingId: String(row.setting_id), ...(row.setting_bot ? { settingBot: String(row.setting_bot) } : {}),
    writerTarget: JSON.parse(String(row.writer_target)) as WriterTarget, cardGen: Number(row.card_gen),
    state: row.state === "SETTLED" ? "SETTLED" : "OPEN",
    ...(row.outcome ? { outcome: String(row.outcome) as CardOutcome } : {}),
    ...(row.pending_change_id ? { pendingChangeId: String(row.pending_change_id) } : {}),
    ...(row.change_id ? { changeId: String(row.change_id) } : {}),
    reason: String(row.reason), createdAt: Number(row.created_at),
    ...(row.settled_at != null ? { settledAt: Number(row.settled_at) } : {}),
  };
}

export interface CardStore {
  create(input: NewCard): SettingCardRecord;
  get(cardId: string): SettingCardRecord | undefined;
  /** The current counter for (threadId, id, bot); 0 when none. */
  currentGen(threadId: string, settingId: string, settingBot: string | undefined): number;
  showsInTurn(threadId: string, generation: string): number;
  setPending(cardId: string, changeId: string): boolean;
  settleSettingCard(cardId: string, outcome: CardOutcome, changeId?: string): SettleResult | undefined;
  /** The M6 reader find J1 calls for "You, from chat with <bot>" (design section 6). */
  cardByChangeId(changeId: string): { cardId: string; botId: string } | undefined;
  forThread(threadId: string): SettingCardRecord[];
  /** Read-repair (section 4): an OPEN card with a pendingChangeId that J0 has `saved` settles `changed`. */
  readRepair(card: SettingCardRecord, lookup: (changeId: string) => JournalLookup): SettingCardRecord;
}

export function openCardStore(db: DatabaseSync, tx: Transaction, now: () => number = Date.now): CardStore {
  db.exec(DDL);
  for (const ddl of INDEXES) db.exec(ddl);
  const get = (cardId: string) => {
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE card_id = ?`).get(cardId) as Row | undefined;
    return row ? toCard(row) : undefined;
  };
  const currentGen = (threadId: string, settingId: string, settingBot: string | undefined) =>
    Number((db.prepare(`SELECT COALESCE(MAX(card_gen), 0) AS g FROM ${TABLE} WHERE thread_id = ? AND setting_id = ? AND setting_bot = ?`)
      .get(threadId, settingId, settingBot ?? "") as Row).g);
  const settle = (cardId: string, outcome: CardOutcome, changeId?: string): SettleResult | undefined => tx((tdb) => {
    const result = tdb.prepare(`UPDATE ${TABLE} SET state = 'SETTLED', outcome = ?, change_id = ?, settled_at = ? WHERE card_id = ? AND state = 'OPEN'`)
      .run(outcome, changeId ?? null, now(), cardId);
    const card = get(cardId);
    if (!card) return undefined;
    // idempotent: the same outcome and changeId as the winner reads as a win; anything else loses and reads the winner
    const won = Number(result.changes) === 1 || (card.outcome === outcome && (card.changeId ?? undefined) === (changeId ?? undefined));
    return { won, card };
  });
  return {
    create(input) {
      return tx((tdb) => {
        const settingBot = input.settingBot ?? "";
        const open = tdb.prepare(`SELECT card_id FROM ${TABLE} WHERE thread_id = ? AND setting_id = ? AND setting_bot = ? AND state = 'OPEN'`)
          .all(input.threadId, input.settingId, settingBot) as Row[];
        for (const row of open) settle(String(row.card_id), "superseded");
        const cardId = randomUUID();
        tdb.prepare(`INSERT INTO ${TABLE} (card_id, thread_id, bot_id, generation, setting_id, setting_bot, writer_target, card_gen, state, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`)
          .run(cardId, input.threadId, input.botId, input.generation, input.settingId, settingBot, JSON.stringify(input.writerTarget),
            currentGen(input.threadId, input.settingId, input.settingBot) + 1, input.reason, now());
        return get(cardId)!;
      });
    },
    get,
    currentGen,
    showsInTurn: (threadId, generation) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE thread_id = ? AND generation = ?`).get(threadId, generation) as Row).n),
    setPending: (cardId, changeId) => tx((tdb) =>
      Number(tdb.prepare(`UPDATE ${TABLE} SET pending_change_id = ? WHERE card_id = ? AND state = 'OPEN'`).run(changeId, cardId).changes) === 1),
    settleSettingCard: settle,
    cardByChangeId(changeId) {
      const row = db.prepare(`SELECT card_id, bot_id FROM ${TABLE} WHERE (change_id = ? AND outcome = 'changed') OR pending_change_id = ? ORDER BY change_id IS NULL LIMIT 1`).get(changeId, changeId) as Row | undefined;
      return row ? { cardId: String(row.card_id), botId: String(row.bot_id) } : undefined;
    },
    forThread: (threadId) => (db.prepare(`SELECT * FROM ${TABLE} WHERE thread_id = ? ORDER BY created_at, card_gen`).all(threadId) as Row[]).map(toCard),
    readRepair(card, lookup) {
      if (card.state !== "OPEN" || !card.pendingChangeId) return card;
      const found = lookup(card.pendingChangeId);
      if (found.state !== "saved") return card;
      return settle(card.cardId, "changed", card.pendingChangeId)?.card ?? card;
    },
  };
}
