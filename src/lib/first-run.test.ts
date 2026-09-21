// THE BUG THIS FILE EXISTS TO PREVENT.
//
// A restored workspace opening into a welcome screen. It is the worst thing
// this flow can do to somebody: they have just moved machines, or recovered
// from a dead disk, and the first thing the app says is "hello, who are
// you?" while their whole working life is sitting behind it.
//
// The old shape had three surfaces each deciding for itself whether this
// install was new, two of them from localStorage, which is empty on a fresh
// browser however long the person has been a customer. There is one decision
// now, it is the server's, and these tests drive it from the wire: a view
// with `firstRun: false` must produce nothing, on every path in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  FIRST_RUN_PHASES,
  closeFirstRun,
  firstRunActive,
  firstRunPhaseRows,
  firstRunPhasesVisible,
  openFirstRun,
  readFirstRunPhases,
  resetFirstRunPhases,
  forgetFirstRunStarted,
} from "./first-run";
import { SETUP_STEPS, type SetupStep, type SetupStepStatus, type SetupView } from "../../shared/setup";

const source = readFileSync(fileURLToPath(new URL("./first-run.ts", import.meta.url)), "utf8");
/** The module with its prose removed. The comments in this file name the
 *  things it deliberately does NOT do, so a scan for those names has to read
 *  the code rather than the explanation of the code. */
const code = source
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

/** A setup view as `GET /api/setup` really answers it. Steps default to open
 *  so a test only has to say the part it is about. */
function view(over: Partial<SetupView> = {}, statuses: Partial<Record<SetupStep, SetupStepStatus>> = {}): SetupView {
  const steps = SETUP_STEPS.map((id) => {
    const status = statuses[id] ?? "open";
    return {
      id,
      done: status === "done",
      ...(status === "skipped" ? { skipped: true } : {}),
      status,
      ...(status === "blocked" ? { block: { reason: "flux-key-needed" as const, message: "A key is needed first." } } : {}),
    };
  });
  const done = steps.filter((step) => step.done).length;
  return {
    version: 3,
    startedAt: 1,
    chiefBotId: "chief",
    ownerName: "",
    engine: { ready: true },
    agents: [{ id: "fuigo", name: "Fuigo", installed: false }],
    signedOutAgents: [],
    routines: { total: 0, briefId: null, briefRan: false },
    crewSize: 0,
    fluxReady: false,
    nothingToThinkWith: false,
    nothingCanAnswer: false,
    connectedJobApps: [],
    firstRun: true,
    progress: { done, total: steps.length },
    blocked: steps.filter((step) => step.status === "blocked").map((step) => step.id),
    // What `nextSetupStep` really answers: the first step that is neither
    // done nor passed over. A blocked step is still the one you are on.
    next: steps.find((step) => !step.done && step.status !== "skipped")?.id ?? null,
    steps,
    ...over,
  };
}

/** What a restored backup looks like on the wire: the server has already
 *  seen the answered turns, the saved key, the connected apps and the
 *  routines, and has said so in one field. */
const RESTORED = () =>
  view(
    { firstRun: false, ownerName: "Sean", fluxReady: true, crewSize: 4, routines: { total: 3, briefId: "r1", briefRan: true } },
    { hello: "done", detect: "done", flux: "done", chat: "done", flow: "done" },
  );

beforeEach(() => {
  resetFirstRunPhases();
});

describe("a restored or established install never sees the first run", () => {
  it("shows nothing when the server says this is not a first run", () => {
    expect(firstRunActive(RESTORED())).toBe(false);
    expect(firstRunPhasesVisible(RESTORED(), readFirstRunPhases())).toBe(false);
  });

  it("stays away even on a half-finished workspace that has clearly been used", () => {
    // The dangerous middle: some steps outstanding, but the server has seen
    // a name, a key and a crew. Counting unfinished steps would call this a
    // first run. The server's answer does not.
    const used = view({ firstRun: false, ownerName: "Sean", crewSize: 2 }, { hello: "done", detect: "done" });
    expect(firstRunPhasesVisible(used, readFirstRunPhases())).toBe(false);
  });

  it("shows nothing before the server has answered at all", () => {
    // Not asked yet is not a yes. A frame of the welcome list while the
    // first read is in flight is the same bug in a smaller window.
    expect(firstRunPhasesVisible(null, readFirstRunPhases())).toBe(false);
    expect(firstRunPhasesVisible(undefined, readFirstRunPhases())).toBe(false);
    expect(firstRunActive(null)).toBe(false);
  });

  it("has no second opinion to be wrong with", () => {
    // No storage, no counting of finished steps, no locally derived
    // "untouched". `view.firstRun` and nothing else.
    expect(code).not.toMatch(/localStorage|sessionStorage/);
    expect(code).toContain("view?.firstRun === true");
    // SCOPED TO THE DECISION, because the rest of the module now legitimately
    // walks `view.steps` to draw pills. The rule was never "never touch the
    // steps"; it is that the answer to "is this a first run, and is it still
    // going" is the server's and is not recomputed here from what the list
    // looks like. So the ban applies to exactly the two functions that answer
    // it, and drawing a pill per step is not one of them.
    const decision = code.slice(code.indexOf("export function firstRunActive"), code.indexOf("export function forgetFirstRunStarted"));
    expect(decision.length).toBeGreaterThan(200);
    expect(decision).not.toMatch(/progress\.done|steps\.every|steps\.filter|steps\.length/);
  });
});

