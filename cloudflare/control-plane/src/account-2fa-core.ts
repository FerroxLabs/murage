// SPDX-License-Identifier: AGPL-3.0-or-later
// B5 account second factor. Pure logic over a store, so the Worker (D1) and the portal's
// browser-journey fake control plane (memory) run the same checks. The assertion check is
// the home's own b1b-webauthn.ts.
import { createPublicKey } from "node:crypto";
import {
  isP256,
  validBrowserFactor,
  verifyBrowserAssertion,
  type BrowserFactor,
} from "../../../server/cloud-home/b1b-webauthn";
import { HTTPError } from "./http";

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const STEPUP_TTL_MS = 30 * 60_000;
const MAX_FACTORS = 5;

export interface FactorRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKeyPem: string;
  rpId: string;
  origin: string;
  counter: number;
  label: string;
  createdAt: number;
}
export interface TwoFactorStore {
  listFactors(userId: string): Promise<FactorRow[]>;
  insertFactor(row: FactorRow): Promise<boolean>;
  setCounter(id: string, counter: number, now: number): Promise<void>;
  putChallenge(id: string, userId: string, purpose: "register" | "assert", message: string, expiresAt: number): Promise<void>;
  /** Single use: returns the message once, then never again. */
  takeChallenge(id: string, userId: string, purpose: "register" | "assert", now: number): Promise<string | null>;
  markVerified(sessionId: string, userId: string, until: number): Promise<void>;
  verifiedUntil(sessionId: string, userId: string): Promise<number | null>;
}
export interface TwoFactorContext {
  store: TwoFactorStore;
  /** The portal origin, e.g. https://cloud.murage.ai. The RP id is its hostname. */
  portalOrigin: string;
  userId: string;
  userEmail: string;
  sessionId: string;
  now: number;
  randomId: () => string;
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const randomMessage = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

function spkiToPem(spkiBase64Url: string): string {
  const der = Buffer.from(spkiBase64Url, "base64url");
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

export async function twoFactorStatus(ctx: TwoFactorContext) {
  const factors = await ctx.store.listFactors(ctx.userId);
  const until = await ctx.store.verifiedUntil(ctx.sessionId, ctx.userId);
  const verified = factors.length > 0 && until !== null && until > ctx.now;
  return {
    enrolled: factors.length > 0,
    verified,
    verifiedUntil: verified ? until : null,
    factors: factors.map((f) => ({ id: f.id, label: f.label, createdAt: f.createdAt })),
  };
}

export async function stepUpSatisfied(ctx: TwoFactorContext): Promise<boolean> {
  return (await twoFactorStatus(ctx)).verified;
}

export async function registerOptions(ctx: TwoFactorContext) {
  const factors = await ctx.store.listFactors(ctx.userId);
  // Email access alone must not add a device to an account that already has one.
  if (factors.length > 0 && !(await stepUpSatisfied(ctx))) throw new HTTPError(403, "step_up_required");
  if (factors.length >= MAX_FACTORS) throw new HTTPError(409, "too_many_factors");
  const id = ctx.randomId();
  const message = randomMessage();
  await ctx.store.putChallenge(id, ctx.userId, "register", message, ctx.now + CHALLENGE_TTL_MS);
  return {
    challengeId: id,
    // The browser challenge is the UTF-8 bytes of `message`.
    message,
    rp: { id: new URL(ctx.portalOrigin).hostname, name: "Murage Cloud" },
    user: { id: b64u(new TextEncoder().encode(ctx.userId)), name: ctx.userEmail, displayName: ctx.userEmail },
    excludeCredentials: factors.map((f) => f.credentialId),
  };
}

export interface RegisterInput { challengeId: unknown; credentialId: unknown; publicKey: unknown; clientDataJSON: unknown; label?: unknown }

export async function registerFinish(ctx: TwoFactorContext, input: RegisterInput) {
  const { challengeId, credentialId, publicKey, clientDataJSON } = input;
  if ([challengeId, credentialId, publicKey, clientDataJSON].some((v) => typeof v !== "string" || v.length > 8192 || v.length === 0)) {
    throw new HTTPError(400, "invalid_request");
  }
  const existing = await ctx.store.listFactors(ctx.userId);
  if (existing.length > 0 && !(await stepUpSatisfied(ctx))) throw new HTTPError(403, "step_up_required");
  const message = await ctx.store.takeChallenge(challengeId as string, ctx.userId, "register", ctx.now);
  if (!message) throw new HTTPError(400, "challenge_expired");
  let data: { type?: unknown; origin?: unknown; challenge?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(Buffer.from(clientDataJSON as string, "base64url").toString("utf8")); } catch { throw new HTTPError(400, "invalid_request"); }
  if (data.type !== "webauthn.create" || data.origin !== ctx.portalOrigin || data.crossOrigin === true
    || data.challenge !== Buffer.from(message).toString("base64url")) throw new HTTPError(400, "invalid_request");
  let pem: string;
  try { pem = spkiToPem(publicKey as string); createPublicKey(pem); } catch { throw new HTTPError(400, "invalid_request"); }
  if (!isP256(pem)) throw new HTTPError(400, "unsupported_key");
  const rpId = new URL(ctx.portalOrigin).hostname;
  const factor: BrowserFactor = { credentialId: credentialId as string, rpId, origin: ctx.portalOrigin, counter: 0 };
  if (!validBrowserFactor(factor, ctx.portalOrigin)) throw new HTTPError(400, "invalid_request");
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 40) : "Security key";
  const row: FactorRow = { id: ctx.randomId(), userId: ctx.userId, publicKeyPem: pem, label, createdAt: ctx.now, ...factor };
  if (!(await ctx.store.insertFactor(row))) throw new HTTPError(409, "conflict");
  // The person just proved they hold the device, so this session is stepped up.
  await ctx.store.markVerified(ctx.sessionId, ctx.userId, ctx.now + STEPUP_TTL_MS);
  return { id: row.id, label };
}

export async function assertOptions(ctx: TwoFactorContext) {
  const factors = await ctx.store.listFactors(ctx.userId);
  if (factors.length === 0) throw new HTTPError(409, "no_factor");
  const id = ctx.randomId();
  const message = randomMessage();
  await ctx.store.putChallenge(id, ctx.userId, "assert", message, ctx.now + CHALLENGE_TTL_MS);
  return { challengeId: id, message, rpId: new URL(ctx.portalOrigin).hostname, allowCredentials: factors.map((f) => f.credentialId) };
}

export async function assertFinish(ctx: TwoFactorContext, input: { challengeId: unknown; assertion: unknown }) {
  if (typeof input.challengeId !== "string") throw new HTTPError(400, "invalid_request");
  const message = await ctx.store.takeChallenge(input.challengeId, ctx.userId, "assert", ctx.now);
  if (!message) throw new HTTPError(400, "challenge_expired");
  const credentialId = (input.assertion as { credentialId?: unknown } | null)?.credentialId;
  const factor = (await ctx.store.listFactors(ctx.userId)).find((f) => f.credentialId === credentialId);
  if (!factor) throw new HTTPError(403, "factor_rejected");
  const counter = verifyBrowserAssertion(
    factor.publicKeyPem,
    { credentialId: factor.credentialId, rpId: factor.rpId, origin: factor.origin, counter: factor.counter },
    message,
    input.assertion,
  );
  if (counter === undefined) throw new HTTPError(403, "factor_rejected");
  await ctx.store.setCounter(factor.id, counter, ctx.now);
  const until = ctx.now + STEPUP_TTL_MS;
  await ctx.store.markVerified(ctx.sessionId, ctx.userId, until);
  return { verified: true, verifiedUntil: until };
}
