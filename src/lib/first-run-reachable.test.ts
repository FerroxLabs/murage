import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The screens import the chrome, which talks to the harness. Neither exists
// in a node test and neither is what this file is about.
vi.mock("@/state/store", () => ({
  api: async () => ({}),
  useStore: () => ({ state: {}, dispatch: () => {} }),
}));

const {
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
} = await import("./first-run-flow");
const {
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
} = await import("./first-run-jobs");
type FirstRunJobWorld = import("./first-run-jobs").FirstRunJobWorld;
type FirstRunSearchRouting = import("./first-run-jobs").FirstRunSearchRouting;
const {
  FirstRunBusinessResultView,
  FirstRunConnectView,
  FirstRunDayResultView,
  FirstRunInputView,
  FirstRunNotesResultView,
  FirstRunResearchResultView,
  FirstRunWorkingView,
  firstRunGo,
  firstRunReachResult,
} = await import("@/components/FirstRunJobsCard");
const { SETUP_JOB_APPS } = await import("../../shared/setup");
type SetupJobApp = import("../../shared/setup").SetupJobApp;

/**
 * NO SCREEN IN THIS FLOW CAN ARRIVE EMPTY, AND EVERY JOB REACHES ITS END.
 *
 * The audit found cards that lose their entire body after one failed setup
 * request: a child returned null with no cached view, the parent's `if
 * (!body)` did not catch a child that returned null, and the person was left
 * looking at a heading with nothing under it. The instruction was that
 * whatever replaced them must not have that shape.
 *
 * THIS FILE USED TO PROVE THAT ABOUT THE MODULES ONLY, AND THE MODULES WERE
 * RENDERED BY NOTHING. `firstRunCardBody` had no case for `jobs` or `do-it`,
 * so the last two steps drew literally nothing while every assertion in here
 * passed. The header was false in the only place it mattered. So the walk
 * still goes through the real rules, and at every stop it now RENDERS the
 * component that stop is made of and reads the words back out of the markup.
 * A screen that stops being drawn fails here.
 *
 * It sweeps every job across every machine the flow can be opened on and
 * asserts two things at each step: the screen the person is on has words on
 * it, and there is a way forward from it. It does not read source.
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
      // THE SIGNED-OUT MACHINE IS ITS OWN MACHINE, AND IT WAS MISSING HERE.
      // `nothingToThinkWith` is FALSE on a computer whose only engine is
      // signed out, so a sweep that did not vary `nothingRunnable`
      // separately never once opened this flow as that person sees it. The
      // impossible pairing is skipped: nothing to think with means nothing
      // runnable by definition.
      for (const nothingRunnable of [false, true]) {
        if (nothingToThinkWith && !nothingRunnable) continue;
        for (const connected of APP_SETS) {
          for (const appsUnreadable of [false, true]) {
            for (const search of ROUTINGS) {
              if (appsUnreadable && connected.length > 0) continue;
              worlds.push({ fluxReady, nothingToThinkWith, nothingRunnable, connected, appsUnreadable, search });
            }
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

/** A sentence as it looks once React has put it in the document. */
const asHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/**
 * Render a screen and hand back its markup, having first insisted there is
 * something on it.
 *
 * "Something on it" is the words a person can read, not the elements: the
 * defect this file exists for drew a step heading with an empty body under
 * it, and an empty body is still a div.
 */
function screenOf(node: ReactElement, label: string): string {
  const markup = renderToStaticMarkup(node);
  const words = markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  expect(words.length, `${label} rendered nothing a person can read`).toBeGreaterThan(20);
  return markup;
}

/** Every sentence the module decided on really reached the screen. */
function saysAll(markup: string, label: string, lines: readonly (string | null | undefined)[]): void {
  for (const line of lines) {
    if (!said(line)) continue;
    expect.soft(markup, `${label} did not render "${line}"`).toContain(asHtml(line!));
  }
}

