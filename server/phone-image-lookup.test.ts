// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone image check (threadsReferencingAttachment, asked three times per remote GET /api/attachments/<name>) reads the
// attachment-name index, never every message: its cost does not grow with history, and it names the same threads the full read did.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import { closeMessageDb, insertMessage, storedMessage, threadsReferencingAttachment } from "./message-db.ts";
import { prepareRestoredDatabase } from "./restore-prep-core.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { indexAttachmentNamesChunk, readIndexState, writeIndexState } from "./transcript-backfill.ts";

const NAME = "0f1e2d3c-4b5a-4968-8776-655443322110.png";
const U = NAME.slice(0, 36);
const OTHER = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), ...extra });

// One row per way a message can mention the name: whether it is a reference (the shared definition, attachment-access.ts) and so
// whether its thread is named. The overlap rows are the ones the indexer files under an earlier uuid's 5-character extension.
const SHAPES: Array<{ thread: string; text: string; extra?: Partial<Message>; references: boolean }> = [
  { thread: "t-plain", text: `see ${NAME}`, references: true },
  { thread: "t-upper", text: `see ${NAME.toUpperCase()}`, references: true },
  { thread: "t-markdown", text: `![x](/api/attachments/${NAME})`, references: true },
  { thread: "t-attached", text: "photo", extra: { attachments: [{ kind: "image", path: `/data/attachments/${NAME}`, mime: "image/png" }] }, references: true },
  { thread: "t-longer-ext", text: `see ${U}.pngx`, references: true },
  { thread: "t-after-dot", text: `see ${OTHER}.${NAME}`, references: true },
  { thread: "t-after-png", text: `see ${OTHER}.png${NAME}`, references: true },
  { thread: "t-after-jpg", text: `see ${OTHER}.jpg${NAME}`, references: true },
  { thread: "t-after-gif", text: `see ${OTHER}.GIF${NAME}`, references: true },
  { thread: "t-after-jpeg", text: `see ${OTHER}.jpeg${NAME}`, references: true },
  { thread: "t-after-webp", text: `see ${OTHER}.webp${NAME}`, references: true },
  { thread: "t-tail", text: `see x${NAME}`, references: false },
  { thread: "t-after-xy", text: `see ${OTHER}.xy${NAME}`, references: false },
  { thread: "t-other-ext", text: `see ${U}.jpg`, references: false },
];
const EXPECTED = SHAPES.filter(s => s.references).map(s => s.thread).sort();

