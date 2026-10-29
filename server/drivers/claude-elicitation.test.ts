// MCP elicitation on the Claude engine (MCP-ELICITATION-109). Claude Code
// forwards a tool server's `elicitation/create` to the host as control_request
// `elicitation` and waits for the host's control_response with no bound of its
// own (verified on 2.1.311). Murage shows it as the same question card ACP and
// Codex raise, and every outcome goes back: accept with the typed content,
// decline on a skip, cancel on the question timeout and on Stop. Any other
// control_request gets an explicit error at once. Run against the fake CLI
// (server/testing/fake-claude-cli.ts, FAKE_CLAUDE_ELICIT).
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { ELICITATION_URL_OPENED } from "../question-normalize.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const ENV_KEYS = ["FAKE_CLAUDE_ELICIT", "FAKE_CLAUDE_ELICIT_LOG", "FAKE_CLAUDE_ELICIT_WITHDRAW", "FAKE_CLAUDE_SIGTERM_DELAY_MS"] as const;

/** SpicyAPI's price confirmation, in the shape Claude Code forwards it. */
const PRICE_CONFIRM = {
  subtype: "elicitation",
  mcp_server_name: "spicyapi",
  display_name: "SpicyAPI",
  message: "This task costs USD 0.048 (max 0.048). Run it?",
  mode: "form",
  elicitation_id: "el-1",
  requested_schema: { type: "object", properties: { confirm: { type: "boolean", title: "Run it" } }, required: ["confirm"] },
  property_order: ["confirm"],
};

type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;
type Resolved = Extract<RuntimeEvent, { type: "request.resolved" }>;

