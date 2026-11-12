// Tokens (design v5.6.1 3.4): every token is derived from a persisted id, so any mail can be rebuilt from rows D1 holds.
// token = subjectKey("updates-token", token_id + ":" + key_version, BETTER_AUTH_SECRET); token_hash = hex(sha256(token)).
import { subjectKey } from "../announcements";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deriveToken(tokenId: string, keyVersion: number, secret: string): Promise<{ token: string; tokenHash: string }> {
  const token = await subjectKey("updates-token", `${tokenId}:${keyVersion}`, secret);
  return { token, tokenHash: await sha256Hex(token) };
}

export const proveTokenId = (outboxId: string) => `prove:${outboxId}`;
export const unsubTokenId = (outboxId: string) => `unsub:${outboxId}`;

/** The address key every updates table uses; the same HMAC as the announcements code, so old opt-outs join (3.1). */
export const emailKeyOf = (email: string, secret: string) => subjectKey("announce-email", email, secret);
