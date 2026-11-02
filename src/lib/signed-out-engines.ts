// AN ENGINE THAT IS HERE, READY, AND SIGNED OUT OF.
//
// THE DEFECT THIS EXISTS FOR. `setupSignedOutReading` (server/setup.ts) asks
// every driver that will answer whether anybody is signed in, and it is
// careful about it: `authenticated === false` and never `!== true`, because
// most drivers do not probe and calling those signed out emptied the engine
// list on installs that worked perfectly well. Our own shipped engine is
// excluded outright, because it answers `false` whenever nobody has logged
// into Flux. So the list is narrow, live, and right.
//
// And exactly one component ever read it: the first-run card. On day two,
// when a Claude Code login expires, the whole product says nothing. The
// engine is present, it is enabled, it is "available", and the first thing
// asked of it fails. The banner added for the crash covers a dead engine
// PROCESS; nothing at all covered a live engine nobody is signed in to.
//
// WHY IT MAY BADGE WHEN THE FAILED-ACTIVITY ROW MAY NOT. The Inbox reads an
// `activity` row saying a turn could not sign in, and that row is a log line:
// there is nothing on it to resolve, so a count built from it could never
// come down again, and a badge that cannot reach zero is what made the
// original number unreadable. THIS is the opposite: a live probe, re-read on
// a poll, which empties itself the moment somebody signs in. FirstRunCard
// says so in its own words: "a sign-in finished in another window empties
// this list".
import { firstRunOwnsMainView } from "@/lib/first-run";
import type { SetupEngineUser, SetupView } from "../../shared/setup";

export interface SignedOutEngineRow {
  id: string;
  name: string;
  /** The command that signs this engine in, when its driver declares one.
   *  The driver is the only thing that knows it, which is why the row
   *  carries it rather than the card hardcoding per-engine copy. */
  signInCommand?: string;
  /** The bots that run on it now. Never empty on a row: see below. */
  usedBy: readonly SetupEngineUser[];
}

/**
 * The engines to report, or none.
 *
 * SILENT WHILE THE FIRST RUN OWNS THE SCREEN, which shows Fuigo and Flux only
 * and asks for no other engine's sign-in (1.0.14). The
 * predicate is `firstRunOwnsMainView`, the same one App.tsx uses to decide
 * whose screen it is, so the two cannot disagree about whether the flow is
 * still running.
 */
export function signedOutEngineRows(view: SetupView | null | undefined): SignedOutEngineRow[] {
  if (!view || firstRunOwnsMainView(view)) return [];
  // ONLY AN ENGINE A BOT RUNS ON (FUIGO-FIRST-SIGNIN-PLACEMENT, Sean 11-02).
  // Flux Router and Fuigo are front and center; another engine is offered in
  // Settings and never pushed. A bot on a signed-out engine fails its turns,
  // so the owner is told and pointed at fixing that bot. One nobody uses
  // never reaches Needs you, its count or the tray.
  return view.signedOutAgents.flatMap((agent) => (agent.usedBy?.length ? [{
    id: agent.id,
    name: agent.name,
    ...(agent.signInCommand ? { signInCommand: agent.signInCommand } : {}),
    usedBy: agent.usedBy,
  }] : []));
}

/**
 * EVERY ENGINE THE SETUP VIEW READ AS SIGNED OUT, USED OR NOT.
 *
 * Only for `engineNeed`'s fallback (engine-need.ts), which adds a row for a
 * signed-out engine the setup view did not report. An engine the view did
 * report and no bot uses is left out on purpose, so that fallback must not
 * bring it back: it reads this list, never the filtered rows.
 */
export function signedOutEngineIds(view: SetupView | null | undefined): Array<{ id: string }> {
  if (!view || firstRunOwnsMainView(view)) return [];
  return view.signedOutAgents.map((agent) => ({ id: agent.id }));
}

/**
 * Fold them into the numbers the Inbox already publishes.
 *
 * BOTH COUNTS OR NEITHER. `decisions` is the umbrella the sidebar badge
 * shows and the three segment counts sum to it. Adding to `connections`
 * alone would put a number on a tab that the sidebar total cannot explain,
 * which is a defect this Inbox has already shipped once.
 */
export function withSignedOutEngines<T extends { decisions: number; connections: number }>(
  page: T,
  rows: ReadonlyArray<SignedOutEngineRow | { id: string }>,
): T {
  if (rows.length === 0) return page;
  return { ...page, decisions: page.decisions + rows.length, connections: page.connections + rows.length };
}

/**
 * The counts every Inbox tab reads, whichever tab is open.
 *
 * The signed-out rows were only worked out on the two tabs that SHOW them
 * (Needs you and Connections), and the counts were folded from that same
 * list. So on Routines, Results and All the tabs read "Needs you (1),
 * Connections (0)" and on Needs you "(3), (2)" for the same Inbox. The rows
 * a tab shows and the numbers every tab shows are now separate: the numbers
 * always count every engine still signed out of, less the ones answered here.
 */
export function inboxTabCounts<T extends { decisions: number; connections: number }>(
  page: T | null,
  view: SetupView | null | undefined,
  answered: ReadonlySet<string>,
  /** Live rows of the same kind (engine-need.ts): one engine or Flux problem, or none. */
  extra: ReadonlyArray<{ id: string }> = [],
): T | null {
  if (!page) return null;
  return withSignedOutEngines(page, [...signedOutEngineRows(view).filter(row => !answered.has(`engine:${row.id}`)), ...extra]);
}
