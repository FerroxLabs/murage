// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 invariant I14 reads "released to the engine's write" (Astra r5 order 2, M-r6-3). A pre-write failure after
// the submission fence passed must not leave a row stamped `dispatchedIn`, through the real adapters:
//  - openai-chat: the fence passes, the id is handed back, then `fetch` fails before anything is sent;
//  - Claude: the fence passes, the MCP-readiness await runs, a Stop lands in it, and the turn's id is handed back without a write.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { ClaudeDriver, resetClaudeMcpReadinessForTests } from "./drivers/claude.ts";
import { resetClaudeVersionGate } from "./drivers/claude-guards.ts";
import { createOpenAIChatRuntime } from "./drivers/openai-chat.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents } from "./testing/events.ts";
import { createTurnAttribution } from "./turn-attribution.ts";
import { TurnSubmissionBoundary } from "./turn-dispatch-guard.ts";

/** The server's own wiring (index.ts): the attribution's stamp lands on a row, and `unstamp` clears it only while it names the turn. */
function rows() {
  const row: { dispatchedIn?: string } = {};
  const attribution = createTurnAttribution({
    stamp: (_thread, _id, turnId) => { row.dispatchedIn = turnId; },
    unstamp: (_thread, _id, turnId) => { if (row.dispatchedIn === turnId) row.dispatchedIn = undefined; },
  });
  const boundary = new TurnSubmissionBoundary();
  attribution.begin("g1", "t", ["u1"]);
  attribution.bind("g1", boundary);
  return { row, attribution, boundary };
}

describe("I14: dispatchedIn means released to the engine's write", () => {
  const instances: ProviderInstance[] = [];
  let previousFetch: typeof globalThis.fetch;
  let scratch: string | undefined;
  beforeEach(() => { ensureDirs(); previousFetch = globalThis.fetch; });
  afterEach(async () => {
    globalThis.fetch = previousFetch;
    for (const instance of instances.splice(0)) await instance.dispose();
    resetClaudeVersionGate();
    resetClaudeMcpReadinessForTests();
    if (scratch) await removeTempDir(scratch);
    scratch = undefined;
  });

  const chat = () => {
    const instance = createOpenAIChatRuntime({
      input: { instanceId: "chat-i14", displayName: "Chat", environment: {}, enabled: true, config: {} },
      driverKind: "openai-chat-i14",
      apiKey: "sk-i14-test",
      apiUrl: "https://chat.invalid/v1",
      models: () => ({ default: "test-model", options: [{ id: "test-model", label: "Test model" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "TestProvider",
      missingKeyError: "missing key",
      unavailableReason: "no key",
      timeoutMs: 10_000,
      retryScale: 0.001,
      nativeLog: { source: "test.i14", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
    });
    instances.push(instance);
    return instance;
  };
  const connectFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

  it("openai-chat: the fence passed and the id was accepted, then fetch failed before the body went out: the row is not stamped", async () => {
    const { row, attribution, boundary } = rows();
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw connectFailure(); }) as typeof fetch;
    const instance = chat();
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-chat-fail", text: "question",
      beforeSubmit: () => boundary.beforeSubmit(() => {}),
      notWritten: () => boundary.notWritten(),
    });
    attribution.accepted("g1", turnId);
    await recorder.until((event) => event.type === "turn.completed", 30_000);
    recorder.stop();
    expect(requests).toBeGreaterThan(0);
    expect(row.dispatchedIn).toBeUndefined();
  }, 60_000);

  it("openai-chat: a request that went out and was answered keeps its stamp", async () => {
    const { row, attribution, boundary } = rows();
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const instance = chat();
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-chat-ok", text: "question",
      beforeSubmit: () => boundary.beforeSubmit(() => {}),
      notWritten: () => boundary.notWritten(),
    });
    attribution.accepted("g1", turnId);
    await recorder.until((event) => event.type === "turn.completed", 30_000);
    recorder.stop();
    expect(row.dispatchedIn).toBe(turnId);
  }, 60_000);

  it("openai-chat: a connection that broke after the request went out may have delivered it (Astra r7, order 2): the stamp stands", async () => {
    const { row, attribution, boundary } = rows();
    const brokenAfterConnect = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    globalThis.fetch = (async () => { throw brokenAfterConnect(); }) as typeof fetch;
    const instance = chat();
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-chat-reset", text: "question",
      beforeSubmit: () => boundary.beforeSubmit(() => {}),
      notWritten: () => boundary.notWritten(),
    });
    attribution.accepted("g1", turnId);
    await recorder.until((event) => event.type === "turn.completed", 30_000);
    recorder.stop();
    expect(row.dispatchedIn).toBe(turnId);
  }, 60_000);

  it("Claude: a Stop in the MCP-readiness wait after the first fence hands the id back with no write: the row is not stamped", async () => {
    const fake = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
    chmodSync(fake, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-i14-"));
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 20_000 });
    try {
      const instance = await ClaudeDriver.create({ instanceId: "claude-i14", displayName: "Claude", environment: {}, enabled: true, config: { cli: fake, permissionMode: "bypassPermissions" } });
      instances.push(instance);
      const { row, attribution, boundary } = rows();
      let fenced!: () => void;
      const firstFence = new Promise<void>((resolve) => { fenced = resolve; });
      const sending = instance.adapter.sendTurn({
        threadId: "t-claude-stop", text: "Founders sweep",
        integrations: { composio: { command: process.execPath, args: ["/fake/connector-proxy.js"], env: { MURAGE_BOT_ID: "dax" } } },
        beforeSubmit: () => { boundary.beforeSubmit(() => {}); fenced(); },
        notWritten: () => boundary.notWritten(),
      });
      await firstFence;
      // the fence passed; the process now waits for its connected apps before the prompt is written
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await instance.adapter.interruptTurn("t-claude-stop").catch(() => undefined);
      const { turnId } = await sending;
      attribution.accepted("g1", turnId);
      expect(row.dispatchedIn).toBeUndefined();
    } finally {
      delete process.env.FAKE_CLAUDE_MCP_READY_MS;
    }
  }, 90_000);

  it("a relaunch that does write passes the fence again and is stamped; a later attempt's stamp is never withdrawn by an older one", () => {
    const { row, attribution, boundary } = rows();
    attribution.accepted("g1", "T1");
    boundary.beforeSubmit(() => {});
    expect(row.dispatchedIn).toBe("T1");
    boundary.notWritten();
    expect(row.dispatchedIn).toBeUndefined();
    boundary.beforeSubmit(() => {});
    expect(row.dispatchedIn).toBe("T1");
    row.dispatchedIn = "T2"; // a newer dispatch re-stamped the row
    boundary.notWritten();
    expect(row.dispatchedIn).toBe("T2");
  });

  it("a later check refusing the second fence takes the first release back", () => {
    const { row, attribution, boundary } = rows();
    boundary.beforeSubmit(() => {});
    attribution.accepted("g1", "T1");
    expect(row.dispatchedIn).toBe("T1");
    expect(() => boundary.beforeSubmit(() => { throw new Error("retired during the MCP wait"); })).toThrow("retired during");
    expect(row.dispatchedIn).toBeUndefined();
  });
});
