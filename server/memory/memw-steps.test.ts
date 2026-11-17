// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2: the pure admission arithmetic (spec 1.1, 1.5, 1.8). The T2 rows that need a live index run in memw-index.test.ts.
import { describe, expect, it } from "vitest";
import * as m from "./memw-steps.ts";

const MiB = 1024 * 1024, PAGE = 4096, FZ = PAGE + 24;

describe("MEMW lines (1.1): the named values T2 reads", () => {
  it("C 28 MB, W fill/delete 4 MB, W merge 12 MB, admit 16 MB, tick 8 MB, 250 ms, gate 48 / ceiling 80, N 64, seal 4 frames", () => {
    expect([m.MEMW_C_BYTES, m.MEMW_W_STEP_BYTES, m.MEMW_W_MERGE_BYTES, m.MEMW_STEP_ADMIT_BYTES, m.MEMW_TICK_TRUNCATE_BYTES]).toEqual([28 * MiB, 4 * MiB, 12 * MiB, 16 * MiB, 8 * MiB]);
    expect([m.MEMW_CALL_MS, m.MEMW_SEGMENT_GATE, m.MEMW_SEGMENT_CEILING, m.MEMW_MERGE_PAGES, m.MEMW_SEAL_FRAMES, m.MEMW_SEGMENT_STEP_STOP, m.MEMW_SEGMENT_READ_WRITES]).toEqual([250, 48, 80, 64, 4, 63, 16]);
    expect([m.MEMW_F_INS_FRAMES, m.MEMW_F_DEL_FRAMES, m.MEMW_ROW_BYTES, m.MEMW_CHARGE_MAX_RECORDS, m.MEMW_K_PIN]).toEqual([64, 32, 512, 65_536, 0.052]);
    expect(m.MEMW_R_W).toBeLessThanOrEqual(8); expect(m.MEMW_R_D).toBeLessThanOrEqual(8);
  });
  it("the tier ceiling is C - 32 B - F_del = 27.87 MiB at 4 KiB pages; S is 4 frames", () => {
    expect(m.tierCeiling(PAGE)).toBe(28 * MiB - 32 - 32 * FZ);
    expect((m.tierCeiling(PAGE) / MiB).toFixed(2)).toBe("27.87");
    expect(m.admitSlack(PAGE)).toBe(4 * FZ);
    expect(m.walLength(256, 4096)).toBe(32 + 256 * FZ);
  });
});

describe("T2 remedy rows (r22 3.8): halved sets", () => {
  it("halve tick, step admit, fill/delete W and controller records together; C, merge line, W_merge and N stay", () => {
    const [l0, l1, l2] = [m.memwLines(0), m.memwLines(1), m.memwLines(2)];
    expect([l0.tickTruncate, l1.tickTruncate, l2.tickTruncate]).toEqual([8 * MiB, 4 * MiB, 2 * MiB]);
    expect([l0.stepAdmit, l1.stepAdmit, l2.stepAdmit]).toEqual([16 * MiB, 8 * MiB, 4 * MiB]);
    expect([l0.wStep, l1.wStep, l2.wStep]).toEqual([4 * MiB, 2 * MiB, 1 * MiB]);
    expect([l0.controllerRecords, l1.controllerRecords, l2.controllerRecords]).toEqual([16, 8, 4]);
    for (const l of [l0, l1, l2]) { expect(l.c).toBe(28 * MiB); expect(l.mergeAdmit).toBe(16 * MiB); expect(l.wMerge).toBe(12 * MiB); expect(l.mergePages).toBe(64); }
    expect([l0.sealAfterMerge, l1.sealAfterMerge, l2.sealAfterMerge]).toEqual([false, true, true]);
    expect(m.MEMW_REMEDY_LEVEL).toBe(0);
  });
  it("a halved set's step admission follows its own line, the merge line does not move", () => {
    const l2 = m.memwLines(2);
    expect(m.admits("fill", l2.wStep, { L: 5 * MiB, pageSize: PAGE, lines: l2 })).toBe(false);
    expect(m.admits("merge", l2.wMerge, { L: 15 * MiB, pageSize: PAGE, lines: l2 })).toBe(true);
  });
});

