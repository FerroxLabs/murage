// Fix 1 (Grok review): the ask generation floor is on disk, so restoring an older devices.json cannot bring a revoked token back.
import { copyFileSync, readFileSync, statSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const pair = (registry: DeviceRegistry) => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, "iPhone");
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};
const DEVICES = join(DATA_DIR, "devices.json");
const FLOOR = join(DATA_DIR, "ask-floor.json");

describe("persisted ask generation floor", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("revoke, restore a pre-revoke devices.json, new registry: the old token is refused", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before-revoke.json"));
    expect(first.revokePhoneAsk(device.id)).toEqual({ through: minted.generation });
    copyFileSync(join(DATA_DIR, "devices.before-revoke.json"), DEVICES);

    const second = new DeviceRegistry();
    expect(second.authenticatePhoneAsk(minted.token)).toBeNull();
    // a fresh mint is above everything the harness refuses
    expect(second.issuePhoneAskToken(device.id)!.generation).toBeGreaterThan(minted.generation);
  });

  it("switching the phone off also survives a restore", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before-off.json"));
    first.setShareAskAllowed(device.id, false);
    copyFileSync(join(DATA_DIR, "devices.before-off.json"), DEVICES);
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull();
  });

  it("the floor file is 0600 and written before the hash leaves devices.json", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const minted = registry.issuePhoneAskToken(device.id)!;
    registry.revokePhoneAsk(device.id);
    expect(existsSync(FLOOR)).toBe(true);
    if (process.platform !== "win32") expect(statSync(FLOOR).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(FLOOR, "utf8")).through[device.id]).toBe(minted.generation);
  });

  it("never lowers: a later revoke of a lower generation keeps the higher floor", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    registry.issuePhoneAskToken(device.id);
    registry.revokePhoneAsk(device.id);
    registry.issuePhoneAskToken(device.id);
    registry.issuePhoneAskToken(device.id);
    const high = registry.revokePhoneAsk(device.id)!.through;
    expect(JSON.parse(readFileSync(FLOOR, "utf8")).through[device.id]).toBe(high);
    registry.revokePhoneAsk(device.id);
    expect(JSON.parse(readFileSync(FLOOR, "utf8")).through[device.id]).toBeGreaterThanOrEqual(high);
  });

  it("a token minted after the revoke is still honoured by a new registry", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    first.issuePhoneAskToken(device.id);
    first.revokePhoneAsk(device.id);
    const fresh = first.issuePhoneAskToken(device.id)!;
    expect(new DeviceRegistry().authenticatePhoneAsk(fresh.token)?.deviceId).toBe(device.id);
  });

  it("a corrupt ask-floor.json fails closed: every ask token is refused, with one log line and no device id", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)?.deviceId).toBe(device.id);
    writeFileSync(FLOOR, "{ not json");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    try {
      const second = new DeviceRegistry();
      expect(second.authenticatePhoneAsk(minted.token)).toBeNull();
      second.list();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(device.id);
    } finally { spy.mockRestore(); }
    // the phone can mint again after re-bootstrapping
    expect(new DeviceRegistry().issuePhoneAskToken(device.id)!.generation).toBeGreaterThan(minted.generation);
  });

  it("a missing ask-floor.json is a first run and keeps ask tokens", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    expect(existsSync(FLOOR)).toBe(false);
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)?.deviceId).toBe(device.id);
  });

  it("a reload in the same process after a revoke does not lift a restored revoked token", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const minted = registry.issuePhoneAskToken(device.id)!;
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before-revoke.json"));
    registry.revokePhoneAsk(device.id);
    copyFileSync(join(DATA_DIR, "devices.before-revoke.json"), DEVICES);
    (registry as unknown as { unavailable: string | null }).unavailable = "forced";
    expect(registry.reload()).toBe(true);
    expect(registry.authenticatePhoneAsk(minted.token)).toBeNull();
  });

  it("a corrupt floor is repaired durably: deleting the bad file and restarting still refuses the old token", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    writeFileSync(FLOOR, "{ not json");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull();
    } finally { spy.mockRestore(); }
    // the strip reached devices.json, and the floor was rebuilt from what is known
    const onDisk = JSON.parse(readFileSync(DEVICES, "utf8")).devices[0];
    expect(onDisk.ask).toBeUndefined();
    expect(JSON.parse(readFileSync(FLOOR, "utf8")).through[device.id]).toBeGreaterThanOrEqual(minted.generation);
    rmSync(FLOOR);
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull();
  });

  it("a restored pre-corruption devices.json is refused against the rebuilt floor", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before.json"));
    writeFileSync(FLOOR, "garbage");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try { new DeviceRegistry(); } finally { spy.mockRestore(); }
    copyFileSync(join(DATA_DIR, "devices.before.json"), DEVICES);
    expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull();
  });

  it("when the strip cannot be written, the registry is unavailable and no ask token is served", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    writeFileSync(FLOOR, "garbage");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const persist = vi.spyOn(DeviceRegistry.prototype as unknown as { persist(): void }, "persist").mockImplementation(() => { throw new Error("crash"); });
    try {
      const second = new DeviceRegistry();
      expect(second.registryStatus().available).toBe(false);
      expect(second.authenticatePhoneAsk(minted.token)).toBeNull();
    } finally { persist.mockRestore(); spy.mockRestore(); }
  });

  it("a revoke never overwrites a floor that went corrupt while running", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    registry.issuePhoneAskToken(device.id);
    writeFileSync(FLOOR, "garbage");
    expect(() => registry.revokePhoneAsk(device.id)).toThrow();
    expect(readFileSync(FLOOR, "utf8")).toBe("garbage");
  });

  it("the share-and-ask off switch is in the floor file: a restored pre-off devices.json cannot mint", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    first.issuePhoneAskToken(device.id);
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before-off.json"));
    first.setShareAskAllowed(device.id, false);
    copyFileSync(join(DATA_DIR, "devices.before-off.json"), DEVICES);
    const second = new DeviceRegistry();
    expect(second.issuePhoneAskToken(device.id)).toBeNull();
    expect(second.list().find((d) => d.id === device.id)?.shareAsk).toBe("off");
    // switching it back on clears the bit for good
    second.setShareAskAllowed(device.id, true);
    expect(new DeviceRegistry().issuePhoneAskToken(device.id)).not.toBeNull();
  });

  it.each([
    ["a negative floor", { v: 1, through: { x: -1 }, off: {} }],
    ["a fractional floor", { v: 1, through: { x: 1.5 }, off: {} }],
    ["a string floor", { v: 1, through: { x: "2" }, off: {} }],
    ["an off bit that is not true", { v: 1, through: {}, off: { x: 1 } }],
    ["an unknown key", { v: 1, through: {}, off: {}, extra: 1 }],
    ["the old flat shape", { x: 1 }],
    ["an array", []],
  ])("%s makes the whole file corrupt and fails closed", (_name, body) => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    const minted = first.issuePhoneAskToken(device.id)!;
    writeFileSync(FLOOR, JSON.stringify(body));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect(new DeviceRegistry().authenticatePhoneAsk(minted.token)).toBeNull(); } finally { spy.mockRestore(); }
  });

  it("a failed turn-on save leaves the off bit in the floor: a restored pre-off devices.json still cannot mint", () => {
    const first = new DeviceRegistry();
    const { device } = pair(first);
    first.issuePhoneAskToken(device.id);
    copyFileSync(DEVICES, join(DATA_DIR, "devices.before-off.json"));
    first.setShareAskAllowed(device.id, false);
    const failing = vi.spyOn(first as unknown as { persist(): void }, "persist").mockImplementation(() => { throw new Error("disk full"); });
    try { expect(() => first.setShareAskAllowed(device.id, true)).toThrow("disk full"); } finally { failing.mockRestore(); }
    expect(JSON.parse(readFileSync(FLOOR, "utf8")).off[device.id]).toBe(true);
    copyFileSync(join(DATA_DIR, "devices.before-off.json"), DEVICES);
    expect(new DeviceRegistry().issuePhoneAskToken(device.id)).toBeNull();
  });
});
