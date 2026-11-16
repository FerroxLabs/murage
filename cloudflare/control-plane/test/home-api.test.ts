// SPDX-License-Identifier: AGPL-3.0-or-later
// What a Cloud home asks of the control plane (src/home-api.ts; browser-owner/DESIGN.md sections 6, 7 and 11): the fresh code for a high-risk
// act, the proof it earns, the terms proof, and the owner events. Every case goes through the worker as the home calls it: an HMAC over
// "murage-home-to-cp-v1\n" + the body bytes, keyed on the home's bootstrap secret.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPayload, type SignedEnvelope } from "../src/b3-signatures";
import { createWorker } from "../src/index";
import { base64, type KeyWrapper } from "../src/key-wrapper";
import { cleanArg, HOME_TO_CP_DOMAIN, maskEmail, OWNER_CODE_LABELS, OWNER_EVENT_KINDS, sweepOwnerEvents, verifyOwnerActProof } from "../src/home-api";
import { currentVersions, SCREEN_VERSION } from "../src/legal-flows";
import { cloudMember } from "./cloud-member";

const HOME_A = "home-api-a";
const HOME_B = "home-api-b";
const ACT = "a".repeat(64);
const ACT_2 = "b".repeat(64);
const DEVICE = "device-1";
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

let signingJwk: JsonWebKey;
let publicJwk: JsonWebKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
});

/** Each home has its own bootstrap secret: one byte value per home id. */
const secretBytes = (homeId: string) => new Uint8Array(32).fill(homeId === HOME_A ? 7 : 9);
const secretOf = (homeId: string) => base64(secretBytes(homeId));
const keyWrapper = (): KeyWrapper => ({ wrap: async () => "w", unwrap: async (homeId: string) => secretBytes(homeId) }) as unknown as KeyWrapper;

const sent: { to: string; subject: string; text: string; html: string }[] = [];
let mailFails = false;
const emailSender = () => ({ async send(m: { to: string; subject: string; text: string; html: string }) {
  if (mailFails) throw new Error("mail down");
  sent.push({ to: m.to, subject: m.subject, text: m.text, html: m.html });
} });
const emails = new Map<string, string>();
const readerDown = { on: false };
const reader = { async emailGen(sub: string) {
  if (readerDown.on) throw new Error("identity_unavailable");
  return { id: sub, email: emails.get(sub) ?? "", updatedAt: "2026-10-01T00:00:00Z" };
} };
const worker = createWorker(fetch, fetch, {}, { emailSender, keyWrapper } as never);
const testEnv = () => ({ ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), IDENTITY_READER: reader, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;

let owner: { userId: string; sub: string };
let other: { userId: string; sub: string };
async function seedHome(homeId: string, ownerId: string, generation = 3) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?,?)`).bind(homeId, `inst-${homeId}`, ownerId, generation, now, now),
    env.DB.prepare("INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,?,'active',?,?,?)")
      .bind(homeId, homeId, generation, now, `https://${homeId}.murage.test`, "https://admin.murage.test"),
    env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(homeId, "w1", "w2", "w3", "v1"),
  ]);
}
beforeEach(async () => {
  owner = await cloudMember("owner-api@example.test");
  other = await cloudMember("other-api@example.test");
  emails.set(owner.sub, "owner-api@example.test");
  emails.set(other.sub, "other-api@example.test");
  await seedHome(HOME_A, owner.userId);
  await seedHome(HOME_B, other.userId);
});
afterEach(() => { sent.length = 0; emails.clear(); mailFails = false; readerDown.on = false; });

