// SPDX-License-Identifier: AGPL-3.0-or-later
// W-transform-applied (Vitest adapter) and W-prod-untouched. The node:test adapter runs the same two witnesses in wal-transform.node-test.mjs.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerThreads from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { TRANSFORM_MARKER, transformWalSource } from "./testing/wal-transform.mjs";

const PROD = ["server/wal-maintenance.ts", "server/io-budget.ts", "server/admission-shared.ts"];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const before = new Map(PROD.map(f => [f, sha(readFileSync(f))]));

it("W-transform-applied: the string passed to new Worker is the transformed worker source (Vitest adapter)", async () => {
  const sources: string[] = [];
  const real = workerThreads.Worker;
  const builtin = process.getBuiltinModule("node:worker_threads") as typeof workerThreads;
  builtin.Worker = class extends real { constructor(source: string | URL, options?: ConstructorParameters<typeof real>[1]) { if (typeof source === "string") sources.push(source); super(source as string, options); } } as typeof real;
  (await import("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports();
  try {
    const wal = await import("./wal-maintenance.ts");
    const dir = mkdtempSync(join(tmpdir(), "wal-transform-"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
    wal.startWalMaintenance(file, { setAutocheckpoint() {}, nudge: async () => false } as never);
    await new Promise(r => setTimeout(r, 200));
    await wal.stopWalMaintenance();
    db.close();
  } finally { builtin.Worker = real; (await import("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports(); }
  expect(sources.length, "a worker was created").toBeGreaterThan(0);
  expect(sources.some(s => s.includes(`/*${TRANSFORM_MARKER}*/`)), "the marker is in the worker source").toBe(true);
});

it("W-transform-applied: a module that is not a target comes back unchanged", () => {
  expect(transformWalSource("/x/server/other.ts", "same")).toBe("same");
});

// The real production text passes through the seam-restore batch untouched; only ONE edit-table anchor (worker-marker) is damaged, so the first and only error can come from the edit table.
const realWal = readFileSync("server/wal-maintenance.ts", "utf8");
const MARKER_ANCHOR = "const WORKER_SOURCE = `";
it("W-transform-applied: the real source transforms (control for the two single-anchor witnesses)", () => {
  expect(realWal.split(MARKER_ANCHOR).length - 1, "the anchor occurs once in production").toBe(1);
  expect(transformWalSource("/x/server/wal-maintenance.ts", realWal)).toContain(`/*${TRANSFORM_MARKER}*/`);
});
it("W-transform-applied: a MISSING edit-table anchor alone fails with the edit table's own named error", () => {
  const damaged = realWal.replace(MARKER_ANCHOR, "const WORKER_SOURCE_RENAMED = `");
  expect(() => transformWalSource("/x/server/wal-maintenance.ts", damaged)).toThrow('wal-transform: anchor "worker-marker" not found in server/wal-maintenance.ts');
});
it("W-transform-applied: a REPEATED edit-table anchor alone fails with the edit table's own named error", () => {
  const doubled = realWal + "\n" + MARKER_ANCHOR + "\n";
  expect(() => transformWalSource("/x/server/wal-maintenance.ts", doubled)).toThrow('wal-transform: anchor "worker-marker" is not unique in server/wal-maintenance.ts');
});
it("W-transform-applied: a missing SEAM anchor fails with the seam-restore's own named error", () => {
  expect(() => transformWalSource("/x/server/wal-maintenance.ts", "nothing here")).toThrow(/^wal-transform: seam anchor "[^"]+" not found in server\/wal-maintenance\.ts$/);
});

it("W-prod-untouched: the production files are byte-identical to git HEAD, and to their bytes before this run", () => {
  const head = process.env.WAL_PROD_HEAD_DIR;
  expect(head, "WAL_PROD_HEAD_DIR names a directory of `git show HEAD:<file>` copies made by the runner").toBeTruthy();
  for (const f of PROD) {
    expect(sha(readFileSync(f)), `${f} differs from HEAD`).toBe(sha(readFileSync(join(head!, f))));
    expect(sha(readFileSync(f)), `${f} changed during the run`).toBe(before.get(f));
  }
});

it("D0-pool: the WAL suites run in forked child processes (pool forks), not worker threads", () => {
  expect(workerThreads.isMainThread, "a worker-thread pool would make this test run inside a Worker").toBe(true);
  expect(typeof process.send, "a forked child has an IPC channel to the pool").toBe("function");
});
