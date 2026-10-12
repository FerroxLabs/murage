// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Grok Build that does not send `_x.ai/mcp_initialized` must not hold every
// turn for the full MCP-ready wait: Grok processes are not pooled, so each
// send would pay it again. The per-server list is read first, and a build
// seen not to notify is remembered (core.ts acpMcpNotifySupport).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { toolsMayBeLoadingNotice, toolsUnavailableNotice } from "../mcp-readiness.ts";
import { resetAcpMcpReadinessForTests } from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const mounts = {
  agents: { command: process.execPath, args: ["fixture-agents"], env: {} },
  memory: { command: process.execPath, args: ["fixture-memory"], env: {} },
};

describe("Grok Build without MCP-ready notifications", () => {
  let dir: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string>) => {
    instance = await GrokAgentDriver.create({ instanceId: "grok-mcp-ready", displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_PROMPT_DUMP: join(dir, "prompt.json"), FAKE_ACP_MODELS: "fixture-model", XAI_API_KEY: "fixture-only", ...environment } });
    recorder = recordEvents(instance.adapter);
  };
  const turn = async (threadId: string) => {
    const sent = Date.now();
    await instance.adapter.sendTurn({ threadId, text: "hello", cwd: dir, integrations: mounts });
    const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    return { done, ms: Date.now() - sent };
  };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
    dir = mkdtempSync(join(tmpdir(), "grok-mcp-ready-"));
    resetAcpMcpReadinessForTests();
    process.env.MURAGE_ACP_MCP_READY_MS = "2500";
    process.env.MURAGE_ACP_MCP_OWN_READY_MS = "200";
  });
  afterEach(async () => {
    delete process.env.MURAGE_ACP_MCP_READY_MS;
    delete process.env.MURAGE_ACP_MCP_OWN_READY_MS;
    recorder?.stop();
    await instance?.dispose();
    resetAcpMcpReadinessForTests();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pays the wait once: the next turns of that build are not held for it, and readiness is reported unknown", async () => {
    await create({});
    const first = await turn("g-1");
    expect(first.ms).toBeGreaterThanOrEqual(2_500);
    expect(first.done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    const second = await turn("g-2");
    const third = await turn("g-3");
    expect(second.ms).toBeLessThan(first.ms - 1_500);
    expect(third.ms).toBeLessThan(first.ms - 1_500);
    expect(second.done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    // The bot hears its tools may still be loading.
    expect(readFileSync(join(dir, "prompt.json"), "utf8")).toContain("may still be loading when this turn started");
  }, 60_000);

  it("reads each server's status first, and does not wait at all when the list shows them ready", async () => {
    await create({ FAKE_ACP_MCP_LIST: "all:ready" });
    const first = await turn("g-list");
    expect(first.ms).toBeLessThan(2_000);
    expect(first.done).toMatchObject({ ok: true });
    expect(first.done.mcpReadiness).toBeUndefined();
    expect(first.done.toolsUnavailable).toBeUndefined();
  }, 60_000);

  it("a build that does notify keeps the full wait for a server that is still connecting", async () => {
    await create({ FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" });
    const first = await turn("g-notify");
    expect(first.done).toMatchObject({ ok: true });
    expect(first.done.mcpReadiness).toBeUndefined();
    expect(first.ms).toBeLessThan(2_000);
  }, 60_000);

  it("a required server the list does not name is unknown, not ready: the bot hears it may still be loading", async () => {
    await create({ FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_LIST: JSON.stringify({ memory: "ready" }) });
    const first = await turn("g-absent");
    expect(first.done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    expect(first.done.toolsUnavailable).toBeUndefined();
    expect(readFileSync(join(dir, "prompt.json"), "utf8")).toContain("may still be loading when this turn started");
  }, 60_000);

  it("a failed server and an unnamed one: both warnings and the unknown-readiness flag survive", async () => {
    await create({ FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_LIST: JSON.stringify({ agents: "failed" }), MURAGE_MCP_RECONNECT_WAIT_MS: "0" });
    await instance.adapter.sendTurn({ threadId: "g-mixed", text: "hello", cwd: dir,
      integrations: { agents: { command: process.execPath, args: ["fixture-agents"], env: {} }, composio: { command: process.execPath, args: ["fixture-composio"], env: {} } } });
    const done = await recorder.until((e) => e.threadId === "g-mixed" && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    expect(done).toMatchObject({ ok: true, mcpReadiness: "unknown", toolsUnavailable: ["messaging other bots"] });
    const prompt = readFileSync(join(dir, "prompt.json"), "utf8");
    expect(prompt).toContain(JSON.stringify(toolsUnavailableNotice(["messaging other bots"])).slice(1, -1));
    expect(prompt).toContain(JSON.stringify(toolsMayBeLoadingNotice(["connected apps"])).slice(1, -1));
  }, 60_000);
});
