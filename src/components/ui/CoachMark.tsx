// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One coach mark (lane L4C), loaded by CoachMarks.tsx only when a hint is due.
// A small card beside the control it explains, with "Got it". Not a modal: it
// takes no focus and the page keeps working. It goes with Got it, Esc, a click
// anywhere else, or when its control leaves the page the window gets too narrow, or help, a menu or a window opens.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { HINT_MIN_WIDTH, pageCovered } from "@/lib/hints-seen";
import { placeTip } from "./Tip";

export interface CoachMarkProps {
  anchor: HTMLElement;
  textKey: string;
  params?: Record<string, string>;
  onDone: () => void;
}

export function CoachMark({ anchor, textKey, params, onDone }: CoachMarkProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setPlace(placeTip(anchor.getBoundingClientRect(), ref.current.getBoundingClientRect(), window.innerWidth));
  }, [anchor]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDone(); };
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onDone(); };
    const gone = setInterval(() => { if (!anchor.isConnected || window.innerWidth < HINT_MIN_WIDTH || pageCovered()) onDone(); }, 500);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => { clearInterval(gone); window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown, true); };
  }, [anchor, onDone]);
  return (
    <div
      ref={ref}
      role="note"
      aria-live="polite"
      data-coach-mark
      style={place ?? { visibility: "hidden", top: 0, left: 0 }}
      className="coach-in fixed z-[79] flex w-[280px] max-w-[calc(100vw-16px)] flex-col gap-2 rounded-xl border border-hairline/50 bg-panel p-3 text-[13px] leading-5 text-ink shadow-2xl"
    >
      <p>{t(textKey as LocaleKey, params)}</p>
      <button type="button" onClick={onDone}
        className="min-h-9 self-end rounded-lg bg-accent px-3 text-[13px] font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
        {t("ux.l4c.coach.gotIt")}
      </button>
    </div>
  );
}