describe("Claude engine: MCP elicitation becomes the owner's question card", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let log: string;

  const start = async (config: Record<string, unknown> = {}) => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-elicit",
      displayName: "Claude",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions", ...config },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-elicit-"));
    log = join(scratch, "elicit.log");
    process.env.FAKE_CLAUDE_ELICIT_LOG = log;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetClaudeVersionGate();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const replies = (): Array<{ type: string; response: { subtype: string; request_id: string; response?: { action: string; content?: unknown }; error?: string } }> =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const opened = (turnId: string) => recorder.until((e) => e.type === "request.opened" && e.turnId === turnId, 30_000) as Promise<Opened>;
  const resolved = (requestId: string) => recorder.until((e) => e.type === "request.resolved" && (e as Resolved).requestId === requestId, 30_000) as Promise<Resolved>;
  const completed = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 30_000) as Promise<Extract<RuntimeEvent, { type: "turn.completed" }>>;

  it("shows a form elicitation as a question card, and the owner's accept goes back with typed content", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-accept", text: "make the image" });
    const card = await opened(turnId);
    expect(card).toMatchObject({ requestType: "question", tool: "elicitation" });
    // Murage's mount name leads the card, never the server's own display_name
    expect(card.summary).toMatch(/^spicyapi: /);
    expect(card.summary).toContain("USD 0.048");
    expect(card.questions?.[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    const outcome = await instance.adapter.respondToRequest("t-accept", card.requestId!, { behavior: "answer", answers: [{ id: "confirm", selected: ["Yes"] }] });
    expect(outcome).toBe("answered");
    expect(await resolved(card.requestId!)).toMatchObject({ behavior: "answer", source: "user" });
    expect((await completed(turnId)).ok).toBe(true);
    expect(replies()).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "cli-ctl-1", response: { action: "accept", content: { confirm: true } } } }]);
  }, 60_000);

  it("a skip goes back as decline", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-decline", text: "make the image" });
    const card = await opened(turnId);
    expect(await instance.adapter.respondToRequest("t-decline", card.requestId!, { behavior: "deny" })).toBe("rejected");
    expect(await resolved(card.requestId!)).toMatchObject({ behavior: "deny", source: "user" });
    await completed(turnId);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "success", request_id: "cli-ctl-1", response: { action: "decline" } }]);
  }, 60_000);

  it("answers that do not fit the card are not delivered; the card stays open", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-badanswer", text: "make the image" });
    const card = await opened(turnId);
    expect(await instance.adapter.respondToRequest("t-badanswer", card.requestId!, { behavior: "answer", answers: [{ id: "confirm", selected: ["Maybe"] }] })).toBe("unavailable");
    expect(replies()).toEqual([]);
    expect(await instance.adapter.respondToRequest("t-badanswer", card.requestId!, { behavior: "deny" })).toBe("rejected");
    await completed(turnId);
  }, 60_000);

  it("nobody answering in time goes back as cancel", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    await start({ questionTimeoutMs: 1_000 });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-timeout", text: "make the image" });
    const card = await opened(turnId);
    expect(await resolved(card.requestId!)).toMatchObject({ behavior: "deny", source: "timeout" });
    await completed(turnId);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "success", request_id: "cli-ctl-1", response: { action: "cancel" } }]);
    // a late answer finds nothing to deliver
    expect(await instance.adapter.respondToRequest("t-timeout", card.requestId!, { behavior: "answer", answers: [{ id: "confirm", selected: ["Yes"] }] })).toBe("unavailable");
  }, 60_000);

  it("a URL elicitation never opens anything; only the owner's tap accepts it, with no content", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([{ subtype: "elicitation", mcp_server_name: "billing", message: "Approve the payment", mode: "url", url: "https://pay.example.com/approve/123", elicitation_id: "el-2" }]);
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-url", text: "pay" });
    const card = await opened(turnId);
    expect(card.questions?.[0]?.question).toContain("https://pay.example.com/approve/123");
    expect(card.choices).toEqual([ELICITATION_URL_OPENED]);
    await instance.adapter.respondToRequest("t-url", card.requestId!, { behavior: "answer", answers: [{ id: "url", selected: [ELICITATION_URL_OPENED] }] });
    await completed(turnId);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "success", request_id: "cli-ctl-1", response: { action: "accept" } }]);
  }, 60_000);

  it("an unknown control_request gets an explicit error reply at once and the turn runs on", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([{ subtype: "hook_callback", callback_id: "x" }]);
    await start();
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-unknown", text: "hi" });
    expect((await completed(turnId)).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "error", request_id: "cli-ctl-1", error: 'Murage does not handle control request "hook_callback"' }]);
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
  }, 60_000);

  it("a form Murage cannot show is cancelled with one line, never left waiting", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([{ ...PRICE_CONFIRM, requested_schema: { type: "object", properties: {} } }]);
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-unshowable", text: "hi" });
    await completed(turnId);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "success", request_id: "cli-ctl-1", response: { action: "cancel" } }]);
    expect(recorder.events.some((e) => e.type === "runtime.error" && /could not show/.test((e as { message: string }).message))).toBe(true);
  }, 60_000);

  it("the CLI withdrawing its request closes the card and writes nothing back", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    process.env.FAKE_CLAUDE_ELICIT_WITHDRAW = "1";
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-withdraw", text: "make the image" });
    const card = await opened(turnId);
    expect(await resolved(card.requestId!)).toMatchObject({ behavior: "deny", source: "system" });
    await completed(turnId);
    expect(replies()).toEqual([]);
  }, 60_000);

  it("Stop mid-elicitation sends cancel to the CLI and closes the card", async () => {
    process.env.FAKE_CLAUDE_ELICIT = JSON.stringify([PRICE_CONFIRM]);
    process.env.FAKE_CLAUDE_SIGTERM_DELAY_MS = "500";
    await start();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stop", text: "make the image" });
    const card = await opened(turnId);
    await instance.adapter.interruptTurn("t-stop", turnId);
    expect(await resolved(card.requestId!)).toMatchObject({ behavior: "deny", source: "system" });
    await completed(turnId);
    expect(replies().map((reply) => reply.response)).toEqual([{ subtype: "success", request_id: "cli-ctl-1", response: { action: "cancel" } }]);
  }, 60_000);
});
