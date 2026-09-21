import { describe, expect, it } from "vitest";

import { FIRST_RUN_COPY } from "./first-run-copy";
import {
  FIRST_RUN_JOB_IDS,
  FIRST_RUN_JOB_SHAPES,
  afterConnect,
  chiefLead,
  chiefQuestion,
  chiefState,
  chiefStatusLine,
  firstRunConnectScreen,
  firstRunJobRows,
  firstRunJobWorld,
  firstRunSearchRouting,
  jobTag,
  missingForJob,
  researchNote,
  typedMayShowWorking,
  typedOutcome,
  typedReply,
  type FirstRunJobWorld,
  type FirstRunSearchRouting,
} from "./first-run-jobs";
import { SETUP_JOB_APPS, type SetupJobApp } from "../../shared/setup";

/**
 * These tests RUN the job logic. Nothing here reads the source of anything.
 *
 * The machines are stated as the four facts a job actually consults, and
 * every assertion is about what the person would see on the screen for that
 * machine. The one that matters most is the blank machine, because the rule
 * there is the opposite of the obvious one: `notes` and `business` need
 * nothing on an ordinary computer and need Flux on that one.
 */
/** One runnable engine, as `/api/setup` reports one. */
const ENGINE = { id: "codex", name: "Codex", installed: true };

function machine(over: Partial<FirstRunJobWorld> = {}): FirstRunJobWorld {
  const world: FirstRunJobWorld = {
    fluxReady: false,
    nothingToThinkWith: false,
    nothingRunnable: false,
    connected: [],
    appsUnreadable: false,
    search: "anonymous",
    ...over,
  };
  // A machine with nothing to think with has nothing runnable on it by
  // definition. The reverse does NOT hold, and that gap is the signed-out
  // machine: an engine is here, nobody is signed in to it, so it is not
  // blank and nothing on it will answer.
  return world.nothingToThinkWith ? { ...world, nothingRunnable: true } : world;
}

/** A computer with an engine on it, a key, and both accounts connected:
 *  everything is ready and nothing is asked for. */
const READY = machine({ fluxReady: true, connected: [...SETUP_JOB_APPS] });

/** Murage just installed on a computer with nothing else. No engine that can
 *  answer, no key. This is the machine the release exists for. */
const BLANK = machine({ nothingToThinkWith: true });

describe("the five jobs the Chief offers", () => {
  it("offers exactly five, in the approved order, with words for each", () => {
    expect(FIRST_RUN_COPY.chat.jobs.rows.map((row) => row.id)).toEqual([...FIRST_RUN_JOB_IDS]);
    for (const row of FIRST_RUN_COPY.chat.jobs.rows) {
      expect(FIRST_RUN_JOB_SHAPES[row.id].id, `${row.id} shape is mislabelled`).toBe(row.id);
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.sub.length).toBeGreaterThan(0);
    }
  });

  it("only ever asks for an app the first run can actually connect", () => {
    // Slack has a row written for it in the specification and is deliberately
    // not offered in 0.1.58. A job that needed it would produce a connect row
    // with no way to act on it.
    for (const id of FIRST_RUN_JOB_IDS) {
      for (const app of FIRST_RUN_JOB_SHAPES[id].needs) {
        expect(SETUP_JOB_APPS, `${id} needs ${app}`).toContain(app);
      }
    }
  });

  it("leads with the morning brief and marks only that row as led", () => {
    const rows = firstRunJobRows(READY);
    expect(rows[0].id).toBe("brief");
    expect(rows.filter((row) => row.lead)).toHaveLength(1);
  });
});

