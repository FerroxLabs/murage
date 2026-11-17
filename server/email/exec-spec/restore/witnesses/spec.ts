/**
 * RESTORE-PARK executable spec, part 1b: WITNESSES (MurageMain rule, binding). Written 2026-11-10 (UTC), revision 3 (2026-11-10T21:16Z).
 *
 * r3.4c (2026-11-11T02:15Z, date -u): witnesses for the Opus design check of r3.4b (M1-M3, L1-L3): base() has archives A and B local and verified
 *   (fs.localArchives); abortStep aborts archive_unreadable (download_failed is pre-arm now). New: M1 stray-prep-after-remove-leaves-key-out,
 *   stray-prep-reapplies-carry-after-remove; M2 job-armed-forever-held-event, sys-armed-held-event-livelock, job-armed-forever-flux-held-request,
 *   job-held-event-prepared-then-drained; M3 arm-before-archive-local, abort-download-failed-in-window, download-failed-pre-arm-refusal,
 *   slow-download-before-arm-keep-blip-restored; L2 abort-discards-staged-marked-db; L3 try-again-before-clear-refused-finishing,
 *   try-again-before-clear-other-code. Each `// r3.4b-wrong` is in the r3.4b comparison set.
 * r3.4d 2026-11-11T02:34Z (date -u): the Opus check of r3.4c, 14 new witnesses (see the r3.4d block); each `// r3.4c-wrong` is in the r3.4c comparison set;
 *   download-failed-pre-arm-refusal now starts with the owner's request (Low d), verdict unchanged.
 * r3.4b (2026-11-11T01:56Z, date -u): 305 witnesses (15 new) for the Opus design check of r3.4 (N1-N5): the job is the journal fs.restoreJob plus the
 *   database marks swappedJobId / preparedJobId (arm / phase / sysJob / clearJob rewritten); every capture stamps carry.jobId; a finished
 *   job is cleared before the next arms (clearJob inserted after prepMarks in every prepMarks-then-restoreB trace). New: N1 tick-creates-
 *   carry, stale-aborted-carry-armed-over, stale-carry-under-new-job, stale-aborted-carry-blind-swap, stale-aborted-carry-launders-at-prep,
 *   capture-then-prep-own-carry; N2 blind-journal-crash-between-w4-and-unlink-reconciles, blind-journal-crash-after-w27-resumes, journal-
 *   written-prepared-outside-w4; N3 stray-prep-after-remove-restores-key, window-ending-prep-takes-own-carry-then-clear; N4 window-event-
 *   applied-mid-job, window-event-held-applied-after-prepared; N5 window-backup-admitted, window-backup-refused-with-line. Each
 *   `// r3.4-escape` (8) is in the r3.4 comparison set.
 * r3.4 (2026-11-11T01:19Z, date -u): 290 witnesses (30 new). Redesign of the restore window (Astra + Fable DISAGREE on r3.3i): every restore
 *   flow now writes the durable job (arm / phase / sysJob / sysSwap / clearJob helpers); fs.restorePending is gone. New: crash witnesses
 *   job-crash-w25..w30, job / abort / window / sealed-carry / departed-key / skipped_in_use witnesses (7 form the r3.3i comparison set).
 *   Original actions restored: nolive-revoked-key-leaves-before-clamp and nolive-later-remove-leaves-before-clamp (restore prep);
 *   nolive-later-remove-clamped-not-raised-revoke ends in a real REVOKE_KEY send again (r3.4a: rebuilt after the restore: view, fresh
 *   owner Remove, inventory confirm, sending lease, revoke, completion; see RULINGS). VERDICT CHANGED: nolive-window-keep-refused-confirm-expired is now a must-reject (confirm_expired is no window refusal).
 * r3.3i (2026-11-11T00:49Z, date -u): 260 witnesses. Independent Opus design check of r3.3h (A-F) + Sol copy check (G): 16 new (A nolive-stale-swap-
 *   mark-cleared-by-tick, nolive-swap-mark-restamped-by-prep, nolive-unconfirmed-mark-born-on-tick; B carried-mark-differs-from-archive-mark-
 *   prep-commits-carried; C marked-key-remove-owed-mark-cleared-by-tick, owed-remove-mark-dropped-at-capture, owed-remove-mark-captured; D
 *   nolive-restore-pending-missing-in-window, restore-pending-left-after-prep, nolive-restore-pending-lost-across-crash, nolive-restore-pending-
 *   through-crash-boot-prep; E nolive-window-refusal-writes-ops-line / -writes-archive / -moves-high-water; G nolive-unconfirmed-view-look-
 *   again-wording, nolive-window-refusal-look-again-only); 13 form the r3.3h comparison set. F: every must-accept witness now passes EVERY
 *   predicate (combined gate); verdicts unchanged, traces made realistic (rows, tokens, leases, ops alerts, carries, prepared epochs,
 *   fs.restorePending through every window, no outgoing DB on nolive starts). Departed-key accepts end the window at the boot prep.
 * r3.3h (2026-11-11T00:34Z, date -u): 244 witnesses. Astra r3.3g DISAGREE (#1-#6): carried-mark-lost-across-boot-prep, nolive-unconfirmed-mark-
 *   rewritten-by-tick, nolive-unconfirmed-mark-future-dated, fresh-remove-of-marked-key-not-revoked, nolive-window-restore-admitted,
 *   nolive-window-try-again-refused, nolive-window-keep-refused-clears-savedkeys, nolive-window-refusal-without-line,
 *   nolive-window-refusal-crash-view-without-line (the r3.3g comparison set) plus accepts for every refused kind and the R1 boot case.
 *   Changed r3.3g traces (verdict kept): nolive-window-owner-keep-refused-then-prep-marks and nolive-window-keep-refused-confirm-expired
 *   now show the restore-finishing line (r3.3h requires it); nolive-second-restore-inside-window now fails at the admitted owner.restore.
 *   Mutants killed: carried-checks-restore-prep-only, unconfirmed-mark-value-mutable, unconfirmed-mark-stamp-unchecked,
 *   removal-done-counts-older-keep, window-admits-restore, window-refusal-by-phase, window-purity-omits-savedkeys, window-refusal-no-line,
 *   window-view-skips-line (window-refusal-not-legal, window-allows-second-restore re-aimed).
 * r3.3g (2026-11-11T00:18Z, date -u): 227 witnesses. Astra r3.3f DISAGREE (#1-#5): nolive-second-restore-inside-window, nolive-window-poll-send,
 *   carried-prep-then-crash-boot-prep-ok, nolive-prep-marks-unconfirmed-then-owner-decides, nolive-window-keep-refused-confirm-expired
 *   (each `// r3.3f-escape` / `// r3.3f-overstrict`, the r3.3f comparison set) plus the unconfirmed-mark, window and departed-key guards.
 *   Mutants killed: window-allows-second-restore, window-allows-send, window-admits-owner, window-refusal-not-legal, boot-clamp-unconditional,
 *   unconfirmed-mark-unguarded, unconfirmed-revoke-on-old-remove, unconfirmed-look-again-skipped, clamp-checks-departed-keys.
 * r3.3e (2026-11-10T23:26Z, date -u): 209 witnesses. Astra r3.3d Medium: park-remove-with-delete-killed-ptoken-refused-confirm-expired (`// r3.3d-overstrict`,
 *   r3.3d rejects). Mutant killed: `token-bot-ignores-park`. 0 gaps.
 * r3.3d (2026-11-10T23:21Z, date -u): 208 witnesses. Reducer-builder gap (follows R3-Q4): remove-with-delete-killed-token-refused-confirm-expired and
 *   keep-with-delete-killed-token-refused-confirm-expired (each `// r3.3c-overstrict`, r3.3c rejects), guard remove-with-delete-killed-token-admitted.
 *   Mutant killed: `token-ignores-bot-delete`. 0 gaps.
 * r3.3c (2026-11-10T22:12Z, date -u): 205 witnesses. Astra r3.3b Low: the look-again line must sit on the bot's own row (section "bot"); keep-stale-look-again-not-bot-row
 *   (`// r3.3b-escape`, r3.3b accepts). Mutant killed: `look-again-any-section`.
 * r3.3b (2026-11-10T22:09Z, date -u): 204 witnesses. Stale untokened Keep (reducer-builder gap + MurageMain ruling): keep-stale-binding-refused-confirm-expired
 *   and keep-retry-on-current-binding-admitted (each `// r3.3a-overstrict`, r3.3a rejects), keep-current-binding-refused-confirm-expired,
 *   keep-stale-refusal-mutates-state, keep-stale-refusal-silent. Astra r3.3a Low: ghost-high-water-lowered-while-live-holds and
 *   ghost-high-water-deleted-while-live-holds (each `// r3.3a-escape`, r3.3a accepts). Mutants killed: `untokened-stale-not-refusable`, `ghost-high-water-unguarded`. 0 gaps.
 * r3.3a (2026-11-10T22:04Z, date -u): 197 witnesses. Astra A8-M1 (+ MurageMain ruling): blind-prep-deletes-then-older-reinsert,
 *   blind-prep-drops-uncarried-kept-key, reinsert-older-after-legit-absence (each `// r3.3-escape: A8-M1`, r3.3 accepts) and the accept
 *   covered-delete-then-carry-newer-authority. Mutants killed: `prep-delete-exempt-uncarried` (blind-prep-drops-uncarried-kept-key),
 *   `reinsert-skips-high-water` (reinsert-older-after-legit-absence). Four restore / revoke steps now record ghost.keptHighWater. 0 gaps.
 * r3.3 (2026-11-10T21:57Z, date -u): 193 witnesses. MurageMain ruling 1 + Astra's check of r3.2 (A7-H1, A7-M2, A7-M3) + Fable FA-L2 / FA-L7: each
 *   has a witness whose r3.2 verdict is WRONG, tagged `// r3.2-escape: <id>` or `// r3.2-overstrict: <id>` and carried in `r32`
 *   (r32Comparison). Named mutants (checked in memory, each killed): `any-restore-ends-keep` (killed by auto-restore-drops-admitted-keep),
 *   `owner-restore-unordered` (killed by stale-owner-restore-drops-keep), `swap-prep-exempt-from-keep-ban` (auto-swap-drops-admitted-keep),
 *   `restore-skips-older-keep-check` (blind-prep-downgrades-kept-key), `whole-tail-promptness` (recovered-delay-then-livelock),
 *   `livelock-window-inclusive` (livelock-window-edge-allowed), `no-time-window` (livelock-window-one-past). Thirteen r3.2 start worlds
 *   that failed initialStateValid (leases / authorities with no Remove history or token) now carry it: 0 valid-world gaps.
 * r3.2 (2026-11-10T21:44Z, date -u): 175 witnesses. Astra final check of r3 (A6-H1, A6-M2..M5) and Fable final check (FA-M1..M3) each have a witness
 *   whose r3.1 verdict is WRONG, tagged `// r3.1-escape: <id>` (r3.1 accepts a must-reject) or `// r3.1-overstrict: <id>` (r3.1 rejects
 *   a must-accept) and carried in `r31` (see r31Comparison). Builders kept(), confirmStart, claimed, keptKey, keptRecord, keyOnlyKeep and
 *   the lease / remove starts now carry real tokens, authorities and Keep history: EVERY witness's start world passes initialStateValid.
 *   Named mutants: `keep-end-by-bot-delete-is-violation` (killed by keep-ended-by-owner-bot-delete), `closing-is-gone` (killed by
 *   keep-refused-inbox-gone-on-parked-evidence and keep-refused-inbox-gone-purge-unseen). The two keepEndsActive rejects now wait 150 s.
 *
 * r3 (MurageMain rules, binding):
 *   FAIL FIRST. Every High of Astra round 5 (A5-H1..H8) and Fable round 5 (F5-H1) has a NEW must-reject witness that the r2 predicate
 *   wrongly ACCEPTS and r3 rejects. Each is marked `// r2-escape: <finding>` and carries `r2: { kind: "escape", finding }`, so the
 *   harness runs it against both revisions and logs fail-before / pass-after. Over-strict r2 findings (r2 rejected correct behaviour)
 *   add a must-accept marked `// r2-overstrict: <finding>` (`r2.kind === "overstrict"`: r2 rejects it, r3 accepts it).
 *   ACTING ACCEPTS. Every must-accept performs the permitted action of its invariant (see `// PERMITTED ACTION` on each step
 *   invariant in invariants.ts), so an over-strict mutant that forbids that action fails at least one must-accept. The passive accepts
 *   Astra listed (A5-M12) are replaced: boot-adopts-other-target, keep-with-lease-on-other-target, boot-prep-opens-store,
 *   unknown-provisioning-op-row, owner-removed-inbox-not-orphan, tick-finishes-other-park-keep, keep-completes.
 *   Witnesses that set r3-only state fields (CarryRecord.removals / blindPending) run against r2 with transpile-only (no type check).
 *
 * Every exported invariant in invariants.ts has at least one MUST-REJECT trace (the bad case its comment names) and one MUST-ACCEPT
 * trace. Every High of Astra round 4 (A4-H1..H10) and Fable round 4 (F4-H1..H4) is tagged on the witness that now catches it; for the
 * Highs that reported an OVER-STRICT predicate (A4-H5, H6, H8, H10) the correct behaviour is a must-accept and the harm is a must-reject.
 * The checker runs `runWitnesses()` FIRST and aborts on any disagreement; `witnessCoverage()` must return [] (no invariant without both).
 *
 * Traces are hand-built data: each step is (action, mutation of a deep copy of the previous world). They are NOT reducer output: a
 * witness exercises ONE predicate, so only the fields that predicate reads are made consistent. Pure: no I/O.
 */
import type {
  Action, AttemptId, AuthorityRecord, Generation, KeepGuard, KeepRecord, Lease, Park, Principal, RemoteRequest, SurfaceRow, TokenIssue,
  TraceStep, World, CarryRecord, FluxCloseReason, RestoreJob, RestoreJobPhase, DurableWrite,
} from "../invariants.current.ts";
import { STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS, verdictOf, GUARD_POLL_WINDOW_MS, CHECKER, LOOK_AGAIN_LINE, RESTORE_FINISHING_LINE, RECONFIRM_KEPT_LINE, RESTORE_FAILED_LINE } from "../invariants.current.ts";

// ===================================================================================================================================
// Builders
// ===================================================================================================================================

const NOW = 1_000_000_000;
const DAY = 24 * 3600_000;
const OWN: Principal = "owner_desktop";
const ADDR = "bot1@mail.test";
const G1: Generation = { inboxId: "i1", opId: "op1", emailKeyRef: "k1", serial: 1 };
const G2: Generation = { inboxId: "i1", opId: "op1", emailKeyRef: "k2", serial: 2 };
const T_I1 = "inbox:i1";
const T_OP1 = "op:op1";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Mut = (w: World) => void;
type StepSpec = [Action, Mut?];

export function base(): World {
  return {
    step: 0, nowMs: NOW,
    bots: { b1: { botId: "b1", present: true } },
    local: {
      tablesPresent: true,
      bindings: { b1: { botId: "b1", state: "active", step: null, gen: clone(G1), address: ADDR } },
      intents: {}, parks: {}, leases: {}, keepOps: {}, keepGuards: {}, rotations: {}, pendingLifecycle: [], keptKeys: {}, savedKeys: { b1: "k1" },
    },
    carry: null,
    fs: { liveMarker: null, stagedMarker: null, messagesDbPresent: true, localArchives: ["A", "B"] }, // r3.4c (M3): downloaded and verified before the trace
    proc: { processId: 1, phase: "running", emailOn: true },
    flux: {
      inboxes: { i1: { inboxId: "i1", installOwned: true, createdUnderOp: "op1", forBot: "b1", address: ADDR, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null } },
      keys: { k1: { keyId: "k1", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "live" } },
      requests: [], events: [], semantics: { restoreCredential: "owner", deleteIdempotencyKeyHonoured: true, listingShipped: false },
    },
    surface: [], archives: [], ops: [],
    ghost: { epoch: 0, tokens: [], authorities: [], keeps: [], restores: [], usedKeepOps: [], preparedEpochs: [], inventoryConfirmedEpochs: [], preparedResets: [], lastBootAtMs: 0, lastParkOrRestoreStep: {}, botDeletedAtStep: {}, ownerRestoreRequests: [], keptHighWater: {} },
  };
}
const from = (m: Mut): World => { const w = base(); m(w); return w; };
function run(start: World, steps: StepSpec[]): TraceStep[] {
  const out: TraceStep[] = [];
  let prev = start;
  for (const [action, m] of steps) {
    const next = clone(prev);
    next.step = prev.step + 1;
    if (action.t === "clock.advance") next.nowMs += action.ms;
    if (m) m(next);
    out.push({ prev, action, next });
    prev = next;
  }
  return out;
}

const rq = (o: Partial<RemoteRequest> & Pick<RemoteRequest, "requestId" | "kind" | "target">): RemoteRequest => ({
  copyOf: null, purpose: "removal", credential: "owner", removalId: null, attemptId: null, authorityId: null, keepOp: null,
  sentAtStep: 0, sentAtMs: NOW, sentInProcess: 1, sentInEpoch: 0, flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null, ...o,
});
const tk = (o: Partial<TokenIssue> = {}): TokenIssue => ({
  tokenId: "tB", kind: "b", botId: "b1", gen: clone(G1), park: null,
  shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k1"] },
  issuedTo: OWN, issuedAtStep: 0, issuedAtMs: NOW, processId: 1, epoch: 0, ...o,
});
const au = (o: Partial<AuthorityRecord> = {}): AuthorityRecord => ({
  authorityId: "aR", kind: "remove_bot_section", principal: OWN, tokenId: "tB", verifiedAtStep: 1, verifiedAtMs: NOW, verifiedInProcess: 1, epoch: 0,
  botId: "b1", scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] }, genAtVerify: clone(G1), parkAtVerify: null, ...o,
});
const kr = (o: Partial<KeepRecord> = {}): KeepRecord => ({
  keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 0, succeededAtStep: null, succeededAtMs: null, confirmedBy: null, ...o,
});
const gd = (o: Partial<KeepGuard> = {}): KeepGuard => ({
  inboxId: "i1", botId: "b1", gen: clone(G1), keepOp: "kp1", keptAtMs: NOW, pollUntilMs: NOW + GUARD_POLL_WINDOW_MS, unresolved: ["at1"], lastCheckedAtMs: null, ...o,
});
const ls = (o: Partial<Lease> = {}): Lease => ({
  removalId: "L1", target: T_I1, inboxId: "i1", botId: "b1", authorityId: "aR", foreign: false, phase: "authorized", attemptId: null, attempts: [], keyTargets: [], ...o,
});
const pk = (o: Partial<Park> = {}): Park => ({
  parkId: "pk1", botId: "b1", parkRev: 0, origin: "restore", state: "parked", target: T_I1, inboxId: "i1", provisionOpId: "op1",
  gen: clone(G1), address: ADDR, keyTargets: [{ keyId: "k1", status: "pending" }], remoteDeletedAtMs: null, ...o,
});
const row = (o: Partial<SurfaceRow> = {}): SurfaceRow => ({
  section: "parked", target: T_I1, botId: "b1", inboxId: "i1", keyIds: ["k1"], provisionOpId: null, address: null, visible: true, line: "Choose Keep address or Remove.", actions: [], ...o,
});
const carry = (o: Partial<CarryRecord> = {}): CarryRecord => ({
  carryId: "c1", jobId: "js", capturedAtStep: 0, forEpoch: 0, complete: true, keyIds: ["k1"], inboxIds: ["i1"], provisionOps: ["op1"], keepGuards: [], keptKeys: {}, outstandingDeletes: [],
  removals: [], blindPending: false, ...o,
});

const tick: Action = { t: "auto.tick" };
const clk = (ms: number): Action => ({ t: "clock.advance", ms });
const send = (r: RemoteRequest): Action => ({ t: "net.send", request: r });
const apply = (id: string): Action => ({ t: "flux.apply", requestId: id });
const okO = { ok: true } as const;
const no = (code: string) => ({ ok: false as const, code });
const removeA = (tokenId: string | null, o: Partial<Extract<Action, { t: "owner.remove" }>> = {}): Action =>
  ({ t: "owner.remove", principal: OWN, botId: "b1", target: T_I1, tokenId, section: "bot", outcome: okO, ...o });
const keepA = (o: Partial<Extract<Action, { t: "owner.keep" }>> = {}): Action =>
  ({ t: "owner.keep", principal: OWN, botId: "b1", target: T_I1, tokenId: null, mode: "live", outcome: okO, ...o });

/** Flux applies DELETE `rid` on i1 (active -> closing, one closing event). */
const closeBy = (rid: string, reason: "owner" | "bot_deleted" = "owner"): Mut => w => {
  const r = w.flux.requests.find(x => x.requestId === rid)!;
  r.flux = "applied"; r.appliedAtMs = w.nowMs;
  const i = w.flux.inboxes.i1;
  if (i.state === "active") {
    i.state = "closing"; i.closingCause = { kind: "delete", requestId: rid, reason }; i.closingSinceMs = w.nowMs; i.closingSinceStep = w.step;
    w.flux.events.push({ eventId: "e-" + rid, type: "email.inbox.closing", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason });
  }
};
const reopen: Mut = w => { const i = w.flux.inboxes.i1; i.state = "active"; i.closingCause = null; i.closingSinceMs = null; i.closingSinceStep = null; };
const fluxClose = (reason: FluxCloseReason): Mut => w => { const i = w.flux.inboxes.i1; i.state = "closing"; i.closingCause = { kind: "flux", reason }; i.closingSinceMs = w.nowMs; i.closingSinceStep = w.step; };
const delGuard: Mut = w => { delete w.local.keepGuards.i1; };

// ---------- r3.3i realistic worlds (combined-predicate gate): the surface rows, ops alerts, leases and history a real home holds ---------
/** The owner surface row of an orphan i1: a plain line, an enabled Keep and an enabled Remove (A4-H9). Judged for tokens only at a view. */
const orphanRow = (o: Partial<SurfaceRow> = {}): SurfaceRow => row({ section: "parked", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: null, enabled: true }], ...o });
/** The row of an orphan with work pending on its target (a Keep op, a removal lease): the only enabled action is Try again now. */
const pendingRow = (o: Partial<SurfaceRow> = {}): SurfaceRow => row({ section: "parked", actions: [{ kind: "try_again_now", tokenId: null, enabled: true }], ...o });
/** The bot row of a present bot whose inbox Flux is closing: an enabled Keep (F4-H1 ii). */
const botKeepRow = (): SurfaceRow => row({ section: "bot", actions: [{ kind: "keep", tokenId: null, enabled: true }] });
const withRows = (w: World, ...rows: SurfaceRow[]): World => { w.surface.push(...rows); return w; };
/** The restore-check row and token of an unconfirmed blind restore (epoch 1). */
const rcRow = () => row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] });
const rTok = () => tk({ tokenId: "tr", kind: "r", botId: null, gen: null, shown: { target: null, address: null, inboxId: null, keyIds: [] }, epoch: 1 });
/** A guard restore raises its ops alert (Check 2): binding id, generation and the blip window, no address. */
const guardLine: Mut = w => { w.ops.push({ kind: "guard_restore", bindingId: "b1", gen: clone(G1), text: "guard restore b1 gen 1", window: { closingSinceMs: NOW, restoredAtMs: null } }); };
/** r3.4: the durable restore job (R1). `arm` writes phase armed (W25) for an admitted owner restore or auto.restoreArm; `phase` writes a
 *  later phase with at = this step; `sysJob` is a job armed (and captured, when a carry exists) BEFORE the trace for a system restore. */
const arm = (w: World, archiveId: string, source: RestoreJob["source"] = "desktop") => { w.fs.restoreJob = { id: "j" + w.step, archiveId, source, phase: "armed", at: w.step }; };
const phase = (w: World, ph: RestoreJobPhase) => { let j = w.fs.restoreJob; // r3.4b (N2): armed / captured / aborted are journal writes; swapped / prepared are the database marks
  if (!j) { j = w.fs.restoreJob = { id: "js", archiveId: "?", source: "desktop", phase: ph === "swapped" || ph === "prepared" ? "armed" : ph, at: w.step }; } // no job: a deliberately job-less trace (restoreJobProtocol judges it)
  if (ph === "swapped") { w.local.swappedJobId = j.id; return; }
  if (ph === "prepared") { w.local.preparedJobId = j.id; return; }
  j.phase = ph; j.at = w.step; };
export const sysJob = (w: World, archiveId: string, source: RestoreJob["source"], ph: RestoreJobPhase) => {
  w.fs.restoreJob = { id: "js", archiveId, source, phase: ph === "swapped" || ph === "prepared" ? (w.carry ? "captured" : "armed") : ph, at: w.step };
  if (ph === "swapped" || ph === "prepared") w.local.swappedJobId = "js"; if (ph === "prepared") w.local.preparedJobId = "js"; };
/** The store is closed between a swap and its prep: r3.4 the job is swapped from the swap, prepared by the prep. */
const pendingPrep = (w: World, on: boolean) => { phase(w, on ? "swapped" : "prepared"); };
/** r3.4: a system restore arms its own job (W25); a finished job is cleared (W24 carry delete, then W30). */
const sysArm = (archiveId = "A", source: RestoreJob["source"] = "desktop"): StepSpec => [{ t: "auto.restoreArm", source, archiveId }, w => { arm(w, archiveId, source); }];
/** r3.4: a system swap of archive A answering the system job js (phase swapped, the store closed until the prep), and the prep ending it. */
const sysSwap = (w: World, source: RestoreJob["source"] = "cloud_reset", blind = false) => { w.ghost.epoch = 1; phase(w, "swapped"); w.proc.phase = "boot_prep";
  w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source, archiveId: "A", blind, carryId: blind ? null : "c1", ownerRequestStep: null, jobId: "js" }); };
