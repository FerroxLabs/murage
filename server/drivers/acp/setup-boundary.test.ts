// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// O1M2-EXTRACT: the content-free setup boundary (setup-boundary.ts, core.ts acpSetupBoundary) was cut out of
// sendTurnFenced with no behaviour change. Owners: the ACP driver core owns both sides (the setup boundary and the
// prompt composition that consumes its record); this file owns the witnesses.
//
// EQUALITY: every recorded turn below runs through the real driver dispatch (adapter.sendTurn on the fake ACP CLI) and
// its normalized canonical events, the frames the driver wrote to the engine's stdin and the prompt bytes the engine
// received must be byte-identical to the transcript recorded on the pre-extraction sha (__fixtures__/setup-boundary-
// equality.json, recorded with ACP_SETUP_EQ_RECORD=<path> on e42188c177).
// BOUNDARY: the same turns hand AcpSupport.observeSetup exactly one record each when setup completes, holding only the
// allow-listed content-free fields, and none when the turn ends inside setup.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { recordAdmittedEvents, type EventRecorder } from "../../testing/admitted-events.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import { geminiAcpSupport } from "./gemini.ts";
import { grokAcpSupport } from "./grok.ts";

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const IDLE_MCP = fileURLToPath(new URL("../../testing/fake-idle-mcp.mjs", import.meta.url));
const idleMount = (label: string) => ({ command: process.execPath, args: [IDLE_MCP, label], env: {} });
const GOLDEN = fileURLToPath(new URL("./__fixtures__/setup-boundary-equality.json", import.meta.url));
/** The record's allow-list, spelled out here (not imported) so this file also runs on the pre-extraction sha. */
const RECORD_KEYS = ["nativeSessionId", "reused", "promptRewritten", "modelPinConfirmed", "failedServers", "absentServers", "mcpOutcome"];

const SELECT_MODEL: AcpSupport = {
  driverKind: "selectModelTest", fluxReach: () => "elsewhere" as const, displayName: "Select Model Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
  defaultCli: "fake-select-model", nativeSource: "test.acp", loginNote: "never reached", selectModel: { configId: "model" },
  spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
};
const CLASSIFIED: AcpSupport = {
  ...SELECT_MODEL, driverKind: "classifiedErrorTest", selectModel: undefined,
  classifyError: (error) => error && typeof error === "object" && (error as { code?: unknown }).code === -32000 ? "invalid_credentials" : undefined,
};

