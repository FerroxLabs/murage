// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23): the per-request plain-name rows the relay appends (server/connector-aliases.ts): draft-only, unknown
// inventory, and the answer's own framing (JSON or event stream). The relay itself is exercised in index-f11-aliases.test.ts.
import { describe, expect, it } from "vitest";
import { restrictedAliasTools, unrestrictedAliasTools, withAliasRows } from "./connector-aliases.ts";
import type { BotRecord } from "./store.ts";

const bot = (extra: Record<string, unknown> = {}) => ({ id: "b", draftOnly: false, ...extra }) as unknown as BotRecord;
const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

describe("unrestricted rows come from the remembered inventory only", () => {
  const inventory = { gmail: ["ca_a", "ca_b"], slack: ["ca_s"], googlecalendar: [] };
  it("lists an alias per toolkit that has an account, with that toolkit's accounts as the enum", () => {
    const rows = unrestrictedAliasTools(bot(), inventory, false);
    expect(names(rows)).toEqual(["gmail_fetch_emails", "gmail_get_profile", "gmail_send_email", "slack_send_message"]);
    expect((rows.find((row) => row.name === "slack_send_message")!.inputSchema.properties as any).account.enum).toEqual(["ca_s"]);
  });
  it("unknown inventory lists nothing (fail closed)", () => {
    expect(unrestrictedAliasTools(bot(), null, false)).toEqual([]);
  });
  it("a draft-only bot gets no write alias; at No limits the draft-only mark does not apply", () => {
    expect(names(unrestrictedAliasTools(bot({ draftOnly: true }), inventory, false))).toEqual(["gmail_fetch_emails", "gmail_get_profile"]);
    expect(names(unrestrictedAliasTools(bot({ draftOnly: true }), inventory, true))).toContain("gmail_send_email");
  });
});

describe("restricted rows", () => {
  it("an unrestricted bot has no restricted rows", () => {
    expect(restrictedAliasTools(bot({ composio: true }))).toEqual([]);
  });
});

describe("withAliasRows keeps the answer's own framing and never doubles a row", () => {
  const rows = unrestrictedAliasTools(bot(), { gmail: ["ca_a"] }, false).slice(0, 1);
  const answer = (tools: unknown[]) => ({ jsonrpc: "2.0", id: 1, result: { tools } });
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  it("JSON", () => {
    const out = JSON.parse(text(withAliasRows("application/json; charset=utf-8", new TextEncoder().encode(JSON.stringify(answer([{ name: "COMPOSIO_MULTI_EXECUTE_TOOL" }]))), rows)));
    expect(names(out.result.tools)).toEqual(["COMPOSIO_MULTI_EXECUTE_TOOL", "gmail_fetch_emails"]);
  });
  it("event stream", () => {
    const raw = `event: message\ndata: ${JSON.stringify(answer([{ name: "COMPOSIO_MULTI_EXECUTE_TOOL" }]))}\n\n`;
    const out = text(withAliasRows("text/event-stream", new TextEncoder().encode(raw), rows));
    expect(out).toContain("event: message");
    expect(names(JSON.parse(out.split("\n").find((line) => line.startsWith("data:"))!.slice(5)).result.tools)).toEqual(["COMPOSIO_MULTI_EXECUTE_TOOL", "gmail_fetch_emails"]);
  });
  it("a row the upstream already lists is not doubled; bytes it cannot read are returned untouched", () => {
    const listed = new TextEncoder().encode(JSON.stringify(answer([{ name: "gmail_fetch_emails" }])));
    expect(names(JSON.parse(text(withAliasRows("application/json", listed, rows))).result.tools)).toEqual(["gmail_fetch_emails"]);
    const junk = new TextEncoder().encode("not json");
    expect(withAliasRows("application/json", junk, rows)).toBe(junk);
  });
});
