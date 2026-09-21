// STEP FOUR AND THE FRONT OF STEP FIVE: THE FIVE JOBS, AND WHAT EACH ONE
// STILL NEEDS.
//
// The Chief asks one question, "what can I take off your plate", and offers
// five answers. Pressing one connects ONLY what that one job needs and then
// does the work. That is the whole re-cut: the standalone `apps` step is
// gone, and the same two sign-ins are asked for by a job the person has just
// chosen, which is the moment they are obviously worth making.
//
// WHY THE LOGIC IS HERE AND NOT IN THE CARD.
//
// The tag on each row ("ready now", "connect Google Calendar", "2 to
// connect") is recomputed on every render from live state, so it is right
// the instant somebody comes back from a browser window with Gmail
// connected. A rule that lives inside a component is a rule nothing can test
// without mounting the component, and the rule that matters most here is the
// one about a blank machine: EVERY job needs Flux first when there is
// nothing on the computer to think with, including the three that normally
// need nothing at all. Getting that wrong offers somebody a job that cannot
// run and then fails silently on them.
//
// The words are in FIRST_RUN_COPY with every other first-run string, so the
// house rules are checked over them by first-run-copy.test.ts rather than by
// anybody remembering. This file joins those words to behaviour and holds
// nothing readable of its own.

import { FIRST_RUN_COPY } from "./first-run-copy.ts";
import { SETUP_JOB_APPS, type SetupJobApp, type SetupView } from "../../shared/setup.ts";

/** The five, in the order they are offered. The first is visually led. */
export const FIRST_RUN_JOB_IDS = ["brief", "day", "notes", "research", "business"] as const;
export type FirstRunJobId = (typeof FIRST_RUN_JOB_IDS)[number];

/** Which box the job opens after everything it needs is connected, or null
 *  for the one job that asks nothing. */
export type FirstRunJobInput = "day" | "notes" | "topic" | null;

/**
 * How much a job wants Flux Router.
 *
 * `required` is a job that reaches for a connected account, and connected
 * accounts are hard-blocked without a key (`connectedAppsBlock`,
 * shared/setup.ts). `better` is a job that runs on whatever is here and runs
 * better on a bigger model. `no` is a job that only needs something, anything,
 * that can think.
 *
 * The distinction is not decoration: it decides whether `flux` appears in
 * this job's missing list on a machine that already has an engine.
 */
export type FirstRunJobFlux = "required" | "better" | "no";

export interface FirstRunJobShape {
  id: FirstRunJobId;
  /** First-run connectable apps this job reaches for. Gmail and Calendar
   *  only in 0.1.58; see SETUP_JOB_APPS for why Slack is not here. */
  needs: readonly SetupJobApp[];
  flux: FirstRunJobFlux;
  input: FirstRunJobInput;
}

/**
 * The shape of each job, with no words in it.
 *
 * `brief` needs both accounts because "what came in overnight and what is
 * already fixed" is mail and calendar, and a brief written without them is a
 * rewrite of what the person typed. `day` needs only the calendar. The other
 * three reach for nothing, which is why they are the ones that still work on
 * a machine where the person declined everything.
 */
export const FIRST_RUN_JOB_SHAPES: Readonly<Record<FirstRunJobId, FirstRunJobShape>> = {
  brief: { id: "brief", needs: ["googlecalendar", "gmail"], flux: "required", input: "day" },
  day: { id: "day", needs: ["googlecalendar"], flux: "required", input: "day" },
  notes: { id: "notes", needs: [], flux: "no", input: "notes" },
  research: { id: "research", needs: [], flux: "better", input: "topic" },
  business: { id: "business", needs: [], flux: "no", input: null },
};

// ── what a job is still waiting on ─────────────────────────────────────

/** One thing standing between the person and the job running. `flux` sorts
 *  to the front because an app row without a key is a row that cannot be
 *  acted on, and they find that out by pressing it. */
export type FirstRunJobNeed = "flux" | SetupJobApp;

export type FirstRunJobTagTone = "ready" | "accent" | "neutral";

export interface FirstRunJobTag {
  text: string;
  tone: FirstRunJobTagTone;
}

/**
 * Everything about live state a job needs to tag itself.
 *
 * A narrow read of the view rather than the view itself, so a test can state
 * a machine in four fields and so it is obvious at a glance that nothing
 * else is consulted. `firstRunJobWorld` is the only way one is built from a
 * real view.
 */
