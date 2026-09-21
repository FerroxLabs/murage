import { describe, expect, it } from "vitest";

import { FIRST_RUN_BRIEF_TIME, FIRST_RUN_COPY } from "./first-run-copy";
import {
  FIRST_RUN_ITEM_CAP,
  briefRoutineRequest,
  businessResult,
  dayResult,
  finishFirstRunJob,
  firstRunInputScreen,
  flowStageFor,
  morningOffer,
  notesResult,
  parseLines,
  pickRisk,
  researchResult,
  workingLines,
  type FirstRunCrewReading,
} from "./first-run-flow";
import { FIRST_RUN_JOB_SHAPES, type FirstRunJobWorld } from "./first-run-jobs";
import { SETUP_JOB_APPS } from "../../shared/setup";

/**
 * REAL TYPED INPUT IN, REAL SENTENCES OUT.
 *
 * Nothing here reads the source of anything. Every assertion puts lines a
 * person could plausibly type into the same functions the screen calls and
 * checks the words that come back, because the defects this replaces were
 * all of one kind: a sentence that was true about the sample and false about
 * the person's own day.
 */
function machine(over: Partial<FirstRunJobWorld> = {}): FirstRunJobWorld {
  return {
    fluxReady: false,
    nothingToThinkWith: false,
    connected: [],
    appsUnreadable: false,
    search: "anonymous",
    ...over,
  };
}

const READY = machine({ fluxReady: true, connected: [...SETUP_JOB_APPS] });

/** Rough, lower case, abbreviated: what somebody actually types into a box
 *  that told them rough is fine. */
const A_REAL_DAY = `
9:30 standup
board pack due Thursday
call Rahul back about the lease

buy milk
`;

describe("the box they type into", () => {
  it("opens the right box for each job, and never for the one with none", () => {
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.day, READY)!.kind).toBe("day");
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.brief, READY)!.kind).toBe("day");
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.notes, READY)!.kind).toBe("notes");
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.research, READY)!.kind).toBe("topic");
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.business, READY)).toBeNull();
  });

  it("says the calendar is connected only when it really is", () => {
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.day, READY)!.connectedLine)
      .toBe("Your calendar is connected, so add anything that is not already in it.");
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.day, machine({ fluxReady: true }))!.connectedLine).toBeNull();
    // A brief needs both, so one of two is not "connected".
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.brief, machine({ fluxReady: true, connected: ["gmail"] }))!.connectedLine)
      .toBeNull();
    // A job that reaches for no account never claims one.
    expect(firstRunInputScreen(FIRST_RUN_JOB_SHAPES.notes, READY)!.connectedLine).toBeNull();
  });

  it("keeps the placeholder a placeholder", () => {
    // Text in the box is the person's, always. An earlier version pre-filled
    // the notes box with example text and it was caught in review.
    const screen = firstRunInputScreen(FIRST_RUN_JOB_SHAPES.notes, READY)!;
    expect(screen.placeholder.length).toBeGreaterThan(0);
    expect(screen).not.toHaveProperty("value");
    expect(screen).not.toHaveProperty("prefill");
  });
});

describe("reading the lines they typed", () => {
  it("drops the blanks and keeps their own words untouched", () => {
    const items = parseLines(A_REAL_DAY);
    expect(items.map((item) => item.text)).toEqual([
      "9:30 standup",
      "board pack due Thursday",
      "call Rahul back about the lease",
      "buy milk",
    ]);
  });

  it("finds a time in the shapes people write one", () => {
    for (const line of ["9:30 standup", "09.30 standup", "2pm call", "2 pm call", "11:15am dentist"]) {
      expect(parseLines(line)[0].timed, line).toBe(true);
    }
    for (const line of ["buy milk", "board pack due Thursday", "version 2 of the deck"]) {
      expect(parseLines(line)[0].timed, line).toBe(false);
    }
  });

  it("finds a deadline in a day name or a deadline word", () => {
    for (const line of ["board pack due Thursday", "ship it Friday", "eod", "end of week", "tomorrow"]) {
      expect(parseLines(line)[0].due, line).toBe(true);
    }
    expect(parseLines("buy milk")[0].due).toBe(false);
  });

  it("finds a person waiting behind a verb", () => {
    for (const line of ["call Rahul back", "email the landlord", "chase the invoice", "follow-up with Dee"]) {
      expect(parseLines(line)[0].owed, line).toBe(true);
    }
    expect(parseLines("9:30 standup")[0].owed).toBe(false);
  });

  it("stops at twelve and says so by stopping, not by claiming more", () => {
    const many = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    expect(parseLines(many)).toHaveLength(FIRST_RUN_ITEM_CAP);
    expect(workingLines("day", parseLines(many), "")[0]).toMatch(/^12 things\./);
  });

  it("reads an empty box as nothing rather than as one blank thing", () => {
    expect(parseLines("")).toEqual([]);
    expect(parseLines("   \n\n  ")).toEqual([]);
  });
});

