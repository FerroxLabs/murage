// STEP FIVE: THE JOB, DONE.
//
// What the person typed, read honestly, and handed back as a result they can
// check. Every number on these screens is counted from their own lines and
// nothing is invented: no risk is manufactured when there is none, no third
// bot is announced that the package does not contain, and no deadline is
// attributed to a line that does not carry one.
//
// WHY THIS IS A MODULE AND NOT A COMPONENT. The thing that goes wrong on a
// result screen is a sentence that is true on the sample and false on the
// person's real input. Both of the defects that got out here were that shape:
// a brief confirmation that reported 07:00 whatever time was chosen, and a
// risk line that invented "or it moves to Wednesday". Both are decidable from
// data, so both are decided here, where a test can put real lines in and read
// real sentences out without mounting anything.
//
// The words are in FIRST_RUN_COPY. This file assembles them, and the
// sentences it assembles are run past the house rules in its own test,
// because the walk in first-run-copy.test.ts can only see the pieces.

import {
  FIRST_RUN_BRIEF_TIME,
  FIRST_RUN_COPY,
  botsEyebrowLine,
  clockLabel,
} from "./first-run-copy.ts";
import {
  FIRST_RUN_JOB_SHAPES,
  missingForJob,
  type FirstRunJobId,
  type FirstRunJobShape,
  type FirstRunJobWorld,
} from "./first-run-jobs.ts";

// ── the box ────────────────────────────────────────────────────────────

export type FirstRunInputKind = "day" | "notes" | "topic";

export interface FirstRunInputScreen {
  kind: FirstRunInputKind;
  heading: string;
  lead: string;
  /** A placeholder, never a value. The box starts empty. */
  placeholder: string;
  rows: number;
  /** Said with a live dot when the job's accounts are all connected, so they
   *  know what they do not have to type out again. Null otherwise, including
   *  for a job that reaches for no account at all. */
  connectedLine: string | null;
  go: string;
  elsewhere: string;
}

export function firstRunInputScreen(
  job: FirstRunJobShape,
  world: FirstRunJobWorld,
): FirstRunInputScreen | null {
  if (job.input === null) return null;
  const words = FIRST_RUN_COPY.flow["do-it"].input;
  const shape = words[job.input];
  const allConnected = job.needs.length > 0 && job.needs.every((app) => world.connected.includes(app));
  return {
    kind: job.input,
    heading: shape.heading,
    lead: shape.lead,
    placeholder: shape.placeholder,
    rows: shape.rows,
    connectedLine: allConnected ? words.calendarConnected : null,
    go: words.go,
    elsewhere: words.elsewhere,
  };
}

// ── reading what they typed ────────────────────────────────────────────

/**
 * THE THREE THINGS A LINE CAN CARRY, AND NOTHING ELSE.
 *
 * A time on it, a date or day against it, or a person waiting for it. Those
 * three are the whole model, and the result screens say so out loud, because
 * the alternative is a screen that appears to know more about the person's
 * week than a regular expression over twelve lines can possibly know.
 */
const TIME_RE = /\b((?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:am|pm)?|(?:1[0-2]|0?[1-9])\s*(?:am|pm))\b/i;
const DUE_RE = /\b(mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(due|deadline|eod|end of (?:day|week)|this week|next week|tomorrow)\b/i;
const OWED_RE = /\b(call|ring|email|reply|respond|get back|chase|follow[- ]?up|send|owe)\b/i;

/** Twelve is enough to be useful and few enough that the result stays one
 *  screen. A person who pasted forty lines gets the first twelve read, and
 *  the count on the screen is the count that was read. */
export const FIRST_RUN_ITEM_CAP = 12;

export interface FirstRunItem {
  text: string;
  timed: boolean;
  due: boolean;
  owed: boolean;
}

export function parseLines(text: string): readonly FirstRunItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, FIRST_RUN_ITEM_CAP)
    .map((line) => ({
      text: line,
      timed: TIME_RE.test(line),
      due: DUE_RE.test(line),
      owed: OWED_RE.test(line),
    }));
}

