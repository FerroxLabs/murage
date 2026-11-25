// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hermes's ask hook leaves Murage's own run-without-asking tools alone (shared/own-servers.ts OWN_UNASKED), by
// their exact names only. A routine sat waiting on cards for mcp__agents__list_bots and
// mcp__murage_memory__memory_search on the Linux real-engine gate.
// The tool names Murage's own HighLevel used before 1.0.20 (seventeen families and two helpers).
const FORMER_HIGHLEVEL_TOOLS = ["HIGHLEVEL_CONTACTS", "HIGHLEVEL_OPPORTUNITIES", "HIGHLEVEL_CONVERSATIONS", "HIGHLEVEL_CALENDARS", "HIGHLEVEL_AUTOMATIONS", "HIGHLEVEL_LOCATION", "HIGHLEVEL_USERS", "HIGHLEVEL_FORMS", "HIGHLEVEL_PAYMENTS", "HIGHLEVEL_SOCIAL", "HIGHLEVEL_BLOGS", "HIGHLEVEL_MEDIA", "HIGHLEVEL_DOCUMENTS", "HIGHLEVEL_FUNNELS", "HIGHLEVEL_COURSES", "HIGHLEVEL_SAAS", "HIGHLEVEL_SNAPSHOTS", "HIGHLEVEL_LIST_CONNECTIONS", "HIGHLEVEL_ACTION_STATUS"];
import { describe, expect, it } from "vitest";

import { OWN_ALWAYS_ASK, OWN_BUILTINS, OWN_UNASKED, type OwnBuiltin } from "../../../shared/own-servers.ts";
import { hermesAskMatcher } from "./hermes.ts";

/** Hermes full-matches the hook's matcher against the tool name; the hook (which asks) runs on a match. */
const asks = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);
const hermesName = (mount: string, tool: string) =>
  `mcp__${OWN_BUILTINS[mount.slice("own:".length) as OwnBuiltin].replace(/-/g, "_")}__${tool}`;

describe("Hermes ask hook and Murage's own tools", () => {
  it.each([false, true])("runs the two tools the gate routine waited on without a card (host computer %s)", (host) => {
    const m = hermesAskMatcher(host);
    expect(asks(m, "mcp__agents__list_bots")).toBe(false);
    expect(asks(m, "mcp__murage_memory__memory_search")).toBe(false);
  });

  it.each([false, true])("runs every OWN_UNASKED tool without a card on a turn email mounts for sending (host computer %s)", (host) => {
    const m = hermesAskMatcher(host, true, "send", true);
    const names = OWN_UNASKED.flatMap((row) => row.tools.map((tool) => hermesName(row.mount, tool)));
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => asks(m, name))).toEqual([]);
  });

  // 1.0.20: Murage's own HighLevel is removed. A server named "highlevel" can only be the owner's own MCP server now, so
  // every former native tool name asks, whatever the legacy highlevel flag says.
  it.each([false, true])("asks for every former native HighLevel tool name, flag on or off (host computer %s)", (host) => {
    const names = FORMER_HIGHLEVEL_TOOLS.map(tool => `mcp__highlevel__${tool}`);
    expect(names.length).toBe(19);
    expect(OWN_UNASKED.some(row => (row.mount as string) === "own:highlevel")).toBe(false);
    for (const flag of [false, true]) {
      const m = hermesAskMatcher(host, true, "send", flag);
      expect(names.filter((name) => !asks(m, name))).toEqual([]);
    }
  });

  it.each([false, true])("still asks for every OWN_ALWAYS_ASK tool (host computer %s)", (host) => {
    const m = hermesAskMatcher(host);
    for (const row of OWN_ALWAYS_ASK) expect(asks(m, hermesName(row.mount, row.tool))).toBe(true);
  });

  it.each([false, true])("still asks for a third-party server or tool that only looks like an own one (host computer %s)", (host) => {
    const m = hermesAskMatcher(host);
    for (const spoof of [
      "mcp__murage_memory_evil__memory_search",
      "mcp__evil_murage_memory__memory_search",
      "mcp__murage_memory__memory_search_evil",
      "mcp__murage_memory__memory_searchx",
      "mcp__agents_evil__list_bots",
      "mcp__agents__list_bots__x",
      "mcp__murage-memory__memory_search",
      "xmcp__agents__list_bots",
      "mcp__agents__list.bots",
      "mcp__agents__publish_site",
      "mcp__other__list_bots",
    ]) expect(asks(m, spoof)).toBe(true);
    expect(asks(m, "terminal")).toBe(true);
    expect(asks(m, "execute_code")).toBe(true);
  });
});