const pending: Promise<unknown>[] = [];
interface Over { signature?: string; rawBody?: string; secretHome?: string; domain?: boolean; method?: string; generation?: number; timestamp?: number; nonce?: string; operation?: string; extra?: Record<string, unknown> }
/** The home's call: the strict body, signed as the harness signs it. `over` forges one thing at a time. */
async function call(homeId: string, op: string, fields: Record<string, unknown> = {}, over: Over = {}) {
  const body = over.rawBody ?? JSON.stringify({ operation: over.operation ?? op, timestamp: over.timestamp ?? Date.now() / 1000, nonce: over.nonce ?? hex(crypto.getRandomValues(new Uint8Array(16)).buffer),
    generation: over.generation ?? 3, ...fields, ...over.extra });
  const bytes = enc.encode((over.domain === false ? "" : HOME_TO_CP_DOMAIN) + body);
  const key = await crypto.subtle.importKey("raw", enc.encode(secretOf(over.secretHome ?? homeId)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = over.signature ?? hex(await crypto.subtle.sign("HMAC", key, bytes));
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://auth.murage.test/v1/homes/${homeId}/home/${op}`, { method: over.method ?? "POST",
    headers: { "content-type": "application/json", "x-murage-home-signature": signature }, body: over.method === "GET" ? undefined : body }), testEnv(), ctx);
  pending.push(waitOnExecutionContext(ctx));
  return Object.assign(res, { raw: body });
}
const errorOf = async (r: Response) => [r.status, (await r.clone().json<{ error?: string }>()).error];
const send = (over: Over = {}, fields: Record<string, unknown> = {}, homeId = HOME_A) =>
  call(homeId, "owner-code-send", { deviceId: DEVICE, act: ACT, label: "full_access", labelArg: "Dax", ...fields }, over);
const codeOf = () => /Your code is: (\d{6})/.exec(sent.at(-1)!.text)![1];
const verify = (challengeId: string, code: string, fields: Record<string, unknown> = {}, over: Over = {}, homeId = HOME_A) =>
  call(homeId, "owner-code-verify", { deviceId: DEVICE, act: ACT, challengeId, code, ...fields }, over);

