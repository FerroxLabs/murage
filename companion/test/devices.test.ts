// Companion device registry contract. The three properties that matter:
// a token is never recoverable from disk, a pairing code cannot be ground
// down by guessing, and revoking a device actually revokes it.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  bearerToken,
  cleanDeviceName,
  DeviceRegistry,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_TTL_MS,
} from "../src/devices.ts";

const pair = (registry: DeviceRegistry, name = "iPhone") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

describe("DeviceRegistry", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("issues a token that authenticates, and never stores it", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    expect(token.startsWith("omb_")).toBe(true);
    expect(registry.authenticate(token)?.id).toBe(device.id);

    // the file on disk holds a digest, not the credential
    const raw = readFileSync(join(DATA_DIR, "devices.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).devices[0].tokenHash).toHaveLength(64);

    // and nothing the UI can read exposes it either
    expect(JSON.stringify(registry.list())).not.toContain(token);
    expect(registry.list()[0]).not.toHaveProperty("tokenHash");
  });

  it("survives a restart", () => {
    const { token } = pair(new DeviceRegistry());
    expect(new DeviceRegistry().authenticate(token)).not.toBeNull();
  });

  it("refuses unknown, empty, and near-miss tokens", () => {
    const registry = new DeviceRegistry();
    const { token } = pair(registry);

    expect(registry.authenticate(undefined)).toBeNull();
    expect(registry.authenticate("")).toBeNull();
    expect(registry.authenticate("omb_nope")).toBeNull();
    expect(registry.authenticate(token.slice(0, -1))).toBeNull();
    expect(registry.authenticate(`${token}x`)).toBeNull();
  });

  it("burns the pairing window after too many wrong codes", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i < MAX_PAIRING_ATTEMPTS; i++) {
      expect(registry.redeem(wrong, "iPhone")).toEqual({ error: "that code is not right" });
      expect(registry.pairing()).not.toBeNull();
    }
    // the last one closes the window rather than counting down forever
    expect(registry.redeem(wrong, "iPhone")).toMatchObject({ error: expect.stringContaining("start pairing again") });
    expect(registry.pairing()).toBeNull();

    // and the real code is worthless now
    expect(registry.redeem(code, "iPhone")).toMatchObject({ error: expect.stringContaining("no pairing") });
    expect(registry.count()).toBe(0);
  });

  it("spends a code exactly once", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone")).toHaveProperty("token");
    expect(registry.redeem(code, "iPad")).toMatchObject({ error: expect.stringContaining("no pairing") });
    expect(registry.count()).toBe(1);
  });

  it("refuses an expired window without a timer", () => {
    // Move the clock, not the object. Ageing the window returned by
    // openPairing() only works while that object is the registry's own — the
    // day it hands back a copy, the test would be asserting against something
    // the registry never reads. The contract is "expiry is evaluated on read
    // against the wall clock", so the clock is the thing to control.
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { code } = registry.openPairing();
      expect(registry.pairing()).not.toBeNull();

      // one tick short of the TTL: still live, so the assertion below is
      // about expiry rather than about pairing being broken outright
      vi.advanceTimersByTime(PAIRING_TTL_MS - 1);
      expect(registry.pairing()).not.toBeNull();

      vi.advanceTimersByTime(2);
      expect(registry.pairing()).toBeNull();
      expect(registry.redeem(code, "iPhone")).toMatchObject({
        error: expect.stringContaining("no pairing"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes one device without touching the others", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry, "iPhone");
    const tablet = pair(registry, "iPad");
    expect(registry.count()).toBe(2);

    expect(registry.revoke(phone.device.id)).toBe(true);
    expect(registry.revoke(phone.device.id)).toBe(false);
    expect(registry.authenticate(phone.token)).toBeNull();
    expect(registry.authenticate(tablet.token)?.name).toBe("iPad");

    // revocation is durable, not just in-memory
    expect(new DeviceRegistry().authenticate(phone.token)).toBeNull();
  });

  it("treats a corrupt devices.json as no paired devices", () => {
    pair(new DeviceRegistry());
    writeFileSync(join(DATA_DIR, "devices.json"), "{ not json");
    expect(new DeviceRegistry().count()).toBe(0);
  });
});

describe("authenticate under a failing disk", () => {
  it("still authenticates when the lastSeenAt write throws", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    // A read-only home or a full disk. The write being attempted here is the
    // "last seen" timestamp, which decorates a row in a settings panel — it
    // must not be able to sign a working phone out, on every request, for
    // the user least equipped to work out why.
    let attempted = 0;
    (registry as unknown as { persist: () => void }).persist = () => {
      attempted++;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };

    expect(registry.authenticate(token)?.id).toBe(device.id);
    expect(attempted).toBe(1);
    // and again, so a throw cannot poison the path for later calls either
    expect(registry.authenticate(token)?.id).toBe(device.id);
  });
});

describe("cleanDeviceName", () => {
  it("clamps, trims, and strips control characters", () => {
    expect(cleanDeviceName("  Milind's iPhone  ")).toBe("Milind's iPhone");
    // an untrusted label must not carry NULs or ANSI escapes into a UI
    expect(cleanDeviceName("bad\u0000name\u001b[31m")).toBe("bad name [31m");
    expect(cleanDeviceName("x".repeat(200))).toHaveLength(60);
  });

  it("falls back rather than allowing an empty label", () => {
    expect(cleanDeviceName("")).toBe("Companion");
    expect(cleanDeviceName(undefined)).toBe("Companion");
    expect(cleanDeviceName("   ")).toBe("Companion");
  });
});

describe("bearerToken", () => {
  it("reads only a well-formed Bearer header", () => {
    expect(bearerToken("Bearer omb_abc")).toBe("omb_abc");
    expect(bearerToken("  Bearer omb_abc  ")).toBe("omb_abc");
    expect(bearerToken("omb_abc")).toBeUndefined();
    expect(bearerToken("Basic omb_abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it("treats the scheme as case-insensitive, per RFC 7235", () => {
    // The proxy's own parser always accepted these. This one did not, so a
    // header authenticated or failed depending on which code path met it.
    expect(bearerToken("bearer omb_abc")).toBe("omb_abc");
    expect(bearerToken("BEARER omb_abc")).toBe("omb_abc");
    expect(bearerToken("BeArEr omb_abc")).toBe("omb_abc");
    // still not a free-for-all
    expect(bearerToken("beareromb_abc")).toBeUndefined();
    expect(bearerToken("Bearer   ")).toBeUndefined();
  });
});

describe("a pairing that cannot be saved", () => {
  // Same throwaway state as the suite above — a registry built on a leftover
  // devices.json would start with a device already in it.
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is not left live in memory", () => {
    const registry = new DeviceRegistry();
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("EROFS: read-only file system");
    };

    const { code } = registry.openPairing();
    const result = registry.redeem(code, "iPhone");

    // A device kept in memory but never written is paired until the next
    // restart and then silently is not — the phone holds a token that stops
    // working with nothing to explain it. Fail the pairing instead.
    expect("error" in result).toBe(true);
    expect(registry.count()).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});
