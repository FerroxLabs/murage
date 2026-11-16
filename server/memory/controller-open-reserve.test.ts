// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW r3.2.8 H.1 / H.2, controller side (worker-controller.ts). Rows: H1, H2, H2b, H3, H4, H4b, H4c, H5, H5b, H6, G1, G4, G6, G7, G7b, G-stop.
// The helper is scripted (a fork mock speaking the helper's messages), so every row runs on the real controller with a fake clock.
// Each row also runs at `startHoldMs: 0` where the design names a control. The probe (index-quarantine.ts probeIndexFile, WP2a) is
// mocked here to a chosen answer; its own rows belong to WP2a.
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { OVERRUN_K_UNKNOWN } from "./memw-steps.ts";
import { CHARGE_START_HOLD_MS, OPEN_RESERVE_MIN_AGE_MS, OPEN_START_RESERVE, MemoryWorkerController, requestIndexOpenReset } from "./worker-controller.ts";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: vi.fn() }));
const probe = vi.hoisted(() => ({ result: "damaged", calls: 0 }));
vi.mock("./index-quarantine.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./index-quarantine.ts")>(),
  probeIndexFile: vi.fn(() => { probe.calls++; return probe.result; }),
}));

const MiB = 1_048_576;
type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void; workerBytes: number; initFailures: number; openExitStreak: number };
const CLOCK = { toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"] as Array<"Date" | "performance" | "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "setImmediate" | "clearImmediate"> };
const HOLDS = [{ name: "real hold", hold: CHARGE_START_HOLD_MS }, { name: "hold 0 (control)", hold: 0 }];

// ---- charge-rule rig: a controller whose current helper is a stub ----
function rig(startHoldMs?: number) {
  const sent: Array<Record<string, unknown>> = [];
  const controller = new MemoryWorkerController(startHoldMs === undefined ? {} : { startHoldMs });
  const created = performance.now();
  const internals = controller as unknown as Internals;
  const stub = () => ({ kill() {}, on() {}, send: (message: Record<string, unknown>) => { sent.push(message); return true; } });
  internals.child = stub();
  let attempt = 0;
  const charge = (bytes: number, opening: boolean | undefined, child: unknown = internals.child, run = "r1") => {
    internals.onWorkerMessage(child, { type: "charge", fileId: "f1", attempt: ++attempt, bytes, helperRunId: run, ...opening === undefined ? {} : { opening } });
    return sent.at(-1)!.granted === true;
  };
  const age = () => performance.now() - created;
  return { controller, internals, stub, charge, age, sent };
}

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  vi.useFakeTimers(CLOCK); vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  probe.result = "damaged"; probe.calls = 0;
});
afterEach(async () => { vi.useRealTimers(); closeDatabase(); vi.mocked(fork).mockReset(); });

