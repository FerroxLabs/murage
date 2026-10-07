import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { callStatusText } from "./call-status";

const base = { phase: "listening" as const, held: false, connecting: false, muted: false, pushToTalk: false };

describe("the 1:1 call's status line", () => {
  it("names the phase in a bare word, never the bot: Listening, One moment, Speaking, Working", () => {
    expect(callStatusText({ ...base, phase: "listening" })).toBe("Listening");
    expect(callStatusText({ ...base, phase: "sending" })).toBe("One moment");
    // the bot's name is already the line above; "Ada" under "Ada" said nothing
    expect(callStatusText({ ...base, phase: "speaking" })).toBe("Speaking");
    expect(callStatusText({ ...base, phase: "working" })).toBe("Working");
    expect(callStatusText({ ...base, phase: "listening", pushToTalk: true })).toBe("Push to talk");
  });

  it("Call paused wins over Connecting, which wins over Muted, which wins over the phase", () => {
    expect(callStatusText({ ...base, held: true, connecting: true, muted: true })).toBe("Call paused");
    expect(callStatusText({ ...base, connecting: true, muted: true })).toBe("Connecting…");
    expect(callStatusText({ ...base, muted: true, phase: "speaking" })).toBe("Muted");
  });

  it("every status is in the catalog, so a language pack can carry it", () => {
    for (const key of ["paused", "connecting", "muted", "pushToTalk", "listening", "oneMoment", "speaking", "working"] as const) {
      expect(typeof en[`calls.status.${key}`]).toBe("string");
    }
    expect(en["calls.status.speaking"]).toBe("Speaking");
  });
});
