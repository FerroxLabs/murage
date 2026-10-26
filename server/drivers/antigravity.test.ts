// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  ANTIGRAVITY_AGENTS_MCP_KEY,
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  ANTIGRAVITY_PRINT_TIMEOUT,
  AntigravityDriver,
  antigravityAgentsMcpServer,
  antigravityComputerMcpServer,
  antigravityMcpServers,
  ANTIGRAVITY_CUSTOM_MCP_PREFIX,
  supportsAntigravityStreamInput,
  readAntigravityModelCatalog,
  parseAntigravityModelsOutput,
  catalogFromAgyList,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { TURN_ASK_RULES } from "../../shared/ask-wording.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

describe("Antigravity stream input compatibility", () => {
  it("requires the release that introduced stream-JSON stdin", () => {
    expect(supportsAntigravityStreamInput("1.1.14")).toBe(false);
    expect(supportsAntigravityStreamInput("1.1.15")).toBe(true);
    expect(supportsAntigravityStreamInput("1.2.0-beta.1")).toBe(true);
    expect(supportsAntigravityStreamInput("not-semver")).toBe(false);
  });
});

describe("agy 1.4.3 model list", () => {
  const live = "gemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\nFetching available models...\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
  it("parses the CLI list and ignores progress lines", () => {
    expect(parseAntigravityModelsOutput(live).map(({ id }) => id)).toEqual(["gemini-4-argon-medium", "gemini-4-argon-high", "gpt-oss-120b-medium"]);
  });
  it("defaults to a model the CLI listed", () => {
    const catalog = catalogFromAgyList(parseAntigravityModelsOutput(live));
    expect(catalog.options.map(({ id }) => id)).toContain(catalog.default);
    expect(catalogFromAgyList(parseAntigravityModelsOutput("only-one\tOnly")).default).toBe("only-one");
  });
  it("static default is in the 1.4.3 list", () => {
    expect(STATIC_ANTIGRAVITY_MODELS.default).toBe("gemini-4-argon-high");
  });
});

describe("readAntigravityModelCatalog", () => {
  it("includes the confirmed Gemini 3.8 Flash variants without changing the default", () => {
    const catalog = readAntigravityModelCatalog({ HOME: join(tmpdir(), "murage-agy-missing-home") });
    expect(catalog.default).toBe("gemini-4-argon-high");
    expect(catalog.options.map(({ id }) => id)).not.toContain("gemini-3.1-pro-high");
    expect(catalog.options.filter(({ id }) => id.startsWith("gemini-3.8-flash-"))).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    ]);
  });

  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "murage-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      removeTempDirSync(home);
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary and fullAuto on", () => {
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: true });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: true });
  });
  it("fullAuto defaults to true, only false when explicitly set", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(true);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });
});

