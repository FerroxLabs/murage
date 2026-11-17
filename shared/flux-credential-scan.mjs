// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 (holes 6/7): find a PRIMARY Flux key (sk-flux-..., not the home key sk-flux-home-...) anywhere inside a
// credential, however it is serialized: a JSON string inside a JSON string (the provider bank), URL-encoded
// text, JSON \u escapes, object keys. One implementation shared by the desktop shell and the server.

const FLUX_TOKEN = /sk-flux-[A-Za-z0-9_-]*/gi;
const HOME_PREFIX = "sk-flux-home-";
const MAX_DEPTH = 8;

function tokens(text) {
  const found = [];
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* raw text only */ }
  for (const source of decoded === text ? [text] : [text, decoded]) for (const match of source.matchAll(FLUX_TOKEN)) found.push(match[0]);
  return found;
}

/** True when `value` (string, array or object, any depth, JSON text at any depth) holds a Flux key that is not a home key. */
export function containsPrimaryFluxKey(value, depth = 0) {
  if (typeof value === "string") {
    if (tokens(value).some(token => !token.startsWith(HOME_PREFIX))) return true;
    const trimmed = value.trim();
    if (depth < MAX_DEPTH && trimmed && "[{\"".includes(trimmed[0])) {
      try { return containsPrimaryFluxKey(JSON.parse(trimmed), depth + 1); } catch { return false; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => containsPrimaryFluxKey(item, depth + 1));
  if (value && typeof value === "object") return Object.entries(value).some(([name, item]) => containsPrimaryFluxKey(name, depth + 1) || containsPrimaryFluxKey(item, depth + 1));
  return false;
}

/** True when a home key (sk-flux-home-...) sits anywhere in `value`. */
export function containsHomeFluxKey(value, depth = 0) {
  if (typeof value === "string") {
    if (tokens(value).some(token => token.startsWith(HOME_PREFIX))) return true;
    const trimmed = value.trim();
    if (depth < MAX_DEPTH && trimmed && "[{\"".includes(trimmed[0])) {
      try { return containsHomeFluxKey(JSON.parse(trimmed), depth + 1); } catch { return false; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => containsHomeFluxKey(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value).some(item => containsHomeFluxKey(item, depth + 1));
  return false;
}

/** A provider-bank row (any shape) that holds a home key but is not the Flux preset: the home key must never leave for another provider. */
export function bankHoldsHomeKeyOutsideFlux(raw) {
  let bank = raw;
  if (typeof raw === "string") { try { bank = JSON.parse(raw); } catch { return false; } }
  if (!Array.isArray(bank)) return false;
  return bank.some(row => row && typeof row === "object" && row.preset !== "flux" && containsHomeFluxKey(row.key));
}
