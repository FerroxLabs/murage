// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 downgrade message, server side of the start path: the real database() open on a data folder a newer Murage saved.
// - every start of a released build raises DATA_DIR/data-version.json to its version, never lowers it (so an older build can name the newer one);
// - a memory schema this build does not know (MEMORY_SCHEMA_UNSUPPORTED) ends the start with a blocked note carrying that code, not the generic
//   MEMORY_MIGRATION_FAILED the shell would answer with its restore page; the refusal leaves messages.db byte for byte as it was.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { readMemoryUpgradeStatus } from "../electron/memory-upgrade-status.mjs";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const MARKER = join(DATA_DIR, "data-version.json");
const files = () => ["messages.db", "messages.db-wal", "messages.db-shm", "data-version.json", "memory-upgrade-status.json"].map(name => join(DATA_DIR, name));
const marker = () => existsSync(MARKER) ? JSON.parse(readFileSync(MARKER, "utf8")) : null;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
let savedVersion: string | undefined;
function reset() { closeDatabase(); stopWalMaintenance(); for (const file of files()) rmSync(file, { force: true }); }
beforeEach(() => { savedVersion = process.env.MURAGE_APP_VERSION; reset(); });
afterEach(() => { reset(); if (savedVersion === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = savedVersion; });

it("a start of a released build writes the data-version marker, and an older start never lowers it", () => {
  process.env.MURAGE_APP_VERSION = "1.0.20";
  database();
  expect(marker()).toEqual({ v: 1, newest: "1.0.20" });
  closeDatabase();
  // A newer build (1.0.21) started here since; this older 1.0.20 start opens the same data and must keep naming 1.0.21.
  writeFileSync(MARKER, JSON.stringify({ v: 1, newest: "1.0.21" }));
  database();
  expect(marker()).toEqual({ v: 1, newest: "1.0.21" });
  closeDatabase();
  // A start with no released version (a source run) leaves the marker alone.
  process.env.MURAGE_APP_VERSION = "dev";
  rmSync(MARKER, { force: true });
  database();
  expect(marker()).toBeNull();
});

it("memory a newer Murage saved ends the start with a MEMORY_SCHEMA_UNSUPPORTED note and leaves messages.db unchanged", () => {
  process.env.MURAGE_APP_VERSION = "1.0.20";
  database();
  closeDatabase(); stopWalMaintenance();
  // What a newer build leaves that this one does not know: one more memory table (the shape 1.0.19's checkpoint tables had for 1.0.18).
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  raw.exec("CREATE TABLE memory_future_rows(id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO memory_future_rows(body) VALUES('kept'); PRAGMA wal_checkpoint(TRUNCATE)");
  raw.close();
  writeFileSync(MARKER, JSON.stringify({ v: 1, newest: "1.0.21" }));
  const before = sha(join(DATA_DIR, "messages.db"));
  expect(() => database()).toThrow(/^MEMORY_SCHEMA_UNSUPPORTED/);
  const note = readMemoryUpgradeStatus(DATA_DIR, { pid: process.pid });
  expect(note).toMatchObject({ state: "blocked", code: "MEMORY_SCHEMA_UNSUPPORTED" });
  expect(sha(join(DATA_DIR, "messages.db"))).toBe(before);
  expect(marker()).toEqual({ v: 1, newest: "1.0.21" });
  const check = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try { expect(check.prepare("SELECT body FROM memory_future_rows").all()).toEqual([{ body: "kept" }]); } finally { check.close(); }
});
