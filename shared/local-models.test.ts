import { describe, expect, it } from "vitest";

import {
  AGENT_MIN_CONTEXT_TOKENS,
  classifyLocalHostname,
  contextPreflight,
  isValidLocalModelId,
  isValidLocalServerKey,
  isValidLocalServerName,
  llamaCppModelId,
  localEngineLabel,
  localEngineSupport,
  LOCAL_ENGINE_LABELS,
  LOCAL_ENGINE_SURFACE,
  localEnginesFor,
  localServerDisplayLabel,
  normalizeLocalServerAddress,
  type LocalToolTestResult,
} from "./local-models.ts";
import { engineToolSupport } from "./provider-engine.ts";

describe("local server address rule (spec A1)", () => {
  it.each([
    ["127.0.0.1:8080", "http://127.0.0.1:8080/v1", "loopback"],
    ["http://localhost:11434", "http://localhost:11434/v1", "loopback"],
    ["http://[::1]:1234/v1", "http://[::1]:1234/v1", "loopback"],
    ["192.168.1.20:8000", "http://192.168.1.20:8000/v1", "private"],
    ["http://10.0.0.5:30000/", "http://10.0.0.5:30000/v1", "private"],
    ["http://172.16.4.2:8080/v1/", "http://172.16.4.2:8080/v1", "private"],
    ["http://172.31.255.1:8080", "http://172.31.255.1:8080/v1", "private"],
    ["http://100.64.0.1:8080", "http://100.64.0.1:8080/v1", "tailnet"],
    ["http://100.127.255.254:18080", "http://100.127.255.254:18080/v1", "tailnet"],
    ["https://gpu.example.com/proxy", "https://gpu.example.com/proxy/v1", "public"],
    ["https://gpu.example.com/proxy/v1", "https://gpu.example.com/proxy/v1", "public"],
  ] as const)("accepts %s as %s (%s)", (typed, apiBase, addressClass) => {
    const result = normalizeLocalServerAddress(typed);
    expect(result).toMatchObject({ ok: true, apiBase, addressClass });
    if (result.ok) expect(result.root).toBe(apiBase.replace(/\/v1$/, ""));
  });

  it.each([
    ["http://gpu.example.com:8080", "https-required"],
    ["http://8.8.8.8:8080", "https-required"],
    ["http://172.32.0.1:8080", "https-required"],
    ["http://100.128.0.1:8080", "https-required"],
    ["http://seanbeast:8080", "https-required"],
    ["http://user:pass@127.0.0.1:8080", "credentials-in-address"],
    ["ftp://127.0.0.1/v1", "unsupported-scheme"],
    ["file:///etc/passwd", "unsupported-scheme"],
    ["http://127.0.0.1:8080/v1?key=x", "invalid-address"],
    ["http://127.0.0.1:8080/#frag", "invalid-address"],
    ["http://127.0.0.1:8080/a b", "invalid-address"],
    ["", "invalid-address"],
    [42, "invalid-address"],
  ] as const)("refuses %s with %s", (typed, code) => {
    expect(normalizeLocalServerAddress(typed)).toEqual({ ok: false, code });
  });

  it("classifies only the spec's ranges as allowed over http", () => {
    expect(classifyLocalHostname("127.8.9.10")).toBe("loopback");
    expect(classifyLocalHostname("100.63.255.255")).toBe("public");
    expect(classifyLocalHostname("192.169.0.1")).toBe("public");
    expect(classifyLocalHostname("fd7a:115c:a1e0::1")).toBe("public");
  });

  it("validates names and keys before they reach any engine config", () => {
    expect(isValidLocalServerName("SeanBeast")).toBe(true);
    expect(isValidLocalServerName("GPU box — upstairs")).toBe(true);
    expect(isValidLocalServerName("   ")).toBe(false);
    expect(isValidLocalServerName("line\nbreak")).toBe(false);
    expect(isValidLocalServerName("x".repeat(61))).toBe(false);
    expect(isValidLocalServerKey("sk-local-123")).toBe(true);
    expect(isValidLocalServerKey("has space")).toBe(false);
    expect(isValidLocalServerKey('quote"inside\n')).toBe(false);
  });

  it("names a server the way the picker and card show it", () => {
    expect(localServerDisplayLabel("llamacpp", "seanbeast")).toBe("llama.cpp on seanbeast");
    expect(localServerDisplayLabel("openai", "GPU box")).toBe("GPU box");
    expect(localServerDisplayLabel("ollama", "")).toBe("Ollama");
  });
});

describe("context preflight (spec T2)", () => {
  it("is unknown when the server did not report a window", () => {
    expect(contextPreflight({ promptTokens: 16_000 }).status).toBe("unknown");
  });

  it("flags windows below the agent minimum as too small", () => {
    expect(contextPreflight({ contextWindow: 4_096, promptTokens: 1_000 }).status).toBe("too-small");
    expect(contextPreflight({ contextWindow: AGENT_MIN_CONTEXT_TOKENS - 1, promptTokens: 1_000 }).status).toBe("too-small");
  });

  it("warns when the prompt takes more than 70% of the window", () => {
    const tight = contextPreflight({ contextWindow: 32_768, promptTokens: 24_000 });
    expect(tight.status).toBe("tight");
    expect(tight.ratio).toBeCloseTo(24_000 / 32_768);
    expect(contextPreflight({ contextWindow: 65_536, promptTokens: 16_000 }).status).toBe("ok");
    expect(contextPreflight({ contextWindow: 40_000, promptTokens: 40_000 }).status).toBe("too-small");
  });
});

