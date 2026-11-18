// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESTORE-PARK REDUCER v1: pure reduce(state, event) -> { actions, state }. Conservative everywhere: park, keep, hold, never DELETE or
// revoke without owner authority, alert. Areas still being revised in r3 are marked // STUB-R3-n (1 tokens, 2 carry, 3 guard.unresolved,
// 4 keepEndsActive timing, 5 blind restore, 6 Keep authority/op/history, 7 pre-restore DELETE after prep, 8 duplicate DELETE).
// Extra durable bookkeeping lives in local.x (a reducer-private extension of LocalDb): request-id expectations, token counter, epoch.

import type { Action, Binding, DurableWrite, InboxId, KeepGuard, KeyTarget, LocalDb, OpId, Park, SurfaceRow, TokenId } from "./invariants.current.ts";
import { GUARD_POLL_MS, GUARD_POLL_WINDOW_MS, LOOK_AGAIN_LINE, TOKEN_TTL_MS, botTarget, inboxTarget } from "./invariants.current.ts";
import type { Effect, HomeEvent, HomeState, ReduceCtx, ReduceResult, Reducer, SendRequest } from "./model.ts";
import { NOOP_CTX, jobPhaseOf } from "./model.ts";
import { RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, locallyReferencedInboxes, locallyReferencedKeys, locallyReferencedOps, queuedRemovals } from "./invariants.current.ts";
import type { CarryRecord } from "./invariants.current.ts";
import { NO_LIVE_SUFFIX } from "./domain.ts";

export const RESTORE_BRANCH_IDS: readonly string[] = [
  "boot", "bootPrep.ok", "bootPrep.throw", "emailOn", "settle", "tick", "tick.reissue_keep", "tick.reissue_delete", "tick.guard_poll", "tick.park_unauthorized", "park.refused_kept", "tryAgain.not_bot",
  "restore.arm", "restore.refuse_window", "restore.refuse_finished", "restore.refuse_not_local", "restore.capture", "restore.capture_refused", "restore.abort", "restore.abort_refused", "window.refuse_owner", "window.refuse_backup",
  "restore.swap", "restore.swap_refused", "restore.swap_not_local", "restore.prepare", "restore.prepare_refused", "restore.clear", "restore.clear_refused", "restore.arm_system", "restore.arm_system_refused",
  "fetch.verified", "fetch.download_failed", "fetch.frozen", "bootPrep.prep",
  "view", "backup", "restore.carry", "restore.blind", "restore.park_archive_removal", "restore.keep_wins",
  "keep.refuse.keep_pending", "keep.refuse.removal_sending", "keep.refuse.confirm_expired", "keep.refuse.inbox_gone", "keep.refuse.bot_present",
  "keep.ok.inbox", "keep.ok.key_only",
  "remove.refuse.keep_pending", "remove.refuse.confirm_expired", "remove.refuse.bot_present", "remove.ok.delete", "remove.ok.hold_blind", "remove.ok.no_inbox",
  "deleteBot.deferred", "reconnect.deferred", "tryAgain.ok", "tryAgain.nothing", "owner.other",
  "answer.unknown", "answer.krest", "answer.kget.success", "answer.kget.rollback", "answer.del.ok", "answer.del.other", "answer.gget.closing", "answer.gget.active", "answer.list",
  "event.closing.delete_guarded", "event.closing.flux", "event.closing.other", "event.deleted", "event.restored", "listing.discover", "guardPoll",
];

type WaitKind = "krest" | "kget" | "del" | "gget" | "list";
interface Wait { k: WaitKind; keepOp?: OpId; inboxId?: InboxId; removalId?: string; at: number }
interface X { seq: number; tok: number; epoch: number; blind: boolean; parkTok?: Record<string, number>; waits: Record<string, Wait>; kst: Record<OpId, "restore" | "get"> }
type LocalX = LocalDb & { x?: X };

const clone = <T>(v: T): T => structuredClone(v);
const xOf = (l: LocalDb): X => { const L = l as LocalX; if (!L.x) L.x = { seq: 0, tok: 0, epoch: 0, blind: false, waits: {}, kst: {} }; return L.x; };
const vals = <T>(r: Record<string, T>): T[] => Object.keys(r).map(k => r[k]);
const MINE = "au:";

class Run {
  s: HomeState; acts: Effect[] = []; readonly hadX: boolean; // hadX: the incoming local database carried no private x (a step that changes nothing must not add one)
  private parkRev0: Record<string, number> = {}; private stamped = new Set<string>();
  readonly now: number; readonly ctx: ReduceCtx;
  constructor(state: HomeState, now: number, ctx: ReduceCtx) { this.now = now; this.ctx = ctx; this.hadX = !!(state.local as LocalX).x; this.s = clone(state); xOf(this.s.local); for (const p of vals(state.local.parks)) if (p.botId !== null) this.parkRev0[p.botId] = p.parkRev; }
  /** r3.4d-s23 (authorityCreatedByValidOwnerAction, "token predates the latest park or restore"): a park (new row, or parkRev moved) kills every owner token of its bot minted up to now.
   *  x.parkTok[bot] = the token counter at the park; a token whose seq is not above it (a seed token has none) is expired. Stamped once per run, before the first snapshot that holds the park. */
  private stampParks(): void {
    for (const p of vals(this.s.local.parks)) {
      if (p.botId === null || this.stamped.has(p.botId) || this.parkRev0[p.botId] === p.parkRev) continue;
      this.stamped.add(p.botId); const x = this.x; (x.parkTok ??= {})[p.botId] = x.tok;
    }
  }
  get x(): X { return xOf(this.s.local); }
  hit(id: string): void { this.ctx.hit(id); }
  durable(write: DurableWrite): void { this.stampParks(); this.acts.push({ k: "durable", write, after: clone(this.s) }); }
  /** the last durable effect must equal the final state (harness consistency check): add a closing write if anything changed since. */
  finish(write: DurableWrite = "W21_completion"): ReduceResult {
    this.stampParks();
    const ds = this.acts.filter(a => a.k === "durable") as { after: HomeState }[];
    if (ds.length && JSON.stringify(ds[ds.length - 1].after) !== JSON.stringify(this.s)) this.durable(write);
    return { actions: this.acts, state: this.s };
  }
  uid(prefix: string): string { const x = this.x; x.tok++; return prefix + this.s.proc.processId + "." + this.now + "." + x.tok; }
  /** stage a request: predict its id, remember what the answer means; the caller makes it durable and then pushes the send. */
  stage(w: Omit<Wait, "at">): string { const x = this.x; x.seq++; const id = "r" + x.seq; x.waits[id] = { ...w, at: this.now }; return id; }
  send(request: SendRequest): void { this.acts.push({ k: "send", request }); }
}

