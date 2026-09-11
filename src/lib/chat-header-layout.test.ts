// The header's layout ladder, as arithmetic (U0-T1).
//
// The rendered result — actual hit rectangles, actual name widths, actual
// menus at 320/390/480/640/820/1024 in both skins — is proved in a browser by
// src/e2e/chat-header.human.spec.ts. What is worth pinning here is the part a
// screenshot cannot show: that the ladder never oscillates, that a control
// which has been relocated stays relocated as the header narrows, and that
// "the name takes what is left" can never resolve to nothing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HEADER_LAYOUTS,
  HEADER_RELOCATION_ORDER,
  METADATA_STEPS,
  NAME_TRACK_MAX_PX,
  NAME_TRACK_MIN_PX,
  headerFits,
  nameTrackMinimum,
  relocatedSlots,
} from "./chat-header-layout";

describe("the ladder only ever gets leaner", () => {
  it("never gives a relocated control its place back, and never returns to one row", () => {
    // Two candidates that both "fit" at the same width is how a measuring
    // layout ends up flipping between them forever. Monotonic steps make that
    // impossible: each step is strictly leaner than the one before it.
    for (let index = 1; index < HEADER_LAYOUTS.length; index++) {
      const previous = HEADER_LAYOUTS[index - 1]!;
      const current = HEADER_LAYOUTS[index]!;
      expect(current.relocated, `step ${index} un-relocated a control`).toBeGreaterThanOrEqual(previous.relocated);
      expect(Number(current.twoRow), `step ${index} went back to one row`).toBeGreaterThanOrEqual(
        Number(previous.twoRow),
      );
      expect(
        current.relocated > previous.relocated ||
          current.twoRow !== previous.twoRow ||
          current.chips !== previous.chips,
        `step ${index} is identical to the one before it`,
      ).toBe(true);
      // The chip fold is the one thing that may come back, and only on the
      // step that takes the second row.
      const rank = { full: 0, titled: 1, compact: 2 };
      if (rank[current.chips] < rank[previous.chips]) expect(current.twoRow && !previous.twoRow).toBe(true);
    }
  });

  it("starts with everything in one row and ends with everything relocated", () => {
    expect(HEADER_LAYOUTS[0]).toEqual({ twoRow: false, chips: "full", relocated: 0 });
    expect(HEADER_LAYOUTS.at(-1)).toEqual({ twoRow: true, chips: "compact", relocated: HEADER_RELOCATION_ORDER.length });
  });

  it("folds the metadata, then the chips, then takes a second row, then relocates real controls", () => {
    // The design's order. Role label, usage totals and the Inspector toggle
    // go first — a second row is a bigger change to the page than folding a
    // read-only figure into a menu — then the task/model context becomes a
    // compact control, and only after the second row does a real control
    // (computer, find, memory, folder) move into the menu.
    expect(HEADER_RELOCATION_ORDER.slice(0, METADATA_STEPS)).toEqual(["roleLabel", "usage", "inspector"]);
    expect(HEADER_LAYOUTS.slice(0, METADATA_STEPS + 5)).toEqual([
      { twoRow: false, chips: "full", relocated: 0 },
      { twoRow: false, chips: "full", relocated: 1 },
      { twoRow: false, chips: "full", relocated: 2 },
      { twoRow: false, chips: "full", relocated: 3 },
      // The task keeps its title one step longer than the other chips.
      { twoRow: false, chips: "titled", relocated: 3 },
      { twoRow: false, chips: "compact", relocated: 3 },
      { twoRow: true, chips: "full", relocated: 3 },
      { twoRow: true, chips: "titled", relocated: 3 },
    ]);
    // Nothing beyond the metadata is relocated before BOTH rows and the
    // compact chips have been tried.
    for (const layout of HEADER_LAYOUTS) {
      if (layout.relocated > METADATA_STEPS) expect(layout).toMatchObject({ twoRow: true, chips: "compact" });
    }
  });

  it("gives the chips their labels back on the second row, and only there", () => {
    // The second row exists to show the task, model and folder by name; a
    // one-row header that could not fit them folds them instead. That is
    // the one non-monotonic step, and it is a row change, so it cannot
    // trade places with a one-row candidate.
    const labelledTwoRow = HEADER_LAYOUTS.filter((layout) => layout.twoRow && layout.chips !== "compact");
    expect(labelledTwoRow).toEqual([
      { twoRow: true, chips: "full", relocated: METADATA_STEPS },
      { twoRow: true, chips: "titled", relocated: METADATA_STEPS },
    ]);
    const foldedOneRow = HEADER_LAYOUTS.filter((layout) => !layout.twoRow && layout.chips !== "full");
    expect(foldedOneRow).toEqual([
      { twoRow: false, chips: "titled", relocated: METADATA_STEPS },
      { twoRow: false, chips: "compact", relocated: METADATA_STEPS },
    ]);
  });

  it("keeps identity, Stop, the task/model context and the call button out of the order entirely", () => {
    for (const fixed of ["name", "avatar", "stop", "task", "model", "call", "more"]) {
      expect(HEADER_RELOCATION_ORDER).not.toContain(fixed);
    }
  });
});

