import { generateKeyPairSync } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry, cleanApprovalKey } from "../src/devices.ts";
import { KEYS, NOW, statement } from "./support-statement.ts";

const INSTALL = "install-0123456789abcdef";
const FILE = join(DATA_DIR, "devices.json");
const point = () => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
};
/** A registry that trusts the test relay key, and a pairing that carries the relay's statement for its key. */
const attested = () => new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });
const pair = (registry: DeviceRegistry, installId?: string, key?: unknown, withStatement = typeof key === "string" && installId !== undefined) => {
  const { code } = registry.openPairing();
  const stmt = withStatement && typeof key === "string" && installId ? statement(installId, key) : undefined;
  const result = registry.redeem(code, "iPhone", undefined, installId, key, stmt);
  if ("error" in result) throw new Error(result.error);
  return result;
};

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("the approval key in the device record", () => {
  it("accepts only an uncompressed P-256 point on the curve", () => {
    const good = point();
    expect(cleanApprovalKey(good)).toBe(good);
    expect(cleanApprovalKey("A".repeat(87))).toBeUndefined(); // right length, not a point
    expect(cleanApprovalKey("short")).toBeUndefined();
    expect(cleanApprovalKey(42)).toBeUndefined();
    expect(cleanApprovalKey(undefined)).toBeUndefined();
    expect(cleanApprovalKey({})).toBeUndefined();
  });

  it("bounds the encoding: length, alphabet, prefix byte and curve membership", () => {
    const good = point();
    expect(cleanApprovalKey(good + "A")).toBeUndefined(); // 88 characters
    expect(cleanApprovalKey(good.slice(0, 86))).toBeUndefined(); // 86 characters
    expect(cleanApprovalKey(good.slice(0, 86) + "=")).toBeUndefined(); // padding is not base64url
    expect(cleanApprovalKey(good.slice(0, 86) + "+")).toBeUndefined(); // standard alphabet
    expect(cleanApprovalKey(` ${good.slice(1)}`)).toBeUndefined();
    const bytes = Buffer.from(good, "base64url");
    const compressedPrefix = Buffer.from(bytes);
    compressedPrefix[0] = 2;
    expect(cleanApprovalKey(compressedPrefix.toString("base64url"))).toBeUndefined();
    const offCurve = Buffer.from(bytes);
    offCurve[64] ^= 1; // nudge y off the curve
    expect(cleanApprovalKey(offCurve.toString("base64url"))).toBeUndefined();
    expect(cleanApprovalKey(Buffer.alloc(65).toString("base64url"))).toBeUndefined(); // all zeros
  });

  it("is stored at pairing with an install id, and classes the device as the app", () => {
    const registry = attested();
    const key = point();
    const { device } = pair(registry, INSTALL, key);
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app", key });
    expect(JSON.stringify(device)).not.toContain(key); // not in what the UI sees
    expect(JSON.stringify(registry.list())).not.toContain(key);
    expect(readFileSync(FILE, "utf8")).toContain(key); // and survives a restart
    expect(new DeviceRegistry({ statementKeys: KEYS }).approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app", key });
  });

  it("a key offered with an install id but no statement is not kept", () => {
    const registry = attested();
    const { device } = pair(registry, INSTALL, point(), false);
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });

  it("stores the canonical spelling of a key, so an alias of the last character hashes the same", () => {
    const registry = attested();
    const good = point();
    const alias = good.slice(0, 86) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(good[86]) ^ 1)];
    expect(Buffer.from(alias, "base64url").equals(Buffer.from(good, "base64url"))).toBe(true);
    expect(alias).not.toBe(good);
    expect(cleanApprovalKey(alias)).toBe(good);
    const { device } = pair(registry, INSTALL, alias); // the statement names the key's bytes, so the alias is the same key
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app", key: good });
  });

  it("ignores a key offered without an install id: a camera-app scan pairs a browser", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry, undefined, point());
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "browser" });
  });

  it("drops a malformed key at pairing but still pairs the app", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry, INSTALL, "A".repeat(87));
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });

  it("an app pairing without a key is still the app, with no key", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry, INSTALL);
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });

  it("re-pairing the same install replaces the key with the new one", () => {
    const registry = attested();
    pair(registry, INSTALL, point());
    const next = point();
    const { device } = pair(registry, INSTALL, next);
    expect(registry.approvalIdentity(device.id)?.key).toBe(next);
  });

  it("re-pairing the same install without a key does not carry the old key over", () => {
    const registry = attested();
    pair(registry, INSTALL, point());
    const { device } = pair(registry, INSTALL);
    expect(registry.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });

  it("knows nothing about an unknown device", () => {
    expect(new DeviceRegistry().approvalIdentity("4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3")).toBeNull();
  });
});

