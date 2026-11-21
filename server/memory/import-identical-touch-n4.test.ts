// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: checkfix-1020-n4 (tracked-notebook poller, import.ts). Consumer side (revoke marker, send fence): revoke-marker owners.
// Sean's pre9 log: "memory receipts revoked scope=records cause=import" every 10-60 s while every owner turn met checking:pending. The poller
// re-reads a notebook whose mtime moved (rewritten or touched with the same words). Byte-identical text must open no window, queue no job and
// log no revoke, round after round; a real change to a shown chunk still opens its window (fail closed).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { REVOKE_WRITE_BUDGET } from "./revoke-budget.ts";
import { PENDING_ALL_THREADS } from "./lineage-types.ts";

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
});
// Sean's 23:24Z state: the marker's minute is spent (settle outcome=budget), so no inline walk finishes a job and each one stays active,
// holding its all-threads pending window. An exhausted budget keeps every committed job visible here, as it did there.
const budget = REVOKE_WRITE_BUDGET.bytesPerMinute;
afterEach(() => { REVOKE_WRITE_BUDGET.bytesPerMinute = budget; });
const exhaust = () => { REVOKE_WRITE_BUDGET.bytesPerMinute = 1; };
const line = (i: number) => `Line ${String(i).padStart(4, "0")}: durable owner context that a routine keeps.`;
function seed(text: string) {
  const root = ensureWorkspace("a"), path = join(root, "MEMORY.md"), ticket = ownerMemoryTicket();
  writeFileSync(path, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
  return path;
}
// 1.0.20 checkwin (revocation.ts importShownProbe): an import revokes only a chunk some session was shown, so a never-shown chunk opens no
// window at all. The routine's notebook here was read by a session first: one delivered receipt cites every chunk at its current version.
function show() {
  const cited = database().prepare("SELECT id,version FROM memory_records WHERE id LIKE '%:chunk:%' AND state='active'").all() as Array<{ id: string; version: number }>;
  database().prepare("INSERT INTO memory_disclosures SELECT 'shown-notebook','thread-a','fixture','session-a',?,'[]','[]',policy_revision,deletion_epoch,0,'delivered',? FROM memory_meta WHERE id=1")
    .run(JSON.stringify(cited.map(chunk => ({ id: chunk.id, version: Number(chunk.version) }))), Date.now());
  return cited.length;
}
function poll() {
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  syncTrackedMemoryImports(roster);
}
const jobs = () => database().prepare("SELECT revoke_id, json_extract(root,'$.ref.id') AS id FROM memory_revoke_jobs WHERE kind='memory'").all() as Array<{ revoke_id: number; id: string }>;
const windows = () => (database().prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=?").get(PENDING_ALL_THREADS) as { n: number }).n;
const chunks = () => (database().prepare("SELECT count(DISTINCT id) AS n FROM memory_records WHERE id LIKE '%:chunk:%'").get() as { n: number }).n;
const lines = Array.from({ length: 600 }, (_, i) => line(i));

it("1.0.20 checkfix-n4: Sean's sequence: a notebook rewritten with the same bytes every poll opens no window and logs no revoke; a real change still does", () => {
  const path = seed(lines.join("\n"));
  expect(show()).toBe(chunks());
  exhaust();
  const warn = vi.spyOn(console, "warn");
  // each poll is 61 s after the last (the poller's own clock): every look is due and takes the full read, as Sean's 10-60 s rhythm did
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const later = () => { offset += 61_000; poll(); };
  const before = jobs().length, open = windows();
  const text = lines.join("\n");
  for (let round = 0; round < 6; round++) {
    // the same words written again: a new mtime (and a new inode) the poller's stat signature sees
    writeFileSync(path, text);
    later();
  }
  expect(jobs().length).toBe(before);
  expect(windows()).toBe(open);
  expect(warn.mock.calls.filter(call => String(call[0]).includes("cause=import"))).toEqual([]);
  // the link stays current with the same hash (no needs-review, no rewrite of the row)
  const link = JSON.parse(String((database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='notebook-link'").get() as { intent: string }).intent));
  expect(link.status).toBe("current");
  // a real change of a chunk a session was shown: its window opens, exactly as before (nothing here skips a revoke)
  writeFileSync(path, [line(0).replace("durable", "revised"), ...lines.slice(1)].join("\n"));
  later();
  expect(jobs().length).toBe(before + 1);
  expect(windows()).toBe(open + 1);
  expect(warn.mock.calls.filter(call => String(call[0]).includes("cause=import")).length).toBeGreaterThan(0);
  warn.mockRestore(); clock.mockRestore();
});
