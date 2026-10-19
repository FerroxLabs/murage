// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud Door v2: the three murage:// links of "Connect to your Cloud home".
//
//   murage://open-cloud?h=<homeId>                      My Cloud's "Open in the app": that home's Cloud window, or Connect.
//   murage://connect-cloud                              the My Cloud card: start (or focus) a Connect.
//   murage://door?h=<homeId>&o=<publicOrigin>#t=<ticket>   the site hands the app a ticket made for its key.
//
// Pure functions, no Electron. Nothing here logs: a door link carries a ticket, so callers log a reason only.

const HOME_ID = /^[\w-]{1,128}$/;
/** The only origin a door link may name: a Cloud home's own host. Staging and production homes both live here. */
export const HOME_ORIGIN = /^https:\/\/h-[0-9a-f]{32}\.murage\.ai$/;
/** The home id an open-cloud link names. Anything else means "run Connect". */
export const OPEN_CLOUD_HOME_ID = /^home-[0-9a-f]{24}$/;
const KINDS = new Set(["door", "connect-cloud", "open-cloud"]);
const TICKET = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const MAX_TICKET_LENGTH = 8300;
/** The longest pasted text or deep link anything here will look at. */
export const MAX_LINK_LENGTH = 8600;

/** "door" | "connect-cloud" | "open-cloud" for a murage:// link of that kind, else null. Does not look at the query or the fragment. */
export function doorLinkKind(raw) {
  if (typeof raw !== "string" || raw.length > MAX_LINK_LENGTH) return null;
  let link;
  try { link = new URL(raw.trim()); } catch { return null; }
  if (link.protocol !== "murage:") return null;
  return KINDS.has(link.hostname) ? link.hostname : null;
}

/** {kind, url} for a door, connect-cloud or open-cloud deep link, else null. */
export function doorLinkFromDeepLink(raw) {
  const kind = doorLinkKind(raw);
  return kind ? { kind, url: String(raw).trim() } : null;
}

/** Only the FIRST murage:// argument is looked at: a later one never rescues an earlier one that is not a door link. */
export function doorLinkFromCommandLine(argv) {
  if (!Array.isArray(argv)) return null;
  const first = argv.find((value) => typeof value === "string" && /^murage:\/\//i.test(value));
  return first === undefined ? null : doorLinkFromDeepLink(first);
}

/** {homeId, origin, ticket} from a murage://door link, or null for anything else or anything malformed. */
export function parseDoorLink(raw) {
  if (doorLinkKind(raw) !== "door") return null;
  let link;
  try { link = new URL(String(raw).trim()); } catch { return null; }
  const homeId = link.searchParams.get("h"), origin = link.searchParams.get("o");
  if (!homeId || !HOME_ID.test(homeId) || !origin || !HOME_ORIGIN.test(origin)) return null;
  try { if (new URL(origin).origin !== origin) return null; } catch { return null; }
  if (!link.hash.startsWith("#t=")) return null;
  const ticket = link.hash.slice(3);
  if (ticket.length > MAX_TICKET_LENGTH || !TICKET.test(ticket)) return null;
  return { homeId, origin, ticket };
}

/** {homeId} from a murage://open-cloud link; homeId is null when h is missing or not a home id (the caller runs Connect). */
export function parseOpenCloudLink(raw) {
  if (doorLinkKind(raw) !== "open-cloud") return null;
  let link;
  try { link = new URL(String(raw).trim()); } catch { return null; }
  const homeId = link.searchParams.get("h");
  return { homeId: homeId && OPEN_CLOUD_HOME_ID.test(homeId) ? homeId : null };
}

/** The account named in a ticket's payload (base64url JSON before the first "."). The home has already verified the signature. */
export function ticketClaims(ticket) {
  try {
    const claims = JSON.parse(Buffer.from(String(ticket).split(".")[0], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}
