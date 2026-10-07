// server/approval-fresh-auth.test.ts
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalDigest, approvalDigestInput } from "../shared/approval-digest.ts";
import { FRESH_AUTH_COPY, FRESH_AUTH_TTL_MS, FreshAuthGate, MAX_CHALLENGES_PER_DEVICE, approvalDeviceFrom, approvalDigestSync, proofMessage, validateProofArgs, verifyProof } from "./approval-fresh-auth.ts";

const DEVICE = "4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3";
const DIGEST = "a".repeat(64);
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { point, signer: (message: string) => sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64url") };
}
const app = (point: string | null) => ({ id: DEVICE, cls: "app" as const, key: point });
function gate(start = 1_000) {
  let now = start;
  return { g: new FreshAuthGate({ now: () => now }), tick: (ms: number) => { now += ms; } };
}
const ask = (device: ReturnType<typeof app> | null, proof?: unknown, over: Partial<{ digest: string; decision: "allow" | "allow-task" | "answer"; requestId: string }> = {}) =>
  ({ device, threadId: "t1", requestId: over.requestId ?? "req-1", decision: over.decision ?? "allow", digest: over.digest ?? DIGEST, proof });

describe("approvalDeviceFrom", () => {
  it("reads the three companion headers, and nothing malformed", () => {
    const { point } = keyPair();
    expect(approvalDeviceFrom({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": point })).toEqual({ id: DEVICE, cls: "app", key: point });
    expect(approvalDeviceFrom({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "browser" })).toEqual({ id: DEVICE, cls: "browser", key: null });
    expect(approvalDeviceFrom({})).toBeNull();
    expect(approvalDeviceFrom({ "x-murage-approval-device": "nope", "x-murage-approval-class": "app" })).toBeNull();
    expect(approvalDeviceFrom({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "admin" })).toBeNull();
    expect(approvalDeviceFrom({ "x-murage-approval-device": DEVICE, "x-murage-approval-class": "app", "x-murage-approval-key": "short" })).toBeNull();
  });
});

describe("the signed message", () => {
  it("is the fixed seven lines", () => {
    expect(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: "n".repeat(43), expiresAt: 61_000 }))
      .toBe(["murage-approval-proof/1", "t1", "req-1", "allow", DIGEST, "n".repeat(43), "61000"].join("\n"));
  });
  it("verifies a real P-256 signature and nothing else", () => {
    const { point, signer } = keyPair();
    const other = keyPair();
    expect(verifyProof(point, "m", signer("m"))).toBe(true);
    expect(verifyProof(point, "m2", signer("m"))).toBe(false);
    expect(verifyProof(other.point, "m", signer("m"))).toBe(false);
    expect(verifyProof(point, "m", "AAAA")).toBe(false);
  });
});

describe("approvalDigestSync", () => {
  it("is the same digest the page computes, with no await between reading the card and checking it", async () => {
    const card = { title: "Run a command?", tool: "Bash", summary: "ls", skillRequest: { source: "s", preview: "p", sha256: "a".repeat(64), name: "n", action: "create", warnings: ["w"] } };
    const sync = approvalDigestSync("t1", "req-1", card);
    expect(typeof sync).toBe("string");
    expect(sync).toBe(await approvalDigest("t1", "req-1", card));
  });
});

describe("FreshAuthGate", () => {
  it("refuses an app device with no key, or no headers, on a high-risk card", () => {
    const { g } = gate();
    expect(g.check(ask(null))).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth_unavailable" } });
    // an app pairing with no key carries no relay attestation (decision 8)
    expect(g.check(ask(app(null)))).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth_unattested", error: FRESH_AUTH_COPY.unattested } });
  });

  it("refuses a browser pairing on a high-risk card, whatever it asks for, and holds no challenge", () => {
    const { g } = gate();
    const browser = { id: DEVICE, cls: "browser" as const, key: null };
    for (const decision of ["allow", "allow-task", "answer"] as const) {
      expect(g.check({ ...ask(null, undefined, { decision }), device: browser }))
        .toMatchObject({ ok: false, status: 403, body: { code: "approve_on_computer", error: FRESH_AUTH_COPY.computerOnly } });
    }
    expect(g.check({ ...ask(null, { nonce: "n".repeat(43), signature: "AAAAAAAA" }), device: browser })).toMatchObject({ body: { code: "approve_on_computer" } });
    expect(g.size()).toBe(0);
  });

  it("never reads an advisory lowRisk stamp, so a forged one changes nothing", () => {
    const { g } = gate();
    const browser = { id: DEVICE, cls: "browser" as const, key: null };
    const forged = { ...ask(null), device: browser, lowRisk: true, card: { lowRisk: true } } as unknown as Parameters<typeof g.check>[0];
    expect(g.check(forged)).toMatchObject({ ok: false, status: 403, body: { code: "approve_on_computer" } });
  });

  it("tells a keyless app device that a free-text answer belongs on the computer", () => {
    expect(gate().g.check(ask(app(null), undefined, { decision: "answer" }))).toMatchObject({ status: 403, body: { code: "answer_on_computer", error: FRESH_AUTH_COPY.answerOnComputer } });
  });

  it("refuses a free-text answer from an app device", () => {
    const { point } = keyPair();
    expect(gate().g.check(ask(app(point), undefined, { decision: "answer" }))).toMatchObject({ ok: false, status: 403, body: { code: "answer_on_computer", error: "Answer this one on your computer." } });
  });

  it("challenges, then accepts the matching signature once", () => {
    const { point, signer } = keyPair();
    const { g } = gate();
    const first = g.check(ask(app(point)));
    expect(first).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth", challenge: { v: 1, digest: DIGEST, decision: "allow", expiresAt: 1_000 + FRESH_AUTH_TTL_MS } } });
    const challenge = (first as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const signature = signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: challenge.nonce, expiresAt: challenge.expiresAt }));
    expect(g.check(ask(app(point), { nonce: challenge.nonce, signature }))).toEqual({ ok: true });
    // single use
    expect(g.check(ask(app(point), { nonce: challenge.nonce, signature }))).toMatchObject({ ok: false, body: { code: "fresh_auth_failed" } });
  });

  it("refuses a proof for another decision, request or device, and leaves the owner's nonce for the owner", () => {
    const { point, signer } = keyPair();
    const { g } = gate();
    const ch = (g.check(ask(app(point), undefined, { decision: "allow-task" })) as never as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    const signed = signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow-task", digest: DIGEST, nonce: ch.nonce, expiresAt: ch.expiresAt }));
    expect(g.check(ask(app(point), { nonce: ch.nonce, signature: signed }, { decision: "allow" }))).toMatchObject({ body: { code: "fresh_auth_failed" } });
    expect(g.check(ask(app(point), { nonce: ch.nonce, signature: signed }, { decision: "allow-task" }))).toEqual({ ok: true });
  });

  it("answers an expired nonce with a new challenge", () => {
    const { point, signer } = keyPair();
    const { g, tick } = gate();
    const ch = (g.check(ask(app(point))) as never as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    const signature = signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: ch.nonce, expiresAt: ch.expiresAt }));
    tick(FRESH_AUTH_TTL_MS);
    const again = g.check(ask(app(point), { nonce: ch.nonce, signature }));
    expect(again).toMatchObject({ ok: false, status: 403, body: { code: "fresh_auth", challenge: { reason: "expired" } } });
    expect((again as never as unknown as { body: { challenge: { nonce: string } } }).body.challenge.nonce).not.toBe(ch.nonce);
  });

  it("answers a changed card with 409 and a challenge for the new digest", () => {
    const { point, signer } = keyPair();
    const { g } = gate();
    const ch = (g.check(ask(app(point))) as never as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    const signature = signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: ch.nonce, expiresAt: ch.expiresAt }));
    expect(g.check(ask(app(point), { nonce: ch.nonce, signature }, { digest: "b".repeat(64) })))
      .toMatchObject({ ok: false, status: 409, body: { code: "fresh_auth_changed", challenge: { digest: "b".repeat(64) } } });
  });

  it("refuses a bad signature", () => {
    const { point } = keyPair();
    const other = keyPair();
    const { g } = gate();
    const ch = (g.check(ask(app(point))) as never as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    const forged = other.signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: ch.nonce, expiresAt: ch.expiresAt }));
    expect(g.check(ask(app(point), { nonce: ch.nonce, signature: forged }))).toMatchObject({ body: { code: "fresh_auth_failed" } });
  });

  it("a second unsigned Allow for the same card returns the live challenge, so a double tap cannot cancel the first prompt", () => {
    const { point, signer } = keyPair();
    const { g, tick } = gate();
    const body = (r: unknown) => (r as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    const first = body(g.check(ask(app(point))));
    const second = body(g.check(ask(app(point))));
    expect(second).toEqual(first);
    expect(g.size()).toBe(1);
    // the first prompt's signed retry still passes
    const signature = signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: first.nonce, expiresAt: first.expiresAt }));
    expect(g.check(ask(app(point), { nonce: first.nonce, signature }))).toEqual({ ok: true });
    // another decision, another device, or an expired challenge gets a new one
    const again = body(g.check(ask(app(point))));
    expect(body(g.check(ask(app(point), undefined, { decision: "allow-task" }))).nonce).not.toBe(again.nonce);
    const other = keyPair();
    expect(body(g.check({ ...ask(app(other.point)), device: { id: "11111111-2222-4333-8444-555555555555", cls: "app" as const, key: other.point } })).nonce).not.toBe(again.nonce);
    tick(FRESH_AUTH_TTL_MS + 1);
    expect(body(g.check(ask(app(point)))).nonce).not.toBe(again.nonce);
  });

  it("keeps one live challenge per request and at most 256 overall", () => {
    const { point } = keyPair();
    const { g } = gate();
    const a = (g.check(ask(app(point))) as never as unknown as { body: { challenge: { nonce: string } } }).body.challenge.nonce;
    // a changed card replaces the held challenge: the old nonce is gone
    g.check(ask(app(point), undefined, { digest: "b".repeat(64) }));
    expect(g.check(ask(app(point), { nonce: a, signature: "AAAA" }))).toMatchObject({ body: { code: "fresh_auth_failed" } });
    for (let i = 0; i < 300; i++) g.check(ask(app(point), undefined, { requestId: `r${i}` }));
    expect(g.size()).toBeLessThanOrEqual(256);
  });

  it("caps challenges per device, so one phone cannot evict another's", () => {
    const { point } = keyPair();
    const { g } = gate();
    const OTHER = "9c2e5a0d-7e41-4b9f-8b7a-3f6c1a524d1e";
    const other = { id: OTHER, cls: "app" as const, key: point };
    const keep = (g.check({ ...ask(other), requestId: "keep" }) as never as unknown as { body: { challenge: { nonce: string } } }).body.challenge.nonce;
    for (let i = 0; i < 300; i++) g.check(ask(app(point), undefined, { requestId: `r${i}` }));
    expect(g.size()).toBeLessThanOrEqual(MAX_CHALLENGES_PER_DEVICE + 1);
    // the other phone's challenge is still held: a bad signature is checked, not "unknown nonce"
    expect(g.check({ ...ask(other, { nonce: keep, signature: "AAAAAAAA" }), requestId: "keep" })).toMatchObject({ body: { code: "fresh_auth_failed" } });
    expect(g.size()).toBeLessThanOrEqual(MAX_CHALLENGES_PER_DEVICE);
  });

  it("a wrong-device submission leaves the owner's nonce intact; the owner's own failed attempt consumes it", () => {
    const { point, signer } = keyPair();
    const { g } = gate();
    const VICTIM = { id: DEVICE, cls: "app" as const, key: point };
    const THIEF = { id: "9c2e5a0d-7e41-4b9f-8b7a-3f6c1a524d1e", cls: "app" as const, key: keyPair().point };
    const ch = (g.check(ask(VICTIM)) as never as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
    expect(g.check(ask(THIEF, { nonce: ch.nonce, signature: "AAAAAAAA" }))).toMatchObject({ body: { code: "fresh_auth_failed" } });
    expect(g.check(ask(VICTIM, { nonce: ch.nonce, signature: signer(proofMessage({ threadId: "t1", requestId: "req-1", decision: "allow", digest: DIGEST, nonce: ch.nonce, expiresAt: ch.expiresAt })) }))).toEqual({ ok: true });
    const ch2 = (g.check(ask(VICTIM, undefined, { requestId: "req-2" })) as never as { body: { challenge: { nonce: string } } }).body.challenge;
    expect(g.check(ask(VICTIM, { nonce: ch2.nonce, signature: "AAAAAAAA" }, { requestId: "req-2" }))).toMatchObject({ body: { code: "fresh_auth_failed" } });
    expect(g.size()).toBe(0);
  });

  it("at global capacity a ninth device never evicts the other eight", () => {
    const { point, signer } = keyPair();
    const { g } = gate();
    const dev = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, cls: "app" as const, key: point });
    const nonces: { nonce: string; expiresAt: number }[][] = [];
    for (let d = 0; d < 8; d++) {
      nonces.push([]);
      for (let i = 0; i < MAX_CHALLENGES_PER_DEVICE; i++) nonces[d]!.push((g.check(ask(dev(d), undefined, { requestId: `r${i}` })) as never as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge);
    }
    expect(g.size()).toBe(256);
    const nine = g.check(ask(dev(8), undefined, { requestId: "n" }));
    expect(nine.ok).toBe(false);
    expect(g.size()).toBe(256);
    for (let d = 0; d < 8; d++) {
      const c = nonces[d]![0]!;
      expect(g.check(ask(dev(d), { nonce: c.nonce, signature: signer(proofMessage({ threadId: "t1", requestId: "r0", decision: "allow", digest: DIGEST, nonce: c.nonce, expiresAt: c.expiresAt })) }, { requestId: "r0" }))).toEqual({ ok: true });
    }
  });
});

