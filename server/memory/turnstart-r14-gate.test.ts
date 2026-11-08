// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 + r14.1 + r15, T12 THE GATE (r13 D:196-214 as amended by r14 sec. 6, r14.1 X6 and r15 sec. 5). Seeded random op
// sequences; after EVERY op, for every thread reading "warm":
//   CORRECTNESS + REAL ENTRY (r15): the NEXT plain send: send() appends the user line and runs NO warm step (the turn hold), then dispatch()
//   runs the IX:13283 compare and the real turn path (E2 -> recall spent -> E1 with E3 inside, head = the sent line) on ONE fresh turn
//   allowance with the TURN's actual footprint. If that footprint equals the confirmed one: verdict "match", a hit (zero judge misses,
//   listings, keeps, hold writes, handle and memo misses, merges, deferred, unfinished; allowance not hit) and the answer equals the cold
//   legacy judge. A changed footprint must be a counted miss and claim nothing. Recall rotates 1500 / 0 / 500 (flagfold F2/F8).
//   USEFULNESS (r15 (e)): per seed the owner thread matched at least once, and no warm step ran between a send and its dispatch.
// LIVENESS (no fault active): every record that is not OVERSIZE / SHARED / not-kept / RECOVERING reads "warm" within HOT_DEADLINE of fake
//   time; each such outcome is accepted only with the generator's own evidence for it (see `accept`).
// CI: 3 seeds x 400 ops (MURAGE_T12_SEEDS / MURAGE_T12_OPS widen it nightly: 50 x 2,000). A failure prints seed, op index and op.
// RB: on b13e r14Surface() throws (no lineageWarmTestSurface), recorded red; the RED commit's real-entry cases are the tip-adapter red.
import { describe, expect, it } from "vitest";
import { HIT_ONLY, HOT_DEADLINE, RECALL_RESERVE, hitOnly, lineageThreadState, r14Surface, rng, type R14Footprint, type R14Surface, type UserKind } from "./testing/turnstart-r14-surface.ts";
import { database } from "../database.ts";
import * as RL from "./replay-lineage.ts";

const SEEDS = Number(process.env.MURAGE_T12_SEEDS ?? 3), OPS = Number(process.env.MURAGE_T12_OPS ?? 400);

/** DB ops come from TURNCACHE-FAILOPEN's exported INVALIDATION_SET (agreed 17:14Z); until that lane merges, the tip's covered set. */
type InvalidationRow = { table: string; op: "INSERT" | "UPDATE" | "DELETE"; kind: string; rows: "OLD" | "NEW" | "OLD+NEW"; when?: string; trigger: string };
const TURNSTART_INVALIDATION_FALLBACK: readonly InvalidationRow[] = [
  { table: "memory_disclosure_outputs", op: "INSERT", kind: "o", rows: "NEW", trigger: "tip" },
  { table: "memory_disclosure_outputs", op: "DELETE", kind: "o", rows: "OLD", trigger: "tip" },
  { table: "memory_output_roots", op: "INSERT", kind: "m", rows: "NEW", trigger: "tip" },
  { table: "memory_output_roots", op: "UPDATE", kind: "m", rows: "OLD+NEW", trigger: "lineage_roots_u (OLD by TURNSTART)" },
  { table: "memory_output_roots", op: "DELETE", kind: "m", rows: "OLD", trigger: "tip" },
  { table: "memory_disclosures", op: "UPDATE", kind: "m", rows: "OLD+NEW", trigger: "lineage_receipts_u (Option A)" },
  { table: "memory_root_set_members", op: "DELETE", kind: "x", rows: "OLD", trigger: "lineage_root_sets_d (+STRUCT)" },
];
const INVALIDATION: readonly InvalidationRow[] =
  ((RL as unknown as { INVALIDATION_SET?: readonly InvalidationRow[] }).INVALIDATION_SET) ?? TURNSTART_INVALIDATION_FALLBACK;

type Op =
  | "send-owner" | "send-nonowner" | "send-kind" | "receipt-update" | "append-merge-then-read" | "db-write" | "foreign-commit"
  | "evict" | "half-drop" | "hold-evict" | "hold-scope" | "authority-move" | "handle-capacity" | "struct-unrelated" | "struct-members-update"
  | "chains-clear" | "forgets-evict" | "footprint-model" | "footprint-exclude" | "footprint-session" | "audience-change" | "root-set-x"
  | "proof-restart" | "supersede" | "session-sound-cap" | "group-store-cap" | "lost-tail" | "lost-middle" | "restart" | "seal-then-evict"
  | "seal-then-key" | "clear-then-hot" | "feed-throws" | "ttl-age" | "copy-window" | "recall-over-reserve" | "room-30k";
