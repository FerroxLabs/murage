import { describe, expect, it } from "vitest";

import { sidebarMarkLabel, sidebarMarkNameClass, sidebarMarkRowClass } from "./sidebar-attention";
import {
  SIDEBAR_SELECTED_ROW,
  sidebarBotRowTone,
  sidebarGroupRowTone,
  sidebarNavRowTone,
} from "./sidebar-row-tone";

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe("sidebar selected row", () => {
  it("marks the open row in gold, drawn inside the existing border", () => {
    expect(classes(SIDEBAR_SELECTED_ROW)).toContain("border-warning");
    // An inset shadow thickens the edge without changing the box size.
    expect(SIDEBAR_SELECTED_ROW).toContain("shadow-[inset_0_0_0_1px_var(--color-warning)]");
  });

  // IT SHARES A TOKEN WITH "WAITING FOR YOU", ON PURPOSE.
  //
  // This file once claimed gold was deliberately none of the other row
  // signals, which was false, and the selection was then moved to ink to make
  // the claim true. That was the wrong trade: nobody had confused the two, no
  // defect was ever reported, and gold selection is the look of the product.
  //
  // So the separation is pinned where it actually lives. Selection is an
  // EDGE. Waiting is a FILL, plus a dot, plus the words out loud, plus the
  // name in full weight. A change that quietly drops one of those has to
  // argue with this.
  it("keeps waiting distinguishable by more than its colour", () => {
    const waiting = { kind: "waiting", count: 1 } as const;
    expect(sidebarMarkRowClass(waiting), "waiting is a fill").toContain("bg-warning/10");
    expect(SIDEBAR_SELECTED_ROW, "selection is an edge, never a fill").not.toContain("bg-warning");
    expect(sidebarMarkLabel(waiting), "and it says so out loud").toBe("Waiting for you");
    expect(sidebarMarkNameClass(waiting)).toContain("font-medium");
  });

  it("gives a row that is merely open none of those", () => {
    // The control. If selection ever picked up the fill or the label, the two
    // really would be one treatment and the trade above would stop holding.
    const none = { kind: "none" } as const;
    expect(sidebarMarkRowClass(none)).toBe("");
    expect(sidebarMarkLabel(none)).toBe("");
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