const vectors = JSON.parse(readFileSync(new URL("../apps/mobile/contract/approval-proof.json", import.meta.url), "utf8"));
describe("the shared proof contract", () => {
  const device = (key: string) => ({ id: DEVICE, cls: "app" as const, key });
  const gateAt = (now: number, nonce: string) => { let t = now; return { g: new FreshAuthGate({ now: () => t, nonce: () => nonce }), at: (ms: number) => { t = ms; } }; };
  const input = (args: { threadId: string; requestId: string; decision: "allow" | "allow-task"; digest: string }, key: string, proof?: unknown) =>
    ({ device: device(key), threadId: args.threadId, requestId: args.requestId, decision: args.decision, digest: args.digest, proof });

  it("builds every accepted message exactly and verifies the committed signature", async () => {
    for (const { args, message } of vectors.accepted) expect(proofMessage(args)).toBe(message);
    expect(verifyProof(vectors.signature.publicKey, vectors.signature.message, vectors.signature.signatureDer)).toBe(true);
    expect(await approvalDigest(vectors.digest.threadId, vectors.digest.requestId, vectors.digest.card)).toBe(vectors.digest.digest);
    expect(vectors.digestTag).toBe("murage-approval-digest/2");
    expect(vectors.skillDigest.card.skillRequest.preview).toEqual(expect.any(String));
    expect(await approvalDigest(vectors.skillDigest.threadId, vectors.skillDigest.requestId, vectors.skillDigest.card)).toBe(vectors.skillDigest.digest);
    expect(vectors.skillDigest.digest).not.toBe(await approvalDigest(vectors.skillDigest.threadId, vectors.skillDigest.requestId, { ...vectors.skillDigest.card, skillRequest: undefined }));
    expect(vectors.skillDigest.card.skillRequest.warnings.length).toBeGreaterThan(0);
    expect(await approvalDigest(vectors.routineDigest.threadId, vectors.routineDigest.requestId, vectors.routineDigest.card)).toBe(vectors.routineDigest.digest);
    expect(vectors.routineDigest.canonicalOperation).toBe('{"action":"create","routine":{"name":"Friday digest","prompt":"Send me a summary","schedule":{"day":"fri","every":"week"}}}');
    expect(approvalDigestInput(vectors.routineDigest.threadId, vectors.routineDigest.requestId, vectors.routineDigest.card)).toContain(JSON.stringify(vectors.routineDigest.canonicalOperation));
  });

  it("has the vectors the native twins need", () => {
    expect(vectors.accepted.length).toBeGreaterThanOrEqual(3);
    expect(new Set(vectors.accepted.map((v: { args: { decision: string } }) => v.args.decision))).toEqual(new Set(["allow", "allow-task"]));
    expect(vectors.accepted.some((v: { name: string }) => /high-S/.test(v.name))).toBe(true);
    expect(vectors.accepted.some((v: { args: { nonce: string } }) => v.args.nonce !== "n".repeat(43))).toBe(true);
    const names = vectors.signatureCases.map((v: { name: string }) => v.name);
    for (const name of ["wrong key", "tampered message byte", "malformed DER", "raw r||s, 64 bytes", "wrong digest", "expired proof"]) expect(names).toContain(name);
    expect(vectors.refused.some((v: { args: { requestId: string } }) => v.args.requestId.includes("\n"))).toBe(true);
    expect(vectors.refused.some((v: { args: { threadId: string } }) => v.args.threadId.includes("\n"))).toBe(true);
  });

  it("verifies every accepted vector, high-S included, and the gate lets each through", () => {
    for (const v of vectors.accepted) {
      expect(validateProofArgs(v.args), v.name).toEqual({ ok: true });
      expect(verifyProof(v.publicKey, v.message, v.signatureDer), v.name).toBe(true);
      const { g } = gateAt(v.args.expiresAt - 60_000, v.args.nonce);
      const ch = (g.check(input(v.args, v.publicKey)) as unknown as { body: { challenge: { nonce: string; expiresAt: number } } }).body.challenge;
      expect(ch, v.name).toMatchObject({ nonce: v.args.nonce, expiresAt: v.args.expiresAt });
      expect(g.check(input(v.args, v.publicKey, { nonce: v.args.nonce, signature: v.signatureDer })), v.name).toEqual({ ok: true });
    }
  });

  it("gives every refused entry its machine-readable outcome, from the verifier and the gate", () => {
    for (const v of vectors.refused) {
      expect(validateProofArgs(v.args), v.why).toEqual({ ok: false, code: v.expect.code });
      if (!v.gate) continue;
      const g = new FreshAuthGate({ now: () => 1_000 });
      const key = vectors.accepted[0].publicKey;
      const out = g.check({ device: device(key), threadId: v.args.threadId, requestId: v.args.requestId, decision: v.args.decision, digest: v.args.digest, proof: undefined });
      expect(out, v.why).toMatchObject({ ok: false, status: v.gate.status, body: { code: v.gate.code } });
      expect(g.size(), v.why).toBe(0);
    }
    for (const v of vectors.refused) expect(typeof v.expect.code, v.why).toBe("string");
  });

  it("refuses every negative signature vector at the verifier and the gate", () => {
    const a = vectors.accepted[0];
    for (const v of vectors.signatureCases) {
      expect(verifyProof(v.publicKey, v.message, v.signatureDer), v.name).toBe(v.expect.verify);
      const { g, at } = gateAt(v.gate.issuedAt, a.args.nonce);
      g.check(input(a.args, v.publicKey));
      at(v.gate.submitAt);
      const out = g.check(input({ ...a.args, digest: v.gate.submitDigest }, v.publicKey, { nonce: a.args.nonce, signature: v.gate.signatureDer ?? v.signatureDer }));
      expect(out, v.name).toMatchObject({ ok: false, status: v.gate.expect.status, body: { code: v.gate.expect.code } });
      if (v.gate.expect.reason) expect(out, v.name).toMatchObject({ body: { challenge: { reason: v.gate.expect.reason } } });
    }
  });
});

