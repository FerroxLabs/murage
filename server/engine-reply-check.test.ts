// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { checkEngineReply, engineLine, replyCheckFailure } from "./engine-reply-check.ts";
import { engineFailure, ENGINE_REPLY_PROMPT, hiddenTurnRunner, withCliMemoryLearning } from "./drivers/cli-memory-learning.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";

const engine = (fail?: unknown, text = "ready") => ({ instanceId: `e-${Math.random()}`, displayName: "Claude Code",
  checkReply: vi.fn(async (_signal: AbortSignal) => { if (fail) throw fail; return text; }) });

describe("one real reply decides", () => {
  it("answers ready on a reply, with no line", async () => {
    expect(await checkEngineReply(engine())).toEqual({ result: "ready" });
  });
  it("answers Sign in for a lost login, and carries no line", async () => {
    expect(await checkEngineReply(engine(engineFailure("Not logged in · Please run /login")))).toEqual({ result: "signin" });
    expect(await checkEngineReply(engine(engineFailure("Unauthorized (401)")))).toEqual({ result: "signin" });
    expect(await checkEngineReply(engine(engineFailure("OAuth token has been revoked (403)")))).toEqual({ result: "signin" });
  });
  it("gives a plan limit that engine's own line, not Sign in", async () => {
    expect(await checkEngineReply(engine(engineFailure("You've hit your session limit · resets 3pm")))).toEqual({ result: "limit", line: "You've hit your session limit · resets 3pm" });
    const line = "Your ChatGPT plan limit is reached. Work that uses it is paused. Murage did not switch to another provider.";
    expect(await checkEngineReply(engine(engineFailure(line)))).toEqual({ result: "limit", line });
  });
  it("gives a CLI or policy refusal that engine's own line, not Sign in", async () => {
    const managed = Object.assign(engineFailure("You cannot use this engine under your organization's MCP policy"), { code: "CLAUDE_MANAGED_MCP_CONFLICT" });
    expect(await checkEngineReply(engine(managed))).toEqual({ result: "refused", line: "You cannot use this engine under your organization's MCP policy" });
    const old = Object.assign(engineFailure("Update Claude Code to keep going."), { code: "update_required" });
    expect((await checkEngineReply(engine(old))).result).toBe("refused");
    expect(await checkEngineReply(engine(engineFailure("Request failed with 403: blocked by your organization's policy")))).toEqual({ result: "refused", line: "Request failed with 403: blocked by your organization's policy" });
  });
  it("never shows an internal code as an engine line", async () => {
    expect(await checkEngineReply(engine(new Error("MEMORY_EXTRACTION_TIMEOUT")))).toEqual({ result: "refused", line: "Claude Code did not answer in time. Try again." });
    expect(await checkEngineReply(engine(new Error("MEMORY_EXTRACTION_REQUEST_FAILED")))).toEqual({ result: "refused", line: "Claude Code did not answer. Try again." });
  });
  it("counts an empty reply as no reply", async () => {
    expect((await checkEngineReply(engine(undefined, "  "))).result).toBe("refused");
  });
  it("a second press while one runs joins it, so only one reply is spent", async () => {
    let release!: (text: string) => void;
    const slow = { instanceId: "joined", checkReply: vi.fn(() => new Promise<string>(resolve => { release = resolve; })) };
    const first = checkEngineReply(slow), second = checkEngineReply(slow);
    expect(slow.checkReply).toHaveBeenCalledOnce();
    release("ready");
    expect(await first).toEqual(await second);
    await checkEngineReply({ ...slow, checkReply: async () => "ready" });
  });
  it("uses the engine's one-shot where it has no hidden session, and stops waiting at the limit", async () => {
    const generateText = vi.fn(async () => "ready");
    expect(await checkEngineReply({ instanceId: "text", generateText })).toEqual({ result: "ready" });
    expect(generateText).toHaveBeenCalledWith(ENGINE_REPLY_PROMPT);
    expect((await checkEngineReply({ instanceId: "stuck", displayName: "Pi", generateText: () => new Promise<string>(() => {}) }, 20))).toEqual({ result: "refused", line: "Pi did not answer in time. Try again." });
    expect((await checkEngineReply({ instanceId: "none", displayName: "Box" })).result).toBe("refused");
  });
  it("keeps colour codes, links and key-shaped text out of the line", () => {
    expect(engineLine("\x1b[31mfailed\x1b[0m at https://x.example/a?t=1 api_key=abc sk-abcdefghij12\nnext")).toBe("failed at [link] api_key=[hidden] [hidden] next");
    expect(engineLine("x".repeat(900))).toHaveLength(300);
    expect(replyCheckFailure(undefined, "E").result).toBe("refused");
  });
});

describe("the hidden session", () => {
  function hidden(script: (threadId: string, emit: (event: RuntimeEvent) => void) => void) {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const sent: Array<Record<string, unknown>> = [];
    const live = { dispose: async () => {}, adapter: {
      onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: { threadId: string }) => { sent.push(input); queueMicrotask(() => script(input.threadId, event => { for (const listener of listeners) listener(event); })); return {}; },
      respondToRequest: async () => {}, interruptTurn: async () => {}, resetSession: async () => {},
    } } as unknown as ProviderInstance;
    return { live: withCliMemoryLearning(live, { run: hiddenTurnRunner }), sent };
  }
  const event = (threadId: string, fields: Record<string, unknown>) => ({ threadId, ...fields }) as unknown as RuntimeEvent;

  it("sends only the fixed prompt, on a thread that exists nowhere else, tool-free and in the background", async () => {
    const { live, sent } = hidden((id, emit) => { emit(event(id, { type: "item.completed", itemType: "assistant_text", text: "ready" })); emit(event(id, { type: "turn.completed", ok: true })); });
    expect(await checkEngineReply({ ...live, checkReply: live.checkReply, instanceId: "h1" })).toEqual({ result: "ready" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: ENGINE_REPLY_PROMPT, proposalOnly: true, background: true, stopLine: true, sessionReset: true });
    expect(String(sent[0]!.threadId)).toMatch(/^memory-learning-/);
    expect(Object.keys(sent[0]!).sort()).toEqual(["background", "cwd", "proposalOnly", "sessionReset", "stopLine", "text", "threadId", "usageFeature"]);
  });
  it("reads a sign-in the engine reported as data, whatever its words say", async () => {
    const { live } = hidden((id, emit) => { emit(event(id, { type: "runtime.error", message: "Something went wrong", authRequired: true })); emit(event(id, { type: "turn.completed", ok: false })); });
    expect(await checkEngineReply({ checkReply: live.checkReply, instanceId: "h2" })).toEqual({ result: "signin" });
    const stop = hidden((id, emit) => emit(event(id, { type: "turn.completed", ok: false, stopReason: "auth_required" })));
    expect(await checkEngineReply({ checkReply: stop.live.checkReply, instanceId: "h3" })).toEqual({ result: "signin" });
  });
  it("reads a limit the engine reported as data", async () => {
    const { live } = hidden((id, emit) => { emit(event(id, { type: "runtime.error", message: "Paused for now", limitResetsAt: 1 })); emit(event(id, { type: "turn.completed", ok: false })); });
    expect(await checkEngineReply({ checkReply: live.checkReply, instanceId: "h4" })).toEqual({ result: "limit", line: "Paused for now" });
  });
  it("spends nothing when the caller gave up before its turn in line", async () => {
    const { live, sent } = hidden(() => {});
    const control = new AbortController(); control.abort();
    await expect(live.checkReply!(control.signal)).rejects.toThrow("MEMORY_EXTRACTION_ABORTED");
    expect(sent).toEqual([]);
  });
});
