// SPDX-License-Identifier: AGPL-3.0-or-later
// The one shared definition of the signed image statement: payload bytes, field rules, signature encoding, and the pinned trust lists.
// Imported by the Worker (src/image-signature.ts) and by scripts/check-deploy.mjs, so both sides build the same bytes.

export const IMAGE_SIG_VERSION = "murage-image-sig/1";
/** sha256 (lowercase hex) of the DER of each public key the Worker may trust. Changing the trust root needs a code change. */
export const TRUSTED_IMAGE_KEY_FPS = ["3297b57ae1685fbdf5f176941735c276715124099519a8e0646a7f0bf2c4661b"];
/** sha256 of each reviewed deploy/cloud-home/image-release-check.sh a signature may name. Newest last.
 *  While this list is empty no signature can verify, and check-deploy refuses production and staging (fail closed). */
export const ACCEPTED_CHECK_SHA256 = ["c2051ebd5a4e7411eb46513c7238a1ebbc44ffe94af1ea0b1b70ae4dfc4ee790"];
/** Image ids that may never create a server again (every superseded production image is added in the commit that pins its successor). */
export const REVOKED_IMAGE_IDS = [];
export const IMAGE_SIG_MAX_AGE_DAYS = 180;
export const IMAGE_SIG_ALERT_DAYS = [30, 7];
export const DAY_MS = 86_400_000;
export const RECHECK_TTL_MS = 3_600_000;
export const RECHECK_TIMEOUT_MS = 5_000;

export const ID_RE = /^[1-9][0-9]{0,15}$/;
export const CREATED_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const VERIFIED_AT_RE = /^[0-9]{8}T[0-9]{6}Z$/;
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const clean = (v) => typeof v === "string" && !v.includes("\n");

export const validImageId = (v) => clean(v) && ID_RE.test(v) && Number.isSafeInteger(Number(v));
export const validCreatedAt = (v) => clean(v) && CREATED_RE.test(v) && parseCreatedMs(v) !== null;
/** The entry's image size text: ECMAScript number text, 0.001 <= x < 1e6, never an exponent, canonical (round-trips). */
export function validImageSizeText(v) {
  if (!clean(v) || !/^[0-9]+(\.[0-9]+)?$/.test(v)) return false;
  const x = Number(v);
  return Number.isFinite(x) && x >= 0.001 && x < 1e6 && String(x) === v;
}
/** The text of a number from the build host API (`image_size`), or null when it is out of range or not a number. */
export function imageSizeText(x) {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0.001 || x >= 1e6) return null;
  const s = String(x);
  return validImageSizeText(s) ? s : null;
}

/** RFC 3339 `created` to epoch ms (offset applied, calendar checked, fraction truncated to ms), or null. */
export function parseCreatedMs(s) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (h > 23 || mi > 59 || se > 59) return null;
  const ms = Number(((m[7] ?? "") + "000").slice(0, 3));
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  let offset = 0;
  if (m[8] !== "Z") {
    const sign = m[8][0] === "-" ? -1 : 1; const oh = Number(m[8].slice(1, 3)); const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = sign * (oh * 60 + om) * 60_000;
  }
  return t - offset;
}
/** `YYYYMMDDTHHMMSSZ` to epoch ms with a calendar round trip (no Feb 30), or null. */
export function parseVerifiedAtMs(s) {
  if (!clean(s) || !VERIFIED_AT_RE.test(s)) return null;
  const y = Number(s.slice(0, 4)); const mo = Number(s.slice(4, 6)); const d = Number(s.slice(6, 8));
  const h = Number(s.slice(9, 11)); const mi = Number(s.slice(11, 13)); const se = Number(s.slice(13, 15));
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const b = new Date(t);
  if (b.getUTCFullYear() !== y || b.getUTCMonth() !== mo - 1 || b.getUTCDate() !== d || b.getUTCHours() !== h || b.getUTCMinutes() !== mi || b.getUTCSeconds() !== se) return null;
  return t;
}

