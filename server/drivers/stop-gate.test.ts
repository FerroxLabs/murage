// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STOP-NONACP-DISPOSE: the gate's own rows (G1 precedence, G2 release, U1 once-only, F1 final, drain bound, late rejection, live ownership).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createStopGate, GateStopped } from "./stop-gate.ts";

function rig(opts?: { announceStart?: boolean | "mark-only" }) {
  const events: Array<Record<string, any>> = [];
  const gate = createStopGate({
    engineName: "Fake",
    emit: (ev) => events.push(ev),
    base: (threadId, turnId) => ({ threadId, turnId }),
    announceStart: opts?.announceStart,
  });
  const kinds = () => events.map((ev) => (ev.type === "turn.completed" ? `completed:${ev.ok}:${ev.stopReason}` : ev.type === "runtime.error" ? `error:${ev.message}` : ev.type));
  return { gate, events, kinds };
}
const PAIR = ["turn.started", "completed:true:cancelled"];
const CLOSING = ["turn.started", "error:Fake closed before it finished its reply", "completed:false:exit_before_result"];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("stop-gate", () => {
  it("G1: ask then close and close then ask both end as the stopped pair; close alone ends closing", () => {
    for (const order of ["ask-close", "close-ask"]) {
      const { gate, kinds } = rig();
      const e = gate.enter("t"); e.turnId = "x";
      if (order === "ask-close") { gate.ask("t"); gate.close(); } else { gate.close(); gate.ask("t"); }
      expect(gate.why(e)).toBe("asked");
      e.finish({ ok: false, stopReason: "refused" });
      expect(kinds()).toEqual(PAIR);
    }
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.close();
    expect(gate.why(e)).toBe("closing");
    e.finish({ ok: true, stopReason: "end_turn" });
    expect(kinds()).toEqual(CLOSING);
  });

  it("G1b: a turn entered after close is closing at once; ask(threadId) touches only that thread", () => {
    const { gate } = rig();
    const a = gate.enter("a"); const b = gate.enter("b");
    gate.ask("a");
    expect(gate.why(a)).toBe("asked");
    expect(gate.why(b)).toBeNull();
    gate.close();
    expect(gate.why(gate.enter("c"))).toBe("closing");
  });

  it("S1: asked is read at emission: a Stop that lands after the dispose mark but before the ending still wins", () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.close();
    expect(gate.why(e)).toBe("closing");
    gate.ask("t");
    e.finish({ ok: false, stopReason: "exit_before_result" });
    expect(kinds()).toEqual(PAIR);
  });

  it("U1: finish is once-only and leaves the gate", () => {
    const { gate, events } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    e.finish({ ok: true, stopReason: "end_turn" });
    e.finish({ ok: false, stopReason: "error" });
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(1);
    expect(gate.size()).toBe(0);
  });

  it("F1: a final verdict is emitted as is under any mark", () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.ask("t"); gate.close();
    e.finish({ ok: false, stopReason: "gate_incident", final: true });
    expect(kinds()).toEqual(["turn.started", "completed:false:gate_incident"]);
  });

  it("an unmarked verdict carries its error and extra fields; antigravity shape announces no turn.started", () => {
    const { gate, events, kinds } = rig({ announceStart: false });
    const e = gate.enter("t"); e.turnId = "x";
    e.finish({ ok: false, stopReason: "unsupported_cli", error: "too old", extra: { code: 7 } });
    expect(kinds()).toEqual(["error:too old", "completed:false:unsupported_cli"]);
    expect(events[1].code).toBe(7);
  });

  it("step: a mark after the await throws GateStopped, reaps via onStopped and reaches a live handle", async () => {
    const { gate } = rig();
    const e = gate.enter("t");
    const reaped: number[] = []; const lives: string[] = [];
    e.live = true; e.stopLive = (w) => lives.push(w);
    const p = gate.step(e, (async () => { await flush(); return 5; })(), { onStopped: (v) => reaped.push(v) });
    gate.close();
    await expect(p).rejects.toBeInstanceOf(GateStopped);
    expect(reaped).toEqual([5]);
    expect(lives).toContain("closing");
    const open = rig().gate;
    expect(await open.step(open.enter("u"), Promise.resolve(3))).toBe(3);
    // a rejection of p is not swallowed
    await expect(open.step(open.enter("v"), Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });

  it("cleanupStep never throws on a mark and never reaches the live handle", async () => {
    const { gate } = rig();
    const e = gate.enter("t"); e.live = true;
    let reached = 0; e.stopLive = () => { reached++; };
    gate.ask("t"); gate.close();
    reached = 0;
    expect(await gate.cleanupStep(e, Promise.resolve(9))).toBe(9);
    expect(reached).toBe(0);
    await expect(gate.cleanupStep(e, Promise.reject(new Error("x")))).rejects.toThrow("x");
  });

  it("launch refuses a marked or finished entry before running fn, and goLive per liveOn", async () => {
    const { gate } = rig();
    const e = gate.enter("t");
    let ran = 0;
    gate.close();
    expect(() => gate.launch(e, () => { ran++; })).toThrow(GateStopped);
    expect(ran).toBe(0);
    const g = rig().gate; const f = g.enter("t");
    g.launch(f, () => { ran++; });
    expect(f.live).toBe(true); expect(ran).toBe(1);
    const h = g.enter("u");
    const pending = g.launch(h, () => new Promise<number>((r) => setTimeout(() => r(1), 0)), { liveOn: "resolve" });
    expect(h.live).toBe(false);
    await pending;
    expect(h.live).toBe(true);
  });

  it("G2: rejected sends (busy, validation) release the entry and stay rejections; drain resolves at once", async () => {
    const { gate } = rig();
    const e = gate.enter("t");
    await expect(gate.run(e, async () => { throw new Error("a turn is already running"); }, () => null)).rejects.toThrow("already running");
    expect(gate.size()).toBe(0);
    gate.close();
    expect(await gate.drain(50)).toEqual([]);
  });

  it("run: a GateStopped under a mark ends the pair (asked) or closing (dispose) and resolves with the turn id", async () => {
    for (const [fn, expected] of [["ask", PAIR], ["close", CLOSING]] as const) {
      const { gate, kinds } = rig();
      const e = gate.enter("t"); e.turnId = "x";
      const r = await gate.run(e, async () => { fn === "ask" ? gate.ask("t") : gate.close(); return gate.step(e, Promise.resolve(1)); }, () => null);
      expect(r).toEqual({ turnId: "x" });
      expect(kinds()).toEqual(expected);
    }
  });

  it("run: the classified verdict goes to finish, which applies precedence (a version card under a Stop is the pair)", async () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.ask("t");
    await gate.run(e, async () => { throw new Error("old cli"); }, (err) => ({ ok: false, stopReason: "update_required", error: String(err) }));
    expect(kinds()).toEqual(PAIR);
    const g2 = rig(); const e2 = g2.gate.enter("t"); e2.turnId = "y";
    await g2.gate.run(e2, async () => { throw new Error("old cli"); }, (err) => ({ ok: false, stopReason: "update_required", error: String(err) }));
    expect(g2.kinds()).toEqual(["turn.started", "error:Error: old cli", "completed:false:update_required"]);
  });

  it("M-C: a rejection after the launch (live) is not finished by the wrapper: the live close path owns the ending", async () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    const r = await gate.run(e, async () => { e.live = true; gate.ask("t"); throw new GateStopped("asked"); }, () => null);
    expect(r).toEqual({ turnId: "x" });
    expect(kinds()).toEqual([]);
    expect(gate.size()).toBe(1);
    e.finish({ ok: true, stopReason: "cancelled" });
    expect(gate.size()).toBe(0);
  });

  it("LR1: a rejection after the entry was settled is swallowed: one receipt, sendTurn resolves", async () => {
    const { gate, events } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    let reject!: (e: Error) => void;
    const probe = new Promise<void>((_, rj) => { reject = rj; });
    const sent = gate.run(e, async () => { await probe; }, () => ({ ok: false, stopReason: "update_required", error: "old" }));
    gate.close();
    gate.settleOutstanding(await gate.drain(10));
    reject(new Error("late"));
    expect(await sent).toEqual({ turnId: "x" });
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(1);
  });

  it("D1: drain is bounded; settleOutstanding ends each open entry exactly once as closing", async () => {
    const { gate, kinds, events } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.close();
    const t0 = Date.now();
    const open = await gate.drain(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(open).toEqual([e]);
    gate.settleOutstanding(open);
    gate.settleOutstanding(open);
    expect(kinds()).toEqual(CLOSING);
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(1);
    expect(gate.size()).toBe(0);
  });

  it("USAGE-1 gate settleOutstanding carries kept: after a drain timeout the entry with a kept getter ends with its usage once, the one without ends with none", async () => {
    const { gate, events } = rig();
    const a = gate.enter("ta"); a.turnId = "xa";
    const b = gate.enter("tb"); b.turnId = "xb";
    let reads = 0;
    a.kept = () => { reads += 1; return { usage: { input: 1, output: 2 } }; };
    gate.close();
    const open = await gate.drain(30);
    expect(open).toHaveLength(2);
    const returned: unknown = gate.settleOutstanding(open); // a void function: kept is read synchronously, nothing is awaited
    expect(returned).toBeUndefined();
    expect(reads).toBe(1);
    const completed = () => events.filter((ev) => ev.type === "turn.completed");
    expect(completed()).toHaveLength(2); // exactly one turn.completed per entry
    const first = completed().find((ev) => ev.turnId === "xa")!;
    const second = completed().find((ev) => ev.turnId === "xb")!;
    expect(first).toMatchObject({ ok: false, stopReason: "exit_before_result", usage: { input: 1, output: 2 } });
    expect(second).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    expect("usage" in second).toBe(false);
    gate.settleOutstanding(open); // a second settle ends nothing again and reads nothing again: no double count
    expect(completed()).toHaveLength(2);
    expect(reads).toBe(1);
    expect(gate.size()).toBe(0);
  });

  it("LAUNCH-1 a spawn launch that throws synchronously gives live back to false and the wrapper ends the turn with one terminal", async () => {
    const { gate, events, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    const out = await gate.run(e, async () => {
      gate.launch(e, () => { throw new Error("spawn exploded"); });
    }, () => ({ ok: false, stopReason: "spawn_error", error: "spawn exploded" }));
    expect(out).toEqual({ turnId: "x" });
    expect(e.live).toBe(false);
    expect(kinds()).toEqual(["turn.started", "error:spawn exploded", "completed:false:spawn_error"]);
    gate.ask("t"); gate.close(); // a later Stop or Stop All finishes nothing twice
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(1);
    expect(gate.size()).toBe(0);
  });

  it("LAUNCH-2 a write launch that throws on an already-live entry keeps it live: the close path owns that ending, the wrapper emits none", async () => {
    const { gate, events } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    let stopped: string | undefined;
    await gate.run(e, async () => {
      gate.bindLive(e, { stop: (why) => { stopped = why; }, kept: () => undefined });
      gate.launch(e, () => { throw new Error("write failed"); });
    }, () => ({ ok: false, stopReason: "stdin_write_failed" }));
    expect(e.live).toBe(true);
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(0);
    gate.ask("t"); // the Stop still reaches the live handle
    expect(stopped).toBe("asked");
  });

  it("LAUNCH-3 control: after a successful launch a Stop reaches stopLive, and a later throwing launch on it restores true, not false", () => {
    const { gate } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    let stopped: string | undefined;
    expect(gate.launch(e, () => 7)).toBe(7);
    expect(e.live).toBe(true);
    gate.bindLive(e, { stop: (why) => { stopped = why; }, kept: () => undefined });
    expect(() => gate.launch(e, () => { throw new Error("again"); })).toThrow("again");
    expect(e.live).toBe(true);
    gate.ask("t");
    expect(stopped).toBe("asked");
  });

  it("BIND-1 bindLive sets live, stop and kept together; kept is required by the type; markLive:false leaves live alone", () => {
    const { gate } = rig();
    const e = gate.enter("t");
    const kept = () => ({ usage: { input: 1, output: 1 } });
    gate.bindLive(e, { stop: () => {}, kept });
    expect(e.live).toBe(true);
    expect(e.kept).toBe(kept);
    expect(typeof e.stopLive).toBe("function");
    const f = gate.enter("u");
    gate.bindLive(f, { kept, markLive: false });
    expect(f.live).toBe(false);
    expect(f.kept).toBe(kept);
    // @ts-expect-error a live binding with no usage source does not compile
    gate.bindLive(gate.enter("v"), { stop: () => {} });
  });

  it("BIND-3 why markLive:false exists (codex reuse, muse): a throw between the binding and the launch still ends the turn through the wrapper; live is true once the launch completed and a Stop then reaches stop", async () => {
    const { gate, events } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    let stopped: string | undefined;
    await gate.run(e, async () => {
      gate.bindLive(e, { stop: (why) => { stopped = why; }, kept: () => undefined, markLive: false });
      expect(e.live).toBe(false);
      throw new Error("startup failed before the launch");
    }, () => ({ ok: false, stopReason: "error", error: "startup failed before the launch" }));
    expect(events.filter((ev) => ev.type === "turn.completed")).toHaveLength(1);
    expect(stopped).toBeUndefined();
    // the same shape through to the launch: live is true when it completes, and a Stop now reaches stop
    const f = gate.enter("u"); f.turnId = "y";
    gate.bindLive(f, { stop: (why) => { stopped = why; }, kept: () => undefined, markLive: false });
    gate.launch(f, () => 1, { liveOn: "call" });
    expect(f.live).toBe(true);
    gate.ask("u");
    expect(stopped).toBe("asked");
    // and the default binding (live at once) swallows the same early throw as a live close path: the contrast the deviation rests on
    const g = gate.enter("v"); g.turnId = "z";
    await gate.run(g, async () => {
      gate.bindLive(g, { kept: () => undefined });
      throw new Error("startup failed before the launch");
    }, () => ({ ok: false, stopReason: "error" }));
    expect(events.filter((ev) => ev.type === "turn.completed" && ev.turnId === "z")).toHaveLength(0);
  });

  it("BIND-2 structure (MurageMain ruling 11-08): only codex.ts and muse-code.ts may pass markLive:false to bindLive", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const users = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "stop-gate.ts")
      .filter((f) => /markLive:\s*false/.test(readFileSync(join(dir, f), "utf8")))
      .sort();
    expect(users).toEqual(["codex.ts", "muse-code.ts"]);
  });

  it("drain resolves as soon as the last entry leaves", async () => {
    const { gate } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.close();
    const d = gate.drain(5_000);
    setTimeout(() => e.finish({ ok: true, stopReason: "end_turn" }), 5);
    expect(await d).toEqual([]);
  });

  it("DT1: a detached startup keeps its entry; a dispose timeout settles it closing", async () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    let release!: () => void;
    gate.handoff(e, () => new Promise<void>((r) => { release = r; }), () => null);
    await flush();
    expect(gate.size()).toBe(1);
    gate.close();
    gate.settleOutstanding(await gate.drain(10));
    expect(kinds()).toEqual(CLOSING);
    release();
    await flush();
    expect(gate.size()).toBe(0);
    expect(kinds()).toEqual(CLOSING);
  });

  it("M-B: detached startup that returns unlaunched is abandoned only when unmarked and no terminal is pending", async () => {
    const a = rig(); const ea = a.gate.enter("t"); ea.turnId = "x";
    a.gate.handoff(ea, async () => {}, () => null);
    await flush();
    expect(a.kinds()).toEqual(["turn.started", "error:Fake did not start this turn", "completed:false:error"]);
    const b = rig(); const eb = b.gate.enter("t"); eb.turnId = "y";
    eb.terminalPending = () => true;
    b.gate.handoff(eb, async () => {}, () => null);
    await flush();
    expect(b.kinds()).toEqual([]);
    expect(b.gate.size()).toBe(1);
    const c = rig(); const ec = c.gate.enter("t"); ec.turnId = "z";
    c.gate.handoff(ec, async () => { c.gate.ask("t"); }, () => null);
    await flush();
    expect(c.kinds()).toEqual(PAIR);
  });

  it("a detached startup that rejects with an unclassified error ends once with that error", async () => {
    const { gate, kinds } = rig();
    const e = gate.enter("t"); e.turnId = "x";
    gate.handoff(e, async () => { throw new Error("spawn failed"); }, () => null);
    await flush();
    expect(kinds()).toEqual(["turn.started", "error:spawn failed", "completed:false:error"]);
    expect(gate.size()).toBe(0);
  });

  it("LW1: launch liveOn resolve with liveWhen: a refused value never sets live; an accepted one does", async () => {
    const { gate } = rig();
    const refused = gate.enter("t");
    await gate.launch(refused, () => Promise.resolve({ status: 500 }), { liveOn: "resolve", liveWhen: (v) => v.status < 300 });
    expect(refused.live).toBe(false);
    const ok = gate.enter("u");
    await gate.launch(ok, () => Promise.resolve({ status: 200 }), { liveOn: "resolve", liveWhen: (v) => v.status < 300 });
    expect(ok.live).toBe(true);
  });

  it("AN1: announceStart mark-only: markStarted announces, a pre-prompt ending announces nothing; stopReason may be null", () => {
    const { gate, kinds } = rig({ announceStart: "mark-only" });
    const a = gate.enter("a"); a.turnId = "x";
    gate.ask("a");
    a.finish({ ok: false, stopReason: "refused" });
    expect(kinds()).toEqual(["completed:true:cancelled"]);
    const live = rig({ announceStart: "mark-only" });
    const b = live.gate.enter("b"); b.turnId = "y";
    b.markStarted();
    b.finish({ ok: true, stopReason: null });
    expect(live.kinds()).toEqual(["turn.started", "completed:true:null"]);
  });

  it("EX1: extra (usage, cost) is kept on the stopped pair and on the closing ending; the stop fields still win", () => {
    for (const mode of ["asked", "closing"]) {
      const { gate, events } = rig();
      const e = gate.enter("t"); e.turnId = "x";
      if (mode === "asked") gate.ask("t"); else gate.close();
      e.finish({ ok: true, stopReason: "end_turn", extra: { usage: { in: 3, out: 4 }, cost: 0.5, stopReason: "bogus", ok: false } });
      const done = events.find((ev) => ev.type === "turn.completed")!;
      expect(done.usage).toEqual({ in: 3, out: 4 });
      expect(done.cost).toBe(0.5);
      expect(done.stopReason).toBe(mode === "asked" ? "cancelled" : "exit_before_result");
      expect(done.ok).toBe(mode === "asked");
    }
  });
});

describe("STOP-NONACP s7 strip-only", () => {
  it("stop-gate.ts loads under node type-stripping, the way the real server starts (no parameter properties, enums or namespaces)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const gateUrl = pathToFileURL(join(here, "stop-gate.ts")).href;
    // the same binary and flag as scripts/control-murage.ts uses to start server/index.ts
    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(gateUrl)}); if (typeof m.createStopGate !== "function" || new m.GateStopped("asked").why !== "asked") process.exit(3);`], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
    expect(`${out.stderr}`).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(out.status).toBe(0);
  });
});
