import { describe, expect, it } from "vitest";
import { hostStoppedLabel, hostStoppedReason } from "./host-stop";

describe("host-stop notice in the renderer", () => {
  it("spells a host-stop notice as 'Stopped — why' and leaves other activity names alone", () => {
    expect(hostStoppedLabel("stopped: this computer was switched off for the bot")).toBe("Stopped — this computer was switched off for the bot");
    expect(hostStoppedLabel("stopped: the model connection it was using was changed or turned off")).toBe("Stopped — the model connection it was using was changed or turned off");
    expect(hostStoppedLabel("error: claude exited null before result")).toBeUndefined();
    expect(hostStoppedLabel("Read")).toBeUndefined();
    expect(hostStoppedLabel(undefined)).toBeUndefined();
  });
  it("re-exports the shared reason reader", () => {
    expect(hostStoppedReason("stopped: why")).toBe("why");
  });
});