const OPS_LIST: readonly Op[] = [
  "send-owner", "send-nonowner", "send-kind", "receipt-update", "append-merge-then-read", "db-write", "foreign-commit", "evict", "half-drop",
  "hold-evict", "hold-scope", "authority-move", "handle-capacity", "struct-unrelated", "struct-members-update", "chains-clear", "forgets-evict",
  "footprint-model", "footprint-exclude", "footprint-session", "audience-change", "root-set-x", "proof-restart", "supersede", "session-sound-cap",
  "group-store-cap", "lost-tail", "lost-middle", "restart", "seal-then-evict", "seal-then-key", "clear-then-hot", "feed-throws", "ttl-age",
  "copy-window", "recall-over-reserve", "room-30k",
];
const KINDS: readonly UserKind[] = ["EXPLICIT", "PROJECT", "EDIT", "HELD", "SYNTHETIC"];

interface Gen { s: R14Surface; r: () => number; threads: string[]; owner: string; nonOwner: string; copyHolder: string; fault: boolean;
  /** footprint overrides the generator's next turns on a thread will carry (W4; persistent until changed) */ turnF: Map<string, Partial<R14Footprint>>;
  /** r15 (e): covered dispatches per thread */ matches: Map<string, number>; step: number;
  /** evidence for liveness acceptance */ evidence: Map<string, Set<string>>;
  /** the S2 revoked arm: threads accepted "revoked" (with their cause) that must re-warm and match after their next send */ revokedPending: Map<string, string>;
  revokedAccepts: number; livenessChecks: number;
  /** distinct threads ever accepted "revoked", and those of them that re-warmed and matched after a later send */ revokedThreads: Set<string>; rewarmed: Set<string> }
const pick = <T>(g: Gen, list: readonly T[]): T => list[Math.floor(g.r() * list.length)]!;
const note = (g: Gen, thread: string, why: string) => { let set = g.evidence.get(thread); if (!set) g.evidence.set(thread, set = new Set()); set.add(why); };

