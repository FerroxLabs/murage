// THE PHASE BAR.
//
// A strip of numbered pills across the top of the app saying where the first
// run has got to. It is not the first run: the first run is the conversation
// with the Chief of Staff, in the Chief's own thread, one card per step. This
// is the thing that lets a person see five steps rather than one card and
// know they are not lost.
//
// WHAT IT REPLACED, AND WHY. This was a 272px column down the right hand side
// (FirstRunRail.tsx). The approved simulation for 0.1.58 puts the phases in a
// row above the window instead, and the owner ruled for the simulation. The
// bar is the better shape for what it now has to say: the phases are numbered
// and the numbers are COMPUTED, because a machine with nothing to think with
// never sees "what is here" and its four phases are numbered one to four. A
// horizontal strip carries a numbered sequence the way a vertical checklist
// carries a list of things still outstanding, and the flow is a sequence.
//
// THREE RULES IT KEEPS FROM THE RAIL.
//
//   It is not a gate. No backdrop, no `role="dialog"`, no focus trap, no
//   `inset-0`. It is a band above the app, and the app is fully usable with
//   it open, closed, or never looked at. The sentence that said so out loud
//   is still said, to assistive technology, as the bar's description; a
//   28px strip does not look like a gate to anybody who can see it.
//
//   It closes, and closing costs nothing. Every card is still in the
//   transcript afterwards, and `/setup` or the Settings row brings the bar
//   back.
//
//   Every pill comes off the wire. The order, the count and each status are
//   the server's (`GET /api/setup`), so this file has no opinion about what
//   is finished. It cannot mark a phase done that the workspace has not
//   actually earned, which is the property that made the old checklist
//   trustworthy and is worth keeping.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import {
  FIRST_RUN_PHASES,
  closeFirstRun,
  firstRunPhaseRows,
  firstRunPhasesVisible,
  useFirstRunPhaseLatch,
} from "@/lib/first-run";
import { useDesktopSurface } from "@/lib/use-surface";
import { useStore } from "@/state/store";
import type { SetupView } from "../../shared/setup";
import { useSetupView } from "./FirstRunChrome";

/**
 * The bar, wired up.
 *
 * Always mounted on a confirmed desktop and usually rendering nothing: it has
 * to be here to answer an `openFirstRun()` on an install that is NOT in its
 * first run, which is what `/setup` and the Settings row are for. The read of
 * `/api/setup` is the shared one every first-run card already uses, so this
 * adds no second request and no second opinion.
 */
export function FirstRunPhases() {
  const { dispatch } = useStore();
  const { view } = useSetupView();
  const bar = useFirstRunPhaseLatch();
  // ASKED HERE TOO, not only by the caller.
  //
  // App.tsx mounts this behind `desktop === true`, and that is the gate that
  // matters. This is the second lock, so a future caller cannot reopen the
  // hole by mounting the bar somewhere new. A phone reaching the app through
  // the browser door is a confirmed remote surface, and `undefined` is not a
  // desktop either: the unknown answer withholds, which is the whole reason
  // the original welcome screen leaked onto a paired phone.
  const desktop = useDesktopSurface();
  const chiefBotId = view?.chiefBotId;
  const handled = useRef(0);

  // Asking for setup now means "take me to my chief of staff", because that
  // is where the first run actually is. Held until the view has answered with
  // a Chief to select, rather than consumed and lost: an ask made while the
  // app was still connecting is still an ask.
  useEffect(() => {
    if (bar.requests === 0 || bar.requests === handled.current) return;
    if (!chiefBotId) return;
    handled.current = bar.requests;
    dispatch({ type: "select", id: chiefBotId });
  }, [bar.requests, chiefBotId, dispatch]);

  if (desktop !== true || !view || !firstRunPhasesVisible(view, bar)) return null;
  return <FirstRunPhasesBody view={view} onClose={closeFirstRun} />;
}

// A finished phase should LOOK finished at a glance, without reading it, and
// the one they are on should be the only thing with any colour in it. The
// simulation dims what is behind and accents what is current; this is that,
// in the app's own tokens.
const PILL_TONE: Record<string, string> = {
  done: "border-hairline/40 text-ink-secondary opacity-60",
  now: "border-accent text-accent font-semibold",
  skipped: "border-hairline/40 text-ink-secondary opacity-60 line-through decoration-ink-secondary/50",
  blocked: "border-hairline text-ink",
  todo: "border-hairline/40 text-ink-secondary",
};

const DESCRIPTION_ID = "first-run-phases-description";

/**
 * The bar with nothing wired to it, so a test can hand it a view and read
 * what a person would read. Same split as the rest of this app's panels.
 */
export function FirstRunPhasesBody({ view, onClose }: { view: SetupView; onClose: () => void }) {
  const rows = firstRunPhaseRows(view);
  return (
    <nav
      aria-label={FIRST_RUN_PHASES.title}
      aria-describedby={DESCRIPTION_ID}
      data-first-run-phases=""
      className="flex w-full shrink-0 flex-wrap items-center gap-2 border-b border-hairline/40 bg-panel px-3 py-2"
    >
      {/* The promise, in the words the rail printed across its foot. Not
          shown: a strip this size is plainly not blocking anything, and a
          sentence of reassurance beside five pills is noise. It is still
          SAID, to anybody navigating by the accessibility tree, who cannot
          see how small it is. */}
      <p id={DESCRIPTION_ID} className="sr-only">
        {FIRST_RUN_PHASES.footer}
      </p>

      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            // The phase they are on, said to assistive technology in the one
            // word ARIA has for it rather than only in a border colour.
            aria-current={row.mark === "now" ? "step" : undefined}
            className={`rounded-full border px-2.5 py-1 text-[11.5px] leading-none ${PILL_TONE[row.mark] ?? "border-hairline/40 text-ink-secondary"}`}
          >
            {row.label}
            {row.state ? <span className="sr-only">{`, ${row.state}`}</span> : null}
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={onClose}
        aria-label={FIRST_RUN_PHASES.close}
        className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}
