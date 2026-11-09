// LM Studio 0.4 (the Bionic app) lists downloaded models at GET /api/v1/models,
// keyed by `key`, with loaded instances and their context. Adapted from
// upstream 545868c56 (#3630) and c63f476e6: in Murage an LM Studio server is
// one probed or added with kind "lmstudio", so only those are asked.
import { afterEach, describe, expect, it } from "vitest";

import { clearLocalContextCacheForTests, decodeInjectId, localHost, mergeLocalInject, probeLocalInjects } from "./local-inject.ts";
import { detectLocalServerKind, probeHost, readLoadedContext } from "../local-server-probe.ts";
import { isValidLocalModelId } from "../../shared/local-models.ts";

const env = () => ({ VITEST: "true", MURAGE_PROBE_LOCAL_INJECT: "1" });

afterEach(() => {
  clearLocalContextCacheForTests();
});

type Answer = { status?: number; body: unknown };

function stub(responses: Record<string, Answer>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(href);
    const hit = Object.keys(responses).find((suffix) => href.endsWith(suffix));
    if (!hit) return new Response("nope", { status: 500 });
    const answer = responses[hit]!;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
}

const NATIVE = {
  models: [
    {
      type: "llm",
      key: "google/gemma-4-26b-a4b",
      loaded_instances: [{ config: { context_length: 4096 } }],
      max_context_length: 262144,
      selected_variant: "google/gemma-4-26b-a4b@q4_k_m",
    },
    { type: "llm", key: "deepseek-r1", loaded_instances: [], max_context_length: 131072 },
    { type: "embedding", key: "acme/vector-model" },
    { type: "decision", key: "acme/router" },
  ],
};

describe("LM Studio 0.4 native catalog", () => {
  it("accepts an LM Studio quant variant id and still rejects junk", () => {
    expect(decodeInjectId("lmstudio::publisher/model@q4_k_m")).toEqual({ host: "lmstudio", model: "publisher/model@q4_k_m" });
    expect(decodeInjectId("lmstudio::bad id")).toBeNull();
    // The Local models tool test takes the same id.
    expect(isValidLocalModelId("publisher/model@q4_k_m")).toBe(true);
    expect(isValidLocalModelId("@model")).toBe(false);
  });

  it("lists downloaded chat models from /api/v1/models, not the OpenAI variant id", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":1234/api/v1/models": { body: NATIVE },
      ":1234/v1/models": { body: { data: [{ id: "google/gemma-4-26b-a4b@q4_k_m" }] } },
    }));
    const lm = rows.filter((row) => row.host === "lmstudio");
    expect(lm.map((row) => row.id)).toEqual(["lmstudio::google/gemma-4-26b-a4b", "lmstudio::deepseek-r1"]);
    expect(lm[0]).toMatchObject({ loaded: true, contextWindow: 4096 });
    // Not loaded: the model maximum is not the window LM Studio will load it
    // with, so no window is claimed for it.
    expect(lm[1]!.loaded).toBe(false);
    expect(lm[1]!.contextWindow).toBeUndefined();
  });

  it("merges the native rows into the picker catalog", async () => {
    const catalog = await mergeLocalInject(
      { default: "keep", options: [{ id: "keep", label: "Keep" }] },
      env(),
      stub({ ":1234/api/v1/models": { body: NATIVE }, ":1234/v1/models": { body: { data: [] } } }),
    );
    const ids = catalog.options.map((option) => option.id);
    expect(ids).toContain("lmstudio::google/gemma-4-26b-a4b");
    expect(ids).toContain("lmstudio::deepseek-r1");
    expect(ids.some((id) => id.includes("@") || id.includes("vector-model") || id.includes("acme/router"))).toBe(false);
  });

  it("offers no chat model when the native list holds only embeddings (Astra r1 Medium)", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":1234/api/v1/models": { body: { models: [{ type: "embedding", key: "acme/vector-model" }] } },
      ":1234/v1/models": { body: { data: [{ id: "acme/vector-model" }] } },
    }));
    expect(rows.filter((row) => row.host === "lmstudio").map((row) => row.id)).toEqual([]);
  });

  it("keeps the v0 loaded flags when /api/v1/models is absent", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":1234/api/v1/models": { status: 404, body: { error: "missing" } },
      ":1234/v1/models": { body: { data: [{ id: "qwen" }, { id: "other" }] } },
      ":1234/api/v0/models": { body: { data: [{ id: "qwen", state: "loaded", loaded_context_length: 8192 }, { id: "other", state: "not-loaded" }] } },
    }));
    expect(rows.find((row) => row.id === "lmstudio::qwen")).toMatchObject({ loaded: true, contextWindow: 8192 });
    expect(rows.find((row) => row.id === "lmstudio::other")?.loaded).toBe(false);
  });

  it("never asks a server that is not LM Studio for the native catalog", async () => {
    const seen: string[] = [];
    await probeLocalInjects(env(), stub({ ":8000/v1/models": { body: { data: [{ id: "q", owned_by: "vllm" }] } } }, seen));
    const native = seen.filter((href) => href.endsWith("/api/v1/models"));
    expect(native.length).toBeGreaterThan(0);
    expect(native.every((href) => href.includes(":1234/"))).toBe(true);
  });

  it("detects the Bionic app, which answers only the native API, as LM Studio", async () => {
    const detected = await detectLocalServerKind(
      probeHost("http://127.0.0.1:18080/v1", undefined),
      env(),
      stub({ ":18080/api/v1/models": { body: NATIVE }, ":18080/v1/models": { body: { data: [{ id: "google/gemma-4-26b-a4b@q4_k_m" }] } } }),
    );
    expect(detected).toMatchObject({ reachable: true, kind: "lmstudio" });
  });

  it("does not call an empty or foreign /api/v1/models answer LM Studio", async () => {
    const detected = await detectLocalServerKind(
      probeHost("http://127.0.0.1:18080/v1", undefined),
      env(),
      stub({ ":18080/api/v1/models": { body: { models: [] } }, ":18080/v1/models": { body: { data: [{ id: "m" }] } } }),
    );
    expect(detected.kind).toBe("openai");
  });

  it("reads a loaded model's context from the native API when v0 is gone", async () => {
    const reading = await readLoadedContext(localHost("lmstudio")!, "google/gemma-4-26b-a4b", env(), stub({ ":1234/api/v1/models": { body: NATIVE } }));
    expect(reading).toMatchObject({ contextWindow: 4096, maxContextWindow: 262144, source: "lmstudio", loaded: true });
    const idle = await readLoadedContext(localHost("lmstudio")!, "deepseek-r1", env(), stub({ ":1234/api/v1/models": { body: NATIVE } }));
    expect(idle).toEqual({ maxContextWindow: 131072, source: "lmstudio", loaded: false });
  });
});