/** r3.4: a start already past a system swap of A (job js swapped, epoch 1 unprepared, store closed); `sysPrep` is the prep that ends it. */
const swappedStart = (w: World) => { sysJob(w, "A", "cloud_reset", "captured"); sysSwap(w); };
const sysPrep = (w: World) => { w.ghost.preparedEpochs.push(w.ghost.epoch); phase(w, "prepared"); w.proc.phase = "running"; };
const clearJob: StepSpec = [{ t: "auto.restoreJobClear" }, w => { w.carry = null; w.fs.restoreJob = null; }]; // W24, then W30 unlinks the journal
/** A Remove authority of epoch 1 (the epoch a blind restore opened) with its token, history a pre-trace lease can name. */
const remHistE1 = (w: World) => { w.ghost.tokens.push(tk({ issuedAtStep: 0, epoch: 1 })); w.ghost.authorities.push(au({ verifiedAtStep: 0, epoch: 1 })); };
/** An admitted untokened bot-row Keep: its Keep op and history record in the claim step. */
const claimKeepNow: Mut = w => {
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: w.step };
  w.ghost.keeps.push(kr({ claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp1"); };
/** An admitted Remove: the lease naming the authority just created. */
const leaseNow: Mut = w => { w.local.leases.L1 = ls(); w.local.bindings.b1.state = "removing"; };
const d = (rid: string, at: AttemptId, o: Partial<RemoteRequest> = {}) =>
  rq({ requestId: rid, kind: "DELETE_INBOX", target: "i1", attemptId: at, removalId: "L1", authorityId: "aR", sentAtStep: -3, answer: "lost", ...o });

/** r3.2 valid-world helpers: the token a pre-trace Remove names, and a Keep authority + record + used op id (initialStateValid). */
const tokB = (w: World, issuedAtStep = -5) => { if (!w.ghost.tokens.some(t => t.tokenId === "tB")) w.ghost.tokens.push(tk({ issuedAtStep })); };
/** r3.3 valid-world helper: the Remove authority aR (and its token) a pre-trace lease L1 names. */
const remHist = (w: World) => { tokB(w); if (!w.ghost.authorities.some(a => a.authorityId === "aR")) w.ghost.authorities.push(au({ verifiedAtStep: -3 })); };
const keepHist = (w: World, rec: Partial<KeepRecord> = {}, verifiedAtStep = -1) => {
  const k = kr(rec);
  w.ghost.authorities.push(au({ authorityId: k.authorityId, kind: "keep", tokenId: null, verifiedAtStep: Math.min(verifiedAtStep, k.claimedAtStep), genAtVerify: null,
    scope: { target: k.target, inboxId: k.inboxId, keyIds: ["k1"] } }));
  w.ghost.keeps.push(k); w.ghost.usedKeepOps.push(k.keepOp);
};

/** A successful Keep at step 0 on i1, with DELETE d1 (attempt at1) held at Flux from before, and its guard. */
function kept(unresolved: AttemptId[] | "unknown" = ["at1"]): World {
  return from(w => {
    tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: -3 }));
    keepHist(w, { claimedAtStep: -2, succeededAtStep: 0, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: -1 } });
    w.flux.requests.push(d("d1", "at1"));
    w.local.keepGuards.i1 = gd({ unresolved });
  });
}

// ===================================================================================================================================
// Witnesses
// ===================================================================================================================================

/** `r2`: escape = must-reject that the r2 predicate wrongly accepted; overstrict = must-accept that the r2 predicate wrongly rejected. */
export interface Witness {
  id: string; invariant: string; expect: "reject" | "accept"; answers: string[]; settled: boolean; trace: TraceStep[];
  r2: { kind: "escape" | "overstrict"; finding: string } | null;
  /** r3.2: escape = must-reject the r3.1 predicate wrongly ACCEPTS; overstrict = must-accept the r3.1 predicate wrongly REJECTS. */
  r31?: { kind: "escape" | "overstrict"; finding: string };
  /** r3.3: escape = must-reject the r3.2 predicate wrongly ACCEPTS; overstrict = must-accept the r3.2 predicate wrongly REJECTS. */
  r32?: { kind: "escape" | "overstrict"; finding: string };
}
const W: Witness[] = [];
const rej = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "reject", answers, settled, trace, r2: null });
const acc = (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false) => W.push({ id, invariant, expect: "accept", answers, settled, trace, r2: null });
/** Marks the witness just pushed. */
const esc = (finding: string) => { W[W.length - 1].r2 = { kind: "escape", finding }; };
const over = (finding: string) => { W[W.length - 1].r2 = { kind: "overstrict", finding }; };
const esc31 = (finding: string) => { W[W.length - 1].r31 = { kind: "escape", finding }; };
const over31 = (finding: string) => { W[W.length - 1].r31 = { kind: "overstrict", finding }; };
const esc32 = (finding: string) => { W[W.length - 1].r32 = { kind: "escape", finding }; };
const over32 = (finding: string) => { W[W.length - 1].r32 = { kind: "overstrict", finding }; };

// ---------- (a) keepEndsActive ------------------------------------------------------------------------------------------------------

// F4-H1: 13 steps. Remove, DELETE sent, answer lost, Keep (confirmed GET), guard, restore whose carry omits the guard, DELETE lands.
rej("keepEndsActive", "restore-drops-guard-13", ["F4-H1", "A3-H1", "A4-H7"], run(base(), [
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.ghost.tokens.push(tk({ issuedAtStep: 1 })); }],
  [removeA("tB"), w => { w.ghost.authorities.push(au({ verifiedAtStep: 2 })); w.local.leases.L1 = ls(); w.local.bindings.b1.state = "removing"; }],
  [tick, w => { Object.assign(w.local.leases.L1, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(d("d1", "at1", { sentAtStep: 4, answer: "pending" })), w => { w.flux.requests.push(d("d1", "at1", { sentAtStep: 4, answer: "pending" })); }],
  [{ t: "fault.loseAnswer", requestId: "d1" }, w => { w.flux.requests[0].answer = "lost"; w.local.leases.L1.phase = "unknown"; }],
  [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 6 };
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, verifiedAtStep: 6 })); w.ghost.keeps.push(kr({ claimedAtStep: 6 })); w.local.leases.L1.phase = "keeping"; }],
  [send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 7 })), w => { w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 7, flux: "applied" })); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { const g = w.flux.requests[1]; g.answer = "delivered"; g.answerSeen = { atStep: 8, result: "ok", fluxStateSeen: "active" }; }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 9, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: 8 } });
    w.local.keepGuards.i1 = gd({ unresolved: ["at1"] }); w.local.keepOps = {}; w.local.leases = {}; w.local.bindings.b1.state = "active"; }],
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ complete: false }); }],
  [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, w => { w.local.keepGuards = {}; w.ghost.epoch = 1;
    w.ghost.restores.push({ atStep: 11, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); w.ghost.preparedEpochs.push(1); w.ghost.lastBootAtMs = NOW; }],
  [apply("d1"), closeBy("d1")],
  [clk(150_000)],
]));
rej("keepEndsActive", "late-delete-never-restored", ["A3-H1", "A4-H6"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(150_000)]]));
acc("keepEndsActive", "flux-billing-close-ends-obligation", ["A4-H5", "F4-M1"], run(withRows(kept(), botKeepRow()), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")], [clk(3600_000)], [tick]]), true);
acc("keepEndsActive", "delete-at-31d-restored-by-event", ["A4-H6"], run(kept(), [[clk(31 * DAY)], [apply("d1"), closeBy("d1")], [clk(30_000), reopen]]), true);
acc("keepEndsActive", "blind-restore-ends-window", ["F4-H1"], run(from(w => { Object.assign(w, kept()); w.fs.messagesDbPresent = false; sysJob(w, "A", "desktop", "armed"); }), [
  [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => { w.fs.messagesDbPresent = true; w.local.keepGuards = {}; pendingPrep(w, true); w.proc.phase = "boot_prep"; w.surface = [rcRow(), botKeepRow()]; w.ghost.epoch = 1;
    w.ghost.restores.push({ atStep: 1, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); }],
  [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); pendingPrep(w, false); w.proc.phase = "running"; }],
  [apply("d1"), closeBy("d1")], [clk(3600_000)],
]), true);

// ---------- (a) keepSuccessIsConfirmed ------------------------------------------------------------------------------------------------

const confirmStart = (restoreAnswered: boolean) => from(w => {
  w.step = 4;
  keepHist(w, { claimedAtStep: 0 });
  w.flux.requests.push(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 1, flux: "applied",
    answer: restoreAnswered ? "delivered" : "pending", answerSeen: restoreAnswered ? { atStep: 2, result: "ok", fluxStateSeen: "active" } : null }));
  w.flux.requests.push(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, flux: "applied", answer: "delivered", answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active" } }));
});
const succeed = (rid: string, at: number): Mut => w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: w.step, succeededAtMs: w.nowMs, confirmedBy: { requestId: rid, atStep: at } });
  w.local.keepGuards.i1 = gd({ keptAtMs: w.nowMs, pollUntilMs: w.nowMs + GUARD_POLL_WINDOW_MS, unresolved: [] }); };
rej("keepSuccessIsConfirmed", "get-before-restore-answered", ["A4-H4"], run(confirmStart(false), [[tick, succeed("g1", 4)]]));
rej("keepSuccessIsConfirmed", "confirmed-by-non-get", ["A4-H4", "F4-L1"], run(confirmStart(true), [[tick, succeed("r1", 2)]]));
acc("keepSuccessIsConfirmed", "real-get-after-restore", [], run(confirmStart(true), [[tick, succeed("g1", 4)]]));

// ---------- (a) guardArmedForEveryKeep ------------------------------------------------------------------------------------------------

const claimed = () => from(w => { keepHist(w, { claimedAtStep: 0 }); });
rej("guardArmedForEveryKeep", "keep-without-guard", ["F3-H2"], run(claimed(), [[tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 1, succeededAtMs: NOW }); }]]));
acc("guardArmedForEveryKeep", "keep-with-guard", [], run(confirmStart(true), [[tick, succeed("g1", 4)]]));

// ---------- (a) guardLivesUntilEveryDeleteResolved ------------------------------------------------------------------------------------

rej("guardLivesUntilEveryDeleteResolved", "guard-gone-at-30d-delete-lands-31d", ["ruling-20:36Z", "A4-H6", "F4-H4"], run(kept(), [[clk(30 * DAY), delGuard], [clk(DAY)], [apply("d1"), closeBy("d1")]]));
rej("guardLivesUntilEveryDeleteResolved", "two-deletes-one-closing-event", ["FLUX-FACT-one-closing-event", "F4-M6"], run(
  from(w => { const k = kept(["at1", "at2"]); Object.assign(w, k); w.flux.requests.push(d("d2", "at2")); }),
  [[apply("d1"), closeBy("d1")], [{ t: "auto.applyEvent", eventId: "e-d1" }, delGuard], [tick, reopen], [apply("d2"), closeBy("d2")]]));
rej("guardLivesUntilEveryDeleteResolved", "unknown-released-without-resolution", ["F4-H4"], run(kept("unknown"), [[tick, delGuard]]));
acc("guardLivesUntilEveryDeleteResolved", "released-by-delivered-answer", ["ruling-20:36Z"], run(withRows(kept(), botKeepRow()), [
  [apply("d1"), closeBy("d1")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => { const r = w.flux.requests[0]; r.answer = "delivered"; r.answerSeen = { atStep: 2, result: "accepted", fluxStateSeen: "closing" }; }],
  [tick, delGuard],
]));
acc("guardLivesUntilEveryDeleteResolved", "single-delete-resolved-by-its-closing", ["ruling-20:36Z"], run(withRows(kept(), botKeepRow()), [[apply("d1"), closeBy("d1")], [{ t: "auto.applyEvent", eventId: "e-d1" }, delGuard]]));
acc("guardLivesUntilEveryDeleteResolved", "released-by-purge", ["ruling-20:36Z"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.events.push({ eventId: "e9", type: "email.inbox.deleted", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: false, reason: null }); }),
  [[{ t: "auto.applyEvent", eventId: "e9" }, delGuard]]));

// ---------- (a) guardDiesOnFreshRemove ------------------------------------------------------------------------------------------------

const guardedWithToken = () => from(w => { w.ghost.tokens.push(tk()); w.local.keepGuards.i1 = gd(); });
rej("guardDiesOnFreshRemove", "guard-survives-owner-remove", ["F4-H3"], run(guardedWithToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); }]]));
acc("guardDiesOnFreshRemove", "guard-deleted-with-remove", ["F4-H3"], run(guardedWithToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); leaseNow(w); delGuard(w); }]]));

// ---------- (a) guardActsOnlyOnGuardRecord ------------------------------------------------------------------------------------------

