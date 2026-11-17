import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
vi.mock("../../hook-safety.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../hook-safety.ts")>(),
  checkAllHookCanon: () => true,
}));
import { type AcpSupport } from "./core.ts";
import { createFixtureAcpDriver as createAcpDriver } from "../../testing/acp-support-fixture.ts";
import { hermesAcpSupport, hermesAskMatcher, hermesOwnUnasked } from "./hermes.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { ensureDirs } from "../../config.ts";
import { installNativeReleaseReader } from "../../decision/provider-release.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { HERMES_VERSION_PIN } from "../../../shared/tool-identity.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const traces = readFileSync(new URL("../../testing/fixtures/tool-identity-r1.2/hermes_traces.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
let instance: ProviderInstance | undefined;
let home = "";
afterEach(async () => { await instance?.dispose(); instance = undefined; if (home) removeTempDirSync(home); home = ""; });

it("production Hermes enables correlation and excludes only C1 through C4", () => {
  expect(hermesAcpSupport.toolCorrelationContext).toBeTypeOf("function");
  const matcher = new RegExp(`^(?:${hermesAskMatcher(true)})$`);
  for (const name of ["memory", "todo_list", "clarify", "session_search", "tool_describe", "video_analyze", "show_tip", "read_terminal", "read_window_below", "x_search", "mcp__computer__", "mcp__computer__click.evil"]) expect(matcher.test(name), name).toBe(true);
  for (const name of ["read_file", "search_files", "skills_list", "skill_view", "vision_analyze", "web_search", "web_extract", "write_file", "patch", ...hermesOwnUnasked(), "mcp__computer__click"]) expect(matcher.test(name), name).toBe(false);
});

// Exercise the production ACP transport using the normative frames themselves.
for (const [id, card] of ["T9-terminal", "T9-execute-code", "E-5-write-file", "G3-execute-code-terminal", "G3-no-nested-hook", "G3-nested-expired", "U-pcomp-early", "U-pcomp-shape", "U-pcomp-twice", "G2-asis-memory", "G2-fallbackB-memory", "E-4-write-dont_ask"].flatMap(id => [false, ...(["T9-terminal", "E-5-write-file", "G3-no-nested-hook"].includes(id) ? [true] : [])].map(card => [id, card] as const))) it(`live driver: ${id} ${card ? "card" : "automatic"}`, async () => {
  const trace = traces.find(t => t.id === id)!;
  ensureDirs(); chmodSync(cli, 0o755);
  home = mkdtempSync(join(tmpdir(), "hermes-correlation-"));
  const prompt = trace.frames.findIndex((f: any) => f.dir === "in" && f.msg.method === "session/prompt");
  const mode = trace.frames.slice(0, prompt).filter((f: any) => f.dir === "in" && f.msg.method === "session/set_mode").at(-1)?.msg.params.modeId ?? trace.frames.slice(0, prompt).find((f: any) => f.msg.result?.modes)?.msg.result.modes.currentModeId ?? "default";
  const steps: any[] = [];
  let after: unknown; let at = 10;
  for (const f of trace.frames.slice(prompt + 1)) {
    if (f.dir === "in" && f.msg.result) { after = f.msg.id; at = 10; }
    if (f.dir !== "out" || !f.msg.method) continue;
    const msg = f.msg;
    const step = msg.method === "session/request_permission" ? { request: { ...msg, params: { ...msg.params, sessionId: undefined } } } : { update: msg.params?.update };
    // The fixture supplies the freshly allocated session id.
    if (step.request) {
      delete step.request.params.sessionId;
      // Synthetic reference asks omit options: supply transport scaffolding,
      // without changing the normative frame file or any expected outcome.
      if (!step.request.params.options?.length) step.request.params.options = [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject_once", kind: "reject_once" }];
    }
    steps.push({ at, ...(after === undefined ? {} : { after }), ...step }); at += 10;
  }
  steps.push({ at: at + 200, ...(after === undefined ? {} : { after }), update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
  steps.push({ at: at + 250, ...(after === undefined ? {} : { after }), result: { stopReason: "end_turn" } });
  const support = {
    driverKind: "hermesCorrelationFixture", displayName: "Hermes", models: { default: "", options: [] }, defaultCli: cli,
    nativeSource: "test.acp", loginNote: "unused", spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "continue", isAuthenticated: () => true, toolTripwire: true,
    toolTripwireMatcher: () => hermesAskMatcher(false),
    toolCorrelationContext: () => trace.ctx ?? {},
    toolIdentityContext: () => ({ hermesInstallSha: HERMES_VERSION_PIN["0.22.2"] }),
    normalizeAsk: hermesAcpSupport.normalizeAsk,
  } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: "correlation", displayName: "Hermes", enabled: true,
    config: Driver.decodeConfig({ cli, fullAuto: !card && id !== "U-pcomp-early" }), environment: {
      HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_AGENT_VERSION: "0.22.2",
      FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: mode }), FAKE_ACP_MCP_READY: "1",
      FAKE_ACP_SCRIPT: JSON.stringify(steps), FAKE_ACP_RPC_LOG: join(home, "rpc.jsonl"), FAKE_ACP_SCRIPT_LOG: join(home, "answers.jsonl"),
    } });
  const recorder = recordEvents(instance.adapter);
  const answers: Promise<unknown>[] = [];
  const unsubscribe = instance.adapter.onEvent(event => {
    if (card && event.type === "request.opened") answers.push(instance!.adapter.respondToRequest("correlation", event.requestId!, { behavior: "allow" }));
  });
  try {
    await instance.adapter.sendTurn({ threadId: "correlation", text: "go", cwd: home });
    const completed = await recorder.until(e => e.type === "turn.completed", 15000);
    const actual = completed.type === "turn.completed" && completed.stopReason === "gate_incident" ? "trip"
      : completed.type === "turn.completed" && completed.stopReason === "hermes-turn-refused" ? "refuse" : "accept";
    await Promise.all(answers);
    expect(actual).toBe(trace.expect.result);
    if (actual === "accept") expect(completed).toMatchObject({ ok: true });
    if (trace.expect.result === "refuse") expect(readFileSync(join(home, "rpc.jsonl"), "utf8")).not.toContain('"session/prompt"');
    if (trace.expect.sent) {
      const replies = readFileSync(join(home, "answers.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      for (const [tcid, expected] of Object.entries(trace.expect.sent)) {
        const ask = trace.frames.find((f: any) => f.msg.method === "session/request_permission" && f.msg.params.toolCall.toolCallId === tcid).msg;
        const reply = replies.find(r => r.id === ask.id);
        const kind = steps.find(s => s.request?.id === ask.id).request.params.options.find((o: any) => o.optionId === reply?.result?.outcome?.optionId)?.kind;
        expect(kind?.startsWith("allow") ? "allow" : "reject", tcid).toBe(expected);
      }
    }
    // Permission completions never masquerade as execution result chips.
    const asks = new Set(trace.frames.filter((f: any) => f.msg.method === "session/request_permission").map((f: any) => f.msg.params.toolCall.toolCallId));
    expect(recorder.events.filter(e => e.type === "item.completed" && e.itemType === "tool" && asks.has(e.itemId))).toEqual([]);
    if (card && id === "G3-no-nested-hook") expect(recorder.events).toContainEqual(expect.objectContaining({ type: "request.resolved", behavior: "deny", source: "system" }));
  } finally { unsubscribe(); recorder.stop(); }
});

it('owner No limits keeps a verified Hermes turn free of correlation and mode refusals', async () => {
  ensureDirs(); chmodSync(cli, 0o755);
  home = mkdtempSync(join(tmpdir(), "hermes-owner-no-limits-"));
  const correlation = vi.fn(() => { throw new Error("owner No limits must use the wipe-only broker"); });
  const Driver = createAcpDriver({
    driverKind: "hermesNoLimitsFixture", displayName: "Hermes", models: { default: "", options: [] }, defaultCli: cli,
    nativeSource: "test.acp", loginNote: "unused", spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "continue", isAuthenticated: () => true, toolTripwire: true,
    toolTripwireMatcher: () => hermesAskMatcher(false), toolCorrelationContext: correlation,
    toolIdentityContext: () => ({ hermesInstallSha: HERMES_VERSION_PIN["0.22.2"] }),
  });
  instance = await Driver.create({ instanceId: "owner-no-limits", displayName: "Hermes", enabled: true,
    config: Driver.decodeConfig({ cli, fullAuto: true }), environment: {
      HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_AGENT_VERSION: "0.22.2",
      FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: "dont_ask" }), FAKE_ACP_MCP_READY: "1",
      FAKE_ACP_SCRIPT: JSON.stringify([
        { at: 5, update: { sessionUpdate: "tool_call", toolCallId: "memory", title: "memory: owner work", kind: "other", status: "in_progress" } },
        { at: 10, update: { sessionUpdate: "tool_call_update", toolCallId: "memory", status: "completed" } },
        { at: 15, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
        { at: 20, result: { stopReason: "end_turn" } },
      ]),
    } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "owner-no-limits", text: "owner work", cwd: home, stopLine: true, noLimits: true });
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: null });
    expect(correlation).not.toHaveBeenCalled();
    expect(recorder.events.filter(e => e.type === "request.opened" || e.type === "runtime.error")).toEqual([]);
  } finally { recorder.stop(); }
});