// ── the three lines while it works ─────────────────────────────────────

/**
 * Shown 400ms apart and then gone. They are counted, not decorative: a
 * person who typed five lines and is told about seven has just learned that
 * this screen makes things up, on the screen where they were deciding
 * whether to believe the next one.
 */
export function workingLines(
  job: FirstRunJobId,
  items: readonly FirstRunItem[],
  typed: string,
): readonly string[] {
  const words = FIRST_RUN_COPY.flow["do-it"].working;
  if (job === "business") return [words.businessShape, words.businessBuilt, words.ready];
  if (job === "research") {
    const head = typed.trim().slice(0, 46);
    return [`${words.topicPrefix} "${head}".`, words.topicSourced, words.ready];
  }
  const timed = items.filter((item) => item.timed).length;
  const dueNoSlot = items.filter((item) => item.due && !item.timed).length;
  const count = `${items.length} ${items.length === 1 ? words.thingOne : words.thingMany}`;
  const timedLine = timed === 0
    ? words.noneTimed
    : `${timed} ${timed === 1 ? words.hasOne : words.hasMany} ${words.timedTail}`;
  const dueLine = dueNoSlot === 0
    ? words.noneDue
    : `${dueNoSlot} ${dueNoSlot === 1 ? words.hasOne : words.hasMany} ${words.dueTail}`;
  return [`${count} ${timedLine}`, dueLine, words.ready];
}

// ── the day and the brief ──────────────────────────────────────────────

/**
 * The one that will slip, or nothing.
 *
 * A deadline with no time beats somebody waiting with no time, because a
 * deadline is a thing the world enforces and a person is a thing they can
 * ring. Anything with a time on it is already placed and is not at risk.
 *
 * Returning null is a real answer and the screen has words for it. An
 * earlier version could not say "nothing is at risk" and invented one.
 */
export function pickRisk(items: readonly FirstRunItem[]): FirstRunItem | null {
  return items.find((item) => item.due && !item.timed)
    ?? items.find((item) => item.owed && !item.timed)
    ?? null;
}

export interface FirstRunRisk {
  line: string;
  reason: string;
  advice: string;
}

export interface FirstRunColumn {
  heading: string;
  items: readonly string[];
  /** Said in place of an empty list, so a column never reads as broken. */
  empty: string;
}

export interface FirstRunDayResult {
  header: string;
  provenance: string;
  risk: FirstRunRisk | null;
  riskEyebrow: string;
  calm: { body: string; second: string } | null;
  fixed: FirstRunColumn;
  waiting: FirstRunColumn;
  /** The morning offer, on the brief job and on nothing else. */
  morning: FirstRunMorningOffer | null;
  again: string;
}

/** What was actually read, said plainly. The calendar and the mail are named
 *  ONLY when they are really connected; a provenance line that claimed a
 *  source it did not have would undo the point of having one. */
function provenance(count: number, world: FirstRunJobWorld, job: FirstRunJobShape): string {
  const words = FIRST_RUN_COPY.flow["do-it"].day;
  const sources: string[] = [];
  if (job.needs.includes("googlecalendar") && world.connected.includes("googlecalendar")) sources.push(words.plusCalendar);
  if (job.needs.includes("gmail") && world.connected.includes("gmail")) sources.push(words.plusMail);
  const base = `${words.fromLines} ${count} ${count === 1 ? words.linesOne : words.linesMany}`;
  if (sources.length === 0) return `${base}.`;
  return `${base}, plus ${sources.join(" and ")}.`;
}

