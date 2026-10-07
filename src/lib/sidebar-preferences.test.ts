import { describe, expect, it, vi } from "vitest";

import {
  AUTO_RAIL_QUERY,
  DEFAULT_SIDEBAR_DENSITY,
  SIDEBAR_AUTO_RAIL_KEY,
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  chooseAutoRail,
  chooseSidebarDensity,
  effectiveSidebarDensity,
  NAV_INSTALL_KEY,
  hasEarlierRun,
  installKind,
  loadAutoRail,
  loadCollapsedSections,
  resetSidebarDensityState,
  sidebarDensityState,
  subscribeSidebarDensity,
  loadSectionOrder,
  loadSidebarDensity,
  parseSidebarDensity,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarDensity,
  toggleCollapsedSection,
} from "./sidebar-preferences";
import { BOT_CHATS_SECTION_ID, userSectionId } from "./sidebar-layout";

const storageWith = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe("sidebar density preferences", () => {
  it("accepts the three supported layouts and rejects stale values", () => {
    // stored names are the pre-0.1.62 ones: compact is Standard, comfortable
    // is Roomy, icons is the Rail
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("compact");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("compact");
    expect(parseSidebarDensity(null)).toBe("compact");
    expect(DEFAULT_SIDEBAR_DENSITY).toBe("compact");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("compact");
  });

  it("gives Standard to a first run only; nobody's saved or shown sidebar changes", () => {
    // a first run: nothing stored anywhere
    expect(loadSidebarDensity(storageWith({}))).toBe("compact");
    // saved choices keep their meaning
    for (const saved of ["comfortable", "compact", "icons"] as const) {
      expect(loadSidebarDensity(storageWith({ [SIDEBAR_DENSITY_KEY]: saved, "murage-email-gate": "skipped" }))).toBe(saved);
    }
    // an install that ran before 0.1.62 and never picked one was showing Roomy
    expect(hasEarlierRun(storageWith({ "murage-email-gate": "submitted" }))).toBe(true);
    expect(loadSidebarDensity(storageWith({ "murage-email-gate": "submitted" }))).toBe("comfortable");
    expect(loadSidebarDensity(storageWith({ [SIDEBAR_SECTION_ORDER_KEY]: "[]" }))).toBe("comfortable");
  });

  it("decides fresh or upgraded once, so a new install stays new after its own first run writes keys", () => {
    const values: Record<string, string> = {};
    const storage = { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
    // first launch of a 0.1.62 build on a new machine
    expect(installKind(storage)).toBe("fresh");
    expect(values[NAV_INSTALL_KEY]).toBe("fresh");
    // that first run writes the email gate and the language...
    values["murage-email-gate"] = "skipped";
    values["murage-ui-language"] = "";
    // ...and the second launch still gets the new-install defaults
    expect(installKind(storage)).toBe("fresh");
    expect(loadSidebarDensity(storage)).toBe("compact");
    expect(loadCollapsedSections(storage)).toEqual([BOT_CHATS_SECTION_ID]);
    // an upgraded install stays upgraded
    const old: Record<string, string> = { "murage-email-gate": "submitted" };
    const oldStorage = { getItem: (key: string) => old[key] ?? null, setItem: (key: string, value: string) => { old[key] = value; } };
    expect(installKind(oldStorage)).toBe("upgraded");
    expect(old[NAV_INSTALL_KEY]).toBe("upgraded");
  });

  it("folds to the rail on a narrow window until the person picks a density", () => {
    expect(effectiveSidebarDensity("compact", { narrowWindow: true, autoRail: true, pinned: false })).toBe("icons");
    expect(effectiveSidebarDensity("comfortable", { narrowWindow: true, autoRail: true, pinned: true })).toBe("comfortable");
    expect(effectiveSidebarDensity("compact", { narrowWindow: true, autoRail: false, pinned: false })).toBe("compact");
    expect(effectiveSidebarDensity("comfortable", { narrowWindow: false, autoRail: true, pinned: false })).toBe("comfortable");
    expect(AUTO_RAIL_QUERY).toBe("(min-width: 768px) and (max-width: 1099.98px)");
    expect(loadAutoRail(storageWith({}))).toBe(true);
    expect(loadAutoRail(storageWith({ [SIDEBAR_AUTO_RAIL_KEY]: "off" }))).toBe(false);
  });

  it("shares one choice between the sidebar and Settings, pinned for the session", () => {
    resetSidebarDensityState();
    const listener = vi.fn();
    const stop = subscribeSidebarDensity(listener);
    expect(sidebarDensityState().pinned).toBe(false);
    chooseSidebarDensity("comfortable");
    expect(sidebarDensityState()).toMatchObject({ density: "comfortable", pinned: true });
    chooseAutoRail(false);
    expect(sidebarDensityState().autoRail).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    resetSidebarDensityState();
  });

  it("starts Bot Chats folded on a first run, and nowhere else", () => {
    expect(loadCollapsedSections(storageWith({}))).toEqual([BOT_CHATS_SECTION_ID]);
    expect(loadCollapsedSections(storageWith({ "murage-email-gate": "skipped" }))).toEqual([]);
    expect(loadCollapsedSections(storageWith({ [SIDEBAR_COLLAPSED_SECTIONS_KEY]: "[]" }))).toEqual([]);
  });
});

describe("sidebar section preferences", () => {
  it("round-trips unique collapsed and ordered section ids", () => {
    const collapsedSet = vi.fn();
    saveCollapsedSections(["builtin:pinned", "builtin:pinned", "section:Work"], {
      setItem: collapsedSet,
    });
    expect(collapsedSet).toHaveBeenCalledWith(
      SIDEBAR_COLLAPSED_SECTIONS_KEY,
      JSON.stringify(["builtin:pinned", "section:Work"]),
    );
    expect(
      loadCollapsedSections({
        getItem: () => JSON.stringify(["builtin:pinned", "section:Work"]),
      }),
    ).toEqual(["builtin:pinned", "section:Work"]);

    const orderSet = vi.fn();
    saveSectionOrder(["section:Work", "builtin:bots"], { setItem: orderSet });
    expect(orderSet).toHaveBeenCalledWith(
      SIDEBAR_SECTION_ORDER_KEY,
      JSON.stringify(["section:Work", "builtin:bots"]),
    );
    expect(loadSectionOrder({ getItem: () => JSON.stringify(["section:Work", "builtin:bots"]) })).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
  });

  it("ignores malformed storage and toggles ids without mutating the source", () => {
    expect(loadCollapsedSections({ getItem: () => "not-json" })).toEqual([]);
    expect(loadSectionOrder({ getItem: () => JSON.stringify({ nope: true }) })).toEqual([]);
    const current = ["section:Work"];
    expect(toggleCollapsedSection(current, "builtin:bots")).toEqual([
      "section:Work",
      "builtin:bots",
    ]);
    expect(toggleCollapsedSection(current, "section:Work")).toEqual([]);
    expect(current).toEqual(["section:Work"]);
  });

  it("supports newlines, caps untrusted arrays, and tolerates blocked storage", () => {
    const withNewline = "section:Line\nBreak";
    expect(loadSectionOrder({ getItem: () => JSON.stringify([withNewline]) })).toEqual([withNewline]);

    const oversized = Array.from({ length: 105 }, (_, index) => `section:${index}`);
    expect(loadSectionOrder({ getItem: () => JSON.stringify(oversized) })).toHaveLength(100);
    expect(loadSectionOrder({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(() => saveSectionOrder(["section:Work"], { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  it("persists raw section ids with lone surrogates and max-length emoji names", () => {
    const ids = [userSectionId("\ud800"), userSectionId("🧠".repeat(30))];
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    saveSectionOrder(ids, storage);
    expect(loadSectionOrder(storage)).toEqual(ids);
  });
});
