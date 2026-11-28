// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// M3 (email design r9 section 8): the account's local reader. Mail an IMAP fetch stored on this computer is read here, never from a
// remote service, so the bot's email_list / email_read answer from the mailbox tables only. Every read is one bounded indexed query;
// nothing here scans the whole inbox per turn (I-16). Sender headers are never treated as authenticated (no header trust, section 1).
import type { DatabaseSync } from "node:sqlite";
import type { FluxOutcome } from "../email/flux-email-client.ts";
import type { MailboxReadBinding, MailReadPort } from "./contract.ts";

/** Largest list page the tools ask for (email_list limit 1..25). */
export const MAILBOX_LIST_CAP = 25;
/** A thread answers at most this many messages, newest kept. */
export const MAILBOX_THREAD_CAP = 200;
/** Stored inbound messages kept per account; older ones are pruned in batches. */
export const MAILBOX_KEEP = 5000;
export const MAILBOX_PRUNE_BATCH = 500;
const FIELD_CAP = 1_000_000;

// The tables exist only once an account connects: the backup inspector refuses an archive carrying them until M3's staging
// omission lands (installation-database-snapshot.ts holds populated custody the same way), so an install without a mailbox keeps
// its backups unchanged and one with a mailbox fails closed instead of archiving mail.
export function initializeMailboxReader(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_accounts (
      bot_id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL UNIQUE,
      read_enabled INTEGER NOT NULL CHECK (read_enabled IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS mailbox_messages (
      inbox_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (inbox_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS mailbox_messages_by_time ON mailbox_messages(inbox_id, received_at DESC, message_id DESC);
    CREATE INDEX IF NOT EXISTS mailbox_messages_by_thread ON mailbox_messages(inbox_id, thread_id, received_at DESC, message_id DESC);
  `);
}

export interface InboundMail {
  id: string;
  threadId: string;
  receivedAt: number;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const addresses = (value: unknown): string[] | null =>
  value === undefined ? [] : Array.isArray(value) && value.length <= 100 && value.every(item => text(item, 320) !== null) ? value as string[] : null;

/** Stores one fetched message; the same id is stored once. Refuses (throws) a malformed or oversized message rather than storing a part. */
export function storeInbound(db: DatabaseSync, inboxId: string, mail: InboundMail): boolean {
  if (!hasMailboxTables(db)) throw new Error("Mailbox not connected");
  const id = text(mail.id, 200), threadId = text(mail.threadId, 200), from = text(mail.from, 320);
  const to = addresses(mail.to), cc = addresses(mail.cc);
  if (!id || !threadId || !from || !to || !cc || typeof mail.subject !== "string" || mail.subject.length > 4000
    || typeof mail.text !== "string" || mail.text.length > FIELD_CAP || !Number.isSafeInteger(mail.receivedAt) || mail.receivedAt < 0) {
    throw new Error("Mailbox message refused");
  }
  const json = JSON.stringify({ id, thread_id: threadId, direction: "inbound", from, to, cc, subject: mail.subject, text: mail.text, received_at: new Date(mail.receivedAt).toISOString() });
  return db.prepare("INSERT INTO mailbox_messages(inbox_id, message_id, thread_id, received_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(inbox_id, message_id) DO NOTHING")
    .run(inboxId, id, threadId, mail.receivedAt, json).changes === 1;
}

/** One bounded batch of the oldest messages past MAILBOX_KEEP; returns how many went. Callers repeat on a later tick. */
export function pruneInbound(db: DatabaseSync, inboxId: string, keep = MAILBOX_KEEP): number {
  return Number(db.prepare(`
    DELETE FROM mailbox_messages WHERE inbox_id=? AND message_id IN (
      SELECT message_id FROM mailbox_messages WHERE inbox_id=? ORDER BY received_at DESC, message_id DESC LIMIT ? OFFSET ?
    )
  `).run(inboxId, inboxId, MAILBOX_PRUNE_BATCH, Math.max(0, keep)).changes);
}

/** Connect's local half (M2 owns Test/Save): the bot's account row. */
export function saveMailboxAccount(db: DatabaseSync, botId: string, inboxId: string, readEnabled: boolean): void {
  initializeMailboxReader(db);
  db.prepare("INSERT INTO mailbox_accounts(bot_id, inbox_id, read_enabled) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET inbox_id=excluded.inbox_id, read_enabled=excluded.read_enabled")
    .run(botId, inboxId, readEnabled ? 1 : 0);
}

const hasMailboxTables = (db: DatabaseSync): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mailbox_accounts'").get());

export function mailboxAccount(db: DatabaseSync, botId: string): { inboxId: string; readEnabled: boolean } | undefined {
  if (!hasMailboxTables(db)) return undefined;
  const row = db.prepare("SELECT inbox_id, read_enabled FROM mailbox_accounts WHERE bot_id=?").get(botId);
  return row ? { inboxId: String(row.inbox_id), readEnabled: row.read_enabled === 1 } : undefined;
}

type Outcome = FluxOutcome<Record<string, unknown>>;
const ok = (body: Record<string, unknown>): Outcome => ({ kind: "ok", status: 200, body, keyId: "local-mailbox" });
const missing = (code: string): Outcome => ({ kind: "refused", status: 404, code, message: code, error: { error: { code, message: code } } as never, keyId: "local-mailbox" });
const parse = (row: Record<string, unknown>): Record<string, unknown> => JSON.parse(String(row.json)) as Record<string, unknown>;

/** The MailReadPort over the local tables. Outbound mail is not stored here (M4 owns the sent copy), so outbound lists are empty. */
export class LocalMailboxReader implements MailReadPort {
  private readonly db: () => DatabaseSync;
  constructor(db: () => DatabaseSync) { this.db = db; }

  async listMessages(_ref: unknown, inboxId: string, query: { direction?: "inbound" | "outbound"; thread_id?: string; since?: string; limit?: number } = {}) {
    if (query.direction === "outbound") return ok({ data: [] }) as never;
    const limit = Math.min(MAILBOX_LIST_CAP, Math.max(1, Math.trunc(query.limit ?? 10)));
    const since = query.since === undefined ? 0 : Date.parse(query.since);
    if (!Number.isFinite(since)) return ok({ data: [] }) as never;
    const rows = query.thread_id === undefined
      ? this.db().prepare("SELECT json FROM mailbox_messages WHERE inbox_id=? AND received_at>=? ORDER BY received_at DESC, message_id DESC LIMIT ?").all(inboxId, since, limit)
      : this.db().prepare("SELECT json FROM mailbox_messages WHERE inbox_id=? AND thread_id=? AND received_at>=? ORDER BY received_at DESC, message_id DESC LIMIT ?").all(inboxId, query.thread_id, since, limit);
    return ok({ data: rows.map(row => { const { text: body, ...summary } = parse(row); return { ...summary, preview: String(body ?? "").slice(0, 300) }; }) }) as never;
  }

  async getMessage(_ref: unknown, inboxId: string, messageId: string) {
    const row = this.db().prepare("SELECT json FROM mailbox_messages WHERE inbox_id=? AND message_id=?").get(inboxId, messageId);
    return (row ? ok(parse(row)) : missing("message_not_found")) as never;
  }

  async getThread(_ref: unknown, inboxId: string, threadId: string) {
    const rows = this.db().prepare("SELECT json FROM mailbox_messages WHERE inbox_id=? AND thread_id=? ORDER BY received_at DESC, message_id DESC LIMIT ?").all(inboxId, threadId, MAILBOX_THREAD_CAP);
    if (!rows.length) return missing("thread_not_found") as never;
    const messages = rows.map(parse).reverse();
    const participants = [...new Set(messages.flatMap(message => [message.from, ...(message.to as string[]), ...(message.cc as string[])]).filter(item => typeof item === "string"))];
    return ok({ id: threadId, subject: messages[0]!.subject, participants, messages }) as never;
  }
}

/** The binding EmailTools reads through (contract.ts), or undefined when this bot has no mailbox or the owner's read tick is off. */
export function localMailboxBinding(db: () => DatabaseSync, botId: string, seal: (threadId: string) => "pending" | "complete"): MailboxReadBinding | undefined {
  const account = mailboxAccount(db(), botId);
  if (!account?.readEnabled) return undefined;
  return { inboxId: account.inboxId, port: new LocalMailboxReader(db), seal };
}
