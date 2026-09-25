// THE SHARED CHROME OF EVERY FIRST RUN CARD.
//
// Not a design system: four class strings and three tiny pieces, kept in one
// file so nine cards cannot drift into nine shapes. The treatment is the one
// IntakeTurn already established for a bot that is asking for something: a
// bubble in the transcript in the same skin as everything else the Chief
// says, with quiet controls underneath. Deliberately NOT a bordered panel,
// and emphatically not a modal. The thing this release replaces was an
// eight card modal whose buttons dropped the person into a settings pane
// they had never seen.

import { useEffect, useState, type ReactNode } from "react";

import { api } from "@/state/store";
import type { SetupStep, SetupView } from "../../shared/setup";

/** The bot's own bubble. Wider than a text bubble because these carry rows
 *  and fields, but the same skin, because it is the same voice. */
export const FIRST_RUN_BUBBLE =
  "w-full max-w-[min(42rem,88%)] max-md:max-w-full rounded-2xl bg-card px-4 py-3 text-[15px] leading-relaxed text-ink";

export const FIRST_RUN_CHIP =
  "min-h-11 rounded-full border border-hairline/50 bg-control px-3.5 text-[13.5px] text-ink hover:bg-raised-hover disabled:opacity-60";

export const FIRST_RUN_PRIMARY =
  "min-h-11 rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50";

export const FIRST_RUN_QUIET = "min-h-11 px-1 text-[13.5px] text-ink-secondary hover:text-ink disabled:opacity-60";

export const FIRST_RUN_INPUT =
  "min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 text-[14px] text-ink";

export const FIRST_RUN_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** The card itself: the Chief talking, with whatever it is offering below. */
export function FirstRunBubble({ children }: { children: ReactNode }) {
  return <div className={FIRST_RUN_BUBBLE}>{children}</div>;
}

/** A sentence of the Chief's, as its own line. Two of these read as two
 *  thoughts; one paragraph of the same words reads as a wall. */
export function FirstRunLine({ children, quiet = false }: { children: ReactNode; quiet?: boolean }) {
  return (
    <p className={quiet ? "mt-2 text-[13px] leading-relaxed text-ink-secondary" : "mt-2 text-[15px] leading-relaxed text-ink first:mt-0"}>
      {children}
    </p>
  );
}

/** Something went wrong, said where it happened rather than in a toast. */
export function FirstRunFailure({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      {message}
    </p>
  );
}

/** Confirmation, in the Chief's own quiet voice. */
export function FirstRunNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="mt-3 text-[13px] leading-relaxed text-success">
      {children}
    </p>
  );
}

export function failureText(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : "";
  return message || fallback;
}

// ── the checklist behind the conversation ──────────────────────────────
// The cards are messages and carry only their own identity, so anything a
// card needs to KNOW (which engines were found, what the brief is doing) is
// read from /api/setup. One read is shared by every card on screen: they all
// mount in the same frame, and nine identical requests would be nine.

let inFlight: Promise<SetupView | null> | null = null;
let cached: { view: SetupView; at: number } | null = null;
const FRESH_MS = 4_000;

/**
 * EVERY CARD AND THE CHECKLIST MOVE TOGETHER, OR THE FLOW LOOKS BROKEN.
 *
 * This was a plain module cache with `useState` in each consumer, and the two
 * do not add up. A card that changed something cleared the cache and
 * re-rendered ITSELF; every other mounted consumer kept the view it read when
 * it mounted, forever, because nothing told it otherwise.
 *
 * The checklist in the sidebar is a consumer. So a person pasted their key,
 * watched the key card settle, and watched the rail go on saying that step
 * was still outstanding. Reported exactly that way: the key is in and "One
 * key worth having" is not ticked. Nothing was wrong with the server, which
 * had the step done; the sidebar had simply never asked again.
 *
 * A subscription instead. One fetch still serves everyone, and when it
 * lands everyone hears about it.
 */
const listeners = new Set<(view: SetupView) => void>();

/**
 * WHILE THE CONVERSATION IS LIVE, KEEP ASKING.
 *
 * The flow only ever moved when somebody pressed something, because the only
 * things that call `driveSetup` are the setup routes and nothing polled. That
 * is fine while every finished step is finished BY an action, and it stops
 * dead the moment one finishes on its own.
 *
 * Which is the ordinary case, not an edge: connected apps travel with the
 * Flux Router key, so a person whose key already carries Gmail arrives at
 * that step with it done and nothing to press. Reported exactly that way, "it
 * stops after everything's connected". Nothing was broken; nobody was asking.
 *
 * One timer for the whole app, chained off each answer rather than a fixed
 * interval, so a slow reply can never stack requests. It runs only while the
 * SERVER says the first run is still going, and stops the moment there is
 * nothing left to do. `GET /api/setup` is idempotent and the card driver is
 * keyed on card identity, so an extra read costs a query and appends nothing.
 */
