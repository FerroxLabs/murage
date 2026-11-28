// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1024-turnpolish (the log line "memory receipts revoked ... count=N" in memory/revocation.ts noteRevocation). 1.0.23 field: a routine
// appends to a notebook and the tracked sync (import.ts syncTrackedMemoryImports, every ~10 s) re-imports it; with no receipt citing the notebook
// it ended nothing and still logged "memory receipts revoked scope=records cause=import count=0" each time. The line is for a revoke that ended
// something. The re-import here is the real tracked sync over a real notebook.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { commitMemoryImport, IMPORT_CHUNK_DIFF, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { resetSessionHolds } from "./disclosures.ts";
import { revokeAllDisclosures, revokeThreadDisclosures } from "./revocation.ts";

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
let warnings: string[] = [];
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); resetSessionHolds();
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  IMPORT_CHUNK_DIFF.keep = false; // the re-import that supersedes every chunk (the path that logged)
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(arg => String(arg)).join(" ")); });
});
afterEach(() => { IMPORT_CHUNK_DIFF.keep = true; vi.restoreAllMocks(); closeMessageDb(); closeDatabase(); });
const revokedLines = () => warnings.filter(text => text.startsWith("memory receipts revoked"));
const notebook = (stamp: string) => [`Line 0000: status ${stamp}`.padEnd(63, "."), ...Array.from({ length: 40 }, (_, i) => `Line ${String(i + 1).padStart(4, "0")}: the owner keeps notes here`.padEnd(63, "."))].join("\n");
let path = "";
function seed(text: string) {
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  path = join(root, "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  syncTrackedMemoryImports(roster);
}
const receipt = (id: string) => database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'thread-a','driver','[]','[]','[]',1,0,1,'delivered',?)").run(id, Date.now());

it("RED turnpolish-4: a tracked re-import that ends no receipt logs no revoke line", () => {
  seed(notebook("one"));
  warnings = [];
  routineWrites(notebook("two"));
  expect(revokedLines()).toEqual([]);
});
it("a revoke that ended receipts still logs its count", () => {
  seed(notebook("one"));
  receipt("bundle-1");
  warnings = [];
  expect(revokeAllDisclosures(database(), "test-cause")).toBe(1);
  expect(revokedLines()).toEqual(["memory receipts revoked scope=global cause=test-cause count=1"]);
});
it("a thread revoke logs its count only when it ended something", () => {
  seed(notebook("one"));
  warnings = [];
  expect(revokeThreadDisclosures(database(), "thread-a", "branch-change")).toBe(0);
  expect(revokedLines()).toEqual([]);
  receipt("bundle-2");
  expect(revokeThreadDisclosures(database(), "thread-a", "branch-change")).toBe(1);
  expect(revokedLines()).toEqual(["memory receipts revoked scope=thread cause=branch-change count=1"]);
});