describe("the id rules accept every id the server really generates", () => {
  const base = () => ({ ...vectors.accepted[0].args });
  const UUID = "3f2b8c1e-9d4a-4e6b-8a1c-7d5e2f9a0b34";
  // Thread ids: store.createTask (newId), "project-proposal-<uuid>" (index.ts).
  // Request ids: newId (codex, acp, host consent, peer approval, routines),
  // "browser-<uuid>", "image-<uuid>", "murage-commands-<uuid>", "setup-<hex>",
  // permission-proxy askId (uuid), and pi's own dialog id as the engine sends it.
  const threadIds = [UUID, `project-proposal-${UUID}`];
  const requestIds = [UUID, `browser-${UUID}`, `image-${UUID}`, `murage-commands-${UUID}`, `setup-${"a1".repeat(16)}`, "toolu_01A09q90qw90lq917835lq9", "call_abc123", "1", "a:b.c/d"];

  it("passes each real thread id and request id", () => {
    for (const threadId of threadIds) expect(validateProofArgs({ ...base(), threadId }), threadId).toEqual({ ok: true });
    for (const requestId of requestIds) expect(validateProofArgs({ ...base(), requestId }), requestId).toEqual({ ok: true });
  });

  it("still bans line breaks and control characters in both", () => {
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\u007fb", "a\u2028b"]) {
      expect(validateProofArgs({ ...base(), threadId: bad })).toEqual({ ok: false, code: "bad_thread_id" });
      expect(validateProofArgs({ ...base(), requestId: bad })).toEqual({ ok: false, code: "bad_request_id" });
    }
  });
});