describe("what a job still needs, on a real machine", () => {
  it("asks for nothing when the key and both accounts are there", () => {
    for (const row of firstRunJobRows(READY)) {
      expect(row.missing, row.id).toEqual([]);
      expect(row.tag.text, row.id).toBe("ready now");
      expect(row.tag.tone, row.id).toBe("ready");
    }
  });

  it("names the one account a brief is short of, rather than counting it", () => {
    const world = machine({ fluxReady: true, connected: ["gmail"] });
    const brief = firstRunJobRows(world).find((row) => row.id === "brief")!;
    expect(brief.missing).toEqual(["googlecalendar"]);
    expect(brief.tag.text).toBe("connect Google Calendar");
    expect(brief.tag.tone).toBe("accent");
  });

  it("counts when there is more than one, because two names is a paragraph", () => {
    const world = machine({ fluxReady: true });
    const brief = firstRunJobRows(world).find((row) => row.id === "brief")!;
    expect(brief.missing).toEqual(["googlecalendar", "gmail"]);
    expect(brief.tag.text).toBe("2 to connect");
    expect(brief.tag.tone).toBe("neutral");
  });

  it("puts Flux at the front of the list, never behind an account", () => {
    // Connecting an account without a key produces a row that cannot be acted
    // on: shared/setup.ts hard-blocks it. So the key is asked for first.
    const brief = firstRunJobRows(machine())[0];
    expect(brief.id).toBe("brief");
    expect(brief.missing[0]).toBe("flux");
    expect(brief.missing).toEqual(["flux", "googlecalendar", "gmail"]);
  });

  it("says the key by name when it is the only thing wanting", () => {
    const day = firstRunJobRows(machine({ connected: ["googlecalendar"] })).find((row) => row.id === "day")!;
    expect(day.missing).toEqual(["flux"]);
    expect(day.tag.text).toBe("needs Flux Router");
  });

  it("leaves the three account-free jobs ready on a computer with an engine and no key", () => {
    const world = machine();
    const rows = firstRunJobRows(world);
    for (const id of ["notes", "research", "business"] as const) {
      const row = rows.find((candidate) => candidate.id === id)!;
      expect(row.missing, id).toEqual([]);
      expect(row.tag.text, id).toBe("ready now");
    }
  });

  // THE RULE THAT IS THE OPPOSITE OF THE OBVIOUS ONE.
  it("needs Flux for EVERY job on a machine with nothing to think with", () => {
    for (const row of firstRunJobRows(BLANK)) {
      expect(row.missing[0], row.id).toBe("flux");
      expect(row.tag.text, row.id).not.toBe("ready now");
    }
    // Including the two that ask for no account at all, which is the whole
    // point: there is no engine behind them, so "ready now" would be a
    // promise the machine cannot keep.
    const rows = firstRunJobRows(BLANK);
    expect(rows.find((row) => row.id === "notes")!.tag.text).toBe("needs Flux Router");
    expect(rows.find((row) => row.id === "business")!.tag.text).toBe("needs Flux Router");
  });

  it("drops the blank-machine rule the moment a key is saved", () => {
    const rows = firstRunJobRows(machine({ nothingToThinkWith: true, fluxReady: true }));
    expect(rows.find((row) => row.id === "notes")!.missing).toEqual([]);
    expect(rows.find((row) => row.id === "brief")!.missing).toEqual(["googlecalendar", "gmail"]);
  });

  it("treats an unreadable connector store as not connected, never as connected", () => {
    // Claiming a connection nobody can see fails on the person's first real
    // job. Conservative here; the screen says which of the two it is.
    const world = firstRunJobWorld(
      { fluxReady: true, nothingToThinkWith: false, connectedJobApps: null, agents: [ENGINE] },
      "anonymous",
    );
    expect(world.appsUnreadable).toBe(true);
    expect(missingForJob(FIRST_RUN_JOB_SHAPES.day, world)).toEqual(["googlecalendar"]);
  });

  it("reads a real view without re-deriving anything from it", () => {
    const world = firstRunJobWorld(
      { fluxReady: true, nothingToThinkWith: false, connectedJobApps: ["gmail"], agents: [ENGINE] },
      "anonymous",
    );
    expect(world).toEqual({
      fluxReady: true,
      nothingToThinkWith: false,
      nothingRunnable: false,
      connected: ["gmail"],
      appsUnreadable: false,
      search: "anonymous",
    });
  });
});

describe("where pressing a job goes", () => {
  it("goes to connect when anything is missing, whatever it is", () => {
    expect(firstRunJobRows(machine())[0].press).toBe("connect");
    expect(firstRunJobRows(BLANK).find((row) => row.id === "notes")!.press).toBe("connect");
  });

  it("goes straight to the box when nothing is missing", () => {
    expect(firstRunJobRows(READY).find((row) => row.id === "notes")!.press).toBe("input");
    expect(firstRunJobRows(READY).find((row) => row.id === "brief")!.press).toBe("input");
  });

  it("goes straight to the work for the one job with nothing to type", () => {
    expect(FIRST_RUN_JOB_SHAPES.business.input).toBeNull();
    expect(firstRunJobRows(READY).find((row) => row.id === "business")!.press).toBe("working");
  });
});

