// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: reclaim-1020-n6 (import write-time revoke of a changed notebook). Consumer side (revoke marker, send fence): revoke-marker owners.
// A routine run appends a line to the bot's notebook; the tracked sync re-imports it. Before this fix every chunk of the notebook, its words
// unchanged, took a soft write-time revoke with an all-threads pending window, so each minute queued one job per chunk faster than the paced
// marker walks them, and every owner turn read checking:pending (recall=withheld). Only the chunks whose words changed may be revoked.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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

it("a routine's one-line append revokes only the chunk whose words changed, not every chunk of the notebook", () => {
  const path = seed(lines.join("\n"));
  expect(chunks()).toBeGreaterThan(8);
  expect(show()).toBe(chunks());
  exhaust();
  const before = jobs().length, open = windows();
  writeFileSync(path, [...lines, line(600)].join("\n"));
  poll();
  const added = jobs().slice(before);
  expect(windows() - open).toBe(1);
  // the last chunk grew; every other chunk kept its id and its exact words
  expect(added.length).toBe(1);
  expect(added[0]!.id).toMatch(/:chunk:\d+$/);
  const last = (database().prepare("SELECT max(CAST(substr(id, instr(id, ':chunk:') + 7) AS INTEGER)) AS n FROM memory_records WHERE id LIKE '%:chunk:%'").get() as { n: number }).n;
  expect(added[0]!.id.endsWith(`:chunk:${last}`)).toBe(true);
});

it("a chunk whose words changed is still revoked (fail closed), and a repeat sync of the same file revokes nothing", () => {
  const path = seed(lines.join("\n"));
  show();
  exhaust();
  const before = jobs().length;
  // same length, different words, in the first chunk only
  writeFileSync(path, [line(0).replace("durable", "revised"), ...lines.slice(1)].join("\n"));
  poll();
  const added = jobs().slice(before);
  expect(added.map(job => job.id)).toEqual([expect.stringMatching(/:chunk:0$/)]);
  poll();
  expect(jobs().length).toBe(before + 1);
});

it("checkwin with n6: a changed chunk no session was shown opens no window and queues no job", () => {
  const path = seed(lines.join("\n"));
  exhaust();
  const before = jobs().length, open = windows();
  writeFileSync(path, [line(0).replace("durable", "revised"), ...lines.slice(1), line(600)].join("\n"));
  poll();
  expect(jobs().length).toBe(before);
  expect(windows()).toBe(open);
});
