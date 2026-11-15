import { bindFixtureAdapter } from "../../testing/mcp-admission-fixture.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordAdmittedEvents as recordEvents, type EventRecorder } from "../../testing/admitted-events.ts";
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
const timeline = (): Moment[] => existsSync(join(dir, "timeline.jsonl")) ? readFileSync(join(dir, "timeline.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Moment) : [];

async function run(driver: ProviderDriver<any>, threadId: string, environment: Record<string, string>) {
  instance ??= await driver.create({ instanceId: `listed-${driver.driverKind}`, displayName: "Fixture", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }),
    environment: { HOME: dir, USERPROFILE: dir, FAKE_ACP_MODE: "happy", FAKE_ACP_MODELS: "fixture-model", CURSOR_API_KEY: "fixture-only",
      FAKE_ACP_MCP_TIMELINE: join(dir, "timeline.jsonl"), ...environment } });
  bindFixtureAdapter(instance.adapter);
  recorder ??= recordEvents(instance.adapter);
  const previousMoments = timeline().length;
  const sent = Date.now();
  await instance.adapter.sendTurn({ threadId, text: "hello", cwd: dir, integrations: ownMounts });
  const done = await recorder.until((e) => e.threadId === threadId && e.type === "turn.completed", 30_000) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  const moments = timeline().slice(previousMoments);
  const prompts = moments.filter(moment => moment.event === "prompt");
  if (driver === GeminiAgentDriver && environment.FAKE_ACP_MCP_CONNECT !== "1") {
    expect(done).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(prompts).toEqual([]);
  }
  return { done, sent, ended: Date.now(), elapsed: Date.now() - sent, prompt: prompts.at(-1)!, moments };
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
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: a consuming mount that is not ready refuses before prompt delivery.
  expect(first.elapsed).toBeGreaterThanOrEqual(1_500);
  expect(first.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
  expect(first.prompt).toBeUndefined();
  expect(warn.mock.calls.some((call) => /not listed by the engine after the 1500 ms cap \(agents, murage-memory(?:-[a-f0-9]{20})?\)/.test(String(call[0])))).toBe(true);
  // silence is never remembered
  const second = await run(GeminiAgentDriver, "silent-2", {});
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: the fresh consuming attempt retains its readiness bound and zero-write refusal.
  expect(second.elapsed).toBeGreaterThanOrEqual(1_500);
  expect(second.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
  expect(second.prompt).toBeUndefined();
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
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: cap expiry refuses a consuming mount, still within the original bound.
  expect(first.elapsed).toBeGreaterThanOrEqual(MCP_LISTED_WAIT_MS - 200);
  expect(first.elapsed).toBeLessThan(MCP_LISTED_WAIT_MS + 3_000);
  expect(first.prompt).toBeUndefined();
  expect(first.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
}, 60_000);

it("an engine build that says nothing twice is waited for briefly, until it is heard once", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "1500");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const first = await run(GeminiAgentDriver, "quiet-1", {});
  const second = await run(GeminiAgentDriver, "quiet-2", {});
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: keep the readiness wait and refuse an unready consuming mount.
  expect(first.elapsed).toBeGreaterThanOrEqual(1_500);
  expect(first.prompt).toBeUndefined();
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: the fresh consuming attempt retains its readiness bound and zero-write refusal.
  expect(second.elapsed).toBeGreaterThanOrEqual(1_500);
  expect(second.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
  expect(second.prompt).toBeUndefined();
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: silent-build heuristics retain their short wait but still refuse consuming mounts without readiness.
  const third = await run(GeminiAgentDriver, "quiet-3", {});
  expect(third.elapsed).toBeLessThan(1_200);
  expect(third.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
  expect(third.prompt).toBeUndefined();
  // a build that announces its servers is heard on the next cold turn (markers inside the short wait), and the cap is back
  await restart(); // a new process, the same build
  const heard = await run(GeminiAgentDriver, "quiet-4", { FAKE_ACP_MCP_CONNECT: "1", FAKE_ACP_MCP_CONNECT_DELAY_MS: "150" });
  expect(heard.moments.filter((moment) => moment.event === "listed").length).toBeGreaterThan(0);
  await restart();
  const after = await run(GeminiAgentDriver, "quiet-5", {});
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: readiness heard again restores the bounded zero-write refusal.
  expect(after.elapsed).toBeGreaterThanOrEqual(1_500);
  expect(after.prompt).toBeUndefined();
}, 120_000);

it("a shorter wait from the environment is kept: 100 ms waits 100 ms", async () => {
  vi.stubEnv("MURAGE_ACP_MCP_LISTED_MS", "100");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const turn = await run(GeminiAgentDriver, "short", {});
  // MAIN RULING INT-CONFLICT-DEFAULT eb01447e7d: preserve the short cap, with no unready prompt delivery.
  expect(turn.elapsed).toBeLessThan(2_500);
  expect(turn.prompt).toBeUndefined();
  expect(turn.done).toMatchObject({ ok: false, stopReason: "memory-refused" });
}, 60_000);

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
