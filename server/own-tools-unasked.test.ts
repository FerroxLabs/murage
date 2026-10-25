// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.6: Murage's own read-only thread recall (thread_search, thread_list,
// thread_read on the murage-memory mount) runs with no card at Ask on every
// engine, from the one shared table (shared/own-servers.ts OWN_UNASKED and
// OWN_READS). Claude, Codex and Fuigo agree. A write keeps its card, and a
// foreign server's tool of the same name is judged like any other foreign
// tool, so it asks at Ask.
import { describe, expect, it } from "vitest";

import { autoVerdict } from "./auto-approve.ts";
import { claudeOwnUnaskedTools } from "./drivers/claude.ts";
import { routeDelivery, type HookDelivery, type RouteContext } from "./drivers/codex-hook.ts";
import { fuigoMemoryAllowOnce, newFuigoMemoryAlias } from "./drivers/acp/fuigo-memory-permission.ts";
import { GATE_UNASKED } from "./drivers/pi-permission-gate.ts";
import { isOwnRead, isOwnUnasked } from "../shared/own-servers.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";
import type { McpMountRecord } from "../shared/mount-identity.ts";

const THREAD_TOOLS = ["thread_search", "thread_list", "thread_read"] as const;
const ASK = { autoApprove: false } as const;
const MOUNTS: McpMountRecord[] = [
  { engineName: "murage-memory", mountId: "own:memory", provenance: "own" },
  { engineName: "agents", mountId: "own:agents", provenance: "own" },
  { engineName: "crm", mountId: "custom:crm", provenance: "custom" },
];

describe("the shared table", () => {
  it.each(THREAD_TOOLS)("own:memory/%s is an own read, so it runs unasked at every level", (tool) => {
    expect(isOwnUnasked("own:memory", tool)).toBe(true);
    expect(isOwnRead("own:memory", tool)).toBe(true);
    // matched by Murage's own mount, never by the tool name alone
    expect(isOwnUnasked("custom:crm", tool)).toBe(false);
    expect(isOwnRead("custom:crm", tool)).toBe(false);
    expect(isOwnUnasked("own:agents", tool)).toBe(false);
  });

  it("Pi's inline copy carries the same thread tools", () => {
    expect(GATE_UNASKED.find(([mount]) => mount === "own:memory")?.[1]).toEqual(expect.arrayContaining([...THREAD_TOOLS]));
  });
});

describe("Claude at Ask", () => {
  it("pre-allows the three thread tools on murage-memory by exact name, and no write that asks", () => {
    const memory = claudeOwnUnaskedTools("memory");
    for (const tool of THREAD_TOOLS) expect(memory).toContain(`mcp__murage-memory__${tool}`);
    expect(memory).not.toContain("mcp__murage-memory");
    expect(claudeOwnUnaskedTools("agents")).not.toContain("mcp__agents__publish_site");
  });

  it("a foreign server's thread_search, filed through the broker, raises a card", () => {
    const call: GrantCall = { engine: "claude", toolCall: { name: "mcp__crm__thread_search", input: { query: "invoice" } }, mcpMounts: MOUNTS };
    expect(autoVerdict(ASK, "mcp__crm__thread_search", "thread_search", { call }).approve).toBeNull();
  });

  it("a write filed through the broker raises a card", () => {
    const call: GrantCall = { engine: "claude", toolCall: { name: "mcp__agents__publish_site", input: { name: "shop" } }, mcpMounts: MOUNTS };
    expect(autoVerdict(ASK, "mcp__agents__publish_site", "publish the site shop", { call }).approve).toBeNull();
  });
});

describe("Codex at Ask", () => {
  const ctx: RouteContext = { project: "/work/project", home: "/work/home", mounts: MOUNTS };
  const delivery = (tool_name: string, tool_input: unknown): HookDelivery => ({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: "/work/project" });

  it.each(THREAD_TOOLS)("%s on murage-memory runs with no card", (tool) => {
    expect(routeDelivery(delivery(`mcp__murage-memory__${tool}`, { query: "invoice" }), ctx)).toEqual({ route: "allow", final: true, why: "own-unasked" });
    // as Codex writes the server name
    expect(routeDelivery(delivery(`mcp__murage_memory__${tool}`, { query: "invoice" }), ctx)).toEqual({ route: "allow", final: true, why: "own-unasked" });
  });

  it("a foreign server's thread_search is not final here and the approval path raises a card", () => {
    expect(routeDelivery(delivery("mcp__crm__thread_search", { query: "invoice" }), ctx)).toEqual({ route: "allow", final: false, why: "custom" });
    const call: GrantCall = { engine: "codex", toolCall: { name: "mcp__crm__thread_search", input: { query: "invoice" } }, mcpMounts: MOUNTS };
    expect(autoVerdict(ASK, "thread_search", "thread_search", { call }).approve).toBeNull();
  });

  it("a write asks", () => {
    expect(routeDelivery(delivery("mcp__agents__publish_site", { name: "shop" }), ctx)).toMatchObject({ route: "ask", tool: "publish_site" });
  });

  it.each(THREAD_TOOLS)("the shared verdict answers %s on Codex's own mount at Ask", (tool) => {
    const call: GrantCall = { engine: "codex", toolCall: { name: `mcp__murage-memory__${tool}`, input: { query: "invoice" } }, mcpMounts: MOUNTS };
    expect(autoVerdict(ASK, tool, tool, { call })).toMatchObject({ source: "own-unasked", rule: `own:memory/${tool}` });
  });
});

describe("Fuigo at Ask", () => {
  const alias = newFuigoMemoryAlias();
  const once = [{ optionId: "once", kind: "allow_once" }];
  const fuigoMounts: McpMountRecord[] = [
    { engineName: alias, mountId: "own:memory", provenance: "own" },
    { engineName: "agents", mountId: "own:agents", provenance: "own" },
    { engineName: "crm", mountId: "custom:crm", provenance: "custom" },
  ];
  const stamped = (name: string, input: unknown = { query: "invoice" }): GrantCall =>
    ({ engine: "acp", toolIdentity: { namespace: "mcp", name }, toolCall: { name, input }, mcpMounts: fuigoMounts });

  it.each(THREAD_TOOLS)("%s under this turn's memory alias is allowed once and the shared verdict needs no card", (tool) => {
    expect(fuigoMemoryAllowOnce({ _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: `${alias}__${tool}` } } }, once, alias)).toBe("once");
    expect(autoVerdict(ASK, tool, tool, { call: stamped(`${alias}__${tool}`) })).toMatchObject({ source: "own-unasked", rule: `own:memory/${tool}` });
  });

  it("a foreign server's thread_search is never allowed by the memory rule and raises a card", () => {
    expect(fuigoMemoryAllowOnce({ _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: "crm__thread_search" } } }, once, alias)).toBeNull();
    expect(autoVerdict(ASK, "thread_search", "thread_search", { call: stamped("crm__thread_search") }).approve).toBeNull();
  });

  it("a write raises a card", () => {
    expect(autoVerdict(ASK, "publish_site", "publish the site shop", { call: stamped("agents__publish_site", { name: "shop" }) }).approve).toBeNull();
  });
});
