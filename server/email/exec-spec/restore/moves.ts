// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MOVES: enabled(model) lists every scheduler/owner/fault/remote move; apply(model, move) runs it (reducer + FakeFlux + recorder) and
// returns the TraceSteps. Pure: the model is cloned, never mutated. Crash injection: Move fault.crash ARMS a crash at write W (before or
// after); when the reducer's effect list reaches that durable write the harness cuts the list there, applies or drops the write, and
// takes the process down (surface cleared: volatile). Sends before the cut have left the home; effects after it never happen.
//
// TRACE SEGMENTATION: a reducer reaction is one TraceStep (action = the trigger move, next = all durable effects applied), split at
// each send effect: the send becomes its own step with action net.send (prev = world just before the request left). Later durable
// effects after a send form another step attributed to the same trigger. The predicate-visible action for net.listing is auto.tick.

import type { Action, FluxEvent, RemoteRequest, TraceStep, TokenIssue, SurfaceRow, World, DurableWrite } from "./invariants.current.ts";
import { FAULT_MODEL, GUARD_POLL_MS, MARKER_NAME, OWNER_PRINCIPALS, TOKEN_TTL_MS, botTarget, inboxTarget } from "./invariants.current.ts";
import { NO_LIVE_SUFFIX, type Domain } from "./domain.ts";
import * as FF from "./fakeflux.ts";
import type { Effect, Env, HomeEvent, HomeState, Model, Move, Reducer, ReduceCtx } from "./model.ts";
import { asPredicateAction, jobPhaseOf, NOOP_CTX, toWorld } from "./model.ts";

export interface Runtime { domain: Domain; reducer: Reducer; ctx: ReduceCtx; onMove?: (m: Move) => void }

export const ALL_WRITES: readonly DurableWrite[] = [
  "W1_desktop_prep_tx", "W2_marker_staged", "W3_swap_record", "W4_consumer_tx", "W5_marker_unlink", "W6_adoption_tx", "W7_deletion_proof", "W8_save_bots",
  "W9_commit_or_orphanize", "W10_authorize", "W11_send_claim", "W12_delete_answer", "W13_keep_claim", "W14_keep_done", "W15_keep_rollback", "W16_event_batch",
  "W17_lifecycle_apply", "W18_revoke_mark", "W19_secret_clear", "W20_keep_guard", "W21_completion", "W22_key_only_park",
  "W23_carry_capture", "W24_carry_delete", "W25_job_armed", "W26_job_captured", "W27_job_swapped_staged", "W28_job_prepared", "W29_job_aborted", "W30_job_cleared",
];

export const clone = <T>(x: T): T => structuredClone(x);

/** Identity of a move for witnesses/dedup: owner outcomes are results, not inputs, so they are stripped. */
export function moveKey(m: Move): string {
  const c = clone(m) as unknown as Record<string, unknown>;
  if ("outcome" in c && typeof c.outcome === "object") delete c.outcome;
  if (c.t === "auto.restorePrepare") delete c.archiveDb;
  return JSON.stringify(c, Object.keys(c).sort());
}

const budgetUsed = (m: Model): number => m.env.flux.requests.filter(r => r.copyOf === null).length;
const budgetMax = (d: Domain): number => Math.min(12, Object.values(d.maxOutstandingPerKind).reduce((a, b) => a + b, 0));

/** Deadlines (absolute ms) the clock should be able to hit exactly: Flux closing horizons, token expiries, reducer wakeups. */
export function deadlines(m: Model, rt: Runtime): number[] {
  const out = new Set<number>();
  for (const ib of Object.values(m.env.flux.inboxes)) { const u = FF.closingUntil(ib); if (u !== null) out.add(u); }
  for (const t of m.env.ghost.tokens) out.add(t.issuedAtMs + TOKEN_TTL_MS);
  for (const w of rt.reducer.wakeups?.(m.home, m.env.nowMs) ?? []) out.add(w);
  for (const g of Object.values(m.home.local.keepGuards)) { out.add(g.pollUntilMs); }
  return [...out].filter(t => t > m.env.nowMs).sort((a, b) => a - b);
}

export function wakeDue(m: Model, rt: Runtime): boolean {
  return (rt.reducer.wakeups?.(m.home, m.env.nowMs) ?? []).some(t => t <= m.env.nowMs);
}

