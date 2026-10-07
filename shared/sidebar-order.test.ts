import { describe, expect, it } from "vitest";

import {
  SIDEBAR_BUILTIN_SECTION_IDS,
  SIDEBAR_ORDER_MAX_ENTRIES,
  knownSidebarOrderId,
  mergeSectionOrder,
  visibleSidebarOrder,
  mergeStoredSidebarOrder,
  parseSidebarOrder,
} from "./sidebar-order.ts";

describe("parseSidebarOrder", () => {
  it("accepts a list of section ids and drops repeats", () => {
    expect(parseSidebarOrder(["section:Ops", "builtin:pinned", "section:Ops"])).toEqual([
      "section:Ops",
      "builtin:pinned",
    ]);
    expect(parseSidebarOrder([])).toEqual([]);
  });

  it("refuses anything that is not a bounded list of short strings", () => {
    expect(parseSidebarOrder(null)).toBeNull();
    expect(parseSidebarOrder("section:Ops")).toBeNull();
    expect(parseSidebarOrder({ order: [] })).toBeNull();
    expect(parseSidebarOrder([1, 2])).toBeNull();
    expect(parseSidebarOrder([""])).toBeNull();
    expect(parseSidebarOrder(["x".repeat(241)])).toBeNull();
    expect(parseSidebarOrder(Array.from({ length: SIDEBAR_ORDER_MAX_ENTRIES + 1 }, (_, i) => `s${i}`))).toBeNull();
  });
});

describe("mergeStoredSidebarOrder", () => {
  it("takes the incoming order and keeps ids it did not mention in their relative slots", () => {
    expect(mergeStoredSidebarOrder(["a", "hidden", "b", "c"], ["c", "b", "a"])).toEqual([
      "c",
      "b",
      "a",
      "hidden",
    ]);
    expect(mergeStoredSidebarOrder(null, ["b", "a"])).toEqual(["b", "a"]);
  });

  it("stays within the bound by dropping ids only the stored order knew", () => {
    const stored = Array.from({ length: SIDEBAR_ORDER_MAX_ENTRIES }, (_, i) => `old${i}`);
    const incoming = ["new1", "new2", "old0"];
    const merged = mergeStoredSidebarOrder(stored, incoming);
    expect(merged).toHaveLength(SIDEBAR_ORDER_MAX_ENTRIES);
    for (const id of incoming) expect(merged).toContain(id);
    expect(merged.indexOf("new1")).toBeLessThan(merged.indexOf("old0"));
  });
});

describe("mergeSectionOrder (shared with the web UI)", () => {
  it("preserves a temporarily empty section's slot", () => {
    expect(mergeSectionOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
  });
});

describe("knownSidebarOrderId", () => {
  it("knows the fixed ids and team ids", () => {
    for (const id of SIDEBAR_BUILTIN_SECTION_IDS) expect(knownSidebarOrderId(id), id).toBe(true);
    expect(knownSidebarOrderId("section:Sean's Office")).toBe(true);
  });

  it("does not know anything else", () => {
    for (const id of ["builtin:made-up", "section:", "section:   ", "Operations", "javascript:alert(1)", `section:${"x".repeat(240)}`]) {
      expect(knownSidebarOrderId(id), id).toBe(false);
    }
  });
});

describe("visibleSidebarOrder", () => {
  it("keeps the fixed ids and the teams this surface can see, in order", () => {
    expect(
      visibleSidebarOrder(
        ["section:Vault", "builtin:pinned", "section:Ops", "section:Gone", "builtin:bots"],
        new Set(["Ops"]),
      ),
    ).toEqual(["builtin:pinned", "section:Ops", "builtin:bots"]);
  });
});

describe("a filtered device's drag", () => {
  it("keeps the hidden teams in their stored places next to their neighbours", () => {
    const stored = ["section:A", "section:Vault", "section:B", "section:C"];
    const phoneDrag = ["section:C", "section:A", "section:B"];
    expect(mergeStoredSidebarOrder(stored, phoneDrag)).toEqual(["section:C", "section:A", "section:Vault", "section:B"]);
  });
});
