// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Learning for a person signed in only to a CLI or ACP engine (design r2.10, r3.7, H12): both extractMemory and groundMemory, the
// openai-compat prompt contracts, the inference purpose route, pacing behind an interactive turn, and the limit pause.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { memoryExtractionMessages, memoryGroundingMessages } from "../memory/extract.ts";
import {
  ENGINE_LIMIT_PAUSE_MS, memoryExtractorConnections, resolveLearningConnection, resolveMemoryExtractor, setLearningClockForTests,
} from "../memory/extractor-connections.ts";
import { CLI_LEARNING, flattenMemoryMessages, isMemoryLearningThread, withCliMemoryLearning } from "./cli-memory-learning.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
afterEach(() => { setLearningClockForTests(null); vi.unstubAllEnvs(); });

type Script = (prompt: string, emit: (event: Record<string, unknown>) => void, input: SendTurnInput) => void | Promise<void>;
/** A fake engine that only offers a turn (the shape Codex and the ACP engines have). */
function fakeEngine(script: Script, id = "codex-fixture", name = "Codex") {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const sent: SendTurnInput[] = [];
  const denied: string[] = [];
  const cwds: Array<string[]> = [];
  const emitFor = (threadId: string) => (event: Record<string, unknown>) =>
    listeners.forEach(listener => listener({ eventId: "e", provider: "codex", threadId, createdAt: "now", ...event } as RuntimeEvent));
  const adapter = {
    provider: "codex", capabilities: { sessionModelSwitch: "unsupported" },
    onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async (input: SendTurnInput) => {
      sent.push(input);
      cwds.push(input.cwd && existsSync(input.cwd) ? readdirSync(input.cwd) : ["(missing)"]);
      emitFor(input.threadId)({ type: "turn.started" });
      await script(input.text, emitFor(input.threadId), input);
      return { turnId: "turn" };
    },
    respondToRequest: async (_thread: string, requestId: string) => { denied.push(requestId); return "rejected"; },
    interruptTurn: async () => undefined,
    resetSession: async () => undefined,
  };
  const instance = { instanceId: id, driverKind: "codex", displayName: name, enabled: true, adapter, dispose: async () => undefined } as unknown as ProviderInstance;
  return { instance: withCliMemoryLearning(instance), sent, denied, cwds, emitFor, listeners };
}

const answer = (text: string): Script => (_prompt, emit) => {
  emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text });
  emit({ type: "turn.completed", ok: true });
};
/** Answers like a model reading the contract: grounding gets {supported}, extraction gets a candidate list. */
const contractEngine: Script = (prompt, emit) => {
  const grounding = prompt.includes("Independently judge");
  const reply = grounding
    ? JSON.stringify({ supported: !prompt.includes('"previousClaim"') || prompt.includes("moved to Lisbon") })
    : JSON.stringify([{ text: "The owner reads reports daily.", quote: "reads reports daily", startByte: 10, endByte: 29, claimType: "owner-statement" }]);
  emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "```json\n" + reply + "\n```" });
  emit({ type: "turn.completed", ok: true });
};
const learning = (instance: ProviderInstance, selected: string | null = instance.instanceId) =>
  resolveLearningConnection({ selected, instances: [instance], readKey: () => null, defaultOn: true });
const signal = () => new AbortController().signal;
const grounding = (over: Record<string, unknown> = {}) => ({ text: "The owner reads reports daily.", quote: "reads reports daily", claimType: "owner-statement", speaker: "owner", outcome: "sent", ...over });

