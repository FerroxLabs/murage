// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.4d J1 reducer-driven tests: the restore job protocol's first half (arm, capture, abort, the window and S20 refusals) driven through the real
// reduceRestore from a seeded state, plus one harness test (owner.restore arms through the reducer; a refusal is not recorded). Each test names
// its mutants (s23-job-mutants.py) that must turn it red. r3.4d J2 (swap, prepare, clear, system arm, archive fetch) follows below.

import { describe, expect, it } from "vitest";
import type { HomeEvent, HomeState } from "./model.ts";
import { jobPhaseOf } from "./model.ts";
import { enabled } from "./moves.ts";
import { SEEDS } from "./seeds.ts";
import { reduceRestore } from "./restore-reducer.ts";
import { DOMAIN_ONE } from "./domain.ts";
import { apply, NOOP_CTX } from "./moves.ts";
import { restoreReducer } from "./restore-reducer.ts";
import { carryCovers, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE } from "./invariants.current.ts";
import type { RestoreJob } from "./invariants.current.ts";

const NOW = 1_000_000;
const drive = (s: HomeState, event: HomeEvent) => { const hits: string[] = []; const r = reduceRestore(s, event, { hit: id => void hits.push(id) }); return { ...r, hits }; };
const base = (): HomeState => { const h = SEEDS.fresh().home; h.fs = { ...h.fs, localArchives: ["a0"] }; return h; };
const withJob = (phase: RestoreJob["phase"], h = base()): HomeState => { h.fs = { ...h.fs, restoreJob: { id: "job1", archiveId: "a0", source: "desktop", phase, at: 3 } }; return h; };
const restoreEv = (step = 5, archiveId = "a0"): HomeEvent => ({ e: "ownerRestore", nowMs: NOW, step, action: { t: "owner.restore", source: "desktop", archiveId } });
const result = (acts: { k: string }[]) => acts.filter(a => a.k === "ownerResult") as { k: "ownerResult"; ok: boolean; code?: string }[];
const writes = (acts: { k: string }[]) => acts.filter(a => a.k === "durable").map(a => (a as unknown as { write: string }).write);
const homeLine = (s: HomeState) => s.surface.filter(r => r.section === "home" && r.visible).map(r => r.line);
/** the state with the journal and the surface removed: what an abort or a refusal must leave untouched. */
/** (the reducer adds its private local.x on any reduction, so it is dropped before comparing) */
const norm = (s: HomeState, drop: { journal?: boolean } = {}) => JSON.stringify({ ...s, surface: null, local: { ...s.local, x: undefined }, fs: drop.journal ? { ...s.fs, restoreJob: null } : s.fs });
const rest = (s: HomeState) => norm(s, { journal: true });
const keepEv = (): HomeEvent => ({ e: "owner", nowMs: NOW, action: { t: "owner.keep", principal: "owner_desktop", botId: "b1", target: "inbox:i1", tokenId: null, mode: "live", outcome: { ok: true } } });

