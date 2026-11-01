// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { searchSettingsCards } from "@/lib/settings-search";
import { TimeZoneSettings, commitChoice, matchZone, timeZoneView, zoneChoices, zoneNow } from "./TimeZoneSettings";

const KEYS = Object.keys(en).filter((key) => key.startsWith("settings.timeZone.") || key === "settings.l1.card.general.time-zone") as Array<keyof typeof en>;

describe("Settings time zone", () => {
  it("opens with its title, its note and a loading line", () => {
    const html = renderToStaticMarkup(createElement(TimeZoneSettings)).replaceAll("&#x27;", "'");
    expect(html).toContain(en["settings.timeZone.title"]);
    expect(html).toContain(en["settings.timeZone.note"]);
    expect(html).toContain(en["settings.timeZone.loading"]);
  });

  it("saves a zone the owner types even when it is the zone this computer is in, so it can be pinned before a trip", () => {
    const zones = ["America/Chicago", "Asia/Bangkok"];
    const following = { timeZone: "America/Chicago", chosen: false, computerTimeZone: "America/Chicago" };
    expect(commitChoice("America/Chicago", following, true, zones)).toEqual({ kind: "save", zone: "America/Chicago" });
    expect(commitChoice("chicago", following, true, zones)).toEqual({ kind: "save", zone: "America/Chicago" });
    // leaving the untouched field saves nothing
    expect(commitChoice("America/Chicago", following, false, zones)).toEqual({ kind: "keep", zone: "America/Chicago" });
    // once chosen, the same zone again is no change
    expect(commitChoice("America/Chicago", { ...following, chosen: true }, true, zones)).toEqual({ kind: "keep", zone: "America/Chicago" });
    expect(commitChoice("Asia/Bangkok", following, true, zones)).toEqual({ kind: "save", zone: "Asia/Bangkok" });
    expect(commitChoice("Central", following, true, zones)).toEqual({ kind: "unknown" });
  });

  it("never offers to follow the computer on a Cloud home, and says so in its words", () => {
    const home = timeZoneView({ timeZone: "America/Chicago", chosen: true, computerTimeZone: "America/Chicago", canFollowComputer: false });
    expect(home).toEqual({ note: "settings.timeZone.noteHome", line: "settings.timeZone.home", offerFollow: false });
    expect(en[home.note]).not.toMatch(/computer/i);
    expect(en[home.line]).not.toMatch(/computer/i);
    const desktop = { timeZone: "America/Chicago", chosen: true, computerTimeZone: "Asia/Bangkok", canFollowComputer: true };
    expect(timeZoneView(desktop)).toEqual({ note: "settings.timeZone.note", line: "settings.timeZone.chosen", offerFollow: true });
    expect(timeZoneView({ ...desktop, chosen: false })).toEqual({ note: "settings.timeZone.note", line: "settings.timeZone.following", offerFollow: false });
    expect(timeZoneView(null).offerFollow).toBe(false);
  });

  it("searches every zone this computer knows, UTC included", () => {
    const zones = zoneChoices();
    expect(zones).toContain("America/Chicago");
    expect(zones).toContain("Asia/Bangkok");
    expect(zones).toContain("UTC");
  });

  it("takes an exact name in any case, or a city that names one zone", () => {
    const zones = ["America/Chicago", "America/New_York", "Asia/Bangkok", "UTC"];
    expect(matchZone("America/Chicago", zones)).toBe("America/Chicago");
    expect(matchZone("america/chicago", zones)).toBe("America/Chicago");
    expect(matchZone("chicago", zones)).toBe("America/Chicago");
    expect(matchZone("New York", zones)).toBe("America/New_York");
    expect(matchZone("utc", zones)).toBe("UTC");
    expect(matchZone("Central", zones)).toBeNull();
    expect(matchZone("", zones)).toBeNull();
  });

  it("shows the time and offset in the zone", () => {
    expect(zoneNow("America/Chicago", new Date("2026-10-27T01:30:00Z"))).toBe("8:30 pm, UTC-05:00");
    expect(zoneNow("America/Chicago", new Date("2026-11-03T15:00:00Z"))).toBe("9:00 am, UTC-06:00");
    expect(zoneNow("Not/AZone")).toBe("");
  });

  it("is found by the words people type for it", () => {
    for (const query of ["time zone", "timezone", "daylight saving", "Time zone"]) {
      expect(searchSettingsCards(query, true, undefined, undefined, undefined, false).map((hit) => hit.card.id), query).toContain("general.time-zone");
    }
  });

  it("uses plain words in English: no em dashes, no \"safe\", no vendor names, no prices", () => {
    expect(KEYS.length).toBe(16);
    for (const key of KEYS) {
      const text = en[key];
      expect(text, key).not.toMatch(/[—–]/);
      expect(text, key).not.toMatch(/\b(?:un)?saf(?:e|ely|ety)\b/i);
      expect(text, key).not.toMatch(/composio|price|cost|\$/i);
    }
  });
});
