// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The home's side of the fresh emailed code for an owner's browser (DESIGN section 6).
// The control plane sends and checks the code and signs a proof (murage-owner-act-v1) for ONE act; this file mints the stateless act
// token the 403 answer carries, relays send/verify to the control plane, and checks the proof that comes back on the retried request.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { canonicalJson } from "../package-signature.ts";
import { OWNER_CODE_LABELS, type OwnerCodeLabel } from "../browser-owner-policy.ts";
import type { CloudDevice, CloudSessions } from "../cloud-sessions.ts";
import type { CloudOwnerAct, OwnerActTokenInput } from "../cloud-request-auth.ts";
import { verifiedOwnerActProof, type ControlPlanePublicJwk } from "./b1b-identity.ts";
import { cloudHomeCopy } from "./copy.ts";
import type { CpResult } from "./cp-client.ts";
import type { OwnerEvents } from "./owner-events.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The act a card decision is bound to (DESIGN section 6): the fields of the approval proof message plus what the digest leaves out. */
export function cardActDigest(i: { threadId: string; requestId: string; decision: string; approvalDigest: string; riskReason: string; extra?: unknown }): string {
  const extra = i.extra === undefined || i.extra === null ? "" : canonicalJson(i.extra);
  return sha256(`card\n${i.threadId}\n${i.requestId}\n${i.decision}\n${i.approvalDigest}\n${i.riskReason}\n${extra}`);
}
/** The act a skill switch-on is bound to: the route's act string plus the scanned content hash, so changed code needs a new code. */
export function skillActDigest(routeAct: string, contentHash: string): string {
  return sha256(`skill\n${routeAct}\n${contentHash}`);
}

export const ACT_TOKEN_DOMAIN = "murage-act-token-v1\n";
export const ACT_TOKEN_TTL_MS = 10 * 60_000;
export const OWNER_PROOF_HEADER = "x-murage-owner-proof";
export const CODE_UNAVAILABLE_COPY = "We couldn't send your code just now. Nothing was changed. Try again in a minute.";
const PER_DEVICE_PER_MINUTE = 10;
const MAX_HEADER = 8_600;

