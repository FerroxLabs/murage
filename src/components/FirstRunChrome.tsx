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

export function readSetupView(force = false): Promise<SetupView | null> {
  const now = Date.now();
  if (!force && cached && now - cached.at < FRESH_MS) return Promise.resolve(cached.view);
  if (!force && inFlight) return inFlight;
  const request = api("/api/setup")
    .then((view: SetupView) => {
      if (view && Array.isArray(view.steps)) cached = { view, at: Date.now() };
      return cached?.view ?? null;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

/** For tests and for a card that has just changed something. */
export function forgetSetupView(): void {
  cached = null;
  inFlight = null;
}

export function useSetupView(): { view: SetupView | null; refresh: () => void } {
  const [view, setView] = useState<SetupView | null>(cached?.view ?? null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void readSetupView(tick > 0).then((next) => {
      if (live && next) setView(next);
    });
    return () => {
      live = false;
    };
  }, [tick]);
  return { view, refresh: () => setTick((value) => value + 1) };
}

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