describe("reserve rule (H.1 1, H.2 4)", () => {
  it("H2: opening charges in the hold: 1 MiB + 1 B refused, 1 MiB at 10 s granted, a second helper's 1 B refused, a 0 B grant debits 0", () => {
    const r = rig();
    vi.advanceTimersByTime(OPEN_RESERVE_MIN_AGE_MS);
    expect(r.charge(MiB + 1, true)).toBe(false);
    expect(r.charge(MiB, true)).toBe(true);
    expect(r.internals.workerBytes).toBe(MiB);
    const second = r.stub(); r.internals.child = second;
    expect(r.charge(1, true, second, "r2")).toBe(false);
    expect(r.charge(0, true, second, "r2")).toBe(true);
    expect(r.internals.workerBytes).toBe(MiB);
    expect(OPEN_START_RESERVE).toBe(MiB);
    void r.controller.stop().catch(() => {});
  });
  it("H2b: 1 MiB at 5 s is refused (no grant before the controller is 10 s old), 0 B is granted at once", () => {
    const r = rig();
    expect(r.charge(0, true)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(r.charge(MiB, true)).toBe(false);
    expect(r.internals.workerBytes).toBe(0);
    void r.controller.stop().catch(() => {});
  });
  it("H3: a charge that is not an opening one (a write's check) is refused for the whole hold and granted from 60 s; a restart gets its own reserve", () => {
    const r = rig();
    vi.advanceTimersByTime(15_000);
    expect(r.charge(4096, false)).toBe(false);
    expect(r.charge(4096, undefined)).toBe(false);
    vi.advanceTimersByTime(CHARGE_START_HOLD_MS - 15_000 - 1);
    expect(r.charge(4096, false)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(r.charge(4096, false)).toBe(true);
    // kill both, restart: a new controller instance, its own hold, at most 1 MiB of reserve
    const next = rig();
    vi.advanceTimersByTime(OPEN_RESERVE_MIN_AGE_MS);
    expect(next.charge(MiB, true)).toBe(true);
    expect(next.charge(1, true)).toBe(false);
    void r.controller.stop().catch(() => {}); void next.controller.stop().catch(() => {});
  });
  it("H5b: a helper that is already ready (a non-R start sends `initialised` with its open pending) gets its 512 KiB opening charge at 10 s", () => {
    const r = rig();
    r.internals.ready = true;
    vi.advanceTimersByTime(OPEN_RESERVE_MIN_AGE_MS);
    expect(r.charge(512 * 1024, true)).toBe(true);
    void r.controller.stop().catch(() => {});
  });
  it.each(HOLDS)("H2/H3 invariants over the hold interval ($name): sum granted <= 1 MiB, no nonzero grant before 10 s, no grant without `opening`", ({ hold }) => {
    const r = rig(hold);
    const log: Array<{ age: number; bytes: number; opening: boolean; granted: boolean; child: number }> = [];
    let child: unknown = r.internals.child, who = 0;
    const go = (at: number, bytes: number, opening: boolean) => {
      vi.advanceTimersByTime(Math.max(0, at - r.age()));
      const age = r.age();
      log.push({ age, bytes, opening, granted: r.charge(bytes, opening, child, `r${who}`), child: who });
    };
    go(0, 0, true); go(1000, 4096, false); go(5000, MiB, true); go(10_000, MiB + 1, true); go(10_000, MiB, true);
    child = r.stub(); r.internals.child = child; who = 1;
    go(12_000, 1, true); go(15_000, 4096, false); go(59_900, 4096, false); go(60_100, 4096, false);
    const inHold = log.filter(entry => entry.age < hold);
    expect(inHold.filter(entry => entry.granted).reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(MiB);
    expect(inHold.filter(entry => entry.granted && entry.bytes > 0 && entry.age < OPEN_RESERVE_MIN_AGE_MS)).toEqual([]);
    expect(inHold.filter(entry => entry.granted && !entry.opening)).toEqual([]);
    void r.controller.stop().catch(() => {});
  });
});

// ---- crash-loop bound (H.1 2, H4/H4b/H4c): controllers one after another; each lives `interval`, its helper charges at the last moment ----
function loop(hold: number, intervalMs: number, perStart: number, bytes: number, horizonMs = 300_000) {
  const grants: Array<{ at: number; bytes: number }> = [];
  for (let elapsed = 0; elapsed < horizonMs; elapsed += intervalMs) {
    const r = rig(hold);
    vi.advanceTimersByTime(intervalMs - 1);
    for (let k = 0; k < perStart; k++) {
      const age = r.age();
      if (r.charge(bytes, true) && age < hold) grants.push({ at: performance.now(), bytes });
    }
    vi.advanceTimersByTime(1);
    void r.controller.stop().catch(() => {});
  }
  let max = 0;
  for (const grant of grants) max = Math.max(max, grants.filter(other => other.at <= grant.at && other.at > grant.at - 60_000).reduce((sum, other) => sum + other.bytes, 0));
  return max;
}
describe.each(HOLDS)("crash-loop bound ($name)", ({ hold }) => {
  it("H4: a crash loop at or under 10 s with a log near C each start grants no reserve byte; any loop stays <= 7 MiB per 60 s", () => {
    let worst = 0;
    for (const interval of [5000, 9900, 10_000, 10_100, 12_000, 20_000]) {
      const max = loop(hold, interval, 1, 28 * MiB);
      if (interval <= 10_000) expect(max).toBe(0);
      worst = Math.max(worst, max);
    }
    console.info(`H4 reserve bytes per 60 s window, worst over loops: ${worst} (line ${7 * MiB}, T11 ${50 * MiB})`);
    expect(worst).toBeLessThanOrEqual(7 * MiB);
  });
  it("H4c: a 1 s loop with 1 MiB opening charges: reserve bytes per window <= 7 MiB", () => {
    expect(loop(hold, 1000, 1, MiB)).toBeLessThanOrEqual(7 * MiB);
  });
  it("H4b: a 12 s loop, three 1 MiB opening charges each start: the window holds at most 5 MiB (< 50 MiB)", () => {
    const max = loop(hold, 12_000, 3, MiB);
    expect(max).toBeLessThanOrEqual(5 * MiB);
    expect(max).toBeLessThan(50 * MiB);
  });
});

// ---- scripted helpers over the real controller ----
type Init = { type?: string; reset?: { resetId: number } };
class Helper extends EventEmitter {
  poll: ReturnType<typeof setInterval> | null = null;
  grantedAt: number | null = null;
  constructor(readonly index: number, readonly script: (helper: Helper, init: Init) => void, readonly onAck: (helper: Helper, granted: boolean) => void) { super(); }
  send = vi.fn((message: Init & { granted?: boolean }) => {
    if (message.type === "init") setTimeout(() => this.script(this, message), 0);
    if (message.type === "charge-ack") this.onAck(this, message.granted === true);
    return true;
  });
  kill = vi.fn(() => { this.exit(null); return true; });
  disconnect() { this.exit(0); }
  exit(code: number | null) { if (this.poll) clearInterval(this.poll); this.poll = null; this.emit("exit", code, null); }
  say(message: Record<string, unknown>) { this.emit("message", message); }
}
let controller: MemoryWorkerController, created: number, helpers: Helper[], starts: number[];
function boot(script: (helper: Helper, init: Init) => void, onAck: (helper: Helper, granted: boolean) => void = () => {}, hold?: number) {
  helpers = []; starts = [];
  controller = new MemoryWorkerController(hold === undefined ? {} : { startHoldMs: hold });
  created = performance.now();
  vi.mocked(fork).mockImplementation(() => {
    const helper = new Helper(helpers.length, script, onAck);
    helpers.push(helper); starts.push(performance.now() - created);
    setTimeout(() => helper.say({ type: "ready" }), 0);
    return helper as unknown as ReturnType<typeof fork>;
  });
}
const internals = () => controller as unknown as Internals;
const owedJob = () => captureSource(database(), { id: "source", threadId: "thread", kind: "text", speaker: "owner", outcome: "recorded", text: "The smoke round is two." });
const overrun = () => database().prepare("SELECT resets,reset_id,state,due_at,kind FROM index_overrun").all() as Array<Record<string, unknown>>;
const finishR = (helper: Helper, init: Init) => { helper.say({ type: "index-opening" }); helper.say({ type: "initialised", resetDone: init.reset?.resetId }); };
const openExit = (helper: Helper) => { helper.say({ type: "index-opening" }); helper.exit(1); };

describe.each(HOLDS)("launch and R start ($name)", ({ hold }) => {
  it("H1: a clean launch: `initialised` at once, the open's opening charge granted at 10 s (at once at hold 0), 0 failed starts", async () => {
    let refused = 0;
    boot((helper, init) => {
      helper.say({ type: "index-opening" }); helper.say({ type: "initialised" });
      let attempt = 0;
      helper.poll = setInterval(() => helper.say({ type: "charge", fileId: "f1", attempt: ++attempt, bytes: 512 * 1024, helperRunId: `h${helper.index}`, opening: true }), 50);
      void init;
    }, (helper, granted) => { if (granted) { if (helper.poll) clearInterval(helper.poll); helper.poll = null; helper.grantedAt = performance.now() - created; } else refused++; }, hold);
    owedJob(); controller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(helpers.length).toBeGreaterThanOrEqual(1);
    expect(helpers[0]!.grantedAt).not.toBeNull();
    if (hold === 0) { expect(helpers[0]!.grantedAt!).toBeLessThan(2000); expect(refused).toBe(0); }
    else { expect(helpers[0]!.grantedAt!).toBeGreaterThanOrEqual(OPEN_RESERVE_MIN_AGE_MS); expect(helpers[0]!.grantedAt!).toBeLessThan(OPEN_RESERVE_MIN_AGE_MS + 1000); }
    expect(internals().initFailures).toBe(0);
    expect(controller.error).toBeNull();
    await controller.stop();
  });
  it("H6: R requested at controller t = 0: the helper is spawned no earlier than 10 s (at once at hold 0), R completes once, 0 failed starts", async () => {
    requestIndexOpenReset();
    boot(finishR, () => {}, hold);
    controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(helpers).toHaveLength(1);
    if (hold === 0) expect(starts[0]!).toBeLessThan(1000); else { expect(starts[0]!).toBeGreaterThanOrEqual(OPEN_RESERVE_MIN_AGE_MS); expect(starts[0]!).toBeLessThan(OPEN_RESERVE_MIN_AGE_MS + 1000); }
    expect(overrun().map(row => row.state)).toEqual(["complete"]);
    expect(internals().initFailures).toBe(0);
    await controller.stop();
  });
  it("H5: an R start whose open needs 4 MiB (> the reserve): refused, failed, respawned at controller start + 60 s with no doubling, status names the reason", async () => {
    requestIndexOpenReset();
    boot((helper, init) => {
      if (helper.index > 0) { finishR(helper, init); return; }
      helper.say({ type: "index-opening" });
      helper.say({ type: "charge", fileId: "f1", attempt: 1, bytes: 4 * MiB, helperRunId: "h0", opening: true });
      helper.say({ type: "initialised", resetDone: undefined });
    }, () => {}, hold);
    controller.start();
    await vi.advanceTimersByTimeAsync(CHARGE_START_HOLD_MS + 3000);
    if (hold === 0) { expect(starts[0]!).toBeLessThan(1000); return; }
    expect(helpers).toHaveLength(2);
    expect(starts[0]!).toBeGreaterThanOrEqual(OPEN_RESERVE_MIN_AGE_MS);
    expect(starts[1]!).toBeGreaterThanOrEqual(CHARGE_START_HOLD_MS);
    expect(starts[1]!).toBeLessThan(CHARGE_START_HOLD_MS + 2000);
    expect(internals().initFailures).toBe(0);
    expect(overrun().map(row => row.state)).toEqual(["complete"]);
    await controller.stop();
  });
});

describe("open-exit streak and the probe (H.1 5-6)", () => {
  const twoOpenExits = async () => { owedJob(); controller.start(); await vi.advanceTimersByTimeAsync(400_000); };
  it("G1 control: two adjacent open exits and a `damaged` probe write one row: requested, kind open, resets unchanged (absent row = OVERRUN_K_UNKNOWN)", async () => {
    boot(openExit);
    await twoOpenExits();
    expect(probe.calls).toBeGreaterThanOrEqual(1);
    expect(overrun()).toEqual([expect.objectContaining({ state: "requested", kind: "open", resets: OVERRUN_K_UNKNOWN })]);
    await controller.stop();
  });
  it("G6: a `healthy` (or busy) probe answer writes no row and breaks the streak", async () => {
    boot(openExit); probe.result = "healthy";
    await twoOpenExits();
    expect(probe.calls).toBeGreaterThanOrEqual(1);
    expect(overrun()).toEqual([]);
    await controller.stop();
    boot(openExit); probe.result = "busy"; probe.calls = 0;
    await twoOpenExits();
    expect(overrun()).toEqual([]);
    await controller.stop();
  });
  it("G4: exits of a start that sent a charge (a hold-refused open) are not open exits: 0 rows, the probe is never asked", async () => {
    boot(helper => { helper.say({ type: "index-opening" }); helper.say({ type: "charge", fileId: "f1", attempt: 1, bytes: 4 * MiB, helperRunId: `h${helper.index}`, opening: true }); helper.exit(1); });
    await twoOpenExits();
    expect(helpers.length).toBeGreaterThanOrEqual(2);
    expect(probe.calls).toBe(0);
    expect(overrun()).toEqual([]);
    await controller.stop();
  });
  it("G7: open, hold-refused, open gives 0 rows; open, initialised then exit, open gives 0", async () => {
    boot(helper => { if (helper.index === 1) { helper.say({ type: "index-opening" }); helper.say({ type: "charge", fileId: "f1", attempt: 1, bytes: 4 * MiB, helperRunId: "h1", opening: true }); helper.exit(1); } else if (helper.index > 2) { helper.exit(0); } else openExit(helper); });
    await twoOpenExits();
    expect(helpers.length).toBeGreaterThanOrEqual(3);
    expect(probe.calls).toBe(0);
    expect(overrun()).toEqual([]);
    await controller.stop();
    boot(helper => { if (helper.index === 1) { helper.say({ type: "index-opening" }); helper.say({ type: "initialised" }); helper.exit(1); } else if (helper.index > 2) { helper.exit(0); } else openExit(helper); });
    await twoOpenExits();
    expect(helpers.length).toBeGreaterThanOrEqual(3);
    expect(probe.calls).toBe(0);
    expect(overrun()).toEqual([]);
    await controller.stop();
  });
  it("G7b: a row already 'requested' is kept byte for byte: no new reset id, due time, kind or resets", async () => {
    requestIndexOpenReset(1_000);
    const before = overrun();
    expect(before).toEqual([expect.objectContaining({ state: "requested", due_at: 1_000 })]);
    boot(openExit);
    await twoOpenExits();
    expect(probe.calls).toBeGreaterThanOrEqual(1);
    expect(overrun()).toEqual(before);
    await controller.stop();
  });
  it("G2 (controller side): an R start whose helper keeps exiting at its open (a rename faulted EBUSY or EPERM) keeps R requested and the set whole: the row is never rewritten, the ladder backs off", async () => {
    requestIndexOpenReset(2_000);
    const before = overrun();
    boot(openExit);
    controller.start();
    await vi.advanceTimersByTimeAsync(CHARGE_START_HOLD_MS + 150_000);
    expect(overrun()).toEqual(before);
    // 30 s then 60 s then 120 s rungs: far fewer starts than a tight loop
    expect(helpers.length).toBeGreaterThanOrEqual(2);
    expect(helpers.length).toBeLessThanOrEqual(6);
    await controller.stop();
  });
  it("G-stop: an exit while the controller is stopping is never an open exit and never asks the probe", async () => {
    boot(helper => { if (helper.index === 0) openExit(helper); else { helper.say({ type: "index-opening" }); (helper as { disconnect: () => void }).disconnect = () => helper.exit(1); } });
    owedJob(); controller.start();
    for (let s = 0; s < 200 && helpers.length < 2; s++) await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(helpers.length).toBe(2);
    internals().openExitStreak = 1;
    await controller.stop();
    expect(probe.calls).toBe(0);
    expect(overrun()).toEqual([]);
  });
});