describe("T2(13) sizer (1.5): X, rho, budget, take", () => {
  it("X counts R_row per row, so 30 B rows are sized by their row term (mutant: text-only denominator)", () => {
    expect(m.rowX({ id: "a".repeat(10), scope: "s".repeat(10), text: "t".repeat(10) })).toBe(30 + 512);
    expect(m.rowX({ id: "k".repeat(20) }, true)).toBe(20 + 512);
    const sizer = new m.StepSizer(PAGE);
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: `r${i}`.padEnd(10, "x"), scope: "s".repeat(10), text: "t".repeat(10) }));
    sizer.record("fill", { x: 1, rows: 1, rise: 0, ms: 1 }); // past the first-step quarter
    const step = sizer.take("fill", rows, r => m.rowX(r));
    const predicted = sizer.predict("fill", step.x).bytes;
    expect(predicted).toBeLessThanOrEqual(0.8 * m.MEMW_W_STEP_BYTES + 1);
    expect(step.rows.length).toBeLessThan(2_000); // 30 B rows: ~1,930 at the 3.11 floor with R_row; ~33k without it
  });
  it("seeds are the floors; history raises rho; the first step after open is a quarter", () => {
    const s = new m.StepSizer(PAGE);
    expect(s.rho("fill")).toBe(3.11); expect(s.rho("delete")).toBe(3.1); expect(s.rho("keys")).toBe(8); expect(s.rho("stage_drop")).toBe(8);
    const full = (0.8 * 4 * MiB - 64 * FZ) / 3.11;
    expect(s.budget("fill")).toBeCloseTo(full / 4, 6);
    s.record("fill", { x: 100_000, rows: 10, rise: 64 * FZ + 500_000, ms: 10 });
    expect(s.rho("fill")).toBeCloseTo(5, 6);
    expect(s.budget("fill")).toBeCloseTo((0.8 * 4 * MiB - 64 * FZ) / 5, 6);
  });
  it("the crossing row is deferred unless it is first; never < 1 row; capped at 16,384 rows (keys 50,000)", () => {
    const s = new m.StepSizer(PAGE);
    const big = [{ x: 10 * MiB }, { x: 1 }];
    expect(s.take("fill", big, r => r.x).rows.length).toBe(1);
    const budget = s.budget("fill");
    const two = [{ x: budget - 10 }, { x: 20 }, { x: 1 }];
    expect(s.take("fill", two, r => r.x).rows.length).toBe(1);
    expect(s.take("fill", Array.from({ length: 40_000 }, () => ({ x: 0 })), r => r.x).rows.length).toBe(16_384);
    expect(s.take("keys", Array.from({ length: 60_000 }, () => ({ x: 0 })), r => r.x).rows.length).toBe(50_000);
  });
  it("mult_k = min(2^k, 8) from the shipped base each time, never compounded; a missing or bad overrun_k is k = 3 (x8)", () => {
    expect([0, 1, 2, 3, 4, 9].map(m.resetMultiplier)).toEqual([1, 2, 4, 8, 8, 8]);
    let k = 2;
    const s = new m.StepSizer(PAGE, () => k);
    expect(s.rho("fill")).toBeCloseTo(3.11 * 4, 9);
    k = 3; expect(s.rho("fill")).toBeCloseTo(3.11 * 8, 9);
    expect(m.overrunK(undefined)).toBe(3); expect(m.overrunK("x")).toBe(3); expect(m.overrunK("-1")).toBe(3); expect(m.overrunK("0")).toBe(0); expect(m.overrunK("2")).toBe(2);
    expect(m.resetMultiplier(m.overrunK(null))).toBe(8);
  });
  it("halves after a call > 150 ms; doubles back only after 8 consecutive calls <= 100 ms; a call > 100 ms resets the run", () => {
    const s = new m.StepSizer(PAGE);
    s.record("delete", { x: 1, rows: 1, rise: 0, ms: 10 });
    const b = s.budget("delete");
    s.record("delete", { x: 1, rows: 1, rise: 0, ms: 200 });
    expect(s.budget("delete")).toBeCloseTo(b / 2, 6);
    for (let i = 0; i < 7; i++) s.record("delete", { x: 1, rows: 1, rise: 0, ms: 50 });
    s.record("delete", { x: 1, rows: 1, rise: 0, ms: 120 }); // resets the run, does not halve
    expect(s.budget("delete")).toBeCloseTo(b / 2, 6);
    for (let i = 0; i < 7; i++) s.record("delete", { x: 1, rows: 1, rise: 0, ms: 50 });
    expect(s.budget("delete")).toBeCloseTo(b / 2, 6);
    s.record("delete", { x: 1, rows: 1, rise: 0, ms: 50 });
    expect(s.budget("delete")).toBeCloseTo(b, 6);
  });
  it("alternating 160 ms and 90 ms calls only ever shrink the step (mutant: double back after 1 fast call)", () => {
    const s = new m.StepSizer(PAGE);
    s.record("fill", { x: 1, rows: 1, rise: 0, ms: 10 });
    const b = s.budget("fill");
    for (let i = 0; i < 6; i++) { s.record("fill", { x: 1, rows: 1, rise: 0, ms: 160 }); s.record("fill", { x: 1, rows: 1, rise: 0, ms: 90 }); }
    expect(s.budget("fill")).toBeCloseTo(b / 64, 6);
  });
  it("F9: every step record carries input bytes, predicted vs actual frames, per-row and meta terms", () => {
    const s = new m.StepSizer(PAGE);
    const r = s.record("fill", { x: 10_512, rows: 1, rise: 70 * FZ, ms: 3, inputBytes: 10_000 });
    expect(r).toMatchObject({ kind: "fill", x: 10_512, rows: 1, actualFrames: 70, metaTerm: 64 * FZ, inputBytes: 10_000 });
    expect(r.predictedFrames).toBe(Math.ceil((64 * FZ + 3.11 * 10_512) / FZ));
    expect(r.perRowTerm).toBeCloseTo(512 * 3.11, 6);
  });
});

