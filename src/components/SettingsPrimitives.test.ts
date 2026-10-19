// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 I0: the one Advanced level per page.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdvancedSection } from "./SettingsPrimitives";

const render = (open: boolean) => renderToStaticMarkup(createElement(AdvancedSection, { section: "general", summary: "Start at login, usage analytics", open, onOpenChange: () => {}, children: createElement("p", { id: "inside" }, "inner") }));

describe("AdvancedSection", () => {
  it("is one labelled toggle that controls its region, and holds no content while closed", () => {
    const html = render(false);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="settings-advanced-general"');
    expect(html).toContain('id="settings-advanced-general"');
    expect(html).toContain("Advanced</span> · Start at login, usage analytics");
    expect(html).not.toContain("inner");
    expect(html).not.toContain("<details");
  });
  it("renders its children when open", () => {
    const html = render(true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('<p id="inside">inner</p>');
  });
});
