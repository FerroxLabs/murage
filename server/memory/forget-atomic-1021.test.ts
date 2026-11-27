// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: producer of the deny keys = forget.ts forgetInTransaction (this lane, cause10-redesign-opus, design FORGET-ATOMIC.md). Readers
// = import.ts commitImportItems / unchangedActive (the import tombstone probe) and deny-read.ts source verdict (the same probe for a copy
// already imported); both unchanged in what they read. The job runner (memory-revocation.ts) only reclaims space after this lane.
// 1.0.21 cause10 (four Astra BLOCKs on one family): a Forget wrote the deny keys of the newest 64 revisions or evidence rows in its
// commit and left the rest to its job. Until the job ran (and forever, if the job row was lost by a restore of an older backup) the
// forgotten words of an older revision could be imported again under another topic, and a copy imported before the Forget stayed
// recallable. Every deny key of any Forget is now written in the Forget's own commit; these witnesses never run the job.
// Real paths: the owner's import (preview + commit), the tracked sync for every later change, the real Forget, the real reader verdict
// (deny-read.ts memoryLookup, which recall's hydration asks).
// cause10 v2 r3 (review High, FA8, after the legacy pass): every witness now runs on the profile an UPGRADE opens (`upgrade()`): Forgets
// an older build left queued (a record and a source Forget of another notebook, the attic) were keyed whole by the start-up pass
// (legacy-forget-keys.ts), which wrote no key of the notebook under test. Then a Forget of this build commits and, with its job not run
// (`busy`), the reader and the import ask at once. What each witness proves and the mutant that turns it RED: the lane's DONE table.
// The older-build shape is made by `asShipped` (legacy-forget-pass-1021.test.ts), so this file no longer runs unchanged on 1.0.20.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import * as importer from "./import.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as revokeBudget from "./revoke-budget.ts";
import { memoryLookup } from "./deny-read.ts";
import { FORGET_INLINE_ROWS, forgetMemory } from "./forget.ts";
import { LEGACY_FORGET_JOBS, LEGACY_FORGET_PASS } from "./legacy-forget-keys.ts";
import { writetimeRecordRefusal } from "./readable.ts";
import { INLINE_REVOCATION } from "./memory-revocation.ts";
import { mergeDestinationMemoryDeletions } from "./restore.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";

// bot "a" keeps the notebook under test; bot "b" keeps the attic, the notebook an older build's queued Forgets are of (another scope,
// so none of its import keys is in the scope the witnesses import into). The revokes of those Forgets stay pending in this file (no
// marker and no job runs), and a pending revoke holds every scope's reads at "checking": a copy is asserted "shown" BEFORE `upgrade()`
// and "withheld" (the definite refusal, by its key) after the Forget under test; without that key it stays "checking".
const roster = { bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  revokeBudget.resetRevokeWriteBudget();
  // import previews are process state (20 at once); the hook exists from cause10 on, the base trees make fewer previews per test
  (importer as { resetMemoryImportPreviews?: () => void }).resetMemoryImportPreviews?.();
});
const inlineMs = INLINE_REVOCATION.ms;
afterEach(() => { INLINE_REVOCATION.ms = inlineMs; importer.IMPORT_CHUNK_DIFF.keep = true; closeDatabase(); });
/** The import as 1.0.20 and 1.0.21 as shipped ran it: a version and a handle of every chunk at every notebook revision (this build
 * keeps an unchanged chunk's one handle and moves it: import.ts IMPORT_CHUNK_DIFF). */
function asOlderBuild<T>(run: () => T): T {
  importer.IMPORT_CHUNK_DIFF.keep = false;
  try { return run(); } finally { importer.IMPORT_CHUNK_DIFF.keep = true; }
}
/** The field state: the Forget's inline job slice is wall-clock (8 ms) and a busy machine spends it before the first step, so the job
 * is left to the runner (on an idle machine a 70-revision job may finish inline, which hides the window but does not close it). */
const busy = () => { INLINE_REVOCATION.ms = 0; };

