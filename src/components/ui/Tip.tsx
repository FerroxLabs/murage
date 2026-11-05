// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tip: the app's one tooltip (UX overhaul slice 4, lane L4C; Phase 2 spec 3),
// in place of the browser's slow, unstyled title="". It shows 300 ms after the
// pointer rests on the control, at once when the control takes keyboard focus,
// and never for a touch. One line, at most 80 characters, with an optional key
// cap. The words are also the control's spoken name (aria-label) and the tip
// is linked with aria-describedby, so a screen reader gets them without the
// hover. Drawn above the control, or below it when there is no room above;
// kept inside the window at the sides.
import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactElement } from "react";

export const TIP_HOVER_MS = 300;
export const TIP_MAX_CHARS = 80;
const EDGE = 8;

export type TipSide = "above" | "below";

/** Where the tip goes: above unless it would leave the window, then below; its left edge kept inside the window. */
export function placeTip(anchor: { top: number; bottom: number; left: number; width: number }, tip: { width: number; height: number }, viewportWidth: number): { side: TipSide; top: number; left: number } {
  const side: TipSide = anchor.top - tip.height - EDGE >= 0 ? "above" : "below";
  const top = side === "above" ? anchor.top - tip.height - 6 : anchor.bottom + 6;
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, viewportWidth - tip.width - EDGE));
  return { side, top, left };
}

/** One line: longer words are cut at 80 characters (tip-lint keeps the source under it). */
export const tipLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= TIP_MAX_CHARS ? line : `${line.slice(0, TIP_MAX_CHARS - 1).trimEnd()}…`;
};

interface TipChildProps {
  "aria-label"?: string;
  "aria-describedby"?: string;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  ref?: unknown;
}

export interface TipProps {
  text: string;
  /** A key cap shown after the words, like "Esc" or "Cmd K". */
  keys?: string;
  /** One focusable control. */
  children: ReactElement<TipChildProps>;
  /** Tests draw it open. */
  initialOpen?: boolean;
}

export function Tip({ text, keys, children, initialOpen = false }: TipProps) {
  const id = useId();
  const line = tipLine(text);
  const [open, setOpen] = useState(initialOpen);
  const [place, setPlace] = useState<{ side: TipSide; top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const hide = useCallback(() => { clear(); setOpen(false); }, []);
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide]);
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    setPlace(placeTip(a, t, window.innerWidth));
  }, [open]);

  const own = children.props;
  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => { anchorRef.current = node; },
    "aria-label": own["aria-label"] ?? line,
    "aria-describedby": [own["aria-describedby"], open ? id : undefined].filter(Boolean).join(" ") || undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      if (event.pointerType === "touch") return;
      clear();
      timer.current = setTimeout(() => setOpen(true), TIP_HOVER_MS);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => { own.onPointerLeave?.(event); hide(); },
    onPointerDown: (event: PointerEvent<HTMLElement>) => { own.onPointerDown?.(event); hide(); },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      // Keyboard focus only: a click or a tap also focuses, and that must not show it.
      let keyboard = true;
      try { keyboard = event.currentTarget.matches(":focus-visible"); } catch { /* older engines: show it */ }
      if (keyboard) { clear(); setOpen(true); }
    },
    onBlur: (event: FocusEvent<HTMLElement>) => { own.onBlur?.(event); hide(); },
  });
  return (
    <>
      {child}
      {open && (
        <span
          ref={tipRef}
          id={id}
          role="tooltip"
          data-tip
          data-side={place?.side ?? "above"}
          style={place ? { top: place.top, left: place.left } : { visibility: "hidden", top: 0, left: 0 }}
          className="pointer-events-none fixed z-[90] flex max-w-[calc(100vw-16px)] items-center gap-2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[12px] leading-4 text-app shadow-lg"
        >
          {line}
          {keys && <kbd className="rounded border border-app/30 px-1 font-sans text-[11px]">{keys}</kbd>}
        </span>
      )}
    </>
  );
}
