// One idle poll of the procedure-review queue asks who may read for every parked
// review (up to 64 a visit), and each ask walked the whole roster, confirming
// every room and thread scope by primary key: 976,072 confirmations in one
// minute on the live store. Within one synchronous pass an audience is worked
// out once per bot and thread; any write, or a changed roster, ends the memo.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { createProcedureReviewHost } from "../procedure-review-host.ts";
import { backgroundMemoryScopes, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { inEligibilityPass } from "./eligibility-pass.ts";
import { setMemoryMode } from "./repository.ts";
import { pendingProcedureReviews, procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureReviewSnapshot } from "./procedure-review.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** Counts the RUNS (get, all, run) of statements whose SQL contains `needle`, from the
 * moment of the call on, for statements prepared after it: install it before first use. */
function runCounter(db: ReturnType<typeof database>, needle: string): () => number {
  const real = db.prepare.bind(db); let runs = 0;
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    if (!sql.includes(needle)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { if (key === "get" || key === "all" || key === "run" || key === "iterate") runs++; return value.apply(target, args); };
    } });
  };
  return () => runs;
}
const CONFIRM = "SELECT 1 FROM memory_scopes WHERE id=? AND kind=? AND owner_key=?";

function world(rooms = 40, threadsPerRoom = 5) {
  const bots = [0, 1, 2].map(i => ({ id: `bot${i}`, threadId: `bot${i}-main`, section: "Ops", tasks: [{ threadId: `bot${i}-task` }] }));
  const groups = Array.from({ length: rooms }, (_, r) => ({ id: `room${r}`, threadId: `room${r}-main`, section: "Ops", memberIds: bots.map(b => b.id),
    tasks: Array.from({ length: threadsPerRoom - 1 }, (_, t) => ({ threadId: `room${r}-t${t}` })) }));
  const roster: MemoryRoster = { bots, groups };
  const store = { bots, groups, bot: (id: string) => bots.find(b => b.id === id), groupTaskByThread: () => undefined, taskByThread: () => undefined } as any;
  return { roster, store };
}

/** A parked review whose receipt is valid, so the host reaches its audience check. */
function park(db: ReturnType<typeof database>, i: number, botId: string, threadId: string) {
  const snapshot: ProcedureReviewSnapshot = { requestId: `req${i}`, scopeId: "s", evidenceDigest: "e".repeat(64), policyRevision: 0, deletionEpoch: 0, learningRevision: 0, evidence: [], outcomeBasis: "source-reported",
    target: { kind: "skill", scopeId: "no-such-scope", ownerId: botId, artifactId: "x", baseRevision: "r", threadId, bundleId: "b" } };
  const candidate = "Verify the output.";
  const receipt = { id: `rc${i}`, requestId: snapshot.requestId, targetDigest: procedureTargetDigest(snapshot.target), snapshotDigest: procedureSnapshotDigest(snapshot), evidenceDigest: snapshot.evidenceDigest,
    candidate, candidateHash: procedureCandidateHash(candidate), evaluator: "t", decision: "accepted", heldout: { corpusDigest: "c".repeat(64), untouched: true, cases: 3, baseline: 1, candidate: 2, regressions: 0 }, budgetRespected: true, cancelled: false };
  const intent = { schema: 1, id: `procedure-review:${i}`, scopeId: "s", status: "deferred", retryAfter: Date.now() + 3_600_000, evidence: [], policyRevision: 0, deletionEpoch: 0, learningRevision: 0, snapshot, receipt };
  const scope = db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','procedure-review-pending',0,'granted',?)").run(intent.id, scope, JSON.stringify(intent));
}

function setup() {
  const { roster, store } = world();
  const db = database(), runs = runCounter(db, CONFIRM);
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  for (let i = 0; i < 64; i++) park(db, i, `bot${i % 3}`, `bot${i % 3}-main`);
  const host = createProcedureReviewHost({ store, routines: () => undefined as any, validateEvidence: () => true, skills: { current: () => undefined, publish: () => {}, wasPublished: () => false } as any });
  return { roster, db, host, runs };
}

it("one poll over 64 parked reviews confirms each room and thread scope once per bot, not once per review", () => {
  const { host, runs } = setup(), before = runs();
  pendingProcedureReviews(1, host.host);
  // 3 bots x (40 rooms x 5 threads + a few own scopes); before the pass memo this was 64 x that.
  expect(runs() - before).toBeLessThanOrEqual(3 * 245);
});

it("inside a pass the answer is remembered; a deleted scope, a roster change or the pass ending all end the memo", () => {
  const { roster, db, runs } = setup();
  const room = db.prepare("SELECT id FROM memory_scopes WHERE kind='room' AND owner_key='room3'").get()!.id as string;
  inEligibilityPass(db, () => {
    const first = backgroundMemoryScopes("bot0", "bot0-main", roster);
    expect(first).toContain(room);
    const before = runs();
    expect(backgroundMemoryScopes("bot0", "bot0-main", roster)).toEqual(first);
    expect(runs()).toBe(before);
    // a row written mid-pass: the scope is gone, so it is not answered from the memo
    db.prepare("DELETE FROM memory_scopes WHERE id=?").run(room);
    expect(backgroundMemoryScopes("bot0", "bot0-main", roster)).not.toContain(room);
  });
  // a room dropped from the roster mid-pass
  const other = db.prepare("SELECT id FROM memory_scopes WHERE kind='room' AND owner_key='room4'").get()!.id as string;
  inEligibilityPass(db, () => {
    expect(backgroundMemoryScopes("bot0", "bot0-main", roster)).toContain(other);
    const dropped = { bots: roster.bots, groups: roster.groups.filter(g => g.id !== "room4") };
    expect(backgroundMemoryScopes("bot0", "bot0-main", dropped)).not.toContain(other);
  });
  // a same-length groups array that swaps a room out (review F1): a new array ends the memo
  inEligibilityPass(db, () => {
    expect(backgroundMemoryScopes("bot0", "bot0-main", roster)).toContain(other);
    const swapped = { bots: roster.bots, groups: roster.groups.map(g => g.id === "room4" ? { ...g, memberIds: ["bot1"] } : g) };
    expect(backgroundMemoryScopes("bot0", "bot0-main", swapped)).not.toContain(other);
  });
  // outside a pass nothing is remembered: every ask confirms again
  const mark = runs();
  backgroundMemoryScopes("bot0", "bot0-main", roster); backgroundMemoryScopes("bot0", "bot0-main", roster);
  expect(runs() - mark).toBeGreaterThan(400);
});
