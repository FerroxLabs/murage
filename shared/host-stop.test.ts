import { describe, expect, it } from "vitest";
import { hostStoppedActivityName, hostStoppedDisplayName, hostStoppedReason } from "./host-stop.ts";

describe("host-stop notice contract", () => {
  it("round-trips the reason through the activity name", () => {
    expect(hostStoppedActivityName("  the model connection it was using was changed or turned off ")).toBe("stopped: the model connection it was using was changed or turned off");
    expect(hostStoppedReason("stopped: this computer was switched off for the bot")).toBe("this computer was switched off for the bot");
    expect(hostStoppedReason("stopped:")).toBeUndefined();
    expect(hostStoppedReason("error: stopped: no")).toBeUndefined();
    expect(hostStoppedReason(undefined)).toBeUndefined();
  });

  it("spells a notice 'Stopped — <reason>' for surfaces without the renderer's locale (export, delegation summaries)", () => {
    expect(hostStoppedDisplayName("stopped: this computer was switched off for the bot")).toBe("Stopped — this computer was switched off for the bot");
    expect(hostStoppedDisplayName("Bash")).toBeUndefined();
    expect(hostStoppedDisplayName("error: claude exited null before result")).toBeUndefined();
    expect(hostStoppedDisplayName(null)).toBeUndefined();
  });
});
