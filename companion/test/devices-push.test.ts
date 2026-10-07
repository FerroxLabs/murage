// Spec §3.5 "Two scoped tokens per device": bound to the device record and
// revoked with it on sign-out, device revocation or re-pair.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeCrypto from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry, PUSH_BINDING, PUSH_TOKEN, PUSH_TOKEN_TTL_MS } from "../src/devices.ts";
import { TOKEN_PATTERNS, UUID } from "../../shared/mobile-push.ts";

// Vitest cannot spy on a native ESM module's export directly ("Module
// namespace is not configurable"), so the rollback test below instead mocks
// node:crypto with a randomBytes that still calls the real implementation —
// it forwards, unlike a stub, so every other test's randomness (device
// tokens, pairing codes, uuids) is untouched — and only wraps it in a vi.fn
// so the rollback test can read back what it returned.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const INSTALL = "install-0123456789abcdef";
const file = () => join(DATA_DIR, "devices.json");
const pair = (registry: DeviceRegistry, installId?: string) => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, "iPhone", undefined, installId);
  if ("error" in result) throw new Error(result.error);
  return result.device;
};
/** `registry.persist` is private; the house pattern (see devices.test.ts's
 * "keeps the old record when the replacement cannot be written") is to
 * shadow it on the instance with a throwing stand-in, then delete the
 * shadow to restore the real method. */
const breakPersist = (registry: DeviceRegistry): (() => void) => {
  const target = registry as unknown as { persist?: () => void };
  target.persist = () => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  return () => {
    delete target.persist;
  };
};

