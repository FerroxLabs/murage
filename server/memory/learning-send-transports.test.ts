import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { fixtureLearningBot } from "../testing/learning-bot-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The learning gate on each real transport (designs/MEM-LEARNING-FENCE-R8.md section 9): T5b, an unchanged call sends once, leaves no
// transaction open and lets a second connection commit right after; T18e, the BEGIN IMMEDIATE to COMMIT hold, p50 and p99 per transport,
// stays under 50 ms. The HTTP transports reach a real local server; the PIP headless transport spawns the stub CLI under the lock; the
// hook form (Codex, ACP, Claude) admits through the hidden-turn runner. No network beyond 127.0.0.1, no real engine.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { withCliMemoryLearning } from "../drivers/cli-memory-learning.ts";
import { claudeTextOnlyTurn, headlessTextOnlyTurn } from "../drivers/headless-text-only.ts";
import { httpTextOnlyTurn } from "../drivers/http-text-only.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { requestMemoryExtraction, requestMemoryGrounding } from "./extract.ts";
import { fixedPrompt } from "./fixed-prompt.ts";
import { isMemorySendFenced } from "./learning-send-fence.ts";
import { learningGate, learningSendHoldSamples, sampleLearningFence, type LearningGate, type LearningPurpose } from "./learning-send.ts";
import type { TextOnlyTurnInput } from "./pip-transport.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { closeDatabase(); });

const N = 40;
const gate = (purpose: LearningPurpose = "extraction"): LearningGate => learningGate(purpose, sampleLearningFence(), {});
const signal = () => new AbortController().signal;
function settledCleanly() {
  expect(database().isTransaction).toBe(false);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { other.exec("PRAGMA busy_timeout=0"); other.exec("BEGIN IMMEDIATE; COMMIT"); } finally { other.close(); }
}
/** Runs `call` N times on fresh gates; each must release exactly once. Logs and bounds the hold p50/p99 for this transport. */
async function holds(transport: string, call: (g: LearningGate) => Promise<unknown>) {
  for (let i = 0; i < N; i++) {
    const g = gate();
    await call(g);
    expect(g.released).toBe(1);
  }
  settledCleanly();
  // each call above released once, so the last N samples are this transport's
  const samples = [...learningSendHoldSamples()].slice(-N).sort((a, b) => a - b);
  expect(samples.length).toBe(N);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * q) - 1)]!;
  console.info(`[learning-send-hold] transport=${transport} n=${samples.length} p50=${at(0.5).toFixed(3)}ms p99=${at(0.99).toFixed(3)}ms max=${samples.at(-1)!.toFixed(3)}ms`);
  expect(at(0.99)).toBeLessThan(50);
}

let server: Server, base = "";
const hits: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      hits.push(body);
      const content = body.includes("pip_reflection") || body.includes('"ok"') || body.includes('"content":"USER"') ? '{"ok":true}' : body.includes("previousClaim") || body.includes("entailed") ? '{"supported":true}' : "[]";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