export function enabled(m: Model, rt: Runtime): Move[] {
  const d = rt.domain, e = m.env, out: Move[] = [], now = e.nowMs, ph = m.home.proc.phase, up = ph === "running";
  // time (explicit boundary events: poll, token TTL, 24 h guard, 30 d purge, plus deadline-1 / deadline of live anchors)
  const jumps = new Set<number>(d.clockJumps);
  for (const t of deadlines(m, rt)) { jumps.add(t - now - 1); jumps.add(t - now); }
  for (const ms of [...jumps].filter(x => x > 0).sort((a, b) => a - b)) if (now + ms <= d.maxNowMs) out.push({ t: "clock.advance", ms });
  // home process phases
  if (ph === "down") out.push({ t: "auto.boot" });
  if (ph === "boot_prep") { out.push({ t: "auto.bootPrep", outcome: "ok" }); } // spec: restore prep never throws (restorePrepNeverThrows); no "threw" outcome is offered }
  if (ph === "store_open") out.push({ t: "auto.emailOn" });
  const room = budgetUsed(m) < budgetMax(d), liveDb = m.home.fs.messagesDbPresent && m.home.local.tablesPresent;
  const jb = m.home.fs.restoreJob ?? null, jph = jb ? jobPhaseOf(m.home) : null, winOpen = jph === "armed" || jph === "captured" || jph === "swapped"; // r3.4d J1: the restore window (effective phase)
  if (up) {
    if (e.ext.settledInProc !== m.home.proc.processId) out.push({ t: "auto.settle" });
    if (e.ext.lastTickMs === null || now - e.ext.lastTickMs >= GUARD_POLL_MS || wakeDue(m, rt)) out.push({ t: "auto.tick" });
    if (!winOpen) for (const g of Object.values(m.home.local.keepGuards)) out.push({ t: "auto.guardPoll", inboxId: g.inboxId }); // held input: no sends in the window
    for (const ev of e.flux.events) if (!winOpen && e.ext.emitted[ev.eventId] && (e.ext.deliveries[ev.eventId] ?? 0) < 1 + d.maxEventRedeliveries) out.push({ t: "auto.applyEvent", eventId: ev.eventId });
    for (const r of e.flux.requests) if (!winOpen && r.flux === "applied" && r.answer === "pending") {
      const res = e.ext.results[r.requestId];
      if (res) out.push({ t: "net.answer", requestId: r.requestId, result: res.answer, fluxStateSeen: res.fluxStateSeen });
    }
    if (e.ext.cfg.listing === "per_account" && !e.ext.listingDelivered) out.push({ t: "net.listing" });
    // owner
    if (room) {
      for (const p of d.principals) {
        if (e.ext.views < d.maxOwnerViews) out.push({ t: "owner.viewSurface", principal: p });
        for (const b of d.bots) {
          const toks: (string | null)[] = [null, ...e.ghost.tokens.filter(t => t.botId === b || t.botId === null).map(t => t.tokenId)];
          const ok = { ok: true } as const;
          for (const tk of toks) {
            for (const mode of ["bot_section", "orphan", "live", "flux_closing", "key_only"] as const)
              for (const ib of mode === "key_only" ? [null] : [...d.inboxes, null]) out.push({ t: "owner.keep", principal: p, botId: b, target: ib ? inboxTarget(ib) : botTarget(b), tokenId: tk, mode, outcome: ok });
            for (const section of ["bot", "parked", "key_only", "other_setup"] as const)
              for (const ib of [...d.inboxes, null]) out.push({ t: "owner.remove", principal: p, botId: b, target: ib ? inboxTarget(ib) : botTarget(b), tokenId: tk, section, outcome: ok });
            out.push({ t: "owner.deleteBot", principal: p, botIds: [b], tokens: { [b]: tk }, outcome: ok }, { t: "owner.reconnect", principal: p, botId: b, tokenId: tk, outcome: ok });
          }
          for (const tg of [botTarget(b), ...d.inboxes.map(inboxTarget)]) out.push({ t: "owner.tryAgainNow", principal: p, botId: b, target: tg, outcome: ok }); // a stale screen may name a non-bot target (S20)
        }
      }
      if (e.ext.backups < d.maxBackups) out.push({ t: "owner.backup", kind: "desktop_backup" }, { t: "owner.backup", kind: "cloud_restic" });
      // a blind restore (outgoing database unavailable: new machine, disk loss) only when the home has no live database; a live one is never swapped blind (outgoingCapturedBeforeSwap)
      if (e.ext.restores < d.maxRestores) for (const a of e.archives) for (const s of d.restoreSources) {
        if (liveDb) out.push({ t: "owner.restore", source: s, archiveId: a.archiveId });
        else if (d.restoreNoOutgoing) out.push({ t: "owner.restore", source: s, archiveId: a.archiveId + NO_LIVE_SUFFIX });
      }
    }
  }
  // r3.4d J1/J2 restore job steps, by the EFFECTIVE phase. Capture: armed, not blind. Abort: armed or captured. Swap: captured, or armed when blind, and the archive still local (M-3).
  // Prepare: swapped (production prep never throws, so only committed is offered). Clear: prepared or aborted.
  if (up && jb) {
    const blind = jb.archiveId.endsWith(NO_LIVE_SUFFIX), isLocal = (m.home.fs.localArchives ?? []).includes(jb.archiveId);
    if (jph === "armed" && !blind) out.push({ t: "auto.captureOutgoing" });
    if (jph === "armed" || jph === "captured") for (const reason of ["archive_unreadable", "owner_cancel"] as const) out.push({ t: "auto.restoreAbort", reason });
    if (isLocal && (jph === "captured" || (jph === "armed" && blind))) out.push({ t: "auto.swap", source: jb.source, archiveId: jb.archiveId, blind });
    if (jph === "prepared" || jph === "aborted") out.push({ t: "auto.restoreJobClear" });
  }
  if (ph === "boot_prep" && jph === "swapped") out.push({ t: "auto.restorePrepare", outcome: "committed" }); // the swap closed the store; the prep runs in the home's boot prep
  // r3.4d J2: with no job, a system restore of a local archive (nobody asked) and an archive fetch (download + verify, before any arm)
  if (up && !jb) {
    if (e.ext.restores < d.maxRestores) for (const a of e.archives) for (const id of liveDb ? [a.archiveId] : d.restoreNoOutgoing ? [a.archiveId + NO_LIVE_SUFFIX] : [])
      if ((m.home.fs.localArchives ?? []).includes(id)) out.push({ t: "auto.restoreArm", source: "cloud_reset", archiveId: id });
    if ((e.ext.fetches ?? 0) < 1) for (const a of e.archives) for (const outcome of ["verified", "download_failed"] as const) out.push({ t: "auto.archiveFetch", archiveId: a.archiveId, outcome });
  }
  // crash injection (before/after every durable write)
  if (ph !== "down" && e.ext.armed === null && e.ext.crashes < d.maxCrashes) for (const at of ALL_WRITES) for (const when of ["before", "after"] as const) out.push({ t: "fault.crash", at, when });
  // remote
  for (const r of e.flux.requests) {
    const copies = e.flux.requests.filter(x => (x.copyOf ?? x.requestId) === (r.copyOf ?? r.requestId)).length;
    if (r.flux === "held") out.push({ t: "flux.apply", requestId: r.requestId });
    if (copies < d.maxCopies) out.push({ t: "fault.duplicate", requestId: r.requestId });
    if (r.flux === "applied" && r.answer === "pending") out.push({ t: "fault.loseAnswer", requestId: r.requestId });
  }
  for (const ev of e.flux.events) if (!e.ext.emitted[ev.eventId]) out.push({ t: "flux.emit", event: ev });
  if (e.ext.fluxCloses < d.maxFluxCloses) for (const ib of Object.values(e.flux.inboxes)) if (ib.state === "active") for (const reason of ["billing", "account_disabled", "support"] as const) out.push({ t: "flux.close", inboxId: ib.inboxId, reason });
  for (const ib of Object.values(e.flux.inboxes)) if (FF.canPurge(ib, now)) out.push({ t: "flux.purge", inboxId: ib.inboxId });
  return out;
}

