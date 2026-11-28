// M10 (1.0.23): Ollama cloud models read their own trained window, never a
// local sibling's /api/ps window, and get no "64k copy" (P1, P3, scope guard).
//
// The real readers run against an injected fetch that serves Ollama-shaped
// JSON (api/types.go: ShowResponse carries `remote_model` / `remote_host` and
// `model_info["<arch>.context_length"]`; ProcessResponse rows carry `name`,
// `model`, `context_length`) and logs every URL. Neutral fixture names only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The fixture hosts are not stored servers, so their readings are looked up by
// the host's address (the cache key since r4), not by an id that resolves nowhere.
import { cachedHostContext, clearLocalContextCacheForTests, type LocalHost } from "./drivers/local-inject.ts";
import { createOllamaContextCopy, readLoadedContext } from "./local-server-probe.ts";

const env = { VITEST: "true" };
const OLLAMA: LocalHost = { id: "fixture-ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:19877/v1" };
const LLAMA: LocalHost = { id: "fixture-llama", label: "llama.cpp", kind: "llamacpp", baseUrl: "http://127.0.0.1:19878/v1" };

type Show = Record<string, unknown> | "fail";
function ollama(options: { ps?: Array<{ name: string; context_length: number }>; show?: Record<string, Show>; props?: unknown }) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(href);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (href.endsWith("/api/ps")) return json({ models: (options.ps ?? []).map((row) => ({ ...row, model: row.name, size: 1, size_vram: 1 })) });
    if (href.endsWith("/api/show")) {
      const model = String((JSON.parse(String(init?.body ?? "{}")) as { model?: unknown }).model);
      const shown = options.show?.[model];
      if (!shown || shown === "fail") return json({ error: "show failed" }, 500);
      return json(shown);
    }
    if (href.endsWith("/props") && options.props) return json(options.props);
    if (href.endsWith("/api/version")) return json({ version: "0.14.2" });
    return json({ error: "not found" }, 404);
  };
  return { urls, fetchImpl };
}
const cloudShow = (length?: number, remote: Record<string, string> = { remote_host: "https://ollama.com:443", remote_model: "fixture-model:70b" }) => ({
  ...remote,
  details: { family: "fixture" },
  model_info: { "general.architecture": "fixture", ...(length ? { "fixture.context_length": length } : {}) },
});
const localShow = (length: number, numCtx?: number) => ({
  parameters: numCtx ? `num_ctx                        ${numCtx}` : "",
  details: { family: "fixture" },
  model_info: { "general.architecture": "fixture", "fixture.context_length": length },
});

beforeEach(() => clearLocalContextCacheForTests());
afterEach(() => clearLocalContextCacheForTests());

describe("M10 P1: a cloud model reads its own trained window", () => {
  it("W1 a cloud-tagged model never takes a local sibling's ps window", async () => {
    const { fetchImpl } = ollama({
      ps: [{ name: "fixture-model:7b", context_length: 4_096 }],
      show: { "fixture-model:70b-cloud": cloudShow(131_072) },
    });
    const reading = await readLoadedContext(OLLAMA, "fixture-model:70b-cloud", env, fetchImpl);
    expect(reading).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud", cloud: true }); // W1-reading
    expect(cachedHostContext(OLLAMA, "fixture-model:70b-cloud")?.contextWindow).toBe(131_072);
  });

  it("W2 the tag alone classifies, and a cloud show with no trained length stays unknown but remembered", async () => {
    const tagged = ollama({ show: { "fixture-model:cloud": cloudShow(262_144, {}) } });
    expect(await readLoadedContext(OLLAMA, "fixture-model:cloud", env, tagged.fetchImpl)).toMatchObject({ contextWindow: 262_144, source: "ollama-cloud", cloud: true }); // W2-tag
    clearLocalContextCacheForTests();
    const bare = ollama({ ps: [{ name: "fixture-model:7b", context_length: 4_096 }], show: { "fixture-model:cloud": cloudShow(undefined, {}) } });
    const reading = await readLoadedContext(OLLAMA, "fixture-model:cloud", env, bare.fetchImpl);
    expect(reading).toEqual({ source: "ollama-cloud", cloud: true }); // W2-unknown
    expect(cachedHostContext(OLLAMA, "fixture-model:cloud")).toEqual({ source: "ollama-cloud", cloud: true }); // W2-memory
  });

  it("W2 a failed show on a cloud-tagged name is an unknown cloud reading, not a ps fallback", async () => {
    const { fetchImpl } = ollama({ ps: [{ name: "fixture-model:7b", context_length: 4_096 }], show: { "fixture-model:70b-cloud": "fail" } });
    expect(await readLoadedContext(OLLAMA, "fixture-model:70b-cloud", env, fetchImpl)).toEqual({ source: "ollama-cloud", cloud: true }); // W2-failed
  });

  it("W3 an untagged alias whose show names a remote model reads show before the base-name ps fallback", async () => {
    const { fetchImpl } = ollama({
      ps: [{ name: "fixture-model:7b", context_length: 4_096 }],
      show: { "fixture-model:big": cloudShow(131_072, { remote_model: "fixture-model:70b-cloud" }) },
    });
    const reading = await readLoadedContext(OLLAMA, "fixture-model:big", env, fetchImpl);
    expect(reading).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud", cloud: true }); // W3-alias
  });

  it("W3b a known-cloud alias whose show fails keeps its cached cloud reading (Fable/Opus r2 M2)", async () => {
    const first = ollama({ show: { "fixture-model:big": cloudShow(131_072, { remote_model: "fixture-model:70b-cloud" }) } });
    await readLoadedContext(OLLAMA, "fixture-model:big", env, first.fetchImpl);
    const busy = ollama({
      ps: [{ name: "fixture-model:big", context_length: 4_096 }, { name: "fixture-model:7b", context_length: 65_536 }],
      show: { "fixture-model:big": "fail" },
    });
    const reading = await readLoadedContext(OLLAMA, "fixture-model:big", env, busy.fetchImpl);
    expect(reading).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud", cloud: true }); // W3b-showfail
    expect(cachedHostContext(OLLAMA, "fixture-model:big")).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud" });
    expect(busy.urls.some((url) => url.endsWith("/api/ps"))).toBe(false);
  });

  it("W3b a tagged cloud model whose show fails keeps a cached windowed reading", async () => {
    const first = ollama({ show: { "fixture-model:70b-cloud": cloudShow(131_072) } });
    await readLoadedContext(OLLAMA, "fixture-model:70b-cloud", env, first.fetchImpl);
    const busy = ollama({ show: { "fixture-model:70b-cloud": "fail" } });
    expect(await readLoadedContext(OLLAMA, "fixture-model:70b-cloud", env, busy.fetchImpl)).toMatchObject({ contextWindow: 131_072, cloud: true }); // W3b-tagfail
  });
});

