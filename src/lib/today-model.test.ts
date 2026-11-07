// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's scenarios (UX 1.0.13, lane L2A): the greeting by hour, the tag order
// (engine first, then health, needs, month, clients, apps, quiet hours), the
// first-run Today (one tag only), and the routine rows.
import { describe, expect, it } from "vitest";
import type { Routine, RoutineRun } from "@/lib/routines";
import { detailedOrder, doneToday, engineState, engineTag, finishedInBackground, greetingFor, healthEngine, leadLine, needsTag, primaryEngine, routinesRanToday, routinesToday, todayEngine, todayModel, type TodayInput } from "./today-model";

const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m).getTime();
const base = (over: Partial<TodayInput> = {}): TodayInput => ({
  now: new Date(at(9, 30)),
  ownerName: "Sean",
  firstRun: false,
  connectivity: "online",
  engine: { id: "claude", label: "Claude", state: "ready", line: "" },
  flux: "ok",
  needsCount: 3,
  health: { level: "ok", line: "" },
  monthTag: null,
  clientsTag: null,
  appsConnected: 4,
  quiet: { active: false, until: null },
  routines: [],
  runs: [],
  botNames: { nova: "Nova", max: "Max" },
  ...over,
});
const texts = (input: TodayInput) => todayModel(input).tags.map((tag) => tag.text);

describe("Today greeting", () => {
  it("greets by the hour, with the owner's name when there is one", () => {
    expect(greetingFor(new Date(at(8)), "Sean")).toBe("Good morning, Sean.");
    expect(greetingFor(new Date(at(12)), "Sean")).toBe("Good afternoon, Sean.");
    expect(greetingFor(new Date(at(17, 59)), "Sean")).toBe("Good afternoon, Sean.");
    expect(greetingFor(new Date(at(18)), "Sean")).toBe("Good evening, Sean.");
    expect(greetingFor(new Date(at(7)), "  ")).toBe("Good morning.");
  });
});

describe("Today status tags", () => {
  it("puts the engine first, then needs, then apps (the mockup's everyday Today)", () => {
    expect(texts(base())).toEqual(["Claude signed in", "3 things need you", "4 apps connected"]);
  });

  it("says Flux allowance used up ahead of everything, even offline", () => {
    expect(texts(base({ flux: "allowance-used-up", connectivity: "offline" }))[0]).toBe("Flux Router: allowance used up");
  });

  it("says offline in place of the engine when there is no internet", () => {
    const tags = todayModel(base({ connectivity: "offline" })).tags;
    expect(tags[0]).toMatchObject({ key: "engine", tone: "warn", text: "Offline · bots on this computer keep working" });
  });

  it("says a signed-out engine in red, and does not repeat it as a health tag", () => {
    const tags = todayModel(base({ engine: { id: "claude", label: "Claude", state: "signed-out", line: "" }, health: { level: "act", line: "Claude is signed out" } })).tags;
    expect(tags[0]).toMatchObject({ tone: "bad", text: "Claude is signed out", action: "engines" });
    expect(tags.filter((tag) => tag.key === "health")).toHaveLength(0);
  });

  it("adds a health tag after the engine when the owner must act on something else", () => {
    expect(texts(base({ health: { level: "act", line: "The last backup did not finish" } }))).toEqual(["Claude signed in", "The last backup did not finish", "3 things need you", "4 apps connected"]);
  });

  it("counts needs in plain words, one and none included, and leaves the tag out while the count is unknown", () => {
    expect(texts(base({ needsCount: 1 }))).toContain("1 thing needs you");
    expect(texts(base({ needsCount: 0 }))).toContain("Nothing needs you");
    expect(todayModel(base({ needsCount: undefined })).tags.some((tag) => tag.key === "needs")).toBe(false);
  });

  it("places the month and clients tags after needs and before apps, then quiet hours last", () => {
    const tags = texts(base({
      monthTag: { key: "month", tone: "warn", text: "80% of your $30 monthly limit" },
      clientsTag: { key: "clients", tone: "info", text: "2 clients need you" },
      quiet: { active: true, until: "07:00" },
    }));
    expect(tags).toEqual(["Claude signed in", "3 things need you", "80% of your $30 monthly limit", "2 clients need you", "4 apps connected", "Quiet hours until 07:00"]);
  });

  it("leaves apps out when none are connected or the count is not known", () => {
    expect(texts(base({ appsConnected: 0 })).some((text) => text.includes("connected"))).toBe(false);
    expect(texts(base({ appsConnected: null })).some((text) => text.includes("connected"))).toBe(false);
    expect(texts(base({ appsConnected: 1 }))).toContain("1 app connected");
  });

  it("shows exactly one tag, Getting set up, during first run (FIRSTRUN 1.2)", () => {
    const model = todayModel(base({ firstRun: true, flux: "allowance-used-up", needsCount: 5 }));
    expect(model.firstRun).toBe(true);
    expect(model.tags.map((tag) => tag.text)).toEqual(["Getting set up"]);
    expect(model.routinesToday).toEqual([]);
  });

  it("never uses an em dash or the word safe in a tag", () => {
    const all = [
      ...texts(base()), ...texts(base({ flux: "allowance-used-up" })), ...texts(base({ connectivity: "offline" })),
      ...texts(base({ flux: "key-problem" })), ...texts(base({ engine: { id: "x", label: "Codex", state: "off", line: "" } })),
    ];
    for (const text of all) {
      expect(text).not.toMatch(/—/);
      expect(text.toLowerCase()).not.toMatch(/\bsafe\b/);
    }
  });
});