// 1.0.3: the turn spawn asks for the Windows engine job (procs.ts engineJob). engineJob answers only on Windows, so here it is
// a stand-in and every spawnCli job argument is recorded; the real spawnCli still runs (off Windows a job changes nothing).
// Each call names a fresh job, as engineJob does: on Windows spawnCli really creates the named job, and a second launch while a
// first (warm) one still holds the same name is refused with EEXIST by design (procs.ts createPipJob).
const jobProbe = vi.hoisted(() => ({ issued: [] as Array<{ name: string }>, jobs: [] as unknown[] }));
vi.mock("../procs.ts", async (original) => {
  const actual = await original<typeof import("../procs.ts")>();
  return {
    ...actual,
    engineJob: () => { const job = { name: `Local\\murage-pip-eng-probe-${process.pid}-${jobProbe.issued.length}` }; jobProbe.issued.push(job); return job; },
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => { jobProbe.jobs.push(args[3]); return actual.spawnCli(...args); },
  };
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (fullAuto = true) => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_AGY_DUMP;
    delete process.env.FAKE_AGY_VERSION;
    recorder?.stop();
    await instance?.dispose();
  });

  it("reports exactly one usage total for each of two turns",async()=>{
    await create();
    for(let n=0;n<2;n++){const sent=await instance.adapter.sendTurn({threadId:"usage-two",text:"hi",model:"gemini-3.1-pro-high"});await recorder.until(e=>e.type==="turn.completed"&&e.turnId===sent.turnId);}
    const completed=recorder.events.filter(e=>e.type==="turn.completed");expect(completed).toHaveLength(2);
    for(const event of completed)expect(event).toMatchObject({ok:true,usage:{input:105,output:20}});
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(jobProbe.issued.length).toBeGreaterThan(0);
    expect(jobProbe.jobs).toContainEqual(jobProbe.issued.at(-1)); // the turn CLI was started in the engine job

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("settles a user Stop as cancelled with no runtime error, never exit_before_result (STOP1)", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-agy-stop-"));
    const readyFile = join(home, "ready");
    instance = await AntigravityDriver.create({
      instanceId: "agy-stop",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "10000", FAKE_AGY_READY_FILE: readyFile },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stop", text: "hold" });
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await instance.adapter.interruptTurn("t-stop");
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ type: "turn.completed", turnId, ok: true, stopReason: "cancelled" });
      expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
      expect(instance.adapter.hasSession("t-stop")).toBe(false);
    } finally {
      removeTempDirSync(home);
    }
  }, 10_000);

  it("a child that dies before result without a Stop still settles exit_before_result with an error", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-agy-crash-"));
    instance = await AntigravityDriver.create({
      instanceId: "agy-crash",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_CRASH_BEFORE_RESULT: "1" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ type: "turn.completed", ok: false, stopReason: "exit_before_result" });
      const errors = recorder.events.filter((e) => e.type === "runtime.error").map((e) => (e as any).message as string);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^Antigravity( Test)? closed \(exit code 3\) before it finished its reply/);
      expect(errors[0]).toContain("simulated crash");
    } finally {
      removeTempDirSync(home);
    }
  }, 10_000);

  // Print mode cannot ask, so at Auto and under Murage's Full access stop line
  // (server/stop-line.ts) this engine skips agy's own permissions only with
  // Murage's relay hook in front of every tool (antigravity-relay.ts, its
  // `--log-file` read before the prompt). Without routeAsks or the stop line the
  // instance's own setting stands.
  it("routeAsks runs a skip-all instance through the relay, and leaves an asking one in accept-edits", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-enforce-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    try {
      for (const fullAuto of [false, true]) {
        if (fullAuto) { recorder.stop(); await instance.dispose(); }
        await create(fullAuto);
        for (const [turn, enforced] of [false, true, false].entries()) {
          const sent = await instance.adapter.sendTurn({
            threadId: `t-enforce-${fullAuto}-${turn}`, text: "hi",
            ...(enforced ? { routeAsks: true as const } : {}),
          });
          await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
          const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
          expect(argv.includes("--dangerously-skip-permissions")).toBe(fullAuto);
          expect(argv.includes("accept-edits")).toBe(!fullAuto);
          expect(argv.includes("--log-file")).toBe(fullAuto && enforced);
        }
      }
    } finally { await removeTempDir(scratch); }
  });

  it.each([true, false] as const)("under the stop line skips agy's permissions only with the relay hook (stopLine %s)", async (stopLine) => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-stop-line-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    await create();
    try {
      await instance.adapter.sendTurn({ threadId: `t-stop-line-${stopLine}`, text: "go", ...(stopLine ? { stopLine: true as const } : {}) });
      await recorder.until((event) => event.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toContain("--dangerously-skip-permissions");
      expect(seen.argv.includes("--log-file")).toBe(stopLine);
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("never skips permissions for an Ask bot; an Auto bot goes through the relay", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-route-asks-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    await create();
    try {
      await instance.adapter.sendTurn({ threadId: "t-route-asks", text: "go", routeAsks: true, askLevel: true });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-route-asks");
      const ask = JSON.parse(readFileSync(dump, "utf8"));
      expect(ask.argv).toContain("accept-edits");
      expect(ask.argv).not.toContain("--dangerously-skip-permissions");
      await instance.adapter.sendTurn({ threadId: "t-route-auto", text: "go", routeAsks: true });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-route-auto");
      const auto = JSON.parse(readFileSync(dump, "utf8"));
      expect(auto.argv).toContain("--dangerously-skip-permissions");
      expect(auto.argv).toContain("--log-file");
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("sends a Windows-sized room prompt over stdin instead of argv", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-long-prompt-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    await create();
    const system = `room instructions\n${"context-0123456789".repeat(8_000)}`;
    try {
      await instance.adapter.sendTurn({
        threadId: "t-long-prompt",
        text: "review the video",
        system,
        model: "gemini-3.1-pro-high",
      });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.prompt).toBe(`${system}\n\n${TURN_ASK_RULES}\n\nreview the video`);
      expect(seen.argv).toContain("--input-format");
      expect(seen.argv).not.toContain("--print");
      expect(JSON.stringify(seen.argv)).not.toContain("room instructions");
      expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("runs a turn on activity alone: agy's own print timeout is out of reach and the driver arms no clock of its own", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-no-cap-"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_AGY_DUMP = dump;
    await create();
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await instance.adapter.sendTurn({ threadId: "t-no-cap", text: "go" });
      await recorder.until((event) => event.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const at = seen.argv.indexOf("--print-timeout");
      expect(at).toBeGreaterThan(-1);
      expect(seen.argv[at + 1]).toBe(ANTIGRAVITY_PRINT_TIMEOUT);
      // beyond the longest silence limit an owner can set (24 hours), so the
      // thread's silence watch is always what stops a quiet turn
      expect(Number(/^(\d+)h$/.exec(ANTIGRAVITY_PRINT_TIMEOUT)?.[1])).toBeGreaterThan(24);
      // no fixed per-turn deadline (the old 11-minute backstop)
      expect(timers.mock.calls.filter(([, ms]) => typeof ms === "number" && ms >= 60_000)).toEqual([]);
    } finally {
      timers.mockRestore();
      await removeTempDir(scratch);
    }
  });

  it("reports agy steps the chat does not show as activity, so the silence watch sees the turn working", async () => {
    process.env.FAKE_AGY_EXTRA_STEPS = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-live", text: "go" });
      await recorder.until((event) => event.type === "turn.completed");
      // planner, the response step, then two growths of it; repeats add nothing
      expect(recorder.events.filter((e) => e.type === "item.updated")).toHaveLength(4);
      expect(recorder.events.filter((e) => e.type === "item.updated").every((e) => (e as any).itemType === "reasoning" && (e as any).tokens === null)).toBe(true);
    } finally {
      delete process.env.FAKE_AGY_EXTRA_STEPS;
    }
  });

  it("reports nothing for a step line written after the result, so a closing child never feeds the next turn's silence watch", async () => {
    process.env.FAKE_AGY_POST_RESULT_STEP = "1";
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-after", text: "go" });
      await recorder.until((event) => event.type === "turn.completed");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const done = recorder.events.findIndex((event) => event.type === "turn.completed");
      expect(recorder.events.slice(done + 1).filter((event) => event.type === "item.updated")).toEqual([]);
    } finally {
      delete process.env.FAKE_AGY_POST_RESULT_STEP;
    }
  });

  it("a Stop that lands while the engine version is still being read ends the turn before it starts", async () => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-early-stop",
      displayName: undefined,
      environment: { FAKE_AGY_VERSION_DELAY_MS: "800" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const sent = instance.adapter.sendTurn({ threadId: "t-early", text: "go" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await instance.adapter.interruptTurn("t-early");
    const { turnId } = await sent;
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.some((e) => e.type === "turn.started")).toBe(false);
  });

  it("strips ambient routing switches from the agy child env", async () => {
    // agy reads none of these today, but it is one of the five spawn paths
    // that spread `...process.env`; the strip is uniform across all of them
    // rather than resting on that staying true.
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-routing-"));
    const dump = join(scratch, "dump.json");
    const ambient = {
      ANTHROPIC_BASE_URL: "https://leftover.example",
      ANTHROPIC_AUTH_TOKEN: "sk-leftover-should-not-route",
      ANTHROPIC_MODEL: "leftover-model",
      OPENAI_BASE_URL: "https://leftover.example/v1",
      OPENAI_MODEL: "leftover-openai-model",
    } as const;
    const saved = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    process.env.FAKE_AGY_DUMP = dump;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-routing", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      for (const name of Object.keys(ambient)) expect(seen.env[name]).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await removeTempDir(scratch);
    }
  });

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("explains how to update an agy version that cannot receive prompts safely", async () => {
    process.env.FAKE_AGY_VERSION = "1.1.14";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-old-agy", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.error",
        message: expect.stringMatching(/1\.1\.15\+.*agy update/),
      }),
      expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "unsupported_cli" }),
    ]));
  });
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.22");
    // agy auth is keyring-backed with no reliable file marker, so the snapshot
    // must NOT claim signed-in from a mere directory — authenticated stays unset.
    expect((snap as any).authenticated).toBeUndefined();
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("marks pre-stream-input versions unavailable with an update action", async () => {
    process.env.FAKE_AGY_VERSION = "1.1.14";
    const instance = await AntigravityDriver.create({
      instanceId: "agy-old",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await expect(instance.snapshot()).resolves.toMatchObject({
        state: "unavailable",
        version: "1.1.14",
        reason: expect.stringMatching(/1\.1\.15\+.*agy update/),
      });
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_VERSION;
    }
  });

  // Upstream #3433: a slow --version probe on a busy machine never reads as "not installed".
  it("a slow version probe keeps the last version; without one it names the timeout, not a missing CLI", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const dir = mkdtempSync(join(tmpdir(), "murage-agy-slow-probe-"));
    const delayFile = join(dir, "version-delay");
    process.env.FAKE_AGY_VERSION_DELAY_FILE = delayFile;
    const create = (instanceId: string) => AntigravityDriver.create({
      instanceId,
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const instance = await create("agy-slow-probe");
    const fresh = await create("agy-slow-probe-fresh");
    try {
      await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", version: "1.1.22" });
      // Past the 8 second probe timeout.
      writeFileSync(delayFile, "9000");
      const [held, none] = await Promise.all([instance.snapshot(), fresh.snapshot()]);
      expect(held).toMatchObject({ state: "available", version: "1.1.22" });
      expect(none).toMatchObject({ state: "unavailable", reason: expect.stringContaining("took longer than 8 seconds") });
    } finally {
      delete process.env.FAKE_AGY_VERSION_DELAY_FILE;
      await instance.dispose();
      await fresh.dispose();
      removeTempDirSync(dir);
    }
  }, 30_000);

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "MURAGE_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      removeTempDirSync(scratch);
    }
  });

  it("keeps long generateText prompts off argv too", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-agy-long-helper-"));
    const dump = join(scratch, "dump.json");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-long-helper",
      displayName: undefined,
      environment: { FAKE_AGY_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const prompt = `summarize\n${"helper-context-0123456789".repeat(6_000)}`;
    try {
      await expect(instance.generateText?.(prompt)).resolves.toBe("done from fake agy");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.prompt).toBe(prompt);
      expect(seen.argv).toContain("--input-format");
      expect(JSON.stringify(seen.argv)).not.toContain("helper-context");
      expect(JSON.stringify(seen.argv).length).toBeLessThan(8_000);
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });
});