describe("M10 P3: no copy for a cloud model (probe-side guard)", () => {
  it("W6b createOllamaContextCopy refuses a cloud-tagged model before /api/version", async () => {
    const { urls, fetchImpl } = ollama({});
    const result = await createOllamaContextCopy(OLLAMA, "fixture-model:70b-cloud", undefined, env, fetchImpl);
    expect(result).toEqual({ status: "refused", reason: "cloud-model", model: "fixture-model:70b-cloud" }); // W6b-refused
    expect(urls).toEqual([]);
  });
});

describe("M10 scope guard (reader half): local models and other servers read as today", () => {
  it("W9 a llama.cpp model named like a cloud tag gets no cloud reading", async () => {
    const { fetchImpl } = ollama({ props: { default_generation_settings: { n_ctx: 8_192 } } });
    const reading = await readLoadedContext(LLAMA, "x:cloud", env, fetchImpl);
    expect(reading).toEqual({ contextWindow: 8_192, source: "llamacpp-props", loaded: true }); // W9-llama
  });

  it("W9 a local model reads its own ps window", async () => {
    const { fetchImpl } = ollama({ ps: [{ name: "fixture-model:7b", context_length: 65_536 }], show: { "fixture-model:7b": localShow(131_072) } });
    expect(await readLoadedContext(OLLAMA, "fixture-model:7b", env, fetchImpl)).toEqual({ contextWindow: 65_536, source: "ollama-ps", loaded: true }); // W9-local
  });

  it("W9 an untagged model whose show fails keeps today's base-name ps fallback", async () => {
    const { fetchImpl } = ollama({ ps: [{ name: "llama3.2:latest", context_length: 32_768 }], show: { "llama3.2": "fail" } });
    expect(await readLoadedContext(OLLAMA, "llama3.2", env, fetchImpl)).toEqual({ contextWindow: 32_768, source: "ollama-ps", loaded: true }); // W9-showfail
  });

  it("W9 a model made local again after a cloud reading reads as local", async () => {
    const first = ollama({ show: { "fixture-model:big": cloudShow(131_072, { remote_model: "fixture-model:70b-cloud" }) } });
    await readLoadedContext(OLLAMA, "fixture-model:big", env, first.fetchImpl);
    const local = ollama({ show: { "fixture-model:big": localShow(131_072, 65_536) } });
    const relearned = await readLoadedContext(OLLAMA, "fixture-model:big", env, local.fetchImpl);
    expect(relearned).toEqual({ contextWindow: 65_536, maxContextWindow: 131_072, source: "ollama-show", loaded: false }); // W9-relearn
    expect(cachedHostContext(OLLAMA, "fixture-model:big")?.cloud).toBeUndefined();
    expect(cachedHostContext(OLLAMA, "fixture-model:big")?.contextWindow).toBe(65_536);
  });
});
