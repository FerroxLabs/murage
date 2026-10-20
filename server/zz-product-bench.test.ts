// Measurement only (throwaway, never merged): what a product write costs on this runner's disk, small and large data dir.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as messages from "./message-db.ts";

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!.toFixed(2);
const dist = (xs: number[]) => `p50 ${q(xs, 0.5)} p95 ${q(xs, 0.95)} max ${q(xs, 1)} ms`;
it("product bench", { timeout: 3_600_000 }, () => {
  const tag = `${process.platform} ${process.env.BENCH_LABEL ?? ""} (${DATA_DIR})`;
  let t = performance.now(); database(); const init = performance.now() - t;
  let n = 0, prev: string | null = null;
  const appends = (count: number) => { const xs: number[] = []; for (let i = 0; i < count; i++) { const id = `m${n++}`; const t0 = performance.now(); messages.appendMessage("bench", { id, text: `words of ${id} `.repeat(20), parentId: prev, at: n, role: "user", kind: "text" } as never); xs.push(performance.now() - t0); prev = id; } return xs; };
  const small = appends(1000);
  closeDatabase();
  // grow messages.db to about 1 GB of other rows (as a long-used install), in big transactions
  t = performance.now();
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS zz_fill(a INTEGER PRIMARY KEY, b BLOB)");
  for (let k = 0; k < 20; k++) { raw.exec("BEGIN"); raw.prepare("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<12500) INSERT INTO zz_fill(b) SELECT randomblob(4000) FROM c").run(); raw.exec("COMMIT"); }
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); raw.close();
  const fill = performance.now() - t;
  t = performance.now(); database(); const reopen = performance.now() - t;
  const large = appends(1000);
  t = performance.now(); const batch = appends(0); void batch;
  console.log(`PRODBENCH ${tag} init ${init.toFixed(0)} ms | append (small db) ${dist(small)} | fill 1GB ${fill.toFixed(0)} ms | reopen ${reopen.toFixed(0)} ms | append (1 GB db) ${dist(large)}`);
  closeDatabase();
});
