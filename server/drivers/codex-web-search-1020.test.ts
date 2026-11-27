// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CODEX-WEB-1020 (customer report): a Codex bot could not search the web. Native search is off on every turn that mounts
// Murage's agents server (codex.ts), the model's native call (`web__run`) was denied as an unknown tool, and Murage's own
// web_search asked on every call. MAIN ruling: native stays off; own web_search runs with no card on the free default
// provider and keeps its ask on a paid provider the owner chose. These witnesses drive the real hook router (routeDelivery),
// the real own-tool tables and the real verdict (autoVerdict); nothing under test is mocked. The provider probe is the seam
// the server itself sets (server/index.ts), set here to each Settings value.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { autoVerdict } from "../auto-approve.ts";
import { CODEX_APPS_WEB_TOOLS, CODEX_NATIVE_WEB_NAMES, codexWebRedirect, routeDelivery, type HookDelivery, type RouteContext } from "./codex-hook.ts";
import { isOwnAlwaysAsk, isOwnRead, isOwnUnasked, OWN_BUILTINS, OWN_WEB_SEARCH_NO_CARD_PROVIDERS, ownWebSearchRunsUnasked, setOwnWebSearchProviderProbe, type OwnBuiltin } from "../../shared/own-servers.ts";
import type { GrantCall } from "../../shared/app-action-grant.ts";

const dir = mkdtempSync(join(tmpdir(), "cxweb-1020-"));
const project = join(dir, "bot");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setOwnWebSearchProviderProbe(undefined));

const FREE = ["engine", "auto"] as const;
const PAID = ["flux", "tavily", "exa", "firecrawl"] as const;
const OWN_AGENTS = { engineName: "agents", mountId: "own:agents", provenance: "own" as const };
const ctx = (mounts: RouteContext["mounts"] = [OWN_AGENTS], extra: Partial<RouteContext> = {}): RouteContext => ({ project, home: dir, mounts, ...extra });
const delivery = (tool_name: unknown, tool_input: unknown): HookDelivery => ({ tool_name, tool_input, tool_use_id: "u1", turn_id: "t1", cwd: project });
const UNKNOWN = { route: "deny", reason: "Murage does not know this tool" };
const ALLOW = { route: "allow", final: true, why: "own-unasked" };
const SEARCH = delivery("mcp__agents__web_search", { query: "weather in Miami today", max_results: 5 });
const MOUNTS = (Object.entries(OWN_BUILTINS) as Array<[OwnBuiltin, string]>).map(([builtin, engineName]) => ({ engineName, mountId: `own:${builtin}`, provenance: "own" as const }));
const call = (tool: string, input: object): GrantCall => ({ engine: "codex", toolCall: { name: `mcp__agents__${tool}`, input }, mcpMounts: MOUNTS });
const searchCall = call("web_search", { query: "netlify pricing" });
const CONTEXTS = [{ call: searchCall }, { call: searchCall, unattended: true }, { call: searchCall, automated: true, routineLevel: true }];

describe("CODEX-WEB-1020: on the free default provider Murage's own web search runs with no card", () => {
  it.each(FREE)("provider %s: the hook lets mcp__agents__web_search through as a final allow on the turn's proven own mount", (provider) => {
    setOwnWebSearchProviderProbe(() => provider);
    expect(routeDelivery(SEARCH, ctx())).toEqual(ALLOW);
  });

  it.each(FREE)("provider %s: the verdict runs it at Ask and at Auto, attended, unattended and on a routine run", (provider) => {
    setOwnWebSearchProviderProbe(() => provider);
    for (const autoApprove of [false, true]) for (const context of CONTEXTS) {
      const verdict = autoVerdict({ autoApprove }, "web_search", "search the web", context);
      expect(verdict, JSON.stringify({ autoApprove, context })).toMatchObject({ source: "own-unasked", rule: "own:agents/web_search" });
      expect(typeof verdict.approve, JSON.stringify({ autoApprove, context })).toBe("string");
    }
  });

  it("the server sets the probe from the same setting, with the same default, as the search handler reads", () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
    expect(index).toContain('setOwnWebSearchProviderProbe(() => cfg.webSearch?.provider ?? "engine");');
    expect(index).toContain('const provider = cfg.webSearch?.provider ?? "engine";');
  });

  it("the no-card providers are exactly the free default and off", () => {
    expect([...OWN_WEB_SEARCH_NO_CARD_PROVIDERS].sort()).toEqual(["auto", "engine", "off"]);
  });
});

