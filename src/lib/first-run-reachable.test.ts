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
  firstRunStage,
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
const { FIRST_RUN_COPY } = await import("./first-run-copy");
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

/**
 * THE THREE ENGINE STATES A MACHINE CAN REALLY BE IN, as the pair of
 * predicates the flow reads: [nothingToThinkWith, nothingCanAnswer].
 *
 * The sweep used to run only the first of the two, which is exactly how the
 * middle row got shipped unchecked. A machine whose only engine is Claude
 * Code or Codex installed and never signed in has SOMETHING on it, so
 * detection runs and `nothingToThinkWith` is false, and NOTHING that can
 * answer, so every job on it still has to ask for a key first.
 *
 * The fourth combination does not exist: an empty machine that can answer is
 * a contradiction, and `nothingToThinkWith` implies `nothingCanAnswer`
 * because `agents` is empty in both.
 */
const ENGINE_STATES: readonly (readonly [boolean, boolean])[] = [
  [true, true],   // nothing on it at all
  [false, true],  // an engine is here and nobody is signed in to it
  [false, false], // something here can answer
];

/** Every machine this flow can be opened on, stated as the facts it reads.
 *  The unreadable-store case is included with an empty set, because that is
 *  exactly how a job is told to treat it. */
function everyMachine(): FirstRunJobWorld[] {
  const worlds: FirstRunJobWorld[] = [];
  for (const fluxReady of [false, true]) {
    for (const [nothingToThinkWith, nothingCanAnswer] of ENGINE_STATES) {
      for (const connected of APP_SETS) {
        for (const appsUnreadable of [false, true]) {
          for (const search of ROUTINGS) {
            if (appsUnreadable && connected.length > 0) continue;
            worlds.push({ fluxReady, nothingToThinkWith, nothingCanAnswer, connected, appsUnreadable, search });
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

  // READ OFF `nothingCanAnswer`, WHICH IS THE READINESS QUESTION. This used
  // to skip every machine whose only engine was signed out, because that
  // machine has `nothingToThinkWith` false, and those are precisely the
  // machines on which every job was being offered as ready now with nothing
  // behind it.
  it("never offers a job as ready on a machine that cannot answer", () => {
    let checked = 0;
    for (const world of MACHINES) {
      if (!world.nothingCanAnswer || world.fluxReady) continue;
      checked += 1;
      for (const row of firstRunJobRows(world)) {
        expect(row.press, `${JSON.stringify(world)} ${row.id}`).toBe("connect");
        expect(row.tag.text, `${JSON.stringify(world)} ${row.id}`).not.toBe(FIRST_RUN_COPY.chat.jobs.tags.ready);
      }
    }
    // The signed-out row of the sweep really is in here, not filtered away.
    expect(MACHINES.some((world) => !world.nothingToThinkWith && world.nothingCanAnswer)).toBe(true);
    expect(checked).toBeGreaterThan(0);
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
            // `unread` is the sentence that says which connected account this
            // screen did NOT read. Somebody who has just handed over Gmail and
            // Calendar for this job will otherwise assume the screen under it
            // came out of them, which is the promise the brief used to make.
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

  // THE ONE JOB WHOSE ANSWER IS NOT ON THIS CARD, SO A SEND THAT NEVER LANDED
  // IS THE ONE THING THE PERSON CANNOT CHECK FOR THEMSELVES.
  //
  // This screen used to take no failure at all, so the card's own `setFailure`
  // had nowhere to appear: a refused send drew the quiet return button and
  // said nothing, under three lines that had already said "Ready."
  it("says so on the research result when the question did not go through", () => {
    const refusal = "That did not go through. Try it again whenever you are ready.";
    for (const world of MACHINES) {
      const result = researchResult(world);
      const markup = screenOf(
        createElement(FirstRunResearchResultView, { result, failure: refusal, onAgain: noop }),
        "research refused",
      );
      expect(markup, JSON.stringify(world)).toContain(asHtml(refusal));
      expect(markup, "no way off the refused research screen").toMatch(/<button/);
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
    fluxReady: true, nothingToThinkWith: false, nothingCanAnswer: false, connected: [], appsUnreadable: false, search: "anonymous",
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
//
// THE OTHER AUDIT REACHED THE SAME ROAD FROM THE OTHER END, with
// `finishFirstRunJob`, which refuses to settle anything until the send has
// been heard back from. The two meet here: `finishFirstRunJob`'s settle step
// IS `firstRunReachResult`, so a research question the server refused never
// arrives at either of the assertions below. That half is executed in
// first-run-flow.test.ts, which can make a send fail; this half is about the
// roads.
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
          // THE PATH THAT NEVER SETTLED. Nothing that can answer and no key:
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
      fluxReady: false, nothingToThinkWith: true, nothingCanAnswer: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.notes, blank)).toBe("connect");
    expect(escapeHatchScreen(blank).kind).toBe("notes");
  });

  it("keeps what they wrote and starts nothing, on the machine with nothing", () => {
    const blank: FirstRunJobWorld = {
      fluxReady: false, nothingToThinkWith: true, nothingCanAnswer: true, connected: [], appsUnreadable: false, search: "anonymous",
    };
    expect(typedMayShowWorking(blank)).toBe(false);
    expect(said(typedReply(blank))).toBe(true);
  });
});

/**
 * A PIN MUST NOT OUTLIVE THE STATE IT WAS PINNED AGAINST.
 *
 * The card derived its stage as `moved ?? (...)`, so once `moved` was pinned
 * to "connect" it beat the live state for ever. Connect one of a job's two
 * accounts, have polling then discover the other was completed somewhere
 * else, and the pinned "connect" still won, `firstRunConnectScreen` returned
 * null because nothing was missing, and the card rendered its generic lead
 * and nothing else: no advance, no input, no control.
 *
 * The property asserted here is the strong one, and it is asserted by walking
 * every job across every machine with every pin the card can hold: what comes
 * back can ALWAYS be drawn.
 */
const PINS: readonly (import("./first-run-flow").FirstRunFlowStage | null)[] = [
  null, "connect", "input", "working", "result",
];

describe("the stage the card lands on can always be drawn", () => {
  it("never returns a stage whose screen would be null, on any machine", () => {
    for (const world of MACHINES) {
      for (const id of FIRST_RUN_JOB_IDS) {
        const job = FIRST_RUN_JOB_SHAPES[id];
        for (const escaped of [false, true]) {
          for (const moved of PINS) {
            const label = `${id} pinned ${moved} escaped=${escaped} on ${JSON.stringify(world)}`;
            const stage = firstRunStage(job, world, moved, escaped);
            expect(stage, label).not.toBeNull();
            if (stage === "connect") {
              expect(firstRunConnectScreen(job, world), label).not.toBeNull();
            }
            if (stage === "input" && !escaped) {
              expect(firstRunInputScreen(job, world), label).not.toBeNull();
            }
          }
        }
      }
    }
  });

  // THE EXACT WALK THE AUDIT DESCRIBED. Two accounts wanted, one connected
  // here, the second discovered by a poll as already done elsewhere.
  it("lets go of a connect pin the moment the machine says there is nothing to connect", () => {
    const job = FIRST_RUN_JOB_SHAPES.brief;
    const keyed = { fluxReady: true, nothingToThinkWith: false, nothingCanAnswer: false, appsUnreadable: false, search: "anonymous" } as const;
    const halfway: FirstRunJobWorld = { ...keyed, connected: ["gmail"] };
    const both: FirstRunJobWorld = { ...keyed, connected: [...SETUP_JOB_APPS] };

    // Pinned while it is still true.
    expect(firstRunStage(job, halfway, "connect", false)).toBe("connect");
    expect(firstRunConnectScreen(job, halfway)).not.toBeNull();

    // The poll lands and the pin is gone, which is what `afterConnect` would
    // have said had it been asked a second time.
    expect(firstRunStage(job, both, "connect", false)).toBe(afterConnect(job, both));
    expect(firstRunStage(job, both, "connect", false)).not.toBe("connect");
  });

  it("keeps the pins that are about the person rather than the machine", () => {
    const job = FIRST_RUN_JOB_SHAPES.brief;
    const both: FirstRunJobWorld = {
      fluxReady: true, nothingToThinkWith: false, nothingCanAnswer: false,
      connected: [...SETUP_JOB_APPS], appsUnreadable: false, search: "anonymous",
    };
    // They typed and it is working, or they have their answer. A poll landing
    // underneath must not drag them back to the box.
    for (const moved of ["input", "working", "result"] as const) {
      expect(firstRunStage(job, both, moved, false), moved).toBe(moved);
    }
  });

  it("holds nothing at all until the job and the machine are both known", () => {
    const world = MACHINES[0];
    expect(firstRunStage(null, world, null, false)).toBeNull();
    expect(firstRunStage(FIRST_RUN_JOB_SHAPES.notes, null, null, false)).toBeNull();
    expect(firstRunStage(null, null, "input", false)).toBe("input");
  });

  it("gives the screen that could not be drawn words and a way off it", async () => {
    const { FirstRunLostView } = await import("@/components/FirstRunJobsCard");
    const markup = screenOf(createElement(FirstRunLostView, { onAgain: noop }), "lost");
    expect(markup, "no way off the screen that could not be drawn").toMatch(/<button/);
    expect(markup).toContain(asHtml(FIRST_RUN_COPY.flow["do-it"].lost));
    expect(markup).toContain(asHtml(FIRST_RUN_COPY.flow["do-it"].again));
  });
});

/**
 * THE TWO FACTS ABOUT THE CARD THAT THIS SUITE CANNOT EXECUTE.
 *
 * Everything above runs the real rules and renders the real screens. `finish`
 * cannot be run here: it fires from a timer inside a mounted component and
 * this suite has no DOM to mount one in. So the wiring is READ, off the
 * source with every comment stripped out first, because the thing that was
 * wrong before was a comment promising an ordinary send over a line that
 * awaited nothing.
 *
 * The rule those reads enforce is proved by execution in
 * first-run-flow.test.ts ("settling step five follows the work"). These only
 * assert that the card is the caller.
 */
const cardSource = (await import("node:fs")).readFileSync(
  new URL("../components/FirstRunJobsCard.tsx", import.meta.url),
  "utf8",
);
/** Block comments, then line comments. The house writes long prose above
 *  every decision in that file and none of it is wiring. */
const code = cardSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the do-it card settles through the rule rather than around it", () => {
  it("derives its stage through the rule rather than pinning moved for ever", () => {
    expect(code, "the card stopped deriving its stage through the rule").toMatch(/firstRunStage\(job, world, moved,/);
    expect(code, "the eternal pin is back").not.toMatch(/moved\s*\n?\s*\?\?\s*\(job/);
  });

  it("draws a screen when a builder returns null, never a lead on its own", () => {
    // Both null branches used to be blanks: one rendered the generic connect
    // lead with no control under it, the other returned null outright.
    const nulls = [...code.matchAll(/if \(!screen\) return ([^;]+);/g)].map((match) => match[1]);
    expect(nulls.length, "the null branches went missing").toBe(2);
    for (const drawn of nulls) expect(drawn, "a screen builder's null still draws a blank").toContain("FirstRunLostView");
  });

  it("runs the finish through finishFirstRunJob", () => {
    expect(code, "the card no longer settles through the rule").toMatch(/await finishFirstRunJob\(/);
  });

  it("never dispatches a send it cannot hear back from", () => {
    const sends = code.match(/type:\s*"send"/g) ?? [];
    const heard = code.match(/onSent:/g) ?? [];
    expect(sends.length, "the card stopped sending anything").toBeGreaterThan(0);
    expect(heard.length, "a send on this card with no confirmation behind it").toBe(sends.length);
  });

  it("records the step in one place, and reaches that place only through the settle step", () => {
    // TWO AUDITS, ONE ROAD. One of them required that the step is settled
    // only AFTER the work has been heard back from, which is `settle:` on
    // `finishFirstRunJob`. The other required that every road into the result
    // settles the step at all, which is `firstRunReachResult`, because the
    // "keep what you typed" path never reaches `finish` and used to leave the
    // last step of the first run outstanding for ever.
    //
    // Composing them rather than choosing between them means the recording
    // lives in exactly one expression, `answerFlow`, and the only two things
    // that are ever handed it are the two road functions. Asserting on the
    // braces of an inlined settle step would have forced the recording to be
    // written out twice, once per road, which is the thing this checks for.
    const at = [...code.matchAll(/answerSetupStep\("flow"/g)].map((match) => match.index ?? 0);
    expect(at.length, "the flow step is recorded from more than one place").toBe(1);
    expect(code, "the one recording site stopped being the one both roads are handed")
      .toMatch(/const answerFlow = \(\w+: FirstRunJobId\) => answerSetupStep\("flow", \w+\);/);

    // The settle step reaches the result through the same road the box does.
    expect(code, "the settle step stopped going through the one road").toMatch(/settle:\s*\(\)\s*=>\s*firstRunReachResult\(/);

    // AND NOTHING ELSE MAY PUT SOMEBODY ON A RESULT SCREEN. A bare
    // `setStage("result")` is a result nothing answered for, which is exactly
    // the defect on the path that skips the working screen.
    expect(code.match(/setStage\("result"\)/g), "a result screen reached without settling the step").toBeNull();

    // Both roads take the recording as an argument rather than reaching for
    // it, so this suite can run them; the ones above do.
    for (const road of [/firstRunReachResult\(id, goTo, answerFlow\)/, /firstRunGo\(world, id, goTo, answerFlow\)/]) {
      expect(code, `${road} is no longer how the card reaches a result`).toMatch(road);
    }
  });
});
