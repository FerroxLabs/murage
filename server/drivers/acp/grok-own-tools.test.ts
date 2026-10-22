// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Grok Build files every MCP call through its `use_tool` dispatcher and
// stamps it under `_meta["x.ai/tool"]` (namespace `grok_build`), where Fuigo
// stamps `fuigo/tool` (`fuigo_build`). Murage read only Fuigo's key, so on
// Grok its own tools (the roster, memory, the app-tool lookup) were
// unproven kind "other" asks that held a card at Auto and at Full access.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { resolveCall, type GrantCall } from "../../../shared/app-action-grant.ts";
import { plainApproval } from "../../../shared/approval-plain.ts";
import { cardDetail } from "../../approval-text.ts";
import { autoVerdict, type AutoApprover } from "../../auto-approve.ts";
import * as core from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";

vi.mock("node:child_process", async (original) => (await import("../../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

// the fake CLI announces no MCP readiness: keep the waits for it short
process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** The stamp Grok Build 1.0.62 puts on its dispatcher (CanonicalToolMeta). */
const GROK_USE_TOOL = { "x.ai/tool": { version: 1, namespace: "grok_build", name: "use_tool", kind: "use_tool", label: "Use Tool", read_only: false } };
const useTool = (toolName: string, toolInput: object, meta: object = GROK_USE_TOOL, title = "Use Tool") => ({
  toolCallId: `call-${toolName}`, kind: "other", title,
  rawInput: { variant: "UseTool", tool_name: toolName, tool_input: toolInput }, _meta: meta,
});

const proxy = (name: string) => ({ command: process.execPath, args: [`/fake/${name}.js`], env: {} });
const OWN = { agents: proxy("agents-proxy"), memory: proxy("memory-proxy"), composio: proxy("composio-mcp") };

const ASK: AutoApprover = { autoApprove: false };
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };

describe("Murage's own tools through Grok Build's use_tool", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-grok-own-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  const asked = async (id: string, toolCall: object, integrations: object = OWN, driver = GrokAgentDriver) => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify(toolCall);
    instance = await driver.create({ instanceId: "acp-test", displayName: "ACP Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: id, text: "go", integrations } as any);
    const opened = (await recorder.until((e) => e.type === "request.opened")) as any;
    await instance.adapter.respondToRequest(id, opened.requestId, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    return opened;
  };
  const callOf = (opened: any): GrantCall => ({
    toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
    mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing,
  });
  const verdictAt = (bot: AutoApprover, opened: any) => autoVerdict(bot, opened.tool, opened.summary, { call: callOf(opened) });

  it.each([
    ["the roster", "agents__list_bots", {}, "own:agents", "see your bots"],
    ["memory", "murage-memory__memory_search", { query: "the launch plan" }, "own:memory", "search its memory"],
  ])("runs %s without a card at Ask, Auto and Full access, and names it in plain words", async (_label, toolName, toolInput, mountId, action) => {
    const opened = await asked(`t-own-${toolName}`, useTool(toolName, toolInput));
    expect(opened.toolIdentity).toEqual({ namespace: "fuigo_build", name: "use_tool", kind: "use_tool" });
    expect(resolveCall(callOf(opened))).toMatchObject({ kind: "mcp", mountId, provenance: "own" });

    const auto = verdictAt(AUTO, opened);
    expect(auto).toMatchObject({ source: "own-unasked" });
    expect(auto.approve).toEqual(expect.any(String));
    expect(verdictAt(FULL, opened).approve).toEqual(expect.any(String));

    // Ask too, as on Claude and Codex: an own read on the turn's own mount is no card
    const ask = verdictAt(ASK, opened);
    expect(ask).toMatchObject({ source: "own-unasked" });
    expect(ask.approve).toEqual(expect.any(String));
    const plain = plainApproval(opened.tool, cardDetail(opened));
    expect(plain?.action).toBe(action);
    expect(JSON.stringify(plain)).not.toMatch(/Variant|UseTool|Tool name/);
  });

  // 1c360d3d1: Grok Build 1.0.62 stamps its dispatcher `x.ai/tool` (grok_build); restamped, the inner
  // `computer__click` resolves on this turn's own computer mount. The gate's grokcli A2 (built before it)
  // carded every host action at Auto as kind "other".
  it("reads the x.ai/tool stamp on a host-computer call: at Auto a screenshot and a click run with no card, at Ask only the click asks", async () => {
    const host = { ...OWN, localComputer: { command: process.execPath, args: ["/fake/cua-driver.js"], env: {}, platform: "linux", scope: "local-computer" } };
    const verdict = (bot: AutoApprover, opened: any) => autoVerdict(bot, opened.tool, opened.summary, { call: callOf(opened), scope: opened.approvalScope });
    const shot = await asked("t-grok-shot", useTool("computer__get_desktop_state", {}), host);
    const click = await asked("t-grok-click", useTool("computer__click", { x: 10, y: 10 }), host);
    for (const opened of [shot, click]) {
      expect(opened.approvalScope).toBe("local-computer");
      expect(opened.toolIdentity).toEqual({ namespace: "fuigo_build", name: "use_tool", kind: "use_tool" });
      expect(resolveCall(callOf(opened))).toMatchObject({ kind: "mcp", mountId: "own:computer", provenance: "own" });
    }
    expect(verdict(AUTO, shot).approve).toEqual(expect.any(String));
    expect(verdict(AUTO, click).approve).toEqual(expect.any(String));
    expect(verdict(ASK, shot).approve).toEqual(expect.any(String));
    expect(verdict(ASK, click).approve).toBeNull();
    // the same call unstamped (the gate's build) is unproven: held even at Auto
    const unstamped = await asked("t-grok-unstamped", { ...useTool("computer__click", { x: 10, y: 10 }), _meta: {} }, host);
    expect(verdict(AUTO, unstamped).approve).toBeNull();
  });

  it("answers the app-tool lookup at Ask, Auto and Full access and never reads it as an action it could not read whole", async () => {
    const opened = await asked("t-own-lookup", useTool("murage_connectors__APPS_SEARCH_TOOLS", { queries: [{ use_case: "send the weekly email" }] }));
    expect(resolveCall(callOf(opened))).toMatchObject({ kind: "mcp", mountId: "own:connector", own: true });
    const auto = verdictAt(AUTO, opened);
    expect(auto.source).not.toBe("unread-call");
    expect(auto.approve).toEqual(expect.any(String));
    expect(verdictAt(FULL, opened).approve).toEqual(expect.any(String));
    expect(verdictAt(ASK, opened)).toMatchObject({ source: "own-unasked" });
    expect(verdictAt(ASK, opened).approve).toEqual(expect.any(String));
    expect(plainApproval(opened.tool, cardDetail(opened))?.action).toBe("look up which app tools to use");
  });

  it("keeps asking for a third-party tool and holds one it cannot prove", async () => {
    const custom = { ...OWN, custom: { notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: {} } } };
    const third = await asked("t-third", useTool("notes__send_note", { to: "someone@example.com", text: "hi" }), custom);
    expect(resolveCall(callOf(third))).toMatchObject({ kind: "mcp", mountId: "custom:notes", provenance: "custom" });
    expect(verdictAt(AUTO, third).source).not.toBe("own-unasked");
    expect(verdictAt(ASK, third).approve).toBeNull();

    // a server this turn never mounted: unproven, held even at Full access
    const stranger = await asked("t-stranger", useTool("stranger__wipe", {}));
    expect(verdictAt(AUTO, stranger)).toMatchObject({ approve: null, source: "unread-call" });
    expect(verdictAt(FULL, stranger).approve).toBeNull();

    // an own name with no own mount handed to the turn is not Murage's own
    const spoof = await asked("t-spoof", useTool("agents__list_bots", {}), { custom: { other: { command: "npx", args: ["x"], env: {} } } });
    expect(verdictAt(AUTO, spoof)).toMatchObject({ approve: null, source: "unread-call" });
    expect(verdictAt(ASK, spoof).approve).toBeNull();

    // an own tool that asks on every engine by design still asks
    const site = await asked("t-own-ask", useTool("agents__publish_site", { name: "x" }));
    expect(verdictAt(AUTO, site).source).not.toBe("own-unasked");
    expect(verdictAt(ASK, site).approve).toBeNull();

    // an own write keeps Ask's card (Auto answers it), in plain words
    const save = await asked("t-own-write", useTool("murage-memory__memory_save", { text: "the launch is Friday" }));
    expect(verdictAt(ASK, save).approve).toBeNull();
    expect(verdictAt(AUTO, save)).toMatchObject({ source: "own-unasked" });
    expect(plainApproval(save.tool, cardDetail(save))?.action).toBe("save a note to its memory");
    const create = await asked("t-own-create", useTool("agents__create_bot", { name: "Helper" }));
    expect(verdictAt(ASK, create).approve).toBeNull();

    // every hold below holds at Ask too

    // a Grok stamp in a namespace Murage does not read stays unproven
    const odd = await asked("t-odd", useTool("agents__list_bots", {}, { "x.ai/tool": { version: 1, namespace: "codex", name: "use_tool", kind: "use_tool" } }));
    expect(verdictAt(AUTO, odd)).toMatchObject({ approve: null, source: "unread-call" });
    expect(verdictAt(ASK, odd).approve).toBeNull();

    // the title alone never names the tool
    const titled = await asked("t-titled", { toolCallId: "k", kind: "other", title: "agents__list_bots", rawInput: {} });
    expect(verdictAt(AUTO, titled)).toMatchObject({ approve: null, source: "unread-call" });
    expect(verdictAt(ASK, titled).approve).toBeNull();
    expect(verdictAt(ASK, stranger).approve).toBeNull();
  }, 240_000);

  it("runs an own write unattended at Auto, as Claude and Codex do, and keeps Ask's card for it", async () => {
    const ask = await asked("t-own-unattended", useTool("agents__ask_bot", { bot_id: "helper", message: "draft the intro" }));
    expect(resolveCall(callOf(ask))).toMatchObject({ kind: "mcp", mountId: "own:agents", tool: "ask_bot" });
    const unattended = autoVerdict(AUTO, ask.tool, ask.summary, { call: callOf(ask), unattended: true });
    expect(unattended).toMatchObject({ source: "own-unasked" });
    expect(unattended.approve).toEqual(expect.any(String));
    expect(autoVerdict(ASK, ask.tool, ask.summary, { call: callOf(ask), unattended: true }).approve).toBeNull();
    expect(verdictAt(ASK, ask).approve).toBeNull();
  });

  it("holds an own read whose arguments name a key file, at every level", async () => {
    for (const [id, query] of [["t-key-ssh", "~/.ssh/id_rsa"], ["t-key-aws", "cat ~/.aws/credentials"]] as const) {
      const opened = await asked(id, useTool("murage-memory__memory_search", { query }));
      expect(resolveCall(callOf(opened))).toMatchObject({ kind: "mcp", mountId: "own:memory", provenance: "own" });
      for (const bot of [ASK, AUTO, FULL]) {
        const verdict = verdictAt(bot, opened);
        expect(verdict.approve, `${query} at ${JSON.stringify(bot)}`).toBeNull();
        expect(verdict.source).toBe("sensitive-guard");
      }
    }
  }, 120_000);

  it.each([
    ["an execute with no command", { toolCallId: "n1", kind: "execute", title: "Run Command", rawInput: { variant: "Bash", is_background: false },
      _meta: { "x.ai/tool": { version: 1, namespace: "grok_build", name: "run_terminal_command", kind: "execute", label: "Run Command", read_only: false } } }],
    ["an edit with no path", { toolCallId: "n2", kind: "edit", title: "Write", rawInput: { variant: "Write", content: "x" },
      _meta: { "x.ai/tool": { version: 1, namespace: "grok_build", name: "write", kind: "edit", label: "Write", read_only: false } } }],
    ["a delete with no path", { toolCallId: "n3", kind: "delete", title: "Delete", rawInput: { variant: "Delete" },
      _meta: { "x.ai/tool": { version: 1, namespace: "grok_build", name: "delete", kind: "delete", label: "Delete", read_only: false } } }],
  ])("holds Grok's stamped native tool at Full access when it is %s", async (_label, toolCall) => {
    const opened = await asked(`t-native-${(toolCall as { toolCallId: string }).toolCallId}`, toolCall);
    expect(resolveCall(callOf(opened))).toMatchObject({ kind: "engine", wrapped: false });
    expect(verdictAt(FULL, opened)).toMatchObject({ approve: null, source: "unread-call" });
    expect(verdictAt(AUTO, opened).approve).toBeNull();
  });

  it("still answers Grok's stamped native execute at Full access when it carries its command", async () => {
    const opened = await asked("t-native-ok", { toolCallId: "n4", kind: "execute", title: "Run Command", rawInput: { variant: "Bash", command: "ls", is_background: false },
      _meta: { "x.ai/tool": { version: 1, namespace: "grok_build", name: "run_terminal_command", kind: "execute", label: "Run Command", read_only: false } } });
    expect(verdictAt(FULL, opened).approve).toEqual(expect.any(String));
  });

  it("judges Fuigo's own stamp the same way", () => {
    const fuigo = (toolName: string, mounts = [{ engineName: "agents", mountId: "own:agents", provenance: "own" as const }]): GrantCall => ({
      toolCall: { name: "other", input: { variant: "UseTool", tool_name: toolName, tool_input: {} } },
      toolIdentity: { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" }, toolKind: "other", mcpMounts: mounts, engine: "acp",
    });
    expect(autoVerdict(AUTO, "other", "Use Tool", { call: fuigo("agents__list_bots") })).toMatchObject({ source: "own-unasked" });
    expect(autoVerdict(ASK, "other", "Use Tool", { call: fuigo("agents__list_bots") })).toMatchObject({ source: "own-unasked" });
    expect(autoVerdict(ASK, "other", "Use Tool", { call: fuigo("agents__update_bot") }).approve).toBeNull();
    expect(autoVerdict(ASK, "other", "Use Tool", { call: fuigo("agents__list_bots", []) }).approve).toBeNull();
    expect(autoVerdict(AUTO, "other", "Use Tool", { call: fuigo("agents__list_bots", []) })).toMatchObject({ approve: null, source: "unread-call" });
  });

  it("restamps a session update's tool row the same way", () => {
    const restamp = (core as Record<string, unknown>).acpRestampFrame as ((msg: unknown, stamp: unknown) => void) | undefined;
    expect(restamp).toBeTypeOf("function");
    const frame = { method: "session/update", params: { update: { sessionUpdate: "tool_call", _meta: { ...GROK_USE_TOOL } } } };
    restamp!(frame, { key: "x.ai/tool", namespaces: { grok_build: "fuigo_build" } });
    expect(frame.params.update._meta).toEqual({ "fuigo/tool": { ...GROK_USE_TOOL["x.ai/tool"], namespace: "fuigo_build" } });
    expect(core.acpStampedIdentity({ _meta: frame.params.update._meta })).toEqual({ namespace: "fuigo_build", name: "use_tool", kind: "use_tool" });
  });
});
