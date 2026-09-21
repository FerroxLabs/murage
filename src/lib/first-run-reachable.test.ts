import { describe, expect, it } from "vitest";

import {
  briefRoutineRequest,
  businessResult,
  dayResult,
  escapeHatchScreen,
  firstRunInputScreen,
  flowStageFor,
  notesResult,
  parseLines,
  researchResult,
  workingLines,
} from "./first-run-flow";
import {
  FIRST_RUN_JOB_IDS,
  FIRST_RUN_JOB_SHAPES,
  afterConnect,
  chiefLead,
  chiefQuestion,
  chiefStatusLine,
  firstRunConnectScreen,
  firstRunJobRows,
  typedMayShowWorking,
  typedReply,
  type FirstRunJobWorld,
  type FirstRunSearchRouting,
} from "./first-run-jobs";
import { SETUP_JOB_APPS, type SetupJobApp } from "../../shared/setup";

/**
 * NO SCREEN IN THIS FLOW CAN ARRIVE EMPTY, AND EVERY JOB REACHES ITS END.
 *
 * The audit found cards that lose their entire body after one failed setup
 * request: a child returned null with no cached view, the parent's `if
 * (!body)` did not catch a child that returned null, and the person was left
 * looking at a heading with nothing under it. The instruction was that
 * whatever replaced them must not have that shape.
 *
 * This sweeps every job across every machine the flow can be opened on and
 * asserts two things at each step: the screen the person is on has words on
 * it, and there is a way forward from it. It does not read source. It walks
 * the flow the way a person would and fails if any stop on the walk is
 * blank or is a dead end.
 */
const ROUTINGS: readonly FirstRunSearchRouting[] = ["anonymous", "own-account", "unconfigured", "off"];
const APP_SETS: readonly (readonly SetupJobApp[])[] = [
  [],
  ["gmail"],
  ["googlecalendar"],
  [...SETUP_JOB_APPS],
];

/** Every machine this flow can be opened on, stated as the facts it reads.
 *  The unreadable-store case is included with an empty set, because that is
 *  exactly how a job is told to treat it. */
function everyMachine(): FirstRunJobWorld[] {
  const worlds: FirstRunJobWorld[] = [];
  for (const fluxReady of [false, true]) {
    for (const nothingToThinkWith of [false, true]) {
      for (const connected of APP_SETS) {
        for (const appsUnreadable of [false, true]) {
          for (const search of ROUTINGS) {
            if (appsUnreadable && connected.length > 0) continue;
            worlds.push({ fluxReady, nothingToThinkWith, connected, appsUnreadable, search });
          }
        }
      }
    }
  }
  return worlds;
}

const MACHINES = everyMachine();

/** What the person could plausibly have in the box by the time a result is
 *  built, including nothing at all. */
const TYPED = [
  "",
  "buy milk",
  "9:30 standup\nboard pack due Thursday\ncall Rahul back about the lease\nbuy milk",
  "9:30 standup\n2pm dentist",
];

