// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: producer = import.ts commitImportItems (chunk-diff), this lane (cause10-import-fable). Reader of a kept chunk's receipt =
// deny-read.ts keptChunk / reimportCarry and disclosures.ts revokedReason, changed by this lane; the fence that calls them (send-fence.ts)
// and the revoke window (revoke-commit.ts, revoke-budget.ts: cause5-1021-fable) are unchanged here.
// 1.0.21 field (a 13 GB profile, 38 bots): a routine appends a line to a tracked notebook about once a minute and the tracked sync
// re-imports it. Every re-import superseded and rewrote EVERY chunk as a new version (a projection receipt and change-journal rows each,
// re-projected into every recall view), and re-touched every older version too, so one appended line cost the notebook's size times its
// revision count. A changed notebook now writes only the chunks whose words changed.
// Real paths: the owner's first import (preview + commit), the tracked sync for every later change, the real revoke commit, and the real
// receipt content verdict (reimportedReceiptVerdict) and acceptance check (revokedReason). Receipt rows are written as a delivered turn
// leaves them (the cited chunk versions and the notebook at its revision), as import-unchanged-chunks-n6.test.ts does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, IMPORT_CHUNK_DIFF, previewMemoryImport, resetMemoryImportPreviews, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as revokeBudget from "./revoke-budget.ts";
import { REVOKE_WRITE_BUDGET } from "./revoke-budget.ts";
import { PENDING_ALL_THREADS } from "./lineage-types.ts";
import { denyGeneration, reimportedReceiptVerdict } from "./deny-read.ts";
import { forgetMemory } from "./forget.ts";
import { keptSpanPairs, runRevocationJobsNow, type KeptSpanCursor } from "./memory-revocation.ts";
import { CURRENT_MEMORY } from "./eligibility.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
const budget = REVOKE_WRITE_BUDGET.bytesPerMinute;
let warnings: string[] = [];
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  // the marker's write minute is process state: a test that re-imports many times (W6d) must not leave the next one a spent minute
  revokeBudget.resetRevokeWriteBudget();
  // so are import previews (20 at once, ended only by time): this file makes more than 20
  resetMemoryImportPreviews();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
});
afterEach(() => { IMPORT_CHUNK_DIFF.keep = true; REVOKE_WRITE_BUDGET.bytesPerMinute = budget; if (inlineFloor) inlineFloor.changesPerMinute = floor!; vi.restoreAllMocks(); closeDatabase(); });
// Coordination with cause5-1021-fable (owner of revoke-budget.ts): its INLINE_FLOOR finishes a commit's own small walk even in a spent
// minute, and a finished job leaves no row. This file counts WHICH revokes an import commits, so where that export exists (the branches
// merged) the floor is turned off while a test counts, exactly as cause5 did for import-unchanged-chunks-n6.test.ts. Absent: nothing to do.
const inlineFloor = (revokeBudget as unknown as { INLINE_FLOOR?: { changesPerMinute: number } }).INLINE_FLOOR;
const floor = inlineFloor?.changesPerMinute;
/** The field state: the marker's write minute is spent, so a committed revoke stays an active job with its all-threads window. */
const exhaust = () => { REVOKE_WRITE_BUDGET.bytesPerMinute = 1; if (inlineFloor) inlineFloor.changesPerMinute = 0; };

