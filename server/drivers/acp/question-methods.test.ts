// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q3 (174): vendor "ask the owner" requests share one method table in acp/core.ts and the one question card.
// Grok Build's `x.ai/ask_user_question` and Cursor's `cursor/ask_question` used to be answered "method not found", so
// the agent's question errored instead of reaching the owner.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { QUESTION_TIMEOUT_MS } from "../../../shared/questions.ts";
import { questionMethodFor } from "./core.ts";
import { CURSOR_ASK_QUESTION, GROK_ASK_USER_QUESTION } from "./question-methods.ts";
import { GrokAgentDriver } from "./grok.ts";
import { CursorAgentDriver } from "./cursor.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Grok Build 1.0.62's AskUserQuestionExtRequest (types.rs): `multi_select` is the model-facing spelling. */
const GROK_PARAMS = {
  sessionId: "s-1",
  toolCallId: "tc-1",
  mode: "default",
  questions: [
    { question: "Which database?", options: [{ label: "Redis", description: "In-memory" }, { label: "Postgres", description: "Relational" }] },
    { question: "Which frameworks?", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multi_select: true },
  ],
};
/** cursor-agent's ask_question: a prompt per question, option ids, allowMultiple, no sessionId. */
const CURSOR_PARAMS = {
  toolCallId: "ask-1",
  title: "Setup",
  questions: [
    { id: "color", prompt: "Which color?", options: [{ id: "blue-id", label: "Blue" }, { id: "green-id", label: "Green" }], allowMultiple: false },
    { id: "sizes", prompt: "Which sizes?", options: [{ id: "s-id", label: "Small" }, { id: "l-id", label: "Large" }], allowMultiple: true },
  ],
};

describe("the vendor question table (QW Q3)", () => {
  it("finds each vendor's ask by its own method name, own keys only", () => {
    expect(questionMethodFor("_fuigo/ask_user_question")?.tool).toBe("ask_user_question");
    expect(questionMethodFor("x.ai/ask_user_question")).toBe(GROK_ASK_USER_QUESTION);
    expect(questionMethodFor("_x.ai/ask_user_question")).toBe(GROK_ASK_USER_QUESTION);
    expect(questionMethodFor("cursor/ask_question")).toBe(CURSOR_ASK_QUESTION);
    for (const method of ["__proto__", "constructor", "toString", "hasOwnProperty", "session/request_permission", 42, undefined]) {
      expect(questionMethodFor(method)).toBeUndefined();
    }
  });

  it("refuses a question whose text is __proto__ or constructor, where answers are keyed by text", () => {
    for (const text of ["__proto__", "constructor"]) {
      const params = { questions: [{ question: text, options: [{ label: "A" }] }] };
      expect(GROK_ASK_USER_QUESTION.parse(params)).toMatchObject({ ok: false });
      expect(questionMethodFor("_fuigo/ask_user_question")!.parse(params)).toMatchObject({ ok: false });
    }
  });

  it("Grok: answers keyed by Grok's question text, own words as Other with notes", () => {
    const parsed = GROK_ASK_USER_QUESTION.parse(GROK_PARAMS);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.questions.map((q) => [q.id, q.question, q.multiSelect, q.allowOther])).toEqual([
      ["q1", "Which database?", false, true],
      ["q2", "Which frameworks?", true, true],
    ]);
    expect(parsed.reply([{ id: "q1", selected: [], other: "SQLite" }, { id: "q2", selected: ["React", "Vue"] }])).toEqual({
      outcome: "accepted",
      answers: { "Which database?": ["Other"], "Which frameworks?": ["React", "Vue"] },
      annotations: { "Which database?": { notes: "SQLite" } },
    });
  });

  it("Grok: a request in another shape is refused whole", () => {
    for (const params of [{}, { questions: "Which?" }, { questions: [{ prompt: "Which?" }] }, { questions: [{ question: "A?", options: "x" }] }]) {
      expect(GROK_ASK_USER_QUESTION.parse(params)).toMatchObject({ ok: false });
    }
  });

  it("Cursor: picks go back by option id; any own words go back whole as skipped", () => {
    const parsed = CURSOR_ASK_QUESTION.parse(CURSOR_PARAMS);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.questions.map((q) => [q.question, q.multiSelect])).toEqual([["Which color?", false], ["Which sizes?", true]]);
    expect(parsed.reply([{ id: "q1", selected: ["Green"] }, { id: "q2", selected: ["Small", "Large"] }])).toEqual({
      outcome: { outcome: "answered", answers: [{ questionId: "color", selectedOptionIds: ["green-id"] }, { questionId: "sizes", selectedOptionIds: ["s-id", "l-id"] }] },
    });
    const skipped = parsed.reply([{ id: "q1", selected: [], other: "Teal" }]) as { outcome: { outcome: string; reason: string } };
    expect(skipped.outcome.outcome).toBe("skipped");
    expect(skipped.outcome.reason).toContain("Teal");
    expect(CURSOR_ASK_QUESTION.cancelled).toEqual({ outcome: { outcome: "cancelled" } });
    expect(CURSOR_ASK_QUESTION.parse({ questions: [{ prompt: "No id?", options: [] }] })).toMatchObject({ ok: false });
  });
});

