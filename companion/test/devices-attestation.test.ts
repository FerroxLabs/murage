import { generateKeyPairSync } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { RELAY_STATEMENT_KEYS, pinnedStatementKeys, verifyApprovalStatement } from "../src/relay-statement.ts";
import { FreshAuthGate } from "../../server/approval-fresh-auth.ts";
import vector from "./fixtures/approval-statement-vector.json" with { type: "json" };
import { KEYS, NOW, statement } from "./support-statement.ts";

const FILE = join(DATA_DIR, "devices.json");
async function webCryptoPoint() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
}
const registry = (keys: Record<string, string> = KEYS) => new DeviceRegistry({ statementKeys: keys, now: () => NOW });
const pair = (r: DeviceRegistry, installId?: string, key?: unknown, stmt?: unknown) => {
  const { code } = r.openPairing();
  const result = r.redeem(code, "iPhone", undefined, installId, key, stmt);
  if ("error" in result) throw new Error(result.error);
  return result.device;
};
const INSTALL = vector.installId;
const HIGH = { threadId: "t1", requestId: "r1", decision: "allow" as const, digest: "a".repeat(64) };
const gateFor = (identity: { id: string; cls: "app" | "browser"; key?: string } | null) =>
  new FreshAuthGate({ now: () => NOW }).check({ ...HIGH, device: identity && { id: identity.id, cls: identity.cls, key: identity.key ?? null }, proof: undefined });
const stored = () => JSON.parse(readFileSync(FILE, "utf8")).devices;

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("the relay statement (golden vector)", () => {
  it("the relay's own statement verifies", () => {
    expect(verifyApprovalStatement(vector.statement, { installId: INSTALL, point: vector.approvalKey }, { keys: KEYS, now: NOW }))
      .toEqual({ kid: "test-1", platform: "ios", environment: "production", issuedAt: vector.issuedAt });
  });
  it("production pins are well-formed and include the live relay kid", () => {
    for (const [kid, key] of Object.entries(RELAY_STATEMENT_KEYS)) {
      expect(kid).toMatch(/^[A-Za-z0-9._-]{1,32}$/);
      expect(Buffer.from(key, "base64url")).toHaveLength(32);
    }
    expect(RELAY_STATEMENT_KEYS["2026-10a"]).toBe("9oNjXeUldmtxe2Crt_3NlzPxJo73LzjkChPx6caJltM");
    expect(Object.keys(RELAY_STATEMENT_KEYS)).not.toContain("test-1");
  });
  it("two pinned kids both verify; an unknown kid and an empty map verify nothing", async () => {
    const other = generateKeyPairSync("ed25519");
    const x = (other.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const keys = { ...KEYS, "2026-11b": x };
    const point = await webCryptoPoint();
    const expectFor = { installId: INSTALL, point };
    expect(verifyApprovalStatement(statement(INSTALL, point), expectFor, { keys, now: NOW })).not.toBeNull();
    expect(verifyApprovalStatement(statement(INSTALL, point, { kid: "2026-11b" }, other.privateKey), expectFor, { keys, now: NOW })).not.toBeNull();
    expect(verifyApprovalStatement(statement(INSTALL, point, { kid: "2026-11c" }, other.privateKey), expectFor, { keys, now: NOW })).toBeNull();
    expect(verifyApprovalStatement(statement(INSTALL, point), expectFor, { keys: {}, now: NOW })).toBeNull();
    const device = pair(registry({}), INSTALL, point, statement(INSTALL, point));
    expect(registry({}).approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });
  it("the environment adds pins in a test run but never overrides a pinned kid", () => {
    const extra = Buffer.alloc(32, 7).toString("base64url");
    const keys = JSON.stringify({ dev1: extra, "2026-10a": extra, bad: "x" });
    for (const gate of [{ NODE_ENV: "test" }, { MURAGE_ALLOW_TEST_RELAY_KEYS: "1" }]) {
      const pins = pinnedStatementKeys({ ...gate, MURAGE_RELAY_STATEMENT_KEYS: keys } as NodeJS.ProcessEnv);
      expect(pins.dev1).toBe(extra);
      expect(pins["2026-10a"]).toBe(RELAY_STATEMENT_KEYS["2026-10a"]);
      expect(pins.bad).toBeUndefined();
    }
    expect(pinnedStatementKeys({ NODE_ENV: "test", MURAGE_RELAY_STATEMENT_KEYS: "{not json" } as NodeJS.ProcessEnv)).toEqual({ ...RELAY_STATEMENT_KEYS });
  });
  it("production ignores the environment: the pinned keys are the only trust anchors", () => {
    const extra = Buffer.alloc(32, 7).toString("base64url");
    const keys = JSON.stringify({ dev1: extra });
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }, { NODE_ENV: "production", MURAGE_ALLOW_TEST_RELAY_KEYS: "0" }]) {
      expect(pinnedStatementKeys({ ...env, MURAGE_RELAY_STATEMENT_KEYS: keys } as NodeJS.ProcessEnv)).toEqual({ ...RELAY_STATEMENT_KEYS });
    }
  });
});

