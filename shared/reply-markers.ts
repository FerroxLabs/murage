// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Validated reply markers, per operation
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rule 62). A send is a
// reply only when this table names the key for THAT operation, the cached
// schema (when there is one) lists the key, and the value has the
// operation's shape. A marker that fails any of the three is read as what it
// is by the key vocabularies, and the send is judged as a fresh send. An
// operation outside this table has no reply semantics.

export type MarkerShape = "slack-ts" | "digits" | "string";

export interface ReplyMarker {
  /** the key, dotted for a nested one (`message_reference.message_id`) */
  key: string;
  shape: MarkerShape;
  /** the operation is only ever a reply */
  required?: boolean;
}

export const REPLY_MARKERS: Readonly<Record<string, ReplyMarker>> = {
  GMAIL_REPLY_TO_THREAD: { key: "thread_id", shape: "string", required: true },
  OUTLOOK_REPLY_EMAIL: { key: "message_id", shape: "string" },
  SLACK_SEND_MESSAGE: { key: "thread_ts", shape: "slack-ts" },
  TELEGRAM_SEND_MESSAGE: { key: "reply_to_message_id", shape: "digits" },
  // GMAIL_SEND_EMAIL, OUTLOOK_SEND_EMAIL and DISCORD_SEND_MESSAGE are deliberately absent (Rule 62a: a row needs both the action and its
  // key confirmed in the catalog fixture; these three do not have that). Their sends are judged fresh, which fails closed.
  // WhatsApp and Twilio (`in_reply_to`): no send-operation slug for either is in this tree's app catalog or cached schemas, so
  // none is named here and their sends have no reply semantics (judged as fresh sends, which fails closed). A row is added only
  // with the slug read from the catalog, never guessed.
};

const SHAPES: Record<MarkerShape, (value: unknown) => boolean> = {
  "slack-ts": (value) => typeof value === "string" && /^\d+\.\d+$/.test(value),
  digits: (value) => (typeof value === "string" && /^\d+$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0),
  string: (value) => typeof value === "string" && value.trim() !== "",
};

function at(args: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = args;
  for (const part of dotted.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Whether this call of `operation` is a validated reply (Rule 62 a..c).
 * `schemaKeys`, when the operation's schema is cached, is the set of keys it
 * lists (top-level, dotted for nested); a key the service ignores is not a
 * reply whatever the table says.
 */
export function validatedReply(operation: string, args: Record<string, unknown>, schemaKeys?: ReadonlySet<string>): boolean {
  const marker = REPLY_MARKERS[operation.toUpperCase()];
  if (!marker) return false;
  if (schemaKeys && !schemaKeys.has(marker.key)) return false;
  return SHAPES[marker.shape](at(args, marker.key));
}