function riskFor(items: readonly FirstRunItem[], chosen: FirstRunItem): FirstRunRisk {
  const words = FIRST_RUN_COPY.flow["do-it"].day;
  const dueCount = items.filter((item) => item.due && !item.timed).length;
  const reason = chosen.due
    ? dueCount === 1
      ? words.riskDueOnly
      : `${words.riskDueFirstPrefix} ${dueCount} ${words.riskDueFirstTail}`
    : words.riskOwed;
  const anyFixed = items.some((item) => item.timed);
  return { line: chosen.text, reason, advice: anyFixed ? words.riskAdviceGap : words.riskAdviceSlot };
}

export function dayResult(
  job: FirstRunJobShape,
  items: readonly FirstRunItem[],
  world: FirstRunJobWorld,
  briefTaken = false,
): FirstRunDayResult {
  const words = FIRST_RUN_COPY.flow["do-it"].day;
  const chosen = pickRisk(items);
  return {
    header: job.id === "brief" ? words.headerBrief : words.headerDay,
    provenance: provenance(items.length, world, job),
    risk: chosen ? riskFor(items, chosen) : null,
    riskEyebrow: chosen ? words.riskEyebrow : words.calmEyebrow,
    calm: chosen ? null : { body: words.calmBody, second: words.calmSecond },
    fixed: {
      heading: words.fixedHeading,
      items: items.filter((item) => item.timed).map((item) => item.text),
      empty: words.fixedEmpty,
    },
    waiting: {
      heading: words.waitingHeading,
      items: items.filter((item) => !item.timed && (item.owed || item.due)).map((item) => item.text),
      empty: words.waitingEmpty,
    },
    morning: job.id === "brief" ? morningOffer(briefTaken) : null,
    again: FIRST_RUN_COPY.flow["do-it"].again,
  };
}

// ── the morning offer ──────────────────────────────────────────────────

export interface FirstRunMorningOffer {
  heading: string;
  body: string;
  button: string;
  working: string;
  failure: string;
  /** Said in place of the button once it is set. Built from the same
   *  constant as the button and the request, so the three cannot disagree
   *  the way the shipped card's picker and its confirmation did. */
  taken: string | null;
}

export function morningOffer(taken: boolean): FirstRunMorningOffer {
  const words = FIRST_RUN_COPY.flow["do-it"].morning;
  const spoken = clockLabel(FIRST_RUN_BRIEF_TIME);
  return {
    heading: words.heading,
    body: `${words.bodyPrefix} ${spoken} ${words.bodyTail}`,
    button: `${spoken}${words.buttonTail}`,
    working: words.working,
    failure: words.failure,
    taken: taken ? `${words.takenPrefix} ${spoken}.` : null,
  };
}

/**
 * The request the button sends, which is the EXISTING brief template.
 *
 * `SETUP_ROUTINE_TEMPLATES.brief` already exists server-side and the route
 * already defaults to 07:00; there is no second brief to mint and no second
 * prompt to keep in step with the first. The time is sent explicitly all the
 * same, so the thing the person was shown and the thing that gets scheduled
 * are one value rather than two that happen to match today.
 */
export function briefRoutineRequest(): { template: "brief"; time: string; weekdaysOnly: true } {
  return { template: "brief", time: FIRST_RUN_BRIEF_TIME, weekdaysOnly: true };
}

// ── the notes ──────────────────────────────────────────────────────────

export interface FirstRunNoteStep {
  text: string;
  tag: string;
}

export interface FirstRunNotesResult {
  header: string;
  provenance: string;
  eyebrow: string;
  steps: readonly FirstRunNoteStep[];
  empty: string | null;
  caveat: string;
  again: string;
}

/** A date beats a person, a person beats a clock, and a line with none of
 *  the three is still on the list rather than quietly dropped. Ties keep the
 *  order they were typed in, which is the only ordering information left. */
function noteRank(item: FirstRunItem): number {
  return (item.due ? 2 : 0) + (item.owed ? 1 : 0);
}

function noteTag(item: FirstRunItem): string {
  const words = FIRST_RUN_COPY.flow["do-it"].notes;
  if (item.due) return words.tagDue;
  if (item.owed) return words.tagOwed;
  return item.timed ? words.tagTimed : words.tagOpen;
}