export interface ActTokenClaims { deviceId: string; accessHash: string; act: string; label: OwnerCodeLabel; labelArg?: string; exp: number }
export interface OwnerCodeDeps {
  sessions: CloudSessions;
  call: (op: string, fields?: Record<string, unknown>) => Promise<CpResult>;
  secret: () => string | undefined;
  /** The pinned home id, generation and control-plane key; throws when unreadable. */
  binding: () => { homeId: string; generation: number; publicJwk: ControlPlanePublicJwk };
  events?: Pick<OwnerEvents, "record">;
  now?: () => number;
}
export interface OwnerCodeAnswer { status: number; body: Record<string, unknown> }
export interface OwnerCodeService extends CloudOwnerAct {
  send(device: CloudDevice, accessHash: string, input: unknown): Promise<OwnerCodeAnswer>;
  verify(device: CloudDevice, accessHash: string, input: unknown): Promise<OwnerCodeAnswer>;
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const unavailable = (): OwnerCodeAnswer => ({ status: 503, body: { error: CODE_UNAVAILABLE_COPY, code: "code_unavailable" } });
const refused = (): OwnerCodeAnswer => ({ status: 403, body: { error: cloudHomeCopy.ownerCodeSignInAgain, code: "token_refused" } });

export function createOwnerCode(deps: OwnerCodeDeps): OwnerCodeService {
  const now = () => deps.now?.() ?? Date.now();
  const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(ACT_TOKEN_DOMAIN + payload).digest("hex");
  const hits = new Map<string, number[]>();
  /** Seconds to wait when this device already used its minute, else 0 (and the use is counted). */
  const limited = (key: string): number => {
    const t = now(), live = (hits.get(key) ?? []).filter(at => t - at < 60_000);
    if (live.length >= PER_DEVICE_PER_MINUTE) { hits.set(key, live); return Math.max(1, Math.ceil((live[0]! + 60_000 - t) / 1000)); }
    live.push(t); hits.set(key, live);
    if (hits.size > 1000) for (const [k, v] of hits) if (v.every(at => t - at >= 60_000)) hits.delete(k);
    return 0;
  };
  const token = (input: OwnerActTokenInput): string => {
    const secret = deps.secret();
    if (!secret) throw new Error(cloudHomeCopy.ownerCodeNoSecret);
    const claims: ActTokenClaims = { deviceId: input.deviceId, accessHash: input.accessHash, act: input.act, label: input.label, ...(input.labelArg ? { labelArg: input.labelArg.slice(0, 60) } : {}), exp: now() + ACT_TOKEN_TTL_MS };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${payload}.${mac(secret, payload)}`;
  };
  /** The token's claims when its MAC is ours, it is unexpired, and it names exactly this device and sign-in. Never throws. */
  const readToken = (raw: unknown, device: CloudDevice, accessHash: string): ActTokenClaims | undefined => {
    try {
      const secret = deps.secret();
      if (!secret || typeof raw !== "string" || raw.length > 1500) return undefined;
      const dot = raw.indexOf(".");
      if (dot < 1) return undefined;
      const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
      if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[0-9a-f]{64}$/.test(sig) || !same(sig, mac(secret, payload))) return undefined;
      const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ActTokenClaims>;
      if (!c || typeof c !== "object" || typeof c.exp !== "number" || c.exp <= now() || c.exp > now() + ACT_TOKEN_TTL_MS + 1000) return undefined;
      if (typeof c.deviceId !== "string" || c.deviceId !== device.id || typeof c.accessHash !== "string" || !same(c.accessHash, accessHash)) return undefined;
      if (typeof c.act !== "string" || !/^[0-9a-f]{64}$/.test(c.act) || !(OWNER_CODE_LABELS as readonly string[]).includes(c.label as string)) return undefined;
      if (c.labelArg !== undefined && (typeof c.labelArg !== "string" || c.labelArg.length > 60)) return undefined;
      return c as ActTokenClaims;
    } catch { return undefined; }
  };
  const verifyProof = (req: IncomingMessage, device: CloudDevice, act: string): boolean => {
    // Correct proofs also need the pinned binding and a durable, single-use nonce.
    // Only these closed cause codes are logged; headers and error text can contain proof material.
    let cause: "bad-proof" | "binding" | "owner-store" | "nonce-store" = "bad-proof";
    try {
      const header = req.headers[OWNER_PROOF_HEADER];
      if (typeof header !== "string" || header.length > MAX_HEADER || !/^[A-Za-z0-9_-]+$/.test(header)) return false;
      const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { payload?: unknown; signature?: unknown; algorithm?: unknown };
      if (!parsed || typeof parsed !== "object" || typeof parsed.payload !== "string" || typeof parsed.signature !== "string" || (parsed.algorithm !== undefined && parsed.algorithm !== "ES256")) return false;
      cause = "binding";
      const pin = deps.binding();
      cause = "bad-proof";
      const claims = verifiedOwnerActProof({ payload: parsed.payload, signature: parsed.signature }, pin.publicJwk, pin.homeId, pin.generation, now());
      cause = "owner-store";
      const owner = deps.sessions.owner();
      if (!owner || claims.account !== owner || claims.deviceId !== device.id || !same(claims.act, act)) return false;
      // Spent once, last: a proof refused above keeps its nonce for the request it was really issued for.
      cause = "nonce-store";
      const db = deps.sessions.db;
      db.prepare("DELETE FROM cloud_door_nonces WHERE expires<=?").run(now());
      try { db.prepare("INSERT INTO cloud_door_nonces (nonce, expires) VALUES (?,?)").run(`oa:${claims.nonce}`, claims.expiresAt + 60_000); }
      catch (error) {
        const code = (error as { errcode?: unknown } | null)?.errcode;
        console.warn(cloudHomeCopy.ownerCodeProofRefused, code === 1555 || code === 2067 ? "proof-reused" : "nonce-store");
        return false;
      }
      try { deps.events?.record("code_used"); } catch { /* an event never blocks the owner's own act */ }
      return true;
    } catch { console.warn(cloudHomeCopy.ownerCodeProofRefused, cause); return false; }
  };
  const send = async (device: CloudDevice, accessHash: string, input: unknown): Promise<OwnerCodeAnswer> => {
    const retry = limited(`send:${device.id}`);
    if (retry) return { status: 429, body: { error: cloudHomeCopy.ownerCodeRate, retryIn: retry, limit: "gap" } };
    const claims = readToken((input as { actToken?: unknown } | null)?.actToken, device, accessHash);
    if (!claims) return refused();
    const r = await deps.call("owner-code-send", { deviceId: device.id, act: claims.act, label: claims.label, ...(claims.labelArg ? { labelArg: claims.labelArg } : {}) });
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (r.ok) {
      if (typeof b.challengeId !== "string" || typeof b.maskedEmail !== "string") return unavailable();
      return { status: 200, body: { challengeId: b.challengeId, maskedEmail: b.maskedEmail, resendIn: typeof b.resendIn === "number" ? b.resendIn : 30 } };
    }
    if (r.status === 429 && b.error === "rate_limited") {
      const day = b.limit === "day";
      return { status: 429, body: { error: cloudHomeCopy.ownerCodeRate, retryIn: typeof b.retryAfter === "number" ? b.retryAfter : 60, limit: day ? "day" : "gap" } };
    }
    return unavailable();
  };
  const verify = async (device: CloudDevice, accessHash: string, input: unknown): Promise<OwnerCodeAnswer> => {
    const retry = limited(`verify:${device.id}`);
    if (retry) return { status: 429, body: { error: cloudHomeCopy.ownerCodeRate, retryIn: retry, limit: "gap" } };
    const claims = readToken((input as { actToken?: unknown } | null)?.actToken, device, accessHash);
    if (!claims) return refused();
    const { challengeId, code } = (input ?? {}) as { challengeId?: unknown; code?: unknown };
    if (typeof challengeId !== "string" || !/^oc_[0-9a-f]{32}$/.test(challengeId) || typeof code !== "string" || !/^\d{6}$/.test(code)) return { status: 400, body: { error: cloudHomeCopy.ownerCodeWrong } };
    const r = await deps.call("owner-code-verify", { deviceId: device.id, act: claims.act, challengeId, code });
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (r.ok) {
      const p = b.proof as { payload?: unknown; signature?: unknown } | undefined;
      if (!p || typeof p.payload !== "string" || typeof p.signature !== "string") return unavailable();
      return { status: 200, body: { proof: { payload: p.payload, signature: p.signature, algorithm: "ES256" } } };
    }
    if (r.status === 403 && b.error === "code_refused") return { status: 400, body: { error: cloudHomeCopy.ownerCodeWrong } };
    if (r.status === 403 && b.error === "code_expired") return { status: 400, body: { error: cloudHomeCopy.ownerCodeExpired } };
    if (b.error === "code_locked" || b.error === "locked") return { status: 400, body: { error: cloudHomeCopy.ownerCodeLocked } };
    return unavailable();
  };
  return { token, verifyProof, doorFresh: deviceId => deps.sessions.doorFresh(deviceId), send, verify };
}