// 64-byte lines (63 + newline), 32 to a 2048-byte chunk (chunks.ts): 320 lines are exactly 10 full chunks.
const line = (i: number, word = "ledger") => `Line ${String(i).padStart(4, "0")}: ${word} notes the owner keeps here`.padEnd(63, ".") + "\n";
const body = (count: number) => Array.from({ length: count }, (_, i) => line(i));
let path = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  path = join(root, "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
/** The routine writes the notebook; the tracked sync's next look re-imports it. */
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  return syncTrackedMemoryImports(roster);
}
type Row = Record<string, unknown>;
const all = (sql: string, ...args: Array<string | number>) => database().prepare(sql).all(...args) as Row[];
const count = (sql: string, ...args: Array<string | number>) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const source = () => database().prepare("SELECT id,revision FROM memory_sources WHERE kind='legacy-import'").get() as { id: string; revision: number };
const index = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/** index -> the one active version of that chunk */
const active = () => new Map(all("SELECT id,version FROM memory_records WHERE id LIKE '%:chunk:%' AND state='active'").map(row => [index(String(row.id)), Number(row.version)]));
const activeText = () => all("SELECT id,text FROM memory_records WHERE id LIKE '%:chunk:%' AND state='active'").sort((a, b) => index(String(a.id)) - index(String(b.id))).map(row => String(row.text)).join("");
const recordRows = () => count("SELECT count(*) AS n FROM memory_records");
const projectionRows = () => count("SELECT count(*) AS n FROM memory_projection_receipts");
const journal = () => count("SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes");
const jobs = () => all("SELECT json_extract(root,'$.ref.id') AS id FROM memory_revoke_jobs WHERE kind='memory'").map(row => index(String(row.id)));
const windows = () => count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=?", PENDING_ALL_THREADS);
/** What recall, search and the index ask of every record they may show (eligibility.ts): active, resting on the current revision. */
const eligible = () => new Set(all(`SELECT r.id FROM memory_records r WHERE r.id LIKE '%:chunk:%' AND ${CURRENT_MEMORY}`).map(row => index(String(row.id))));
const importLines = () => warnings.filter(text => text.includes("cause=import"));
/** A delivered turn's receipt: the chunks it was shown at their versions, and the notebook at its revision then. */
function receipt(bundleId: string, chunks: number[]) {
  const now = active(), { id, revision } = source();
  database().prepare("INSERT INTO memory_disclosures SELECT ?,'thread-a','fixture','session-a',?,?,'[]',policy_revision,deletion_epoch,0,'delivered',? FROM memory_meta WHERE id=1")
    .run(bundleId, JSON.stringify(chunks.map(i => ({ id: `${id}:chunk:${i}`, version: now.get(i)! }))), JSON.stringify([{ id, revision }]), Date.now());
}
const verdict = (bundleId: string) => { const v = reimportedReceiptVerdict(database(), bundleId, { audience: null }); return "reason" in v ? `${v.state}/${String(v.reason)}` : v.state; };
const receiptState = (bundleId: string) => String((database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId) as Row).state);

it("W1 one appended line writes the last chunk only: every other chunk keeps its version and projection receipt, and the cost does not grow with history", () => {
  const lines = body(330); // 10 full chunks and a partial one (10 lines)
  seed(lines.join(""));
  expect(active().size).toBe(11);
  const first = new Map(active());
  const costs: Array<{ records: number; projections: number; journal: number }> = [];
  for (let round = 0; round < 6; round++) {
    const before = { records: recordRows(), projections: projectionRows(), journal: journal() };
    lines.push(line(330 + round, "routine"));
    routineWrites(lines.join(""));
    costs.push({ records: recordRows() - before.records, projections: projectionRows() - before.projections, journal: journal() - before.journal });
  }
  // one new record version and one new projection receipt per append (the changed last chunk); before the fix: 11 of each
  expect(costs.map(cost => cost.records)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(costs.map(cost => cost.projections)).toEqual([1, 1, 1, 1, 1, 1]);
  // change-journal rows (what every recall view re-projects): a small constant, the same on the sixth append as on the first
  // (measured on f6ae52c670: 33 on the first append and 88 on the sixth, 2 per chunk plus one per existing version of every chunk)
  expect(Math.max(...costs.map(cost => cost.journal))).toBeLessThanOrEqual(4);
  expect(costs[5]!.journal).toBe(costs[0]!.journal);
  const now = active();
  for (let i = 0; i < 10; i++) expect([i, now.get(i)]).toEqual([i, first.get(i)]);
  expect(now.get(10)).toBe(source().revision);
  expect(source().revision).toBe(7);
  // nothing of an unchanged chunk was rewritten: one version of each, ever
  expect(count("SELECT count(*) AS n FROM memory_records WHERE id LIKE '%:chunk:%' AND CAST(substr(id,instr(id,':chunk:')+7) AS INTEGER)<10")).toBe(10);
  // and every chunk is still what recall may show: it rests on the notebook's current revision, at its bytes, with the notebook's words
  expect([...eligible()].sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, i) => i));
  expect(count("SELECT count(*) AS n FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE r.state='active' AND e.source_revision!=?", source().revision)).toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_evidence_by_source b JOIN memory_records r ON r.id=b.record_id AND r.version=b.record_version WHERE r.state='active' AND b.source_revision=?", source().revision)).toBe(11);
  expect(activeText()).toBe(lines.join(""));
  expect(all("SELECT start_byte AS s,end_byte AS e FROM memory_evidence WHERE record_id=? AND source_revision=7", `${source().id}:chunk:3`)).toEqual([{ s: 3 * 2048, e: 4 * 2048 }]);
});

