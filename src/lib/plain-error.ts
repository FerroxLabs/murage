// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2540, Apache-2.0 (see NOTICE).
// A technical error shown as one plain line, with the original kept for a
// Details link. Patterns are deliberately narrow and match the WHOLE message:
// a sentence a person or a bot wrote is never rewritten.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface PlainError {
  /** What to show. */
  line: string;
  /** The original text when `line` replaced it; null when the message was already plain. */
  details: string | null;
}

const NETWORK = /^(?:TypeError:\s*)?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|fetch failed|Network request failed|The network connection was lost\.?)$/i;
const NODE_CODE = /^(?:Error:\s*)?(?:connect |read |write |getaddrinfo )?(E(?:CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH|AI_AGAIN)|ERR_[A-Z_]+)\b[^\n]*$/;
const STATUS = /^(?:HTTP\s*)?(?:status\s*)?([1-5]\d{2})(?:\s+[A-Za-z][A-Za-z ]{0,40})?$/i;
const STACK = /^[A-Za-z]*Error: [^\n]*\n\s+at\s/;

function keyForStatus(code: number): LocaleKey {
  if (code === 401 || code === 403) return "err.plain.signIn";
  if (code === 404) return "err.plain.notFound";
  if (code === 429) return "err.plain.rateLimit";
  if (code >= 500) return "err.plain.server";
  return "err.plain.internal";
}

function looksLikeJsonBody(text: string): boolean {
  if (!/^[{[]/.test(text) || !/[}\]]$/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

export function plainError(message: string): PlainError {
  const text = message.trim();
  const keep: PlainError = { line: message, details: null };
  if (!text) return keep;
  const plain = (key: LocaleKey): PlainError => ({ line: t(key), details: message });
  if (NETWORK.test(text) || /^E(?:CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN)\b/.test(text)) return plain("err.plain.network");
  const status = STATUS.exec(text);
  if (status) return plain(keyForStatus(Number(status[1])));
  if (/^(?:rate limit(?:ed)?|too many requests)\b[^.\n]{0,40}$/i.test(text)) return plain("err.plain.rateLimit");
  if (/^(?:unauthorized|forbidden)$/i.test(text)) return plain("err.plain.signIn");
  if (looksLikeJsonBody(text)) return plain("err.plain.badReply");
  if (STACK.test(text)) return plain("err.plain.internal");
  if (NODE_CODE.test(text)) return plain("err.plain.internal");
  return keep;
}
