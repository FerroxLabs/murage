// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's scenarios (UX 1.0.13, lane L2A): the greeting by hour, the tag order
// (engine first, then health, needs, month, clients, apps, quiet hours), the
// first-run Today (one tag only), and the routine rows.
import { describe, expect, it } from "vitest";
import type { Routine, RoutineRun } from "@/lib/routines";
import { engineState, finishedInBackground, greetingFor, primaryEngine, routinesToday, todayModel, type TodayInput } from "./today-model";

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
    expect(engineState({ instanceId: "a", displayName: "A", snapshot: { state: "available" } })).toBe("ready");
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