describe("home to control plane: authentication", () => {
  it("a correctly signed call is answered (terms-proof for a customer with no acceptance: none)", async () => {
    const r = await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" });
    expect([r.status, await r.json()]).toEqual([200, { status: "none" }]);
  });
  it("no signature, a malformed one and a flipped one are all 401 unauthorized", async () => {
    const good = await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" });
    expect(good.status).toBe(200);
    for (const signature of ["", "zz", "0".repeat(64), "A".repeat(64)]) {
      expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { signature }))).toEqual([401, "unauthorized"]);
    }
  });
  it("domain separation: a body signed WITHOUT the home-to-control-plane domain string (the way the control plane signs for a home) is refused", async () => {
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { domain: false }))).toEqual([401, "unauthorized"]);
  });
  it("a body signed for the management route (operation /api/cloud/pairing) does not pass as a home call", async () => {
    const mgmt = JSON.stringify({ operation: "/api/cloud/pairing", timestamp: Date.now() / 1000, nonce: "a".repeat(32), generation: 3, homeTermsVersion: "2026-10-10" });
    expect(await errorOf(await call(HOME_A, "terms-proof", {}, { rawBody: mgmt, domain: false }))).toEqual([401, "unauthorized"]);
    // Even signed with the domain, the operation must equal the path's.
    expect(await errorOf(await call(HOME_A, "terms-proof", {}, { rawBody: mgmt }))).toEqual([400, "invalid_request"]);
  });
  it("a home signing for another home: home B's secret on home A's path is 401, and so is the reverse", async () => {
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { secretHome: HOME_B }))).toEqual([401, "unauthorized"]);
    expect(await errorOf(await call(HOME_B, "terms-proof", { homeTermsVersion: "2026-10-10" }, { secretHome: HOME_A }))).toEqual([401, "unauthorized"]);
  });
  it("an altered body (one field changed after signing) is 401", async () => {
    const first = await call(HOME_A, "owner-code-send", { deviceId: DEVICE, act: ACT, label: "full_access" });
    expect(first.status).toBe(200);
    const body = JSON.parse(first.raw) as Record<string, unknown>;
    const signedFor = first.raw;
    // Re-send the same signature over a different body.
    const sig = await (async () => {
      const key = await crypto.subtle.importKey("raw", enc.encode(secretOf(HOME_A)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return hex(await crypto.subtle.sign("HMAC", key, enc.encode(HOME_TO_CP_DOMAIN + signedFor)));
    })();
    const altered = JSON.stringify({ ...body, act: ACT_2, nonce: "c".repeat(32) });
    expect(await errorOf(await call(HOME_A, "owner-code-send", {}, { rawBody: altered, signature: sig }))).toEqual([401, "unauthorized"]);
  });
  it("an unknown home, and a home that is gone, answer 401 like a bad signature (no existence oracle)", async () => {
    expect(await errorOf(await call("home-api-none", "terms-proof", { homeTermsVersion: "2026-10-10" }, { secretHome: HOME_A }))).toEqual([401, "unauthorized"]);
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(HOME_A).run();
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }))).toEqual([401, "unauthorized"]);
  });
  it("a replayed signed body (same nonce) is 409 replay; a fresh nonce passes", async () => {
    const first = await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { nonce: "d".repeat(32) });
    expect(first.status).toBe(200);
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { nonce: "d".repeat(32) }))).toEqual([409, "replay"]);
    expect((await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { nonce: "e".repeat(32) })).status).toBe(200);
  });
  it("the nonce belongs to its home: the same nonce at another home is not a replay", async () => {
    expect((await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { nonce: "f".repeat(32) })).status).toBe(200);
    expect((await call(HOME_B, "terms-proof", { homeTermsVersion: "2026-10-10" }, { nonce: "f".repeat(32) })).status).toBe(200);
  });
  it("a timestamp more than 300 s from now, either way, is 401 stale_timestamp", async () => {
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { timestamp: Date.now() / 1000 - 400 }))).toEqual([401, "stale_timestamp"]);
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { timestamp: Date.now() / 1000 + 400 }))).toEqual([401, "stale_timestamp"]);
    expect((await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { timestamp: Date.now() / 1000 - 200 })).status).toBe(200);
  });
  it("the body names the home's own generation: another one is 409 stale_generation", async () => {
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { generation: 2 }))).toEqual([409, "stale_generation"]);
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { generation: 4 }))).toEqual([409, "stale_generation"]);
  });
  it("a body with an extra field, a wrong type or a bad enum is 400, and a GET is 405", async () => {
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" }, { extra: { text: "hello" } }))).toEqual([400, "invalid_request"]);
    expect(await errorOf(await call(HOME_A, "terms-proof", { homeTermsVersion: "10/10/2026" }))).toEqual([400, "invalid_request"]);
    expect(await errorOf(await send({}, { label: "not-a-label" }))).toEqual([400, "invalid_request"]);
    expect(await errorOf(await call(HOME_A, "owner-event", { seq: 1, kind: "made_up" }))).toEqual([400, "invalid_request"]);
    expect((await call(HOME_A, "terms-proof", {}, { method: "GET" })).status).toBe(405);
  });
  it("no bearer, cookie or member identity is read: a request with a customer Authorization header and no signature is still 401", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://auth.murage.test/v1/homes/${HOME_A}/home/terms-proof`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer anything" }, body: "{}" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe("the fresh code: send", () => {
  it("mails a 6-digit code to the owner, with fixed words for the label and the cleaned argument; answers only a masked address", async () => {
    const r = await send();
    expect(r.status).toBe(200);
    const body = await r.json<{ sent: boolean; reused: boolean; challengeId: string; maskedEmail: string; digits: number; expiresIn: number; resendIn: number }>();
    expect(body).toMatchObject({ sent: true, reused: false, maskedEmail: "o***@example.test", digits: 6, expiresIn: 600, resendIn: 30 });
    expect(body.challengeId).toMatch(/^oc_[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain("owner-api@example.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner-api@example.test");
    expect(sent[0].subject).toBe(`Your Murage code: ${codeOf()}`);
    expect(sent[0].text).toContain("Use this code to turn on Full access for Dax.");
    expect(sent[0].text).toContain("It works for 10 minutes. Murage staff will never ask you for it.");
    expect(sent[0].text).toContain("Make chat-only");
  });
  it("the code is stored only as an HMAC, never in the clear", async () => {
    await send();
    const rows = (await env.DB.prepare("SELECT * FROM home_owner_codes").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(codeOf());
    expect(String(rows[0].code_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the email's words come from the label, not from the home: every label has fixed words, and the argument is cleaned (no links, markup or addresses, 60 characters)", async () => {
    expect(cleanArg("Dax <script>alert(1)</script> http://evil.example/x www.evil.example me@evil.example")).toBe("Dax script alert(1) /script");
    expect(cleanArg("  \u200b\n ")).toBeNull();
    expect(cleanArg("x".repeat(200))).toHaveLength(60);
    expect(cleanArg(undefined)).toBeNull();
    for (const [i, label] of OWNER_CODE_LABELS.entries()) {
      sent.length = 0;
      await env.DB.prepare("DELETE FROM home_owner_code_sends").run();
      const r = await send({}, { label, labelArg: "Dax http://evil.example", act: i.toString(16).padStart(2, "0").repeat(32) });
      expect(r.status).toBe(200);
      expect(sent[0].text.split("\n\n")[0]).toMatch(/^Use this code to [^<>&:/]*\.$|^Use this code to [^<>&]*\.$/);
      expect(sent[0].text).not.toContain("evil.example");
      expect(sent[0].html).not.toContain("<script");
    }
  });
  it("maskEmail keeps the first character and the domain", () => {
    expect(maskEmail("s.donahoe@example.com")).toBe("s***@example.com");
  });
  it("the same act asked again inside 30 s reuses the live challenge: one mail, the same challenge id, no second slot", async () => {
    const a = await (await send()).json<{ challengeId: string }>();
    const b = await send();
    expect(await b.json()).toMatchObject({ reused: true, challengeId: a.challengeId });
    expect(sent).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_code_sends").first<{ n: number }>())!.n).toBe(1);
  });
  it("a different act inside 30 s is 429 rate_limited with Retry-After and limit gap; nothing is mailed", async () => {
    await send();
    const r = await send({}, { act: ACT_2 });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await r.json()).toMatchObject({ error: "rate_limited", limit: "gap" });
    expect(sent).toHaveLength(1);
  });
  it("after 30 s a resend of the same act replaces the earlier challenge: the old code stops working", async () => {
    const first = await (await send()).json<{ challengeId: string }>();
    const firstCode = codeOf();
    await env.DB.prepare("UPDATE home_owner_code_sends SET at=at-31000").run();
    await env.DB.prepare("UPDATE home_owner_codes SET created_at=created_at-31000").run();
    const second = await (await send()).json<{ challengeId: string; reused: boolean }>();
    expect(second.reused).toBe(false);
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(sent).toHaveLength(2);
    expect(await errorOf(await verify(first.challengeId, firstCode))).toEqual([403, "code_expired"]);
    expect((await verify(second.challengeId, codeOf())).status).toBe(200);
  });
  it("twelve sends a day per home: the thirteenth is 429 with limit day, and another home is untouched", async () => {
    for (let i = 0; i < 12; i++) {
      await env.DB.prepare("INSERT INTO home_owner_code_sends (id,home_id,challenge_id,at) VALUES (?,?,?,?)").bind(`s-${i}`, HOME_A, `c-${i}`, Date.now() - 60_000 - i * 1000).run();
    }
    const r = await send();
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ limit: "day" });
    expect(sent).toHaveLength(0);
    expect((await send({}, {}, HOME_B)).status).toBe(200);
  });
  it("a mail that fails is 503 email_unavailable, the challenge is removed, and the slot stays spent", async () => {
    mailFails = true;
    expect(await errorOf(await send())).toEqual([503, "email_unavailable"]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_codes").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_code_sends").first<{ n: number }>())!.n).toBe(1);
  });
  it("an identity reader that cannot answer is 503 identity_unavailable: no mail, no slot", async () => {
    readerDown.on = true;
    expect(await errorOf(await send())).toEqual([503, "identity_unavailable"]);
    expect(sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_code_sends").first<{ n: number }>())!.n).toBe(0);
  });
  it("the code goes to the address Supabase confirms now, not the one stored earlier", async () => {
    emails.set(owner.sub, "moved@example.test");
    expect((await send()).status).toBe(200);
    expect(sent[0].to).toBe("moved@example.test");
  });
});