const noop = () => {};

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

          // ...and it is really on the screen, on a desktop and on a surface
          // that cannot open a browser window for a sign-in.
          for (const desktop of [true, false] as const) {
            const markup = screenOf(
              createElement(FirstRunConnectView, {
                screen: screen!, busy: "" as const, failure: "", desktop,
                onConnect: noop, onSkipToInput: noop, onElsewhere: noop,
              }),
              `${label} connect desktop=${desktop}`,
            );
            saysAll(markup, `${label} connect`, [
              screen!.heading, screen!.lead, screen!.elsewhere, screen!.skipToInput,
              ...screen!.rows.flatMap((row) => [row.bold, row.small]),
            ]);
          }

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

          const markup = screenOf(
            createElement(FirstRunInputView, {
              screen: box!, value: "", busy: false, onChange: noop, onGo: noop, onElsewhere: noop,
            }),
            `${label} input`,
          );
          saysAll(markup, `${label} input`, [box!.heading, box!.lead, box!.go, box!.elsewhere, box!.connectedLine]);
          // THE PLACEHOLDER STAYS A PLACEHOLDER. Text in the box is the
          // person's, always, and an earlier version pre-filled the notes box.
          expect(markup, `${label} input`).toContain(`placeholder="${asHtml(box!.placeholder)}"`);
          expect(markup, `${label} put words in the person's box`).not.toMatch(/<textarea[^>]*>[^<]/);
        }

        for (const typed of TYPED) {
          const items = parseLines(typed);
          const working = workingLines(id, items, typed);
          expect(working, `${label} working`).toHaveLength(3);
          for (const line of working) expect(said(line), `${label} working`).toBe(true);
          // The first line is on screen from the first frame, so the working
          // screen is never a blank pause.
          saysAll(screenOf(createElement(FirstRunWorkingView, { lines: working, shown: 1 }), `${label} working`),
            `${label} working`, [working[0]]);
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

          const markup = screenOf(
            createElement(FirstRunDayResultView, {
              result, busy: false, failure: "", onMorning: noop, onAgain: noop,
            }),
            label,
          );
          saysAll(markup, label, [
            result.header, result.provenance, result.unread, result.riskEyebrow, result.again,
            result.risk?.line, result.risk?.reason, result.risk?.advice,
            result.calm?.body, result.calm?.second,
            result.fixed.heading, result.waiting.heading,
            ...result.fixed.items, ...result.waiting.items,
            result.morning?.heading, result.morning?.body, result.morning?.button,
          ]);
          // The morning offer is on the brief and on nothing else, on screen
          // as well as in the answer.
          expect(markup.includes(asHtml(briefRoutineOfferHeading())), label).toBe(id === "brief");
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

      const markup = screenOf(createElement(FirstRunNotesResultView, { result, onAgain: noop }), `notes "${typed}"`);
      saysAll(markup, `notes "${typed}"`, [
        result.header, result.provenance, result.eyebrow, result.caveat, result.again, result.empty,
        ...result.steps.flatMap((step) => [step.text, step.tag]),
      ]);
    }
  });

  it("fills the research result on every machine that can reach it", () => {
    for (const world of MACHINES) {
      const result = researchResult(world);
      expect(said(result.again), JSON.stringify(world)).toBe(true);
      // The local-model line is an addition, never the whole body, so null
      // here is correct rather than empty.
      expect(result.onLocal === null || said(result.onLocal)).toBe(true);
      const markup = renderToStaticMarkup(createElement(FirstRunResearchResultView, { result, onAgain: noop }));
      saysAll(markup, "research", [result.again, result.onLocal]);
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

      const markup = screenOf(
        createElement(FirstRunBusinessResultView, {
          result, busy: false, taken: false, failure: "", onSwitchOn: noop, onAgain: noop,
        }),
        "crew",
      );
      saysAll(markup, "crew", [
        result.header, result.lead, result.botsEyebrow, result.again,
        result.reviewEyebrow, result.reviewLine,
        result.offer?.label, result.offer?.why,
        ...result.bots.flatMap((bot) => [bot.name, bot.role]),
      ]);
      // A crew with no bots in it must not draw an empty list and call it
      // "your crew"; it still says what it is and how to get back.
      expect(markup).toContain(asHtml(result.again));
    }
  });

  // The one screen in step five that has nothing of its own to say yet. It
  // must not draw the crew before the install has answered, and it must not
  // leave somebody stranded if the install refused.
  it("gives the crew's waiting screen words and a way off it, refusal or not", async () => {
    const { FirstRunCrewWaitingView } = await import("@/components/FirstRunJobsCard");
    for (const failure of ["", "That crew is not available on this computer."]) {
      const markup = screenOf(createElement(FirstRunCrewWaitingView, { failure, onAgain: noop }), `crew waiting "${failure}"`);
      expect(markup, "no way off the waiting screen").toMatch(/<button/);
      if (failure) expect(markup).toContain(asHtml(failure));
      // Nothing about a crew that may not exist yet.
      expect(markup).not.toContain("Business Planner");
    }
  });

  it("sends one brief request and only one, whatever screen asked for it", () => {
    expect(briefRoutineRequest()).toEqual(briefRoutineRequest());
    expect(briefRoutineRequest().template).toBe("brief");
  });
});

