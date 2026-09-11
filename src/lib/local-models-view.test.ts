// The "don't make me think" rule, held to the copy rather than to a screenshot.
//
// Each of these is a state a person can actually land in. The rule is that every
// one of them answers three questions without reasoning: what Murage found, what
// that means, and the one thing to do next. A state that returns a diagnostic, a
// port number nobody typed, or nothing to press is a failure of this file, not a
// matter of taste — so the assertions are about those properties, not about the
// exact sentence, except where the spec fixes the sentence.
import { describe, expect, it } from "vitest";

import {
  checkLine,
  contextLine,
  engineLocalLine,
  enginesLine,
  LOCAL_MODELS_TITLE,
  lastCheckedLine,
  lookedLine,
  nextActionFor,
  serverStatusLine,
  surfacesLine,
  testOutcomeLine,
  tokensLabel,
} from "./local-models-view";
import {
  LOCAL_DETECTION_TARGETS,
  type LocalModelView,
  type LocalServerView,
  type LocalToolTestOutcome,
  type LocalToolTestResult,
} from "../../shared/local-models";

function test(outcome: LocalToolTestOutcome, over: Partial<LocalToolTestResult> = {}): LocalToolTestResult {
  return {
    serverId: "srv_abcdefgh",
    apiBase: "http://127.0.0.1:8080/v1",
    model: "qwen3.8-27b",
    outcome,
    checks: [],
    surfaces: { chat: outcome === "tools-work" || outcome === "tools-partial", responses: false, messages: false },
    testedAt: 1_700_000_000_000,
    durationMs: 4200,
    ...over,
  };
}

function model(over: Partial<LocalModelView> = {}): LocalModelView {
  return { id: "srv_abcdefgh::qwen3.8-27b", model: "qwen3.8-27b", loaded: true, engines: [], ...over };
}

function server(over: Partial<LocalServerView> = {}): LocalServerView {
  return {
    id: "srv_abcdefgh",
    name: "seanbeast",
    label: "llama.cpp on seanbeast",
    kind: "llamacpp",
    address: "http://127.0.0.1:8080/v1",
    source: "added",
    editable: true,
    hasKey: false,
    status: "running",
    checkedAt: 1_700_000_000_000,
    models: [model()],
    ...over,
  };
}

describe("the empty state says where Murage looked (spec V1)", () => {
  it("names every address automatic detection checked, by server name", () => {
    const line = lookedLine(LOCAL_DETECTION_TARGETS);
    for (const target of LOCAL_DETECTION_TARGETS) expect(line).toContain(target.address);
    expect(line).toContain("Ollama");
    expect(line).toContain("LM Studio");
    // llama.cpp is called llama.cpp. Mislabelling it "oMLX" — the other server
    // on :8080 — is the exact confusion the spec calls out.
    expect(line).toContain("llama.cpp");
    expect(line).toContain("nothing answered");
  });
});

describe("a server card states what it found, in that order", () => {
  it("says running, how many models, and when it last looked", () => {
    const now = 1_700_000_060_000;
    expect(serverStatusLine(server(), now)).toBe("Running · 1 model · checked 1 minute ago");
    expect(serverStatusLine(server({ models: [] }), now)).toContain("no models loaded");
    expect(serverStatusLine(server({ status: "not-answering" }), now)).toBe("Not answering · checked 1 minute ago");
  });

  it("reads a fresh check as just now rather than as zero minutes", () => {
    expect(lastCheckedLine(1_000_000, 1_000_000)).toBe("checked just now");
    expect(lastCheckedLine(1_000_000, 1_000_000 + 3_600_000)).toBe("checked 1 hour ago");
  });

  it("says what a context size means, not only what it is", () => {
    expect(contextLine(model({ context: { contextWindow: 65_536, source: "llamacpp-props" } }))).toBe("64K context loaded");
    const small = contextLine(model({ context: { contextWindow: 4_096, source: "llamacpp-props" } }));
    expect(small).toContain("4K context loaded");
    expect(small).toContain("too small for agents");
    expect(contextLine(model())).toBe("Context size not reported by this server");
  });

  it("names the engines that can use the model, and says so plainly when none can", () => {
    expect(enginesLine(model({ engines: ["fuigoAgent", "piAgent", "codex"] }))).toBe("Usable by Fuigo, pi, Codex");
    expect(enginesLine(model({ engines: [] }))).toContain("run the test first");
    expect(enginesLine(model({ engines: ["fuigoAgent"], test: test("tools-partial") }))).toBe("Usable by Fuigo");
  });

  it("promises no engine for a model whose test said it cannot run agents", () => {
    // The server still lists chat engines for such a model (they run their own
    // loop), so without this the card would say "can't use tools" and
    // "Usable by Fuigo, pi, …" three lines apart.
    for (const outcome of ["text-instead-of-tools", "server-rejects-tools", "context-too-small", "model-not-found", "unreachable"] as const) {
      expect(enginesLine(model({ engines: ["fuigoAgent", "piAgent"], test: test(outcome) })), outcome).toBe("");
    }
  });

  it("rounds a duration and names the surfaces in the terms engines are chosen by", () => {
    expect(surfacesLine(test("tools-work"))).toBe("Proven: chat tools");
    expect(surfacesLine(test("tools-work", { surfaces: { chat: true, responses: true, messages: true } })))
      .toBe("Proven: chat tools, Codex (responses), Claude (messages)");
    expect(surfacesLine(test("unreachable"))).toBe("Nothing proven yet");
  });

  it("keeps K labels honest for small windows", () => {
    expect(tokensLabel(512)).toBe("512");
    expect(tokensLabel(32_768)).toBe("32K");
  });
});