describe("per-job connect", () => {
  it("asks for nothing at all when there is nothing to ask for", () => {
    expect(firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.notes, READY)).toBeNull();
  });

  it("heads one missing thing as one thing, and says why it wants it", () => {
    const screen = firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.day, machine({ fluxReady: true }))!;
    expect(screen.heading).toBe("One thing, and then I can do it.");
    expect(screen.rows).toHaveLength(1);
    expect(screen.rows[0]).toEqual({
      need: "googlecalendar",
      bold: "Google Calendar",
      small: "so I know what is already fixed in your day. You sign in on Google's own screen, and take it back there.",
    });
  });

  it("counts them when there are more, and keeps the key first", () => {
    const screen = firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.brief, machine())!;
    expect(screen.heading).toBe("3 things, and then I can do it.");
    expect(screen.rows.map((row) => row.need)).toEqual(["flux", "googlecalendar", "gmail"]);
    expect(screen.rows[0].bold).toBe("Flux Router");
  });

  it("never sends somebody to Google's screen for something that is not Google's", () => {
    // The simulation put "You sign in on Google's own screen" on a Slack row.
    // Every reason that names Google's screen must be about a Google account.
    for (const [need, reason] of Object.entries(FIRST_RUN_COPY.flow["do-it"].connect.reasons)) {
      if (!/Google's own screen/.test(reason)) continue;
      expect(SETUP_JOB_APPS, `${need} claims Google signs it in`).toContain(need as SetupJobApp);
      expect(need === "gmail" || need === "googlecalendar", `${need} is not a Google account`).toBe(true);
    }
  });

  it("offers the typing escape only to a job that has something to type", () => {
    expect(firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.day, machine())!.skipToInput)
      .toBe("Skip that and let me type it in instead");
    expect(firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.business, BLANK)!.skipToInput).toBeNull();
  });

  it("carries the unreadable-store fact onto the screen rather than into a tag", () => {
    const world = machine({ fluxReady: true, appsUnreadable: true });
    expect(firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.day, world)!.appsUnreadable).toBe(true);
    expect(jobTag(missingForJob(FIRST_RUN_JOB_SHAPES.day, world)).text).toBe("connect Google Calendar");
  });

  it("advances by itself only once the last thing is connected", () => {
    const halfway = machine({ fluxReady: true, connected: ["gmail"] });
    expect(afterConnect(FIRST_RUN_JOB_SHAPES.brief, halfway)).toBe("connect");
    expect(afterConnect(FIRST_RUN_JOB_SHAPES.brief, READY)).toBe("input");
    expect(afterConnect(FIRST_RUN_JOB_SHAPES.business, READY)).toBe("working");
  });
});

/**
 * DOES "LOOK INTO SOMETHING FOR ME" RUN ON A FIRST RUN, AND WHOSE ACCOUNT
 * DOES IT USE.
 *
 * Answered against the route rather than guessed. `/api/internal/web-search`
 * reads `cfg.webSearch?.provider ?? "engine"`, and `engine` and `auto` both
 * call `searchFreeWeb`, which is anonymous and takes no API key. So on an
 * unconfigured machine, which is every first run, the job runs and uses
 * nothing of the person's. The other three states only happen because
 * somebody chose them, and the job says so rather than searching quietly.
 */
describe("the research job and whose account it searches on", () => {
  const cases: Array<[string, Parameters<typeof firstRunSearchRouting>[0], FirstRunSearchRouting]> = [
    ["a machine nobody has configured", null, "anonymous"],
    ["a config with no web search block", {}, "anonymous"],
    ["the shipped default", { provider: "engine" }, "anonymous"],
    ["auto, which is the same backend", { provider: "auto" }, "anonymous"],
    ["a chosen provider with its key", { provider: "tavily", tavilyConfigured: true }, "own-account"],
    ["exa with its key", { provider: "exa", exaConfigured: true }, "own-account"],
    ["firecrawl with its key", { provider: "firecrawl", firecrawlConfigured: true }, "own-account"],
    ["a chosen provider with no key on this computer", { provider: "tavily" }, "unconfigured"],
    ["exa chosen, firecrawl configured", { provider: "exa", firecrawlConfigured: true }, "unconfigured"],
    ["switched off deliberately", { provider: "off" }, "off"],
  ];

  for (const [name, config, expected] of cases) {
    it(`reads ${name} as ${expected}`, () => {
      expect(firstRunSearchRouting(config)).toBe(expected);
    });
  }

  it("says nothing on the ordinary machine, because nothing is wrong there", () => {
    expect(researchNote("anonymous")).toBeNull();
    const row = firstRunJobRows(READY).find((job) => job.id === "research")!;
    expect(row.note).toBeNull();
    expect(row.tag.text).toBe("ready now");
  });

  it("names the account whenever the search would go through one of theirs", () => {
    const row = firstRunJobRows(machine({ fluxReady: true, search: "own-account" }))
      .find((job) => job.id === "research")!;
    expect(row.note).toBe("Searching goes out through the search account you connected yourself.");
  });

  it("does not claim a search it cannot make", () => {
    for (const routing of ["unconfigured", "off"] as const) {
      const row = firstRunJobRows(machine({ fluxReady: true, search: routing }))
        .find((job) => job.id === "research")!;
      expect(row.note, routing).not.toBeNull();
      expect(row.note!, routing).toMatch(/what you tell me|what you give me/);
    }
  });

  it("puts the note on the research row and on no other", () => {
    for (const row of firstRunJobRows(machine({ fluxReady: true, search: "off" }))) {
      if (row.id !== "research") expect(row.note, row.id).toBeNull();
    }
  });
});