describe("a genuinely fresh install does see it", () => {
  it("offers the rail unasked", () => {
    expect(firstRunActive(view())).toBe(true);
    expect(firstRunPhasesVisible(view(), readFirstRunPhases())).toBe(true);
  });

  it("goes away when they close it, and does not come back by itself", () => {
    closeFirstRun();
    expect(readFirstRunPhases().closed).toBe(true);
    expect(firstRunPhasesVisible(view(), readFirstRunPhases())).toBe(false);
  });
});

describe("/setup and the Settings row reach it on any install", () => {
  it("opens on a workspace the server calls established", () => {
    openFirstRun();
    expect(firstRunPhasesVisible(RESTORED(), readFirstRunPhases())).toBe(true);
  });

  it("reopens one that was closed", () => {
    closeFirstRun();
    openFirstRun();
    expect(readFirstRunPhases().closed).toBe(false);
    expect(firstRunPhasesVisible(view(), readFirstRunPhases())).toBe(true);
  });

  it("counts every ask, so a second one is a second trip to the Chief", () => {
    openFirstRun();
    openFirstRun();
    expect(readFirstRunPhases().requests).toBe(2);
  });

  it("still shows nothing when the server has not answered", () => {
    openFirstRun();
    expect(firstRunPhasesVisible(null, readFirstRunPhases())).toBe(false);
  });
});

describe("the pills are the server's list", () => {
  it("renders one pill per step the view carries, in the view's order", () => {
    const rows = firstRunPhaseRows(view());
    expect(rows.map((row) => row.id)).toEqual([...SETUP_STEPS]);
    expect(rows.every((row) => row.label.length > 0)).toBe(true);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
  });

  // THE NUMBERS ARE COMPUTED, WHICH IS WHY THEY ARE WORTH A TEST.
  //
  // A machine with nothing to think with is never shown "what is here": the
  // server settles that step before presenting it, and the approved flow
  // drops the phase rather than showing a crossed-off report that was never
  // written. Everything after it moves up one.
  it("drops the phase a blank machine never sees, and renumbers the rest", () => {
    const blank = view({ nothingToThinkWith: true, next: "flux" }, { detect: "done" });
    const rows = firstRunPhaseRows(blank);
    expect(rows.map((row) => row.id)).toEqual(["hello", "flux", "chat", "flow"]);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.label)).toEqual([
      "1 · who you are",
      "2 · switch it on",
      "3 · first chat",
      "4 · do the thing",
    ]);
  });

  it("keeps it when the server says that phase is still open", () => {
    // `nothingToThinkWith` and an unsettled `detect` contradict each other.
    // Drawing the step the person is on is the honest answer to that; hiding
    // what they are being asked to do is not.
    const rows = firstRunPhaseRows(view({ nothingToThinkWith: true, next: "detect" }));
    expect(rows.map((row) => row.id)).toEqual([...SETUP_STEPS]);
    expect(rows.find((row) => row.id === "detect")?.mark).toBe("now");
  });

  it("marks done, passed over, waiting and the one they are on", () => {
    const rows = firstRunPhaseRows(view({}, { hello: "done", detect: "skipped", flux: "blocked" }));
    const mark = Object.fromEntries(rows.map((row) => [row.id, row.mark]));
    expect(mark.hello).toBe("done");
    expect(mark.detect).toBe("skipped");
    expect(mark.flux).toBe("blocked");
    // `next` is the first step that is neither done nor passed over, and the
    // server works it out. Here that is flux, which is blocked, so the first
    // plain open row is chat and it is not "now".
    expect(mark.chat).toBe("todo");
    expect(mark.flow).toBe("todo");
    const fresh = firstRunPhaseRows(view());
    expect(fresh.find((row) => row.id === "hello")?.mark).toBe("now");
  });

  it("draws a pill for a step it has never heard of rather than dropping it", () => {
    // A newer server sending a sixth step must not make a step quietly
    // disappear from the list of what is left to do.
    const known = view();
    const extended = {
      ...known,
      steps: [...known.steps, { id: "somethingnew" as SetupStep, done: false, status: "open" as SetupStepStatus }],
    };
    const rows = firstRunPhaseRows(extended);
    expect(rows).toHaveLength(known.steps.length + 1);
    expect(rows[rows.length - 1].name).toBe("somethingnew");
    expect(rows[rows.length - 1].label).toBe("6 · somethingnew");
  });
});

