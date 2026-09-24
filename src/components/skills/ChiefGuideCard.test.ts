// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChiefGuideCardView } from "./ChiefGuideCard";

const noop = () => {};
const render = (on: boolean | null) => renderToStaticMarkup(createElement(ChiefGuideCardView, { on, busy: false, error: "", onToggle: noop, onRead: noop }));

describe("the Chief of Staff guide card", () => {
  it("names the guide, says it is built in, and has a switch and Read it", () => {
    const html = render(true);
    expect(html).toContain("Chief of Staff guide");
    expect(html).toContain("Built-in");
    expect(html).toContain("Read it");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toMatch(/SKILL\.md|frontmatter|manifest|—/);
  });

  it("shows the switch off when the owner switched it off, and waits while loading", () => {
    expect(render(false)).toContain('aria-checked="false"');
    expect(render(null)).toContain("disabled");
  });

  it("sits at the top of the Skills panel of the workspace Chief only", () => {
    const source = readFileSync(new URL("../BotSkillsPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('const isChief = bot.chiefOfStaff === true && bot.chiefScope === "workspace";');
    expect(source.indexOf("<ChiefGuideCard")).toBeLessThan(source.indexOf("<SkillsBody"));
    expect(source).toContain("{isChief && !snapshot.viewing && <ChiefGuideCard");
  });
});