it("W2 a re-import that withdraws nothing is a true no-op for the fence: no revoke, no pending window, no receipt ended, and the receipt still reads shown", () => {
  const lines = body(320); // exactly 10 full chunks: an appended line lands in a new chunk and changes no earlier one
  seed(lines.join(""));
  receipt("shown-all", Array.from({ length: 10 }, (_, i) => i));
  exhaust();
  const generation = denyGeneration(database()), before = { records: recordRows(), journal: journal() };
  routineWrites([...lines, line(320, "routine")].join(""));
  expect(source().revision).toBe(2);
  expect(jobs()).toEqual([]);
  expect(windows()).toBe(0);
  expect(denyGeneration(database())).toBe(generation);
  expect(importLines()).toEqual([]);
  expect(recordRows() - before.records).toBe(1);
  expect(journal() - before.journal).toBeLessThanOrEqual(2);
  // the receipt names the notebook at revision 1 and ten chunks no re-import touched: it still holds
  expect(receiptState("shown-all")).toBe("delivered");
  expect(verdict("shown-all")).toBe("shown");
  // the minute's full recheck of the file as it now is, and a touch with the same words, write nothing at all
  const quiet = { changes: count("SELECT total_changes() AS n"), journal: journal() };
  routineWrites([...lines, line(320, "routine")].join(""));
  routineWrites([...lines, line(320, "routine")].join(""));
  expect(count("SELECT total_changes() AS n") - quiet.changes).toBe(2); // the two test-only checkedAt resets above, nothing else
  expect(journal()).toBe(quiet.journal);
  expect(windows()).toBe(0);
});

