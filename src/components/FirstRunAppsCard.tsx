// CARD FOUR: the accounts the work actually lives in.
//
// BEFORE any routine, and that order is the point. A morning brief with
// nothing connected to read is a demonstration; a morning brief over a real
// inbox and a real calendar is the product. Each row says WHY in a few
// words, because "Gmail" with a button beside it is a logo and a chore.
//
// One click each. The connecting itself is `connectApp`, the standalone
// version of what the connected apps dialog does, so the card holds no
// OAuth knowledge of its own.

import { useEffect, useRef, useState } from "react";

import { connectApp, readConnectAppStatus, type ConnectAppStatus } from "@/lib/connect-app";
import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { useDesktopSurface } from "@/lib/use-surface";
import { api } from "@/state/store";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  answerSetupStep,
  failureText,
  openOutside,
  skipSetupStep,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.apps.apps;

export function FirstRunAppsCard({ settled }: { settled: boolean }) {
  const desktop = useDesktopSurface();
  const [status, setStatus] = useState<Record<string, ConnectAppStatus>>({});
  const [busySlug, setBusySlug] = useState("");
  const [failure, setFailure] = useState("");
  // A CARD SETTLES FROM THE SERVER, NOT ONLY FROM THIS COMPONENT.
  //
  // This was `useState(settled)`, which reads the prop ONCE. `settled` is set
  // by the server when the step lands, and that can happen after this card
  // first rendered: another surface answered it, the step completed on its
  // own, or the app reopened mid-flow. The card went on showing an open form
  // with live buttons for a question that was already answered, which is most
  // of why the thread read as a wall of unfinished business.
  //
  // Derived instead, so the two ways a card can be finished agree: this
  // component did it, or the server says so.
  const [acted, setActed] = useState(false);
  const done = acted || settled;
  const gone = useRef(false);

  // WHAT THIS SESSION CONNECTED, as opposed to what simply arrived.
  //
  // Connected apps travel with the Flux Router key rather than with the
  // computer, so a key that already has Gmail on it shows Gmail working on a
  // machine that has never seen it. Saying only "Connected" there reads as a
  // lie about something this machine did. The honest split is the one the
  // card can actually make: a row this person just pressed is theirs, and a
  // row that was on before they touched anything came with the key.
  const [justConnected, setJustConnected] = useState<readonly string[]>([]);

  useEffect(() => {
    gone.current = false;
    // What is already connected, so a person who did this last week is not
    // asked to do it again.
    for (const row of copy.rows) {
      void readConnectAppStatus(row.slug, api).then((next) => {
        if (!gone.current && next) setStatus((current) => ({ ...current, [row.slug]: next }));
      });
    }
    return () => {
      gone.current = true;
    };
  }, []);

  const connect = async (slug: string) => {
    if (busySlug || desktop !== true) return;
    setBusySlug(slug);
    setFailure("");
    setStatus((current) => ({ ...current, [slug]: { connected: false, pending: true, status: "INITIATED" } }));
    try {
      const result = await connectApp(slug, {
        request: api,
        openExternal: openOutside,
        desktop,
        cancelled: () => gone.current,
      });
      if (gone.current) return;
      setStatus((current) => ({ ...current, [slug]: result }));
      if (result.connected) {
        setJustConnected((current) => (current.includes(slug) ? current : [...current, slug]));
        await answerSetupStep("apps", slug);
      }
    } catch (cause) {
      if (!gone.current) setFailure(failureText(cause, copy.failure));
    } finally {
      if (!gone.current) setBusySlug("");
    }
  };

  const notNow = async () => {
    if (busySlug) return;
    setFailure("");
    try {
      await skipSetupStep("apps");
      setActed(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>

      {copy.rows.some((row) => {
        const state = status[row.slug];
        return Boolean(state?.connected && !state.pending) && !justConnected.includes(row.slug);
      }) && <FirstRunLine quiet>{copy.cameWithKey}</FirstRunLine>}

      <ul className="mt-3 grid gap-2">
        {copy.rows.map((row) => {
          const state = status[row.slug];
          const connected = Boolean(state?.connected && !state.pending);
          const mine = justConnected.includes(row.slug);
          const waiting = busySlug === row.slug;
          return (
            <li key={row.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-inset px-3 py-2">
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{row.label}</span>
                <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{row.why}</span>
              </span>
              {connected ? (
                <span className="text-[13px] text-success">{mine ? copy.connected : copy.connectedElsewhere}</span>
              ) : desktop === true ? (
                <button
                  type="button"
                  disabled={Boolean(busySlug) || done}
                  onClick={() => void connect(row.slug)}
                  className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
                >
                  {waiting ? copy.connecting : copy.connect}
                </button>
              ) : (
                // Never a button that cannot work. A phone looking at this
                // workspace is told where the switch is instead.
                <span className="text-[12.5px] text-ink-secondary">{copy.desktopOnly}</span>
              )}
            </li>
          );
        })}
      </ul>

      <FirstRunLine quiet>{copy.trust}</FirstRunLine>
      <FirstRunFailure message={failure} />

      {!done && (
        <button type="button" disabled={Boolean(busySlug)} onClick={() => void notNow()} className={`mt-2 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {copy.dismiss}
        </button>
      )}
    </FirstRunBubble>
  );
}
