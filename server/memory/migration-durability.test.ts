// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VACUUM INTO does not fsync the file it writes (SQLite documents this). The
// pre-upgrade copy is renamed into place and then messages.db is upgraded with
// synchronous=FULL, so without an explicit flush a power cut could leave a
// committed v4 messages.db beside a copy whose pages never reached the disk.
// The copy must be flushed before its rename, and the folder after it.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as schema from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";

const roots: string[] = [];
const io = (schema as unknown as { memorySnapshotIo?: { fsyncSync: (fd: number) => void; renameSync: (from: string, to: string) => void } }).memorySnapshotIo;
const real = io ? { ...io } : null;
afterEach(() => {
  if (io && real) Object.assign(io, real);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("flushes the copy to disk before renaming it into place, and the folder after", () => {
  expect(io, "the copy's file calls are observable").toBeTruthy();
  const calls: string[] = [];
  io!.fsyncSync = (fd) => { calls.push("fsync"); real!.fsyncSync(fd); };
  io!.renameSync = (from, to) => { calls.push(String(from).endsWith(".partial") ? "rename partial" : "rename other"); real!.renameSync(from, to); };
  const root = mkdtempSync(join(tmpdir(), "murage-memdurable-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(schema.MEMORY_SCHEMA_V2);
    db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
    db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
    schema.migrateMemorySchema(db, "off", { snapshotV2Path: join(root, schema.MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => 1024 ** 4 });
    const rename = calls.indexOf("rename partial");
    expect(rename).toBeGreaterThan(0);
    expect(calls.slice(0, rename)).toContain("fsync");
    if (process.platform !== "win32") expect(calls.slice(rename + 1)).toContain("fsync");
  } finally { db.close(); }
});

it("retries a rename a Windows scanner briefly blocks, and gives up on a real error", () => {
  expect(io).toBeTruthy();
  let failures = 2;
  io!.renameSync = (from, to) => { if (failures-- > 0) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); real!.renameSync(from, to); };
  const root = mkdtempSync(join(tmpdir(), "murage-memdurable-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db"));
  try {
    db.exec(schema.MEMORY_SCHEMA_V2);
    db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
    db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
    schema.migrateMemorySchema(db, "off", { snapshotV2Path: join(root, schema.MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => 1024 ** 4 });
    expect(Number(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version)).toBe(7);
  } finally { db.close(); }
});