describe("every test outcome is a plain sentence with a next action (spec T1)", () => {
  const outcomes: LocalToolTestOutcome[] = [
    "tools-work",
    "tools-partial",
    "text-instead-of-tools",
    "context-too-small",
    "server-rejects-tools",
    "model-not-found",
    "unreachable",
  ];

  it("never leaves a state without a primary action or without help text", () => {
    for (const outcome of outcomes) {
      const action = nextActionFor(server(), model({ test: test(outcome) }));
      expect(action.label, outcome).toBeTruthy();
      expect(action.help, outcome).toMatch(/\w/);
    }
    // and an untested model, and a server that is not answering
    expect(nextActionFor(server(), model()).kind).toBe("test");
    expect(nextActionFor(server({ status: "not-answering" }), model()).kind).toBe("retest");
  });

  it("uses the words the spec fixes for the three outcomes people actually hit", () => {
    expect(testOutcomeLine(test("tools-work"))).toBe("Tools work — ready for agents");
    expect(testOutcomeLine(test("text-instead-of-tools"))).toContain("can't use tools");
    expect(testOutcomeLine(test("context-too-small", { context: { contextWindow: 4_096, source: "llamacpp-props" } })))
      .toBe("Context too small for agents (loaded 4K; agents need 32K+)");
  });

  it("carries no protocol jargon into any outcome sentence", () => {
    for (const outcome of outcomes) {
      const line = testOutcomeLine(test(outcome));
      expect(line, outcome).not.toMatch(/OpenAI-compatible|openai-compat|\/v1\/|HTTP \d|JSON|oMLX|inject/i);
    }
  });

  it("hands back the exact flag to fix a server that refuses tools", () => {
    const action = nextActionFor(server(), model({ test: test("server-rejects-tools", { fix: { kind: "server-flag", value: "--jinja" } }) }));
    expect(action.kind).toBe("copy-flag");
    expect(action.value).toBe("--jinja");
  });

  it("offers Ollama the context copy and every other server the flag", () => {
    const small = test("context-too-small", { context: { contextWindow: 4_096, source: "ollama-ps" } });
    expect(nextActionFor(server({ kind: "ollama" }), model({ test: small })).kind).toBe("ollama-context-copy");
    expect(nextActionFor(server({ kind: "vllm" }), model({ test: small })).kind).toBe("copy-flag");
  });

  it("sends a passing model on to the one place it can be chosen", () => {
    const action = nextActionFor(server(), model({ test: test("tools-work") }));
    expect(action.kind).toBe("use");
    expect(action.help).toContain("model menu");
  });

  it("promises the test costs nothing, because that is the question it raises", () => {
    expect(nextActionFor(server(), model()).help).toMatch(/nothing is billed|no cloud/i);
  });
});

describe("the technical half stays behind the disclosure", () => {
  it("turns each probe check into a sentence, including one nobody has a name for", () => {
    expect(checkLine({ name: "chat.auto", status: "pass", detail: "ok" })).toBe("Calls a tool when it should: Pass — passed");
    expect(checkLine({ name: "responses.functionCall", status: "skipped", detail: "no-endpoint" }))
      .toBe("Responses-style tools (Codex): Skipped — this server does not offer that endpoint");
    expect(checkLine({ name: "chat.stream", status: "fail", detail: "text-instead-of-tool" }))
      .toContain("answered with text instead of calling the tool");
  });
});

describe("engines say where they stand on local models (spec V4)", () => {
  it("points every tool engine at the one place local models are managed", () => {
    for (const driver of ["fuigoAgent", "piAgent", "opencodeGo", "qwenAgent", "codex", "claudeAgent"]) {
      expect(engineLocalLine(driver), driver).toContain(`Models → ${LOCAL_MODELS_TITLE}`);
    }
  });

  it("labels the chat-only drivers truthfully instead of implying agents", () => {
    for (const driver of ["openai-compat", "grok"]) {
      expect(engineLocalLine(driver), driver).toBe(`${LOCAL_MODELS_TITLE}: chat only (no tools)`);
    }
  });

  it("says nothing at all for an engine that cannot use a local server", () => {
    // No dead ends: a row that cannot be acted on is better absent than denied.
    expect(engineLocalLine("antigravity")).toBe("");
    expect(engineLocalLine("boxAgent")).toBe("");
  });
});