describe("CODEX-WEB-1020: a paid provider the owner chose keeps the ask", () => {
  it.each(PAID)("provider %s: the hook asks under the mount's own name", (provider) => {
    setOwnWebSearchProviderProbe(() => provider);
    expect(routeDelivery(SEARCH, ctx())).toMatchObject({ route: "ask", tool: "web_search", toolCall: { name: "mcp__agents__web_search" } });
  });

  it.each(PAID)("provider %s: the verdict cards it at Ask with no grant honoured, and Auto answers as before", (provider) => {
    setOwnWebSearchProviderProbe(() => provider);
    expect(autoVerdict({ autoApprove: false, alwaysAllow: ["web_search", "mcp__agents__web_search"] }, "web_search", "search the web", { call: searchCall })).toMatchObject({ approve: null, source: "always-ask" });
    expect(autoVerdict({ autoApprove: true }, "web_search", "search the web", { call: searchCall })).toEqual({ approve: "auto-approved web_search", source: "auto-mode", rule: undefined });
  });

  it("the setting is read on every call: a switch to a paid provider asks on the next call, and back", () => {
    let provider = "engine";
    setOwnWebSearchProviderProbe(() => provider);
    expect(routeDelivery(SEARCH, ctx())).toEqual(ALLOW);
    provider = "tavily";
    expect(routeDelivery(SEARCH, ctx())).toMatchObject({ route: "ask" });
    expect(autoVerdict({ autoApprove: false }, "web_search", "search the web", { call: searchCall }).approve).toBeNull();
    provider = "auto";
    expect(routeDelivery(SEARCH, ctx())).toEqual(ALLOW);
  });

  it("fail-closed: no probe, a probe that throws, no value or an unknown value is an ask", () => {
    const probes: Array<(() => string | undefined) | undefined> = [undefined, () => { throw new Error("config unreadable"); }, () => undefined, () => "", () => "ENGINE", () => "paid-new"];
    for (const probe of probes) {
      setOwnWebSearchProviderProbe(probe);
      expect(ownWebSearchRunsUnasked("own:agents", "web_search"), String(probe)).toBe(false);
      expect(routeDelivery(SEARCH, ctx()), String(probe)).toMatchObject({ route: "ask" });
      expect(autoVerdict({ autoApprove: false }, "web_search", "search the web", { call: searchCall }).approve, String(probe)).toBeNull();
    }
  });
});

describe("CODEX-WEB-1020: the exception is this one tool on this one mount, and the tables are as they were", () => {
  it("web_search is still an always-ask row and never an unasked one, so no engine pre-allows it", () => {
    setOwnWebSearchProviderProbe(() => "engine");
    expect(isOwnAlwaysAsk("own:agents", "web_search")).toBe(true);
    expect(isOwnUnasked("own:agents", "web_search")).toBe(false);
    expect(isOwnRead("own:agents", "web_search")).toBe(false);
  });

  it("no other tool or mount is let through on the free provider", () => {
    setOwnWebSearchProviderProbe(() => "engine");
    for (const tool of ["web_read", "publish_site", "take_down_site", "skill_manage", "register_artifact"]) {
      expect(ownWebSearchRunsUnasked("own:agents", tool), tool).toBe(false);
      expect(routeDelivery(delivery(`mcp__agents__${tool}`, {}), ctx()), tool).toMatchObject({ route: "ask", toolCall: { name: `mcp__agents__${tool}` } });
    }
    for (const mount of ["own:memory", "own:dweb", "custom:agents", "external:codex:0000000000000000:agents"]) expect(ownWebSearchRunsUnasked(mount, "web_search"), mount).toBe(false);
    expect(autoVerdict({ autoApprove: false, alwaysAllow: ["web_read", "mcp__agents__web_read"] }, "web_read", "read a page", { call: call("web_read", { url: "https://example.com/" }) })).toMatchObject({ approve: null, source: "always-ask" });
  });

  it("a server that is only named agents (custom, or two records of that name) is not that allow", () => {
    setOwnWebSearchProviderProbe(() => "engine");
    const custom = { engineName: "agents", mountId: "custom:agents", provenance: "custom" as const };
    expect(routeDelivery(SEARCH, ctx([custom]))).toEqual({ route: "allow", final: false, why: "custom" });
    expect(routeDelivery(SEARCH, ctx([OWN_AGENTS, custom]))).toMatchObject({ route: "ask" });
    expect(routeDelivery(SEARCH, ctx([]))).toMatchObject({ route: "ask" });
    const verdict = autoVerdict({ autoApprove: false }, "web_search", "search the web", { call: { engine: "codex", toolCall: { name: "mcp__agents__web_search", input: { query: "x" } }, mcpMounts: [custom] } });
    expect(verdict.source).not.toBe("own-unasked");
    expect(verdict.approve).toBeNull();
  });

  it("No limits is untouched: the call is an ask for the wipe check, as before", () => {
    setOwnWebSearchProviderProbe(() => "engine");
    expect(routeDelivery(SEARCH, ctx([OWN_AGENTS], { noLimits: true }))).toMatchObject({ route: "ask", tool: "mcp__agents__web_search" });
    expect(routeDelivery(delivery("web__run", { q: "x" }), ctx([OWN_AGENTS], { noLimits: true }))).toMatchObject({ route: "ask", tool: "web__run" });
  });
});

