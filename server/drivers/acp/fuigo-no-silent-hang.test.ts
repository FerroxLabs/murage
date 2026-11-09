import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-NO-SILENT-HANG (1.0.15, design r5) through the driver: a scripted fake Fuigo (fake-acp-cli fuigo-script) and
// short knobs. The rules themselves, at real limits, are in fuigo-silence.test.ts. Every value here is fake.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import type { AcpConfig } from "./core.ts";
import { FUIGO_COMPACTION_PINS, FUIGO_TURN_PINS, FuigoAgentDriver, scrubFuigoHandedEnv, withholdFuigoProviderEnv } from "./fuigo.ts";
import { GrokAgentDriver } from "./grok.ts";

// The owner's shell turns Fuigo's compaction clock off; the instance stretches it.
const SHELL = { FUIGO_COMPACTION_WALL_CLOCK_SECS: "0" } as const;
vi.mock("../../env-path.ts", async (original) => {
  const real = await original<typeof import("../../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, ...SHELL, PATH: real.augmentedPath() }, capture: "session" as const };
    }),
  };
});

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const FLUX = "sk-flux-fixture-only";
const homes: string[] = [];
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

// short knobs: tick = 200 ms
const KNOBS = { MURAGE_FUIGO_SILENT_MS: "800", MURAGE_FUIGO_TOOL_SILENT_MS: "1500", MURAGE_FUIGO_COMPACT_SILENT_MS: "2500", MURAGE_FUIGO_FAILED_GRACE_MS: "600" };

beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH/i.test(key)) vi.stubEnv(key, "");
  for (const [name, value] of Object.entries(KNOBS)) vi.stubEnv(name, value);
});
afterEach(async () => {
  recorder?.stop();
  recorder = undefined;
  await instance?.dispose();
  instance = undefined;
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

type Step = Record<string, unknown>;
const chunk = (at: number, text = "Hello. "): Step => ({ at, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const notify = (at: number, update: Record<string, unknown>, meta: Record<string, unknown> = {}): Step => ({ at, rail: "_fuigo/session_notification", update, meta });
const tool = (at: number, status: string, id = "t1"): Step => ({ at, update: { sessionUpdate: status === "start" ? "tool_call" : "tool_call_update", toolCallId: id, title: "run", kind: "execute", status: status === "start" ? "in_progress" : status } });
const endTurn = (at: number): Step => ({ at, result: { stopReason: "end_turn" } });

async function start(script: Step[], options: { environment?: Record<string, string>; driver?: "grok" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "murage-fuigo-hang-"));
  homes.push(home);
  const log = join(home, "script.log");
  const driver = (options.driver === "grok" ? GrokAgentDriver : FuigoAgentDriver) as unknown as ProviderDriver<AcpConfig>;
  instance = await driver.create({ instanceId: "fuigo-hang", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script), FAKE_ACP_SCRIPT_LOG: log,
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model", FUIGO_API_KEY: FLUX, ...options.environment } });
  recorder = recordEvents(instance.adapter);
  const startedAt = Date.now();
  await instance.adapter.sendTurn({ threadId: "fhang", text: "hello", cwd: home });
  const answers = () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
  return { home, startedAt, answers, adapter: instance.adapter };
}
const completed = (timeoutMs = 15_000) => recorder!.until((e) => e.threadId === "fhang" && e.type === "turn.completed", timeoutMs) as Promise<RuntimeEvent & { ok: boolean; stopReason: string | null }>;
const errors = () => recorder!.events.filter((e) => e.type === "runtime.error").map((e) => (e as { message: string }).message);
const turnsCompleted = () => recorder!.events.filter((e) => e.type === "turn.completed").length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the silence rule through the driver", () => {
  it("a Fuigo that never answers ends with the watch's line, no_first_response, one outcome (test 1)", async () => {
    const { startedAt } = await start([]);
    const done = await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(750);
    expect(done).toMatchObject({ ok: false, stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo did not start answering within 1 second. Flux Router may be out of reach. Try again in a moment."]);
    await sleep(500);
    expect(turnsCompleted()).toBe(1);
  }, 20_000);

  it("connect retries on both rails every 100 ms never reset it (tests 2, 5)", async () => {
    const reason = "Connection problem; retrying request";
    const steps: Step[] = [];
    for (let at = 50; at < 4000; at += 100) {
      steps.push(notify(at, { sessionUpdate: "retry_state", type: "retrying", attempt: 1, reason, error_type: "http" }));
      steps.push({ at, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Retrying the model (1/3)" } }, meta: { "fuigo/retryStatus": { type: "retrying" } } });
    }
    const { startedAt } = await start(steps);
    const done = await completed();
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(done).toMatchObject({ ok: false, stopReason: "no_first_response" });
  }, 20_000);

  it("silent after an answer began: the went-silent line (test 6)", async () => {
    await start([chunk(50)]);
    expect(await completed()).toMatchObject({ ok: false, stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo went silent for 1 second, so the turn was stopped. Try again in a moment."]);
  }, 20_000);

  it("steady progress past every limit finishes cleanly", async () => {
    const steps: Step[] = [];
    for (let at = 50; at < 3000; at += 300) steps.push(chunk(at, "more. "));
    steps.push(endTurn(3000));
    await start(steps);
    expect(await completed()).toMatchObject({ ok: true, stopReason: null });
    expect(errors()).toEqual([]);
  }, 20_000);

  it("a failed retry, then Fuigo's typed error inside the grace: the engine's error is the one outcome (test 13)", async () => {
    await start([
      notify(600, { sessionUpdate: "retry_state", type: "failed", error_type: "http", message: "reqwest error stream" }),
      { at: 1000, error: { code: -32603, message: "Internal error", data: { message: "reqwest error stream: error sending request", error_kind: "http" } } },
    ]);
    const done = await completed();
    expect(done.stopReason).not.toBe("no_first_response");
    expect(errors().some((message) => message.includes("Flux Router may be out of reach"))).toBe(false);
  }, 20_000);
});

describe("local work (r5-1, r5-2)", () => {
  it("buffered response and tool frames after auto_compact_started do not hand the turn to the 2 minute rule (test 27)", async () => {
    const { startedAt } = await start([
      chunk(50), tool(60, "start"), notify(100, { sessionUpdate: "auto_compact_started" }),
      notify(120, { sessionUpdate: "response_completed" }), tool(130, "completed"),
    ]);
    const done = await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2400);
    expect(done).toMatchObject({ ok: false, stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo was compacting the conversation for 3 seconds without finishing. Try again in a moment."]);
  }, 20_000);

  it("a compaction that completes hands back to the silence rule, timed from the end (test 12)", async () => {
    const { startedAt } = await start([chunk(50), notify(100, { sessionUpdate: "auto_compact_started" }), notify(1500, { sessionUpdate: "auto_compact_completed" })]);
    const done = await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2200);
    expect(done).toMatchObject({ stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo went silent for 1 second, so the turn was stopped. Try again in a moment."]);
  }, 20_000);

  it("a memory flush ending does not end an open compaction (test 22)", async () => {
    const { startedAt } = await start([
      chunk(50), notify(100, { sessionUpdate: "auto_compact_started" }), notify(150, { sessionUpdate: "memory_flush_started" }),
      notify(200, { sessionUpdate: "memory_flush_completed", result: "written" }),
    ]);
    await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2400);
    expect(errors()[0]).toContain("compacting the conversation");
  }, 20_000);
});

describe("the tool rule (r4 H3, r5-3, r5-4)", () => {
  it("a tool running with no word: the tool rule at its own limit, never the silence rule (test 24)", async () => {
    const { startedAt } = await start([chunk(50), tool(60, "start")]);
    const done = await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
    expect(done).toMatchObject({ ok: false, stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo had a tool running for 2 seconds without a word, so the turn was stopped."]);
  }, 20_000);

  it("a model chunk while the tool is still running restarts the tool clock (test 24b)", async () => {
    const { startedAt } = await start([tool(50, "start"), chunk(1200, "still going. ")]);
    await completed();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2600);
    expect(errors()[0]).toContain("had a tool running");
  }, 20_000);

  it("a fallback turn held after the prompt result that stalls on a tool is ended by the tool rule (test 25)", async () => {
    vi.stubEnv("MURAGE_FUIGO_FALLBACK_GRACE_MS", "300");
    const { adapter } = await start([chunk(50), endTurn(700)], { environment: { FAKE_ACP_INTERJECT: "fallback", FAKE_ACP_FALLBACK_STALL: "tool" } });
    await recorder!.until((e) => e.type === "content.delta", 10_000);
    expect(await adapter.steer!("fhang", "also the totals")).toBe("delivered");
    const done = await completed();
    expect(done).toMatchObject({ ok: false, stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo had a tool running for 2 seconds without a word, so the turn was stopped."]);
    expect(turnsCompleted()).toBe(1);
  }, 20_000);
});

describe("cards and engine requests pause the watch (tests 10, 26)", () => {
  const ASK = { toolCallId: "tc-ask", mode: "default", questions: [{ question: "Which database?", options: [{ label: "Redis", description: "" }, { label: "Postgres", description: "" }] }] };

  it("a question card open past every limit holds; after the answer, silence ends the turn from the answer", async () => {
    const { answers, adapter } = await start([chunk(50), tool(60, "start"), { at: 100, request: { id: 9401, method: "_fuigo/ask_user_question", params: ASK } }]);
    const opened = await recorder!.until((e) => e.type === "request.opened", 10_000) as { requestId: string };
    await sleep(3500);
    expect(turnsCompleted()).toBe(0);
    const answeredAt = Date.now();
    await adapter.respondToRequest("fhang", opened.requestId, { behavior: "answer", message: "Redis", answers: [{ id: "q1", selected: ["Redis"] }] });
    const done = await completed();
    expect(answers()).toHaveLength(1);
    expect(Date.now() - answeredAt).toBeGreaterThanOrEqual(1400);
    expect(done).toMatchObject({ stopReason: "no_first_response" });
    expect(errors()).toEqual(["Fuigo had a tool running for 2 seconds without a word, so the turn was stopped."]);
  }, 30_000);
});

describe("stops, other engines", () => {
  it("a Stop before any rule is due is a cancellation with no watch line (test 15)", async () => {
    const { adapter } = await start([chunk(50)]);
    await sleep(300);
    await adapter.interruptTurn("fhang");
    const done = await completed();
    expect(done.stopReason).not.toBe("no_first_response");
    await sleep(1500);
    expect(errors().filter((message) => message.includes("went silent") || message.includes("did not start answering"))).toEqual([]);
    expect(turnsCompleted()).toBe(1);
  }, 20_000);

  it("an engine crash before any rule is due: the crash is the one outcome, no watch line after it (test 15)", async () => {
    await start([chunk(50), { at: 300, exit: 3 }]);
    const done = await completed();
    expect(done.stopReason).not.toBe("no_first_response");
    await sleep(1500);
    expect(errors().filter((message) => message.includes("went silent") || message.includes("did not start answering"))).toEqual([]);
    expect(turnsCompleted()).toBe(1);
  }, 20_000);

  it("dispose (quit, restart) mid-turn: no watch line after it (test 15)", async () => {
    await start([chunk(50)]);
    await sleep(300);
    const disposing = instance!;
    instance = undefined;
    await disposing.dispose();
    await sleep(1500);
    expect(errors().filter((message) => message.includes("went silent") || message.includes("did not start answering"))).toEqual([]);
    expect(turnsCompleted()).toBeLessThanOrEqual(1);
  }, 20_000);

  it("Grok Build has no Fuigo watch: a 2 s silence then end_turn finishes cleanly (test 18)", async () => {
    await start([chunk(50), endTurn(2000)], { driver: "grok" });
    expect(await completed()).toMatchObject({ ok: true, stopReason: null });
    expect(errors()).toEqual([]);
  }, 20_000);
});

describe("the compaction pin (test 29)", () => {
  it("FUIGO_COMPACTION_WALL_CLOCK_SECS is a turn pin at Fuigo's own 300", () => {
    expect(FUIGO_COMPACTION_PINS).toEqual({ FUIGO_COMPACTION_WALL_CLOCK_SECS: "300" });
    expect(FUIGO_TURN_PINS).toMatchObject(FUIGO_COMPACTION_PINS);
  });

  it("child and handed map: 300 over the shell's 0 and an instance's 900, every Windows casing replaced", () => {
    for (const platform of ["linux", "win32"] as const) {
      const child: Record<string, string | undefined> = { FUIGO_API_KEY: FLUX, fuigo_compaction_wall_clock_secs: "900", FUIGO_COMPACTION_WALL_CLOCK_SECS: "0" };
      withholdFuigoProviderEnv(child, platform);
      const map: Record<string, string | undefined> = { ...SHELL, Fuigo_Compaction_Wall_Clock_Secs: "900" };
      scrubFuigoHandedEnv(map, child, platform);
      // the name Fuigo reads: any casing on Windows, the exact name elsewhere
      const named = (env: Record<string, string | undefined>) => Object.entries(env)
        .filter(([name]) => (platform === "win32" ? name.toUpperCase() : name) === "FUIGO_COMPACTION_WALL_CLOCK_SECS");
      expect([platform, named(child)]).toEqual([platform, [["FUIGO_COMPACTION_WALL_CLOCK_SECS", "300"]]]);
      expect([platform, map.FUIGO_COMPACTION_WALL_CLOCK_SECS]).toEqual([platform, "300"]);
    }
  });

  it("the spawned engine gets 300 over the shell's 0 and the instance's 900", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-fuigo-hang-pin-"));
    homes.push(home);
    const dump = join(home, "spawn.json");
    const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
    instance = await driver.create({ instanceId: "fuigo-hang-pin", displayName: "Fuigo", enabled: true, config: driver.decodeConfig({ cli }),
      environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model",
        FUIGO_API_KEY: FLUX, FUIGO_COMPACTION_WALL_CLOCK_SECS: "900"} });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "fhang", text: "hello", cwd: home });
    await completed();
    const spawned = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
    expect(spawned.env.FUIGO_COMPACTION_WALL_CLOCK_SECS).toBe("300");
  }, 30_000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
