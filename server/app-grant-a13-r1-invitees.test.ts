// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1) item 3, Rule 80a: a calendar event
// with fresh invitees stops for each of them, under every spelling; an
// unreadable invitee is unread, never nobody.
import { describe, expect, it } from "vitest";

import type { GrantCall } from "../shared/app-action-grant.ts";
import type { McpMountRecord } from "../shared/mount-identity.ts";
import { routineTurnApproval } from "./routine-permissions.ts";
import { classifyAsk, classifyAskRows, rowDestinations, type StopLinePlace } from "./stop-line.ts";

type Ask = GrantCall & { tool: string; summary: string };

const OWN: McpMountRecord = { engineName: "murage_connectors", mountId: "own:connector", provenance: "own" };
const EXECUTE = "murage_connectors__APPS_MULTI_EXECUTE_TOOL";
const row = (tool_slug: string, args: Record<string, unknown> = {}) => ({ tool_slug, arguments: args });
const fuigo = (...rows: unknown[]): Ask => ({
  tool: "other", summary: "Run app tools", toolKind: "other", engine: "acp",
  toolIdentity: { namespace: "mcp", name: EXECUTE }, toolCall: { name: "Run app tools", input: { tools: rows } }, mcpMounts: [OWN],
});
const place: StopLinePlace = { home: "/Users/ada", cwd: "/Users/ada/work", roots: ["/Users/ada/work"], knownRecipients: new Set(["ada@example.com"]), realpath: (p: string) => p };
const judge = (ask: Ask, alwaysAllow: string[]) => routineTurnApproval({
  bot: { autoApprove: true, fullAccess: true, noLimits: true }, run: { permissionMode: "ask", alwaysAllow }, tool: ask.tool, summary: ask.summary,
  context: { call: ask, stopLine: classifyAsk(ask, place), stopRows: classifyAskRows(ask, place) },
}).verdict;

describe("item 3, Rule 80a: invitation destinations are recipients where the operation sends", () => {
  const create = (args: Record<string, unknown>) => fuigo(row("GMAIL_FETCH_EMAILS"), row("GOOGLECALENDAR_CREATE_EVENT", { summary: "Training", ...args }));
  const keys = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_CREATE_EVENT"];

  it("stops each fresh invitee despite the saved create action, under every spelling", () => {
    for (const args of [
      { attendees: ["bob@example.com"] }, { attendees: [{ email: "bob@example.com" }] }, { attendees: "bob@example.com" },
      { invitees: ["bob@example.com"] }, { guests: ["bob@example.com"] }, { attendee_emails: ["bob@example.com"] },
      { optional_attendees: ["bob@example.com"] }, { participants: ["bob@example.com"] },
    ]) {
      const ask = create(args);
      expect(judge(ask, keys).source, JSON.stringify(args)).toBe("stop-line");
      expect(classifyAskRows(ask, place)![1], JSON.stringify(args)).toEqual([expect.objectContaining({ kind: "message", place: "bob@example.com" })]);
    }
  });

  it("covers a named invitee only with that invitee's own stop key", () => {
    const two = create({ attendees: ["bob@example.com", "eve@example.com"] });
    expect(classifyAskRows(two, place)![1]!.map((hit) => hit.place)).toEqual(["bob@example.com", "eve@example.com"]);
    expect(judge(two, [...keys, "stop:message:bob@example.com"]).source).toBe("stop-line");
    expect(judge(two, [...keys, "stop:message:bob@example.com", "stop:message:eve@example.com"])).toMatchObject({ source: "routine-allow" });
  });

  it("lets a known invitee, or an event with nobody invited, run on the saved action", () => {
    expect(judge(create({ attendees: ["ada@example.com"] }), keys)).toMatchObject({ source: "routine-allow" });
    expect(judge(create({}), keys)).toMatchObject({ source: "routine-allow" });
  });

  it("reads an invitee it cannot see through as unread, never as nobody", () => {
    const ask = create({ attendees: [{ nested: { deep: "x" } }] });
    expect(judge(ask, keys).source).toBe("stop-line");
    expect(classifyAskRows(ask, place)![1]).toEqual([expect.objectContaining({ kind: "message", what: expect.stringContaining("cannot tell who it goes to") })]);
  });

  it("stops a single create call too, and lists the invitees on the card", () => {
    const one = fuigo(row("GOOGLECALENDAR_CREATE_EVENT", { attendees: ["bob@example.com"] }));
    expect(classifyAsk(one, place)).toMatchObject({ kind: "message", place: "bob@example.com" });
    expect(rowDestinations({ attendees: [{ email: "Bob@Example.com" }] })).toEqual(["bob@example.com"]);
  });
});
