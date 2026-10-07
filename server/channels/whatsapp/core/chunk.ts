// Copyright 2026 Ferrox Labs
// Adapted from OpenClaw extensions/whatsapp/src/auto-reply/deliver-reply.ts (MIT, OpenClaw Foundation)
// and Hermes Agent scripts/whatsapp-bridge/bridge.js send queue (MIT, Nous Research).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Outbound chunking and send policy (design 6). Pure.

export const MAX_CHUNK_CHARS = 4000;
export const CHUNK_DELAY_MS = 300;
export const SEND_TIMEOUT_MS = 60_000;
export const SEND_RETRY_MAX = 3;
export const SEND_RETRY_MIN_MS = 500;
export const SEND_RETRY_MAX_MS = 1000;

const CLOSE_FENCE = "\n```";

/** The opening line of the fence still open at the end of `text`, or null. */
function openFenceAfter(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("```")) continue;
    open = open === null ? trimmed : null;
  }
  return open;
}

function findCut(text: string, budget: number): number {
  const paragraph = text.lastIndexOf("\n\n", budget);
  if (paragraph > 0) return paragraph;
  const line = text.lastIndexOf("\n", budget);
  if (line > 0) return line;
  let cut = budget;
  const before = text.charCodeAt(cut - 1);
  if (before >= 0xd800 && before <= 0xdbff && cut > 1) cut -= 1; // never split a surrogate pair
  return cut;
}

/**
 * Splits `text` into pieces of at most `limit` characters: paragraph
 * boundaries first, then lines, then a hard cut. A code fence that a split
 * runs through is closed at the end of one piece and reopened at the start of
 * the next, so every piece renders on its own.
 */
export function chunkMessage(text: string, limit: number = MAX_CHUNK_CHARS): string[] {
  if (!Number.isInteger(limit) || limit < 32) throw new RangeError("chunkMessage: limit must be an integer of at least 32");
  if (!text) return [];
  const out: string[] = [];
  let rest = text;
  let fence: string | null = null;
  while (rest.length > 0) {
    const prefix = fence ? `${fence}\n` : "";
    if (prefix.length + rest.length <= limit) {
      out.push(prefix + rest);
      break;
    }
    const budget = limit - prefix.length - CLOSE_FENCE.length;
    if (budget < 1) throw new RangeError("chunkMessage: code fence header leaves no room");
    const cut = findCut(rest, budget);
    const head = rest.slice(0, cut);
    const trimmed = head.replace(/\s+$/, "");
    let body = prefix + (trimmed || head);
    const stillOpen = openFenceAfter(body);
    if (stillOpen) body += CLOSE_FENCE;
    fence = stillOpen;
    out.push(body);
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return out;
}

export type SendErrorCode = "auth" | "forbidden" | "rate-limit" | "offline" | "timeout" | "unavailable";

export interface ClassifiedSendError {
  code: SendErrorCode;
  /** True when the message may still have been delivered; never retry. */
  uncertain: boolean;
  /** Only connection-type errors are retried. */
  retryable: boolean;
  retryAfterSeconds?: number;
  message: string;
}

export const SEND_TIMEOUT_MESSAGE = "WhatsApp send timed out";

/** Maps a Baileys/Boom error to the ChannelSendError codes of design 6. */
export function classifySendError(error: unknown): ClassifiedSendError {
  const e = (error ?? {}) as { message?: unknown; output?: { statusCode?: unknown }; data?: { statusCode?: unknown; retryAfter?: unknown }; statusCode?: unknown; name?: unknown };
  const message = typeof e.message === "string" ? e.message : String(error);
  const status = [e.output?.statusCode, e.statusCode, e.data?.statusCode].find((value) => typeof value === "number") as number | undefined;
  if (message === SEND_TIMEOUT_MESSAGE || e.name === "TimeoutError") return { code: "timeout", uncertain: true, retryable: false, message };
  if (status === 401) return { code: "auth", uncertain: false, retryable: false, message };
  if (status === 403) return { code: "forbidden", uncertain: false, retryable: false, message };
  if (status === 429) {
    const retryAfter = typeof e.data?.retryAfter === "number" && e.data.retryAfter > 0 ? e.data.retryAfter : undefined;
    return { code: "rate-limit", uncertain: false, retryable: false, message, ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}) };
  }
  if (status === 428 || /connection closed|not open|socket.*(closed|not)/i.test(message)) return { code: "offline", uncertain: false, retryable: true, message };
  return { code: "unavailable", uncertain: false, retryable: false, message };
}

/** Delay before retry number `attempt` (1-based), or null when the retry budget is spent or the error is not retryable. */
export function sendRetryDelay(error: ClassifiedSendError, attempt: number, random: () => number = Math.random): number | null {
  if (!error.retryable || attempt > SEND_RETRY_MAX) return null;
  return SEND_RETRY_MIN_MS + Math.floor(random() * (SEND_RETRY_MAX_MS - SEND_RETRY_MIN_MS + 1));
}

export interface QuoteInput { remoteJid: string; id: string; fromMe?: boolean; participant?: string; text?: string }

/**
 * The minimal quoted message Baileys' `quoted` option needs, rebuilt from the envelope's quoted text
 * rather than keeping whole messages (design 6). On a cache miss (no text to show) it returns
 * undefined and the reply goes out unquoted instead of as a blank bubble (OpenClaw af531525c46).
 */
export function minimalQuoted(quote: QuoteInput | undefined): { key: { remoteJid: string; id: string; fromMe: boolean; participant?: string }; message: { conversation: string } } | undefined {
  if (!quote || !quote.id || !quote.remoteJid) return undefined;
  const text = (quote.text ?? "").trim();
  if (!text) return undefined;
  return {
    key: { remoteJid: quote.remoteJid, id: quote.id, fromMe: quote.fromMe === true, ...(quote.participant ? { participant: quote.participant } : {}) },
    message: { conversation: text.slice(0, 500) },
  };
}

/**
 * Runs `send` after a best-effort typing indicator. A presence failure never fails or delays the send
 * beyond the attempt (OpenClaw 402bd4af01b). The paused update after the last chunk is also best effort.
 */
export async function sendWithPresence<T>(presence: (state: "composing" | "paused") => Promise<unknown> | unknown, send: () => Promise<T>, onPresenceError: (error: unknown) => void = () => undefined): Promise<T> {
  const tryPresence = async (state: "composing" | "paused"): Promise<void> => {
    try { await presence(state); } catch (error) { try { onPresenceError(error); } catch { /* logging must not matter */ } }
  };
  await tryPresence("composing");
  try {
    return await send();
  } finally {
    await tryPresence("paused");
  }
}