describe("the status line the Chief opens with", () => {
  it("reports routing when the key is in", () => {
    expect(chiefState(READY)).toBe("connected");
    expect(chiefStatusLine(READY, "qwen3:8b on Ollama"))
      .toBe("Connected. Smart routing on, and your apps are a click away when a job needs them.");
  });

  it("says plainly that nothing can answer yet on a blank machine", () => {
    expect(chiefState(BLANK)).toBe("no-brain");
    expect(chiefStatusLine(BLANK, ""))
      .toBe("Nothing to think with yet, so every job below is waiting on one connection.");
  });

  it("names the real engine rather than a sample one", () => {
    expect(chiefState(machine())).toBe("local");
    expect(chiefStatusLine(machine(), "qwen3:8b on Ollama"))
      .toBe("Running on qwen3:8b on Ollama here on this computer.");
    expect(chiefStatusLine(machine(), "Claude Code"))
      .toBe("Running on Claude Code here on this computer.");
  });

  it("does not leave a gap where a name should be when there is no name", () => {
    expect(chiefStatusLine(machine(), "  ")).toBe("Running on what is already on this computer.");
  });

  /**
   * THE DEFECT: "RUNNING ON WHAT IS ALREADY ON THIS COMPUTER", WITH NOTHING
   * RUNNING.
   *
   * `nothingToThinkWith` is `agents.length === 0 && signedOutAgents.length
   * === 0`, so a machine with Codex installed and nobody signed in answers
   * FALSE and fell straight through to `local`. `engineName` then returned
   * "" because `view.agents` is empty, and the unnamed branch claimed
   * something was running. That is the exact audience the `signed-out`
   * variant exists for.
   */
  it("does not say anything is running on a machine whose engine is signed out", () => {
    const signedOut = machine({ nothingRunnable: true });
    expect(signedOut.nothingToThinkWith, "this is not the blank machine").toBe(false);
    expect(chiefState(signedOut)).toBe("signed-out");
    expect(chiefStatusLine(signedOut, ""))
      .toBe("Nothing on this computer is signed in yet, so every job below is waiting on a sign in or a connection.");
    // Not one of the four openings on that machine may claim it is running.
    expect(chiefStatusLine(signedOut, "")).not.toMatch(/running on/i);
    expect(chiefStatusLine(signedOut, "Codex")).not.toMatch(/running on/i);
    // And the lead under it agrees with it rather than promising the work.
    expect(chiefLead(signedOut)).toBe(chiefLead(BLANK));
    expect(chiefLead(signedOut)).not.toMatch(/I will do it now/);
  });

  it("reads nothing runnable off the engines the view really has", () => {
    expect(firstRunJobWorld({ fluxReady: false, nothingToThinkWith: false, connectedJobApps: [], agents: [] }, "anonymous")
      .nothingRunnable).toBe(true);
    expect(firstRunJobWorld({ fluxReady: false, nothingToThinkWith: false, connectedJobApps: [], agents: [ENGINE] }, "anonymous")
      .nothingRunnable).toBe(false);
  });

  it("asks the question by name, and reads correctly after a skipped hello", () => {
    // Skipping hello stores NOTHING. "there" is a render fallback the card
    // applies on its way in (`firstRunAddress`), which is why that word was
    // chosen: it reads correctly here, and the greeting drops the clause.
    expect(chiefQuestion("Sean")).toBe("What can I take off your plate, Sean?");
    expect(chiefQuestion("there")).toBe("What can I take off your plate, there?");
    expect(chiefQuestion("  Sean  ")).toBe("What can I take off your plate, Sean?");
    expect(chiefQuestion("")).toBe("What can I take off your plate?");
  });

  it("promises to do it now only where it can", () => {
    expect(chiefLead(READY)).toMatch(/I will do it now/);
    expect(chiefLead(BLANK)).toMatch(/before anything happens/);
    expect(chiefLead(BLANK)).not.toMatch(/I will do it now/);
  });
});

