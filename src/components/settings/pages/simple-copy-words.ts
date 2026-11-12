// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SIMPLE-COPY R2: the one word counter for every cap on the Simple pages (the Playwright spec, simple-copy.test.ts and the
// Backups guard). A word is a whitespace-separated token with at least one letter or digit, so "Also counts as 1,
// couldn't as 1, Wi-Fi as 1, and a lone dot or ellipsis as 0.
export const countWords = (text: string) => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** The quoted Tailscale button names the Phone bans allow (S2). */
export const PHONE_ALLOWED_QUOTED = [/"MagicDNS"/g, /"Enable HTTPS"/g];

/** S2 banned words per page, case-insensitive unless noted. */
export const BANS_ALL = [/—/, /\bsafe(ly)?\b/i];
export const BANS_PHONE = [/\btailnet/i, /\bhttps?\b/i, /certificate/i, /\bport\b/i, /browser door/i, /\bdoor\b/i, /loopback/i, /funnel/i, /tailscale serve/i, /sidecar/i, /\burl\b/i, /\bdns\b/i, /\blan\b/i];
export const BANS_MESSAGING = [/credential/i, /socket mode/i, /oauth/i, /\bguild/i, /\bscopes?\b/i, /\bapi\b/i, /ingress/i, /\bchannels\b/i, /Murage Desktop/];
export const BANS_BACKUPS = [/repository/i, /snapshot/i, /chmod/i, /\.age\b/i, /\bs3\b/i, /\bsftp\b/i, /catalogue/i, /archive/i, /credential/i];

export type SimplePage = "phone" | "messaging" | "backups";
const PAGE_BANS: Record<SimplePage, RegExp[]> = { phone: BANS_PHONE, messaging: BANS_MESSAGING, backups: BANS_BACKUPS };

/** The banned patterns a text trips for its page (after the Phone allowlist strip), as their sources. Empty means clean. */
export function bannedIn(text: string, page: SimplePage): string[] {
  const clean = page === "phone" ? PHONE_ALLOWED_QUOTED.reduce((value, quoted) => value.replace(quoted, ""), text) : text;
  return [...BANS_ALL, ...PAGE_BANS[page]].filter((ban) => ban.test(clean)).map((ban) => ban.source);
}