const closingKept = (m?: Mut) => from(w => { Object.assign(w, kept()); w.step = 6; closeBy("d1")(w); if (m) m(w); });
const guardRestore = send(rq({ requestId: "r9", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", credential: "owner" }));
rej("guardActsOnlyOnGuardRecord", "guard-reverts-later-remove", ["F4-H3"], run(closingKept(w => { w.ghost.authorities.push(au({ authorityId: "aR2", verifiedAtStep: 5 })); }), [[guardRestore]]));
rej("guardActsOnlyOnGuardRecord", "guard-fights-flux-billing", ["F3-H1", "A4-H5"], run(closingKept(fluxClose("billing")), [[guardRestore]]));
acc("guardActsOnlyOnGuardRecord", "guard-restores-delete-closing", [], run(closingKept(), [[guardRestore, guardLine]]));

// ---------- (a) restoreUsesOwnerCredentialAndKeepPurpose ------------------------------------------------------------------------------

rej("restoreUsesOwnerCredentialAndKeepPurpose", "restore-with-bot-key", ["A4-M11"], run(base(), [[send(rq({ requestId: "r9", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", credential: "bot_key" }))]]));
acc("restoreUsesOwnerCredentialAndKeepPurpose", "restore-with-owner-key", [], run(closingKept(), [[guardRestore, guardLine]]));

// ---------- (b) authorityCreatedByValidOwnerAction --------------------------------------------------------------------------------------

const withToken = () => from(w => { w.ghost.tokens.push(tk()); });
rej("authorityCreatedByValidOwnerAction", "token-for-rotated-generation", ["A4-H1", "A3-M9"], run(
  from(w => { w.ghost.tokens.push(tk()); w.local.bindings.b1.gen = clone(G2); w.local.savedKeys.b1 = "k2"; }),
  [[removeA("tB"), w => { w.ghost.authorities.push(au()); }]]));
rej("authorityCreatedByValidOwnerAction", "authority-from-automatic-step", ["A4-H1"], run(withToken(), [[tick, w => { w.ghost.authorities.push(au()); }]]));
rej("authorityCreatedByValidOwnerAction", "bot-credential-authority", ["A3-M11"], run(withToken(), [[removeA("tB", { principal: "bot_credential" }), w => { w.ghost.authorities.push(au({ principal: "bot_credential" })); }]]));
acc("authorityCreatedByValidOwnerAction", "valid-owner-remove", [], run(withToken(), [[removeA("tB"), w => { w.ghost.authorities.push(au()); leaseNow(w); }]]));

// ---------- (b) ownerAuthorityForEveryDestructiveSend ---------------------------------------------------------------------------------

rej("ownerAuthorityForEveryDestructiveSend", "reconnect-deletes-inbox", ["A4-H2"], run(
  from(w => { tokB(w); w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", verifiedAtStep: 0 })); }),
  [[send(d("d1", "at1", { authorityId: "aRot", answer: "pending" }))]]));
rej("ownerAuthorityForEveryDestructiveSend", "delete-after-later-keep", ["A3-H1", "Keep-always-wins"], run(
  from(w => { w.step = 2; tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 1 })); keepHist(w, { claimedAtStep: 2 }, 2); }),
  [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("ownerAuthorityForEveryDestructiveSend", "delete-under-owner-remove", [], run(from(w => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) removalSendNeedsSendingLease --------------------------------------------------------------------------------------------

const leaseAuth = (w: World) => { tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); };
rej("removalSendNeedsSendingLease", "delete-without-send-claim", ["F4-M4"], run(from(w => { leaseAuth(w); w.local.leases.L1 = ls(); }), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("removalSendNeedsSendingLease", "delete-under-sending-lease", [], run(from(w => { leaseAuth(w); w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) noDestructiveSendAfterBlindRestore --------------------------------------------------------------------------------------

const blind = (confirmed: boolean) => from(w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); w.ghost.preparedEpochs.push(1); if (confirmed) w.ghost.inventoryConfirmedEpochs.push(1); });
rej("noDestructiveSendAfterBlindRestore", "delete-after-blind-restore", ["Q2-ruling", "F4-M5"], run(blind(false), [[send(d("d1", "at1", { answer: "pending" }))]]));
acc("noDestructiveSendAfterBlindRestore", "delete-after-owner-confirms", ["Q2-ruling"], run(from(w => { Object.assign(w, blind(true)); remHistE1(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); }), [[send(d("d1", "at1", { answer: "pending" }))]]));

// ---------- (b) keptKeysProtected -------------------------------------------------------------------------------------------------------

const keptKey = (removeAt: number) => from(w => {
  w.step = 4; w.local.keptKeys.k9 = "aK9";
  w.ghost.tokens.push(tk({ tokenId: "t9", shown: { target: "op:op9", address: null, inboxId: null, keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", tokenId: null, verifiedAtStep: 1, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aRk", kind: "remove_key_only", tokenId: "t9", verifiedAtStep: removeAt, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } }));
});
const revokeK9 = send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRk" }));
/** The same revoke sent the way a home sends it: under a lease in `sending` that names k9 as a pending key target. */
const revokeK9L = send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRk", removalId: "L9", attemptId: "a9" }));
const leaseK9: Mut = w => { w.local.leases.L9 = ls({ removalId: "L9", target: "op:op9", inboxId: null, authorityId: "aRk", phase: "sending", attemptId: "a9", attempts: ["a9"], keyTargets: [{ keyId: "k9", status: "pending" }] }); };
rej("keptKeysProtected", "kept-key-revoked-by-older-remove", ["A4-H3"], run(keptKey(0), [[revokeK9]]));
rej("keptKeysProtected", "key-marked-kept-without-keep", ["F4-L4"], run(base(), [[tick, w => { w.ghost.authorities.push(au()); w.local.keptKeys.k1 = "aR"; }]]));
acc("keptKeysProtected", "kept-key-revoked-by-later-remove", [], run(from(w => { Object.assign(w, keptKey(3)); leaseK9(w); }), [[revokeK9L]]));

// ---------- (c) nothingAutomaticUnparks -------------------------------------------------------------------------------------------------

const parked = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; });
rej("nothingAutomaticUnparks", "tick-resumes-parked-removal", ["standing-order"], run(parked(), [[tick, w => { w.local.leases.L1 = ls(); }]]));
// A5-M12: acting. The tick finishes the owner's Keep on ANOTHER park (keep_pending -> key_release) while pk1 stays parked.
acc("nothingAutomaticUnparks", "tick-finishes-other-park-keep", ["A5-M12"], run(
  from(w => { w.surface.push(orphanRow()); w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; w.local.parks.pk2 = pk({ parkId: "pk2", target: "inbox:i2", inboxId: "i2", state: "keep_pending" }); }),
  [[tick, w => { w.local.parks.pk2.state = "key_release"; }]]));
acc("nothingAutomaticUnparks", "evidence-moves-pk-to-pkE", [], run(withRows(parked(), orphanRow()), [[{ t: "auto.applyEvent", eventId: "e1" }, w => { w.local.parks.pk1.state = "parked_evidence"; }]]));

// ---------- (c) keptStaysKept ------------------------------------------------------------------------------------------------------------

const keptRecord = () => from(w => { keepHist(w, { succeededAtStep: 0, succeededAtMs: NOW }); });
rej("keptStaysKept", "boot-reparks-kept-address", ["A3-M14"], run(keptRecord(), [[{ t: "auto.boot" }, w => { w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy" }); }]]));
// A5-M12: acting. Boot adopts a legacy removal of a DIFFERENT target (inbox i2) as a park; the kept target is untouched.
acc("keptStaysKept", "boot-adopts-other-target", ["A5-M12"], run(keptRecord(), [[{ t: "auto.boot" }, w => {
  w.local.parks.pk2 = pk({ parkId: "pk2", origin: "legacy", target: "inbox:i2", inboxId: "i2" }); }]]));

// ---------- (c) outgoingCapturedBeforeSwap ----------------------------------------------------------------------------------------------

const swapA: Action = { t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false };
rej("outgoingCapturedBeforeSwap", "swap-without-carry", ["A4-H7", "F4-H1"], run(base(), [[swapA]]));
rej("outgoingCapturedBeforeSwap", "carry-deleted-before-prep", ["A4-H7"], run(from(w => { w.carry = carry(); }), [[tick, w => { w.carry = null; }]]));
acc("outgoingCapturedBeforeSwap", "swap-after-complete-carry", [], run(from(w => { w.carry = carry(); sysJob(w, "A", "cloud_reset", "captured"); }), [[swapA, w => { sysSwap(w); }]]));

// ---------- (c) restorePrepParksEverything ----------------------------------------------------------------------------------------------

const prep: Action = { t: "auto.restorePrepare", outcome: "committed" };
const inFlight = () => from(w => { remHist(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); });
const parkIt: Mut = w => { w.surface = [orphanRow()]; w.local.leases = {}; w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; };
rej("restorePrepParksEverything", "carried-guard-lost", ["A4-H7", "F4-H1"], run(from(w => { w.carry = carry({ keepGuards: [gd()], jobId: "js" }); swappedStart(w); }), [[prep]])); // r3.4c (M1): the window-ending prep of the carry's job
rej("restorePrepParksEverything", "restored-removal-not-parked", ["A3-H1", "standing-order"], run(inFlight(), [[prep, w => { w.local.leases = {}; }]]));
acc("restorePrepParksEverything", "restored-removal-parked", [], run(inFlight(), [[prep, parkIt]]));
acc("restorePrepParksEverything", "foreign-lease-dropped", ["F3-M2"], run(from(w => { w.local.leases.LF = ls({ removalId: "LF", target: "inbox:i9", inboxId: "i9", botId: null, foreign: true }); }), [[prep, w => { w.local.leases = {}; }]]));
acc("restorePrepParksEverything", "carried-keep-beats-archived-removal", ["R2-Q1"], run(
  from(w => { w.local.bindings.b1.state = "removing"; w.carry = carry({ keepGuards: [gd()] }); swappedStart(w); }),
  [[prep, w => { sysPrep(w); w.local.bindings.b1.state = "restored_unverified"; w.local.keepGuards.i1 = gd({ unresolved: "unknown" }); }]]));

// ---------- (c) restorePrepNeverThrows ----------------------------------------------------------------------------------------------------

rej("restorePrepNeverThrows", "prep-throws", ["F3-M2"], run(base(), [[{ t: "auto.restorePrepare", outcome: "threw" }]]));
acc("restorePrepNeverThrows", "prep-commits", [], run(base(), [[prep]]));

// ---------- (d) everyOrphanHasExecutableAction ------------------------------------------------------------------------------------------

const botGone = (m?: Mut) => from(w => { w.bots.b1.present = false; if (m) m(w); });
rej("everyOrphanHasExecutableAction", "bot-deleted-during-live-keep", ["A3-H6"], run(base(), [[tick, w => { w.bots.b1.present = false; }]]));
rej("everyOrphanHasExecutableAction", "only-try-again-nothing-pending", ["A4-H9"], run(base(), [[tick, w => {
  w.bots.b1.present = false; w.surface = [row({ actions: [{ kind: "try_again_now", tokenId: null, enabled: true }] })]; }]]));
// A5-M12: acting. The bot is gone with its create answer lost (inbox id unknown); the tick WRITES the op-backed key-only row, then
// Flux's late create lands an inbox under op1 and the same row covers it.
acc("everyOrphanHasExecutableAction", "unknown-provisioning-op-row", ["A4-H8", "D1-reversed", "A5-M12"], run(botGone(w => {
  w.local.bindings.b1 = { botId: "b1", state: "provisioning", step: "inbox", gen: { inboxId: null, opId: "op1", emailKeyRef: "k1", serial: 1 }, address: null };
  w.flux.inboxes = {};
  w.flux.requests.push(rq({ requestId: "c1", kind: "CREATE_INBOX", target: "op1", purpose: "provision" }));
}), [
  [tick, w => { w.surface = [row({ section: "key_only", target: T_OP1, inboxId: null, provisionOpId: "op1", actions: [{ kind: "keep", tokenId: "tp", enabled: true }, { kind: "remove", tokenId: "tp", enabled: true }] })]; }],
  [{ t: "flux.apply", requestId: "c1" }, w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); w.flux.inboxes.i1 = { inboxId: "i1", installOwned: true, createdUnderOp: "op1", forBot: "b1", address: ADDR, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null }; }],
]));
// A5-M12: acting. The owner's Remove runs: Flux closes i1, the DELETE answer arrives, then the bot deletion completes (binding, saved
// key and lease gone, key revoked). The closing inbox is under a valid current-epoch Remove with no park: not an orphan.
acc("everyOrphanHasExecutableAction", "owner-removed-inbox-not-orphan", ["F4-M3", "A5-M12"], run(from(w => {
  w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] });
  tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 }));
  w.flux.requests.push(d("d1", "at1", { answer: "pending" }));
}), [
  [apply("d1"), closeBy("d1")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => {
    const r = w.flux.requests[0]; r.answer = "delivered"; r.answerSeen = { atStep: 2, result: "accepted", fluxStateSeen: "closing" }; w.local.leases.L1.phase = "acked"; }],
  [tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.leases = {}; w.flux.keys.k1.state = "revoked"; w.bots.b1.present = false; }],
]));

// ---------- (d) viewMintsScopedTokens ---------------------------------------------------------------------------------------------------

const view = (shownTarget: string): StepSpec => [{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", actions: [{ kind: "remove", tokenId: "tB", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1, shown: { target: shownTarget, address: ADDR, inboxId: "i1", keyIds: ["k1"] } }));
}];
rej("viewMintsScopedTokens", "token-shows-another-target", ["A4-H8", "A4-H9"], run(base(), [view("inbox:i2")]));
acc("viewMintsScopedTokens", "token-scoped-to-row", [], run(base(), [view(T_I1)]));

// ---------- (d) keyOnlyActionsTouchNoInbox ----------------------------------------------------------------------------------------------

const keyOnlyKeep = () => from(w => { keepHist(w, { target: T_OP1, inboxId: null, mode: "key_only" }); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_OP1, inboxId: null, mode: "key_only", authorityId: "aK", claimedAtStep: 0 }; });
rej("keyOnlyActionsTouchNoInbox", "key-only-keep-sends-get", ["F3-M3"], run(keyOnlyKeep(), [[send(rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));
acc("keyOnlyActionsTouchNoInbox", "key-only-remove-revokes", [], run(from(w => {
  w.ghost.tokens.push(tk({ tokenId: "tp", shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k1"] } }));
  w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", verifiedAtStep: 0, scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } }));
  w.local.leases.L1 = ls({ target: T_OP1, inboxId: null, phase: "sending", attemptId: "at1", attempts: ["at1"], keyTargets: [{ keyId: "k1", status: "pending" }] }); }),
  [[send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", authorityId: "aR", removalId: "L1", attemptId: "at1" }))]]));

// ---------- (d) blindRestoreIsOwnerVisible ------------------------------------------------------------------------------------------

rej("blindRestoreIsOwnerVisible", "blind-restore-silent", ["F4-H1", "point-1"], run(blind(false), [[tick]]));
acc("blindRestoreIsOwnerVisible", "blind-restore-check-row", ["point-1"], run(blind(false), [[tick, w => {
  w.surface = [row({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], actions: [{ kind: "confirm_inventory", tokenId: "tr", enabled: true }] })]; }]]));

// ---------- (e) keepAndRemoveSerialized -------------------------------------------------------------------------------------------------

rej("keepAndRemoveSerialized", "key-only-keep-with-active-removal", ["A4-H3"], run(keyOnlyKeep(), [[tick, w => { w.local.leases.L1 = ls({ target: T_OP1, inboxId: null }); }]]));
// A5-M12: acting. With a key-only Keep open on op1, a removal lease opens on a DIFFERENT target (inbox i1).
acc("keepAndRemoveSerialized", "keep-with-lease-on-other-target", ["A5-M12"], run(keyOnlyKeep(), [[tick, w => { w.local.leases.L1 = ls(); }]]));

// ---------- (e) noRemoveDuringKeep ------------------------------------------------------------------------------------------------------

const keyOnlyRemove: StepSpec = [removeA("tp", { target: T_OP1, section: "key_only" }), w => { w.ghost.authorities.push(au({ kind: "remove_key_only", tokenId: "tp", scope: { target: T_OP1, inboxId: null, keyIds: ["k1"] } }));
  w.local.leases.L1 = ls({ target: T_OP1, inboxId: null, keyTargets: [{ keyId: "k1", status: "pending" }] }); }];
rej("noRemoveDuringKeep", "remove-authorized-during-key-only-keep", ["A4-H3"], run(keyOnlyKeep(), [keyOnlyRemove]));
acc("noRemoveDuringKeep", "remove-with-no-keep", [], run(from(w => { w.ghost.tokens.push(tk({ tokenId: "tp", shown: { target: T_OP1, address: ADDR, inboxId: null, keyIds: ["k1"] } })); }), [keyOnlyRemove]));

// ---------- (e) keepNetworkNeedsClaim ---------------------------------------------------------------------------------------------------

rej("keepNetworkNeedsClaim", "flux-closing-keep-unclaimed", ["A3-H2"], run(base(), [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep" }))]]));
acc("keepNetworkNeedsClaim", "claimed-keep-restore", [], run(from(w => { keepHist(w, { mode: "flux_closing" }); w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "flux_closing", authorityId: "aK", claimedAtStep: 0 }; }),
  [[send(rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "keep", keepOp: "kp1" }))]]));

// ---------- (e) keepOpsFreshAndCasChecked -----------------------------------------------------------------------------------------------

const claimKp1: StepSpec = [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 }; }];
const claimKp1Full: StepSpec = [keepA(), w => { w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } })); claimKeepNow(w); }];
rej("keepOpsFreshAndCasChecked", "keep-op-reused", ["A3-M8"], run(from(w => { w.ghost.usedKeepOps.push("kp1"); }), [claimKp1]));
rej("keepOpsFreshAndCasChecked", "stale-answer-applies", ["A3-M8"], run(from(w => { w.flux.requests.push(rq({ requestId: "g0", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp0" })); }),
  [[{ t: "net.answer", requestId: "g0", result: "ok", fluxStateSeen: "active" }, w => { w.local.bindings.b1.state = "restored_unverified"; }]]));
acc("keepOpsFreshAndCasChecked", "fresh-keep-op", [], run(base(), [claimKp1Full]));

// ---------- (e) admissionPinned ---------------------------------------------------------------------------------------------------------

const leaseIn = (phase: Lease["phase"]) => from(w => { remHist(w); w.local.leases.L1 = ls({ phase }); });
rej("admissionPinned", "keep-refused-while-unknown", ["F4-H2", "A4-H9", "point-2"], run(leaseIn("unknown"), [[keepA({ outcome: no("removal_unknown") })]]));
rej("admissionPinned", "removal-sending-code-while-unknown", ["F4-H2", "point-2"], run(leaseIn("unknown"), [[keepA({ outcome: no("removal_sending") })]]));
// r3.4d-s23: Try again now is judged only on a bot:* target (non-bot targets are refused not_a_bot_target), so the pending work is a lease on bot:b1.
rej("admissionPinned", "try-again-refused-while-pending", ["A4-H9"], run(from(w => { remHist(w); w.local.leases.L1 = ls({ phase: "unknown", target: "bot:b1" }); }), [[{ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target: "bot:b1", outcome: no("unavailable") }]]));
acc("admissionPinned", "keep-refused-only-while-sending", ["point-2"], run(leaseIn("sending"), [[keepA({ outcome: no("removal_sending") })]]));
acc("admissionPinned", "remove-refused-while-keep-open", [], run(keyOnlyKeep(), [[removeA("tp", { target: T_OP1, section: "key_only", outcome: no("keep_pending") })]]));

// ---------- (f) keyTargetsNeverLost -----------------------------------------------------------------------------------------------------

rej("keyTargetsNeverLost", "live-key-without-record", ["A3-M7"], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; }]]));
acc("keyTargetsNeverLost", "key-held-by-park", [], run(base(), [[tick, w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.parks.pk1 = pk(); w.surface.push(orphanRow()); }]]));

// ---------- (f) keyTargetEntriesNeverDropped --------------------------------------------------------------------------------------------

const parkOnlyKey = () => from(w => { w.local.bindings = {}; w.local.savedKeys = {}; w.local.parks.pk1 = pk(); w.surface.push(orphanRow()); });
rej("keyTargetEntriesNeverDropped", "target-dropped-while-live", ["A3-M7", "A4-H7"], run(parkOnlyKey(), [[tick, w => { w.local.parks.pk1.keyTargets = []; }]]));
acc("keyTargetEntriesNeverDropped", "target-dropped-after-revoke", [], run(parkOnlyKey(), [[tick, w => { w.local.parks.pk1.keyTargets = []; w.flux.keys.k1.state = "revoked"; }]]));

// ---------- (f) savedKeyNeverOutlivesRevokeWithoutWork ----------------------------------------------------------------------------------

rej("savedKeyNeverOutlivesRevokeWithoutWork", "revoked-key-saved-no-work", ["A3-M10", "A4-H10"], run(base(), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));
rej("savedKeyNeverOutlivesRevokeWithoutWork", "marked-revoked-before-secret-cleared", ["A3-M10"], run(base(), [[tick, w => { w.local.parks.pk1 = pk({ keyTargets: [{ keyId: "k1", status: "revoked" }] }); }]]));
acc("savedKeyNeverOutlivesRevokeWithoutWork", "async-revoke-pending", ["A4-H10"], run(from(w => { w.local.parks.pk1 = pk(); }), [[tick, w => { w.flux.keys.k1.state = "revoked"; }]]));

// ---------- (g) markerNeverArchivedAndConsumedAtBoot ------------------------------------------------------------------------------------

rej("markerNeverArchivedAndConsumedAtBoot", "cloud-restic-carries-marker", ["A3-M16"], run(base(), [[{ t: "owner.backup", kind: "cloud_restic" }, w => { w.archives.push({ archiveId: "s1", kind: "cloud_restic", topLevelNames: ["home/messages.db", "home/restore-pending.json"] }); }]]));
acc("markerNeverArchivedAndConsumedAtBoot", "archive-without-marker", [], run(base(), [[{ t: "owner.backup", kind: "cloud_export" }, w => { w.archives.push({ archiveId: "s1", kind: "cloud_export", topLevelNames: ["home/messages.db"] }); }]]));

// ---------- (g) everyReplacementPreparedBeforeStore -------------------------------------------------------------------------------------

const replaced = (prepared: boolean) => from(w => { w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "cloud_undo", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); if (prepared) w.ghost.preparedEpochs.push(1); });
rej("everyReplacementPreparedBeforeStore", "store-open-without-prep", ["A4-M14"], run(replaced(false), [[tick]]));
// A5-M12: acting. Boot prep commits the epoch's prep, then the store opens.
acc("everyReplacementPreparedBeforeStore", "boot-prep-opens-store", ["A5-M12"], run(from(w => { Object.assign(w, replaced(false)); w.proc.phase = "boot_prep"; }),
  [[{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); w.proc.phase = "store_open"; }]]));

// ---------- (h) quiescenceReachable ------------------------------------------------------------------------------------------------------

const ticks = (n: number): StepSpec[] => Array.from({ length: n }, () => [tick] as StepSpec);
rej("quiescenceReachable", "remove-never-progresses", ["A4-H9", "A4-M13"], run(base(), [[removeA("tB"), w => { w.local.leases.L1 = ls(); }], ...ticks(CHECKER.livenessBound)]));
// A5-H6 / A5-M12: acting. The admitted Keep claims (authority, op, history), confirms with its own GET, records success, arms its guard.
const g1 = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 2, ...o });
acc("quiescenceReachable", "keep-completes", ["A5-H6", "A5-M12"], run(base(), [
  [keepA(), w => { w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK", claimedAtStep: 1 };
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null })); w.ghost.keeps.push(kr({ claimedAtStep: 1 })); }],
  [send(g1()), w => { w.flux.requests.push(g1()); }],
  [apply("g1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 4, result: "ok", fluxStateSeen: "active" } }); }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 5, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: 4 } }); w.local.keepOps = {}; w.local.keepGuards.i1 = gd({ unresolved: [] }); }],
  ...ticks(CHECKER.livenessBound - 3)]));
acc("quiescenceReachable", "unfair-suffix-not-judged", ["A4-M13"], run(withToken(), [
  [removeA("tB"), w => { w.ghost.authorities.push(au()); w.local.leases.L1 = ls(); w.local.bindings.b1.state = "removing"; w.flux.requests.push(d("d1", "at1", { answer: "pending", sentAtStep: 1 })); }],
  ...Array.from({ length: CHECKER.livenessBound }, () => [clk(60_000)] as StepSpec)]));

// ---------- Check 2 opsLinesNeverNameAddress -------------------------------------------------------------------------------------------

const opsLine = (text: string, bindingId: string | null, kind: "blip" | "other" = "other"): Mut => w => {
  w.ops.push({ kind, bindingId, gen: bindingId ? clone(G1) : null, text, window: kind === "blip" ? { closingSinceMs: NOW, restoredAtMs: NOW + 30_000 } : null });
};
rej("opsLinesNeverNameAddress", "line-names-address", ["Check-2"], run(base(), [[tick, opsLine(`blip on ${ADDR}`, "b1", "blip")]]));
rej("opsLinesNeverNameAddress", "line-without-binding", ["A4-L15"], run(base(), [[tick, opsLine("guard check", null)]]));
acc("opsLinesNeverNameAddress", "line-binding-and-window", ["Check-2"], run(base(), [[tick, opsLine("blip b1 gen 1", "b1", "blip")]]));

// ---------- environmentWellFormed ----------------------------------------------------------------------------------------------------------

const heldD1 = () => from(w => { w.flux.requests.push(d("d1", "at1", { answer: "pending" })); });
rej("environmentWellFormed", "restore-erases-held-delete", ["A4-M12", "A3-H1"], run(heldD1(), [[swapA, w => { w.flux.requests = []; }]]));
rej("environmentWellFormed", "delete-on-closing-emits-second-event", ["FLUX-FACT-one-closing-event"], run(
  from(w => { w.flux.requests.push(d("d1", "at1", { flux: "applied" }), d("d2", "at2", { answer: "pending" })); Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d1", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 }); }),
  [[apply("d2"), w => { w.flux.requests[1].flux = "applied"; w.flux.events.push({ eventId: "e-d2", type: "email.inbox.closing", inboxId: "i1", atMs: NOW, atStep: 1, deliveredToHome: false, reason: "owner" }); }]]));
acc("environmentWellFormed", "delete-closes-once", [], run(withRows(heldD1(), botKeepRow()), [[apply("d1"), closeBy("d1")]]));

// ===================================================================================================================================
// r3 witnesses (Astra round 5 = A5-*, Fable round 5 = F5-*)
// ===================================================================================================================================

// ---------- A5-H1: authority bound to what the owner saw and chose ------------------------------------------------------------------

// r2-escape: A5-H1. The row shows k1; the token minted for its Remove additionally shows k2 (an undisplayed key).
rej("viewMintsScopedTokens", "token-shows-undisplayed-key", ["A5-H1"], run(base(), [[{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", keyIds: ["k1"], actions: [{ kind: "remove", tokenId: "tB", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1, shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k1", "k2"] } })); }]])); esc("A5-H1");
rej("viewMintsScopedTokens", "token-minted-outside-view", ["A5-H1"], run(base(), [[tick, w => { w.ghost.tokens.push(tk({ issuedAtStep: 1 })); }]])); esc("A5-H1");
const parkTok = (o: Partial<TokenIssue> = {}) => tk({ tokenId: "tP", kind: "p", gen: null, park: { parkId: "pk1", parkRev: 0 }, ...o });
const parkedTok = () => from(w => { w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; w.ghost.tokens.push(parkTok()); });
// r2-escape: A5-H1. Reconnect presented with a PARK token: r2 validated it in the p branch and never ran the rotation checks.
rej("authorityCreatedByValidOwnerAction", "reconnect-with-park-token", ["A5-H1"], run(parkedTok(), [[
  { t: "owner.reconnect", principal: OWN, botId: "b1", tokenId: "tP", outcome: okO },
  w => { w.ghost.authorities.push(au({ authorityId: "aRot", kind: "rotate_reconnect", tokenId: "tP", parkAtVerify: { parkId: "pk1", parkRev: 0 } })); }]])); esc("A5-H1");
// r2-escape: A5-H1. The owner pressed Remove on i2's row; the authority is scoped to i1 (the token's target), not the owner's choice.
rej("authorityCreatedByValidOwnerAction", "authority-target-differs-from-action", ["A5-H1"], run(withToken(), [[removeA("tB", { target: "inbox:i2" }), w => { w.ghost.authorities.push(au()); }]])); esc("A5-H1");
// r2-escape: F5-L5. An untokened bot-row Keep authority names key k7, which the binding does not hold.
rej("authorityCreatedByValidOwnerAction", "untokened-keep-names-foreign-key", ["F5-L5", "A5-H1"], run(base(), [[keepA(), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k7"] } })); }]])); esc("F5-L5");
acc("authorityCreatedByValidOwnerAction", "untokened-bot-keep", ["R2-Q5"], run(base(), [[keepA(), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } })); claimKeepNow(w); }]]));
acc("authorityCreatedByValidOwnerAction", "park-remove-with-park-token", ["A5-H1"], run(parkedTok(), [[removeA("tP", { section: "parked" }), w => { w.local.leases.L1 = ls({ authorityId: "aRp" }); w.local.parks.pk1.state = "remove_authorized"; w.surface = [pendingRow()];
  w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_park", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } })); }]]));

// ---------- A5-H2: the carry holds queued removals and evidence; one park per target --------------------------------------------------

const carriedRemoval = () => from(w => { w.carry = carry({ removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] }); });
// r2-escape: A5-H2. The outgoing home had an authorized, unsent removal of i1; the archive has i1 active. Prep leaves it active, unparked.
rej("restorePrepParksEverything", "carried-unsent-removal-not-parked", ["A5-H2", "A4-H7"], run(from(w => { Object.assign(w, carriedRemoval()); w.carry!.jobId = "js"; swappedStart(w); }), [[prep]])); esc("A5-H2"); // r3.4c (M1)
acc("restorePrepParksEverything", "carried-unsent-removal-parked", ["A5-H2"], run(from(w => { Object.assign(w, carriedRemoval()); swappedStart(w); }), [[prep, w => { sysPrep(w); w.surface = [orphanRow()]; w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; }]]));
// r2-escape: A5-H2. Two key-only removals (op1, op2) in the archive; prep parks one and resumes the other. r2 let one park stand for both.
rej("restorePrepParksEverything", "one-park-for-two-op-removals", ["A5-H2"], run(from(w => {
  w.local.bindings = {}; w.local.savedKeys = {};
  w.local.parks.pkA = pk({ parkId: "pkA", target: T_OP1, inboxId: null, provisionOpId: "op1" });
  w.local.parks.pkB = pk({ parkId: "pkB", target: "op:op2", inboxId: null, provisionOpId: "op2", keyTargets: [{ keyId: "k2", status: "pending" }] });
}), [[prep, w => { w.local.parks.pkB.state = "remove_authorized"; }]])); esc("A5-H2");
// r2-escape: A5-H2. The outgoing home has an authorized removal lease with no attempt yet; the carry omits it and the swap proceeds.
rej("outgoingCapturedBeforeSwap", "carry-omits-queued-removal", ["A5-H2"], run(from(w => {
  remHist(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); w.carry = carry();
}), [[swapA, w => { w.ghost.epoch = 1; }]])); esc("A5-H2");
acc("outgoingCapturedBeforeSwap", "carry-holds-queued-removal", ["A5-H2"], run(from(w => {
  remHist(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); w.carry = carry({ removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] });
  sysJob(w, "A", "cloud_reset", "captured");
}), [[swapA, w => { sysSwap(w); }]]));
acc("outgoingCapturedBeforeSwap", "carry-deleted-after-prep", [], run(from(w => { w.carry = carry(); w.ghost.epoch = 1; }), [[prep, w => { w.ghost.preparedEpochs.push(1); w.carry = null; }]]));

// ---------- A5-H3: protected contents cannot be edited away ---------------------------------------------------------------------------

// r2-escape: A5-H3 / F5-L1. A tick rewrites an "unknown" guard to [], the next tick releases it (no DELETE held at that moment).
rej("guardLivesUntilEveryDeleteResolved", "unknown-rewritten-then-released", ["A5-H3", "F5-L1"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.requests[0].flux = "applied"; }),
  [[tick, w => { w.local.keepGuards.i1.unresolved = []; }], [tick, delGuard]])); esc("A5-H3");
acc("guardLivesUntilEveryDeleteResolved", "guard-drops-answered-attempt", ["A5-H3"], run(
  from(w => { Object.assign(w, kept(["at1", "at2"])); w.flux.requests.push(d("d2", "at2")); Object.assign(w.flux.requests[0], { flux: "applied", answer: "delivered", answerSeen: { atStep: 0, result: "accepted", fluxStateSeen: "closing" } }); }),
  [[tick, w => { w.local.keepGuards.i1.unresolved = ["at2"]; }]]));
// r2-overstrict: F5-L6. An archived guard for an inbox already purged is released by a GET that answers not_found.
acc("guardLivesUntilEveryDeleteResolved", "guard-released-by-get-not-found", ["F5-L6"], run(
  from(w => { Object.assign(w, kept("unknown")); w.flux.requests[0].flux = "applied"; w.flux.inboxes.i1.state = "purged";
    w.flux.requests.push(rq({ requestId: "g7", kind: "GET_INBOX", target: "i1", purpose: "guard", flux: "applied", answer: "delivered", answerSeen: { atStep: 0, result: "not_found", fluxStateSeen: null } })); }),
  [[tick, delGuard]])); over("F5-L6");
const keptK9 = (removeAt: number) => from(w => { Object.assign(w, keptKey(removeAt)); w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op9", forBot: "b1", state: "live" }; });
// r2-escape: A5-H3. A tick deletes the kept-key entry; the older Remove then revokes the key the owner kept.
rej("keptKeysProtected", "kept-key-entry-dropped-then-revoked", ["A5-H3"], run(keptK9(0), [[tick, w => { delete w.local.keptKeys.k9; }], [revokeK9]])); esc("A5-H3");
acc("keptKeysProtected", "kept-entry-cleared-after-later-remove-revoke", ["A5-H3"], run(from(w => { Object.assign(w, keptK9(3)); leaseK9(w); w.surface = [pendingRow({ section: "key_only", target: "op:op9", inboxId: null, keyIds: ["k9"], provisionOpId: "op9" })]; }), [[revokeK9L],
  [{ t: "net.answer", requestId: "v9", result: "ok", fluxStateSeen: null }, w => { w.flux.keys.k9.state = "revoked"; delete w.local.keptKeys.k9; w.ghost.keptHighWater.k9 = "aK9"; }]]));
// r2-escape: A5-H3. Prep keeps the carried guard's row but rewrites its "unknown" attempts to [] (released on the next tick).
rej("restorePrepParksEverything", "carried-guard-content-weakened", ["A5-H3"], run(from(w => { w.carry = carry({ keepGuards: [gd({ unresolved: "unknown" })], jobId: "js" }); swappedStart(w); }), // r3.4c (M1)
  [[prep, w => { w.local.keepGuards.i1 = gd({ unresolved: [] }); }]])); esc("A5-H3");

// ---------- A5-H4: timing judged only where the named assumptions held; purge ends the terminal obligation ------------------------------

// r2-escape: A5-H4. One early fault excused the bound for ever in r2; r3 restarts the clock at the fault, so 10 idle minutes fail.
rej("keepEndsActive", "fault-excuses-forever", ["A5-H4"], run(kept(), [[apply("d1"), closeBy("d1")], [{ t: "fault.loseAnswer", requestId: "d1" }], [clk(600_000)]])); esc("A5-H4");
const restoreReq = (sentAtMs: number) => rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", sentAtMs });
// r2-overstrict: A5-H4. The home sends its guard RESTORE at once; Flux holds it 120 s (A-RESTORE-APPLY broken); it applies; active.
acc("keepEndsActive", "restore-held-beyond-90s-excused", ["A5-H4"], run(kept(), [
  [apply("d1"), closeBy("d1")],
  [send(restoreReq(NOW)), w => { w.flux.requests.push(restoreReq(NOW)); guardLine(w); }],
  [clk(120_000)],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }],
]), true); over("A5-H4");
// r2-overstrict: A5-H4. Crash, the DELETE closes the inbox, 31 days offline, Flux purges it, the home boots and drops the guard.
acc("keepEndsActive", "offline-30d-purge-then-recover", ["A5-H4"], run(kept(), [
  [apply("d1"), closeBy("d1")],
  [{ t: "fault.crash", at: "W16_event_batch", when: "before" }, w => { w.proc.phase = "down"; }],
  [clk(31 * DAY)],
  [{ t: "flux.purge", inboxId: "i1" }, w => { w.flux.inboxes.i1.state = "purged"; w.flux.events.push({ eventId: "eP", type: "email.inbox.deleted", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason: null }); }],
  [{ t: "auto.boot" }, w => { w.proc.phase = "running"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }],
  [{ t: "auto.applyEvent", eventId: "eP" }, delGuard],
]), true); over("A5-H4");
// r2-overstrict: A5-H4 / R2-Q3. After 24 h the bound rests on A-EVENT-5MIN; the closing event arrives 8 min late, the home restores at once.
acc("keepEndsActive", "late-event-after-24h-excused", ["A5-H4", "R2-Q3"], run(kept(), [
  [clk(2 * DAY)],
  [apply("d1"), closeBy("d1")],
  [clk(8 * 60_000)],
  [{ t: "auto.applyEvent", eventId: "e-d1" }],
  [send(restoreReq(NOW + 2 * DAY + 8 * 60_000)), w => { w.flux.requests.push(restoreReq(w.nowMs)); guardLine(w); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }],
]), true); over("A5-H4");
// r2-overstrict: F5-L4. A Remove recorded before the trace (initial ghost) but after the Keep ends the Keep's window.
acc("keepEndsActive", "pre-trace-remove-ends-window", ["F5-L4"], run(from(w => { Object.assign(w, kept()); w.step = 3; w.ghost.authorities.push(au({ authorityId: "aR2", verifiedAtStep: 2 })); }),
  [[apply("d1"), closeBy("d1")], [clk(2 * 3600_000)]])); over("F5-L4");

// ---------- A5-H5, F5-M1, F5-M2: blind restore, owner confirmation, discovery ----------------------------------------------------------

const unknownEntries: Mut = w => {
  w.flux.inboxes.i5 = { inboxId: "i5", installOwned: true, createdUnderOp: "op5", forBot: "b5", address: "x5@mail.test", state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null };
  w.flux.keys.k5 = { keyId: "k5", installOwned: true, mintedUnderOp: "op5", forBot: "b5", state: "live" };
};
// r2-escape: A5-H5 / F5-M2. Blind restore (epoch 1, unconfirmed), then a NON-blind restore (epoch 2) of that incomplete DB: r2 lifted the fence.
rej("noDestructiveSendAfterBlindRestore", "fence-dropped-by-second-restore", ["A5-H5", "F5-M2"], run(from(w => {
  w.ghost.epoch = 2;
  w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null });
  w.ghost.restores.push({ atStep: 1, atMs: NOW, epochAfter: 2, source: "cloud_undo", archiveId: "B", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null });
}), [[send(d("d1", "at1", { answer: "pending" }))]])); esc("A5-H5");
acc("noDestructiveSendAfterBlindRestore", "delete-after-complete-listing", ["Q2-ruling", "A5-H5"], run(from(w => {
  Object.assign(w, blind(false)); w.flux.semantics.listingShipped = true; remHistE1(w); w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] }); w.surface = [rcRow()]; w.ghost.tokens.push(rTok());
  w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, flux: "applied", answer: "delivered", answerSeen: { atStep: 2, result: "ok", fluxStateSeen: null }, listingComplete: true }));
}), [[send(d("d1", "at1", { answer: "pending" }))]]));
const confirmStep = (): StepSpec => [{ t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: 1, botId: null, scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null }));
  w.ghost.inventoryConfirmedEpochs.push(1); w.surface = []; }];
// r2-overstrict: A5-H5 / F5-M1 / R2-Q4. Owner confirms a blind restore before any listing: unknown inbox i5 and key k5 stay live, no row.
acc("everyOrphanHasExecutableAction", "unknown-inbox-after-confirm-no-listing", ["A5-H5", "F5-M1", "R2-Q4"], run(
  from(w => { Object.assign(w, blind(false)); unknownEntries(w); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), [confirmStep()])); over("A5-H5");
// r2-overstrict: A5-H5 / F5-M1. Listing shipped, owner confirmed; the discovery LIST is sent and not yet answered: k5 is not yet lost.
acc("keyTargetsNeverLost", "unknown-key-while-discovery-pending", ["A5-H5", "F5-M1", "R2-Q4"], run(
  from(w => { Object.assign(w, blind(true)); unknownEntries(w); w.flux.semantics.listingShipped = true; }),
  [[send(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1 })), w => { w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1 })); }]])); over("A5-H5");
rej("keyTargetsNeverLost", "listed-key-no-record", ["A5-H5", "F5-M1"], run(
  from(w => { Object.assign(w, blind(true)); unknownEntries(w); w.flux.semantics.listingShipped = true; }),
  [[{ t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null }, w => {
    w.flux.requests.push(rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, flux: "applied", answer: "delivered", answerSeen: { atStep: 1, result: "ok", fluxStateSeen: null }, listingComplete: true })); }]]));
// r2-escape: A5-H5 (R2-Q4: a discovery pass is REQUIRED once the listing exists). Listing shipped, nothing ever lists: r2 called it quiet.
rej("quiescenceReachable", "discovery-never-run", ["A5-H5", "R2-Q4"], run(from(w => { Object.assign(w, blind(true)); w.flux.semantics.listingShipped = true; }), ticks(CHECKER.livenessBound))); esc("A5-H5");
const listReq = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "L1", kind: "LIST_ACCOUNT", target: "acct", purpose: "discovery", sentAtStep: 1, sentInEpoch: 1, ...o });
acc("quiescenceReachable", "discovery-run-then-quiet", ["A5-H5", "R2-Q4"], run(from(w => { Object.assign(w, blind(true)); w.flux.semantics.listingShipped = true; }), [
  [send(listReq()), w => { w.flux.requests.push(listReq()); }],
  [apply("L1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 3, result: "ok", fluxStateSeen: null }, listingComplete: true }); }],
  ...ticks(CHECKER.livenessBound - 3)]));

// ---------- A5-H6, F5-H1: an admitted owner action does its work; refusals keyed to their premise ---------------------------------------

// r2-escape: A5-H6. Keep on a visible parked row "succeeds" and creates no authority, no Keep op, no history; the park is unchanged.
rej("admissionPinned", "noop-keep-ok", ["A5-H6", "F4-H2"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" })]])); esc("A5-H6");
// r2-escape: A5-H6. The same no-op Keep, then a fair quiet suffix: r2 judged it quiescent (parked waiting) and complete.
rej("quiescenceReachable", "noop-keep-quiescent", ["A5-H6"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" })], ...ticks(CHECKER.livenessBound)])); esc("A5-H6");
acc("admissionPinned", "keep-ok-claims", ["A5-H6"], run(parkedTok(), [[keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.local.parks.pk1.state = "keep_pending"; w.surface = [pendingRow()]; }]]));
// r2-escape: F5-H1. Remove on a PARKED row of a present bot refused "bot_present": r2 treated every non-bot section as absent-bot.
rej("admissionPinned", "remove-refused-bot-present-on-parked", ["F5-H1"], run(parkedTok(), [[removeA("tP", { section: "parked", outcome: no("bot_present") })]])); esc("F5-H1");
// r2-escape: F5-H1. Keep on an orphan inbox held only by a carried guard refused "inbox_gone" with no gone evidence.
rej("admissionPinned", "keep-refused-inbox-gone-guard-only", ["F5-H1"], run(from(w => {
  w.bots.b1.present = false; w.local.bindings = {}; w.local.savedKeys = {}; w.local.keepGuards.i1 = gd({ unresolved: "unknown" });
  w.ghost.tokens.push(tk({ tokenId: "tF", kind: "f", botId: null, gen: null }));
}), [[keepA({ mode: "orphan", tokenId: "tF", outcome: no("inbox_gone") })]])); esc("F5-H1");
const removeParked = (): StepSpec => [removeA("tP", { section: "parked" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_park", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.leases.L1 = ls({ authorityId: "aRp" }); w.local.parks.pk1.state = "remove_authorized"; w.surface = [pendingRow()]; }];
acc("admissionPinned", "remove-on-parked-row-succeeds", ["F5-H1"], run(parkedTok(), [removeParked()]));

// ---------- A5-H7: a restored, parked removal is never hidden ---------------------------------------------------------------------------

// r2-escape: A5-H7. A pre-restore DELETE (epoch 0 authority) lands on i1 after prep parked it; r2 exempted i1 as "removed by owner".
rej("everyOrphanHasExecutableAction", "restored-parked-removal-hidden", ["A5-H7", "F4-M3"], run(from(w => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); w.ghost.preparedEpochs.push(1);
  tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: -5 }));
  w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked";
  w.flux.requests.push(d("d1", "at1", { flux: "applied", answer: "pending" }));
}), [[apply("d1"), closeBy("d1")]])); esc("A5-H7");

// ---------- A5-H8 (R2-Q2): both DELETE idempotency semantics encoded consistently ----------------------------------------------------

const dupAfterRestore = (honoured: boolean) => from(w => {
  w.flux.semantics.deleteIdempotencyKeyHonoured = honoured;
  w.flux.requests.push(d("d1", "at1", { flux: "applied", appliedAtMs: NOW, answer: "delivered" }), d("d1c", "at1", { copyOf: "d1", answer: "pending" }));
});
// r2-escape: A5-H8. Idempotency key honoured: the duplicate lands after the Keep restored i1 and closes it AGAIN (a second execution).
rej("environmentWellFormed", "idempotent-duplicate-executes-twice", ["A5-H8", "R2-Q2"], run(dupAfterRestore(true), [[apply("d1c"), closeBy("d1c")]])); esc("A5-H8");
// r2-overstrict: A5-H8. Idempotency key honoured: the duplicate is applied with no effect.
acc("environmentWellFormed", "idempotent-duplicate-silent", ["A5-H8", "R2-Q2"], run(dupAfterRestore(true), [[apply("d1c"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); }]])); over("A5-H8");
acc("environmentWellFormed", "non-idempotent-duplicate-executes", ["A5-H8", "R2-Q2"], run(withRows(dupAfterRestore(false), botKeepRow()), [[apply("d1c"), closeBy("d1c")]]));

// ---------- A5-M9: fairness covers work created during the suffix; livelock is caught -----------------------------------------------

// r2-overstrict: A5-M9. Recovery from an authorized lease sends its DELETE near the end; the request is legitimately still held.
acc("quiescenceReachable", "recovery-new-request-at-end", ["A5-M9"], run(from(w => { w.local.bindings.b1.state = "removing"; w.local.leases.L1 = ls(); tokB(w); w.ghost.authorities.push(au({ verifiedAtStep: 0 })); }), [
  ...ticks(4), [tick, w => { Object.assign(w.local.leases.L1, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(d("d1", "at1", { answer: "pending", sentAtStep: 6 })), w => { w.flux.requests.push(d("d1", "at1", { answer: "pending", sentAtStep: 6 })); }],
  [tick]])); over("A5-M9");
const pollRound = (n: number): StepSpec[] => {
  const g = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "p" + n, kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * n + 1, ...o });
  return [[tick, w => { w.flux.requests.push(g()); }], [apply("p" + n), w => { Object.assign(w.flux.requests[n], { flux: "applied", appliedAtMs: w.nowMs }); }],
    [{ t: "net.answer", requestId: "p" + n, result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[n], { answer: "delivered", answerSeen: { atStep: 3 * n + 3, result: "ok", fluxStateSeen: "active" } }); }]];
};
const livelockRounds = Math.ceil(CHECKER.fairRecoverySteps / 3);
rej("quiescenceReachable", "recovery-livelock", ["A5-M9"], run(base(), [
  ...Array.from({ length: livelockRounds }, (_, n) => pollRound(n)).flat(),
  [tick, w => { w.flux.requests.push(rq({ requestId: "pz", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * livelockRounds + 1 })); }]]));

// ---------- A5-M10: removal revokes need the send claim too --------------------------------------------------------------------------

const revokeK1 = send(rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", removalId: "L1", attemptId: "at2", authorityId: "aR", answer: "pending" }));
// r2-escape: A5-M10. A removal revoke leaves while the lease is only authorized (no send claim; Keep admission cannot see it).
rej("removalSendNeedsSendingLease", "revoke-without-send-claim", ["A5-M10", "F4-M4"], run(from(w => { remHist(w); w.local.leases.L1 = ls({ keyTargets: [{ keyId: "k1", status: "pending" }] }); }), [[revokeK1]])); esc("A5-M10");
acc("removalSendNeedsSendingLease", "revoke-under-sending-lease", ["A5-M10"], run(from(w => {
  remHist(w); w.local.leases.L1 = ls({ phase: "sending", attemptId: "at2", attempts: ["at2"], keyTargets: [{ keyId: "k1", status: "pending" }] }); }), [[revokeK1]]));

// ---------- A5-M11, F5-L2: history and recorder fields are fixed once written ----------------------------------------------------------

// r2-escape: A5-M11. A successful Keep's success time is erased (keepEndsActive would then skip it).
rej("environmentWellFormed", "keep-success-time-erased", ["A5-M11", "A4-M12"], run(keptRecord(), [[tick, w => { w.ghost.keeps[0].succeededAtMs = null; }]])); esc("A5-M11");
// r2-escape: F5-L2. A non-owner step records an inventory confirmation (would make the blind fence vacuous).
rej("environmentWellFormed", "confirm-epoch-without-owner", ["F5-L2"], run(blind(false), [[tick, w => { w.ghost.inventoryConfirmedEpochs.push(1); }]])); esc("F5-L2");
acc("environmentWellFormed", "owner-confirms-inventory", ["F5-L2"], run(from(w => { Object.assign(w, blind(false)); w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); }), [confirmStep()]));

// ---------- F5-M3: a Flux-caused closing is offered even when a guard exists ------------------------------------------------------------

// r2-escape: F5-M3. After a Keep (guard present), Flux closes i1 for billing; no Keep is offered on the bot row.
rej("everyOrphanHasExecutableAction", "flux-close-guarded-no-keep-row", ["F5-M3", "F4-M1"], run(from(w => { w.local.keepGuards.i1 = gd(); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, fluxClose("billing")]])); esc("F5-M3");
acc("everyOrphanHasExecutableAction", "flux-close-guarded-keep-row", ["F5-M3"], run(from(w => { w.local.keepGuards.i1 = gd(); }), [[{ t: "flux.close", inboxId: "i1", reason: "billing" }, w => {
  fluxClose("billing")(w); w.surface = [row({ section: "bot", actions: [{ kind: "keep", tokenId: null, enabled: true }] })]; }]]));

// ---------- F5-L3: only an ok Keep / Remove / bot delete moves a parked park ------------------------------------------------------------

// r2-escape: F5-L3. Reconnect names the bot and moves its parked park to remove_authorized.
rej("nothingAutomaticUnparks", "reconnect-unparks", ["F5-L3"], run(parked(), [[{ t: "owner.reconnect", principal: OWN, botId: "b1", tokenId: "tB", outcome: okO }, w => { w.local.parks.pk1.state = "remove_authorized"; }]])); esc("F5-L3");
acc("nothingAutomaticUnparks", "owner-remove-moves-park", ["F5-L3", "F5-H1"], run(parkedTok(), [removeParked()]));

// ---------- R3-Q4 (r3.1): an ok owner.deleteBot kills that bot's authorities, tokens and leases in the same step ---------------------

/** b1 holds Remove authority aR (pre-trace) with lease L1 sending attempt at1; b2 holds aR2 on i2 with lease L2 sending at2. Step 1:
 *  ok owner.deleteBot [b1] with b token tD, creating its own bot_delete_with_token authority aD and recording the deletion. */
const twoBots = () => from(w => {
  w.bots.b2 = { botId: "b2", present: true };
  const s2 = { target: "inbox:i2", inboxId: "i2", keyIds: [] as string[] };
  w.ghost.tokens.push(tk({ issuedAtStep: -4 }), tk({ tokenId: "tB2", botId: "b2", gen: null, shown: { ...s2, address: null }, issuedAtStep: -4 }), tk({ tokenId: "tD" }));
  w.ghost.authorities.push(au({ verifiedAtStep: -3 }), au({ authorityId: "aR2", botId: "b2", tokenId: "tB2", verifiedAtStep: -3, scope: s2, genAtVerify: null }));
  w.local.leases.L1 = ls({ phase: "sending", attemptId: "at1", attempts: ["at1"] });
  w.local.leases.L2 = ls({ removalId: "L2", target: "inbox:i2", inboxId: "i2", botId: "b2", authorityId: "aR2", phase: "sending", attemptId: "at2", attempts: ["at2"] });
});
const deleteB1: StepSpec = [{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: 1 }));
  w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; }];
/** An ok delete does its work in the same step: b1's old lease dies, the delete's own lease LD names aD, and i1 shows its pending row. */
const deleteB1Clean: StepSpec = [deleteB1[0], w => { deleteB1[1]!(w); delete w.local.leases.L1; w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); w.surface = [pendingRow()]; }];
// r3-escape: Q4. After the ok bulk delete of b1, b1's OLD Remove authority aR (and its lease L1) is used again to send a DELETE of i1.
const reusedD = d("d1", "at1", { answer: "pending", sentAtStep: 2 });
rej("deletedBotAuthorityDead", "deleteBot-authority-reused", ["R3-Q4"], run(twoBots(), [deleteB1, [send(reusedD), w => { w.flux.requests.push(clone(reusedD)); }]]));
// r3-escape: Q4. The same delete leaves b2 untouched: b2's authority aR2 and lease L2 then send i2's DELETE legitimately.
const otherD = d("d2", "at2", { target: "i2", removalId: "L2", authorityId: "aR2", answer: "pending", sentAtStep: 2 });
acc("deletedBotAuthorityDead", "deleteBot-other-bot-untouched", ["R3-Q4"], run(twoBots(), [deleteB1Clean, [send(otherD), w => { w.flux.requests.push(clone(otherD)); }]]));

// ===================================================================================================================================
// r3.2 witnesses (Astra final check of r3 = A6-*, Fable final check = FA-*). Every start world passes initialStateValid.
// ===================================================================================================================================

// ---------- A6-H1: every admitted owner op completes; nothing automatic rolls keep_pending back to parked ------------------------------

/** Step 1: an admitted orphan Keep on parked pk1 (valid p token): authority, Keep op, history, park keep_pending. */
const admitKeep = (): StepSpec => [keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending"; }];
const viewS: StepSpec = [{ t: "owner.viewSurface", principal: OWN }];
const admitKeepRow = (): StepSpec => { const a = admitKeep(); return [a[0], w => { a[1]!(w); w.surface = [pendingRow()]; }]; };
// r3.1-escape: A6-H1. The admitted Keep is discarded after a later view (op dropped, keep_pending -> parked); r3.1 judged only the view.
rej("quiescenceReachable", "keep-admitted-then-view-discarded", ["A6-H1", "A5-H6"], run(parkedTok(), [admitKeep(), viewS,
  [tick, w => { w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; }], ...ticks(CHECKER.livenessBound)])); esc31("A6-H1");
// r3.1-escape: A6-H1. A tick rolls an admitted keep_pending park back to parked.
rej("nothingAutomaticUnparks", "auto-rolls-keep-pending-to-parked", ["A6-H1"], run(from(w => {
  Object.assign(w, parkedTok()); keepHist(w, { mode: "orphan", claimedAtStep: 0 }); w.local.parks.pk1.state = "keep_pending";
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 0 };
}), [[tick, w => { w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; }]])); esc31("A6-H1");
// A6-H1 accept: the admitted Keep completes AFTER a later view (own GET, success, guard, park done).
const g1v = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "g1", kind: "GET_INBOX", target: "i1", purpose: "keep", keepOp: "kp1", sentAtStep: 3, ...o });
acc("quiescenceReachable", "keep-admitted-completes-after-view", ["A6-H1"], run(parkedTok(), [admitKeepRow(), viewS,
  [send(g1v()), w => { w.flux.requests.push(g1v()); }],
  [apply("g1"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "g1", result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 5, result: "ok", fluxStateSeen: "active" } }); }],
  [tick, w => { Object.assign(w.ghost.keeps[0], { succeededAtStep: 6, succeededAtMs: w.nowMs, confirmedBy: { requestId: "g1", atStep: 5 } });
    w.local.keepOps = {}; w.local.keepGuards.i1 = gd({ unresolved: "unknown" }); delete w.local.parks.pk1; w.local.bindings.b1.state = "active"; w.surface = []; }],
  ...ticks(CHECKER.livenessBound)]));