export interface FirstRunJobWorld {
  fluxReady: boolean;
  /** Nothing on this computer can answer. Computed server-side over
   *  `runnable()`, never re-derived here: see `SetupView`. */
  nothingToThinkWith: boolean;
  /**
   * NOT ONE ENGINE ON THIS COMPUTER IS READY TO ANSWER RIGHT NOW.
   *
   * WHY IT IS NOT `nothingToThinkWith`. That predicate is
   * `agents.length === 0 && signedOutAgents.length === 0`, so a machine with
   * Codex installed and nobody signed in to it answers FALSE: it is not
   * blank, it has something worth telling the person about, and it is the
   * exact audience the `signed-out` variant was built for. The Chief then
   * read that as "local" and opened with "Running on what is already on this
   * computer", about an engine that answers nothing. This is the narrower
   * fact the sentence actually needed: `agents` is already filtered by
   * `runnable()`, so empty means nothing here will answer.
   */
  nothingRunnable: boolean;
  /** Which of the two first-run apps are connected. */
  connected: readonly SetupJobApp[];
  /**
   * The connector store could not be read, so `connected` is "we do not
   * know" rather than "nothing".
   *
   * The jobs stay conservative and treat unknown as unconnected, because the
   * other way round claims a connection we cannot see and then fails on the
   * person's first real job. The screen says which of the two it is; the tag
   * cannot.
   */
  appsUnreadable: boolean;
  /** How a web search would leave this computer, for the one job that makes
   *  one. See `firstRunSearchRouting`. */
  search: FirstRunSearchRouting;
}

export function firstRunJobWorld(
  view: Pick<SetupView, "fluxReady" | "nothingToThinkWith" | "connectedJobApps" | "agents">,
  search: FirstRunSearchRouting,
): FirstRunJobWorld {
  return {
    fluxReady: view.fluxReady,
    nothingToThinkWith: view.nothingToThinkWith,
    nothingRunnable: (view.agents ?? []).length === 0,
    connected: view.connectedJobApps ?? [],
    appsUnreadable: view.connectedJobApps === null,
    search,
  };
}

/**
 * What this job is still waiting on, in the order it should be asked for.
 *
 * THE SECOND TERM IS THE ONE TO GET RIGHT. On a machine with nothing to
 * think with, every job needs Flux first, including `notes` and `business`
 * which normally need nothing: there is no engine behind them, so "ready
 * now" would be a promise the machine cannot keep. This is the same
 * predicate that skipped the detection step, read off the view rather than
 * worked out again here.
 */
export function missingForJob(job: FirstRunJobShape, world: FirstRunJobWorld): readonly FirstRunJobNeed[] {
  const missing: FirstRunJobNeed[] = job.needs.filter((app) => !world.connected.includes(app));
  if ((job.flux === "required" || world.nothingToThinkWith) && !world.fluxReady) missing.unshift("flux");
  return missing;
}

/** What one missing thing is called when the row has to name it. */
export function jobNeedLabel(need: FirstRunJobNeed): string {
  return FIRST_RUN_COPY.chat.jobs.needLabels[need];
}

/**
 * The live tag on the right of a job row.
 *
 * Four shapes, and the difference between them is the point: one missing
 * thing is named, because "connect Google Calendar" is a thing a person can
 * decide about, and two or more is counted, because a row cannot hold both
 * names without becoming a paragraph.
 */
export function jobTag(missing: readonly FirstRunJobNeed[]): FirstRunJobTag {
  const words = FIRST_RUN_COPY.chat.jobs.tags;
  if (missing.length === 0) return { text: words.ready, tone: "ready" };
  if (missing.length === 1) {
    return missing[0] === "flux"
      ? { text: words.flux, tone: "accent" }
      : { text: `${words.connectOne} ${jobNeedLabel(missing[0])}`, tone: "accent" };
  }
  return { text: `${missing.length} ${words.countTail}`, tone: "neutral" };
}

// ── the one job that leaves the computer on its own ────────────────────

/**
 * HOW A WEB SEARCH GETS OUT, WHICH IS THE ANSWER TO "DOES RESEARCH RUN".
 *
 * The question was whether `research` can run on a first run without
 * quietly using an account the person pays for. Verified against
 * server/index.ts and server/web-search.ts rather than assumed:
 *
 *   `cfg.webSearch?.provider ?? "engine"` is the route's default, and both
 *   `engine` and `auto` call `searchFreeWeb` (server/free-web-search.ts),
 *   which is anonymous Parallel Search with a DuckDuckGo fallback and no API
 *   key of any kind. Only an explicitly chosen `tavily`, `exa` or
 *   `firecrawl` reaches `searchWeb`, which refuses outright without that
 *   provider's own key.
 *
 * So on an unconfigured machine, which is every first run, searching uses
 * nothing of the person's. That is `anonymous`, and `research` is offered
 * with no strings attached.
 *
 * The other three states exist because the owner may have chosen otherwise
 * before reaching this screen, and a job that stayed silent about it would
 * be the exact thing this was checked to prevent.
 */
