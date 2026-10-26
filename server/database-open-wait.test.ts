// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opening a brand-new messages.db waits for another connection that holds the file for a moment (a worker that opened it by path),
// instead of failing at once on its first pragma (auto_vacuum) with "database is locked" (person-handoff-result E2, 1.0.6 sg b25a).
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fresh = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  // The file is reported missing once, as it is to a database() that runs before the other connection created it.
  const existsSync = (path: Parameters<typeof fs.existsSync>[0]) => {
    if (fresh.path && path === fresh.path) { fresh.path = ""; return false; }
    return fs.existsSync(path);
  };
  return { ...fs, default: { ...fs, existsSync }, existsSync };
});

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
let opened: typeof import("./database.ts") | undefined;
afterEach(() => { fresh.path = ""; opened?.closeDatabase(); closeDatabase(); });

it("a fresh file another connection holds for a moment is opened once it lets go", async () => {
  const file = join(DATA_DIR, "messages.db");
  // a fresh copy of database.ts, loaded after the node:fs mock (the setup files load the first one with the real module)
  vi.resetModules();
  opened = await import("./database.ts");
  const holder = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData);
    db.exec("BEGIN EXCLUSIVE");
    parentPort.postMessage("held");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec("COMMIT"); db.close();
    parentPort.postMessage("released");
  `, { eval: true, workerData: file });
  try {
    expect((await once(holder, "message"))[0]).toBe("held");
    fresh.path = file;
    const started = performance.now();
    const db = opened.database();
    expect(fresh.path, "database() did not take the fresh-file path").toBe("");
    expect(performance.now() - started).toBeGreaterThan(100);
    // (the holder's own commit may already have written the header, so the vacuum mode is not asserted here: the open is)
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()).toMatchObject({ n: expect.any(Number) });
    expect(String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode)).toBe("wal");
  } finally {
    await holder.terminate();
  }
});
