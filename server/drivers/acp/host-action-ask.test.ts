// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Host-computer approvals that do not depend on the engine.
//
// 1. Kimi, Droid and Cursor ask for Murage's computer tools by title only
//    (real gate, Linux: kimi 2.2.0 sent `{"method":"session/request_permission",
//    "params":{"toolCall":{"title":"mcp__computer__click"}}}` with no kind;
//    Droid and Cursor sent kind "other"), which Rule 9 never trusts, so every
//    such ask was a card even at Auto. Those engines now run the computer mount
//    unasked, and Murage's computer service asks per action by the exact tool
//    (adapter.askHostAction): the card is judged as a proven call.
// 2. Read-only computer actions (the screen, the windows) are no card at any
//    level on any engine; a click asks once at Ask. Packaged Mac app, Fuigo at
//    Ask: one click took 11 "Local computer approval" cards, one per screenshot
//    and window read. Claude at Ask on the gate (1.0.3 capgate) took 8 cards
//    for list_windows, get_desktop_state x3, get_window_state and 3 clicks.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { resolveCall, type GrantCall } from "../../../shared/app-action-grant.ts";
import { autoVerdict, type AutoApprover } from "../../auto-approve.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

process.env.MURAGE_ACP_MCP_READY_MS ??= "300";
process.env.MURAGE_ACP_MCP_OWN_READY_MS ??= "200";
process.env.MURAGE_ACP_MCP_LISTED_MS ??= "200";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const SUPPORT: AcpSupport = {
  driverKind: "hostAskTest",
  displayName: "Host Ask Test",
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  defaultCli: "fake",
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const ServiceAsks = createAcpDriver({ ...SUPPORT, hostComputerAskedByMurage: true });
const EngineAsks = createAcpDriver(SUPPORT);

const HOST = { localComputer: { command: process.execPath, args: ["/fake/cua-driver.js"], env: {}, platform: "linux" as const, scope: "local-computer" as const } };

const ASK: AutoApprover = { autoApprove: false };
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };

const callOf = (opened: any): GrantCall => ({
  toolCall: opened.toolCall, toolIdentity: opened.toolIdentity, toolKind: opened.toolKind,
  mcpMounts: opened.mcpMounts, engine: opened.toolEngine, inputMissing: opened.toolInputMissing,
});
const verdict = (bot: AutoApprover, opened: any) => autoVerdict(bot, opened.tool, opened.summary, { call: callOf(opened), scope: opened.approvalScope });
/** Cards a person sees for a sequence of asks: every one Murage does not answer. */
const cards = (bot: AutoApprover, asks: any[]) => asks.filter((opened) => verdict(bot, opened).approve === null).length;

describe("Murage's computer service asks for an engine that runs the computer mount unasked", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-host-ask-"));
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PERMISSION_TOOLCALL;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  /** A running turn (the fake engine holds one shell ask open), then a host action through the service. */
  const running = async (driver: typeof ServiceAsks, threadId: string) => {
    process.env.FAKE_ACP_MODE = "permission";
    process.env.FAKE_ACP_PERMISSION_TOOLCALL = JSON.stringify({ toolCallId: "tc-shell", kind: "execute", title: "ls", rawInput: { command: "ls" } });
    instance = await driver.create({ instanceId: "host-ask", displayName: "Host Ask", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch, integrations: HOST } as any);
    return (await recorder.until((e) => e.type === "request.opened" && (e as any).tool === "shell")) as any;
  };

  it("asks once per action with the exact tool, a deny stops it and an allow lets it run", async () => {
    const shell = await running(ServiceAsks, "t-host-ask");
    const denied = instance!.adapter.askHostAction!("t-host-ask", { name: "click", arguments: { x: 10, y: 10 } });
    const opened = (await recorder!.until((e) => e.type === "request.opened" && (e as any).tool === "mcp__computer__click")) as any;
    expect(opened).toMatchObject({ approvalScope: "local-computer", requestType: "permission", toolEngine: "acp",
      toolIdentity: { namespace: "mcp", name: "computer__click" }, toolCall: { name: "mcp__computer__click", input: { x: 10, y: 10 } } });
    expect(resolveCall(callOf(opened))).toMatchObject({ kind: "mcp", mountId: "own:computer", provenance: "own", tool: "click" });
    expect(await instance!.adapter.respondToRequest("t-host-ask", opened.requestId, { behavior: "deny" })).toBe("rejected");
    expect(await denied).toBe("deny");

    const allowed = instance!.adapter.askHostAction!("t-host-ask", { name: "type_text", arguments: { text: "hi" } });
    const second = (await recorder!.until((e) => e.type === "request.opened" && (e as any).tool === "mcp__computer__type_text")) as any;
    expect(await instance!.adapter.respondToRequest("t-host-ask", second.requestId, { behavior: "allow" })).toBe("allowed-once");
    expect(await allowed).toBe("allow");

    // the engine withdrew the call (its MCP request was cancelled, so the proxy's request closed): the card closes, nothing runs
    const controller = new AbortController();
    const withdrawn = instance!.adapter.askHostAction!("t-host-ask", { name: "drag", arguments: {} }, controller.signal);
    const third = (await recorder!.until((e) => e.type === "request.opened" && (e as any).tool === "mcp__computer__drag")) as any;
    controller.abort();
    expect(await withdrawn).toBe("deny");
    expect(await recorder!.until((e) => e.type === "request.resolved" && (e as any).requestId === third.requestId)).toMatchObject({ behavior: "deny", source: "system" });
    expect(await instance!.adapter.respondToRequest("t-host-ask", third.requestId, { behavior: "allow" })).toBe("unavailable");

    await instance!.adapter.respondToRequest("t-host-ask", shell.requestId, { behavior: "deny" });
    await recorder!.until((e) => e.type === "turn.completed");
    // the turn is gone: nothing can be asked, and the service then has no turn to act for either
    expect(await instance!.adapter.askHostAction!("t-host-ask", { name: "click" })).toBeNull();
  }, 30000);

  it("asks nothing for an engine that asks for the computer itself (one card, never two)", async () => {
    const shell = await running(EngineAsks, "t-engine-asks");
    expect(await instance!.adapter.askHostAction!("t-engine-asks", { name: "click" })).toBeNull();
    await instance!.adapter.respondToRequest("t-engine-asks", shell.requestId, { behavior: "deny" });
    await recorder!.until((e) => e.type === "turn.completed");
  }, 30000);

  it("a screenshot then a click at Ask is exactly one card through the service; reads are no card at Auto and Full access", async () => {
    const shell = await running(ServiceAsks, "t-host-count");
    const asks: any[] = [];
    for (const [name, args] of [["get_desktop_state", {}], ["get_window_state", { window_id: 7 }], ["list_windows", {}], ["click", { x: 1, y: 1 }]] as const) {
      const pending = instance!.adapter.askHostAction!("t-host-count", { name, arguments: args });
      const opened = (await recorder!.until((e) => e.type === "request.opened" && (e as any).tool === `mcp__computer__${name}`)) as any;
      asks.push(opened);
      await instance!.adapter.respondToRequest("t-host-count", opened.requestId, { behavior: "allow" });
      await pending;
    }
    expect(cards(ASK, [asks[0], asks[3]])).toBe(1);
    expect(cards(ASK, asks)).toBe(1);
    expect(verdict(ASK, asks[3]).approve).toBeNull();
    for (const bot of [ASK, AUTO, FULL]) for (const read of asks.slice(0, 3)) expect(verdict(bot, read).approve, JSON.stringify(bot)).toEqual(expect.any(String));
    await instance!.adapter.respondToRequest("t-host-count", shell.requestId, { behavior: "deny" });
    await recorder!.until((e) => e.type === "turn.completed");
  }, 30000);
});

