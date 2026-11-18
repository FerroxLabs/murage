// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hermes's ask hook leaves Murage's own run-without-asking tools alone (shared/own-servers.ts OWN_UNASKED), by
// their exact names only. A routine sat waiting on cards for mcp__agents__list_bots and
// mcp__murage_memory__memory_search on the Linux real-engine gate.
import { HIGHLEVEL_FAMILIES, HIGHLEVEL_FAMILY_TOOLS, HIGHLEVEL_HELPER_NAMES, HIGHLEVEL_WRITE_TOOLS } from "../../../shared/highlevel.ts";
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
    const names = OWN_UNASKED.flatMap((row) => (row.mount === "own:highlevel" ? [...Object.values(HIGHLEVEL_FAMILY_TOOLS), ...HIGHLEVEL_HELPER_NAMES] : row.tools).map((tool) => hermesName(row.mount, tool)));
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => asks(m, name))).toEqual([]);
  });

  it.each([false, true])("asks for every HighLevel tool on a turn that does not mount native HighLevel (host computer %s)", (host) => {
    const m = hermesAskMatcher(host, true, "send", false);
    const names = [...Object.values(HIGHLEVEL_FAMILY_TOOLS), ...HIGHLEVEL_HELPER_NAMES].map(tool => hermesName("own:highlevel", tool));
    // The amended surface is seventeen family tools and two helpers.
    expect(names.length).toBe(19);
    expect(names.length).toBe(HIGHLEVEL_FAMILIES.length + HIGHLEVEL_HELPER_NAMES.length);
    expect(names).toEqual(OWN_UNASKED.filter(row => row.mount === "own:highlevel").flatMap(row => row.tools.map(tool => hermesName(row.mount, tool))));
    expect(names.filter((name) => !asks(m, name))).toEqual([]);
  });

  it.each([false, true])("asks for retired legacy HighLevel change names even on a turn that mounts native HighLevel (host computer %s)", (host) => {
    const m = hermesAskMatcher(host, true, "send", true);
    const changes = [...HIGHLEVEL_WRITE_TOOLS].map((tool) => hermesName("own:highlevel", tool));
    expect(changes).toHaveLength(8);
    expect(changes.filter((name) => !asks(m, name))).toEqual([]);
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
