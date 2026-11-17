// SPDX-License-Identifier: AGPL-3.0-or-later
// agy's Google sign-in link, checked exactly (AGY-ON-CLOUD design section 5). Pure, no imports: the server, the renderer and the electron main
// all read this one copy. A link is shown or opened only when it is https, on accounts.google.com with no port or userinfo, at agy's own
// authorization path, for agy's own client and redirect, with PKCE (S256, a 43 to 128 character unreserved challenge), response_type=code, and
// none of client_id, redirect_uri, code_challenge, response_type or state given twice.
/** agy 1.4.4's own OAuth client and redirect (read from the binary). Anything else is not shown to the owner. */
export const AGY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const AGY_OAUTH_REDIRECT = "https://antigravity.google/oauth-callback";
const SINGLE = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "response_type", "state"];
/** The link as a normalized string, or null when it is not exactly Google's sign-in page for agy. */
export function checkedGoogleLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.port !== "" || url.username || url.password) return null;
  if (url.pathname !== "/o/oauth2/auth" && url.pathname !== "/o/oauth2/v2/auth") return null;
  for (const key of SINGLE) if (url.searchParams.getAll(key).length > 1) return null;
  if (url.searchParams.get("client_id") !== AGY_OAUTH_CLIENT_ID || url.searchParams.get("redirect_uri") !== AGY_OAUTH_REDIRECT) return null;
  if (url.searchParams.get("response_type") !== "code") return null;
  // PKCE is required: a code intercepted at the edge is useless without the verifier that stays on the home.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(url.searchParams.get("code_challenge") ?? "") || url.searchParams.get("code_challenge_method") !== "S256") return null;
  return url.toString();
}
/** The first OSC 8 hyperlink target in terminal output (ESC ] 8 ; params ; URI, ended by BEL or ESC \). */
export function osc8Link(output) {
  const match = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(String(output));
  return match ? match[1] : null;
}
/** The first OSC 8 target in the output that passes checkedGoogleLink, or null. */
export function checkedOsc8Link(output) {
  const pattern = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  for (const match of String(output).matchAll(pattern)) { const link = checkedGoogleLink(match[1]); if (link) return link; }
  return null;
}