/** Obligations the fairness model (checker.ts) says MUST eventually fire. Everything else (owner, faults, Flux-initiated close, time) is optional. */
export function isObligation(mv: Move, m: Model, rt: Runtime): boolean {
  switch (mv.t) {
    case "auto.boot": case "auto.emailOn": case "auto.settle": case "flux.apply": case "net.answer": case "flux.emit": case "flux.purge": case "net.listing": return true;
    case "auto.captureOutgoing": case "auto.swap": case "auto.restoreJobClear": return true; // r3.4d J1/J2: a job's capture, swap and clear are fair; abort is not
    case "auto.restorePrepare": return mv.outcome === "committed";
    case "auto.bootPrep": return mv.outcome === "ok";
    case "auto.applyEvent": return (m.env.ext.deliveries[mv.eventId] ?? 0) === 0;
    case "auto.tick": return wakeDue(m, rt);
    default: return false;
  }
}

// ---------- apply ------------------------------------------------------------------------------------------------------------------

export interface ApplyResult { model: Model; steps: TraceStep[]; move: Move }

const fluxCtx = (e: Env, rid: string | null): FF.FluxCtx => {
  const meta = rid ? e.ext.reqMeta[rid.split("#")[0]] : undefined;
  return { nowMs: e.nowMs, step: e.step, cfg: e.ext.cfg, newEventId: () => "ev" + e.ext.nextEvent++, botHint: meta?.botHint ?? null, deleteReason: meta?.deleteReason ?? "owner", accountEmailDisabled: Object.values(e.flux.inboxes).some(i => i.closingCause?.kind === "flux" && i.closingCause.reason === "account_disabled") };
};
const principalOf = (a: Action): TokenIssue["issuedTo"] => ("principal" in a ? a.principal : "owner_desktop");
const sectionKind = (s: SurfaceRow["section"]): TokenIssue["kind"] => (s === "bot" ? "b" : s === "restore_check" ? "r" : s === "parked" || s === "kept" || s === "key_only" ? "p" : "f");

