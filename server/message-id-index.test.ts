// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// messages(id) (message-id-index.ts): a source named by its id alone is one index seek, never a scan of the messages table. A new file gets the
// index with its schema; a file with history gets it from the idle-window optional build; the 1.0.2 downgrade takes it away again.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { buildOptionalIndexOffThread } from "./memory/optional-index.ts";
import { MESSAGE_ID_INDEX, MESSAGE_ID_OPTIONAL_INDEX, downgradeMessageIdIndexTo102, messageIdIndexReady } from "./message-id-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const BY_ID = "SELECT thread_id FROM messages WHERE id=?";
const plan = (db: DatabaseSync) => (db.prepare(`EXPLAIN QUERY PLAN ${BY_ID}`).all("m1") as Array<{ detail: string }>).map(row => row.detail);

it("a new file: the lookup of a message by id alone searches messages_id, it never scans the table", () => {
  const db = database();
  expect(messageIdIndexReady(db)).toBe(true);
  const detail = plan(db);
  expect(detail.some(line => line.includes(`INDEX ${MESSAGE_ID_INDEX}`) && line.startsWith("SEARCH"))).toBe(true);
  expect(detail.some(line => line.startsWith("SCAN"))).toBe(false);
});

it("a file with history: a scan before the idle build, one seek after it; the 1.0.2 downgrade drops the index", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
    const put = db.prepare("INSERT INTO messages VALUES(?,?,1,'user','text','x','{}')");
    for (let i = 0; i < 200; i++) put.run(`t${i % 7}`, `m${i}`);
    expect(plan(db).some(line => line.startsWith("SCAN"))).toBe(true);
    expect(await buildOptionalIndexOffThread(db, MESSAGE_ID_OPTIONAL_INDEX, { inline: true })).toBe(true);
    expect(plan(db).some(line => line.startsWith("SCAN"))).toBe(false);
    expect(plan(db).some(line => line.includes(`INDEX ${MESSAGE_ID_INDEX}`))).toBe(true);
    expect(db.prepare(BY_ID).get("m9")).toEqual({ thread_id: "t2" });
    expect(downgradeMessageIdIndexTo102(db)).toEqual({ dropped: true });
    expect(messageIdIndexReady(db)).toBe(false);
    expect(downgradeMessageIdIndexTo102(db)).toEqual({ dropped: false });
  } finally { db.close(); }
});
