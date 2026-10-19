// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
export interface BrowserFactor { credentialId: string; rpId: string; origin: string; counter: number }
export interface BrowserAssertion { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();
/** The CP enrolls the credential; each assertion still proves RP, origin and UV. */
export function verifyBrowserAssertion(key: string, factor: BrowserFactor, message: string, value: unknown): number | undefined {
  try {
    const a = value as BrowserAssertion;
    if (!a || a.credentialId !== factor.credentialId || [a.clientDataJSON,a.authenticatorData,a.signature].some(v => typeof v !== "string" || v.length > 8192)) return;
    const client = Buffer.from(a.clientDataJSON,"base64url"), auth = Buffer.from(a.authenticatorData,"base64url");
    const data = JSON.parse(client.toString("utf8"));
    if (data.type !== "webauthn.get" || data.origin !== factor.origin || data.crossOrigin === true || data.challenge !== Buffer.from(message).toString("base64url")) return;
    if (auth.length < 37 || !timingSafeEqual(auth.subarray(0,32),digest(factor.rpId)) || (auth[32]! & 5) !== 5) return;
    const counter = auth.readUInt32BE(33);
    if ((counter !== 0 || factor.counter !== 0) && counter <= factor.counter) return;
    if (!verify("sha256",Buffer.concat([auth,digest(client)]),key,Buffer.from(a.signature,"base64url"))) return;
    return counter;
  } catch { return; }
}
export function validBrowserFactor(factor: BrowserFactor, publicOrigin: string): boolean {
  try {
    const origin = new URL(publicOrigin);
    return origin.protocol === "https:" && origin.origin === publicOrigin && factor.origin === publicOrigin && factor.rpId === origin.hostname
      && typeof factor.credentialId === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(factor.credentialId) && factor.counter === 0;
  } catch { return false; }
}
export function isP256(key: string): boolean {
  try { const k=createPublicKey(key); return k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1"; } catch { return false; }
}