describe("units and groups (1.5)", () => {
  it("unit cost: written x R_w + stored x R_d + F_ins + F_del", () => {
    const u = { id: "a", scopeId: "b", text: "cc", deleted: false, stored: 10 };
    expect(m.unitCost(u, PAGE)).toBe(4 * 8 + 10 * 8 + 64 * FZ + 32 * FZ);
    expect(m.unitCost({ ...u, deleted: true }, PAGE)).toBe(10 * 8 + 32 * FZ);
    expect(m.unitCost({ ...u, stored: 0 }, PAGE)).toBe(4 * 8 + 64 * FZ);
  });
  it("T2(14) unit writes count squatter delete AND re-insert: 4 per relocating replacement (mutant: 2 per unit)", () => {
    expect(m.writesOf({ previous: true, squatter: true, insert: true, squatterReinsert: true })).toBe(4);
    expect(m.writesOf({ previous: false, squatter: false, insert: true, squatterReinsert: false })).toBe(1);
    const units = Array.from({ length: 16 }, () => ({ cost: 1, writes: { lexical: 4 } }));
    expect(m.formGroup(units, 0, { L: 32, pageSize: PAGE, msPerCostByte: 0 }).count).toBe(8); // 8 x 4 = 32 writes
  });
  it("<= 16 units; split at 32 writes per table; L + cost + S <= C; one unit too large alone does not fit", () => {
    const small = Array.from({ length: 40 }, () => ({ cost: 10, writes: { lexical: 1, lexical_age: 1 } }));
    expect(m.formGroup(small, 0, { L: 32, pageSize: PAGE, msPerCostByte: 0 }).count).toBe(16);
    const mixed = [{ cost: 1, writes: { lexical: 30 } }, { cost: 1, writes: { lexical: 3 } }];
    expect(m.formGroup(mixed, 0, { L: 32, pageSize: PAGE, msPerCostByte: 0 }).count).toBe(1);
    const fat = [{ cost: 10 * MiB, writes: {} }, { cost: 10 * MiB, writes: {} }];
    expect(m.formGroup(fat, 0, { L: 5 * MiB, pageSize: PAGE, msPerCostByte: 0 }).count).toBe(2); // 25 MiB + S <= C
    expect(m.formGroup(fat, 0, { L: 8 * MiB, pageSize: PAGE, msPerCostByte: 0 }).count).toBe(1); // 28 MiB + S > C
    expect(m.formGroup(fat, 0, { L: 20 * MiB, pageSize: PAGE, msPerCostByte: 0 })).toEqual({ count: 0, cost: 0, fitsAlone: false });
  });
  it("T2(15) predicted group time <= 100 ms (mutant: no time aim), never < 1 unit", () => {
    const clock = new m.GroupClock();
    clock.record(50, 1000); clock.record(10, 1000);
    expect(clock.msPerCostByte()).toBeCloseTo(0.05, 9);
    const units = Array.from({ length: 16 }, () => ({ cost: 1000, writes: { lexical: 1 } }));
    expect(m.formGroup(units, 0, { L: 32, pageSize: PAGE, msPerCostByte: clock.msPerCostByte() }).count).toBe(2);
    expect(m.formGroup(units, 0, { L: 32, pageSize: PAGE, msPerCostByte: 10 }).count).toBe(1);
  });
});

