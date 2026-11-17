// control: retain the isolated turn and mount admission used by server dispatch.
import { bindFixtureAdapter } from "../../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Grok Build that does not send `_x.ai/mcp_initialized` must not hold every
// turn for the full MCP-ready wait: Grok processes are not pooled, so each
// send would pay it again. The per-server list is read first and releases the
// wait once it shows every server settled; a build that answers the list with
// method-not-found is not asked for it again (core.ts acpMcpListUnsupported).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { resetAcpMcpReadinessForTests } from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const mounts = {
  agents: { command: process.execPath, args: [new URL("../../testing/fake-idle-mcp.mjs", import.meta.url).pathname, "fixture-agents"], env: {} },
  memory: { command: process.execPath, args: [new URL("../../testing/fake-idle-mcp.mjs", import.meta.url).pathname, "fixture-memory"], env: {} },
};

describe("Grok Build without MCP-ready notifications", () => {
  let dir: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string>) => {
    instance = await GrokAgentDriver.create({ instanceId: "grok-mcp-ready", displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_PROMPT_DUMP: join(dir, "prompt.json"), FAKE_ACP_MODELS: "fixture-model", XAI_API_KEY: "fixture-only", ...environment } });
    bindFixtureAdapter(instance.adapter);
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
    removeTempDirSync(dir);
  });

  it("a build whose list is method-not-found is not asked for it again, and silence is never remembered: every cold turn keeps its wait", async () => {
    process.env.MURAGE_ACP_MCP_READY_MS = "1500";
    await create({ FAKE_ACP_RPC_LOG: join(dir, "acp.log") });
    const first = await turn("g-1");
    expect(first.ms).toBeGreaterThanOrEqual(1_500);
    // MAIN RULING INT-CONFLICT-DEFAULT 2793682f0bc eb01447e7d1: unknown consuming readiness refuses before a prompt.
    expect(first.done).toMatchObject({ ok: false, mcpReadiness: "unknown" });
    const listsAfterFirst = (readFileSync(join(dir, "acp.log"), "utf8").match(/mcp\/list/g) ?? []).length;
    expect(listsAfterFirst).toBeGreaterThan(0);
    // the first turn's silence proves nothing (a slow start looks the same): the next cold turns wait too
    const second = await turn("g-2");
    const third = await turn("g-3");
    expect(second.ms).toBeGreaterThanOrEqual(1_500);
    expect(third.ms).toBeGreaterThanOrEqual(1_500);
    // MAIN RULING INT-CONFLICT-DEFAULT 2793682f0bc eb01447e7d1: every cold consuming turn must prove readiness.
    expect(second.done).toMatchObject({ ok: false, mcpReadiness: "unknown" });
    // MAIN RULING INT-CONFLICT-DEFAULT 6fc6fc93037 eb01447e7d1: silence never authorizes the third consuming prompt.
    expect(third.done).toMatchObject({ ok: false, mcpReadiness: "unknown" });
    // only the explicit method-not-found is remembered: the list is not asked again
    expect((readFileSync(join(dir, "acp.log"), "utf8").match(/mcp\/list/g) ?? []).length).toBe(listsAfterFirst);
    // MAIN RULING INT-CONFLICT-DEFAULT 6d591f22b07 eb01447e7d1: the terminal receipt reports unknown readiness; no unproven consuming prompt is written.
    expect(existsSync(join(dir, "prompt.json"))).toBe(false);
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
    // MAIN RULING INT-CONFLICT-DEFAULT 2793682f0bc eb01447e7d1: unknown consuming readiness refuses before a prompt.
    expect(first.done).toMatchObject({ ok: false, mcpReadiness: "unknown" });
    expect(first.done.toolsUnavailable).toBeUndefined();
    // MAIN RULING INT-CONFLICT-DEFAULT e466d1fa346 eb01447e7d1: a missing server refuses despite the aggregate announcement.
    expect(existsSync(join(dir, "prompt.json"))).toBe(false);
  }, 60_000);

  it("a failed server and an unnamed one: both warnings and the unknown-readiness flag survive", async () => {
    await create({ FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_LIST: JSON.stringify({ agents: "failed" }), MURAGE_MCP_RECONNECT_WAIT_MS: "0" });
    await instance.adapter.sendTurn({ threadId: "g-mixed", text: "hello", cwd: dir,
      integrations: { agents: { command: process.execPath, args: [new URL("../../testing/fake-idle-mcp.mjs", import.meta.url).pathname, "fixture-agents"], env: {} }, composio: { command: process.execPath, args: [new URL("../../testing/fake-idle-mcp.mjs", import.meta.url).pathname, "fixture-composio"], env: {} } } });
    const done = await recorder.until((e) => e.threadId === "g-mixed" && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    // MAIN RULING INT-CONFLICT-DEFAULT e466d1fa346 eb01447e7d1: failed and absent consuming servers keep both facts on a refusal, without submitting warning text as a prompt.
    expect(done).toMatchObject({ ok: false, mcpReadiness: "unknown", toolsUnavailable: ["messaging other bots"] });
    // MAIN RULING INT-CONFLICT-DEFAULT e466d1fa346 eb01447e7d1: neither the failed-server nor unknown-server warning permits a consuming prompt.
    expect(existsSync(join(dir, "prompt.json"))).toBe(false);
    expect(recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "g-mixed")).toHaveLength(1);
  }, 60_000);
});