export function notesResult(items: readonly FirstRunItem[]): FirstRunNotesResult {
  const words = FIRST_RUN_COPY.flow["do-it"].notes;
  const steps = [...items]
    .sort((left, right) => noteRank(right) - noteRank(left))
    .map((item) => ({ text: item.text, tag: noteTag(item) }));
  return {
    header: words.header,
    provenance: `${words.fromPrefix} ${items.length} ${items.length === 1 ? words.fromTailOne : words.fromTailMany}`,
    eyebrow: words.eyebrow,
    steps,
    empty: steps.length === 0 ? words.empty : null,
    caveat: words.caveat,
    again: FIRST_RUN_COPY.flow["do-it"].again,
  };
}

// ── the research ───────────────────────────────────────────────────────

export interface FirstRunResearchResult {
  /** Said under the answer when it was written by whatever is on this
   *  computer rather than by a routed model. Null when Flux is in, and null
   *  on a machine with nothing, which never reaches this screen because the
   *  job asks for the key first. */
  onLocal: string | null;
  again: string;
}

export function researchResult(world: FirstRunJobWorld): FirstRunResearchResult {
  return {
    onLocal: !world.fluxReady && !world.nothingToThinkWith
      ? FIRST_RUN_COPY.flow["do-it"].research.onLocal
      : null,
    again: FIRST_RUN_COPY.flow["do-it"].again,
  };
}

// ── the crew ───────────────────────────────────────────────────────────

/**
 * The starter profile as this screen needs to read it.
 *
 * Every field comes from `library/packages/starter-solo-business.json` at
 * render time rather than being written down here, because the one thing
 * this screen must never do is describe a crew the person did not get.
 * server/first-run-business-crew.test.ts reads the real package and checks
 * these words against it.
 */
export interface FirstRunCrewReading {
  agents: readonly { key: string; name: string }[];
  routine: {
    name: string;
    /** 24 hour clock, as the package stores it. */
    time: string;
    /** 0 is Sunday, as the scheduler counts them. */
    weekdays: readonly number[];
    durationMinutes: number;
    enabledAfterInstall: boolean;
  } | null;
}

export interface FirstRunCrewBot {
  name: string;
  role: string | null;
}

export interface FirstRunBusinessResult {
  header: string;
  lead: string;
  botsEyebrow: string;
  bots: readonly FirstRunCrewBot[];
  reviewEyebrow: string | null;
  reviewLine: string | null;
  offer: { label: string; why: string; taken: string } | null;
  again: string;
}

const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

export function businessResult(crew: FirstRunCrewReading): FirstRunBusinessResult {
  const words = FIRST_RUN_COPY.flow["do-it"].business;
  const roles: Record<string, string> = words.roles;
  const routine = crew.routine;
  // The eyebrow counts what is really there. A profile that grew a third bot
  // would say so here rather than having this screen keep saying two, which
  // is what it did while `botsEyebrowMany` was the literal "Two bots".
  const botsEyebrow = botsEyebrowLine(crew.agents.length);
  const days = routine?.weekdays.map((day) => WEEKDAY_NAMES[day]).filter(Boolean) ?? [];
  return {
    header: words.header,
    lead: words.lead,
    botsEyebrow,
    bots: crew.agents.map((agent) => ({ name: agent.name, role: roles[agent.key] ?? null })),
    reviewEyebrow: routine ? words.reviewEyebrow : null,
    reviewLine: routine
      ? `${routine.name}, ${days.join(" and ")} at ${clockLabel(routine.time)}, ${routine.durationMinutes} ${words.minutesTail}`
        + (routine.enabledAfterInstall ? "" : ` ${words.reviewTail}`)
      : null,
    // Offered only when it really did install switched off. A button that
    // said "switch it on" about something already running would be the
    // second thing the person pressed and the first thing that lied to them.
    offer: routine && !routine.enabledAfterInstall
      ? { label: words.offer, why: words.offerWhy, taken: words.offerTaken }
      : null,
    again: FIRST_RUN_COPY.flow["do-it"].again,
  };
}