export type FirstRunSearchRouting = "anonymous" | "own-account" | "unconfigured" | "off";

/** The shape `/api/config` already publishes. Keys are never sent, only
 *  whether each one is there (server/index.ts, `tavilyConfigured` and its
 *  two siblings). */
export interface FirstRunSearchConfig {
  provider?: "engine" | "auto" | "tavily" | "exa" | "firecrawl" | "off";
  tavilyConfigured?: boolean;
  exaConfigured?: boolean;
  firecrawlConfigured?: boolean;
}

export function firstRunSearchRouting(config: FirstRunSearchConfig | null | undefined): FirstRunSearchRouting {
  const provider = config?.provider ?? "engine";
  if (provider === "off") return "off";
  if (provider === "engine" || provider === "auto") return "anonymous";
  const configured = provider === "tavily"
    ? config?.tavilyConfigured
    : provider === "exa"
      ? config?.exaConfigured
      : config?.firecrawlConfigured;
  return configured === true ? "own-account" : "unconfigured";
}

/**
 * The line under the research job, or null when there is nothing to say.
 *
 * Null on the default route on purpose. A first run that explained its own
 * plumbing on a screen where nothing is wrong would be noise, and the rule
 * is only that the job must never search without saying whose account it is
 * searching on.
 */
export function researchNote(routing: FirstRunSearchRouting): string | null {
  return routing === "anonymous" ? null : FIRST_RUN_COPY.chat.jobs.searchNotes[routing];
}

// ── the rows, joined to their words ────────────────────────────────────

export interface FirstRunJobRow {
  id: FirstRunJobId;
  title: string;
  sub: string;
  /** True for the first row, which is visually led. */
  lead: boolean;
  missing: readonly FirstRunJobNeed[];
  tag: FirstRunJobTag;
  /** Where pressing it goes: the connect screen when anything is missing,
   *  the job's own input when not, and straight to the work for the one job
   *  that has no input. */
  press: "connect" | "input" | "working";
  /** Said under the row, or null. Only `research` ever has one. */
  note: string | null;
}

export function firstRunJobRows(world: FirstRunJobWorld): readonly FirstRunJobRow[] {
  return FIRST_RUN_COPY.chat.jobs.rows.map((row, index) => {
    const shape = FIRST_RUN_JOB_SHAPES[row.id];
    const missing = missingForJob(shape, world);
    return {
      id: row.id,
      title: row.title,
      sub: row.sub,
      lead: index === 0,
      missing,
      tag: jobTag(missing),
      press: missing.length > 0 ? "connect" : shape.input === null ? "working" : "input",
      note: row.id === "research" ? researchNote(world.search) : null,
    };
  });
}

// ── per-job connect ────────────────────────────────────────────────────

export interface FirstRunConnectRow {
  need: FirstRunJobNeed;
  bold: string;
  small: string;
}

export interface FirstRunConnectScreen {
  heading: string;
  lead: string;
  rows: readonly FirstRunConnectRow[];
  /** Offered only when the job has a box to type into. `business` has none,
   *  so there is nothing to skip to. */
  skipToInput: string | null;
  elsewhere: string;
  /** The store could not be read, so these rows may be asking for something
   *  already connected. Said on the screen, never folded into a tag. */
  appsUnreadable: boolean;
}

/**
 * The connect screen for one job, or null when it has nothing to ask for.
 *
 * Null rather than an empty screen, because a screen headed "0 things, and
 * then I can do it" is the shape of bug that ships when a caller trusts a
 * function to always have something to say.
 */
export function firstRunConnectScreen(
  job: FirstRunJobShape,
  world: FirstRunJobWorld,
): FirstRunConnectScreen | null {
  const missing = missingForJob(job, world);
  if (missing.length === 0) return null;
  const words = FIRST_RUN_COPY.flow["do-it"].connect;
  return {
    heading: missing.length === 1 ? words.headingOne : `${missing.length} ${words.headingManyTail}`,
    lead: words.lead,
    rows: missing.map((need) => ({ need, bold: jobNeedLabel(need), small: words.reasons[need] })),
    skipToInput: job.input === null ? null : words.skipToInput,
    elsewhere: words.elsewhere,
    appsUnreadable: world.appsUnreadable,
  };
}

/**
 * Where connecting one thing leaves the person.
 *
 * Connecting the LAST missing thing advances by itself: they pressed a job,
 * they did what it asked, and making them press a second button to start the
 * work they already asked for is a form. Anything else re-renders the same
 * screen with that row satisfied.
 */
export function afterConnect(job: FirstRunJobShape, world: FirstRunJobWorld): "connect" | "input" | "working" {
  if (missingForJob(job, world).length > 0) return "connect";
  return job.input === null ? "working" : "input";
}

// ── the status line the Chief opens with ───────────────────────────────