describe("vendor questions through the ACP driver (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;

  const start = async (method: string, params: unknown, driver: typeof GrokAgentDriver = GrokAgentDriver) => {
    Object.assign(process.env, { FAKE_ACP_MODE: "vendor-question", FAKE_ACP_ASK_METHOD: method, FAKE_ACP_ASK_PARAMS: JSON.stringify(params), FAKE_ACP_DUMP: dump });
    instance = await driver.create({ instanceId: "acp-q3", displayName: "Q3", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
  };
  const decision = () => JSON.parse(readFileSync(dump, "utf8")).decision;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-q3-"));
    dump = join(scratch, "dump.json");
  });
  afterEach(async () => {
    for (const key of ["FAKE_ACP_MODE", "FAKE_ACP_ASK_METHOD", "FAKE_ACP_ASK_PARAMS", "FAKE_ACP_DUMP"]) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it("Grok Build's ask opens the question card, never auto-answered, and answers by question text", async () => {
    await start("_x.ai/ask_user_question", GROK_PARAMS);
    await instance!.adapter.sendTurn({ threadId: "t-grok-q", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", tool: "ask_user_question", summary: "Which database?" });
    await expect(instance!.adapter.respondToRequest("t-grok-q", (opened as any).requestId, {
      behavior: "answer", message: "Redis", answers: [{ id: "q1", selected: ["Redis"] }],
    })).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(decision()).toEqual({ outcome: "accepted", answers: { "Which database?": ["Redis"] } });
  });

  it("Cursor's ask opens the same card and answers by option id", async () => {
    await start("cursor/ask_question", CURSOR_PARAMS, CursorAgentDriver as typeof GrokAgentDriver);
    await instance!.adapter.sendTurn({ threadId: "t-cursor-q", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", tool: "ask_user", summary: "Which color?" });
    await instance!.adapter.respondToRequest("t-cursor-q", (opened as any).requestId, { behavior: "answer", message: "Blue", answers: [{ id: "q1", selected: ["Blue"] }] });
    await recorder.until((e) => e.type === "turn.completed");
    expect(decision()).toEqual({ outcome: { outcome: "answered", answers: [{ questionId: "color", selectedOptionIds: ["blue-id"] }] } });
  });

  it("the turn ending cancels the ask, and a reply after that is dropped", async () => {
    await start("x.ai/ask_user_question", GROK_PARAMS);
    await instance!.adapter.sendTurn({ threadId: "t-grok-stop", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance!.adapter.interruptTurn("t-grok-stop");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
    await expect(instance!.adapter.respondToRequest("t-grok-stop", (opened as any).requestId, {
      behavior: "answer", message: "Redis", answers: [{ id: "q1", selected: ["Redis"] }],
    })).resolves.toBe("unavailable");
    expect(recorder.events.filter((e) => e.type === "request.resolved")).toHaveLength(1);
  });

  it("an unanswered ask times out at the question timeout with the vendor's cancelled reply", async () => {
    const original = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
      original(callback, delay === QUESTION_TIMEOUT_MS ? 50 : delay, ...args)) as typeof setTimeout);
    try {
      await start("x.ai/ask_user_question", GROK_PARAMS);
      await instance!.adapter.sendTurn({ threadId: "t-grok-timeout", text: "go" });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "timeout" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(decision()).toEqual({ outcome: "cancelled" });
      await expect(instance!.adapter.respondToRequest("t-grok-timeout", (opened as any).requestId, {
        behavior: "answer", message: "Redis", answers: [{ id: "q1", selected: ["Redis"] }],
      })).resolves.toBe("unavailable");
    } finally { timer.mockRestore(); }
  });

  it("a Grok ask in a shape Murage cannot read fails closed with one line; the agents ask_user stays mounted", async () => {
    await start("_x.ai/ask_user_question", { sessionId: "s-1", toolCallId: "tc-1", questions: [{ prompt: "Which database?" }] });
    await instance!.adapter.sendTurn({
      threadId: "t-grok-bad",
      text: "go",
      integrations: { agents: { command: process.execPath, args: ["/fake/agents-proxy.js"], env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_COMMS_TOKEN: "t" } } },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    const lines = recorder.events.filter((e) => e.type === "runtime.error");
    expect(lines).toHaveLength(1);
    expect((lines[0] as { message: string }).message).toMatch(/could not show/);
    expect(decision()).toEqual({ outcome: "cancelled" });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers.map((server: { name: string }) => server.name)).toContain("agents");
  });
});
