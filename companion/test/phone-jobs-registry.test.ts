import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../src/state.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { KEYS, NOW, statement } from "./support-statement.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const fixture = JSON.parse(readFileSync(join(__dirname, "../../apps/mobile/contract/phone-jobs.json"), "utf8"));
const [V0, V1] = fixture.keyId.vectors as Array<{ point: string; keyId: string }>;
const file = () => join(DATA_DIR, "devices.json");
const registry = () => new DeviceRegistry({ statementKeys: KEYS, now: () => NOW });
const pair = (r: DeviceRegistry, installId: string | undefined, point?: string) => {
  const { code } = r.openPairing();
  const stmt = installId && point ? statement(installId, point) : undefined;
  const res = r.redeem(code, "iPhone", undefined, installId, point, stmt);
  if ("error" in res) throw new Error(res.error);
  return res.device;
};

beforeEach(() => removeTempDirSync(DATA_DIR));

describe("deviceByApprovalKeyId", () => {
  it("finds the one device holding the key", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    expect(r.deviceByApprovalKeyId(V0.keyId)).toEqual({ ok: true, deviceId: d.id, point: V0.point });
  });

  it("answers none for no match and for the wrong hash", () => {
    const r = registry();
    pair(r, "install-0123456789abcdef", V0.point);
    expect(r.deviceByApprovalKeyId(V1.keyId)).toEqual({ ok: false, reason: "none" });
    expect(r.deviceByApprovalKeyId(fixture.keyId.notKeyId[V0.point])).toEqual({ ok: false, reason: "none" });
  });

  it("answers many for two devices on one point, logging ids and no key material", () => {
    const r = registry();
    const a = pair(r, "install-0123456789abcdef", V0.point);
    const b = pair(r, "install-fedcba9876543210", V1.point);
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    const list = Array.isArray(raw) ? raw : raw.devices;
    list.find((x: { id: string }) => x.id === b.id).approvalKey.point = V0.point;
    writeFileSync(file(), JSON.stringify(Array.isArray(raw) ? list : { ...raw, devices: list }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = new DeviceRegistry({ statementKeys: KEYS });
    expect(fresh.deviceByApprovalKeyId(V0.keyId)).toEqual({ ok: false, reason: "many" });
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(a.id);
    expect(line).toContain(b.id);
    expect(line).not.toContain(V0.point);
    expect(line).not.toContain(V0.keyId);
    warn.mockRestore();
  });

  it("never matches a browser-class device", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const live = (r as unknown as { devices: Array<{ id: string; installId?: string }> }).devices.find((x) => x.id === d.id)!;
    delete live.installId;
    expect(r.deviceByApprovalKeyId(V0.keyId)).toEqual({ ok: false, reason: "browser" });
  });

  it("answers none after revoke", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    r.revoke(d.id);
    expect(r.deviceByApprovalKeyId(V0.keyId)).toEqual({ ok: false, reason: "none" });
  });
});

describe("the phone-jobs token", () => {
  it("authenticates, keeps only a digest on disk, and a second issue kills the first", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const t1 = r.issuePhoneJobsToken(d.id, 1000)!;
    expect(t1).toMatch(/^murage_pj_[A-Za-z0-9_-]{43}$/);
    expect(r.authenticatePhoneJobs(t1)).toEqual({ deviceId: d.id });
    expect(readFileSync(file(), "utf8")).not.toContain("murage_pj_");
    expect(new DeviceRegistry({ statementKeys: KEYS }).authenticatePhoneJobs(t1)).toEqual({ deviceId: d.id });
    const t2 = r.issuePhoneJobsToken(d.id)!;
    expect(r.authenticatePhoneJobs(t1)).toBeNull();
    expect(r.authenticatePhoneJobs(t2)).toEqual({ deviceId: d.id });
  });

  it("refuses unknown devices, malformed and missing tokens", () => {
    const r = registry();
    expect(r.issuePhoneJobsToken("nope")).toBeNull();
    expect(r.authenticatePhoneJobs(undefined)).toBeNull();
    expect(r.authenticatePhoneJobs("murage_pj_short")).toBeNull();
  });

  it("clear removes it", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const t = r.issuePhoneJobsToken(d.id)!;
    expect(r.clearPhoneJobsToken(d.id)).toBe(true);
    expect(r.authenticatePhoneJobs(t)).toBeNull();
    expect(r.clearPhoneJobsToken(d.id)).toBe(false);
  });

  it("revoke takes the token with the record", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const t = r.issuePhoneJobsToken(d.id)!;
    r.revoke(d.id);
    expect(r.authenticatePhoneJobs(t)).toBeNull();
  });

  it("drops a malformed stored phoneJobs on load and keeps a well-formed one", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const t = r.issuePhoneJobsToken(d.id)!;
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    const list = Array.isArray(raw) ? raw : raw.devices;
    const save = () => writeFileSync(file(), JSON.stringify(Array.isArray(raw) ? list : { ...raw, devices: list }));
    expect(new DeviceRegistry({ statementKeys: KEYS }).authenticatePhoneJobs(t)).toEqual({ deviceId: d.id });
    list[0].phoneJobs = { tokenHash: "not-hex", issuedAt: 1 };
    save();
    expect(new DeviceRegistry({ statementKeys: KEYS }).authenticatePhoneJobs(t)).toBeNull();
  });
});

describe("PublicDevice", () => {
  it("has phoneJobsReady and no phoneJobs, token hash or key", () => {
    const r = registry();
    const d = pair(r, "install-0123456789abcdef", V0.point);
    const plain = pair(r, undefined);
    r.issuePhoneJobsToken(d.id);
    const list = r.list();
    const pub = list.find((x) => x.id === d.id)!;
    expect(pub.phoneJobsReady).toBe(true);
    expect(list.find((x) => x.id === plain.id)!.phoneJobsReady).toBe(false);
    expect(pub).not.toHaveProperty("phoneJobs");
    const text = JSON.stringify(list) + JSON.stringify(d);
    expect(text).not.toContain(V0.point);
    expect(text).not.toContain("tokenHash");
  });
});
