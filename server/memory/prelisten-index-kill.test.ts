// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250: the owner-pin index is built on the opening connection before listen. A process killed partway through that build
// (a force quit, or the desktop parent stopping a slow start) leaves part of the build in the log with no commit. The next launch
// must open the file, build the index whole and find every row. The kill lands while the build's pages are reaching the log, proved
// by the log growing and by the index being absent afterwards.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { appendMessage } from "../message-db.ts";
import { optionalIndexReady } from "./optional-index.ts";
import { setMemoryMode } from "./repository.ts";
import { OWNER_PIN, OWNER_PIN_INDEX } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const ROWS = 400_000;
const PINNED = ROWS / 2;
const WAL_BYTES_AT_KILL = 256 * 1024;

// A second process doing what the pre-listen step does: one CREATE INDEX on the file. A small page cache makes the build's pages spill to the log before its commit.
const BUILDER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA cache_size=50");
console.log("began");
db.exec(process.argv[2]);
console.log("committed");
`;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

function killDuringBuild(file: string): Promise<{ signal: NodeJS.Signals | null; committed: boolean; walBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", BUILDER, file, OWNER_PIN.sql], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "", walBytes = 0;
    child.stdout.on("data", chunk => { output += String(chunk); });
    const wal = `${file}-wal`;
    const watch = setInterval(() => {
      walBytes = existsSync(wal) ? statSync(wal).size : 0;
      // The caller emptied the log first, so what is in it after "began" is the build's own.
      if (output.includes("began") && walBytes >= WAL_BYTES_AT_KILL) { clearInterval(watch); child.kill("SIGKILL"); }
    }, 1);
    child.on("error", error => { clearInterval(watch); reject(error); });
    child.on("close", (_code, signal) => { clearInterval(watch); resolve({ signal, committed: output.includes("committed"), walBytes }); });
  });
}

it("a launch killed during the pre-listen index build leaves a file the next launch opens and builds on", async () => {
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database(), file = join(DATA_DIR, "messages.db"), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  transaction(() => {
    // one created_at per 1,000 rows: the age-key window takes at most 131,072 records inside one 64 ms span
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at,owner_pinned) VALUES(?,1,?,'fact','t','owner-statement','active',0,?,?)");
    for (let i = 0; i < ROWS; i++) record.run(`r${i}`, scope, Math.floor(i / 1000) * 86_400_000, i < PINNED ? 1 : 0);
  });
  db.exec(`DROP INDEX IF EXISTS ${OWNER_PIN_INDEX}`);
  closeDatabase();
  await stopWalMaintenance();
  const emptied = new DatabaseSync(file);
  emptied.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  emptied.close();
  expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0).toBe(0);

  const killed = await killDuringBuild(file);
  // Windows has no signals: child.kill ends the process outright and may report no signal, so only a POSIX run reads it.
  if (process.platform !== "win32") expect(killed.signal).toBe("SIGKILL");
  expect(killed.committed).toBe(false);
  expect(killed.walBytes).toBeGreaterThanOrEqual(WAL_BYTES_AT_KILL);
  const raw = new DatabaseSync(file);
  expect(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name=?").get(OWNER_PIN_INDEX)!.n).toBe(0);
  raw.close();

  const next = database();
  expect(optionalIndexReady(next, OWNER_PIN_INDEX)).toBe(true);
  expect(next.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  expect(next.prepare(`SELECT count(*) AS n FROM memory_records INDEXED BY ${OWNER_PIN_INDEX} WHERE owner_pinned=1 AND state='active' AND scope_id=?`).get(scope)!.n).toBe(PINNED);
  closeDatabase();
}, 180_000);
