// A phone gets the width of the phone.
//
// Source contracts, not render tests: the renderer suite runs in node with no
// DOM, and the two transcripts are ~1,500 lines each. The real proof of these
// widths is src/e2e/transcript-width.human.spec.ts, which measures them in a
// browser at 390x844 and 1440x900. What this file pins is the shape of the
// fix, so a later edit cannot quietly restore the numbers that spec caught:
//
//   message content  290px of 390  (74.4%)  →  334px of 390  (85.6%)
//   widest bubble    322px of 390  (82.6%)  →  366px of 390  (93.8%)
//   tool chip        527px wide, 161px past the transcript's right edge, cut
//                    by `overflow-x-hidden`  →  366px, fully inside it
//
// Both transcripts are covered, because both carried the same three defects.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const chat = read("./ChatView.tsx");
const group = read("./GroupView.tsx");
const styles = read("../styles.css");
const views: Array<[string, string]> = [["ChatView", chat], ["GroupView", group]];

describe("the message column is not capped at ~75% of a phone", () => {
  it.each(views)("%s lets a bubble take the transcript's width below md", (_name, source) => {
    // `max-md:max-w-[92%]` was the cap. 92% of a column that had already spent
    // a 20px gutter each side, minus the bubble's own 16px padding each side,
    // is the 74.4% that was measured on screen.
    expect(source).not.toContain("max-md:max-w-[92%]");
    expect(source).toContain("max-md:max-w-full");
    // The desktop reading measure survives: 42rem is ~65-75 characters.
    expect(source).toContain("max-w-[min(42rem,78%)]");
  });

  it.each(views)("%s trims the transcript's own gutter on a phone", (_name, source) => {
    expect(source).toContain("px-5 max-md:px-3");
  });

  it.each(views)("%s drops the hover-only controls where there is no hover", (_name, source) => {
    // They are `opacity-0` until `group-hover`, and a phone reports
    // `hover: none` — so on a phone they were invisible AND still reserving
    // ~130px of every row. `md:contents` keeps them flex items of the row on a
    // pointer device; `max-md:hidden` takes them out of the flow below `md`.
    expect(source).toContain("max-md:hidden md:contents");
    // …and the hover-revealed timestamp, which was the widest of them.
    expect(source).toMatch(/group-hover:opacity-100 max-md:hidden/);
  });
});

describe("a tool chip contains the name it was given", () => {
  it("shrinks, and wraps rather than cuts", () => {
    // `max-w-[480px]` + `truncate` (which is `white-space: nowrap`) made 480px
    // the chip's MIN-content width as well as its max, so flex-shrink could
    // not take the pill below it on a 390px screen.
    expect(CHIP).toContain("min-w-0");
    expect(CHIP).toContain("max-w-full");
    expect(CHIP).not.toContain("max-w-[480px]");
    expect(CHIP_NAME).toContain("break-all");
    expect(CHIP_NAME).not.toContain("truncate");
  });

  it.each(views)("%s renders its chip from that one definition", (_name, source) => {
    expect(source).toContain('from "@/lib/transcript-chrome"');
    expect(source).not.toContain('max-w-[480px] truncate');
  });
});

describe("markdown cannot push the transcript sideways", () => {
  it("breaks a token that has no space or hyphen in it", () => {
    // `overflow-wrap: normal` breaks only at spaces and hyphens, so a hash or
    // a path with neither sets the paragraph's min-content width: measured at
    // 268.5px past the right edge on a phone. `anywhere` (not `break-word`)
    // because only `anywhere` also lowers min-content, which is what stops the
    // overflow rather than merely re-flowing it.
    expect(styles).toMatch(/\.chat-md\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
