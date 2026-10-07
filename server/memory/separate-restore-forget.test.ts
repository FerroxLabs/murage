// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A restore into a separate installation must keep forgotten memory forgotten
// (audit A-1). This runs the real runSeparateDesktopRecovery from
// electron/main.mjs against real messages.db files, with only the restore
// worker and the selection publisher stubbed, and checks the memory outcome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
import * as memoryRestore from "./restore.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

const main = readFileSync(fileURLToPath(new URL("../../electron/main.mjs", import.meta.url)), "utf8");
function realSeparateRestore(scope: Record<string, unknown>) {
  const start = main.indexOf("async function runSeparateDesktopRecovery(");
  let body = main.slice(start, main.indexOf("async function runEncryptedSeparateDesktopRecovery(", start));
  const loader = 'await import(pathToFileURL(path.join(process.resourcesPath, "server", "memory", "restore.js")).href)';
  body = body.replace(loader, "await loadMemoryRestore()");
  const keys = Object.keys(scope);
  return new Function(...keys, "let retainedSeparateDirectory=null;" + body + ";return runSeparateDesktopRecovery;")(...keys.map(key => scope[key]));
}

it("a plain restore into a separate installation keeps a forgotten memory forgotten", async () => {
  appendMessage("thread", { id: "source", at: 1, role: "user", kind: "text", text: "private retained source" });
  const work = claimMemoryJob("worker")!; publishMemoryWork(work, "worker", captureWork(work));
  const root = mkdtempSync(join(tmpdir(), "murage-separate-forget-"));
  try {
    const target = join(root, "new-install"); mkdirSync(target);
    await backup(database(), join(target, "messages.db")); // the old backup still remembers it
    writeFileSync(join(target, "restore-review.json"), JSON.stringify({ version: 1, status: "review-required", modifications: [] }));
    forgetMemory(ownerMemoryTicket(), { kind: "source", id: work.sourceId }); // the user said forget, after the backup
    closeDatabase();
    const events: string[] = [];
    const run = realSeparateRestore({
      canRestoreSeparateInstallation: () => true,
      allocateSeparateInstallation: (plan: { dataDirectory: string }) => ({ ...plan, dataDirectory: target }),
      acquireDataDirLease: () => ({ release: () => events.push("release"), utilityServerLeaseEnvironment: () => {} }),
      runDesktopRecovery: async () => ({ ok: true, operation: "restore" }),
      publishInstallationSelection: () => {
        events.push("publish");
        const db = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
        try { expect((db.prepare("SELECT state FROM memory_records").get() as { state: string }).state).toBe("deleted"); }
        finally { db.close(); }
      },
      desktopShutdownStarted: false,
      desktopDataDir: DATA_DIR,
      loadMemoryRestore: async () => memoryRestore,
    });
    await run({ archive: "/chosen.zip", sha256: "a".repeat(64) }, { originalRoot: DATA_DIR, dataDirectory: target });
    expect(events).toEqual(["publish", "release"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("a restore that cannot carry the original's deletions never publishes the selection", async () => {
  const events: string[] = [];
  const run = realSeparateRestore({
    canRestoreSeparateInstallation: () => true,
    allocateSeparateInstallation: (plan: unknown) => plan,
    acquireDataDirLease: () => ({ release: () => events.push("release"), utilityServerLeaseEnvironment: () => {} }),
    runDesktopRecovery: async () => ({ ok: true }),
    publishInstallationSelection: () => events.push("publish"),
    desktopShutdownStarted: false,
    desktopDataDir: DATA_DIR,
    loadMemoryRestore: async () => ({ mergeOriginalMemoryDeletions: () => { throw new Error("merge failed"); } }),
  });
  await expect(run({}, { originalRoot: DATA_DIR, dataDirectory: "/x" })).rejects.toThrow("merge failed");
  expect(events).toEqual(["release"]);
});
