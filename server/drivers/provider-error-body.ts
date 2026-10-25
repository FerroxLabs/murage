// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot httpErrorDetail in server/drivers/openai-chat.ts (Apache-2.0), see NOTICE.

/** What a provider's JSON error envelope says, read loosely. Providers answer
 *  `{error:{message,code,type}}`, `{message,code}`, `{error:"text"}` or
 *  `{detail:"text"}`. A body that is not one of those gives all-undefined. */
export interface ProviderErrorFields {
  message?: string;
  code?: string;
  type?: string;
}

const SENTENCE_CAP = 300;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function providerErrorFields(body: string): ProviderErrorFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const root = parsed as Record<string, unknown>;
  const inner = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? (root.error as Record<string, unknown>)
    : root;
  const message = str(inner.message) ?? str(root.error) ?? str(root.detail) ?? str(root.message);
  const code = str(inner.code) ?? str(root.code);
  const type = str(inner.type) ?? str(root.type);
  return { ...(message ? { message } : {}), ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

/** The provider's own sentence for a non-2xx body, with its lowercase_snake
 *  machine code after it, or the raw body cut to `cap` when it is not an
 *  envelope. Redact the body BEFORE calling this: a key echoed in an error
 *  must already be masked. */
export function httpErrorDetail(body: string, cap = 500): string {
  const { message, code } = providerErrorFields(body);
  if (!message) return body.slice(0, cap);
  const sentence = message.length > SENTENCE_CAP ? `${message.slice(0, SENTENCE_CAP - 1)}…` : message;
  const withCode = code && SNAKE.test(code) ? `${sentence} (${code})` : sentence;
  return withCode.slice(0, cap);
}

/** Only the sentence, for plain copy: no machine code, capped. */
export function providerSentence(body: string): string | undefined {
  const { message } = providerErrorFields(body);
  if (!message) return undefined;
  return message.length > SENTENCE_CAP ? `${message.slice(0, SENTENCE_CAP - 1)}…` : message;
}
