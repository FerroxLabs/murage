// C3 HL-WRITES-1019: real routing functions, isolated fake provider; no live engine or account.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { autoVerdict, type AutoContext, type AutoApprover } from "../auto-approve.ts";
import { claudeOwnUnaskedTools } from "../drivers/claude.ts";
import { cursorOwnReadAllow } from "../drivers/acp/cursor.ts";
import { HERMES_OWN_UNASKED_TOOLS, hermesAskMatcher } from "../drivers/acp/hermes.ts";
import { PHONE_JOBS_ENGINES } from "../phone-jobs-engines.ts";
import type { GrantCall } from "../../shared/app-action-grant.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";
import * as shared from "../../shared/highlevel.ts";

const path = "./engine-policy.ts";
// RED uses typeof guards: a missing slice module fails assertions, not module collection.
const policy: Partial<typeof import("./engine-policy.ts")> = await import(/* @vite-ignore */ path).catch(() => ({}));
const tools = [...Object.values(shared.HIGHLEVEL_FAMILY_TOOLS), ...shared.HIGHLEVEL_HELPER_NAMES];
const SENTINEL = "SENTINEL_C3_rm -rf /";
const own: McpMountRecord = { engineName: "highlevel", mountId: "own:highlevel", provenance: "own" };
const call = (name: string, mount = own): GrantCall => ({
  engine: "acp", mcpMounts: [mount], toolIdentity: { namespace: "mcp", name: `${mount.engineName}__${name}` },
  toolCall: { name: `mcp__${mount.engineName}__${name}`, input: { operation: "contacts.update", args: { contactId: "c1", firstName: SENTINEL, customFields: { nested: SENTINEL } } } },
});
const levels: Array<[string, AutoApprover, Partial<AutoContext>]> = [
  ["Ask", { id: "b" }, {}], ["Auto", { id: "b", autoApprove: true }, {}],
  ["Full access", { id: "b", autoApprove: true, fullAccess: true }, { fullAccessOrigin: "owner" }],
  ["No limits", { id: "b", autoApprove: true, fullAccess: true, noLimits: true }, { fullAccessOrigin: "owner", ownerStarted: true }],
  ["routine", { id: "b", autoApprove: true }, { routineLevel: true, fullAccessOrigin: "routine" }],
  ["unattended", { id: "b", autoApprove: true }, { unattended: true }],
  ["host scope", { id: "b" }, { scope: "local-computer" }],
];
const mounting = ["fuigoAgent", "grokAgent", "claudeAgent", "codex", "piAgent", "opencodeGo", "geminiAgent", "qwenAgent", "kimiAgent", "cursorAgent", "droidAgent", "hermesAgent", "clineAgent", "museCode", "copilotAgent", "customAcp"];
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("T9 engines.everyMountingEngineReachesHandler", () => {
  it("pins every mounting engine and all family tools plus helpers (MAIN adds eight families)", () => {
    expect(mounting.slice().sort()).toEqual(Object.entries(PHONE_JOBS_ENGINES).filter(([,s]) => s.mounts).map(([k]) => k).sort());
    expect(tools).toHaveLength(19);
    expect(policy.highlevelHandlerTools?.slice().sort()).toEqual(tools.slice().sort());
    const frozen = (shared as unknown as { HIGHLEVEL_FAMILY_TOOLS?: Record<string,string> }).HIGHLEVEL_FAMILY_TOOLS;
    if (frozen) expect(tools.slice(0, -2).sort()).toEqual(Object.values(frozen).sort());
  });
  for (const engine of mounting) it(`${engine}: exact preallow where available and common dispatcher policy at every trust level`, () => {
    for (const name of tools) {
      if (engine === "claudeAgent") expect(claudeOwnUnaskedTools("highlevel")).toContain(`mcp__highlevel__${name}`);
      if (engine === "cursorAgent") expect(cursorOwnReadAllow({ integrations: { highlevel: {} } } as never)).toContain(`Mcp(highlevel:${name})`);
      if (engine === "hermesAgent") {
        expect(HERMES_OWN_UNASKED_TOOLS).toContain(`mcp__highlevel__${name}`);
        expect(new RegExp(`^${hermesAskMatcher(false, false, undefined, true)}$`).test(`mcp__highlevel__${name}`)).toBe(false);
        expect(new RegExp(`^${hermesAskMatcher(false)}$`).test(`mcp__highlevel__${name}`)).toBe(true);
      }
      if (engine === "codex") expect(read("../drivers/codex.ts")).toContain('mount("highlevel", turn.integrations.highlevel, true, "own:highlevel")');
      // Pi's exact preallow rows are C1-owned; its dispatcher/backstop still reaches the same handler.
      for (const [level, bot, context] of levels) {
        const verdict = autoVerdict(bot, `highlevel__${name}`, SENTINEL, { ...context, call: call(name) });
        expect(verdict, `${engine}/${name}/${level}`).toMatchObject({ source: "own-unasked", rule: `own:highlevel/${name}` });
        expect(verdict.approve).not.toBeNull();
        expect(JSON.stringify(verdict)).not.toContain(SENTINEL);
      }
    }
  });
  it("only exact own provenance releases a family tool; questions and custom mounts remain held", () => {
    expect(typeof policy.highlevelEngineAsk).toBe("function");
    const custom = call("HIGHLEVEL_CONTACTS", { ...own, mountId: "custom:highlevel", provenance: "custom" });
    expect(autoVerdict({ id: "b" }, "HIGHLEVEL_CONTACTS", SENTINEL, { call: custom }).approve).toBeNull();
    expect(autoVerdict({ id: "b" }, "HIGHLEVEL_CONTACTS", SENTINEL, { call: call("HIGHLEVEL_CONTACTS"), question: true }).approve).toBeNull();
    expect(policy.highlevelEngineAsk!(call("HIGHLEVEL_UNKNOWN"), "marked")).toEqual({ kind: "deny" });
  });
});