it("W3 an edit in the middle rewrites that chunk only and withdraws it: its receipt ends and reads withheld, a receipt on untouched chunks holds", () => {
  const lines = body(330);
  seed(lines.join(""));
  receipt("cites-4", [4]);
  receipt("cites-2-and-9", [2, 9]);
  const first = new Map(active());
  const edited = [...lines];
  edited[4 * 32 + 5] = line(4 * 32 + 5, "harbor"); // same length: no chunk boundary moves
  routineWrites(edited.join(""));
  const now = active();
  for (const i of [...first.keys()]) expect([i, now.get(i)]).toEqual([i, i === 4 ? 2 : 1]);
  expect(all("SELECT version,state FROM memory_records WHERE id=? ORDER BY version", `${source().id}:chunk:4`)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
  expect(activeText()).toBe(edited.join(""));
  expect(eligible().size).toBe(11);
  // the receipt that was shown the withdrawn words ends and reads withheld; the one shown only untouched chunks holds
  // (the bounded receipt job logs its own line, then the import's)
  expect(importLines()).toEqual(["memory receipts revoked scope=records cause=import-job count=1", "memory receipts revoked scope=records cause=import count=1"]);
  expect(receiptState("cites-4")).toBe("revoked");
  expect(verdict("cites-4")).toBe("withheld/deny-memory");
  expect(receiptState("cites-2-and-9")).toBe("delivered");
  expect(verdict("cites-2-and-9")).toBe("shown");
  expect(jobs()).toEqual([4]);
  expect(windows()).toBe(0);
  // the write-time revoke names the withdrawn chunk and no other. Shown with the marker's minute spent, where a committed revoke stays an
  // active job (its standing window over the other receipts in that state is the revoke budget's: cause5-1021-fable, not judged here)
  receipt("cites-6", [6]);
  exhaust();
  edited[6 * 32 + 5] = line(6 * 32 + 5, "orchard");
  routineWrites(edited.join(""));
  expect(jobs()).toEqual([4, 6]); // chunk 4's from the first edit, chunk 6's now: one per withdrawn chunk, none for the nine kept
  expect(receiptState("cites-6")).toBe("revoked");
  expect(receiptState("cites-2-and-9")).toBe("delivered");
  expect(active().get(2)).toBe(1);
  expect(active().get(6)).toBe(3);
});

it("W3b a line deleted in the middle: chunks before it are kept, every later chunk is rewritten with the shifted words, and the dropped tail has no active version", () => {
  const lines = body(321); // 10 full chunks and one line: deleting a line leaves exactly 10 chunks
  seed(lines.join(""));
  expect(active().size).toBe(11);
  receipt("cites-1", [1]);
  receipt("cites-7", [7]);
  receipt("cites-10", [10]);
  const shorter = lines.filter((_, i) => i !== 3 * 32 + 1); // inside chunk 3
  routineWrites(shorter.join(""));
  const now = active();
  expect([...now.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 1], [1, 1], [2, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2]]);
  expect(all("SELECT version,state FROM memory_records WHERE id=?", `${source().id}:chunk:10`)).toEqual([{ version: 1, state: "superseded" }]);
  expect(activeText()).toBe(shorter.join(""));
  expect([...eligible()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // no superseded version is left resting on the current revision, and no active one on an old revision
  expect(count("SELECT count(*) AS n FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE (r.state='active')!=(e.source_revision=2)")).toBe(0);
  expect(verdict("cites-1")).toBe("shown");
  expect(verdict("cites-7")).toBe("withheld/deny-memory");
  expect(verdict("cites-10")).toBe("withheld/deny-memory");
  // the words come back: the restored chunk is a NEW version (its earlier words were withdrawn), never the old one revived
  routineWrites(lines.join(""));
  expect(active().get(7)).toBe(3);
  expect(active().get(1)).toBe(1);
  expect(active().get(10)).toBe(3);
  expect(activeText()).toBe(lines.join(""));
  expect(verdict("cites-1")).toBe("shown");
  expect(verdict("cites-7")).toBe("withheld/deny-memory");
  // dropped again, then a change elsewhere: the dropped chunk has no version left to withdraw and is not withdrawn a second time. Shown
  // with the marker's minute spent, where every committed revoke stays a visible job: the only new one is the edited chunk's
  exhaust();
  routineWrites(shorter.join(""));
  expect(active().has(10)).toBe(false);
  const earlier = jobs();
  expect(earlier).toContain(10);
  const reworded = [...shorter];
  reworded[5] = line(5, "harbor");
  routineWrites(reworded.join(""));
  expect(jobs().slice(earlier.length)).toEqual([0]);
  expect(active().get(0)).toBe(5);
});

const tombstone = (type: "source" | "import", target: string, revision: number | null, contentHash: string | null) =>
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('fixture-tombstone',?,?,?,?,0,'fixture',0)").run(type, target, revision, contentHash);
const untombstone = () => database().exec("DELETE FROM memory_tombstones WHERE id='fixture-tombstone'");

it("W4 a forgotten notebook is never carried: a forget of an in-between revision, or of an in-between revision's contents, withholds a kept chunk's receipt", () => {
  const lines = body(330);
  seed(lines.join(""));
  receipt("cites-2", [2]); // chunk 2 at version 1, the notebook at revision 1
  routineWrites([...lines, line(330, "routine")].join(""));
  routineWrites([...lines, line(330, "routine"), line(331, "routine")].join(""));
  expect(source().revision).toBe(3);
  expect(active().get(2)).toBe(1);
  expect(verdict("cites-2")).toBe("shown");
  // revision 2 is neither the revision the receipt names nor the current one: only the kept chunk's own rule (deny-read.ts keptChunk) sees it
  tombstone("source", source().id, 2, null);
  expect(verdict("cites-2")).toBe("withheld/deny-memory");
  untombstone();
  expect(verdict("cites-2")).toBe("shown");
  // the owner forgot the notebook's contents as they were at revision 2 (forget.ts: an import tombstone by scope and content hash)
  const then = database().prepare("SELECT v.content_hash AS hash,s.scope_id AS scope FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=? AND v.revision=2").get(source().id) as { hash: string; scope: string };
  tombstone("import", then.scope, null, then.hash);
  expect(verdict("cites-2")).toBe("withheld/deny-memory");
  untombstone();
  expect(verdict("cites-2")).toBe("shown");
  // and the whole notebook forgotten
  tombstone("source", source().id, null, null);
  expect(verdict("cites-2")).toBe("withheld/deny-memory");
});

it("W5 an upgraded profile: a chain 1.0.20 wrote (v1 superseded by the same words at v2) whose head later imports keep still carries its receipt, and not across a forget", () => {
  const lines = body(330);
  seed(lines.join(""));
  receipt("cites-2", [2]); // chunk 2 at version 1, the notebook at revision 1
  IMPORT_CHUNK_DIFF.keep = false; // the import as 1.0.20 and 1.0.21 ran it
  routineWrites([...lines, line(330, "routine")].join(""));
  IMPORT_CHUNK_DIFF.keep = true;
  const chunk = `${source().id}:chunk:2`;
  expect(all("SELECT version,state FROM memory_records WHERE id=? ORDER BY version", chunk)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
  expect(verdict("cites-2")).toBe("shown");
  routineWrites([...lines, line(330, "routine"), line(331, "routine")].join(""));
  routineWrites([...lines, line(330, "routine"), line(331, "routine"), line(332, "routine")].join(""));
  // the head (v2) was kept by both later imports: no new version, its evidence on the current revision
  expect(all("SELECT version,state FROM memory_records WHERE id=? ORDER BY version", chunk)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
  expect(all("SELECT record_version AS v,source_revision AS r FROM memory_evidence WHERE record_id=? ORDER BY record_version", chunk)).toEqual([{ v: 1, r: 1 }, { v: 2, r: 4 }]);
  expect(verdict("cites-2")).toBe("shown");
  tombstone("source", source().id, 3, null);
  expect(verdict("cites-2")).toBe("withheld/deny-memory");
});

// ---- r2 (review of 68c41865a4, two High): the real Forget (forget.ts forgetMemory) and the real import of a second notebook file.
/** The same bot's topic notebook (memory/<name>): another source of the same scope. */
function topicFile(name: string, text: string) {
  const dir = join(ensureWorkspace("a"), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}
const importTopic = (name: string) => { const ticket = ownerMemoryTicket(); return commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a", topic: name }], roster).previewId, roster, false); };
/** The notebook revisions whose contents may not be imported again (an import tombstone on the scope with that revision's hash). */
const forgottenRevisions = (id: string) => all(`SELECT DISTINCT v.revision AS r FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id
  JOIN memory_tombstones t ON t.target_type='import' AND t.target_id=s.scope_id AND t.content_hash=v.content_hash WHERE v.source_id=? ORDER BY v.revision`, id).map(row => Number(row.r));
const handles = (chunk: string) => all("SELECT record_version AS v,source_revision AS r FROM memory_evidence WHERE record_id=? ORDER BY record_version", chunk);
const wordsHeld = (words: string) => count("SELECT count(*) AS n FROM memory_records WHERE text LIKE ?", `%${words}%`);

it("W6 a forgotten kept chunk stays forgotten at every revision it rested on: the notebook as it was BEFORE the append cannot be imported again under another topic", () => {
  const lines = body(330), first = lines.join("");
  seed(first);
  routineWrites([...lines, line(330, "routine")].join(""));
  const { id } = source(), chunk = `${id}:chunk:2`;
  // kept: one version, its one handle moved to revision 2 (1.0.20 had a version and a handle at each revision, and Forget read both)
  expect(handles(chunk)).toEqual([{ v: 1, r: 2 }]);
  expect(wordsHeld("Line 0070")).toBe(1);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk });
  expect(wordsHeld("Line 0070")).toBe(0);
  // the words as they were at revision 1, in another notebook file of the same bot: the owner's import of it is refused
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(wordsHeld("Line 0070")).toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_sources WHERE kind='legacy-import' AND state='active'")).toBe(0);
  // why: both revisions the chunk rested on carry the tombstones 1.0.20's Forget wrote for them
  expect(forgottenRevisions(id)).toEqual([1, 2]);
  expect(all("SELECT revision AS r FROM memory_tombstones WHERE target_type='source' AND target_id=? AND reason='forgotten-supporting-source' ORDER BY revision", id).map(row => Number(row.r))).toEqual([1, 2]);
});

it("W6b a chunk kept through more revisions than one Forget commit takes (70 appends): the job's supporting phase tombstones the rest, down to revision 1", () => {
  const lines = body(330), first = lines.join("");
  seed(first);
  const text = [...lines];
  for (let i = 0; i < 70; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const { id, revision } = source(), chunk = `${id}:chunk:0`;
  expect(revision).toBe(71);
  expect(handles(chunk)).toEqual([{ v: 1, r: 71 }]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk });
  runRevocationJobsNow(database());
  expect(forgottenRevisions(id)).toEqual(Array.from({ length: 71 }, (_, i) => i + 1));
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(wordsHeld("Line 0005")).toBe(0);
});

// ---- r3 (review of 39a80a52d6, High, forget.ts:94): a Forget is effective for import in its own commit, whatever the revision count.
/** The Forget's job row while its supporting phase is still owed (memory-revocation.ts): the tombstones of the older revisions are not written yet. */
const supportingOwed = () => count("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='memory-revocation' AND json_extract(intent,'$.phases[0]')='supporting'");

it("W8 a chunk kept through more revisions than the Forget commit AND its inline job slice take (330 appends): the oldest revisions' contents are refused at once, before the job writes their tombstones", () => {
  const lines = body(330), first = lines.join("");
  seed(first);
  const text = [...lines];
  for (let i = 0; i < 330; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const { id, revision } = source(), chunk = `${id}:chunk:0`;
  expect(revision).toBe(331);
  expect(handles(chunk)).toEqual([{ v: 1, r: 331 }]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk });
  // cause10 v2 (FORGET-ATOMIC.md): the job is committed and has not run, and every revision's import key is already there. (r3 asserted
  // the window here, revision 1 without its key, and that the import read the pending Forget; v2 closes the window in the commit.)
  expect(supportingOwed()).toBe(1);
  const landed = forgottenRevisions(id);
  expect(landed).toEqual(Array.from({ length: 331 }, (_, i) => i + 1));
  expect(wordsHeld("Line 0005")).toBe(0);
  // the forgotten words as they were at revision 1, under another topic of the same bot: refused now, not after the job
  topicFile("copy.md", first);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  expect(wordsHeld("Line 0005")).toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_sources WHERE kind='legacy-import' AND id!=?", id)).toBe(0);
  // the refusal did not run the job
  expect(supportingOwed()).toBe(1);
  expect(forgottenRevisions(id)).toEqual(landed);
  // a pending Forget refuses only what it forgets: other words import while it is pending
  topicFile("other.md", body(40).map((_, i) => line(i, "garden")).join(""));
  expect(importTopic("other.md").imported).toBe(1);
  expect(wordsHeld("garden notes")).toBeGreaterThan(0);
  // and when the job has run the same import is refused by the tombstones, as W6b
  runRevocationJobsNow(database());
  expect(supportingOwed()).toBe(0);
  expect(forgottenRevisions(id)).toEqual(Array.from({ length: 331 }, (_, i) => i + 1));
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
});

it("W8b one version only is forgotten while its older revisions are still the job's: a revision that version never rested on imports, a revision it did rest on is refused", () => {
  const lines = body(330), first = lines.join("");
  seed(first);
  // revision 2: chunk 0 is edited (version 2), then kept through 330 appends (revisions 2-332)
  const text = [...lines];
  text[5] = line(5, "edited");
  const second = text.join("");
  routineWrites(second);
  for (let i = 0; i < 330; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const { id } = source(), chunk = `${id}:chunk:0`;
  expect(handles(chunk)).toEqual([{ v: 1, r: 1 }, { v: 2, r: 332 }]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk, revision: 2 });
  expect(supportingOwed()).toBe(1);
  // cause10 v2: every revision version 2 rested on has its key at the commit (r3 asserted revision 2 still owed here), none before it
  expect(forgottenRevisions(id)).toEqual(Array.from({ length: 331 }, (_, i) => i + 2));
  // revision 1 held version 1's words, which this Forget did not name: it imports, now and after the job
  topicFile("before.md", first);
  expect(importTopic("before.md").imported).toBe(1);
  // revision 2 is the oldest revision version 2 rested on: refused while its tombstone is still owed
  topicFile("copy.md", second);
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  runRevocationJobsNow(database());
  expect(forgottenRevisions(id)).toEqual(Array.from({ length: 331 }, (_, i) => i + 2));
  expect(() => importTopic("copy.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
});

it("W6d an upgraded profile: a 1.0.20 chain longer than one Forget commit (66 versions, a handle each) whose head was then kept 70 times: the job walks the older handles AND the rest of the head's span", () => {
  const lines = body(330);
  seed(lines.join(""));
  const text = [...lines];
  IMPORT_CHUNK_DIFF.keep = false; // the import as 1.0.20 and 1.0.21 ran it
  for (let i = 0; i < 65; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  IMPORT_CHUNK_DIFF.keep = true;
  for (let i = 65; i < 135; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const { id, revision } = source(), chunk = `${id}:chunk:0`;
  expect(revision).toBe(136);
  const rows = handles(chunk);
  expect(rows.length).toBe(66);
  expect(rows[65]).toEqual({ v: 66, r: 136 });
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk });
  runRevocationJobsNow(database());
  expect(forgottenRevisions(id)).toEqual(Array.from({ length: 136 }, (_, i) => i + 1));
});

it("W6c one version only is forgotten, a version an edit superseded after it was kept: the revisions THAT version rested on, no others", () => {
  const lines = body(330);
  seed(lines.join(""));
  routineWrites([...lines, line(330, "routine")].join(""));
  routineWrites([...lines, line(330, "routine"), line(331, "routine")].join(""));
  const edited = [...lines, line(330, "routine"), line(331, "routine")];
  edited[70] = line(70, "edited");
  routineWrites(edited.join(""));
  routineWrites([...edited, line(332, "routine")].join(""));
  const { id } = source(), chunk = `${id}:chunk:2`;
  // version 1 rested on revisions 1-3 (its handle stopped at 3), version 4 on revisions 4-5
  expect(handles(chunk)).toEqual([{ v: 1, r: 3 }, { v: 4, r: 5 }]);
  // the span walk the job resumes (memory-revocation.ts keptSpanPairs) ends at any row budget, one row a step included, and names each
  // revision once: version 4's revision 4, then version 1's revisions 2 and 1
  for (const max of [1, 2, 3, 64]) {
    const walked: number[] = [];
    let cursor: KeptSpanCursor | null = null, steps = 0;
    do {
      const step = keptSpanPairs(database(), { id: chunk, rev: null }, cursor, max);
      walked.push(...step.pairs.map(pair => pair.revision));
      cursor = step.next;
    } while (cursor && ++steps < 50);
    expect({ max, cursor, walked }).toEqual({ max, cursor: null, walked: [4, 2, 1] });
  }
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: chunk, revision: 1 });
  expect(forgottenRevisions(id)).toEqual([1, 2, 3]);
});

it("W7 a forget from before the turn does not refuse it later: a kept chunk's receipt is judged from the notebook revision the RECEIPT names, not from the chunk's first revision", () => {
  const lines = body(330), first = lines.join("");
  seed(first);
  const { id } = source(), chunk = `${id}:chunk:2`;
  const cite = (bundleId: string, revision: number) => database().prepare("INSERT INTO memory_disclosures SELECT ?,'thread-a','fixture','session-a',?,?,'[]',policy_revision,deletion_epoch,0,'delivered',? FROM memory_meta WHERE id=1")
    .run(bundleId, JSON.stringify([{ id: chunk, version: 1 }]), JSON.stringify([{ id, revision }]), Date.now());
  const revisionNow = () => Number((database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(id) as Row).revision);
  // the same words as revision 1 in a second notebook file of the bot, imported by the owner
  topicFile("copy.md", first);
  importTopic("copy.md");
  const copy = String((database().prepare("SELECT id FROM memory_sources WHERE kind='legacy-import' AND id!=?").get(id) as Row).id);
  cite("before", 1); // a turn shown the notebook at revision 1
  routineWrites([...lines, line(330, "routine")].join(""));
  expect(revisionNow()).toBe(2);
  // the owner forgets the second notebook (real Forget: an import tombstone on the scope with the hash revision 1 also has) and removes its file
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: copy });
  removeTempDirSync(join(ensureWorkspace("a"), "memory"));
  runRevocationJobsNow(database());
  expect(forgottenRevisions(id)).toEqual([1]);
  cite("after", 2); // a turn shown the notebook AFTER that forget, at revision 2: chunk 2 is still version 1
  expect(verdict("after")).toBe("shown");
  // an unrelated append: chunk 2 kept again, its handle on revision 3
  routineWrites([...lines, line(330, "routine"), line(331, "routine")].join(""));
  expect(revisionNow()).toBe(3);
  expect(handles(chunk)).toEqual([{ v: 1, r: 3 }]);
  expect(verdict("after")).toBe("shown");
  // the receipt from before the forget names revision 1, whose contents were forgotten: still never carried
  expect(verdict("before")).toBe("withheld/deny-memory");
  // the same boundary for a forget of one notebook revision: the receipt that names a later revision holds, an earlier or equal one does not
  database().exec("DELETE FROM memory_tombstones WHERE target_type='import'");
  expect(verdict("before")).toBe("shown");
  tombstone("source", id, 1, null);
  expect(verdict("after")).toBe("shown");
  expect(verdict("before")).toBe("withheld/deny-memory");
  untombstone();
  tombstone("source", id, 2, null);
  expect(verdict("after")).toBe("withheld/deny-memory");
  expect(verdict("before")).toBe("withheld/deny-memory");
});
