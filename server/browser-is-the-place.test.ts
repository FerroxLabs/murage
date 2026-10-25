// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { browserIsThePlace } from "./browser-is-the-place.ts";

describe("browser is the place", () => {
  for (const computer of [undefined, "off", "browser", "local", "vm", "cloud"] as const) {
    it.each([false, true])(`${computer ?? "auto"} with browser mounted=%s`, browserMounted => {
      expect(browserIsThePlace(computer, browserMounted))
        .toBe(browserMounted && (computer === "off" || computer === "browser"));
    });
  }
});
