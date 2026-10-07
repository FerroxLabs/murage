// server/approval-fresh-auth.ts
// SEC-006: a high-risk Allow from a paired Murage app needs a fresh device
// authentication. The phone signs this harness's nonce plus the digest of the
// live card with a key created at pairing (Secure Enclave or AndroidKeyStore,
// user presence per use). The companion vouches for which device asked and
// forwards that device's public key; this module only checks the proof.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { approvalDigestInput, type DigestCard } from "../shared/approval-digest.ts";
import { UUID } from "../shared/mobile-push.ts";

export const FRESH_AUTH_TTL_MS = 60_000;
export const MAX_CHALLENGES = 256;
export const MAX_CHALLENGES_PER_DEVICE = 32;
export const PROOF_TAG = "murage-approval-proof/1";
const POINT = /^[A-Za-z0-9_-]{87}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{8,128}$/;

export const FRESH_AUTH_COPY = {
  confirm: "Confirm it's you on this phone to allow this.",
  noKey: "Approve this on your computer. To approve high-risk actions from this phone, turn on a passcode, then pair it again.",
  unattested: "Approve this on your computer. To approve high-risk actions from this phone, update the Murage app, then pair it again.",
  answerOnComputer: "Answer this one on your computer.",
  changed: "This request changed. Review it again before you allow it.",
  computerOnly: "Approve this on your computer or in the Murage app.",
  failed: "Murage couldn't confirm it was you. Try again.",
} as const;

/** The same digest as shared approvalDigest, computed synchronously. The harness reads the live card
 *  and digests it with no await in between, so a card that changes mid-request cannot be checked against a stale digest. */
export function approvalDigestSync(threadId: string, requestId: string, card: DigestCard): string {
  return createHash("sha256").update(approvalDigestInput(threadId, requestId, card), "utf8").digest("hex");
}

export type ApprovalDecision = "allow" | "allow-task" | "answer";
export interface ApprovalDevice { id: string; cls: "app" | "browser"; key: string | null }
export interface ProofFields { threadId: string; requestId: string; decision: "allow" | "allow-task"; digest: string; nonce: string; expiresAt: number }
export type GateResult = { ok: true } | { ok: false; status: 403 | 409; body: Record<string, unknown> };

const one = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? undefined : value);

/** Call only after companionAuthorized(headers): these headers mean
 *  something only next to the launch proof. */
export function approvalDeviceFrom(headers: IncomingHttpHeaders): ApprovalDevice | null {
  const id = one(headers["x-murage-approval-device"]);
  const cls = one(headers["x-murage-approval-class"]);
  const key = one(headers["x-murage-approval-key"]);
  if (!id || !UUID.test(id) || (cls !== "app" && cls !== "browser")) return null;
  if (key !== undefined && !POINT.test(key)) return null;
  return { id, cls, key: key ?? null };
}

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
// No control character, DEL, C1 control or line/paragraph separator: the
// message is newline-framed, so an id with a line break would shift fields.
const FRAMING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// The reason is shown under the Face ID prompt, so a format character (bidi control, zero-width, BOM
// mid-string, U+061C, astral tag) is refused, never stripped. Same rule as the phones.
const FORMAT_CHAR = /\p{Cf}/u;
const validRequestId = (v: unknown): boolean => typeof v === "string" && v.length >= 1 && v.length <= 256 && !FRAMING.test(v);
const validThreadId = (v: unknown): boolean => typeof v === "string" && THREAD_ID.test(v);
const validDigest = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export type ProofArgsCode = "bad_args" | "bad_version" | "bad_decision" | "bad_digest" | "bad_nonce" | "bad_thread_id" | "bad_request_id" | "bad_expiry" | "bad_reason";

/** The field rules for the approveWithDevice args (contract: approval-proof.json).
 *  The Swift and Java parsers must refuse exactly what this refuses. */
export function validateProofArgs(args: unknown): { ok: true } | { ok: false; code: ProofArgsCode } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, code: "bad_args" };
  const a = args as Record<string, unknown>;
  if (a.v !== 1) return { ok: false, code: "bad_version" };
  if (a.decision !== "allow" && a.decision !== "allow-task") return { ok: false, code: "bad_decision" };
  if (!validThreadId(a.threadId)) return { ok: false, code: "bad_thread_id" };
  if (!validRequestId(a.requestId)) return { ok: false, code: "bad_request_id" };
  if (!validDigest(a.digest)) return { ok: false, code: "bad_digest" };
  if (typeof a.nonce !== "string" || !NONCE.test(a.nonce)) return { ok: false, code: "bad_nonce" };
  if (typeof a.expiresAt !== "number" || !Number.isSafeInteger(a.expiresAt) || a.expiresAt < 1) return { ok: false, code: "bad_expiry" };
  if (typeof a.reason !== "string" || a.reason.length < 1 || a.reason.length > 160 || FRAMING.test(a.reason) || FORMAT_CHAR.test(a.reason)) return { ok: false, code: "bad_reason" };
  return { ok: true };
}

export function proofMessage(p: ProofFields): string {
  return [PROOF_TAG, p.threadId, p.requestId, p.decision, p.digest, p.nonce, String(p.expiresAt)].join("\n");
}

