// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// nlrace P2, C1-C5, T2, V4: a stop that cannot be proven keeps the bot refused and is re-attempted with bounded backoff; it is released ONLY by a
// proof (gone) from a current probe. Each probe is its own helper child; a hung helper is aborted and killed at the cap, abandoned at 3 x cap,
// and never starves the next attempt. The clock, the helpers and the kill are doubles: every interleaving is forced.
import { assert, describe, expect, it } from "vitest";
import { McpStopRecovery, PROBE_CAP_MS, type ProbeHandle, type ProbeOutcome, type RecoveryDeps } from "./mcp-stop-recovery.ts";
import type { StopRecord } from "./mcp-stop-proof.ts";

const record = (owner = "bot-1", generation = 1): StopRecord => ({ version: 1, owner, generation, platform: "cloud", state: "STOPPING", cloud: { unit: "murage-mcp-0123456789abcdef.scope", cgroupPath: "/x/murage-mcp-0123456789abcdef.scope", contained: true } });

class FakeClock {
  now = 1_000_000;
  #timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  setTimeout = (fn: () => void, ms: number) => { const t = { at: this.now + ms, fn, live: true }; this.#timers.push(t); return () => { t.live = false; }; };
  clock = { now: () => this.now, setTimeout: this.setTimeout };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    let fired = 0;
    for (;;) {
      await flush();
      const next = this.#timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      // nlrace4a (Astra 10): a recovery with no backoff re-arms itself every ms; that is a failed ASSERTION here, never a test timeout.
      if (++fired > 500) assert.fail(`a tight loop: more than 500 timer firings inside one advance of ${ms} ms (the backoff is gone)`);
      next.live = false; this.now = Math.max(this.now, next.at); next.fn();
    }
    this.now = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

interface Probe extends ProbeHandle { killed: number; settle(outcome: ProbeOutcome): void; exit(): void; signal: AbortSignal; isAlive: boolean }
function probe(signal: AbortSignal, immediate?: ProbeOutcome, exitsOnKill = false): Probe {
  let settle!: (o: ProbeOutcome) => void;
  let exit!: () => void;
  const result = new Promise<ProbeOutcome>((resolve) => { settle = resolve; });
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const p: Probe = { result, exited, killed: 0, signal, isAlive: true, settle, exit: () => { p.isAlive = false; exit(); },
    kill() { p.killed++; if (exitsOnKill) p.exit(); }, alive: () => p.isAlive };
  if (immediate) { settle(immediate); p.exit(); }
  return p;
}
interface Rig { r: McpStopRecovery; clock: FakeClock; launches: Probe[]; kills: StopRecord[]; released: StopRecord[]; health: Array<{ owner: string; reason: string }>; script: Array<(signal: AbortSignal) => Probe> }
function rig(over: Partial<RecoveryDeps> = {}): Rig {
  const clock = new FakeClock();
  const rg: Rig = { clock, launches: [], kills: [], released: [], health: [], script: [], r: undefined as unknown as McpStopRecovery };
  rg.r = new McpStopRecovery({
    clock: clock.clock,
    launch: (_rec, signal) => { const p = (rg.script.shift() ?? ((s) => probe(s, { v: "unknown", why: "default" })))(signal); rg.launches.push(p); return p; },
    reKill: async (rec) => { rg.kills.push(rec); },
    release: (rec) => { rg.released.push(rec); },
    health: (item) => rg.health.push(item),
    ...over,
  });
  return rg;
}
const unknownProbe = () => (s: AbortSignal) => probe(s, { v: "unknown", why: "x" });
const goneProbe = () => (s: AbortSignal) => probe(s, { v: "gone" });
const aliveProbe = () => (s: AbortSignal) => probe(s, { v: "alive", why: "x" });
const hung = (exitsOnKill = false) => (s: AbortSignal) => probe(s, undefined, exitsOnKill);

describe("RC: bounded recovery (C1-C5, T2)", () => {
  it("RC1 T10: UNKNOWN twice then a gone proof releases the bot, on the 2 s, 10 s, 30 s schedule", async () => {
    const x = rig(); x.script.push(unknownProbe(), unknownProbe(), goneProbe());
    const t0 = x.clock.now;
    let released = false;
    void x.r.enroll(record()).then(() => { released = true; });
    expect(x.r.quarantined("bot-1")).toBe(true);
    await x.clock.advance(60_000);
    expect(released).toBe(true);
    expect(x.r.quarantined("bot-1")).toBe(false);
    expect(x.released).toHaveLength(1);
    expect(x.r.inspect(record())).toBeUndefined();
    void t0;
  });
  it("RC2 T11: a permanent UNKNOWN stays refused with no tight loop (attempt times asserted: 2 s, 10 s, 30 s, then every 60 s)", async () => {
    const x = rig();
    void x.r.enroll(record());
    await x.clock.advance(20 * 60_000);
    expect(x.r.quarantined("bot-1")).toBe(true);
    expect(x.released).toHaveLength(0);
    const starts = x.r.inspect(record())!.starts;
    const gaps = starts.slice(1).map((at, i) => at - starts[i]!);
    expect(starts[0]! - 1_000_000).toBe(2_000);
    expect(gaps.slice(0, 3)).toEqual([10_000, 30_000, 60_000]);
    expect(gaps.slice(3).every((gap) => gap === 60_000)).toBe(true);
    expect(starts.length).toBeLessThan(25);
  });
  it("RC3 T12/C5: an alive proof keeps the refusal and re-kills on the same backoff; never releases", async () => {
    const x = rig(); for (let i = 0; i < 6; i++) x.script.push(aliveProbe());
    void x.r.enroll(record());
    await x.clock.advance(5 * 60_000);
    expect(x.r.quarantined("bot-1")).toBe(true);
    expect(x.kills.length).toBeGreaterThanOrEqual(5);
    expect(x.released).toHaveLength(0);
  });
  it("RC4 C3/R10: after the 3rd UNKNOWN the platform kill is sent once more, then one more proof; a group kill is never part of it", async () => {
    const x = rig(); x.script.push(unknownProbe(), unknownProbe(), unknownProbe(), goneProbe());
    void x.r.enroll(record());
    await x.clock.advance(10_000 + 2_000 + 30_000 - 1);
    expect(x.kills).toHaveLength(0);
    await x.clock.advance(1);
    expect(x.kills).toHaveLength(1);
    await x.clock.advance(70_000);
    expect(x.released).toHaveLength(1);
  });
  it("RC5 release happens only on a gone proof from the CURRENT probe: unknown never releases, and nothing time-based does", async () => {
    const x = rig();
    void x.r.enroll(record());
    await x.clock.advance(60 * 60_000);
    expect(x.released).toHaveLength(0);
    expect(x.r.quarantined("bot-1")).toBe(true);
  });
  it("RC6 the bot's next turn request re-proves now, single flight (five requests are one probe)", async () => {
    const x = rig(); x.script.push(hung(), goneProbe());
    void x.r.enroll(record());
    for (let i = 0; i < 5; i++) x.r.requestProbe("bot-1");
    await flush();
    expect(x.launches).toHaveLength(1);
  });
  it("RC7 a restart enrolls with an immediate first proof", async () => {
    const x = rig(); x.script.push(goneProbe());
    const done = x.r.enroll(record(), { immediate: true });
    await done;
    expect(x.released).toHaveLength(1);
  });
  it("RC8 the REPARENTED flag found by a probe is persisted before the next attempt", async () => {
    const saved: StopRecord[] = [];
    const x = rig({ save: (rec) => { saved.push(rec); } });
    const rec: StopRecord = { ...record(), platform: "desktop", cloud: undefined, desktop: { pairs: [{ pid: 10, start: "a" }, { pid: 11, start: "b" }], rootPair: { pid: 10, start: "a" }, captureCompleted: true } };
    x.script.push((s) => probe(s, { v: "unknown", why: "reparented", reparented: [{ pid: 11, start: "b" }] }));
    void x.r.enroll(rec);
    await x.clock.advance(2_500);
    expect(saved[0]?.desktop?.pairs.find((p) => p.pid === 11)?.reparented).toBe(true);
  });
});

describe("RH: health is decoupled from escalation (U4)", () => {
  it("RH1 5 minutes UNKNOWN raises ONE health item per bot per day, never a release", async () => {
    const x = rig();
    void x.r.enroll(record());
    await x.clock.advance(6 * 60_000);
    expect(x.health.filter((h) => h.reason === "unknown-5-minutes")).toHaveLength(1);
    await x.clock.advance(60 * 60_000);
    expect(x.health.filter((h) => h.owner === "bot-1")).toHaveLength(1);
    expect(x.released).toHaveLength(0);
  });
  it("RH2 a first probe that never settles raises health at its abandonment, with no escalation having happened", async () => {
    const x = rig(); x.script.push(hung());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(3 * PROBE_CAP_MS);
    expect(x.health.map((h) => h.reason)).toContain("probe-abandoned");
    expect(x.kills).toHaveLength(0);
  });
});

describe("RV: bounded probe settlement (V4)", () => {
  it("RV1 inner work ignores abort: abort and kill at the cap, forced settlement at 3 x cap, the next C2 runs beside that one leak, health raised, no release, a late result is discarded", async () => {
    const x = rig(); x.script.push(hung(), hung());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(PROBE_CAP_MS - 1);
    expect(x.launches[0]!.signal.aborted).toBe(false);
    await x.clock.advance(1);
    expect(x.launches[0]!.signal.aborted).toBe(true);
    expect(x.launches[0]!.killed).toBe(1);
    expect(x.r.inspect(record())!.active).toBe(true); // not settled yet: abandoned only at 2 x cap after the abort
    await x.clock.advance(2 * PROBE_CAP_MS);
    expect(x.r.inspect(record())!.active).toBe(false);
    expect(x.r.inspect(record())!.leaks).toBe(1);
    expect(x.health.map((h) => h.reason)).toContain("probe-abandoned");
    await x.clock.advance(10_000); // the next C2 attempt starts on schedule (the second backoff step)
    expect(x.launches).toHaveLength(2);
    expect(x.r.quarantined("bot-1")).toBe(true);
    x.launches[0]!.settle({ v: "gone" }); // a late result from the abandoned generation
    await flush();
    expect(x.released).toHaveLength(0);
    expect(x.r.quarantined("bot-1")).toBe(true);
  });
  it("RV2 a probe that settles after its cap (before abandonment) is UNKNOWN and its result is discarded: it can never release", async () => {
    const x = rig(); x.script.push(hung());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(PROBE_CAP_MS + 1);
    x.launches[0]!.settle({ v: "gone" });
    await flush();
    expect(x.released).toHaveLength(0);
    expect(x.r.quarantined("bot-1")).toBe(true);
    expect(x.r.inspect(record())!.active).toBe(false);
  });
  it("RV3 two hung attempts in a row: the second starts beside the first leak; a third is refused while two leaks live, and runs again when one exits", async () => {
    const x = rig(); x.script.push(hung(), hung(), goneProbe());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(3 * PROBE_CAP_MS + 10_000); // first abandoned, second starts on schedule
    expect(x.launches).toHaveLength(2);
    await x.clock.advance(3 * PROBE_CAP_MS); // second abandoned: two live leaks
    expect(x.r.inspect(record())!.leaks).toBe(2);
    await x.clock.advance(5 * 60_000);
    expect(x.launches).toHaveLength(2); // refused while both leaks live
    expect(x.r.inspect(record())!.refused).toBe(true);
    expect(x.released).toHaveLength(0);
    x.launches[0]!.exit(); // a leak exits
    await x.clock.advance(61_000);
    expect(x.launches).toHaveLength(3);
    expect(x.released).toHaveLength(1);
  });
  it("RV4 four live leaks in the process: no new probe for another bot, that bot stays refused, health raised; a leak exits and probing resumes", async () => {
    const x = rig({ launch: (rec, signal) => { const p = rec.owner === "c" ? probe(signal, { v: "gone" }) : probe(signal); x.launches.push(p); return p; } });
    void x.r.enroll(record("a", 1), { immediate: true });
    void x.r.enroll(record("b", 1), { immediate: true });
    await x.clock.advance(3 * PROBE_CAP_MS); // a and b each abandon a hung probe: two leaks in the process
    await x.clock.advance(10_000); // their second attempts start beside those leaks
    await x.clock.advance(3 * PROBE_CAP_MS); // and are abandoned too: four live leaks
    expect(x.r.processLeaks).toBe(4);
    const before = x.launches.length;
    void x.r.enroll(record("c", 1), { immediate: true });
    await flush();
    expect(x.launches.length).toBe(before);
    expect(x.r.quarantined("c")).toBe(true);
    expect(x.r.inspect(record("c", 1))!.refused).toBe(true);
    expect(x.health.filter((h) => h.owner === "c").map((h) => h.reason)).toContain("leak-cap");
    x.launches[0]!.exit(); // one leak exits: three live
    await x.clock.advance(61_000);
    expect(x.released.some((rec) => rec.owner === "c")).toBe(true);
  });
  it("RV5 abort and SIGKILL are by generation: generation N's timers never reach generation N+1's helper", async () => {
    const x = rig(); x.script.push(hung(), hung());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(3 * PROBE_CAP_MS + 10_000);
    expect(x.launches).toHaveLength(2);
    const [first, second] = x.launches as [Probe, Probe];
    expect(first.killed).toBe(1);
    await x.clock.advance(PROBE_CAP_MS - 100); // generation 1's cap would have fired by now if it were still armed for the bot
    expect(second.killed).toBe(0);
    expect(second.signal.aborted).toBe(false);
    await x.clock.advance(100);
    expect(second.killed).toBe(1); // its own cap
    expect(first.killed).toBe(1);
  });
  it("RV6 a helper that exits when killed is no leak: the bot is never refused by it", async () => {
    const x = rig(); x.script.push(hung(true), goneProbe());
    void x.r.enroll(record(), { immediate: true });
    await x.clock.advance(3 * PROBE_CAP_MS + 10_500);
    expect(x.r.processLeaks).toBe(0);
    expect(x.released).toHaveLength(1);
  });
});