export type FirstRunChiefState = "connected" | "no-brain" | "signed-out" | "local";

/**
 * Four openings, and only one of them is allowed to say something is running.
 *
 * It is never "you are all set". The jobs are still shown, because seeing
 * what this thing would do for you is the reason to connect anything at all,
 * but every one of them says what it needs first.
 *
 * THE DEFECT `signed-out` EXISTS FOR. There were three states and the test
 * between the last two was `nothingToThinkWith`, which is false on a machine
 * with a signed-out engine on it. So somebody with Codex installed and never
 * signed in fell to `local` and was told "Running on what is already on this
 * computer" while nothing at all was running: `view.agents` is empty, so
 * even the engine's name came out blank. That is precisely the audience the
 * `signed-out` detection variant was built for.
 */
export function chiefState(world: FirstRunJobWorld): FirstRunChiefState {
  if (world.fluxReady) return "connected";
  if (world.nothingToThinkWith) return "no-brain";
  return world.nothingRunnable ? "signed-out" : "local";
}

export function chiefStatusLine(world: FirstRunJobWorld, engineName: string): string {
  const lines = FIRST_RUN_COPY.chat.jobs.status;
  const state = chiefState(world);
  if (state === "connected") return lines.connected;
  if (state === "no-brain") return lines.noBrain;
  if (state === "signed-out") return lines.signedOut;
  const named = engineName.trim();
  return named ? `${lines.localPrefix} ${named} ${lines.localTail}` : lines.localUnnamed;
}

/**
 * The question, with their name in it when there is one.
 *
 * SKIPPING THE HELLO STEP STORES NOTHING. This comment used to say it
 * "stores `there`", flatly contradicting `firstRunAddress`, which says in so
 * many words that it is a render fallback that writes nothing; and neither
 * of them was true of the code, which passed a bare `view.ownerName` in and
 * asked "What can I take off your plate?" of somebody the approved flow
 * calls "there".
 *
 * `firstRunAddress` is what fills this sentence, at the call site, and the
 * reason it is a fallback rather than a saved name is that the greeting
 * wants the opposite thing from the same blank: a skipped name DROPS the
 * comma clause there ("Good to meet you."), and a stored "there" would make
 * it say "Good to meet you, there." Both are only possible while the blank
 * stays blank.
 *
 * The empty branch stays because a caller is not obliged to use the
 * fallback, and a question with a gap in it would be worse than one without
 * the clause.
 */
export function chiefQuestion(ownerName: string): string {
  const words = FIRST_RUN_COPY.chat.jobs;
  const name = ownerName.trim();
  return name ? `${words.question}, ${name}?` : `${words.question}?`;
}

/**
 * "I will do it now" is a promise, so it is only made where it can be kept.
 *
 * A signed-out machine gets the same honest lead as a blank one. It sits
 * directly under the status line, and a lead that said "Pick one and I will
 * do it now" over a status line that has just said nothing here is signed in
 * would be the two of them contradicting each other on the same screen.
 */
export function chiefLead(world: FirstRunJobWorld): string {
  const words = FIRST_RUN_COPY.chat.jobs;
  const state = chiefState(world);
  return state === "no-brain" || state === "signed-out" ? words.leadNoBrain : words.lead;
}

// ── the escape hatch, on a machine with nothing ────────────────────────

/**
 * WHAT HAPPENS WHEN THEY TYPE INTO THE BOX AND NOTHING CAN ANSWER.
 *
 * `pickDefaultEngine` (server/default-engine.ts) deliberately returns empty
 * rather than falling back to something that does not work, and there is a
 * standing ruling that Murage never offers to download a model. So on a
 * blank machine with no key there is genuinely nothing to ask, and the only
 * two honest options are to say so or to pretend.
 *
 * `keep` is saying so. What they typed is kept, and the Chief says it will
 * be used as soon as there is something to think with. What it must not do
 * is show a working state or say an answer is coming, because both of those
 * are a wait that never ends, and a person who watched a spinner for a
 * minute has been told something false by the interface rather than by the
 * words.
 */
export type FirstRunTypedOutcome = "answer" | "keep";

export function typedOutcome(world: FirstRunJobWorld): FirstRunTypedOutcome {
  return world.nothingToThinkWith && !world.fluxReady ? "keep" : "answer";
}

/** Whether the box may show a working state at all. Never on the `keep`
 *  path: there is nothing running to be working. */
export function typedMayShowWorking(world: FirstRunJobWorld): boolean {
  return typedOutcome(world) === "answer";
}

export function typedReply(world: FirstRunJobWorld): string | null {
  return typedOutcome(world) === "keep" ? FIRST_RUN_COPY.chat.jobs.kept : null;
}

void SETUP_JOB_APPS;