export function verifyProof(point: string, message: string, signature: string): boolean {
  try {
    const raw = Buffer.from(point, "base64url");
    if (raw.length !== 65 || raw[0] !== 4 || !SIGNATURE.test(signature)) return false;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    return verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

function parseProof(value: unknown): { nonce: string; signature: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { nonce, signature } = value as Record<string, unknown>;
  return typeof nonce === "string" && NONCE.test(nonce) && typeof signature === "string" ? { nonce, signature } : null;
}

type Held = ProofFields & { deviceId: string };
const refuse = (status: 403 | 409, code: string, error: string): GateResult => ({ ok: false, status, body: { error, code } });

export class FreshAuthGate {
  private readonly held = new Map<string, Held>();
  private readonly deps: { now: () => number; nonce?: () => string };
  constructor(deps: { now: () => number; nonce?: () => string }) {
    this.deps = deps;
  }
  size(): number { return this.held.size; }

  check(input: { device: ApprovalDevice | null; threadId: string; requestId: string; decision: ApprovalDecision; digest: string; proof: unknown }): GateResult {
    const { device } = input;
    // Ids and digest are signed newline-framed: refuse any that could shift a field.
    if (!validThreadId(input.threadId) || !validRequestId(input.requestId) || !validDigest(input.digest)) return refuse(403, "fresh_auth_failed", FRESH_AUTH_COPY.failed);
    // Decision 1: a browser pairing never passes for a high-risk card, with or without a proof.
    if (device?.cls === "browser") return refuse(403, "approve_on_computer", FRESH_AUTH_COPY.computerOnly);
    if (input.decision === "answer") return refuse(403, "answer_on_computer", FRESH_AUTH_COPY.answerOnComputer);
    if (!device) return refuse(403, "fresh_auth_unavailable", FRESH_AUTH_COPY.noKey);
    // Decision 8: an app pairing with no key carries no relay attestation, so it approves low-rated cards only.
    if (!device.key) return refuse(403, "fresh_auth_unattested", FRESH_AUTH_COPY.unattested);
    const decision = input.decision;
    const proof = parseProof(input.proof);
    if (!proof) return this.live(device.id, input, decision) ?? this.challenge(device.id, input, decision);
    const held = this.held.get(proof.nonce);
    // Ownership first: a submission from another device or for another request leaves the owner's nonce untouched.
    if (!held || held.deviceId !== device.id || held.threadId !== input.threadId || held.requestId !== input.requestId || held.decision !== decision) {
      return refuse(403, "fresh_auth_failed", FRESH_AUTH_COPY.failed);
    }
    this.held.delete(proof.nonce); // single use for its owner, whatever happens next
    if (held.expiresAt <= this.deps.now()) return this.challenge(device.id, input, decision, "expired");
    if (held.digest !== input.digest) return this.challenge(device.id, input, decision, "changed");
    if (!verifyProof(device.key, proofMessage(held), proof.signature)) return refuse(403, "fresh_auth_failed", FRESH_AUTH_COPY.failed);
    return { ok: true };
  }

  /** The unexpired challenge this device already holds for exactly this card and decision, if any.
   *  A double tap, or a spoken yes beside a tap, then shares one nonce instead of cancelling the first prompt. */
  private live(deviceId: string, input: { threadId: string; requestId: string; digest: string }, decision: "allow" | "allow-task"): GateResult | null {
    const now = this.deps.now();
    for (const held of this.held.values()) {
      if (held.deviceId !== deviceId || held.threadId !== input.threadId || held.requestId !== input.requestId || held.decision !== decision || held.digest !== input.digest || held.expiresAt <= now) continue;
      return { ok: false, status: 403, body: { error: FRESH_AUTH_COPY.confirm, code: "fresh_auth", challenge: { v: 1, nonce: held.nonce, digest: held.digest, decision, expiresAt: held.expiresAt } } };
    }
    return null;
  }

  private challenge(deviceId: string, input: { threadId: string; requestId: string; digest: string }, decision: "allow" | "allow-task", reason?: "expired" | "changed"): GateResult {
    const now = this.deps.now();
    for (const [nonce, held] of this.held) {
      if (held.expiresAt <= now || (held.deviceId === deviceId && held.threadId === input.threadId && held.requestId === input.requestId)) this.held.delete(nonce);
    }
    // a device that floods challenges evicts only its own oldest, never another phone's
    let mine = 0;
    for (const held of this.held.values()) if (held.deviceId === deviceId) mine++;
    for (const [nonce, held] of this.held) {
      if (mine < MAX_CHALLENGES_PER_DEVICE) break;
      if (held.deviceId === deviceId) { this.held.delete(nonce); mine--; }
    }
    // overall backstop: never evict another phone's challenge. Drop this device's own oldest, or refuse the new one.
    while (this.held.size >= MAX_CHALLENGES) {
      let own: string | null = null;
      for (const [nonce, held] of this.held) if (held.deviceId === deviceId) { own = nonce; break; }
      if (own === null) return refuse(403, "fresh_auth_failed", FRESH_AUTH_COPY.failed);
      this.held.delete(own);
    }
    const nonce = this.deps.nonce?.() ?? randomBytes(32).toString("base64url");
    const expiresAt = now + FRESH_AUTH_TTL_MS;
    this.held.set(nonce, { deviceId, threadId: input.threadId, requestId: input.requestId, decision, digest: input.digest, nonce, expiresAt });
    const changed = reason === "changed";
    return {
      ok: false,
      status: changed ? 409 : 403,
      body: {
        error: changed ? FRESH_AUTH_COPY.changed : FRESH_AUTH_COPY.confirm,
        code: changed ? "fresh_auth_changed" : "fresh_auth",
        challenge: { v: 1, nonce, digest: input.digest, decision, expiresAt, ...(reason ? { reason } : {}) },
      },
    };
  }
}