/** Every statement the lookup prepares on the message connection, and how many rows a LIKE examined. */
function observe(db: DatabaseSync) {
  const prepared: string[] = [];
  const original = db.prepare.bind(db);
  let likeRows = 0;
  db.function("like", { deterministic: true }, (pattern: unknown, value: unknown) => {
    likeRows++;
    return String(value ?? "").toLowerCase().includes(String(pattern).replace(/^%|%$/g, "").toLowerCase()) ? 1 : 0;
  });
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => { prepared.push(sql); return original(sql); };
  return {
    run<T>(work: () => T): { value: T; likeRows: number; scans: string[] } {
      prepared.length = 0; likeRows = 0;
      const value = work();
      const seen = likeRows;
      const scans = prepared.flatMap(sql => {
        const params = (sql.match(/\?/g) ?? []).map(() => "");
        return (original(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(r => r.detail).filter(d => /^SCAN /.test(d));
      });
      return { value, likeRows: seen, scans };
    },
    restore() { (db as { prepare: unknown }).prepare = original; },
  };
}

function fillHistory(db: DatabaseSync, rows: number, offset = 0): void {
  // ordinary history: other conversations, other pictures, written as the store writes rows (one JSON per row)
  const put = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', NULL, ?)");
  db.exec("BEGIN");
  for (let i = offset; i < offset + rows; i++) {
    const other = `${String(i % 100000).padStart(8, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}.png`;
    put.run(`t-history-${i % 50}`, `h-${i}`, i, JSON.stringify({ id: `h-${i}`, role: "user", kind: "text", text: `an older line ${i} with ![p](/api/attachments/${other}) and some words to give the row a real size`, at: i }));
  }
  db.exec("COMMIT");
}

describe("phone image lookup reads the attachment-name index", () => {
  beforeEach(() => {
    closeMessageDb();
    removeTempDirSync(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it.each([1_000, 20_000])("with %i history rows: no messages scan, no LIKE row, the same threads", (rows) => {
    for (const [i, shape] of SHAPES.entries()) insertMessage(shape.thread, msg(`m-${i}`, shape.text, shape.extra));
    const db = database();
    fillHistory(db, rows);
    while (indexAttachmentNamesChunk(db)) { /* the backfill reaches every row, as it does at startup */ }
    expect(readIndexState(db, "attachment_name").done).toBe(1);
    // a restart: the server's first read of the message database (long before a phone asks) reads the rare 42-character pointers, so the first
    // phone lookup after it reads nothing but keyed rows, with no background pass having reported yet
    closeMessageDb();
    storedMessage("t-plain", "m-0");
    const reopened = database();
    const seen = observe(reopened);
    try {
      const first = seen.run(() => threadsReferencingAttachment(NAME));
      expect(first.value.slice().sort()).toEqual(EXPECTED);
      expect(first.likeRows).toBe(0);
      expect(first.scans).toEqual([]);
      const looked = seen.run(() => threadsReferencingAttachment(NAME));
      expect(looked.value.slice().sort()).toEqual(EXPECTED);
      expect(looked.likeRows).toBe(0);
      expect(looked.scans).toEqual([]);
      // a reference written after that read is found too
      insertMessage("t-late", msg("late", `see ${OTHER}.png${NAME}`));
      const late = seen.run(() => threadsReferencingAttachment(NAME));
      expect(late.value.slice().sort()).toEqual([...EXPECTED, "t-late"].sort());
      expect(late.scans).toEqual([]);
      const missing = seen.run(() => threadsReferencingAttachment("ffffffff-ffff-4fff-8fff-ffffffffffff.png"));
      expect(missing.value).toEqual([]);
      expect(missing.likeRows).toBe(0);
      expect(missing.scans).toEqual([]);
      // the old LIKE matched without regard to case: a request in another case is shown the same
      const upper = seen.run(() => threadsReferencingAttachment(`${U.toUpperCase()}.png`));
      expect(upper.value.slice().sort()).toEqual([...EXPECTED, "t-late"].sort());
      expect(upper.likeRows).toBe(0);
      expect(upper.scans).toEqual([]);
    } finally { seen.restore(); }
  });

  it.each([1_000, 20_000])("with %i history rows: a remote request for a name that is not <uuid>.<ext> reads no message", (rows) => {
    insertMessage("t-legacy", msg("legacy", "see abc-123.png"));
    const db = database();
    fillHistory(db, rows);
    while (indexAttachmentNamesChunk(db)) { /* indexed, as at startup */ }
    const seen = observe(db);
    try {
      for (const name of ["abc-123.png", "chart.png", "ffffffff-ffff-4fff-8fff-ffffffffffff-x.png"]) {
        const asked = seen.run(() => threadsReferencingAttachment(name, { remote: true }));
        expect(asked.value, name).toEqual([]);
        expect(asked.likeRows, name).toBe(0);
        expect(asked.scans, name).toEqual([]);
      }
      // the desktop's own callers keep the full read for such a name
      expect(threadsReferencingAttachment("abc-123.png")).toEqual(["t-legacy"]);
    } finally { seen.restore(); }
  });

  it("an index that completes after the open reads the pointers in the step that completes it, so no phone lookup after it scans", () => {
    insertMessage("t-start", msg("start", "hello"));
    for (const [i, shape] of SHAPES.entries()) insertMessage(shape.thread, msg(`m-${i}`, shape.text, shape.extra));
    const db = database();
    writeIndexState(db, "attachment_name", { done: 0, cursor: 0, skipped: 0 });
    expect(threadsReferencingAttachment(NAME).slice().sort()).toEqual(EXPECTED); // the full read answers meanwhile
    while (indexAttachmentNamesChunk(db)) { /* the pass reaches every row */ }
    const seen = observe(db);
    try {
      const first = seen.run(() => threadsReferencingAttachment(NAME));
      expect(first.value.slice().sort()).toEqual(EXPECTED);
      expect(first.scans).toEqual([]);
    } finally { seen.restore(); }
  });

  it("while the backfill is not done, a remote request for a uuid name reads the index only: no message is read", () => {
    insertMessage("t-start", msg("start", "hello"));
    const db = database();
    fillHistory(db, 5_000);
    // rows from before the index existed are in messages and not in attachment_name; rows written since are indexed by their writer
    const old = msg("old", `see ${NAME}`);
    db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?)").run("t-old", old.id, old.at, old.text ?? null, JSON.stringify(old));
    insertMessage("t-new", msg("new", `see ${NAME}`));
    writeIndexState(db, "attachment_name", { done: 0, cursor: 0, skipped: 0 });
    const seen = observe(db);
    try {
      const asked = seen.run(() => threadsReferencingAttachment(NAME, { remote: true }));
      expect(asked.value).toEqual(["t-new"]);
      expect(asked.likeRows).toBe(0);
      expect(asked.scans).toEqual([]);
      // the desktop's own callers still read every row until the pass is done
      expect(threadsReferencingAttachment(NAME).slice().sort()).toEqual(["t-new", "t-old"]);
    } finally { seen.restore(); }
  });

  it("a restore that rewrites a row indexes the names the rewrite brings out, so the lookup still finds its thread", () => {
    insertMessage("t-start", msg("start", "hello"));
    const db = database();
    // a stored row whose uuid has an escaped character (the f is written \u0066): the text on disk does not contain the name, the decoded message does
    const escaped = `${NAME[0]}\\u0066${NAME.slice(2)}`;
    const row = msg("m-escaped", `see ${NAME}`);
    db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?)")
      .run("t-restored", row.id, row.at, row.text ?? null, JSON.stringify(row).replace(NAME, escaped));
    while (indexAttachmentNamesChunk(db)) { /* the backfill reaches every row */ }
    expect(readIndexState(db, "attachment_name").done).toBe(1);
    expect(threadsReferencingAttachment(NAME)).toEqual([]);
    const home = mkdtempSync(join(tmpdir(), "murage-phoneimg-"));
    try {
      prepareRestoredDatabase(db, { generation: "g1", profile: "same-home", quarantineId: "q1", modifications: [], state: home, files: new Set(), sharingBots: [], sharingGroups: [], botIds: new Set(), persistRosters: () => {} });
    } finally { removeTempDirSync(home); }
    expect(threadsReferencingAttachment(NAME)).toEqual(["t-restored"]);
  });

  it("before the backfill is done, and for a name the index does not hold, the full read still answers the same", () => {
    // rows from before the index existed: in messages, not yet in attachment_name
    insertMessage("t-start", msg("start", "hello"));
    const db = database();
    const put = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', ?, ?)");
    for (const [i, shape] of [...SHAPES.entries(), [SHAPES.length, { thread: "t-legacy", text: "see abc-123.png" }] as const]) {
      const row = msg(`m-${i}`, shape.text, "extra" in shape ? shape.extra : {});
      put.run(shape.thread, row.id, row.at, row.text ?? null, JSON.stringify(row));
    }
    writeIndexState(db, "attachment_name", { done: 0, cursor: 0, skipped: 0 });
    expect(threadsReferencingAttachment(NAME).slice().sort()).toEqual(EXPECTED);
    expect(threadsReferencingAttachment("abc-123.png")).toEqual(["t-legacy"]);
  });
});
