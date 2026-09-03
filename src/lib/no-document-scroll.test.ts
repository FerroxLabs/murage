// The app must never scroll the DOCUMENT.
//
// It is a fixed-height layout: html is 100%, body is overflow:hidden, #root
// is the viewport. But `html` is the scrolling element and it is visible, so
// an absolutely positioned descendant hanging past the viewport scrolls the
// whole window — sliding the entire app upward and leaving a black band where
// the page ran out. Nothing throws, no error boundary fires, and it looks
// exactly like the app broke.
//
// Measured in the running app before the fix: document 1176px in an 807px
// viewport, window.scrollY reaching 369.5. The culprit was the composer's
// full-bleed ground — `absolute -left-5 -right-5 top-1/2 h-[50vh]`,
// deliberately half a viewport tall so message bubbles cannot show below the
// pill's midline — which sits near the bottom of the screen and therefore
// hung 404px past it.
//
// Clipping at #root fixes that one and forecloses the class. `fixed`
// descendants are positioned against the viewport and are NOT clipped by an
// ancestor's overflow, so menus, the message action sheet and the install
// invite are unaffected.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** The body of the first `#root { … }` block, comments stripped. */
const rootBlock = (() => {
  const at = css.indexOf("#root {");
  const body = css.slice(at, css.indexOf("}", at));
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
})();

describe("the document never scrolls", () => {
  it("clips #root, so no descendant can grow the page", () => {
    expect(rootBlock).toMatch(/overflow:\s*hidden/);
  });

  it("still sizes #root to the viewport", () => {
    // Clipping only helps because the element being clipped is exactly one
    // screen tall. Losing the height would clip the app instead.
    expect(rootBlock).toMatch(/height:\s*100%/);
  });

  it("keeps body from scrolling too, which is the other half", () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
  });
});