// A6-H1 owner-caused end (MurageMain a): Keep admitted on the bot's OLD inbox i2 (park pk2), then the owner deletes the bot. The
// delete kills the Keep op (deletedBotAuthorityDead), parks i2 again (owner step) and removes i1 + k1 to completion. MUTANT
// `keep-end-by-bot-delete-is-violation` (quiescenceReachable without the deletedAfter end) must reject this accept.
// (MurageMain b: the model has NO owner action that withdraws or cancels a Keep, so there is no such end and no witness.)
const keepThenDelete = () => from(w => {
  w.local.parks.pk2 = pk({ parkId: "pk2", target: "inbox:i2", inboxId: "i2", provisionOpId: "op2", keyTargets: [], address: "old@mail.test", gen: { inboxId: "i2", opId: "op2", emailKeyRef: null, serial: 0 } });
  w.ghost.tokens.push(parkTok({ tokenId: "tP2", park: { parkId: "pk2", parkRev: 0 }, shown: { target: "inbox:i2", address: "old@mail.test", inboxId: "i2", keyIds: [] } }), tk({ tokenId: "tD" }));
});
const dD = (o: Partial<RemoteRequest> = {}) => d("d1", "at1", { removalId: "LD", authorityId: "aD", answer: "pending", sentAtStep: 4, ...o });
const vD = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "v1", kind: "REVOKE_KEY", target: "k1", removalId: "LD", attemptId: "at1", authorityId: "aD", sentAtStep: 7, ...o });
const deleteB1Work: StepSpec = [{ t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aD", kind: "bot_delete_with_token", tokenId: "tD", verifiedAtStep: w.step }));
  w.ghost.botDeletedAtStep.b1 = w.step; w.bots.b1.present = false; w.local.bindings.b1.state = "removing";
  w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD", keyTargets: [{ keyId: "k1", status: "pending" }] }); }];
acc("quiescenceReachable", "keep-ended-by-owner-bot-delete", ["A6-H1", "MurageMain-a"], run(keepThenDelete(), [
  [keepA({ target: "inbox:i2", mode: "orphan", tokenId: "tP2" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP2", genAtVerify: null, parkAtVerify: { parkId: "pk2", parkRev: 0 }, scope: { target: "inbox:i2", inboxId: "i2", keyIds: [] } }));
    w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: "inbox:i2", inboxId: "i2", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
    w.ghost.keeps.push(kr({ target: "inbox:i2", inboxId: "i2", mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk2.state = "keep_pending"; }],
  [deleteB1Work[0], w => { deleteB1Work[1]!(w); w.local.keepOps = {}; w.local.parks.pk2.state = "parked"; w.surface = [pendingRow()]; }],
  [tick, w => { Object.assign(w.local.leases.LD, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(dD()), w => { w.flux.requests.push(dD()); }],
  [apply("d1"), closeBy("d1", "bot_deleted")],
  [{ t: "net.answer", requestId: "d1", result: "accepted", fluxStateSeen: "closing" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 6, result: "accepted", fluxStateSeen: "closing" } }); w.local.leases.LD.phase = "sending"; }],
  [send(vD()), w => { w.flux.requests.push(vD()); }],
  [apply("v1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); w.flux.keys.k1.state = "revoked"; }],
  [{ t: "net.answer", requestId: "v1", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[1], { answer: "delivered", answerSeen: { atStep: 9, result: "ok", fluxStateSeen: null } }); }],
  [tick, w => { w.local.leases = {}; w.local.bindings = {}; w.local.savedKeys = {}; w.flux.events[0].deliveredToHome = true; w.surface = []; }],
  ...ticks(CHECKER.livenessBound)]));

// ---------- A6-M2: after a complete listing, discovery takes effect ------------------------------------------------------------------

const unlistedBlind = () => from(w => { Object.assign(w, blind(false)); unknownEntries(w); w.flux.semantics.listingShipped = true; w.surface = [rcRow()]; w.ghost.tokens.push(rTok()); });
const listAnswered: Mut = w => { w.flux.requests.push(listReq({ flux: "applied", answer: "delivered", answerSeen: { atStep: w.step, result: "ok", fluxStateSeen: null }, listingComplete: true })); };
const listAns: Action = { t: "net.answer", requestId: "L1", result: "ok", fluxStateSeen: null };
// r3.1-escape: A6-M2. Unconfirmed blind restore, complete listing delivered, only the restore-check row kept: listed k5 has no record.
rej("keyTargetsNeverLost", "listing-delivered-unconfirmed-no-record", ["A6-M2", "F5-M1"], run(unlistedBlind(), [[listAns, listAnswered]])); esc31("A6-M2");
// r3.1-escape: A6-M2. The same: listed inbox i5 has no row.
rej("everyOrphanHasExecutableAction", "listing-delivered-unconfirmed-no-row", ["A6-M2", "F5-M1"], run(unlistedBlind(), [[listAns, listAnswered]])); esc31("A6-M2");
const discovered: Mut = w => {
  listAnswered(w);
  w.local.parks.pk5 = pk({ parkId: "pk5", botId: "b5", origin: "restore", target: "op:op5", inboxId: null, provisionOpId: "op5", address: null, gen: { inboxId: null, opId: "op5", emailKeyRef: "k5", serial: 0 }, keyTargets: [{ keyId: "k5", status: "pending" }] });
  w.surface = [rcRow(), row({ section: "key_only", target: "op:op5", botId: "b5", inboxId: null, keyIds: ["k5"], provisionOpId: "op5",
    actions: [{ kind: "keep", tokenId: "t5", enabled: true }, { kind: "remove", tokenId: "t5", enabled: true }] })];
};
acc("keyTargetsNeverLost", "listing-delivered-entries-recorded", ["A6-M2"], run(unlistedBlind(), [[listAns, discovered]]));
acc("everyOrphanHasExecutableAction", "listing-delivered-entries-rowed", ["A6-M2"], run(unlistedBlind(), [[listAns, discovered]]));

// ---------- A6-M3: kept-key protection judged on the carry, not at the swap ----------------------------------------------------------

const keptSwapStart = (carried: string | null) => from(w => {
  const sc = { target: "op:op9", inboxId: null, keyIds: ["k9"] };
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: -5, scope: sc }), au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: -2, scope: sc }));
  w.local.keptKeys.k9 = "aKn"; w.carry = carry({ keyIds: ["k1", "k9"], keptKeys: carried ? { k9: carried } : {} }); sysJob(w, "A", "cloud_reset", "captured");
});
const swapOld: StepSpec = [swapA, w => { w.local.keptKeys = { k9: "aKo" }; w.ghost.keptHighWater.k9 = "aKn"; w.ghost.epoch = 1; pendingPrep(w, true); w.proc.phase = "boot_prep";
  w.ghost.restores.push({ atStep: w.step, atMs: NOW, epochAfter: 1, source: "cloud_reset", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); }];
// r3.1-overstrict: A6-M3. Outgoing k9 kept under NEWER aKn, archive under OLDER aKo; the carry holds aKn and the prep restores it.
acc("keptKeysProtected", "swap-archive-older-keep-carry-newer", ["A6-M3", "A5-H3"], run(keptSwapStart("aKn"), [swapOld,
  [prep, w => { w.local.keptKeys.k9 = "aKn"; w.ghost.preparedEpochs.push(1); pendingPrep(w, false); w.proc.phase = "running"; w.carry = null; }]])); over31("A6-M3");
// r3.1-escape: A6-M3. Post-swap, the prep keeps the archive's OLDER Keep although the carry holds the newer one.
rej("keptKeysProtected", "prep-keeps-archive-older-keep", ["A6-M3"], run(from(w => { Object.assign(w, keptSwapStart("aKn")); swapOld[1]!(w); }),
  [[prep, w => { w.ghost.preparedEpochs.push(1); w.carry = null; }]])); esc31("A6-M3");
rej("keptKeysProtected", "swap-carry-drops-kept-key", ["A6-M3"], run(keptSwapStart(null), [swapOld]));

// ---------- A6-M4: livelock judged after the last drained step ------------------------------------------------------------------------

// r3.1-escape: A6-M4. One drained tick, then the endless polling loop of recovery-livelock.
rej("quiescenceReachable", "drained-tick-then-livelock", ["A6-M4", "A5-M9"], run(base(), [[tick],
  ...Array.from({ length: livelockRounds }, (_, n) => pollRound(n)).flat(),
  [tick, w => { w.flux.requests.push(rq({ requestId: "pz", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: 3 * livelockRounds + 2 })); }]])); esc31("A6-M4");

// ---------- A6-M5 (R3-Q4): an ok bot delete creates its work and completes ---------------------------------------------------------

const delStart = () => from(w => { w.ghost.tokens.push(tk({ tokenId: "tD" })); });
const delOk: Action = { t: "owner.deleteBot", principal: OWN, botIds: ["b1"], tokens: { b1: "tD" }, outcome: okO };
// r3.1-escape: A6-M5. The ok delete records the deletion and creates no authority and no removal work.
rej("admissionPinned", "deleteBot-ok-creates-nothing", ["A6-M5", "R3-Q4"], run(delStart(), [[delOk, w => { w.ghost.botDeletedAtStep.b1 = 1; w.bots.b1.present = false; }]])); esc31("A6-M5");
// r3.1-escape: A6-M5. Authority and lease, but the delete's own parked target stays parked (waits for ever).
rej("admissionPinned", "deleteBot-leaves-park-waiting", ["A6-M5"], run(from(w => { Object.assign(w, parked()); w.ghost.tokens.push(tk({ tokenId: "tD" })); }), [deleteB1Work])); esc31("A6-M5");
acc("admissionPinned", "deleteBot-ok-authorizes-and-leases", ["A6-M5"], run(from(w => { Object.assign(w, parked()); w.ghost.tokens.push(tk({ tokenId: "tD" })); }),
  [[deleteB1Work[0], w => { deleteB1Work[1]!(w); w.local.parks.pk1.state = "remove_authorized"; w.surface = [pendingRow()]; }]]));
// r3.1-escape: A6-M5. The delete's lease is dropped by a tick and nothing is sent; i1 stays active.
rej("quiescenceReachable", "deleteBot-work-dropped", ["A6-M5"], run(delStart(), [deleteB1Work, [tick, w => { w.local.leases = {}; w.local.bindings = {}; }], ...ticks(CHECKER.livenessBound)])); esc31("A6-M5");

// ---------- FA-M1: the blip bound is derived from the named assumptions (120 s) ------------------------------------------------------

const guardRestoreAt = (o: Partial<RemoteRequest> = {}) => rq({ requestId: "r1", kind: "RESTORE_INBOX", target: "i1", purpose: "guard", ...o });
// r3.1-overstrict: FA-M1. Still closing EXACTLY at the derived worst case (poll 60 + answer 30 + apply 30 = 120 s), then restored.
acc("keepEndsActive", "blip-at-derived-worst-case-120s", ["FA-M1", "A5-H4"], run(kept(), [[apply("d1"), closeBy("d1")],
  [clk(120_000)], [send(guardRestoreAt({ sentAtMs: NOW + 120_000 })), w => { w.flux.requests.push(guardRestoreAt({ sentAtMs: w.nowMs })); guardLine(w); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }]]), true); over31("FA-M1");
// r3.1-overstrict: FA-M1. The same at ~115 s.
acc("keepEndsActive", "blip-at-115s", ["FA-M1"], run(kept(), [[apply("d1"), closeBy("d1")],
  [clk(115_000)], [send(guardRestoreAt({ sentAtMs: NOW + 115_000 })), w => { w.flux.requests.push(guardRestoreAt({ sentAtMs: w.nowMs })); guardLine(w); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }]]), true); over31("FA-M1");
rej("keepEndsActive", "blip-1ms-past-worst-case", ["FA-M1"], run(kept(), [[apply("d1"), closeBy("d1")], [clk(120_001)]]));

// ---------- FA-M2: bot_present keys on the TARGET row's bot, not the action's ---------------------------------------------------------

/** b1 present, live on i2 (gen 2); i1 at Flux is an orphan of ABSENT b2 (no park); f token on i1's row. */
const orphanOfOther = (i1Owner: "b1" | "none") => from(w => {
  w.bots.b2 = { botId: "b2", present: false };
  w.local.bindings.b1.gen = { inboxId: i1Owner === "b1" ? "i1" : "i2", opId: "op2", emailKeyRef: "k1", serial: 2 };
  w.flux.inboxes.i1.forBot = "b2";
  w.ghost.tokens.push(tk({ tokenId: "tF", kind: "f", botId: null, gen: null, shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: [] } }));
});
// r3.1-escape: FA-M2. The action's bot b1 is present, the row's premise (no present live binding names i1) holds: refusal illegal.
rej("admissionPinned", "keep-refused-bot-present-on-orphan-of-present-bot", ["FA-M2", "F5-H1"], run(orphanOfOther("none"), [[keepA({ mode: "orphan", tokenId: "tF", outcome: no("bot_present") })]])); esc31("FA-M2");
// r3.1-overstrict: FA-M2 / FA-L1. The action names ABSENT b2, but present b1's live binding now names i1: bot_present is legal.
acc("admissionPinned", "keep-refused-bot-present-row-bot-differs", ["FA-M2", "FA-L1"], run(orphanOfOther("b1"), [[keepA({ botId: "b2", mode: "orphan", tokenId: "tF", outcome: no("bot_present") })]])); over31("FA-M2");

// ---------- FA-M3 (High-class): inbox_gone only on purge / deleted evidence -----------------------------------------------------------

const pkE = () => from(w => { Object.assign(w, parkedTok()); w.local.parks.pk1.state = "parked_evidence"; w.local.parks.pk1.remoteDeletedAtMs = NOW;
  Object.assign(w.flux.inboxes.i1, { state: "closing", closingCause: { kind: "delete", requestId: "d0", reason: "owner" }, closingSinceMs: NOW, closingSinceStep: 0 }); });
// r3.1-escape: FA-M3. Keep on the standing order's main row (parked_evidence, inbox CLOSING, restorable) refused "inbox_gone".
// MUTANT `closing-is-gone` (inboxGone true on a parked_evidence park or a closing inbox) must accept it, so this witness kills it.
rej("admissionPinned", "keep-refused-inbox-gone-on-parked-evidence", ["FA-M3", "standing-order"], run(pkE(), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]])); esc31("FA-M3");
acc("admissionPinned", "keep-admitted-on-parked-evidence", ["FA-M3", "standing-order"], run(pkE(), [[keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: 1 };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: 1 })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending"; w.surface = [pendingRow()]; }]]));
const purgedSeen = (delivered: boolean) => from(w => { Object.assign(w, pkE()); w.flux.inboxes.i1.state = "purged";
  w.flux.events.push({ eventId: "eP", type: "email.inbox.deleted", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: delivered, reason: null }); });
acc("admissionPinned", "keep-refused-inbox-gone-after-delivered-purge", ["FA-M3"], run(purgedSeen(true), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]]));
// r3.1-escape: FA-M3. After the purge but BEFORE the home has seen any purge / deleted evidence: inbox_gone is still illegal.
rej("admissionPinned", "keep-refused-inbox-gone-purge-unseen", ["FA-M3"], run(purgedSeen(false), [[keepA({ mode: "orphan", tokenId: "tP", outcome: no("inbox_gone") })]])); esc31("FA-M3");

// ===================================================================================================================================
// r3.3 witnesses (MurageMain ruling 1, Astra check of r3.2 = A7-*, Fable FA-L2 / FA-L7). Every start world passes initialStateValid.
// ===================================================================================================================================

// ---------- A7-H1 (ruling 1): only an OWNER restore requested AFTER the Keep claim ends an admitted Keep ------------------------------

/** An admitted orphan Keep on parked pk1 claimed in THIS step; its key k1 is protected (keptKeys) from the claim. */
const admitKeepNow = (): StepSpec => [keepA({ mode: "orphan", tokenId: "tP" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: "tP", verifiedAtStep: w.step, genAtVerify: null, parkAtVerify: { parkId: "pk1", parkRev: 0 } }));
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "orphan", authorityId: "aK", claimedAtStep: w.step };
  w.ghost.keeps.push(kr({ mode: "orphan", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp1"); w.local.parks.pk1.state = "keep_pending";
  w.local.keptKeys.k1 = "aK"; w.surface = [pendingRow()]; }];
const ownerRestoreA: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "A" }, w => {
  w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "A" }); arm(w, "A"); }];
const captureK: StepSpec = [{ t: "auto.captureOutgoing" }, w => {
  w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, capturedAtStep: w.step, keptKeys: { k1: "aK" }, removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] }); phase(w, "captured"); }];
/** The swap answers the owner request of step `req` (null = an automatic / system restore nobody asked for). The archive predates the
 *  Keep: pk1 parked, no Keep op, no kept key. */
const swapK = (req: number | null): StepSpec => [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, w => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: req, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keepOps = {}; w.local.parks.pk1.state = "parked"; w.local.keptKeys = {}; w.ghost.keptHighWater.k1 = "aK"; pendingPrep(w, true); w.proc.phase = "boot_prep"; w.surface = [orphanRow()]; }];
const prepK: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); pendingPrep(w, false); w.proc.phase = "running"; w.carry = null; w.local.keptKeys.k1 = "aK"; }];
const ownerAfter = () => run(parkedTok(), [admitKeepNow(), ownerRestoreA, captureK, swapK(2), prepK, clearJob, ...ticks(CHECKER.livenessBound)]);
const autoOnly = () => run(parkedTok(), [admitKeepNow(), sysArm(), captureK, swapK(null), prepK, clearJob, ...ticks(CHECKER.livenessBound)]);
const staleOwner = () => run(parkedTok(), [ownerRestoreA, admitKeepNow(), captureK, swapK(1), prepK, clearJob, ...ticks(CHECKER.livenessBound)]);
// Ruling 1 accept: the owner restores AFTER the Keep claim; the prep drops the in-flight Keep and the carry keeps k1's protection.
acc("quiescenceReachable", "owner-restore-ends-keep-carried", ["A7-H1", "ruling-1"], ownerAfter());
acc("keptKeysProtected", "owner-restore-ends-keep-carried:kkp", ["A7-H1", "ruling-1"], ownerAfter());
acc("nothingAutomaticUnparks", "owner-restore-ends-keep-carried:nau", ["A7-H1", "ruling-1"], ownerAfter());
acc("environmentWellFormed", "owner-restore-request-recorded", ["A7-H1"], ownerAfter());
// r3.2-escape: A7-H1. Astra's scenario: admit Keep, an AUTOMATIC swap/prep discards it, 6 fair ticks. MUTANT any-restore-ends-keep.
rej("quiescenceReachable", "auto-restore-drops-admitted-keep", ["A7-H1", "ruling-1"], autoOnly()); esc32("A7-H1");
// r3.2-escape: A7-H1. The same trace at the swap step: r3.2 exempted swap/prep from the keep_pending ban. MUTANT swap-prep-exempt-from-keep-ban.
rej("nothingAutomaticUnparks", "auto-swap-drops-admitted-keep", ["A7-H1"], autoOnly()); esc32("A7-H1");
// r3.2-escape: A7-H1. A STALE owner restore (requested before the Keep claim) swaps in after it. MUTANT owner-restore-unordered.
rej("quiescenceReachable", "stale-owner-restore-drops-keep", ["A7-H1", "ruling-1"], staleOwner()); esc32("A7-H1");
// r3.2-escape: A7-H1. The same at the swap step.
rej("nothingAutomaticUnparks", "stale-owner-restore-swap-drops-keep", ["A7-H1"], staleOwner()); esc32("A7-H1");
// A7-H1: the exemption cannot be forged: a swap record naming an owner request that was never made.
// r3.2-escape: A7-H1 (new record field; r3.2 had no check).
rej("environmentWellFormed", "restore-names-no-owner-request", ["A7-H1"], run(parkedTok(), [admitKeepNow(), captureK, swapK(1)])); esc32("A7-H1");

// ---------- A7-M2: a restore step keeps the older-Keep rule for every key the carry does not hold --------------------------------------

const k9Start = (withCarry: boolean) => from(w => {
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: -4, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k9"] } }));
  w.ghost.authorities.push(au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: -2, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k9"] } }));
  sysJob(w, "A", "desktop", "armed"); // r3.4b (N1): the system job js whose capture made the carry
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: 0, atMs: NOW, epochAfter: 1, source: "desktop", archiveId: "A", blind: !withCarry, carryId: withCarry ? "c1" : null, ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keptKeys.k9 = "aKn"; if (withCarry) w.carry = carry({ keptKeys: { k9: "aKo" } });
  w.local.swappedJobId = "js"; if (withCarry) w.fs.restoreJob!.phase = "captured";
});
const prepK9: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null; w.local.keptKeys.k9 = "aKo"; w.ghost.keptHighWater.k9 = "aKn"; }];
// r3.2-escape: A7-M2. Blind restore, no carry: the prep downgrades kept k9 from the newer aKn to the older aKo.
rej("keptKeysProtected", "blind-prep-downgrades-kept-key", ["A7-M2"], run(k9Start(false), [prepK9])); esc32("A7-M2");
// A7-M2 accept: the carry holds k9 (under aKo) and the prep restores exactly the carried protection.
acc("keptKeysProtected", "carried-prep-keeps-carried-kept-key", ["A7-M2"], run(k9Start(true), [prepK9]));

// ---------- A8-M1 (r3.3a): a restore step drops only carried kept keys; kept-key authority is monotonic (ghost.keptHighWater) ----------

const prepDropK9: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); w.local.preparedJobId = "js"; w.carry = null;
  delete w.local.keptKeys.k9; w.ghost.keptHighWater.k9 = "aKn"; }];
const reKeep = (id: string): StepSpec => [tick, w => { w.local.keptKeys.k9 = id; }];
// r3.3-escape: A8-M1. Astra's two steps: a blind prep drops uncarried k9 (no revoke, no later Remove), then a tick re-keeps it under OLDER aKo.
rej("keptKeysProtected", "blind-prep-deletes-then-older-reinsert", ["A8-M1"], run(k9Start(false), [prepDropK9, reKeep("aKo")]));
// r3.3-escape: A8-M1. The drop alone (the protection is gone; an older Remove could now revoke k9). MUTANT prep-delete-exempt-uncarried.
rej("keptKeysProtected", "blind-prep-drops-uncarried-kept-key", ["A8-M1"], run(k9Start(false), [prepDropK9]));
// r3.3-escape: A8-M1. The entry left LEGITIMATELY (later Remove revoked k9); a tick re-keeps k9 under a Keep older than its high-water aK9.
// MUTANT reinsert-skips-high-water.
rej("keptKeysProtected", "reinsert-older-after-legit-absence", ["A8-M1"], run(from(w => { Object.assign(w, keptK9(3));
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: 0, scope: { target: "op:op9", inboxId: null, keyIds: ["k9"] } })); }),
  [[revokeK9], [{ t: "net.answer", requestId: "v9", result: "ok", fluxStateSeen: null }, w => { w.flux.keys.k9.state = "revoked"; delete w.local.keptKeys.k9;
    w.ghost.keptHighWater.k9 = "aK9"; }], reKeep("aKo")]));
// A8-M1 accept: a non-blind swap drops k9 (the archive lacks it) while the carry holds its newer aKn; the prep restores aKn.
acc("keptKeysProtected", "covered-delete-then-carry-newer-authority", ["A8-M1"], run(keptSwapStart("aKn"), [[swapA, w => { delete w.local.keptKeys.k9;
  w.ghost.keptHighWater.k9 = "aKn"; w.ghost.epoch = 1;
  w.ghost.restores.push({ atStep: w.step, atMs: NOW, epochAfter: 1, source: "cloud_reset", archiveId: "A", blind: false, carryId: "c1", ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null }); pendingPrep(w, true); w.proc.phase = "boot_prep"; }],
  [prep, w => { w.local.keptKeys.k9 = "aKn"; w.ghost.preparedEpochs.push(1); pendingPrep(w, false); w.proc.phase = "running"; w.carry = null; }]]));

// ---------- A7-M3: livelock judged after the last delay; the window is derived (LIVELOCK_WINDOW_MS = MAX_BLIP_MS) -------------------

const pollBy = (id: string, gap = 0): StepSpec[] => {
  const at = (w: World) => w.flux.requests.find(r => r.requestId === id)!;
  const out: StepSpec[] = [[tick, w => { w.flux.requests.push(rq({ requestId: id, kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: w.step, sentAtMs: w.nowMs })); }],
    [apply(id), w => { Object.assign(at(w), { flux: "applied", appliedAtMs: w.nowMs }); }],
    [{ t: "net.answer", requestId: id, result: "ok", fluxStateSeen: "active" }, w => { Object.assign(at(w), { answer: "delivered", answerSeen: { atStep: w.step, result: "ok", fluxStateSeen: "active" } }); }]];
  if (gap) out.push([clk(gap)]);
  return out;
};
const lastPoll: StepSpec = [tick, w => { w.flux.requests.push(rq({ requestId: "pz", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: w.step, sentAtMs: w.nowMs })); }];
// r3.2-escape: A7-M3. Drained tick; one request HELD past PROMPT_STEPS, then resolved; then the endless prompt poll, never drained.
rej("quiescenceReachable", "recovered-delay-then-livelock", ["A7-M3", "A5-M9"], run(base(), [[tick],
  [tick, w => { w.flux.requests.push(rq({ requestId: "h0", kind: "GET_INBOX", target: "i1", purpose: "poll", sentAtStep: w.step, sentAtMs: w.nowMs })); }], ...ticks(4),
  [apply("h0"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); }],
  [{ t: "net.answer", requestId: "h0", result: "ok", fluxStateSeen: "active" }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: w.step, result: "ok", fluxStateSeen: "active" } }); }],
  ...Array.from({ length: livelockRounds }, (_, n) => pollBy("q" + n)).flat(), lastPoll])); esc32("A7-M3");
// A7-M3 edge: prompt polling every GUARD_POLL_MS, never drained, for EXACTLY LIVELOCK_WINDOW_MS (120 s): not yet a livelock.
const edgePolls = (): StepSpec[] => [[tick], ...pollBy("e0", 60_000), ...pollBy("e1", 60_000), ...pollBy("e2")];
acc("quiescenceReachable", "livelock-window-edge-allowed", ["A7-M3"], run(base(), [...edgePolls(), lastPoll]));
// r3.2-escape: A7-M3. One tick (1 ms) past the window: livelock.
rej("quiescenceReachable", "livelock-window-one-past", ["A7-M3"], run(base(), [...edgePolls(), [clk(1)], lastPoll])); esc32("A7-M3");

// ---------- FA-L2: a botless (other-setup) removal in flight at restore is parked -------------------------------------------------

const otherSetupArchive = () => from(w => {
  w.ghost.tokens.push(tk({ tokenId: "tF", kind: "f", botId: null, gen: null, issuedAtStep: -5, shown: { target: "inbox:i9", address: "other@mail.test", inboxId: "i9", keyIds: [] } }));
  w.ghost.authorities.push(au({ authorityId: "aO", kind: "remove_other_setup", tokenId: "tF", botId: null, verifiedAtStep: -3, genAtVerify: null, scope: { target: "inbox:i9", inboxId: "i9", keyIds: [] } }));
  w.local.leases.LO = ls({ removalId: "LO", target: "inbox:i9", inboxId: "i9", botId: null, authorityId: "aO", phase: "sending", attemptId: "at9", attempts: ["at9"] });
});
const pk9 = (state: Park["state"]) => pk({ parkId: "pk9", botId: null, target: "inbox:i9", inboxId: "i9", provisionOpId: null, state, address: "other@mail.test",
  gen: { inboxId: "i9", opId: null, emailKeyRef: null, serial: 0 }, keyTargets: [] });
// r3.2-escape: FA-L2. The prep keeps the restored other-setup removal RUNNING (remove_authorized) instead of parking it.
rej("restorePrepParksEverything", "restored-other-setup-removal-unparked", ["FA-L2", "standing-order"], run(otherSetupArchive(), [[prep, w => {
  w.local.leases = {}; w.local.parks.pk9 = pk9("remove_authorized"); }]])); esc32("FA-L2");
acc("restorePrepParksEverything", "restored-other-setup-removal-parked", ["FA-L2"], run(otherSetupArchive(), [[prep, w => {
  w.local.leases = {}; w.local.parks.pk9 = pk9("parked"); }]]));

// ---------- FA-L7: a bot-row Keep may carry a fresh token ---------------------------------------------------------------------------

const botKeepView = (shown: string): StepSpec => [{ t: "owner.viewSurface", principal: OWN }, w => {
  w.surface = [row({ section: "bot", actions: [{ kind: "remove", tokenId: "tB", enabled: true }, { kind: "keep", tokenId: "tK", enabled: true }] })];
  w.ghost.tokens.push(tk({ issuedAtStep: 1 }), tk({ tokenId: "tK", issuedAtStep: 1, shown: { target: shown, address: ADDR, inboxId: "i1", keyIds: ["k1"] } })); }];
// r3.2-overstrict: FA-L7. r3.2 failed the bot-row Keep's fresh token as "minted for no visible enabled action".
acc("viewMintsScopedTokens", "bot-keep-carries-fresh-token", ["FA-L7", "R2-Q5"], run(base(), [botKeepView(T_I1)])); over32("FA-L7");
// FA-L7 contrast: a carried bot-row Keep token is judged like any other (shows another target).
rej("viewMintsScopedTokens", "bot-keep-token-shows-another-target", ["FA-L7"], run(base(), [botKeepView("inbox:i2")]));

// ---------- r3.3b: a stale UNTOKENED bot-row Keep may be refused confirm_expired, purely, with a look-again line ----------------

const T_B1 = "bot:b1"; // the builder's trace: b1 active on inbox i1; the owner's stale screen Keeps the bot-level target
const lookAgain: Mut = w => { w.surface = [row({ section: "bot", line: LOOK_AGAIN_LINE, actions: [{ kind: "keep", tokenId: null, enabled: true }] })]; };
const staleKeep = keepA({ target: T_B1, mode: "bot_section", outcome: no("confirm_expired") });
// r3.3a-overstrict: the stale untokened Keep had no legal outcome (admit fails F5-L5, refuse had no code). MUTANT untokened-stale-not-refusable.
acc("admissionPinned", "keep-stale-binding-refused-confirm-expired", ["r3.3b-ruling"], run(base(), [[staleKeep, lookAgain]]));
// Contrast: the target IS b1's current live binding (inbox:i1), no token is needed: confirm_expired has no precondition.
rej("admissionPinned", "keep-current-binding-refused-confirm-expired", ["r3.3b-ruling"], run(base(), [[keepA({ mode: "bot_section", outcome: no("confirm_expired") }), lookAgain]]));
// (a) The stale refusal opens a Keep op (a Keep obligation) while refusing.
rej("admissionPinned", "keep-stale-refusal-mutates-state", ["r3.3b-ruling"], run(base(), [[staleKeep, w => { lookAgain(w);
  w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_B1, inboxId: "i1", mode: "bot_section", authorityId: "aK", claimedAtStep: w.step }; }]]));
// (b) The stale refusal shows the owner nothing (no look-again line).
rej("admissionPinned", "keep-stale-refusal-silent", ["r3.3b-ruling"], run(base(), [[staleKeep]]));
// r3.3b-escape: Astra r3.3b Low. The look-again line is shown, but on a parked row, not the bot's own row. MUTANT look-again-any-section.
rej("admissionPinned", "keep-stale-look-again-not-bot-row", ["r3.3c"], run(base(), [[staleKeep, w => {
  w.surface = [row({ section: "parked", line: LOOK_AGAIN_LINE, actions: [{ kind: "keep", tokenId: null, enabled: true }] })]; }]]));
