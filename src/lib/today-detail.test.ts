// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Detailed view, pure models (designs/TODAY-SLICE-1104.md section 2b, test 5): the spend card's days, coverage
// and usual; the per-bot lines; the Done today detail line; the routines line.
import { describe, expect, it } from "vitest";
import type { RoutineRun } from "@/lib/routines";
import { botLines, doneMeta, routinesLine, runEngine, spendCard, spendLines, TODAY_RUNS_HELD } from "./today-detail";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const NOW = at(4, 12);
const run = (over: Partial<RoutineRun>): RoutineRun => ({
  id: "x", routineId: "r1", routineName: "Morning brief", target: "bot", botId: "nova", runOn: "ember",
  scheduledFor: at(4, 8), status: "completed", manual: false, startedAt: at(4, 8), finishedAt: at(4, 8, 2), createdAt: at(4, 8), ...over,
} as RoutineRun);
let n = 0;
const on = (d: number, cost: number | null, over: Partial<RoutineRun> = {}) => run({ id: `r${n++}`, scheduledFor: at(d, 8), finishedAt: at(d, 9), cost, ...over });

describe("the spend card (D3)", () => {
  it("usual is the median over reported covered days only; unreported days are hollow, never $0", () => {
    // day -3 of November is Oct 28 (7 days back: in the usual window, not on the bars); -2 is Oct 29
    const card = spendCard([on(-3, 0.4), on(-2, null), on(1, 0.2), on(2, 0.6), on(3, 1.0), on(4, 0.5)], NOW);
    expect(card.state).toBe("ok");
    if (card.state !== "ok") return;
    expect(card.days).toHaveLength(7);
    expect(card.days[0]!.start).toBe(new Date(2026, 9, 29).getTime());
    expect(card.today).toMatchObject({ kind: "cost", total: 0.5 });
    expect(card.days.map((day) => day.kind)).toEqual(["unreported", "empty", "empty", "cost", "cost", "cost", "cost"]);
    const oct29 = card.days.find((day) => day.start === new Date(2026, 9, 29).getTime())!;
    expect(oct29).toMatchObject({ kind: "unreported", total: 0, runs: 1, unreportedRuns: 1 });
    const oct30 = card.days.find((day) => day.start === new Date(2026, 9, 30).getTime())!;
    expect(oct30).toMatchObject({ kind: "empty", total: 0, runs: 0 });
    // reported days before today: 0.4 (Oct 28), 0.2, 0.6, 1.0 -> median 0.5
    expect(card.usual).toBeCloseTo(0.5);
  });

  it("under 3 reported days before today: no compare", () => {
    const card = spendCard([on(2, 0.3), on(3, 0.3), on(4, 1)], NOW);
    expect(card.state === "ok" && card.usual).toBeNull();
    if (card.state !== "ok") return;
    expect(spendLines(card).usual).toEqual({ key: "ux.l2a.today.runCost.noHistory" });
    const three = spendCard([on(1, 0.3), on(2, 0.3), on(3, 0.6), on(4, 1)], NOW);
    expect(three.state === "ok" && three.usual).toBeCloseTo(0.3);
  });

  it("today with some null costs says partial; today with only null costs says todayNone, never $0", () => {
    const mixed = spendCard([on(3, 0.2), on(4, 0.4), on(4, null), on(4, null)], NOW);
    expect(mixed.state).toBe("ok");
    if (mixed.state !== "ok") return;
    expect(spendLines(mixed).today).toEqual({ key: "ux.l2a.today.runCost.today", params: { cost: "$0.40" } });
    expect(spendLines(mixed).partial).toEqual({ key: "ux.l2a.today.runCost.partial", params: { n: 2 } });
    const nullOnly = spendCard([on(3, 0.2), on(4, null)], NOW);
    expect(nullOnly.state).toBe("ok");
    if (nullOnly.state !== "ok") return;
    expect(nullOnly.today).toMatchObject({ kind: "unreported", total: 0 });
    expect(spendLines(nullOnly).today).toEqual({ key: "ux.l2a.today.runCost.todayNone" });
    expect(spendLines(nullOnly).partial).toBeNull();
    // no run today is a real $0
    const quiet = spendCard([on(3, 0.2)], NOW);
    expect(quiet.state === "ok" && spendLines(quiet).today).toEqual({ key: "ux.l2a.today.runCost.today", params: { cost: "$0" } });
  });

  it("no finite cost in 8 days gives none; only terminal runs count", () => {
    expect(spendCard([], NOW)).toEqual({ state: "none" });
    expect(spendCard([on(4, null), on(2, null)], NOW)).toEqual({ state: "none" });
    expect(spendCard([on(4, 3, { status: "running" }), on(4, 3, { status: "queued" })], NOW)).toEqual({ state: "none" });
    // 8 days back is outside the window
    expect(spendCard([on(-4, 1)], NOW)).toEqual({ state: "none" });
    expect(spendCard([on(4, 0.1, { status: "failed" }), on(4, 0.2, { status: "missed" }), on(4, 0.3, { status: "cancelled" })], NOW)).toMatchObject({ state: "ok", today: { total: expect.closeTo(0.6) } });
  });

  it("under the cap every day is covered; at the cap days start after the oldest TERMINAL run, an old active run kept", () => {
    const filler = (count: number, d: number, extra: Partial<RoutineRun> = {}) => Array.from({ length: count }, (_, i) => run({ id: `f${d}-${i}`, scheduledFor: at(d, 8), finishedAt: at(d, 9), cost: 0.01, ...extra }));
    // 1,999 held: every day covered, the Oct 29 cost counts
    const under = spendCard([...filler(1, -2), ...filler(TODAY_RUNS_HELD - 3, 3), on(4, 0.5)], NOW);
    expect(under.state).toBe("ok");
    if (under.state !== "ok") return;
    expect(under.days.find((day) => day.start === new Date(2026, 9, 29).getTime())?.kind).toBe("cost");
    // 2,000 held: the oldest terminal run is Nov 2, so Nov 2 itself is partial (uncovered) and Nov 3 on are covered.
    // An active run from Oct 30 is kept by the trim and does not move the coverage.
    const atCap = [
      run({ id: "active-old", status: "running", scheduledFor: new Date(2026, 9, 30, 8).getTime(), finishedAt: undefined, cost: null }),
      ...filler(10, 2), ...filler(TODAY_RUNS_HELD - 12, 3), on(4, 0.5),
    ];
    expect(atCap).toHaveLength(TODAY_RUNS_HELD);
    const card = spendCard(atCap, NOW);
    expect(card.state).toBe("ok");
    if (card.state !== "ok") return;
    const kind = (d: number) => card.days.find((day) => day.start === new Date(2026, 10, d).getTime())?.kind;
    expect(kind(2)).toBe("uncovered");
    expect(kind(1)).toBe("uncovered");
    expect(kind(3)).toBe("cost");
    expect(card.usual).toBeNull();
  });

  it("more than 2,000 runs, all today: too many to total here", () => {
    const many = Array.from({ length: TODAY_RUNS_HELD + 5 }, (_, i) => run({ id: `t${i}`, scheduledFor: at(4, 1) + i, finishedAt: at(4, 2) + i, cost: 0.01 }));
    expect(spendCard(many, NOW)).toEqual({ state: "tooMany" });
    expect(spendCard(many.slice(0, TODAY_RUNS_HELD), NOW)).toEqual({ state: "tooMany" });
    // more than 2,000 with the oldest terminal yesterday: today is covered
    const spread = [run({ id: "y", scheduledFor: at(3, 8), finishedAt: at(3, 9), cost: 1 }), ...many];
    expect(spendCard(spread, NOW).state).toBe("ok");
  });

  it("sums each local calendar day, also on a 25 hour DST day (run with TZ=America/New_York)", () => {
    // Sun 1 Nov 2026 is 25 hours long in New York. 00:30 and 23:30 that day both belong to it; 00:30 on the 2nd does not.
    const runs = [
      run({ id: "a", scheduledFor: at(1, 0, 30), finishedAt: at(1, 0, 30), cost: 0.1 }),
      run({ id: "b", scheduledFor: at(1, 23, 30), finishedAt: at(1, 23, 30), cost: 0.2 }),
      run({ id: "c", scheduledFor: at(2, 0, 30), finishedAt: at(2, 0, 30), cost: 0.4 }),
      run({ id: "d", scheduledFor: at(4, 0, 10), finishedAt: at(4, 0, 10), cost: 0.8 }),
    ];
    const card = spendCard(runs, NOW);
    expect(card.state).toBe("ok");
    if (card.state !== "ok") return;
    const total = (d: number) => card.days.find((day) => day.start === new Date(2026, 10, d).getTime())?.total;
    expect(total(1)).toBeCloseTo(0.3);
    expect(total(2)).toBeCloseTo(0.4);
    expect(card.today.total).toBeCloseTo(0.8);
    // seven distinct local midnights, oldest first
    expect(new Set(card.days.map((day) => day.start)).size).toBe(7);
    expect(card.days.every((day) => new Date(day.start).getHours() === 0)).toBe(true);
  });
});