// ---------------- tokens: self-describing ids, minted only in owner steps (STUB-R3-1: bind to exact inbox id, key ids, address shown) ----------------
// id = t|<kind b/p/r>|<proc>|<epoch>|<mintedAtMs>|<seq>|<botId>|<serial-or-rev>|<target>
function mintToken(R: Run, kind: "b" | "p" | "r", botId: string | null, ver: number | string, target: string | null): TokenId {
  return ["t", kind, R.s.proc.processId, R.x.epoch, R.now, ++R.x.tok, botId ?? "-", ver, target ?? "-"].join("|");
}
function tokenInfo(R: Run, id: TokenId | null): { kind: string; botId: string; target: string | null; ver: string } | "expired" | null {
  if (id === null) return null;
  const p = id.split("|");
  if (p.length < 9 || p[0] !== "t") return "expired";
  const [, kind, proc, epoch, at, seq, botId, ver, ...rest] = p;
  const target = rest.join("|") === "-" ? null : rest.join("|");
  if (Number(proc) !== R.s.proc.processId || Number(epoch) !== R.x.epoch || R.now > Number(at) + TOKEN_TTL_MS) return "expired";
  const stamp = R.x.parkTok?.[botId]; if (stamp !== undefined && !(Number(seq) > stamp)) return "expired"; // minted at or before the bot's latest park
  if (kind === "b") { const b = R.s.local.bindings[botId]; if (!b || String(b.gen.serial) !== ver) return "expired"; }
  if (kind === "p") { const pk = R.s.local.parks[botId]; if (!pk || String(pk.parkRev) !== ver) return "expired"; }
  return { kind, botId, target, ver };
}

const keysOfBinding = (b: Binding | undefined): string[] => (b && b.gen.emailKeyRef ? [b.gen.emailKeyRef] : []);
const inboxOfTarget = (t: string): InboxId | null => (t.startsWith("inbox:") ? t.slice(6) : null);
const targetOfBinding = (b: Binding): string => (b.gen.inboxId ? inboxTarget(b.gen.inboxId) : botTarget(b.botId));

// ---------------- surface ----------------
function render(R: Run, mint: boolean, principalOwner: boolean, onlyR = false): void {
  const L = R.s.local, rows: SurfaceRow[] = [], prev = R.s.surface;
  const reuse = (key: string, kind: string): TokenId | null => {
    for (const r of prev) if (r.visible && (r.target ?? "") + "|" + r.section === key) for (const a of r.actions) if (a.kind === kind && a.tokenId && tokenInfo(R, a.tokenId) !== "expired") return a.tokenId;
    return null;
  };
  const tk = (kind: "b" | "p" | "r", bot: string | null, ver: number | string, target: string | null, section: string, act: string): TokenId | null => {
    if (mint && principalOwner && (!onlyR || kind === "r")) return mintToken(R, kind, bot, ver, target);
    return reuse((target ?? "") + "|" + section, act);
  };
  for (const b of vals(L.bindings)) {
    if (b.state === "removal_parked") continue;
    const target = targetOfBinding(b);
    rows.push({
      section: "bot", target, botId: b.botId, inboxId: b.gen.inboxId, keyIds: keysOfBinding(b), provisionOpId: b.gen.inboxId === null ? b.gen.opId : null, address: b.address, visible: true,
      line: "Email for this bot", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: tk("b", b.botId, b.gen.serial, target, "bot", "remove"), enabled: true }],
    });
  }
  for (const p of vals(L.parks)) {
    rows.push({
      section: "parked", target: p.target, botId: p.botId, inboxId: p.inboxId, keyIds: p.keyTargets.map(k => k.keyId), provisionOpId: p.provisionOpId, address: p.address, visible: true, line: "Email removal on hold",
      actions: [{ kind: "keep", tokenId: tk("p", p.botId, p.parkRev, p.target, "parked", "keep"), enabled: true }, { kind: "remove", tokenId: tk("p", p.botId, p.parkRev, p.target, "parked", "remove"), enabled: true }],
    });
  }
  if (R.x.blind) // STUB-R3-5: a blind restore keeps unknown keys live and asks the owner to confirm; discovery runs when the listing exists
    rows.push({ section: "restore_check", target: null, botId: null, inboxId: null, keyIds: [], provisionOpId: null, address: null, visible: true, line: "Check your email setup", actions: [{ kind: "confirm_inventory", tokenId: tk("r", null, 0, null, "restore_check", "confirm_inventory"), enabled: true }] });
  // r3.4d J1 (R1): every owner view shows the home line while the window is open; an aborted, uncleared job shows the failed line.
  const jw = R.s.fs.restoreJob ?? null;
  if (jw && jobOpen(R.s)) rows.push(homeRow(RESTORE_FINISHING_LINE)); else if (jw && jw.phase === "aborted") rows.push(homeRow(RESTORE_FAILED_LINE));
  R.s.surface = rows;
}

