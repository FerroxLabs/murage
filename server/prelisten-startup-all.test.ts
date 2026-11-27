// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all (fablehunt-1020q #4, sweep-B B-3/B-5). Two step classes before listen:
//  - one-statement index builds other than the turn index (owner-pin here, the pattern of evidence, lineage, receipt lines, source-lsn, revoke
//    jobs): a start that died inside the build began the same build again at every launch. Now the first start after a death builds it
//    whole once more (prelisten-index-beat), and after a second death it is left to the build after listen: the start serves.
//  - every other step before listen: the real server keeps its own start-up note (boot-progress.ts) from its first module until listen,
//    naming the step, and takes it down at listen.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { appendMessage } from "./message-db.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { buildOptionalIndexOffThread, optionalIndexReady, PRE_LISTEN_ATTEMPT_PREFIX, preListenIndexDeferred, requiredIndexRebuildPending } from "./memory/optional-index.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { OWNER_PIN, OWNER_PIN_INDEX } from "./memory/schema.ts";
import { BOOT_PROGRESS_FILE } from "./boot-progress.ts";

const file = () => join(DATA_DIR, "messages.db");
const MARKER = `${PRE_LISTEN_ATTEMPT_PREFIX}${OWNER_PIN_INDEX}`;

function fileWithoutIndex(rows = 800_000) {
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
const marker = () => { const raw = new DatabaseSync(file(), { readOnly: true }); try { return raw.prepare("SELECT done FROM transcript_index_state WHERE name=?").get(MARKER) as { done: number } | undefined; } finally { raw.close(); } };
const indexOnDisk = () => { const raw = new DatabaseSync(file(), { readOnly: true }); try { return Boolean(raw.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(OWNER_PIN_INDEX)); } finally { raw.close(); } };

/** One real start in a child process, killed (SIGKILL, as the shell's stop and a crash end it) the moment its build has begun: its marker
 * row is committed with `deaths` and the index is not on disk yet. */
async function startKilledInBuild(deaths: number) {
  const opener = join(DATA_DIR, "opener.mjs");
  writeFileSync(opener, `import { database } from ${JSON.stringify(new URL("./database.ts", import.meta.url).href)}; database(); console.log("opened");`);
  const child = spawn(process.execPath, [opener], { env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: ["ignore", "pipe", "inherit"] });
  let output = "", sighted = false;
  child.stdout.on("data", chunk => { output += String(chunk); });
  const watch = setInterval(() => {
    try { if ((marker()?.done ?? 0) >= deaths && !sighted) { sighted = true; child.kill("SIGKILL"); clearInterval(watch); } } catch { /* not there yet */ }
  }, 1);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", error => { clearTimeout(deadline); clearInterval(watch); reject(error); });
    child.once("close", () => { clearTimeout(deadline); clearInterval(watch); resolve(); });
  });
  return { sighted, opened: output.includes("opened") };
}

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

it("a pre-listen index whose build died twice is left to the build after listen: the third start serves, the build after listen lands", { timeout: 240_000 }, async () => {
  fileWithoutIndex();
  await stopWalMaintenance();
  // first death: the next start builds it whole once more (the existing launch rule), so it begins the build again and dies again
  const first = await startKilledInBuild(1);
  expect(first).toEqual({ sighted: true, opened: false });
  expect(indexOnDisk()).toBe(false);
  const second = await startKilledInBuild(2);
  expect(second).toEqual({ sighted: true, opened: false });
  expect(indexOnDisk()).toBe(false);
  expect(marker()?.done).toBe(2);
  // the third start does not begin it: it opens, with the index declared left until after listen and pending like a failed build
  const db = database();
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(false);
  expect(preListenIndexDeferred(db, OWNER_PIN_INDEX)).toBe(true);
  expect(requiredIndexRebuildPending(db, OWNER_PIN_INDEX)).toBe(true);
  // the build after listen (a worker on its own connection) lands; the start after it finds the index and removes the marker
  expect(await buildOptionalIndexOffThread(db, OWNER_PIN)).toBe(true);
  closeDatabase();
  const next = database();
  expect(optionalIndexReady(next, OWNER_PIN_INDEX)).toBe(true);
  expect(preListenIndexDeferred(next, OWNER_PIN_INDEX)).toBe(false);
  expect(requiredIndexRebuildPending(next, OWNER_PIN_INDEX)).toBe(false);
  expect(marker()).toBeUndefined();
});

it("one death is not enough: the next start builds the index whole before listen and takes the marker down", { timeout: 240_000 }, async () => {
  fileWithoutIndex();
  await stopWalMaintenance();
  expect(await startKilledInBuild(1)).toEqual({ sighted: true, opened: false });
  const db = database();
  expect(optionalIndexReady(db, OWNER_PIN_INDEX)).toBe(true);
  expect(preListenIndexDeferred(db, OWNER_PIN_INDEX)).toBe(false);
  expect(marker()).toBeUndefined();
});

it("the real server start keeps its own note from its first module to listen, naming the step, and takes it down at listen", { timeout: 120_000 }, async () => {
  const note = join(DATA_DIR, BOOT_PROGRESS_FILE);
  const script = join(DATA_DIR, "boot.mjs");
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // the same first import as index.ts, then the real open and the real listen mark
  writeFileSync(script, `import ${at("./boot-progress-start.ts")};
const { readFileSync, existsSync } = await import("node:fs");
const { database } = await import(${at("./database.ts")});
const { startupMark } = await import(${at("./startup-trace.ts")});
const { bootStep } = await import(${at("./read-only-start.ts")});
const look = () => { try { return JSON.parse(readFileSync(${JSON.stringify(note)}, "utf8")); } catch { return null; } };
const beat = () => new Promise(resolve => setTimeout(resolve, 2500)); // one heartbeat interval and some
for (let i = 0; i < 100 && !look(); i++) await new Promise(resolve => setTimeout(resolve, 50));
const before = look();
database();
await beat();
const afterOpen = look();
bootStep("projects.linkLegacyRuns", () => undefined, undefined);
await beat();
const afterStep = look();
startupMark("listen");
console.log(JSON.stringify({ pid: process.pid, before, afterOpen, afterStep, afterListen: existsSync(${JSON.stringify(note)}) }));
process.exit(0);
`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR, MURAGE_BOOT_PROGRESS: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  await new Promise(resolve => child.once("close", resolve));
  const line = output.trim().split("\n").map(row => { try { return JSON.parse(row); } catch { return null; } }).find(row => row && "afterListen" in row);
  expect(line).toBeTruthy();
  expect(line.before).toMatchObject({ v: 1, state: "starting", pid: line.pid, step: "modules" });
  expect(line.afterOpen?.pid).toBe(line.pid);
  expect(String(line.afterOpen?.step)).toMatch(/^database\./);
  expect(line.afterStep).toMatchObject({ pid: line.pid, step: "projects.linkLegacyRuns" });
  expect(line.afterStep.seq).toBeGreaterThan(line.before.seq);
  expect(line.afterListen).toBe(false);
  expect(existsSync(note)).toBe(false);
  // a backup leaves the note out, like the memory-upgrade note
  expect(classifyDataDirEntry(BOOT_PROGRESS_FILE)).toMatchObject({ backup: "excluded" });
  expect(classifyDataDirEntry(`${BOOT_PROGRESS_FILE}.4242001.tmp`)).toMatchObject({ backup: "excluded" });
});