/** Applies one op. Ops that lower a limit restore it before returning (the eviction op's shape, Fable r13 H1 iii). */
function apply(g: Gen, op: Op): void {
  const { s } = g, t = pick(g, g.threads), db = database();
  g.fault = false;
  switch (op) {
    case "send-owner": turn(g, g.owner); return;
    case "send-nonowner": turn(g, g.nonOwner); note(g, g.nonOwner, "SHARED"); return;
    case "send-kind": {
      const kind = pick(g, KINDS); s.send(t, kind);
      expect(s.dispatch(t, { over: { ...g.turnF.get(t), userKind: kind } }).verdict, `a ${kind} turn is never covered (r15 sec. 2)`).toMatch(/^miss/);
      note(g, t, `kind:${kind}`); return;
    }
    case "footprint-model": override(g, t, { maxBytes: 50_000 + Math.floor(g.r() * 4) * 50_000 }); return;
    case "footprint-exclude": override(g, t, { exclude: [`x${Math.floor(g.r() * 3)}`] }); return;
    case "footprint-session": override(g, t, { cursor: { instanceId: "engine", nativeSession: `S${Math.floor(g.r() * 3)}`, incarnation: 1 } }); return;
    case "append-merge-then-read": {
      // an in-place append merge (RL:1724-1735, added > 0) and a state read BEFORE any re-confirm (Astra r13 f)
      const at = Date.now();
      db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[]',1,0,1,'delivered',?)")
        .run(`merge-${at}-${Math.floor(g.r() * 1e9)}`, t, "engine", "S", at);
      check(g, `${op} (before re-confirm)`); return;
    }
    case "db-write": {
      const row = pick(g, INVALIDATION);
      // one representative write per row; tables without a fixture row are skipped (counted, so a seed that never writes fails `coverage`)
      if (!writeRow(g, row)) return; note(g, "*", `db:${row.table}:${row.op}`); return;
    }
    case "evict": s.setLimits({ verdictLimit: 8 }); turn(g, pick(g, g.threads)); s.setLimits({ verdictLimit: undefined as never }); return;
    case "half-drop": s.setLimits({ edgeBound: 8 }); turn(g, pick(g, g.threads)); s.setLimits({ edgeBound: undefined as never }); return;
    case "hold-evict": s.setLimits({ sessionHoldsMax: 1 }); turn(g, pick(g, g.threads)); s.setLimits({ sessionHoldsMax: undefined as never }); return;
    case "handle-capacity": s.setLimits({ maxHandles: 1 }); turn(g, pick(g, g.threads)); s.setLimits({ maxHandles: undefined as never }); return;
    case "forgets-evict": s.setLimits({ threadForgetsMax: 1 }); turn(g, pick(g, g.threads)); s.setLimits({ threadForgetsMax: undefined as never }); return;
    case "authority-move":
      db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES(?,'record','nobody',NULL,NULL,1,'forgotten',1)").run(`tz${Math.floor(g.r() * 1e9)}`);
      return;
    case "struct-unrelated": {
      const set = db.prepare("SELECT set_id,root_message_id FROM memory_root_set_members WHERE set_id IN (SELECT set_id FROM memory_output_roots WHERE thread_id=?) LIMIT 1").get(g.copyHolder);
      if (set) db.prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_message_id=?").run(set.set_id, set.root_message_id);
      return;
    }
    case "recall-over-reserve": g.fault = true; return; // probed below with recall > reserve: counted, not a W''' failure
    case "room-30k": s.fixture("room-30k"); return;      // Astra r14 H14-2: must never read warm with the reserve charged unless the confirm proved it
    case "restart": case "clear-then-hot": case "ttl-age": case "seal-then-evict": case "seal-then-key": case "feed-throws": case "lost-tail":
    case "lost-middle": case "proof-restart": case "supersede": case "session-sound-cap": case "group-store-cap": case "copy-window":
    case "audience-change": case "root-set-x": case "receipt-update": case "foreign-commit": case "chains-clear": case "hold-scope":
    case "struct-members-update":
      if (op === "audience-change") note(g, "*", "audience-change");
      // the surface's fixture owns these (it knows the warmer's internals); the generator only names them
      s.fixture("gate", { op: OPS_LIST.indexOf(op), seed: Math.floor(g.r() * 1e9) }); if (op === "feed-throws") g.fault = true; return;
  }
}
function writeRow(g: Gen, row: InvalidationRow): boolean {
  const db = database(), t = pick(g, g.threads);
  const msg = db.prepare("SELECT id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(t);
  if (!msg) return false;
  try {
    if (row.table === "memory_output_roots" && row.op === "UPDATE") db.prepare("UPDATE memory_output_roots SET message_id=message_id WHERE thread_id=? AND message_id=?").run(t, msg.id);
    else if (row.table === "memory_disclosures" && row.op === "UPDATE") db.prepare("UPDATE memory_disclosures SET state=state WHERE thread_id=?").run(t);
    else if (row.op === "DELETE") db.prepare(`DELETE FROM ${row.table} WHERE rowid=(SELECT max(rowid) FROM ${row.table})`).run();
    else return false; // INSERT rows: the sends and fixtures write them
    return true;
  } catch { return false; }
}

/** One whole plain turn on t: send (no warm step), dispatch with the thread's current overrides (r15). */
function turn(g: Gen, t: string): void { g.s.send(t); g.s.dispatch(t, { over: g.turnF.get(t) }); }
function override(g: Gen, t: string, over: Partial<R14Footprint>): void { g.turnF.set(t, { ...g.turnF.get(t), ...over }); }

/** The CORRECTNESS + REAL-ENTRY oracle after one op: the NEXT plain send on every warm thread (r15 sec. 5). */
function check(g: Gen, where: string, only?: string): void {
  const { s } = g;
  // `only`: that thread alone (a dispatch forgets what is kept, so later threads of the loop would read pending)
  for (const t of only === undefined ? g.threads : [only]) {
    if (lineageThreadState(t) !== "warm") continue;
    const over = g.turnF.get(t);
    const confirmed = s.record(t)?.footprintHash ?? null;
    const same = confirmed !== null && s.footprintHash(s.turnFootprint(t, over)) === confirmed;
    const recall = g.fault ? RECALL_RESERVE + 500 : [RECALL_RESERVE, 0, 500][g.step++ % 3]!;
    s.send(t);
    const d = s.dispatch(t, { recallNodes: recall, over });
    if (!same) { expect(d.verdict, `${where}: ${t} warm, footprint changed: must be a counted miss`).toMatch(/^miss/); continue; }
    const at = `${where}: ${t} read warm with a matching footprint, dispatch ${JSON.stringify(d)}`;
    expect(d.verdict, at).toBe("match");
    g.matches.set(t, (g.matches.get(t) ?? 0) + 1);
    if (g.fault) continue; // recall over the reserve: outside W4's allowance condition, counted by warmAllowanceHit
    expect(hitOnly(d.counts), at).toEqual(HIT_ONLY);
    expect({ revoked: d.counts.revoked, withheld: [...d.counts.withheld].sort() }, `${at} vs legacy`).toEqual({ revoked: d.legacy.revoked, withheld: [...d.legacy.withheld].sort() });
    if (g.revokedPending.delete(t)) g.rewarmed.add(t); // a revoked-accepted thread re-warmed after a send and matched (S2 arm, condition 3)
  }
}
/** The S2 revoked arm, LIVENESS ONLY (Grok r15.1 S2 REVOKE VOIDS, MurageMain 18:01Z; T12 ruling by the TURNSTART lead + MurageMain 11-07): a
 * session whose E2 answers revoked can claim nothing until a send renews it, so "warm by HOT_DEADLINE" is unreachable without a send. Accepted
 * only when (1) the record's last confirm saw E2 revoked, (2) an independent cold E2 on the task row's cursor answers revoked now, and (3) the
 * cause is the production one: an audience change (the generator ran one) left the cursor's receipts under an older policy_revision. Any other
 * cause fails. Every soundness assert is untouched; an accepted thread must re-warm and match after its next send within the seed. */
function revokedArm(g: Gen, t: string, rec: NonNullable<ReturnType<R14Surface["record"]>>): { ok: boolean; cause: string } {
  if (rec.reason !== "revoked" || rec.lastConfirm?.revoked !== true) return { ok: false, cause: "not a revoked confirm" };
  const cold = g.s.coldE2(t);
  const policy = cold.receiptRevision !== null && cold.receiptRevision < cold.policyRevision && (g.evidence.get("*")?.has("audience-change") ?? false);
  const cause = `${policy ? "policy-revision" : "other"} (session ${cold.session}, receipts rev ${cold.receiptRevision}, now ${cold.policyRevision}, cold E2 ${cold.revoked ? "revoked" : "not revoked"}: ${cold.why ?? "-"})`;
  // MUTANT:revoked-arm-unconditional
  return { ok: cold.revoked && policy, cause };
}
/** The RECOVERING arm's evidence: at least CONFIRM_TRIES rounds, within the slice bound. */
function recoveringOk(rec: NonNullable<ReturnType<R14Surface["record"]>>, at: string): void {
  expect(rec.outcome, at).toBe("RECOVERING");
  expect(rec.confirmRounds, at).toBeGreaterThanOrEqual(3); expect(rec.recoverSlices, at).toBeLessThanOrEqual(16);
}
/** Root-set damage (the generator's member DELETEs: root-set-x, struct-unrelated, db-write): a set of t whose stored size is not its member
 * count; storedHandle never fits it and fails closed (RL:2588), so the thread cannot warm. Read from the DB. */
function rootSetDamage(t: string): string[] {
  return database().prepare("SELECT s.set_id AS id, s.size AS size, (SELECT count(*) FROM memory_root_set_members m WHERE m.set_id=s.set_id) AS n FROM memory_root_sets s WHERE s.set_id IN (SELECT set_id FROM memory_output_roots WHERE thread_id=?)")
    .all(t).filter(row => Number(row.size) !== Number(row.n)).map(row => `${String(row.id)} size ${Number(row.size)} members ${Number(row.n)}`);
}
/** LIVENESS with the capacity precondition: only evidenced outcomes are accepted. */
function accept(g: Gen, where: string): void {
  const { s } = g;
  s.advance(HOT_DEADLINE);
  for (const t of g.threads) {
    const rec = s.record(t);
    if (!rec) continue;
    g.livenessChecks++;
    if (lineageThreadState(t) === "warm") continue;
    const ev = g.evidence.get(t) ?? new Set<string>();
    const at = `${where}: ${t} not warm by HOT_DEADLINE, record ${JSON.stringify(rec)}, evidence ${JSON.stringify([...ev])}`;
    if (rec.outcome === null && rec.reason === "revoked") {
      const arm = revokedArm(g, t, rec);
      if (!arm.ok) throw new Error(`${at}, revoke cause ${arm.cause}`);
      g.revokedAccepts++; g.revokedThreads.add(t); g.revokedPending.set(t, `${where}: ${arm.cause}`);
      continue;
    }
    switch (rec.outcome) {
      case "SHARED": expect(t, at).toBe(g.nonOwner); break;
      case "RECOVERING": recoveringOk(rec, at); break;
      case "OVERSIZE": expect(rec.reason ?? "", at).toMatch(/^(trace|foreign|allowance|edges)/); break;
      default:
        if (!rec.admitted) { expect(rec.reason ?? "", at).toMatch(/^(budget|group|edges|access)/); break; }
        if ([...ev].some(e => e.startsWith("kind:"))) break; // a non-APPENDED turn: never predicted (r14.1 X1)
        throw new Error(at);
    }
  }
}

describe("T12 THE GATE (r14 + r14.1)", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed} x ${OPS} ops: warm is only ever claimed for a matching footprint whose real entry is a hit and agrees with legacy`, () => {
      const s = r14Surface();
      try {
        const threads = s.fixture("gate", { seed });
        const g: Gen = { s, r: rng(seed), threads, owner: threads[0]!, nonOwner: threads[1]!, copyHolder: threads[3]!, fault: false, turnF: new Map(), evidence: new Map(), matches: new Map(), step: 0,
          revokedPending: new Map(), revokedAccepts: 0, livenessChecks: 0, revokedThreads: new Set(), rewarmed: new Set() };
        const seen = new Map<Op, number>();
        for (let index = 0; index < OPS; index++) {
          const op = index < OPS_LIST.length * 3 ? OPS_LIST[index % OPS_LIST.length]! : pick(g, OPS_LIST);
          seen.set(op, (seen.get(op) ?? 0) + 1);
          const where = `seed ${seed} op #${index} ${op}`;
          apply(g, op);
          check(g, where);
          if (!g.fault) accept(g, where);
        }
        // every op ran at least 3 times per seed (r13 D:197)
        for (const op of OPS_LIST) expect(seen.get(op) ?? 0, `seed ${seed}: op ${op} coverage`).toBeGreaterThanOrEqual(3);
        // C8: confirms per step and per record per step are bounded (r14 C8)
        expect(s.counters().confirmsPerStepMax).toBeLessThanOrEqual(4);
        expect(s.counters().confirmsPerRecordPerStepMax).toBeLessThanOrEqual(1);
        // S4: no pinned entry was ever evicted outside the all-pinned fallback
        expect(s.counters().pinnedEvictions).toBe(0);
        // r15 (d)(e): the claim is reachable on real sends (never safe-but-dead) and no warm step ran inside a turn hold
        expect(g.matches.get(g.owner) ?? 0, `seed ${seed}: the owner thread never matched`).toBeGreaterThan(0);
        expect(s.counters().warmStepsBetweenSendAndDispatch).toBe(0);
        // T11(g): no removed key had an UNKNOWN owner
        expect(s.counters().unknownOwners).toBe(0);
        // S2 revoked arm, condition 3 (lead ruling 11-07): after its NEXT send, (a) every accepted thread is no longer revoked, and (b) it
        // re-warms and matches, except (named, counted) when it ends RECOVERING on a root set the generator damaged (rootSetDamage)
        let rootSetExceptions = 0;
        g.fault = false;
        for (const [t, cause] of [...g.revokedPending]) {
          // the next send is a plain one: a generator override the confirm cannot predict (footprint-session names another session) would make
          // every later turn a counted miss by construction, never a match
          g.turnF.delete(t);
          turn(g, t);
          s.advance(HOT_DEADLINE);
          const rec = s.record(t), at = `seed ${seed}: ${t} accepted revoked (${cause}), after its next send: record ${JSON.stringify(rec)}`;
          expect(s.coldE2(t).revoked, `${at}: the cold E2 still answers revoked (no renew)`).toBe(false);
          expect(rec?.lastConfirm?.revoked, `${at}: the last confirm still saw revoked`).toBe(false);
          if (lineageThreadState(t) !== "warm") {
            const damage = rootSetDamage(t);
            expect(damage.length, `${at}: did not re-warm, and no root-set damage explains it`).toBeGreaterThan(0);
            recoveringOk(rec!, `${at}, root-set damage ${JSON.stringify(damage)}`);
            rootSetExceptions++; g.revokedPending.delete(t); continue;
          }
          check(g, `seed ${seed} revoked re-warm ${t}`, t);
          expect(g.revokedPending.has(t), `${at}: re-warmed but never matched`).toBe(false);
        }
        // the arm rejects a revoke with no production cause: the owner's current receipts flipped to revoked directly (no policy change)
        // (a record that CLAIMS a revoked confirm on the owner, whose session the cold E2 does not find revoked, renewed after its last send)
        {
          turn(g, g.owner); s.advance(HOT_DEADLINE); // renews the owner's session if an audience change revoked it
          const rec = s.record(g.owner);
          expect(rec, `seed ${seed}: the owner has a record for the counterfeit probe`).not.toBeNull();
          expect(s.coldE2(g.owner).revoked, `seed ${seed}: counterfeit probe precondition (the owner's session is not revoked)`).toBe(false);
          const claimed = { ...rec!, outcome: null, reason: "revoked", lastConfirm: { ...rec!.lastConfirm!, revoked: true } };
          const arm = revokedArm(g, g.owner, claimed);
          expect(arm.ok, `seed ${seed}: a revoke the cold E2 does not see, with no production cause, is accepted (${arm.cause})`).toBe(false);
        }
        // (c) the deterministic renew probe on a healthy thread (a cursor, no root-set damage, not the non-owner): audience change -> the arm
        // accepts it with cause policy-revision -> send (renew) -> warm -> match. No exception applies here.
        {
          const probe = g.threads.find(t => t !== g.nonOwner && rootSetDamage(t).length === 0 && s.coldE2(t).session !== null);
          expect(probe, `seed ${seed}: no healthy thread with a session for the renew probe`).toBeDefined();
          const t = probe!, where = `seed ${seed} renew probe ${t}`;
          g.turnF.delete(t); // a plain send (no generator override)
          turn(g, t); s.advance(HOT_DEADLINE);
          expect(lineageThreadState(t), `${where}: warm before the audience change, record ${JSON.stringify(s.record(t))}`).toBe("warm");
          s.fixture("gate", { op: OPS_LIST.indexOf("audience-change"), seed: 0 }); note(g, "*", "audience-change");
          s.advance(HOT_DEADLINE);
          const rec = s.record(t);
          expect(rec?.reason, `${where}: the audience change revokes the session, record ${JSON.stringify(rec)}`).toBe("revoked");
          const arm = revokedArm(g, t, rec!);
          expect(arm.ok && arm.cause.startsWith("policy-revision"), `${where}: the arm accepts it (${arm.cause})`).toBe(true);
          const before = g.matches.get(t) ?? 0;
          turn(g, t); s.advance(HOT_DEADLINE);
          expect(lineageThreadState(t), `${where}: re-warms after its next send (renew), record ${JSON.stringify(s.record(t))}`).toBe("warm");
          check(g, where, t);
          expect(g.matches.get(t) ?? 0, `${where}: matches after the renew`).toBeGreaterThan(before);
        }
        // condition 4: the arm is never the only liveness path; reported per seed
        console.log(`T12 seed ${seed}: revokedAccepts ${g.revokedAccepts} of ${g.livenessChecks} liveness checks; accepted threads ${g.revokedThreads.size}, re-warmed+MATCH ${g.rewarmed.size}, RECOVERING-with-evidence ${rootSetExceptions}; owner matches ${g.matches.get(g.owner) ?? 0}`);
        // MurageMain 11-07: the root-set exception is never the main path
        expect(rootSetExceptions, `seed ${seed}: RECOVERING-with-evidence ${rootSetExceptions} > half of ${g.revokedThreads.size} accepted threads`).toBeLessThanOrEqual(g.revokedThreads.size / 2);
        expect(g.revokedAccepts, `seed ${seed}: revokedAccepts`).toBeLessThan(g.livenessChecks);
      } finally { s.setLimits(null); }
    });
  }
});