const POOL: AcpSupport = {
  driverKind: "poolTest", fluxReach: () => "elsewhere" as const, displayName: "Pool Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] }, defaultCli: "fake-pool", nativeSource: "pool.acp",
  loginNote: "never reached", spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null, authFailure: "continue", isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized", pooledSessions: true,
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

type Observed = { record: Record<string, unknown>; threadId: string; turnId: string };
interface Scenario {
  name: string;
  support: AcpSupport;
  env?: Record<string, string>;
  turn: Omit<SendTurnInput, "cwd">;
  /** Runs after sendTurn returns and before the turn is awaited (a Stop inside setup). */
  during?: (ctx: { instance: ProviderInstance; dir: string; threadId: string }) => Promise<void>;
  /** Runs once the turn completed, before the instance is disposed (a later intent warm on the same thread). */
  after?: (ctx: { instance: ProviderInstance; dir: string; threadId: string; turnId: string; recorder: EventRecorder }) => Promise<void>;
  /** The record this turn's setup must hand over, or null when the turn ends inside setup. */
  record: Record<string, unknown> | null;
  /** The records later turns run by `after` hand over, in order. */
  afterRecords?: Record<string, unknown>[];
  completed: { ok: boolean } & Record<string, unknown>;
}

const fresh = { reused: false, promptRewritten: false, failedServers: null, absentServers: [], mcpOutcome: null };
const SCENARIOS: Scenario[] = [
  { name: "fresh session", support: grokAcpSupport, turn: { threadId: "t-eq-fresh", text: "hello" },
    record: { ...fresh, nativeSessionId: "fake-acp-session", modelPinConfirmed: true }, completed: { ok: true } },
  { name: "session/load with a model pin", support: SELECT_MODEL, env: { FAKE_ACP_MODELS: "m-one,m-two" },
    turn: { threadId: "t-eq-load", text: "go", model: "m-two", resumeCursor: "resumed-thread-1" },
    record: { ...fresh, nativeSessionId: "resumed-thread-1", modelPinConfirmed: true }, completed: { ok: true } },
  { name: "model pin refused after session/load: the turn fails inside setup", support: SELECT_MODEL,
    turn: { threadId: "t-eq-pin-refused", text: "go", model: "m-two", resumeCursor: "resumed-thread-2" },
    record: null, completed: { ok: false } },
  { name: "session/load answers null: fresh session with the replayed transcript", support: grokAcpSupport,
    env: { FAKE_ACP_LOAD_NULL: "1" },
    turn: { threadId: "t-eq-null", text: "go", resumeCursor: "gone-cursor", transcript: [{ role: "user", text: "Fixture prior line" }] },
    record: { ...fresh, nativeSessionId: "fake-acp-session", promptRewritten: true, modelPinConfirmed: true }, completed: { ok: true } },
  { name: "session/load not found: fresh session, notice and replay", support: geminiAcpSupport,
    env: { FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32602, message: "Session not found", data: { sessionId: "missing-cursor" } }) },
    turn: { threadId: "t-eq-missing", text: "What did I say?", resumeCursor: "missing-cursor",
      transcript: [{ role: "user", text: "Remember ALPHA." }, { role: "assistant", text: "Remembered." }] },
    record: { ...fresh, nativeSessionId: "fake-acp-session", promptRewritten: true, modelPinConfirmed: true }, completed: { ok: true } },
  { name: "session/load refused: the turn fails inside setup", support: CLASSIFIED,
    env: { FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32000, message: "authentication required" }) },
    turn: { threadId: "t-eq-refused", text: "Continue", resumeCursor: "saved-session", transcript: [{ role: "user", text: "Prior message" }] },
    record: null, completed: { ok: false, stopReason: "auth_required" } },
  { name: "Stop while session/new is held: the turn ends inside setup", support: grokAcpSupport,
    env: { FAKE_ACP_SESSION_NEW_GATE: "@dir/session-new" },
    turn: { threadId: "t-eq-stop", text: "hi" },
    during: async ({ instance, dir, threadId }) => {
      await until(() => existsSync(join(dir, "session-new.waiting")));
      const stopping = instance.adapter.interruptTurn(threadId).catch(() => undefined);
      writeFileSync(join(dir, "session-new"), "");
      await stopping;
    },
    record: null, completed: { ok: true, stopReason: "cancelled" } },
  // The child outlives the Stop (it ignores SIGTERM until the exit gate), so session/new is answered after the Stop and setup
  // reaches its own halt guard (ACP_SETUP_HALTED) instead of a rejected request.
  { name: "Stop All while session/new is held, child still closing: setup halts at its guard", support: grokAcpSupport,
    env: { FAKE_ACP_SESSION_NEW_GATE: "@dir/session-new", FAKE_ACP_TERM: "gate", FAKE_ACP_EXIT_GATE: "@dir/exit" },
    turn: { threadId: "t-eq-stop-linger", text: "hi" },
    during: async ({ instance, dir }) => {
      await until(() => existsSync(join(dir, "session-new.waiting")));
      const stopping = instance.adapter.stopAll().catch(() => undefined);
      writeFileSync(join(dir, "session-new"), "");
      // the answer lands on the still-open child; give the driver its read before the child may exit
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(join(dir, "exit"), "");
      await stopping;
    },
    record: null, completed: { ok: true, stopReason: "cancelled" } },
  // MCP readiness with servers: the engine lists one required server failed and names no other, so both lists are non-empty.
  { name: "MCP servers: one required server failed, one unnamed: the consuming turn is refused inside setup", support: grokAcpSupport,
    env: { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_LIST: JSON.stringify({ agents: "failed" }),
      MURAGE_MCP_RECONNECT_WAIT_MS: "0", MURAGE_ACP_MCP_READY_MS: "2500", MURAGE_ACP_MCP_OWN_READY_MS: "200" },
    turn: { threadId: "t-eq-mcp-failed", text: "hello", integrations: { agents: idleMount("fixture-agents"), composio: idleMount("fixture-composio") } },
    record: null, completed: { ok: false, stopReason: "memory-refused", mcpReadiness: "unknown", toolsUnavailable: ["messaging other bots"] } },
  { name: "MCP servers: every server listed ready", support: grokAcpSupport,
    env: { FAKE_ACP_MCP_LIST: "all:ready", MURAGE_ACP_MCP_READY_MS: "2500", MURAGE_ACP_MCP_OWN_READY_MS: "200" },
    turn: { threadId: "t-eq-mcp-ready", text: "hello", integrations: { agents: idleMount("fixture-agents"), memory: idleMount("fixture-memory") } },
    record: { ...fresh, nativeSessionId: "fake-acp-session", modelPinConfirmed: true, failedServers: [], mcpOutcome: "ready" }, completed: { ok: true } },
  // A second turn on the thread adopts the parked process (the reused branch: no initialize, the session it holds).
  { name: "pooled turn, then a second turn on the parked process", support: POOL,
    env: { MURAGE_ACP_POOL: "1", MURAGE_ACP_POOL_IDLE_MS: "60000", FAKE_ACP_MCP_READY: "1" },
    turn: { threadId: "t-eq-reuse", text: "one" },
    after: async ({ instance, threadId, turnId: first, recorder }) => {
      await instance.adapter.awaitTurnTeardown?.(threadId, first);
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "two", resumeCursor: "fake-acp-session" } as SendTurnInput);
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    },
    record: { ...fresh, nativeSessionId: "fake-acp-session", modelPinConfirmed: true },
    afterRecords: [{ ...fresh, nativeSessionId: "fake-acp-session", reused: true, modelPinConfirmed: true }], completed: { ok: true } },
  // An intent warm runs setup and ends at its own guard (settle, then ACP_SETUP_HALTED): no prompt, no record.
  { name: "pooled turn, idle close, then an intent warm: the warm ends inside setup", support: POOL,
    env: { MURAGE_ACP_POOL: "1", MURAGE_ACP_POOL_IDLE_MS: "150", MURAGE_WARM_ACTIVITY_WINDOW_MS: "250", FAKE_ACP_MCP_READY: "1", FAKE_ACP_SPAWN_LOG: "@dir/spawns.log" },
    turn: { threadId: "t-eq-warm", text: "one" },
    after: async ({ instance, dir, threadId }) => {
      const [pid] = readFileSync(join(dir, "spawns.log"), "utf8").trim().split("\n").map(Number);
      await until(() => !alive(pid!));
      vi.stubEnv("MURAGE_ACP_POOL_IDLE_MS", "60000");
      expect(await instance.adapter.prewarm!(threadId)).toBe(true);
    },
    record: { ...fresh, nativeSessionId: "fake-acp-session", modelPinConfirmed: true }, completed: { ok: true } },
];