// ---------------- the restore job (r3.4d J1: arm, capture, abort; swap / prepare / clear are J2) ----------------
/** the window is the job's open phases armed, captured, swapped (R1). */
const jobOpen = (s: HomeState): boolean => { const p = jobPhaseOf(s); return p === "armed" || p === "captured" || p === "swapped"; }; // the EFFECTIVE phase: the journal, or the marks W27 / W28
const homeRow = (line: string): SurfaceRow => ({ section: "home", target: null, botId: null, inboxId: null, keyIds: [], provisionOpId: null, address: null, visible: true, line, actions: [] });
const setHomeLine = (R: Run, line: string): void => { R.s.surface = R.s.surface.filter(r => r.section !== "home").concat(homeRow(line)); };
/** a window or finished-job refusal: restore_finishing, changing nothing but the surface (no durable effect). */
function refuseFinishing(R: Run, hit: string): ReduceResult {
  R.hit(hit); setHomeLine(R, RESTORE_FINISHING_LINE); R.acts.push({ k: "ownerResult", ok: false, code: "restore_finishing" }); return R.finish();
}
function ownerRestore(R: Run, e: Extract<HomeEvent, { e: "ownerRestore" }>): ReduceResult {
  const a = e.action, j = R.s.fs.restoreJob ?? null;
  if (j) return refuseFinishing(R, jobOpen(R.s) ? "restore.refuse_window" : "restore.refuse_finished"); // open: window; prepared / aborted not yet cleared: S20 (r3.4c L3)
  if (!(R.s.fs.localArchives ?? []).includes(a.archiveId)) { R.hit("restore.refuse_not_local"); R.acts.push({ k: "ownerResult", ok: false, code: "archive_not_local" }); return R.finish(); }
  R.hit("restore.arm");
  R.s.fs = { ...R.s.fs, restoreJob: { id: R.uid("job"), archiveId: a.archiveId, source: a.source, phase: "armed", at: e.step } };
  R.acts.push({ k: "ownerResult", ok: true });
  R.durable("W25_job_armed");
  return R.finish();
}
function buildCarry(R: Run, step: number, jobId: string): CarryRecord {
  const L = R.s.local;
  return {
    carryId: R.uid("carry"), capturedAtStep: step, forEpoch: R.x.epoch, complete: true,
    keyIds: [...locallyReferencedKeys(L)], inboxIds: [...locallyReferencedInboxes(L)], provisionOps: [...locallyReferencedOps(L)],
    keepGuards: clone(vals(L.keepGuards)), keptKeys: clone(L.keptKeys),
    outstandingDeletes: vals(L.leases).flatMap(l => (l.inboxId ? l.attempts.map(at => ({ inboxId: l.inboxId as string, attemptId: at })) : [])),
    removals: queuedRemovals(L), blindPending: R.x.blind, unconfirmedKept: clone(L.unconfirmedKept ?? {}), jobId,
  };
}
/** capture: only the ARMED job; the carry first (W23), then phase captured (W26). Anything else changes nothing (the harness never offers it). */
function captureOutgoing(R: Run, e: Extract<HomeEvent, { e: "captureOutgoing" }>): ReduceResult {
  const j = R.s.fs.restoreJob ?? null;
  if (!j || jobPhaseOf(R.s) !== "armed") { R.hit("restore.capture_refused"); return R.finish(); }
  R.hit("restore.capture");
  R.s.carry = buildCarry(R, e.step, j.id);
  R.durable("W23_carry_capture");
  R.s.fs = { ...R.s.fs, restoreJob: { ...j, phase: "captured", at: e.step } };
  R.durable("W26_job_captured");
  return R.finish();
}
/** abort: only from armed or captured; writes phase aborted (W29) and nothing else but the home line. */
function restoreAbort(R: Run, e: Extract<HomeEvent, { e: "restoreAbort" }>): ReduceResult {
  const j = R.s.fs.restoreJob ?? null;
  if (!j || (jobPhaseOf(R.s) !== "armed" && jobPhaseOf(R.s) !== "captured")) { R.hit("restore.abort_refused"); return R.finish(); }
  R.hit("restore.abort");
  R.s.fs = { ...R.s.fs, restoreJob: { ...j, phase: "aborted", at: e.step } };
  setHomeLine(R, RESTORE_FAILED_LINE);
  R.durable("W29_job_aborted");
  return R.finish();
}

/** system restore (nobody asked): arms its job exactly like an owner request, but only when no job exists; it is never a window refusal. */
function restoreArm(R: Run, e: Extract<HomeEvent, { e: "restoreArm" }>): ReduceResult {
  if (R.s.fs.restoreJob || !(R.s.fs.localArchives ?? []).includes(e.archiveId)) { R.hit("restore.arm_system_refused"); return R.finish(); }
  R.hit("restore.arm_system");
  R.s.fs = { ...R.s.fs, restoreJob: { id: R.uid("job"), archiveId: e.archiveId, source: e.source, phase: "armed", at: e.step } };
  R.durable("W25_job_armed");
  return R.finish();
}
/** clear: only a finished (prepared or aborted) job; the carry is deleted first (W24), then the journal is unlinked (W30). */
function restoreJobClear(R: Run, _e: Extract<HomeEvent, { e: "restoreJobClear" }>): ReduceResult {
  const ph = jobPhaseOf(R.s);
  if (ph !== "prepared" && ph !== "aborted") { R.hit("restore.clear_refused"); return R.finish(); }
  R.hit("restore.clear");
  if (R.s.carry) { R.s.carry = null; R.durable("W24_carry_delete"); }
  R.s.fs = { ...R.s.fs, restoreJob: null };
  R.s.surface = R.s.surface.filter(r => !(r.section === "home" && r.line === RESTORE_FAILED_LINE)); // the failed line shows with the aborted job
  R.durable("W30_job_cleared");
  return R.finish();
}
/** archive fetch (before any arm, M-3): a verified one makes the archive local; a failed one changes nothing and shows the failed line only when it serves an owner's request (forOwner). A job's own archive is frozen. */
function archiveFetch(R: Run, e: Extract<HomeEvent, { e: "archiveFetch" }>): ReduceResult {
  if (!R.hadX) delete (R.s.local as LocalX).x; // a fetch touches no database: nothing but fs.localArchives and the surface may change
  const j = R.s.fs.restoreJob ?? null;
  if (j) { R.hit("fetch.frozen"); return R.finish(); }
  if (e.outcome === "verified") {
    R.hit("fetch.verified");
    const la = R.s.fs.localArchives ?? [], add = [e.archiveId, e.archiveId + NO_LIVE_SUFFIX].filter(x => !la.includes(x));
    R.s.fs = { ...R.s.fs, localArchives: [...la, ...add] };
    return R.finish();
  }
  R.hit("fetch.download_failed");
  if (e.forOwner) setHomeLine(R, RESTORE_FAILED_LINE); else R.s.surface = R.s.surface.filter(r => !(r.section === "home" && r.line === RESTORE_FAILED_LINE));
  return R.finish();
}

// ---------------- parking (STUB-R3-2 carry: queued-removal state and evidence preserved) ----------------
function parkBinding(R: Run, b: Binding, origin: Park["origin"], evidence: boolean, keyTargets: KeyTarget[]): boolean {
  const L = R.s.local, prior = L.parks[b.botId];
  // r3.4d-s23 (page S14, MurageMain 2026-11-11): a kept target is never parked again by a step other than a restore: REFUSED, visibly (hit park.refused_kept), never a silent no-op.
  if (origin !== "restore" && keysOfBinding(b).some(k => L.keptKeys[k])) { R.hit("park.refused_kept"); return false; }
  const kt = [...(prior?.keyTargets ?? [])];
  for (const t of keyTargets) if (!kt.some(k => k.keyId === t.keyId)) kt.push(t);
  if (!kt.length) for (const k of keysOfBinding(b)) kt.push({ keyId: k, status: "pending" });
  if (prior) { prior.keyTargets = kt; if (evidence && prior.state === "parked") { prior.state = "parked_evidence"; prior.parkRev++; } b.state = "removal_parked"; return true; }
  const target = targetOfBinding(b);
  L.parks[b.botId] = { parkId: b.botId, botId: b.botId, parkRev: 1, origin, state: evidence ? "parked_evidence" : "parked", target, inboxId: b.gen.inboxId, provisionOpId: b.gen.inboxId === null ? b.gen.opId : null, gen: clone(b.gen), address: b.address, keyTargets: kt, remoteDeletedAtMs: evidence ? R.now : null };
  b.state = "removal_parked";
  return true;
}
/** Boot, settle and tick: nothing automatic finishes a removal no owner authority of this reducer backs (legacy 1.0.18, mid-flight, foreign). */
function parkUnauthorized(R: Run): boolean {
  const L = R.s.local; let changed = false;
  for (const b of vals(L.bindings)) {
    if (b.state !== "removing" && b.state !== "remove_requested") continue;
    const lease = vals(L.leases).find(l => l.botId === b.botId);
    if (lease && lease.authorityId.startsWith(MINE)) continue;
    if (vals(L.keepOps).some(k => k.target === targetOfBinding(b))) continue; // r3.4d-s23: the owner's Keep in flight on this target wins; nothing parks it (a park would make the Keep's own RESTORE an automatic unpark)
    R.hit("tick.park_unauthorized");
    if (!parkBinding(R, b, "legacy", lease?.phase === "gone" || L.intents[b.botId]?.deletionProof === true, lease?.keyTargets ?? [])) continue;
    if (lease) delete L.leases[lease.removalId];
    delete L.intents[b.botId];
    changed = true;
  }
  return changed;
}

