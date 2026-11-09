// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE MURAGE LOGO WITH EMBER, as one React component. The mark and the wordmark come from the same data the splash
// and the tip header use (shared/murage-lockup.mjs), so there is one logo. Ember is the real avatar component.
//
// Three ways to wear it:
//   "none"    the plain logo, nothing else (the first-load picture)
//   "static"  Ember in place, finished
//   "pop"     the welcome: the logo stands still, Ember pops up from behind the mark's lower left with one soft
//             overshoot, then blinks once. Motion is done by 1.5 s. No sound, no loop.
// With reduced motion every mode shows the finished picture: Ember in place, no pop, no blink.

import { useEffect, useRef, useState } from "react";

import {
  BRAND_ORANGE,
  GALAXY_CORE,
  GALAXY_PATHS,
  GALAXY_STROKE,
  LOCKUP_FRAME,
  MARK_BOX,
  MARK_SCALE,
  WORDMARK_PATH,
  emberBox,
} from "../../shared/murage-lockup.mjs";
import { EmberAvatar, type EmberAvatarHandle } from "./Avatar";
import type { EmberColor } from "@/lib/mascot";

/** The welcome's motion, in one place. The animation starts at popDelayMs, lands by popDelayMs + popMs, blinks once at
 *  blinkAtMs, and nothing moves after doneMs. */
export const LOCKUP_TIMING = {
  popDelayMs: 100,
  popMs: 500,
  blinkAtMs: 950,
  doneMs: 1500,
} as const;

/** The pose Ember wears: happy, one face pinned so nothing drifts, body held still. */
export const LOCKUP_EMBER_EXPRESSION = 19;

export type LockupMode = "none" | "static" | "pop";

export function lockupReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The reduced-motion preference, followed live: turning it on while the welcome is open stills it at once. */
export function useLockupReducedMotion(): boolean {
  const [reduced, setReduced] = useState(lockupReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return reduced;
}

/** True while the app is on its light skin (document.documentElement.dataset.skin, set before first paint). */
export function useLightSkin(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.dataset.skin === "light";
  const [light, setLight] = useState(read);
  useEffect(() => {
    setLight(read());
    if (typeof MutationObserver === "undefined") return;
    const watch = new MutationObserver(() => setLight(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    return () => watch.disconnect();
  }, []);
  return light;
}

export interface MurageLockupProps {
  /** The mark's height in px. Default 84. */
  size?: number;
  mode?: LockupMode;
  /** Ember's colour and body. The default is the brand orange flame. */
  color?: EmberColor;
  body?: string | null;
  className?: string;
  /** Force a skin instead of reading the app's. */
  light?: boolean;
}

export function MurageLockup({ size = 84, mode = "none", color = "orange", body = null, className, light }: MurageLockupProps) {
  const skinLight = useLightSkin();
  const isLight = light ?? skinLight;
  const still = useLockupReducedMotion();
  const pop = mode === "pop" && !still;
  const showEmber = mode !== "none";
  const handle = useRef<EmberAvatarHandle>(null);

  useEffect(() => {
    if (!pop) return;
    const timer = setTimeout(() => handle.current?.blink(), LOCKUP_TIMING.blinkAtMs);
    return () => clearTimeout(timer);
  }, [pop]);

  const k = size / MARK_BOX.size;
  const ink = isLight ? "#111111" : "#ffffff";
  const ground = isLight ? "#f7f7f8" : "#111111";
  const box = emberBox();
  const emberPx = Math.round(box.size * k);
  const { x, y, width, height } = LOCKUP_FRAME;

  return (
    <span
      className={`murage-lockup${className ? ` ${className}` : ""}`}
      data-ink={ink}
      data-ground={ground}
      data-mode={mode}
      role="img"
      aria-label={showEmber ? "Murage, with Ember" : "Murage"}
      style={{ position: "relative", display: "inline-block", width: width * k, maxWidth: "100%", aspectRatio: `${width} / ${height}`, lineHeight: 0, ["--ml-ground" as string]: ground }}
    >
      <svg width="100%" height="100%" viewBox={`${x} ${y} ${width} ${height}`} aria-hidden="true" focusable="false" style={{ display: "block" }}>
        <g transform={`translate(${MARK_BOX.x} ${MARK_BOX.y}) scale(${MARK_SCALE})`} fill="none" stroke={BRAND_ORANGE} strokeWidth={GALAXY_STROKE} strokeLinecap="round" strokeLinejoin="round">
          {GALAXY_PATHS.map((d) => <path key={d} d={d} />)}
          <circle cx={GALAXY_CORE.cx} cy={GALAXY_CORE.cy} r={GALAXY_CORE.r} fill={BRAND_ORANGE} stroke="none" />
        </g>
        <path d={WORDMARK_PATH} fill={ink} />
      </svg>
      {showEmber && (
        <span
          className="murage-lockup-ember"
          data-pop={pop ? "true" : "false"}
          style={{
            position: "absolute",
            left: `${((box.x - x) / width) * 100}%`,
            top: `${((box.y - y) / height) * 100}%`,
            width: `${(box.size / width) * 100}%`,
            height: `${(box.size / height) * 100}%`,
            lineHeight: 0,
            transformOrigin: "50% 100%",
            filter: `drop-shadow(0 0 1.2px ${ground}) drop-shadow(0 0 1.2px ${ground})`,
            ...(pop
              ? { animation: `murage-lockup-pop ${LOCKUP_TIMING.popMs}ms cubic-bezier(.34,1.5,.64,1) ${LOCKUP_TIMING.popDelayMs}ms both` }
              : {}),
          }}
        >
          <span style={{ display: "block", width: "100%", height: "100%" }}>
          <EmberAvatar
            ref={handle}
            color={color}
            body={body}
            size={emberPx}
            state="happy"
            expression={LOCKUP_EMBER_EXPRESSION}
            bodyMotion={0}
            trackPointer={false}
            lookAround={0}
            animated={!still}
            autoBlink={false}
          />
          </span>
        </span>
      )}
    </span>
  );
}