function recordTokens(m: Model, p: TokenIssue["issuedTo"]): void {
  for (const row of m.home.surface) for (const a of row.actions) {
    if (a.tokenId === null || m.env.ghost.tokens.some(t => t.tokenId === a.tokenId)) continue;
    const park = row.botId ? m.home.local.parks[row.botId] : undefined;
    m.env.ghost.tokens.push({
      tokenId: a.tokenId, kind: sectionKind(row.section), botId: row.botId, gen: row.botId ? m.home.local.bindings[row.botId]?.gen ?? null : null,
      park: park ? { parkId: park.parkId, parkRev: park.parkRev } : null, shown: { target: row.target, address: row.address ?? null, inboxId: row.inboxId, keyIds: row.keyIds },
      issuedTo: p, issuedAtStep: m.env.step, issuedAtMs: m.env.nowMs, processId: m.home.proc.processId, epoch: m.env.ghost.epoch,
    });
  }
}

/** r3.4d J2: the restore job's own moves. A crash that cuts one of them BEFORE its last write is that crash's step, not the move's (the move did not complete): the step's action is fault.crash. */
const JOB_MOVES: ReadonlySet<string> = new Set(["owner.restore", "auto.restoreArm", "auto.captureOutgoing", "auto.swap", "auto.restorePrepare", "auto.restoreJobClear", "auto.restoreAbort"]);

const crashed = (h: HomeState): HomeState => ({ ...h, proc: { ...h.proc, phase: "down" }, surface: [] });

/** r3.3a (A8-M1): the recorder keeps ghost.keptHighWater[k] = the newest Keep authority the key's entry has held (never lowered, never removed). */
function bumpHW(m: Model): void {
  const g = m.env.ghost;
  for (const [k, id] of Object.entries(m.home.local.keptKeys)) {
    const a = g.authorities.find(x => x.authorityId === id), cur = g.authorities.find(x => x.authorityId === g.keptHighWater[k]);
    if (a && (!cur || a.verifiedAtStep > cur.verifiedAtStep)) g.keptHighWater[k] = id;
  }
}

