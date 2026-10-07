import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { takeLaunchSecret } from "./launch-secret.ts";

// Taken once, from the private pipe the launcher named (stdin or the utility
// parent port): an environment copy stays readable at /proc/<pid>/environ on
// Linux and a file can be raced (audit P1, S1b R8). Nothing is left behind for
// a later CLI/MCP spawn to copy.
const launchToken = await takeLaunchSecret("MURAGE_COMPANION_TOKEN");

/** A private launch proof, not the client-controlled companion marker. */
export function createCompanionAuthority(token: string | undefined, header = "x-murage-companion-token") {
  const expected = token?.length === 64 && /^[a-f0-9]{64}$/.test(token) ? Buffer.from(token, "hex") : null;
  return (headers: IncomingHttpHeaders): boolean => {
    const supplied = headers[header];
    if (!expected || typeof supplied !== "string" || supplied.length !== 64 || !/^[a-f0-9]{64}$/.test(supplied)) return false;
    return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
  };
}

// Consume before any later generic CLI/MCP spawn can copy process.env. This
// closure survives config reloads; only a new trusted parent launch rotates it.
export const companionAuthorized = createCompanionAuthority(launchToken);
/** The same launch secret in a second header: the companion stamps it on every
 * request it forwards (phone and browser door), so the harness can tell a
 * forwarded request from a bare loopback one (audit C5). It claims no owner
 * authority: `companionAuthorized` stays the only owner proof. */
export const DOOR_FORWARD_HEADER = "x-murage-door-token";
export const doorAuthorized = createCompanionAuthority(launchToken, DOOR_FORWARD_HEADER);
