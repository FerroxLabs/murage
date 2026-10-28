import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_ACTIONS, PHONE_JOBS_TAG, PHONE_TOKEN, PHONE_TOOL_NAMES, RESULT_MAX_BYTES, actionArgsSchema, actionResultSchema, leaseAnswerSchema,
  leaseRequestSchema, offerArgsValid, offerSchema, pollSchema, resultValid, targetedAnswerSchema,
  phoneJobsMessage, registrationSchema, resultSchema,
} from "./phone-jobs-contract.ts";
import { approvalKeyId } from "./phone-jobs-hash.ts";

const fx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8"));

describe("phone-jobs contract", () => {
  it("keyId hashes the decoded point bytes, never the string (N8)", () => {
    expect(fx.keyId.vectors.length).toBeGreaterThanOrEqual(2);
    for (const v of fx.keyId.vectors) {
      expect(v.point).toHaveLength(87);
      expect(approvalKeyId(v.point)).toBe(v.keyId);
      expect(approvalKeyId(v.point)).not.toBe(fx.keyId.notKeyId[v.point]);
    }
    expect(approvalKeyId(fx.keyId.vectors[0].point)).not.toBe(fx.keyId.notKeyId[fx.keyId.vectors[0].point]);
    expect(approvalKeyId("AAAA")).toBeNull();
    expect(approvalKeyId("")).toBeNull();
    // 65 bytes but the first is not 0x04
    expect(approvalKeyId(Buffer.concat([Buffer.from([3]), Buffer.alloc(64, 1)]).toString("base64url"))).toBeNull();
    // standard base64 characters are refused
    expect(approvalKeyId(fx.keyId.vectors[0].point.replace(/-/g, "+").replace(/_/g, "/") + "=")).toBeNull();
  });

  it("builds the signed message byte for byte", () => {
    const m = fx.mint.vector;
    expect(fx.mint.tag).toBe(PHONE_JOBS_TAG);
    expect(fx.mint.ttlMs).toBe(60000);
    expect(m.nonce).toHaveLength(43);
    expect(m.keyId).toBe(approvalKeyId(m.point));
    expect(phoneJobsMessage(m)).toBe(m.message);
    expect(m.message.endsWith("\n")).toBe(false);
    expect(m.message.split("\n")).toEqual([PHONE_JOBS_TAG, m.origin, m.keyId, m.nonce, String(m.expiresAt)]);
  });

  it("the mint signature verifies with crypto.verify (DER, SHA-256)", () => {
    const m = fx.mint.vector;
    const raw = Buffer.from(m.point, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    const ok = (sig: string, msg: string) => verify("sha256", Buffer.from(msg, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(sig, "base64url"));
    expect(ok(m.signature, m.message)).toBe(true);
    expect(ok(m.signature, m.message + "0")).toBe(false);
  });

  it("token pattern", () => {
    expect(fx.token.pattern).toBe(PHONE_TOKEN.source);
    for (const t of fx.token.valid) expect(PHONE_TOKEN.test(t)).toBe(true);
    for (const t of fx.token.invalid) expect(PHONE_TOKEN.test(t)).toBe(false);
  });

  it("accepts every valid body and refuses every invalid one", () => {
    expect(registrationSchema.safeParse(fx.registration.valid).success).toBe(true);
    for (const ok of fx.registration.alsoValid) expect(registrationSchema.safeParse(ok).success).toBe(true);
    for (const bad of fx.registration.invalid) expect(registrationSchema.safeParse(bad.body).success, bad.why).toBe(false);
    for (const ok of fx.job.offers) expect(offerSchema.safeParse(ok).success).toBe(true);
    for (const bad of fx.job.invalidOffers) expect(offerSchema.safeParse(bad.body).success, bad.why).toBe(false);
    expect(leaseRequestSchema.safeParse(fx.job.lease.request).success).toBe(true);
    for (const bad of fx.job.lease.invalidRequests) expect(leaseRequestSchema.safeParse(bad.body).success, bad.why).toBe(false);
    for (const a of fx.job.lease.answers) expect(leaseAnswerSchema.safeParse(a).success).toBe(true);
    for (const bad of fx.job.lease.invalidAnswers) expect(leaseAnswerSchema.safeParse(bad.body).success, bad.why).toBe(false);
    for (const p of fx.job.poll.answers.filter((a: { jobs?: unknown }) => a.jobs)) expect(pollSchema.safeParse(p).success).toBe(true);
    for (const ok of fx.job.results) expect(resultSchema.safeParse(ok.body).success, ok.name).toBe(true);
    for (const bad of fx.job.invalidResults) expect(resultSchema.safeParse(bad.body).success, bad.why).toBe(false);
  });

  it("covers every result code and the 256 KB bound", () => {
    const codes = fx.job.results.map((r: { body: { code?: string } }) => r.body.code).filter(Boolean).sort();
    expect(codes).toEqual(["declined", "denied", "invalid_result", "too_large", "unsupported"]);
    expect(fx.job.oversize.maxBytes).toBe(RESULT_MAX_BYTES);
    const token = fx.job.results[0].body.leaseToken;
    const under = { leaseToken: token, ok: true, result: { text: "a".repeat(RESULT_MAX_BYTES - 200) } };
    const over = { leaseToken: token, ok: true, result: { text: "a".repeat(RESULT_MAX_BYTES) } };
    expect(resultSchema.safeParse(under).success).toBe(true);
    expect(resultSchema.safeParse(over).success).toBe(false);
  });

  it("push category and native names", () => {
    expect(fx.push.categoryEntry).toEqual({ kind: "device-job", risk: "unrated", category: "device-job" });
    expect(fx.push.iosCategory).toEqual({ "device-job": "DEVICE_JOB" });
    expect(fx.push.androidChannel).toEqual({ "device-job": "requests" });
  });

  it("has no user home paths", () => {
    expect(JSON.stringify(fx)).not.toMatch(/\/Users\/|C:\\\\Users\\\\/);
  });
});

type Bad = { why: string; body: unknown; repeat?: { path: string; count: number } };
type ActionFx = { tool: string; capability: string; validArgs: unknown[]; invalidArgs: Bad[]; validResults: unknown[]; invalidResults: Bad[] };
const actions = fx.actions as Record<string, ActionFx>;

/** Expands a fixture's repeat: the array at repeat.path (dotted) holds one element; make it count copies. */
function expand(b: Bad): unknown {
  if (!b.repeat) return b.body;
  const body = structuredClone(b.body) as Record<string, unknown>;
  const keys = b.repeat.path.split(".");
  let o = body;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  const one = (o[last] as unknown[])[0];
  o[last] = Array.from({ length: b.repeat.count }, () => structuredClone(one));
  return body;
}

describe("phone-jobs per-action schemas (S1b)", () => {
  it("PHONE_ACTIONS covers exactly the 14 tools and the fixture", () => {
    expect(PHONE_TOOL_NAMES).toHaveLength(14);
    expect(Object.keys(PHONE_ACTIONS).sort()).toEqual([...PHONE_TOOL_NAMES].sort());
    const acts = Object.values(PHONE_ACTIONS).map((a) => a.action);
    expect(new Set(acts).size).toBe(14);
    expect(Object.keys(actionArgsSchema).sort()).toEqual([...acts].sort());
    expect(Object.keys(actionResultSchema).sort()).toEqual([...acts].sort());
    expect(Object.keys(actions).filter((k) => k !== "note").sort()).toEqual([...acts].sort());
    for (const t of PHONE_TOOL_NAMES) {
      const { action, capability } = PHONE_ACTIONS[t];
      expect(action).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(action.length).toBeLessThanOrEqual(48);
      expect(action.startsWith(capability + ".")).toBe(true);
      expect(actions[action].tool).toBe(t);
      expect(actions[action].capability).toBe(capability);
    }
  });

  for (const [name, a] of Object.entries(actions).filter(([k]) => k !== "note")) {
    it(`${name}: args and results`, () => {
      expect(a.validArgs.length).toBeGreaterThanOrEqual(1);
      expect(a.validResults.length).toBeGreaterThanOrEqual(1);
      expect(a.invalidArgs.length).toBeGreaterThanOrEqual(3);
      expect(a.invalidResults.length).toBeGreaterThanOrEqual(2);
      for (const v of a.validArgs) expect(actionArgsSchema[name].safeParse(v).success, JSON.stringify(v)).toBe(true);
      for (const v of a.validResults) {
        expect(actionResultSchema[name].safeParse(v).success, JSON.stringify(v)).toBe(true);
        expect(resultValid(name, v)).toBe(true);
      }
      for (const b of a.invalidArgs) expect(actionArgsSchema[name].safeParse(expand(b)).success, b.why).toBe(false);
      for (const b of a.invalidResults) {
        expect(actionResultSchema[name].safeParse(expand(b)).success, b.why).toBe(false);
        expect(resultValid(name, expand(b)), b.why).toBe(false);
      }
    });
  }

  it("resultValid refuses unknown actions and over-large results", () => {
    expect(resultValid("nope.nothing", {})).toBe(false);
    expect(resultValid("alarms.set", { outcome: "set", x: "a".repeat(RESULT_MAX_BYTES) })).toBe(false);
  });

  it("offerArgsValid checks action, capability and args", () => {
    for (const o of fx.job.offers) expect(offerArgsValid(o), o.action).toBe(true);
    const o = fx.job.offers[0];
    expect(offerArgsValid({ ...o, capability: "reminders" })).toBe(false);
    expect(offerArgsValid({ ...o, action: "calendar.nope" })).toBe(false);
    expect(offerArgsValid({ ...o, args: { start: o.args.start } })).toBe(false);
    expect(offerArgsValid({ ...o, args: { ...o.args, x: 1 } })).toBe(false);
  });

  it("the targeted read is its own union; the long poll keeps its shape", () => {
    expect(fx.job.targeted.answers.length).toBeGreaterThanOrEqual(6);
    const reasons = fx.job.targeted.answers.filter((a: { reason?: string }) => a.reason).map((a: { reason: string }) => a.reason).sort();
    expect(reasons).toEqual(["done", "ended", "revoked", "unknown"]);
    for (const a of fx.job.targeted.answers) expect(targetedAnswerSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
    for (const b of fx.job.targeted.invalid) expect(targetedAnswerSchema.safeParse(b.body).success, b.why).toBe(false);
    expect(pollSchema.safeParse({ handled: true }).success).toBe(false);
    for (const b of fx.job.poll.invalid) expect(pollSchema.safeParse(b.body).success, b.why).toBe(false);
    expect(fx.job.poll.answers.some((a: Record<string, unknown>) => "handled" in a)).toBe(false);
  });
});
