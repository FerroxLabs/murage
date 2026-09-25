// Long threads scroll without jank (spec §6): both transcripts mount a capped
// window, keep the reader still by a surviving row rather than by height, and
// let rows the reader has already seen skip layout off screen. Browser proof
// is the human spec; this pins the wiring in both views and the CSS contract.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const views: Array<[string, string]> = [["ChatView", read("./ChatView.tsx")], ["GroupView", read("./GroupView.tsx")]];
const styles = read("../styles.css");

describe("transcript rows", () => {
  it.each(views)("%s gives every top-level item a real, anchorable box", (_name, source) => {
    expect(source).not.toMatch(/<div key=\{(?:item\.id|m\.id)\} className="contents"/);
    expect(source).toMatch(/data-row=\{item\.id\} className="transcript-row flex flex-col gap-3"/);
    expect(source).toMatch(/data-row=\{m\.id\} className="transcript-row flex flex-col gap-3"/);
  });

  it.each(views)("%s pages and expands through the capped window", (_name, source) => {
    expect(source).toContain("expandEarlier({ start: startIndex, end: w.end }");
    expect(source).toContain("expandLater({ start: w.start, end: w.end }");
    expect(source).toContain("trimFollowedTail(w, ");
    expect(source).not.toContain("expandWindowStart(startIndex)");
  });

  it.each(views)("%s restores by row, not by height", (_name, source) => {
    expect(source).toContain("captureRowAnchor(");
    expect(source).toContain("restoreRowAnchor(");
    expect(source).not.toContain("el.scrollHeight - captured.height");
  });

  it.each(views)("%s marks seen rows as they mount", (_name, source) => {
    expect(source).toMatch(/observeSeenRows\(transcriptRef\.current, scrollRef\.current\)/);
  });

  // A page the reader asked for is revealed at the top; past the cap the
  // newest rows unmount, as for "Show earlier". Without this, reading back
  // through server pages mounted every page.
  it.each(views)("%s caps a revealed page", (_name, source) => {
    expect(source).toContain("capRevealedWindow(moved, ");
  });

  // Following means the newest row is on screen. At the bottom of a window
  // that ends early, the reader is not at the end of the conversation: follow
  // re-arms only once the tail is mounted again ("Show later" or Jump).
  it.each(views)("%s only follows a window that holds the newest row", (_name, source) => {
    expect(source).toMatch(/const atEnd = \(\) => \{\s*const el = scrollRef\.current;\s*if \(laterCount > 0\) return false;/);
    expect(source).toContain("if (resume && laterCount === 0) setBottomFollow(true);");
  });

  it("skips only rows that have been seen, and keeps them measured", () => {
    expect(styles).toMatch(/\.transcript-row \{\s*contain-intrinsic-size: auto 120px;\s*\}/);
    expect(styles).toMatch(/\.transcript-row\[data-seen\] \{\s*content-visibility: auto;\s*\}/);
  });

  it("never clips an open menu inside a row", () => {
    // content-visibility implies paint containment: a dropdown (the voice
    // note's <details>, a card's menu) would be cut off at the row's edge.
    expect(styles).toMatch(/\.transcript-row:focus-within,\s*\.transcript-row:has\(details\[open\], \[aria-expanded="true"\]\) \{\s*content-visibility: visible;\s*\}/);
    // and the lift comes after the skip, so it wins at equal specificity
    expect(styles.indexOf("content-visibility: visible")).toBeGreaterThan(styles.indexOf("content-visibility: auto"));
  });
});
