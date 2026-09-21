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
// The rail is not a modal and closing it costs nothing, so closing is
// remembered for this session only. If the install genuinely has not been set
// up, the list is there again next time, and the conversation it tracks is
// still in the Chief's thread either way.

import { useSyncExternalStore } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import type { SetupStep, SetupView } from "../../shared/setup";

// ── the words the rail says ────────────────────────────────────────────
// Four of the six rows are named by the card they track, imported from the
// one copy module rather than re-typed here, so a row and its card cannot
// drift apart. Only "hello" and "agents" need a name of their own: their
// cards open with a sentence rather than a heading.
const STEP_LABELS: Record<string, string> = {
  hello: "Say hello",
  agents: "See what is already here",
  flux: FIRST_RUN_COPY.flux.key.title,
  apps: FIRST_RUN_COPY.apps.apps.title,
  brief: FIRST_RUN_COPY.brief.brief.title,
  routines: FIRST_RUN_COPY.routines["more-routines"].title,
};

export const FIRST_RUN_RAIL = {
  title: "Getting set up",
  close: "Close this list",
  /** A count of steps, which is the one number this flow is allowed. */
  progress: (done: number, total: number) => `${done} of ${total} done`,
  state: {
    now: "Now",
    done: FIRST_RUN_COPY.settled,
    skipped: "Passed over",
    /** Something else has to happen first. Said plainly, and never as a
     *  sentence about what Murage cannot do. */
    blocked: "Waiting on something",
    todo: "",
  },
  /** The quiet line at the bottom. The whole promise of the rail is in it:
   *  this is a list, not a gate, and the app underneath already works. */
  footer: "Close this whenever you like. Nothing in it stops you using Murage, and all of it stays in your chat.",
} as const;

// ── opening it from anywhere ───────────────────────────────────────────
// A module latch rather than a store action, for the same reason SetupPanel
// had one: the composer's "/setup" command and the Settings row both just
// want the list on screen, and neither should have to own app state to say
// so. What changed is what opening MEANS. It is not a modal any more, so
// `openFirstRun` selects the Chief of Staff's thread and shows the rail
// beside it. The rail itself does the selecting, because only a component
// inside the store can dispatch.

export interface FirstRunRailLatch {
  /** Closed by hand, this session. */
  closed: boolean;
  /** Bumped by every `openFirstRun()`. The rail acts on a number it has not
   *  seen, so two asks in a row are two asks. */
  requests: number;
}

const CLEAN: FirstRunRailLatch = { closed: false, requests: 0 };

let latch: FirstRunRailLatch = CLEAN;
const listeners = new Set<() => void>();

function publish(next: FirstRunRailLatch): void {
  latch = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Show the first run: the Chief's thread, with the progress rail beside it.
 *  `/setup` in the composer and the Settings row are the two callers. */
export function openFirstRun(): void {
  publish({ closed: false, requests: latch.requests + 1 });
}

/** They closed the rail. Nothing else changes: every card is still in the
 *  conversation and every step can still be finished from there. */
export function closeFirstRun(): void {
  if (latch.closed) return;
  publish({ ...latch, closed: true });
}

export function readFirstRunRail(): FirstRunRailLatch {
  return latch;
}

/** Tests only. The latch is module state and a test that opened it would
 *  otherwise leak into the next one. */
export function resetFirstRunRail(): void {
  latch = CLEAN;
}

export function useFirstRunRailLatch(): FirstRunRailLatch {
  return useSyncExternalStore(subscribe, readFirstRunRail, readFirstRunRail);
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
 * Should the rail be on screen?
 *
 * No view means the server has not answered yet, and nothing is the right
 * answer to a question nobody has asked. A closed rail stays closed. An ask
 * from `/setup` or from Settings shows it on any install, which is the whole
 * point of those two entry points. Otherwise, and only otherwise, the
 * server's `firstRun` decides.
 */
export function firstRunRailVisible(
  view: SetupView | null | undefined,
  rail: FirstRunRailLatch,
): boolean {
  if (!view) return false;
  if (rail.closed) return false;
  if (rail.requests > 0) return true;
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

/** Whether the first run has been seen to start in this session. Sticky on
 *  purpose: see `firstRunRailVisible`. */
let started = false;

/** Tests own their own world; nothing in the app clears this. */
export function forgetFirstRunStarted(): void {
  started = false;
}

// ── the rows ───────────────────────────────────────────────────────────

export type FirstRunRailMark = "done" | "now" | "skipped" | "blocked" | "todo";

export interface FirstRunRailRow {
  id: SetupStep;
  label: string;
  mark: FirstRunRailMark;
  /** The short word under the label, or "" when the row says enough. */
  state: string;
}

/**
 * The six rows, built from the view the server sent and from nothing else.
 *
 * No local list of steps: the order, the count and every status come off the
 * wire, so a step that changes on the server changes here without anybody
 * remembering to edit a second copy. The labels are looked up by id with the
 * id itself as the fallback, so an unknown step still draws a row rather
 * than vanishing from a list of what is left to do.
 */
export function firstRunRailRows(view: SetupView): FirstRunRailRow[] {
  return view.steps.map((step) => {
    const mark: FirstRunRailMark =
      step.status === "done"
        ? "done"
        : step.status === "skipped"
          ? "skipped"
          : step.status === "blocked"
            ? "blocked"
            : view.next === step.id
              ? "now"
              : "todo";
    return {
      id: step.id,
      label: STEP_LABELS[step.id] ?? step.id,
      mark,
      state: FIRST_RUN_RAIL.state[mark],
    };
  });
}