function react(m: Model, ev: HomeEvent, trigger: Move, rt: Runtime, steps: TraceStep[], patch: { outcome?: { ok: boolean; code?: string } }, swapRec?: () => void): void {
  // r3.4d J2 recorder: the restore record lands WITH the swap write W3, the prepared epoch WITH the prep write W4 (when the job's preparedJobId is in it); a write the crash dropped records nothing
  const landed = (ef: { write: string; after: HomeState }): void => {
    if (ef.write === "W3_swap_record" && swapRec) swapRec();
    const g = m.env.ghost, jr = ef.after.fs.restoreJob;
    if (ef.write === "W4_consumer_tx" && jr && ef.after.local.preparedJobId === jr.id && !g.preparedEpochs.includes(g.epoch)) g.preparedEpochs.push(g.epoch);
  };
  const snap = (): World => { bumpHW(m); return clone(toWorld(m)); };
  const parksBefore = clone(m.home.local.parks), authLen0 = m.env.ghost.authorities.length, keepsLen0 = m.env.ghost.keeps.length, usedLen0 = m.env.ghost.usedKeepOps.length; let durableApplied = false;
  const res = rt.reducer.reduce(clone(m.home), ev, rt.ctx);
  let segStart = snap();
  const flush = (action: Action): void => { steps.push({ prev: segStart, action, next: snap() }); segStart = snap(); };
  let cut = false, dirty = false, trigFlushed = false;
  // r3.4d-s23 (admissionPinned): a crash CUTS an owner step. Before its durable write nothing of the action happened (the step is labelled by the crash, not by an
  // owner action that was never answered); after it the write is committed, so the ghost effects tied to that write (authority, Keep claim) are recorded and only the owner's answer is lost.
  let cutWhen: "before" | "after" | null = null, crashAction: Action | null = null;
  const pa = asPredicateAction(trigger);
  let lastAfter: HomeState | null = null, crashAct: Extract<Action, { t: "fault.crash" }> | null = null;
  const localAdd: string[] = []; // r3.4d J1: archives the backup verified locally (fs.localArchives)
  for (const ef of res.actions as Effect[]) {
    if (cut && !(cutWhen === "after" && ef.k === "keep")) { if (cutWhen === "after" && ef.k === "ownerResult") continue; break; }
    bumpHW(m);
    switch (ef.k) {
      case "durable": {
        const arm = m.env.ext.armed;
        if (arm && arm.at === ef.write) {
          m.env.ext.armed = null;
          const lastDur = [...(res.actions as Effect[])].reverse().find(x => x.k === "durable") === ef;
          const finishedJob = arm.when === "after" && lastDur && JOB_MOVES.has(trigger.t); // the job move completed; the crash that follows is its own step
          if (!(arm.when === "after" && lastDur) || finishedJob) crashAct = arm.at === "W23_carry_capture" && arm.when === "after" ? { t: "fault.crash", at: "W26_job_captured", when: "before" } : { t: "fault.crash", at: arm.at, when: arm.when }; // after W23 = before W26: the same durable state
          if (finishedJob) { m.home = clone(ef.after); lastAfter = ef.after; landed(ef); flush(pa); m.home = crashed(m.home); }
          else if (arm.when === "before") m.home = crashed(m.home); else { m.home = crashed(clone(ef.after)); lastAfter = ef.after; landed(ef); }
          cutWhen = arm.when;
          if (arm.when === "before" && trigger.t.startsWith("owner.") && !trigFlushed && !durableApplied) { // nothing of the owner action was committed: roll back its ghost effects and label the step by the crash
            m.env.ghost.authorities.length = authLen0; m.env.ghost.keeps.length = keepsLen0; m.env.ghost.usedKeepOps.length = usedLen0; patch.outcome = undefined;
            crashAction = { t: "fault.crash", at: ef.write, when: "before" } as Action;
          }
          m.env.ext.lastTickMs = null; cut = true; dirty = true; rt.ctx.hit("harness.crash." + ef.write + "." + arm.when);
        } else { m.home = clone(ef.after); lastAfter = ef.after; dirty = true; durableApplied = true; landed(ef); }
        break;
      }
      case "send": {
        if (dirty || steps.length === 0) { flush(pa); dirty = false; trigFlushed = true; }
        // A send is its own trace step after the triggering answer/claim: causal comparisons must not give both events one timestamp.
        m.env.step++;
        const id = "r" + m.env.ext.nextReq++, { botHint, deleteReason, ...q } = ef.request;
        const req: RemoteRequest = { ...q, requestId: id, copyOf: null, sentAtStep: m.env.step, sentAtMs: m.env.nowMs, sentInProcess: m.home.proc.processId, sentInEpoch: m.env.ghost.epoch, flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null };
        m.env.ext.reqMeta[id] = { botHint: botHint ?? null, deleteReason: deleteReason ?? "owner" };
        m.env.flux.requests.push(req);
        steps.push({ prev: segStart, action: { t: "net.send", request: clone(req) }, next: snap() }); segStart = snap();
        break;
      }
      case "authorize": {
        const bind = ef.botId ? m.home.local.bindings[ef.botId] : undefined, park = ef.botId ? m.home.local.parks[ef.botId] : undefined;
        if (ef.tokenId !== null && !m.env.ghost.tokens.some(t => t.tokenId === ef.tokenId)) m.env.ext.harnessViolations.push({ name: "recorder.authorityFromUnknownToken", why: "authority " + ef.authorityId + " cites token " + ef.tokenId + " never shown", step: m.env.step });
        const pr = trigger.t.startsWith("owner.") ? principalOf(trigger as Action) : "system";
        if (!OWNER_PRINCIPALS.has(pr)) m.env.ext.harnessViolations.push({ name: "recorder.authorityNotFromOwner", why: "authority created by non-owner trigger " + trigger.t, step: m.env.step });
        m.env.ghost.authorities.push({
          authorityId: ef.authorityId, kind: ef.kind, principal: pr, tokenId: ef.tokenId, verifiedAtStep: m.env.step, verifiedAtMs: m.env.nowMs, verifiedInProcess: m.home.proc.processId,
          epoch: m.env.ghost.epoch, botId: ef.botId, scope: { target: ef.inboxId ? inboxTarget(ef.inboxId) : ef.botId ? botTarget(ef.botId) : null, inboxId: ef.inboxId, keyIds: ef.keyIds }, genAtVerify: bind?.gen ?? null, parkAtVerify: park ? { parkId: park.parkId, parkRev: park.parkRev } : null,
        });
        break;
      }
      case "keep": {
        const g = m.env.ghost;
        if (ef.phase === "claimed") { g.keeps.push({ keepOp: ef.keepOp, botId: ef.botId, target: ef.inboxId ? inboxTarget(ef.inboxId) : botTarget(ef.botId), inboxId: ef.inboxId, mode: ef.mode, authorityId: ef.authorityId, claimedAtStep: m.env.step, succeededAtStep: null, succeededAtMs: null, confirmedBy: null }); g.usedKeepOps.push(ef.keepOp); }
        else {
          const k = g.keeps.find(x => x.keepOp === ef.keepOp);
          if (k) {
            k.succeededAtStep = m.env.step; k.succeededAtMs = m.env.nowMs;
            // The reducer receives the logical request id. The trusted recorder knows which transport GET
            // actually delivered that answer, including a copy that completed before the original.
            const confirmation = ef.confirmedBy;
            const answered = trigger.t === "net.answer" ? m.env.flux.requests.find(r => r.requestId === trigger.requestId) : undefined;
            const requestId = confirmation && answered && (answered.copyOf ?? answered.requestId) === confirmation.requestId ? answered.requestId : confirmation?.requestId;
            k.confirmedBy = confirmation ? { ...confirmation, requestId: requestId!, atStep: m.env.step } : null;
          }
        }
        break;
      }
      case "ownerResult": patch.outcome = { ok: ef.ok, code: ef.code }; break;
      case "archive": { const aid = "a" + m.env.ext.nextArchive++; m.env.archives.push({ archiveId: aid, kind: ef.kind, topLevelNames: ef.topLevelNames }); m.env.ext.archiveDbs[aid] = clone(ef.db); localAdd.push(aid, aid + NO_LIVE_SUFFIX); } dirty = true; break;
    }
  }
  bumpHW(m);
  // r3.4d-s23: a PARK kills every owner token of its bot ("park or restore", lastParkOrRestoreStep): the recorder stamps any bot whose park row is new or whose parkRev moved in this step.
  if (!cut) for (const p of Object.values(res.state.local.parks)) { if (p.botId === null) continue; const was = parksBefore[p.botId]; if (!was || was.parkRev !== p.parkRev) m.env.ghost.lastParkOrRestoreStep[p.botId] = m.env.step; }
  if (!cut) {
    if (lastAfter !== null && JSON.stringify(lastAfter) !== JSON.stringify(res.state)) m.env.ext.harnessViolations.push({ name: "harness.reducerStateMismatch", why: "state != state after last durable effect (" + ev.e + ")", step: m.env.step });
    m.home = clone(res.state);
  }
  if (localAdd.length) m.home = { ...m.home, fs: { ...m.home.fs, localArchives: [...(m.home.fs.localArchives ?? []), ...localAdd] } };
  if (m.home.proc.phase === "running") recordTokens(m, trigger.t.startsWith("owner.") ? principalOf(trigger as Action) : "system"); // TEMP DIAGNOSTIC PATCH: record before the final snapshot
  if (dirty || steps.length === 0 || (!cut && JSON.stringify(m.home) !== JSON.stringify(segStart))) flush(crashAction ?? (crashAct && JOB_MOVES.has(trigger.t) ? crashAct : trigFlushed ? { t: "net.settle" } : pa)); // the trigger is carried by ONE segment; a trailing remainder after a send is neutral
}

