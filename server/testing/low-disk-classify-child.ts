// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child of server/low-disk-classify.test.ts (ACCEPTANCE.md C1): a process whose data dir is the test's directory. It opens the real database with the real
// checkpointer, makes the disk scarce (ballast) and reports, as one JSON line, what the two write wrappers throw. Spawned only by that test.
// Usage: low-disk-classify-child.ts <floor|lag> [ballast file]
const [scenario, ballast = ""] = process.argv.slice(2);
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir || !process.env.LOW_DISK_CLASSIFY_CHILD) { process.stderr.write("refusing: not started by the classify test\n"); process.exit(2); }
const { mkdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
const { DatabaseSync } = await import("node:sqlite");
const { closeDatabase, database, startBackgroundUpgrade, transaction, withBusyBudget } = await import("../database.ts");
const { DatabaseBusyError, DiskFloorRefusal, isLowDisk } = await import("../db-busy.ts");
const { isReadOnly, startMode } = await import("../read-only-start.ts");
const { WAL_ADMISSION_BYTES, assertWalWriteAdmission, walMaintenanceReady } = await import("../wal-maintenance.ts");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MiB = 1024 * 1024;
const kind = (error: unknown) => error instanceof DiskFloorRefusal ? "DiskFloorRefusal" : error instanceof DatabaseBusyError ? "DatabaseBusyError" : error === undefined ? "none" : `other:${String(error)}`;
const run = (fn: () => unknown) => { try { fn(); return undefined; } catch (error) { return error; } };

mkdirSync(dataDir, { recursive: true });
const mode = startMode(dataDir);
const db = database();
for (let i = 0; i < 400 && !walMaintenanceReady(); i++) await sleep(25);
db.exec("CREATE TABLE IF NOT EXISTS c1_probe(n INTEGER)");
transaction(local => local.prepare("INSERT INTO c1_probe VALUES(1)").run());
const out: Record<string, unknown> = { scenario, startMode: mode, ready: walMaintenanceReady() };

if (scenario === "floor") {
  // ballast down to under the worker's 64 MiB floor (the start check was normal), then wait for the worker's verdict
  // Fixture ballast belongs to another process, so it cannot spend the recovery process's real byte budget.
  const { spawnSync } = await import("node:child_process");
  const filled = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { closeSync, openSync, statfsSync, writeSync } from "node:fs";
    const [dir, file] = process.argv.slice(1), MiB = 1024 * 1024;
    const fd = openSync(file, "a"), buf = Buffer.alloc(MiB, 1);
    try { for (;;) { const s = statfsSync(dir), left = s.bavail * s.bsize - 40 * MiB; if (left <= 0) break; writeSync(fd, buf, 0, Math.min(MiB, left)); } }
    finally { closeSync(fd); }
  `, dataDir, ballast], { encoding: "utf8" });
  if (filled.status !== 0) throw new Error(`fixture ballast failed: ${filled.stderr}`);
  let verdict: unknown;
  for (let i = 0; i < 400 && !(verdict = run(() => assertWalWriteAdmission())); i++) await sleep(50);
  const { ioBudget } = await import("../io-budget.ts");
  while (ioBudget.nextAdmissionMs() <= 5_000) await sleep(50);
  out.bootRecoveryRoom = ioBudget.backgroundRoom();
  const recovery = startBackgroundUpgrade();
  const ticket = ioBudget.admit("BOOT_RECOVERY", 64 * 1024);
  out.bootRecoveryRefused = ticket === null;
  if (ticket) ioBudget.settle(ticket, 0);
  recovery.stop();
  const viaBudget = run(() => withBusyBudget(1000, "boot-mark", local => local.exec("INSERT INTO c1_probe VALUES(2)")));
  const viaTransaction = run(() => transaction(local => local.prepare("INSERT INTO c1_probe VALUES(3)").run()));
  Object.assign(out, { verdict: kind(verdict), viaBudget: kind(viaBudget), viaTransaction: kind(viaTransaction), budgetLow: isLowDisk(viaBudget), transactionLow: isLowDisk(viaTransaction), readOnly: isReadOnly() });
} else {
  // ample disk: the retained log is at the admission ceiling while the checkpointer has not caught up: a lagging log, not a low disk
  const file=join(dataDir,"messages.db"), reader=new DatabaseSync(file,{readOnly:true});
  try {
    reader.exec("BEGIN");reader.prepare("SELECT * FROM c1_probe").all();
    db.exec("CREATE TABLE c1_lag(payload BLOB)");
    const insert=db.prepare("INSERT INTO c1_lag VALUES(zeroblob(?))");
    while(statSync(`${file}-wal`).size<WAL_ADMISSION_BYTES) insert.run(8*MiB);
    const error=run(()=>assertWalWriteAdmission(file));
    Object.assign(out,{lag:kind(error),lagLow:isLowDisk(error),readOnly:isReadOnly(),lagBytes:statSync(`${file}-wal`).size,pinned:reader.isTransaction});
  } finally { reader.close(); }
}
closeDatabase();
process.stdout.write(`C1RESULT ${JSON.stringify(out)}\n`);
process.exit(0);
