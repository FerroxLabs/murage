import { describe, expect, it } from "vitest";
import { shouldShowNotifyChooser, type NotifySurfacesBridge } from "./notify-surfaces";
import { notifySurfaceDefaults } from "../../shared/notify-surfaces.mjs";

const bridge = (state: unknown, fail = false) => ({ get: async () => { if (fail) throw new Error("x"); return state; } }) as unknown as NotifySurfacesBridge;

describe("shouldShowNotifyChooser", () => {
  it("is true for a new install that has not seen it", async () => {
    expect(await shouldShowNotifyChooser(bridge(notifySurfaceDefaults("new", "darwin")))).toBe(true);
  });
  it("is false for an upgrade", async () => {
    expect(await shouldShowNotifyChooser(bridge(notifySurfaceDefaults("upgrade", "darwin")))).toBe(false);
  });
  it("is false once done or kept inside", async () => {
    for (const chooser of ["done", "kept-inside"]) expect(await shouldShowNotifyChooser(bridge({ ...notifySurfaceDefaults("new", "linux"), chooser }))).toBe(false);
  });
  it("is false with no bridge (web build) and when the read fails", async () => {
    expect(await shouldShowNotifyChooser(null)).toBe(false);
    expect(await shouldShowNotifyChooser(bridge(null, true))).toBe(false);
  });
});