describe("CODEX-WEB-1020: a native web call is answered with the tool that works, never as an unknown tool", () => {
  it.each(CODEX_NATIVE_WEB_NAMES.map((name) => [name] as const))("%s on a turn with the own agents mount is denied with the own tool's name", (name) => {
    const out = routeDelivery(delivery(name, { search_query: [{ q: "weather" }] }), ctx());
    expect(out).toEqual({ route: "deny", reason: codexWebRedirect("agents") });
    expect(out).toMatchObject({ reason: expect.stringContaining("mcp__agents__web_search") });
    expect(out).toMatchObject({ reason: expect.stringContaining("mcp__agents__web_read") });
    expect(JSON.stringify(out)).not.toContain("does not know this tool");
  });

  it("web__run is one of those names (the customer's call)", () => {
    expect(CODEX_NATIVE_WEB_NAMES).toContain("web__run");
  });

  it("the words carry the mount's name as Codex writes it", () => {
    expect(routeDelivery(delivery("web__run", {}), ctx([{ engineName: "murage-agents", mountId: "own:agents", provenance: "own" }])))
      .toEqual({ route: "deny", reason: "That web tool is not on this turn. Search with mcp__murage_agents__web_search and open a page with mcp__murage_agents__web_read." });
  });

  it("it is always a deny, on the free provider too: the native call is never allowed or sent to a card below No limits", () => {
    setOwnWebSearchProviderProbe(() => "engine");
    for (const name of CODEX_NATIVE_WEB_NAMES) expect(routeDelivery(delivery(name, {}), ctx()).route, name).toBe("deny");
  });

  it("with no proven own agents mount, or two, the answer is the unknown-tool deny as before", () => {
    expect(routeDelivery(delivery("web__run", {}), ctx([]))).toEqual(UNKNOWN);
    expect(routeDelivery(delivery("web__run", {}), ctx([{ engineName: "agents", mountId: "custom:agents", provenance: "custom" }]))).toEqual(UNKNOWN);
    expect(routeDelivery(delivery("web__run", {}), ctx([{ engineName: "murage-memory", mountId: "own:memory", provenance: "own" }]))).toEqual(UNKNOWN);
    expect(routeDelivery(delivery("web__run", {}), ctx([OWN_AGENTS, { engineName: "agents2", mountId: "own:agents", provenance: "own" }]))).toEqual(UNKNOWN);
  });

  it("a name that only starts like one is still unknown, and every other unknown name is unchanged", () => {
    for (const name of ["web__run_evil", "web__runner", "xweb__run", "web_fetch", "shell_snapshot", "request_user_input", "write_stdin"]) {
      expect(routeDelivery(delivery(name, {}), ctx()), name).toEqual(UNKNOWN);
    }
  });
});

describe("CODEX-WEB-1020: the ChatGPT apps web tool a real Codex turn fell back to is answered the same way", () => {
  // the real delivery (gate box, Codex 0.167.2, 2026-11-19): approvals asked tool=search_service__web_run, level=ask, held=unread
  const REAL = "mcp__codex_apps__search_service__web_run";

  it("the real delivery is denied with the own tool's name, not carded", () => {
    expect(routeDelivery(delivery(REAL, { system2_search_query: [{ q: "node lts" }], open: [{ ref_id: "https://nodejs.org/en/download" }] }), ctx())).toEqual({ route: "deny", reason: codexWebRedirect("agents") });
  });

  it.each(CODEX_APPS_WEB_TOOLS.map((tool) => [tool] as const))("codex_apps/%s is denied the same way, on the free provider too", (tool) => {
    setOwnWebSearchProviderProbe(() => "engine");
    expect(routeDelivery(delivery(`mcp__codex_apps__${tool}`, {}), ctx())).toEqual({ route: "deny", reason: codexWebRedirect("agents") });
  });

  it("any other ChatGPT apps tool, and that tool name on another server, asks as before", () => {
    for (const name of ["mcp__codex_apps__gmail__search", "mcp__codex_apps__search_service__web_run_evil", "mcp__codex_apps2__search_service__web_run", "mcp__other__search_service__web_run"]) {
      expect(routeDelivery(delivery(name, {}), ctx()), name).toMatchObject({ route: "ask" });
    }
  });

  it("with no proven own agents mount it asks as before; a mount of this turn that is named codex_apps is judged as that mount", () => {
    expect(routeDelivery(delivery(REAL, {}), ctx([]))).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery(REAL, {}), ctx([{ engineName: "agents", mountId: "custom:agents", provenance: "custom" }]))).toMatchObject({ route: "ask" });
    expect(routeDelivery(delivery(REAL, {}), ctx([OWN_AGENTS, { engineName: "codex_apps", mountId: "custom:codex_apps", provenance: "custom" }]))).toEqual({ route: "allow", final: false, why: "custom" });
  });

  it("No limits is untouched: it is an ask for the wipe check", () => {
    expect(routeDelivery(delivery(REAL, {}), ctx([OWN_AGENTS], { noLimits: true }))).toMatchObject({ route: "ask", tool: REAL });
  });
});
