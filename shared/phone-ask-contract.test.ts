import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PHONE_ASK_TAG, PHONE_ASK_TOKEN, PHONE_ASK_TTL_MS, SHARE_FILE_MIME_LIST, SHARE_IMAGE_MIME_LIST, SHARE_LIMITS, TARGETS_RECENT_MAX,
  askSchema, manifestSchema, phoneAskMessage, targetsAnswerSchema, tokenRequestSchema,
} from "./phone-ask-contract.ts";
import { PHONE_JOBS_TAG, phoneJobsMessage } from "./phone-jobs-contract.ts";
import { approvalKeyId } from "./phone-jobs-hash.ts";
import { SHARE_FILE_MIMES, SHARE_IMAGE_MIMES } from "../server/attachments.ts";

const fx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-ask.json", import.meta.url), "utf8"));
const types = JSON.parse(readFileSync(new URL("../apps/mobile/contract/share-types.json", import.meta.url), "utf8"));

type Bad = { why: string; body: unknown; repeat?: { path: string; count: number } };
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

const keyFor = (point: string) => {
  const raw = Buffer.from(point, "base64url");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
};
const sigOk = (point: string, sig: string, msg: string) =>
  verify("sha256", Buffer.from(msg, "utf8"), { key: keyFor(point), dsaEncoding: "der" }, Buffer.from(sig, "base64url"));