// ---------------- network helpers ----------------
function sendKeepStep(R: Run, keepOp: OpId, kind: "RESTORE_INBOX" | "GET_INBOX", inboxId: InboxId): void {
  R.stage({ k: kind === "RESTORE_INBOX" ? "krest" : "kget", keepOp, inboxId });
  R.x.kst[keepOp] = kind === "RESTORE_INBOX" ? "restore" : "get";
  R.durable("W11_send_claim");
  R.send({ kind, purpose: "keep", target: inboxId, credential: "owner", removalId: null, attemptId: null, authorityId: null, keepOp });
}
function sendDelete(R: Run, removalId: string): void {
  const L = R.s.local, l = L.leases[removalId], attempt = R.uid("at");
  l.phase = "sending"; l.attemptId = attempt; l.attempts.push(attempt);
  R.stage({ k: "del", removalId, inboxId: l.inboxId ?? undefined });
  R.durable("W11_send_claim");
  R.send({ kind: "DELETE_INBOX", purpose: "removal", target: l.inboxId as string, credential: "owner", removalId, attemptId: attempt, authorityId: l.authorityId, keepOp: null, botHint: l.botId, deleteReason: "owner" });
}
function sendGuardGet(R: Run, g: KeepGuard): void {
  g.lastCheckedAtMs = R.now;
  R.stage({ k: "gget", inboxId: g.inboxId });
  R.durable("W20_keep_guard");
  R.send({ kind: "GET_INBOX", purpose: "guard", target: g.inboxId, credential: "owner", removalId: null, attemptId: null, authorityId: null, keepOp: null });
}
/** STUB-R3-4: a guard repair re-claims a fresh keep op (no new ghost Keep) so the RESTORE is always under a claim (guard-purpose sends need an ops alert in the same step). */
function startGuardRestore(R: Run, g: KeepGuard): void {
  const L = R.s.local;
  if (vals(L.keepOps).some(k => k.inboxId === g.inboxId) || vals(L.leases).some(l => l.inboxId === g.inboxId) || vals(L.parks).some(p => p.inboxId === g.inboxId)) return;
  const op = R.uid("kg:");
  L.keepOps[op] = { keepOp: op, botId: g.botId, target: inboxTarget(g.inboxId), inboxId: g.inboxId, mode: "live", authorityId: g.keepOp, claimedAtStep: 0 };
  R.hit("answer.gget.closing");
  R.durable("W13_keep_claim");
  sendKeepStep(R, op, "RESTORE_INBOX", g.inboxId);
}

// ---------------- owner actions ----------------
function ownerKeep(R: Run, a: Extract<Action, { t: "owner.keep" }>): ReduceResult {
  const L = R.s.local, t = a.target, inboxId = inboxOfTarget(t), bind = L.bindings[a.botId], park = L.parks[a.botId];
  const keepsOnT = vals(L.keepOps).some(k => k.target === t), leasesOnT = vals(L.leases).filter(l => l.target === t);
  const parksOnT = vals(L.parks).filter(p => p.target === t);
  const needsToken = a.mode === "orphan" || a.mode === "key_only";
  const ti = tokenInfo(R, a.tokenId);
  const tokenBad = a.tokenId === null ? needsToken : ti === "expired" || ti === null || ti.target !== t || (ti.kind !== "b" && ti.kind !== "p") || (ti.kind === "b" && (!bind || bind.state === "removal_parked")); // a b token dies with its binding's park (lastParkOrRestoreStep)
  const gone = parksOnT.some(p => p.state === "parked_evidence") || leasesOnT.some(l => l.phase === "gone") || (!bind && !parksOnT.length && !leasesOnT.length);
  const refuse = (code: string, br: string): ReduceResult => { R.hit(br); R.acts.push({ k: "ownerResult", ok: false, code }); return R.finish(); };
  // r3.4d-s23 (r3.3b ruling): an UNTOKENED bot-row Keep (bot_section / live / flux_closing) is the owner's choice on the bot's CURRENT live row. If the
  // target is not that row's target (the screen is stale), refuse confirm_expired, pure, and put the look-again line on the bot's own row.
  const liveT = bind && bind.state !== "removal_parked" ? (bind.gen.inboxId ? inboxTarget(bind.gen.inboxId) : botTarget(a.botId)) : null;
  const staleUntokened = !needsToken && a.tokenId === null && (liveT === null || liveT !== t || parksOnT.length > 0);
  if (staleUntokened) {
    R.hit("keep.refuse.confirm_expired");
    render(R, false, true); // reuse-only (no minting): the owner's screen is rebuilt so the bot's own row exists to carry the line
    let carried = false;
    for (const r of R.s.surface) if (r.visible && r.section === "bot" && r.botId === a.botId) { r.line = LOOK_AGAIN_LINE; carried = true; }
    if (!carried) R.s.surface.push({ section: "bot", target: botTarget(a.botId), botId: a.botId, inboxId: null, keyIds: [], provisionOpId: null, address: null, visible: true, line: LOOK_AGAIN_LINE, actions: [] });
    R.acts.push({ k: "ownerResult", ok: false, code: "confirm_expired" });
    return R.finish();
  }
  if (keepsOnT) return refuse("keep_pending", "keep.refuse.keep_pending");
  if (leasesOnT.some(l => l.phase === "sending")) return refuse("removal_sending", "keep.refuse.removal_sending");
  if (tokenBad) return refuse("confirm_expired", "keep.refuse.confirm_expired");
  if (gone) return refuse("inbox_gone", "keep.refuse.inbox_gone");
  // r3.4d-s23 (admissionPinned): bot_present only when a present, un-parked binding still names this inbox and no park holds the target; otherwise a valid token is admitted.
  if (needsToken && inboxId !== null && !parksOnT.length && vals(L.bindings).some(b2 => b2.state !== "removal_parked" && b2.gen.inboxId === inboxId)) return refuse("bot_present", "keep.refuse.bot_present");
  // r3.4d-fix-s1: a target other than the binding's own, with no park or lease on it, is stale (a bot bound to an inbox is not kept as bot:<id>). MUTANT keep-stale-target-accepted
  if (bind && t !== targetOfBinding(bind) && !parksOnT.length && !leasesOnT.length) return refuse("inbox_gone", "keep.refuse.inbox_gone");
  // STUB-R3-6: Keep creates its authority, its operation and its history, never a no-op ok.
  const keyIds = park ? park.keyTargets.map(k => k.keyId) : keysOfBinding(bind);
  const authorityId = R.uid(MINE), keepOp = R.uid("kp:");
  R.acts.push({ k: "authorize", authorityId, kind: "keep", tokenId: a.tokenId, botId: a.botId, inboxId, keyIds });
  L.keepOps[keepOp] = { keepOp, botId: a.botId, target: t, inboxId, mode: a.mode, authorityId, claimedAtStep: 0 };
  for (const l of leasesOnT) l.phase = "keeping";
  if (park) { park.state = "keep_pending"; park.parkRev++; }
  R.durable("W13_keep_claim");
  R.acts.push({ k: "keep", keepOp, botId: a.botId, inboxId, mode: a.mode, authorityId, phase: "claimed" });
  R.acts.push({ k: "ownerResult", ok: true });
  if (inboxId === null) {
    R.hit("keep.ok.key_only");
    delete L.keepOps[keepOp];
    for (const k of keyIds) L.keptKeys[k] = authorityId;
    for (const l of leasesOnT) delete L.leases[l.removalId];
    if (park) delete L.parks[a.botId];
    // r3.4d-fix-s1 (page S1): a key-only Keep success resets EVERY binding on its target, as the inbox Keep does (none is left removing without a lease). MUTANT keep-key-only-resets-parked-only
    for (const b2 of vals(L.bindings)) {
      if (targetOfBinding(b2) !== t && b2.botId !== a.botId) continue;
      if (b2.state === "removal_parked" || b2.state === "removing" || b2.state === "remove_requested") b2.state = "active";
      delete L.intents[b2.botId];
    }
    R.durable("W14_keep_done");
    R.acts.push({ k: "keep", keepOp, botId: a.botId, inboxId: null, mode: a.mode, authorityId, phase: "succeeded" });
    render(R, false, true);
    return R.finish();
  }
  R.hit("keep.ok.inbox");
  render(R, false, true);
  sendKeepStep(R, keepOp, "RESTORE_INBOX", inboxId);
  return R.finish();
}