describe("what the phase bar says", () => {
  const strings = [
    FIRST_RUN_PHASES.title,
    FIRST_RUN_PHASES.close,
    FIRST_RUN_PHASES.footer,
    ...Object.values(FIRST_RUN_PHASES.state),
    ...firstRunPhaseRows(view()).map((row) => row.label),
  ];

  it("promises in so many words that closing it stops nothing", () => {
    expect(FIRST_RUN_PHASES.footer).toContain("Close this whenever you like");
    expect(FIRST_RUN_PHASES.footer).toContain("stops you using Murage");
  });

  it("keeps every copy rule the first run is held to", () => {
    for (const line of strings) {
      expect(line, line).not.toMatch(/[—–]/);
      expect(line.toLowerCase(), line).not.toMatch(/composio/);
      expect(line.toLowerCase(), line).not.toMatch(/cheap|discount|wholesale|afford|save money|budget|\$|token/);
      expect(line.toLowerCase(), line).not.toMatch(/lesson|exercise|quiz|assignment|homework/);
      // Never a model count, and no count of anything but steps.
      expect(line, line).not.toMatch(/\d+\+\s*models|\d+\s*models/i);
    }
  });

  it("counts steps and nothing else", () => {
    // The only number in this flow is a phase number. The rail printed
    // "2 of 5 done" beside its rows; the bar does not, because a pill already
    // carries its position and the two could disagree the moment a phase is
    // dropped. Whatever numbers a pill does carry must be its own position
    // and nothing else: no prices, no model counts, no minutes.
    for (const row of firstRunPhaseRows(view())) {
      expect(row.label.match(/\d+/g), row.label).toEqual([String(row.number)]);
    }
  });

  it("never states a limit where the product has a capability", () => {
    for (const line of strings) {
      expect(line.toLowerCase(), line).not.toMatch(/i can never|cannot send|can't send/);
    }
  });
});

// THE CHECKLIST DISAPPEARED AFTER THE FIRST STEP.
//
// `firstRun` means "this install has never been set up", and one of the
// traces it reads is a saved owner name. The first thing the flow does is ask
// for that name. So the flag goes false at step one, by design, and the rail
// went with it: the person watched a checklist appear, tick one row, and
// vanish for the whole rest of the run. Reported as the sidebar not updating
// and there being no path forward, which is exactly what that looks like.
//
// server/setup-conversation.ts hit the same trap first and documented it in
// `conversationLive`. Starting and continuing are different questions.
describe("how long the checklist stays on screen", () => {
  const open = { closed: false, requests: 0 };
  const view = (over: Record<string, unknown>) =>
    ({ firstRun: false, next: "flux", steps: [], progress: { done: 1, total: 6 } , ...over }) as unknown as SetupView;

  it("appears on an install that has never been set up", () => {
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ firstRun: true }), open)).toBe(true);
  });

  it("stays once the flow has started, even though firstRun goes false", () => {
    forgetFirstRunStarted();
    // Step one: the name is saved, so the server stops calling this a first
    // run. The flow is very much still going.
    expect(firstRunPhasesVisible(view({ firstRun: true }), open)).toBe(true);
    expect(firstRunPhasesVisible(view({ firstRun: false, next: "flux" }), open)).toBe(true);
    expect(firstRunPhasesVisible(view({ firstRun: false, next: "apps" }), open)).toBe(true);
  });

  it("goes when there is nothing left to do", () => {
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ firstRun: true }), open)).toBe(true);
    expect(firstRunPhasesVisible(view({ firstRun: false, next: null }), open)).toBe(false);
  });

  it("never appears on an established install that simply has a step open", () => {
    // Somebody who never set a morning brief has `next` forever. They are not
    // in a first run and must not be handed one.
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ firstRun: false, next: "brief" }), open)).toBe(false);
  });

  it("still obeys a rail closed by hand", () => {
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ firstRun: true }), { closed: true, requests: 0 })).toBe(false);
  });
});

// THE FLOW STOPPED WHEN A STEP FINISHED ON ITS OWN.
//
// Only the setup routes drive the conversation and nothing polled, so the
// flow moved when somebody pressed something and not otherwise. Connected
// apps travel with the Flux Router key, so a person whose key already carries
// Gmail reaches that step with it done and nothing to press. Reported as "it
// stops after everything's connected".
//
// `conversationLive` is the server's own answer, from the welcome card being
// in the thread. It is the only honest test of "started here and still
// going", because `firstRun` goes false at step one by design.
describe("the server's word on whether the flow is still going", () => {
  const open = { closed: false, requests: 0 };
  const view = (over: Record<string, unknown>) =>
    ({ firstRun: false, next: "brief", steps: [], progress: { done: 4, total: 6 } , ...over }) as unknown as SetupView;

  it("keeps the checklist up even when the client never saw firstRun", () => {
    // The app was restarted part way through setup, so the very first read
    // already said firstRun:false. The latch alone would never have fired.
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ conversationLive: true }), open)).toBe(true);
  });

  it("takes it down when the conversation has nothing left to do", () => {
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({ conversationLive: true, next: null }), open)).toBe(false);
  });

  it("does not mistake an old build's view for a live conversation", () => {
    forgetFirstRunStarted();
    expect(firstRunPhasesVisible(view({}), open)).toBe(false);
  });
});
