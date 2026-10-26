// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Restoring a backup made before a Forget: the forget's tombstones travel into
// the restored file (restore.ts mergeDestinationMemoryDeletions), and every
// record they end comes back deleted AND without its words, the same end state
// a live Forget leaves (forget-scrub.test.ts).
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { mergeDestinationMemoryDeletions } from "./restore.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(async () => { closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

it("a record restored as deleted from a pre-Forget backup comes back without its words", async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "SENTINEL-RESTORE my old address" });
  const work = claimMemoryJob("worker")!; publishMemoryWork(work, "worker", captureWork(work));
  const root = mkdtempSync(join(tmpdir(), "murage-restore-scrub-"));
  try {
    const candidate = join(root, "candidate"); mkdirSync(candidate);
    await backup(database(), join(candidate, "messages.db"));
    forgetMemory(ownerMemoryTicket(), { kind: "source", id: work.sourceId });
    closeDatabase(); await stopWalMaintenance();
    expect(mergeDestinationMemoryDeletions(DATA_DIR, candidate).merged).toBeGreaterThan(0);
    const restored = new DatabaseSync(join(candidate, "messages.db"));
    try {
      const rows = restored.prepare("SELECT state,text FROM memory_records").all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.state === "deleted")).toBe(true);
      expect(Number(restored.prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE '%SENTINEL-RESTORE%'").get()!.n)).toBe(0);
    } finally { restored.close(); }
  } finally { removeTempDirSync(root); }
});
