// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export const BRAND_ORANGE: "#ff6b35";
export const GALAXY_PATHS: readonly string[];
export const GALAXY_CORE: { readonly cx: number; readonly cy: number; readonly r: number };
export const GALAXY_STROKE: number;
export const WORDMARK_PATH: string;
export const MARK_BOX: { readonly x: number; readonly y: number; readonly size: number };
export const MARK_SCALE: number;
export const LOCKUP_FRAME: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export const EMBER_PLACE: { readonly scale: number; readonly left: number; readonly bottom: number };
export const EMBER_DEFAULT_SVG: string;
export function emberBox(): { x: number; y: number; size: number };
export interface LockupOptions {
  /** The mark's height in px. Default 84. */
  size?: number;
  /** Ink for a light ground. */
  light?: boolean;
  /** Ember's face: svg markup or a data:image URI. */
  face?: string;
  ember?: "none" | "static";
}
export function lockupSvg(options?: LockupOptions): string;