describe("T9b engines without HighLevel", () => {
  for (const kind of ["antigravityAgent", "openclawAgent", "grok", "minimax", "openai-compat", "boxAgent", "unknown"]) it(`${kind}: no offered engine route`, () => {
    expect(typeof policy.highlevelEngineSupported).toBe("function");
    expect(policy.highlevelEngineSupported!(kind)).toBe(false);
  });
});

describe("backstop", () => {
  it("backstop.titleOnlyKindOtherDeniedNoRow", async () => {
    expect(typeof policy.deliverHighlevelEngineAsk).toBe("function");
    const request: GrantCall = { engine: "acp", toolKind: "other", mcpMounts: [own], toolCall: { name: "other", input: { title: "HIGHLEVEL_CONTACTS", body: SENTINEL } } };
    const respond = vi.fn(async () => undefined), fallback = vi.fn();
    const ask = policy.highlevelEngineAsk!(request, "marked");
    expect(ask).toEqual({ kind: "deny" });
    await policy.deliverHighlevelEngineAsk!(ask!, { respond, canFallback: () => true, fallback } as never);
    expect(respond).toHaveBeenCalledWith({ behavior: "deny", message: expect.any(String) });
    expect(fallback).not.toHaveBeenCalled();
  });
  it("backstop.bareNameDeniedNoRow", async () => {
    expect(typeof policy.highlevelEngineAsk).toBe("function");
    const request: GrantCall = { engine: "acp", toolKind: "other", mcpMounts: [own], toolCall: { name: "HIGHLEVEL_CONTACTS", input: { body: SENTINEL } } };
    expect(policy.highlevelEngineAsk!(request, "marked")).toEqual({ kind: "deny" });
    expect(policy.highlevelEngineAsk!({ engine: "acp", toolKind: "other" }, "marked")).toEqual({ kind: "deny" });
    expect(policy.highlevelEngineAsk!({ engine: "acp", toolKind: "other" }, "unmarked")).toBeUndefined();
  });
  it("T17 r2 failed own delivery never publishes a HighLevel ask row", async () => {
    expect(typeof policy.deliverHighlevelEngineAsk).toBe("function");
    const ask = policy.highlevelEngineAsk!(call("HIGHLEVEL_CONTACTS"), "marked")!;
    const rows = vi.fn(), respond = vi.fn(async () => { throw new Error(SENTINEL); });
    // An old implementation's fallback callback would publish a row. r2 withdraws it.
    await policy.deliverHighlevelEngineAsk!(ask, { respond, canFallback: () => true, fallback: rows } as never);
    expect(rows).not.toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith({ behavior: "deny", message: expect.any(String) });
    respond.mockClear();
    await policy.deliverHighlevelEngineAsk!({ kind: "deny" }, { respond, canFallback: () => true });
    expect(respond).toHaveBeenCalledOnce();
  });
  it("r2 every engine list derives only from the nineteen frozen tools", () => {
    expect(claudeOwnUnaskedTools("highlevel").sort()).toEqual(tools.map(t => `mcp__highlevel__${t}`).sort());
    expect(HERMES_OWN_UNASKED_TOOLS.filter(t => t.startsWith("mcp__highlevel__")).sort()).toEqual(tools.map(t => `mcp__highlevel__${t}`).sort());
    expect(read("./engine-policy.ts")).not.toContain("provisionalFamilies");
  });
  it("index consumes the backstop before generic verdicts, cardDetail and fallback rows", () => {
    const index = read("../index.ts");
    const start = index.indexOf('const highlevelBackstop =');
    expect(start).toBeGreaterThan(0);
    const end = index.indexOf('const denyAutomatically =', start);
    expect(end).toBeGreaterThan(start);
    const branch = index.slice(start, end);
    expect(branch).toContain('const highlevelBackstop = highlevelEngineRequest(event,');
    expect(branch).toContain('if (highlevelBackstop) {\n        if (!event.requestId) break;');
    expect(branch).toContain('deliverHighlevelEngineAsk(');
    for (const banned of ['cardDetail(', 'pushMessage(', 'appendDecision(', 'broadcast(', 'fallback:', 'allowKey:', 'toolInput:', 'event.summary', 'event.tool,']) expect(branch).not.toContain(banned);
  });
});

