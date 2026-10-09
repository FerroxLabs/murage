// SPDX-License-Identifier: AGPL-3.0-or-later
// D2: the browser side panel and the app's mascot read one colour table, so a bot is the same colour in both.
import { describe, expect, it } from "vitest";
import { EMBER_COLORS } from "./mascot";
import { EMBER_COLOR_HEX, botColorHex } from "../../shared/ember-colors";

describe("one colour table", () => {
  it("is the table the mascot paints with", () => {
    expect(EMBER_COLORS).toEqual(EMBER_COLOR_HEX);
    for (const [name, hex] of Object.entries(EMBER_COLORS)) expect(botColorHex(name)).toBe(hex);
  });
});