const POLL_MS = 3_000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * HOW MANY READS IN A ROW MAY REPORT NOTHING NEW BEFORE THE POLL GIVES UP.
 *
 * `view.next === null` was the only stop, and it is not one. `chat` and
 * `flow` are settled by the person doing something in this renderer, so a
 * person who leaves the app sitting on the jobs screen — or on any screen
 * they never finish — has a `view.next` that is never null, and the app
 * re-read `GET /api/setup` every three seconds for the life of the process.
 * That read calls `registry.describe()` over the whole engine fleet and,
 * once a key exists, reaches the connected-apps broker. Forever, on every
 * install, including one left open overnight.
 *
 * So the poll is bounded by its own usefulness. It exists to notice a step
 * finishing OFF screen (connected apps travel with the Flux key, a sign-in
 * happens in another window), and a run of identical answers is the proof
 * that nothing is finishing. Twenty of them is a minute of asking, which
 * covers coming back from a browser tab; past that, nothing is happening and
 * the app stops asking.
 *
 * Anything the person does restarts it, because every mutation in this file
 * goes through `forgetSetupView`, and so does `refresh`.
 */
export const SETUP_POLL_IDLE_LIMIT = 20;

/** A read that failed, and how many times in a row. A failure is retried
 *  rather than swallowed: with nothing cached, several cards render nothing
 *  at all, and only a SUCCESSFUL read used to schedule another one. */
const RETRY_MS = 2_000;
export const SETUP_READ_RETRY_LIMIT = 5;

let idleReads = 0;
let lastSeen = "";
let failedReads = 0;
/** The route answered 403/404: this surface (a phone through the door) is
 * never shown the first run, so asking again only adds 404s to its log. */
let refused = false;

/** Whether a poll is still worth making. Pure, and exported, so the rule can
 *  be read and tested without a timer. */
export function setupPollWanted(view: SetupView, idle: number): boolean {
  if (view.conversationLive !== true) return false;
  if (view.next === null) return false;
  return idle < SETUP_POLL_IDLE_LIMIT;
}

function clearPoll(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(view: SetupView): void {
  clearPoll();
  if (!setupPollWanted(view, idleReads)) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void readSetupView(true);
  }, POLL_MS);
}

/**
 * The read did not answer, so ask again instead of ending the flow.
 *
 * `.catch(() => null)` alone is what made one bad response permanent: the
 * cards that report on the machine return null with no view, and only a
 * successful publish scheduled the next read, so a single failure left a
 * heading with nothing under it and nothing that would ever ask again.
 *
 * Bounded, and backing off, because a server that is genuinely gone should
 * not be hammered. A cached view is left exactly as it was: the last true
 * answer beats no answer.
 */
function scheduleRetry(): void {
  if (pollTimer || failedReads >= SETUP_READ_RETRY_LIMIT) return;
  failedReads += 1;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void readSetupView(true);
  }, RETRY_MS * failedReads);
}

function publish(view: SetupView): void {
  // A poll that keeps hearing the same answer is a poll that is not earning
  // its request. `JSON.stringify` rather than a hand-picked set of fields:
  // a signature that named the fields it cared about would stop noticing the
  // next field somebody adds.
  const seen = JSON.stringify(view);
  if (seen === lastSeen) idleReads += 1;
  else {
    lastSeen = seen;
    idleReads = 0;
  }
  for (const listener of [...listeners]) listener(view);
  schedulePoll(view);
}

