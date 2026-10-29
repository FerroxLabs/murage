// A phone that signs out or re-pairs loses its in-flight ask forwards (S33, carried from S32).
import { beforeEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/devices.ts";
import { abortAskForwardsOnRemoval, AskForwards } from "../src/phone-door.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

describe("ask forwards end with the device", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("a sign-out or revoke aborts that device's forwards and leaves another device's alone", () => {
    const devices = new DeviceRegistry();
    const forwards = new AskForwards();
    abortAskForwardsOnRemoval(devices, forwards);
    const pair = (name: string) => {
      const result = devices.redeem(devices.openPairing().code, name);
      if ("error" in result) throw new Error(result.error);
      return result;
    };
    const a = pair("Phone A");
    const b = pair("Phone B");
    const mine = forwards.add(a.device.id);
    const other = forwards.add(b.device.id);
    expect(devices.revoke(a.device.id)).toBe(true); // what signOutDevice and the computer's revoke both call
    expect(mine.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("a re-pair of the same install aborts the old record's forwards", () => {
    const devices = new DeviceRegistry();
    const forwards = new AskForwards();
    abortAskForwardsOnRemoval(devices, forwards);
    const first = devices.redeem(devices.openPairing().code, "iPhone", undefined, "ios-install-0123456789abcdef");
    if ("error" in first) throw new Error(first.error);
    const live = forwards.add(first.device.id);
    const second = devices.redeem(devices.openPairing().code, "iPhone", undefined, "ios-install-0123456789abcdef");
    if ("error" in second) throw new Error(second.error);
    expect(second.device.id).not.toBe(first.device.id);
    expect(live.signal.aborted).toBe(true);
  });
});