// r2 retains the ORIGINAL event privately; C3 never reconstructs identity from a projected frame.
it("F0 original request resolves the handler and the generation-keyed ledger alone relaxes other calls", () => {
  expect(typeof policy.installHighlevelEngineLedger).toBe("function");
  const classOf = vi.fn(() => "highlevel" as "highlevel" | "other");
  policy.installHighlevelEngineLedger!({ classOf });
  const original = { type: "request.opened", threadId: "t", turnId: "g", itemId: "i", requestId: "r", toolEngine: "acp", ...call("HIGHLEVEL_CONTACTS") };
  expect(policy.highlevelEngineRequest!(original as never, "marked")).toMatchObject({ kind: "own", tool: "HIGHLEVEL_CONTACTS" });
  expect(classOf).toHaveBeenCalledWith("t", "g", "i");
  const other = { ...original, toolIdentity: undefined, toolCall: undefined };
  expect(policy.highlevelEngineRequest!(other as never, "marked")).toEqual({ kind: "deny" });
  classOf.mockReturnValue("other");
  expect(policy.highlevelEngineRequest!(other as never, "marked")).toBeUndefined();
  policy.installHighlevelEngineLedger!({ classOf: () => { throw new Error(SENTINEL); } });
  expect(policy.highlevelEngineRequest!(other as never, "marked")).toEqual({ kind: "deny" });
  policy.installHighlevelEngineLedger!(undefined);
});

it("backstop.resolvesWhenLogSuppressed", async () => {
  const { EventBus } = await import("../harness/bus.ts");
  const log = vi.fn(), respond = vi.fn(async () => undefined), bus = new EventBus(log);
  // This C3 regression proves private delivery while logging is suppressed.
  // F0's highlevelProjection is a C4 stub; its real projection path still needs
  // the C4/S-INT integration test and must not be inferred from method presence.
  bus.omitLog(() => true);
  const original = { type: "request.opened", threadId: "isolated-c3-backstop", itemId: "i", requestId: "r", toolEngine: "acp", ...call("HIGHLEVEL_CONTACTS") };
  const deliveries: Promise<void>[] = [];
  bus.subscribe(event => {
    expect(event).toBe(original);
    const ask = policy.highlevelEngineRequest!(event, "marked");
    expect(ask).toMatchObject({ kind: "own", tool: "HIGHLEVEL_CONTACTS" });
    deliveries.push(policy.deliverHighlevelEngineAsk!(ask!, { respond, canFallback: () => false }));
  }, { durable: true });
  bus.publish(original as never);
  await Promise.all(deliveries);
  expect(respond).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
});

it("F0 ledger relaxation cannot cross a thread or generation or invent a missing key", () => {
  const classOf = vi.fn((thread: string, generation: string, item: string) =>
    thread === "t" && generation === "g" && item === "i" ? "other" as const : "highlevel" as const);
  policy.installHighlevelEngineLedger!({ classOf });
  const original = { type: "request.opened", threadId: "t", turnId: "g", itemId: "i", requestId: "r" };
  try {
    expect(policy.highlevelEngineRequest!(original as never, "marked")).toBeUndefined();
    for (const change of [{ threadId: "other" }, { turnId: "old" }, { turnId: undefined }, { itemId: undefined }, { itemId: undefined, requestId: undefined }]) {
      expect(policy.highlevelEngineRequest!({ ...original, ...change } as never, "marked")).toEqual({ kind: "deny" });
    }
    expect(classOf).toHaveBeenLastCalledWith("t", "g", "");
    expect(policy.highlevelEngineRequest!({ ...original, itemId: undefined, requestId: "i" } as never, "marked")).toBeUndefined();
    expect(classOf).toHaveBeenLastCalledWith("t", "g", "i");
  } finally { policy.installHighlevelEngineLedger!(undefined); }
});