describe("the three lines while it works", () => {
  it("counts what they typed and nothing else", () => {
    const lines = workingLines("day", parseLines(A_REAL_DAY), A_REAL_DAY);
    expect(lines).toEqual([
      "4 things. 1 has a time on it.",
      "1 has a deadline and no slot.",
      "Ready.",
    ]);
  });

  it("says one thing as one thing", () => {
    expect(workingLines("day", parseLines("buy milk"), "buy milk")).toEqual([
      "1 thing. None has a time on it.",
      "None of them carries a deadline I can see.",
      "Ready.",
    ]);
  });

  it("says none rather than zero", () => {
    const lines = workingLines("notes", parseLines("buy milk\nfix the door"), "");
    expect(lines[0]).toBe("2 things. None has a time on it.");
    expect(lines[1]).toBe("None of them carries a deadline I can see.");
  });

  it("shows the research topic back in their own words", () => {
    const typed = "whether we should move our billing to Stripe";
    expect(workingLines("research", [], typed)[0]).toBe(`Reading around "${typed}".`);
  });

  it("does not run a long topic off the line", () => {
    const typed = "x".repeat(200);
    expect(workingLines("research", [], typed)[0]).toBe(`Reading around "${"x".repeat(46)}".`);
  });

  // THE SIMULATION SAID THREE BOTS AND TWO ROUTINES. THE PACKAGE HAS TWO AND
  // ONE. The screen after this one shows the real crew, so a count here that
  // did not match would be caught by the person two seconds later.
  // These three lines are shown while the package installs, and
  // `workingLines` is handed the job and what the person typed, never the
  // crew. It said "Two bots and one review", which is a count made by a
  // function that cannot see what it is counting: right today, wrong the
  // day the package grows. So it names the crew and counts nothing, and the
  // counting happens on the screen after, which does have the reading.
  it("announces the crew without counting one it cannot see", () => {
    expect(workingLines("business", [], "")).toEqual([
      "Picking a shape that fits one person running the whole thing.",
      "Your crew and one review, and no plumbing for you to do.",
      "Ready.",
    ]);
    expect(workingLines("business", [], "").join(" ")).not.toMatch(/\b(?:one|two|three|\d+)\s+bots?\b/i);
    expect(workingLines("business", [], "").join(" ")).not.toMatch(/three bots|two routines/i);
  });
});

describe("the one that will slip", () => {
  it("picks the deadline with no time against it", () => {
    const items = parseLines(A_REAL_DAY);
    expect(pickRisk(items)!.text).toBe("board pack due Thursday");
  });

  it("falls back to somebody waiting when no deadline is loose", () => {
    const items = parseLines("9:30 standup\ncall Rahul back about the lease");
    expect(pickRisk(items)!.text).toBe("call Rahul back about the lease");
  });

  it("never picks something that already has a time", () => {
    const items = parseLines("9:30 call Rahul back\n2pm board pack due Thursday");
    expect(pickRisk(items)).toBeNull();
  });

  // IT SAYS NOTHING IS AT RISK RATHER THAN MANUFACTURE ONE.
  it("returns nothing when nothing is at risk", () => {
    expect(pickRisk(parseLines("9:30 standup\n2pm dentist"))).toBeNull();
    expect(pickRisk([])).toBeNull();
  });
});