// 64-byte lines, 32 to a 2048-byte chunk: 330 lines are 10 full chunks and a part.
const line = (i: number, word = "ledger") => `Line ${String(i).padStart(4, "0")}: ${word} notes the owner keeps here`.padEnd(63, ".") + "\n";
const body = (count: number) => Array.from({ length: count }, (_, i) => line(i));
let path = "";
const ticket = () => ownerMemoryTicket();
function seed(text: string) {
  path = join(ensureWorkspace("a"), "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket(), previewMemoryImport(ticket(), [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  return syncTrackedMemoryImports(roster);
}
function topicFile(name: string, text: string, botId = "a") {
  const dir = join(ensureWorkspace(botId), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}
const importTopic = (name: string, botId = "a") => commitMemoryImport(ticket(), previewMemoryImport(ticket(), [{ kind: "bot", botId, topic: name }], roster).previewId, roster, false);
type Row = Record<string, unknown>;
const all = (sql: string, ...args: Array<string | number>) => database().prepare(sql).all(...args) as Row[];
const count = (sql: string, ...args: Array<string | number>) => Number((database().prepare(sql).get(...args) as { n: number }).n);
/** The imported notebooks, oldest first: the tracked notebook (MEMORY.md) is the first, a topic file imported just now the newest. */
const sourceIds = () => all("SELECT id FROM memory_sources WHERE kind='legacy-import' ORDER BY rowid").map(row => String(row.id));
const sourceIdOf = (file: string) => file === "MEMORY.md" ? sourceIds()[0]! : sourceIds().at(-1)!;
/** What recall asks of a copy: its source at its revision (deny-read.ts memoryLookup) and, for its first chunk record, the gate every
 * recalled record passes before a prompt (readable.ts writetimeRecordRefusal: the record and each evidence source). A Forget must leave
 * both "withheld" (a definite refusal); "checking" is the revoke's pending window, which its marker walk closes on its own clock whatever
 * the job has written, after which the copy would read shown again. */
function copyState(copyId: string): string[] {
  const chunk = all("SELECT id,version FROM memory_records WHERE id LIKE ? ORDER BY id,version DESC LIMIT 1", `${copyId}:chunk:%`)[0]!;
  const source = memoryLookup(database(), [{ kind: "source", id: copyId, version: revisionOf(copyId) }], { audience: null }).values().next().value!.state;
  const evidence = all("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?", String(chunk.id), Number(chunk.version))
    .map(row => ({ sourceId: String(row.source_id), revision: Number(row.source_revision), startByte: Number(row.start_byte), endByte: Number(row.end_byte) }));
  let record: string;
  try { record = writetimeRecordRefusal(database(), { kind: "record", id: String(chunk.id), version: Number(chunk.version) }, evidence) ? "withheld" : "shown"; }
  catch (error) { if (String(error).includes("MEMORY_REPLAY_LIMIT")) record = "checking"; else throw error; }
  return [source, record];
}
const revisionOf = (id: string) => Number((database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(id) as Row).revision);
/** A notebook changed 70 times by the routine: more revisions (and on 1.0.20, more evidence rows of chunk 0) than one Forget commit took. */
function longNotebook(): { first: string; id: string } {
  const lines = body(330), first = lines.join("");
  seed(first);
  const text = [...lines];
  for (let i = 0; i < 70; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const id = sourceIdOf("MEMORY.md");
  expect(Number((database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(id) as Row).revision)).toBe(71);
  return { first, id };
}
const garden = () => body(40).map((_, i) => line(i, "garden")).join("");
/** The revisions of a notebook whose contents carry an import key in its scope, and those that carry a supporting-source key. */
const keyedRevisions = (id: string) => all(`SELECT v.revision AS r FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=?
  AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='import' AND t.target_id=s.scope_id AND t.content_hash=v.content_hash) ORDER BY v.revision`, id).map(row => Number(row.r));
const sourceKeyRevisions = (id: string) => all("SELECT revision AS r FROM memory_tombstones WHERE target_type='source' AND target_id=? AND reason='forgotten-supporting-source' ORDER BY revision", id).map(row => Number(row.r));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const tombstones = () => count("SELECT count(*) AS n FROM memory_tombstones");
/** What every receipt and retained session is compared with (deny-read.ts "watermark"). */
const watermark = () => { const row = database().prepare("SELECT deletion_epoch AS e,policy_revision AS p FROM memory_meta WHERE id=1").get() as { e: number; p: number }; return [Number(row.e), Number(row.p)]; };
const queue = () => all("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='memory-revocation' AND state IN ('granted','revoked') ORDER BY rowid").map(row => ({ row: String(row.id), job: JSON.parse(String(row.intent)) as Record<string, any> }));

/** The queued Forgets as the shipped builds (1.0.20, 1.0.21 f6ae52c670) left them, the helper of legacy-forget-pass-1021.test.ts: a
 * Forget of this build writes every key in its commit and marks its job, so the keys each job's own cursor says an older build left to
 * the job are taken out again, with the fields only this lineage writes (`record.keys`, `record.span`, `imports.keys`). */
function asShipped(): void {
  const db = database();
  for (const { row, job } of queue()) {
    if (job.record?.id && job.phases.includes("supporting") && job.record.after) {
      const owed = `FROM memory_evidence e WHERE e.record_id=?1 AND (e.record_version,e.source_id,e.source_revision,e.start_byte)<(?2,?3,?4,?5)`;
      const args = [String(job.record.id), ...job.record.after] as Array<string | number>;
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='import' AND content_hash IN (SELECT v.content_hash ${owed.replace("WHERE", "JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE")})`).run(...args);
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='source' AND reason='forgotten-supporting-source' AND (target_id,revision) IN (SELECT e.source_id,e.source_revision ${owed})`).run(...args);
      db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.record.keys','$.record.span') WHERE id=?").run(row);
    }
    if (job.imports?.id && job.phases.includes("imports")) {
      const below = Number((db.prepare("SELECT revision FROM memory_source_versions WHERE source_id=? ORDER BY revision DESC LIMIT 1 OFFSET ?").get(String(job.imports.id), FORGET_INLINE_ROWS - 1) as Row).revision);
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='import' AND content_hash IN (SELECT content_hash FROM memory_source_versions WHERE source_id=? AND revision<?)`).run(String(job.imports.id), below);
      db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(json_set(intent,'$.imports.below',?),'$.imports.keys') WHERE id=?").run(below, row);
    }
  }
}
const ATTIC_REVISIONS = 66;
/** The profile as an upgrade opens it. An older build imported another bot's notebook (the attic: 66 revisions, its first chunk never
 * changed), forgot that chunk and then the whole attic, and left both jobs queued owing the keys of its older revisions; this build
 * then opens the file, and its start-up pass keys them before the open returns (legacy-forget-keys.ts). Nothing is asserted here about
 * the pass: each witness states what it needs of it in its own body. Returns the attic, what the queue owed before the open
 * (LEGACY_FORGET_JOBS), and what the pass of that open did. The Forget's job slice stays spent (`busy`): no job runs in this file. */
function upgrade(): { attic: string; owed: number; pass: { jobs: number; keys: number } } {
  const lines = Array.from({ length: 33 }, (_, i) => line(i, "attic"));
  asOlderBuild(() => {
    for (let revision = 1; revision <= ATTIC_REVISIONS; revision++) {
      importer.resetMemoryImportPreviews();
      topicFile("attic.md", lines.join(""), "b");
      importTopic("attic.md", "b");
      lines.push(line(100 + revision, "attic"));
    }
  });
  const attic = sourceIdOf("attic.md");
  busy();
  forgetMemory(ticket(), { kind: "record", id: `${attic}:chunk:0` });
  forgetMemory(ticket(), { kind: "source", id: attic });
  asShipped();
  const owed = all(LEGACY_FORGET_JOBS).length;
  closeDatabase();
  database();
  return { attic, owed, pass: passOfOpen() };
}
/** What the start-up pass of the newest open did; an open that ran no pass reads as keying nothing (an assertion on it fails, not a crash). */
const passOfOpen = () => ({ jobs: LEGACY_FORGET_PASS.last?.jobs ?? 0, keys: LEGACY_FORGET_PASS.last?.keys ?? 0 });
/** The next start of the app with the file as it is (no job has run): what its start-up pass did. */
function nextStart(): { jobs: number; keys: number } {
  closeDatabase();
  database();
  return passOfOpen();
}
/** The queued jobs of the Forgets of this notebook (its chunks or the whole of it): this file never runs a job. */
const jobsOwed = (id: string) => queue().filter(({ job }) => job.imports?.id === id || String(job.record?.id ?? "").startsWith(`${id}:chunk:`)).length;
/** Every key the start-up pass wrote is the attic's: the notebook under test carries none before its own Forget. */
const unkeyed = (id: string) => [keyedRevisions(id), sourceKeyRevisions(id), count("SELECT count(*) AS n FROM memory_tombstones WHERE target_id=? OR target_id LIKE ?", id, `${id}:chunk:%`)];

/** The real restore of a backup taken BEFORE a Forget (cause10 v2 r2, review High forget-atomic-1021.test.ts:151/:167: deleting the job
 * row by hand proved nothing about restore). The backup is the live file copied by SQLite's backup; the Forget then commits on the live
 * file and the process stops before its job runs; the installation restore's ledger merge (restore.ts mergeDestinationMemoryDeletions,
 * the call installation-restore.ts makes, the Cloud fence's mergeDestinationLedger) carries the live file's deletion ledger onto the
 * backup, and the merged backup becomes the live file. Nothing here writes or deletes a row by hand: the restored file has no job of the
 * Forget because the backup never had one. The owner then turns memory back on (the restore leaves it paused). */
async function restoreBackupFromBefore(id: string, forget: () => void): Promise<void> {
  const candidate = join(DATA_DIR, "restore-candidate");
  mkdirSync(candidate, { recursive: true });
  const jobIds = () => all("SELECT id FROM memory_scope_bindings WHERE subject_id='memory-revocation' AND state IN ('granted','revoked')").map(row => String(row.id));
  const earlier = new Set(jobIds());
  await backup(database(), join(candidate, "messages.db"));
  forget();
  // the Forget's own job (a job queued before the backup is in the backup, and is not the Forget's)
  const owed = jobIds().filter(job => !earlier.has(job));
  expect(owed.length).toBeGreaterThan(0);
  closeDatabase(); await stopWalMaintenance();
  // the backup holds nothing of the Forget: not its job, not one deny key (it was taken before the Forget's commit)
  const before = new DatabaseSync(join(candidate, "messages.db"), { readOnly: true });
  try {
    expect(before.prepare("SELECT id FROM memory_scope_bindings WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(owed)), "the Forget's job in the backup").toEqual([]);
    // (the backup does hold the attic's keys, written by the upgrade's open: they are not this Forget's)
    expect(Number(before.prepare(`SELECT count(*) AS n FROM memory_tombstones t WHERE t.target_id=?1 OR t.target_id LIKE ?1||':chunk:%'
      OR (t.target_type='import' AND t.content_hash IN (SELECT content_hash FROM memory_source_versions WHERE source_id=?1))`).get(id)!.n), "the Forget's deny keys in the backup").toBe(0);
  } finally { before.close(); }
  const merged = mergeDestinationMemoryDeletions(DATA_DIR, candidate);
  expect(merged.history).toBe("destination-ledger-preserved");
  expect(merged.merged).toBeGreaterThan(0);
  // the merged backup becomes the live file through SQLite's own backup, in place (cause10 v2 r3: a removed and copied file was not what
  // the next open read; connections of this process outlive closeDatabase on the removed file, and that open read the live file as it was,
  // the Forget's job and every key in it, so a merge that carried no import key stayed green)
  const restored = new DatabaseSync(join(candidate, "messages.db"));
  try { await backup(restored, join(DATA_DIR, "messages.db")); } finally { restored.close(); }
  // the restored file is the backup plus the merged ledger; the merge queues its own cleanup for the tombstones it applied, which this
  // file never runs either. The owner turns memory back on (the restore leaves it paused).
  database().exec("UPDATE memory_meta SET mode='active'");
  // the open read the restored file: the Forget's job is not in it (what refuses after this was carried by the merge)
  expect(all("SELECT id FROM memory_scope_bindings WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(owed)), "the Forget's job in the restored file").toEqual([]);
}

it("FA1 after an upgrade keyed the older build's Forgets: a record Forget of a chunk kept through more than 64 revisions refuses the notebook as first imported at once, before any job runs", () => {
  const { first, id } = longNotebook();
  const start = upgrade();
  // the start-up pass keyed the two older-build Forgets and nothing of this notebook: what refuses below is this Forget's commit
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` });
  expect(jobsOwed(id)).toBe(1);
  // the import races the Forget's job: the chunk's words were in every revision since the first, and revision 1's contents are refused
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(sourceIds()).toEqual([id, start.attic]);
  // only what was forgotten: other words import
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

it("FA2 after an upgrade: a copy imported BEFORE a record Forget (>64 revisions) is unrecallable at the Forget's commit, and every revision the record rested on is refused as a source", () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  expect(importTopic("copy.md").imported).toBe(1);
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` });
  expect(jobsOwed(id)).toBe(1);
  // the reader races the Forget's job: the copy is refused by the import key of revision 1, written in the commit
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  // and the supporting-source key of every revision the chunk rested on is in the commit too (the newest 64 by the inline rows, the
  // rest by the set statement): no source verdict waits for the job
  expect(sourceKeyRevisions(id)).toEqual(range(1, 71));
});

it("FA3 after an upgrade: a source Forget of a notebook with more than 64 revisions: a copy from before is unrecallable and a copy after is refused, at the commit", () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  expect(importTopic("copy.md").imported).toBe(1);
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  forgetMemory(ticket(), { kind: "source", id });
  expect(jobsOwed(id)).toBe(1);
  // the reader races the job: the copy holds revision 1's words, older than the newest 64 revisions
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  // the same words under a third topic: never admitted (1.0.20 admitted it and ended it once its job reached revision 1)
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

it("FA4 after an upgrade: a record Forget, a crash before its job, then a backup from before the Forget restored (the real ledger merge): the Forget still holds, by the merged keys alone", async () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  importTopic("copy.md");
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  await restoreBackupFromBefore(id, () => forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` }));
  // the open of the restored file keyed nothing (the backup's older-build Forgets were keyed before it was taken, and the Forget's own
  // job is not in it): what refuses below was carried by the merge
  expect(passOfOpen().jobs).toBe(0);
  // the backup's copy is in the restored file, and it is not recallable; its words cannot be imported again
  expect(count("SELECT count(*) AS n FROM memory_sources WHERE id=?", copy)).toBe(1);
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  // every revision the chunk rested on carries its import key in the restored file (the merge carried the whole key set)
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

it("FA5 after an upgrade: a source Forget, a crash, then a backup from before the Forget restored (the real ledger merge): every revision's key is in the restored file, no revision importable, no older copy recallable", async () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  importTopic("copy.md");
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  await restoreBackupFromBefore(id, () => forgetMemory(ticket(), { kind: "source", id }));
  expect(passOfOpen().jobs).toBe(0);
  // every revision's contents carries its import key in the restored file: 71 keys of one scope, alike but for their hash, and the
  // merge carried each (the deny key set is complete at the commit, and merged whole)
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  expect(count("SELECT count(*) AS n FROM memory_sources WHERE id=?", copy)).toBe(1);
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

it("FA6 after an upgrade: a reviewed import is checked against the bytes committed: a notebook forgotten under its raw hash (1.0.3 tombstone) is refused when it is swapped in after the preview", () => {
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  // two notebooks that differ only in a card number, which the import masks: the same stored text, different raw bytes
  const withCard = (card: string) => `${body(20).join("")}card ${card} for the trip\n`;
  const forgotten = withCard("4012 8888 8888 1881");
  topicFile("card.md", withCard("4111 1111 1111 1111"));
  const preview = previewMemoryImport(ticket(), [{ kind: "bot", botId: "a", topic: "card.md" }], roster);
  // a profile forgotten on 1.0.3 holds the import tombstone of the text as read (import.ts legacyHash), not of the masked text
  database().prepare("INSERT INTO memory_tombstones VALUES('fa6-legacy','import',?,NULL,?,1,'forgotten-original',0)")
    .run(preview.items[0]!.scopeId, createHash("sha256").update(forgotten).digest("hex"));
  topicFile("card.md", forgotten);
  expect(() => commitMemoryImport(ticket(), preview.previewId, roster, false)).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(sourceIds()).toEqual([start.attic]);
});

it("FA7 after an upgrade: a source Forget of one revision: that revision's words are refused at once, another revision's words still import", () => {
  const { first, id } = longNotebook();
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  expect(unkeyed(id)).toEqual([[], [], 0]);
  forgetMemory(ticket(), { kind: "source", id, revision: 1 });
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  // the Forget named one revision: only its contents are keyed, and the words of the next revision import
  expect(keyedRevisions(id)).toEqual([1]);
  topicFile("later.md", first + line(330, "routine"));
  expect(importTopic("later.md").imported).toBe(1);
});

// ---- Forgets queued by an older build on the notebook itself: the start-up pass is the only thing between them and an import ----
it("FA8 record Forgets an older build left queued on this notebook: the open keys every revision they forget, an import of the first revision is refused by that key with no job row left, and a Forget of this build made next refuses at its commit", () => {
  // the notebook as the older build imported it (71 versions of each unchanged chunk, a handle each)
  const { first, id } = asOlderBuild(longNotebook);
  // the older build's Forgets of 8 kept chunks: each left revisions 1..7 to its job (the newest 64 were keyed in its commit)
  busy();
  for (let n = 0; n < 8; n++) forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:${n}` });
  asShipped();
  expect(all(LEGACY_FORGET_JOBS).length).toBe(8);
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  // the upgrade's open: every one keyed whole before it returns
  expect(nextStart().jobs).toBe(8);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  // nothing an import reads rests on the queue: with every job row gone (a restore of an older backup), revision 1's words are refused
  database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='memory-revocation'");
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(sourceIds()).toEqual([id]);
  // a Forget of this build on the upgraded profile, raced by an import: words admitted a moment ago are refused from its commit
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
  forgetMemory(ticket(), { kind: "source", id: sourceIdOf("other.md") });
  topicFile("orchard.md", garden());
  expect(() => importTopic("orchard.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
});

it("FA9 a Forget of this build is complete at its commit, so the next start's pass over older builds' Forgets leaves its queued job alone: no key written twice, the watermark not moved again", () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  importTopic("copy.md");
  const copy = sourceIdOf("copy.md");
  const start = upgrade();
  expect([start.owed, start.pass.jobs]).toEqual([2, 2]);
  // a record Forget of this build, its supporting phase queued (more than 64 evidence rows)
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` });
  expect(queue().filter(entry => entry.job.record?.id === `${id}:chunk:0`).map(entry => entry.job.phases[0])).toEqual(["supporting"]);
  let facts = [tombstones(), watermark()];
  expect(nextStart().jobs, "this build's queued record Forget keyed again at the next start").toBe(0);
  expect([tombstones(), watermark()]).toEqual(facts);
  // a source Forget of this build, its imports phase queued (more than 64 revisions; the late-copy window is still the job's)
  busy();
  forgetMemory(ticket(), { kind: "source", id });
  expect(queue().filter(entry => entry.job.imports?.id === id).map(entry => entry.job.phases[0])).toEqual(["imports"]);
  facts = [tombstones(), watermark()];
  expect(nextStart().jobs, "this build's queued source Forget keyed again at the next start").toBe(0);
  expect([tombstones(), watermark()]).toEqual(facts);
  // and the Forgets hold across the starts
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
});