export function readSetupView(force = false): Promise<SetupView | null> {
  if (refused) return Promise.resolve(null);
  const now = Date.now();
  if (!force && cached && now - cached.at < FRESH_MS) return Promise.resolve(cached.view);
  if (!force && inFlight) return inFlight;
  const request = api("/api/setup")
    .then((view: SetupView) => {
      if (view && Array.isArray(view.steps)) {
        failedReads = 0;
        cached = { view, at: Date.now() };
        publish(view);
      } else {
        // An answer that is not a setup view is a failure wearing a 200.
        scheduleRetry();
      }
      return cached?.view ?? null;
    })
    .catch((error: { status?: unknown } | null) => {
      if (error?.status === 403 || error?.status === 404) {
        refused = true;
        return null;
      }
      scheduleRetry();
      return null;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

/**
 * Something changed: drop what we knew and tell everybody the new answer.
 *
 * It used to only drop. The re-read is what closes the loop, and it is here
 * rather than at each call site because every caller of this function has
 * just done something that moves the checklist, without exception.
 *
 * It also wakes the poll. Something just happened, so the run of identical
 * answers that stopped it is over by definition.
 */
export function forgetSetupView(): void {
  refused = false;
  cached = null;
  inFlight = null;
  idleReads = 0;
  lastSeen = "";
  failedReads = 0;
  clearPoll();
  void readSetupView(true);
}

export function useSetupView(): { view: SetupView | null; refresh: () => void } {
  const [view, setView] = useState<SetupView | null>(cached?.view ?? null);
  useEffect(() => {
    let live = true;
    const listener = (next: SetupView) => {
      if (live) setView(next);
    };
    listeners.add(listener);
    void readSetupView().then((next) => {
      if (live && next) setView(next);
    });
    return () => {
      live = false;
      listeners.delete(listener);
    };
  }, []);
  // `refresh` is somebody pressing "I have done it", so it wakes the poll for
  // the same reason `forgetSetupView` does: the run of identical answers that
  // stopped it is over.
  return { view, refresh: () => forgetSetupView() };
}

/**
 * The step a PARKED first-run card answers.
 *
 * W16 cut six steps to five, and `apps`, `brief` and `routines` stopped
 * existing. Three cards were built against them and all three are real,
 * tested work: the apps rows, the morning brief and its "a couple more"
 * offer, and the phone and Tailscale walkthrough. Whether they move to
 * another surface, come back later in the flow, or go, is the owner's
 * decision and it has not been taken. NONE OF THEM IS DELETED HERE.
 *
 * So they keep compiling, and they point at the step they would now live
 * inside: `flow` is where a job asks for what it needs and where its result
 * arrives, which is where every one of them belongs if it comes back.
 * NOTHING RENDERS THEM TODAY — `variantForCurrentStep` in
 * server/setup-conversation.ts never emits their variants — so this constant
 * changes no behaviour. It exists so the park is one named decision in one
 * place instead of three quiet string edits.
 */
export const PARKED_CARD_STEP: SetupStep = "flow";

/** Record what they said against a step. The server owns what that means
 *  for the checklist; this only reports it. */
export async function answerSetupStep(step: SetupStep, answer: string): Promise<void> {
  await api("/api/setup/answer", { method: "POST", body: JSON.stringify({ step, answer }) });
  forgetSetupView();
}

/** Passed over deliberately. Skipped is not done, and the Chief does not
 *  bring it up again unasked. */
export async function skipSetupStep(step: SetupStep): Promise<void> {
  await api("/api/setup/skip", { method: "POST", body: JSON.stringify({ step }) });
  forgetSetupView();
}

/**
 * Put a step back on the list.
 *
 * "Something else" and "take something else off my plate" both mean the same
 * thing: the job they chose is not the job any more. `chat` is settled by the
 * recorded job id, so putting it back is how the Chief's question becomes the
 * live one again. Reopening drops the answer and re-derives, so a step still
 * backed by live state comes straight back done; it asks again, it does not
 * undo anything.
 */
export async function reopenSetupStep(step: SetupStep): Promise<void> {
  await api("/api/setup/reopen", { method: "POST", body: JSON.stringify({ step }) });
  forgetSetupView();
}

/** The routine the brief and routine cards ask for. The contract is the one
 *  `/api/setup/routine` answers: a template, an optional time, and the
 *  setup view back with the routine's id on it. */
export interface SetupRoutineResult {
  routineId?: string;
  runId?: string;
}

export async function createSetupRoutine(body: {
  template: "brief" | "triage" | "watch";
  time?: string;
  weekdaysOnly?: boolean;
  subject?: string;
}): Promise<SetupRoutineResult> {
  const result = await api("/api/setup/routine", { method: "POST", body: JSON.stringify(body) });
  forgetSetupView();
  return result ?? {};
}

/** Open a page in the person's real browser. The desktop bridge when there
 *  is one, a new tab when there is not. */
export async function openOutside(url: string): Promise<void> {
  const box = (globalThis as { muragebox?: { openExternal?: (link: string) => Promise<void> } }).muragebox;
  if (box?.openExternal) {
    await box.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