function ownerRemove(R: Run, a: Extract<Action, { t: "owner.remove" }>): ReduceResult {
  const L = R.s.local, t = a.target, inboxId = inboxOfTarget(t), bind = L.bindings[a.botId ?? ""];
  const refuse = (code: string, br: string): ReduceResult => { R.hit(br); R.acts.push({ k: "ownerResult", ok: false, code }); return R.finish(); };
  if (vals(L.keepOps).some(k => k.target === t)) return refuse("keep_pending", "remove.refuse.keep_pending");
  const ti = tokenInfo(R, a.tokenId);
  if (a.tokenId === null || ti === "expired" || ti === null || ti.target !== t) return refuse("confirm_expired", "remove.refuse.confirm_expired");
  // r3.4d-s23 (admissionPinned, bot_present precondition): refuse bot_present ONLY for the other-setup / key-only sections whose target a present, un-parked binding still names
  // (no park holds the target). A valid token on any other section (the bot's own, a parked row) is the owner's real choice and is admitted.
  const premise = (a.section === "other_setup" || a.section === "key_only") && inboxId !== null && !vals(L.parks).some(p => p.target === t) && vals(L.bindings).some(b2 => b2.state !== "removal_parked" && b2.gen.inboxId === inboxId);
  if (premise) return refuse("bot_present", "remove.refuse.bot_present");
  // a b token dies with its binding's park; a p token is the owner's choice on the parked row and is admitted (the park leaves "parked" for remove_authorized)
  const parkOfTok = ti.kind === "p" ? L.parks[a.botId as string] : undefined;
  if (!bind || (ti.kind === "b" && bind.state === "removal_parked") || (ti.kind === "p" && !parkOfTok)) return refuse("confirm_expired", "remove.refuse.confirm_expired");
  const keyIds = ti.kind === "p" ? (L.parks[a.botId as string]?.keyTargets.map(k => k.keyId) ?? []) : keysOfBinding(bind);
  const authorityId = R.uid(MINE);
  const grant = (): void => { R.acts.push({ k: "authorize", authorityId, kind: ti.kind === "p" ? "remove_park" : "remove_bot_section", tokenId: a.tokenId, botId: a.botId, inboxId, keyIds }); R.acts.push({ k: "ownerResult", ok: true }); }; // recorded before the W10 write (a crash before that write rolls them back, see moves.ts react)
  delete L.keepGuards[inboxId ?? ""]; // guardDiesOnFreshRemove: same step as the authority
  if (inboxId === null) { R.hit("remove.ok.no_inbox"); const rid = R.uid("rm:"); L.leases[rid] = { removalId: rid, target: t, inboxId: null, botId: a.botId, authorityId, foreign: false, phase: "authorized", attemptId: null, attempts: [], keyTargets: keyIds.map(k => ({ keyId: k, status: "pending" as const })) }; grant(); R.durable("W10_authorize"); render(R, false, true); return R.finish("W10_authorize"); } // the owner's Remove always leaves removal work (a lease) naming its authority; with no inbox there is nothing to DELETE (drive skips it)
  const heldLease = vals(L.leases).find(l => l.target === t);
  if (heldLease) { // r3.4d-s23 (admissionPinned): the owner's fresh Remove authority takes over the lease already on the target: a NEW lease row naming it, carrying the old one's attempts and phase; no second DELETE is sent
    const removalId = R.uid("rm:");
    delete L.leases[heldLease.removalId];
    L.leases[removalId] = { ...heldLease, removalId, authorityId, foreign: false };
    for (const w of vals(R.x.waits)) if (w.removalId === heldLease.removalId) w.removalId = removalId;
    grant(); R.durable("W10_authorize"); render(R, false, true); return R.finish("W10_authorize");
  }
  const removalId = R.uid("rm:");
  L.leases[removalId] = { removalId, target: t, inboxId, botId: a.botId, authorityId, foreign: false, phase: "authorized", attemptId: null, attempts: [], keyTargets: keyIds.map(k => ({ keyId: k, status: "pending" as const })) };
  bind.state = "removing";
  if (parkOfTok) { parkOfTok.state = "remove_authorized"; parkOfTok.parkRev++; }
  grant(); R.durable("W10_authorize");
  if (R.x.blind) { R.hit("remove.ok.hold_blind"); render(R, false, true); return R.finish("W10_authorize"); } // STUB-R3-5: no destructive send before the owner confirms
  R.hit("remove.ok.delete");
  render(R, false, true);
  sendDelete(R, removalId);
  return R.finish();
}