// r3.3a-overstrict: (c) after the look-again, the owner Keeps the current binding untokened; admitted with authority, op and record.
acc("admissionPinned", "keep-retry-on-current-binding-admitted", ["r3.3b-ruling", "R2-Q5"], run(base(), [[staleKeep, lookAgain],
  [keepA({ mode: "bot_section" }), w => {
    w.ghost.authorities.push(au({ authorityId: "aK", kind: "keep", tokenId: null, verifiedAtStep: w.step, genAtVerify: null, scope: { target: T_I1, inboxId: "i1", keyIds: ["k1"] } }));
    w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "bot_section", authorityId: "aK", claimedAtStep: w.step };
    w.ghost.keeps.push(kr({ mode: "bot_section", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp1"); }]]));

// ---------- r3.3b (Astra r3.3a Low): the ghost high-water itself is never deleted or lowered --------------------------------------

// r3.3a-escape: live k9 and ghost k9 both name aKn; a tick moves the ghost entry to the older aKo (the max with live hid it). MUTANT ghost-high-water-unguarded.
rej("keptKeysProtected", "ghost-high-water-lowered-while-live-holds", ["r3.3a-Low"], run(from(w => { Object.assign(w, k9Start(false)); w.ghost.keptHighWater.k9 = "aKn"; }),
  [[tick, w => { w.ghost.keptHighWater.k9 = "aKo"; }]]));
// r3.3a-escape: the same, deleting the ghost entry. MUTANT ghost-high-water-unguarded.
rej("keptKeysProtected", "ghost-high-water-deleted-while-live-holds", ["r3.3a-Low"], run(from(w => { Object.assign(w, k9Start(false)); w.ghost.keptHighWater.k9 = "aKn"; }),
  [[tick, w => { delete w.ghost.keptHighWater.k9; }]]));

// ---------- r3.3d (reducer-builder gap, R3-Q4): a token killed by an ok deleteBot may be refused confirm_expired ----------------

// Step 1: the owner views b1's row (mints b token tB and Keep token tK); step 2: ok deleteBot b1 (tD, own authority aD, lease LD);
// steps 3-5: the delete's work claims and sends DELETE i1, a tick; step 6: the owner acts on the stale row with a token R3-Q4 killed.
const delKilled = (last: StepSpec, start: World = delStart()): TraceStep[] => run(start, [botKeepView(T_I1), deleteB1Work,
  [tick, w => { Object.assign(w.local.leases.LD, { phase: "sending", attemptId: "at1", attempts: ["at1"] }); }],
  [send(dD({ sentAtStep: 4 })), w => { w.flux.requests.push(dD({ sentAtStep: 4 })); }], [tick], last]);
// r3.3c-overstrict: the Remove with the delete-killed token had no legal outcome (ok breaks deletedBotAuthorityDead, confirm_expired had
// no precondition). MUTANT token-ignores-bot-delete.
acc("admissionPinned", "remove-with-delete-killed-token-refused-confirm-expired", ["r3.3d", "R3-Q4"], delKilled([removeA("tB", { outcome: no("confirm_expired") })]));
// Guard: admitting that Remove (new authority under tB, new lease) uses an authority of the deleted bot.
rej("deletedBotAuthorityDead", "remove-with-delete-killed-token-admitted", ["r3.3d", "R3-Q4"], delKilled([removeA("tB"), w => {
  w.ghost.authorities.push(au({ authorityId: "aR9", verifiedAtStep: w.step }));
  w.local.leases.L9 = ls({ removalId: "L9", authorityId: "aR9" }); }]));
// r3.3c-overstrict: the same for the row's tokened Keep (tK). MUTANT token-ignores-bot-delete.
acc("admissionPinned", "keep-with-delete-killed-token-refused-confirm-expired", ["r3.3d", "R3-Q4"], delKilled([keepA({ tokenId: "tK", outcome: no("confirm_expired") })]));
// r3.3d-overstrict (Astra r3.3d Medium): the same start plus b1's old inbox i2 parked (pk2) and its park token tP2 (botId null: it speaks
// for b1 through its park). The owner's Remove on the parked row with tP2 had no legal outcome (ok breaks deletedBotAuthorityDead, which
// resolves the park's bot; confirm_expired had no precondition, tokenProblem read t.botId only). MUTANT token-bot-ignores-park.
acc("admissionPinned", "park-remove-with-delete-killed-ptoken-refused-confirm-expired", ["r3.3e", "R3-Q4"], delKilled([removeA("tP2", { target: "inbox:i2", section: "parked", outcome: no("confirm_expired") })],
  from(w => {
    w.local.parks.pk2 = pk({ parkId: "pk2", target: "inbox:i2", inboxId: "i2", provisionOpId: "op2", keyTargets: [], address: "old@mail.test", gen: { inboxId: "i2", opId: "op2", emailKeyRef: null, serial: 0 } });
    w.ghost.tokens.push(tk({ tokenId: "tD" }), parkTok({ tokenId: "tP2", botId: null, park: { parkId: "pk2", parkRev: 0 }, shown: { target: "inbox:i2", address: "old@mail.test", inboxId: "i2", keyIds: [] } })); })));

// ---------- r3.3f (ruling b, reducer-builder case): the blind / no-live-DB swap window; the prep clamps to the high-water -------------

// k9 was kept under older aKo (in the archive) and later under newer aKn (the live database, now lost); ghost.keptHighWater.k9 = aKn.
const noLiveStart = () => from(w => {
  const sc = { target: T_I1, inboxId: "i1", keyIds: ["k9"] };
  w.ghost.authorities.push(au({ authorityId: "aKo", kind: "keep", tokenId: null, verifiedAtStep: -4, genAtVerify: null, scope: sc }), au({ authorityId: "aKn", kind: "keep", tokenId: null, verifiedAtStep: -2, genAtVerify: null, scope: sc }));
  w.ghost.keptHighWater.k9 = "aKn";
  w.fs.messagesDbPresent = false; // r3.3i (F): no outgoing database (new machine / lost disk), so the swap is blind
});
const ownerRestoreNoLive: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "A" }, w => {
  w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "A" }); arm(w, "A"); }]; // r3.4: the job first (W25)
/** The blind swap renames archive A (k9 under older aKo) into place; `closed` = the store is closed until the prep (boot_prep). */
const swapNoLive = (closed: boolean): StepSpec => [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => {
  w.ghost.epoch = 1; w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: w.step - 1, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keptKeys = { k9: "aKo" }; w.fs.messagesDbPresent = true; phase(w, "swapped"); if (closed) w.proc.phase = "boot_prep"; }];
// r3.3e-overstrict (reducer-builder case): crash between the swap and its prep; the boot prep clamps k9 to aKn before the store opens.
// r3.3e rejected the swap step itself (over-strict); this is the r3.3e comparison witness.
acc("keptKeysProtected", "nolive-swap-window-crash-boot-prep-clamps", ["r3.3f"], run(noLiveStart(), [ownerRestoreNoLive, swapNoLive(true),
  [{ t: "fault.crash", at: "W3_swap_record", when: "after" }, w => { w.proc.phase = "down"; }],
  [{ t: "auto.boot" }, w => { w.proc.phase = "boot_prep"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }],
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.keptKeys.k9 = "aKn"; w.proc.phase = "store_open"; }]]));
// r3.3f: the prep commits and opens the store with k9 still under the archive's older aKo. MUTANT prep-skips-high-water-clamp.
rej("keptKeysProtected", "nolive-prep-leaves-older-keep", ["r3.3f"], run(noLiveStart(), [ownerRestoreNoLive, swapNoLive(true),
  [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.proc.phase = "store_open"; }]]));
// r3.3f: the same swap with the store left OPEN gets no window. MUTANT swap-window-ignores-phase.
rej("keptKeysProtected", "nolive-swap-older-keep-store-open", ["r3.3f"], run(noLiveStart(), [ownerRestoreNoLive, swapNoLive(false)]));

// ---------- r3.3g (Astra r3.3f #1-#5): window isolation, fail-closed unconfirmed marks, explicit window obligation ----------------------

const k9Sc = { target: T_I1, inboxId: "i1", keyIds: ["k9"] };
const crashW3: StepSpec = [{ t: "fault.crash", at: "W3_swap_record", when: "after" }, w => { w.proc.phase = "down"; }];
const bootW: StepSpec = [{ t: "auto.boot" }, w => { w.proc.phase = "boot_prep"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }];
/** The window-ending restore prep keeps the archive's older aKo for uncarried k9 and marks it unconfirmed (design (i), reducer R2). */
const prepMarks: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.unconfirmedKept = { k9: w.step }; w.proc.phase = "store_open"; }];
const nolive = (extra: StepSpec[], start: World = noLiveStart()) => run(start, [ownerRestoreNoLive, swapNoLive(true), ...extra]);
const withRemoveAfterHw = () => from(w => { Object.assign(w, noLiveStart());
  w.ghost.authorities.push(au({ authorityId: "aRl", kind: "remove_bot_section", tokenId: null, verifiedAtStep: -1, genAtVerify: null, scope: k9Sc })); });
const withK9Revoked = () => from(w => { Object.assign(w, noLiveStart());
  w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "revoked" }; });
/** r3.3h: the home-level restore-finishing line every window refusal and every view while the prep is pending shows. */
const finishing: Mut = w => { w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FINISHING_LINE })]; };
/** r3.3i (G): the view while k9 is marked shows RECONFIRM_KEPT_LINE on a bot row naming k9 (LOOK_AGAIN_LINE is the binding-changed case only). */
const lookAgainView: StepSpec = [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "bot", keyIds: ["k9"], line: RECONFIRM_KEPT_LINE })]; }];

// #1 r3.3f-escape (High): a second owner restore inside the window captures the stale aKo into its carry; the carried prep then commits it
// exactly and the original clamp obligation vanishes. r3.3g serializes: no capture while the prep is pending. MUTANT window-allows-second-restore.
rej("keptKeysProtected", "nolive-second-restore-inside-window", ["r3.3g", "Astra-r3.3f-1"], nolive([
  [{ t: "owner.restore", source: "desktop", archiveId: "B" }, w => { w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "B" }); arm(w, "B"); }],
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 1, keyIds: ["k9"], inboxIds: [], provisionOps: [], keptKeys: { k9: "aKo" } }); phase(w, "captured"); }],
  [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: false }, w => { w.ghost.epoch = 2; phase(w, "swapped");
    w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 2, source: "desktop", archiveId: "B", blind: false, carryId: "c2", ownerRequestStep: w.step - 2, jobId: w.fs.restoreJob?.id ?? null }); w.local.keptKeys = {}; }],
  [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(2); phase(w, "prepared"); w.carry = null; w.local.keptKeys = { k9: "aKo" }; w.proc.phase = "store_open"; }]]));

// #2 r3.3f-overstrict (High, design (i)): the reducer cannot see aKn; the prep keeps aKo MARKED unconfirmed, every view shows the look-again
// line, and the owner's new Keep (after the mark) clears it. r3.3f demanded a clamp to the invisible aKn.
/** r3.3i: the same view, minting the b token of the owner's new Keep of k9 (kept on its bot row, showing exactly k9). */
const lookAgainViewTok: StepSpec = [lookAgainView[0], w => { lookAgainView[1]!(w);
  w.ghost.tokens.push(tk({ tokenId: "tK9", issuedAtStep: w.step, epoch: w.ghost.epoch, shown: { target: T_I1, address: ADDR, inboxId: "i1", keyIds: ["k9"] } }));
  w.surface[0].actions = [{ kind: "keep", tokenId: "tK9", enabled: true }]; }];
acc("keptKeysProtected", "nolive-prep-marks-unconfirmed-then-owner-decides", ["r3.3g", "Astra-r3.3f-2"], nolive([prepMarks, lookAgainViewTok,
  [keepA({ tokenId: "tK9" }), w => { w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", tokenId: "tK9", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, epoch: w.ghost.epoch, scope: k9Sc }));
    w.local.keepOps.kp1 = { keepOp: "kp1", botId: "b1", target: T_I1, inboxId: "i1", mode: "live", authorityId: "aK9", claimedAtStep: w.step };
    w.ghost.keeps.push(kr({ authorityId: "aK9", claimedAtStep: w.step })); w.ghost.usedKeepOps.push("kp1");
    w.local.keptKeys.k9 = "aK9"; w.local.unconfirmedKept = {}; }]]));
// #2: the mark cleared by a tick, no owner decision. MUTANT unconfirmed-mark-unguarded.
rej("keptKeysProtected", "nolive-unconfirmed-mark-cleared-by-tick", ["r3.3g", "Astra-r3.3f-2"], nolive([prepMarks, [tick, w => { w.local.unconfirmedKept = {}; }]]));
// #2: a Remove verified BEFORE the mark (here after aKn, invisible to the reducer) does not license revoking a marked key; fail closed.
// MUTANT unconfirmed-revoke-on-old-remove.
rej("keptKeysProtected", "nolive-unconfirmed-revoked-under-pre-restore-remove", ["r3.3g", "Astra-r3.3f-2"], nolive([prepMarks,
  [send(rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRl" }))]], withRemoveAfterHw()));
// #2: an owner view while k9 is marked shows no look-again line. MUTANT unconfirmed-look-again-skipped.
rej("keptKeysProtected", "nolive-unconfirmed-view-without-look-again", ["r3.3g", "Astra-r3.3f-2"], nolive([prepMarks,
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "kept", botId: null, keyIds: ["k9"] })]; }]]));
// #2: a later (serialized) restore whose carry drops the mark launders it away.
rej("keptKeysProtected", "unconfirmed-mark-lost-across-later-restore", ["r3.3g", "Astra-r3.3f-2"], nolive([prepMarks,
  [{ t: "owner.restore", source: "desktop", archiveId: "B" }, w => { w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "B" }); arm(w, "B"); }],
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 1, keyIds: ["k9"], inboxIds: [], provisionOps: [], keptKeys: { k9: "aKo" } }); phase(w, "captured"); }],
  [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: false }, w => { w.ghost.epoch = 2; phase(w, "swapped"); w.proc.phase = "boot_prep";
    w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 2, source: "desktop", archiveId: "B", blind: false, carryId: "c2", ownerRequestStep: w.step - 2, jobId: w.fs.restoreJob?.id ?? null }); delete w.local.unconfirmedKept; }]]));

// #3 r3.3f-escape (Medium): a poll send inside the window. MUTANT window-allows-send.
rej("keptKeysProtected", "nolive-window-poll-send", ["r3.3g", "Astra-r3.3f-3"], nolive([[send(rq({ requestId: "g1", kind: "GET_INBOX", target: T_I1 }))]]));
// #3: an owner Keep admitted inside the window (a new authority before the prep). MUTANT window-admits-owner.
rej("keptKeysProtected", "nolive-window-owner-keep-admitted", ["r3.3g", "Astra-r3.3f-3"], nolive([[keepA(), w => {
  w.ghost.authorities.push(au({ authorityId: "aK9", kind: "keep", tokenId: null, verifiedAtStep: w.step, genAtVerify: null, scope: k9Sc })); }]]));
// #3 accept: the same Keep refused confirm_expired, purely; the prep then marks.
acc("keptKeysProtected", "nolive-window-owner-keep-refused-then-prep-marks", ["r3.3g", "Astra-r3.3f-3"], nolive([[keepA({ outcome: no("restore_finishing") }), finishing], prepMarks])); // r3.4: restore_finishing (the only window code)
// #3 r3.3f-overstrict: that refusal is legal (admissionPinned): r3.3f had no precondition for it (the bot's current binding, no token).
// MUTANT window-refusal-not-legal.
// r3.4 (Astra r3.3i #4, Fable F2): VERDICT CHANGED accept -> reject: confirm_expired is no longer a legal window refusal.
rej("admissionPinned", "nolive-window-keep-refused-confirm-expired", ["r3.3g", "Astra-r3.3f-3"], nolive([[keepA({ outcome: no("confirm_expired") }), finishing]]));

// #4 r3.3f-overstrict (Medium): the accepted carried prep, then an ordinary crash, boot and boot prep that keeps its result (aKo live, aKn
// the high-water). No window is outstanding, so no clamp. MUTANT boot-clamp-unconditional.
acc("keptKeysProtected", "carried-prep-then-crash-boot-prep-ok", ["r3.3g", "Astra-r3.3f-4"], run(k9Start(true), [prepK9, crashW3, bootW,
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.proc.phase = "store_open"; }]]));

// #5 accepts: departed keys owe no clamp; the clamp never raises an authority. MUTANT clamp-checks-departed-keys (first two).
// r3.4 (Astra r3.3i #5): back on the ORIGINAL action, the restore prep; restorePrepParksEverything lets a departed key leave (ruling).
const prepDropsK9: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); delete w.local.keptKeys.k9; w.proc.phase = "store_open"; }];
acc("keptKeysProtected", "nolive-revoked-key-leaves-before-clamp", ["r3.3g", "Astra-r3.3f-5", "Astra-r3.3i-5"], nolive([prepDropsK9], withK9Revoked()));
acc("keptKeysProtected", "nolive-later-remove-leaves-before-clamp", ["r3.3g", "Astra-r3.3f-5", "Astra-r3.3i-5"], nolive([prepDropsK9], withRemoveAfterHw()));
// r3.4: the same departures judged by restorePrepParksEverything; a LIVE key with no later Remove may not depart. MUTANT prep-departed-key-must-stay.
acc("restorePrepParksEverything", "prep-departed-revoked-key-not-lost", ["r3.4", "Astra-r3.3i-5"], nolive([prepDropsK9], withK9Revoked()));
acc("restorePrepParksEverything", "prep-departed-removed-key-not-lost", ["r3.4", "Astra-r3.3i-5"], nolive([prepDropsK9], withRemoveAfterHw()));
rej("restorePrepParksEverything", "prep-live-unremoved-key-lost", ["r3.4", "Astra-r3.3i-5"], nolive([prepDropsK9]));
const prepClamps: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.keptKeys.k9 = "aKn"; w.proc.phase = "store_open"; }];
acc("keptKeysProtected", "nolive-revoked-key-clamped-not-raised", ["r3.3g", "Astra-r3.3f-5"], nolive([prepClamps, [tick, w => { delete w.local.keptKeys.k9; }]], withK9Revoked()));
// r3.4a: back on a REAL REVOKE_KEY send, rebuilt as a post-restore trace. The old revoke was barred by ownerAuthorityForEveryDestructiveSend
// (the Remove was verified in epoch 0, before the restore; a Remove authority dies at a later restore epoch) and by the blind fence. Now,
// after the prep clamped k9 to aKn (never raised), the owner views (a key-only row with Keep and Remove, and the restore-check row), Removes
// k9 (epoch 1, verified after the restore and after the clamp), confirms the inventory (lifts the blind fence), the lease claims sending,
// the revoke leaves under that fresh Remove, Flux applies it, the answer lands, and the work retires with the entry gone.
const clampRevokeStart = () => from(w => { Object.assign(w, noLiveStart());
  w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "live" };
  // the owner viewed before the restore: a visible key-only row for k9 with enabled Keep and Remove and the token it minted (epoch 0)
  w.ghost.tokens.push(tk({ tokenId: "tP9", issuedAtStep: 0, shown: { target: T_I1, address: ADDR, inboxId: null, keyIds: ["k9"] } }));
  w.surface = [row({ section: "key_only", inboxId: null, keyIds: ["k9"], actions: [{ kind: "keep", tokenId: "tP9", enabled: true }, { kind: "remove", tokenId: "tP9", enabled: true }] })]; });
const clampView: StepSpec = [{ t: "owner.viewSurface", principal: OWN }, w => {
  w.ghost.tokens.push(tk({ tokenId: "tR9", issuedAtStep: w.step, issuedAtMs: w.nowMs, epoch: w.ghost.epoch, shown: { target: T_I1, address: ADDR, inboxId: null, keyIds: ["k9"] } }), { ...rTok(), issuedAtStep: w.step, issuedAtMs: w.nowMs, processId: w.proc.processId });
  w.surface = [row({ section: "key_only", inboxId: null, keyIds: ["k9"], actions: [{ kind: "keep", tokenId: "tR9", enabled: true }, { kind: "remove", tokenId: "tR9", enabled: true }] }), rcRow()]; }];
const clampRemove: StepSpec = [removeA("tR9", { section: "key_only" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aRp", kind: "remove_bot_section", tokenId: "tR9", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, epoch: w.ghost.epoch, scope: { target: T_I1, inboxId: null, keyIds: ["k9"] } }));
  w.local.leases.L9 = ls({ removalId: "L9", inboxId: null, authorityId: "aRp", keyTargets: [{ keyId: "k9", status: "pending" }] }); }];
const clampConfirm: StepSpec = [{ t: "owner.confirmInventory", principal: OWN, tokenId: "tr", outcome: okO }, w => {
  w.ghost.authorities.push(au({ authorityId: "aC", kind: "confirm_inventory", tokenId: "tr", epoch: w.ghost.epoch, botId: null, verifiedAtStep: w.step, verifiedAtMs: w.nowMs, verifiedInProcess: w.proc.processId, scope: { target: null, inboxId: null, keyIds: [] }, genAtVerify: null }));
  w.ghost.inventoryConfirmedEpochs.push(w.ghost.epoch); w.surface = [pendingRow({ section: "key_only", inboxId: null, keyIds: ["k9"] })]; }];
const vClamp = rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aRp", removalId: "L9", attemptId: "a9", sentAtStep: 8 });
acc("keptKeysProtected", "nolive-later-remove-clamped-not-raised-revoke", ["r3.3g", "Astra-r3.3f-5", "r3.4a"], nolive([prepClamps, clampView, clampRemove, clampConfirm,
  [tick, w => { Object.assign(w.local.leases.L9, { phase: "sending", attemptId: "a9", attempts: ["a9"] }); }],
  [send(vClamp), w => { w.flux.requests.push(vClamp); }],
  [apply("v9"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); w.flux.keys.k9.state = "revoked"; }],
  [{ t: "net.answer", requestId: "v9", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: w.step, result: "ok", fluxStateSeen: null } }); }],
  [tick, w => { w.local.leases = {}; delete w.local.keptKeys.k9; }]], clampRevokeStart()));

// ---------- r3.3h (Astra r3.3g #1-#6): both preps consume the carry, immutable marks, Remove after an older Keep, no queue, one refusal rule

const restoreB: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "B" }, w => { w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "B" }); arm(w, "B"); }];
/** After prepMarks (k9 marked at step 3): a correct carry of k9 -> aKo WITH its mark, a non-blind swap into archive B (aKo, no mark), crash. */
const carriedMarkSwapCrash = (): StepSpec[] => [prepMarks, clearJob, restoreB,
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 1, keyIds: ["k1", "k9"], keptKeys: { k9: "aKo" }, unconfirmedKept: { k9: 3 }, blindPending: true }); phase(w, "captured"); /* r3.3i (F): covers the outgoing database and its blind fence */ }],
  [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: false }, w => { w.ghost.epoch = 2; phase(w, "swapped"); w.proc.phase = "boot_prep"; // r3.3i (F): forEpoch is the outgoing epoch
    w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 2, source: "desktop", archiveId: "B", blind: false, carryId: "c2", ownerRequestStep: w.step - 2, jobId: w.fs.restoreJob?.id ?? null });
    w.local.keptKeys = { k9: "aKo" }; delete w.local.unconfirmedKept; }],
  crashW3, bootW];
// #1 r3.3g-escape (High): the boot prep after the crash keeps aKo but drops the carried mark. MUTANT carried-checks-restore-prep-only.
rej("keptKeysProtected", "carried-mark-lost-across-boot-prep", ["r3.3h", "Astra-r3.3g-1"], nolive([...carriedMarkSwapCrash(),
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(2); phase(w, "prepared"); w.carry = null; w.proc.phase = "store_open"; }]])); // r3.3g-escape
// #1 accept: the boot prep restores the carried mark with its carried value.
acc("keptKeysProtected", "carried-mark-kept-across-boot-prep", ["r3.3h", "Astra-r3.3g-1"], nolive([...carriedMarkSwapCrash(),
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(2); phase(w, "prepared"); w.carry = null; w.local.unconfirmedKept = { k9: 3 }; w.proc.phase = "store_open"; }]]));

// #2 r3.3g-escape (High): a tick moves the mark back to -5 (before aKo's -4), a second tick clears it as if aKo were a fresh Keep.
// MUTANT unconfirmed-mark-value-mutable.
rej("keptKeysProtected", "nolive-unconfirmed-mark-rewritten-by-tick", ["r3.3h", "Astra-r3.3g-2"], nolive([prepMarks,
  [tick, w => { w.local.unconfirmedKept = { k9: -5 }; }], [tick, w => { w.local.unconfirmedKept = {}; }]])); // r3.3g-escape
// #2 r3.3g-escape: a future-dated mark (it would block legitimate later Keep / Remove decisions). MUTANT unconfirmed-mark-stamp-unchecked.
rej("keptKeysProtected", "nolive-unconfirmed-mark-future-dated", ["r3.3h", "Astra-r3.3g-2"], nolive([[{ t: "auto.restorePrepare", outcome: "committed" }, w => {
  w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.unconfirmedKept = { k9: w.step + 5 }; w.proc.phase = "store_open"; }]])); // r3.3g-escape

// #3 (High): k9 kept under old aKo and marked; the owner Removes it AFTER the mark; the work retires with k9 live, unused and still kept.
const markedK9 = () => from(w => { Object.assign(w, noLiveStart()); w.fs.messagesDbPresent = true;
  w.local.keptKeys = { k9: "aKo" }; w.local.unconfirmedKept = { k9: -1 };
  w.flux.keys.k9 = { keyId: "k9", installOwned: true, mintedUnderOp: "op1", forBot: "b1", state: "live" };
  // r3.3i: the owner viewed before the trace: a visible key-only row for orphan k9 with enabled Keep and Remove, and the token it minted.
  w.ghost.tokens.push(tk({ tokenId: "tR9", issuedAtStep: 0, shown: { target: T_I1, address: ADDR, inboxId: null, keyIds: ["k9"] } }));
  w.surface = [row({ section: "key_only", inboxId: null, keyIds: ["k9"], actions: [{ kind: "keep", tokenId: "tR9", enabled: true }, { kind: "remove", tokenId: "tR9", enabled: true }] })]; });
const removeK9: StepSpec = [removeA("tR9", { section: "key_only" }), w => {
  w.ghost.authorities.push(au({ authorityId: "aR9", kind: "remove_bot_section", tokenId: "tR9", verifiedAtStep: w.step, verifiedAtMs: w.nowMs, scope: { target: T_I1, inboxId: null, keyIds: ["k9"] } }));
  w.local.leases.L9 = ls({ removalId: "L9", inboxId: null, authorityId: "aR9", keyTargets: [{ keyId: "k9", status: "pending" }] }); }];
