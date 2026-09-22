// WHAT IS LEFT OF FIRST-RUN STATE IN THE CLIENT.
//
// Almost nothing, and that is the point. The version this replaces had three
// first-run surfaces up at once: a modal checklist, a three-choice welcome
// gate, and a floating offer for the same key the checklist was already
// asking for. Each one carried its own opinion about whether this install was
// new, and App.tsx had to pass a flag around to stop two of them appearing
// over each other.
//
// There is one opinion now and it is the server's. `view.firstRun` is derived
// on every read from things a used workspace cannot fake: a name on the
// profile, a bot that has answered, a saved key, a connected account, a
// routine, a teammate (`setupIsFirstRun`, shared/setup.ts). A restored backup
// trips all of them, which is the case that matters most. Interrupting
// somebody's restored workspace with a welcome screen is the worst bug this
// flow ever had, and the fix is that the client no longer has a second
// opinion to be wrong with.
//
// WHY THERE IS NO "SEEN" LATCH IN LOCAL STORAGE ANY MORE. SetupPanel kept one
// so that closing the modal did not bring it back at the next launch. It was
// a per-machine guess sitting next to an authoritative answer, and a guess
// that reads empty in a fresh browser is exactly the shape of the bug above.
// The phase bar is not a modal and closing it costs nothing, so closing is
// remembered for this session only. If the install genuinely has not been set
// up, the list is there again next time, and the conversation it tracks is
// still in the Chief's thread either way.

import { useSyncExternalStore } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import type { SetupStep, SetupView } from "../../shared/setup";

// ── the words the phase bar says ───────────────────────────────────────
// The five phases, named the way the approved simulation names them, in its
// own lower case: a pill reads `2 · what is here`, so the number is the
// sentence and the name finishes it. Short verbs, because this is a place in
// a conversation and not a table of contents.
//
// They are literals rather than lookups into FIRST_RUN_COPY. Four rows used
// to borrow their card's heading so a row and its card could not drift apart,
// and three of those four cards are now parked; borrowing from a parked card
// would put a phase on the bar for a step that no longer exists. The rows are
// built from `view.steps`, which comes off the wire, so an unknown id still
// draws a pill labelled with the id rather than vanishing from a list of what
// is left to do.
const PHASE_NAMES: Record<string, string> = {
  hello: "who you are",
  detect: "what is here",
  flux: "switch it on",
  chat: "first chat",
  flow: "do the thing",
};

/** The pill's own text. A middle dot, not a dash of any kind: the house rules
 *  ban em and en dashes outright and `first-run.test.ts` checks every string
 *  here for one. Not exported: a second caller building this string somewhere
 *  else is how a separator drifts, and the labels the pills carry are already
 *  on every row `firstRunPhaseRows` returns. */
function firstRunPhaseLabel(number: number, name: string): string {
  return `${number} · ${name}`;
}

export const FIRST_RUN_PHASES = {
  title: "Getting set up",
  close: "Close this list",
  state: {
    now: "Now",
    done: FIRST_RUN_COPY.settled,
    skipped: "Passed over",
    /** Something else has to happen first. Said plainly, and never as a
     *  sentence about what Murage cannot do. */
    blocked: "Waiting on something",
    todo: "",
  },
  /** The promise the rail carried in a line across its foot. The bar is a
   *  strip of pills above the app rather than a 272px column beside it, so
   *  there is nowhere sensible to print a sentence; it is read to assistive
   *  technology as the bar's description instead, and the close button is
   *  still there for everyone. The words do not change, because they are the
   *  whole promise: this is a list, not a gate. */
  footer: "Close this whenever you like. Nothing in it stops you using Murage, and all of it stays in your chat.",
} as const;

// ── opening it from anywhere ───────────────────────────────────────────
// A module latch rather than a store action, for the same reason SetupPanel
// had one: the composer's "/setup" command and the Settings row both just
// want the list on screen, and neither should have to own app state to say
// so. What changed is what opening MEANS. It is not a modal any more, so
// `openFirstRun` selects the Chief of Staff's thread and shows the phase bar
// above it. The bar itself does the selecting, because only a component
// inside the store can dispatch.

