import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderAvailable, skillRecorderEnabled } from "./feature-flags";

describe("workspace feature flags", () => {
  it.each([{}, { features: {} }, { features: { showToolCalls: false } }])("enables browser and Teach a skill when a loaded config has no switch: %j", (config) => {
    expect(skillRecorderEnabled(config)).toBe(true);
    expect(builtInBrowserEnabled(config)).toBe(true);
  });

  it.each([undefined, null])("waits for the saved switches before enabling either feature: %j", (config) => {
    expect(skillRecorderEnabled(config)).toBe(false);
    expect(builtInBrowserEnabled(config)).toBe(false);
    expect(skillRecorderAvailable(config, true, false)).toBe(false);
  });

  it("honours independent explicit opt-outs", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { skillRecorder: false } })).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(skillRecorderEnabled({ features: { browser: false } })).toBe(true);
  });

  it("honours an explicit on", () => {
    expect(skillRecorderEnabled({ features: { skillRecorder: true } })).toBe(true);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
  });

  it.each([undefined, false, true])("keeps recording off Cloud with desktop=%s, including an explicit on", (desktop) => {
    for (const config of [{}, { features: { skillRecorder: true } }]) {
      expect(skillRecorderAvailable(config, desktop, true)).toBe(false);
      expect(skillRecorderAvailable(config, desktop, false)).toBe(desktop === true);
    }
    expect(skillRecorderAvailable({ features: { skillRecorder: false } }, desktop, false)).toBe(false);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });
});