describe("r3.4d J1 restore job (real restore-reducer.ts)", () => {
  // MUTANTS arm-dropped (arm writes no job), arm-wrong-phase (writes captured), arm-no-w25 (journal set, W25 not written).
  it("owner.restore ARMS: journal phase armed with the archive, source and this step, W25, ok", () => {
    const r = drive(base(), restoreEv(5));
    expect(result(r.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    const j = r.state.fs.restoreJob!;
    expect(j).toMatchObject({ archiveId: "a0", source: "desktop", phase: "armed", at: 5 });
    expect(j.id).toBeTruthy();
    expect(writes(r.actions)).toEqual(["W25_job_armed"]);
    expect(r.hits).toContain("restore.arm");
    expect(r.state.carry).toBeNull();
    expect(rest(r.state)).toBe(rest(base()));
  });

  // MUTANT refuse-not-local-dropped.
  it("owner.restore of an archive that is not local is refused archive_not_local: no job, nothing changed", () => {
    const h = base(); h.fs = { ...h.fs, localArchives: [] };
    const r = drive(h, restoreEv());
    expect(result(r.actions)).toEqual([{ k: "ownerResult", ok: false, code: "archive_not_local" }]);
    expect(r.state.fs.restoreJob ?? null).toBeNull();
    expect(writes(r.actions)).toEqual([]);
    expect(r.hits).toContain("restore.refuse_not_local");
  });

  // MUTANT refuse-window-dropped (the open-job refusal is skipped, so the restore re-arms over the job).
  it("owner.restore while the job is armed or captured is refused restore_finishing: pure, the home line shows, nothing queued", () => {
    for (const phase of ["armed", "captured"] as const) {
      const h = withJob(phase);
      const r = drive(h, restoreEv(9));
      expect(result(r.actions), phase).toEqual([{ k: "ownerResult", ok: false, code: "restore_finishing" }]);
      expect(r.state.fs.restoreJob, phase).toEqual(h.fs.restoreJob);
      expect(norm(r.state), phase).toBe(norm(h));
      expect(homeLine(r.state), phase).toEqual([RESTORE_FINISHING_LINE]);
      expect(writes(r.actions), phase).toEqual([]);
      expect(r.hits).toContain("restore.refuse_window");
    }
  });

  // MUTANT refuse-finished-dropped (S20: only an OPEN job refuses; a prepared / aborted one lets a new restore arm over it).
  it("S20: owner.restore while a finished job is not yet cleared (aborted, prepared) is refused restore_finishing, pure", () => {
    for (const phase of ["aborted", "prepared"] as const) {
      const h = withJob(phase);
      const r = drive(h, restoreEv(9));
      expect(result(r.actions), phase).toEqual([{ k: "ownerResult", ok: false, code: "restore_finishing" }]);
      expect(r.state.fs.restoreJob, phase).toEqual(h.fs.restoreJob);
      expect(homeLine(r.state), phase).toEqual([RESTORE_FINISHING_LINE]);
      expect(writes(r.actions), phase).toEqual([]);
      expect(r.hits).toContain("restore.refuse_finished");
    }
  });

  // MUTANTS capture-no-w26 (phase stays armed), capture-carry-unstamped (carry.jobId null), capture-any-phase (captures from captured too).
  it("capture: an ARMED job writes a complete carry stamped with the job (W23), then phase captured (W26)", () => {
    const h = withJob("armed"), r = drive(h, { e: "captureOutgoing", nowMs: NOW, step: 6 });
    expect(writes(r.actions)).toEqual(["W23_carry_capture", "W26_job_captured"]);
    expect(r.state.fs.restoreJob).toMatchObject({ id: "job1", phase: "captured", at: 6 });
    const c = r.state.carry!;
    expect(c.jobId).toBe("job1");
    expect(c.complete).toBe(true);
    expect(carryCovers(h.local, c)).toBe(true);
    expect(c.keyIds).toContain("k1");
    expect(r.hits).toContain("restore.capture");
    // the W23 write already holds the carry with the job still armed (a crash between the two leaves the capture to redo)
    const w23 = r.actions.find(a => a.k === "durable" && a.write === "W23_carry_capture") as unknown as { after: HomeState };
    expect(w23.after.carry?.jobId).toBe("job1");
    expect(w23.after.fs.restoreJob?.phase).toBe("armed");
  });
  it("capture is refused (nothing changes) with no job, with a captured job, with an aborted job", () => {
    for (const h of [base(), withJob("captured"), withJob("aborted")]) {
      const r = drive(h, { e: "captureOutgoing", nowMs: NOW, step: 6 });
      expect(r.state.carry ?? null).toBeNull();
      expect(r.state.fs.restoreJob ?? null).toEqual(h.fs.restoreJob ?? null);
      expect(writes(r.actions)).toEqual([]);
      expect(r.hits).toContain("restore.capture_refused");
    }
  });

  // MUTANTS abort-changes-carry, abort-no-line, abort-no-w29, abort-wrong-phase.
  it("abort from armed or captured writes ONLY phase aborted (W29) and the restore-failed home line", () => {
    const captured = drive(withJob("armed"), { e: "captureOutgoing", nowMs: NOW, step: 6 }).state;
    for (const [phase, h] of [["armed", withJob("armed")], ["captured", captured]] as const) {
      for (const reason of ["archive_unreadable", "owner_cancel"] as const) {
        const r = drive(h, { e: "restoreAbort", nowMs: NOW, step: 8, reason });
        expect(r.state.fs.restoreJob, phase).toMatchObject({ id: "job1", archiveId: "a0", source: "desktop", phase: "aborted", at: 8 });
        expect(rest(r.state), phase).toBe(rest(h));
        expect(r.state.carry, phase).toEqual(h.carry);
        expect(homeLine(r.state), phase).toEqual([RESTORE_FAILED_LINE]);
        expect(writes(r.actions), phase).toEqual(["W29_job_aborted"]);
        expect(r.hits).toContain("restore.abort");
      }
    }
  });
  // MUTANT abort-any-phase.
  it("abort is refused (nothing changes) with no job, an aborted, a prepared or a swapped job", () => {
    for (const h of [base(), withJob("aborted"), withJob("prepared"), withJob("swapped")]) {
      const r = drive(h, { e: "restoreAbort", nowMs: NOW, step: 8, reason: "owner_cancel" });
      expect(r.state.fs.restoreJob ?? null).toEqual(h.fs.restoreJob ?? null);
      expect(writes(r.actions)).toEqual([]);
      expect(r.hits).toContain("restore.abort_refused");
    }
  });

  // MUTANTS window-decision-admitted, window-backup-admitted, window-view-no-line.
  it("while the window is open every owner decision and a backup are refused restore_finishing (pure), and a view shows the line", () => {
    for (const phase of ["armed", "captured"] as const) {
      const h = withJob(phase);
      const k = drive(h, keepEv());
      expect(result(k.actions), phase).toEqual([{ k: "ownerResult", ok: false, code: "restore_finishing" }]);
      expect(rest(k.state), phase).toBe(rest(h)); expect(homeLine(k.state), phase).toEqual([RESTORE_FINISHING_LINE]); expect(writes(k.actions)).toEqual([]);
      const b = drive(h, { e: "backup", nowMs: NOW, kind: "desktop_backup" });
      expect(result(b.actions), phase).toEqual([{ k: "ownerResult", ok: false, code: "restore_finishing" }]);
      expect(b.actions.some(a => a.k === "archive"), phase).toBe(false);
      const v = drive(h, { e: "owner", nowMs: NOW, action: { t: "owner.viewSurface", principal: "owner_desktop" } });
      expect(homeLine(v.state), phase).toEqual([RESTORE_FINISHING_LINE]);
    }
    // control: no job, the same Keep is not a window refusal and a backup archives
    expect(result(drive(base(), keepEv()).actions)[0]?.code).not.toBe("restore_finishing");
    expect(drive(base(), { e: "backup", nowMs: NOW, kind: "desktop_backup" }).actions.some(a => a.k === "archive")).toBe(true);
  });
});

describe("r3.4d J1 harness (moves.ts apply)", () => {
  const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
  // MUTANTS harness-records-refused-request (a refused restore is recorded), harness-backup-not-local (backup does not add the archive to fs.localArchives).
  it("backup makes the archive local; owner.restore arms through the reducer and records the request; a second restore is refused, stamped and NOT recorded", () => {
    let m = SEEDS.fresh();
    m = apply(m, { t: "owner.backup", kind: "desktop_backup" }, rt).model;
    const id = m.env.archives[0].archiveId;
    expect(m.home.fs.localArchives).toContain(id);
    const a = apply(m, { t: "owner.restore", source: "desktop", archiveId: id }, rt);
    expect(a.steps.map(s => s.action.t)).toEqual(["owner.restore"]);
    const last = a.steps[a.steps.length - 1].next;
    expect(last.fs.restoreJob).toMatchObject({ archiveId: id, phase: "armed", at: a.model.env.step });
    expect(a.model.env.ghost.ownerRestoreRequests).toHaveLength(1);
    expect(a.model.env.ghost.restores).toHaveLength(0);
    const b = apply(a.model, { t: "owner.restore", source: "desktop", archiveId: id }, rt);
    expect(b.move).toMatchObject({ t: "owner.restore", outcome: { ok: false, code: "restore_finishing" } });
    expect(b.model.env.ghost.ownerRestoreRequests).toHaveLength(1);
    expect(b.model.home.fs.restoreJob).toEqual(a.model.home.fs.restoreJob);
  });
});

// ---------------- r3.4d J2: swap, prepare, clear, system arm, archive fetch ----------------
const archiveDb = () => structuredClone(SEEDS.fresh().home.local);
const swapEv = (h: HomeState, over: Partial<Extract<HomeEvent, { e: "restoreSwap" }>> = {}): HomeEvent => ({ e: "restoreSwap", nowMs: NOW, step: 7, source: "desktop", archiveId: "a0", blind: false, archiveDb: archiveDb(), archiveTopLevelNames: ["messages.db"], outgoingDb: structuredClone(h.local), ...over });
const captured = (): HomeState => drive(withJob("armed"), { e: "captureOutgoing", nowMs: NOW, step: 6 }).state;
const swapped = (): HomeState => { const c = captured(); return drive(c, swapEv(c)).state; };
const prepEv: HomeEvent = { e: "restorePrepare", nowMs: NOW, step: 8 };
const clearEv: HomeEvent = { e: "restoreJobClear", nowMs: NOW, step: 9 };

describe("r3.4d J2 swap (real restore-reducer.ts)", () => {
  // MUTANTS swap-no-w27 (the staged-DB write is dropped), swap-no-mark (swappedJobId never set), swap-journal-rewritten (the journal says swapped).
  it("swap of a captured job: W27 stages the DB with the job's mark, W3 installs it; the journal keeps its own phase, the carry stays", () => {
    const c = captured(), r = drive(c, swapEv(c));
    expect(writes(r.actions)).toEqual(["W27_job_swapped_staged", "W3_swap_record"]);
    expect(r.state.local.swappedJobId).toBe("job1");
    expect(jobPhaseOf(r.state)).toBe("swapped");
    expect(r.state.fs.restoreJob?.phase).toBe("captured");
    expect(r.state.carry).toEqual(c.carry);
    const w27 = r.actions.find(a => a.k === "durable" && a.write === "W27_job_swapped_staged") as unknown as { after: HomeState };
    expect(JSON.stringify(w27.after.local)).toBe(JSON.stringify(c.local)); // staged: the live home is unchanged until W3
    expect(r.state.proc).toMatchObject({ phase: "boot_prep", emailOn: false }); expect(r.state.surface).toEqual([]); // the swap closes the store: the home restarts into its prep
    expect(r.hits).toContain("restore.swap");
  });
  // MUTANTS swap-any-phase (a non-blind swap from armed is allowed), swap-any-archive, swap-no-local-recheck.
  it("swap is refused (nothing changes) from armed (not blind), with another archive or source, with no job, and when the archive is no longer local", () => {
    const a = withJob("armed"), c = captured(), gone = captured(); gone.fs = { ...gone.fs, localArchives: [] };
    for (const [name, h, ev, hit] of [["armed non-blind", a, swapEv(a), "restore.swap_refused"], ["other archive", c, swapEv(c, { archiveId: "a9" }), "restore.swap_refused"], ["other source", c, swapEv(c, { source: "cloud_reset" }), "restore.swap_refused"],
      ["no job", base(), swapEv(base()), "restore.swap_refused"], ["not local", gone, swapEv(gone), "restore.swap_not_local"]] as const) {
      const r = drive(h, ev);
      expect(writes(r.actions), name).toEqual([]); expect(norm(r.state), name).toBe(norm(h)); expect(r.hits, name).toContain(hit);
    }
  });
  // MUTANT swap-blind-needs-capture (a blind swap from armed is refused).
  it("a blind swap goes from armed straight to swapped, no carry", () => {
    const a = withJob("armed"), r = drive(a, swapEv(a, { blind: true, outgoingDb: null }));
    expect(jobPhaseOf(r.state)).toBe("swapped"); expect(r.state.carry).toBeNull(); expect(r.hits).toContain("restore.blind");
  });
});

describe("r3.4d J2 prepare (real restore-reducer.ts)", () => {
  // MUTANTS prepare-no-mark (preparedJobId not written), prepare-no-restamp (the carried unconfirmed mark is dropped), prepare-keeps-leases.
  it("prepare of a swapped job: one W4 write with the job's prepared mark; the carry stays for the clear; carried unconfirmed marks are re-stamped", () => {
    const s = swapped(); s.carry = { ...s.carry!, unconfirmedKept: { k1: 5 } }; s.local = { ...s.local, keptKeys: { ...s.local.keptKeys, k1: "au:x" }, leases: { l1: { removalId: "l1" } as never } };
    const r = drive(s, prepEv);
    expect(writes(r.actions)).toEqual(["W4_consumer_tx"]);
    expect(r.state.local.preparedJobId).toBe("job1"); expect(jobPhaseOf(r.state)).toBe("prepared"); expect(r.state.proc.phase).toBe("store_open");
    expect(r.state.carry).toEqual(s.carry);
    expect(r.state.local.unconfirmedKept).toEqual({ k1: 5 });
    expect(Object.keys(r.state.local.leases)).toEqual([]);
    expect(r.hits).toContain("restore.prepare");
  });
  // MUTANT prepare-any-phase.
  it("prepare is refused (nothing changes) unless the job is swapped", () => {
    for (const h of [base(), withJob("armed"), captured(), withJob("aborted")]) {
      const r = drive(h, prepEv); expect(writes(r.actions)).toEqual([]); expect(norm(r.state)).toBe(norm(h)); expect(r.hits).toContain("restore.prepare_refused");
    }
    const p = drive(swapped(), prepEv).state, r = drive(p, prepEv);
    expect(norm(r.state)).toBe(norm(p));
  });
  // MUTANT boot-prep-no-prep (the boot prep leaves a swapped job unprepared).
  it("the boot prep after a crash between swap and prep ends the window: W4 with the prepared mark, then W6; an armed job is not touched", () => {
    const bp: HomeEvent = { e: "bootPrep", nowMs: NOW, inject: "none" }, s = swapped(); s.proc = { ...s.proc, phase: "boot_prep" };
    const r = drive(s, bp);
    expect(writes(r.actions)).toEqual(["W4_consumer_tx", "W6_adoption_tx"]); expect(jobPhaseOf(r.state)).toBe("prepared"); expect(r.hits).toContain("bootPrep.prep");
    const a = withJob("armed"); a.proc = { ...a.proc, phase: "boot_prep" };
    expect(jobPhaseOf(drive(a, bp).state)).toBe("armed");
  });
});

describe("r3.4d J2 clear, system arm, archive fetch (real restore-reducer.ts)", () => {
  // MUTANTS clear-keeps-carry, clear-no-w30 (journal stays), clear-order (W30 before W24), clear-any-phase.
  it("clear of a prepared job deletes the carry (W24) and then unlinks the journal (W30)", () => {
    const p = drive(swapped(), prepEv).state, r = drive(p, clearEv);
    expect(writes(r.actions)).toEqual(["W24_carry_delete", "W30_job_cleared"]);
    expect(r.state.carry).toBeNull(); expect(r.state.fs.restoreJob ?? null).toBeNull(); expect(r.hits).toContain("restore.clear");
    const w24 = r.actions.find(a => a.k === "durable" && a.write === "W24_carry_delete") as unknown as { after: HomeState };
    expect(w24.after.carry).toBeNull(); expect(w24.after.fs.restoreJob?.id).toBe("job1"); // a crash between the two leaves a finished job with no carry
  });
  it("clear of an aborted job deletes its carry and drops the failed line; it is refused for open or no job", () => {
    const ab = drive(captured(), { e: "restoreAbort", nowMs: NOW, step: 8, reason: "owner_cancel" }).state, r = drive(ab, clearEv);
    expect(r.state.carry).toBeNull(); expect(r.state.fs.restoreJob ?? null).toBeNull(); expect(homeLine(r.state)).toEqual([]);
    for (const h of [base(), withJob("armed"), captured(), swapped()]) { const x = drive(h, clearEv); expect(writes(x.actions)).toEqual([]); expect(norm(x.state)).toBe(norm(h)); expect(x.hits).toContain("restore.clear_refused"); }
  });
  // MUTANTS arm-system-over-job, arm-system-not-local.
  it("a system restore arms its job like an owner request (W25, this step), only with no job and a local archive", () => {
    const r = drive(base(), { e: "restoreArm", nowMs: NOW, step: 4, source: "cloud_reset", archiveId: "a0" });
    expect(r.state.fs.restoreJob).toMatchObject({ archiveId: "a0", source: "cloud_reset", phase: "armed", at: 4 }); expect(writes(r.actions)).toEqual(["W25_job_armed"]); expect(r.hits).toContain("restore.arm_system");
    const h = base(); h.fs = { ...h.fs, localArchives: [] };
    for (const x of [withJob("armed"), withJob("aborted"), h]) { const y = drive(x, { e: "restoreArm", nowMs: NOW, step: 4, source: "cloud_reset", archiveId: "a0" }); expect(norm(y.state)).toBe(norm(x)); expect(y.hits).toContain("restore.arm_system_refused"); }
  });
  // MUTANTS fetch-no-add, fetch-line-always (the line ignores forOwner), fetch-not-frozen.
  it("archive fetch: verified makes the archive local; a failed owner fetch shows the failed line, a background one shows none; a job's archive is frozen", () => {
    const fe = (archiveId: string, outcome: "verified" | "download_failed", forOwner: boolean): HomeEvent => ({ e: "archiveFetch", nowMs: NOW, step: 3, archiveId, outcome, forOwner });
    const v = drive(base(), fe("a5", "verified", false));
    expect(v.state.fs.localArchives).toEqual(expect.arrayContaining(["a0", "a5", "a5!nolive"])); expect(v.hits).toContain("fetch.verified");
    const o = drive(base(), fe("a0", "download_failed", true)), b = drive(base(), fe("a0", "download_failed", false));
    expect(homeLine(o.state)).toEqual([RESTORE_FAILED_LINE]); expect(homeLine(b.state)).toEqual([]);
    expect(rest(o.state)).toBe(rest(base())); expect(rest(b.state)).toBe(rest(base()));
    const stale = base(); stale.surface = [{ section: "home", target: null, botId: null, inboxId: null, keyIds: [], provisionOpId: null, address: null, visible: true, line: RESTORE_FAILED_LINE, actions: [] }];
    expect(homeLine(drive(stale, fe("a0", "download_failed", false)).state)).toEqual([]);
    const j = withJob("captured"), f = drive(j, fe("a0", "verified", false));
    expect(norm(f.state)).toBe(norm(j)); expect(f.hits).toContain("fetch.frozen");
  });
});

describe("r3.4d J2 harness (moves.ts apply / enabled): the whole job, one step per transition", () => {
  const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
  const kinds = (m: ReturnType<typeof SEEDS.fresh>) => enabled(m, rt).map(x => x.t);
  // MUTANTS harness-swap-records-early (restore record when the move starts, not when W3 lands), harness-no-prepared-epoch, harness-prepare-offered-early, harness-clear-offered-early.
  it("backup, restore, capture, swap, prepare, clear: each is its own step; the recorder writes the restore record at W3 and the prepared epoch at W4", () => {
    let m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model; const id = m.env.archives[0].archiveId;
    m = apply(m, { t: "owner.restore", source: "desktop", archiveId: id }, rt).model;
    expect(kinds(m)).toContain("auto.captureOutgoing"); expect(kinds(m)).not.toContain("auto.restorePrepare"); expect(kinds(m)).not.toContain("auto.restoreJobClear"); expect(kinds(m)).not.toContain("auto.swap");
    m = apply(m, { t: "auto.captureOutgoing" }, rt).model;
    expect(kinds(m)).toContain("auto.swap"); expect(m.env.ghost.restores).toHaveLength(0);
    const sw = apply(m, { t: "auto.swap", source: "desktop", archiveId: id, blind: false }, rt);
    expect(sw.steps.map(s => s.action.t)).toEqual(["auto.swap"]); m = sw.model;
    expect(m.env.ghost.restores).toHaveLength(1);
    expect(m.env.ghost.restores[0]).toMatchObject({ jobId: m.home.fs.restoreJob!.id, atStep: m.env.step, epochAfter: 1, blind: false, ownerRequestStep: m.env.ghost.ownerRestoreRequests[0].atStep });
    expect(m.env.ghost.restores[0].carryId).toBe(m.home.carry!.carryId);
    expect(m.env.ghost.preparedEpochs).toEqual([]);
    expect(kinds(m)).toEqual(expect.arrayContaining(["auto.restorePrepare"])); expect(kinds(m)).not.toContain("auto.swap"); expect(kinds(m)).not.toContain("auto.restoreJobClear");
    m = apply(m, { t: "auto.restorePrepare", outcome: "committed" }, rt).model;
    expect(m.env.ghost.preparedEpochs).toEqual([1]); expect(kinds(m)).not.toContain("auto.restorePrepare");
    m = apply(m, { t: "auto.emailOn" }, rt).model; expect(m.home.proc.phase).toBe("running"); expect(kinds(m)).toContain("auto.restoreJobClear");
    m = apply(m, { t: "auto.restoreJobClear" }, rt).model;
    expect(m.home.fs.restoreJob ?? null).toBeNull(); expect(m.home.carry).toBeNull(); expect(kinds(m)).not.toContain("auto.restoreJobClear");
  });
  it("a crash dropping W3 records no restore; a crash after W3 does, and the boot prep then records the prepared epoch", () => {
    let m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model; const id = m.env.archives[0].archiveId;
    m = apply(apply(m, { t: "owner.restore", source: "desktop", archiveId: id }, rt).model, { t: "auto.captureOutgoing" }, rt).model;
    const before = apply(apply(m, { t: "fault.crash", at: "W3_swap_record", when: "before" }, rt).model, { t: "auto.swap", source: "desktop", archiveId: id, blind: false }, rt).model;
    expect(before.env.ghost.restores).toHaveLength(0); expect(before.home.proc.phase).toBe("down");
    const after = apply(apply(m, { t: "fault.crash", at: "W3_swap_record", when: "after" }, rt).model, { t: "auto.swap", source: "desktop", archiveId: id, blind: false }, rt).model;
    expect(after.env.ghost.restores).toHaveLength(1); expect(jobPhaseOf(after.home)).toBe("swapped");
    let b = apply(after, { t: "auto.boot" }, rt).model; b = apply(b, { t: "auto.bootPrep", outcome: "ok" }, rt).model;
    expect(b.env.ghost.preparedEpochs).toEqual([1]); expect(jobPhaseOf(b.home)).toBe("prepared");
  });
  // MUTANT harness-system-arm-names-request (a system restore claims the stale owner request).
  it("a system restore (auto.restoreArm) arms a job and its restore record names no owner request", () => {
    let m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model; const id = m.env.archives[0].archiveId;
    expect(kinds(m)).toContain("auto.restoreArm");
    m = apply(m, { t: "auto.restoreArm", source: "cloud_reset", archiveId: id }, rt).model;
    expect(m.home.fs.restoreJob).toMatchObject({ phase: "armed", source: "cloud_reset" }); expect(kinds(m)).not.toContain("auto.restoreArm"); expect(kinds(m)).not.toContain("auto.archiveFetch");
    m = apply(apply(m, { t: "auto.captureOutgoing" }, rt).model, { t: "auto.swap", source: "cloud_reset", archiveId: id, blind: false }, rt).model;
    expect(m.env.ghost.restores[0].ownerRequestStep).toBeNull();
  });
});

describe("r3.4d J2 harness gating (moves.ts enabled / apply)", () => {
  const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
  const kinds = (m: ReturnType<typeof SEEDS.fresh>) => enabled(m, rt).map(x => x.t);
  const restoreIds = (m: ReturnType<typeof SEEDS.fresh>) => enabled(m, rt).filter(x => x.t === "owner.restore").map(x => (x as { archiveId: string }).archiveId);
  // MUTANT harness-blind-with-live-db (a blind restore is offered while the home has a live database).
  it("a blind restore is offered only when the home has no live database, a plain one only when it has", () => {
    const m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model;
    expect(restoreIds(m).length).toBeGreaterThan(0); expect(restoreIds(m).some(x => x.endsWith("!nolive"))).toBe(false);
    const lost = structuredClone(m); lost.home.fs = { ...lost.home.fs, messagesDbPresent: false };
    expect(restoreIds(lost).length).toBeGreaterThan(0); expect(restoreIds(lost).every(x => x.endsWith("!nolive"))).toBe(true);
  });
  // MUTANT harness-dropped-arm-reports-ok (a restore whose arm write the crash dropped is reported ok to the owner).
  it("an owner.restore whose arm (W25) a crash dropped is stamped refused; one whose arm landed is ok", () => {
    const m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model, id = m.env.archives[0].archiveId;
    for (const when of ["before", "after"] as const) {
      const r = apply(apply(m, { t: "fault.crash", at: "W25_job_armed", when }, rt).model, { t: "owner.restore", source: "desktop", archiveId: id }, rt);
      if (when === "before") expect(r.move).toMatchObject({ outcome: { ok: false, code: "restore_not_started" } }); else expect(r.move).toMatchObject({ outcome: { ok: true } });
      expect(!!r.model.home.fs.restoreJob).toBe(when === "after");
    }
  });
  // MUTANT harness-prepare-offered-up (the restore prep is offered with the store open).
  it("the restore prep is offered only while the home is in its boot prep", () => {
    let m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model; const id = m.env.archives[0].archiveId;
    m = apply(apply(apply(m, { t: "owner.restore", source: "desktop", archiveId: id }, rt).model, { t: "auto.captureOutgoing" }, rt).model, { t: "auto.swap", source: "desktop", archiveId: id, blind: false }, rt).model;
    expect(kinds(m)).toContain("auto.restorePrepare");
    const open = structuredClone(m); open.home.proc.phase = "running"; expect(kinds(open)).not.toContain("auto.restorePrepare");
  });
});

describe("r3.4d J2 crash attribution (moves.ts react)", () => {
  const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
  const armed = () => { const m = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model, id = m.env.archives[0].archiveId; return { m: apply(m, { t: "owner.restore", source: "desktop", archiveId: id }, rt).model, id }; };
  const lastAction = (r: ReturnType<typeof apply>) => r.steps[r.steps.length - 1].action;
  // MUTANTS harness-crash-keeps-move-action (the cut step keeps the move's action), harness-w23-not-normalized (a crash after the carry write W23 is not the W26-before crash).
  it("a crash that cuts a job move before its last write is the crash's step (fault.crash); a crash after its last write leaves the move's step", () => {
    const base0 = apply(SEEDS.fresh(), { t: "owner.backup", kind: "desktop_backup" }, rt).model, id = base0.env.archives[0].archiveId, own = { t: "owner.restore" as const, source: "desktop" as const, archiveId: id };
    expect(lastAction(apply(apply(base0, { t: "fault.crash", at: "W25_job_armed", when: "before" }, rt).model, own, rt))).toEqual({ t: "fault.crash", at: "W25_job_armed", when: "before" });
    const done = apply(apply(base0, { t: "fault.crash", at: "W25_job_armed", when: "after" }, rt).model, own, rt);
    expect(done.steps.map(s => s.action.t)).toEqual(["owner.restore", "fault.crash"]); expect(done.steps[0].next.proc.phase).toBe("running"); expect(done.steps[1].next.proc.phase).toBe("down");
    const { m } = armed();
    const w23 = apply(apply(m, { t: "fault.crash", at: "W23_carry_capture", when: "after" }, rt).model, { t: "auto.captureOutgoing" }, rt);
    expect(lastAction(w23)).toEqual({ t: "fault.crash", at: "W26_job_captured", when: "before" }); // the carry landed, the phase write did not
    expect(w23.model.home.carry?.jobId).toBe(w23.model.home.fs.restoreJob?.id); expect(w23.model.home.fs.restoreJob?.phase).toBe("armed");
    expect(apply(apply(m, { t: "fault.crash", at: "W26_job_captured", when: "after" }, rt).model, { t: "auto.captureOutgoing" }, rt).steps.map(s => s.action.t)).toEqual(["auto.captureOutgoing", "fault.crash"]);
  });
});