// r3.3g-escape: removalDone counted the old kept entry as done. MUTANT removal-done-counts-older-keep.
rej("quiescenceReachable", "fresh-remove-of-marked-key-not-revoked", ["r3.3h", "Astra-r3.3g-3"], run(markedK9(), [removeK9,
  [tick, w => { w.local.leases = {}; }], ...ticks(CHECKER.livenessBound)])); // r3.3g-escape
// #3 accept: the same Remove completes with the revoke; the entry and the mark leave with it.
const v9 = rq({ requestId: "v9", kind: "REVOKE_KEY", target: "k9", authorityId: "aR9", removalId: "L9", attemptId: "a9", sentAtStep: 3 });
acc("quiescenceReachable", "fresh-remove-of-marked-key-revoked", ["r3.3h", "Astra-r3.3g-3"], run(markedK9(), [removeK9,
  [tick, w => { Object.assign(w.local.leases.L9, { phase: "sending", attemptId: "a9", attempts: ["a9"] }); }],
  [send(v9), w => { w.flux.requests.push(v9); }],
  [apply("v9"), w => { Object.assign(w.flux.requests[0], { flux: "applied", appliedAtMs: w.nowMs }); w.flux.keys.k9.state = "revoked"; }],
  [{ t: "net.answer", requestId: "v9", result: "ok", fluxStateSeen: null }, w => { Object.assign(w.flux.requests[0], { answer: "delivered", answerSeen: { atStep: 5, result: "ok", fluxStateSeen: null } }); }],
  [tick, w => { w.local.leases = {}; delete w.local.keptKeys.k9; w.local.unconfirmedKept = {}; }], ...ticks(CHECKER.livenessBound - 4)]));

// #4 r3.3g-escape (Medium): an owner.restore ADMITTED inside the window (r3.3g: "recorded and served later", with no durable queue).
// MUTANT window-admits-restore.
rej("keptKeysProtected", "nolive-window-restore-admitted", ["r3.3h", "Astra-r3.3g-4"], nolive([restoreB])); // r3.3g-escape
// #4: a refused restore records nothing and captures nothing. MUTANT window-allows-second-restore (re-aimed).
const restoreRefused: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "B", outcome: no("restore_finishing") }, finishing];
rej("keptKeysProtected", "nolive-window-capture-after-refused-restore", ["r3.3h", "Astra-r3.3g-4"], nolive([restoreRefused,
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 2, keyIds: ["k9"], inboxIds: [], provisionOps: [], keptKeys: { k9: "aKo" } }); phase(w, "captured"); }]]));
// #4 accept: refused inside the window, the owner asks again once the prep committed and that restore is admitted.
acc("keptKeysProtected", "nolive-window-restore-refused-then-served", ["r3.3h", "Astra-r3.3g-4"], nolive([restoreRefused, prepMarks, lookAgainView, clearJob, restoreB]));

// #5 accepts (Medium): one window-refusal rule, every refused kind legal (admissionPinned). MUTANT window-refusal-not-legal.
const leaseStart = () => from(w => { Object.assign(w, noLiveStart()); w.local.leases.L1 = ls(); });
const tryRefused: StepSpec = [{ t: "owner.tryAgainNow", principal: OWN, botId: "b1", target: T_I1, outcome: no("restore_finishing") }, finishing];
acc("admissionPinned", "nolive-window-try-again-refused", ["r3.3h", "Astra-r3.3g-5"], nolive([tryRefused], leaseStart())); // r3.3g-overstrict
acc("admissionPinned", "nolive-window-remove-refused", ["r3.3h", "Astra-r3.3g-5"], nolive([[removeA("tB", { outcome: no("restore_finishing") }), finishing]]));
acc("admissionPinned", "nolive-window-restore-refused", ["r3.3h", "Astra-r3.3g-5"], nolive([restoreRefused]));
// #5 R1: an ordinary boot (no pending prep) is NOT a window; a restore_finishing refusal there has no precondition. MUTANT window-refusal-by-phase.
rej("admissionPinned", "ordinary-boot-refusal-not-window", ["r3.3h", "Astra-r3.3g-5"], run(from(w => { w.proc.phase = "boot_prep"; }), [[keepA({ outcome: no("restore_finishing") }), finishing]]));

// #6 r3.3g-escape (Medium): the refusal clears a saved key. MUTANT window-purity-omits-savedkeys.
rej("keptKeysProtected", "nolive-window-keep-refused-clears-savedkeys", ["r3.3h", "Astra-r3.3g-6"], nolive([[keepA({ outcome: no("confirm_expired") }), w => { finishing(w); w.local.savedKeys.b1 = null; }]])); // r3.3g-escape
// #6 r3.3g-escape: the refusal explains nothing. MUTANT window-refusal-no-line.
rej("keptKeysProtected", "nolive-window-refusal-without-line", ["r3.3h", "Astra-r3.3g-6"], nolive([[keepA({ outcome: no("confirm_expired") })]])); // r3.3g-escape
// #6 r3.3g-escape: after a crash (prep still pending) the owner's view no longer says why. MUTANT window-view-skips-line.
const refusedCrashBoot: StepSpec[] = [[keepA({ outcome: no("restore_finishing") }), finishing], crashW3, bootW];
rej("keptKeysProtected", "nolive-window-refusal-crash-view-without-line", ["r3.3h", "Astra-r3.3g-6"], nolive([...refusedCrashBoot,
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "bot", line: "Choose Keep address or Remove." })]; }]])); // r3.3g-escape
acc("keptKeysProtected", "nolive-window-refusal-crash-view-shows-line", ["r3.3h", "Astra-r3.3g-6"], nolive([...refusedCrashBoot,
  [{ t: "owner.viewSurface", principal: OWN }, finishing]]));


// ---------- r3.3i (independent Opus design check of r3.3h, A-F; Sol copy check G) ------------------------------------------------------

const swapMarked = (v: number): StepSpec => [swapNoLive(true)[0], w => { swapNoLive(true)[1]!(w); w.local.unconfirmedKept = { k9: v }; }];
const prepKeeps = (m: Mut = () => {}): StepSpec => [{ t: "auto.restorePrepare", outcome: "committed" }, w => {
  w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.proc.phase = "store_open"; m(w); }];
// A r3.3h-escape (Partial #2): the blind swap brings k9 (aKo, -4) with an archive mark at -5; the prep keeps -5 and a tick clears it as a
// "fresh Keep" (aKo is after -5). r3.3i: the window-ending prep re-stamps. MUTANT prep-keeps-swap-mark.
rej("keptKeysProtected", "nolive-stale-swap-mark-cleared-by-tick", ["r3.3i", "design-check-A"], run(noLiveStart(), [ownerRestoreNoLive, swapMarked(-5), prepKeeps(),
  [tick, w => { w.local.unconfirmedKept = {}; }]])); // r3.3h-escape
// A r3.3h-overstrict: the prep re-stamps the swap's mark to its own step. MUTANT window-end-mark-immutable.
acc("keptKeysProtected", "nolive-swap-mark-restamped-by-prep", ["r3.3i", "design-check-A"], run(noLiveStart(), [ownerRestoreNoLive, swapMarked(-5),
  prepKeeps(w => { w.local.unconfirmedKept = { k9: w.step }; }), [tick]])); // r3.3h-overstrict
// A: outside the window-ending prep no step creates a mark. MUTANT unconfirmed-mark-stamp-unchecked (re-aimed).
rej("keptKeysProtected", "nolive-unconfirmed-mark-born-on-tick", ["r3.3i", "design-check-A"], nolive([prepMarks,
  [tick, w => { w.local.unconfirmedKept = { ...w.local.unconfirmedKept, k1: w.step }; }]]));

// B r3.3h-overstrict (High wedge): archive B carries k9 marked at 1, the carry marks it at 3; the prep commits the carried 3.
acc("keptKeysProtected", "carried-mark-differs-from-archive-mark-prep-commits-carried", ["r3.3i", "design-check-B"], nolive([prepMarks, clearJob, restoreB,
  [{ t: "auto.captureOutgoing" }, w => { w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 1, keyIds: ["k1", "k9"], keptKeys: { k9: "aKo" }, unconfirmedKept: { k9: 3 }, blindPending: true }); phase(w, "captured"); /* r3.3i (F): covers the outgoing database and its blind fence */ }],
  [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: false }, w => { w.ghost.epoch = 2; phase(w, "swapped"); w.proc.phase = "boot_prep";
    w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 2, source: "desktop", archiveId: "B", blind: false, carryId: "c2", ownerRequestStep: w.step - 2, jobId: w.fs.restoreJob?.id ?? null });
    w.local.keptKeys = { k9: "aKo" }; w.local.unconfirmedKept = { k9: 1 }; }],
  [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(2); phase(w, "prepared"); w.carry = null; w.local.unconfirmedKept = { k9: 3 }; w.proc.phase = "store_open"; }]])); // r3.3h-overstrict

// C r3.3h-escape (High): a fresh owner Remove (still owed: k9 stays kept) clears the mark; a later restore would excuse the Remove and the
// carry would hold aKo unmarked. MUTANT remove-clears-mark-kept-key.
rej("keptKeysProtected", "marked-key-remove-owed-mark-cleared-by-tick", ["r3.3i", "design-check-C"], run(markedK9(), [removeK9,
  [tick, w => { w.local.unconfirmedKept = {}; }]])); // r3.3h-escape
const restoreArmedA: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "A" }, w => {
  w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "A" }); arm(w, "A"); }];
const captureK9 = (marks?: Record<string, number>): StepSpec => [{ t: "auto.captureOutgoing" }, w => {
  w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: "c2", capturedAtStep: w.step, forEpoch: 0, keyIds: ["k1", "k9"], keptKeys: { k9: "aKo" }, ...(marks ? { unconfirmedKept: marks } : {}) }); phase(w, "captured"); }];
// C r3.3h-escape: the capture of the outgoing home drops the mark of k9, whose Remove is owed. MUTANT capture-drops-owed-remove-mark.
rej("keptKeysProtected", "owed-remove-mark-dropped-at-capture", ["r3.3i", "design-check-C"], run(markedK9(), [removeK9, restoreArmedA, captureK9()])); // r3.3h-escape
acc("keptKeysProtected", "owed-remove-mark-captured", ["r3.3i", "design-check-C"], run(markedK9(), [removeK9, restoreArmedA, captureK9({ k9: -1 })]));

// D r3.3h-escape (Medium/High): R1's durable flag. MUTANTS restore-pending-unchecked, restore-pending-stale-allowed.
const noFlag = (x: StepSpec): StepSpec => [x[0], w => { x[1]?.(w); w.fs.restoreJob = null; }]; // r3.4: the job lost
rej("restoreJobMatchesReality", "nolive-restore-pending-missing-in-window", ["r3.3i", "design-check-D"], run(noLiveStart(), [noFlag(ownerRestoreNoLive), noFlag(swapNoLive(true))])); // r3.3h-escape
rej("restoreJobMatchesReality", "restore-pending-left-after-prep", ["r3.3i", "design-check-D"], nolive([[prepMarks[0], w => { prepMarks[1]!(w); w.local.preparedJobId = null; }]])); // r3.3h-escape
rej("restoreJobMatchesReality", "nolive-restore-pending-lost-across-crash", ["r3.3i", "design-check-D"], nolive([noFlag(crashW3)])); // r3.3h-escape
acc("restoreJobMatchesReality", "nolive-restore-pending-through-crash-boot-prep", ["r3.3i", "design-check-D"], nolive([crashW3, bootW,
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.unconfirmedKept = { k9: w.step }; w.proc.phase = "store_open"; }]]));

// E r3.3h-escape (Low): a window refusal that writes an ops line, an archive, or moves the high-water. MUTANT window-purity-omits-ops-archives-highwater.
const keepRefusedM = (m: Mut): StepSpec => [keepA({ outcome: no("confirm_expired") }), w => { finishing(w); m(w); }];
rej("keptKeysProtected", "nolive-window-refusal-writes-ops-line", ["r3.3i", "design-check-E"], nolive([keepRefusedM(opsLine("keep refused while a restore finishes", "b1"))])); // r3.3h-escape
rej("keptKeysProtected", "nolive-window-refusal-writes-archive", ["r3.3i", "design-check-E"], nolive([keepRefusedM(w => { w.archives.push({ archiveId: "X", kind: "desktop_backup", topLevelNames: ["messages.db"] }); })])); // r3.3h-escape
rej("keptKeysProtected", "nolive-window-refusal-moves-high-water", ["r3.3i", "design-check-E"], nolive([keepRefusedM(w => { w.ghost.keptHighWater.k1 = "aKn"; })])); // r3.3h-escape

// G r3.3h-escape (copy): the marked-key view uses the binding-changed wording; a window refusal explained only by it. MUTANTS
// reconfirm-line-uses-look-again, window-line-accepts-look-again.
rej("keptKeysProtected", "nolive-unconfirmed-view-look-again-wording", ["r3.3i", "Sol-copy-G"], nolive([prepMarks,
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "bot", keyIds: ["k9"], line: LOOK_AGAIN_LINE })]; }]])); // r3.3h-escape
rej("keptKeysProtected", "nolive-window-refusal-look-again-only", ["r3.3i", "Sol-copy-G"], nolive([[keepA({ outcome: no("confirm_expired") }),
  w => { w.surface = [row({ section: "bot", line: LOOK_AGAIN_LINE })]; }]])); // r3.3h-escape

// ---------- r3.4 (redesign: durable restore job, one window, sealed carry; Astra r3.3i #1-#6, Fable F1-F6) ------------------------------

const crashAt = (at: DurableWrite, when: "before" | "after" = "after"): StepSpec => [{ t: "fault.crash", at, when }, w => { w.proc.phase = "down"; }];
const abortStep = (m: Mut = () => {}): StepSpec => [{ t: "auto.restoreAbort", reason: "archive_unreadable" }, w => { phase(w, "aborted");
  w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE })]; m(w); }];
const blindSwapSys: StepSpec = [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: true }, w => { w.ghost.epoch = 1; phase(w, "swapped");
  w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: true, carryId: null, ownerRequestStep: null, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keptKeys = { k9: "aKo" }; w.fs.messagesDbPresent = true; w.proc.phase = "boot_prep"; }];
const captureB = (id = "c2", ph: RestoreJobPhase = "captured"): StepSpec => [{ t: "auto.captureOutgoing" }, w => {
  w.carry = carry({ jobId: w.fs.restoreJob?.id ?? null, carryId: id, capturedAtStep: w.step, forEpoch: 1, keyIds: ["k1", "k9"], keptKeys: { k9: "aKo" }, unconfirmedKept: { k9: 3 }, blindPending: true }); phase(w, ph); }];
const swapB = (archiveKept: Record<string, string>): StepSpec => [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: false }, w => { w.ghost.epoch = 2; phase(w, "swapped"); w.proc.phase = "boot_prep";
  w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 2, source: "desktop", archiveId: "B", blind: false, carryId: w.carry!.carryId, ownerRequestStep: w.ghost.ownerRestoreRequests[w.ghost.ownerRestoreRequests.length - 1].atStep, jobId: w.fs.restoreJob?.id ?? null });
  w.local.keptKeys = { ...archiveKept }; delete w.local.unconfirmedKept; }];
const prepCarried = (a: "auto.restorePrepare" | "auto.bootPrep", m: Mut = () => {}): StepSpec => [a === "auto.bootPrep" ? { t: a, outcome: "ok" } : { t: a, outcome: "committed" }, w => {
  w.ghost.preparedEpochs.push(2); phase(w, "prepared"); w.carry = null; w.local.keptKeys = { k9: "aKo" }; w.local.unconfirmedKept = { k9: 3 }; w.proc.phase = "store_open"; m(w); }];

// 1 Durable job: a crash witness at every new write point W25-W30 (each accepted: the job's durable phase matches the world and boot resumes it).
acc("restoreJobMatchesReality", "job-crash-w25-armed-resumes", ["r3.4", "Astra-r3.3i-3"], run(noLiveStart(), [ownerRestoreNoLive, crashAt("W25_job_armed"), bootW,
  [swapNoLive(true)[0], w => { swapNoLive(true)[1]!(w); w.ghost.restores[0].ownerRequestStep = 1; }], prepMarks, clearJob]));
acc("restoreJobMatchesReality", "job-crash-w26-captured-resumes", ["r3.4", "Astra-r3.3i-3"], nolive([prepMarks, clearJob, restoreB, captureB(), crashAt("W26_job_captured"), bootW, swapB({ k9: "aKo" }), prepCarried("auto.restorePrepare"), clearJob]));
acc("restoreJobMatchesReality", "job-crash-w27-staged-swap-resumes", ["r3.4", "Fable-r3.3i-F1"], nolive([prepMarks, clearJob, restoreB, captureB(), crashAt("W27_job_swapped_staged"), bootW, swapB({ k9: "aKo" }), prepCarried("auto.restorePrepare"), clearJob]));
acc("restoreJobMatchesReality", "job-crash-w28-after-boot-clears", ["r3.4", "Fable-r3.3i-F1"], nolive([prepMarks, crashAt("W28_job_prepared"), bootW, [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.proc.phase = "store_open"; }], clearJob]));
acc("restoreJobMatchesReality", "job-crash-w29-aborted-clears", ["r3.4", "Fable-r3.3i-F3"], nolive([prepMarks, clearJob, restoreB, captureB(), abortStep(), crashAt("W29_job_aborted"), bootW, clearJob]));
acc("restoreJobMatchesReality", "job-crash-w30-cleared", ["r3.4", "Fable-r3.3i-F1"], nolive([prepMarks, clearJob, crashAt("W30_job_cleared"), bootW, [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.proc.phase = "store_open"; }]]));
// 1: the job vanishes at boot (no abort, no clear). MUTANT job-phase-any-step.
rej("restoreJobProtocol", "job-armed-lost-across-boot", ["r3.4", "Astra-r3.3i-3"], run(noLiveStart(), [ownerRestoreNoLive, crashAt("W25_job_armed"), [bootW[0], w => { bootW[1]!(w); w.fs.restoreJob = null; }]]));
// 1 liveness: an armed job never finishes; the same job aborted and cleared is quiescent. MUTANT quiescence-ignores-job.
const restoreLive: StepSpec = [{ t: "owner.restore", source: "desktop", archiveId: "A" }, w => { w.ghost.ownerRestoreRequests.push({ atStep: w.step, source: "desktop", archiveId: "A" }); arm(w, "A"); }];
rej("quiescenceReachable", "job-stuck-armed-never-finishes", ["r3.4", "Astra-r3.3i-3"], run(base(), [restoreLive, ...ticks(CHECKER.livenessBound)])); // r3.3i-escape
acc("quiescenceReachable", "job-armed-aborted-cleared-quiescent", ["r3.4", "Fable-r3.3i-F3"], run(base(), [restoreLive, abortStep(), clearJob, ...ticks(CHECKER.livenessBound)]));
// 1: a swap of another archive than the job's. MUTANT job-swap-any-archive.
rej("restoreJobProtocol", "job-swap-foreign-archive", ["r3.4"], run(noLiveStart(), [ownerRestoreNoLive, [{ t: "auto.swap", source: "desktop", archiveId: "B", blind: true }, w => { swapNoLive(true)[1]!(w); w.ghost.restores[0].archiveId = "B"; }]]));
// 1: the window-ending prep leaves the job swapped. MUTANT prep-skips-job-phase.
rej("restoreJobProtocol", "job-prepared-left-swapped", ["r3.4", "Fable-r3.3i-F1"], nolive([[prepMarks[0], w => { const pj = w.local.preparedJobId; prepMarks[1]!(w); w.local.preparedJobId = pj; }]]));
// 1 abort (Fable F3): after capture, pure, with the failed line, then cleared with its carry; rejects: impure, silent, after the swap.
acc("outgoingCapturedBeforeSwap", "abort-after-capture-clears", ["r3.4", "Fable-r3.3i-F3"], nolive([prepMarks, clearJob, restoreB, captureB(), abortStep(), clearJob])); // r3.3i-overstrict
rej("restoreJobProtocol", "abort-not-pure", ["r3.4", "Fable-r3.3i-F3"], nolive([prepMarks, clearJob, restoreB, captureB(), abortStep(w => { w.local.savedKeys.b1 = null; })]));
rej("restoreJobProtocol", "abort-without-failed-line", ["r3.4", "Fable-r3.3i-F3"], nolive([prepMarks, clearJob, restoreB, captureB(), [abortStep()[0], w => { phase(w, "aborted"); }]]));
rej("restoreJobProtocol", "abort-after-swap", ["r3.4", "Fable-r3.3i-F3"], nolive([abortStep()]));
// 1 (Fable F4): a system restore runs as a job too: armed, swapped (blind), prepared, cleared. MUTANT job-arm-over-open (second witness below).
acc("restoreJobProtocol", "system-restore-armed-swapped-prepared", ["r3.4", "Fable-r3.3i-F4"], run(noLiveStart(), [sysArm(), blindSwapSys, prepMarks, clearJob]));

// 2 One window (Astra r3.3i #4, #6, Fable F2): from phase armed on, only restore_finishing, pure, visible. MUTANTS window-accepts-confirm-expired,
// job-arm-over-open, window-purity-omits-bots.
rej("admissionPinned", "armed-keep-refused-confirm-expired-impure", ["r3.4", "Astra-r3.3i-4", "Fable-r3.3i-F2"], run(noLiveStart(), [ownerRestoreNoLive,
  [keepA({ outcome: no("confirm_expired") }), w => { w.local.savedKeys.b1 = null; }]])); // r3.3i-escape
acc("admissionPinned", "armed-keep-refused-restore-finishing", ["r3.4", "Astra-r3.3i-4"], run(noLiveStart(), [ownerRestoreNoLive, [keepA({ outcome: no("restore_finishing") }), finishing]]));
rej("restoreJobProtocol", "armed-second-restore-admitted", ["r3.4", "Astra-r3.3i-4"], run(noLiveStart(), [ownerRestoreNoLive, restoreB]));
rej("keptKeysProtected", "armed-view-without-line", ["r3.4", "Fable-r3.3i-F2"], run(noLiveStart(), [ownerRestoreNoLive, [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = []; }]])); // r3.3i-escape
acc("keptKeysProtected", "armed-view-shows-line", ["r3.4", "Fable-r3.3i-F2"], run(noLiveStart(), [ownerRestoreNoLive, [{ t: "owner.viewSurface", principal: OWN }, finishing]]));
rej("keptKeysProtected", "window-refusal-deletes-bot", ["r3.4", "Astra-r3.3i-6"], nolive([[keepA({ outcome: no("restore_finishing") }), w => { finishing(w); w.bots.b1.present = false; }]])); // r3.3i-escape

// 3 Sealed carry (Astra r3.3i #1, #2). MUTANTS carry-mutable, bootprep-carry-not-authority.
rej("carryImmutable", "carry-mark-rewritten-after-swap", ["r3.4", "Astra-r3.3i-1"], nolive([prepMarks, clearJob, restoreB, captureB(), swapB({ k9: "aKo" }),
  [tick, w => { w.carry!.unconfirmedKept = { k9: -5 }; }]])); // r3.3i-escape
// the crash lands after the carry write W23 and before W26: the carry is on disk, the job still armed; boot captures again (R1).
acc("carryImmutable", "carry-recaptured-while-armed", ["r3.4", "Astra-r3.3i-1"], nolive([prepMarks, clearJob, restoreB, [crashAt("W26_job_captured", "before")[0], w => { const j = clone(w.fs.restoreJob); captureB("c2")[1]!(w); w.fs.restoreJob = j; w.proc.phase = "down"; }], bootW,
  captureB("c3"), swapB({ k9: "aKo" }), prepCarried("auto.restorePrepare"), clearJob]));
acc("keptKeysProtected", "carried-key-missing-from-archive-rebuilt-at-boot-prep", ["r3.4", "Astra-r3.3i-2"], nolive([prepMarks, clearJob, restoreB, captureB(), swapB({}), crashW3, bootW,
  prepCarried("auto.bootPrep")])); // r3.3i-overstrict
rej("keptKeysProtected", "carried-key-missing-from-archive-left-absent", ["r3.4", "Astra-r3.3i-2"], nolive([prepMarks, clearJob, restoreB, captureB(), swapB({}), crashW3, bootW,
  prepCarried("auto.bootPrep", w => { w.local.keptKeys = {}; w.local.unconfirmedKept = {}; })]));

// 5 copy (Fable F6): a Remove that ends skipped_in_use (k9 is bot b2's saved key) keeps the entry and the mark; the view shows the reconfirm line.
const markedK9InUse = () => from(w => { Object.assign(w, markedK9()); w.bots.b2 = { botId: "b2", present: true }; w.local.savedKeys.b2 = "k9"; });
acc("keptKeysProtected", "marked-key-remove-skipped-in-use-keeps-reconfirm-line", ["r3.4", "Fable-r3.3i-F6"], run(markedK9InUse(), [removeK9,
  [tick, w => { w.local.leases.L9.keyTargets = [{ keyId: "k9", status: "skipped_in_use" }]; }],
  [{ t: "owner.viewSurface", principal: OWN }, w => { w.surface = [row({ section: "bot", botId: "b2", keyIds: ["k9"], line: RECONFIRM_KEPT_LINE })]; }]]));

