// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// R40 Settings G9 review, mockup finding 1: the interface font lives inside Appearance,
// so searching for it lands on that card, not on nothing or on a neighbour.
import { describe, expect, it } from "vitest";

import { searchSettingsIndex, type SettingsFindContext } from "./settings-search";

const APP: SettingsFindContext = { desktop: true, cloud: false, bots: [{ id: "b-nova", name: "Nova" }] };
const PHONE: SettingsFindContext = { desktop: false, cloud: false, bots: [{ id: "b-nova", name: "Nova" }] };

describe("interface font is findable in Appearance", () => {
  it.each(["font", "fonts", "interface font", "typeface", "lettering"])("%s -> general.appearance", (q) => {
    expect(searchSettingsIndex(q, APP).hits.map((hit) => hit.entry.id)[0]).toBe("general.appearance");
  });
  it("also on a phone, where Appearance shows too", () => {
    expect(searchSettingsIndex("font", PHONE).hits.map((hit) => hit.entry.id)[0]).toBe("general.appearance");
  });
});
