// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 7: the last line of defence between the recipient scan and anything the owner or the bot reads. Only an address, a handle or a
// phone number may become recipient text. A card number, a one-time code or free text never does, whatever field it came from.
// Its only import is the shared secret classifier (no imports of its own): the intent check, the service and the facts collector all use it.

import { looksLikeSecretValue as sharedLooksLikeSecretValue } from "../shared/browser-secret-classifier.ts";

/** Round 8: the shared classifier (digits and separators normalised: dots, spaces, full-width and other scripts; 4 to 9 digit codes, SSNs,
 * card halves, 13 to 19 digit cards). A leading @ is not a disguise: an @handle that is really a number is a number. */
export function looksLikeSecretValue(value: string): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (sharedLooksLikeSecretValue(text)) return true;
  return text.startsWith("@") && sharedLooksLikeSecretValue(text.slice(1));
}

const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const HANDLE = /^@[^\s@]+$/u;
const PHONE = /^\+?[\d\s().-]+$/;

/** True when the token may be shown as a recipient: email-like, handle-like or phone-like, and not shaped like a secret. */
export function isRecipientToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  const t = token.trim();
  if (!t || t.length > 254) return false;
  if (looksLikeSecretValue(t)) return false;
  if (EMAIL.test(t) || HANDLE.test(t)) return true;
  if (PHONE.test(t)) { const n = t.replace(/\D/g, "").length; return n >= 7 && n <= 20; }
  return false;
}

export function cleanRecipients(list: readonly unknown[] | undefined): string[] {
  return Array.isArray(list) ? list.filter(isRecipientToken) : [];
}

/** For the stages after the scan (intent line, card, digest): drop only what is shaped like a secret. Odd recipients still show, hidden characters and all. */
export function withoutSecretValues(list: readonly unknown[] | undefined): string[] {
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && !looksLikeSecretValue(item.trim())) : [];
}