// ---------------- answers ----------------
function onAnswer(R: Run, e: Extract<HomeEvent, { e: "answer" }>): ReduceResult {
  const L = R.s.local, x = R.x;
  let w: Wait | undefined = x.waits[e.requestId];
  if (!w) { // unknown id (stale, duplicate, request of an earlier process, or id drift after a crash): attribute to the single open keep op, else ignore
    const open = vals(L.keepOps);
    const stage = open.length === 1 ? x.kst[open[0].keepOp] : undefined;
    if (open.length === 1 && stage && !vals(x.waits).some(v => v.keepOp === open[0].keepOp)) w = { k: stage === "restore" ? "krest" : "kget", keepOp: open[0].keepOp, inboxId: open[0].inboxId ?? undefined, at: 0 };
    else { R.hit("answer.unknown"); return R.finish(); }
  } else delete x.waits[e.requestId];
  if (w.k === "krest") {
    R.hit("answer.krest");
    const op = w.keepOp as string;
    if (!L.keepOps[op]) return R.finish();
    sendKeepStep(R, op, "GET_INBOX", w.inboxId as string);
    return R.finish();
  }
  if (w.k === "kget") {
    const op = w.keepOp as string, k = L.keepOps[op];
    if (!k) return R.finish();
    const bind = L.bindings[k.botId], park = L.parks[k.botId];
    if (e.answer === "ok" && e.fluxStateSeen === "active") {
      R.hit("answer.kget.success");
      delete L.keepOps[op]; delete x.kst[op];
      for (const l of vals(L.leases)) if (l.target === k.target) delete L.leases[l.removalId];
      const keyIds = park ? park.keyTargets.map(t => t.keyId) : keysOfBinding(bind);
      for (const key of keyIds) L.keptKeys[key] = k.authorityId;
      if (park) delete L.parks[k.botId];
      // r3.4d-s23 (page S1, MurageMain 2026-11-11): Keep success resets EVERY binding on the target (none is left removing without a lease).
      for (const b2 of vals(L.bindings)) {
        if (targetOfBinding(b2) !== k.target && b2.botId !== k.botId) continue;
        if (b2.state === "removal_parked" || b2.state === "removing" || b2.state === "remove_requested") b2.state = "active";
        delete L.intents[b2.botId];
      }
      // STUB-R3-3: guard.unresolved is "unknown" and is never shrunk except by a real resolution (a Remove or a purge deletes the row)
      L.keepGuards[k.inboxId as string] = { inboxId: k.inboxId as string, botId: k.botId, gen: clone(bind?.gen ?? park?.gen ?? { inboxId: k.inboxId, opId: null, emailKeyRef: null, serial: 1 }), keepOp: op, keptAtMs: R.now, pollUntilMs: R.now + GUARD_POLL_WINDOW_MS, unresolved: "unknown", lastCheckedAtMs: null };
      R.durable("W14_keep_done");
      R.acts.push({ k: "keep", keepOp: op, botId: k.botId, inboxId: k.inboxId, mode: k.mode, authorityId: k.authorityId, phase: "succeeded", confirmedBy: { requestId: e.requestId, state: "active" } });
      render(R, false, false);
      return R.finish();
    }
    R.hit("answer.kget.rollback");
    delete L.keepOps[op]; delete x.kst[op];
    if (park) { park.state = park.remoteDeletedAtMs !== null ? "parked_evidence" : "parked"; park.parkRev++; }
    for (const l of vals(L.leases)) if (l.target === k.target && l.phase === "keeping") l.phase = "acked";
    R.durable("W15_keep_rollback");
    render(R, false, false);
    return R.finish();
  }
  if (w.k === "del") {
    const l = L.leases[w.removalId as string];
    if (!l) return R.finish();
    if (e.answer === "ok" || e.answer === "not_found") { // STUB-R3-8: a duplicate DELETE (already_closing) resolves the same way; no second closing is assumed
      R.hit("answer.del.ok");
      l.phase = "acked";
      const b = L.bindings[l.botId ?? ""]; if (b && b.state === "removing") b.state = "remove_requested";
      R.durable("W12_delete_answer");
    } else { R.hit("answer.del.other"); l.phase = "unknown"; R.durable("W12_delete_answer"); }
    render(R, false, false);
    return R.finish();
  }
  if (w.k === "gget") {
    const g = L.keepGuards[w.inboxId as string];
    if (g && e.answer === "ok" && e.fluxStateSeen === "closing") { startGuardRestore(R, g); render(R, false, false); return R.finish(); }
    R.hit("answer.gget.active");
    return R.finish();
  }
  R.hit("answer.list");
  return R.finish();
}

// ---------------- tick / guard polling ----------------
function drive(R: Run, polls: boolean): void {
  const L = R.s.local, x = R.x;
  if (parkUnauthorized(R)) R.durable("W22_key_only_park");
  for (const id of Object.keys(x.waits)) if (R.now - x.waits[id].at > 10 * 60_000) delete x.waits[id];
  for (const op of vals(L.keepOps)) {
    if (vals(x.waits).some(w => w.keepOp === op.keepOp) || op.inboxId === null) continue;
    R.hit("tick.reissue_keep");
    sendKeepStep(R, op.keepOp, x.kst[op.keepOp] === "get" ? "GET_INBOX" : "RESTORE_INBOX", op.inboxId);
  }
  if (!x.blind) for (const l of vals(L.leases)) {
    if (!l.authorityId.startsWith(MINE) || l.phase === "acked" || l.phase === "keeping" || l.phase === "gone" || l.inboxId === null) continue;
    if (vals(x.waits).some(w => w.removalId === l.removalId)) continue;
    R.hit("tick.reissue_delete");
    sendDelete(R, l.removalId);
  }
  if (polls) for (const g of vals(L.keepGuards)) {
    if (R.now >= g.pollUntilMs || (g.lastCheckedAtMs !== null && R.now - g.lastCheckedAtMs < GUARD_POLL_MS)) continue;
    if (vals(L.keepOps).some(k => k.inboxId === g.inboxId)) continue;
    R.hit("tick.guard_poll");
    sendGuardGet(R, g);
  }
}

function wakeups(s: HomeState, _now: number): number[] {
  const L = s.local, x = (L as LocalX).x, out: number[] = [];
  for (const g of vals(L.keepGuards)) if (g.pollUntilMs > (g.lastCheckedAtMs ?? g.keptAtMs)) out.push(Math.min(g.pollUntilMs, (g.lastCheckedAtMs ?? g.keptAtMs) + GUARD_POLL_MS));
  for (const w of vals(x?.waits ?? {})) out.push(w.at + 10 * 60_000 + 1);
  return out;
}

// ---------------- restore: swap and prepare are two steps (r3.4d J2) ----------------
/** swap: only the job's own archive, from captured (or armed when blind), and only a local one (M-3). The incoming database is staged with
 *  swappedJobId (W27, the live home unchanged), then renamed into place (W3) with the outgoing guards, kept keys, parks, bindings and intents merged in. */