export interface FirstRunPhaseLatch {
  /** Closed by hand, this session. */
  closed: boolean;
  /** Bumped by every `openFirstRun()`. The bar acts on a number it has not
   *  seen, so two asks in a row are two asks. */
  requests: number;
}

const CLEAN: FirstRunPhaseLatch = { closed: false, requests: 0 };

let latch: FirstRunPhaseLatch = CLEAN;
const listeners = new Set<() => void>();

function publish(next: FirstRunPhaseLatch): void {
  latch = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show the first run: the Chief's thread, with the phase bar above it.
 *  `/setup` in the composer and the Settings row are the two callers. */
export function openFirstRun(): void {
  publish({ closed: false, requests: latch.requests + 1 });
}

/** They closed the bar. Nothing else changes: every card is still in the
 *  conversation and every step can still be finished from there. */
export function closeFirstRun(): void {
  if (latch.closed) return;
  publish({ ...latch, closed: true });
}

export function readFirstRunPhases(): FirstRunPhaseLatch {
  return latch;
}

/** Tests only. The latch is module state and a test that opened it would
 *  otherwise leak into the next one. */
export function resetFirstRunPhases(): void {
  latch = CLEAN;
}

export function useFirstRunPhaseLatch(): FirstRunPhaseLatch {
  return useSyncExternalStore(subscribe, readFirstRunPhases, readFirstRunPhases);
}

// ── the one question ───────────────────────────────────────────────────

/**
 * Is this install in its first run?
 *
 * The server's answer, passed straight through. Deliberately not derived
 * from `progress.done` or from the steps: half the list is true the moment
 * the app opens on a brand new machine, so counting finished steps says
 * "already set up" about an install that has done nothing.
 */
export function firstRunActive(view: SetupView | null | undefined): boolean {
  return view?.firstRun === true;
}

/**
 * Should the phase bar be on screen?
 *
 * No view means the server has not answered yet, and nothing is the right
 * answer to a question nobody has asked. A closed bar stays closed. An ask
 * from `/setup` or from Settings shows it on any install, which is the whole
 * point of those two entry points. Otherwise, and only otherwise, the
 * server's `firstRun` decides.
 */
export function firstRunPhasesVisible(
  view: SetupView | null | undefined,
  bar: FirstRunPhaseLatch,
): boolean {
  if (!view) return false;
  if (bar.closed) return false;
  if (bar.requests > 0) return true;
  // The server's own answer, when it has one. It knows the welcome card is in
  // the thread, which is the only honest test of "this flow started here and
  // is still going"; the latch below is a fallback for a view from a build
  // that predates the field.
  if (view.conversationLive === true) {
    started = true;
    return view.next !== null;
  }
  if (firstRunActive(view)) {
    started = true;
    return true;
  }
  // STARTING AND CONTINUING ARE DIFFERENT QUESTIONS, and this used to answer
  // both with `firstRun`.
  //
  // `firstRun` is "this install has never been set up", and one of the traces
  // it reads is a saved owner name. The first thing the flow does is ask for
  // that name. So the flag goes false at step one, BY DESIGN, and the rail
  // vanished for the whole rest of the run: the person watched a checklist
  // appear, tick one row, and disappear. Reported as the sidebar not updating
  // and there being no path forward, which is exactly what it looks like.
  //
  // server/setup-conversation.ts hit this first and says so in `conversationLive`.
  // This is the same rule on the client: once the flow has been seen to start,
  // it stays on screen until there is nothing left to do.
  return started && view.next !== null;
}

/**
 * Does the first run own the main view right now?
 *
 * THE RELEASE BLOCK THIS ANSWERS, WHICH IS THE ORIGINAL ONE WEARING A COAT.
 *
 * Every first-run card lives in the Chief of Staff's thread. `App.tsx`
 * renders `<NoEngines />` INSTEAD of that thread whenever no instance is
 * runnable, and its predicate is a deliberate copy of `runnable()` from
 * server/setup.ts — the very function that decides `nothingToThinkWith`. So
 * the two are true on exactly the same machine: the blank one. Murage ships
 * the Fuigo binary, so a bare computer has an instance reporting available
 * with an empty catalogue, which is runnable-false and engine-less at once.
 *
 * On that machine the person was shown "Install an AI engine to get started"
 * and "Murage doesn't ship a model of its own" — flatly contradicting the
 * first run's own "Murage brought its own AI with it" — above a list of CLIs
 * to install, a Check again button, and NO WAY TO ENTER A KEY. Meanwhile the
 * phase bar sat above it reading `2 · switch it on` with nothing to press.
 *
 * The flux step's own fix is real and already shipped in this branch: the
 * server plans `key` on every machine and `FirstRunFluxCard` swaps to its
 * blank-machine heading. It was simply never reachable, because the screen
 * that carries it was replaced before it could draw. That is the same defect
 * as the original block, one layer up: the card that takes a key was shown
 * only to machines that did not need one.
 *
 * THE TEST IS THE ONE THE PHASE BAR ALREADY USES, and that is the point.
 * `conversationLive` alone would be wrong and permanently so: it is true once
 * the welcome card is in the thread, and that card is never removed, so a
 * workspace that finished setup years ago would suppress the engine screen
 * for ever. Pairing it with `next !== null` is what the bar settled on for
 * the same reason, so the band and the view below it now answer the question
 * identically instead of disagreeing about whose screen this is.
 */
export function firstRunOwnsMainView(view: SetupView | null | undefined): boolean {
  if (!view) return false;
  return view.conversationLive === true && view.next !== null;
}

/** Whether the first run has been seen to start in this session. Sticky on
 *  purpose: see `firstRunPhasesVisible`. */
let started = false;

/** Tests own their own world; nothing in the app clears this. */
export function forgetFirstRunStarted(): void {
  started = false;
}

// ── the pills ──────────────────────────────────────────────────────────

export type FirstRunPhaseMark = "done" | "now" | "skipped" | "blocked" | "todo";

export interface FirstRunPhaseRow {
  id: SetupStep;
  /** Where this pill sits among the pills ACTUALLY SHOWN, counting from one.
   *  Not its index in `view.steps`: on a machine with nothing to think with
   *  the second step is not drawn and everything after it moves up. */
  number: number;
  /** The phase's name on its own, without the number. */
  name: string;
  /** What the pill reads. */
  label: string;
  mark: FirstRunPhaseMark;
  /** The short word the pill carries for assistive technology, or "" when the
   *  label says enough. */
  state: string;
}

/**
 * The pills, built from the view the server sent and from nothing else.
 *
 * No local list of steps: the order, the count and every status come off the
 * wire, so a step that changes on the server changes here without anybody
 * remembering to edit a second copy. The names are looked up by id with the
 * id itself as the fallback, so an unknown step still draws a pill rather
 * than vanishing from a list of what is left to do.
 *
 * THE NUMBERS ARE COMPUTED, NOT LITERAL, and that is the whole reason this
 * returns a `number` at all. On a machine with nothing to think with there is
 * no "what is here" to report, the server settles `detect` before it is ever
 * presented, and the approved simulation drops the phase rather than showing
 * a second pill already crossed off on a machine that never had anything.
 * Four pills, numbered one to four. `phases()` in the simulation does exactly
 * this.
 *
 * It is dropped only when the server agrees it is SETTLED. `nothingToThinkWith`
 * and an open `detect` would be a contradiction, and the honest answer to a
 * contradiction is to draw the step the person is still on rather than hide
 * the thing they are being asked to do.
 */
export function firstRunPhaseRows(view: SetupView): FirstRunPhaseRow[] {
  const shown = view.steps.filter(
    (step) =>
      !(
        step.id === "detect"
        && view.nothingToThinkWith === true
        && (step.status === "done" || step.status === "skipped")
      ),
  );
  return shown.map((step, index) => {
    const mark: FirstRunPhaseMark =
      step.status === "done"
        ? "done"
        : step.status === "skipped"
          ? "skipped"
          : step.status === "blocked"
            ? "blocked"
            : view.next === step.id
              ? "now"
              : "todo";
    const name = PHASE_NAMES[step.id] ?? step.id;
    return {
      id: step.id,
      number: index + 1,
      name,
      label: firstRunPhaseLabel(index + 1, name),
      mark,
      state: FIRST_RUN_PHASES.state[mark],
    };
  });
}
