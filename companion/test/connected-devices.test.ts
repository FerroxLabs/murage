import { describe, expect, it } from "vitest";

import { createConnectedDeviceTracker } from "../src/connected-devices.ts";

describe("connected device tracker", () => {
  it("keeps a device live until every overlapping event stream closes", () => {
    const tracker = createConnectedDeviceTracker();
    const closeOldRoute = tracker.open("phone-1");
    const closeNewRoute = tracker.open("phone-1");
    const closeOtherPhone = tracker.open("phone-2");

    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeOldRoute();
    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeNewRoute();
    expect(tracker.ids()).toEqual(["phone-2"]);
    closeOtherPhone();
    expect(tracker.ids()).toEqual([]);
  });

  it("makes each stream cleanup idempotent", () => {
    const tracker = createConnectedDeviceTracker();
    const close = tracker.open("phone-1");

    close();
    close();
    expect(tracker.ids()).toEqual([]);
  });
});