function restoreSwap(R: Run, e: Extract<HomeEvent, { e: "restoreSwap" }>): ReduceResult {
  const j = R.s.fs.restoreJob ?? null, ph = jobPhaseOf(R.s);
  if (!j || j.archiveId !== e.archiveId || j.source !== e.source || !(ph === "captured" || (ph === "armed" && e.blind))) { R.hit("restore.swap_refused"); return R.finish(); }
  if (!(R.s.fs.localArchives ?? []).includes(j.archiveId)) { R.hit("restore.swap_not_local"); return R.finish(); }
  const out = e.outgoingDb ? (clone(e.outgoingDb) as LocalX) : null, arch = e.archiveDb ? (clone(e.archiveDb) as LocalX) : null;
  const prevX = clone(R.x);
  const L: LocalX = arch ?? { tablesPresent: true, bindings: {}, intents: {}, parks: {}, leases: {}, keepOps: {}, keepGuards: {}, rotations: {}, pendingLifecycle: [], keptKeys: {}, savedKeys: {} };
  L.tablesPresent = true;
  L.swappedJobId = j.id; L.preparedJobId = null; // the staged database carries the job's mark; an archive's old marks are inert
  R.hit("restore.swap");
  R.durable("W27_job_swapped_staged");
  R.s.local = L;
  L.x = { seq: prevX.seq, tok: prevX.tok, epoch: prevX.epoch + 1, blind: out === null, waits: prevX.waits, kst: {} }; // parkTok restarts: the epoch bump already kills every earlier token
  R.hit(out ? "restore.carry" : "restore.blind");
  // STUB-R3-2: carry preserves the outgoing guards, kept keys, parks and queued-removal state (leases become parks), never dropping evidence.
  if (out) {
    for (const g of vals(out.keepGuards)) L.keepGuards[g.inboxId] = g;
    for (const k of Object.keys(out.keptKeys)) L.keptKeys[k] = out.keptKeys[k];
    for (const p of vals(out.parks)) { const q = L.parks[p.parkId]; if (q) for (const t of q.keyTargets) if (!p.keyTargets.some(k => k.keyId === t.keyId)) p.keyTargets.push(t); L.parks[p.parkId] = p; }
    for (const l of vals(out.leases)) {
      if (l.botId === null || l.foreign) continue;
      const bind = out.bindings[l.botId];
      if (L.parks[l.botId]) { for (const t of l.keyTargets) if (!L.parks[l.botId].keyTargets.some(k => k.keyId === t.keyId)) L.parks[l.botId].keyTargets.push(t); continue; }
      L.parks[l.botId] = { parkId: l.botId, botId: l.botId, parkRev: 1, origin: "restore", state: l.phase === "gone" ? "parked_evidence" : "parked", target: l.target, inboxId: l.inboxId, provisionOpId: null, gen: clone(bind?.gen ?? { inboxId: l.inboxId, opId: null, emailKeyRef: null, serial: 1 }), address: bind?.address ?? null, keyTargets: clone(l.keyTargets), remoteDeletedAtMs: l.phase === "gone" ? R.now : null };
    }
    for (const b of vals(out.bindings)) if (!L.bindings[b.botId] && !L.parks[b.botId]) L.bindings[b.botId] = b; // an outgoing binding the archive lacks stays (never silently lost)
    for (const [bot, k] of Object.entries(out.savedKeys)) if (!(bot in L.savedKeys) || L.savedKeys[bot] === null) L.savedKeys[bot] = k;
    for (const i of vals(out.intents)) if (!L.intents[i.botId]) L.intents[i.botId] = i;
  }
  R.s.fs = { ...R.s.fs, messagesDbPresent: true };
  R.s.proc = { ...R.s.proc, phase: "boot_prep", emailOn: false }; // the swap closes the store: the home restarts into its prep (everyReplacementPreparedBeforeStore)
  R.s.surface = [];
  R.durable("W3_swap_record");
  return R.finish();
}

/** the prep body (shared by the restore prep and the boot prep that finishes a crashed one): park the archive's removals in flight, drop leases, keep ops
 *  and lifecycle rows, re-stamp the carried unconfirmed marks (R2) from the job's OWN carry, and write the job's prepared mark (W28, a row of W4). */
function prepare(R: Run, jobId: string): void {
  const L = R.s.local as LocalX, c = R.s.carry && R.s.carry.jobId === jobId ? R.s.carry : null;
  // archive removals in flight or queued are parked, keeping their evidence, unless the outgoing home had Kept that inbox (Keep wins, R2-Q1)
  for (const b of vals(L.bindings)) {
    if (b.state !== "removing" && b.state !== "remove_requested" && b.state !== "removal_parked") continue;
    if (b.gen.inboxId && L.keepGuards[b.gen.inboxId]) { R.hit("restore.keep_wins"); if (b.state !== "removal_parked") b.state = "active"; continue; }
    R.hit("restore.park_archive_removal");
    const lease = vals(L.leases).find(l => l.botId === b.botId);
    parkBinding(R, b, "restore", lease?.phase === "gone" || L.intents[b.botId]?.deletionProof === true, lease?.keyTargets ?? []);
    delete L.intents[b.botId];
  }
  for (const i of vals(L.intents)) {
    const b = L.bindings[i.botId];
    if (i.phase !== "removed" && b && b.state !== "removal_parked" && !(b.gen.inboxId && L.keepGuards[b.gen.inboxId])) { parkBinding(R, b, "restore", false, []); delete L.intents[i.botId]; }
  }
  for (const k of Object.keys(L.leases)) delete L.leases[k];
  for (const k of Object.keys(L.keepOps)) delete L.keepOps[k];
  L.pendingLifecycle = [];
  if (c?.unconfirmedKept) for (const k of Object.keys(c.unconfirmedKept)) if (k in L.keptKeys) L.unconfirmedKept = { ...(L.unconfirmedKept ?? {}), [k]: c.unconfirmedKept[k] }; // R2 re-stamp
  L.preparedJobId = jobId;
  R.s.proc = { ...R.s.proc, phase: "store_open" }; // the prep opens the store (the boot prep sets the same phase after it)
  R.s.surface = [];
  R.durable("W4_consumer_tx");
}
function restorePrepare(R: Run, _e: Extract<HomeEvent, { e: "restorePrepare" }>): ReduceResult {
  const j = R.s.fs.restoreJob ?? null;
  if (!j || jobPhaseOf(R.s) !== "swapped") { R.hit("restore.prepare_refused"); return R.finish(); }
  R.hit("restore.prepare");
  prepare(R, j.id);
  return R.finish();
}