describe("phone-ask contract", () => {
  it("builds the ask message byte for byte, never the jobs tag", () => {
    const m = fx.mint.vector;
    expect(fx.mint.tag).toBe(PHONE_ASK_TAG);
    expect(fx.mint.ttlMs).toBe(PHONE_ASK_TTL_MS);
    expect(fx.mint.ttlMs).toBe(60000);
    expect(m.nonce).toHaveLength(43);
    expect(m.keyId).toBe(approvalKeyId(m.point));
    expect(phoneAskMessage(m)).toBe(m.message);
    expect(m.message.startsWith("murage-phone-jobs/1")).toBe(false);
    expect(m.message.endsWith("\n")).toBe(false);
    expect(m.message.split("\n")).toEqual([PHONE_ASK_TAG, m.origin, m.keyId, m.nonce, String(m.expiresAt)]);
  });

  it("the mint signature verifies, and no signature crosses purposes", () => {
    const m = fx.mint.vector;
    expect(sigOk(m.point, m.signature, m.message)).toBe(true);
    expect(sigOk(m.point, m.signature, m.message + "0")).toBe(false);
    // this vector's signature is not a jobs mint over the same fields
    const asJobs = fx.mint.crossPurpose.askVectorAsJobs.message;
    expect(asJobs).toBe(phoneJobsMessage(m));
    expect(asJobs.startsWith(PHONE_JOBS_TAG)).toBe(true);
    expect(sigOk(m.point, m.signature, asJobs)).toBe(false);
    // the Part 1 jobs vector's signature is not an ask mint over its fields
    const j = fx.mint.crossPurpose.jobsVector;
    expect(sigOk(j.point, j.signature, phoneJobsMessage(j))).toBe(true);
    expect(sigOk(j.point, j.signature, phoneAskMessage(j))).toBe(false);
    const jobsFx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8"));
    expect(j).toEqual(jobsFx.mint.vector);
  });

  it("accepts the valid token request and refuses the invalid ones (a missing scope is jobs)", () => {
    expect(tokenRequestSchema.safeParse(fx.tokenRequest.valid).success).toBe(true);
    expect(tokenRequestSchema.parse(fx.tokenRequest.valid).scope).toBe("ask");
    for (const ok of fx.tokenRequest.alsoValid) expect(tokenRequestSchema.safeParse(ok).success).toBe(true);
    expect(tokenRequestSchema.parse(fx.tokenRequest.alsoValid[1]).scope).toBeUndefined();
    expect(fx.tokenRequest.missingScopeMeans).toBe("jobs");
    for (const bad of fx.tokenRequest.invalid) expect(tokenRequestSchema.safeParse(bad.body).success, bad.why).toBe(false);
  });

  it("refuses every invalid body, including a body via or origin (B12)", () => {
    expect(manifestSchema.safeParse(fx.share.manifest.valid).success).toBe(true);
    for (const ok of fx.share.manifest.alsoValid) expect(manifestSchema.safeParse(ok).success).toBe(true);
    for (const bad of fx.share.invalid as Bad[]) expect(manifestSchema.safeParse(expand(bad)).success, bad.why).toBe(false);
    expect(askSchema.safeParse(fx.ask.request).success).toBe(true);
    for (const bad of fx.ask.invalid as Bad[]) expect(askSchema.safeParse(expand(bad)).success, bad.why).toBe(false);
    expect(askSchema.safeParse({ ...fx.ask.request, via: "ask-sheet" }).success).toBe(false);
    const whys = (fx.share.invalid as Bad[]).map((b) => b.why).join("|");
    for (const w of ["via", "origin", "ownerActs", "shareId 15", "shareId 81", "11 items", "mime outside", "threadId not"]) expect(whys).toContain(w);
    expect(askSchema.safeParse({ ...fx.ask.request, text: "x".repeat(1024 * 1024 + 1) }).success).toBe(false);
  });

  it("pins the token shape", () => {
    expect(PHONE_ASK_TOKEN.source).toBe(fx.token.pattern);
    for (const t of fx.token.valid) expect(PHONE_ASK_TOKEN.test(t)).toBe(true);
    for (const t of fx.token.invalid) expect(PHONE_ASK_TOKEN.test(t)).toBe(false);
  });

  it("pins the limits and the share types to the server lists", () => {
    expect(fx.limits).toEqual(SHARE_LIMITS);
    expect(fx.limits.imageMaxBytes).toBe(10 * 1024 * 1024);
    expect(fx.limits.fileMaxBytes).toBe(25 * 1024 * 1024);
    expect(types.images).toEqual([...SHARE_IMAGE_MIMES]);
    expect(types.files.map((f: { mime: string }) => f.mime)).toEqual([...SHARE_FILE_MIMES]);
    expect([...SHARE_IMAGE_MIME_LIST]).toEqual([...SHARE_IMAGE_MIMES]);
    expect([...SHARE_FILE_MIME_LIST]).toEqual([...SHARE_FILE_MIMES]);
    expect(types.androidFilter).toEqual([...SHARE_IMAGE_MIMES, ...SHARE_FILE_MIMES]);
    expect(Object.keys(types.imageUtis)).toEqual(types.images);
    for (const f of types.files) expect(f.uti).toMatch(/^[a-z0-9.-]+$/);
    expect(types.heicToJpeg).toEqual({ quality: 0.85, maxEdge: 4096 });
  });

  it("describes the multipart share body byte for byte", () => {
    const mp = fx.share.multipart;
    expect(mp.order).toEqual(["manifest", "item-1", "item-n"]);
    expect(mp.contentType).toBe(`multipart/form-data; boundary=${mp.boundary}`);
    const parts: string[] = mp.body.split(`--${mp.boundary}`);
    expect(parts[0]).toBe("");
    expect(parts[parts.length - 1]).toBe("--\r\n");
    const real = parts.slice(1, -1);
    expect(real).toHaveLength(1 + mp.items.length);
    const split = (p: string) => {
      const [head, ...rest] = p.split("\r\n\r\n");
      return { head, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
    };
    const first = split(real[0]);
    expect(first.head).toBe('\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json');
    expect(JSON.parse(first.body)).toEqual(fx.share.manifest.valid);
    const man = manifestSchema.parse(JSON.parse(first.body));
    mp.items.forEach((it: { n: number; filename: string; mime: string; text: string }, i: number) => {
      const p = split(real[i + 1]);
      expect(p.head).toBe(`\r\nContent-Disposition: form-data; name="item-${it.n}"; filename="${it.filename}"\r\nContent-Type: ${it.mime}`);
      expect(p.body).toBe(it.text);
      expect(man.items[i]).toMatchObject({ n: it.n, name: it.filename, mime: it.mime, bytes: Buffer.byteLength(it.text) });
    });
    expect(man.items.length).toBe(mp.items.length);
  });

  it("targets carry at most 8 recent entries and no message text", () => {
    expect(fx.targets.recentMax).toBe(TARGETS_RECENT_MAX);
    expect(targetsAnswerSchema.safeParse(fx.targets.answer).success).toBe(true);
    for (const bad of fx.targets.invalid as Bad[]) expect(targetsAnswerSchema.safeParse(expand(bad)).success, bad.why).toBe(false);
    expect(JSON.stringify(fx.targets.answer)).not.toMatch(/"text"|"body"|"reply"/);
  });

  it("lists the answer shapes the plan names", () => {
    const share = fx.share.answers;
    expect(share.ok.map((a: { body: { queueId?: string } }) => Object.keys(a.body).sort().join())).toEqual(["messageId,state,threadId", "queueId,state,threadId"]);
    expect(share.errors.map((e: { status: number; body?: { code: string } }) => `${e.status}${e.body ? e.body.code : ""}`))
      .toEqual(["409conflict", "409target_gone", "413too_large", "415unsupported_type", "422invalid", "401revoked", "403revoked", "404"]);
    expect(Object.keys(fx.ask.answer).sort()).toEqual(["askId", "id", "notify", "state", "threadId"]);
    expect(fx.ask.errors.map((e: { status: number; body?: { code: string } }) => `${e.status}${e.body ? e.body.code : ""}`))
      .toEqual(["409conflict", "409target_gone", "422invalid", "401revoked", "403revoked", "404"]);
  });

  it("has no user home paths and no em dashes or banned words in answer copy", () => {
    expect(JSON.stringify(fx)).not.toMatch(/\/Users\/|C:\\\\Users\\\\/);
    expect(JSON.stringify(types)).not.toMatch(/\/Users\/|C:\\\\Users\\\\/);
    const copy = JSON.stringify([fx.share.answers, fx.ask.errors]);
    expect(copy).not.toMatch(/\u2014|\u2013/);
    expect(copy).not.toMatch(/\b(safe|unsafe|safety)\b/i);
  });
});