function test(surfaces: LocalToolTestResult["surfaces"], outcome: LocalToolTestResult["outcome"] = "tools-work"): LocalToolTestResult {
  return { serverId: "srv_abcdef012345", apiBase: "http://127.0.0.1:18080/v1", model: "m", outcome, checks: [], surfaces, testedAt: 1, durationMs: 1 };
}

describe("engine eligibility (spec E3/E4)", () => {
  it("offers chat engines before any test, but not Codex or Claude Code", () => {
    const engines = localEnginesFor(undefined);
    expect(engines).toEqual(expect.arrayContaining(["fuigoAgent", "piAgent", "opencodeGo", "qwenAgent", "hermesAgent"]));
    expect(engines).not.toContain("codex");
    expect(engines).not.toContain("claudeAgent");
  });

  it("adds Codex only after /v1/responses passed and Claude Code only after /v1/messages passed", () => {
    expect(localEnginesFor(test({ chat: true, responses: true, messages: false }))).toContain("codex");
    expect(localEnginesFor(test({ chat: true, responses: true, messages: false }))).not.toContain("claudeAgent");
    expect(localEnginesFor(test({ chat: true, responses: false, messages: true }))).toContain("claudeAgent");
    expect(localEnginesFor(test({ chat: true, responses: false, messages: true }))).not.toContain("codex");
  });

  it("offers nothing for an unreachable server", () => {
    expect(localEnginesFor(test({ chat: false, responses: false, messages: false }, "unreachable"))).toEqual([]);
  });

  it("labels openai-compat and the grok API as chat-only and never offers Antigravity local rows", () => {
    expect(localEngineSupport("openai-compat")).toBe("chat-only");
    expect(localEngineSupport("grok")).toBe("chat-only");
    expect(localEngineSupport("antigravityAgent")).toBe("none");
    expect(localEngineSupport("piAgent")).toBe("tools");
    expect(engineToolSupport("openai-compat")).toBe("chat-only");
    expect(engineToolSupport("grok")).toBe("chat-only");
    for (const driver of ["piAgent", "opencodeGo", "droidAgent", "kimiAgent", "grokAgent", "fuigoAgent"]) {
      expect(engineToolSupport(driver)).toBe("tools");
    }
  });
});

describe("llama-server's model name (0.1.52 LM2, live finding)", () => {
  // Observed on SeanBeast, llama.cpp b1-192067b, 2026-09-11: /v1/models and
  // /props both name the loaded model `D:\Qwen\models\Qwen3.8-27B-UD-Q4_K_M.gguf`.
  // Every id Murage listed was then dropped by the `host::model` grammar, so a
  // running server showed up as "detected, no models" and could not be picked
  // for any bot. The same build answered a request naming `totally-made-up`
  // from the loaded model, which is why the file's own name is a safe stand-in.
  it("recovers a usable id from a Windows path", () => {
    expect(llamaCppModelId("D:\\Qwen\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf")).toBe("Qwen3.8-27B-UD-Q4_K_M");
  });

  it("recovers one from a POSIX path, and leaves a plain id alone", () => {
    expect(llamaCppModelId("/srv/models/gemma-4-31b.gguf")).toBe("gemma-4-31b");
    expect(llamaCppModelId("qwen3.8-27b")).toBe("qwen3.8-27b");
  });

  it("produces an id the picker's own grammar accepts", () => {
    for (const raw of ["D:\\Qwen\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf", "/srv/models/gemma-4-31b.gguf", "C:\\a b\\model name.gguf"]) {
      const id = llamaCppModelId(raw)!;
      expect(id, raw).toBeTruthy();
      expect(isValidLocalModelId(id), raw).toBe(true);
    }
  });

  it("keeps the honest empty answer rather than inventing a name", () => {
    for (const raw of ["", "   ", "/", "D:\\models\\.gguf", 7, null, undefined]) {
      expect(llamaCppModelId(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("engine names (spec V2)", () => {
  it("names every engine that can use a local server the way the app names it", () => {
    expect(Object.keys(LOCAL_ENGINE_SURFACE).every((driver) => LOCAL_ENGINE_LABELS[driver])).toBe(true);
    expect(localEngineLabel("fuigoAgent")).toBe("Fuigo");
    expect(localEngineLabel("piAgent")).toBe("pi");
    expect(localEngineLabel("claudeAgent")).toBe("Claude");
  });

  it("falls back to the driver id rather than rendering nothing", () => {
    expect(localEngineLabel("somethingNew")).toBe("somethingNew");
  });
});
