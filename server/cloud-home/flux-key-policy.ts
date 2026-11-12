// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: one home-key-only rule for EVERY credential slot, not just fluxApiKey.
//
// A Cloud home holds only the key Flux issued for it (sk-flux-home-...). Any slot
// whose base URL points at Flux must hold that key, and that key must never
// leave for a non-Flux address. A URL that merely looks like Flux (userinfo,
// odd port, plain http, a lookalike host, unparseable text naming fluxrouter)
// is refused outright.
import { cloudHomeCopy } from "./copy.ts";
import { isHomeFluxKey } from "./flux-home-gate.ts";
import { bankHoldsHomeKeyOutsideFlux, containsPrimaryFluxKey } from "../../shared/flux-credential-scan.mjs";

export type FluxTarget = "flux" | "other" | "suspicious";

function isFluxHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, "");
  return name === "fluxrouter.ai" || name.endsWith(".fluxrouter.ai");
}

export function fluxTarget(url: unknown): FluxTarget {
  if (typeof url !== "string" || !url.trim()) return "other";
  let parsed: URL;
  try { parsed = new URL(url.trim()); }
  catch { return /fluxrouter/i.test(url) ? "suspicious" : "other"; }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (isFluxHostname(host)) {
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port ? "flux" : "suspicious";
  }
  if (host.includes("fluxrouter") || /fluxrouter/i.test(decodeURIComponentSafe(parsed.username + parsed.password))) return "suspicious";
  return "other";
}

function decodeURIComponentSafe(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** Plain-words refusal for a key paired with a base URL, or null when the pair is allowed. */
export function fluxKeyPolicyError(key: unknown, url: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return null;
  // Hole 7: the owner's primary key is refused for EVERY transport, whatever address it is paired with.
  if (containsPrimaryFluxKey(key)) return cloudHomeCopy.fluxKeyMustBeHomeKey;
  const target = fluxTarget(url);
  if (target === "suspicious") return cloudHomeCopy.fluxKeyMustBeHomeKey;
  if (target === "flux") return isHomeFluxKey(key.trim()) ? null : cloudHomeCopy.fluxKeyMustBeHomeKey;
  return isHomeFluxKey(key.trim()) ? cloudHomeCopy.fluxHomeKeyOnlyForFlux : null;
}

/** Prefix of every key Flux mints. Used where no URL travels with the key. */
const FLUX_KEY_FAMILY = /^sk-flux-/;

/** A key in a slot other than fluxApiKey: a Flux key that is not a home key is never accepted. */
export function isPrimaryFluxKeyShape(value: string): boolean {
  const key = value.trim();
  return FLUX_KEY_FAMILY.test(key) && !isHomeFluxKey(key);
}

const URL_FIELD = /(url|endpoint)$/i;

/** First policy violation among a config section's key fields and its URL fields, or null. */
export function fluxSectionViolation(section: unknown, keyField: string): string | null {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const record = section as Record<string, unknown>;
  const key = record[keyField];
  if (typeof key !== "string" || !key.trim()) return null;
  let sawUrl = false;
  for (const [name, value] of Object.entries(record)) {
    if (name === keyField || typeof value !== "string" || !URL_FIELD.test(name) || !value.trim()) continue;
    sawUrl = true;
    const error = fluxKeyPolicyError(key, value);
    if (error) return error;
  }
  // No URL given: a primary-shaped Flux key still must not ride in a custom slot.
  if (!sawUrl && isPrimaryFluxKeyShape(key)) return cloudHomeCopy.fluxKeyMustBeHomeKey;
  return null;
}

/**
 * Hole 7: one recursive check for a serialized credential (the provider bank is a JSON string; any value may be
 * JSON, URL-encoded or escaped text). Null when clean. Used on ingestion, section validation, restore and route resolution.
 */
export function serializedFluxViolation(value: unknown): string | null {
  if (containsPrimaryFluxKey(value)) return cloudHomeCopy.fluxKeyMustBeHomeKey;
  if (bankHoldsHomeKeyOutsideFlux(value)) return cloudHomeCopy.fluxHomeKeyOnlyForFlux;
  return null;
}