describe("the day and the brief result", () => {
  const items = parseLines(A_REAL_DAY);

  it("heads tomorrow for the brief and today for the day", () => {
    expect(dayResult(FIRST_RUN_JOB_SHAPES.brief, items, READY).header).toBe("Tomorrow morning");
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY).header).toBe("Today");
  });

  it("says where it read from, and claims no source it does not have", () => {
    expect(dayResult(FIRST_RUN_JOB_SHAPES.brief, items, READY).provenance)
      .toBe("From your 4 lines, plus your calendar and your mail.");
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, items, machine({ fluxReady: true, connected: ["googlecalendar"] })).provenance)
      .toBe("From your 4 lines, plus your calendar.");
    // Nothing connected: the lines are the whole of it, and it says so.
    expect(dayResult(FIRST_RUN_JOB_SHAPES.brief, items, machine()).provenance)
      .toBe("From your 4 lines.");
    // The day job never reaches for mail, so connected mail is not its source.
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY).provenance)
      .toBe("From your 4 lines, plus your calendar.");
  });

  it("says one line as one line", () => {
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("buy milk"), machine()).provenance)
      .toBe("From your 1 line.");
  });

  it("names the risk in their own words and says why it chose it", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY);
    expect(result.riskEyebrow).toBe("The one that will slip");
    expect(result.risk!.line).toBe("board pack due Thursday");
    expect(result.risk!.reason).toBe("It is the only thing you gave me with a deadline and no time against it.");
    expect(result.risk!.advice).toBe("Put it in the first gap your fixed points leave open.");
    expect(result.calm).toBeNull();
  });

  // THE "ONLY" IN THAT SENTENCE IS A COUNT AND HAS TO BEHAVE LIKE ONE.
  it("stops saying only the moment there is a second one", () => {
    const two = parseLines("board pack due Thursday\nlease signed by Friday");
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, two, machine());
    expect(result.risk!.reason).toBe("It is the first of 2 things you gave me with a deadline and no time against it.");
    expect(result.risk!.reason).not.toMatch(/\bonly\b/);
  });

  it("gives different advice when there is nothing fixed to slot around", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("board pack due Thursday"), machine());
    expect(result.risk!.advice).toBe("Give it a slot before anything else claims one.");
  });

  it("explains the person waiting rather than inventing a deadline for them", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("9:30 standup\ncall Rahul back"), machine());
    expect(result.risk!.reason).toBe("Somebody is waiting on it and it has no time against it, so it loses to everything that has.");
  });

  it("says nothing is at risk rather than manufacturing one", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("9:30 standup\n2pm dentist"), machine());
    expect(result.risk).toBeNull();
    expect(result.riskEyebrow).toBe("Nothing here is at risk");
    expect(result.calm!.body).toBe("Everything you gave me either has a time on it or nobody waiting for it.");
    expect(result.calm!.second).toMatch(/Put a deadline or a person against any line/);
  });

  it("splits the two columns by the same rule the risk used", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY);
    expect(result.fixed.items).toEqual(["9:30 standup"]);
    expect(result.waiting.items).toEqual(["board pack due Thursday", "call Rahul back about the lease"]);
    // "buy milk" carries none of the three and belongs in neither column.
    expect([...result.fixed.items, ...result.waiting.items]).not.toContain("buy milk");
  });

  it("gives an empty column words rather than a gap", () => {
    const result = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("buy milk"), machine());
    expect(result.fixed.items).toEqual([]);
    expect(result.fixed.empty.length).toBeGreaterThan(0);
    expect(result.waiting.items).toEqual([]);
    expect(result.waiting.empty.length).toBeGreaterThan(0);
  });

  it("ends every result with the way back to the Chief", () => {
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY).again).toBe("Take something else off my plate");
    expect(notesResult(items).again).toBe("Take something else off my plate");
    expect(researchResult(READY).again).toBe("Take something else off my plate");
  });
});

/**
 * THE MORNING OFFER, AND THE TWO THINGS IT MUST NOT DO.
 *
 * It must not mail them the brief, because Murage reads their mail and a
 * brief in that inbox is circular. And it must not report a time other than
 * the one it scheduled, which is exactly what the shipped card did.
 */
describe("the offer to do it every morning", () => {
  it("is made on the brief job and on no other", () => {
    const items = parseLines(A_REAL_DAY);
    expect(dayResult(FIRST_RUN_JOB_SHAPES.brief, items, READY).morning).not.toBeNull();
    expect(dayResult(FIRST_RUN_JOB_SHAPES.day, items, READY).morning).toBeNull();
  });

  it("promises the brief in the app and never in their inbox", () => {
    const offer = morningOffer(false);
    expect(offer.body).toContain("It never goes to your inbox");
    expect(offer.body).toContain("waiting here when you open this computer");
    expect(`${offer.heading} ${offer.body} ${offer.button}`).not.toMatch(/\bemail(ed)? (it|you|the brief)\b|send it to your inbox/i);
  });

  it("says back exactly the time it is going to schedule", () => {
    const offer = morningOffer(true);
    const request = briefRoutineRequest();
    expect(request.time).toBe(FIRST_RUN_BRIEF_TIME);
    expect(request.weekdaysOnly).toBe(true);
    expect(request.template).toBe("brief");
    // One value, spoken three times. The shipped card had a picker and a
    // confirmation that disagreed with it.
    expect(offer.button).toBe("7:00 am, weekdays");
    expect(offer.body).toContain("7:00 am");
    expect(offer.taken).toBe("Set. Weekdays at 7:00 am.");
  });

  it("does not claim it is set before it is", () => {
    expect(morningOffer(false).taken).toBeNull();
  });
});