const until = async (seen: () => boolean) => { while (!seen()) await new Promise((resolve) => setTimeout(resolve, 10)); };

/** Stable placeholders for everything a run varies by itself (ids, times, pids, temp paths); content is kept verbatim. */
function normalizer(paths: Record<string, string>) {
  const ids = new Map<string, string>();
  const id = (value: string, prefix: string) => { if (!ids.has(value)) ids.set(value, `${prefix}${ids.size + 1}`); return ids.get(value)!; };
  // camelCase suffixes only (createdAt, waitedMs), so keys like "format" or "params" are never blanked
  const VOLATILE = /^(at|ts|ms|pid|seq|time)$|[a-z](At|Ms|Time)$|^(elapsed|duration)/;
  const ID_KEY = /^(eventId|turnId|itemId|requestId|processGeneration|launchId|callId|diagnosticId)$/;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const text = (value: string) => {
    let out = value;
    for (const [name, path] of Object.entries(paths)) out = out.split(path).join(`<${name}>`);
    // per-run secrets and names (relay tickets, socket digests) get stable placeholders; equal values stay equal
    return out.replace(UUID, (match) => id(match, "U")).replace(/\b[0-9a-f]{32,}\b/g, (match) => id(match, "H"))
      .replace(/^[A-Za-z0-9_-]{40,}$/, (match) => id(match, "K"));
  };
  const walk = (value: unknown, key = ""): unknown => {
    if ((typeof value === "number" || typeof value === "string") && VOLATILE.test(key)) return "#";
    if (typeof value === "string") return ID_KEY.test(key) ? id(value, "I") : text(value);
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return walk;
}

interface Run { transcript: string; observed: Observed[]; completed: RuntimeEvent | undefined }
async function runScenario(scenario: Scenario): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "murage-setup-eq-"));
  const env: Record<string, string> = { FAKE_ACP_RPC_LOG: join(dir, "rpc.jsonl"), FAKE_ACP_RPC_FULL_LOG: join(dir, "rpc-full.jsonl"), FAKE_ACP_PROMPT_DUMP: join(dir, "prompt.json") };
  resetAcpMcpReadinessForTests();
  for (const [key, value] of Object.entries(scenario.env ?? {})) env[key] = value.replace("@dir", dir);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const observed: Observed[] = [];
  const driver = createAcpDriver({ ...scenario.support, observeSetup: (record, at) => { observed.push({ record: { ...record }, ...at }); } });
  const instance = await driver.create({ instanceId: "setup-eq", displayName: "Setup Eq", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const recorder = recordAdmittedEvents(instance.adapter);
  try {
    const cwd = fixtureBotFolder();
    const { turnId } = await instance.adapter.sendTurn({ cwd, ...scenario.turn } as SendTurnInput);
    await scenario.during?.({ instance, dir, threadId: scenario.turn.threadId });
    const completed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    await scenario.after?.({ instance, dir, threadId: scenario.turn.threadId, turnId, recorder });
    recorder.stop();
    await instance.dispose();
    const walk = normalizer({ scratch: dir, bot: cwd, cli: FAKE_CLI, tmp: tmpdir() });
    const rpc = existsSync(env.FAKE_ACP_RPC_LOG)
      ? readFileSync(env.FAKE_ACP_RPC_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    // FAKE_ACP_RPC_FULL_LOG writes each client frame whole (method and params) just before FAKE_ACP_RPC_LOG writes its line
    // for the same frame, so the two logs pair line by line: the process from one, the params from the other.
    const full = existsSync(env.FAKE_ACP_RPC_FULL_LOG)
      ? readFileSync(env.FAKE_ACP_RPC_FULL_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    expect(full.map((frame: { method: string }) => frame.method), "the two frame logs pair line by line").toEqual(rpc.map((frame: { method: string }) => frame.method));
    const pids = new Map<number, string>();
    const frames = rpc.map((frame: Record<string, unknown>, index: number) => {
      const pid = frame.pid as number;
      if (!pids.has(pid)) pids.set(pid, `P${pids.size + 1}`);
      const { pid: _pid, ...rest } = frame;
      return { proc: pids.get(pid), ...(walk(rest) as object), params: walk(full[index].params, "params") };
    });
    const prompt = existsSync(env.FAKE_ACP_PROMPT_DUMP) ? JSON.parse(readFileSync(env.FAKE_ACP_PROMPT_DUMP, "utf8")) : null;
    const transcript = JSON.stringify({ events: walk(recorder.events), frames, prompt: walk(prompt) }, null, 1);
    return { transcript, observed, completed };
  } finally {
    recorder.stop();
    await instance.dispose().catch(() => undefined);
    vi.unstubAllEnvs();
    removeTempDirSync(dir);
  }
}

describe("O1M2-EXTRACT: the ACP setup boundary", () => {
  const recorded: Record<string, string> = {};
  const observedRecords: Record<string, Observed[]> = {};
  beforeAll(() => ensureDirs());
  afterAll(() => vi.unstubAllEnvs());

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))("%s", async (name, scenario) => {
    const run = await runScenario(scenario);
    const record = process.env.ACP_SETUP_EQ_RECORD;
    // recording onto the golden would make the comparison below compare a transcript with itself
    expect(record === undefined || !record.endsWith("setup-boundary-equality.json"), "record next to the golden, never onto it").toBe(true);
    if (record) {
      recorded[name] = run.transcript; writeFileSync(record, JSON.stringify(recorded, null, 1) + "\n");
      observedRecords[name] = run.observed; writeFileSync(`${record}.observed.json`, JSON.stringify(observedRecords, null, 1) + "\n");
    }
    // EQUALITY: events, stdin frames and prompt bytes equal the pre-extraction transcript.
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
    expect(golden[name], "a golden transcript is recorded for this turn").toBeTypeOf("string");
    expect(run.transcript === golden[name], "byte-identical to the pre-extraction transcript").toBe(true);
    // BOUNDARY: one content-free record when setup completes, none when the turn ends inside it.
    const expected = [
      ...(scenario.record === null ? [] : [{ record: scenario.record, threadId: scenario.turn.threadId, turnId: run.completed?.turnId }]),
      ...(scenario.afterRecords ?? []).map((record) => ({ record, threadId: scenario.turn.threadId, turnId: expect.any(String) })),
    ];
    expect(run.observed).toEqual(expected);
    for (const { record: seen } of run.observed) expect(Object.keys(seen).sort()).toEqual([...RECORD_KEYS].sort());
    expect(run.completed).toMatchObject(scenario.completed);
  }, 60_000);
});

// ORDER: setup and prompt composition are one job. In the pre-extraction code everything from the session.started emit (inside
// setup) through the submission fence and the session/prompt write ran with no await between, so a caller that acts on
// session.started in a microtask (a lease revoke, a Stop) always ran AFTER the fence. The boundary's exit must not add a
// microtask. Entry: adapter.sendTurn with SendTurnInput.beforeSubmit, the fence the prompt write calls.
describe("O1M2-EXTRACT: setup exit adds no job before the prompt write", () => {
  beforeAll(() => ensureDirs());
  it("the submission fence runs before any continuation of session.started", async () => {
    resetAcpMcpReadinessForTests();
    const driver = createAcpDriver(grokAcpSupport);
    const instance = await driver.create({ instanceId: "setup-order", displayName: "Setup Order", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordAdmittedEvents(instance.adapter);
    let startedContinued = false;
    const fenceSawStartedContinuation: boolean[] = [];
    const started = recorder.until((e) => e.type === "session.started").then(() => { startedContinued = true; });
    try {
      const { turnId } = await instance.adapter.sendTurn({
        cwd: fixtureBotFolder(), threadId: "t-order", text: "hello",
        beforeSubmit: () => { fenceSawStartedContinuation.push(startedContinued); },
      } as SendTurnInput);
      await started;
      const completed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(completed).toMatchObject({ ok: true });
      expect(fenceSawStartedContinuation.length, "the fence ran for the prompt write").toBeGreaterThan(0);
      expect(fenceSawStartedContinuation.at(-1), "the write's fence ran before the caller's continuation of session.started").toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose().catch(() => undefined);
    }
  }, 60_000);
});