describe("T2(4) admission (1.5)", () => {
  it("nothing but seal while drain; nothing but maintenance while a batch is held", () => {
    expect(m.admits("fill", 1, { L: 32, pageSize: PAGE, drain: true })).toBe(false);
    expect(m.admits("seal", 1, { L: 27 * MiB, pageSize: PAGE, drain: true })).toBe(true);
    expect(m.admits("group", 1, { L: 32, pageSize: PAGE, held: true })).toBe(false);
    expect(m.admits("merge", 12 * MiB, { L: 32, pageSize: PAGE, held: true, maintenance: true })).toBe(true);
  });
  it("every admitted step has L + W + S <= C and L <= 16 MiB; merges at L <= 16 MiB", () => {
    for (let L = 32; L <= 28 * MiB; L += 257 * 1024) {
      if (m.admits("fill", 4 * MiB, { L, pageSize: PAGE })) { expect(L + 4 * MiB + 4 * FZ).toBeLessThanOrEqual(28 * MiB); expect(L).toBeLessThanOrEqual(16 * MiB); }
      if (m.admits("merge", 12 * MiB, { L, pageSize: PAGE })) { expect(L + 12 * MiB + 4 * FZ).toBeLessThanOrEqual(28 * MiB); expect(L).toBeLessThanOrEqual(16 * MiB); }
    }
    expect(m.admits("merge", 12 * MiB, { L: 16 * MiB - 4 * FZ, pageSize: PAGE })).toBe(true);
    expect(m.admits("merge", 12 * MiB, { L: 16 * MiB, pageSize: PAGE })).toBe(false);
  });
  it("T2(11) a tier step only at L = 32 B (mutant: tier at L <= 16 MB), up to the ceiling", () => {
    expect(m.admits("tier", 20 * MiB, { L: 32, pageSize: PAGE })).toBe(true);
    expect(m.admits("tier", 20 * MiB, { L: 32 + FZ, pageSize: PAGE })).toBe(false);
    expect(m.admits("tier", 8 * MiB, { L: 4 * MiB, pageSize: PAGE })).toBe(false);
    expect(m.admits("tier", m.tierCeiling(PAGE) + 1, { L: 32, pageSize: PAGE })).toBe(false);
  });
});

describe("T2(14) segments (1.5)", () => {
  const structure = (levels: number, segments: number, marker = false) => {
    const v = (n: number) => { const out: number[] = []; const b: number[] = []; do { b.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n); for (let i = 0; i < b.length; i++) out.push(b[i] | (i < b.length - 1 ? 0x80 : 0)); return out; };
    return Uint8Array.from([0, 0, 0, 1, ...(marker ? [0xff, 0, 0, 1] : []), ...v(levels), ...v(segments)]);
  };
  it("reads the segment count from the structure record, with and without the version marker", () => {
    expect(m.structureSegments(structure(2, 47))).toBe(47);
    expect(m.structureSegments(structure(3, 300, true))).toBe(300);
    expect(m.structureSegments(null)).toBeNull();
  });
  it("the gate closes above 48, not 64 (mutant: gate 64)", () => {
    expect(m.segmentGateOpen([48, 10])).toBe(true);
    expect(m.segmentGateOpen([49])).toBe(false);
    expect(m.segmentGateOpen([10, 60])).toBe(false);
  });
  it("D3 re-reads every 16 FTS row writes and ends at a read showing >= 63; bound 79 (mutant: 64 KB read cadence)", () => {
    let segs = 40, reads = 0, writes = 0;
    const w = new m.SegmentWatch(() => { reads++; return segs; });
    while (w.wrote()) { writes++; if (writes % 4 === 0) segs++; if (writes > 10_000) break; }
    expect(reads).toBe(Math.ceil((writes + 1) / 16));
    expect(segs).toBeLessThanOrEqual(79);
    expect(segs).toBeGreaterThanOrEqual(63);
  });
});

describe("T2(10)/(11) merge prediction and routes (1.8)", () => {
  it("pred = k x T + 128 frames; k = max(K_PIN x mult, last-8 rise/T)", () => {
    const p = new m.MergePredictor(PAGE);
    expect(p.pred("lexical", 100 * MiB)).toBeCloseTo(0.052 * 100 * MiB + 128 * FZ, 3);
    p.record("lexical", 10 * MiB, 100 * MiB);
    expect(p.k("lexical")).toBeCloseTo(0.1, 9);
    expect(new m.MergePredictor(PAGE, () => 2).k("lexical")).toBeCloseTo(0.052 * 4, 9);
  });
  it("<= 12 MiB merge; to 27.87 MiB tier; beyond: floor", () => {
    expect(m.mergeRoute(12 * MiB, PAGE)).toBe("merge");
    expect(m.mergeRoute(12 * MiB + 1, PAGE)).toBe("tier");
    expect(m.mergeRoute(20 * MiB, PAGE)).toBe("tier");
    expect(m.mergeRoute(m.tierCeiling(PAGE), PAGE)).toBe("tier");
    expect(m.mergeRoute(m.tierCeiling(PAGE) + 1, PAGE)).toBe("floor");
  });
  it("gate hold R1: maintenance merges only while elapsed + 750 ms <= 5,000 ms", () => {
    expect(m.gateHoldMayMerge(4_250)).toBe(true);
    expect(m.gateHoldMayMerge(4_251)).toBe(false);
  });
});
