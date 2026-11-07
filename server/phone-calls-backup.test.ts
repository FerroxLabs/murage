// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOT-CALLS-1020: phone-calls.db (call history, owner-only transcripts, caller settings revisions) travels with a backup and
// comes back on restore. An owner must never lose call history by restoring.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { classifyDataDirEntry, isRestorableDataDirName } from "./data-dir-inventory.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { SqliteCallStore } from "./phone-calls/store.ts";
import type { CallRow } from "./phone-calls/service.ts";
import type { RevisionState } from "./phone-calls/settings.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

function installation(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "bots.json"), "[]");
  writeFileSync(join(dir, "groups.json"), "[]");
  return dir;
}
const storeIn = (dir: string) => { const db = new DatabaseSync(join(dir, "phone-calls.db")); open.push(db); return new SqliteCallStore(db); };
const row = (id: string, status: CallRow["status"], extra: Partial<CallRow> = {}): CallRow => ({
  id, vendorId: `v-${id}`, revision: 2, assistantId: "asst-2", createdAt: 1_700_000_000_000, status,
  language: "en", to: "+15550100", goal: "Book a table for two", details: "Friday 8pm", limits: "No deposit", ...extra,
});

it("phone-calls.db is a backed-up database, its sidecars are not stored on their own", () => {
  expect(classifyDataDirEntry("phone-calls.db")?.backup).toBe("database");
  expect(isRestorableDataDirName("phone-calls.db")).toBe(true);
  for (const side of ["phone-calls.db-wal", "phone-calls.db-shm", "phone-calls.db-journal"]) expect(classifyDataDirEntry(side)?.backup).toBe("sidecar");
});

it("backup then restore keeps every call, the owner-only transcript and the settings revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-phone-backup-")); roots.push(root);
  const source = installation(root, "source");
  const store = storeIn(source); // left open: rows may sit in the WAL, as in a running installation
  const ended = row("call-1", "ended", { transcript: "Business: table for two at 8, reference AB-12.", reference: "AB-12", lengthSeconds: 74 });
  store.put(ended);
  store.put(row("call-2", "scheduled"));
  const revisions = { next: 3, active: 2, revisions: [] } satisfies RevisionState;
  store.saveRevisions(revisions);

  const archive = join(root, "backup.zip");
  const { sha256 } = await writeInstallationArchive(source, archive);
  const target = join(root, "restored");
  await restoreInstallation(target, archive, sha256, { requireNew: true });

  const back = storeIn(target);
  expect(back.get("call-1")).toEqual(ended);
  expect(back.get("call-2")?.status).toBe("scheduled");
  expect(back.recent().map(r => r.id).sort()).toEqual(["call-1", "call-2"]);
  expect(back.loadRevisions()).toEqual(revisions);
});
