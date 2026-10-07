// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Answers the server's WhatsApp auth key request over the private utility parent port (design 3.3).
//
// The key is 32 random bytes as 64 hex characters, kept as `whatsappAuthKey` in the OS-encrypted credential
// document. It is minted on the first request, never regenerated, and never leaves this process except in the
// reply on the private port: not in the environment, not in an argument, not in a log line.
//
//   credential store unavailable this launch  ->  key: null (the server shows "blocked: credential-store")
//   stored value present but malformed        ->  key: null (never replaced: the saved session may depend on it)
//   stored value absent                       ->  mint, persist through the serialized credential update, reply
//
// Pure of Electron: main.mjs passes its credential functions in, so this is testable under node --test.
import { randomBytes } from "node:crypto";

export const WHATSAPP_AUTH_KEY_REQUEST = "murage:whatsapp-auth-key-request";
export const WHATSAPP_AUTH_KEY_REPLY = "murage:whatsapp-auth-key";
export const WHATSAPP_AUTH_KEY_FIELD = "whatsappAuthKey";

const HEX_KEY = /^[0-9a-f]{64}$/;
const exists = (value) => value !== undefined && value !== null && value !== "";

export function isWhatsAppAuthKeyRequest(message) {
  return Boolean(message) && typeof message === "object" && message.type === WHATSAPP_AUTH_KEY_REQUEST;
}

/**
 * @param {object} deps
 * @param {() => boolean} deps.credentialStoreUnavailable
 * @param {() => Record<string, unknown>} deps.readCredentials the current decrypted document
 * @param {(derive: (current: Record<string, unknown>) => Record<string, unknown>) => Promise<unknown>} deps.updateCredentials
 * @param {(message: object) => void} deps.reply posts on the private port of the requesting child
 * @param {() => string} [deps.mint] test seam
 * @returns {Promise<string|null>} the key, for tests only; callers must not log it
 */
export async function answerWhatsAppAuthKeyRequest({ credentialStoreUnavailable, readCredentials, updateCredentials, reply, mint = () => randomBytes(32).toString("hex") }) {
  const send = (key) => { try { reply({ type: WHATSAPP_AUTH_KEY_REPLY, key }); } catch { /* the child went away */ } return key; };
  try {
    if (credentialStoreUnavailable()) return send(null);
    const stored = readCredentials()?.[WHATSAPP_AUTH_KEY_FIELD];
    if (exists(stored)) return send(typeof stored === "string" && HEX_KEY.test(stored) ? stored : null);
    const fresh = mint();
    if (!HEX_KEY.test(fresh)) return send(null);
    await updateCredentials((current) => {
      // Another writer may have minted between the read and this serialized update: keep theirs.
      if (exists(current?.[WHATSAPP_AUTH_KEY_FIELD])) return current;
      return { ...current, [WHATSAPP_AUTH_KEY_FIELD]: fresh };
    });
    const saved = readCredentials()?.[WHATSAPP_AUTH_KEY_FIELD];
    return send(typeof saved === "string" && HEX_KEY.test(saved) ? saved : null);
  } catch {
    return send(null);
  }
}