describe("CLI and ACP learning (H12)", () => {
  it("implements both extractMemory and groundMemory, and the wrapper installs .ground", async () => {
    const { instance } = fakeEngine(contractEngine);
    expect(typeof instance.extractMemory).toBe("function");
    expect(typeof instance.groundMemory).toBe("function");
    const connection = learning(instance);
    expect(connection).toMatchObject({ source: "chosen", instanceId: "codex-fixture" });
    expect(typeof connection.extractor!.ground).toBe("function");
    expect(typeof resolveMemoryExtractor("codex-fixture", [instance])!.ground).toBe("function");
  });

  it("extracts with the openai-compat prompt, as JSON in an empty folder with no tools mounted", async () => {
    const engine = fakeEngine(contractEngine);
    const raw = await learning(engine.instance).extractor!("The owner reads reports daily.", 2000, signal());
    expect(JSON.parse(raw)).toHaveLength(1);
    const prompt = engine.sent[0].text;
    expect(prompt).toBe(flattenMemoryMessages(memoryExtractionMessages("The owner reads reports daily.")));
    expect(prompt).toContain("Return only a JSON array");
    expect(engine.sent[0]).toMatchObject({ sessionReset: true, stopLine: true, proposalOnly: true, background: true });
    expect(engine.sent[0].integrations).toBeUndefined();
    expect(isMemoryLearningThread(engine.sent[0].threadId)).toBe(true);
    expect(engine.cwds[0]).toEqual([]);
    // the folder goes once the engine's retained session for the thread is retired
    await vi.waitFor(() => expect(existsSync(engine.sent[0].cwd!)).toBe(false));
  });

  it("a paraphrase activates: the grounding call returns supported through the grounding contract", async () => {
    const engine = fakeEngine(contractEngine);
    const extractor = learning(engine.instance).extractor!;
    const input = grounding({ text: "Reads the reports every day.", claimType: "owner-statement" });
    const raw = await extractor.ground!(input, 64, signal());
    expect(JSON.parse(raw)).toEqual({ supported: true });
    expect(engine.sent[0].text).toBe(flattenMemoryMessages(memoryGroundingMessages(input)));
    expect(engine.sent[0].text).toContain("Independently judge");
  });

  it("a correction grounds against the prior claim it replaces", async () => {
    const engine = fakeEngine(contractEngine);
    const extractor = learning(engine.instance).extractor!;
    const input = grounding({ text: "The owner moved to Lisbon.", quote: "moved to Lisbon", previousClaim: "The owner lives in Austin." });
    expect(JSON.parse(await extractor.ground!(input, 64, signal()))).toEqual({ supported: true });
    expect(engine.sent[0].text).toContain("The owner lives in Austin.");
    const mere = grounding({ text: "The owner likes Lisbon.", quote: "likes Lisbon", previousClaim: "The owner lives in Austin." });
    expect(JSON.parse(await extractor.ground!(mere, 64, signal()))).toEqual({ supported: false });
  });

  it("a procedure evaluation runs through the host's own messages", async () => {
    const engine = fakeEngine(answer('{"verdict":"keep"}'));
    const extractor = learning(engine.instance).extractor!;
    const messages = [{ role: "system", content: "Evaluate this procedure." }, { role: "user", content: "{\"procedure\":\"weekly report\"}" }];
    const raw = await extractor("weekly report", 2000, signal(), { policyRevision: "r1", messages, purpose: "evaluation" });
    expect(raw).toBe('{"verdict":"keep"}');
    expect(engine.sent[0].text).toBe(flattenMemoryMessages(messages));
  });

  it("dispatch.purpose reaches the inference prompt and its output cap, not the extraction prompt", async () => {
    const engine = fakeEngine(answer("{}"));
    const extractor = learning(engine.instance).extractor!;
    const messages = [{ role: "system", content: "REFLECT ON THE DAY" }, { role: "user", content: "notes" }];
    await extractor("notes", 8000, signal(), { policyRevision: "r1", messages, purpose: "reflection" });
    expect(engine.sent[0].text).toContain("REFLECT ON THE DAY");
    expect(engine.sent[0].text).not.toContain("Return only a JSON array");
    // the ordinary cap (2000) holds without a purpose, the reflection cap (8000) only with one
    await expect(extractor("notes", 8000, signal(), { policyRevision: "r1", messages })).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
    await expect(extractor("notes", 3001, signal(), { policyRevision: "r1", messages, purpose: "continuity" })).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
    expect(engine.sent).toHaveLength(1);
  });

  it("refuses a source over the extraction budget and an answer over the bound, and denies every ask", async () => {
    const engine = fakeEngine((_prompt, emit) => {
      emit({ type: "request.opened", requestId: "r1", requestType: "permission", tool: "shell", summary: "ls" });
      emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "x".repeat(70_000) });
      emit({ type: "turn.completed", ok: true });
    });
    const extractor = learning(engine.instance).extractor!;
    await expect(extractor("a".repeat(65_537), 2000, signal())).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
    await expect(extractor("small", 2000, signal())).rejects.toThrow("MEMORY_EXTRACTION_RESPONSE_LIMIT");
    expect(engine.denied).toEqual(["r1"]);
  });

  it("runs one extraction session at a time on an engine", async () => {
    let open = 0, most = 0;
    const releases: Array<() => void> = [];
    const engine = fakeEngine(async (_prompt, emit) => {
      open++; most = Math.max(most, open);
      await new Promise<void>(resolve => releases.push(resolve));
      open--;
      emit({ type: "item.completed", itemType: "assistant_text", origin: "engine", text: "[]" });
      emit({ type: "turn.completed", ok: true });
    });
    const extractor = learning(engine.instance).extractor!;
    const first = extractor("one", 2000, signal()), second = extractor("two", 2000, signal());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(engine.sent).toHaveLength(1);
    releases[0]();
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await second;
    expect(most).toBe(1);
  });

  it("an interactive turn makes extraction wait until the engine is idle", async () => {
    const engine = fakeEngine(answer("[]"));
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const pending = learning(engine.instance).extractor!("source", 2000, signal());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(engine.sent).toHaveLength(0);
    engine.emitFor("owner-chat")({ type: "turn.completed", ok: true });
    await expect(pending).resolves.toBe("[]");
    expect(engine.sent).toHaveLength(1);
    // the hidden session's own turn is never counted as interactive
    await expect(learning(engine.instance).extractor!("again", 2000, signal())).resolves.toBe("[]");
  });

  it("a waiting extraction stops when its caller gives up", async () => {
    const engine = fakeEngine(answer("[]"));
    engine.emitFor("owner-chat")({ type: "turn.started" });
    const controller = new AbortController();
    const pending = learning(engine.instance).extractor!("source", 2000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("MEMORY_EXTRACTION_ABORTED");
    expect(engine.sent).toHaveLength(0);
  });

  it("a limit pauses learning with the plain status line, then resumes when the engine's limit has passed", async () => {
    let now = 1_000_000;
    setLearningClockForTests(() => now);
    const engine = fakeEngine((_prompt, emit) => {
      emit({ type: "runtime.error", message: "You've hit your usage limit. Try again later." });
      emit({ type: "turn.completed", ok: false });
    });
    const first = learning(engine.instance);
    await expect(first.extractor!("source", 2000, signal())).rejects.toMatchObject({ status: 429, limit: true });
    expect(learning(engine.instance)).toMatchObject({ source: "none", extractor: null, reason: "Learning waits while Codex is at its limit." });
    await expect(first.extractor!("source", 2000, signal())).rejects.toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");
    expect(engine.sent).toHaveLength(1);
    now += ENGINE_LIMIT_PAUSE_MS + 1;
    expect(learning(engine.instance)).toMatchObject({ source: "chosen" });
  });

  it("a refused sign-in pauses learning with the existing refusal tracking", async () => {
    const engine = fakeEngine((_prompt, emit) => {
      emit({ type: "runtime.error", message: "Not logged in. Please run /login", authRequired: true });
      emit({ type: "turn.completed", ok: false });
    });
    await expect(learning(engine.instance).extractor!("source", 2000, signal())).rejects.toMatchObject({ status: 401 });
    expect(learning(engine.instance)).toMatchObject({ source: "none", reason: "Learning is paused: the engine asked you to sign in again." });
  });
});

