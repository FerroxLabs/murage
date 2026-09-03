// A phone can act on a message, and it still gets the width of the phone.
//
// The hover rail (copy / reply / speak / regenerate / pin) is `opacity-0`
// until `group-hover`, and a phone reports `hover: none`, so below `md` it is
// `display: none`. That took ~130px back for the transcript and took the last
// way of copying, replying to, or speaking a message away with it. The
// replacement is a tap on the bubble that opens a sheet.
//
// These are the parts of that with no DOM in them: when a tap counts, and the
// class strings the sheet and the bubble are built from. The proof that the
// sheet is really reachable by a thumb, and that the transcript did not narrow
// to pay for it, is src/e2e/message-actions.human.spec.ts, which taps a real
// bubble in a real browser at 390x844.
import { describe, expect, it } from "vitest";

import {
  BUBBLE_INTERACTIVE,
  BUBBLE_TAPPABLE,
  SHEET_BACKDROP,
  SHEET_ITEM,
  SHEET_PANEL,
  bubbleTapOpensActions,
} from "@/lib/transcript-chrome";

const tap = (over: Partial<Parameters<typeof bubbleTapOpensActions>[0]> = {}) =>
  bubbleTapOpensActions({ narrow: true, onInteractive: false, selectedText: "", ...over });

describe("a tap on a bubble is the phone's way in", () => {
  it("opens the sheet on a phone", () => {
    expect(tap()).toBe(true);
  });

  it("does nothing above md, where the rail is still there and still hovers", () => {
    // The one rule the whole change is measured against: desktop must not
    // gain a behaviour it never had. A bubble on a 1440px screen is not a
    // button, and clicking one has to stay inert.
    expect(tap({ narrow: false })).toBe(false);
  });

  it("leaves a tap on a link or a button to the link or the button", () => {
    // An answer's markdown links, the tool-payload disclosure, and "Show full
    // message" all live inside the bubble and already mean something.
    expect(tap({ onInteractive: true })).toBe(false);
  });

  it("does not steal the tap that ends a text selection", () => {
    // This is the long-press problem arriving by another route. Selection
    // still starts on a long press — we never suppressed it — so the release
    // lands on the bubble. Opening a sheet there would throw away the
    // selection the person just made.
    expect(tap({ selectedText: "three calendars" })).toBe(false);
    expect(tap({ selectedText: "   " })).toBe(true);
  });

  it("names the descendants that own their own tap", () => {
    for (const selector of ["a", "button", "summary", "[role=\"button\"]"]) {
      expect(BUBBLE_INTERACTIVE).toContain(selector);
    }
  });
});

describe("the trigger costs the row nothing", () => {
  it("is scoped to max-md in every one of its utilities", () => {
    // Not decoration: this is the desktop-is-untouched proof in class form.
    // One unprefixed utility here would land on a 1440px bubble.
    const tokens = BUBBLE_TAPPABLE.split(/\s+/).filter(Boolean);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((token) => !token.startsWith("max-md:"))).toEqual([]);
  });

  it("changes nothing that has a width", () => {
    // `cursor` never affects layout and a ring is a box-shadow. Padding, a
    // margin, a border or a min-width on the bubble WOULD move the measured
    // 334px of message content, so none of them may appear here.
    expect(BUBBLE_TAPPABLE).toMatch(/cursor-pointer/);
    expect(BUBBLE_TAPPABLE).toMatch(/focus-visible:ring/);
    expect(BUBBLE_TAPPABLE).not.toMatch(/(^|:)(p[xytrbles]?|m[xytrbl]?|w|min-w|max-w|h|border|gap|inline|block|flex|grid)-/);
  });
});

describe("the sheet is out of the transcript's layout, and reachable by a thumb", () => {
  it("is fixed to the bottom edge rather than laid out in a row", () => {
    // `fixed` is what makes the width claim structural rather than lucky: a
    // fixed box is out of flow, so nothing it contains can ever be paid for
    // in transcript width.
    expect(SHEET_PANEL).toContain("fixed");
    expect(SHEET_PANEL).toContain("inset-x-0");
    expect(SHEET_PANEL).toContain("bottom-0");
    expect(SHEET_BACKDROP).toContain("fixed");
    expect(SHEET_BACKDROP).toContain("inset-0");
  });

  it("clears the home indicator, because this app installs as a PWA", () => {
    // Standalone: there is no browser chrome under the sheet to absorb the
    // inset, so the last row would sit under the indicator without this.
    expect(SHEET_PANEL).toContain("env(safe-area-inset-bottom)");
  });

  it("gives every action a 44px target", () => {
    expect(SHEET_ITEM).toContain("min-h-[44px]");
    expect(SHEET_ITEM).toContain("w-full");
  });

  it("animates through classes a reduced-motion reader can switch off", () => {
    expect(SHEET_PANEL).toContain("msg-sheet");
    expect(SHEET_BACKDROP).toContain("msg-sheet-backdrop");
  });
});
