// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FLUX-LINKS-SIGNIN: Flux pages that need a session (keys, billing) are opened through Flux's own sign-in page, which sends the
// owner on to the page once signed in. A Flux account made by Murage Cloud has no password, so a straight link to the page landed a
// signed-out owner on the password form. Same shape as Flux's own MCP sign-in redirect (src/mcp/oauth/routes.py: return_to, the
// path percent-encoded whole).
export const FLUX_WEB_ORIGIN = "https://fluxrouter.ai";

/** Flux's sign-in page, returning to `path` (a same-origin path starting with "/"). */
export function fluxSignInUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("fluxSignInUrl takes a Flux path");
  return `${FLUX_WEB_ORIGIN}/auth/sign-in?return_to=${encodeURIComponent(path)}`;
}

export const FLUX_KEYS_PAGE = fluxSignInUrl("/home/api-keys");
export const FLUX_BILLING_PAGE = fluxSignInUrl("/home/billing");
export const FLUX_DASHBOARD_BILLING_PAGE = fluxSignInUrl("/dashboard/billing");