describe("what each step relocates", () => {
  it("moves one more control per step, lowest priority first", () => {
    for (let relocated = 0; relocated <= HEADER_RELOCATION_ORDER.length; relocated++) {
      const slots = relocatedSlots({ twoRow: false, chips: "full", relocated });
      expect([...slots]).toEqual(HEADER_RELOCATION_ORDER.slice(0, relocated));
    }
  });

  it("is the layout's decision alone: no CSS breakpoint folds a control away on the side", () => {
    // Every fold in the header answers to the layout's stamp
    // (`data-chat-header-chips`) or to a relocation, never to a container
    // width of its own. Otherwise a control could vanish from the header
    // AND never appear in the menu — simply gone.
    const header = readFileSync(new URL("../components/ChatHeader.tsx", import.meta.url), "utf8");
    const launcher = readFileSync(new URL("../components/MemoryLauncher.tsx", import.meta.url), "utf8");
    const chips = readFileSync(new URL("./compact-chip.ts", import.meta.url), "utf8");
    for (const source of [header, launcher, chips]) {
      expect(source).not.toMatch(/@max-\w+\/chathead/);
      expect(source).not.toMatch(/@container/);
    }
    expect(header).toContain("data-chat-header-chips={layout.chips}");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain('@custom-variant chip-fold (&:where([data-chat-header-chips="compact"] *));');
    expect(css).toContain(
      '@custom-variant chip-trim (&:where([data-chat-header-chips="titled"] *, [data-chat-header-chips="compact"] *));',
    );
  });
});

describe("the bot name always keeps a usable track", () => {
  it("guarantees a quarter of the header, floored at 96px and capped at 200px", () => {
    expect(nameTrackMinimum(320, 1000)).toBe(NAME_TRACK_MIN_PX);
    expect(nameTrackMinimum(600, 1000)).toBe(150);
    expect(nameTrackMinimum(2000, 1000)).toBe(NAME_TRACK_MAX_PX);
  });

  it("never asks for more than the name actually needs", () => {
    // "Bot" does not get 96px of guaranteed track; it gets its own 30px, and
    // the controls keep the rest.
    expect(nameTrackMinimum(1024, 30)).toBe(30);
  });

  it("rejects the layout that was shipped: a 0px name in a 390px column", () => {
    expect(headerFits({ contentWidth: 390, overflow: 0, nameWidth: 0, nameNatural: 220 })).toBe(false);
  });

  it("rejects a layout whose controls escape the header", () => {
    expect(headerFits({ contentWidth: 390, overflow: 42, nameWidth: 200, nameNatural: 220 })).toBe(false);
  });

  it("accepts a layout that leaves the name its track and stays inside the header", () => {
    // A quarter of 390 is 97.5px of guaranteed track.
    expect(headerFits({ contentWidth: 390, overflow: 0, nameWidth: 98, nameNatural: 220 })).toBe(true);
    // Sub-pixel layout rounding is not a failure; half a pixel of tolerance
    // on the track and one pixel on the overflow.
    expect(headerFits({ contentWidth: 390, overflow: 1, nameWidth: 97.1, nameNatural: 220 })).toBe(true);
    expect(headerFits({ contentWidth: 390, overflow: 1, nameWidth: 96.9, nameNatural: 220 })).toBe(false);
  });

  it("accepts a short name at its natural width even in a narrow header", () => {
    expect(headerFits({ contentWidth: 320, overflow: 0, nameWidth: 30, nameNatural: 30 })).toBe(true);
  });
});
