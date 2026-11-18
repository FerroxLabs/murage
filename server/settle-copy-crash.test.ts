// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T14, copy cases: a real SIGKILL of a child process inside settleFtsCopy, for the pre-prune copy and the
// staged backup. A kill inside the MEMORY-journal settle may leave the partial unusable; it is never published. Each restart
// leaves no unsettled file under a final name, removes what the killed run left, and the next copy is settled.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { ftsSettled } from "./settle-copy.ts";
import { snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { DELETED_TEXT, deleteThreadRows, fileHolds, headerIsRollback, holdMerges, keptRows, seedMixed, sidecarsOf } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const NOW = 1_790_000_000_000;
const url = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, file)).href);

/** A live data folder whose messages.db index is owed; big enough that the settle takes a while. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-settle-crash-")); roots.push(root);
  const data = join(root, "installation"); mkdirSync(data);
  const db = new DatabaseSync(join(data, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  holdMerges(db);
  for (let i = 0; i < 8; i++) seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 1500, deleted: 300, text: DELETED_TEXT.zh });
  db.exec("INSERT INTO thread_state VALUES ('kept', NULL)");
  deleteThreadRows(db, "gone");
  expect(ftsSettled(db)).toBe("owed");
  return { root, data, db };
}

type Step = "opened" | "optimized" | "vacuumed" | "renamed";
/** Runs `body` in a child process. At settle `step` the child kills itself (`self`) or tells the parent, which kills it (`parent`:
 * the kill lands at an arbitrary point of the work after that step). */
function child(root: string, imports: string, body: string, step: Step, who: "self" | "parent") {
  const script = join(root, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, `
${imports}
const { settleCopyIo } = await import(${url("settle-copy.ts")});
settleCopyIo.step = (name) => {
  if (name !== ${JSON.stringify(step)}) return;
  ${who === "self" ? 'process.kill(process.pid, "SIGKILL");' : 'process.stdout.write("AT\\n");'}
};
${body}
process.stdout.write("DONE\\n");
`);
  return new Promise<{ signal: NodeJS.Signals | null; out: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ["--no-warnings", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, MURAGE_DATA_DIR: join(root, "installation") } });
    let out = "", err = "";
    proc.stdout.on("data", chunk => { out += chunk; if (who === "parent" && String(chunk).includes("AT")) proc.kill("SIGKILL"); });
    proc.stderr.on("data", chunk => { err += chunk; });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => {
      if (code === 1 && !signal && process.platform === "win32" && !err.trim()) { resolve({ signal: "SIGKILL", out }); return; }
      if (code && !signal) reject(new Error(`child failed ${code}: ${err}`)); else resolve({ signal, out });
    });
  });
}

// "vacuumed": the VACUUM INTO file is written beside the partial, not yet renamed (R6.1); "renamed": it is the partial, before the proof
const cases: Array<[Step, "self" | "parent"]> = [["opened", "parent"], ["optimized", "self"], ["vacuumed", "self"], ["renamed", "self"]];

it.each(cases)("T14 pre-prune: killed inside settleFtsCopy (%s, %s): the restart leaves no unsettled file under a final name", async (step, who) => {
  const f = fixture();
  const target = join(f.data, `project-rows-before-prune-${NOW}.db`);
  const run = await child(f.root, `
import { DatabaseSync } from "node:sqlite";
const { snapshotProjectRows } = await import(${url("project-migration.ts")});`, `
const db = new DatabaseSync(${JSON.stringify(join(f.data, "messages.db"))});
snapshotProjectRows(db, ${NOW}, ${JSON.stringify(f.data)});`, step, who);
  expect(run.signal).toBe("SIGKILL");
  expect(run.out).not.toContain("DONE");
  expect(existsSync(target)).toBe(false); // never published
  if (step === "vacuumed") expect(existsSync(`${target}.partial-settle`)).toBe(true); // what the sweep must remove
  const { snapshotProjectRows, sweepPrePruneLeftovers } = await import("./project-migration.ts");
  sweepPrePruneLeftovers(f.data); // the next boot
  expect(readdirSync(f.data).filter(name => name.startsWith("project-rows-before-prune-"))).toEqual([]);
  expect(snapshotProjectRows(f.db, NOW, f.data)).toBe(true);
  expect(sidecarsOf(target)).toEqual([]);
  expect(headerIsRollback(target)).toBe(true);
  expect(fileHolds(target, DELETED_TEXT.zh)).toBe(false);
  const copy = new DatabaseSync(target, { readOnly: true }); databases.push(copy);
  expect(ftsSettled(copy)).toBe("settled");
  expect(keptRows(copy, "kept")).toBe(12_000);
}, 120_000);

it.each(cases)("T14 staged backup: killed inside settleFtsCopy (%s, %s): nothing is published and the next backup is settled", async (step, who) => {
  const f = fixture();
  const target = join(f.root, "snapshot.db");
  const run = await child(f.root, `
const { snapshotInstallationDatabase } = await import(${url("installation-database-snapshot.ts")});`, `
await snapshotInstallationDatabase(${JSON.stringify(f.data)}, ${JSON.stringify(target)});`, step, who);
  expect(run.signal).toBe("SIGKILL");
  expect(existsSync(target)).toBe(false); // never published
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-database-snapshot-"))).toHaveLength(1); // what the kill left
  expect(await snapshotInstallationDatabase(f.data, target)).toMatchObject({ status: "copied" });
  // swept, and the new run's own scratch gone (the killed child's lease leftovers are the lease's own business)
  expect(readdirSync(f.root).filter(name => /^\.murage-(?:database-snapshot|damaged-export|archive-write)-/.test(name))).toEqual([]);
  expect(sidecarsOf(target)).toEqual([]);
  expect(headerIsRollback(target)).toBe(true);
  expect(fileHolds(target, DELETED_TEXT.zh)).toBe(false);
  const copy = new DatabaseSync(target, { readOnly: true }); databases.push(copy);
  expect(ftsSettled(copy)).toBe("settled");
  expect(keptRows(copy, "kept")).toBe(12_000);
}, 120_000);
