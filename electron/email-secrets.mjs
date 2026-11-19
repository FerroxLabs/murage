// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email custody in the desktop shell (BOT-EMAIL-MURAGE-109 2.3, 2.4). The email keys (one email:bot key per bot) and the email:owner
// desktop token live in the OS-encrypted credential document (credentials.bin via safeStorage) under `emailSecrets`, the same way the
// link-server secrets do. Pure functions: main.mjs owns the fs and safeStorage plumbing.
//
//   boot          workspaceCredentialEnv puts the document in MURAGE_EMAIL_SECRETS for the server only (the server reads and deletes it,
//                 and the name is in WORKSPACE_CREDENTIAL_ENV, so no engine or tool child inherits it);
//   server push   `murage:email-secrets-save {doc}` on the private utility port whenever the server mints, rotates or revokes a key:
//                 main replaces its copy with the sanitized doc;
//   owner act     "turn email on" runs the PKCE desktop sign-in, whose token request asks scope email:owner; main stores the token and
//                 hands it to the server
//                 as `murage:email-owner {owner}` (the server's own save then echoes the whole doc back).
// Nothing here logs a value. The renderer never receives a token.

export const EMAIL_SECRETS_KEY = "emailSecrets";
export const EMAIL_SECRETS_SAVE = "murage:email-secrets-save";
export const EMAIL_OWNER_MESSAGE = "murage:email-owner";
export const EMAIL_OWNER_SCOPE = "email:owner";
// EMAIL-ACCOUNT-CHANGE r3: main -> server once the doc of a save is in credentials.bin ({rev, epoch} echoed from the save), so the server uses
// a new email key only once it survives a crash.
export const EMAIL_SECRETS_SAVED = "murage:email-secrets-saved";

const KEY_ID = /^[\w.:-]{1,200}$/;
const BOT_ID = /^[\w-]{1,160}$/;
const INBOX_ID = /^[\w.:-]{1,200}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** One credential, or null: a non-empty token without whitespace (at most 4096 chars) and a plain key id. */
export function emailCredential(raw) {
  if (!isRecord(raw)) return null;
  const { token, keyId } = raw;
  if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token)) return null;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
  return { token, keyId };
}

/** The stored shape: { owner?, bots: { [botId]: {token, keyId} }, retired?: { [inboxId]: {token, keyId, botId} } }. Anything else is dropped.
 *  `retired` (EMAIL-ACCOUNT-CHANGE r3) holds an old Flux account's bot key while sends on its inbox are still open. */
export function sanitizeEmailSecretsDoc(raw) {
  let source = raw;
  if (typeof source === "string") { try { source = JSON.parse(source); } catch { source = null; } }
  const out = { bots: {} };
  if (!isRecord(source)) return out;
  const owner = emailCredential(source.owner);
  if (owner) out.owner = owner;
  if (isRecord(source.bots)) {
    for (const [botId, value] of Object.entries(source.bots)) {
      if (botId === "__proto__" || !BOT_ID.test(botId)) continue;
      const cred = emailCredential(value);
      if (cred) out.bots[botId] = cred;
    }
  }
  for (const field of ["retired", "legacyRetired"]) {
    if (Array.isArray(source[field])) {
      const kept = source[field].map(emailCredential).filter(Boolean);
      if (kept.length) out[field] = kept;
    }
  }
  if (isRecord(source.retired)) {
    for (const [inboxId, value] of Object.entries(source.retired)) {
      if (inboxId === "__proto__" || !INBOX_ID.test(inboxId) || !isRecord(value) || typeof value.botId !== "string" || !BOT_ID.test(value.botId)) continue;
      const cred = emailCredential(value);
      if (cred) (out.retired ??= {})[inboxId] = { ...cred, botId: value.botId };
    }
  }
  // r4 section 2: the rotation handover slot, { [botId]: {token, keyId} }
  if (isRecord(source.prev)) {
    for (const [botId, value] of Object.entries(source.prev)) {
      if (botId === "__proto__" || !BOT_ID.test(botId)) continue;
      const cred = emailCredential(value);
      if (cred) (out.prev ??= {})[botId] = cred;
    }
  }
  return out;
}

const empty = (doc) => !doc.owner && Object.keys(doc.bots).length === 0 && Object.keys(doc.retired ?? {}).length === 0 && (doc.legacyRetired ?? []).length === 0 && Object.keys(doc.prev ?? {}).length === 0;

/** The credential document with the server's latest email doc in place (an empty doc removes the field). */
export function withEmailSecrets(credentials, doc) {
  const next = { ...(credentials ?? {}) };
  const clean = sanitizeEmailSecretsDoc(doc);
  if (empty(clean)) delete next[EMAIL_SECRETS_KEY];
  else next[EMAIL_SECRETS_KEY] = clean;
  return next;
}

/** The credential document with a new email:owner token (the bot keys are kept). */
export function withEmailOwner(credentials, owner) {
  const cred = emailCredential(owner);
  if (!cred) throw new Error("not an email owner credential");
  const current = sanitizeEmailSecretsDoc(credentials?.[EMAIL_SECRETS_KEY]);
  return withEmailSecrets(credentials, { ...current, owner: cred });
}

/** MURAGE_EMAIL_SECRETS for the spawned server, or undefined when nothing is stored. */
export function emailSecretsEnv(credentials) {
  const doc = sanitizeEmailSecretsDoc(credentials?.[EMAIL_SECRETS_KEY]);
  return empty(doc) ? undefined : JSON.stringify(doc);
}

export function isEmailSecretsSave(message) { return isRecord(message) && message.type === EMAIL_SECRETS_SAVE; }

/** Every key id the stored credential document holds under emailSecrets (bot, prev and retired slots, and the owner): what a read-back proves. */
export function emailKeyIdsOf(credentials) {
  const doc = sanitizeEmailSecretsDoc(credentials?.[EMAIL_SECRETS_KEY]);
  return [
    ...Object.values(doc.bots).map((cred) => cred.keyId),
    ...Object.values(doc.prev ?? {}).map((cred) => cred.keyId),
    ...(doc.legacyRetired ?? []).map((cred) => cred.keyId), ...Object.values(doc.retired ?? {}).map((cred) => cred.keyId),
    ...(doc.owner ? [doc.owner.keyId] : []),
  ];
}

/** The ack for a save (EMAIL-ACCOUNT-CHANGE r3, r4 section 1): {rev, epoch} echoed from the save plus the key ids READ BACK from disk
 *  (`keyIds`); null for a save that carried none (an older server) or when no read-back list is given. */
export function emailSecretsSavedMessage(message, keyIds) {
  if (!isRecord(message) || !Number.isInteger(message.rev) || typeof message.epoch !== "string" || message.epoch.length > 80) return null;
  if (!Array.isArray(keyIds) || keyIds.some((id) => typeof id !== "string" || !KEY_ID.test(id))) return null;
  return { type: EMAIL_SECRETS_SAVED, rev: message.rev, epoch: message.epoch, keyIds: [...new Set(keyIds)] };
}

/** r4 section 1: reads credentials.bin back, decrypts it, and builds the ack from the key ids it holds. Rejects (no ack) when the file cannot
 *  be read, decrypted or parsed. `readFile` and `decrypt` are main.mjs's. */
export async function ackFromDisk({ readFile, decrypt }, message) {
  const decrypted = await decrypt(readFile());
  const text = typeof decrypted === "string" ? decrypted : decrypted?.result;
  const parsed = JSON.parse(text);
  const ack = emailSecretsSavedMessage(message, emailKeyIdsOf(parsed));
  if (!ack) throw new Error("no ack for this save");
  return ack;
}

/**
 * The email:owner credential from the PKCE token response (contract r2.5: POST /api/desktop/token with `scope: "email:owner"` answers
 * { api_key, key_id, scopes }). `scopes` without email:owner (Flux answers [] while its bot key switch is off) means bot email stays dark
 * for the owner: null here, and flux-desktop-signin's readEmailOwnerToken ends the sign-in with the calm `email_dark` line (never a
 * failure). A missing or malformed token or key id is null too (bad_key).
 */
/** True when the token response's `scopes` carries email:owner (r2.5). */
export function emailOwnerScopeGranted(body) {
  return isRecord(body) && Array.isArray(body.scopes) && body.scopes.includes(EMAIL_OWNER_SCOPE);
}

export function emailOwnerFromTokenResponse(body) {
  if (!isRecord(body)) return null;
  const token = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!token || token.length > 4096 || /\s/.test(token)) return null;
  if (!emailOwnerScopeGranted(body)) return null;
  if (typeof body.key_id !== "string" || !KEY_ID.test(body.key_id)) return null;
  return emailCredential({ token, keyId: body.key_id });
}
