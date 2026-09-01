// The native window chrome that CSS cannot reach, per palette. Everything the
// renderer paints follows `[data-skin]` in src/styles.css; the Windows
// caption-button overlay and the window's own background are drawn by the
// main process and have to be told the same colours. The values mirror each
// palette's `--color-app` (the header strip is `bg-app`) and, for the symbols,
// its `--color-ink-secondary` — flattened to opaque hex because the overlay
// accepts no alpha. Keep in step with src/styles.css and src/lib/skins.ts.
"use strict";

const SKIN_CHROME = Object.freeze({
  dark: Object.freeze({ color: "#0a0a0a", symbolColor: "#a8a8a8" }),
  light: Object.freeze({ color: "#f0f0f0", symbolColor: "#555555" }),
});

const DEFAULT_SKIN = "dark";

/** The chrome colours for a resolved palette id sent by the renderer. Anything
 * that is not a known palette — a renamed skin, a stale value, a non-string,
 * or the "auto" PREFERENCE (which is not a palette and must be resolved before
 * it gets here) — falls back to Dark rather than throwing, because the renderer
 * has already painted and a wrong overlay is recoverable while a broken IPC is
 * not. Adding an `auto` key here would paint a dark titlebar on a light
 * desktop; resolve on the renderer side instead. */
function skinChrome(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) ? SKIN_CHROME[skin] : SKIN_CHROME[DEFAULT_SKIN];
}

/** True when the id names a skin this module knows. A non-string coerces to a
 * property key that cannot match a skin id, so it answers false without a
 * separate type guard. */
function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin);
}

module.exports = { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin };
