// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phone-call key custody in the desktop shell (BOT-CALLS-1020 section 3a). The owner's Vapi private key lives in the OS-encrypted
// credential document (credentials.bin via safeStorage) under `phoneCallSecrets`, bound to the single origin https://api.vapi.ai.
// Its own entry kind: never an MCP entry, never in config.json, never in an engine config or a child environment.
//
//   boot        workspaceCredentialEnv always sets MURAGE_PHONE_CALL_SECRETS for the server only ("{}" when no key is saved): its
//               presence is how the server knows it runs under the desktop shell (dev and headless runs never get it, so they
//               register no phone tools). The server reads and deletes it; the name is in WORKSPACE_CREDENTIAL_ENV.
//   owner act   the key box in Settings sends the key to main over `phone-key:save`; main stores it and pushes
//               `murage:phone-key {doc}` to the server on the private utility port. `phone-key:remove` stores nothing and pushes
//               an empty doc. The renderer never reads the key back.
// Pure functions: main.mjs owns the fs and safeStorage plumbing. Nothing here logs a value.

export const PHONE_SECRETS_KEY = "phoneCallSecrets";
export const PHONE_KEY_ORIGIN = "https://api.vapi.ai";
export const PHONE_KEY_MESSAGE = "murage:phone-key";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The stored shape { key, origin }, or null. A key is 1..512 chars with no whitespace; the origin is always Vapi's. */
export function sanitizePhoneKey(raw) {
  let source = raw;
  if (typeof source === "string") source = { key: source.trim(), origin: PHONE_KEY_ORIGIN };
  if (!isRecord(source)) return null;
  const { key, origin } = source;
  if (typeof key !== "string" || !key || key.length > 512 || /\s/.test(key)) return null;
  if (origin !== PHONE_KEY_ORIGIN) return null;
  return { key, origin };
}

/** The credential document with the phone key set (or removed when `key` is null). Other credentials stay. */
export function withPhoneKey(credentials, key) {
  const next = { ...(credentials ?? {}) };
  if (key === null) { delete next[PHONE_SECRETS_KEY]; return next; }
  const clean = sanitizePhoneKey(key);
  if (!clean) throw new Error("not a phone key");
  next[PHONE_SECRETS_KEY] = clean;
  return next;
}

/** MURAGE_PHONE_CALL_SECRETS for the spawned server. Always a string under the desktop shell: "{}" marks a desktop run with no key. */
export function phoneSecretsEnv(credentials) {
  const clean = sanitizePhoneKey(credentials?.[PHONE_SECRETS_KEY]);
  return JSON.stringify(clean ?? {});
}

/** The push main sends the server after a save or a removal. */
export function phoneKeyMessage(credentials) {
  return { type: PHONE_KEY_MESSAGE, doc: sanitizePhoneKey(credentials?.[PHONE_SECRETS_KEY]) };
}