describe("the notes result", () => {
  const items = parseLines("buy milk\ncall Rahul back\n9:30 standup\nboard pack due Thursday");

  it("orders by what has a date, then who is waiting, then the rest", () => {
    expect(notesResult(items).steps.map((step) => step.text)).toEqual([
      "board pack due Thursday",
      "call Rahul back",
      "buy milk",
      "9:30 standup",
    ]);
  });

  it("keeps the order they typed when two rank the same", () => {
    const two = parseLines("call Rahul back\nemail the landlord");
    expect(notesResult(two).steps.map((step) => step.text)).toEqual([
      "call Rahul back",
      "email the landlord",
    ]);
  });

  it("tags each row with the reason it is where it is", () => {
    expect(notesResult(items).steps.map((step) => step.tag)).toEqual([
      "has a date",
      "owed",
      "open",
      "timed",
    ]);
  });

  it("counts the lines it was given", () => {
    expect(notesResult(items).provenance).toBe("From the 4 lines you pasted.");
    expect(notesResult(parseLines("buy milk")).provenance).toBe("From the 1 line you pasted.");
  });

  it("says there was nothing in there rather than showing an empty list", () => {
    const result = notesResult([]);
    expect(result.steps).toEqual([]);
    expect(result.empty).toBeTruthy();
    expect(notesResult(items).empty).toBeNull();
  });

  it("closes by saying that nothing else was in the notes", () => {
    expect(notesResult(items).caveat).toMatch(/Nothing else was in the notes, so nothing else is in the list/);
  });
});

describe("the research result", () => {
  it("says what wrote it when it was the engine on this computer", () => {
    expect(researchResult(machine()).onLocal)
      .toBe("Running on the local model. Flux Router would put a bigger one on this, and it reads faster.");
  });

  it("says nothing extra once the key is in", () => {
    expect(researchResult(READY).onLocal).toBeNull();
  });

  it("never claims a local model on a machine that has none", () => {
    expect(researchResult(machine({ nothingToThinkWith: true })).onLocal).toBeNull();
  });
});

/**
 * THE CREW SCREEN READS THE PACKAGE. Here it is driven with a reading; the
 * reading is checked against the real `starter-solo-business.json` in
 * server/first-run-business-crew.test.ts.
 */
describe("the crew the business job installs", () => {
  const SOLO: FirstRunCrewReading = {
    agents: [
      { key: "business-planner", name: "Business Planner" },
      { key: "draft-partner", name: "Draft Partner" },
    ],
    routine: {
      name: "Weekly business review (suggested)",
      time: "09:00",
      weekdays: [1],
      durationMinutes: 15,
      enabledAfterInstall: false,
    },
  };

  it("names the bots the package names, with what each one is for", () => {
    const result = businessResult(SOLO);
    expect(result.botsEyebrow).toBe("Two bots");
    expect(result.bots).toEqual([
      { name: "Business Planner", role: "priorities, and what finished means" },
      { name: "Draft Partner", role: "writes it, then reviews it" },
    ]);
  });

  it("describes the review from the schedule rather than from memory", () => {
    expect(businessResult(SOLO).reviewLine)
      .toBe("Weekly business review (suggested), Mondays at 9:00 am, 15 minutes. It arrives switched off so nothing starts behind your back.");
    expect(businessResult(SOLO).reviewEyebrow).toBe("One review, paused until you want it");
  });

  it("follows the package if the package changes rather than repeating itself", () => {
    const grown = businessResult({
      agents: [{ key: "business-planner", name: "Planner" }],
      routine: { ...SOLO.routine!, time: "17:30", weekdays: [5], durationMinutes: 30 },
    });
    expect(grown.botsEyebrow).toBe("One bot");
    expect(grown.bots).toEqual([{ name: "Planner", role: "priorities, and what finished means" }]);
    expect(grown.reviewLine).toContain("Fridays at 5:30 pm, 30 minutes.");
  });

  it("offers to switch it on only because it really installed switched off", () => {
    expect(businessResult(SOLO).offer!.label).toBe("Switch the Monday review on");
    const running = businessResult({ ...SOLO, routine: { ...SOLO.routine!, enabledAfterInstall: true } });
    expect(running.offer).toBeNull();
    expect(running.reviewLine).not.toMatch(/switched off/);
  });

  it("says nothing about a review when the package has none", () => {
    const none = businessResult({ agents: SOLO.agents, routine: null });
    expect(none.reviewLine).toBeNull();
    expect(none.reviewEyebrow).toBeNull();
    expect(none.offer).toBeNull();
  });

  it("shows a bot with no written role rather than dropping it", () => {
    const stranger = businessResult({ agents: [{ key: "new-bot", name: "New Bot" }], routine: null });
    expect(stranger.bots).toEqual([{ name: "New Bot", role: null }]);
  });
});

