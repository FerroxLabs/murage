// Measurement only (throwaway, never merged): SQLite commit latency on this runner's disks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";

function bench(dir: string, sync: string, n: number): string {
  const db = new DatabaseSync(join(dir, `b-${sync}.db`));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${sync}; CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)`);
  const ins = db.prepare("INSERT INTO t(b) VALUES(?)");
  const times: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); ins.run("x".repeat(200)); times.push(performance.now() - t0); }
  const t0 = performance.now(); db.exec("BEGIN"); for (let i = 0; i < 10_000; i++) ins.run("y".repeat(200)); db.exec("COMMIT"); const batch = performance.now() - t0;
  db.close();
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.floor(p * (times.length - 1))]!.toFixed(2);
  return `${sync} autocommit p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)} ms; 10k rows in one txn ${batch.toFixed(0)} ms`;
}
it("disk bench", { timeout: 600_000 }, () => {
  const dirs: Array<[string, string]> = [["os.tmpdir", mkdtempSync(join(tmpdir(), "bench-"))]];
  if (process.env.RUNNER_TEMP) dirs.push(["RUNNER_TEMP", mkdtempSync(join(process.env.RUNNER_TEMP, "bench-"))]);
  dirs.push(["workspace", mkdtempSync(join(process.cwd(), "bench-"))]);
  for (const [name, dir] of dirs) for (const sync of ["FULL", "NORMAL"]) console.log(`DISKBENCH ${process.platform} ${name} (${dir}) ${bench(dir, sync, 500)}`);
});
