// Server-side keyId hash for the phone-jobs contract. Uses node:crypto, so it must never be
// imported from src/ (shared/web-safe-imports.test.ts guards the web graph).
import { createHash } from "node:crypto";

const B64URL_POINT = /^[A-Za-z0-9_-]{87}$/;

/** keyId = base64url(SHA-256 of the 65 decoded point bytes), never of the string (N8). Null for anything that is not an uncompressed P-256 point. */
export function approvalKeyId(point: string): string | null {
  if (typeof point !== "string" || !B64URL_POINT.test(point)) return null;
  const raw = Buffer.from(point, "base64url");
  if (raw.length !== 65 || raw[0] !== 4) return null;
  return createHash("sha256").update(raw).digest("base64url");
}
