import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SIDEBAR_BUILTIN_SECTION_IDS } from "../../shared/sidebar-order";

import {
  initialSectionOrderUpload,
  saveSectionOrderToComputer,
  shownSectionOrder,
} from "./sidebar-order-sync";

const mac = ["section:Sean's Office", "builtin:projects", "builtin:pinned"];
const phoneDefault = ["builtin:pinned", "builtin:projects", "section:Operations"];

describe("shownSectionOrder", () => {
  it("uses the computer's order once it is known, over any local copy", () => {
    expect(shownSectionOrder(mac, phoneDefault)).toEqual(mac);
    // An empty saved order is still the computer's answer.
    expect(shownSectionOrder([], phoneDefault)).toEqual([]);
  });

  it("keeps the local copy while the computer has none, or has not answered", () => {
    expect(shownSectionOrder(null, phoneDefault)).toEqual(phoneDefault);
    expect(shownSectionOrder(undefined, phoneDefault)).toEqual(phoneDefault);
  });
});

describe("initialSectionOrderUpload", () => {
  it("uploads the desktop's local arrangement when the computer has none", () => {
    expect(initialSectionOrderUpload({ server: null, local: mac, desktop: true, attempted: false })).toEqual(mac);
  });

  it("never uploads from a phone or browser, which would only be a default", () => {
    expect(initialSectionOrderUpload({ server: null, local: phoneDefault, desktop: false, attempted: false })).toBeNull();
    // Not yet known to be the desktop is not the desktop.
    expect(initialSectionOrderUpload({ server: null, local: mac, desktop: undefined, attempted: false })).toBeNull();
  });

  it("never replaces a saved order, and uploads at most once", () => {
    expect(initialSectionOrderUpload({ server: phoneDefault, local: mac, desktop: true, attempted: false })).toBeNull();
    // An older harness that sends no order at all is not "none saved".
    expect(initialSectionOrderUpload({ server: undefined, local: mac, desktop: true, attempted: false })).toBeNull();
    expect(initialSectionOrderUpload({ server: null, local: mac, desktop: true, attempted: true })).toBeNull();
    expect(initialSectionOrderUpload({ server: null, local: [], desktop: true, attempted: false })).toBeNull();
  });
});

describe("saveSectionOrderToComputer", () => {
  it("saves a drag through the section route every door reaches", async () => {
    const request = vi.fn().mockResolvedValue({ order: phoneDefault });
    expect(await saveSectionOrderToComputer(phoneDefault, request)).toEqual(phoneDefault);
    expect(request).toHaveBeenCalledWith("/api/sidebar-sections", {
      method: "POST",
      body: JSON.stringify({ order: phoneDefault }),
    });
  });

  it("marks the one-time desktop upload as initial", async () => {
    const request = vi.fn().mockResolvedValue({ order: mac });
    await saveSectionOrderToComputer(mac, request, { initial: true });
    expect(request).toHaveBeenCalledWith("/api/sidebar-sections", {
      method: "POST",
      body: JSON.stringify({ order: mac, initial: true }),
    });
  });

  it("answers null when the computer refused or sent something unusable", async () => {
    expect(await saveSectionOrderToComputer(mac, vi.fn().mockRejectedValue(new Error("offline")))).toBeNull();
    expect(await saveSectionOrderToComputer(mac, vi.fn().mockResolvedValue({ order: "nope" }))).toBeNull();
  });
});

describe("the fixed section ids the computer accepts", () => {
  it("are every fixed id the sidebar can produce", () => {
    // The harness drops ids it does not know and always shows a phone the
    // fixed ones, so a new fixed section must be added to the shared list.
    const sources = ["src/lib/sidebar-layout.ts", "src/components/Sidebar.tsx"].map((file) => readFileSync(file, "utf8")).join("\n");
    const used = [...new Set([...sources.matchAll(/"(builtin:[a-z-]+)"/g)].map((match) => match[1]!))];
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(SIDEBAR_BUILTIN_SECTION_IDS, id).toContain(id);
  });
});
