import { describe, expect, it, vi } from "vitest";

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

  it("terminates every stream for a revoked device with idempotent cleanup", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateFirst = vi.fn();
    const terminateSecond = vi.fn();
    const closeFirst = tracker.open("phone-1", terminateFirst);
    const closeSecond = tracker.open("phone-1", terminateSecond);
    tracker.open("phone-2");

    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(tracker.ids()).toEqual(["phone-2"]);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();

    closeFirst();
    closeSecond();
    expect(tracker.disconnect("phone-1")).toBe(false);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();
  });

  it("ends one browser session's streams and leaves the other session on the device live", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateSignedOut = vi.fn();
    const terminateOverlap = vi.fn();
    const terminateOtherBrowser = vi.fn();
    const closeSignedOut = tracker.open("phone-1", terminateSignedOut, "session-a");
    tracker.open("phone-1", terminateOverlap, "session-a");
    tracker.open("phone-1", terminateOtherBrowser, "session-b");

    expect(tracker.disconnectSession("session-a")).toBe(true);
    expect(terminateSignedOut).toHaveBeenCalledOnce();
    expect(terminateOverlap).toHaveBeenCalledOnce();
    expect(terminateOtherBrowser).not.toHaveBeenCalled();
    // The device is still present: another browser on it is still streaming.
    expect(tracker.ids()).toEqual(["phone-1"]);

    // Cleanup after termination stays idempotent, and a second end is a no-op.
    closeSignedOut();
    expect(tracker.disconnectSession("session-a")).toBe(false);
    expect(terminateSignedOut).toHaveBeenCalledOnce();
  });

  it("forgets a session's streams when the device is revoked, and a released stream is not ended later", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateReleased = vi.fn();
    const terminateLive = vi.fn();
    const release = tracker.open("phone-1", terminateReleased, "session-a");
    tracker.open("phone-1", terminateLive, "session-a");

    release();
    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(terminateReleased).not.toHaveBeenCalled();
    expect(terminateLive).toHaveBeenCalledOnce();
    // Revoking the device already ended this session's streams.
    expect(tracker.disconnectSession("session-a")).toBe(false);
    expect(tracker.ids()).toEqual([]);
  });

  it("keeps presence until terminate runs, so a close handler sees the device already gone", () => {
    const tracker = createConnectedDeviceTracker();
    const seen: string[][] = [];
    tracker.open("phone-1", () => seen.push(tracker.ids()), "session-a");
    tracker.open("phone-1", () => seen.push(tracker.ids()), "session-a");

    tracker.disconnectSession("session-a");
    expect(seen).toEqual([[], []]);
  });
});