describe("read-only computer actions are no card on every engine's ask", () => {
  const mounts = [{ engineName: "computer", mountId: "own:computer", provenance: "own" }];
  /** Claude's own ask for an MCP tool (claude.ts request.opened). */
  const claude = (name: string, input: object = {}) => ({ tool: `mcp__computer__${name}`, summary: name, approvalScope: "local-computer",
    toolEngine: "claude", toolCall: { name: `mcp__computer__${name}`, input }, mcpMounts: mounts });
  /** Fuigo's dispatcher ask, stamped fuigo/tool use_tool (Grok Build's x.ai/tool restamped the same way). */
  const fuigo = (name: string, input: object = {}) => ({ tool: "other", summary: "Use Tool", approvalScope: "local-computer", toolEngine: "acp", toolKind: "other",
    toolIdentity: { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" },
    toolCall: { name: "other", input: { variant: "UseTool", tool_name: `computer__${name}`, tool_input: input } }, mcpMounts: mounts });

  /** Codex's PreToolUse hook ask (codex-hook.ts routeDelivery, real gate card "Approval needed", tool "list_windows"). */
  const codex = (name: string, input: object = {}) => ({ tool: name, summary: name, toolEngine: "codex",
    toolCall: { name: `mcp__computer__${name}`, input }, mcpMounts: mounts });

  it.each([["Claude", claude], ["Codex", codex], ["Fuigo and Grok Build", fuigo]])("%s: a screenshot then a click at Ask is exactly one card", (_label, shape) => {
    const shot = shape("get_desktop_state");
    const click = shape("click", { x: 1, y: 1 });
    expect(cards(ASK, [shot, click])).toBe(1);
    expect(verdict(ASK, click).approve).toBeNull();
    for (const name of ["get_desktop_state", "get_window_state", "list_windows", "screenshot", "zoom", "get_accessibility_tree"]) {
      for (const bot of [ASK, AUTO, FULL]) expect(verdict(bot, shape(name)).approve, `${name} ${JSON.stringify(bot)}`).toEqual(expect.any(String));
    }
    // every action that changes something still asks at Ask
    for (const name of ["click", "type_text", "press_key", "hotkey", "drag", "scroll", "launch_app", "kill_app", "clipboard_read", "clipboard_write", "browser_navigate", "set_value"]) {
      expect(verdict(ASK, shape(name)).approve, name).toBeNull();
    }
  });

  it("never by title: a read named only in a title, or on a server that is not Murage's computer, still asks", () => {
    const titled = { tool: "other", summary: "mcp__computer__get_desktop_state", approvalScope: "local-computer", toolEngine: "acp", toolKind: "other",
      toolCall: { name: "other", input: {} }, mcpMounts: mounts };
    expect(verdict(ASK, titled).approve).toBeNull();
    expect(verdict(AUTO, titled).approve).toBeNull();
    const custom = { ...claude("get_desktop_state"), tool: "mcp__mydesk__get_desktop_state", toolCall: { name: "mcp__mydesk__get_desktop_state", input: {} },
      mcpMounts: [...mounts, { engineName: "mydesk", mountId: "custom:mydesk", provenance: "custom" }] };
    expect(verdict(ASK, custom).approve).toBeNull();
  });
});
