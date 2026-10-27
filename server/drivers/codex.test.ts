import { fixtureCredentialFingerprint } from "../testing/fixture-dump.ts";
// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// The fake is a shebang script — the same constraint codex.cmd itself
// hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { TURN_ASK_RULES } from "../../shared/ask-wording.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as procs from "../procs.ts";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CODEX_MCP_TOOL_TIMEOUT_SEC, CodexDriver, codexCloudBilling } from "./codex.ts";
import { HOOK_LIVENESS_WIN32_MS, setCodexFloorsForTests } from "./codex-hook.ts";
import { DATA_DIR } from "../config.ts";
import { flushDecisionLog } from "../decision-log.ts";
import { resetIsolationCache } from "./isolation-cache.ts";
import { scopedCliHomeRoot } from "./scoped-cli-home.ts";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { TURN_BOT, TURN_RENDER, cloudTurnLaunch } from "../cloud-home/turn-process.ts";
import { ABSENT_PINS, valuePins } from "../../shared/arg-vocabulary.ts";
import type { CloudLauncherSpawn } from "../cloud-home/bot-state.ts";
import { buildRemoteMount } from "../custom-mcp-mounts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { NATIVE_DIR } from "../config.ts";
import { resolveCall } from "../../shared/app-action-grant.ts";
import { isMountRecord } from "../../shared/mount-identity.ts";
import { autoVerdict } from "../auto-approve.ts";
import { execChecks, gate, resetExecChecks } from "../testing/exec-check-spy.ts";
import { approveStartupWrite } from "../testing/startup-write.ts";