it.each([false, true])('an authenticated No limits upgrade retires a pending Hermes binding gate (posture callback=%s)', async notifyPosture => {
  ensureDirs(); chmodSync(cli, 0o755);
  home = mkdtempSync(join(tmpdir(), "hermes-upgrade-no-limits-"));
  let posture: Pick<SendTurnInput, "routeAsks" | "askLevel" | "stopLine" | "noLimits"> = { routeAsks: true, askLevel: true };
  const wire = join(home, "upgrade-answers.jsonl");
  let heldRequestId: string | undefined;
  installNativeReleaseReader(identity => identity.threadId === "owner-upgrade" && identity.requestId === heldRequestId);
  const Driver = createAcpDriver({
    driverKind: "hermesUpgradeFixture", displayName: "Hermes", models: { default: "", options: [] }, defaultCli: cli,
    nativeSource: "test.acp", loginNote: "unused", spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "continue", isAuthenticated: () => true, toolTripwire: true,
    toolTripwireMatcher: () => hermesAskMatcher(false), toolCorrelationContext: () => ({}),
    toolIdentityContext: () => ({ hermesInstallSha: HERMES_VERSION_PIN["0.22.2"] }),
  });
  instance = await Driver.create({ instanceId: "owner-upgrade", displayName: "Hermes", enabled: true,
    config: Driver.decodeConfig({ cli, fullAuto: false }), environment: {
      HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_AGENT_VERSION: "0.22.2",
      FAKE_ACP_SESSION_MODES: JSON.stringify({ currentModeId: "default" }), FAKE_ACP_MCP_READY: "1",
      FAKE_ACP_SCRIPT_LOG: wire,
      FAKE_ACP_SCRIPT: JSON.stringify([
        { at: 5, request: { id: 901, method: "session/request_permission", params: {
          toolCall: { toolCallId: "pending", title: "terminal", kind: "execute", rawInput: { command: "<terminal> (plugin approval rule)", description: "unreadable identity envelope" } },
          options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }],
        } } },
        { after: 901, at: 5, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
        { after: 901, at: 10, result: { stopReason: "end_turn" } },
      ]),
    } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "owner-upgrade", text: "owner work", cwd: home, ...posture, permissionNow: () => posture });
    const opened = await recorder.until(e => e.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error("Missing held permission");
    heldRequestId = opened.requestId;
    // This trusted callback models the server's already-authenticated owner level change.
    posture = { stopLine: true, noLimits: true };
    if (notifyPosture) await instance.adapter.onPostureChange?.("owner-upgrade");
    expect(await instance.adapter.respondToRequest("owner-upgrade", opened.requestId!, { behavior: "allow", identityFrame: opened.identityFrame, toolIdentity: opened.toolIdentity })).toBe("allowed-once");
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    const answer = readFileSync(wire, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.id === 901);
    expect(answer.result.outcome.optionId).toBe("yes");
    expect(recorder.events.filter(e => e.type === "runtime.error")).toEqual([]);
  } finally { recorder.stop(); installNativeReleaseReader(() => false); }
});