describe("P23: a browser posing as the app cannot approve a high-risk card", () => {
  it("an install id plus a WebCrypto key, with no statement, keeps no key and is refused on a high-risk card", async () => {
    const r = registry();
    const device = pair(r, "install-attacker-browser-01", await webCryptoPoint());
    const identity = r.approvalIdentity(device.id);
    expect(identity).toEqual({ id: device.id, cls: "app" });
    expect(readFileSync(FILE, "utf8")).not.toContain("approvalKey");
    expect(gateFor(identity)).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth_unattested" } });
  });

  it("a genuine phone's statement cannot be replayed with the browser's own key", async () => {
    const r = registry();
    const device = pair(r, INSTALL, await webCryptoPoint(), vector.statement); // statement names a different key
    expect(r.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });
});

describe("forged or expired statements are refused", () => {
  const forger = generateKeyPairSync("ed25519").privateKey;
  const cases: Array<[string, (point: string) => unknown]> = [
    ["signed by another key", (p) => statement(INSTALL, p, {}, forger)],
    ["an unpinned kid", (p) => statement(INSTALL, p, { kid: "other" })],
    ["another install id", (p) => statement(INSTALL, p, { install: "install-someone-else-0001" })],
    ["another key's hash", (p) => statement(INSTALL, p, { hash: "0".repeat(64) })],
    ["a wrong tag", (p) => statement(INSTALL, p, { tag: "murage-approval-attestation/2" })],
    ["an unknown platform", (p) => statement(INSTALL, p, { platform: "web" })],
    ["expired beyond the skew", (p) => statement(INSTALL, p, { issued: String(NOW - 600_000 - 300_001) })],
    ["issued in the future beyond the skew", (p) => statement(INSTALL, p, { issued: String(NOW + 300_001) })],
    ["a lifetime longer than ten minutes", (p) => statement(INSTALL, p, { expires: String(vector.issuedAt + 600_001) })],
    ["a tampered payload", (p) => { const [a, b] = String(statement(INSTALL, p)).split("."); const bytes = Buffer.from(a, "base64url"); bytes[bytes.length - 1] ^= 1; return `${bytes.toString("base64url")}.${b}`; }],
    ["not a string", () => 42],
    ["one part", (p) => String(statement(INSTALL, p)).split(".")[0]],
    ["malformed base64", (p) => String(statement(INSTALL, p)).replace(/^./, "*")],
    ["oversized", (p) => `${String(statement(INSTALL, p))}${"A".repeat(4096)}`],
    ["a non-canonical spelling of the signature", (p) => { const [a, b] = String(statement(INSTALL, p)).split("."); return `${a}.${b}=`; }],
  ];
  for (const [name, make] of cases) {
    it(name, async () => {
      const point = await webCryptoPoint();
      expect(verifyApprovalStatement(make(point), { installId: INSTALL, point }, { keys: KEYS, now: NOW })).toBeNull();
      const r = registry();
      const device = pair(r, INSTALL, point, make(point));
      expect(r.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
      expect(gateFor(r.approvalIdentity(device.id))).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth_unattested" } });
    });
  }
});

describe("a valid statement passes", () => {
  it("stores the key with its attestation, survives a restart, and the gate issues a challenge", async () => {
    const r = registry();
    const point = await webCryptoPoint();
    const device = pair(r, INSTALL, point, statement(INSTALL, point, { platform: "android", env: "development" }));
    expect(r.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app", key: point });
    expect(stored()[0].approvalKey.attestation).toEqual({ kid: "test-1", platform: "android", environment: "development", issuedAt: vector.issuedAt });
    expect(new DeviceRegistry({ statementKeys: {} }).approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app", key: point }); // not re-verified on load
    expect(gateFor(r.approvalIdentity(device.id))).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth" } });
  });

  it("a statement without an install id is ignored, as a key is (camera scan pairs a browser)", async () => {
    const r = registry();
    const point = await webCryptoPoint();
    const device = pair(r, undefined, point, statement(INSTALL, point));
    expect(r.approvalIdentity(device.id)).toEqual({ id: device.id, cls: "browser" });
  });

  it("a hand-edited record with a key but no attestation loads keyless", async () => {
    const r = registry();
    const point = await webCryptoPoint();
    const device = pair(r, INSTALL, point, statement(INSTALL, point));
    const file = JSON.parse(readFileSync(FILE, "utf8"));
    delete file.devices[0].approvalKey.attestation;
    writeFileSync(FILE, JSON.stringify(file));
    expect(new DeviceRegistry({ statementKeys: KEYS }).approvalIdentity(device.id)).toEqual({ id: device.id, cls: "app" });
  });

  it("a record with a key and attestation but no install id loads keyless, and the class follows the install id only", async () => {
    const r = registry();
    const point = await webCryptoPoint();
    const device = pair(r, INSTALL, point, statement(INSTALL, point));
    const file = JSON.parse(readFileSync(FILE, "utf8"));
    delete file.devices[0].installId;
    writeFileSync(FILE, JSON.stringify(file));
    expect(new DeviceRegistry({ statementKeys: KEYS }).approvalIdentity(device.id)).toEqual({ id: device.id, cls: "browser" });
  });
});