describe("the fresh code: verify and the proof", () => {
  const sendOk = async (fields: Record<string, unknown> = {}) => (await (await send({}, fields)).json<{ challengeId: string }>()).challengeId;
  it("the right code answers an ES256 proof for exactly that act, device, home, generation and account, good for 120 s", async () => {
    const id = await sendOk();
    const before = Date.now();
    const r = await verify(id, codeOf());
    expect(r.status).toBe(200);
    const { proof, expiresAt } = await r.json<{ proof: SignedEnvelope; expiresAt: number }>();
    const claims = await verifyPayload(proof, publicJwk) as Record<string, unknown>;
    expect(Object.keys(claims)).toEqual(["type", "homeId", "generation", "account", "deviceId", "act", "nonce", "issuedAt", "expiresAt"]);
    expect(claims).toMatchObject({ type: "murage-owner-act-v1", homeId: HOME_A, generation: 3, account: owner.userId, deviceId: DEVICE, act: ACT });
    expect(claims.expiresAt).toBe(expiresAt);
    expect((claims.expiresAt as number) - (claims.issuedAt as number)).toBe(120_000);
    expect(claims.issuedAt as number).toBeGreaterThanOrEqual(before - 1000);
    expect(String(claims.nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The home's reference check passes now, and the code is spent.
    await verifyOwnerActProof(proof, publicJwk, { homeId: HOME_A, generation: 3, account: owner.userId, deviceId: DEVICE, act: ACT, now: Date.now() });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_codes").first<{ n: number }>())!.n).toBe(0);
  });
  it("each proof carries its own nonce", async () => {
    const nonces = new Set<string>();
    for (const act of [ACT, ACT_2]) {
      await env.DB.prepare("UPDATE home_owner_code_sends SET at=at-60000").run();
      const id = await sendOk({ act });
      const { proof } = await (await verify(id, codeOf(), { act })).json<{ proof: SignedEnvelope }>();
      nonces.add((await verifyPayload(proof, publicJwk) as { nonce: string }).nonce);
    }
    expect(nonces.size).toBe(2);
  });
  it("a wrong code is 403 code_refused and spends one of five guesses; the fifth wrong guess locks the challenge even for the right code", async () => {
    const id = await sendOk();
    const right = codeOf();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await errorOf(await verify(id, wrong))).toEqual([403, "code_refused"]);
    expect(await errorOf(await verify(id, right))).toEqual([403, "code_expired"]);
  });
  it("replay: a proof's code cannot be verified twice", async () => {
    const id = await sendOk();
    const code = codeOf();
    expect((await verify(id, code)).status).toBe(200);
    expect(await errorOf(await verify(id, code))).toEqual([403, "code_expired"]);
  });
  it("wrong act: the challenge is invisible to a verify that names another act (so a proof for act B cannot be had with act A's code)", async () => {
    const id = await sendOk();
    expect(await errorOf(await verify(id, codeOf(), { act: ACT_2 }))).toEqual([403, "code_expired"]);
    // The act the code was sent for still verifies: a wrong-act try did not spend it.
    expect((await verify(id, codeOf())).status).toBe(200);
  });
  it("wrong device: a challenge for one device cannot be verified for another", async () => {
    const id = await sendOk();
    expect(await errorOf(await verify(id, codeOf(), { deviceId: "device-2" }))).toEqual([403, "code_expired"]);
  });
  it("expired: a code past its 10 minutes is 403 code_expired, right or wrong", async () => {
    const id = await sendOk();
    await env.DB.prepare("UPDATE home_owner_codes SET expires_at=?").bind(Date.now() - 1).run();
    expect(await errorOf(await verify(id, codeOf()))).toEqual([403, "code_expired"]);
  });
  it("wrong account: a home whose owner changed after the code was sent cannot use it", async () => {
    const id = await sendOk();
    await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(other.userId, HOME_A).run();
    expect(await errorOf(await verify(id, codeOf()))).toEqual([403, "code_refused"]);
  });
  it("another home cannot verify this home's challenge, with its own valid signature", async () => {
    const id = await sendOk();
    expect(await errorOf(await verify(id, codeOf(), {}, {}, HOME_B))).toEqual([403, "code_expired"]);
    expect((await verify(id, codeOf())).status).toBe(200);
  });
  it("a generation bump after the send: the old challenge is gone for the new generation (409 on the stale body, expired on the new one)", async () => {
    const id = await sendOk();
    const code = codeOf();
    await env.DB.batch([env.DB.prepare("UPDATE cloud_homes SET generation=4 WHERE id=?").bind(HOME_A), env.DB.prepare("UPDATE cloud_machines SET generation=4 WHERE id=?").bind(HOME_A)]);
    expect(await errorOf(await verify(id, code))).toEqual([409, "stale_generation"]);
    expect(await errorOf(await verify(id, code, {}, { generation: 4 }))).toEqual([403, "code_expired"]);
  });
  it("the proof is signed here only: a harness with the secret and no code gets no proof, and a forged one does not verify", async () => {
    // No challenge, a made-up challenge id and a made-up code: nothing is signed.
    expect(await errorOf(await verify("oc_" + "0".repeat(32), "123456"))).toEqual([403, "code_expired"]);
    // A proof signed by any other key fails the home's pinned-key check.
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const claims = { type: "murage-owner-act-v1", homeId: HOME_A, generation: 3, account: owner.userId, deviceId: DEVICE, act: ACT, nonce: "n".repeat(43), issuedAt: Date.now(), expiresAt: Date.now() + 120_000 };
    const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, other.privateKey, enc.encode(payload)));
    const forged = { payload, signature: btoa(String.fromCharCode(...sig)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), algorithm: "ES256" as const };
    await expect(verifyOwnerActProof(forged, publicJwk, { homeId: HOME_A, generation: 3, account: owner.userId, deviceId: DEVICE, act: ACT, now: Date.now() })).rejects.toThrow();
  });
  it("the home's reference check refuses a proof for another act, device, home, generation or account, an expired one, and a tampered one", async () => {
    const id = await sendOk();
    const { proof } = await (await verify(id, codeOf())).json<{ proof: SignedEnvelope }>();
    const want = { homeId: HOME_A, generation: 3, account: owner.userId, deviceId: DEVICE, act: ACT, now: Date.now() };
    await verifyOwnerActProof(proof, publicJwk, want);
    for (const wrong of [{ act: ACT_2 }, { deviceId: "device-2" }, { homeId: HOME_B }, { generation: 4 }, { account: other.userId }]) {
      await expect(verifyOwnerActProof(proof, publicJwk, { ...want, ...wrong })).rejects.toThrow("owner_proof_mismatch");
    }
    await expect(verifyOwnerActProof(proof, publicJwk, { ...want, now: Date.now() + 121_000 })).rejects.toThrow("owner_proof_expired");
    const tampered = { ...proof, payload: proof.payload.slice(0, -2) + (proof.payload.endsWith("AA") ? "BB" : "AA") };
    await expect(verifyOwnerActProof(tampered, publicJwk, want)).rejects.toThrow();
  });
  it("a signer that is not configured is 503 signer_unavailable after the code checked out (the code is spent: the owner asks again)", async () => {
    const id = await sendOk();
    const e = { ...testEnv(), CLOUD_B3_SIGNING_JWK: undefined } as unknown as Env;
    const ctx = createExecutionContext();
    const body = JSON.stringify({ operation: "owner-code-verify", timestamp: Date.now() / 1000, nonce: "9".repeat(32), generation: 3, deviceId: DEVICE, act: ACT, challengeId: id, code: codeOf() });
    const key = await crypto.subtle.importKey("raw", enc.encode(secretOf(HOME_A)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hex(await crypto.subtle.sign("HMAC", key, enc.encode(HOME_TO_CP_DOMAIN + body)));
    const res = await worker.fetch(new Request(`https://auth.murage.test/v1/homes/${HOME_A}/home/owner-code-verify`, { method: "POST",
      headers: { "content-type": "application/json", "x-murage-home-signature": signature }, body }), e, ctx);
    await waitOnExecutionContext(ctx);
    expect(await errorOf(res)).toEqual([503, "signer_unavailable"]);
  });
});

describe("terms proof over the wire", () => {
  async function seedRow(table: string, values: Record<string, unknown>) {
    const cols = (await env.DB.prepare(`SELECT name,type,"notnull" AS nn,dflt_value FROM pragma_table_info('${table}')`).all<{ name: string; type: string; nn: number; dflt_value: string | null }>()).results;
    const row: Record<string, unknown> = {};
    for (const c of cols) if (c.nn === 1 && c.dflt_value === null) row[c.name] = c.type.toUpperCase().startsWith("INT") ? 0 : "x";
    Object.assign(row, values);
    const k = Object.keys(row);
    await env.DB.prepare(`INSERT INTO ${table} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).bind(...k.map((x) => row[x])).run();
  }
  const accept = async (userId: string, screen: string) => {
    const v = currentVersions();
    await seedRow("checkout_consents", { id: `c-${userId}`, home_id: HOME_A, user_id: userId, screen_version: screen, cloud_terms_version: v.cloudTerms, tos_version: v.termsOfService,
      privacy_version: v.privacyPolicy, completed_at: Date.now() - 1000, created_at: Date.now() - 5000 });
    await seedRow("terms_acceptances", { id: `a-${userId}`, user_id: userId, cloud_terms_version: v.cloudTerms, tos_version: v.termsOfService, privacy_version: v.privacyPolicy,
      source: "checkout", consent_id: `c-${userId}`, wording: "x", accepted_at: Date.now() - 1000 });
  };
  it("the owner's checkout acceptance answers a proof signed for THIS home and generation, naming the account", async () => {
    await accept(owner.userId, SCREEN_VERSION);
    const r = await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" });
    const body = await r.json<{ status: string; proof: SignedEnvelope }>();
    expect(body.status).toBe("proof");
    expect(await verifyPayload(body.proof, publicJwk)).toMatchObject({ type: "murage-terms-v1", homeId: HOME_A, generation: 3, account: owner.userId, homeTermsVersion: "2026-10-10",
      ageConfirmed: true, source: "checkout", graceUntil: null });
  });
  it("another home's owner cannot be given this owner's acceptance: home B (its own owner, no acceptance) gets none", async () => {
    await accept(owner.userId, SCREEN_VERSION);
    expect(await (await call(HOME_B, "terms-proof", { homeTermsVersion: "2026-10-10" })).json()).toEqual({ status: "none" });
  });
  it("an acceptance from the screen before the age words answers none", async () => {
    await accept(owner.userId, "checkout-clickwrap-2026-10-11.6");
    expect(await (await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" })).json()).toEqual({ status: "none" });
  });
  it("a home version the map does not name answers none", async () => {
    await accept(owner.userId, SCREEN_VERSION);
    expect(await (await call(HOME_A, "terms-proof", { homeTermsVersion: "2027-01-01" })).json()).toEqual({ status: "none" });
  });
});

describe("owner events", () => {
  const ev = (seq: number, kind = "flux_key_changed", homeId = HOME_A) => call(homeId, "owner-event", { seq, kind }, {});
  it("records an event and mails the owner once, with words from the enum and no text from the home", async () => {
    const r = await ev(1);
    expect([r.status, await r.json()]).toEqual([200, { recorded: true, duplicate: false }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner-api@example.test");
    expect(sent[0].text).toContain("A browser changed your Flux key on your Murage home at ");
    expect(sent[0].text).toContain("Make chat-only");
    expect((await env.DB.prepare("SELECT mailed_at FROM home_owner_events WHERE home_id=? AND seq=1").bind(HOME_A).first<{ mailed_at: number | null }>())!.mailed_at).not.toBeNull();
  });
  it("every kind has fixed words; an unknown kind is 400", async () => {
    let seq = 100;
    for (const kind of OWNER_EVENT_KINDS) {
      sent.length = 0;
      await env.DB.prepare("DELETE FROM home_owner_event_slots").run();
      expect((await ev(seq++, kind)).status).toBe(200);
      expect(sent[0].text).toMatch(/^A browser [A-Za-z ]+ on your Murage home at \d\d:\d\d UTC\./);
    }
    expect(await errorOf(await ev(999, "free_text"))).toEqual([400, "invalid_request"]);
  });
  it("is deduped on (home, seq): the same seq again is a duplicate, not a second mail; the same seq at another home is its own event", async () => {
    await ev(5);
    const dup = await ev(5);
    expect(await dup.json()).toEqual({ recorded: true, duplicate: true });
    expect(sent).toHaveLength(1);
    expect((await ev(5, "flux_key_changed", HOME_B).then((r) => r.json()))).toEqual({ recorded: true, duplicate: false });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_events").first<{ n: number }>())!.n).toBe(2);
  });
  it("is paced at three mails an hour: the fourth event is recorded, held, and folded into the next hour's one mail by the sweep", async () => {
    for (let i = 1; i <= 4; i++) { await ev(i, "webhook_added"); }
    expect(sent).toHaveLength(3);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_events WHERE mailed_at IS NULL").first<{ n: number }>())!.n).toBe(1);
    expect(await sweepOwnerEvents(env as unknown as Env, Date.now(), { emailSender } as never)).toBe(0);
    const later = Date.now() + 3_700_000;
    await env.DB.prepare("UPDATE home_owner_events SET next_attempt_at=? WHERE mailed_at IS NULL").bind(later - 1000).run();
    expect(await sweepOwnerEvents({ ...testEnv() }, later, { emailSender } as never)).toBe(1);
    expect(sent).toHaveLength(4);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM home_owner_events WHERE mailed_at IS NULL").first<{ n: number }>())!.n).toBe(0);
  });
  it("a mail that fails leaves the event owed, and the sweep sends it later", async () => {
    mailFails = true;
    expect((await ev(7, "channel_paired")).status).toBe(200);
    expect(sent).toHaveLength(0);
    mailFails = false;
    const later = Date.now() + 3_600_000;
    await env.DB.prepare("UPDATE home_owner_events SET next_attempt_at=0, claim_id=NULL").run();
    expect(await sweepOwnerEvents(testEnv(), later, { emailSender } as never)).toBe(1);
    expect(sent[0].text).toContain("paired a chat channel");
  });
  it("the owner's first browser on a home just gone ready is closed unmailed; a second browser is mailed", async () => {
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=?").bind(Date.now() - 60_000).run();
    expect((await ev(9, "browser_made_owner")).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect((await ev(10, "browser_made_owner")).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
  it("a first browser a day after the home went ready is mailed", async () => {
    await env.DB.prepare("UPDATE cloud_homes SET ready_at=?").bind(Date.now() - 25 * 3_600_000).run();
    expect((await ev(11, "browser_made_owner")).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
  it("survives a restart: the owed event is in D1, not in memory (a fresh worker's sweep sends it)", async () => {
    mailFails = true;
    await ev(8, "browser_made_owner");
    mailFails = false;
    await env.DB.prepare("UPDATE home_owner_events SET next_attempt_at=0, claim_id=NULL").run();
    expect(await sweepOwnerEvents(testEnv(), Date.now() + 3_600_000, { emailSender } as never)).toBe(1);
  });
});

describe("what home calls can never do", () => {
  it("no home call writes terms_acceptances, checkout consents, billing or devices: the four operations leave every one of those tables as it was", async () => {
    const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n;
    const tables = ["terms_acceptances", "checkout_consents", "billing_subscriptions", "terms_change_notices", "cloud_recovery_holds"];
    const before = await Promise.all(tables.map(count));
    await call(HOME_A, "terms-proof", { homeTermsVersion: "2026-10-10" });
    const id = (await (await send()).json<{ challengeId: string }>()).challengeId;
    await verify(id, codeOf());
    await call(HOME_A, "owner-event", { seq: 1, kind: "code_used" });
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });
  it("the source of the home routes holds no statement that changes the acceptance, consent, billing or device tables", async () => {
    // @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
    const sources = import.meta.glob("../src/home-*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).sort()).toEqual(["../src/home-api.ts", "../src/home-terms-map.ts", "../src/home-terms.ts"]);
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:terms_acceptances|checkout_consents|terms_change_notices|billing_\w+|cloud_recovery_holds|cloud_home_keys|cloud_machines)\b/i);
    }
  });
});