// Each way an engine can show that Murage's tools are there: it announces it,
// its per-server list shows every server settled, or (with neither) Murage's
// own servers answer its tools/list (mcp-listed.ts). A cold turn's prompt goes
// within 3 s of that moment and never before it; the full bound is far longer.
describe("a cold turn starts on MCP readiness, of every kind", () => {
  const SETTLE_MS = 1_500;
  let dir: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  const ownMounts = {
    agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MURAGE_COMMS_TOKEN: "fixture-only" } },
    memory: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: { MURAGE_MEMORY_TOKEN: "fixture-only" } },
  };
  type Moment = { event: "ready" | "listed" | "prompt"; at: number; name?: string };
  const timeline = (): Moment[] => readFileSync(join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Moment);

  const run = async (threadId: string, environment: Record<string, string>, integrations: Record<string, unknown>, expectPrompt = true) => {
    instance = await GrokAgentDriver.create({ instanceId: `grok-ready-${threadId}`, displayName: "Grok", enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli, fullAuto: true }),
      environment: { HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_MODELS: "fixture-model", XAI_API_KEY: "fixture-only",
        FAKE_ACP_MCP_TIMELINE: join(dir, "timeline.jsonl"), ...environment } });
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
    const sent = Date.now();
    await instance.adapter.sendTurn({ threadId, text: "hello", cwd: dir, integrations });
    const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
    const moments = timeline();
    const prompt = moments.find((moment) => moment.event === "prompt")!;
    // MAIN RULING INT-CONFLICT-DEFAULT 591d0b436b0 eb01447e7d1: the partial-readiness control below requires an absent prompt; complete-readiness controls still require one.
    if (expectPrompt) expect(prompt).toBeDefined();
    return { done, sent, prompt, moments, elapsed: Date.now() - sent };
  };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
    dir = mkdtempSync(join(tmpdir(), "grok-ready-kinds-"));
    resetAcpMcpReadinessForTests();
    // far beyond the 3 s the test allows: a turn released by the bound fails it
    process.env.MURAGE_ACP_MCP_READY_MS = "12000";
  });
  afterEach(async () => {
    delete process.env.MURAGE_ACP_MCP_READY_MS;
    recorder?.stop();
    await instance?.dispose();
    resetAcpMcpReadinessForTests();
    vi.unstubAllEnvs();
    removeTempDirSync(dir);
  });

  const startsOnReadiness = (readyAt: number, prompt: Moment, sent: number) => {
    expect(prompt.at).toBeGreaterThanOrEqual(readyAt);
    expect(prompt.at - readyAt).toBeLessThan(3_000);
    expect(readyAt - sent).toBeGreaterThanOrEqual(SETTLE_MS - 100);
  };

  it("an engine that announces readiness", async () => {
    const { done, sent, prompt, moments } = await run("k-announce",
      { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_READY_DELAY_MS: String(SETTLE_MS) }, mounts);
    startsOnReadiness(moments.find((moment) => moment.event === "ready")!.at, prompt, sent);
    expect(done).toMatchObject({ ok: true });
    expect(done.mcpReadiness).toBeUndefined();
  }, 60_000);

  it("an engine whose per-server list shows every server settled", async () => {
    const { done, sent, prompt, moments } = await run("k-list",
      { FAKE_ACP_MCP_LIST: "all:ready", FAKE_ACP_MCP_LIST_READY_AFTER_MS: String(SETTLE_MS) }, mounts);
    startsOnReadiness(moments.find((moment) => moment.event === "ready")!.at, prompt, sent);
    expect(done).toMatchObject({ ok: true });
    expect(done.mcpReadiness).toBeUndefined();
  }, 60_000);

  it("an engine with neither: Murage's own servers answer its tools/list", async () => {
    const { done, sent, prompt, moments } = await run("k-connect",
      { FAKE_ACP_MCP_CONNECT: "1", FAKE_ACP_MCP_CONNECT_DELAY_MS: String(SETTLE_MS) }, ownMounts);
    const listed = moments.filter((moment) => moment.event === "listed");
    expect(listed.map((moment) => moment.name).sort()).toEqual(["agents", "murage-memory"]);
    startsOnReadiness(Math.max(...listed.map((moment) => moment.at)), prompt, sent);
    expect(done).toMatchObject({ ok: true });
    expect(done.mcpReadiness).toBeUndefined();
  }, 60_000);

  it("one of Murage's servers listed is not readiness: the turn waits for the other, up to the bound", async () => {
    process.env.MURAGE_ACP_MCP_READY_MS = "2500";
    const { done, prompt, moments, elapsed } = await run("k-partial",
      { FAKE_ACP_MCP_CONNECT: "1" }, { agents: ownMounts.agents, memory: { ...mounts.memory, env: { FIXTURE_TOOLS_LIST_HOLD: "1" } } }, false);
    expect(moments.filter((moment) => moment.event === "listed").map((moment) => moment.name)).toEqual(["agents"]);
    // MAIN RULING INT-CONFLICT-DEFAULT 591d0b436b0 eb01447e7d1: a partial tool-list receipt waits the original bound and refuses, never starts a consuming prompt.
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    // MAIN RULING INT-CONFLICT-DEFAULT 591d0b436b0 eb01447e7d1: the absent second catalog cannot authorize a prompt.
    expect(prompt).toBeUndefined();
    // MAIN RULING INT-CONFLICT-DEFAULT 591d0b436b0 eb01447e7d1: partial readiness remains unknown on the terminal refusal.
    expect(done).toMatchObject({ ok: false, mcpReadiness: "unknown" });
  }, 60_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
