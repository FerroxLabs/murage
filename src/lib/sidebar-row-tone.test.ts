import { describe, expect, it } from "vitest";

import {
  SIDEBAR_SELECTED_ROW,
  sidebarBotRowTone,
  sidebarGroupRowTone,
  sidebarNavRowTone,
} from "./sidebar-row-tone";

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe("sidebar selected row", () => {
  it("marks the open row in ink, drawn inside the existing border", () => {
    expect(classes(SIDEBAR_SELECTED_ROW)).toContain("border-ink");
    // An inset shadow thickens the edge without changing the box size.
    expect(SIDEBAR_SELECTED_ROW).toContain("shadow-[inset_0_0_0_1px_var(--color-ink)]");
  });

  // COLOUR IS SPENT ON MEANING, AND SELECTION IS NOT MEANING.
  //
  // The selected edge was drawn in the warning token, which is the token a
  // WAITING row is filled with (sidebarMarkRowClass) and the token every
  // warning callout in the app uses. The two were told apart only by which
  // CSS property carried them. This is the invariant an old comment in
  // sidebar-row-tone.ts claimed and the code did not have.
  it("never borrows a signal colour to say which row is open", () => {
    const every = [
      SIDEBAR_SELECTED_ROW,
      sidebarBotRowTone("chief", true),
      sidebarBotRowTone("leader", true),
      sidebarBotRowTone("member", true),
      sidebarGroupRowTone(true),
      sidebarNavRowTone(true),
    ];
    for (const tone of every) {
      for (const signal of ["warning", "danger", "success", "team-lead"]) {
        expect(tone, `selection must not borrow ${signal}`).not.toMatch(new RegExp(`\\b(border|bg|text)-${signal}\\b`));
      }
      expect(tone, "nor the waiting fill").not.toContain("bg-warning");
    }
  });

  it("still says which row is open, loudly", () => {
    // THE NEGATIVE CONTROL. Satisfying the rule above by removing the edge
    // would restore the defect that made somebody borrow gold in the first
    // place: a faint fill and a hairline border nobody could find.
    for (const tone of [sidebarBotRowTone("member", true), sidebarGroupRowTone(true), sidebarNavRowTone(true)]) {
      expect(classes(tone)).toContain("border-ink");
      expect(tone).toContain("shadow-[inset_0_0_0_1px_var(--color-ink)]");
    }
    expect(sidebarBotRowTone("member", false), "and only when it is open").not.toContain("border-ink");
  });

  it("applies the selected treatment to the selected bot row only, for every role", () => {
    for (const role of ["chief", "leader", "member"] as const) {
      expect(classes(sidebarBotRowTone(role, true))).toContain("border-ink");
      expect(classes(sidebarBotRowTone(role, false))).not.toContain("border-ink");
    }
    // Role colour still reads at rest, and never on top of the selection edge.
    expect(sidebarBotRowTone("leader", false)).toContain("border-team-lead/30");
    expect(sidebarBotRowTone("leader", true)).not.toContain("border-team-lead");
    expect(sidebarBotRowTone("chief", false)).toContain("border-accent/25");
  });

  it("gives channel and Team map rows the same edge, with a transparent border at rest so nothing shifts", () => {
    for (const tone of [sidebarGroupRowTone, sidebarNavRowTone]) {
      expect(classes(tone(true))).toContain("border-ink");
      expect(classes(tone(false))).toContain("border-transparent");
      expect(classes(tone(true))).toContain("border");
      expect(classes(tone(false))).toContain("border");
    }
  });

  it("never uses the unread dot's accent fill as the selection signal", () => {
    for (const tone of [sidebarBotRowTone("member", true), sidebarGroupRowTone(true), sidebarNavRowTone(true)]) {
      expect(classes(tone)).not.toContain("bg-accent");
    }
  });
});
