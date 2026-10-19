// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 62 reply markers and the Rule 51 own-server table.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLY_MARKERS, validatedReply, type MarkerShape } from "./reply-markers.ts";
import { isOwnUnasked, OWN_ALWAYS_ASK, OWN_UNASKED } from "./own-servers.ts";

describe("Rule 62", () => {
  it("names the marker per operation and checks its shape", () => {
    expect(Object.keys(REPLY_MARKERS).sort()).toEqual([
      "GMAIL_REPLY_TO_THREAD", "OUTLOOK_REPLY_EMAIL", "SLACK_SEND_MESSAGE", "TELEGRAM_SEND_MESSAGE",
    ]);
    expect(validatedReply("SLACK_SEND_MESSAGE", { thread_ts: "1700000000.000100" })).toBe(true);
    expect(validatedReply("SLACK_SEND_MESSAGE", { thread_ts: "yesterday" })).toBe(false);
    expect(validatedReply("SLACK_CHAT_POST_MESSAGE", { thread_ts: "1700000000.000100" })).toBe(false);
    expect(validatedReply("TELEGRAM_SEND_MESSAGE", { reply_to_message_id: 42 })).toBe(true);
    expect(validatedReply("GMAIL_REPLY_TO_THREAD", { thread_id: "" })).toBe(false);
    expect(validatedReply("GMAIL_REPLY_TO_THREAD", { thread_id: "abc" }, new Set(["to", "body"]))).toBe(false);
    expect(validatedReply("GMAIL_REPLY_TO_THREAD", { thread_id: "abc" }, new Set(["thread_id"]))).toBe(true);
  });

  // Decision (g): rows whose action and key are not both confirmed in the catalog fixture are deleted, so these sends are fresh sends
  it("pins the deletion of GMAIL_SEND_EMAIL, OUTLOOK_SEND_EMAIL and DISCORD_SEND_MESSAGE", () => {
    for (const [op, args] of [
      ["GMAIL_SEND_EMAIL", { threadId: "abc" }],
      ["OUTLOOK_SEND_EMAIL", { conversationId: "abc" }],
      ["DISCORD_SEND_MESSAGE", { message_reference: { message_id: "123" } }],
    ] as const) {
      expect(REPLY_MARKERS[op], op).toBeUndefined();
      expect(validatedReply(op, args), op).toBe(false);
    }
  });
});

// Section (g) of APP-GRANT-FIXPLAN-r6 (Rule 62a as amended): a row stands only when its slug is in the catalog AND its
// key, dotted for a nested one, is a property of that operation's input schema whose JSON type fits the row's shape.
interface SchemaNode { type?: string; properties?: Record<string, SchemaNode> }
const CATALOG = JSON.parse(readFileSync(new URL("./reply-markers.catalog.fixture.json", import.meta.url), "utf8")) as { operations: Record<string, SchemaNode> };
const FITS: Record<MarkerShape, readonly string[]> = { "slack-ts": ["string"], digits: ["string", "integer"], string: ["string"] };
function propertyAt(schema: SchemaNode, dotted: string): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema;
  for (const part of dotted.split(".")) node = node?.properties && Object.hasOwn(node.properties, part) ? node.properties[part] : undefined;
  return node;
}

describe("Rule 62a against the catalog", () => {
  it.each(Object.entries(REPLY_MARKERS))("%s names a key its cached input schema lists, with a type that fits its shape", (slug, marker) => {
    const schema = CATALOG.operations[slug];
    expect(schema, `${slug} is not in the catalog fixture`).toBeDefined();
    const property = propertyAt(schema!, marker.key);
    expect(property, `${slug}: ${marker.key} is not in its input schema`).toBeDefined();
    expect(FITS[marker.shape], `${slug}: ${marker.key} is ${property!.type}, not a ${marker.shape}`).toContain(property!.type);
  });
});

describe("Rule 51", () => {
  it("one table; a tool that asks by design is never in it", () => {
    expect(isOwnUnasked("own:memory", "memory_save")).toBe(true);
    expect(isOwnUnasked("own:agents", "allow_for_task")).toBe(true);
    expect(isOwnUnasked("own:agents", "skill_manage")).toBe(false);
    expect(isOwnUnasked("own:dweb", "dweb_opencode_run")).toBe(false);
    expect(isOwnUnasked("custom:memory", "memory_save")).toBe(false);
    for (const row of OWN_ALWAYS_ASK) expect(isOwnUnasked(row.mount, row.tool), row.tool).toBe(false);
    const all = OWN_UNASKED.flatMap((row) => row.tools.map((tool) => `${row.mount}/${tool}`));
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((entry) => entry.startsWith("own:muragebox"))).toBe(false);
  });

  // Gap (d) of steps 1..3: no WhatsApp or Twilio send slug is in the tree, so none is a reply, whatever it carries
  it("gives a WhatsApp or Twilio send no reply semantics until its slug is read from the catalog", () => {
    for (const op of ["WHATSAPP_SEND_MESSAGE", "TWILIO_SEND_SMS", "TWILIO_SEND_WHATSAPP_MESSAGE"]) {
      expect(REPLY_MARKERS[op]).toBeUndefined();
      expect(validatedReply(op, { in_reply_to: "wamid.HBgM" })).toBe(false);
    }
  });
});