describe("T5b and T18e per transport", () => {
  it("HTTP extraction (requestMemoryTransport's fetch)", async () => {
    const sent = hits.length;
    await holds("http-extraction", g => requestMemoryExtraction({ url: base, apiKey: "k", model: "m" }, "zqtransport the owner prefers tea", 100, signal(), undefined, g));
    expect(hits.length - sent).toBe(N);
  });
  it("HTTP grounding (pin or fallback reach this same fetch)", async () => {
    await holds("http-grounding", g => requestMemoryGrounding({ url: base, apiKey: "k", model: "m" },
      { text: "The owner prefers tea.", quote: "prefers tea", claimType: "owner-statement", speaker: "owner", outcome: "sent" }, 64, signal(), g));
  });
  it("PIP HTTP (http-text-only's aliased fetch)", async () => {
    const turn = (g: LearningGate): TextOnlyTurnInput => ({ cwd: fixtureBotFolder(),
      system: fixedPrompt("SYS"), text: "USER", model: "m", signal: signal(), maxOutputTokens: 100, maxOutputBytes: 12 * 1024,
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      context: { botId: "b", runId: randomUUID(), family: "lived", attempt: 1 }, transport: { fence: () => "none", gate: g },
    } as TextOnlyTurnInput);
    await holds("pip-http", async g => { const r = await httpTextOnlyTurn(turn(g), { baseUrl: base, apiKey: "k", buildBody: (model, messages) => ({ model, messages }) }); expect(r.verdict.state).toBe("validated"); });
  });
  it("the hook form: Codex, ACP and Claude admit through beforeSubmit right before the write", async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const written: string[] = [];
    const adapter = {
      provider: "codex", capabilities: { sessionModelSwitch: "unsupported" },
      onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async (input: SendTurnInput) => {
        input.beforeSubmit?.();
        written.push(input.text);
        const emit = (event: Record<string, unknown>) => listeners.forEach(l => l({ eventId: "e", provider: "codex", threadId: input.threadId, createdAt: "now", ...event } as RuntimeEvent));
        emit({ type: "turn.started" });
        emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: JSON.stringify({ supported: true }) });
        emit({ type: "turn.completed", ok: true });
        return { turnId: "turn" };
      },
      respondToRequest: async () => "rejected", interruptTurn: async () => undefined, resetSession: async () => undefined,
    };
    const instance = fixtureLearningBot(withCliMemoryLearning({ instanceId: "codex-fixture", driverKind: "codex", displayName: "Codex", enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance));
    await holds("hook-admit", g => instance.groundMemory!({ text: "The owner prefers tea.", quote: "prefers tea", claimType: "owner-statement", speaker: "owner", outcome: "sent" }, 64, signal(), g));
    expect(written.length).toBe(N);
  });
  it.skipIf(process.platform === "win32")("PIP Fuigo/Grok (writeFileSync of the prompt file and spawnCli under the lock)", async () => {
    const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "pip-hold-")), etc = join(dir, "etc"), home = join(dir, "home");
    mkdirSync(etc); mkdirSync(home);
    try {
      const cfg = {
        engine: "fuigo" as const, cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${join(dir, "rec.jsonl")}`], tmpBase: join(dir, "tmp"),
        pathValue: "/usr/bin:/bin", fluxKey: "flux-test-key", postResultGraceMs: 3000,
        preflight: { etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(dir, "no-managed.json") },
      };
      const turn = (g: LearningGate): TextOnlyTurnInput => ({ cwd: fixtureBotFolder(),
        system: fixedPrompt("SYS"), text: "USER", model: "model-x", signal: signal(), maxOutputTokens: 1500, maxOutputBytes: 12 * 1024,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
        context: { botId: "b", runId: randomUUID(), family: "lived", attempt: 1 }, transport: { fence: () => "none", gate: g },
      } as TextOnlyTurnInput);
      await holds("pip-headless-spawn", async g => { const r = await headlessTextOnlyTurn(turn(g), cfg); expect(r.verdict.state).toBe("validated"); });
    } finally { removeTempDirSync(dir); }
  }, 300_000);
  it.skipIf(process.platform === "win32")("PIP Claude (the prompt's stdin.end under the lock, after the child is registered)", async () => {
    const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "pip-hold-claude-")), etc = join(dir, "etc"), home = join(dir, "home");
    mkdirSync(etc); mkdirSync(home);
    try {
      const cfg = {
        cli: process.execPath, cliPrefixArgs: [STUB, "--stub=text-result", `--stub-out=${join(dir, "rec.jsonl")}`], tmpBase: join(dir, "tmp"),
        env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv, platform: "linux" as const, postResultGraceMs: 3000,
        preflight: { etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(dir, "no-managed.json") },
      };
      const turn = (g: LearningGate): TextOnlyTurnInput => ({ cwd: fixtureBotFolder(),
        system: fixedPrompt("SYS"), text: "USER", model: "model-x", signal: signal(), maxOutputTokens: 1500, maxOutputBytes: 12 * 1024,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
        context: { botId: "b", runId: randomUUID(), family: "lived", attempt: 1 }, transport: { fence: () => "none", gate: g },
      } as TextOnlyTurnInput);
      await holds("pip-headless-claude-stdin", async g => { const r = await claudeTextOnlyTurn(turn(g), cfg); expect(r.verdict.state).toBe("validated"); });
    } finally { removeTempDirSync(dir); }
  }, 300_000);
});

describe("no gate, no send (r6 section 0/4, MurageMain ruling 1)", () => {
  it("each HTTP transport refuses a call without a gate and nothing reaches the server", async () => {
    const sent = hits.length;
    await expect(requestMemoryExtraction({ url: base, apiKey: "k", model: "m" }, "zqungated", 100, signal())).rejects.toSatisfy(isMemorySendFenced);
    await expect(httpTextOnlyTurn({
      system: fixedPrompt("SYS"), text: "zqungated", model: "m", signal: signal(), maxOutputTokens: 100, maxOutputBytes: 12 * 1024,
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
      context: { botId: "b", runId: "r", family: "lived", attempt: 1 }, transport: { fence: () => "none" },
    } as TextOnlyTurnInput, { baseUrl: base, apiKey: "k", buildBody: (model, messages) => ({ model, messages }) })).rejects.toSatisfy(isMemorySendFenced);
    expect(hits.length).toBe(sent);
    expect(hits.join("\n")).not.toContain("zqungated");
  });
  it.skipIf(process.platform === "win32")("each headless PIP transport refuses a turn without a gate: no temp root, no process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pip-ungated-"));
    try {
      const input = { cwd: fixtureBotFolder(),
        system: fixedPrompt("SYS"), text: "zqungated", model: "m", signal: signal(), maxOutputTokens: 100, maxOutputBytes: 12 * 1024,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
        context: { botId: "b", runId: "r", family: "lived", attempt: 1 }, transport: { fence: () => "none" },
      } as TextOnlyTurnInput;
      const rec = join(dir, "rec.jsonl"), tmpBase = join(dir, "tmp");
      const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
      await expect(headlessTextOnlyTurn(input, { engine: "fuigo", cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${rec}`], tmpBase, pathValue: "/usr/bin:/bin" })).rejects.toSatisfy(isMemorySendFenced);
      await expect(claudeTextOnlyTurn(input, { cli: process.execPath, cliPrefixArgs: [STUB, "--stub=text-result", `--stub-out=${rec}`], tmpBase, env: {} })).rejects.toSatisfy(isMemorySendFenced);
      expect(existsSync(rec)).toBe(false);
      expect(existsSync(tmpBase)).toBe(false);
    } finally { removeTempDirSync(dir); }
  });
});