/** The eight-member payload, a fixed-order template after per-field checks (never JSON.stringify of an object). Throws on any bad field. */
export function buildPayload(f) {
  if (!validImageId(f.imageId)) throw new Error("payload_image_id");
  if (!validCreatedAt(f.createdAt)) throw new Error("payload_created_at");
  if (!validImageSizeText(f.imageSize)) throw new Error("payload_image_size");
  if (f.env !== "staging" && f.env !== "prod") throw new Error("payload_env");
  if (!(clean(f.checkSha256) && HEX64_RE.test(f.checkSha256))) throw new Error("payload_check_sha256");
  if (f.verdict !== "pass") throw new Error("payload_verdict");
  if (parseVerifiedAtMs(f.verifiedAt) === null) throw new Error("payload_verified_at");
  return `{"v":"${IMAGE_SIG_VERSION}","image_id":"${f.imageId}","created_at":"${f.createdAt}","image_size":"${f.imageSize}","env":"${f.env}","check_sha256":"${f.checkSha256}","verdict":"pass","verified_at":"${f.verifiedAt}"}`;
}

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function b64urlEncode(bytes) {
  let out = ""; let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U[n >> 18] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63];
  }
  if (i + 1 === bytes.length) { const n = bytes[i] << 16; out += B64U[n >> 18] + B64U[(n >> 12) & 63]; }
  else if (i + 2 === bytes.length) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64U[n >> 18] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63]; }
  return out;
}
/** Strict: the alphabet, and a canonical re-encoding. Returns Uint8Array or null. */
export function b64urlDecode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = []; let acc = 0; let bits = 0;
  for (const ch of s) { acc = (acc << 6) | B64U.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; } }
  const bytes = Uint8Array.from(out);
  return b64urlEncode(bytes) === s ? bytes : null;
}
/** The stored form of `sig`: base64url of exactly 64 bytes, re-encoding to the identical text. Returns the 64 raw bytes or null. */
export function decodeStoredSig(s) {
  if (!clean(s) || !SIG_RE.test(s)) return null;
  const b = b64urlDecode(s);
  return b && b.length === 64 ? b : null;
}

const P256_N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
/** Strict DER ECDSA-Sig-Value to 64-byte raw r||s (P1363). Throws on anything non-canonical. */
export function derToP1363(der) {
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  const fail = (why) => { throw new Error(`der_${why}`); };
  if (b.length < 8 || b[0] !== 0x30) fail("sequence");
  if (b[1] & 0x80) fail("length_form"); // one-byte length only
  if (b[1] !== b.length - 2) fail("length");
  let i = 2;
  const take = () => {
    if (b[i] !== 0x02) fail("integer_tag");
    const len = b[i + 1];
    if (len === undefined || len < 1 || len > 33 || (len & 0x80)) fail("integer_length");
    const v = b.slice(i + 2, i + 2 + len);
    if (v.length !== len) fail("truncated");
    i += 2 + len;
    if (v[0] & 0x80) fail("negative");
    if (v.length > 1 && v[0] === 0x00 && !(v[1] & 0x80)) fail("not_minimal");
    const stripped = v[0] === 0x00 && v.length > 1 ? v.slice(1) : v;
    if (stripped.length > 32) fail("integer_too_long");
    const out = new Uint8Array(32); out.set(stripped, 32 - stripped.length);
    return out;
  };
  const r = take(); const s = take();
  if (i !== b.length) fail("trailing");
  const big = (x) => BigInt("0x" + Array.from(x, (v) => v.toString(16).padStart(2, "0")).join(""));
  for (const x of [r, s]) { const n = big(x); if (n < 1n || n >= P256_N) fail("range"); }
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32);
  return raw;
}

const ENTRY_KEYS = ["kind", "verifiedBy", "checkVersion", "verifiedAt", "createdAt", "imageSize", "env", "checkSha256", "verdict", "keyFp", "sig"];
/** Strict validation of a customer imageKinds entry. Returns { ok:true, entry } or { ok:false } (the caller maps it to image_sig_malformed). */
export function parseCustomerEntry(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false };
  const keys = Object.keys(v);
  if (keys.some((k) => !ENTRY_KEYS.includes(k)) || v.kind !== "customer") return { ok: false };
  if (v.verifiedBy !== "hz-live-rescue" || typeof v.checkVersion !== "string" || !/^[1-9][0-9]{0,3}$/.test(v.checkVersion)) return { ok: false };
  if (parseVerifiedAtMs(v.verifiedAt) === null || !validCreatedAt(v.createdAt) || !validImageSizeText(v.imageSize)) return { ok: false };
  if (v.env !== "staging" && v.env !== "prod") return { ok: false };
  if (!(typeof v.checkSha256 === "string" && HEX64_RE.test(v.checkSha256)) || v.verdict !== "pass") return { ok: false };
  if (!(typeof v.keyFp === "string" && HEX64_RE.test(v.keyFp)) || decodeStoredSig(v.sig) === null) return { ok: false };
  return { ok: true, entry: v };
}
/** Days of validity left at `nowMs`, or a negative number once expired. */
export const daysLeft = (verifiedAtMs, nowMs) => (verifiedAtMs + IMAGE_SIG_MAX_AGE_DAYS * DAY_MS - nowMs) / DAY_MS;

/** 64-byte raw r||s to a DER ECDSA-Sig-Value (minimal INTEGERs). For verifiers whose runtime only takes DER. */
export function p1363ToDer(raw) {
  const int = (b) => { let a = Array.from(b); while (a.length > 1 && a[0] === 0) a = a.slice(1); if (a[0] & 0x80) a = [0, ...a]; return [0x02, a.length, ...a]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32, 64))];
  return Uint8Array.from([0x30, body.length, ...body]);
}