describe("Antigravity Murage MCP config", () => {
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityComputerMcpServer(boxIntegrations)!;
  const agentsIntegrations = (token = "agents-tok") => ({
    agents: {
      command: process.execPath,
      args: [SPAWNED_PROXIES.agents],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        MURAGE_HARNESS_URL: "http://127.0.0.1:8799",
        MURAGE_COMMS_TOKEN: token,
        MURAGE_BOT_ID: "gemini-bot",
        MURAGE_THREAD_ID: "thread-1",
        MURAGE_TURN_DEPTH: "0",
      },
    },
  });
  const agentsEntry = (token = "agents-tok") => ({
    command: process.execPath,
    args: [SPAWNED_PROXIES.agents],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      MURAGE_HARNESS_URL: "http://127.0.0.1:8799",
      MURAGE_COMMS_TOKEN: token,
      MURAGE_BOT_ID: "gemini-bot",
      MURAGE_THREAD_ID: "thread-1",
      MURAGE_TURN_DEPTH: "0",
    },
  });

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityComputerMcpServer(boxIntegrations)).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        MURAGEBOX_BOX_ID: "bx_1",
        MURAGEBOX_BOX_TOKEN: "box-tok",
        MURAGE_CONTROL_URL: "http://127.0.0.1:9/control",
        MURAGE_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("builds the teammate proxy spec and combines it atomically with the computer mount", () => {
    const integrations = { ...boxIntegrations, ...agentsIntegrations("turn-secret") };
    expect(antigravityAgentsMcpServer(integrations)).toEqual(agentsEntry("turn-secret"));
    expect(antigravityMcpServers(integrations)).toEqual({
      [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
      [ANTIGRAVITY_AGENTS_MCP_KEY]: agentsEntry("turn-secret"),
    });
    expect(antigravityMcpServers(undefined)).toEqual({});
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityComputerMcpServer({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } });
    expect(antigravityComputerMcpServer({})).toBeNull();
    expect(antigravityComputerMcpServer(undefined)).toBeNull();
  });

  it("advertises computer and teammate MCP only on full-auto instances, and never localComputerMcp", async () => {
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.agentsMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.customMcp).toBe(true);
      // accept-edits print mode auto-denies tools that would prompt, so a
      // mount there could never fire — the capability must not be offered.
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(false);
      expect(acceptEdits.adapter.capabilities.agentsMcp).toBe(false);
      expect(acceptEdits.adapter.capabilities.customMcp).toBe(false);
      // The host desktop needs per-action human approval; print mode has no
      // approval channel in any mode.
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBeUndefined();
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBeUndefined();
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  const customIntegrations = () => ({
    custom: {
      comfy: {
        command: process.execPath, args: [SPAWNED_PROXIES.remoteMcp, "--server", "comfy"], env: {},
        harnessEnv: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:8799", MURAGE_MCP_TOKEN: "turn-tok" },
      },
      notes: { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "n" } },
      forged: { command: "x", args: [], env: { MURAGE_MCP_TOKEN: "forged" } },
    },
  });

  it("mounts the owner's servers under murage-custom- keys, merged with the harness environment (MCP-LINK T9)", () => {
    expect(antigravityMcpServers(customIntegrations())).toEqual({
      [`${ANTIGRAVITY_CUSTOM_MCP_PREFIX}comfy`]: {
        command: process.execPath, args: [SPAWNED_PROXIES.remoteMcp, "--server", "comfy"],
        env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:8799", MURAGE_MCP_TOKEN: "turn-tok" },
      },
      [`${ANTIGRAVITY_CUSTOM_MCP_PREFIX}notes`]: { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "n" } },
    });
  });

  it("never mounts custom servers without full auto, where print mode cannot ask", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "murage-agy-custom-safe-"));
    const dump = join(home, "mcp-at-spawn.json");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-custom-off", displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: dump },
      enabled: true, config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-custom-off", text: "no tools", integrations: customIntegrations() });
      await recorder.until((event) => event.type === "turn.completed");
      const atSpawn = JSON.parse(readFileSync(dump, "utf8"));
      expect(JSON.stringify(atSpawn)).not.toContain("turn-tok");
      expect(Object.keys(atSpawn?.mcpServers ?? {}).filter((key) => key.startsWith(ANTIGRAVITY_CUSTOM_MCP_PREFIX))).toEqual([]);
    } finally {
      recorder.stop();
      await instance.dispose();
      removeTempDirSync(home);
    }
  });

  it("does not mount token-bearing Murage tools in safe mode even when a caller supplies them", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "murage-agy-mcpsafe-"));
    const dump = join(home, "mcp-at-spawn.json");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-safe",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-safe",
        text: "do not expose tools",
        integrations: { ...boxIntegrations, ...agentsIntegrations("must-not-leak") },
      });
      await recorder.until((event) => event.type === "turn.completed");

      const atSpawn = JSON.parse(readFileSync(dump, "utf8"));
      expect(atSpawn?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(atSpawn?.mcpServers?.[ANTIGRAVITY_AGENTS_MCP_KEY]).toBeUndefined();
      expect(JSON.stringify(atSpawn)).not.toContain("must-not-leak");
    } finally {
      recorder.stop();
      await instance.dispose();
      removeTempDirSync(home);
    }
  });
});
