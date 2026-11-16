// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The child of server/turn-index.test.ts: a real node process, so a death is a death (SIGKILL, no close, no rollback) and a read runs with VITEST set
// or unset. MURAGE_DATA_DIR comes from the parent, a test directory. Prints one JSON line with what a read saw.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";

const [scenario, threadId = "", turnId = ""] = process.argv.slice(2);
const file = join(DATA_DIR, "messages.db");
const die = (): never => { process.kill(process.pid, "SIGKILL"); throw new Error("NOT_REACHED"); };
const insert = (db: DatabaseSync, id: string, json: object) =>
  db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(threadId, id, Date.now(), "bot", "activity", null, JSON.stringify({ id, at: Date.now(), role: "bot", kind: "activity", turnId, tool: { name: "Bash" }, ...json }));

if (scenario === "die-in-uncommitted-build") {
  const db = new DatabaseSync(file);
  const { TURN_INDEX_DDL } = await import("../message-tables.ts");
  db.exec("BEGIN IMMEDIATE");
  db.exec(TURN_INDEX_DDL);
  die();
} else if (scenario === "die-during-build") {
  const db = new DatabaseSync(file);
  const { TURN_INDEX_DDL } = await import("../message-tables.ts");
  console.log("building");
  db.exec(TURN_INDEX_DDL);
  console.log("built");
  die();
} else if (scenario === "die-mid-turn") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  for (const id of ["c1", "c2", "c3"]) insert(db, id, {});
  db.exec("BEGIN IMMEDIATE");
  insert(db, "uncommitted", {});
  die();
} else if (scenario === "read" || scenario === "read-without-index") {
  const { database } = await import("../database.ts");
  const { turnRows, turnTextRows } = await import("../message-db.ts");
  const { isPrepared } = await import("../branch-store.ts");
  const db = database();
  // the open built it, so it goes under the running process
  if (scenario === "read-without-index") db.exec("DROP INDEX messages_turn");
  const pendingBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM fill_pending").get() as { n: number }).n);
  const out: Record<string, unknown> = {};
  try {
    out.rows = turnRows(threadId, turnId).map(row => row.id);
    out.text = turnTextRows(threadId, turnId).map(row => row.id);
  } catch (error) { out.error = (error as { code?: string }).code ?? String(error); }
  out.prepared = isPrepared(threadId);
  out.queued = Number((db.prepare("SELECT COUNT(*) AS n FROM fill_pending").get() as { n: number }).n) - pendingBefore;
  console.log(JSON.stringify(out));
  process.exit(0);
} else throw new Error(`unknown scenario ${scenario}`);
