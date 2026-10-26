// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { browserIsThePlace } from "./browser-is-the-place";

describe("browser is the place in the panel", () => {
  for (const computer of [undefined, "off", "browser", "local", "vm", "cloud"] as const) {
    for (const browser of [undefined, false, true]) {
      for (const enabled of [undefined, false, true]) {
        it.each([undefined, false, true])(`${computer ?? "auto"}, browser=${browser}, enabled=${enabled}, capability=%s`, browserMcp => {
          expect(browserIsThePlace({ computer, browser }, { features: { browser: enabled } }, { capabilities: { browserMcp } }))
            .toBe((computer === "off" || computer === "browser") && browser !== false && enabled === true && browserMcp === true);
        });
      }
    }
  }

  it("waits for configuration and the selected engine", () => {
    expect(browserIsThePlace({ computer: "off" }, null, { capabilities: { browserMcp: true } })).toBe(false);
    expect(browserIsThePlace({ computer: "browser" }, { features: { browser: true } }, undefined)).toBe(false);
  });
});
