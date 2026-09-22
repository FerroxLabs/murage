// DOES ANY SENTENCE RUN OFF THE RIGHT EDGE OF THE SCREEN?
//
// ONE COPY, BECAUSE TWO COPIES IS HOW THIS CHECK GOT IT WRONG TWICE.
//
// This lived inline in `first-run-every-path.human.spec.ts` and was copied
// into `first-run-flux-path.human.spec.ts` with the note that a spec is not a
// module. The copy then got a fix the original did not, and the original was
// left armed with a false alarm it had simply never been in a position to
// trigger. That is drift, and drift in a check is worse than no check: the
// two files disagree about what clipping means and neither says so. So it is
// a module now, and a spec that wants this measurement imports it.
//
// THE FIRST VERSION COULD NOT FAIL. It walked ELEMENTS and skipped any with
// children, to avoid measuring a wrapper instead of its prose. But all real
// prose has markup in it — a bolded word, a link, a span — so every sentence
// worth checking was a non-leaf and was skipped. It went green at three
// widths on a release with photographed clipping, and a bare-div control
// passed while a control with one `<strong>` in it did not. A check that only
// sees the simplest text on the page is decoration.
//
// A Range over a TEXT NODE reports the rectangles the browser actually
// painted, one per wrapped line, which is exactly what a reader's eye lands
// on and is indifferent to how the markup is nested.
import type { Page } from "@playwright/test";

export type ClippedLine = { text: string; right: number; limit: number };

/**
 * Every text node whose painted line boxes cross the right edge of the
 * viewport, capped at eight so a catastrophic layout reports a readable
 * failure instead of a wall.
 *
 * A spec that imports this owes it a NEGATIVE CONTROL in the same file:
 * bait the page with prose that really does overflow and require this to
 * scream. Three checks in this harness went green while blind, and the only
 * thing that caught any of them was being handed the thing they existed for.
 */
export async function clippedText(app: Page): Promise<ClippedLine[]> {
  return app.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const found: ClippedLine[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text.length < 12) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = window.getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      // VISUALLY HIDDEN TEXT IS NOT CLIPPED TEXT.
      //
      // Tailwind's `sr-only` is `position:absolute;width:1px;height:1px;
      // overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap`, so the TEXT
      // inside lays out at its natural width in a one-pixel box and a Range
      // over it reports a rectangle tens of pixels wide — past the right edge
      // whenever the control it labels sits near one. NOTHING IS PAINTED
      // THERE: the browser clipped it away before anybody could read it,
      // which is the entire purpose of the idiom.
      //
      // The connected-world spec hit this immediately — PushToTalk's "Hold to
      // talk", right 1488 in a 1440 viewport. The skip-path spec never had,
      // because that button only renders once something can answer, and on a
      // blank machine with Flux skipped nothing can. A false alarm waiting
      // for the first spec that reached a working world, which is exactly the
      // kind of failure that gets a real check deleted.
      //
      // The test is the PARENT'S OWN PAINTED BOX, not a class name: an
      // element one pixel across is not showing anybody a sentence, whatever
      // idiom put it there. Real prose lives in a parent at least as wide as
      // one line of it, so this cannot hide the clipping the check exists
      // for — the baits in both specs are prose in a full-width parent and
      // still scream with this in place.
      const box = parent.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > limit + 1) {
          found.push({ text: text.slice(0, 80), right: Math.round(rect.right), limit });
          break;
        }
      }
    }
    return found.slice(0, 8);
  });
}
