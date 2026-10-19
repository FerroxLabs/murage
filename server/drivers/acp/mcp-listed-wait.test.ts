// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engines with no readiness signal of their own (Gemini, Qwen, OpenCode, Kimi,
// Droid) still start the MCP servers Murage hands them, so a prompt sent
// straight after session/new reaches a model whose tools are not there yet.
// Murage's own servers write a marker once they have answered the engine's
// tools/list (mcp-listed.ts); a cold turn on such an engine waits for the
// markers of the servers it was handed, at most 5 s, and logs a wait that
// reaches the cap. An engine that does not connect (Cursor, Hermes) is not
// waited for. A wait that ran out is not remembered.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { MCP_LISTED_WAIT_MS, resetAcpMcpReadinessForTests } from "./core.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const SETTLE_MS = 1_500;
let dir: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
const ownMounts = {
  agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MURAGE_COMMS_TOKEN: "fixture-only" } },
  memory: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: { MURAGE_MEMORY_TOKEN: "fixture-only" } },
};
type Moment = { event: "ready" | "listed" | "prompt"; at: number; name?: string };
const timeline = (): Moment[] => readFileSync(join(dir, "timeline.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Moment);

async function run(driver: ProviderDriver<any>, threadId: string, environment: Record<string, string>) {
  instance ??= await driver.create({ instanceId: `listed-${driver.driverKind}`, displayName: "Fixture", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }),
    environment: { HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_MODELS: "fixture-model", CURSOR_API_KEY: "fixture-only",
      FAKE_ACP_MCP_TIMELINE: join(dir, "timeline.jsonl"), ...environment } });
  recorder ??= recordEvents(instance.adapter);
  const sent = Date.now();
  await instance.adapter.sendTurn({ threadId, text: "hello", cwd: dir, integrations: ownMounts });
  const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  const prompts = timeline().filter((moment) => moment.event === "prompt");
  return { done, sent, prompt: prompts.at(-1)!, moments: timeline() };
}

async function restart() { recorder?.stop(); recorder = undefined; await instance?.dispose(); instance = undefined; }
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) vi.stubEnv(key, "");
  dir = mkdtempSync(join(tmpdir(), "mcp-listed-wait-"));
  resetAcpMcpReadinessForTests();
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  recorder = undefined;
  instance = undefined;
  resetAcpMcpReadinessForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeTempDirSync(dir);
});

it("the cap is 5 s", () => {
  expect(MCP_LISTED_WAIT_MS).toBe(5_000);
});

it("a cold turn on a connecting engine waits for its servers' markers and starts within 3 s of them", async () => {
  const { done, sent, prompt, moments } = await run(GeminiAgentDriver, "connect", { FAKE_ACP_MCP_CONNECT: "1", FAKE_ACP_MCP_CONNECT_DELAY_MS: String(SETTLE_MS) });
  const listed = moments.filter((moment) => moment.event === "listed");
  expect(listed.map((moment) => moment.name).sort()).toEqual(["agents", "murage-memory"]);
  const readyAt = Math.max(...listed.map((moment) => moment.at));
  // never before the markers, and within 3 s of them
  expect(prompt.at).toBeGreaterThanOrEqual(readyAt);
  expect(prompt.at - readyAt).toBeLessThan(3_000);
  expect(readyAt - sent).toBeGreaterThanOrEqual(SETTLE_MS - 100);
  expect(done).toMatchObject({ ok: true });
  expect(done.mcpReadiness).toBeUndefined();
}, 60_000);

it("a connecting engine whose servers never answer waits the cap, logs it, and the next cold turn waits again", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "1500");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const first = await run(GeminiAgentDriver, "silent-1", {});
  expect(first.prompt.at - first.sent).toBeGreaterThanOrEqual(1_500);
  expect(first.done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
  expect(warn.mock.calls.some((call) => /not listed by the engine after the 1500 ms cap \(agents, murage-memory\)/.test(String(call[0])))).toBe(true);
  // silence is never remembered
  const second = await run(GeminiAgentDriver, "silent-2", {});
  expect(second.prompt.at - second.sent).toBeGreaterThanOrEqual(1_500);
}, 60_000);

it("an engine that does not connect to the servers it is handed is not waited for", async () => {
  const { done, sent, prompt, moments } = await run(CursorAgentDriver, "cursor", {});
  expect(moments.filter((moment) => moment.event === "listed")).toEqual([]);
  expect(prompt.at - sent).toBeLessThan(MCP_LISTED_WAIT_MS - 2_000);
  expect(done).toMatchObject({ ok: true });
}, 60_000);

it("the environment cannot lengthen the 5 s cap: a value of 12 s still waits 5 s (Astra r2 P1-9)", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "12000");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const first = await run(GeminiAgentDriver, "clamped-1", {});
  expect(first.prompt.at - first.sent).toBeGreaterThanOrEqual(MCP_LISTED_WAIT_MS - 200);
  expect(first.prompt.at - first.sent).toBeLessThan(MCP_LISTED_WAIT_MS + 3_000);
}, 60_000);

it("an engine build that says nothing twice is waited for briefly, until it is heard once", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "1500");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const first = await run(GeminiAgentDriver, "quiet-1", {});
  const second = await run(GeminiAgentDriver, "quiet-2", {});
  expect(first.prompt.at - first.sent).toBeGreaterThanOrEqual(1_500);
  expect(second.prompt.at - second.sent).toBeGreaterThanOrEqual(1_500);
  // the third cold turn does not pay the cap again
  const third = await run(GeminiAgentDriver, "quiet-3", {});
  expect(third.prompt.at - third.sent).toBeLessThan(1_200);
  // a build that announces its servers is heard on the next cold turn (markers inside the short wait), and the cap is back
  await restart(); // a new process, the same build
  const heard = await run(GeminiAgentDriver, "quiet-4", { FAKE_ACP_MCP_CONNECT: "1", FAKE_ACP_MCP_CONNECT_DELAY_MS: "150" });
  expect(heard.moments.filter((moment) => moment.event === "listed").length).toBeGreaterThan(0);
  await restart();
  const after = await run(GeminiAgentDriver, "quiet-5", {});
  expect(after.prompt.at - after.sent).toBeGreaterThanOrEqual(1_500);
}, 120_000);

it("a shorter wait from the environment is kept: 100 ms waits 100 ms", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "100");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const turn = await run(GeminiAgentDriver, "short", {});
  expect(turn.prompt.at - turn.sent).toBeLessThan(2_500);
}, 60_000);
