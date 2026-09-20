// THE PROGRESS RAIL.
//
// A list down the right hand side of the chat saying where the first run has
// got to. It is not the first run: the first run is the conversation with the
// Chief of Staff, in the Chief's own thread, one card per step. This is the
// thing that lets a person see six steps rather than one card and know they
// are not lost.
//
// THREE RULES IT EXISTS TO KEEP.
//
//   It is not a gate. No backdrop, no `role="dialog"`, no focus trap, no
//   `inset-0`. It is a column beside the chat, and the app is fully usable
//   with it open, closed, or never looked at. One quiet line at the bottom
//   says exactly that, because a person who has been shown three setup
//   screens by other software has no reason to believe it.
//
//   It closes, and closing costs nothing. Every card is still in the
//   transcript afterwards, and `/setup` or the Settings row brings the rail
//   back.
//
//   Every row comes off the wire. The order, the count and each status are
//   the server's (`GET /api/setup`), so this file has no opinion about what
//   is finished. It cannot mark a step done that the workspace has not
//   actually earned, which is the property that made the old checklist
//   trustworthy and is worth keeping.

import { useEffect, useRef } from "react";
import { Check, X } from "lucide-react";

import {
  FIRST_RUN_RAIL,
  closeFirstRun,
  firstRunRailRows,
  firstRunRailVisible,
  useFirstRunRailLatch,
} from "@/lib/first-run";
import { useDesktopSurface } from "@/lib/use-surface";
import { useStore } from "@/state/store";
import type { SetupView } from "../../shared/setup";
import { useSetupView } from "./FirstRunChrome";

/**
 * The rail, wired up.
 *
 * Always mounted on a confirmed desktop and usually rendering nothing: it has
 * to be here to answer an `openFirstRun()` on an install that is NOT in its
 * first run, which is what `/setup` and the Settings row are for. The read of
 * `/api/setup` is the shared one every first-run card already uses, so this
 * adds no second request and no second opinion.
 */
export function FirstRunRail() {
  const { dispatch } = useStore();
  const { view } = useSetupView();
  const rail = useFirstRunRailLatch();
  // ASKED HERE TOO, not only by the caller.
  //
  // App.tsx mounts this behind `desktop === true`, and that is the gate that
  // matters. This is the second lock, so a future caller cannot reopen the
  // hole by mounting the rail somewhere new. A phone reaching the app through
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
    if (rail.requests === 0 || rail.requests === handled.current) return;
    if (!chiefBotId) return;
    handled.current = rail.requests;
    dispatch({ type: "select", id: chiefBotId });
  }, [rail.requests, chiefBotId, dispatch]);

  if (desktop !== true || !view || !firstRunRailVisible(view, rail)) return null;
  return <FirstRunRailBody view={view} onClose={closeFirstRun} />;
}

const ROW_TONE: Record<string, string> = {
  done: "text-ink-secondary",
  now: "text-ink font-medium",
  skipped: "text-ink-secondary",
  blocked: "text-ink",
  todo: "text-ink-secondary",
};

/**
 * The rail with nothing wired to it, so a test can hand it a view and read
 * what a person would read. Same split as the rest of this app's panels.
 */
export function FirstRunRailBody({ view, onClose }: { view: SetupView; onClose: () => void }) {
  const rows = firstRunRailRows(view);
  return (
    <aside
      aria-label={FIRST_RUN_RAIL.title}
      data-first-run-rail=""
      // `hidden md:flex`: below md the chat needs the whole width, and the
      // first run is complete without this. Every card, every field and every
      // button is in the conversation; the rail only says how far along it is.
      className="hidden w-[272px] shrink-0 flex-col overflow-y-auto border-l border-hairline/40 bg-panel md:flex"
    >
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">{FIRST_RUN_RAIL.title}</h2>
          <p className="mt-0.5 text-[12px] text-ink-secondary">
            {FIRST_RUN_RAIL.progress(view.progress.done, view.progress.total)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={FIRST_RUN_RAIL.close}
          className="-mr-1 rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <ol className="px-2 py-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2">
            <span aria-hidden="true" className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
              {row.mark === "done" ? (
                <Check size={14} className="text-success" />
              ) : (
                <span
                  className={
                    row.mark === "now"
                      ? "block h-2 w-2 rounded-full bg-accent"
                      : "block h-2 w-2 rounded-full border border-hairline"
                  }
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13.5px] leading-snug ${ROW_TONE[row.mark] ?? "text-ink"}`}>
                {row.label}
              </span>
              {row.state && (
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-secondary">{row.state}</span>
              )}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-auto px-4 pb-4 pt-3 text-[12px] leading-relaxed text-ink-secondary">
        {FIRST_RUN_RAIL.footer}
      </p>
    </aside>
  );
}
