// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings v10 SHELL-SEAT: every v10 page has one loader line and a file of its own, so no page lane edits
// page-registry.tsx; the Overview section slot loads its file by id and renders nothing until that file draws something (C9).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SETTINGS_V10_PAGE_IDS, SETTINGS_V10_PAGE_LOADERS } from "./page-registry";
import { OVERVIEW_SECTION_LOADERS, OverviewSection } from "./overview-sections";
import OverviewPage from "./pages/OverviewPage";

describe("v10 page slots", () => {
  it("names the 17 app pages once each", () => {
    expect(SETTINGS_V10_PAGE_IDS).toHaveLength(17);
    expect([...SETTINGS_V10_PAGE_IDS]).toEqual([
      "overview", "providers", "engines", "models", "usage", "tools", "connections", "computer", "messaging",
      "companion", "bots", "rules", "skills", "memory", "general", "backups", "about",
    ]);
  });

  it("gives every v10 page a loader whose module default-exports a component", async () => {
    for (const id of SETTINGS_V10_PAGE_IDS) {
      const load = SETTINGS_V10_PAGE_LOADERS[id];
      expect(load, `loader for ${id}`).toBeTypeOf("function");
      const mod = await load();
      expect(mod.default, `default export of ${id}`).toBeTypeOf("function");
    }
  });

  it("has no loader for an id outside the v10 list", () => {
    expect(Object.keys(SETTINGS_V10_PAGE_LOADERS).sort()).toEqual([...SETTINGS_V10_PAGE_IDS].sort());
  });
});

describe("OverviewSection slot", () => {
  it("renders nothing for an id with no loader", () => {
    expect(renderToStaticMarkup(createElement(OverviewSection, { id: "overview.nothing" }))).toBe("");
    expect(renderToStaticMarkup(createElement(OverviewSection, { id: "constructor" }))).toBe("");
  });

  it("seats overview.changed, and its file default-exports a component that draws nothing yet", async () => {
    const load = OVERVIEW_SECTION_LOADERS["overview.changed"];
    expect(load).toBeTypeOf("function");
    const mod = await load();
    expect(mod.default).toBeTypeOf("function");
    expect(renderToStaticMarkup(createElement(mod.default))).toBe("");
  });

  it("is drawn by the Overview page, so the find lane never has to add it", () => {
    const tree = OverviewPage({ page: "general", mode: "simple", desktop: true, cloud: false, anchor: null });
    expect(tree.type).toBe(OverviewSection);
    expect(tree.props).toEqual({ id: "overview.changed" });
  });
});
