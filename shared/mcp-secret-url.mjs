// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one rule for "does this link hold a secret" (spec MCP-LINK 3.4 and review
// finding F2). The registry, the URL policy module and the paste parser all
// import it, so a token shape that is caught in one place is caught in all three.
//
// A link holds a secret when it has userinfo, a query string, or a path
// segment that looks like a token. Tokens show up as Zapier-style keys,
// base64 with padding, JWTs (dots) and short mixed-case keys, so the test is
// shape-based, not a single character-class run.

export const MASK = "•••";

const TOKEN_CHARS = /^[A-Za-z0-9._~=+%-]+$/;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/;

/**
 * True for a path segment that reads as a token rather than a word:
 *  - 24 or more characters of anything;
 *  - a JWT (eyJ..., with a dot);
 *  - 16 or more characters from the token set that mix letters and digits, or
 *    upper and lower case.
 * @param {string} segment
 */
export function isOpaqueSegment(segment) {
  // A stored mask is not a token. URL parsing percent-encodes it, so compare decoded.
  if (segment === MASK || segment === encodeURIComponent(MASK)) return false;
  if (segment.length >= 24) return true;
  if (JWT_SHAPE.test(segment)) return true;
  if (segment.length < 16 || !TOKEN_CHARS.test(segment)) return false;
  // A run of 16 or more digits is an id or a key, not a word (MCP-LINK L3).
  if (/^[0-9]+$/.test(segment)) return true;
  const lower = /[a-z]/.test(segment);
  const upper = /[A-Z]/.test(segment);
  const digit = /[0-9]/.test(segment);
  return (digit && (lower || upper)) || (lower && upper);
}

/** A pathname with every opaque segment replaced by the mask. @param {string} pathname */
export function maskPathname(pathname) {
  return pathname.split("/").map((segment) => (isOpaqueSegment(segment) ? MASK : segment)).join("/");
}

/** @param {string} pathname */
export function pathHasOpaqueSegment(pathname) {
  return pathname.split("/").some(isOpaqueSegment);
}

/**
 * Whether an http(s) link holds anything secret. False for a string that is not
 * a link.
 * @param {string} value
 */
export function urlHasSecret(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return Boolean(url.username || url.password || url.search || pathHasOpaqueSegment(url.pathname));
}

/**
 * What a listing or a log line may show: scheme, host and masked path. Never
 * userinfo, query or fragment. "" when it is not an http(s) link.
 * @param {string} value
 */
export function displayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return `${url.protocol}//${url.host}${maskPathname(url.pathname)}`;
}

/**
 * Split a pasted link into what config.json keeps and what the secret store
 * keeps. `urlSecret` is true whenever the full link holds anything secret.
 *
 * Packaged (the default): `storedUrl` has userinfo, query and fragment removed
 * and every opaque path segment masked, so it is not dialable; connections read
 * `fullUrl` from the secret store. `keepFullInConfig` is the dev/headless
 * fallback, where `storedUrl` is the full link, as spec 3.4 allows.
 * @param {string} value
 * @param {{ keepFullInConfig?: boolean }} [options]
 * @returns {{ storedUrl: string, fullUrl: string, urlSecret: boolean } | null}
 */
export function splitSecretUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  const urlSecret = urlHasSecret(parsed.href);
  const storedUrl = options.keepFullInConfig && urlSecret
    ? parsed.href
    : `${parsed.protocol}//${parsed.host}${maskPathname(parsed.pathname)}`;
  return { storedUrl, fullUrl: parsed.href, urlSecret };
}
