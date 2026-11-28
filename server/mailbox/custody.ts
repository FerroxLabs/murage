import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Message } from "../store.ts";
import { storedJson } from "../transcript-seq.ts";
import { MAILBOX_PLACEHOLDER, project } from "./projection.ts";

/** W's sealed file custody ledger and its walk cursor (media-custody.ts), created with the rest of custody and empty until a seal. */
export const MAILBOX_SEALED_MEDIA_DDL = `
    CREATE TABLE IF NOT EXISTS mailbox_sealed_media (thread_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (thread_id, name));
    CREATE TABLE IF NOT EXISTS mailbox_sealed_media_cursor (thread_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
  `;

export function initializeMailboxCustody(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox_sealed_threads (
      thread_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'deleted')),
      cursor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mailbox_sealed_rows (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    );
  `);
  db.exec(MAILBOX_SEALED_MEDIA_DDL);
}

const lookups = new WeakMap<DatabaseSync, StatementSync>();
export function mailboxSealState(db: DatabaseSync, threadId: string): "pending" | "complete" | "deleted" | undefined {
  let lookup = lookups.get(db);
  if (!lookup) {
    lookup = db.prepare("SELECT state FROM mailbox_sealed_threads WHERE thread_id=?");
    lookups.set(db, lookup);
  }
  const state = lookup.get(threadId)?.state;
  if (state === undefined || state === "pending" || state === "complete" || state === "deleted") return state;
  throw new Error("Invalid mailbox seal state");
}

export function mailboxSealed(db: DatabaseSync, threadId: string): boolean {
  try { return mailboxSealState(db, threadId) !== undefined; }
  catch { return true; }
}

export function genericMailboxMessage(db: DatabaseSync, threadId: string, message: Message): Message {
  return mailboxSealed(db, threadId) ? project(message) : message;
}

// Store splices only rewrite lineage on already projected rows. Keep every original content field when they do.
export function mailboxMessageForRewrite(db: DatabaseSync, threadId: string, message: Message): Message {
  if (!message.sealed) return message;
  const held = db.prepare("SELECT json FROM mailbox_sealed_rows WHERE thread_id=? AND message_id=?").get(threadId, message.id)
    ?? db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=? AND json_extract(json, '$.card.approvalId') IS NOT NULL").get(threadId, message.id);
  if (!held) throw new Error("Sealed row unavailable");
  const { sealed: _marker, text, ...patch } = message;
  return { ...JSON.parse(String(held.json)) as Message, ...patch, ...(text === MAILBOX_PLACEHOLDER ? {} : { text }) };
}

export function sealSplit(db: DatabaseSync, threadId: string, message: Message): { stored: Message; generic: Message } {
  const state = mailboxSealState(db, threadId);
  if (state === undefined) return { stored: message, generic: message };
  if (state !== "complete") throw new Error("Email privacy setup hasn't finished; this conversation is paused.");
  if (!db.isTransaction) throw new Error("Mailbox writes require a transaction");
  const generic = project(message);
  if (message.card?.approvalId) return { stored: message, generic };
  copyMailboxMessage(db, threadId, message);
  return { stored: generic, generic };
}

export function copyMailboxMessage(db: DatabaseSync, threadId: string, message: Message) {
  db.prepare(`
    INSERT INTO mailbox_sealed_rows(thread_id, message_id, json) VALUES (?, ?, ?)
    ON CONFLICT(thread_id, message_id) DO UPDATE SET json=excluded.json
  `).run(threadId, message.id, storedJson(message));
}