describe("selection order", () => {
  const api = { instanceId: "grok-api", driverKind: "openai-compat", displayName: "My API", enabled: true, extractMemory: async () => "[]" } as unknown as ProviderInstance;
  it("ranks Flux, then API connections, then CLI engines last", () => {
    const cli = fakeEngine(answer("[]")).instance;
    const rows = memoryExtractorConnections([cli, api], "flux-key");
    expect(rows.map(row => row.instanceId)).toEqual(["@murage/flux-fast", "@murage/flux-standard", "@murage/flux-auto", "grok-api", "codex-fixture"]);
    expect(rows.every(row => row.eligible)).toBe(true);
  });

  it("with a Flux key the default is Flux even when a CLI engine is signed in", () => {
    const cli = fakeEngine(answer("[]")).instance;
    expect(resolveLearningConnection({ selected: null, instances: [cli, api], readKey: () => "flux-key", defaultOn: true })).toMatchObject({ source: "default", instanceId: "@murage/flux-fast" });
  });

  it("without a Flux key the suggestion is the API connection, and a CLI-only person is offered the CLI engine", () => {
    const cli = fakeEngine(answer("[]")).instance;
    expect(resolveLearningConnection({ selected: null, instances: [cli, api], readKey: () => null, defaultOn: true })).toMatchObject({ source: "none", suggestion: { instanceId: "grok-api" } });
    expect(resolveLearningConnection({ selected: null, instances: [cli], readKey: () => null, defaultOn: true })).toMatchObject({ source: "none", suggestion: { instanceId: "codex-fixture", label: "Codex" } });
    // the owner can pick it, as today
    expect(resolveLearningConnection({ selected: "codex-fixture", instances: [cli, api], readKey: () => null, defaultOn: true })).toMatchObject({ source: "chosen", instanceId: "codex-fixture" });
  });
});