describe("the engine Today names", () => {
  const engines = [
    { instanceId: "codex", displayName: "Codex", snapshot: { state: "available" as const, authenticated: true } },
    { instanceId: "claude", displayName: "Claude", snapshot: { state: "available" as const, authenticated: false } },
  ];
  it("is the one most bots use, signed in or not", () => {
    expect(primaryEngine(engines, ["claude", "claude", "codex"])).toMatchObject({ id: "claude", state: "signed-out" });
  });
  it("falls back to the first ready engine, then the first at all", () => {
    expect(primaryEngine(engines, [])).toMatchObject({ id: "codex", state: "ready" });
    expect(primaryEngine([engines[1]!], [])).toMatchObject({ id: "claude" });
    expect(primaryEngine([], ["claude"])).toBeNull();
  });
  it("reads switched off, missing and signed out in that order", () => {
    expect(engineState({ instanceId: "a", displayName: "A", enabled: false, snapshot: { state: "unavailable" } })).toBe("off");
    expect(engineState({ instanceId: "a", displayName: "A", snapshot: { state: "unavailable" } })).toBe("missing");
    expect(engineState({ instanceId: "a", displayName: "A", snapshot: { state: "available", authenticated: false } })).toBe("signed-out");
    // Fuigo's own signed-out flag is not a problem while /api/engine-health is loading or failed, as on the server.
    expect(engineState({ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: false } })).toBe("ready");
    expect(primaryEngine([{ instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available", authenticated: false } }], ["fuigo"])).toMatchObject({ id: "fuigo", state: "ready" });
    expect(engineState({ instanceId: "a", displayName: "A", snapshot: { state: "available" } })).toBe("ready");
  });
  it("reads a sign-in check that did not answer as checking, and Today never says signed in for it", () => {
    expect(engineState({ instanceId: "a", displayName: "A", snapshot: { state: "available", authUnverified: true } })).toBe("checking");
    const tags = texts(base({ engine: { id: "codex", label: "Codex", state: "checking", line: "" } }));
    expect(tags[0]).toBe("Checking Codex sign-in");
    expect(tags.some((tag) => /signed in/i.test(tag))).toBe(false);
  });
});

describe("Today's routines and Finished in the background", () => {
  const routine = (over: Partial<Routine>): Routine => ({ id: "r1", name: "Morning brief", prompt: "", target: "bot" as Routine["target"], botId: "nova", runOn: "local" as Routine["runOn"], enabled: true, schedule: {} as Routine["schedule"], durationMinutes: 5, nextRunAt: null, createdAt: 0, updatedAt: 0, ...over });
  const run = (over: Partial<RoutineRun>): RoutineRun => ({ id: "x1", routineId: "r1", routineName: "Morning brief", target: "bot" as RoutineRun["target"], botId: "nova", runOn: "local" as RoutineRun["runOn"], scheduledFor: at(8), status: "completed", manual: false, startedAt: at(8), finishedAt: at(8) + 40_000, ...over } as RoutineRun);
  const now = new Date(at(9, 30));

  it("lists what ran today with when and how long, one row per routine, then what is still to come", () => {
    const rows = routinesToday(
      [routine({ id: "r1" }), routine({ id: "r2", name: "Weekly digest", botId: "max", nextRunAt: at(17) }), routine({ id: "r3", name: "Tomorrow", nextRunAt: at(9) + 86_400_000 })],
      [run({ id: "a" }), run({ id: "b", startedAt: at(7), finishedAt: at(7) + 1000 })],
      { nova: "Nova", max: "Max" }, now,
    );
    expect(rows.map((row) => [row.line, row.meta, row.tone])).toEqual([
      ["Morning brief", "Nova · ran 08:00 · took 40 s", "ok"],
      ["Weekly digest", "Max · at 17:00", "next"],
    ]);
  });

  it("marks a failed run as needing a look, and leaves yesterday out", () => {
    const rows = routinesToday([], [run({ status: "failed" }), run({ id: "old", routineId: "r9", scheduledFor: at(8) - 86_400_000, startedAt: at(8) - 86_400_000, finishedAt: at(8) - 86_400_000 })], { nova: "Nova" }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meta: "Nova · needs a look", tone: "bad" });
  });

  it("shows finished work by its first line, newest first, within a day", () => {
    const rows = finishedInBackground([
      run({ id: "a", output: "## 14 invoices filed in Drive\nmore", finishedAt: at(6, 30) }),
      run({ id: "b", output: "Morning brief sent to you", finishedAt: at(8, 2) }),
      run({ id: "c", output: "", finishedAt: at(9) }),
      run({ id: "d", output: "old", finishedAt: at(9) - 2 * 86_400_000 }),
    ], { nova: "Nova" }, now);
    expect(rows.map((row) => [row.line, row.meta])).toEqual([["Morning brief sent to you", "Nova · 08:02"], ["14 invoices filed in Drive", "Nova · 06:30"]]);
  });
});

describe("the engine the Health level reads (HEALTH-HEADLINE-FALLBACK)", () => {
  const row = (id: string, state: "ready" | "missing" | "signed-out" | "off" | "limit" | "checking", usedBy = 0) => ({ id, label: id, state, line: "", usedBy });
  it("never reads an engine nobody chose and no bot uses, so an unused missing engine cannot turn Health red", () => {
    expect(healthEngine([row("codex", "missing"), row("claude", "missing")], null)).toBeNull();
    expect(healthEngine([row("codex", "missing"), row("fuigo", "ready", 2)], null)).toMatchObject({ id: "fuigo", state: "ready" });
    expect(healthEngine([row("codex", "missing"), row("claude", "ready")], "claude")).toMatchObject({ id: "claude" });
  });
  it("reads the worst of the default and every engine a bot uses", () => {
    expect(healthEngine([row("claude", "ready"), row("codex", "signed-out", 1)], "claude")).toMatchObject({ id: "codex", state: "signed-out" });
    expect(healthEngine([row("claude", "missing"), row("codex", "ready", 3)], "claude")).toMatchObject({ id: "claude", state: "missing" });
    expect(healthEngine([row("claude", "limit", 1), row("codex", "off", 1)], "codex")).toMatchObject({ id: "codex" });
  });
  it("an older answer with no usedBy still reads the default", () => {
    expect(healthEngine([{ id: "claude", label: "Claude", state: "signed-out", line: "" }, { id: "codex", label: "Codex", state: "missing", line: "" }], "claude")).toMatchObject({ id: "claude" });
  });
});

describe("Today slice 1.0.18: head and Done today", () => {
  const run = (over: Partial<RoutineRun>): RoutineRun => ({ id: "x1", routineId: "r1", routineName: "Morning brief", target: "bot" as RoutineRun["target"], botId: "nova", runOn: "local" as RoutineRun["runOn"], scheduledFor: at(8), status: "completed", manual: false, startedAt: at(8), finishedAt: at(8) + 40_000, ...over } as RoutineRun);
  const now = new Date(at(9, 30));

  it("reads Nothing needs you in the ok tone, and a count above 0 in info", () => {
    expect(needsTag(0)).toMatchObject({ tone: "ok", text: "Nothing needs you" });
    expect(needsTag(2)).toMatchObject({ tone: "info" });
    expect(needsTag(undefined)).toBeNull();
    expect(todayModel(base({ needsCount: 0 })).tags.find((tag) => tag.key === "needs")?.tone).toBe("ok");
  });

  it("the head's all-clear needs a fresh 0 count and no Worth a look line, as NeedsBlock does (H6)", () => {
    const tag = (count: number | undefined, needsState: TodayInput["needsState"]) => todayModel(base({ needsCount: count, needsState })).tags.find((t) => t.key === "needs");
    // a stale zero: the checking words, never green
    expect(tag(0, { stale: true, lines: 0, reads: true })).toMatchObject({ tone: "info", text: "Checking what needs you." });
    // a stale count above 0: never green either
    expect(tag(2, { stale: true, lines: 2, reads: true })?.tone).not.toBe("ok");
    // unknown on a surface that reads Needs you: checking, not silence and not green
    expect(tag(undefined, { reads: true })).toMatchObject({ tone: "info", text: "Checking what needs you." });
    // the browser door has no read: no tag, as before
    expect(tag(undefined, { reads: false })).toBeUndefined();
    // zero owed but Worth a look lines below: counted, in info, never Nothing needs you
    expect(tag(0, { stale: false, lines: 1, reads: true })).toMatchObject({ tone: "info", text: "1 thing needs you" });
    expect(tag(0, { stale: false, lines: 3, reads: true })).toMatchObject({ tone: "info", text: "3 things need you" });
    // the count above 0 keeps the badge truth
    expect(tag(4, { stale: false, lines: 1, reads: true })).toMatchObject({ tone: "info", text: "4 things need you" });
    // only a fresh 0 with no line is the green all-clear
    expect(tag(0, { stale: false, lines: 0, reads: true })).toMatchObject({ tone: "ok", text: "Nothing needs you" });
  });

  it("Detailed blocks are in DOM order for the active layout: phone one column, desktop row by row", () => {
    expect(detailedOrder(true)).toEqual(["needs", "cost", "day", "routines", "working", "done"]);
    expect(detailedOrder(false)).toEqual(["needs", "day", "cost", "routines", "working", "done"]);
  });

  it("puts Fuigo first when any visible bot runs on Fuigo, and says Fuigo on Flux Router", () => {
    const engines = [
      { instanceId: "claude", displayName: "Claude", snapshot: { state: "available" as const, authenticated: true } },
      { instanceId: "fuigo", displayName: "Fuigo", driverKind: "fuigoAgent", snapshot: { state: "available" as const, authenticated: false } },
    ];
    const most = primaryEngine(engines, ["claude", "claude", "fuigo"]);
    expect(most).toMatchObject({ id: "claude" });
    const engine = todayEngine(most, engines, ["claude", "claude", "fuigo"]);
    expect(engine).toMatchObject({ id: "fuigo", state: "ready", fuigo: true });
    const tags = todayModel(base({ engine })).tags;
    expect(tags[0]).toMatchObject({ key: "engine", tone: "ok", text: "Fuigo on Flux Router", action: "engines" });
    // The server's own row keeps the server's state.
    expect(todayEngine({ id: "claude", label: "Claude", state: "ready", line: "" }, engines, ["fuigo"], [{ id: "fuigo", label: "Fuigo", state: "missing", line: "Not found" }])).toMatchObject({ id: "fuigo", state: "missing", fuigo: true });
    expect(engineTag({ engine: { id: "fuigo", label: "Fuigo", state: "missing", line: "", fuigo: true }, flux: "ok", connectivity: "online" })?.text).toBe("Fuigo is not on this computer");
    // No bot on Fuigo: the engine Today already named, untouched.
    expect(todayEngine(most, engines, ["claude"])).toBe(most);
    // Flux allowance still outranks it.
    expect(todayModel(base({ engine, flux: "allowance-used-up" })).tags[0]?.text).toBe("Flux Router: allowance used up");
  });

  it("builds the lead line from its parts, dropping every part at 0", () => {
    expect(leadLine({ ran: 4, look: 2, decide: 1, next: { name: "Inbox sweep", at: at(11) } })).toEqual([
      { key: "ux.l2a.today.lead.ran", params: { n: 4 } },
      { key: "ux.l2a.today.lead.look", params: { n: 2 } },
      { key: "ux.l2a.today.lead.decide", params: { n: 1 } },
      { key: "ux.l2a.today.lead.next", params: { name: "Inbox sweep", time: "11:00" } },
    ]);
    expect(leadLine({ ran: 3, look: 0, decide: 2, next: null }).map((part) => "key" in part && part.key)).toEqual(["ux.l2a.today.lead.ran", "ux.l2a.today.lead.decide"]);
    expect(leadLine({ ran: 0, look: 0, decide: 0, next: null })).toEqual([{ key: "ux.l2a.today.lead.quiet" }]);
    expect(leadLine({ ran: 0, look: Number.NaN, decide: -1, next: { name: "Digest", at: at(17, 5) } })).toEqual([{ key: "ux.l2a.today.lead.quiet" }, { key: "ux.l2a.today.lead.next", params: { name: "Digest", time: "17:05" } }]);
    expect(routinesRanToday([run({ id: "a" }), run({ id: "b", status: "failed" }), run({ id: "c", finishedAt: at(8) - 86_400_000, scheduledFor: at(8) - 86_400_000 })], now)).toBe(1);
  });

  it("titles Done today by the routine name, failed and missed first with their error or the generic line", () => {
    const rows = doneToday([
      run({ id: "ok", routineName: "Morning brief", output: "## 14 invoices filed\nmore", finishedAt: at(9) }),
      run({ id: "bad", routineName: "Inbox sweep", status: "failed", error: "Gmail is not authorized.\nstack", finishedAt: at(7) }),
      run({ id: "miss", routineName: "Weekly digest", status: "missed", finishedAt: undefined, scheduledFor: at(6) }),
      run({ id: "quiet", routineName: "Tidy", output: "", finishedAt: at(8, 30) }),
      run({ id: "live", status: "running", finishedAt: undefined }),
      run({ id: "old", finishedAt: at(9) - 86_400_000 }),
    ], { nova: "Nova" }, now);
    expect(rows.map((row) => [row.title, row.status, row.line])).toEqual([
      ["Inbox sweep", "failed", { raw: "Gmail is not authorized." }],
      ["Weekly digest", "missed", { key: "ux.l2a.today.look.failedGeneric" }],
      ["Morning brief", "completed", { raw: "14 invoices filed" }],
      ["Tidy", "completed", null],
    ]);
    expect(rows[0]).toMatchObject({ tone: "bad", botName: "Nova", time: "07:00" });
    expect(todayModel(base({ runs: [run({ id: "ok", output: "Done" })] })).done.map((row) => row.title)).toEqual(["Morning brief"]);
    expect(todayModel(base({ firstRun: true, runs: [run({})] })).done).toEqual([]);
  });
});
