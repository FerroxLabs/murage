import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** A private launch proof, not the client-controlled companion marker. */
export function createCompanionAuthority(token: string | undefined) {
  const expected = token?.length === 64 && /^[a-f0-9]{64}$/.test(token) ? Buffer.from(token, "hex") : null;
  return (headers: IncomingHttpHeaders): boolean => {
    const supplied = headers["x-murage-companion-token"];
    if (!expected || typeof supplied !== "string" || supplied.length !== 64 || !/^[a-f0-9]{64}$/.test(supplied)) return false;
    return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
  };
}

// Consume before any later generic CLI/MCP spawn can copy process.env. This
// closure survives config reloads; only a new trusted parent launch rotates it.
export const companionAuthorized = createCompanionAuthority(process.env.MURAGE_COMPANION_TOKEN);
delete process.env.MURAGE_COMPANION_TOKEN;