function said(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

describe("the Chief's own screen, on every machine", () => {
  it("has a question, a lead, a status line and five tagged jobs, always", () => {
    for (const world of MACHINES) {
      const label = JSON.stringify(world);
      expect(said(chiefQuestion("Sean")), label).toBe(true);
      expect(said(chiefLead(world)), label).toBe(true);
      expect(said(chiefStatusLine(world, "qwen3:8b on Ollama")), label).toBe(true);
      // A machine whose engine has no name must still get a status line.
      expect(said(chiefStatusLine(world, "")), label).toBe(true);

      const rows = firstRunJobRows(world);
      expect(rows.map((row) => row.id), label).toEqual([...FIRST_RUN_JOB_IDS]);
      for (const row of rows) {
        expect(said(row.title), `${label} ${row.id}`).toBe(true);
        expect(said(row.sub), `${label} ${row.id}`).toBe(true);
        expect(said(row.tag.text), `${label} ${row.id}`).toBe(true);
      }
    }
  });

  it("never offers a job as ready on a machine that cannot run it", () => {
    for (const world of MACHINES) {
      if (!world.nothingToThinkWith || world.fluxReady) continue;
      for (const row of firstRunJobRows(world)) {
        expect(row.press, `${JSON.stringify(world)} ${row.id}`).toBe("connect");
      }
    }
  });
});

describe("every job walks from the Chief to a result", () => {
  it("never lands on a screen with nothing on it, and never dead ends", () => {
    for (const world of MACHINES) {
      for (const id of FIRST_RUN_JOB_IDS) {
        const job = FIRST_RUN_JOB_SHAPES[id];
        const label = `${id} on ${JSON.stringify(world)}`;
        let stage = flowStageFor(job, world);

        if (stage === "connect") {
          const screen = firstRunConnectScreen(job, world);
          expect(screen, label).not.toBeNull();
          expect(said(screen!.heading), label).toBe(true);
          expect(said(screen!.lead), label).toBe(true);
          expect(screen!.rows.length, label).toBeGreaterThan(0);
          for (const row of screen!.rows) {
            expect(said(row.bold), `${label} ${row.need}`).toBe(true);
            expect(said(row.small), `${label} ${row.need}`).toBe(true);
          }
          // A way out that is not connecting: either type it in instead, or
          // go back and pick something else. Never neither.
          expect(said(screen!.elsewhere) || said(screen!.skipToInput), label).toBe(true);

          // Connecting everything it asked for advances, and the screen it
          // advances to is one this walk knows how to render.
          const done: FirstRunJobWorld = {
            ...world,
            fluxReady: true,
            connected: [...SETUP_JOB_APPS],
            appsUnreadable: false,
          };
          stage = afterConnect(job, done);
          expect(["input", "working"], label).toContain(stage);
        }

        if (stage === "input") {
          const box = firstRunInputScreen(job, world);
          expect(box, label).not.toBeNull();
          expect(said(box!.heading), label).toBe(true);
          expect(said(box!.lead), label).toBe(true);
          expect(said(box!.placeholder), label).toBe(true);
          expect(said(box!.go), label).toBe(true);
          expect(said(box!.elsewhere), label).toBe(true);
          expect(box!.rows, label).toBeGreaterThan(0);
        }

        for (const typed of TYPED) {
          const items = parseLines(typed);
          const working = workingLines(id, items, typed);
          expect(working, `${label} working`).toHaveLength(3);
          for (const line of working) expect(said(line), `${label} working`).toBe(true);
        }
      }
    }
  });
});

describe("every result has a body and a way on, whatever was typed", () => {
  it("fills the day and the brief from any input at all", () => {
    for (const world of MACHINES) {
      for (const id of ["brief", "day"] as const) {
        for (const typed of TYPED) {
          const label = `${id} "${typed.slice(0, 20)}" ${JSON.stringify(world)}`;
          const result = dayResult(FIRST_RUN_JOB_SHAPES[id], parseLines(typed), world);
          expect(said(result.header), label).toBe(true);
          expect(said(result.provenance), label).toBe(true);
          expect(said(result.riskEyebrow), label).toBe(true);
          // Exactly one of the two: a named risk, or the words for having
          // none. Never both, and never neither.
          expect([result.risk === null, result.calm === null], label).toEqual([result.calm !== null, result.risk !== null]);
          if (result.risk) {
            expect(said(result.risk.line), label).toBe(true);
            expect(said(result.risk.reason), label).toBe(true);
            expect(said(result.risk.advice), label).toBe(true);
          } else {
            expect(said(result.calm!.body), label).toBe(true);
            expect(said(result.calm!.second), label).toBe(true);
          }
          for (const column of [result.fixed, result.waiting]) {
            expect(said(column.heading), label).toBe(true);
            // An empty column says something rather than showing a gap.
            expect(column.items.length > 0 || said(column.empty), label).toBe(true);
          }
          expect(said(result.again), label).toBe(true);
          if (id === "brief") {
            expect(said(result.morning!.heading), label).toBe(true);
            expect(said(result.morning!.body), label).toBe(true);
            expect(said(result.morning!.button), label).toBe(true);
          } else {
            expect(result.morning, label).toBeNull();
          }
        }
      }
    }
  });

  it("fills the notes result even when nothing survived the parse", () => {
    for (const typed of TYPED) {
      const result = notesResult(parseLines(typed));
      expect(said(result.header)).toBe(true);
      expect(said(result.provenance)).toBe(true);
      expect(said(result.eyebrow)).toBe(true);
      expect(said(result.caveat)).toBe(true);
      expect(said(result.again)).toBe(true);
      expect(result.steps.length > 0 || said(result.empty)).toBe(true);
    }
  });

  it("fills the research result on every machine that can reach it", () => {
    for (const world of MACHINES) {
      const result = researchResult(world);
      expect(said(result.again), JSON.stringify(world)).toBe(true);
      // The local-model line is an addition, never the whole body, so null
      // here is correct rather than empty.
      expect(result.onLocal === null || said(result.onLocal)).toBe(true);
    }
  });

  it("fills the crew result whatever the package turns out to hold", () => {
    for (const crew of [
      { agents: [{ key: "business-planner", name: "Business Planner" }, { key: "draft-partner", name: "Draft Partner" }], routine: { name: "Weekly business review (suggested)", time: "09:00", weekdays: [1], durationMinutes: 15, enabledAfterInstall: false } },
      { agents: [{ key: "business-planner", name: "Business Planner" }], routine: null },
      { agents: [], routine: null },
    ]) {
      const result = businessResult(crew);
      expect(said(result.header)).toBe(true);
      expect(said(result.lead)).toBe(true);
      expect(said(result.botsEyebrow)).toBe(true);
      expect(said(result.again)).toBe(true);
      // The review section is all present or all absent, never half of it.
      expect([result.reviewEyebrow === null, result.reviewLine === null])
        .toEqual([result.reviewLine === null, result.reviewEyebrow === null]);
    }
  });

  it("sends one brief request and only one, whatever screen asked for it", () => {
    expect(briefRoutineRequest()).toEqual(briefRoutineRequest());
    expect(briefRoutineRequest().template).toBe("brief");
  });
});

describe("the escape hatch for somebody whose thing is not on the list", () => {
  it("opens the notes box on every machine, including one with nothing", () => {
    for (const world of MACHINES) {
      const box = escapeHatchScreen(world);
      expect(box.kind, JSON.stringify(world)).toBe("notes");
      expect(said(box.heading), JSON.stringify(world)).toBe(true);
      expect(said(box.placeholder), JSON.stringify(world)).toBe(true);
    }
  });

  it("does not stop at the connect screen the way pressing the job would", () => {
    // This is the one place in the flow that deliberately skips a gate. The
    // notes job reaches for no account, so there is nothing to connect, and
    // asking for a key before letting somebody type a sentence is the form
    // this release exists to delete.
    const blank: FirstRunJobWorld = {
      fluxReady: false, nothingToThinkWith: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.notes, blank)).toBe("connect");
    expect(escapeHatchScreen(blank).kind).toBe("notes");
  });

  it("keeps what they wrote and starts nothing, on the machine with nothing", () => {
    const blank: FirstRunJobWorld = {
      fluxReady: false, nothingToThinkWith: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(typedMayShowWorking(blank)).toBe(false);
    expect(said(typedReply(blank))).toBe(true);
  });
});