// ---------------- the reducer ----------------
export function reduceRestore(state: HomeState, event: HomeEvent, ctx: ReduceCtx = NOOP_CTX): ReduceResult {
  const R = new Run(state, event.nowMs, ctx);
  switch (event.e) {
    case "boot": {
      R.hit("boot");
      R.s.proc = { processId: state.proc.processId + 1, phase: "boot_prep", emailOn: false };
      R.s.surface = []; R.x.waits = {};
      R.durable("W1_desktop_prep_tx");
      return R.finish();
    }
    case "bootPrep": {
      if (event.inject === "throw") { R.hit("bootPrep.throw"); return R.finish(); } // the harness injects a throw; production prep never throws
      R.hit("bootPrep.ok");
      if (jobPhaseOf(R.s) === "swapped") { R.hit("bootPrep.prep"); prepare(R, R.s.fs.restoreJob!.id); } // a crash left the swap done and its prep owed: this prep ends the window
      parkUnauthorized(R);
      R.s.proc = { ...R.s.proc, phase: "store_open" };
      R.durable("W6_adoption_tx");
      return R.finish();
    }
    case "emailOn": {
      R.hit("emailOn");
      R.s.proc = { ...R.s.proc, phase: "running", emailOn: true };
      render(R, false, false);
      R.durable("W9_commit_or_orphanize");
      return R.finish();
    }
    case "settle": { R.hit("settle"); if (!jobOpen(R.s)) drive(R, false); render(R, false, false); return R.finish("W16_event_batch"); }
    case "tick": { R.hit("tick"); if (!jobOpen(R.s)) drive(R, true); render(R, false, false); return R.finish("W16_event_batch"); }
    case "guardPoll": {
      R.hit("guardPoll");
      const g = R.s.local.keepGuards[event.inboxId];
      if (g && event.nowMs < g.pollUntilMs && !vals(R.s.local.keepOps).some(k => k.inboxId === g.inboxId) && !(g.lastCheckedAtMs !== null && event.nowMs - g.lastCheckedAtMs < GUARD_POLL_MS)) sendGuardGet(R, g);
      return R.finish();
    }
    case "applyEvent": {
      const ev = event.event, L = R.s.local, g = L.keepGuards[ev.inboxId];
      if (ev.type === "email.inbox.closing") {
        if (g && (ev.reason === "owner" || ev.reason === "bot_deleted")) { R.hit("event.closing.delete_guarded"); startGuardRestore(R, g); render(R, false, false); return R.finish(); }
        R.hit(ev.reason === "owner" || ev.reason === "bot_deleted" ? "event.closing.other" : "event.closing.flux");
        return R.finish();
      }
      if (ev.type === "email.inbox.deleted") { R.hit("event.deleted"); delete L.keepGuards[ev.inboxId]; R.durable("W17_lifecycle_apply"); render(R, false, false); return R.finish(); }
      R.hit("event.restored");
      return R.finish();
    }
    case "answer": return onAnswer(R, event);
    case "listing": {
      R.hit("listing.discover");
      // STUB-R3-5: discovery only parks unknown install-owned inboxes under their bot; it never destroys anything
      const L = R.s.local; let changed = false;
      for (const fi of event.inboxes) {
        if (!fi.installOwned || fi.state === "purged" || !fi.forBot) continue;
        const known = vals(L.bindings).some(b => b.gen.inboxId === fi.inboxId || b.gen.opId === fi.createdUnderOp) || vals(L.parks).some(p => p.inboxId === fi.inboxId);
        if (known || L.parks[fi.forBot]) continue;
        L.parks[fi.forBot] = { parkId: fi.forBot, botId: fi.forBot, parkRev: 1, origin: "legacy", state: "parked", target: inboxTarget(fi.inboxId), inboxId: fi.inboxId, provisionOpId: fi.createdUnderOp, gen: { inboxId: fi.inboxId, opId: fi.createdUnderOp, emailKeyRef: null, serial: 1 }, address: null, keyTargets: [], remoteDeletedAtMs: null };
        changed = true;
      }
      if (changed) { R.durable("W22_key_only_park"); render(R, false, false); }
      return R.finish();
    }
    case "backup": {
      if (jobOpen(R.s)) return refuseFinishing(R, "window.refuse_backup"); // r3.4b (N5): backup is a window decision
      R.hit("backup");
      return { actions: [{ k: "archive", kind: event.kind, topLevelNames: state.fs.messagesDbPresent ? ["messages.db"] : [], db: clone(state.local) }], state };
    }
    case "ownerRestore": return ownerRestore(R, event);
    case "captureOutgoing": return captureOutgoing(R, event);
    case "restoreAbort": return restoreAbort(R, event);
    case "restoreSwap": return restoreSwap(R, event);
    case "restorePrepare": return restorePrepare(R, event);
    case "restoreJobClear": return restoreJobClear(R, event);
    case "restoreArm": return restoreArm(R, event);
    case "archiveFetch": return archiveFetch(R, event);
    case "owner": {
      const a = event.action;
      if (a.t !== "owner.viewSurface" && jobOpen(R.s)) return refuseFinishing(R, "window.refuse_owner");
      if (a.t === "owner.viewSurface") { R.hit("view"); render(R, true, true); return R.finish(); }
      if (a.t === "owner.keep") return ownerKeep(R, a);
      if (a.t === "owner.remove") return ownerRemove(R, a);
      if (a.t === "owner.tryAgainNow") {
        const L = R.s.local, t = a.target;
        // r3.4d-s23 (page S20, MurageMain 2026-11-11): Try again now is for a bot target only; any other target is refused, visibly.
        if (!t.startsWith("bot:")) { R.hit("tryAgain.not_bot"); R.acts.push({ k: "ownerResult", ok: false, code: "not_a_bot_target" }); return R.finish(); }
        const pending = vals(L.keepOps).some(k => k.target === t) || vals(L.leases).some(l => l.target === t) || vals(L.parks).some(p => p.target === t && p.state !== "parked" && p.state !== "parked_evidence");
        if (pending) { R.hit("tryAgain.ok"); R.acts.push({ k: "ownerResult", ok: true }); drive(R, false); return R.finish(); }
        R.hit("tryAgain.nothing"); R.acts.push({ k: "ownerResult", ok: false, code: "nothing_pending" }); return R.finish();
      }
      if (a.t === "owner.deleteBot") { R.hit("deleteBot.deferred"); R.acts.push({ k: "ownerResult", ok: false, code: "deferred" }); return R.finish(); } // STUB-R3-1
      if (a.t === "owner.reconnect") { R.hit("reconnect.deferred"); R.acts.push({ k: "ownerResult", ok: false, code: "deferred" }); return R.finish(); } // STUB-R3-1
      R.hit("owner.other"); R.acts.push({ k: "ownerResult", ok: true }); return R.finish();
    }
  }
}

/** Seed-time surface: what the owner sees before the first step (a seed's rows come from the reducer's own render, never hand-built). */
export function renderSeedSurface(state: HomeState, nowMs: number): SurfaceRow[] { const R = new Run(state, nowMs, NOOP_CTX); render(R, false, true); return R.s.surface; }
export const restoreReducer: Reducer = { name: "restore-reducer-v1", reduce: reduceRestore, wakeups, renderSeedSurface };
