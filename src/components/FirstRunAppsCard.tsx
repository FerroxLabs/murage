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
  const [done, setDone] = useState(settled);
  const gone = useRef(false);

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
      if (result.connected) await answerSetupStep("apps", slug);
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
      setDone(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    }
  };

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine>{copy.second}</FirstRunLine>

      <ul className="mt-3 grid gap-2">
        {copy.rows.map((row) => {
          const state = status[row.slug];
          const connected = Boolean(state?.connected && !state.pending);
          const waiting = busySlug === row.slug;
          return (
            <li key={row.slug} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-inset px-3 py-2">
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{row.label}</span>
                <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{row.why}</span>
              </span>
              {connected ? (
                <span className="text-[13px] text-success">{copy.connected}</span>
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
