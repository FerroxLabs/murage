// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own tools that ask on every engine by design (shared/own-servers.ts
// OWN_ALWAYS_ASK, Rule 51): publish_site, take_down_site, skill_manage and the
// rest. At Ask and at Auto no remembered "Always allow" (tool, exact command or
// stop-line place), task allowance or routine grant answers them. Auto mode's
// own answer is unchanged, as for any tool. Full access keeps its contract.
import { describe, expect, it } from "vitest";

import { approvalKey, autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { stopLineKey, type StopHit } from "./stop-line.ts";
import { assertOwnAskTablesDisjoint, OWN_ALWAYS_ASK, OWN_BUILTINS, OWN_UNASKED, type OwnBuiltin } from "../shared/own-servers.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";

const MOUNTS = (Object.entries(OWN_BUILTINS) as Array<[OwnBuiltin, string]>).map(([builtin, engineName]) => ({ engineName, mountId: `own:${builtin}`, provenance: "own" as const }));

/** The engine's ask as Codex files it: the MCP name, on this turn's own mounts. */
function codexCall(mount: string, tool: string, input: object = { name: "shop" }): GrantCall {
  const server = OWN_BUILTINS[mount.slice("own:".length) as OwnBuiltin];
  return { engine: "codex", toolCall: { name: `mcp__${server}__${tool}`, input }, mcpMounts: MOUNTS };
}

const SUMMARY = "publish the site shop";
const STOP: StopHit = { kind: "message", place: "public:netlify:shop", what: "publish a site where anyone can see it" };
const STOP_KEY = stopLineKey(STOP)!;

function keysFor(tool: string, call: GrantCall): string[] {
  return [approvalKey(tool, SUMMARY, undefined, call), tool, call.toolCall!.name, STOP_KEY].filter((k): k is string => typeof k === "string");
}

describe("no remembered answer runs an OWN_ALWAYS_ASK tool at Ask", () => {
  it("a remembered grant for publish_site at Ask raises the card, with no grant offered", () => {
    const call = codexCall("own:agents", "publish_site");
    const verdict = autoVerdict({ autoApprove: false, alwaysAllow: keysFor("publish_site", call) }, "publish_site", SUMMARY, { call });
    expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
  });

  it("an unstamped mcp__agents__publish_site with a remembered grant at Ask raises the card", () => {
    const name = "mcp__agents__publish_site";
    expect(autoVerdict({ autoApprove: false, alwaysAllow: [approvalKey(name, SUMMARY) ?? name, name] }, name, SUMMARY)).toMatchObject({ approve: null, source: "always-ask" });
  });

  it.each(OWN_ALWAYS_ASK.map((row) => [row.mount, row.tool] as const))("%s/%s: a remembered, task or routine stop-line grant does not answer it at Ask or Auto", (mount, tool) => {
    const call = codexCall(mount, tool);
    const keys = keysFor(tool, call);
    for (const autoApprove of [false, true]) {
      const bot: AutoApprover = { autoApprove, alwaysAllow: keys };
      const contexts: AutoContext[] = [
        { call, stopLine: STOP },
        { call, stopLine: STOP, stopAllowedForTask: STOP_KEY, taskAllowanceKeys: [STOP_KEY] },
        { call, stopLine: STOP, automated: true, routineLevel: true, routineAllow: [STOP_KEY] },
      ];
      for (const context of contexts) expect(autoVerdict(bot, tool, SUMMARY, context), JSON.stringify({ autoApprove, context })).toMatchObject({ approve: null, source: "always-ask" });
    }
  });
});

describe("at Auto, a grant never answers it and Auto mode's own answer is unchanged", () => {
  it("a remembered grant for publish_site at Auto is not what answers it: Auto mode is, as on base", () => {
    const call = codexCall("own:agents", "publish_site");
    const granted = autoVerdict({ autoApprove: true, alwaysAllow: keysFor("publish_site", call) }, "publish_site", SUMMARY, { call });
    const plain = autoVerdict({ autoApprove: true }, "publish_site", SUMMARY, { call });
    expect(granted).toEqual(plain);
    expect(granted).toMatchObject({ source: "auto-mode", rule: undefined });
  });

  it("a routine grant does not answer it on an attended routine run at Auto", () => {
    const call = codexCall("own:agents", "publish_site");
    const context: AutoContext = { call, automated: true, routineLevel: true, routineAllow: keysFor("publish_site", call) };
    expect(autoVerdict({ autoApprove: true }, "publish_site", SUMMARY, context)).toMatchObject({ source: "auto-mode", rule: undefined });
  });

  it("pins base: web_search on a Codex-style ask is answered by Auto mode at Auto, attended and on a routine run, and cards at Ask", () => {
    const call = codexCall("own:agents", "web_search", { query: "netlify pricing" });
    const auto = autoVerdict({ autoApprove: true }, "web_search", "search the web", { call });
    expect(auto).toEqual({ approve: "auto-approved web_search", source: "auto-mode", rule: undefined });
    expect(autoVerdict({ autoApprove: true }, "web_search", "search the web", { call, automated: true, routineLevel: true })).toEqual(auto);
    expect(autoVerdict({ autoApprove: false }, "web_search", "search the web", { call }).approve).toBeNull();
  });
});

describe("the own tool tables", () => {
  it("OWN_ALWAYS_ASK and OWN_UNASKED never name the same mount and tool", () => {
    expect(() => assertOwnAskTablesDisjoint()).not.toThrow();
    const unasked = new Set(OWN_UNASKED.flatMap((row) => row.tools.map((tool) => `${row.mount}/${tool}`)));
    for (const row of OWN_ALWAYS_ASK) expect(unasked.has(`${row.mount}/${row.tool}`), row.tool).toBe(false);
  });

  it("the assert refuses an overlap", () => {
    const overlap = [{ mount: "own:agents" as const, tools: ["publish_site"], boundary: "test" }];
    expect(() => assertOwnAskTablesDisjoint(overlap, OWN_ALWAYS_ASK)).toThrow(/publish_site/);
  });
});

describe("Full access is unchanged", () => {
  it("still approves publish_site for the owner's own turn, with or without a remembered grant", () => {
    const call = codexCall("own:agents", "publish_site");
    for (const bot of [{ autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, alwaysAllow: keysFor("publish_site", call) }] as AutoApprover[]) {
      const verdict = autoVerdict(bot, "publish_site", SUMMARY, { call });
      expect(verdict).toMatchObject({ source: "full-access" });
      expect(verdict.approve).toEqual(expect.any(String));
    }
  });
});
