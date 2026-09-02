// Browser sessions, in the device registry.
//
// A session is a second credential *form* for an existing paired device, not
// a second identity. Everything below is a consequence of that choice, and
// the reason it was made: there is no second store to keep consistent, so
// revocation works on browsers on day one with no new revocation path.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  DeviceRegistry,
  MAX_SESSIONS_PER_DEVICE,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from "../src/devices.ts";

const pair = (registry: DeviceRegistry, name = "iPhone") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

describe("browser sessions", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("keeps only the digest, exactly as a device token does", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari on iPhone");
    expect(session).not.toBeNull();

    const raw = readFileSync(join(DATA_DIR, "devices.json"), "utf8");
    // A stolen devices.json is not a stolen fleet, and now not a stolen
    // browser either.
    expect(raw).not.toContain(session!.value);
    expect(JSON.parse(raw).devices[0].sessions[0].hash).toHaveLength(64);

    // and nothing the control page renders exposes even the digest
    expect(JSON.stringify(registry.list())).not.toContain("hash");
    expect(registry.list()[0]).not.toHaveProperty("sessions");
  });

  it("resolves a cookie back to its device, and nothing else to anything", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari")!;

    expect(registry.resolveSession(session.value)?.device.id).toBe(device.id);
    expect(registry.resolveSession("murage_browser_not_a_real_one")).toBeNull();
    expect(registry.resolveSession(undefined)).toBeNull();
    expect(registry.resolveSession("")).toBeNull();
  });

  it("cannot outlive the device it hangs off", () => {
    // The whole reason sessions live inside DeviceRecord. Revoking a phone
    // signs out every browser opened against it, with no second store to
    // remember to clear and no window in which the two disagree.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari")!;
    expect(registry.resolveSession(session.value)).not.toBeNull();

    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.resolveSession(session.value)).toBeNull();

    // and it does not come back when the file is re-read
    expect(new DeviceRegistry().resolveSession(session.value)).toBeNull();
  });

  it("survives a restart, because the sidecar restarts with the app", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari on iPhone")!;

    const reloaded = new DeviceRegistry();
    const resolved = reloaded.resolveSession(session.value);
    expect(resolved?.device.id).toBe(device.id);
    // A design that signs the phone out daily is a design Sean turns off.
    expect(resolved?.session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("signs out one browser without touching the others", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const first = registry.openSession(device.id, "Safari")!;
    const second = registry.openSession(device.id, "Chrome")!;

    expect(registry.closeSession(first.value)).toBe(true);
    expect(registry.resolveSession(first.value)).toBeNull();
    expect(registry.resolveSession(second.value)?.device.id).toBe(device.id);
    // and signing out something that was never open is not a success
    expect(registry.closeSession(first.value)).toBe(false);
  });

  it("caps the sessions per device, evicting least-recently-used", () => {
    // A browser that clears cookies weekly must not grow the file without
    // bound, and the person in front of the machine must not be the one
    // refused.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = Array.from({ length: MAX_SESSIONS_PER_DEVICE + 1 }, (_, i) =>
      registry.openSession(device.id, `browser ${i}`)!,
    );
    expect(opened.every(Boolean)).toBe(true);

    // The oldest is gone; the newest works.
    expect(registry.resolveSession(opened[0].value)).toBeNull();
    for (const session of opened.slice(1)) {
      expect(registry.resolveSession(session.value)).not.toBeNull();
    }
    expect(JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices[0].sessions).toHaveLength(
      MAX_SESSIONS_PER_DEVICE,
    );
  });

  it("expires on the rolling idle window", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari")!;

    // A fortnight and a minute of not being opened.
    const later = Date.now() + SESSION_IDLE_MS + 60_000;
    vi.setSystemTime(later);
    expect(registry.resolveSession(session.value)).toBeNull();
    vi.useRealTimers();

    // and the dead row is taken out on the way past rather than re-judged
    // on every later request
    const file = JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8"));
    expect(file.devices[0].sessions ?? []).toHaveLength(0);
  });

  it("expires on the absolute cap even when it is used constantly", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const session = registry.openSession(device.id, "Safari")!;

    // Used every day for three months. The idle window keeps rolling
    // forward; the absolute cap does not move.
    for (let day = 1; day <= 91; day += 1) {
      vi.setSystemTime(Date.now() + 24 * 3600 * 1000);
      const alive = registry.resolveSession(session.value);
      if (day * 24 * 3600 * 1000 < SESSION_ABSOLUTE_MS) {
        expect(alive, `day ${day}`).not.toBeNull();
      } else {
        expect(alive, `day ${day}`).toBeNull();
      }
    }
    vi.useRealTimers();
  });

  it("refuses to open a session against a device that is not there", () => {
    const registry = new DeviceRegistry();
    expect(registry.openSession("dev_that_never_paired", "Safari")).toBeNull();
  });

  it("drops a stored session with no hash rather than completing one", () => {
    // The opposite call from the device fields, and for the opposite reason:
    // those decorate a working credential, this one *is* the credential. A
    // row without a hash can neither authenticate nor be signed out.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    registry.openSession(device.id, "Safari");

    const path = join(DATA_DIR, "devices.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    // Not expired, on purpose: an expired row would be dropped by the
    // expiry filter and the missing-hash rule would never be exercised.
    const now = Date.now();
    file.devices[0].sessions.push({
      label: "no hash",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_ABSOLUTE_MS,
    });
    writeFileSync(path, JSON.stringify(file));

    const reloaded = new DeviceRegistry();
    // The hashless row is gone, and the good one is untouched.
    reloaded.openSession(device.id, "another");
    const after = JSON.parse(readFileSync(path, "utf8")).devices[0].sessions;
    expect(after).toHaveLength(2);
    expect(after.every((s: { hash?: string }) => typeof s.hash === "string")).toBe(true);
    expect(reloaded.resolveSession("anything")).toBeNull();
  });
});
