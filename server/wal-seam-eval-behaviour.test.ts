// SPDX-License-Identifier: AGPL-3.0-or-later
// P3 behavioural witness (walseam-19m). Runs the REAL production worker (no test transform: vitest.walprod.config.ts) and hands its workerData every field a code seam could read.
// The only code the worker may evaluate is the shipped admissionSource; anything else that runs leaves a marker file. The static guard stays as an extra layer.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerThreads from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const FIELDS = ["barrier", "hooks", "hook", "onStep", "beforeCopy", "trace", "script", "code", "source", "init"];
it("P3: the real worker evaluates nothing from workerData except the shipped admissionSource", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-eval-"));
  const marker = (f: string, shape: string) => join(dir, `${f}-${shape}.ran`);
  const code = (m: string) => `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(m)}, "ran")`;
  const extra: Record<string, unknown> = {};
  for (const f of FIELDS) { extra[f] = code(marker(f, "str")); extra[f + "Obj"] = { source: `(function(){${code(marker(f, "obj"))};return {}})()` }; }
  extra.barrier = { source: `(function(){${code(marker("barrier", "obj"))};return {}})()` };
  const real = workerThreads.Worker;
  const builtin = process.getBuiltinModule("node:worker_threads") as typeof workerThreads;
  builtin.Worker = class extends real { constructor(source: string | URL, options?: ConstructorParameters<typeof real>[1]) { if (options?.workerData) Object.assign(options.workerData as object, extra); super(source as string, options); } } as typeof real;
  (await import("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports();
  let ready = false;
  try {
    const wal = await import("./wal-maintenance.ts");
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
    wal.startWalMaintenance(file, { setAutocheckpoint() {}, nudge: async () => false } as never);
    const end = Date.now() + 20_000; while (Date.now() < end && !wal.walMaintenanceReady()) await new Promise(r => setTimeout(r, 25));
    ready = wal.walMaintenanceReady();
    await new Promise(r => setTimeout(r, 500));
    await wal.stopWalMaintenance(); db.close();
  } finally { builtin.Worker = real; (await import("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports(); }
  const ran = [...FIELDS.flatMap(f => [marker(f, "str"), marker(f, "obj")])].filter(existsSync).map(p => p.slice(dir.length + 1));
  removeTempDirSync(dir);
  expect(ready, "the production worker came up with the injected fields present").toBe(true);
  expect(ran, "injected code that the production worker evaluated").toEqual([]);
});
