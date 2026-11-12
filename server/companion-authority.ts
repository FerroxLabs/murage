import { isDesktopApp } from "./cloud-owner-surface.ts";
import { cloudIdentity, isOwnerBrowser } from "./cloud-request-identity.ts";
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
const desktopCompanionAuthorized = createCompanionAuthority(launchToken);
/** True when this process was launched with a well-formed launch proof (the value itself never leaves this module). */
export const launchProofPresent: boolean = launchToken?.length === 64 && /^[a-f0-9]{64}$/.test(launchToken);
export const companionAuthorized = (headers: IncomingHttpHeaders): boolean => process.env.MURAGE_CLOUD_ROLE === "home"
  ? ["owner-desktop","owner-phone"].includes(cloudIdentity(headers)?.scope ?? "") || isOwnerBrowser(cloudIdentity(headers))
  : desktopCompanionAuthorized(headers);
/** The ACTING gate for mayApprove and requestOrigin: the owner at the keyboard or on the paired phone, never a browser
 * cookie. On a home that is the owner-desktop or owner-phone scope ONLY; the passkey browser acts through requestSurface
 * "desktop", and a remembered-owner browser never acts (H1). Off a home it is the desktop's own launch proof. */
export const ownerActs = (headers: IncomingHttpHeaders): boolean => process.env.MURAGE_CLOUD_ROLE === "home"
  ? ["owner-desktop","owner-phone"].includes(cloudIdentity(headers)?.scope ?? "")
  : desktopCompanionAuthorized(headers);
/** The second layer behind the route policy on POST /api/terms/accept. Whoever acts (mayApprove's own test: the desktop
 * surface, or ownerActs) may accept. On a Cloud home ONLY, an owner browser also may, remembered-owner included: a
 * customer with no desktop or phone has no other surface, and the owner already accepted the terms at checkout. This
 * carve-out is for the terms record alone; accepting grants no authority over bots, tools or money, so it does not widen
 * ownerActs or mayApprove and H1 stays whole for every approval. It still refuses a chat-only browser (no factor), a
 * revoked one, and a bot's shell with no identity. Off a home it adds nothing. */
export const mayAcceptTerms = (headers: IncomingHttpHeaders, surfaceActs: boolean): boolean =>
  surfaceActs || ownerActs(headers) || (process.env.MURAGE_CLOUD_ROLE === "home" && companionAuthorized(headers));
/** The same launch secret in a second header: the companion stamps it on every
 * request it forwards (phone and browser door), so the harness can tell a
 * forwarded request from a bare loopback one (audit C5). It claims no owner
 * authority: `companionAuthorized` stays the only owner proof. */
export const DOOR_FORWARD_HEADER = "x-murage-door-token";
export const doorAuthorized = createCompanionAuthority(launchToken, DOOR_FORWARD_HEADER);

/** The identical preview audience for answers, hello, live frames and replay: the desktop app, the owner acting, and on a Cloud home the owner browser (passkey or remembered-owner, Sean 10-30: a full owner). A chat-only or unremembered browser is refused. */
export const chatsReader = (headers: IncomingHttpHeaders, query?: URLSearchParams | null): boolean => isDesktopApp(headers, query) || ownerActs(headers) || (process.env.MURAGE_CLOUD_ROLE === "home" && isOwnerBrowser(cloudIdentity(headers)));