/**
 * THE FREE-TEXT BOX ON A MACHINE THAT CANNOT ANSWER.
 *
 * `pickDefaultEngine` returns empty rather than falling back, and Murage
 * never offers to fetch a model, so there is genuinely nothing to ask. The
 * only honest behaviour is to keep what was typed and say so. A spinner here
 * is a wait that never ends.
 */
describe("typing into the box with nothing to think with", () => {
  it("keeps what was typed and starts nothing", () => {
    expect(typedOutcome(BLANK)).toBe("keep");
    expect(typedMayShowWorking(BLANK)).toBe(false);
  });

  it("never says an answer is on its way", () => {
    const reply = typedReply(BLANK)!;
    expect(reply).toBeTruthy();
    expect(reply).not.toMatch(/working on|one moment|thinking|hold on|coming|shortly|any second/i);
    expect(reply).toMatch(/keeping it/);
  });

  it("answers normally the moment there is anything to answer with", () => {
    for (const world of [READY, machine(), machine({ nothingToThinkWith: true, fluxReady: true })]) {
      expect(typedOutcome(world)).toBe("answer");
      expect(typedMayShowWorking(world)).toBe(true);
      expect(typedReply(world)).toBeNull();
    }
  });
});

/**
 * THE HOUSE RULES OVER THE SENTENCES THIS MODULE ASSEMBLES.
 *
 * first-run-copy.test.ts walks every static string under FIRST_RUN_COPY,
 * which covers the pieces. It cannot see a sentence built at render time out
 * of two of them plus an engine name, and those are sentences on screen too.
 * The patterns are the ones that would actually be tripped by anything
 * assembled here; the full set lives with the copy.
 */
describe("the assembled sentences obey the house rules too", () => {
  const assembled = [
    chiefQuestion("Sean"),
    chiefQuestion(""),
    chiefStatusLine(READY, "qwen3:8b on Ollama"),
    chiefStatusLine(BLANK, ""),
    chiefStatusLine(machine(), "Claude Code"),
    chiefLead(READY),
    chiefLead(BLANK),
    ...firstRunJobRows(machine()).flatMap((row) => [row.title, row.sub, row.tag.text, row.note ?? ""]),
    ...firstRunJobRows(READY).map((row) => row.tag.text),
    // `?? ""` rather than `!`: a rule that stops being said is a defect for
    // the test that asserts it is said, not a crash in the one that checks
    // how it is worded.
    ...(["own-account", "unconfigured", "off"] as const).map((routing) => researchNote(routing) ?? ""),
    typedReply(BLANK) ?? "",
    firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.brief, machine())!.heading,
    firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.day, machine({ fluxReady: true }))!.heading,
    ...firstRunConnectScreen(FIRST_RUN_JOB_SHAPES.brief, machine())!.rows.flatMap((row) => [row.bold, row.small]),
  ].filter((text) => text.length > 0);

  it("has sentences to check", () => {
    expect(assembled.length).toBeGreaterThan(20);
  });

  it("never uses an em dash or an en dash", () => {
    for (const text of assembled) {
      expect.soft(text).not.toContain("—");
      expect.soft(text).not.toContain("–");
    }
  });

  it("never names the connected app broker", () => {
    for (const text of assembled) expect.soft(text.toLowerCase()).not.toContain("composio");
  });

  it("never sells on price", () => {
    const banned = /\b(cheap\w*|discount\w*|wholesale|afford\w*|budget\w*|spend\w*|cost\w*|pric\w*|token\w*|free|dollars?|cents?|per month|save money|value for money)\b/i;
    for (const text of assembled) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${hit[0]} in "${text}"` : null).toBeNull();
      expect.soft(text).not.toMatch(/[$£€]\s?\d/);
    }
  });

  it("never describes a capability as a limit", () => {
    const banned = /\b(i can never|i cannot|i can't|i am not allowed|i am unable|never able to)\b/i;
    for (const text of assembled) {
      const hit = banned.exec(text);
      expect.soft(hit ? `${hit[0]} in "${text}"` : null).toBeNull();
    }
  });

  it("never sends the person to Settings on the way through", () => {
    for (const text of assembled) expect.soft(text).not.toMatch(/\bsettings\b/i);
  });
});
