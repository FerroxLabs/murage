// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 I0 (SETTINGS-LANES.md): the card registry contract.
import { describe, expect, it } from "vitest";
import { advancedRegionId, cardForAnchor, cardsForSurface, settingsCardProblems, type SettingsCard } from "./settings-cards";

const cards: SettingsCard[] = [
  { id: "general.profile", section: "general", advanced: false, surface: "any", words: ["name", "email"], anchor: "profile-heading" },
  { id: "general.about-me", section: "general", advanced: false, surface: "desktop", words: ["about me"], anchor: "about-me-heading" },
  { id: "about.experimental", section: "about", advanced: true, surface: "desktop", words: ["labs"], anchor: "experimental-settings" },
];

describe("the card registry", () => {
  it("remote-surface: desktop cards only on the confirmed desktop, none while unresolved", () => {
    expect(cardsForSurface(cards, true).map((card) => card.id)).toEqual(cards.map((card) => card.id));
    expect(cardsForSurface(cards, false).map((card) => card.id)).toEqual(["general.profile"]);
    expect(cardsForSurface(cards, undefined).map((card) => card.id)).toEqual(["general.profile"]);
  });

  it("finds the card of an anchor, so an opener knows to open Advanced first", () => {
    expect(cardForAnchor(cards, "experimental-settings")?.advanced).toBe(true);
    expect(cardForAnchor(cards, "missing")).toBeUndefined();
    expect(advancedRegionId("memory")).toBe("settings-advanced-memory");
  });

  it("reports duplicate ids and anchors, empty words and malformed ids", () => {
    expect(settingsCardProblems(cards)).toEqual([]);
    const bad: SettingsCard[] = [...cards, { ...cards[0]!, words: [] }, { id: "Nope", section: "usage", advanced: false, surface: "any", words: ["x"], anchor: "about-me-heading" }];
    expect(settingsCardProblems(bad)).toEqual(["duplicate id general.profile", "duplicate anchor profile-heading", "general.profile has no words", "duplicate anchor about-me-heading", "Nope is not section.name"]);
  });
});