describe("where a chosen job starts", () => {
  it("asks for what is missing first", () => {
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.brief, machine())).toBe("connect");
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.notes, machine({ nothingToThinkWith: true }))).toBe("connect");
  });

  it("opens the box when there is one and nothing is missing", () => {
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.notes, READY)).toBe("input");
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.research, machine())).toBe("input");
  });

  it("goes straight to the work when there is nothing to type", () => {
    expect(flowStageFor(FIRST_RUN_JOB_SHAPES.business, READY)).toBe("working");
  });
});

/**
 * The house rules over the sentences this module assembles. The pieces are
 * walked by first-run-copy.test.ts; these are what a person actually reads.
 */
describe("the assembled result sentences obey the house rules too", () => {
  const items = parseLines(A_REAL_DAY);
  const crew: FirstRunCrewReading = {
    agents: [
      { key: "business-planner", name: "Business Planner" },
      { key: "draft-partner", name: "Draft Partner" },
    ],
    routine: { name: "Weekly business review (suggested)", time: "09:00", weekdays: [1], durationMinutes: 15, enabledAfterInstall: false },
  };
  const brief = dayResult(FIRST_RUN_JOB_SHAPES.brief, items, READY, true);
  const calm = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("9:30 standup"), machine());
  const twoDue = dayResult(FIRST_RUN_JOB_SHAPES.day, parseLines("board pack due Thursday\nlease signed by Friday"), machine());
  const notes = notesResult(items);
  const business = businessResult(crew);

  const assembled = [
    ...workingLines("day", items, ""),
    ...workingLines("notes", parseLines("buy milk"), ""),
    ...workingLines("business", [], ""),
    ...workingLines("research", [], "whether we should move our billing to Stripe"),
    brief.header, brief.provenance, brief.riskEyebrow,
    brief.risk?.reason ?? "", brief.risk?.advice ?? "",
    twoDue.risk?.reason ?? "",
    calm.riskEyebrow, calm.calm?.body ?? "", calm.calm?.second ?? "",
    brief.fixed.heading, brief.fixed.empty, brief.waiting.heading, brief.waiting.empty,
    brief.morning?.heading ?? "", brief.morning?.body ?? "", brief.morning?.button ?? "",
    brief.morning?.taken ?? "", brief.morning?.working ?? "", brief.morning?.failure ?? "",
    notes.header, notes.provenance, notes.eyebrow, notes.caveat,
    notesResult([]).empty ?? "",
    ...notes.steps.map((step) => step.tag),
    researchResult(machine()).onLocal ?? "",
    business.header, business.lead, business.botsEyebrow,
    business.reviewEyebrow ?? "", business.reviewLine ?? "",
    business.offer?.label ?? "", business.offer?.why ?? "", business.offer?.taken ?? "",
    ...business.bots.map((bot) => bot.role ?? ""),
    brief.again,
    ...(["day", "notes", "topic"] as const).flatMap((kind) => {
      const job = kind === "topic" ? FIRST_RUN_JOB_SHAPES.research : kind === "notes" ? FIRST_RUN_JOB_SHAPES.notes : FIRST_RUN_JOB_SHAPES.day;
      const screen = firstRunInputScreen(job, READY)!;
      return [screen.heading, screen.lead, screen.placeholder, screen.go, screen.elsewhere, screen.connectedLine ?? ""];
    }),
  ].filter((text) => text.length > 0);

  it("has sentences to check", () => {
    expect(assembled.length).toBeGreaterThan(40);
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

  it("never says a time in 24 hour clock", () => {
    // 9:00 and 21:00 are different days for the person reading it. The house
    // formatter says a time out loud; nothing here writes one by hand.
    for (const text of assembled) {
      for (const match of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
        const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 4);
        // Their own typed lines are quoted back verbatim and are theirs.
        if (items.some((item) => item.text.includes(match[0]))) continue;
        expect.soft(`${match[0]}${tail}`, `${text} says a time without saying am or pm`).toMatch(/^\d{1,2}:\d{2}\s?(am|pm)/);
      }
    }
  });

  it("does not leave a copy key unresolved anywhere", () => {
    for (const text of assembled) {
      expect.soft(text, `${text} looks like an unresolved template`).not.toMatch(/\{\w+\}|undefined|\[object/);
    }
  });
});

describe("the flow copy stays where the flow can find it", () => {
  it("keeps every step five string under the one card", () => {
    // A string that drifts out of here is a string the walk in
    // first-run-copy.test.ts stops covering.
    expect(Object.keys(FIRST_RUN_COPY.flow["do-it"]).sort()).toEqual([
      "again", "business", "connect", "day", "failure", "input", "morning", "notes", "research", "working",
    ]);
  });
});

/**
 * THE LAST STEP OF THE FIRST RUN MAY NOT BE RECORDED OVER NOTHING.
 *
 * The research job's send was fired and forgotten, and the statement straight
 * after it recorded `flow` complete. Every one of these walks the real
 * `finishFirstRunJob` with the work made to behave the way a real machine can
 * behave, and asserts on ORDER and on whether `settle` was reached at all.
 * Nothing here reads source.
 */
describe("settling step five follows the work", () => {
  function recorder() {
    const log: string[] = [];
    const never = (name: string) => async () => {
      log.push(name);
      throw new Error(`${name} should not have been called`);
    };
    return { log, never };
  }

  it("sends the question BEFORE it records the step, and records it once", async () => {
    const { log, never } = recorder();
    await finishFirstRunJob(FIRST_RUN_JOB_SHAPES.research, {
      send: async () => { log.push("send"); },
      install: never("install"),
      settle: async () => { log.push("settle"); },
    });
    expect(log).toEqual(["send", "settle"]);
  });

  it("does not record the step when the send is refused", async () => {
    const { log, never } = recorder();
    const refused = new Error("That did not go through.");
    await expect(finishFirstRunJob(FIRST_RUN_JOB_SHAPES.research, {
      send: async () => { throw refused; },
      install: never("install"),
      settle: async () => { log.push("settle"); },
    })).rejects.toBe(refused);
    expect(log, "the first run settled on a question nobody received").toEqual([]);
  });

  it("does not record the step when the send never comes back in time", async () => {
    // A send that hangs is the other way to be wrong here: the caller bounds
    // the wait and rejects, and a rejection must not settle anything.
    const { log, never } = recorder();
    await expect(finishFirstRunJob(FIRST_RUN_JOB_SHAPES.research, {
      send: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("no answer")), 1)),
      install: never("install"),
      settle: async () => { log.push("settle"); },
    })).rejects.toThrow("no answer");
    expect(log).toEqual([]);
  });

  it("installs the crew before it records the step, and not after a refusal", async () => {
    const { log, never } = recorder();
    await finishFirstRunJob(FIRST_RUN_JOB_SHAPES.business, {
      send: never("send"),
      install: async () => { log.push("install"); },
      settle: async () => { log.push("settle"); },
    });
    expect(log).toEqual(["install", "settle"]);

    const after: string[] = [];
    await expect(finishFirstRunJob(FIRST_RUN_JOB_SHAPES.business, {
      send: never("send"),
      install: async () => { throw new Error("that crew is not available"); },
      settle: async () => { after.push("settle"); },
    })).rejects.toThrow("that crew is not available");
    expect(after).toEqual([]);
  });

  it("sends nothing at all for the jobs that have nothing to send", async () => {
    for (const id of ["brief", "day", "notes"] as const) {
      const { log, never } = recorder();
      await finishFirstRunJob(FIRST_RUN_JOB_SHAPES[id], {
        send: never("send"),
        install: never("install"),
        settle: async () => { log.push("settle"); },
      });
      expect(log, id).toEqual(["settle"]);
    }
  });

  it("settles nothing under a card the person has already left", async () => {
    const log: string[] = [];
    await finishFirstRunJob(FIRST_RUN_JOB_SHAPES.research, {
      send: async () => { log.push("send"); },
      install: async () => { log.push("install"); },
      settle: async () => { log.push("settle"); },
      gone: () => true,
    });
    expect(log).toEqual(["send"]);
  });
});
