// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { signV4 } from "../src/aws-sigv4";
import { keyWrapperFor, stagingKeyWrapper } from "../src/key-wrapper";

const ADMIN = "test-only-cloud-admin-token-with-no-real-access";
const KEK = btoa("x".repeat(32));
const ARN = "arn:aws:kms:eu-west-1:111122223333:key/11111111-2222-3333-4444-555555555555";
const KMS_ENV = { AWS_KMS_KEY_ARN: ARN, AWS_KMS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIATESTONLY", AWS_SECRET_ACCESS_KEY: "test-only-secret" };

/** In-memory stand-in for AWS KMS: checks the request shape and enforces encryption-context binding. */
function mockKms() {
  const calls: { target: string; authorization: string; body: Record<string, unknown> }[] = [];
  const handler = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const target = headers["x-amz-target"];
    calls.push({ target, authorization: headers.authorization, body });
    expect(url).toBe("https://kms.eu-west-1.amazonaws.com/");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTONLY\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    if (body.KeyId !== ARN) return new Response("{}", { status: 400 });
    if (target === "TrentService.Encrypt") {
      const blob = btoa(JSON.stringify({ pt: body.Plaintext, ctx: body.EncryptionContext }));
      return Response.json({ CiphertextBlob: blob, KeyId: ARN });
    }
    const parsed = JSON.parse(atob(body.CiphertextBlob as string)) as { pt: string; ctx: unknown };
    if (JSON.stringify(parsed.ctx) !== JSON.stringify(body.EncryptionContext)) return new Response("{}", { status: 400 });
    return Response.json({ Plaintext: parsed.pt, KeyId: ARN });
  });
  return { calls, handler };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("SigV4", () => {
  it("matches the AWS get-vanilla test vector", async () => {
    const headers = await signV4({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: "", region: "us-east-1",
      service: "service", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", now: new Date("2015-08-30T12:36:00Z") });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
      + "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
});

describe("KMS key wrapper", () => {
  it("wraps with KMS, binds the home id as encryption context and never exposes the plaintext in the blob", async () => {
    const kms = mockKms();
    const wrapper = keyWrapperFor(KMS_ENV, kms.handler as unknown as typeof fetch);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapper.wrap("home-a", secret);
    expect(wrapped.startsWith("v2.")).toBe(true);
    expect(kms.calls[0].body.EncryptionContext).toEqual({ homeId: "home-a" });
    expect(await wrapper.unwrap("home-a", wrapped)).toEqual(secret);
    // A blob copied to another home's row cannot be unwrapped there.
    await expect(wrapper.unwrap("home-b", wrapped)).rejects.toThrow("cloud_kms_unavailable");
  });
  it("refuses a decrypt answered under a different key", async () => {
    const wrapper = keyWrapperFor(KMS_ENV, (async () => Response.json({ Plaintext: btoa("x".repeat(32)), KeyId: "arn:aws:kms:eu-west-1:1:key/other" })) as unknown as typeof fetch);
    await expect(wrapper.unwrap("home-a", `v2.${btoa("blob")}`)).rejects.toThrow();
  });
  it("a KMS outage fails closed with a fixed code and no detail", async () => {
    const wrapper = keyWrapperFor(KMS_ENV, (async () => new Response("AccessDenied secret detail", { status: 403 })) as unknown as typeof fetch);
    await expect(wrapper.unwrap("home-a", `v2.${btoa("blob")}`)).rejects.toThrow(/^cloud_kms_unavailable$/);
  });
  it("v2 blobs are unreadable with only the Worker secrets that a deployer holds (no AWS credentials)", async () => {
    const kms = mockKms();
    const wrapped = await keyWrapperFor(KMS_ENV, kms.handler as unknown as typeof fetch).wrap("home-a", new Uint8Array(32).fill(7));
    const deployerOnly = keyWrapperFor({ CLOUD_KEK_V1: KEK });
    await expect(deployerOnly.unwrap("home-a", wrapped)).rejects.toThrow();
  });
  it("without KMS the legacy Worker-secret wrapper still works (staging)", async () => {
    expect((await keyWrapperFor({ CLOUD_KEK_V1: KEK }).wrap("h", new Uint8Array(32))).startsWith("v1.")).toBe(true);
  });
  it("a half-configured KMS fails closed instead of falling back to the Worker secret", () => {
    expect(() => keyWrapperFor({ CLOUD_KEK_V1: KEK, AWS_KMS_KEY_ARN: ARN })).toThrow("cloud_key_unavailable");
  });
});

describe("rewrap migration", () => {
  const call = async (envx: Record<string, unknown>, body: unknown) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://admin.murage.test/v1/machines/rewrap-keys", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) }),
      { ...env, CLOUD_ADMIN_TOKEN: ADMIN, ...envx } as Env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  it("rewraps every v1 row under KMS, preserves the plaintext, and is resumable", async () => {
    const legacy = stagingKeyWrapper(KEK);
    const plain = new Map<string, Uint8Array>();
    for (const id of ["h1", "h2", "h3"]) {
      const keys = [1, 2, 3].map((n) => new Uint8Array(32).fill(n + id.charCodeAt(1)));
      plain.set(id, keys[0]);
      await env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)")
        .bind(id, await legacy.wrap(id, keys[0]), await legacy.wrap(id, keys[1]), await legacy.wrap(id, keys[2]), "v1").run();
    }
    const kms = mockKms();
    vi.stubGlobal("fetch", kms.handler);
    // KMS not configured: refused, nothing touched.
    expect((await call({ CLOUD_KEK_V1: KEK }, {})).status).toBe(409);
    const first = await (await call({ CLOUD_KEK_V1: KEK, ...KMS_ENV }, { limit: 2 })).json<{ rewrapped: number; failed: number; remaining: number }>();
    expect(first).toEqual({ rewrapped: 2, failed: 0, remaining: 1 });
    const second = await (await call({ CLOUD_KEK_V1: KEK, ...KMS_ENV }, {})).json();
    expect(second).toEqual({ rewrapped: 1, failed: 0, remaining: 0 });
    const rows = await env.DB.prepare("SELECT * FROM cloud_home_keys").all<{ home_id: string; kek_id: string; wrapped_data_key: string; wrapped_volume_key: string }>();
    expect(rows.results.every((r) => r.kek_id === "kms1" && r.wrapped_data_key.startsWith("v2.") && r.wrapped_volume_key.startsWith("v2."))).toBe(true);
    // With the Worker-secret KEK deleted, KMS alone reads them back to the same plaintext.
    const kmsOnly = keyWrapperFor(KMS_ENV, kms.handler as unknown as typeof fetch);
    for (const r of rows.results) expect(await kmsOnly.unwrap(r.home_id, r.wrapped_data_key)).toEqual(plain.get(r.home_id));
    expect(await (await call({ CLOUD_KEK_V1: KEK, ...KMS_ENV }, {})).json()).toEqual({ rewrapped: 0, failed: 0, remaining: 0 });
  });
  it("requires the admin token", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://admin.murage.test/v1/machines/rewrap-keys", { method: "POST", body: "{}" }), env as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});

describe("backup password", () => {
  it("is derived deterministically per home from the data key, differs per home, and is never stored", async () => {
    const wrapper = stagingKeyWrapper(KEK);
    for (const id of ["bp1", "bp2"]) {
      await env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)")
        .bind(id, await wrapper.wrap(id, new Uint8Array(32).fill(9)), await wrapper.wrap(id, new Uint8Array(32)), await wrapper.wrap(id, new Uint8Array(32)), "v1").run();
    }
    const get = async (id: string, token = ADMIN) => {
      const ctx = createExecutionContext();
      const r = await worker.fetch(new Request(`https://admin.murage.test/v1/machines/${id}/backup-password`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
        { ...env, CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_KEK_V1: KEK } as Env, ctx);
      await waitOnExecutionContext(ctx);
      return r;
    };
    const a1 = await (await get("bp1")).json<{ password: string }>();
    const a2 = await (await get("bp1")).json<{ password: string }>();
    const b = await (await get("bp2")).json<{ password: string }>();
    expect(a1.password).toBe(a2.password);
    expect(a1.password).not.toBe(b.password);
    expect(atob(a1.password)).toHaveLength(32);
    expect((await get("bp1", "wrong")).status).toBe(401);
    expect((await get("nope")).status).toBe(404);
  });
});
