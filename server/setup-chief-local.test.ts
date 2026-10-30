// "I AM USING IT NOW" ON A LOCAL MODEL IS A CLAIM ABOUT THE CHIEF'S OWN TURNS.
//
// Astra r2 (L6A, 1.0.12): the detection card said it whenever the Chief's
// ENGINE had a local DEFAULT model and the host was any registered one. The
// Chief can be on a cloud model on that same engine, and a registered host can
// be another computer on the network. Both made the promise false.
//
// The line is now backed only by `chiefLocalModel`, read from the Chief's own
// `modelSelection` the way a real turn reads it, on a loopback host, with no
// provider connection routing the turn elsewhere. Unsure is undefined.

import { describe, expect, it, vi } from "vitest";

// Two user-added servers: one on another computer, one on this one. Every
// other host id falls through to the real table, so the built-in loopback
// hosts are tested as they ship.
vi.mock("./drivers/local-inject.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./drivers/local-inject.ts")>();
  const added = new Map([
    ["lanbox", { id: "lanbox", label: "Ollama on lanbox", kind: "ollama" as const, baseUrl: "http://192.168.1.20:11434/v1", source: "added" as const }],
    ["myllama", { id: "myllama", label: "My llama", kind: "llamacpp" as const, baseUrl: "http://127.0.0.1:9000/v1", source: "added" as const }],
  ]);
  return {
    ...actual,
    localHost: (id: string) => added.get(id) ?? actual.localHost(id),
    decodeInjectId: (id: string | null | undefined) => {
      const sep = (id ?? "").indexOf("::");
      if (id && sep > 0 && added.has(id.slice(0, sep))) return { host: id.slice(0, sep), model: id.slice(sep + 2) };
      return actual.decodeInjectId(id);
    },
  };
});

const { chiefLocalModelOf, isLoopbackBase, readWorkspace, setupAgentsReading } = await import("./setup.ts");

const workspace = { messagesFor: () => [], routesThroughFlux: () => false };
const chief = (model: string, extra: Record<string, unknown> = {}) => ({
  id: "chief",
  threadId: "chief-thread",
  modelSelection: { instanceId: "openai-compat", model, ...extra },
});

describe("the Chief's own local model", () => {
  it("is named when the Chief's own selection is a model on this computer", () => {
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "ollama::qwen3:8b" })).toEqual({ model: "qwen3:8b", host: "Ollama" });
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "myllama::q" })).toEqual({ model: "q", host: "My llama" });
    const reading = readWorkspace({ ...workspace, bots: [chief("ollama::qwen3:8b")] }, "chief");
    expect(reading.chiefLocalModel).toEqual({ model: "qwen3:8b", host: "Ollama" });
  });

  it("is absent when the Chief is on a remote model, even with a local host registered", () => {
    // The engine's default may be `ollama::...` and Ollama is a known host;
    // neither matters, because the Chief's own turns use this model.
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "meta-llama/llama-4-70b" })).toBeUndefined();
    expect(chiefLocalModelOf({ instanceId: "claude", model: "claude-sonnet-5" })).toBeUndefined();
    const reading = readWorkspace({ ...workspace, bots: [chief("meta-llama/llama-4-70b")] }, "chief");
    expect(reading).not.toHaveProperty("chiefLocalModel");
  });

  it("is absent when the model is on another computer", () => {
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "lanbox::qwen3:8b" })).toBeUndefined();
  });

  // Astra r3: the engine ROWS read the engine's default model, and a LAN
  // default read as "on this computer". Only a loopback host is local.
  it("an engine row is local only when its default model is on a loopback host", () => {
    const row = (model: string) => setupAgentsReading([{
      instanceId: "openai-compat",
      driverKind: "openaiCompat",
      snapshot: { state: "available" },
      models: { default: model },
    }])[0];
    expect(row("lanbox::qwen3:8b")).not.toHaveProperty("localModel");
    expect(row("myllama::q").localModel).toEqual({ model: "q", host: "My llama" });
    expect(row("ollama::qwen3:8b").localModel).toEqual({ model: "qwen3:8b", host: "Ollama" });
  });

  it("is absent when the model is unknown or the selection is missing", () => {
    expect(chiefLocalModelOf(undefined)).toBeUndefined();
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "" })).toBeUndefined();
    expect(chiefLocalModelOf({ instanceId: "", model: "ollama::qwen3:8b" })).toBeUndefined();
    expect(chiefLocalModelOf({ instanceId: "codex", model: "flux::flux-auto" })).toBeUndefined();
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "nohost::qwen3:8b" })).toBeUndefined();
    expect(readWorkspace({ ...workspace, bots: [] }, "chief")).not.toHaveProperty("chiefLocalModel");
  });

  it("is absent when a provider connection routes the turn", () => {
    expect(chiefLocalModelOf({ instanceId: "openai-compat", model: "ollama::qwen3:8b", connectionId: "conn-1" })).toBeUndefined();
  });

  it("counts only loopback addresses as this computer", () => {
    for (const url of ["http://127.0.0.1:11434/v1", "http://127.8.0.1:1/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1"]) {
      expect.soft(isLoopbackBase(url), url).toBe(true);
    }
    for (const url of ["http://192.168.1.20:11434/v1", "http://10.0.0.5/v1", "https://api.example.com/v1", "http://127.0.0.1.example.com/v1", "not a url"]) {
      expect.soft(isLoopbackBase(url), url).toBe(false);
    }
  });
});