/** The morning offer's heading, as the only screen that carries it words it. */
function briefRoutineOfferHeading(): string {
  return dayResult(FIRST_RUN_JOB_SHAPES.brief, [], {
    fluxReady: true, nothingToThinkWith: false, nothingRunnable: false, connected: [], appsUnreadable: false, search: "anonymous",
  }).morning!.heading;
}

// RELEASE BLOCK #2, THIRD PART: A STEP THAT FINISHED ON A TIMER, OR NEVER.
//
// Step five used to be answered inside `finish()`, which runs off the working
// screen's 2.3 second timer and nowhere else. On the "keep what you typed"
// path `typedMayShowWorking` is false, so the person goes from the box
// straight to the result, `finish()` never runs, and `flow` is never
// answered: the last step of the first run stays outstanding for ever, on the
// one machine that cannot do the work in the first place.
//
// These two functions are the whole of the rule and they take their effects
// as arguments, because this suite renders static markup and cannot press a
// button. A rule that lives only inside a component's closure is a rule
// nothing here can read, which is how a step came to finish on a timer with
// nobody noticing.
describe("step five finishes on every road into the result", () => {
  it("answers the step from the box, on a machine that can work and on one that cannot", async () => {
    for (const world of MACHINES) {
      for (const id of FIRST_RUN_JOB_IDS) {
        const label = `${id} on ${JSON.stringify(world)}`;
        const stages: string[] = [];
        const answered: string[] = [];
        await firstRunGo(world, id, (stage) => stages.push(stage), async (job) => {
          answered.push(job);
        });

        if (typedMayShowWorking(world)) {
          // Something is behind the box, so the three counted lines run and
          // the timer hands over to the road below.
          expect(stages, label).toEqual(["working"]);
          expect(answered, `${label} finished the step before doing the work`).toEqual([]);
        } else {
          // THE PATH THAT NEVER SETTLED. Nothing to think with and no key:
          // the box keeps what they wrote, there is no working state to show,
          // and the result is the end of the step.
          expect(stages, label).toEqual(["result"]);
          expect(answered, `${label} reached a result that nothing answered for`).toEqual([id]);
        }
      }
    }
  });

  it("answers it when the timer hands over too, and when there is no job to answer with", async () => {
    const stages: string[] = [];
    const answered: string[] = [];
    await firstRunReachResult("business", (stage) => stages.push(stage), async (job) => {
      answered.push(job);
    });
    expect(stages).toEqual(["result"]);
    expect(answered, "the working screen handed over without finishing the step").toEqual(["business"]);

    // The reopened card: no job recorded, so there is nothing to answer with
    // and nothing to answer for. It must still not claim a step.
    const none: string[] = [];
    await firstRunReachResult(null, () => {}, async (job) => {
      none.push(job);
    });
    expect(none).toEqual([]);
  });
});

describe("the escape hatch for somebody whose thing is not on the list", () => {
  it("opens the notes box on every machine, including one with nothing", () => {
    for (const world of MACHINES) {
      const box = escapeHatchScreen(world);
      expect(box.kind, JSON.stringify(world)).toBe("notes");
      expect(said(box.heading), JSON.stringify(world)).toBe(true);
      expect(said(box.placeholder), JSON.stringify(world)).toBe(true);
      const markup = screenOf(
        createElement(FirstRunInputView, {
          screen: box, value: "", busy: false, onChange: noop, onGo: noop, onElsewhere: noop,
        }),
        "escape hatch",
      );
      saysAll(markup, "escape hatch", [box.heading, box.lead, box.go, box.elsewhere]);
    }
  });

  it("does not stop at the connect screen the way pressing the job would", () => {
    // This is the one place in the flow that deliberately skips a gate. The
    // notes job reaches for no account, so there is nothing to connect, and
    // asking for a key before letting somebody type a sentence is the form
    // this release exists to delete.
    const blank: FirstRunJobWorld = {
      fluxReady: false, nothingToThinkWith: true, nothingRunnable: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.notes, blank)).toBe("connect");
    expect(escapeHatchScreen(blank).kind).toBe("notes");
  });

  it("keeps what they wrote and starts nothing, on the machine with nothing", () => {
    const blank: FirstRunJobWorld = {
      fluxReady: false, nothingToThinkWith: true, nothingRunnable: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(typedMayShowWorking(blank)).toBe(false);
    expect(said(typedReply(blank))).toBe(true);
  });
});
