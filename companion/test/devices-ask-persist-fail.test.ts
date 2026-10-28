// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the device list cannot be saved after the revoke floor was written, the floor stays up (it never goes down) and the ask bearer is refused at
// once, the same answer a restart would give. The caller still gets an error because the device record did not change.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const FLOOR = join(DATA_DIR, "ask-floor.json");
const floor = () => JSON.parse(readFileSync(FLOOR, "utf8")) as { through: Record<string, number>; off: Record<string, boolean> };
const pair = (registry: DeviceRegistry) => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, "iPhone");
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};
const failSave = (registry: DeviceRegistry) => vi.spyOn(registry as unknown as { persist(): void }, "persist").mockImplementation(() => { throw new Error("disk full"); });

describe("a failed save after the ask floor was raised fails closed", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("revokePhoneAsk: the bearer is refused at once and after a restart, the floor stays up, and the page does not say on", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const minted = registry.issuePhoneAskToken(device.id)!;
    expect(registry.authenticatePhoneAsk(minted.token)).not.toBeNull();
    const failing = failSave(registry);
    try { expect(() => registry.revokePhoneAsk(device.id)).toThrow("disk full"); } finally { failing.mockRestore(); }
    expect(floor().through[device.id]).toBe(minted.generation);
    expect(registry.authenticatePhoneAsk(minted.token)).toBeNull();
    expect(registry.list().find((d) => d.id === device.id)?.shareAsk).not.toBe("on");
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull();
    expect(floor().through[device.id]).toBe(minted.generation);
    // a fresh mint after the disk recovers works and is above the floor
    const again = registry.issuePhoneAskToken(device.id)!;
    expect(again.generation).toBeGreaterThan(minted.generation);
    expect(registry.authenticatePhoneAsk(again.token)).not.toBeNull();
    expect(registry.authenticatePhoneAsk(minted.token)).toBeNull();
    expect(floor().through[device.id]).toBe(minted.generation);
  });

  it("setShareAskAllowed(false): the bearer is refused at once and after a restart, the floor and off bit stay, and the page says off", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const minted = registry.issuePhoneAskToken(device.id)!;
    const failing = failSave(registry);
    try { expect(() => registry.setShareAskAllowed(device.id, false)).toThrow("disk full"); } finally { failing.mockRestore(); }
    expect(floor().through[device.id]).toBe(minted.generation);
    expect(floor().off[device.id]).toBe(true);
    expect(registry.authenticatePhoneAsk(minted.token)).toBeNull();
    expect(registry.issuePhoneAskToken(device.id)).toBeNull();
    expect(registry.list().find((d) => d.id === device.id)?.shareAsk).toBe("off");
    const restarted = new DeviceRegistry();
    expect(restarted.authenticatePhoneAsk(minted.token)).toBeNull();
    expect(restarted.list().find((d) => d.id === device.id)?.shareAsk).toBe("off");
    expect(floor().through[device.id]).toBe(minted.generation);
  });
});
