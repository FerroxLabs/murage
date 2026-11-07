// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The phone-call key (BOT-CALLS-1020 section 3a). Its own entry kind, not an MCP entry. Held in memory only, in the harness,
// bound to the single origin https://api.vapi.ai. In the packaged app it arrives from the desktop shell once at boot in
// MURAGE_PHONE_CALL_SECRETS (read and deleted here; listed in WORKSPACE_CREDENTIAL_ENV so no child inherits it) and as pushes
// from main when the owner saves it in the key box. There is NO config.json fallback: dev and headless runs never hold it, so
// they register no phone tools. The key is only ever added to a request by phoneVendorFetch at send time.

export const PHONE_SECRETS_ENV = "MURAGE_PHONE_CALL_SECRETS";
export const PHONE_KEY_ORIGIN = "https://api.vapi.ai";

interface Held { key: string; origin: string }
let held: Held | null = null;
let desktopShell = false;

function sanitizeKey(raw: unknown): Held | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { key, origin } = raw as Record<string, unknown>;
  if (typeof key !== "string" || !key || key.length > 512 || /\s/.test(key)) return null;
  // Bound to one origin; a doc for any other origin is dropped, not re-bound.
  if (origin !== PHONE_KEY_ORIGIN) return null;
  return { key, origin };
}

/** Boot: the desktop shell sets the env var (possibly to "{}" when no key is saved yet). Its presence marks a desktop run. */
export function loadPhoneSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): { desktop: boolean; loaded: boolean } {
  const raw = env[PHONE_SECRETS_ENV];
  delete env[PHONE_SECRETS_ENV];
  if (raw === undefined) return { desktop: desktopShell, loaded: held !== null };
  desktopShell = true;
  try { held = sanitizeKey(JSON.parse(raw)); } catch { held = null; }
  return { desktop: true, loaded: held !== null };
}

/** A push from main after the owner saves or removes the key in the desktop key box. */
export function setPhoneKeyFromShell(doc: unknown): boolean {
  desktopShell = true;
  held = sanitizeKey(doc);
  return held !== null;
}

export function clearPhoneKey(): void { held = null; }

/** The push main sends on the private utility port after the owner saves or removes the key (electron/phone-secrets.mjs). */
export const PHONE_KEY_MESSAGE = "murage:phone-key";
export function isPhoneShellMessage(message: unknown): message is { type: typeof PHONE_KEY_MESSAGE; doc?: unknown } {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === PHONE_KEY_MESSAGE;
}
/** Apply a shell push. A null or malformed doc clears the key. Never logs the value. */
export function applyPhoneShellMessage(message: { doc?: unknown }): boolean { return setPhoneKeyFromShell(message.doc ?? null); }

/** Only the desktop shell isolates this secret, so only a desktop run offers phone calls (section 1, 3a). */
export function phoneCallsSupported(): boolean { return desktopShell; }
export function phoneKeyPresent(): boolean { return desktopShell && held !== null; }

/** Internal to phoneVendorFetch. Never exported through any tool, route, log or config. */
export function _heldPhoneKeyForSend(origin: string): string | null {
  if (!desktopShell || !held || origin !== held.origin) return null;
  return held.key;
}

/** Test seam: reset module state. */
export function _resetPhoneSecretsForTest(): void { held = null; desktopShell = false; }
