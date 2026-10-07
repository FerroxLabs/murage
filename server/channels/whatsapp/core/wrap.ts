// Copyright 2026 Ferrox Labs
// Prompt wrapper shape follows server/channels/slack/event.ts and server/telegram-channel.ts.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The whole prompt trust boundary for WhatsApp (design 5.7). Pure.
// - The sentinel words are constants; nothing a sender writes can produce or close them.
// - Every body line that looks like any sentinel is replaced.
// - Display name, group title, caption, filename and quoted text each get their own labelled
//   field, with control characters removed and a length cap.
// Provenance (sender, chat, audience, destination) never travels in the prompt; it stays on the
// envelope, so nothing in here can change who is speaking or where the reply goes.

export const WRAP_PLATFORM = "WHATSAPP";
export const SENTINEL_LABEL = "CHANNEL MESSAGE";
export const REMOVED_LINE = "[bracketed line removed]";

export const FIELD_CAPS = { name: 80, title: 120, caption: 1000, filename: 200, quote: 500, body: 20_000, transcript: 4000 } as const;

/** A line that is, or tries to be, an opening or closing sentinel for any platform. */
const SENTINEL_TOKEN = /\[\/?UNTRUSTED\s+[A-Z\s]+\]/gi;

export interface WrapFields {
  body?: string;
  senderName?: string;
  groupTitle?: string;
  caption?: string;
  filename?: string;
  quotedText?: string;
  /** Text recognised from a voice note; rendered with a `[voice note]` marker. */
  voiceTranscript?: string;
}

/** Control characters out (newlines and tabs become one space), bidi overrides out, trimmed, capped. */
export function cleanLine(value: string | undefined, cap: number): string {
  if (!value) return "";
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(SENTINEL_TOKEN, REMOVED_LINE)
    .replace(/\s{2,}/g, " ")
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** Keeps newlines in a body but removes other control characters, replaces sentinel-looking lines, and caps length. */
export function cleanBody(value: string | undefined, cap: number = FIELD_CAPS.body): string {
  if (!value) return "";
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
  const lines = text.split("\n").map(line => {
    const clean = line.replace(SENTINEL_TOKEN, REMOVED_LINE);
    return clean.trim() === REMOVED_LINE ? REMOVED_LINE : clean;
  });
  const joined = lines.join("\n");
  return joined.length > cap ? `${joined.slice(0, cap - 1)}…` : joined;
}

/** A field value can never start a line that reads as a sentinel; the label prefix already guarantees it, this keeps the value from ending a bracket run. */
const field = (label: string, value: string): string => (value ? `${label}: ${value}\n` : "");

export function wrapUntrusted(platform: string, fields: WrapFields): string {
  const tag = `UNTRUSTED ${platform.toUpperCase().replace(/[^A-Z ]/g, "")} ${SENTINEL_LABEL}`;
  const transcript = cleanBody(fields.voiceTranscript, FIELD_CAPS.transcript);
  const body = cleanBody(fields.body);
  const parts =
    field("Sender name", cleanLine(fields.senderName, FIELD_CAPS.name)) +
    field("Group", cleanLine(fields.groupTitle, FIELD_CAPS.title)) +
    field("Quoted message", cleanLine(fields.quotedText, FIELD_CAPS.quote)) +
    field("Attachment", cleanLine(fields.filename, FIELD_CAPS.filename)) +
    field("Caption", cleanLine(fields.caption, FIELD_CAPS.caption));
  const message = transcript ? (body ? `[voice note] ${transcript}\n${body}` : `[voice note] ${transcript}`) : body;
  return `[${tag}]\n${parts}${parts ? "Message:\n" : ""}${message}\n[/${tag}]`;
}
