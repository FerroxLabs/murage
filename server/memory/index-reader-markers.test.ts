// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeMessageTables } from "../message-tables.ts";
import { WALKED, walkerPending, walkMessagesChunk } from "../message-walker.ts";
import { readIndexState } from "../transcript-backfill.ts";

it("a fresh message file records every completed walk before its first write", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db, { defer: true });
    for (const name of WALKED) expect(readIndexState(db, name), name).toEqual({ done: 1, cursor: 0, skipped: 0 });
    expect(walkerPending(db)).toEqual([]);
  } finally { db.close(); }
});

it("an older populated file keeps its missing turn walk pending until every row is filed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db, { defer: true });
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('thread',?,1,'bot','text','reply',?)");
    for (const id of ["first", "second"]) insert.run(id, JSON.stringify({ id, role: "bot", kind: "text", text: "reply", turnId: id }));
    db.exec("DELETE FROM transcript_index_state WHERE name='turn_first'");
    initializeMessageTables(db, { defer: true });
    expect(walkerPending(db)).toEqual(["turn_first"]);
    expect(walkMessagesChunk(db, 1).more).toBe(true);
    expect(readIndexState(db, "turn_first").done).toBe(0);
    expect(db.prepare("SELECT turn_id FROM turn_first ORDER BY turn_id").all()).toEqual([{ turn_id: "first" }]);
    expect(walkMessagesChunk(db, 1).more).toBe(false);
    expect(readIndexState(db, "turn_first").done).toBe(1);
    expect(db.prepare("SELECT turn_id FROM turn_first ORDER BY turn_id").all()).toEqual([{ turn_id: "first" }, { turn_id: "second" }]);
  } finally { db.close(); }
});
