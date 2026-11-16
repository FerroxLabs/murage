import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";

const SCOPE = "chats-read";
const TTL_MS = 60_000;

/** The trusted companion mints a short-lived, chats-only credential. A domain-separated
 * signing key binds it to this launch without forwarding the launch credential itself. */
export function createChatsReaderAuthority(launchToken: string | undefined, now = Date.now) {
  const key = typeof launchToken === "string" && /^[a-f0-9]{64}$/.test(launchToken)
    ? Buffer.from(hkdfSync("sha256", Buffer.from(launchToken, "hex"), "murage", "chats-reader-v1", 32)) : null;
  const sign = (payload: string) => createHmac("sha256", key!).update(payload).digest();
  return {
    mint(scope = SCOPE): string | undefined {
      if (!key) return undefined;
      const issuedAt = now();
      const payload = Buffer.from(JSON.stringify({ id: randomUUID(), scope, issuedAt, expiresAt: issuedAt + TTL_MS })).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    verify(proof: unknown): boolean {
      if (!key || typeof proof !== "string" || proof.length > 1024) return false;
      const parts = proof.split(".");
      if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
      const [payload, signature] = parts as [string, string];
      const supplied = Buffer.from(signature, "base64url"), expected = sign(payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
      try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        const time = now();
        return typeof claims.id === "string" && /^[a-f0-9-]{36}$/.test(claims.id) && claims.scope === SCOPE
          && Number.isSafeInteger(claims.issuedAt) && Number.isSafeInteger(claims.expiresAt)
          && claims.issuedAt <= time && claims.expiresAt > time && claims.expiresAt - claims.issuedAt === TTL_MS;
      } catch { return false; }
    },
  };
}