export function apply(model: Model, move: Move, rt: Runtime): ApplyResult {
  const m = clone(model), e = m.env, steps: TraceStep[] = [], patch: { outcome?: { ok: boolean; code?: string } } = {};
  rt.onMove?.(move); e.step++;
  const reqOf = (id: string): RemoteRequest => { const r = e.flux.requests.find(x => x.requestId === id); if (!r) throw new Error("no such request " + id); return r; };
  const simple = (action: Action): void => { steps.push({ prev: clone(toWorld(model)), action, next: clone(toWorld(m)) }); };
  switch (move.t) {
    case "clock.advance": {
      e.nowMs += move.ms; e.ext.clockJumps++;
      for (const ib of Object.values(e.flux.inboxes)) { const k = FF.intake(ib); const c = (e.ext.mail[ib.inboxId] ??= { accepted: false, dropped: false }); if (k === "accepted") c.accepted = true; if (k === "dropped") c.dropped = true; }
      simple(move); break;
    }
    case "fault.crash": e.ext.crashes++; e.ext.armed = { at: move.at, when: move.when }; simple(move); break;
    case "fault.loseAnswer": reqOf(move.requestId).answer = "lost"; simple(move); break;
    case "fault.duplicate": {
      const r = reqOf(move.requestId), base = r.copyOf ?? r.requestId, n = e.flux.requests.filter(x => x.copyOf === base).length + 1;
      e.flux.requests.push({ ...clone(r), requestId: base + "#dup" + n, copyOf: base, flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null }); simple(move); break;
    }
    case "fault.reorder": case "fault.delayEvent": simple(move); break; // subsumed (FAULT_SUBSUMPTION); accepted when replaying witnesses
    case "flux.apply": {
      const r = reqOf(move.requestId), result = FF.applyRequest(e.flux, r, fluxCtx(e, r.requestId));
      r.flux = "applied"; r.appliedAtMs = e.nowMs; e.ext.results[r.requestId] = result; simple(move); break;
    }
    case "flux.emit": e.ext.emitted[move.event.eventId] = true; simple(move); break;
    case "flux.close": e.ext.fluxCloses++; FF.fluxClose(e.flux, move.inboxId, move.reason, fluxCtx(e, null)); simple(move); if (m.home.proc.phase === "running") react(m, { e: "settle", nowMs: e.nowMs }, { t: "auto.settle" }, rt, steps, patch); break; // the surface is derived from state: re-render after Flux changes it
    case "flux.purge": FF.purge(e.flux, move.inboxId, fluxCtx(e, null)); simple(move); break;
    case "net.send": throw new Error("net.send is produced by the reducer, never scheduled");
    case "net.listing": { const l = FF.listing(e.flux); e.ext.listingDelivered = true; react(m, { e: "listing", nowMs: e.nowMs, inboxes: clone(l.inboxes), keys: clone(l.keys) }, move, rt, steps, patch); break; }
    case "net.answer": {
      const r = reqOf(move.requestId), res = e.ext.results[move.requestId];
      r.answer = "delivered"; // duplicates of the same id share results via base id
      r.answerSeen = { atStep: e.step, result: res.answer, fluxStateSeen: res.fluxStateSeen };
      react(m, { e: "answer", nowMs: e.nowMs, requestId: move.requestId.split("#")[0], answer: res.answer, code: res.code, fluxStateSeen: res.fluxStateSeen }, move, rt, steps, patch); break;
    }
    case "auto.boot": react(m, { e: "boot", nowMs: e.nowMs }, move, rt, steps, patch); e.ghost.lastBootAtMs = e.nowMs; break;
    case "auto.bootPrep": react(m, { e: "bootPrep", nowMs: e.nowMs, inject: move.outcome === "threw" ? "throw" : "none" }, move, rt, steps, patch); break;
    case "auto.emailOn": react(m, { e: "emailOn", nowMs: e.nowMs }, move, rt, steps, patch); break;
    case "auto.settle": e.ext.settledInProc = m.home.proc.processId; react(m, { e: "settle", nowMs: e.nowMs }, move, rt, steps, patch); break;
    case "auto.tick": e.ext.lastTickMs = e.nowMs; react(m, { e: "tick", nowMs: e.nowMs }, move, rt, steps, patch); break;
    case "auto.guardPoll": react(m, { e: "guardPoll", nowMs: e.nowMs, inboxId: move.inboxId }, move, rt, steps, patch); break;
    case "auto.captureOutgoing": react(m, { e: "captureOutgoing", nowMs: e.nowMs, step: e.step }, move, rt, steps, patch); break;
    case "auto.restoreAbort": react(m, { e: "restoreAbort", nowMs: e.nowMs, step: e.step, reason: move.reason }, move, rt, steps, patch); break;
    case "auto.restorePrepare": react(m, { e: "restorePrepare", nowMs: e.nowMs, step: e.step }, move, rt, steps, patch); break;
    case "auto.restoreJobClear": react(m, { e: "restoreJobClear", nowMs: e.nowMs, step: e.step }, move, rt, steps, patch); break;
    case "auto.restoreArm": {
      e.ext.restores++; e.ext.jobReq = null; // a system restore: no owner request
      react(m, { e: "restoreArm", nowMs: e.nowMs, step: e.step, source: move.source, archiveId: move.archiveId }, move, rt, steps, patch); break;
    }
    case "auto.archiveFetch": {
      e.ext.fetches = (e.ext.fetches ?? 0) + 1;
      // the fetch serves an owner's request when one of its archive has no restore after it (the recorder knows; the home only gets the flag)
      const forOwner = !m.home.fs.restoreJob && e.ghost.ownerRestoreRequests.some(r => r.archiveId === move.archiveId && !e.ghost.restores.some(x => x.archiveId === r.archiveId && x.atStep >= r.atStep));
      react(m, { e: "archiveFetch", nowMs: e.nowMs, step: e.step, archiveId: move.archiveId, outcome: move.outcome, forOwner }, move, rt, steps, patch); break;
    }
    case "auto.applyEvent": {
      const ev = e.flux.events.find(x => x.eventId === move.eventId) as FluxEvent;
      e.ext.deliveries[ev.eventId] = (e.ext.deliveries[ev.eventId] ?? 0) + 1; ev.deliveredToHome = true;
      react(m, { e: "applyEvent", nowMs: e.nowMs, event: clone(ev) }, move, rt, steps, patch); break;
    }
    case "owner.viewSurface": e.ext.views++; react(m, { e: "owner", nowMs: e.nowMs, action: move }, move, rt, steps, patch); break;
    case "owner.backup": e.ext.backups++; react(m, { e: "backup", nowMs: e.nowMs, kind: move.kind }, move, rt, steps, patch); break;
    case "owner.restore": {
      // r3.4d J1: the owner's request is the reducer's ARM step (or a restore_finishing / not-local refusal, which is not recorded and owes nothing).
      const ev: HomeEvent = { e: "ownerRestore", nowMs: e.nowMs, step: e.step, action: move };
      const dry = rt.reducer.reduce(clone(m.home), ev, NOOP_CTX);
      if (!dry.actions.some(a => a.k === "ownerResult" && !a.ok)) {
        e.ext.restores++; e.ext.jobReq = e.step;
        e.ghost.ownerRestoreRequests.push({ atStep: e.step, source: move.source, archiveId: move.archiveId.endsWith(NO_LIVE_SUFFIX) ? move.archiveId.slice(0, -NO_LIVE_SUFFIX.length) : move.archiveId });
      }
      react(m, ev, move, rt, steps, patch);
      if (!dry.actions.some(a => a.k === "ownerResult" && !a.ok) && !m.home.fs.restoreJob) patch.outcome = { ok: false, code: "restore_not_started" }; // a crash dropped the arm (W25): the owner was told nothing was admitted
      break;
    }
    case "auto.swap": {
      // r3.4d J2: the swap is its own step. The recorder writes the restore record when W3 lands (swapRec), naming the job, its carry and the owner request that armed it.
      const id = move.archiveId.endsWith(NO_LIVE_SUFFIX) ? move.archiveId.slice(0, -NO_LIVE_SUFFIX.length) : move.archiveId;
      const arch = e.archives.find(a => a.archiveId === id); if (!arch) throw new Error("no such archive " + id);
      const jobId = m.home.fs.restoreJob?.id, noLive = move.blind, reqStep = e.ext.jobReq ?? null;
      const swapRec = (): void => {
        e.ghost.epoch++; e.ghost.restores.push({ atStep: e.step, atMs: e.nowMs, epochAfter: e.ghost.epoch, source: move.source, archiveId: id, blind: noLive, carryId: m.home.carry?.carryId ?? null, ownerRequestStep: reqStep, jobId });
        for (const b of Object.keys(e.bots)) e.ghost.lastParkOrRestoreStep[b] = e.step;
      };
      const outgoing = noLive ? null : clone(m.home.local);
      react(m, { e: "restoreSwap", nowMs: e.nowMs, step: e.step, source: move.source, archiveId: move.archiveId, blind: noLive, archiveDb: clone(e.ext.archiveDbs[id] ?? null), archiveTopLevelNames: [...arch.topLevelNames], outgoingDb: outgoing }, move, rt, steps, patch, swapRec); break;
    }
    default: react(m, { e: "owner", nowMs: e.nowMs, action: move as Action }, move, rt, steps, patch);
  }
  let outMove: Move = move;
  if (patch.outcome && ("outcome" in move || move.t === "owner.restore" || move.t === "owner.backup")) { // r3.4d J1: a refused restore / backup stamps its outcome too
    outMove = { ...move, outcome: patch.outcome.ok ? { ok: true } : { ok: false, code: patch.outcome.code ?? "failed" } } as unknown as Move;
    for (const s of steps) if (moveKey(s.action) === moveKey(move)) s.action = outMove as Action;
  }
  return { model: m, steps, move: outMove };
}

export { NOOP_CTX, FAULT_MODEL, MARKER_NAME };