describe("push tokens in the device record", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  // The review that followed this task's first pass found that devices.ts
  // had started importing shared/mobile-push.ts's patterns directly, which
  // compiles under tsconfig.server.json but breaks tsconfig.companion.build.json
  // (rootDir: companion/src) and so the packaged sidecar. devices.ts now
  // duplicates them inline; this is the guard against the two silently
  // drifting apart. Only this test file may import shared/ — it isn't part
  // of the companion build.
  it("keeps its inline patterns identical to shared/mobile-push.ts", () => {
    expect(PUSH_BINDING.source).toBe(UUID.source);
    expect(PUSH_BINDING.flags).toBe(UUID.flags);
    expect(PUSH_TOKEN.detail.source).toBe(TOKEN_PATTERNS.detail.source);
    expect(PUSH_TOKEN.detail.flags).toBe(TOKEN_PATTERNS.detail.flags);
    expect(PUSH_TOKEN.respond.source).toBe(TOKEN_PATTERNS.respond.source);
    expect(PUSH_TOKEN.respond.flags).toBe(TOKEN_PATTERNS.respond.flags);
  });

  it("issues two tokens that authenticate only in their own scope, and stores digests only", () => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    const issued = registry.issuePushTokens(device.id, B, 1000)!;
    expect(issued.detail).toMatch(/^murage_pd_[A-Za-z0-9_-]{43}$/);
    expect(issued.respond).toMatch(/^murage_pr_[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(1000 + PUSH_TOKEN_TTL_MS);
    expect(registry.authenticatePush(issued.detail, "detail", 2000)).toEqual({ deviceId: device.id, bindingId: B });
    expect(registry.authenticatePush(issued.respond, "respond", 2000)).toEqual({ deviceId: device.id, bindingId: B });
    expect(registry.authenticatePush(issued.detail, "respond", 2000)).toBeNull();
    expect(registry.authenticatePush(issued.respond, "detail", 2000)).toBeNull();
    const raw = readFileSync(file(), "utf8");
    expect(raw).not.toContain(issued.detail);
    expect(raw).not.toContain(issued.respond);
    expect(registry.list()[0]).not.toHaveProperty("push");
    expect(registry.pushBinding(device.id)).toBe(B);
  });

  it("survives a restart and dies at its expiry", () => {
    const first = new DeviceRegistry();
    const device = pair(first);
    const issued = first.issuePushTokens(device.id, B, 1000)!;
    const second = new DeviceRegistry();
    expect(second.authenticatePush(issued.detail, "detail", 1000 + PUSH_TOKEN_TTL_MS - 1)?.deviceId).toBe(device.id);
    expect(second.authenticatePush(issued.detail, "detail", 1000 + PUSH_TOKEN_TTL_MS)).toBeNull();
  });

  it("reissuing kills the previous pair", () => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    const old = registry.issuePushTokens(device.id, B)!;
    const fresh = registry.issuePushTokens(device.id, B)!;
    expect(registry.authenticatePush(old.detail, "detail")).toBeNull();
    expect(registry.authenticatePush(fresh.detail, "detail")?.deviceId).toBe(device.id);
  });

  it("a failed write during issuance rolls back: the previous tokens stay live, the ones that never landed on disk do not authenticate", () => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    const first = registry.issuePushTokens(device.id, B)!;

    // The mocked randomBytes still returns the real random bytes (see the
    // vi.mock above) — recording, not stubbing — so what it returns for the
    // detail token minted inside the doomed call can be read back afterwards
    // without this test guessing at or fixing the randomness.
    const recorded = vi.mocked(nodeCrypto.randomBytes);
    recorded.mockClear();
    const restore = breakPersist(registry);
    try {
      expect(() => registry.issuePushTokens(device.id, B)).toThrow();
    } finally {
      restore();
    }
    // issuePushTokens calls randomBytes(32) twice, detail then respond, and
    // rejects before either return value leaves the function.
    const doomedDetail = `murage_pd_${(recorded.mock.results[0]!.value as Buffer).toString("base64url")}`;

    expect(registry.authenticatePush(first.detail, "detail")?.deviceId).toBe(device.id);
    expect(registry.authenticatePush(first.respond, "respond")?.deviceId).toBe(device.id);
    expect(registry.pushBinding(device.id)).toBe(B);
    expect(registry.authenticatePush(doomedDetail, "detail")).toBeNull();
  });

  it("drops a malformed push record on load instead of throwing, and treats the device as never registered", () => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    registry.issuePushTokens(device.id, B);

    const stored = JSON.parse(readFileSync(file(), "utf8"));
    stored.devices[0].push = {
      bindingId: "not-a-uuid",
      detailHash: "too-short",
      respondHash: "too-short",
      issuedAt: "yesterday",
      expiresAt: "tomorrow",
    };
    writeFileSync(file(), JSON.stringify(stored));

    expect(() => new DeviceRegistry()).not.toThrow();
    const reloaded = new DeviceRegistry();
    expect(reloaded.pushBinding(device.id)).toBeNull();
    expect(reloaded.list().find((d) => d.id === device.id)).not.toHaveProperty("push");
  });

  it.each([
    ["null", null],
    ["a string", "murage_pd_notreally"],
    ["a number", 4],
  ])("drops a push field that is %s", (_label, value) => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    const stored = JSON.parse(readFileSync(file(), "utf8"));
    stored.devices[0].push = value;
    writeFileSync(file(), JSON.stringify(stored));

    expect(() => new DeviceRegistry()).not.toThrow();
    expect(new DeviceRegistry().pushBinding(device.id)).toBeNull();
  });

  it("revoking the device kills both tokens and says which device went", () => {
    const registry = new DeviceRegistry();
    const removed = vi.fn();
    registry.onDeviceRemoved(removed);
    const device = pair(registry);
    const issued = registry.issuePushTokens(device.id, B)!;
    registry.revoke(device.id);
    expect(registry.authenticatePush(issued.detail, "detail")).toBeNull();
    expect(registry.authenticatePush(issued.respond, "respond")).toBeNull();
    expect(removed).toHaveBeenCalledWith(device.id);
  });

  it("signing the device out kills both tokens and fires the same listener as revoke", () => {
    const registry = new DeviceRegistry();
    const removed = vi.fn();
    registry.onDeviceRemoved(removed);
    const device = pair(registry);
    const issued = registry.issuePushTokens(device.id, B)!;
    const { value } = registry.openSession(device.id, "Safari")!;

    const signedOut = registry.signOutDevice(value);
    expect(signedOut).toBe(device.id);
    expect(registry.authenticatePush(issued.detail, "detail")).toBeNull();
    expect(registry.authenticatePush(issued.respond, "respond")).toBeNull();
    expect(removed).toHaveBeenCalledWith(device.id);
  });

  it("a re-pair of the same install kills the old tokens", () => {
    const registry = new DeviceRegistry();
    const removed = vi.fn();
    registry.onDeviceRemoved(removed);
    const first = pair(registry, INSTALL);
    const issued = registry.issuePushTokens(first.id, B)!;
    const second = pair(registry, INSTALL);
    expect(second.id).not.toBe(first.id);
    expect(registry.authenticatePush(issued.detail, "detail")).toBeNull();
    expect(removed).toHaveBeenCalledWith(first.id);
  });

  it("refuses an unknown device, a malformed binding, a malformed token and a well-formed but unknown token", () => {
    const registry = new DeviceRegistry();
    const device = pair(registry);
    registry.issuePushTokens(device.id, B);
    expect(registry.issuePushTokens("nope", B)).toBeNull();
    expect(registry.issuePushTokens(device.id, "not-a-uuid")).toBeNull();
    expect(registry.authenticatePush("murage_pd_short", "detail")).toBeNull();
    expect(registry.authenticatePush(undefined, "detail")).toBeNull();
    // Right shape, matches no device's hash: the search comes up empty
    // rather than the format check rejecting it.
    const wellFormedButUnknown = `murage_pd_${nodeCrypto.randomBytes(32).toString("base64url")}`;
    expect(registry.authenticatePush(wellFormedButUnknown, "detail")).toBeNull();
  });

  it("a listener that throws does not stop a second listener, and the revoke still lands", () => {
    const registry = new DeviceRegistry();
    const second = vi.fn();
    registry.onDeviceRemoved(() => {
      throw new Error("boom");
    });
    registry.onDeviceRemoved(second);
    const device = pair(registry);
    expect(registry.revoke(device.id)).toBe(true);
    expect(second).toHaveBeenCalledWith(device.id);
    expect(registry.list().find((d) => d.id === device.id)).toBeUndefined();
  });

  it("unsubscribes: a removed listener is not called for a later removal", () => {
    const registry = new DeviceRegistry();
    const heard = vi.fn();
    const unsubscribe = registry.onDeviceRemoved(heard);
    const first = pair(registry, "install-aaaaaaaaaaaaaaaa");
    const second = pair(registry, "install-bbbbbbbbbbbbbbbb");

    registry.revoke(first.id);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith(first.id);

    unsubscribe();
    registry.revoke(second.id);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