describe("Your team today (D4)", () => {
  const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, threadId: `${id}-main`, ...extra }) as never;
  it("orders working, waiting for you, then by next run, then name, and leaves hidden bots out", () => {
    const lines = botLines([
      bot("z", "Zed"), bot("a", "Ava"), bot("w", "Wes", { activity: "waiting-on-you" }), bot("k", "Kai", { activity: "working", busy: true }),
      bot("h", "Hid", { hidden: true }), bot("n", "Nia", { activity: "no-signal" }), bot("d", "Dee", { activity: "dead" }), bot("b", "Bea"),
    ], [
      { botId: "z", enabled: true, nextRunAt: NOW + 3_600_000 },
      { botId: "z", enabled: true, nextRunAt: NOW + 600_000 },
      { botId: "a", enabled: true, nextRunAt: NOW + 1_200_000 },
      { botId: "b", enabled: false, nextRunAt: NOW + 60_000 },
      { botId: "b", enabled: true, nextRunAt: NOW - 60_000 },
    ], [], NOW);
    expect(lines.map((line) => line.name)).toEqual(["Kai", "Wes", "Zed", "Ava", "Bea", "Dee", "Nia"]);
    expect(lines.find((line) => line.botId === "z")?.next).toBe(NOW + 600_000);
    expect(lines.find((line) => line.botId === "b")?.next).toBeNull();
    expect(lines.map((line) => line.state)).toEqual(["working", "waiting", "ready", "ready", "ready", "stopped", "noSignal"]);
  });
  it("last run is the newest finished run; a bot with none uses its newest task activity; else nothing", () => {
    const lines = botLines([
      bot("a", "Ava", { tasks: [{ threadId: "t1", lastActivityAt: NOW - 50 }, { threadId: "t2", lastActivityAt: NOW - 10 }] }),
      bot("b", "Bea", { tasks: [{ threadId: "t3", lastActivityAt: NOW - 5 }] }),
      bot("c", "Cy"),
    ], [], [{ botId: "b", finishedAt: NOW - 900 }, { botId: "b", finishedAt: NOW - 100 }, { botId: "b", finishedAt: undefined }], NOW);
    const by = (id: string) => lines.find((line) => line.botId === id)!;
    expect(by("a").last).toEqual({ kind: "active", at: NOW - 10 });
    expect(by("b").last).toEqual({ kind: "run", at: NOW - 100 });
    expect(by("c").last).toBeNull();
  });
});

