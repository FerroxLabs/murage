// THE PRESS IS ANSWERED BEFORE THE NETWORK IS.
//
// The owner walked a fresh Cloud home and two presses said nothing for
// seconds: Continue on the name card left a grey "Saving" pill with no
// motion, and picking "Brief me every morning" changed nothing at all. On
// Cloud every request goes through the tunnel and the home proxy, so the
// answer can take a while; the person must never be the one wondering
// whether the press landed.
//
// So the card that was pressed draws this in the same render as the press:
// the Chief working and a few plain words saying what is happening. It is
// state the click handler sets, never something a response turns on.
// With reduced motion asked for, the Chief holds still and the dots do not
// pulse: the words alone carry it.
import { useEffect, useMemo, useState } from "react";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { WorkingDots } from "./WorkingIndicator";

/** After this long the line adds that it is still going. */
export const FIRST_RUN_SLOW_AFTER_MS = 5_000;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function FirstRunWorking({ bot, words }: { bot?: Bot | null; words: string }) {
  const still = useMemo(prefersReducedMotion, []);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), FIRST_RUN_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="first-run-working"
      data-motion={still ? "static" : "animated"}
      className="mt-3 flex items-center gap-2.5 rounded-xl bg-inset px-3 py-2 text-[13.5px] text-ink"
    >
      {bot ? (
        <BotAvatar bot={bot} state="thinking" size={28} forward={false} trackPointer={false} animated={!still} />
      ) : null}
      <span className="min-w-0">
        <span className="block">{words}</span>
        {slow && <span className="block text-[12.5px] text-ink-secondary">{t("firstRun.press.slow")}</span>}
      </span>
      {!still && <WorkingDots size={4} className="ml-auto text-ink-secondary" />}
    </div>
  );
}
