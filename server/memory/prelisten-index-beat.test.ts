// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-INDEX: the owner-pin index built before listen on a launch that is not migrating. The build holds the server thread, and at 50 IOPS it
// outlasts the shell's 5-minute limit, so the start-up note has to keep moving for the whole statement. A thread of its own reads the real note
// while this thread sits in the real CREATE INDEX.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, setUpgradeReporterForTest, transaction } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { optionalIndexReady } from "./optional-index.ts";
import { setMemoryMode } from "./repository.ts";
import { OWNER_PIN_INDEX } from "./schema.ts";
import { memoryUpgradeReporter, MEMORY_UPGRADE_STATUS_FILE } from "./upgrade-status.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";

const file = () => join(DATA_DIR, "messages.db");
const ROWS = 400_000;
const SAMPLER = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const samples = [];
let stop = false;
parentPort.on("message", () => { stop = true; parentPort.postMessage(samples); });
parentPort.postMessage("ready");
const look = () => {
  if (stop) return;
  try { const note = JSON.parse(readFileSync(workerData.note, "utf8")); samples.push({ state: note.state, phase: note.phase, step: note.step, updatedAt: note.updatedAt, contract: note.upgrade && note.upgrade.phase, awake: note.upgrade && note.upgrade.step.awakeElapsedMs }); } catch {}
  setTimeout(look, 2);
};
look();
`;

/** A file with history whose owner-pin index is gone: the launch that follows is not a migration and has one real build to do. */
function fileWithoutIndex(rows = ROWS) {
  setMemoryMode("capture");
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence" });
  const db = database();
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  transaction(() => {
    const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at,owner_pinned) VALUES(?,1,?,'fact','t','owner-statement','active',0,?,?)");
    for (let i = 0; i < rows; i++) record.run(`r${i}`, scope, Math.floor(i / 1000) * 86_400_000, i % 2);
  });
  db.exec(`DROP INDEX IF EXISTS ${OWNER_PIN_INDEX}`);
  closeDatabase();
}
/** The real reporter, its beat quick enough for this test's build, with each indexing beat recorded. */
function watchedReporter(seen: Array<{ phase: string; atStart: boolean; atEnd?: boolean }>, throwing = false) {
  const indexOnDisk = () => { const raw = new DatabaseSync(file(), { readOnly: true }); try { return Boolean(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(OWNER_PIN_INDEX)); } finally { raw.close(); } };
  setUpgradeReporterForTest(((dir: string, partial: (path: string) => string) => {
    const real = memoryUpgradeReporter(dir, partial);
    return { ...real, blocking(first: Parameters<typeof real.blocking>[0], from?: number, _interval?: number, phase = "migrating", contractPhase?: "indexing") {
      if (phase !== "indexing" || first !== "backfill") return real.blocking(first, from, _interval, phase, contractPhase);
      const row: { phase: string; atStart: boolean; atEnd?: boolean } = { phase, atStart: indexOnDisk() };
      seen.push(row);
      if (throwing) throw new Error("the note cannot be written");
      const beat = real.blocking(first, from, 20, phase, contractPhase);
      return { step: beat.step, end() { row.atEnd = indexOnDisk(); beat.end(); } };
    } };
  }) as typeof memoryUpgradeReporter);
}

beforeEach(() => { closeDatabase(); setUpgradeReporterForTest(null); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); setUpgradeReporterForTest(null); });

it("an ordinary launch that builds the index keeps the upgrading note moving for the whole CREATE INDEX, and takes it down after", { timeout: 180_000 }, async () => {
  fileWithoutIndex();
  const seen: Array<{ phase: string; atStart: boolean; atEnd?: boolean }> = [];
  watchedReporter(seen);
  const note = join(DATA_DIR, MEMORY_UPGRADE_STATUS_FILE);
  const sampler = new Worker(SAMPLER, { eval: true, workerData: { note } });
  await new Promise(resolve => sampler.once("message", resolve));
  const db = database();
  const samples = await new Promise<Array<{ state: string; phase: string; step: string; updatedAt: number; contract?: string; awake?: number }>>(resolve => { sampler.once("message", resolve); sampler.postMessage("stop"); });
  await sampler.terminate();
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  // the beat began before the build and ended after it
  const pin = seen.filter(row => row.atStart === false && row.atEnd === true);
  expect(pin).toHaveLength(1);
  const during = samples.filter(sample => sample.contract === "indexing");
  expect(during.every(sample => sample.state === "upgrading" && sample.step === "backfill")).toBe(true);
  expect(new Set(during.map(sample => sample.updatedAt)).size).toBeGreaterThanOrEqual(3);
  // the window's clock: the time awake in this step moves with the beat
  expect(during.at(-1)!.awake!).toBeGreaterThan(during[0]!.awake!);
  expect(existsSync(note)).toBe(false);
});

it("only a launch with the index missing has the beat: not a new installation, not a file with the index", () => {
  const pinBeats = (seen: Array<{ atStart: boolean; atEnd?: boolean }>) => seen.filter(row => row.atStart === false && row.atEnd === true);
  const seen: Array<{ phase: string; atStart: boolean; atEnd?: boolean }> = [];
  watchedReporter(seen);
  const db = database();
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  expect(pinBeats(seen)).toEqual([]);
  closeDatabase();
  database();
  expect(pinBeats(seen)).toEqual([]);
  // the same file and the same watch, with the index gone
  database().exec(`DROP INDEX IF EXISTS ${OWNER_PIN_INDEX}`);
  closeDatabase();
  database();
  expect(pinBeats(seen)).toHaveLength(1);
});

it("a launch killed under the beat leaves its note behind, and the next launch builds the index whole and takes the note down", { timeout: 180_000 }, async () => {
  fileWithoutIndex(800_000);
  await stopWalMaintenance();
  const note = join(DATA_DIR, MEMORY_UPGRADE_STATUS_FILE);
  // a file, not -e: --input-type would be inherited by the beat's own worker thread, whose source is CommonJS
  const opener = join(DATA_DIR, "opener.mjs");
  writeFileSync(opener, `import { database } from ${JSON.stringify(new URL("../database.ts", import.meta.url).href)}; database(); console.log("opened");`);
  const child = spawn(process.execPath, [opener], { env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: ["ignore", "pipe", "inherit"] });
  let output = "", sighted = false;
  child.stdout.on("data", chunk => {
    output += String(chunk);
    if (output.includes("opened") && !sighted) child.kill("SIGTERM");
  });
  const watch = setInterval(() => {
    // only this beat names the step in its contract state, so the note is seen only under the wrap at the build
    try { if (JSON.parse(readFileSync(note, "utf8")).upgrade?.phase === "indexing") { sighted = true; child.kill("SIGKILL"); clearInterval(watch); } } catch { /* not there yet, or mid-rename */ }
  }, 1);
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(deadline); clearInterval(watch); reject(error); });
    child.once("close", (_code, ended) => { clearTimeout(deadline); clearInterval(watch); resolve(ended); });
  });
  expect(sighted).toBe(true);
  expect(signal).toBe("SIGKILL");
  expect(output).not.toContain("opened");
  expect(existsSync(note)).toBe(true);
  const raw = new DatabaseSync(file());
  expect(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name=?").get(OWNER_PIN_INDEX)!.n).toBe(0);
  raw.close();
  const next = database();
  expect(optionalIndexReady(next, OWNER_PIN_INDEX)).toBe(true);
  expect(next.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  expect(existsSync(note)).toBe(false);
});

it("a note that cannot be written never stops the start: the index is still built", () => {
  fileWithoutIndex(1000);
  const seen: Array<{ phase: string; atStart: boolean; atEnd?: boolean }> = [];
  watchedReporter(seen, true);
  const db = database();
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
});

it("an upgrade launch still opens with the index built, under the same note", () => {
  buildSyntheticV6(file(), { threads: 4, perThread: 6, payloadBytes: 50, receiptsPerThread: 1 });
  const seen: Array<{ phase: string; atStart: boolean; atEnd?: boolean }> = [];
  watchedReporter(seen);
  const db = database();
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  expect(seen.filter(row => row.atStart === false && row.atEnd === true)).toHaveLength(1);
});