describe("the drivers carry both methods", () => {
  it("Codex and an ACP engine implement extractMemory and groundMemory", async () => {
    for (const driver of [CodexDriver, GeminiAgentDriver] as const) {
      const instance = await (driver as typeof CodexDriver).create({ instanceId: "fixture", displayName: "Fixture", environment: {}, enabled: true, config: { ...(driver as typeof CodexDriver).defaultConfig(), cli: "fixture-cli-that-does-not-exist" } });
      try {
        expect(typeof instance.extractMemory).toBe("function");
        expect(typeof instance.groundMemory).toBe("function");
        expect((instance as unknown as Record<symbol, unknown>)[CLI_LEARNING]).toBe(true);
      } finally { await instance.dispose().catch(() => undefined); }
    }
  });
});

describe("Claude one-shot learning (fake CLI)", () => {
  const fake = fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url));
  const made: ProviderInstance[] = [];
  afterEach(async () => { for (const instance of made.splice(0)) await instance.dispose().catch(() => undefined); });
  const create = async () => {
    chmodSync(fake, 0o755);
    const instance = await ClaudeDriver.create({ instanceId: "claude-fixture", displayName: "Claude", environment: {}, enabled: true, config: { cli: fake, permissionMode: "acceptEdits" } });
    made.push(instance);
    return instance;
  };

  it("extracts and grounds with no tools, no MCP, no session file, in an empty folder", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-learning-test-"));
    try {
      vi.stubEnv("FAKE_CLAUDE_ONE_SHOT_TEXT", '```json\n{"supported":true}\n```');
      const dump = join(scratch, "dump.json");
      vi.stubEnv("FAKE_CLAUDE_DUMP", dump);
      const instance = await create();
      expect(typeof instance.groundMemory).toBe("function");
      const extractor = learning(instance).extractor!;
      expect(typeof extractor.ground).toBe("function");
      const input = grounding();
      expect(JSON.parse(await extractor.ground!(input, 64, signal()))).toEqual({ supported: true });
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.argv).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--no-session-persistence"]));
      expect(seen.argv).not.toContain("--dangerously-skip-permissions");
      expect(seen.prompt).toBe(flattenMemoryMessages(memoryGroundingMessages(input)));
      expect(seen.cwdEntries).toEqual([]);
      expect(seen.cwd).not.toBe(process.cwd());
    } finally { removeTempDirSync(scratch); }
  }, 30_000);

  it("a usage limit pauses learning with the status line", async () => {
    vi.stubEnv("FAKE_CLAUDE_ONE_SHOT_ERROR", "Claude AI usage limit reached|1760000000");
    const instance = await create();
    const first = learning(instance);
    await expect(first.extractor!("The owner reads reports daily.", 2000, signal())).rejects.toMatchObject({ status: 429, limit: true });
    expect(learning(instance)).toMatchObject({ source: "none", reason: "Learning waits while Claude is at its limit." });
  }, 30_000);
});