vi.mock("node:child_process", async (original) => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    opts: { mode?: string; fullAuto?: boolean; environment?: Record<string, string> } = {},
  ) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: opts.environment ?? {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_ESCALATION;
    delete process.env.FAKE_CODEX_HOOKS;
    delete process.env.FAKE_CODEX_TOOLS;
    delete process.env.FAKE_CODEX_VERSION;
    delete process.env.MURAGE_CODEX_HOOK_LIVENESS_MS;
    delete process.env.FAKE_CODEX_MCP_SERVER;
    delete process.env.FAKE_CODEX_MCP_TOOL;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CODEX_APPROVAL;
    delete process.env.FAKE_CODEX_TRANSIENTS;
    delete process.env.FAKE_CODEX_PARTIAL_FAILS;
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    delete process.env.FAKE_CODEX_STOP_RACE;
    delete process.env.FAKE_CODEX_LAUNCH_CRASHES;
    delete process.env.FAKE_CODEX_LAUNCH_KILLS;
    delete process.env.FAKE_CODEX_LAUNCH_SILENT;
    delete process.env.FAKE_CODEX_STALE_STDERR_GATE;
    delete process.env.FAKE_CODEX_PREACK_CRASH;
    delete process.env.FAKE_CODEX_ACK_CRASH;
    delete process.env.FAKE_CODEX_EXIT_MID_TURN;
    delete process.env.FAKE_CODEX_EXIT_MID_TURN_KILL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.MURAGE_TTS_KEY;
    delete process.env.FAKE_CODEX_SKILLS;
    delete process.env.FAKE_CODEX_SKILLS_BATCHED;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("banks only the difference of resumed totals and drops the baseline on reset", async () => {
    await create({ mode: "resume" });
    for (const resumeCursor of [undefined, "thread-fake", undefined]) {
      const sent = await instance.adapter.sendTurn({ threadId: "t-total-bank", text: "hi", cwd: scratch, resumeCursor });
      await recorder.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    }
    const completed = recorder.events.filter(e => e.type === "turn.completed");
    expect(completed).toHaveLength(3);
    expect(completed[0]).not.toHaveProperty("usage");
    expect(completed[1]).toMatchObject({ usage: { input: 0, output: 0, cachedInput: 0 } });
    expect(completed[2]).not.toHaveProperty("usage");
  });

  it("F9 discards the total baseline when resume falls back to a new session", async () => {
    await create();
    for (const resumeCursor of [undefined, "missing-session"]) {
      const sent = await instance.adapter.sendTurn({ threadId: "t-resume-failure", text: "hi", cwd: scratch, resumeCursor });
      await recorder.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
    }
    const completed = recorder.events.filter(e => e.type === "turn.completed");
    expect(completed).toHaveLength(2);
    expect(completed[1]).not.toHaveProperty("usage");
  });

  // Codex's app-server has no command list; the built-in pair is mapped to
  // its calls and the skills come live from skills/list (codex-cli 0.156).
  describe("engine commands", () => {
    const SKILL = { name: "release-notes", description: "Write release notes", interface: { shortDescription: "Draft the notes" }, path: "/skills/release-notes/SKILL.md", scope: "user", enabled: true, pluginId: null };
    const calls = () => JSON.parse(readFileSync(process.env.FAKE_CODEX_DUMP!, "utf8")).calls as Array<{ method: string; params: any }>;

    it("reports the built-in commands and the skills Codex lists", async () => {
      process.env.FAKE_CODEX_SKILLS = JSON.stringify([SKILL, { ...SKILL, name: "off", enabled: false }]);
      await create();
      await instance.adapter.sendTurn({ threadId: "t-skills", text: "hi", cwd: scratch });
      await recorder.until((e) => e.type === "turn.completed");
      expect(await recorder.until((e) => e.type === "engine.commands")).toMatchObject({
        provider: "codex",
        commands: [
          { name: "review", hint: "[what to review]" },
          { name: "compact" },
          { name: "release-notes", description: "Draft the notes" },
        ],
      });
    });

    // The skills answer and the turn's end can reach the driver in one read
    // (a fast turn on a busy machine). The list is the bot's, not the turn's:
    // it is still reported after the turn settles.
    it("reports the skills Codex lists when the answer lands in the same read as the turn's end", async () => {
      process.env.FAKE_CODEX_SKILLS = JSON.stringify([SKILL]);
      process.env.FAKE_CODEX_SKILLS_BATCHED = "1";
      await create();
      await instance.adapter.sendTurn({ threadId: "t-skills-batched", text: "hi", cwd: scratch });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(await recorder.until((e) => e.type === "engine.commands")).toMatchObject({
        provider: "codex",
        commands: [
          { name: "review", hint: "[what to review]" },
          { name: "compact" },
          { name: "release-notes", description: "Draft the notes" },
        ],
      });
    });

    it("reports nothing when skills/list gives no list, so the older event sequence holds", async () => {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-no-skills", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");
      expect(recorder.events.some((e) => e.type === "engine.commands")).toBe(false);
    });

    it("runs /review as review/start and shows the review", async () => {
      process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
      await create();
      await instance.adapter.sendTurn({ threadId: "t-review", text: "/review the auth change", system: "You are Moss.", engineCommand: { name: "review", args: "the auth change" } });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      const review = calls().find((call) => call.method === "review/start");
      expect(review?.params).toEqual({ threadId: "codex-thread-1", target: { type: "custom", instructions: "the auth change" }, delivery: "inline" });
      expect(calls().some((call) => call.method === "turn/start")).toBe(false);
      expect(recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")).toMatchObject({ text: "FAKE_REVIEW no issues found" });
    });

    it("reviews uncommitted changes when /review has nothing after it", async () => {
      process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
      await create();
      await instance.adapter.sendTurn({ threadId: "t-review-bare", text: "/review", engineCommand: { name: "review", args: "" } });
      await recorder.until((e) => e.type === "turn.completed");
      expect(calls().find((call) => call.method === "review/start")?.params.target).toEqual({ type: "uncommittedChanges" });
    });

    it("runs /compact as thread/compact/start and settles on its turn", async () => {
      process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
      await create();
      await instance.adapter.sendTurn({ threadId: "t-compact", text: "/compact", engineCommand: { name: "compact", args: "" } });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(calls().find((call) => call.method === "thread/compact/start")?.params).toEqual({ threadId: "codex-thread-1" });
      expect(recorder.events.filter((e) => e.type === "item.started")).toMatchObject([{ itemType: "tool", title: "compact" }]);
    });

    it("runs a skill as turn/start carrying the skill", async () => {
      process.env.FAKE_CODEX_SKILLS = JSON.stringify([SKILL]);
      process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
      await create();
      await instance.adapter.sendTurn({ threadId: "t-skill", text: "/release-notes v2", system: "You are Moss.", engineCommand: { name: "release-notes", args: "v2" } });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(calls().find((call) => call.method === "turn/start")?.params.input).toEqual([
        { type: "text", text: "$release-notes v2" },
        { type: "skill", name: "release-notes", path: "/skills/release-notes/SKILL.md" },
      ]);
    });
  });

  it.each(["parent-isolation", "parent-early"])("isolates parent native events (%s)", async (mode) => {
    await create({ mode });
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
    await instance.adapter.sendTurn({ threadId: "parent-isolation", text: "one parent action" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toMatchObject([
      { ok: true, usage: { input: 11, output: 2 } },
    ]);
    expect(recorder.events.filter((e) => e.type === "content.delta")).toMatchObject([{ delta: "parent reply" }]);
    expect(recorder.events.filter((e) => e.type === "item.completed")).toMatchObject([{ itemType: "assistant_text", text: "parent reply" }]);
    expect(recorder.events.filter((e) => e.type === "thread.token-usage.updated")).toMatchObject([{ input: 20, output: 5 }]);
    expect(recorder.events.some((e) => e.type === "item.started")).toBe(false);
    expect(JSON.stringify(recorder.events)).not.toMatch(/FOREIGN|UNIDENTIFIED/);
    expect(recorder.events.filter((e) => e.type === "runtime.error").map((e) => e.message)).toEqual(
      mode === "parent-isolation" ? ["connection diagnostic"] : [],
    );
    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_DUMP, "utf8"));
    expect(seen.calls.filter((c: { method: string }) => c.method === "turn/start")).toHaveLength(1);
  });

  it.each(["terminal-error", "terminal-error-duplicate"])("surfaces a terminal provider error exactly once (%s)", async (mode) => {
    await create({ mode });
    await instance.adapter.sendTurn({ threadId: "terminal-diagnostic", text: "hi" });
    await recorder.until(e => e.type === "turn.completed");
    expect(recorder.events.filter(e => e.type === "runtime.error").map(e => e.message)).toEqual(["Provider rejected the request"]);
    expect(recorder.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(recorder.events.findIndex(e => e.type === "runtime.error")).toBeLessThan(recorder.events.findIndex(e => e.type === "turn.completed"));
    expect(recorder.events.some(e => e.type === "turn.retrying")).toBe(false);
  });

  it.each(["parent-invalid-ack", "parent-overflow"])("fails unbound parent output explicitly (%s)", async (mode) => {
    await create({ mode });
    await instance.adapter.sendTurn({ threadId: "parent-failure", text: "one parent action" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(recorder.events.some((e) => e.type === "content.delta" || e.type === "thread.token-usage.updated")).toBe(false);
    expect(recorder.events.find((e) => e.type === "runtime.error")?.message).toMatch(
      mode === "parent-invalid-ack" ? /^Codex Test did not start the turn\.$/ : /^Codex Test sent more updates before the turn started than Murage can hold, so the turn was stopped\.$/,
    );
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  });

  it("preserves helper approval requests while ignoring helper completion", async () => {
    await create({ mode: "parent-approval" });
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
    await instance.adapter.sendTurn({ threadId: "parent-approval", text: "one parent action" });
    const ask = await recorder.until((e) => e.type === "request.opened");
    expect(ask).toMatchObject({ summary: "helper command" });
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    await instance.adapter.respondToRequest("parent-approval", String(ask.requestId), { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(process.env.FAKE_CODEX_DUMP, "utf8")).decision).toEqual({ decision: "decline" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toMatchObject([{ ok: true }]);
  });

  it("a turn that holds its permission asks never arms the 15-minute deny (routine runs)", async () => {
    await create({ mode: "parent-approval" });
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump.json");
    const originalTimeout = globalThis.setTimeout;
    const armed: number[] = [];
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 15 * 60_000) armed.push(delay);
      return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      await instance.adapter.sendTurn({ threadId: "held-approval", text: "one parent action", holdPermissionAsks: true });
      const ask = await recorder.until((e) => e.type === "request.opened");
      expect(armed).toEqual([]);
      await instance.adapter.respondToRequest("held-approval", String(ask.requestId), { behavior: "allow" });
      await recorder.until((e) => e.type === "turn.completed");
    } finally { timerSpy.mockRestore(); }
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.MURAGE_TTS_KEY = "tts-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
      model: "gpt-5.6-sol",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.started", // webSearch Murage
      "item.completed", // commandExecution done
      "item.completed", // webSearch done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
      cachedInput: 4,
    });
    expect(recorder.events.filter((event) => event.itemId === "w1")).toMatchObject([
      { type: "item.started", itemType: "tool", title: "web_search" },
      { type: "item.completed", itemType: "tool", ok: true },
    ]);
    // codex reports the THREAD total; the driver turns it into this turn's
    // figure so the harness never sums a running total
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(recorder.events.at(-1)).not.toHaveProperty("usage");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.MURAGE_TTS_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    // skills/list feeds the composer's "/" menu; nothing waits on it
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "skills/list", "turn/start"]);
    // persona rides in front of the prompt text — codex has no system slot
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe(`You are Testy.\n\n${TURN_ASK_RULES}\n\nlist files`);
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai" });
  });

  it("waits for child exit before completion and ignores buffered and later output after settlement", async () => {
    await create({ mode: "late-output" });
    const dump = join(scratch, "shutdown.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-shutdown", text: "go" });
    await recorder.until((event) => event.type === "item.completed" && event.itemType === "assistant_text");
    const { pid } = JSON.parse(readFileSync(dump, "utf8"));
    expect(instance.adapter.hasSession?.("t-shutdown")).toBe(true);
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
    await recorder.until((event) => event.type === "turn.completed");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(instance.adapter.hasSession?.("t-shutdown")).toBe(false);
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "content.delta").map((event) => event.delta))
      .toEqual(["done from fake codex"]);
  });

  it(process.platform === "win32"
    ? "confirms native Windows termination despite the fixture's POSIX shutdown delay"
    : "force-stops a delayed POSIX shutdown within the existing close budget", async () => {
    const dump = join(scratch, "shutdown-timeout.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await create({ mode: "late-output", environment: { FAKE_CODEX_SHUTDOWN_DELAY_MS: "5500" } });
    await instance.adapter.sendTurn({ threadId: "t-timeout", text: "go" });
    await recorder.until(event => event.type === "item.completed" && event.itemType === "assistant_text");
    let windowsPid: number | undefined;
    if (process.platform === "win32") {
      // The live fixture rewrites its receipt as protocol messages arrive.
      // File existence does not mean a concurrent write has finished.
      await expect.poll(() => {
        try { windowsPid = JSON.parse(readFileSync(dump, "utf8")).pid; }
        catch { windowsPid = undefined; }
        return Number.isSafeInteger(windowsPid) && windowsPid! > 0;
      }).toBe(true);
      // killCliTree uses taskkill /F on Windows, and its libuv SIGTERM
      // fallback also forces termination. Neither runs the POSIX delay handler.
      await expect(instance.adapter.interruptTurn("t-timeout")).resolves.toBeUndefined();
      await recorder.until(event => event.type === "turn.completed");
      await expect(instance.adapter.stopAll()).resolves.toBeUndefined();
      await expect(instance.dispose()).resolves.toBeUndefined();
    } else {
      await expect(instance.adapter.interruptTurn("t-timeout")).resolves.toBeUndefined();
      await expect(instance.adapter.stopAll()).resolves.toBeUndefined();
      await expect(instance.dispose()).resolves.toBeUndefined();
    }
    await recorder.until(event => event.type === "turn.completed");
    // Preserve the original POSIX read after the producer has closed its dump.
    const pid = windowsPid ?? JSON.parse(readFileSync(dump, "utf8")).pid;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(instance.adapter.hasSession?.("t-timeout")).toBe(false);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter(event => event.type === "content.delta").map(event => event.delta))
      .toEqual(["done from fake codex"]);
  }, 10000);

  it("retains an uncertain stopped turn after root close and permits an explicit retry", async () => {
    await create({ mode: "late-output" });
    const confirm = vi.spyOn(procs, "awaitCliTreeStopped").mockResolvedValue(false);
    try {
      await instance.adapter.sendTurn({ threadId: "t-uncertain-group", text: "go" });
      await recorder.until(event => event.type === "runtime.error" && event.message === "Codex Test did not close after Stop. This conversation stays busy until it does; restart Murage if it stays stuck.");
      await expect(instance.adapter.interruptTurn("t-uncertain-group")).rejects.toThrow("shutdown is still pending");
      await expect(instance.adapter.stopAll()).rejects.toThrow("shutdown is still pending");
      await expect(instance.dispose()).rejects.toThrow("listeners remain attached");
      expect(instance.adapter.hasSession("t-uncertain-group")).toBe(true);
      expect(recorder.events.some(event => event.type === "turn.completed")).toBe(false);
    } finally {
      confirm.mockRestore();
      await instance.adapter.interruptTurn("t-uncertain-group");
    }
    await recorder.until(event => event.type === "turn.completed");
    expect(instance.adapter.hasSession("t-uncertain-group")).toBe(false);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  });

  it("strips ambient routing switches from the codex child env", async () => {
    // An OPENAI_BASE_URL left in the shell by a provider switcher would point
    // the CLI's own ChatGPT login at a third party, silently, every turn.
    const ambient = {
      OPENAI_BASE_URL: "https://leftover.example/v1",
      OPENAI_MODEL: "leftover-openai-model",
      ANTHROPIC_BASE_URL: "https://leftover.example",
      ANTHROPIC_AUTH_TOKEN: "sk-leftover-should-not-route",
      ANTHROPIC_MODEL: "leftover-model",
    } as const;
    const saved = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    try {
      await create();
      const dump = join(scratch, "dump-routing.json");
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-routing", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      for (const name of Object.keys(ambient)) expect(seen.env[name]).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("routes a flux::flux-* turn through the Flux Responses provider table", async () => {
    // The whole codex Flux surface in one assertion set: the provider table
    // reaches argv, the secret does NOT, the raw workspace key is gone from
    // the child, and thread/start selects the provider the table declares.
    process.env.FLUX_API_KEY = "sk-flux-test-key";
    try {
      await create();
      const dump = join(scratch, "flux.json");
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-flux", text: "hi", model: "flux::flux-auto", warmIdentity: { botId: "b", audience: "owner", decidedOwner: true } });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const argv = (seen.argv as string[]).join(" ");
      expect(argv).toContain('model_providers.flux.base_url="https://api.fluxrouter.ai/v1"');
      expect(argv).toContain('model_providers.flux.wire_api="responses"');
      expect(argv).toContain('model_providers.flux.env_key="MURAGE_FLUX_API_KEY"');
      // codex has no metadata for flux-* and would otherwise assume a
      // 258400-token window, larger than the smallest backend Flux routes to
      expect(argv).toContain("model_context_window=129024");
      // argv is world-readable in `ps`; only the env-key NAME may appear there
      expect(argv).not.toContain("sk-flux-test-key");
      expect(seen.env.MURAGE_FLUX_API_KEY).toBe(fixtureCredentialFingerprint("sk-flux-test-key"));
      // FLUX_API_KEY is workspace-scoped — the child gets the copy, never it
      expect(seen.env.FLUX_API_KEY).toBeUndefined();

      const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
      expect(threadStart.params).toMatchObject({ model: "flux-auto", modelProvider: "flux" });
    } finally {
      delete process.env.FLUX_API_KEY;
    }
  });

  it("leaves a native codex turn untouched when no Flux model is picked", async () => {
    process.env.FLUX_API_KEY = "sk-flux-test-key";
    try {
      await create();
      const dump = join(scratch, "flux-native.json");
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-flux-native", text: "hi", model: "gpt-5.6-sol" });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect((seen.argv as string[]).join(" ")).not.toContain("model_providers.flux");
      expect((seen.argv as string[]).join(" ")).not.toContain("model_context_window");
      expect(seen.env.MURAGE_FLUX_API_KEY).toBeUndefined();
    } finally {
      delete process.env.FLUX_API_KEY;
    }
  });

  it("does not half-apply the provider table for a bare flux-auto id", async () => {
    // A bare id decodes to OFFICIAL_CODEX_PROVIDER and is refused at spawn
    // (server/index.ts). If it ever reaches the driver it must stay native
    // rather than carry a provider table thread/start will never select.
    process.env.FLUX_API_KEY = "sk-flux-test-key";
    try {
      await create();
      const dump = join(scratch, "flux-bare.json");
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-flux-bare", text: "hi", model: "flux-auto" });
      await recorder.until((event) => event.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect((seen.argv as string[]).join(" ")).not.toContain("model_providers.flux");
      expect(seen.env.MURAGE_FLUX_API_KEY).toBeUndefined();
    } finally {
      delete process.env.FLUX_API_KEY;
    }
  });

  it("normalizes native image generation bytes without exposing the provider path", async () => {
    await create({ mode: "image" });
    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "make an image",
      model: "gpt-5.6-sol",
    });
    await recorder.until((event) => event.type === "turn.completed");

    const image = recorder.events.find(
      (event) => event.type === "item.completed" && event.itemType === "assistant_image",
    );
    expect(image).toMatchObject({
      itemType: "assistant_image",
      itemId: "img1",
      alt: "a tiny green mouse",
    });
    expect(image && "data" in image ? image.data : "").toMatch(/^iVBOR/);
    // savedPath is the app-server's own file. Reading it would make the
    // harness depend on a path it did not write; the bytes are the contract.
    expect(JSON.stringify(image)).not.toContain("provider-owned-path");
  });

  it("keeps the generated raster out of the native protocol tee", async () => {
    // ~/.murage/native/*.ndjson is an ordinary file people paste into bug
    // reports. A megabyte of base64 in it is both useless and a leak of the
    // provider's local path, so the entry keeps the shape and loses both.
    await create({ mode: "image" });
    // appendNative never creates its directory (ensureDirs does that at
    // boot) and swallows the ENOENT, so the unit test makes it itself.
    mkdirSync(NATIVE_DIR, { recursive: true });
    const threadId = `t-image-log-${Date.now()}`;
    await instance.adapter.sendTurn({ threadId, text: "make an image", model: "gpt-5.6-sol" });
    await recorder.until((event) => event.type === "turn.completed");

    const logged = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(logged).toContain("imageGeneration");
    expect(logged).toContain("base64 chars]");
    expect(logged).not.toContain("iVBORw0KGgo");
    expect(logged).not.toContain("provider-owned-path");
  });

  it("keeps the full command when a Windows interpreter prefix is long", async () => {
    await create({ mode: "windows-command" });
    await instance.adapter.sendTurn({ threadId: "t-windows-command", text: "read notes" });

    const command = [
      "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "-Command",
      `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
    ].join(" ");
    expect(command.length).toBeGreaterThan(200);
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({
      type: "item.started",
      title: command,
    });
    expect(opened).toMatchObject({ requestType: "permission", summary: command });

    await instance.adapter.respondToRequest("t-windows-command", opened.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("uses the instance environment for the Codex process", async () => {
    const codexHome = join(scratch, "custom-codex-home");
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "environment.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-environment", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    // The child runs in a scoped CODEX_HOME (codex-isolation.ts) whose login links to the instance's home.
    const childHome = JSON.parse(readFileSync(dump, "utf8")).env.CODEX_HOME as string;
    expect(childHome).not.toBe(codexHome);
    expect(readlinkSync(join(childHome, "auth.json"))).toBe(join(codexHome, "auth.json"));
  });

  // S3b: Ask, Auto and Full bots see their connected-app calls as approval cards.
  it("leaves connected apps unquieted when the turn routes asks or has the stop line", async () => {
    await create();
    const composio = { command: process.execPath, args: ["-e", ""], env: {} };
    for (const [name, flags] of [["plain", {}], ["routeAsks", { routeAsks: true as const }], ["stopLine", { stopLine: true as const }]] as const) {
      const dump = join(scratch, `composio-${name}.json`);
      process.env.FAKE_CODEX_DUMP = dump;
      const sent = await instance.adapter.sendTurn({ threadId: `t-composio-${name}`, text: "hi", ...flags, integrations: { composio } });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
      const argv = JSON.parse(readFileSync(dump, "utf8")).argv.join(" ");
      expect(argv.includes("mcp_servers.murage_connectors.default_tools_approval_mode")).toBe(name === "plain");
    }
  });

  it("mounts connected apps without placing credential values in argv", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "check mail",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            MURAGE_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
            MURAGE_COMMS_TOKEN: "per-boot-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.murage_connectors.command");
    expect(seen.argv.join(" ")).toContain("MURAGE_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("per-boot-token");
    expect(seen.env.MURAGE_COMMS_TOKEN).toBe(fixtureCredentialFingerprint("per-boot-token"));
  });

  it("never hands one custom MCP server another server's value for the same variable (03-A1)", async () => {
    await create();
    const dump = join(scratch, "custom-mcp-clash.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp-clash",
      text: "go",
      integrations: {
        custom: {
          one: { command: "npx", args: ["-y", "@x/one"], env: { NOTES_TOKEN: "value-for-one" } },
          two: { command: "npx", args: ["-y", "@x/two"], env: { NOTES_TOKEN: "value-for-two" } },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const argv: string[] = seen.argv;
    const flag = (server: string, key: string) => {
      const arg = argv.find((item) => item.startsWith(`mcp_servers.${server}.${key}=`));
      return arg ? JSON.parse(arg.slice(`mcp_servers.${server}.${key}=`.length)) : undefined;
    };
    // No value of either server is ever on the argv (the argv is readable for the life of the process).
    expect(argv.join("\n")).not.toContain("value-for-one");
    expect(argv.join("\n")).not.toContain("value-for-two");
    // Each server resolves its own value through the environment: the shared name, or a private alias the launcher restores
    // under the server's own name for that one child only.
    const resolve = async (server: string) => {
      const command: string = flag(server, "command");
      const args: string[] = flag(server, "args");
      const forwarded: string[] = flag(server, "env_vars");
      const childEnv: Record<string, string> = Object.fromEntries(forwarded.filter((n) => seen.env[n] !== undefined).map((n) => [n, seen.env[n]]));
      if (command !== process.execPath) return childEnv.NOTES_TOKEN;
      // run the real launcher with a probe in place of the server's command
      const { spawnSync } = await import("node:child_process");
      const at = args.indexOf("murage-env-launch");
      const probe = spawnSync(command, ["-e", args[1], "murage-env-launch", args[at + 1], process.execPath, "-e", "process.stdout.write(JSON.stringify([process.env.NOTES_TOKEN, Object.keys(process.env).filter((k) => k.startsWith('MURAGE_MCPV_'))]))"], { env: { ...childEnv, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
      const [token, leaked] = JSON.parse(probe.stdout);
      expect(leaked).toEqual([]);
      return token;
    };
    expect(await resolve("one")).toBe(fixtureCredentialFingerprint("value-for-one"));
    expect(await resolve("two")).toBe(fixtureCredentialFingerprint("value-for-two"));
  });

  it("skips custom MCP entries before copying reserved env or requesting a bearer, preserving built-ins and approval behavior", async () => {
    await create();
    const dump = join(scratch, "custom-mcp.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.customMcp).toBe(true);
    const blocked = Object.fromEntries([
      "MURAGE_COMMS_TOKEN", "MURAGE_CONNECTOR_UPSTREAM_URL", "murage_harness_url",
      "MURAGEBOX_TOKEN", "muragebox_url", "ELECTRON_RUN_AS_NODE", "electron_run_as_node",
      "DWEB_URL", "dweb_url", "PH_ANDROID_SERIAL", "ph_android_serial",
    ].map((key, index) => [`blocked${index}`, {
      command: "attacker-mcp", args: [], env: { [key]: "attacker-value", CUSTOM_REJECTED_MARKER: "must-not-copy" },
    }]));

    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "go",
      integrations: {
        custom: {
          ...blocked,
          bearer_request: { command: "attacker-mcp", args: [], env: { MURAGE_COMMS_TOKEN: "" } },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
        },
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            MURAGE_COMMS_TOKEN: "per-boot-token",
            MURAGE_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const argv = seen.argv.join(" ");
    for (const name of [...Object.keys(blocked), "bearer_request"]) {
      expect(argv).not.toContain(`mcp_servers.${name}.`);
    }
    expect(argv).not.toContain("attacker-mcp");
    expect(seen.env.CUSTOM_REJECTED_MARKER).toBeUndefined();
    expect(seen.env.MURAGE_COMMS_TOKEN).toBe(fixtureCredentialFingerprint("per-boot-token"));
    expect(seen.env.MURAGE_CONNECTOR_UPSTREAM_URL).toBe("http://127.0.0.1:8799/api/internal/connectors/mcp");
    expect(seen.argv.find((arg: string) => arg.startsWith("mcp_servers.notes.env_vars=")))
      .toBe('mcp_servers.notes.env_vars=["NOTES_TOKEN"]');
    expect(argv).toContain("mcp_servers.notes.command");
    // env value stays in the child env; argv carries names only
    expect(argv).toContain("NOTES_TOKEN");
    expect(argv).not.toContain("tok-notes");
    expect(seen.env.NOTES_TOKEN).toBe(fixtureCredentialFingerprint("tok-notes"));
    // the built-in keeps codex's pre-quieted approval mode; the custom
    // server does NOT — its tool calls arrive as approval cards
    expect(argv).toContain('mcp_servers.murage_connectors.default_tools_approval_mode');
    expect(argv).not.toContain('mcp_servers.notes.default_tools_approval_mode');
    // codex stops any MCP tool call after 60 seconds unless told otherwise;
    // every server Murage mounts gets a limit past the longest silence
    // setting, so a long tool call (or a card waiting on the owner) is
    // stopped only by the thread's silence watch or a Stop
    for (const name of ["murage_connectors", "notes"]) {
      expect(seen.argv).toContain(`mcp_servers.${name}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`);
    }
    expect(CODEX_MCP_TOOL_TIMEOUT_SEC).toBeGreaterThan(24 * 60 * 60);
    // a custom stdio server often downloads on its first turn: it gets 60 s
    // to start; Murage's own (already installed) servers get 20 s, at least twice
    // the connector bridge's absolute list deadline (codex's default is 10 s)
    expect(seen.argv).toContain("mcp_servers.notes.startup_timeout_sec=60");
    expect(seen.argv).toContain("mcp_servers.murage_connectors.startup_timeout_sec=20");
  });

  it("mounts two link servers as the proxy: names in argv, one shared child environment without a collision, no secret anywhere", async () => {
    await create();
    const dump = join(scratch, "remote-mounts.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const token = "b2".repeat(24);
    const context = { execPath: process.execPath, proxyPath: "/fake/remote-mcp-proxy.js", harnessUrl: "http://127.0.0.1:1", token: () => token };
    await instance.adapter.sendTurn({
      threadId: "t-remote-mounts",
      text: "go",
      integrations: {
        custom: {
          svc: buildRemoteMount("svc", context, token),
          svc2: buildRemoteMount("svc2", context, token),
          forged: { command: "attacker-mcp", args: [], env: { MURAGE_MCP_TOKEN: "forged" } },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-notes" } },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    for (const name of ["svc", "svc2"]) {
      expect(seen.argv).toContain(`mcp_servers.${name}.args=${JSON.stringify(["/fake/remote-mcp-proxy.js", "--server", name])}`);
      expect(seen.argv).toContain(`mcp_servers.${name}.env_vars=${JSON.stringify(["ELECTRON_RUN_AS_NODE", "MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN"])}`);
      expect(seen.argv).toContain(`mcp_servers.${name}.startup_timeout_sec=60`);
      expect(seen.argv).not.toContain(`mcp_servers.${name}.default_tools_approval_mode="auto"`);
    }
    // one child environment, one value each: the two servers agree, so nothing collides
    expect(seen.env.MURAGE_MCP_TOKEN).toBe(fixtureCredentialFingerprint(token));
    expect(JSON.stringify(seen.argv)).not.toContain(token);
    expect(JSON.stringify(seen.argv)).not.toContain("attacker-mcp");
    expect(seen.argv.find((arg: string) => arg.startsWith("mcp_servers.notes.env_vars="))).toBe('mcp_servers.notes.env_vars=["NOTES_TOKEN"]');
  });

  it("gives a custom server its own mount name when the owner's config.toml already declares one by that name", async () => {
    const codexHome = join(scratch, "collision-codex-home");
    mkdirSync(codexHome, { recursive: true });
    // the owner's own Fibery entry is a REMOTE server: merging a stdio
    // command into it is "invalid configuration" and kills the turn, and its
    // approval mode would silently un-card the bot's server
    writeFileSync(
      join(codexHome, "config.toml"),
      '[mcp_servers.fibery]\nurl = "https://mcp-eu-svc.fibery.io/mcp"\ndefault_tools_approval_mode = "auto"\n',
    );
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "collision.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-mcp-collision",
      text: "go",
      integrations: {
        custom: {
          fibery: { command: "uv", args: ["tool", "run", "fibery-mcp-server"], env: {} },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: {} },
        },
        browser: { command: process.execPath, args: ["/fake/browser-proxy.js"], env: {} },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
    const joined = argv.join(" ");

    // the colliding server moves aside, and nothing is written into the
    // owner's own table
    expect(joined).toContain("mcp_servers.fibery_murage.command");
    expect(argv.some((arg) => arg.startsWith("mcp_servers.fibery.") && arg !== "mcp_servers.fibery.enabled=false")).toBe(false);
    // the owner's own server is switched off for the bot (codex-isolation.ts), never redefined
    expect(argv).toContain("mcp_servers.fibery.enabled=false");
    // still no approval mode of its own: the moved server is carded, and it
    // can no longer inherit "auto" from the owner's entry
    expect(joined).not.toContain("mcp_servers.fibery_murage.default_tools_approval_mode");
    // an unrelated custom name is untouched
    expect(joined).toContain("mcp_servers.notes.command");
    expect(argv.some((arg) => arg.startsWith("mcp_servers.notes_murage."))).toBe(false);
    // harness-owned mounts are never renamed — a bot's custom server cannot
    // take one of their names (mcp-registry RESERVED_MCP_NAMES)
    expect(joined).toContain("mcp_servers.browser.command");
  });

  it("does not move a colliding server on top of one of the bot's own servers", async () => {
    const codexHome = join(scratch, "double-collision-codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.fibery]\nurl = "https://mcp-eu-svc.fibery.io/mcp"\n');
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "double-collision.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-mcp-double-collision",
      text: "go",
      integrations: {
        custom: {
          // the owner's name collides with the first; the second is the bot's
          // own server, already sitting on the alias the first wants
          fibery: { command: "uv", args: ["tool", "run", "fibery-mcp-server"], env: {} },
          fibery_murage: { command: "npx", args: ["-y", "@x/fibery-murage"], env: {} },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;

    // each server's command lands under its own mcp_servers.<mount>. prefix,
    // and the two prefixes are different — one -c override merging into the
    // other is the same silent capability merge, caused by Murage this time
    const mountOf = (command: string): string => {
      const arg = argv.find((entry) => entry.startsWith("mcp_servers.") && entry.endsWith(`.command=${JSON.stringify(command)}`));
      return arg ? arg.slice("mcp_servers.".length, arg.indexOf(".command=")) : "";
    };
    const movedAside = mountOf("uv");
    const ownServer = mountOf("npx");
    expect(ownServer).toBe("fibery_murage");
    expect(movedAside).not.toBe("");
    expect(movedAside).not.toBe(ownServer);
    // and nothing is written into the owner's own table
    expect(argv.some((arg) => arg.startsWith("mcp_servers.fibery.") && arg !== "mcp_servers.fibery.enabled=false")).toBe(false);
  });

  const mountPrefixes = (dump: string): string[] => {
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
    return argv.filter((arg) => arg.endsWith(".command=\"uv\"")).map((arg) => arg.slice(0, arg.indexOf(".command=")));
  };

  it("moves a colliding server aside however the owner's config.toml spells the table", async () => {
    // none of these is a `[mcp_servers.fibery]` header, and every one of them
    // defines the same table that `-c mcp_servers.fibery.command=…` merges into
    const spellings = [
      ['mcp_servers.fibery.url = "https://mcp-eu-svc.fibery.io/mcp"\n', "dotted"],
      ['["mcp_servers".fibery]\nurl = "https://mcp-eu-svc.fibery.io/mcp"\n', "quoted-root"],
      ['mcp_servers = { fibery = { url = "https://mcp-eu-svc.fibery.io/mcp" } }\n', "inline"],
      ['[mcp_servers]\nfibery = { url = "https://mcp-eu-svc.fibery.io/mcp" }\n', "under-header"],
    ] as const;

    for (const [config, label] of spellings) {
      const codexHome = join(scratch, `spelling-${label}`);
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), config);
      await create({ environment: { CODEX_HOME: codexHome } });
      const dump = join(scratch, `spelling-${label}.json`);
      process.env.FAKE_CODEX_DUMP = dump;

      await instance.adapter.sendTurn({
        threadId: `t-spelling-${label}`,
        text: "go",
        integrations: { custom: { fibery: { command: "uv", args: ["tool", "run", "fibery-mcp-server"], env: {} } } },
      });
      await recorder.until((event) => event.type === "turn.completed");
      expect(mountPrefixes(dump), label).toEqual(["mcp_servers.fibery_murage"]);

      recorder.stop();
      await instance.dispose();
    }
  });

  it("moves every custom server aside when the owner's config.toml cannot be read", async () => {
    // a directory where config.toml should be: the file is there in some form
    // and Murage cannot see inside it. Mounting under the bot's own names would
    // merge each override into whatever the owner actually wrote, including a
    // default_tools_approval_mode that un-cards the server.
    const codexHome = join(scratch, "unreadable-codex-home");
    mkdirSync(join(codexHome, "config.toml"), { recursive: true });
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "unreadable.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-unreadable-config",
      text: "go",
      integrations: {
        custom: { fibery: { command: "uv", args: [], env: {} }, notes: { command: "uv", args: ["notes"], env: {} } },
        browser: { command: process.execPath, args: ["/fake/browser-proxy.js"], env: {} },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;

    expect(mountPrefixes(dump).sort()).toEqual(["mcp_servers.fibery_murage", "mcp_servers.notes_murage"]);
    expect(argv.some((arg) => arg.startsWith("mcp_servers.fibery."))).toBe(false);
    expect(argv.some((arg) => arg.startsWith("mcp_servers.notes."))).toBe(false);
    // the moved servers are still carded, and harness mounts are untouched
    expect(argv.some((arg) => arg.includes("_murage.default_tools_approval_mode"))).toBe(false);
    expect(argv.join(" ")).toContain("mcp_servers.browser.command");
  });

  it("turns off Codex's own desktop browser and computer tools so the bot uses Murage's", async () => {
    await create();
    const dump = join(scratch, "tool-surface.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-tool-surface",
      text: "go",
      preloadBrowserTools: true,
      integrations: { browser: { command: process.execPath, args: ["/fake/browser-proxy.js"], env: {} } },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const argv: string[] = JSON.parse(readFileSync(dump, "utf8")).argv;
    expect(argv).toContain("features.browser_use=false");
    expect(argv).toContain("features.browser_use_external=false");
    expect(argv).toContain("features.computer_use=false");
    expect(argv).toContain('plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }');
    // native web search keeps whatever mode the owner configured
    expect(argv.some((arg) => arg.startsWith("web_search="))).toBe(false);
    expect(argv.join(" ")).toContain("mcp_servers.browser.command");
    expect(argv.join(" ")).not.toContain("alwaysLoad");
    expect(argv.join(" ")).not.toContain("preloadBrowserTools");
  });

  it("mounts dedicated memory without agents and rejects custom replacement without exposing its token in argv", async () => {
    await create();
    const dump=join(scratch,"memory.json");process.env.FAKE_CODEX_DUMP=dump;
    await instance.adapter.sendTurn({threadId:"memory-only",text:"recall",integrations:{
      memory:{command:process.execPath,args:["/fake/memory-proxy.js"],env:{MURAGE_HARNESS_URL:"http://127.0.0.1:1",MURAGE_MEMORY_TOKEN:"memory-fixture-secret"}},
      custom:{"murage-memory":{command:"attacker-mcp",args:[],env:{}},forged:{command:"attacker-mcp",args:[],env:{MURAGE_MEMORY_TOKEN:"forged"}}},
    }});
    await recorder.until(event=>event.type==="turn.completed");
    const seen=JSON.parse(readFileSync(dump,"utf8")),argv=seen.argv.join(" ");
    expect(instance.adapter.capabilities.memoryMcp).toBe(true);
    expect(argv).toContain("mcp_servers.murage-memory.command");
    expect(argv).toContain("/fake/memory-proxy.js");
    expect(argv).not.toContain("attacker-mcp");
    expect(argv).not.toContain("memory-fixture-secret");
    expect(seen.env.MURAGE_MEMORY_TOKEN).toBe(fixtureCredentialFingerprint("memory-fixture-secret"));
    expect(argv).not.toContain("mcp_servers.agents.command");
  });

  it("mounts peer-agent comms without placing the comms token in argv", async () => {
    await create();
    const dump = join(scratch, "agents.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "ask the researcher",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            MURAGE_HARNESS_URL: "http://127.0.0.1:8799",
            MURAGE_BOT_ID: "captain",
            MURAGE_THREAD_ID: "t-agents",
            MURAGE_COMMS_TOKEN: "peer-comms-secret",
            MURAGE_TURN_DEPTH: "0",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.agents.command");
    expect(seen.argv.join(" ")).toContain("/tmp/agents-proxy.js");
    expect(seen.argv.join(" ")).toContain("MURAGE_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("peer-comms-secret");
    expect(seen.env.MURAGE_COMMS_TOKEN).toBe(fixtureCredentialFingerprint("peer-comms-secret"));
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
  });

  it("mounts the Local VM computer MCP server without placing credentials in argv", async () => {
    await create();
    const dump = join(scratch, "local-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.computerMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-local-computer",
      text: "open the browser",
      integrations: {
        localComputer: {
          command: process.execPath,
          args: ["/tmp/container-mcp.js", "podman", "murage-computer", "/run/cua.sock"],
          env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_VM_TOKEN: "vm-secret" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("/tmp/container-mcp.js");
    expect(seen.argv.join(" ")).toContain("MURAGE_VM_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("vm-secret");
    expect(seen.env.MURAGE_VM_TOKEN).toBe(fixtureCredentialFingerprint("vm-secret"));
  });

  it("mounts the remote computer proxy without placing its token in argv", async () => {
    await create();
    const dump = join(scratch, "remote-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-remote-computer",
      text: "take a screenshot",
      integrations: {
        computer: { boxId: "box-123", token: "remote-secret" },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("computer-proxy");
    expect(seen.argv.join(" ")).toContain("MURAGEBOX_BOX_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("remote-secret");
    expect(seen.env.MURAGEBOX_BOX_ID).toBe("box-123");
    expect(seen.env.MURAGEBOX_BOX_TOKEN).toBe(fixtureCredentialFingerprint("remote-secret"));
  });

  it("sends the local provider when the picker id is custom-encoded", async () => {
    await create({ environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" } });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "hi",
      model: "unsloth::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const threadStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "unsloth",
    });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("model_providers.unsloth.base_url=\"http://127.0.0.1:8888/v1\"");
    expect(JSON.stringify(seen.argv)).not.toContain("unsloth-secret");
    expect(seen.env.MURAGE_LOCAL_UNSLOTH_API_KEY).toBe(fixtureCredentialFingerprint("unsloth-secret"));
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  // Isolation-all round 3: a cursor from an earlier root is not in the bot's state root. Real Codex 0.162.1
  // (fake CODEX_HOME, build host container) answers thread/resume with -32600 "no rollout found for thread id …".
  it("replays the conversation into the one fresh thread when resume fails, and a resumed thread gets no replay", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    const dump = join(scratch, "r3-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-r3-replay", text: "What did I say?", resumeCursor: "gone-thread",
      transcript: [{ role: "user", text: "Remember ALPHA." }, { role: "assistant", text: "Remembered." }],
    });
    await recorder.until((e) => e.type === "turn.completed");
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: any }>;
    expect(calls.filter((c) => c.method === "thread/start")).toHaveLength(1);
    const sent = calls.find((c) => c.method === "turn/start")!.params.input[0].text as string;
    expect(sent).toMatch(/could not be restored[\s\S]*User: Remember ALPHA\.\nAssistant: Remembered\.[\s\S]*What did I say\?$/);
  });

  it("does not replay when the resume worked", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "r3-dump-ok.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-r3-noreplay", text: "again", resumeCursor: "codex-thread-9",
      transcript: [{ role: "user", text: "Remember ALPHA." }],
    });
    await recorder.until((e) => e.type === "turn.completed");
    const calls = JSON.parse(readFileSync(dump, "utf8")).calls as Array<{ method: string; params: any }>;
    expect(calls.find((c) => c.method === "turn/start")!.params.input[0].text).toBe(`${TURN_ASK_RULES}\n\nagain`);
  });

  it("on a Cloud home names the bot, renders the resumed thread's policy and resumes under the start policy", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    // The spawn is captured as the launcher would get it, then run as a desktop spawn of the fake.
    const realSpawnCli = procs.spawnCli;
    const spawned: Record<string, string | undefined>[] = [];
    const spy = vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts, ...rest) => {
      spawned.push({ ...(opts.env as Record<string, string | undefined>) });
      vi.stubEnv("MURAGE_CLOUD_ROLE", "");
      try { return realSpawnCli(cli, args, { ...opts, env: { ...process.env } }, ...rest); }
      finally { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); }
    });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    try {
      await instance.adapter.sendTurn({ threadId: "t-cloud-resume", text: "again", cwd: scratch, resumeCursor: "codex-thread-9", warmIdentity: { botId: "bot-atlas", audience: "owner" } });
      await recorder.until((e) => e.type === "turn.completed");
      const resumed = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "thread/resume");
      expect(resumed.params).toEqual({ threadId: "codex-thread-9", sandbox: "workspace-write", approvalPolicy: "on-request" });
      const first = spawned.at(-1)!;
      expect(first[TURN_BOT]).toBe("bot-atlas");
      expect(JSON.parse(first[TURN_RENDER]!)).toMatchObject({ resume: "codex-thread-9", codexPolicy: { approval: "on-request", sandbox: "workspace-write" } });
      const request = JSON.parse(cloudTurnLaunch("codex", ["app-server"], first, scratch)!.request);
      expect(request.bot).toBe("bot-atlas");
      expect(request.render.codexPolicy).toEqual({ approval: "on-request", sandbox: "workspace-write" });
      expect(Object.keys(request.env)).not.toContain(TURN_BOT);
      // Rule 74 on a Cloud home: the handed pins sit on top of the cloudTurnEnvironment map and ride the launcher request.
      for (const [name, value] of valuePins(process.platform)) { expect(first[name], name).toBe(value); expect(request.env[name], name).toBe(value); }
      // (the ssh program is the identified OpenSSH, or plain ssh; the launcher pins the plain form either way; on Windows the
      // identified OpenSSH is a drive path to ssh.exe, e.g. Git's C:\Program Files\Git\usr\bin\ssh.exe)
      expect(first.GIT_SSH_COMMAND).toMatch(/^'(?:\/[^']*\/|[A-Za-z]:\\[^']*\\)?ssh(?:\.exe)?' '-o' 'BatchMode=yes'$/);
      expect(request.env.GIT_SSH_COMMAND).toBe(first.GIT_SSH_COMMAND);
      expect(request.env.RSYNC_RSH).toBe(first.GIT_SSH_COMMAND);
      for (const name of ABSENT_PINS) expect(request.env, name).not.toHaveProperty(name);

      // A new thread names no rollout and so no resume policy.
      const before = spawned.length;
      await instance.adapter.sendTurn({ threadId: "t-cloud-fresh", text: "hi", cwd: scratch, warmIdentity: { botId: "bot-atlas", audience: "owner" } });
      await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-cloud-fresh");
      const fresh = JSON.parse(spawned[before][TURN_RENDER] ?? "{}");
      expect(fresh).not.toHaveProperty("resume");
      expect(fresh).not.toHaveProperty("codexPolicy");
      expect(spawned[before][TURN_BOT]).toBe("bot-atlas");
    } finally {
      vi.unstubAllEnvs();
      spy.mockRestore();
    }
  });

  describe("Flux Memory headers on a Cloud home", () => {
    const FLUX_KEY = "sk-flux-Mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm"; // secret-scan: fixture
    // Capture the spawn as the launcher would get it (argv and render), then run it as a desktop spawn of the fake.
    const captureHomeSpawn = async (turn: Record<string, unknown>) => {
      await create();
      const realSpawnCli = procs.spawnCli;
      const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const spy = vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts, ...rest) => {
        spawned.push({ args: [...args], env: { ...(opts.env as Record<string, string | undefined>) } });
        vi.stubEnv("MURAGE_CLOUD_ROLE", "");
        try { return realSpawnCli(cli, args, { ...opts, env: { ...process.env } }, ...rest); }
        finally { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); }
      });
      vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
      vi.stubEnv("FLUX_API_KEY", FLUX_KEY);
      try {
        await instance.adapter.sendTurn({ text: "hi", cwd: scratch, ...turn } as never);
        await recorder.until((e) => e.type === "turn.completed");
        return spawned.at(-1)!;
      } finally { vi.unstubAllEnvs(); spy.mockRestore(); }
    };
    const memoryOff = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };

    it("a saved Flux connection sends no model_providers argv and carries the headers on the render route", async () => {
      const providerRoute = { connectionId: "c1", revision: "r1", preset: "flux", protocol: "responses", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: FLUX_KEY, model: "flux-auto" };
      const seen = await captureHomeSpawn({ threadId: "t-cloud-flux-conn", model: "flux-auto", providerRoute, warmIdentity: { botId: "bot-atlas", audience: "owner", decidedOwner: true } });
      expect(seen.args.filter((arg) => arg.startsWith("model_providers."))).toEqual([]);
      expect(JSON.parse(seen.env[TURN_RENDER]!).route.headers).toEqual({ "x-flux-memory-app": "murage" });
    });

    it("a non-owner native flux turn renders the flux-off table with the capture-off headers", async () => {
      const seen = await captureHomeSpawn({ threadId: "t-cloud-flux-guest", model: "flux::flux-auto", warmIdentity: { botId: "bot-atlas", audience: "non-owner", decidedOwner: false } });
      expect(seen.args.filter((arg) => arg.startsWith("model_providers."))).toEqual([]);
      const route = JSON.parse(seen.env[TURN_RENDER]!).route;
      expect(route.provider).toBe("flux-off");
      expect(route.headers).toEqual(memoryOff);
    });

    it("an owner native flux turn renders the base flux table", async () => {
      const seen = await captureHomeSpawn({ threadId: "t-cloud-flux-owner", model: "flux::flux-auto", warmIdentity: { botId: "bot-atlas", audience: "owner", decidedOwner: true } });
      const route = JSON.parse(seen.env[TURN_RENDER]!).route;
      expect(route.provider).toBe("flux");
      expect(route.headers).toEqual({ "x-flux-memory-app": "murage" });
    });
  });

  it("reports API billing on a Cloud home only when the launcher says Codex runs on an enrolled key", async () => {
    const answer = (code: number, stdout: string): CloudLauncherSpawn => () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdoutStream = new PassThrough(), stderrStream = new PassThrough();
      Object.assign(child, { stdout: stdoutStream, stderr: stderrStream, kill: () => true });
      setImmediate(() => { stdoutStream.end(stdout); stderrStream.end(); setImmediate(() => (child as unknown as EventEmitter).emit("close", code)); });
      return child;
    };
    const engines = (mode: string) => JSON.stringify({ tombstoned: false, engines: { codex: { mode, signedIn: true, expiresAt: null } } });
    expect(await codexCloudBilling(answer(0, engines("apikey")))).toBe("subscription"); // off a home: unchanged
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    try {
      expect(await codexCloudBilling(answer(0, engines("apikey")))).toBe("metered");
      expect(await codexCloudBilling(answer(0, engines("chatgpt")))).toBe("subscription");
      expect(await codexCloudBilling(answer(0, JSON.stringify({ tombstoned: false, engines: {} })))).toBe("subscription");
      expect(await codexCloudBilling(answer(1, ""))).toBe("subscription");
      expect(await codexCloudBilling(answer(0, "garbage"))).toBe("subscription");
      expect(await codexCloudBilling(() => { throw new Error("spawn failed"); })).toBe("subscription");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("headlines the real command of a legacy shell approval and labels the reason apart", async () => {
    process.env.FAKE_CODEX_APPROVAL = JSON.stringify({
      method: "execCommandApproval",
      params: { command: ["rm", "-rf", "build dir"], reason: "Just tidying the workspace" },
    });
    await create({ mode: "approval" });
    await instance.adapter.sendTurn({ threadId: "t-approve-argv", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ tool: "shell", summary: "rm -rf 'build dir'", reason: "Just tidying the workspace" });
    await instance.adapter.respondToRequest("t-approve-argv", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("headlines the files of a legacy apply_patch approval, not the reason", async () => {
    process.env.FAKE_CODEX_APPROVAL = JSON.stringify({
      method: "applyPatchApproval",
      params: { fileChanges: { "src/a.ts": { type: "update" }, "src/b.ts": { type: "add" } }, reason: "Fixing the bug" },
    });
    await create({ mode: "approval" });
    await instance.adapter.sendTurn({ threadId: "t-approve-patch", text: "patch" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ tool: "edit", summary: "src/a.ts, src/b.ts", reason: "Fixing the bug" });
    await instance.adapter.respondToRequest("t-approve-patch", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("answers Codex 0.149 MCP elicitation with the MCP result shape", async () => {
    await create({ mode: "mcp-elicitation" });
    const dump = join(scratch, "mcp-elicitation.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-elicitation", text: "list bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // Rule 12: the fake's ask names its tool only in the message prose, which
    // is never read, so the call is named by the server with an empty tool part
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "mcp__agents__",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });
    // the arguments reach the card, not only the question
    expect(JSON.parse((opened as any).toolInput)).toEqual({ bot: "lena", limit: 3 });

    await instance.adapter.respondToRequest("t-mcp-elicitation", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: {} });
  });

  it("a project question stays open past its normal deadline", async () => {
    await create({ mode: "form-elicitation" });
    const original = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
      original(callback, delay === 30 * 60_000 ? 50 : delay, ...args)) as typeof setTimeout);
    try {
      await instance.adapter.sendTurn({ threadId: "project-question", text: "choose", holdProjectAsks: true, holdPermissionAsks: true });
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(opened).toMatchObject({ requestType: "question" });
      await new Promise(resolve => original(resolve, 200));
      expect(recorder.events.some(event => event.type === "request.resolved")).toBe(false);
      await instance.adapter.respondToRequest("project-question", opened.requestId!, { behavior: "deny" });
      expect(await recorder.until(event => event.type === "request.resolved")).toMatchObject({ source: "user" });
    } finally { timer.mockRestore(); }
  });

  it("shows a form elicitation as a question, never auto-answers it in fullAuto, and accepts typed content (ASK1, ASK3)", async () => {
    await create({ mode: "form-elicitation", fullAuto: true });
    const dump = join(scratch, "form-elicitation.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-form-elicitation", text: "deploy it" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // ASK1 carded this as a permission named "elicitation"; ASK3 makes it the
    // question it is, with the MCP server's field as the card's question.
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "elicitation",
      summary: "Which environment should I deploy to?",
      choices: ["staging", "production"],
      questions: [{ id: "environment", question: "Which environment should I deploy to?", options: [{ label: "staging" }, { label: "production" }], multiSelect: false, allowOther: false }],
    });

    await expect(
      instance.adapter.respondToRequest("t-form-elicitation", opened.requestId!, {
        behavior: "answer",
        message: "production",
        answers: [{ id: "environment", selected: ["production"] }],
      }),
    ).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "answer", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: { environment: "production" } });
  });

  it("declines a skipped form elicitation with the MCP result shape, not an invented answer (ASK3)", async () => {
    await create({ mode: "form-elicitation" });
    const dump = join(scratch, "form-elicitation-skip.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-form-skip", text: "deploy it" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-form-skip", opened.requestId!, { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
  });

  it("maps item/tool/requestUserInput to a question with every question's own options and answers per id (ASK3)", async () => {
    await create({ mode: "user-input", fullAuto: true });
    const dump = join(scratch, "user-input.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-user-input", text: "set it up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    // fullAuto never answers a question; the card carries all three questions
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "request_user_input",
      summary: "Which database should the service use?",
      choices: ["Postgres", "Redis"],
      questions: [
        { id: "db", header: "Database", options: [{ label: "Postgres", description: "Relational, durable" }, { label: "Redis", description: "In-memory, fast" }], allowOther: false },
        { id: "token", header: "Token", options: [], allowOther: true, secret: true },
        { id: "region", header: "Region", options: [{ label: "eu-west", description: "Ireland" }], allowOther: true },
      ],
    });

    await expect(
      instance.adapter.respondToRequest("t-user-input", opened.requestId!, {
        behavior: "answer",
        message: "Redis / tok / eu-west",
        answers: [
          { id: "db", selected: ["Redis"] },
          { id: "token", selected: [], other: "tok_secret_1" },
          { id: "region", selected: ["eu-west"] },
        ],
      }),
    ).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "answer", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      answers: { db: { answers: ["Redis"] }, token: { answers: ["tok_secret_1"] }, region: { answers: ["eu-west"] } },
    });
  });

  it("answers a skipped requestUserInput with empty answers, never a sentence in the owner's name (ASK3)", async () => {
    await create({ mode: "user-input" });
    const dump = join(scratch, "user-input-skip.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-user-input-skip", text: "set it up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-user-input-skip", opened.requestId!, { behavior: "deny" })).resolves.toBe("rejected");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    const decision = JSON.parse(readFileSync(dump, "utf8")).decision;
    expect(decision).toEqual({ answers: { db: { answers: [] }, token: { answers: [] }, region: { answers: [] } } });
    expect(JSON.stringify(decision)).not.toMatch(/nobody|judgment|Murage/);
  });

  it("gives Codex the same honest no-answer when the turn ends with a question still open (ASK3)", async () => {
    await create({ mode: "user-input" });
    const dump = join(scratch, "user-input-ended.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-user-input-end", text: "set it up" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-user-input-end");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  // With the host computer attached, a shell command or another MCP server's
  // tool is judged like any other ask, so a stop line card (a delete outside
  // the folder) keeps "Allow for this task" and "Always allow". Only the
  // computer's own tools keep the local-computer treatment.
  const hostComputer = { localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin" as const, scope: "local-computer" as const } };
  it("does not stamp a shell command as computer control when the host computer is attached", async () => {
    await create({ mode: "approval" });
    await instance.adapter.sendTurn({ threadId: "t-host-shell", text: "clean up", integrations: hostComputer });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ tool: "shell", toolCall: { name: "shell" } });
    expect((opened as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-host-shell", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("does not stamp another MCP server's tool as computer control", async () => {
    await create({ mode: "mcp-elicitation" });
    await instance.adapter.sendTurn({ threadId: "t-host-mcp", text: "list", integrations: hostComputer });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ toolCall: { name: "mcp__agents__" } });
    expect((opened as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-host-mcp", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("stamps approvalScope on cards only when the turn controls this Mac", async () => {
    process.env.FAKE_CODEX_MCP_SERVER = "computer";
    process.env.FAKE_CODEX_MCP_TOOL = "click";
    await create({ mode: "mcp-elicitation" });

    // host-mounted: a computer tool carries the scope that keeps the
    // harness's local-computer-block backstop in force for remembered
    // always-allows
    await instance.adapter.sendTurn({
      threadId: "t-host-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });
    const host = await recorder.until((e) => e.type === "request.opened");
    expect(host).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-host-scope", host.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    // a Local VM mount is not the host: no scope stamped
    await instance.adapter.sendTurn({
      threadId: "t-vm-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: process.execPath, args: ["/tmp/container-mcp.js"], env: {} },
      },
    });
    const vm = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-vm-scope");
    expect((vm as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-vm-scope", vm.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-vm-scope");
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  // Murage's Full access stops before deleting outside its folder, paying
  // and messaging someone new (server/stop-line.ts): a fullAuto instance
  // keeps its reach but asks, so those three can wait for the owner.
  // Gap 4: routeAsks replaces never on both Codex thread/start and turn/start.
  it("routeAsks overrides only Codex skip-all approval policy", async () => {
    for (const fullAuto of [false, true]) {
      if (fullAuto) { recorder.stop(); await instance.dispose(); }
      await create({ mode: "approval", fullAuto });
      const dump = join(scratch, `enforce-asks-${fullAuto}.json`);
      process.env.FAKE_CODEX_DUMP = dump;
      for (const [turn, enforced] of [false, true, false].entries()) {
        const threadId = `t-enforce-${fullAuto}-${turn}`;
        const sent = await instance.adapter.sendTurn({
          threadId, text: "hi",
          ...(enforced ? { routeAsks: true as const } : {}),
        });
        const event = await recorder.until((event) => event.turnId === sent.turnId &&
          (event.type === "request.opened" || event.type === "turn.completed"));
        expect(event.type).toBe(!fullAuto || enforced ? "request.opened" : "turn.completed");
        if (event.type === "request.opened") {
          expect(event).toMatchObject({ requestType: "permission", tool: "shell" });
          await instance.adapter.respondToRequest(threadId, event.requestId!, { behavior: "deny" });
        }
        await recorder.until((event) => event.type === "turn.completed" && event.turnId === sent.turnId);
        const seen = JSON.parse(readFileSync(dump, "utf8"));
        const start = seen.calls.find((call: { method: string }) => call.method === "thread/start");
        const prompt = seen.calls.find((call: { method: string }) => call.method === "turn/start");
        expect(start.params).toMatchObject({
          sandbox: fullAuto ? "danger-full-access" : "workspace-write",
          approvalPolicy: fullAuto ? enforced ? "untrusted" : "never" : "on-request",
        });
        expect(prompt).toBeDefined();
        if (fullAuto && enforced) expect(prompt.params.approvalPolicy).toBe("untrusted");
        else expect(prompt.params).not.toHaveProperty("approvalPolicy");
      }
    }
  });

  it("asks instead of auto-accepting under the stop line, and reports the command", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump-stop-line.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-stop-line", text: "clean up", stopLine: true });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", toolCall: { name: "shell", input: { command: "rm -rf scratch" } } });
    await instance.adapter.respondToRequest("t-stop-line", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const start = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(start.params).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "untrusted" });
    expect(seen.calls.find((c: { method: string }) => c.method === "turn/start").params.approvalPolicy).toBe("untrusted");
  });

  // Ask and Auto bots (below Full access) ask too: the owner's mode decides.
  it("asks instead of auto-accepting for an Ask or Auto bot on a fullAuto instance", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump-route-asks.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-route-asks", text: "clean up", routeAsks: true });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", toolCall: { name: "shell", input: { command: "rm -rf scratch" } } });
    await instance.adapter.respondToRequest("t-route-asks", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.calls.find((c: { method: string }) => c.method === "thread/start").params).toMatchObject({ approvalPolicy: "untrusted" });
    expect(seen.calls.find((c: { method: string }) => c.method === "turn/start").params.approvalPolicy).toBe("untrusted");
  });

  it("reports an MCP tool call's server, name and arguments for the stop line", async () => {
    await create({ mode: "mcp-elicitation" });
    await instance.adapter.sendTurn({ threadId: "t-mcp-toolcall", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ toolCall: { name: "mcp__agents__", input: { bot: "lena", limit: 3 } } });
    await instance.adapter.respondToRequest("t-mcp-toolcall", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  describe("F4 records and structured MCP names (T3, T11, T63, T64, T74)", () => {
    const agentsMount = {
      command: process.execPath,
      args: ["/tmp/agents-proxy.js"],
      env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:8799", MURAGE_BOT_ID: "captain", MURAGE_THREAD_ID: "t", MURAGE_COMMS_TOKEN: "peer", MURAGE_TURN_DEPTH: "0" },
    };
    const mcpAsk = (serverName: string, meta: Record<string, unknown>) => {
      process.env.FAKE_CODEX_APPROVAL = JSON.stringify({
        method: "mcpServer/elicitation/request",
        params: {
          serverName,
          mode: "form",
          _meta: { codex_approval_kind: "mcp_tool_call", ...meta },
          message: `Allow the ${serverName} MCP server to run tool "decoy_from_prose"?`,
          requestedSchema: { type: "object", properties: {} },
        },
      });
    };
    type Opened = {
      tool: string;
      toolEngine?: string;
      mcpMounts?: Array<{ engineName: string; mountId: string; provenance: string }>;
      toolCall?: { name: string; input?: unknown };
      toolInputMissing?: string;
    };
    const ask = async (threadId: string, integrations?: Record<string, unknown>): Promise<Opened> => {
      await instance.adapter.sendTurn({ threadId, text: "go", ...(integrations ? { integrations } : {}) } as never);
      const opened = await recorder.until((e) => e.type === "request.opened" && e.threadId === threadId);
      await instance.adapter.respondToRequest(threadId, opened.requestId!, { behavior: "deny" });
      await recorder.until((e) => e.type === "turn.completed" && e.threadId === threadId);
      return opened as unknown as Opened;
    };
    const resolved = (opened: Opened) =>
      resolveCall({ engine: "codex", toolCall: opened.toolCall as never, mcpMounts: opened.mcpMounts as never, inputMissing: opened.toolInputMissing });

    it("names the MCP tool from the structured field, never from the message prose (T11)", async () => {
      mcpAsk("agents", { tool_name: "list_bots", tool_params: { limit: 3 } });
      await create({ mode: "approval" });
      const opened = await ask("t-named", { agents: agentsMount });
      expect(opened.toolEngine).toBe("codex");
      expect(opened.toolCall).toEqual({ name: "mcp__agents__list_bots", input: { limit: 3 } });
      expect(opened.tool).toBe("list_bots");
      expect(resolved(opened)).toMatchObject({ kind: "mcp", server: "agents", tool: "list_bots", mountId: "own:agents", own: false });
    });

    it("an MCP ask with no structured tool name is called mcp__<server>__ and resolves unproven (T11)", async () => {
      mcpAsk("agents", { tool_params: {} });
      await create({ mode: "approval" });
      const opened = await ask("t-unnamed", { agents: agentsMount });
      expect(opened.toolCall).toEqual({ name: "mcp__agents__", input: {} });
      expect(opened.tool).toBe("mcp__agents__");
      expect(resolved(opened)).toMatchObject({ kind: "unproven" });
    });

    it("an MCP ask with no tool_params states the field missing and carries no input (F5)", async () => {
      mcpAsk("agents", { tool_name: "list_bots" });
      await create({ mode: "approval" });
      const opened = await ask("t-noparams", { agents: agentsMount });
      expect(opened.toolInputMissing).toBe("_meta.tool_params");
      expect(opened.toolCall).toEqual({ name: "mcp__agents__list_bots" });
      expect("input" in opened.toolCall!).toBe(false);
      expect(autoVerdict({ autoApprove: true }, opened.tool, "x", { call: { toolCall: opened.toolCall as never, mcpMounts: opened.mcpMounts as never, inputMissing: opened.toolInputMissing, engine: "codex" } }))
        .toMatchObject({ approve: null, source: "unread-call" });
    });

    it("an MCP name that fits no record resolves unproven (T3)", async () => {
      mcpAsk("ghost", { tool_name: "do_it", tool_params: {} });
      await create({ mode: "approval" });
      const opened = await ask("t-ghost", { agents: agentsMount });
      expect(opened.toolCall?.name).toBe("mcp__ghost__do_it");
      expect(opened.mcpMounts!.map((r) => r.engineName)).toEqual(["agents"]);
      expect(resolved(opened)).toMatchObject({ kind: "unproven" });
    });

    it("a shell ask with no command is unread, and the command is never replaced by the summary (T64)", async () => {
      process.env.FAKE_CODEX_APPROVAL = JSON.stringify({ method: "item/commandExecution/requestApproval", params: { cwd: "/tmp" } });
      await create({ mode: "approval" });
      const opened = await ask("t-nocommand");
      expect(opened.toolInputMissing).toBe("command");
      expect(opened.toolCall).toEqual({ name: "shell" });
      const verdict = autoVerdict({ autoApprove: true }, opened.tool, "shell", { call: { toolCall: opened.toolCall as never, mcpMounts: opened.mcpMounts as never, inputMissing: opened.toolInputMissing, engine: "codex" } });
      expect(verdict).toMatchObject({ approve: null, source: "unread-call" });
    });

    it("a shell ask that carries its command reports it as written", async () => {
      process.env.FAKE_CODEX_APPROVAL = JSON.stringify({ method: "execCommandApproval", params: { command: ["ls", "-la"], cwd: "/tmp" } });
      await create({ mode: "approval" });
      const opened = await ask("t-command");
      expect(opened.toolInputMissing).toBeUndefined();
      expect(opened.toolCall).toEqual({ name: "shell", input: { command: ["ls", "-la"], cwd: "/tmp" } });
    });

    it("records own and custom mounts with the registry name before aliasing (T63)", async () => {
      const codexHome = join(scratch, "records-home");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.fibery]\nurl = "https://example.invalid/mcp"\n');
      mcpAsk("fibery_murage", { tool_name: "search", tool_params: { q: "x" } });
      await create({ mode: "approval", environment: { CODEX_HOME: codexHome } });
      const opened = await ask("t-records", {
        agents: agentsMount,
        custom: {
          fibery: { command: "uv", args: ["run", "f"], env: {} },
          notes: { command: "npx", args: ["-y", "n"], env: {} },
          bad__name: { command: "x", args: [], env: {} },
        },
      });
      const mounts = opened.mcpMounts!;
      expect(mounts.every(isMountRecord)).toBe(true);
      expect(mounts).toContainEqual({ engineName: "agents", mountId: "own:agents", provenance: "own" });
      // engineName after aliasing, mountId the registry name before it
      expect(mounts).toContainEqual({ engineName: "fibery_murage", mountId: "custom:fibery", provenance: "custom" });
      expect(mounts).toContainEqual({ engineName: "notes", mountId: "custom:notes", provenance: "custom" });
      // a name holding __ is refused: no record
      expect(mounts.some((r) => r.engineName.includes("__"))).toBe(false);
      expect(resolved(opened)).toMatchObject({ kind: "mcp", server: "fibery_murage", mountId: "custom:fibery", provenance: "custom" });
    });

    it("does not mount a custom server whose name holds a double underscore (Rule 11)", async () => {
      await create();
      const dump = join(scratch, "double-underscore.json");
      process.env.FAKE_CODEX_DUMP = dump;
      await instance.adapter.sendTurn({
        threadId: "t-dunder",
        text: "go",
        integrations: { custom: { bad__name: { command: "x", args: [], env: {} }, ok: { command: "y", args: [], env: {} } } },
      });
      await recorder.until((event) => event.type === "turn.completed");
      const joined = (JSON.parse(readFileSync(dump, "utf8")).argv as string[]).join(" ");
      expect(joined).not.toContain("bad__name");
      expect(joined).toContain("mcp_servers.ok.command");
    });

    it("adds an external record for each table in the config.toml under the spawn's CODEX_HOME (T74)", async () => {
      const homeA = join(scratch, "home-a");
      const homeB = join(scratch, "home-b");
      for (const dir of [homeA, homeB]) mkdirSync(dir, { recursive: true });
      const table = '[mcp_servers.shared]\ncommand = "tool"\nargs = ["--x"]\nenv = { TOKEN = "t" }\n[mcp_servers.agents]\ncommand = "owner-agents"\n';
      writeFileSync(join(homeA, "config.toml"), table);
      writeFileSync(join(homeB, "config.toml"), table);
      mcpAsk("shared", { tool_name: "go", tool_params: {} });

      await create({ mode: "approval", environment: { CODEX_HOME: homeA } });
      const first = await ask("t-ext-a", { agents: agentsMount });
      await instance.dispose();
      await create({ mode: "approval", environment: { CODEX_HOME: homeB } });
      const second = await ask("t-ext-b", { agents: agentsMount });

      const externals = (o: Opened) => o.mcpMounts!.filter((r) => r.provenance === "external");
      expect(externals(first)).toHaveLength(1);
      expect(externals(first)[0]).toMatchObject({ engineName: "shared", provenance: "external" });
      expect(externals(first)[0]!.mountId).toMatch(/^external:codex:[0-9a-f]{16}:shared$/);
      // the table Murage wrote over (agents) is not external
      expect(first.mcpMounts!.filter((r) => r.engineName === "agents")).toEqual([{ engineName: "agents", mountId: "own:agents", provenance: "own" }]);
      // the same table in two Codex homes is two identities
      expect(externals(second)[0]!.mountId).not.toBe(externals(first)[0]!.mountId);
      expect(resolved(first)).toMatchObject({ kind: "mcp", provenance: "external", own: false });
    });

    it("states no mount list when the config.toml cannot be read, so the MCP ask is unproven (T74)", async () => {
      const codexHome = join(scratch, "broken-home");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), "[mcp_servers.broken\ncommand = ");
      mcpAsk("agents", { tool_name: "list_bots", tool_params: {} });
      await create({ mode: "approval", environment: { CODEX_HOME: codexHome } });
      const opened = await ask("t-broken", { agents: agentsMount });
      expect(opened.toolEngine).toBe("codex");
      expect(opened.mcpMounts).toBeUndefined();
      expect(resolved(opened)).toMatchObject({ kind: "unproven" });
    });
  });

  it("a user Stop settles the turn as cancelled with no runtime error (STOP1)", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-codex-user-stop", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-codex-user-stop");
    const done = await recorder.until((e) => e.type === "turn.completed");
    // the same terminal state the ACP and Pi drivers report for a Stop
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("a Stop still settles as cancelled when Codex reports a clean end after it (STOP1 race)", async () => {
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-codex-stop-race", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    // Hold the kill: the app-server stays alive, gets the Stop's deny of its open ask and answers with a clean
    // turn/completed, which therefore always reaches the driver after the Stop (the order that failed 3-4 of 5 runs).
    const held: ChildProcess[] = [];
    const kill = vi.spyOn(procs, "killCliTree").mockImplementation((child) => { held.push(child); });
    const confirm = vi.spyOn(procs, "awaitCliTreeStopped").mockResolvedValue(true);
    try {
      await instance.adapter.interruptTurn("t-codex-stop-race");
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
      expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(held.length).toBeGreaterThan(0);
    } finally {
      kill.mockRestore();
      confirm.mockRestore();
      for (const child of held) { procs.killCliTree(child); await procs.awaitCliTreeStopped(child); }
    }
  });

  it("a reply that finished before the Stop keeps its finished state (STOP1 race)", async () => {
    await create({ mode: "approval" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-codex-done-then-stop", text: "go" });
    const ask: any = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-codex-done-then-stop", String(ask.requestId), { behavior: "allow" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.interruptTurn("t-codex-done-then-stop");
    expect(done).toMatchObject({ turnId, ok: true, stopReason: null });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("reports whether the installed Codex CLI is signed in", async () => {
    await create();
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });

    await instance.dispose();
    recorder.stop();
    await create({ mode: "logged-out" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
    });
  });

  it("also accepts login status from older Codex versions that used stdout", async () => {
    await create({ mode: "logged-in-stdout" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });
  });

  it("marks a Codex 401 as setup so the UI offers sign-in instead of Retry", async () => {
    await create({ mode: "unauthorized" });
    await instance.adapter.sendTurn({ threadId: "t-unauthorized", text: "hi" });

    const error = await recorder.until((event) => event.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });

  it("auto-retries a transient turn/start failure, then completes with one final message", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-retry", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    // exactly one settled reply across all three app-server launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("does not relaunch a provider safety rejection wrapped in 429", async () => {
    await create({ mode: "safety-rejection" });
    process.env.FAKE_CODEX_DUMP = join(scratch, "safety-calls.json");
    await instance.adapter.sendTurn({ threadId: "safety-rejection", text: "synthetic request" });
    await recorder.until(e => e.type === "turn.completed");
    expect(recorder.events.filter(e => e.type === "turn.completed")).toMatchObject([{ ok: false }]);
    expect(recorder.events.filter(e => e.type === "turn.retrying")).toEqual([]);
    expect(recorder.events.filter(e => e.type === "runtime.error")).toHaveLength(1);
    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_DUMP, "utf8"));
    expect(seen.calls.filter((c: { method: string }) => c.method === "turn/start")).toHaveLength(1);
  });

  it("stops retrying at the attempt cap and settles as failed", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-cap");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-cap", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
  }, 20_000);

  it("interrupting one thread does not cancel another thread's retry", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-concurrent");
    await create();

    const first = instance.adapter.sendTurn({ threadId: "t-codex-stop", text: "stop me" });
    const second = instance.adapter.sendTurn({ threadId: "t-codex-continue", text: "keep going" });
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-stop");
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-continue");
    await instance.adapter.interruptTurn("t-codex-stop");

    await expect(
      recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-codex-continue"),
    ).resolves.toMatchObject({ ok: true });
    // a Stop during the backoff is a user cancellation, not a failure (STOP1)
    await expect(
      recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-codex-stop"),
    ).resolves.toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter((e) => e.type === "runtime.error" && e.threadId === "t-codex-stop")).toEqual([]);
    await Promise.allSettled([first, second]);
  }, 20_000);

  // U06 (upstream 1198): Stop wakes the retry backoff. A 60x scale makes the
  // first backoff 45s or more, so settling well inside 5s proves the wait was
  // interrupted rather than served out.
  it("a Stop during the retry backoff settles at once as cancelled, without a relaunch", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-cancel-backoff");
    process.env.FAKE_CODEX_RETRY_SCALE = "60";
    await create();
    const threadId = "t-codex-cancel-backoff";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((e) => e.type === "turn.retrying");
    const stoppedAt = Date.now();
    await instance.adapter.interruptTurn(threadId);
    await instance.adapter.interruptTurn(threadId);

    const done = await recorder.until((e) => e.type === "turn.completed", 5_000);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled", turnId });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(readFileSync(join(scratch, "codex-launches-cancel-backoff"), "utf8")).toBe("1");
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  }, 20_000);

  // U06 (upstream 1222 Stop fence): the fixture answers turn/start with a
  // transient error only once it receives the driver's SIGTERM, so the
  // failure deterministically arrives after Stop was requested.
  it.skipIf(process.platform === "win32")("a handshake failure caused by Stop never announces a retry", async () => {
    const marker = join(scratch, "codex-stop-race");
    process.env.FAKE_CODEX_STOP_RACE = marker;
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    const threadId = "t-codex-stop-race";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((e) => e.type === "session.started");
    // the fixture holds turn/start: the handshake phase is reached
    for (let i = 0; i < 1_000 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(existsSync(marker)).toBe(true);
    await instance.adapter.interruptTurn(threadId);

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled", turnId });
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe("turn/start\n");
  }, 20_000);

  // U07 (upstream 1220 + 1222): honest exit reports and close-path recovery.
  describe("app-server exits", () => {
    const launches = () => readFileSync(process.env.FAKE_CODEX_STATE!, "utf8");
    const errorsOf = () => recorder.events.filter((e) => e.type === "runtime.error").map((e) => e.message);

    /** Watches each spawned app-server's pipes from inside the spawn, so a
     * listener runs in the same dispatch as the driver's own handler. */
    const watchSpawns = (watch: (child: ReturnType<typeof procs.spawnCli>) => void) => {
      const realSpawnCli = procs.spawnCli;
      return vi.spyOn(procs, "spawnCli").mockImplementation((...args: Parameters<typeof procs.spawnCli>) => {
        const child = realSpawnCli(...args);
        watch(child);
        return child;
      });
    };

    it("recovers a transient crash before turn/start was ever sent", async () => {
      process.env.FAKE_CODEX_LAUNCH_CRASHES = "1";
      process.env.FAKE_CODEX_STATE = join(scratch, "launch-crash");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-codex-launch-crash", text: "hi" });

      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true, turnId });
      expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1]);
      expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(errorsOf()).toEqual([]);
      expect(launches()).toBe("2");
    }, 20_000);

    it.skipIf(process.platform === "win32")("treats a signal-killed launch as terminal even with transient stderr", async () => {
      process.env.FAKE_CODEX_LAUNCH_KILLS = "1";
      process.env.FAKE_CODEX_STATE = join(scratch, "launch-kill");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      await create();
      await instance.adapter.sendTurn({ threadId: "t-codex-launch-kill", text: "hi" });

      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(errorsOf()).toHaveLength(1);
      expect(errorsOf()[0]).toContain("(signal SIGKILL)");
      expect(errorsOf()[0]).not.toContain("exit code null");
      expect(errorsOf()[0]).toContain("connection reset by peer");
      expect(launches()).toBe("1");
    }, 20_000);

    it("never retries a silent exit off stale stderr from before later protocol output", async () => {
      process.env.FAKE_CODEX_STATE = join(scratch, "launch-silent");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      await create();
      const gate = join(scratch, "stale-stderr-gate");
      // set after create(): the catalog spawn must not hold its initialize
      process.env.FAKE_CODEX_LAUNCH_SILENT = "1";
      process.env.FAKE_CODEX_STALE_STDERR_GATE = gate;
      const spawnSpy = watchSpawns((child) => {
        child.stderr.on("data", (c: Buffer) => {
          if (c.toString().includes("connection reset")) writeFileSync(gate, "");
        });
      });
      try {
        await instance.adapter.sendTurn({ threadId: "t-codex-launch-silent", text: "hi" });
        const done = await recorder.until((e) => e.type === "turn.completed");
        expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
        expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
        expect(errorsOf()).toEqual(["Codex Test closed (exit code 1) before it finished its reply"]);
        expect(existsSync(gate)).toBe(true);
        expect(launches()).toBe("1");
      } finally {
        spawnSpy.mockRestore();
      }
    }, 20_000);

    it.each(["plain", "buffered"])("never replays a crash after turn/start was written (%s)", async (variant) => {
      process.env.FAKE_CODEX_PREACK_CRASH = variant;
      process.env.FAKE_CODEX_STATE = join(scratch, `preack-${variant}`);
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      await create();
      await instance.adapter.sendTurn({ threadId: `t-codex-preack-${variant}`, text: "hi" });

      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
      expect(errorsOf()).toHaveLength(1);
      expect(errorsOf()[0]).toContain("connection reset by peer");
      expect(launches()).toBe("1");
    }, 20_000);

    it("never replays a turn after its acknowledgement, quoting the crash's own stderr", async () => {
      const gate = join(scratch, "ack-crash-gate");
      process.env.FAKE_CODEX_ACK_CRASH = gate;
      process.env.FAKE_CODEX_STATE = join(scratch, "ack-crash");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      const spawnSpy = watchSpawns((child) => {
        let seen = "";
        child.stdout.on("data", (c: Buffer) => {
          seen += c.toString();
          if (seen.includes(`"result":{"turn":{"id":"turn-1"`)) writeFileSync(gate, "");
        });
      });
      try {
        await create();
        await instance.adapter.sendTurn({ threadId: "t-codex-ack-crash", text: "hi" });
        const done = await recorder.until((e) => e.type === "turn.completed");
        expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
        expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
        expect(errorsOf()).toEqual(["Codex Test closed (exit code 1) before it finished its reply: Error: connection reset by peer"]);
        expect(launches()).toBe("1");
      } finally {
        spawnSpy.mockRestore();
      }
    }, 20_000);

    it("does not blame stale stderr when the app-server is killed mid-turn", async () => {
      const stderrGate = join(scratch, "mid-turn-stderr-gate");
      const killGate = join(scratch, "mid-turn-kill-gate");
      process.env.FAKE_CODEX_EXIT_MID_TURN = stderrGate;
      process.env.FAKE_CODEX_EXIT_MID_TURN_KILL = killGate;
      process.env.FAKE_CODEX_STATE = join(scratch, "mid-turn");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      const spawnSpy = watchSpawns((child) => {
        child.stderr.on("data", (c: Buffer) => {
          if (c.toString().includes("426")) writeFileSync(stderrGate, "");
        });
      });
      try {
        await create();
        await instance.adapter.sendTurn({ threadId: "t-codex-exit-mid-turn", text: "hi" });
        await recorder.until((e) => e.type === "content.delta" && e.streamKind === "reasoning_text");
        writeFileSync(killGate, "");
        const done = await recorder.until((e) => e.type === "turn.completed");
        expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
        expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
        // win32 has no signals: the kill lands as TerminateProcess, exit 1
        // Stale stderr from before the last protocol output is not quoted, and
        // the line names no protocol step.
        const wording = process.platform === "win32" ? "Codex Test closed (exit code 1) before it finished its reply" : "Codex Test closed (signal SIGKILL) before it finished its reply";
        expect(errorsOf()).toEqual([wording]);
        expect(errorsOf()[0]).not.toContain("426");
        expect(launches()).toBe("1");
      } finally {
        spawnSpy.mockRestore();
      }
    }, 20_000);

    it("a Stop during a crash recovery backoff settles at once as cancelled", async () => {
      process.env.FAKE_CODEX_LAUNCH_CRASHES = "9";
      process.env.FAKE_CODEX_STATE = join(scratch, "launch-crash-stop");
      process.env.FAKE_CODEX_RETRY_SCALE = "60";
      await create();
      const threadId = "t-codex-crash-stop";
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi" });
      await recorder.until((e) => e.type === "turn.retrying");
      const stoppedAt = Date.now();
      await instance.adapter.interruptTurn(threadId);

      const done = await recorder.until((e) => e.type === "turn.completed", 5_000);
      expect(Date.now() - stoppedAt).toBeLessThan(5_000);
      expect(done).toMatchObject({ ok: true, stopReason: "cancelled", turnId });
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
      expect(errorsOf()).toEqual([]);
      expect(launches()).toBe("1");
    }, 20_000);

    it("does not relaunch after a crash until the old process group is confirmed gone", async () => {
      process.env.FAKE_CODEX_LAUNCH_CRASHES = "9";
      process.env.FAKE_CODEX_STATE = join(scratch, "launch-crash-unconfirmed");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      await create();
      const threadId = "t-codex-crash-unconfirmed";
      const confirm = vi.spyOn(procs, "awaitCliTreeStopped").mockResolvedValue(false);
      try {
        await instance.adapter.sendTurn({ threadId, text: "hi" });
        await recorder.until((e) => e.type === "runtime.error" && e.message === "Codex Test did not close after Stop. This conversation stays busy until it does; restart Murage if it stays stuck.");
        expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
        expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
        expect(instance.adapter.hasSession(threadId)).toBe(true);
        expect(launches()).toBe("1");
      } finally {
        confirm.mockRestore();
      }
      await instance.adapter.interruptTurn(threadId);
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: false, stopReason: "shutdown_timeout" });
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(launches()).toBe("1");
    }, 20_000);
  });

  // F4 design (lanes/release104/designs/F4.md) section 2a, G03-2: a turn/start that may have reached the engine is never sent again.
  describe("F4: one turn is sent once", () => {
    const callLog = () => join(scratch, "f4-calls.log");
    const turnStarts = () => (existsSync(callLog()) ? readFileSync(callLog(), "utf8").split("\n").filter((l) => l.endsWith(" turn/start")).length : 0);
    const errorsOf = () => recorder.events.filter((e) => e.type === "runtime.error").map((e) => (e as { message: string }).message);
    beforeEach(() => {
      process.env.FAKE_CODEX_CALL_LOG = callLog();
      process.env.FAKE_CODEX_STATE = join(scratch, "f4-launches");
      process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
      process.env.MURAGE_CODEX_RPC_TIMEOUT_MS = "400";
    });
    afterEach(() => {
      for (const name of ["FAKE_CODEX_CALL_LOG", "FAKE_CODEX_TURNSTART_SILENT", "FAKE_CODEX_TURNSTART_LATE", "MURAGE_CODEX_RPC_TIMEOUT_MS"]) delete process.env[name];
    });

    it.each([["F1", "buffered"], ["F2", "plain"]])("%s: turn/start never answered (%s) => written once, no relaunch, settles failed on the timeout, process closed", async (_id, knob) => {
      process.env.FAKE_CODEX_TURNSTART_SILENT = knob;
      const dump = join(scratch, `f4-silent-${knob}.json`);
      process.env.FAKE_CODEX_DUMP = dump;
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: `t-f4-silent-${knob}`, text: "hi" });
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
      expect(turnStarts()).toBe(1);
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(errorsOf()).toHaveLength(1);
      expect(errorsOf()[0]).toContain("timed out while starting the turn");
      const pid = JSON.parse(readFileSync(dump, "utf8")).pid as number;
      const end = Date.now() + 5_000;
      const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
      while (!gone() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(gone()).toBe(true);
    }, 20_000);

    it("F3: an error answer to turn/start after a buffered notification => no relaunch", async () => {
      process.env.FAKE_CODEX_TURNSTART_SILENT = "notify-error";
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-f4-notify-error", text: "hi" });
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: false });
      expect(turnStarts()).toBe(1);
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    }, 20_000);

    it("F5 (GUARD): Stop during the unanswered turn/start on an ungated process => cancelled once, no relaunch", async () => {
      process.env.FAKE_CODEX_TURNSTART_SILENT = "plain";
      process.env.MURAGE_CODEX_RPC_TIMEOUT_MS = "10000";
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-f4-stop", text: "hi" });
      const end = Date.now() + 5_000;
      while (turnStarts() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await instance.adapter.interruptTurn("t-f4-stop");
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
      await new Promise((r) => setTimeout(r, 300));
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(turnStarts()).toBe(1);
    }, 20_000);

    it("F6: the ACK and a turn notification arrive after the timer fired, while the process holds its shutdown => one turn/start, no relaunch, one completion", async () => {
      process.env.FAKE_CODEX_TURNSTART_LATE = "1";
      await create();
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-f4-late", text: "hi" });
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(done).toMatchObject({ ok: false });
      await new Promise((r) => setTimeout(r, 500));
      expect(turnStarts()).toBe(1);
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    }, 30_000);
  });

  // F4 design section 2b, 03-2: the selected model rides every turn/start and every resume, and a resumed thread must prove it.
  describe("F4: the chosen model answers", () => {
    const callsOf = (dump: string, method: string) => JSON.parse(readFileSync(dump, "utf8")).calls.filter((c: { method: string }) => c.method === method).map((c: { params: any }) => c.params);

    it("F9: turn/start carries the selected model", async () => {
      await create();
      const dump = join(scratch, "f4-model.json");
      process.env.FAKE_CODEX_DUMP = dump;
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-f4-model", text: "hi", model: "gpt-f4-chosen" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      expect(callsOf(dump, "turn/start")[0]).toMatchObject({ model: "gpt-f4-chosen" });
    });

    it("F10: a Flux resume names and verifies the Flux table; a named connection's resume names and verifies its provider", async () => {
      process.env.FLUX_API_KEY = "sk-flux-test-key";
      try {
        await create({ mode: "resume" });
        const dump = join(scratch, "f4-flux.json");
        process.env.FAKE_CODEX_DUMP = dump;
        const flux = await instance.adapter.sendTurn({ threadId: "t-f4-flux", text: "hi", model: "flux::flux-auto", resumeCursor: "thread-flux", warmIdentity: { botId: "b", audience: "owner", decidedOwner: true } });
        await recorder.until((e) => e.type === "turn.completed" && e.turnId === flux.turnId);
        expect(callsOf(dump, "thread/resume")[0]).toMatchObject({ threadId: "thread-flux", model: "flux-auto", modelProvider: "flux" });
        expect(callsOf(dump, "thread/start")).toHaveLength(0);
      } finally {
        delete process.env.FLUX_API_KEY;
      }
      const dump2 = join(scratch, "f4-route.json");
      process.env.FAKE_CODEX_DUMP = dump2;
      const routed = await instance.adapter.sendTurn({ threadId: "t-f4-route", text: "hi", resumeCursor: "thread-route",
        providerRoute: { connectionId: "fixture-provider", revision: "fixture-revision", preset: "openai", protocol: "responses", baseUrl: "https://provider.example/v1", apiKey: "fixture-only-not-real", model: "routed-model" } } as never);
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === routed.turnId);
      const resume = callsOf(dump2, "thread/resume")[0];
      expect(resume).toMatchObject({ threadId: "thread-route", model: "routed-model" });
      expect(resume.modelProvider).toMatch(/^murage_[0-9a-f]{16}$/);
      expect(callsOf(dump2, "thread/start")).toHaveLength(0);
    });
  });

  it("never retries after agent text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_PARTIAL_FAILS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-partial");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-partial", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);


  it("uses the device-code login, which needs no free port on the machine", () => {
    // Probed 2026-09-20 on macOS, Ubuntu 24.04 and Windows Server 2025 with
    // plain pipes: plain `codex login` binds 127.0.0.1:1455 and prints no
    // code, so it fails wherever that port is taken or no browser can reach
    // this machine. `--device-auth` opens NO listener and prints a URL and a
    // short code, which is what an in-app card can show.
    expect(CodexDriver.install?.signInCommand).toBe("codex login --device-auth");
    expect(CodexDriver.install?.signInCommand).not.toBe("codex login");
  });

  it("declares the effort levels the app-server accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("sends effort on turn/start, and omits the key when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.effort).toBe("xhigh");
  });

  // Before 0.1.55 an attached image reached codex only as an
  // <attached-image path> tag in the text, which the model had to open with
  // its own read tool. turn/start takes the app-server's ImageUserInput
  // {type:"image", url} — the bytes ride a data: URL.
  it("puts an attached image into turn/start as a data-URL image item", async () => {
    await create();
    const dump = join(scratch, "image.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";

    await instance.adapter.sendTurn({ threadId: "t-image", text: "what is this", images: [{ mimeType: "image/png", data }] });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.input).toEqual([
      { type: "text", text: `${TURN_ASK_RULES}\n\nwhat is this` },
      { type: "image", url: `data:image/png;base64,${data}` },
    ]);
    expect(instance.adapter.capabilities.imagesInline).toBe(true);
  });

  it("sends only the text item when the turn carries no image", async () => {
    await create();
    const dump = join(scratch, "no-image.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-image", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.input).toEqual([{ type: "text", text: `${TURN_ASK_RULES}\n\nhi` }]);
  });

  it("sends no effort key when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params).not.toHaveProperty("effort");
  });
});

// A4: app-server stdout is framed with a byte bound before any parse.
describe("CodexDriver bounded ingress (A4)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-bounded",
      displayName: "Codex Bounded",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  /** No event on the thread may carry the dropped frame's content. */
  const noLargePayload = (threadId: string) =>
    recorder.events.filter((e) => e.threadId === threadId).every((e) => JSON.stringify(e).length < 1024 * 1024);

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("fails only the turn whose frame is over the limit, even when turn/completed follows it", async () => {
    await create();
    const oversized = await instance.adapter.sendTurn({ threadId: "t-oversize", text: "__fixture_oversize_frame__" });
    const ordinary = await instance.adapter.sendTurn({ threadId: "t-ordinary", text: "hello" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === oversized.turnId);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === ordinary.turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error",
      threadId: "t-oversize",
      message: expect.stringMatching(/^Codex sent a protocol message larger than 32 MiB/),
    }));
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", itemType: "assistant_text", threadId: "t-ordinary", text: "done from fake codex",
    }));
    expect(noLargePayload("t-oversize")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  });

  it("fails an unterminated oversized frame without waiting for a newline", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-open", text: "__fixture_oversize_open_frame__" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(noLargePayload("t-open")).toBe(true);
  });

  // `imageGeneration` was the only raster this driver kept; an MCP tool's own
  // image was read for its ok flag and dropped.
  it("surfaces an MCP tool's image and withholds the computer surface's frame", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-mcp-image", text: "__fixture_mcp_tool_image__" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const images = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      threadId: "t-mcp-image",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      alt: "omarchy__screenshot",
    });
  });

  it("still carries a generated image at the 10 MiB image cap", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-large", text: "__fixture_large_frame__" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true });
    const image = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_image" && e.itemId === "img-large");
    expect((image as { data: string } | undefined)?.data).toHaveLength(4 * Math.ceil((10 * 1024 * 1024) / 3));
  });
});

// Rules 67 and 68 on the fake app-server: the PreToolUse gate, the per-version policy, the tripwire. The fake runs the hook script
// from hooks.json in the scoped CODEX_HOME for every tool call, the way Codex does (server/testing/fake-codex-app-server.ts).
describe("Codex PreToolUse gate (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let ownerHome: string;
  const AGENTS = { command: process.execPath, args: ["-e", ""], env: {} };

  const create = async (version = "codex-cli 0.150.0", opts: { fullAuto?: boolean; codexHome?: string } = {}) => {
    resetIsolationCache();
    process.env.FAKE_CODEX_VERSION = version;
    instance = await CodexDriver.create({
      instanceId: "codex-gate", displayName: "Codex Test", environment: { CODEX_HOME: opts.codexHome ?? ownerHome }, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };
  const recreate = async (version?: string, opts?: { fullAuto?: boolean }) => {
    recorder?.stop();
    await instance?.dispose();
    await create(version, opts);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-codex-gate-")));
    ownerHome = join(scratch, "owner-home");
    mkdirSync(ownerHome, { recursive: true });
    writeFileSync(join(ownerHome, "config.toml"), [
      'model = "gpt-owner"', "[hooks]", 'owner = "hook"', "[hooks.state]", '"/x/hooks.json:pre_tool_use:0:0" = { trusted_hash = "sha256:aa" }',
      "[mcp_servers.owner_files]", 'command = "files"', "",
    ].join("\n"));
  });

  afterEach(async () => {
    for (const name of ["FAKE_CODEX_MODE", "FAKE_CODEX_VERSION", "FAKE_CODEX_TOOLS", "FAKE_CODEX_HOOKS", "FAKE_CODEX_DUMP", "FAKE_CODEX_CALL_LOG", "FAKE_CODEX_SPAWN_LOG",
      "FAKE_CODEX_ESCALATION", "MURAGE_CODEX_HOOK_LIVENESS_MS", "FAKE_CODEX_SESSION_DELAY_MS", "FAKE_CODEX_SESSION_LOG", "FAKE_CODEX_INTERRUPT_DELAY_MS",
      "FAKE_CODEX_EARLY_ITEM", "FAKE_CODEX_HOOKS_DELAY_MS", "FAKE_CODEX_HOOKS_DELAY_COUNT", "MURAGE_CODEX_HOOKS_LIST_MS", "FAKE_CODEX_RETRY_SCALE"]) delete process.env[name];
    setCodexFloorsForTests();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  /** One turn that makes the given tool calls; every ask is answered by `decide` (null leaves it pending). */
  const run = async (threadId: string, tools: unknown[], decide: (e: any, n: number) => any = () => ({ behavior: "allow" }), turn: Record<string, unknown> = {}) => {
    process.env.FAKE_CODEX_TOOLS = JSON.stringify(tools);
    const dumpPath = join(scratch, `dump-${threadId}.json`);
    process.env.FAKE_CODEX_DUMP = dumpPath;
    const sent = await instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch, integrations: { agents: AGENTS }, ...turn } as never);
    const answered = new Set<string>();
    const opened: any[] = [];
    for (;;) {
      const e: any = await recorder.until((ev: any) => ev.turnId === sent.turnId && ((ev.type === "request.opened" && !answered.has(ev.requestId)) || ev.type === "turn.completed"));
      if (e.type === "turn.completed") return { sent, done: e, opened, dump: (): any => JSON.parse(readFileSync(dumpPath, "utf8")) };
      answered.add(e.requestId);
      opened.push(e);
      const decision = decide(e, opened.length - 1);
      if (decision) await instance.adapter.respondToRequest(threadId, e.requestId, decision);
    }
  };
  const calls = (dump: any): string[] => dump.calls.map((c: { method: string }) => c.method);
  const retired = ["un", "trusted"].join("");

  // Section (d) of APP-GRANT-FIXPLAN-r6 (Rules 74a, 74d): each command card's environment is checked when the card opens,
  // in the generation it opens in; an approved startup-file write between two asks makes the second check again
  it("checks each command ask in the environment generation its card opens in", async () => {
    await create();
    resetExecChecks();
    const runsAtOpen: number[] = [];
    const r = await run("t-gen-codex", [
      { kind: "shell", id: "g1", command: "ls", cwd: scratch },
      { kind: "shell", id: "g2", command: "pwd", cwd: scratch },
    ], (_e, n) => {
      runsAtOpen.push(execChecks.runs);
      if (n === 0) expect(approveStartupWrite()).toBe(true);
      return { behavior: "allow" };
    });
    expect(r.opened.map((e) => e.tool)).toEqual(["shell", "shell"]);
    expect(runsAtOpen).toEqual([1, 2]);
    expect(r.opened[1].execEnv).toMatchObject({ cwd: scratch, env: { PAGER: "cat" } });
  });

  it("never reports a check whose environment generation changed while it was awaiting", async () => {
    await create();
    resetExecChecks();
    const held = gate();
    execChecks.hold = held.promise;
    execChecks.onRun = (n) => {
      if (n === 1) setTimeout(() => { approveStartupWrite(); execChecks.hold = null; held.open(); }, 50);
    };
    const runsAtOpen: number[] = [];
    const r = await run("t-gen-codex-race", [{ kind: "shell", id: "r1", command: "ls", cwd: scratch }], () => {
      runsAtOpen.push(execChecks.runs);
      return { behavior: "allow" };
    });
    expect(runsAtOpen).toEqual([2]);
    expect(r.opened[0].execEnv).toMatchObject({ cwd: scratch, env: { PAGER: "cat" } });
  });

  // The fake of item 5: it asks only what the real app-server asks under the policy it was given.
  it("asks nothing for an ordinary command under on-request and everything under the retired policy", async () => {
    process.env.FAKE_CODEX_ESCALATION = "0";
    process.env.FAKE_CODEX_MODE = "approval";
    await create("codex-cli 0.147.0");
    const quiet = await instance.adapter.sendTurn({ threadId: "t-quiet", text: "go", cwd: scratch });
    const done = await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === quiet.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e: any) => e.type === "request.opened" && e.turnId === quiet.turnId)).toBe(false);
    const asked = await instance.adapter.sendTurn({ threadId: "t-asked", text: "go", cwd: scratch, stopLine: true });
    const opened: any = await recorder.until((e: any) => e.type === "request.opened" && e.turnId === asked.turnId);
    expect(opened).toMatchObject({ tool: "shell", toolEngine: "codex" });
    await instance.adapter.respondToRequest("t-asked", opened.requestId, { behavior: "deny" });
    await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === asked.turnId);
  });

  // Real codex 0.163 raised a second card (mcpServer/elicitation/request, codex_approval_kind mcp_tool_call) for Murage's own
  // `computer` mount behind the hook's card. Gated turns mount Murage's own servers with "approve"; legacy keeps "auto"; custom stays unquieted.
  it("mounts Murage's own servers with approve behind the hook gate so codex raises no second card", async () => {
    const own = { command: process.execPath, args: ["-e", ""], env: {} };
    for (const [version, gated] of [["codex-cli 0.147.0", false], ["codex-cli 0.163.0", true]] as const) {
      await recreate(version);
      const r = await run(`t-appr-${version}`, [], () => null, { integrations: { agents: AGENTS, localComputer: own } });
      const argv = r.dump().argv.join(" ");
      expect(argv.includes('mcp_servers.computer.default_tools_approval_mode="approve"')).toBe(gated);
      expect(argv.includes('mcp_servers.computer.default_tools_approval_mode="auto"')).toBe(!gated);
      expect(argv).not.toContain("mcp_servers.notes.default_tools_approval_mode");
    }
  });

  // T91
  it("keeps the retired policy below the version that refuses it and gates from there", async () => {
    for (const [version, gated] of [["codex-cli 0.147.0", false], ["codex-cli 0.148.0", false], ["codex-cli 0.149.0", true], ["codex-cli 0.163.0", true]] as const) {
      await recreate(version);
      const r = await run(`t-pol-${version}`, [], () => null, { stopLine: true });
      expect(r.done).toMatchObject({ ok: true });
      const dump = r.dump();
      const start = dump.calls.find((c: any) => c.method === "thread/start").params;
      const prompt = dump.calls.find((c: any) => c.method === "turn/start").params;
      expect(start.approvalPolicy).toBe(gated ? "on-request" : retired);
      expect(prompt.approvalPolicy).toBe(gated ? "on-request" : retired);
      expect(dump.argv.join(" ").includes('approval_policy="on-request"')).toBe(gated);
      expect(dump.argv.join(" ").includes("features.hooks=true")).toBe(gated);
      expect(calls(dump).includes("hooks/list")).toBe(gated);
      expect(existsSync(join(dump.env.CODEX_HOME, "hooks.json"))).toBe(gated);
      if (gated) expect(JSON.stringify({ argv: dump.argv, calls: dump.calls })).not.toContain(retired);
    }
    // the owner's No limits keeps never below the retirement and runs on-request behind the gate from it
    await recreate("codex-cli 0.147.0", { fullAuto: true });
    expect((await run("t-pol-full-old", [], () => null)).dump().calls.find((c: any) => c.method === "thread/start").params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    await recreate("codex-cli 0.150.0", { fullAuto: true });
    expect((await run("t-pol-full-new", [], () => null)).dump().calls.find((c: any) => c.method === "thread/start").params).toMatchObject({ approvalPolicy: "on-request", sandbox: "danger-full-access" });
  });

  it("refuses a retired build that cannot carry the gate before any process starts", async () => {
    setCodexFloorsForTests({ retired: [0, 100, 0], gate: [0, 129, 0] });
    await recreate("codex-cli 0.110.0");
    // set after create: the model catalog starts its own app-server at create
    const spawnLog = join(scratch, "spawns.log");
    process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
    const r = await run("t-below-gate", [], () => null);
    expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ localFailure: "engine-update-required" });
    expect(existsSync(spawnLog)).toBe(false);
  });

  it("refuses the turn before turn/start when hooks/list is missing or the trust does not take", async () => {
    const log = join(scratch, "calls.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    // B13: a reported current version without hooks/list is never "older than" (an unreadable version is refused before the spawn)
    for (const [mode, version, failure] of [["none", "codex-cli 0.164.0", "engine-folder-unavailable"], ["untrusted-stays", undefined, "engine-folder-unavailable"]] as const) {
      process.env.FAKE_CODEX_HOOKS = mode;
      writeFileSync(log, "");
      await recreate(version);
      const r = await run(`t-refuse-${mode}-${version}`, [], () => null);
      expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
      const error = recorder.events.find((e) => e.type === "runtime.error") as any;
      expect(error).toMatchObject({ localFailure: failure });
      expect(String(error.message)).not.toContain("older than");
      const methods = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[1]);
      expect(methods).toContain("hooks/list");
      expect(methods).not.toContain("thread/start");
      expect(methods).not.toContain("turn/start");
    }
  });

  // B13 (REHEARSAL-2, Windows, Codex 0.164.0): hooks/list answered past its 15 s bound and the owner was told their Codex was older
  // than 0.129.0. A slow answer is waited for once more, longer, and never read as a version. (The bound is scaled through
  // MURAGE_CODEX_HOOKS_LIST_MS; without the fix the 15 s bound runs out first and the turn is refused as engine-update-required.)
  it("B13: a current Codex that answers hooks/list slowly runs the turn and is never told to update", async () => {
    process.env.MURAGE_CODEX_HOOKS_LIST_MS = "300";
    process.env.FAKE_CODEX_HOOKS_DELAY_MS = "16000";
    process.env.FAKE_CODEX_HOOKS_DELAY_COUNT = "1";
    const log = join(scratch, "calls-b13.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await recreate("codex-cli 0.164.0");
    const r = await run("t-b13-slow-once", [], () => null);
    expect(recorder.events.some((e: any) => e.localFailure === "engine-update-required")).toBe(false);
    expect(r.done).toMatchObject({ ok: true });
    // Fable r1 High: the wait explains itself. The line opens when the first bound runs out and closes when the list arrives,
    // before anything of the turn itself.
    const mine = recorder.events.filter((e: any) => e.turnId === r.sent.turnId) as any[];
    const opened = mine.findIndex((e) => e.type === "item.started" && String(e.itemId).startsWith("hooks-"));
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(mine[opened]).toMatchObject({ origin: "murage", itemType: "tool", title: expect.stringContaining("Codex Test is taking a moment to get ready") });
    // Astra r2 High: the line reaches the mascot's working line too (Tool calls off hides the chip)
    expect(mine[opened].spoken).toBe(mine[opened].title);
    expect(String(mine[opened].title)).not.toMatch(/\u2014|\bsafe|unsafe|safety/i);
    const closed = mine.findIndex((e) => e.type === "item.completed" && e.itemId === mine[opened].itemId);
    expect(closed).toBeGreaterThan(opened);
    expect(mine[closed]).toMatchObject({ ok: true });
    const firstOther = mine.findIndex((e) => e.type === "item.started" && !String(e.itemId).startsWith("hooks-") && !String(e.itemId).startsWith("wake-"));
    if (firstOther >= 0) expect(firstOther).toBeGreaterThan(closed);
    const methods = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[1]);
    expect(methods.filter((m) => m === "hooks/list").length).toBeGreaterThanOrEqual(2);
    expect(methods).toContain("turn/start");
  }, 40_000);

  it("B13: a current Codex that never answers hooks/list in time is retried as a slow start, refused without the gate, never told to update", async () => {
    process.env.MURAGE_CODEX_HOOKS_LIST_MS = "200";
    process.env.FAKE_CODEX_HOOKS_DELAY_MS = "20000";
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    const log = join(scratch, "calls-b13-dead.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await recreate("codex-cli 0.164.0");
    const r = await run("t-b13-slow-always", [], () => null);
    expect(r.done).toMatchObject({ ok: false });
    expect(recorder.events.some((e: any) => e.localFailure === "engine-update-required")).toBe(false);
    // Fable r1 Medium: one relaunch for a slow handshake (two starts, ~2 minutes at real bounds), then a clear line
    expect(recorder.events.filter((e: any) => e.type === "turn.retrying")).toHaveLength(1);
    const errors = recorder.events.filter((e: any) => e.type === "runtime.error");
    expect(errors.at(-1)).toMatchObject({ message: "Codex Test did not get its hooks ready in time, even after a fresh start; try again in a moment." });
    expect(errors.some((e: any) => /older than|Update Codex/i.test(String(e.message)))).toBe(false);
    const methods = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[1]);
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
  }, 40_000);

  it("B13: a Codex really below the floor is still told to update, slow handshake or not", async () => {
    process.env.MURAGE_CODEX_HOOKS_LIST_MS = "200";
    process.env.FAKE_CODEX_HOOKS_DELAY_MS = "20000";
    setCodexFloorsForTests({ retired: [0, 100, 0], gate: [0, 129, 0] });
    await recreate("codex-cli 0.110.0");
    const r = await run("t-b13-old", [], () => null);
    expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ localFailure: "engine-update-required", message: expect.stringContaining("0.110.0 is older than 0.129.0") });
  });

  // 1.0.3 RUN B (Windows): the hook started past 10 s and the turn was refused. On win32 the bound is HOOK_LIVENESS_WIN32_MS (45 s);
  // this runs the driver at a tenth of real time through the bound's own override: a hook starting at 12 s and at 40 s (1.2 s, 4 s)
  // is proven and the turn completes, one that never starts is refused at the bound (4.5 s), not before.
  it("proves a Windows-slow SessionStart inside the wider bound and refuses one that never starts at the bound", async () => {
    const scale = 10;
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(" ")); });
    onTestFinished(() => warn.mockRestore());
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = String(HOOK_LIVENESS_WIN32_MS / scale);
    for (const startsAt of [12_000, 40_000]) {
      process.env.FAKE_CODEX_SESSION_DELAY_MS = String(startsAt / scale);
      await recreate();
      const r = await run(`t-slow-${startsAt}`, [], () => null);
      expect(r.done, `hook at ${startsAt} ms`).toMatchObject({ ok: true });
    }
    delete process.env.FAKE_CODEX_SESSION_DELAY_MS;
    process.env.FAKE_CODEX_HOOKS = "dead";
    await recreate();
    const started = Date.now();
    const dead = await run("t-slow-dead", [], () => null);
    expect(dead.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(HOOK_LIVENESS_WIN32_MS / scale);
    expect(warned.some((line) => line === `codex hook-liveness bound_ms=${HOOK_LIVENESS_WIN32_MS / scale} source=env`)).toBe(true);
  }, 30_000);

  it("interrupts and refuses when the SessionStart handler never posts", async () => {
    process.env.FAKE_CODEX_HOOKS = "dead";
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "400";
    const log = join(scratch, "calls-dead.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await recreate();
    const r = await run("t-dead", [], () => null);
    expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("pre-execution hook did not start") });
    expect(readFileSync(log, "utf8")).toContain("turn/interrupt");
    expect(recorder.events.some((e: any) => e.type === "item.started" && e.origin === "engine")).toBe(false);
  });

  // Astra BLOCK 2: the turn is held until the hook is proven, so a Codex that carries on past a dead hook never ends a turn cleanly
  it("refuses a turn that completes before the SessionStart proof, and stops a call that starts unproven", async () => {
    process.env.FAKE_CODEX_HOOKS = "dead-runs";
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "400";
    await recreate();
    const quiet = await run("t-dead-quiet", [], () => null);
    expect(quiet.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error" && e.turnId === quiet.sent.turnId)).toMatchObject({ message: expect.stringContaining("pre-execution hook did not start") });
    await recreate();
    const busy = await run("t-dead-call", [{ kind: "shell", id: "c-dead", command: "echo hi" }], () => null);
    expect(busy.done).toMatchObject({ ok: false });
    expect(recorder.events.some((e: any) => e.type === "item.started" && e.origin === "engine" && e.turnId === busy.sent.turnId)).toBe(false);
  });

  // r6 (a), Rule 68c: one refusal per turn, one way. A proof that lands after the bound, while the interrupt is still pending, revives
  // nothing: the next delivery is denied, the clean completion settles scope_unavailable, and the process is closed with the turn.
  it("keeps a turn refused when the SessionStart proof lands after the bound while turn/interrupt is pending", async () => {
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "400";
    process.env.FAKE_CODEX_SESSION_DELAY_MS = "450";
    process.env.FAKE_CODEX_INTERRUPT_DELAY_MS = "2000";
    const sessions = join(scratch, "sessions-late.log");
    process.env.FAKE_CODEX_SESSION_LOG = sessions;
    const log = join(scratch, "calls-late.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await recreate();
    const warm = { warmIdentity: { botId: "b-late", audience: "owner" as const } };
    const r = await run("t-late", [{ kind: "shell", id: "a1", command: "ls -la", cwd: scratch }], () => ({ behavior: "allow" }), warm);
    expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(readFileSync(sessions, "utf8")).toContain("SessionStart");
    expect(readFileSync(log, "utf8")).toContain("turn/interrupt");
    expect(r.opened).toEqual([]);
    const firstPid = r.dump().pid;
    expect(r.dump().hookLog.find((h: any) => h.id === "a1")).toMatchObject({ verdict: "deny" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error" && e.turnId === r.sent.turnId)).toMatchObject({ message: expect.stringContaining("pre-execution hook did not start") });
    // the refused process is never kept: the next turn on the thread runs on a new one
    delete process.env.FAKE_CODEX_SESSION_DELAY_MS;
    delete process.env.FAKE_CODEX_INTERRUPT_DELAY_MS;
    const next = await run("t-late", [], () => null, { ...warm, resumeCursor: "codex-thread-1" });
    expect(next.done).toMatchObject({ ok: true });
    expect(next.dump().pid).not.toBe(firstPid);
  });

  it("answers a card still open when the turn is refused with a deny, even when the owner allows it", async () => {
    process.env.FAKE_CODEX_INTERRUPT_DELAY_MS = "2500";
    await recreate();
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([
      { kind: "shell", id: "p1", command: "ls -la", cwd: scratch, concurrent: true },
      { kind: "shell", id: "p2", command: "cat /etc/hostname", cwd: scratch, hook: false, delayMs: 1200 },
    ]);
    const dumpPath = join(scratch, "dump-t-pending.json");
    process.env.FAKE_CODEX_DUMP = dumpPath;
    const sent = await instance.adapter.sendTurn({ threadId: "t-pending", text: "go", cwd: scratch, integrations: { agents: AGENTS } } as never);
    const card: any = await recorder.until((e: any) => e.turnId === sent.turnId && e.type === "request.opened");
    expect(card).toMatchObject({ tool: "shell" });
    await recorder.until((e: any) => e.turnId === sent.turnId && e.type === "runtime.error");
    await instance.adapter.respondToRequest("t-pending", card.requestId, { behavior: "allow" } as never);
    const resolved: any = await recorder.until((e: any) => e.type === "request.resolved" && e.requestId === card.requestId);
    expect(resolved.behavior).toBe("deny");
    const done: any = await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "gate_incident" });
    expect(JSON.parse(readFileSync(dumpPath, "utf8")).hookLog.find((h: any) => h.id === "p1")).toMatchObject({ verdict: "deny" });
  });

  it("says the turn stopped as soon as it started when an item started before the refusal, and before it ran anything otherwise", async () => {
    process.env.FAKE_CODEX_HOOKS = "dead";
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "400";
    await recreate();
    const quiet = await run("t-line-quiet", [], () => null);
    expect(quiet.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error" && e.turnId === quiet.sent.turnId))
      .toMatchObject({ message: "Codex Test's pre-execution hook did not start, so this turn was stopped before it ran anything." });
    process.env.FAKE_CODEX_EARLY_ITEM = "1";
    await recreate();
    const begun = await run("t-line-begun", [], () => null);
    expect(begun.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error" && e.turnId === begun.sent.turnId))
      .toMatchObject({ message: "Codex Test's pre-execution hook did not start, so this turn was stopped as soon as it started." });
  });

  it("carries the proof on a kept process, and after an incident the next turn waits for a fresh SessionStart", async () => {
    const sessions = join(scratch, "sessions-void.log");
    process.env.FAKE_CODEX_SESSION_LOG = sessions;
    const waits = () => readFileSync(sessions, "utf8").split("\n").filter(Boolean).length;
    await recreate();
    const warm = { warmIdentity: { botId: "b-proof", audience: "owner" as const } };
    const clean = await run("t-carry", [], () => null, warm);
    expect(clean.done).toMatchObject({ ok: true });
    const cleanPid = clean.dump().pid;
    const kept = await run("t-carry", [], () => null, { ...warm, resumeCursor: "codex-thread-1" });
    expect(kept.done).toMatchObject({ ok: true });
    expect(kept.dump().pid).toBe(cleanPid);
    expect(waits()).toBe(1);
    writeFileSync(sessions, "");
    const tripped = await run("t-void", [{ kind: "shell", id: "v1", command: "cat /etc/hostname", cwd: scratch, hook: false }], () => null, warm);
    expect(tripped.done).toMatchObject({ ok: false, stopReason: "gate_incident" });
    const after = await run("t-void", [], () => null, { ...warm, resumeCursor: "codex-thread-1" });
    expect(after.done).toMatchObject({ ok: true });
    expect(waits()).toBe(2);
  });

  // Rule 68c with Rule 67: a call Codex starts before the SessionStart proof ran without the gate. It is an incident: the turn is
  // interrupted and refused with the tripwire line, and the approval request that follows is never allowed.
  it("treats a call that starts before the SessionStart proof as an incident and never allows the approval held behind it", async () => {
    process.env.FAKE_CODEX_MODE = "mcp-elicitation";
    process.env.FAKE_CODEX_SESSION_DELAY_MS = "600";
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "3000";
    const log = join(scratch, "calls-early.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    const dumpPath = join(scratch, "dump-t-early.json");
    process.env.FAKE_CODEX_DUMP = dumpPath;
    await recreate();
    const sent = await instance.adapter.sendTurn({ threadId: "t-early", text: "go", cwd: scratch, integrations: { agents: AGENTS } } as never);
    const done: any = await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "gate_incident" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error" && e.turnId === sent.turnId))
      .toMatchObject({ message: expect.stringContaining("`ls -la` without Murage's check") });
    expect(readFileSync(log, "utf8")).toContain("turn/interrupt");
    expect(recorder.events.some((e: any) => e.type === "request.opened" && e.turnId === sent.turnId)).toBe(false);
    const decision = existsSync(dumpPath) ? JSON.parse(readFileSync(dumpPath, "utf8")).decision : null;
    expect(JSON.stringify(decision ?? null)).not.toMatch(/accept|allow/);
  });

  // Rule 68c: the proof carries only under the hook configuration it was given under. A changed configuration ends reuse, and the
  // next turn waits for a fresh SessionStart on a new process.
  it("does not carry the proof to a turn whose hook configuration changed", async () => {
    const sessions = join(scratch, "sessions-config.log");
    process.env.FAKE_CODEX_SESSION_LOG = sessions;
    const waits = () => readFileSync(sessions, "utf8").split("\n").filter(Boolean).length;
    await recreate();
    const warm = { warmIdentity: { botId: "b-config", audience: "owner" as const } };
    const first = await run("t-config", [], () => null, warm);
    expect(first.done).toMatchObject({ ok: true });
    expect(waits()).toBe(1);
    const firstPid = first.dump().pid;
    // the hook command names the runtime it runs on: another path to the same runtime is another hook configuration
    const runtime = join(scratch, process.platform === "win32" ? "node-alias.exe" : "node-alias"); // cmd runs only a named executable
    symlinkSync(process.execPath, runtime);
    const realExecPath = process.execPath;
    const info = vi.spyOn(console, "info");
    try {
      process.execPath = runtime;
      expect(process.execPath).toBe(runtime);
      const next = await run("t-config", [], () => null, { ...warm, resumeCursor: "codex-thread-1" });
      expect(next.done).toMatchObject({ ok: true });
      expect(info.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("codex dispatch thread=t-config"))).toEqual(["codex dispatch thread=t-config process=spawned reason=hook-config-changed"]);
      expect(next.dump().pid).not.toBe(firstPid);
      expect(waits()).toBe(2);
    } finally {
      process.execPath = realExecPath;
      info.mockRestore();
    }
  });

  // Astra BLOCK 1 (Rule 68a): a gated plan whose scoped home cannot be named is refused before any spawn, never run without its hook
  it("refuses a gated turn when the scoped home resolves to nothing", async () => {
    await create("codex-cli 0.150.0", { codexHome: join(scopedCliHomeRoot("codex"), "no-such-scope") });
    const spawnLog = join(scratch, "spawns-noscope.log");
    process.env.FAKE_CODEX_SPAWN_LOG = spawnLog;
    const r = await run("t-no-scope", [], () => null);
    expect(r.done).toMatchObject({ ok: false, stopReason: "scope_unavailable" });
    expect(existsSync(spawnLog)).toBe(false);
  });

  // T100 a..c
  it("writes the gate into the scoped home only, drops the owner's hooks, and trusts through hooks/list and config/batchWrite", async () => {
    await create();
    // a kept process keeps its env file (03-1: the file goes with the process)
    const r = await run("t-files", [], () => null, { warmIdentity: { botId: "b-files", audience: "owner" } });
    const dump = r.dump();
    const home = dump.env.CODEX_HOME as string;
    expect(home).not.toBe(ownerHome);
    expect(existsSync(join(ownerHome, "hooks.json"))).toBe(false);
    const hooks = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    // 03-1: the process's own env file, named in its environment, under the scope's hook-env/
    const envFile = dump.env.MURAGE_CODEX_HOOK_ENV as string;
    expect(dirname(envFile)).toBe(join(home, "hook-env"));
    expect(readFileSync(join(home, "hooks.json"), "utf8")).not.toContain(readFileSync(envFile, "utf8").split("TOKEN=")[1]!.trim());
    if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(home, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-owner"');
    expect(config).not.toContain("owner = \"hook\"");
    expect(config).not.toContain("trusted_hash = \"sha256:aa\"");
    expect(dump.argv).toEqual(expect.arrayContaining(["features.hooks=true"]));
    expect(JSON.stringify(dump)).not.toContain("bypass_hook_trust");
    const order = calls(dump);
    expect(order.indexOf("hooks/list")).toBeGreaterThan(order.indexOf("initialize"));
    expect(order.indexOf("config/batchWrite")).toBeGreaterThan(order.indexOf("hooks/list"));
    expect(order.lastIndexOf("hooks/list")).toBeGreaterThan(order.indexOf("config/batchWrite"));
    expect(order.lastIndexOf("hooks/list")).toBeLessThan(order.indexOf("thread/start"));
    expect(dump.calls.find((c: any) => c.method === "config/batchWrite").params).toMatchObject({ reloadUserConfig: true, edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert" }] });
    // Rule 74: the pinned non-login shell form and the handed environment, per turn
    expect(dump.argv.join(" ")).toContain("allow_login_shell=false");
    expect(dump.argv.join(" ")).toContain("features.shell_snapshot=false");
    expect(dump.argv.join(" ")).toMatch(/shell_environment_policy\.set=\{[^}]*PAGER="cat"/);
    expect(dump.env.PAGER).toBe("cat");
  });

  // T86 and T103, Codex half
  it("turns each delivery into the decision Rule 68e gives it, as an ordinary ask through request.opened", async () => {
    await create();
    writeFileSync(join(scratch, ".env"), "KEY=1");
    const patch = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
    const tools = [
      { kind: "update_plan", id: "c1" },
      { kind: "view_image", id: "c2", input: { path: ".env" }, cwd: scratch },
      { kind: "other", id: "c3", name: "web_fetch", input: { url: "https://x.test" } },
      { kind: "shell", id: "c4", command: "ls -la", cwd: scratch },
      { kind: "apply_patch", id: "c5", cwd: scratch, patch: patch("*** Add File: notes.txt", "+hi") },
      { kind: "apply_patch", id: "c6", cwd: scratch, patch: patch("*** Add File: ../outside.txt", "+hi") },
      { kind: "mcp", id: "c7", server: "agents", tool: "list_bots", input: {} },
      { kind: "mcp", id: "c8", server: "agents", tool: "publish_site", input: { site: "x" } },
      { kind: "shell", id: "c9", cwd: scratch },
    ];
    const r = await run("t-table", tools, (e) => (e.tool === "shell" && e.toolCall?.input ? { behavior: "allow" } : { behavior: "deny", message: "no" }));
    expect(r.done).toMatchObject({ ok: true });
    const verdicts = Object.fromEntries(r.dump().hookLog.map((h: any) => [h.id, h]));
    // answered by Murage with no card
    expect(verdicts.c1).toMatchObject({ name: "update_plan", verdict: "allow" });
    expect(verdicts.c3).toMatchObject({ name: "web_fetch", verdict: "deny", reason: "Murage does not know this tool" });
    expect(verdicts.c5).toMatchObject({ name: "apply_patch", verdict: "allow" });
    expect(verdicts.c7).toMatchObject({ name: "mcp__agents__list_bots", verdict: "allow" });
    // asked: view_image of .env, the command, the patch that leaves the project, an own tool outside the unasked rows, a command with no command
    expect(r.opened.map((e) => e.tool)).toEqual(["view_image", "shell", "edit", "publish_site", "shell"]);
    expect(verdicts.c2.verdict).toBe("deny");
    expect(verdicts.c4.verdict).toBe("allow");
    expect(verdicts.c6.verdict).toBe("deny");
    expect(verdicts.c8.verdict).toBe("deny");
    const [, shell, edit, own, missing] = r.opened;
    expect(shell).toMatchObject({ requestType: "permission", toolEngine: "codex", toolCall: { name: "shell", input: { command: "ls -la", cwd: scratch } } });
    expect(shell.mcpMounts).toEqual(expect.arrayContaining([expect.objectContaining({ engineName: "agents", mountId: "own:agents", provenance: "own" })]));
    // F12: the handed map with the pins and the absence set, from the delivery's cwd
    expect(shell.execEnv.unread).toBeUndefined();
    {
      expect(shell.execEnv).toMatchObject({ cwd: scratch, env: { PAGER: "cat", GIT_TERMINAL_PROMPT: "0" } });
      expect(shell.execEnv.absent).toEqual(expect.arrayContaining(["PYTHONINSPECT", "BASH_ENV"]));
    }
    expect(shell.execEnv.env.PYTHONINSPECT).toBeUndefined();
    expect(edit).toMatchObject({ tool: "edit", toolCall: { name: "edit", input: { paths: ["../outside.txt"] } } });
    expect(own).toMatchObject({ tool: "publish_site", toolCall: { name: "mcp__agents__publish_site", input: { site: "x" } } });
    // F5: a command that never arrived is stated missing and never replaced
    expect(missing).toMatchObject({ tool: "shell", toolInputMissing: "command", toolCall: { name: "shell" } });
    expect(missing.toolCall).not.toHaveProperty("input");
    // the calls that ran: the allowed ones started, the denied ones never did
    const started = recorder.events.filter((e: any) => e.type === "item.started" && e.origin === "engine").map((e: any) => e.itemId);
    expect(started).toEqual(expect.arrayContaining(["c4", "c5", "c7"]));
    expect(started).not.toEqual(expect.arrayContaining(["c6"]));
    expect(started).not.toEqual(expect.arrayContaining(["c8"]));
  });

  // Rule 68e: the verdict mapping, narrowing denials and the one counter
  it("delivers a narrowing denial as the deny reason and raises the card on the third identical one", async () => {
    await create();
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([1, 2, 3].map((n) => ({ kind: "shell", id: `n${n}`, command: "find / -name x", cwd: scratch })));
    process.env.FAKE_CODEX_DUMP = join(scratch, "dump-narrow.json");
    const sent = await instance.adapter.sendTurn({ threadId: "t-narrow", text: "go", cwd: scratch } as never);
    const seen = new Set<string>();
    const next = async () => (await recorder.until((e: any) => e.turnId === sent.turnId && e.type === "request.opened" && !seen.has(e.requestId))) as any;
    for (const n of [1, 2]) {
      const e = await next();
      seen.add(e.requestId);
      expect(await instance.adapter.respondToRequest("t-narrow", e.requestId, { behavior: "deny", message: `search a folder (${n})`, source: "narrow" } as never)).toBe("rejected");
    }
    const third = await next();
    seen.add(third.requestId);
    // not delivered: the ask stays pending as the owner's card
    expect(await instance.adapter.respondToRequest("t-narrow", third.requestId, { behavior: "deny", message: "search a folder (3)", source: "narrow" } as never)).toBe("card");
    expect(await instance.adapter.respondToRequest("t-narrow", third.requestId, { behavior: "allow" })).toBe("allowed-once");
    await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const log = JSON.parse(readFileSync(join(scratch, "dump-narrow.json"), "utf8")).hookLog;
    expect(log.map((h: any) => [h.id, h.verdict])).toEqual([["n1", "deny"], ["n2", "deny"], ["n3", "allow"]]);
    expect(log[0].reason).toBe("search a folder (1)");
  });

  it("answers a call that reaches the approval path after the hook with the hook's decision, one card", async () => {
    await create();
    const r = await run("t-once", [{ kind: "shell", id: "e1", command: "pip install x", cwd: scratch, escalate: true }]);
    expect(r.done).toMatchObject({ ok: true });
    expect(r.opened).toHaveLength(1);
    expect(r.dump().decision).toMatchObject({ decision: "accept" });
    // a hook deny is final on the approval path too: nothing runs and nothing asks again
    const denied = await run("t-once-deny", [{ kind: "shell", id: "e2", command: "pip install y", cwd: scratch, escalate: true, runAnyway: true }], () => ({ behavior: "deny" }));
    expect(denied.opened).toHaveLength(1);
  });

  it("keeps the gate on a retained app-server: one handshake, a fresh token each turn, and every call still asked", async () => {
    const log = join(scratch, "calls-warm.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await create();
    const warm = { warmIdentity: { botId: "b-warm", audience: "owner" as const } };
    const tools = [{ kind: "shell", id: "w1", command: "ls", cwd: scratch }]; // the SAME tools both turns: the warm key's env must not change
    const first = await run("t-warm", tools, () => ({ behavior: "allow" }), warm);
    const firstPid = first.dump().pid;
    const home = first.dump().env.CODEX_HOME as string;
    const envFile = first.dump().env.MURAGE_CODEX_HOOK_ENV as string;
    expect(dirname(envFile)).toBe(join(home, "hook-env"));
    const tokenOne = readFileSync(envFile, "utf8");
    let tokenTwo = "";
    // read while the second turn's card is open: the live process's file holds this turn's token (03-1: a closed process's file is gone)
    const second = await run("t-warm", tools, () => {
      tokenTwo = readdirSync(dirname(envFile)).map((name) => readFileSync(join(dirname(envFile), name), "utf8")).join("");
      return { behavior: "deny" };
    }, { ...warm, resumeCursor: "codex-thread-1" });
    expect(second.done).toMatchObject({ ok: true });
    expect(second.opened.map((e) => e.tool)).toEqual(["shell"]);
    expect(second.dump().hookLog.at(-1)).toMatchObject({ id: "w1", verdict: "deny" });
    expect(second.dump().pid).toBe(firstPid); // real reuse, under the real settle probe
    expect(tokenTwo).toMatch(/TOKEN=/);
    expect(tokenTwo).not.toBe(tokenOne);
    const handshakes = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(`${first.dump().pid} `) && l.endsWith(" initialize"));
    expect(handshakes).toHaveLength(1);
  });

  // F4 design 2a (Astra r1 #2): a Stop before SessionStart is the user's Stop, never a refused turn
  it("F5b: Stop during the unanswered turn/start on a gated process before SessionStart => cancelled at once, no error card", async () => {
    process.env.FAKE_CODEX_HOOKS = "dead";
    process.env.FAKE_CODEX_TURNSTART_SILENT = "plain";
    process.env.MURAGE_CODEX_HOOK_LIVENESS_MS = "8000";
    const log = join(scratch, "calls-f5b.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    try {
      await create();
      const sent = await instance.adapter.sendTurn({ threadId: "t-f5b", text: "go", cwd: scratch, integrations: { agents: AGENTS } } as never);
      const end = Date.now() + 5_000;
      while (!(existsSync(log) && readFileSync(log, "utf8").includes(" turn/start")) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      const stoppedAt = Date.now();
      await instance.adapter.interruptTurn("t-f5b");
      const done: any = await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
      expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(Date.now() - stoppedAt).toBeLessThan(4_000);
      expect(recorder.events.some((e: any) => e.type === "runtime.error" && e.turnId === sent.turnId)).toBe(false);
    } finally {
      delete process.env.FAKE_CODEX_TURNSTART_SILENT;
    }
  }, 20_000);

  // B13 (Fable r1, Astra): a Stop during the wider hooks/list wait is the user's Stop: cancelled at once, no card, no relaunch
  it("F5c: Stop during the long hooks/list wait => cancelled at once, no error card, no relaunch, no thread/start", async () => {
    // a 2 s first bound and a 6 s wider one: a Stop that only landed at the bound would take ~6 s, not well under 2.5 s
    process.env.MURAGE_CODEX_HOOKS_LIST_MS = "2000";
    process.env.FAKE_CODEX_HOOKS_DELAY_MS = "30000";
    const log = join(scratch, "calls-f5c.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await recreate("codex-cli 0.164.0");
    const sent = await instance.adapter.sendTurn({ threadId: "t-f5c", text: "go", cwd: scratch, integrations: { agents: AGENTS } } as never);
    // the wait line opens when the first bound runs out: the driver is inside the wider wait now
    const chip: any = await recorder.until((e: any) => e.turnId === sent.turnId && e.type === "item.started" && String(e.itemId).startsWith("hooks-"));
    const stoppedAt = Date.now();
    await instance.adapter.interruptTurn("t-f5c");
    const done: any = await recorder.until((e: any) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(Date.now() - stoppedAt).toBeLessThan(2_500);
    // Astra r2: the wait line is closed on the Stop path too, so no working dots outlive the turn
    await recorder.until((e: any) => e.type === "item.completed" && e.itemId === chip.itemId);
    const mine = recorder.events.filter((e: any) => e.turnId === sent.turnId);
    expect(mine.some((e: any) => e.type === "runtime.error")).toBe(false);
    expect(mine.some((e: any) => e.type === "turn.retrying")).toBe(false);
    const methods = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[1]);
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
  }, 20_000);

  // F4 design 2c (03-1): two conversations of one bot, each with its own app-server, each hook reaching its own turn
  it("F11: two concurrent conversations of one gated bot => each process's hook reads its own socket and token, and each approval lands on its own turn", async () => {
    process.env.FAKE_CODEX_SESSION_DELAY_MS = "600";
    await create();
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([{ kind: "shell", id: "c1", command: "ls", cwd: scratch }]);
    const warm = { warmIdentity: { botId: "b-pair", audience: "owner" as const } };
    const [a, b] = await Promise.all(["t-pair-a", "t-pair-b"].map((threadId) =>
      instance.adapter.sendTurn({ threadId, text: "go", cwd: scratch, integrations: { agents: AGENTS }, ...warm } as never)));
    const answered = new Set<string>();
    const settled = new Map<string, any>();
    const own = new Map<string, string>([[a!.turnId, "t-pair-a"], [b!.turnId, "t-pair-b"]]);
    while (settled.size < 2) {
      const e: any = await recorder.until((ev: any) => own.has(ev.turnId) && ((ev.type === "request.opened" && !answered.has(ev.requestId)) || (ev.type === "turn.completed" && !settled.has(ev.turnId))));
      if (e.type === "turn.completed") { settled.set(e.turnId, e); continue; }
      answered.add(e.requestId);
      expect(await instance.adapter.respondToRequest(own.get(e.turnId)!, e.requestId, { behavior: "allow" })).toBe("allowed-once");
    }
    expect(settled.get(a!.turnId)).toMatchObject({ ok: true });
    expect(settled.get(b!.turnId)).toMatchObject({ ok: true });
    const opened = recorder.events.filter((e: any) => e.type === "request.opened" && own.has(e.turnId)) as any[];
    expect(opened.map((e) => own.get(e.turnId)).sort()).toEqual(["t-pair-a", "t-pair-b"]);
  }, 30_000);

  // F4 design 2a (Astra r2 #1): Stop revokes the turn's authority before the kill is awaited
  it("F20: Stop with a held kill while a PreToolUse decision is pending => the pending call is denied, a fresh delivery is refused, a late approval answer is ignored", async () => {
    await create();
    process.env.FAKE_CODEX_TOOLS = JSON.stringify([{ kind: "shell", id: "s1", command: "ls", cwd: scratch }, { kind: "shell", id: "s2", command: "pwd", cwd: scratch }]);
    const dumpPath = join(scratch, "dump-f20.json");
    process.env.FAKE_CODEX_DUMP = dumpPath;
    const sent = await instance.adapter.sendTurn({ threadId: "t-f20", text: "go", cwd: scratch, integrations: { agents: AGENTS } } as never);
    const opened: any = await recorder.until((e: any) => e.type === "request.opened" && e.turnId === sent.turnId);
    const kill = vi.spyOn(procs, "killCliTree").mockImplementation(() => {});
    const confirm = vi.spyOn(procs, "awaitCliTreeStopped").mockResolvedValue(false);
    try {
      await expect(instance.adapter.interruptTurn("t-f20")).rejects.toThrow(/still pending/);
      expect(await instance.adapter.respondToRequest("t-f20", opened.requestId, { behavior: "allow" })).toBe("unavailable");
      const end = Date.now() + 8_000;
      const log = () => { try { return JSON.parse(readFileSync(dumpPath, "utf8")).hookLog as any[]; } catch { return []; } };
      while (log().length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(log().find((h) => h.id === "s1")).toMatchObject({ verdict: "deny" });
      // the refused delivery is the script's printed deny with a clean exit (U18: the one form every Windows shell keeps)
      expect(log().find((h) => h.id === "s2")).toMatchObject({ verdict: "deny", reason: expect.stringContaining("Murage blocked this call") });
      expect(recorder.events.some((e: any) => e.type === "request.opened" && e.turnId === sent.turnId && e.requestId !== opened.requestId)).toBe(false);
    } finally {
      kill.mockRestore();
      confirm.mockRestore();
      await instance.adapter.interruptTurn("t-f20").catch(() => {});
    }
  }, 30_000);

  // Rule 67
  it("stops the turn when Codex starts a call the hook never reached, and carries the line to the next turn", async () => {
    const log = join(scratch, "calls-trip.log");
    process.env.FAKE_CODEX_CALL_LOG = log;
    await create();
    const r = await run("t-trip", [{ kind: "shell", id: "x1", command: "cat /etc/hostname", cwd: scratch, hook: false }], () => null);
    const line = "Codex ran `cat /etc/hostname` without Murage's check; the turn was stopped";
    expect(r.done).toMatchObject({ ok: false, stopReason: "gate_incident" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error")).toMatchObject({ message: line });
    expect(readFileSync(log, "utf8")).toContain("turn/interrupt");
    expect(r.dump().interrupted).toBe(true);
    await flushDecisionLog(DATA_DIR);
    const rows = readFileSync(join(DATA_DIR, "decisions.ndjson"), "utf8").split("\n").filter((l) => l.includes("cat /etc/hostname")).map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({ threadId: "t-trip", source: "observed", decision: "auto-denied" });
    // the next turn re-runs the handshake on a fresh process and its prompt carries the line
    writeFileSync(log, "");
    const next = await run("t-trip", [], () => null);
    expect(next.done).toMatchObject({ ok: true });
    const turnStart = next.dump().calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.input[0].text.startsWith(line)).toBe(true);
    expect(readFileSync(log, "utf8").split("\n").filter((l) => l.endsWith(" hooks/list")).length).toBeGreaterThanOrEqual(1);
    // and only that turn
    const third = await run("t-trip", [], () => null);
    expect(third.dump().calls.find((c: any) => c.method === "turn/start").params.input[0].text).not.toContain("without Murage's check");
  });

  it("stops the turn when Codex runs a call the hook denied", async () => {
    await create();
    const r = await run("t-denied-ran", [{ kind: "shell", id: "d1", command: "rm -rf build", cwd: scratch, runAnyway: true }], () => ({ behavior: "deny" }));
    expect(r.done).toMatchObject({ ok: false, stopReason: "gate_incident" });
    expect(recorder.events.find((e: any) => e.type === "runtime.error")).toMatchObject({ message: expect.stringContaining("rm -rf build") });
  });

  it("keeps the tripwire off a turn that is not gated", async () => {
    await create("codex-cli 0.147.0");
    const r = await run("t-legacy-free", [{ kind: "shell", id: "l1", command: "ls", cwd: scratch, hook: false }], () => null);
    expect(r.done).toMatchObject({ ok: true });
    expect(r.dump().calls.map((c: any) => c.method)).not.toContain("hooks/list");
  });

  // The coordinator's regression proof: nothing that was gated before runs unchecked now
  it("still puts every shell, patch and MCP call of an Ask, Auto and Full access bot, fullAuto or not, in front of a card or the gate", async () => {
    for (const fullAuto of [false, true]) {
      await recreate("codex-cli 0.150.0", { fullAuto });
      for (const [name, flags] of [["ask", { routeAsks: true }], ["auto", { routeAsks: true }], ["full", { stopLine: true }], ["bare", {}]] as const) {
        const tools = [
          { kind: "shell", id: "s1", command: "rm -rf build", cwd: scratch },
          { kind: "apply_patch", id: "p1", cwd: scratch, patch: ["*** Begin Patch", "*** Add File: /etc/murage-test", "+x", "*** End Patch"].join("\n") },
          { kind: "mcp", id: "m1", server: "agents", tool: "publish_site", input: {} },
        ];
        const r = await run(`t-reg-${fullAuto}-${name}`, tools, () => ({ behavior: "deny" }), flags);
        expect(r.done).toMatchObject({ ok: true });
        // each of the three reached Murage's ask path before it could run, and none started
        expect(r.opened.map((e) => e.tool)).toEqual(["shell", "edit", "publish_site"]);
        expect(r.dump().hookLog.map((h: any) => h.verdict)).toEqual(["deny", "deny", "deny"]);
        expect(recorder.events.some((e: any) => e.type === "item.started" && e.origin === "engine" && ["s1", "p1", "m1"].includes(e.itemId) && e.turnId === r.sent.turnId)).toBe(false);
        expect(r.dump().calls.find((c: any) => c.method === "turn/start").params.approvalPolicy).toBe("on-request");
      }
    }
  });
});