describe("Done today detail (D2)", () => {
  const instances = [{ instanceId: "fuigo", displayName: "Fuigo" }, { instanceId: "claude", displayName: "Claude" }];
  const bots = [{ id: "nova", name: "Nova", modelSelection: { instanceId: "fuigo" }, tasks: [
    { threadId: "own", modelSelection: { instanceId: "claude" } },
    { threadId: "follows", modelSelection: { instanceId: "claude" }, followsBotModel: true },
  ] }];
  const row = { botName: "Nova", time: "09:00" };
  it("joins bot, time, took, cost and runs on, dropping unknown parts; a null cost says no cost reported", () => {
    expect(doneMeta(run({ startedAt: at(4, 9), finishedAt: at(4, 9, 2) + 5_000, cost: 0.12, threadId: "own" }), row, bots, instances)).toEqual([
      { raw: "Nova" }, { raw: "09:00" }, { key: "ux.l2a.today.done.took", params: { dur: "2m 05s" } }, { raw: "$0.12" }, { key: "ux.l2a.today.done.engine", params: { engine: "Claude" } },
    ]);
    expect(doneMeta(run({ startedAt: undefined, cost: null, botId: "gone" }), { botName: "", time: "" }, bots, instances)).toEqual([{ key: "ux.l2a.today.done.noCost" }]);
    expect(doneMeta(run({ cost: undefined }), row, bots, instances).some((part) => "key" in part && part.key === "ux.l2a.today.done.noCost")).toBe(true);
  });
  it("engine: the run task's model, else the bot's (task missing or following the bot), named as it is now", () => {
    expect(runEngine({ botId: "nova", executionThreadId: "own", threadId: "x" }, bots, instances)).toBe("Claude");
    expect(runEngine({ botId: "nova", threadId: "follows" }, bots, instances)).toBe("Fuigo");
    expect(runEngine({ botId: "nova", threadId: "missing" }, bots, instances)).toBe("Fuigo");
    // the engine changed after the run: the label is the bot's engine now
    const moved = [{ ...bots[0]!, modelSelection: { instanceId: "claude" } }];
    expect(runEngine({ botId: "nova", threadId: "missing" }, moved, instances)).toBe("Claude");
    expect(runEngine({ botId: "nova", threadId: "missing" }, bots, [])).toBeNull();
    expect(runEngine({ botId: "ghost" }, bots, instances)).toBeNull();
  });
});

describe("the routines line (D5)", () => {
  it("counts ran and failed today and names the next run, which may be tomorrow; none when nothing is scheduled", () => {
    const runs = [on(4, 0.1), on(4, 0.1), on(4, null, { status: "failed" }), on(4, null, { status: "missed" }), on(4, null, { status: "cancelled" }), on(3, 0.1)];
    const tomorrow = at(5, 7);
    expect(routinesLine([{ name: "Brief", enabled: true, nextRunAt: tomorrow }, { name: "Late", enabled: true, nextRunAt: at(5, 9) }, { name: "Off", enabled: false, nextRunAt: NOW + 1 }], runs, NOW))
      .toEqual({ ran: 2, failed: 2, next: { name: "Brief", at: tomorrow } });
    expect(routinesLine([{ name: "Event", enabled: true, nextRunAt: null }, { name: "Off", enabled: false, nextRunAt: NOW + 1 }], runs, NOW)).toEqual({ ran: 2, failed: 2, next: null });
    expect(routinesLine([], runs, NOW)).toBeNull();
  });
});
