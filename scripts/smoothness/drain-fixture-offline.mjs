// Fixture preparation only, in a network-none container with the server stopped.
// Invoke the PRODUCT's exported offline drain. Never edit job rows in the rig.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const data = '/smooth-data/murage';
if (realpathSync(data) !== data || existsSync(`${data}/config.json`)) throw Error('requires the stopped isolated copy');
process.env.MURAGE_DATA_DIR = data;
process.env.HOME = '/tmp/offline-home';
// Register the same fold hook used by normal boot before asking the product to drain.
await import('/work/server/memory/revoke-fold.ts');
const { database, closeDatabase } = await import('/work/server/database.ts');
const { drainRevokeMarker, revocationWorkPending } = await import('/work/server/memory/memory-revocation.ts');
const began = performance.now();
const db = database();
function counts() {
  return { activeJobs: Number(db.prepare("SELECT count(*) n FROM memory_revoke_jobs WHERE state='active'").get().n),
    pendingJobs: Number(db.prepare("SELECT count(*) n FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')").get().n),
    pendingFlips: Number(db.prepare('SELECT count(*) n FROM memory_receipt_flips').get().n) };
}
try {
  const before = counts();
  console.log(JSON.stringify({ phase: 'before', ...before }));
  const result = drainRevokeMarker(db);
  const after = counts();
  const report = { method: 'product drainRevokeMarker', product: process.env.PRODUCT_SHA,
    before, after, result, workPending: revocationWorkPending(db), elapsedMs: performance.now() - began };
  writeFileSync('/out/offline-drain.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (result.pending || report.workPending || after.pendingJobs || after.pendingFlips) throw Error('product offline drain left pending work');
} finally { closeDatabase(); }
