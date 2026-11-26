// q1023-cleanopus (owner): what the app's runner does with the 102 kept clean-up jobs on the CLEANED copy: drainRevokeMarker runs every
// bookkeeping job and any revoke job it creates (receipt flips -> audience revokes). Counts only. usage: node /job/bk-drain.ts <db>
import { DatabaseSync } from "node:sqlite";
const { drainRevokeMarker } = await import("/work/server/memory/memory-revocation.ts");
await import("/work/server/memory/revoke-commit.ts");
const db = new DatabaseSync(process.argv[2]!);
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144;");
const n = (s: string) => Number(db.prepare(s).get()!.n);
const c = () => ({ maxRevoke: n("SELECT coalesce(max(revoke_id),0) AS n FROM memory_revoke_jobs"), jobsOpen: n("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')"),
  pending: n("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n"), flips: n("SELECT count(*) AS n FROM memory_receipt_flips"),
  bookkeeping: n("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-revocation:%'"), denyLine: n("SELECT count(*) AS n FROM memory_deny_line"),
  sourcesActive: n("SELECT count(*) AS n FROM memory_sources WHERE state='active'"), records: n("SELECT count(*) AS n FROM memory_records") });
const before = c(); const t0 = Date.now(); let slices = 0, err = "";
try { slices = drainRevokeMarker(db, 50_000_000).slices; } catch (e) { err = String((e as { code?: unknown; message?: unknown }).code ?? (e as Error).message).slice(0, 60); }
console.log("BK-DRAIN", JSON.stringify({ before, after: c(), slices, seconds: Math.round((Date.now() - t0) / 1000), err }));
