// Producer owner: recall-prod-y (continuation); consumer owner: recall-fix-h (unchanged Q1 two-seek witness).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect } from 'vitest';
import { it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { fixtureMemoryAccess as memoryAccess } from '../testing/recall-access-fixture.ts';
import { buildMemoryBundle } from './bundle.ts';
import { bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, prepareMemoryDisclosure } from './disclosures.ts';
import { ownerMemoryTicket } from './authority.ts';
import { forgetMemory } from './forget.ts';
import { stopMemoryRevocation } from './memory-revocation.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { stampFreshSession } from './testing/writetime-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { settleTestHandles } from '../test-handle-registry.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { sqlWork } from './testing/sql-work.ts';
import { thawRootSetWritesForTest } from './replay-lineage.ts';
import { REVOKE_PACE, REVOKE_PACE_COMMIT, REVOKE_WRITE_BUDGET, resetRevokeWriteBudget } from './revoke-budget.ts';
const original = { bytes: REVOKE_WRITE_BUDGET.bytesPerMinute, pace: REVOKE_PACE.bytesPerMinute, rows: REVOKE_PACE_COMMIT.rows };
beforeEach(() => { thawRootSetWritesForTest(true); REVOKE_WRITE_BUDGET.bytesPerMinute = Infinity; REVOKE_PACE.bytesPerMinute = Infinity; REVOKE_PACE_COMMIT.rows = 1_000_000; resetRevokeWriteBudget(); });
afterEach(() => { thawRootSetWritesForTest(false); REVOKE_WRITE_BUDGET.bytesPerMinute = original.bytes; REVOKE_PACE.bytesPerMinute = original.pace; REVOKE_PACE_COMMIT.rows = original.rows; resetRevokeWriteBudget(); });
beforeEach(async () => { await removeTempDir(DATA_DIR, { strict: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { stopMemoryRevocation(); await settleTestHandles(DATA_DIR); });
const empty = { search: async () => ({ hits: [], vectorRows: 0 }) };
function addSource(id: string, scope: string, text = "x") {
  const db = database();
  db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,'hash','text','owner','settled',NULL,'active')").run(id, scope, `msg-${id}`);
  storeAnchorMessage(db, "private", `msg-${id}`, text);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash',?,1)").run(id, JSON.stringify({ text }));
}

function liveSetup() {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin("bot", "private");
    const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  return { roster, access, scope: ensureScope("bot", "bot") };
}

it("the next turn after a forget resets a long session from two seeks, without judging or revoking its receipts one by one", async () => {
  const { access, scope } = liveSetup(), db = database();
  db.prepare("INSERT INTO memory_records VALUES('shown',1,?,'fact','The owner keeps backups on Fridays','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  addSource("source-shown", scope, "The owner keeps backups on Fridays");
  db.prepare("INSERT INTO memory_evidence VALUES('shown',1,'source-shown',1,0,?)").run(Buffer.byteLength("The owner keeps backups on Fridays"));
  const a = access();
  const bundle = await buildMemoryBundle("anything", a, empty, { allowance: LineageAllowance.tool() });
  prepareMemoryDisclosure(bundle, a, "claude");
  bindMemoryDisclosureSession(bundle.bundleId, "session-1");
  stampFreshSession(database(), "private", "claude", "session-1"); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  deliverMemoryDisclosure(bundle.bundleId, a);
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  // a long session: 20k more receipts under the same epoch, each citing the record shown
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) SELECT 'long'||i,'private','claude','session-1','[{"id":"shown","version":1}]','[]',?,?,0,'delivered',i FROM n`).run(meta.policy_revision, meta.deletion_epoch);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "source-shown" });
  stopMemoryRevocation(); // the job's own slices are not what this measures
  const revoked = () => Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session='session-1' AND state='revoked'").get()!.n);
  const before = revoked();
  const why: { reason?: string } = {};
  const t0 = performance.now();
  const currentAccess = access();
  const { result, work } = sqlWork(db, () => continuationMemoryRevoked(LineageAllowance.tool(), "private", "claude", "session-1", currentAccess, why));
  expect(result).toBe(true);
  expect(performance.now() - t0).toBeLessThan(20);
  expect(why.reason).toMatch(/^writetime-session-forgotten$/);
  expect(revoked() - before).toBeLessThanOrEqual(1);
  const seeks = [...work.sqls].reduce((total, [sql, count]) => total + (/^\s*(SELECT|WITH)\b/i.test(sql) ? count : 0), 0);
  expect(seeks, "two-seek continuation bound").toBeLessThanOrEqual(2);
}, 300_000);