describe("the key can never be added after pairing", () => {
  const legacy = () => {
    const registry = attested();
    const { device, token } = pair(registry, INSTALL);
    return { registry, id: device.id, token };
  };

  it("loads an old record that has no key, and keeps it working without one", () => {
    const { id, token } = legacy();
    const stored = JSON.parse(readFileSync(FILE, "utf8"));
    expect(stored.devices[0].approvalKey).toBeUndefined();
    const reloaded = new DeviceRegistry();
    expect(reloaded.authenticate(token)?.id).toBe(id);
    expect(reloaded.approvalIdentity(id)).toEqual({ id, cls: "app" });
    expect(reloaded.list()).toHaveLength(1);
  });

  it("loads a record with no install id and no key as a browser", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    expect(new DeviceRegistry().approvalIdentity(device.id)).toEqual({ id: device.id, cls: "browser" });
  });

  it("drops a malformed stored key on load instead of trusting it", () => {
    const { id } = legacy();
    const stored = JSON.parse(readFileSync(FILE, "utf8"));
    stored.devices[0].approvalKey = { point: "A".repeat(87), addedAt: 1, attestation: { kid: "test-1", platform: "ios", environment: "production", issuedAt: 1 } };
    writeFileSync(FILE, JSON.stringify(stored));
    expect(new DeviceRegistry().approvalIdentity(id)).toEqual({ id, cls: "app" });
  });

  it("a stolen-cookie session, a renewal and a bearer refresh add no key", () => {
    const { registry, id, token } = legacy();
    const opened = registry.openSession(id, "Safari");
    expect(opened).not.toBeNull();
    registry.resolveSession(opened!.value);
    registry.renewSession(opened!.value, Date.now() + 365 * 24 * 3600 * 1000);
    registry.authenticate(token);
    expect(registry.approvalIdentity(id)).toEqual({ id, cls: "app" });
    expect(readFileSync(FILE, "utf8")).not.toContain("approvalKey");
    expect(new DeviceRegistry().approvalIdentity(id)).toEqual({ id, cls: "app" });
  });

  it("re-entering with a key on a replayed pairing request leaves the device keyless", () => {
    const registry = attested();
    const { code } = registry.openPairing();
    const requestId = "req-0123456789abcdef0123";
    const first = registry.redeem(code, "iPhone", requestId, INSTALL);
    if ("error" in first) throw new Error(first.error);
    const k = point();
    const again = registry.redeem(code, "iPhone", requestId, INSTALL, k, statement(INSTALL, k));
    if ("error" in again) throw new Error(again.error);
    expect(again.device.id).toBe(first.device.id);
    expect(registry.approvalIdentity(first.device.id)).toEqual({ id: first.device.id, cls: "app" });
  });

  it("a spent or wrong code carrying a key changes nothing", () => {
    const { registry, id } = legacy();
    const k = point();
    const bad = registry.redeem("000000", "iPhone", undefined, INSTALL, k, statement(INSTALL, k));
    expect("error" in bad).toBe(true);
    expect(registry.approvalIdentity(id)).toEqual({ id, cls: "app" });
  });

  it("offers no other way to write a key", () => {
    const proto = Object.getOwnPropertyNames(DeviceRegistry.prototype);
    expect(proto.filter((n) => /approval/i.test(n))).toEqual(["approvalIdentity"]);
    expect(proto.filter((n) => /^set\w*key$/i.test(n))).toEqual([]);
  });
});