// ── where the flow is ──────────────────────────────────────────────────

export type FirstRunFlowStage = "connect" | "input" | "working" | "result";

/**
 * Where a chosen job starts.
 *
 * The same rule as the job row's own `press`, read through the job rather
 * than the row, for a caller that already has the job in hand. A job with
 * nothing missing and nothing to type goes straight to the work.
 */
export function flowStageFor(job: FirstRunJobShape, world: FirstRunJobWorld): FirstRunFlowStage {
  if (missingForJob(job, world).length > 0) return "connect";
  return job.input === null ? "working" : "input";
}

/**
 * "OR JUST TELL ME WHAT YOU NEED."
 *
 * The way out for somebody whose thing is not on the list. It goes STRAIGHT
 * to the notes box, past the connect screen, which is the one place in this
 * flow that deliberately skips a gate: the notes job reaches for no account,
 * so there is nothing to connect, and asking for a key before letting
 * somebody type a sentence would be the form this release exists to delete.
 *
 * On a machine with nothing to think with that leaves a box with nothing
 * behind it, which is the case the owner was asked about and the reason
 * `typedOutcome` exists. The box still opens, what they write is still kept,
 * and nothing spins. See first-run-jobs.ts.
 */
// ── settling step five, AFTER the work rather than in front of it ──────

/**
 * WHAT THE LAST STEP OF THE FIRST RUN HAS TO DO BEFORE IT IS RECORDED DONE.
 *
 * THE DEFECT THIS EXISTS TO STOP. The research job's question was handed to
 * `dispatch` and forgotten. A dispatch returns nothing, so the card could not
 * tell a delivered question from one the route refused, and the very next
 * statement recorded `flow` complete. A rejected send, an authentication
 * failure, an unanswered approval card and a dead provider all ended the same
 * way: "Ready." on screen and the first run marked finished over a question
 * nobody had received. Worse, the whole thing ran from the timer that had
 * ALREADY played the three working lines, so the theatre came first and the
 * work, such as it was, ran into the void behind it.
 *
 * Settlement now follows the work. `send` resolves only when the server has
 * accepted the message and rejects when it has not, and `settle` is on the
 * resolving path alone. Anything that throws in here leaves the step open,
 * which is the honest state: it did not happen. The caller says so where it
 * happened, which is what the card's failure line is for.
 *
 * INJECTED RATHER THAN IMPORTED, so the rule is decidable without a server,
 * a clock or a DOM, exactly like every other rule in this module.
 */
export interface FirstRunJobWork {
  /** The person's question, as a promise that settles on the server's own
   *  answer. Called for `research` and for nothing else. */
  send: () => Promise<void>;
  /** The business package. Called for `business` and for nothing else. */
  install: () => Promise<void>;
  /** Records `flow` answered. Reached only once the work above has. */
  settle: () => Promise<void>;
  /** The card has gone. Nothing it owns should still be written to, and a
   *  step settled under a card nobody is looking at is a step settled on
   *  nothing. */
  gone?: () => boolean;
}

export async function finishFirstRunJob(job: FirstRunJobShape, work: FirstRunJobWork): Promise<void> {
  if (job.id === "business") await work.install();
  if (job.id === "research") await work.send();
  if (work.gone?.()) return;
  await work.settle();
}

export function escapeHatchScreen(world: FirstRunJobWorld): FirstRunInputScreen {
  const screen = firstRunInputScreen(FIRST_RUN_JOB_SHAPES.notes, world);
  // `notes` always has a box, so this is a type narrowing rather than a
  // fallback. If it ever stops having one, the escape hatch has nowhere to
  // go and that should be loud rather than quietly rendering nothing.
  if (!screen) throw new Error("The notes job lost its input, so there is nowhere for the escape hatch to go.");
  return screen;
}
