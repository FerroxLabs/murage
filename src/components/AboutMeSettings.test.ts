// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ABOUT_ME_COPY, AboutMeSettings, charCounter } from "./AboutMeSettings";
import { BotShapesView, type ShapeRow } from "./BotShapesPanel";
import { settingsSearchResults } from "./SettingsModal";

describe("About me settings", () => {
  it("opens with the intro, says who reads it, and loads from the server", () => {
    const html = renderToStaticMarkup(createElement(AboutMeSettings)).replaceAll("&#x27;", "'");
    expect(html).toContain("About me");
    expect(html).toContain(ABOUT_ME_COPY.intro);
    expect(html).toContain(ABOUT_ME_COPY.audience);
    expect(html).toContain("Loading");
  });

  it("counts toward the cap and says plainly when it is over", () => {
    expect(charCounter(120, 4000)).toEqual({ text: "120 of 4,000 characters", over: false });
    expect(charCounter(4000, 4000).over).toBe(false);
    const over = charCounter(4210, 4000);
    expect(over.over).toBe(true);
    expect(over.text).toBe("4,210 of 4,000 characters. Shorten it by 210 to save.");
  });

  it("uses plain words: no em dashes, no \"safe\", no vendor names, no prices", () => {
    for (const text of [...Object.values(ABOUT_ME_COPY), charCounter(10, 4000).text, charCounter(5000, 4000).text]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\bsafe/i);
      expect(text).not.toMatch(/composio|price|cost|\$/i);
    }
  });

  it("is found by the words people type for it", () => {
    for (const query of ["about me", "About me", "profile", "who I am", "my name"]) expect(settingsSearchResults(query), query).toContain("aboutMe");
  });

  it("is edited from its row in What shapes a bot", () => {
    const row: ShapeRow = { id: "about-me", group: "rules", label: "About you", what: "What you wrote.", text: "x", switchable: true, locked: false, on: true, editor: "aboutMe" };
    const html = renderToStaticMarkup(createElement(BotShapesView, { view: { botId: "b", botName: "Moss", team: { section: "", label: "" }, rows: [row], lastTurn: null }, busy: null, error: "", onToggle: () => {}, onEdit: () => {} }));
    expect(html).toContain('aria-label="Use About you"');
    expect(html).toContain("Edit in Settings");
  });
});