// ---------- r3.4b (Opus design check of r3.4: N1 High, N2 / N3 Medium, N4 / N5 Low) ----------------------------------------------------
// N1 carry provenance. MUTANTS carry-created-by-any-step, job-arm-over-finished, blind-swap-with-carry, carry-job-unchecked, prep-consumes-foreign-carry.
const staleCarry = () => carry({ carryId: "cS", jobId: "jOld", capturedAtStep: -3, keyIds: ["k9"], inboxIds: [], provisionOps: [], keptKeys: { k9: "aKo" } });
const withStaleCarry = () => from(w => { Object.assign(w, noLiveStart()); w.carry = staleCarry(); }); // an aborted job's carry its clear never deleted
const unmarkedK9 = () => from(w => { Object.assign(w, markedK9()); delete w.local.unconfirmedKept; w.ghost.keptHighWater.k9 = "aKo"; }); // k9 confirmed under aKo: its high-water
rej("carryImmutable", "tick-creates-carry", ["r3.4b", "Opus-r3.4-N1"], run(noLiveStart(), [ownerRestoreNoLive,
  [tick, w => { w.carry = carry({ carryId: "cT", jobId: w.fs.restoreJob!.id, capturedAtStep: w.step, keyIds: ["k9"], inboxIds: [], provisionOps: [], keptKeys: { k9: "aKo" } }); }]])); // r3.4-escape
rej("restoreJobProtocol", "stale-aborted-carry-armed-over", ["r3.4b", "Opus-r3.4-N1"], run(unmarkedK9(), [restoreArmedA, captureK9(), abortStep(), restoreB])); // r3.4-escape
rej("restoreJobMatchesReality", "stale-carry-under-new-job", ["r3.4b", "Opus-r3.4-N1"], run(withStaleCarry(), [ownerRestoreNoLive])); // r3.4-escape
rej("outgoingCapturedBeforeSwap", "stale-aborted-carry-blind-swap", ["r3.4b", "Opus-r3.4-N1"], nolive([], withStaleCarry())); // r3.4-escape
rej("keptKeysProtected", "stale-aborted-carry-launders-at-prep", ["r3.4b", "Opus-r3.4-N1"], nolive([[prepMarks[0], w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.proc.phase = "store_open"; }]], withStaleCarry())); // r3.4-escape
acc("carryImmutable", "capture-then-prep-own-carry", ["r3.4b", "Opus-r3.4-N1"], nolive([prepMarks, clearJob, restoreB, captureB(), swapB({ k9: "aKo" }), prepCarried("auto.restorePrepare"), clearJob]));
// N3 a stray prep (no prep pending) re-applies the carry after an owner Remove. MUTANTS stray-prep-consumes-carry, rekeep-under-removed-keep.
const swapAkept: StepSpec = [{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, w => { w.ghost.epoch = 1; phase(w, "swapped"); w.proc.phase = "boot_prep";
  w.ghost.restores.push({ atStep: w.step, atMs: w.nowMs, epochAfter: 1, source: "desktop", archiveId: "A", blind: false, carryId: "c2", ownerRequestStep: 1, jobId: w.fs.restoreJob?.id ?? null }); w.local.keptKeys = { k9: "aKo" }; }];
const prepAkeep: StepSpec = [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.proc.phase = "store_open"; }]; // carry left until the clear
rej("keptKeysProtected", "stray-prep-after-remove-restores-key", ["r3.4b", "Opus-r3.4-N3"], run(unmarkedK9(), [restoreArmedA, captureK9(), swapAkept, prepAkeep,
  [removeK9[0], w => { removeK9[1]!(w); delete w.local.keptKeys.k9; }],
  [{ t: "auto.restorePrepare", outcome: "committed" }, w => { w.local.keptKeys.k9 = "aKo"; }]])); // r3.4-escape
acc("keptKeysProtected", "window-ending-prep-takes-own-carry-then-clear", ["r3.4b", "Opus-r3.4-N3"], run(unmarkedK9(), [restoreArmedA, captureK9(), swapAkept, prepAkeep, clearJob]));
// N2 the journal: a crash at every write, including between the W4 commit (preparedJobId) and the journal unlink. MUTANT journal-holds-db-phase.
acc("restoreJobMatchesReality", "blind-journal-crash-between-w4-and-unlink-reconciles", ["r3.4b", "Opus-r3.4-N2", "Fable-r3.3i-F1"], nolive([prepMarks, crashAt("W30_job_cleared", "before"), bootW, clearJob]));
acc("restoreJobMatchesReality", "blind-journal-crash-after-w27-resumes", ["r3.4b", "Opus-r3.4-N2"], nolive([crashAt("W27_job_swapped_staged"), bootW,
  [{ t: "auto.bootPrep", outcome: "ok" }, w => { w.ghost.preparedEpochs.push(1); phase(w, "prepared"); w.local.unconfirmedKept = { k9: w.step }; w.proc.phase = "store_open"; }], clearJob]));
rej("restoreJobMatchesReality", "journal-written-prepared-outside-w4", ["r3.4b", "Opus-r3.4-N2"], nolive([[prepMarks[0], w => { const pj = w.local.preparedJobId; prepMarks[1]!(w);
  w.local.preparedJobId = pj; w.fs.restoreJob!.phase = "prepared"; w.fs.restoreJob!.at = w.step; }]])); // r3.4 had no journal (the job sat in the database, absent on a blind restore)
// N4 held input: an event arriving mid-job is applied only after the job is prepared. MUTANT window-takes-input.
const withEvent = () => from(w => { Object.assign(w, noLiveStart()); w.flux.events.push({ eventId: "eR", type: "email.inbox.restored", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: false, reason: null }); });
const applyER: StepSpec = [{ t: "auto.applyEvent", eventId: "eR" }, w => { w.flux.events[0].deliveredToHome = true; }];
rej("keptKeysProtected", "window-event-applied-mid-job", ["r3.4b", "Opus-r3.4-N4"], run(withEvent(), [ownerRestoreNoLive, applyER])); // r3.4-escape
acc("keptKeysProtected", "window-event-held-applied-after-prepared", ["r3.4b", "Opus-r3.4-N4"], nolive([prepMarks, clearJob, applyER], withEvent()));
// N5 owner.backup is a window decision. MUTANT window-admits-backup.
rej("admissionPinned", "window-backup-admitted", ["r3.4b", "Opus-r3.4-N5"], run(noLiveStart(), [ownerRestoreNoLive,
  [{ t: "owner.backup", kind: "desktop_backup" }, w => { w.archives.push({ archiveId: "X", kind: "desktop_backup", topLevelNames: [] }); }]])); // r3.4-escape
acc("admissionPinned", "window-backup-refused-with-line", ["r3.4b", "Opus-r3.4-N5"], run(noLiveStart(), [ownerRestoreNoLive,
  [{ t: "owner.backup", kind: "desktop_backup", outcome: no("restore_finishing") }, finishing]]));

// ---------- r3.4c (Opus design check of r3.4b: M1-M3 Medium, L1-L3 Low) -------------------------------------------------------------
// M1 a stray prep (no prep pending) owes no carry duty: after the Remove it parks the lease and leaves k9 out. MUTANT stray-prep-owes-carry.
const viewK9e1: StepSpec = [{ t: "owner.viewSurface", principal: OWN }, w => { w.ghost.tokens.push(tk({ tokenId: "tR9e", issuedAtStep: w.step, epoch: 1, shown: { target: T_I1, address: ADDR, inboxId: null, keyIds: ["k9"] } }));
  w.surface = [row({ section: "key_only", inboxId: null, keyIds: ["k9"], actions: [{ kind: "keep", tokenId: "tR9e", enabled: true }, { kind: "remove", tokenId: "tR9e", enabled: true }] })]; }];
const removeK9Drop: StepSpec = [removeA("tR9e", { section: "key_only" }), w => { removeK9[1]!(w); const a = w.ghost.authorities[w.ghost.authorities.length - 1]; a.tokenId = "tR9e"; a.epoch = 1; delete w.local.keptKeys.k9; }];
const strayPrep = (rekeep: boolean): StepSpec => [{ t: "auto.restorePrepare", outcome: "committed" }, w => { delete w.local.leases.L9;
  w.local.parks.pk9 = pk({ parkId: "pk9", inboxId: null, keyTargets: [{ keyId: "k9", status: "pending" }] }); if (rekeep) w.local.keptKeys.k9 = "aKo"; }];
acc("restorePrepParksEverything", "stray-prep-after-remove-leaves-key-out", ["r3.4c", "Opus-r3.4b-M1"], run(unmarkedK9(), [restoreArmedA, captureK9(), swapAkept, prepAkeep, viewK9e1, removeK9Drop, strayPrep(false)])); // r3.4b-wrong
rej("keptKeysProtected", "stray-prep-reapplies-carry-after-remove", ["r3.4c", "Opus-r3.4b-M1"], run(unmarkedK9(), [restoreArmedA, captureK9(), swapAkept, prepAkeep, viewK9e1, removeK9Drop, strayPrep(true)]));
// M2 job progress and held input. MUTANTS held-counts-late, job-progress-unchecked.
const withEventBase = () => from(w => { w.flux.events.push({ eventId: "eR", type: "email.inbox.restored", inboxId: "i1", atMs: NOW, atStep: 0, deliveredToHome: false, reason: null }); });
rej("quiescenceReachable", "job-armed-forever-held-event", ["r3.4c", "Opus-r3.4b-M2", "Astra-r3.3i-3"], run(withEventBase(), [restoreLive, ...ticks(CHECKER.fairRecoverySteps + 1)])); // r3.4b-wrong (M2 RED)
rej("quiescenceReachable", "sys-armed-held-event-livelock", ["r3.4c", "Opus-r3.4b-M2"], run(withEventBase(), [...ticks(CHECKER.promptSteps + 1), sysArm(), [clk(130_000)], [tick]])); // r3.4b-wrong
rej("quiescenceReachable", "job-armed-forever-flux-held-request", ["r3.4c", "Opus-r3.4b-M2"], run(from(w => { w.flux.requests.push(rq({ requestId: "rH", kind: "GET_INBOX", target: "i1", purpose: "keep" })); }),
  [restoreLive, ...ticks(CHECKER.livenessBound)])); // r3.4b-wrong
acc("quiescenceReachable", "job-held-event-prepared-then-drained", ["r3.4c", "Opus-r3.4b-M2"], nolive([[prepMarks[0], w => { prepMarks[1]!(w); w.proc.phase = "running"; w.surface = [rcRow()]; }], clearJob, applyER, ...ticks(CHECKER.livenessBound)], withEvent()));
// M3 the download is before the arm. MUTANT download-inside-window.
const failedRow: Mut = w => { w.surface = [row({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], line: RESTORE_FAILED_LINE })]; };
rej("restoreJobProtocol", "arm-before-archive-local", ["r3.4c", "Opus-r3.4b-M3"], run(from(w => { w.fs.localArchives = []; }), [restoreLive])); // r3.4b-wrong
rej("restoreJobProtocol", "abort-download-failed-in-window", ["r3.4c", "Opus-r3.4b-M3"], run(base(), [restoreLive, [{ t: "auto.restoreAbort", reason: "download_failed" }, w => { phase(w, "aborted"); failedRow(w); }]])); // r3.4b-wrong
acc("restoreJobProtocol", "download-failed-pre-arm-refusal", ["r3.4c", "Opus-r3.4b-M3"], run(from(w => { w.fs.localArchives = []; w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); }), [[{ t: "auto.archiveFetch", archiveId: "A", outcome: "download_failed" }, failedRow]])); // r3.4d (Low d): the owner asked
acc("keepEndsActive", "slow-download-before-arm-keep-blip-restored", ["r3.4c", "Opus-r3.4b-M3", "A3-H1"], run(from(w => { Object.assign(w, kept()); w.fs.localArchives = []; }), [[apply("d1"), closeBy("d1")],
  [clk(60_000)], [send(guardRestoreAt({ sentAtMs: NOW + 60_000 })), w => { w.flux.requests.push(guardRestoreAt({ sentAtMs: w.nowMs })); guardLine(w); }],
  [apply("r1"), w => { Object.assign(w.flux.requests[1], { flux: "applied", appliedAtMs: w.nowMs }); reopen(w); }],
  [clk(70_000)], [{ t: "auto.archiveFetch", archiveId: "A", outcome: "verified" }, w => { w.fs.localArchives = ["A"]; }], restoreLive]), true);
// a finished job never cleared (fair suffix, nothing open). MUTANT quiescence-ignores-job (re-aimed: job-progress catches the armed one first).
rej("quiescenceReachable", "job-aborted-never-cleared", ["r3.4c", "Opus-r3.4b-M2"], run(base(), [restoreLive, abortStep(), ...ticks(CHECKER.livenessBound)]));
// L2 the abort discards a staged incoming database already marked swappedJobId (W27 landed in the staged file, W3 did not).
acc("restoreJobProtocol", "abort-discards-staged-marked-db", ["r3.4c", "Opus-r3.4b-L2"], nolive([prepMarks, clearJob, restoreB, captureB(), crashAt("W27_job_swapped_staged"), bootW, abortStep(), clearJob]));
// L3 "Try again" before the clear. MUTANT finished-job-restore-any-code.
const tryAgain = (code: string): StepSpec => [{ t: "owner.restore", source: "desktop", archiveId: "A", outcome: no(code) }, finishing];
acc("admissionPinned", "try-again-before-clear-refused-finishing", ["r3.4c", "Opus-r3.4b-L3"], run(base(), [restoreLive, abortStep(), tryAgain("restore_finishing"), clearJob]));
rej("admissionPinned", "try-again-before-clear-other-code", ["r3.4c", "Opus-r3.4b-L3"], run(base(), [restoreLive, abortStep(), tryAgain("busy")]));

// ---------- r3.4d (Opus design check of r3.4c: N-M1..N-M4, N-L1..N-L4; page INVARIANTS-PAGE-r34d.md) ---------------------------------
const clks = (n: number): StepSpec[] => Array.from({ length: n }, () => [clk(1_000)] as StepSpec);
// L2 (M-1): Flux and clock steps do not count toward the job bound. MUTANT job-progress-counts-all-steps.
acc("quiescenceReachable", "owner-restore-many-env-steps-accepted", ["r3.4d", "Opus-r3.4c-N-M1"], nolive([prepMarks, clearJob, restoreB, captureB(), swapB({ k9: "aKo" }), ...clks(6), prepCarried("auto.restorePrepare"), clearJob])); // r3.4c-wrong
acc("quiescenceReachable", "system-restore-many-env-steps-accepted", ["r3.4d", "Opus-r3.4c-N-M1"], run(noLiveStart(), [sysArm(), blindSwapSys, ...clks(6), prepMarks, clearJob])); // r3.4c-wrong
// L2 (M-2): the bound runs until the clear. MUTANT job-bound-stops-at-finished.
rej("quiescenceReachable", "job-prepared-or-aborted-never-cleared-event-pending", ["r3.4d", "Opus-r3.4c-N-M2"], run(withEventBase(), [restoreLive, abortStep(), tryAgain("restore_finishing"), ...ticks(2), tryAgain("restore_finishing"), ...ticks(CHECKER.livenessBound)])); // r3.4c-wrong
// A1 (M-3): the job's archive is frozen and re-checked at the swap. MUTANTS archive-not-frozen, swap-no-archive-recheck.
rej("restoreJobProtocol", "fetch-replaces-job-archive-mid-job", ["r3.4d", "Opus-r3.4c-N-M3"], run(base(), [restoreLive, [{ t: "auto.archiveFetch", archiveId: "B", outcome: "verified" }, w => { w.fs.localArchives = ["B"]; }]])); // r3.4c-wrong
rej("restoreJobProtocol", "swap-archive-missing", ["r3.4d", "Opus-r3.4c-N-M3"], run(from(w => { w.carry = carry(); sysJob(w, "A", "cloud_reset", "captured"); w.fs.localArchives = []; }), // r3.4c-wrong
  [[{ t: "auto.swap", source: "cloud_reset", archiveId: "A", blind: false }, w => { sysSwap(w); }]]));
// C1 (M-4): the boot prep after a crash between swap and prep owes the carry duties. MUTANT boot-prep-exempt.
const bootPrepOk = (m: Mut = () => {}): StepSpec => [{ t: "auto.bootPrep", outcome: "ok" }, w => { sysPrep(w); m(w); }];
rej("restorePrepParksEverything", "boot-prep-leaves-carried-removal-unparked", ["r3.4d", "Opus-r3.4c-N-M4", "A5-H2"], run(from(w => { Object.assign(w, carriedRemoval()); swappedStart(w); }), [crashAt("W28_job_prepared", "before"), bootW, bootPrepOk()])); // r3.4c-wrong
rej("restorePrepParksEverything", "boot-prep-drops-carried-guard", ["r3.4d", "Opus-r3.4c-N-M4", "A4-H7"], run(from(w => { w.carry = carry({ keepGuards: [gd()] }); swappedStart(w); }), [crashAt("W28_job_prepared", "before"), bootW, bootPrepOk()])); // r3.4c-wrong
acc("restorePrepParksEverything", "boot-prep-parks-carried-removal", ["r3.4d", "Opus-r3.4c-N-M4"], run(from(w => { Object.assign(w, carriedRemoval()); swappedStart(w); }), [crashAt("W28_job_prepared", "before"), bootW,
  bootPrepOk(w => { w.surface = [orphanRow()]; w.local.parks.pk1 = pk(); w.local.bindings.b1.state = "removal_parked"; })]));
// L3 (Low b): held input drains after the window. MUTANT held-input-never-checked.
rej("heldInputDrains", "held-event-dropped-after-window", ["r3.4d", "Opus-r3.4c-N-L2"], nolive([prepMarks, clearJob, ...ticks(CHECKER.livenessBound)], withEvent())); // r3.4c-wrong
acc("heldInputDrains", "held-event-applied-after-window", ["r3.4d", "Opus-r3.4c-N-L2"], nolive([[prepMarks[0], w => { prepMarks[1]!(w); w.proc.phase = "running"; w.surface = [rcRow()]; }], clearJob, applyER, ...ticks(CHECKER.livenessBound)], withEvent()));
// A1 (Low d): the failed-download line only for an owner request. MUTANT fetch-line-always.
const fetchFail: Action = { t: "auto.archiveFetch", archiveId: "A", outcome: "download_failed" };
acc("restoreJobProtocol", "background-prefetch-fails-no-line", ["r3.4d", "Opus-r3.4c-N-L4"], run(from(w => { w.fs.localArchives = []; }), [[fetchFail]])); // r3.4c-wrong
rej("restoreJobProtocol", "background-prefetch-fails-shows-line", ["r3.4d", "Opus-r3.4c-N-L4"], run(from(w => { w.fs.localArchives = []; }), [[fetchFail, failedRow]])); // r3.4c-wrong
rej("restoreJobProtocol", "owner-fetch-fails-no-line", ["r3.4d", "Opus-r3.4c-N-L4"], run(from(w => { w.fs.localArchives = []; w.ghost.ownerRestoreRequests.push({ atStep: 0, source: "desktop", archiveId: "A" }); }), [[fetchFail]]));

// Helper kit for the clause-mutant group files (witnesses/witnesses-cm-gN.ts): exported so each group adds witnesses in its own file.
export { NOW, DAY, OWN, ADDR, G1, G2, T_I1, T_OP1, clone, from, run, rq, tk, au, kr, gd, ls, pk, row, carry, tick, clk, send, apply, okO, no, removeA, keepA, closeBy, reopen, fluxClose, delGuard, orphanRow, pendingRow, botKeepRow, withRows, rcRow, rTok, guardLine, arm, phase, pendingPrep, sysArm, sysSwap, swappedStart, sysPrep, clearJob, remHistE1, claimKeepNow, leaseNow, d, tokB, remHist, keepHist, kept, confirmStart, succeed, claimed, guardedWithToken, closingKept, guardRestore, withToken, leaseAuth, blind, keptKey, revokeK9, revokeK9L, leaseK9, parked, keptRecord, swapA, prep, inFlight, parkIt, botGone, view, keyOnlyKeep, keyOnlyRemove, claimKp1, claimKp1Full, leaseIn, parkOnlyKey, replaced, ticks, g1, opsLine, heldD1, parkTok, parkedTok, carriedRemoval, keptK9, restoreReq, unknownEntries, confirmStep, listReq, removeParked, dupAfterRestore, pollRound, livelockRounds, revokeK1, twoBots, deleteB1, deleteB1Clean, reusedD, otherD, admitKeep, viewS, admitKeepRow, g1v, keepThenDelete, dD, vD, deleteB1Work, unlistedBlind, listAnswered, listAns, discovered, keptSwapStart, swapOld, delStart, delOk, guardRestoreAt, orphanOfOther, pkE, purgedSeen, admitKeepNow, ownerRestoreA, captureK, swapK, prepK, ownerAfter, autoOnly, staleOwner, k9Start, prepK9, prepDropK9, reKeep, pollBy, lastPoll, edgePolls, otherSetupArchive, pk9, botKeepView, T_B1, lookAgain, staleKeep, delKilled, noLiveStart, ownerRestoreNoLive, swapNoLive, k9Sc, crashW3, bootW, prepMarks, nolive, withRemoveAfterHw, withK9Revoked, finishing, lookAgainView, lookAgainViewTok, prepDropsK9, prepClamps, clampRevokeStart, clampView, clampRemove, clampConfirm, vClamp, restoreB, carriedMarkSwapCrash, markedK9, removeK9, v9, restoreRefused, leaseStart, tryRefused, refusedCrashBoot, swapMarked, prepKeeps, restoreArmedA, captureK9, noFlag, keepRefusedM, crashAt, abortStep, blindSwapSys, captureB, swapB, prepCarried, restoreLive, markedK9InUse, staleCarry, withStaleCarry, unmarkedK9, swapAkept, prepAkeep, withEvent, applyER, viewK9e1, removeK9Drop, strayPrep, withEventBase, failedRow, tryAgain, clks, bootPrepOk, fetchFail };
/** rej/acc that push into a group file's own array (the group file owns its witnesses and its PIN). */
export const cmKit = (into: Witness[]) => ({
  rej: (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false): void => { into.push({ id, invariant, expect: "reject", answers, settled, trace, r2: null }); },
  acc: (invariant: string, id: string, answers: string[], trace: TraceStep[], settled = false): void => { into.push({ id, invariant, expect: "accept", answers, settled, trace, r2: null }); },
});
export const WITNESSES: readonly Witness[] = W; // the base spec witnesses only; the merged list (base + clause-mutant groups) is witnesses/witnesses-all.ts

// ===================================================================================================================================
// Runner (the checker calls this FIRST)
// ===================================================================================================================================

export function runWitnesses(ws: readonly Witness[] = WITNESSES): { id: string; invariant: string; ok: boolean; why: string }[] {
  return ws.map(w => {
    const v = verdictOf(w.invariant, w.trace, w.settled);
    const rejected = !v.ok && v.invariant === w.invariant;
    const ok = w.expect === "reject" ? rejected : v.ok;
    return { id: w.id, invariant: w.invariant, ok, why: v.ok ? "accepted" : v.why };
  });
}

/** Invariants lacking a must-reject or a must-accept witness, Highs lacking a must-reject, and r3 Highs lacking an r2-escape. All empty. */
export function witnessCoverage(ws: readonly Witness[] = W): { missing: string[]; highsMissing: string[]; r2EscapesMissing: string[] } {
  const names = [...Object.keys(STEP_INVARIANTS), ...Object.keys(STATE_INVARIANTS), ...Object.keys(TRACE_INVARIANTS)];
  const missing: string[] = [];
  for (const n of names) for (const e of ["reject", "accept"] as const) if (!ws.some(w => w.invariant === n && w.expect === e)) missing.push(`${n}:${e}`);
  const r3Highs = ["A5-H1", "A5-H2", "A5-H3", "A5-H4", "A5-H5", "A5-H6", "A5-H7", "A5-H8", "F5-H1"];
  const highs = ["A4-H1", "A4-H2", "A4-H3", "A4-H4", "A4-H5", "A4-H6", "A4-H7", "A4-H8", "A4-H9", "A4-H10", "F4-H1", "F4-H2", "F4-H3", "F4-H4", ...r3Highs];
  const highsMissing = highs.filter(h => !ws.some(w => w.expect === "reject" && w.answers.includes(h)));
  const r2EscapesMissing = r3Highs.filter(h => !ws.some(w => w.expect === "reject" && w.r2?.kind === "escape" && w.r2.finding === h));
  return { missing, highsMissing, r2EscapesMissing };
}

/** r3.2 fail-first set: escapes (r3.1 must ACCEPT them) and over-strict accepts (r3.1 must REJECT them). */
export function r31Comparison(ws: readonly Witness[] = WITNESSES): { id: string; kind: "escape" | "overstrict"; finding: string; r31ShouldAccept: boolean }[] {
  return ws.filter(w => w.r31 !== undefined).map(w => ({ id: w.id, kind: w.r31!.kind, finding: w.r31!.finding, r31ShouldAccept: w.r31!.kind === "escape" }));
}

/** r3.3 fail-first set: escapes (r3.2 must ACCEPT them) and over-strict accepts (r3.2 must REJECT them). */
export function r32Comparison(ws: readonly Witness[] = WITNESSES): { id: string; kind: "escape" | "overstrict"; finding: string; r32ShouldAccept: boolean }[] {
  return ws.filter(w => w.r32 !== undefined).map(w => ({ id: w.id, kind: w.r32!.kind, finding: w.r32!.finding, r32ShouldAccept: w.r32!.kind === "escape" }));
}

/** The fail-first set: escapes (r2 must ACCEPT them, r3 must reject) and over-strict accepts (r2 must REJECT them, r3 must accept). */
export function r2Comparison(ws: readonly Witness[] = WITNESSES): { id: string; kind: "escape" | "overstrict"; finding: string; r2ShouldAccept: boolean }[] {
  return ws.filter(w => w.r2 !== null).map(w => ({ id: w.id, kind: w.r2!.kind, finding: w.r2!.finding, r2ShouldAccept: w.r2!.kind === "escape" }));
}
