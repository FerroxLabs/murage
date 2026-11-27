// q1023-cleanopus: the MODULE path of the same withdraw (owner: q1023-cleanopus). Runs in the test container on a COPY.
// usage: node /job/undo-module.ts <messages.db>
// Every open revoke is put into the undo exactly as revoke-commit.ts undoRevoke does for a held job (same UPDATE, one generation bump),
// minus its foldRefusesUndo guard (owner waiver); then the marker's own slices (revoke-marker.ts markerSlice -> walkerSlice serves
// 'undoing' first -> undoStep, pruneFinished) run until nothing moves; then clearOrphanPending and the cover sweep (reset-hidden-rules.ts
// sweep), one generation bump. Deletion receipts are kept (same as the sql). Bookkeeping clean-up jobs are NOT run (the sql leaves them).
import { DatabaseSync } from "node:sqlite";
const M = "/work/server/memory/";
const marker = await import(M + "revoke-marker.ts");
await import(M + "revoke-commit.ts");
const { lateBuildStep } = await import(M + "memory-revocation.ts");
const { COVER_REVOKE, WALKER_REVOKE, FIRST_LSN } = await import(M + "lineage-types.ts");
const file = process.argv[2]!;
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144;");
const tx = <T>(run: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const out = run(); db.exec("COMMIT"); return out; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
const t0 = Date.now();
const ids = db.prepare("SELECT revoke_id FROM memory_revoke_jobs WHERE state NOT IN ('done','undone') ORDER BY revoke_id").all().map(r => Number(r.revoke_id));
tx(() => {
  db.exec(`CREATE TEMP TABLE w_receipt AS SELECT * FROM main.memory_deny_line WHERE lsn=${FIRST_LSN} AND reason='delete-conversation'
    AND revoke_id IN (SELECT revoke_id FROM main.memory_revoke_jobs WHERE state NOT IN ('done','undone'))`);
  const start = db.prepare("UPDATE memory_revoke_jobs SET phase='undo',cursor='',state='undoing' WHERE revoke_id=?");
  for (const id of ids) { start.run(id); marker.bumpDenyGeneration(db); }
});
let slices = 0;
for (;;) {
  const moved = tx(() => marker.markerSlice(db, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, lateBuildStep));
  slices++;
  if (moved !== true) break;
}
let orphans = 0;
tx(() => {
  db.exec("INSERT INTO main.memory_deny_line SELECT * FROM temp.w_receipt");
  for (;;) { const gone = marker.clearOrphanPending(db, 4096); orphans += gone; if (gone < 4096) break; }
  if (!db.prepare("SELECT 1 FROM memory_revoke_jobs WHERE state NOT IN ('done','undone') LIMIT 1").get())
    db.prepare(`DELETE FROM memory_revoke_reached WHERE revoke_id IN (${COVER_REVOKE},${WALKER_REVOKE})`).run();
  marker.bumpDenyGeneration(db);
});
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const n = (sql: string) => Number(db.prepare(sql).get()!.n);
console.log("UNDO-MODULE", JSON.stringify({ withdrawn: ids.length, slices, orphans, seconds: Math.round((Date.now() - t0) / 1000),
  jobsOpen: n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')"),
  pending: n("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n"),
  frontier: n("SELECT count(*) AS n FROM memory_revoke_frontier") }));
db.close();
