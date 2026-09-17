import { describe, expect, it } from "vitest";

import {
  SIDEBAR_SELECTED_ROW,
  sidebarBotRowTone,
  sidebarGroupRowTone,
  sidebarNavRowTone,
} from "./sidebar-row-tone";

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe("sidebar selected row", () => {
  it("marks the open row with the gold warning token, drawn inside the existing border", () => {
    expect(classes(SIDEBAR_SELECTED_ROW)).toContain("border-warning");
    // An inset shadow thickens the edge without changing the box size.
    expect(SIDEBAR_SELECTED_ROW).toContain("shadow-[inset_0_0_0_1px_var(--color-warning)]");
  });

  it("applies the selected treatment to the selected bot row only, for every role", () => {
    for (const role of ["chief", "leader", "member"] as const) {
      expect(classes(sidebarBotRowTone(role, true))).toContain("border-warning");
      expect(classes(sidebarBotRowTone(role, false))).not.toContain("border-warning");
    }
    // Role colour still reads at rest, and never on top of the selection edge.
    expect(sidebarBotRowTone("leader", false)).toContain("border-team-lead/30");
    expect(sidebarBotRowTone("leader", true)).not.toContain("border-team-lead");
    expect(sidebarBotRowTone("chief", false)).toContain("border-accent/25");
  });

  it("gives channel and Team map rows the same edge, with a transparent border at rest so nothing shifts", () => {
    for (const tone of [sidebarGroupRowTone, sidebarNavRowTone]) {
      expect(classes(tone(true))).toContain("border-warning");
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
