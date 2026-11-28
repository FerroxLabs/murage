// RC3 item 5: a catalog refresh must not hammer an owner's LAN Ollama host.
// Eight engines each merging local models used to probe every host twice
// (16 sockets). One refresh is now one scope: one probe per address, and a
// background refresh never probes a user-added server on its own.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLocalServerStore } from "../local-servers.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import {
  cachedLocalContext,
  clearLocalContextCacheForTests,
  configureLocalPinnedModels,
  contextWindowsFromPs,
  localContextWindow,
  localHost,
  mergeLocalInject,
  probeLocalInjects,
  probeLocalHosts,
  runInLocalProbeScope,
} from "./local-inject.ts";
import { ollamaContextCopyName, primeLocalContext, readLoadedContext } from "../local-server-probe.ts";
import { createLocalModelsRoute } from "../local-models.ts";
import type { DelegatedRequest } from "../route-delegation.ts";
import { ensurePiInjectModel } from "./pi.ts";

const ADDED = "http://127.0.0.1:19876";
const ENV = { VITEST: "true", MURAGE_PROBE_LOCAL_INJECT: "1" };
const BASE = { default: "keep", options: [{ id: "keep", label: "Keep" }] };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "murage-probe-scope-"));
  mkdirSync(join(root, "local-models"), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(root, "local-models", "local-servers.json"),
    JSON.stringify({
      version: 1,
      servers: [{ id: "srv_aabbccddeeff", name: "LAN", kind: "ollama", apiBase: `${ADDED}/v1`, createdAt: now, updatedAt: now }],
    }),
  );
  configureLocalServerStore(root);
  clearLocalContextCacheForTests();
});
afterEach(async () => {
  configureLocalServerStore(null);
  await removeTempDir(root);
});

function counting() {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(href);
    if (!href.startsWith(ADDED)) throw new TypeError("nothing listens here");
    const body = href.endsWith("/api/ps") ? { models: [] } : { object: "list", data: [{ id: "llama3:8b", object: "model" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { urls, fetchImpl };
}

const mergeEight = (fetchImpl: typeof fetch) =>
  Promise.all(Array.from({ length: 8 }, () => mergeLocalInject(BASE, ENV, fetchImpl, { driver: "piAgent" })));

describe("local probe scope", () => {
  it("a startup (background) refresh makes zero probes to user-added hosts", async () => {
    const { urls, fetchImpl } = counting();
    await runInLocalProbeScope(false, () => mergeEight(fetchImpl));
    expect(urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
  });

  it("one refresh makes at most one probe per host, however many engines merge", async () => {
    const { urls, fetchImpl } = counting();
    const merged = await runInLocalProbeScope(true, () => mergeEight(fetchImpl));
    const added = urls.filter((url) => url.startsWith(ADDED));
    // /v1/models + /api/ps for one Ollama host, once.
    expect(added.length).toBeLessThanOrEqual(2);
    expect(merged[0]!.options.some((option) => option.id === "srv_aabbccddeeff::llama3:8b")).toBe(true);
    for (const base of new Set(urls.map((url) => new URL(url).origin))) {
      const perPath = urls.filter((url) => url.startsWith(base));
      expect(new Set(perPath).size).toBe(perPath.length);
    }
  });

  it("a later background refresh lists the stored result without calling the host", async () => {
    const first = counting();
    await runInLocalProbeScope(true, () => mergeLocalInject(BASE, ENV, first.fetchImpl, { driver: "piAgent" }));
    const later = counting();
    const merged = await runInLocalProbeScope(false, () => mergeLocalInject(BASE, ENV, later.fetchImpl, { driver: "piAgent" }));
    expect(later.urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
    expect(merged.options.some((option) => option.id === "srv_aabbccddeeff::llama3:8b")).toBe(true);
  });

  it("boot and reload: zero probes to a user-added host, at most one per localhost address", async () => {
    const { urls, fetchImpl } = counting();
    const fake = makeFakeDriver();
    const originalCreate = fake.driver.create.bind(fake.driver);
    fake.driver.create = async (input) => {
      await mergeLocalInject(BASE, ENV, fetchImpl, { driver: "piAgent" });
      return originalCreate(input);
    };
    const registry = new ProviderRegistry([fake.driver]);
    const configs = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`e${i}`, { driver: "fake" }]));
    await registry.load(configs);
    await registry.reload(new Set(["e0", "e1", "e2"]), configs);
    expect(urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
    for (const origin of new Set(urls.map((url) => new URL(url).origin))) {
      const perPath = urls.filter((url) => url.startsWith(origin));
      // load and reload are two scopes: each path at most twice, never per driver.
      expect(perPath.length).toBeLessThanOrEqual(2 * new Set(perPath).size);
    }
  });

  // A bot's current model on a user-added host: a fresh boot (background scope,
  // no stored page) must still list it, with zero calls to the host, on every
  // engine that merges local models. A turn decodes the id from the stored
  // server, so it needs no listing.
  it.each(["piAgent", "kimi", "qwen", "hermes", "grok", "droid", "opencode-go", "openai-compat", "fuigo", "codex", "claude"])(
    "%s: a bot's current model on an added host is listed after a fresh boot without probing it",
    async (driver) => {
      const { urls, fetchImpl } = counting();
      const pinned = "srv_aabbccddeeff::llama3:8b";
      configureLocalPinnedModels(() => [pinned]);
      try {
        const merged = await runInLocalProbeScope(false, () => mergeLocalInject(BASE, ENV, fetchImpl, { driver }));
        expect(urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
        // codex and claude only offer a model whose tool test passed; none is stored here.
        if (driver !== "codex" && driver !== "claude") {
          expect(merged.options.some((option) => option.id === pinned)).toBe(true);
        }
      } finally {
        configureLocalPinnedModels(() => []);
      }
    },
  );
});

// M10 (1.0.23) P1/P2: a known-cloud model's /api/ps row never changes a local
// model's window and never overwrites its cloud reading. Ollama-shaped fixtures
// (ShowResponse remote_model/remote_host, ProcessResponse context_length).
describe("M10 Ollama cloud models on the probe path", () => {
  const SRV = "srv_aabbccddeeff";
  type Show = Record<string, unknown> | "fail";
  function ollama(options: { ps?: Array<{ name: string; context_length: number }>; tags?: string[]; show?: Record<string, Show> }) {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(href);
      if (!href.startsWith(ADDED)) throw new TypeError("nothing listens here");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (href.endsWith("/api/ps")) return json({ models: (options.ps ?? []).map((row) => ({ ...row, model: row.name })) });
      if (href.endsWith("/v1/models")) return json({ object: "list", data: (options.tags ?? []).map((id) => ({ id, object: "model" })) });
      if (href.endsWith("/api/show")) {
        const shown = options.show?.[String((JSON.parse(String(init?.body ?? "{}")) as { model?: unknown }).model)];
        return !shown || shown === "fail" ? json({ error: "show failed" }, 500) : json(shown);
      }
      return json({ error: "not found" }, 404);
    };
    return { urls, fetchImpl };
  }
  const remoteShow = (length: number) => ({ remote_model: "fixture-model:70b-cloud", remote_host: "https://ollama.com:443", model_info: { "fixture.context_length": length } });
  const host = () => localHost(SRV)!;
  const pageFor = async (fetchImpl: typeof fetch) => (await probeLocalHosts(ENV, fetchImpl)).find((page) => page.host.id === SRV)!;

  it("W3b an alias read as cloud stays out of the ps map, the base-name minimum and the cache", async () => {
    await readLoadedContext(host(), "fixture-model:big", ENV, ollama({ show: { "fixture-model:big": remoteShow(131_072) } }).fetchImpl);
    const listed = ollama({
      tags: ["fixture-model:big", "fixture-model:7b"],
      ps: [{ name: "fixture-model:big", context_length: 4_096 }, { name: "fixture-model:7b", context_length: 65_536 }],
      show: { "fixture-model:big": remoteShow(131_072) },
    });
    const page = await pageFor(listed.fetchImpl);
    expect(page.contexts.get("fixture-model")?.contextWindow).toBe(65_536); // W3b-probe
    expect(page.contexts.has("fixture-model:big")).toBe(false);
    expect(cachedLocalContext(SRV, "fixture-model:big")).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud" });
    const again = await readLoadedContext(host(), "fixture-model:big", ENV, listed.fetchImpl);
    expect(again).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud" });
    expect(listed.urls.filter((url) => url.endsWith("/api/show")).length).toBe(1);
  });

  it("W3b a known-cloud alias whose show then fails keeps its cloud memory through the next probe", async () => {
    await readLoadedContext(host(), "fixture-model:big", ENV, ollama({ show: { "fixture-model:big": remoteShow(131_072) } }).fetchImpl);
    const busy = ollama({
      tags: ["fixture-model:big", "fixture-model:7b"],
      ps: [{ name: "fixture-model:big", context_length: 4_096 }, { name: "fixture-model:7b", context_length: 65_536 }],
      show: { "fixture-model:big": "fail" },
    });
    await readLoadedContext(host(), "fixture-model:big", ENV, busy.fetchImpl);
    const page = await pageFor(busy.fetchImpl);
    expect(cachedLocalContext(SRV, "fixture-model:big")).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud", cloud: true }); // W3b-probe-showfail
    expect(page.contexts.get("fixture-model")?.contextWindow).toBe(65_536);
  });

  it("W5 a cloud-tagged ps row neither shrinks its local sibling nor fills the cache", async () => {
    const payload = { models: [{ name: "fixture-model:70b-cloud", model: "fixture-model:70b-cloud", context_length: 4_096 }, { name: "fixture-model:7b", model: "fixture-model:7b", context_length: 65_536 }] };
    const windows = contextWindowsFromPs(payload);
    expect(windows.get("fixture-model")).toBe(65_536); // W5-min
    expect(windows.has("fixture-model:70b-cloud")).toBe(false);
    const listed = ollama({ tags: ["fixture-model:70b-cloud", "fixture-model:7b"], ps: payload.models });
    await pageFor(listed.fetchImpl);
    expect(cachedLocalContext(SRV, "fixture-model:70b-cloud")?.source).not.toBe("ollama-ps");
  });

  it("W12 a picked cloud model carries its own window to the engines (Opus r2 M1)", async () => {
    await readLoadedContext(host(), "fixture-model:70b-cloud", ENV, ollama({ show: { "fixture-model:70b-cloud": remoteShow(131_072) } }).fetchImpl);
    const listed = ollama({
      tags: ["fixture-model:70b-cloud", "fixture-model:7b"],
      ps: [{ name: "fixture-model:70b-cloud", context_length: 4_096 }, { name: "fixture-model:7b", context_length: 65_536 }],
    });
    const merged = await mergeLocalInject(BASE, ENV, listed.fetchImpl, { driver: "piAgent" });
    const option = (id: string) => merged.options.find((row) => row.id === `${SRV}::${id}`);
    expect(option("fixture-model:70b-cloud")?.contextWindow).toBe(131_072); // W12-window
    expect(option("fixture-model:7b")?.contextWindow).toBe(65_536);
  });

  it("W13 a refresh that read the alias at 4k before its first test cannot override the cached cloud window (Astra High)", async () => {
    const listed = ollama({
      tags: ["fixture-model:big", "fixture-model:7b"],
      ps: [{ name: "fixture-model:big", context_length: 4_096 }, { name: "fixture-model:7b", context_length: 65_536 }],
      show: { "fixture-model:big": remoteShow(131_072) },
    });
    const refreshed = await runInLocalProbeScope(true, async () => {
      // The refresh's probe reads the alias at 4k: nothing yet says it is cloud.
      const page = await pageFor(listed.fetchImpl);
      expect(page.contexts.get("fixture-model:big")?.contextWindow).toBe(4_096);
      // The alias's first test lands while this refresh is still merging.
      await readLoadedContext(host(), "fixture-model:big", ENV, listed.fetchImpl);
      return probeLocalInjects(ENV, listed.fetchImpl);
    });
    const row = (id: string) => refreshed.find((entry) => entry.model === id);
    expect(row("fixture-model:big")?.contextWindow).toBe(131_072); // W13-window
    expect(row("fixture-model:7b")?.contextWindow).toBe(65_536);
    expect(cachedLocalContext(SRV, "fixture-model:big")).toMatchObject({ contextWindow: 131_072, source: "ollama-cloud", cloud: true }); // W13-cache
  });
});

// M10 r3 (Astra r2 High, local-inject.ts:105): the built-in Ollama address has
// two ids (ollama, local_ollama). The window an engine writer reads must be the
// one the test read, whichever id the pick carries: one reading per address.
describe("M10 one context reading per Ollama address", () => {
  const BUILTIN = "http://127.0.0.1:11434";
  const MODEL = "fixture-model:big";
  const cloudShow = { remote_model: "fixture-model:70b-cloud", remote_host: "https://ollama.com:443", model_info: { "fixture.context_length": 131_072 } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function builtin(show: () => Promise<Response>, rowContext?: number) {
    const fetchImpl: typeof fetch = async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith(BUILTIN)) throw new TypeError("nothing listens here");
      if (href.endsWith("/api/ps")) return json({ models: [{ name: MODEL, model: MODEL, context_length: 4_096 }] });
      if (href.endsWith("/v1/models")) return json({ object: "list", data: [{ id: MODEL, object: "model", ...(rowContext ? { context_length: rowContext } : {}) }] });
      if (href.endsWith("/api/show")) return show();
      return json({ error: "not found" }, 404);
    };
    return fetchImpl;
  }
  // A refresh reads the alias at 4k under both ids; its first test then runs on `ollama`.
  async function probedThenTestedOnOllama() {
    const fetchImpl = builtin(async () => json(cloudShow));
    await probeLocalHosts(ENV, fetchImpl);
    expect(localContextWindow("local_ollama", MODEL)).toBe(4_096);
    await readLoadedContext(localHost("ollama")!, MODEL, ENV, fetchImpl);
    return fetchImpl;
  }

  it("W14a a test on one built-in id sizes the other id with the cloud window", async () => {
    await probedThenTestedOnOllama();
    expect(localContextWindow("local_ollama", MODEL)).toBe(131_072); // W14a-window
    expect(cachedLocalContext("local_ollama", MODEL)).toMatchObject({ source: "ollama-cloud", cloud: true });
  });

  it("W14b a Pi turn on local_ollama writes the cloud window to models.json, not the stale 4k", async () => {
    const fetchImpl = await probedThenTestedOnOllama();
    const pick = `local_ollama::${MODEL}`;
    const env = { ...ENV, HOME: root, USERPROFILE: root };
    // The turn path (pi.ts:970): prime the reading, then upsert models.json.
    await primeLocalContext(pick, env, fetchImpl);
    expect(ensurePiInjectModel(pick, env)).toEqual({ provider: "local_ollama", modelId: MODEL });
    const pi = JSON.parse(readFileSync(join(root, ".pi", "agent", "models.json"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }>;
    };
    const row = pi.providers.local_ollama!.models.find((entry) => entry.id === MODEL);
    expect(row?.contextWindow).toBe(131_072); // W14b-pi
  });

  it("W16 a catalog row's length cannot overwrite the cloud reading of a tested model (Astra r3 High)", async () => {
    await probedThenTestedOnOllama();
    // The next refresh lists the alias with a 4k context_length on its /v1/models row.
    await probeLocalHosts(ENV, builtin(async () => json(cloudShow), 4_096));
    expect(localContextWindow("ollama", MODEL)).toBe(131_072); // W16-window
    expect(cachedLocalContext("ollama", MODEL)).toMatchObject({ source: "ollama-cloud", cloud: true });
  });

  it("W17 a local sibling's base-name minimum cannot overwrite a bare name read as cloud (Astra r3 pass-2 High)", async () => {
    const BARE = "fixture-model";
    const fetchImpl: typeof fetch = async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith(BUILTIN)) throw new TypeError("nothing listens here");
      if (href.endsWith("/api/ps")) return json({ models: [{ name: `${BARE}:7b`, model: `${BARE}:7b`, context_length: 4_096 }] });
      if (href.endsWith("/v1/models")) return json({ object: "list", data: [{ id: BARE, object: "model" }, { id: `${BARE}:7b`, object: "model" }] });
      if (href.endsWith("/api/show")) return json(cloudShow);
      return json({ error: "not found" }, 404);
    };
    await readLoadedContext(localHost("ollama")!, BARE, ENV, fetchImpl);
    // The refresh sees only the local sibling running at 4k.
    await probeLocalHosts(ENV, fetchImpl);
    expect(localContextWindow("ollama", BARE)).toBe(131_072); // W17-window
    expect(localContextWindow("local_ollama", `${BARE}:7b`)).toBe(4_096);
  });

  it("W18 a read whose show failed while the first test landed keeps the cloud reading (Astra r3 pass-3 High)", async () => {
    const BARE = "fixture-model";
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let shows = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith(BUILTIN)) throw new TypeError("nothing listens here");
      if (href.endsWith("/api/ps")) return json({ models: [{ name: `${BARE}:7b`, model: `${BARE}:7b`, context_length: 4_096 }] });
      if (href.endsWith("/api/show")) {
        shows += 1;
        if (shows > 1) return json(cloudShow);
        await held;
        return json({ error: "show failed" }, 500);
      }
      return json({ error: "not found" }, 404);
    };
    // Started before anything says cloud; its show will fail and ps lists only the :7b sibling.
    const early = readLoadedContext(localHost("ollama")!, BARE, ENV, fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await readLoadedContext(localHost("ollama")!, BARE, ENV, fetchImpl);
    release();
    await early;
    expect(localContextWindow("ollama", BARE)).toBe(131_072); // W18-window
    expect(cachedLocalContext("local_ollama", BARE)).toMatchObject({ source: "ollama-cloud", cloud: true });
  });
});

// ASTRA 49db4e1188 High (local-inject.ts:98): a cache write keyed after its
// await. One row per writer site in SITES.md: the reply is read from the added
// server's OLD address and lands after the real PATCH moved the server.
describe("M10 a reading is cached only under the address it was read from", () => {
  const SERVER = "srv_aabbccddeeff";
  const MOVED = "http://127.0.0.1:19877";
  const MODEL = "fixture-model:8b";
  const copyName = ollamaContextCopyName(MODEL, 32_768);
  const routeEnv = () => ({ ...ENV, HOME: root, USERPROFILE: root });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const request = (method: string, path: string, body?: unknown): DelegatedRequest => {
    const url = new URL(`http://127.0.0.1${path}`);
    return { method, path: url.pathname, url, headers: {}, desktop: true, readBody: async () => body };
  };
  // The old address answers 4k, the moved one 32k; `hold` parks one old-address reply.
  function twoAddresses(hold: (href: string, body: unknown) => boolean) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let parked!: () => void;
    const reached = new Promise<void>((resolve) => { parked = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const shown = (body as { model?: string } | undefined)?.model ?? MODEL;
      if (href.startsWith(ADDED)) {
        if (hold(href, body)) {
          parked();
          await held;
        }
        if (href.endsWith("/api/ps")) return json({ models: [{ name: MODEL, model: MODEL, context_length: 4_096 }] });
        if (href.endsWith("/api/show")) return json({ parameters: `num_ctx ${shown === copyName ? 32_768 : 4_096}`, model_info: {} });
        if (href.endsWith("/api/version")) return json({ version: "0.12.0" });
        if (href.endsWith("/api/create")) return json({ status: "success" });
        if (href.endsWith("/v1/models")) return json({ object: "list", data: [{ id: MODEL, object: "model" }] });
        return json({ error: "not found" }, 404);
      }
      if (href.startsWith(MOVED)) {
        if (href.endsWith("/api/ps")) return json({ models: [] });
        if (href.endsWith("/api/show")) return json({ parameters: `num_ctx ${shown === MODEL ? 32_768 : 4_096}`, model_info: {} });
        if (href.endsWith("/v1/models")) return json({ object: "list", data: [{ id: MODEL, object: "model" }] });
        return json({ error: "not found" }, 404);
      }
      throw new TypeError("nothing listens here");
    };
    return { fetchImpl, reached, release };
  }
  const rows = [
    {
      site: "S1 probeHostGroup (catalog refresh)",
      model: MODEL,
      hold: (href: string) => href.endsWith("/api/ps"),
      start: (fetchImpl: typeof fetch) => probeLocalHosts(ENV, fetchImpl),
    },
    {
      site: "S2 readLoadedContext (Local models test route)",
      model: MODEL,
      hold: (href: string) => href.endsWith("/api/show"),
      start: (fetchImpl: typeof fetch) =>
        createLocalModelsRoute({ fetchImpl, env: routeEnv, probeTimeoutMs: 500 })(request("POST", `/api/local-models/servers/${SERVER}/test`, { model: MODEL })),
    },
    {
      site: "S3 createOllamaContextCopy (copy route)",
      model: copyName,
      hold: (href: string, body: unknown) => href.endsWith("/api/show") && (body as { model?: string } | undefined)?.model === copyName,
      start: (fetchImpl: typeof fetch) =>
        createLocalModelsRoute({ fetchImpl, env: routeEnv })(request("POST", `/api/local-models/servers/${SERVER}/ollama-context-copy`, { model: MODEL, numCtx: 32_768 })),
    },
  ];

  it.each(rows)("W19 $site: a reply from the old address lands after the edit and is not the moved server's window", async ({ model, hold, start }) => {
    const { fetchImpl, reached, release } = twoAddresses(hold);
    const inFlight = start(fetchImpl);
    await reached;
    const edited = await createLocalModelsRoute({ fetchImpl, env: routeEnv })(request("PATCH", `/api/local-models/servers/${SERVER}`, { address: MOVED }));
    expect(edited.status).toBe(200);
    expect(localHost(SERVER)?.baseUrl).toBe(`${MOVED}/v1`);
    release();
    await inFlight;
    expect(localContextWindow(SERVER, model)).toBeUndefined(); // W19-window
    // Positive control: a read of the moved server itself is still cached.
    await readLoadedContext(localHost(SERVER)!, model, ENV, fetchImpl);
    expect(localContextWindow(SERVER, model)).toBe(model === MODEL ? 32_768 : 4_096); // W19-fresh
  });

  it("W19c a reply that started before the server moved away and back does not replace the newer reading (address generation)", async () => {
    // The old address first answers 4k (that reply is held), then restarts and answers 8k.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let parked!: () => void;
    const reached = new Promise<void>((resolve) => { parked = resolve; });
    let psCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!href.startsWith(ADDED) && !href.startsWith(MOVED)) throw new TypeError("nothing listens here");
      if (href.endsWith("/v1/models")) return json({ object: "list", data: [{ id: MODEL, object: "model" }] });
      if (href.startsWith(MOVED) || !href.endsWith("/api/ps")) return href.endsWith("/api/ps") ? json({ models: [] }) : json({ error: "not found" }, 404);
      psCalls += 1;
      if (psCalls === 1) {
        parked();
        await held;
        return json({ models: [{ name: MODEL, model: MODEL, context_length: 4_096 }] });
      }
      return json({ models: [{ name: MODEL, model: MODEL, context_length: 8_192 }] });
    };
    const probe = probeLocalHosts(ENV, fetchImpl);
    await reached;
    const patch = createLocalModelsRoute({ fetchImpl, env: routeEnv });
    expect((await patch(request("PATCH", `/api/local-models/servers/${SERVER}`, { address: MOVED }))).status).toBe(200);
    expect((await patch(request("PATCH", `/api/local-models/servers/${SERVER}`, { address: ADDED }))).status).toBe(200);
    expect(localContextWindow(SERVER, MODEL)).toBe(8_192);
    release();
    await probe;
    expect(localContextWindow(SERVER, MODEL)).toBe(8_192); // W19c-window
  });

  it("W20 a catalog refresh whose page came from the old address does not size the moved server's row with it", async () => {
    const { fetchImpl, reached, release } = twoAddresses((href) => href.endsWith("/api/ps"));
    const merged = mergeLocalInject(BASE, ENV, fetchImpl, { driver: "piAgent" });
    await reached;
    const edited = await createLocalModelsRoute({ fetchImpl, env: routeEnv })(request("PATCH", `/api/local-models/servers/${SERVER}`, { address: MOVED }));
    expect(edited.status).toBe(200);
    release();
    const row = (await merged).options.find((option) => option.id === `${SERVER}::${MODEL}`);
    expect(row).toBeDefined();
    expect(row?.contextWindow).toBeUndefined(); // W20-catalog
    // Positive control: once the moved server is read, its row carries its own window.
    await readLoadedContext(localHost(SERVER)!, MODEL, ENV, fetchImpl);
    const next = (await mergeLocalInject(BASE, ENV, fetchImpl, { driver: "piAgent" })).options.find((option) => option.id === `${SERVER}::${MODEL}`);
    expect(next?.contextWindow).toBe(32_768); // W20-fresh
  });

  it("W19b a Pi turn on the moved server reads the new address, not the old server's 4k", async () => {
    const { fetchImpl, reached, release } = twoAddresses((href) => href.endsWith("/api/ps"));
    const probe = probeLocalHosts(ENV, fetchImpl);
    await reached;
    const edited = await createLocalModelsRoute({ fetchImpl, env: routeEnv })(request("PATCH", `/api/local-models/servers/${SERVER}`, { address: MOVED }));
    expect(edited.status).toBe(200);
    release();
    await probe;
    const pick = `${SERVER}::${MODEL}`;
    const env = { ...ENV, HOME: root, USERPROFILE: root };
    // The turn path (pi.ts:970): prime the reading, then upsert models.json.
    await primeLocalContext(pick, env, fetchImpl);
    expect(ensurePiInjectModel(pick, env)).toEqual({ provider: SERVER, modelId: MODEL });
    const pi = JSON.parse(readFileSync(join(root, ".pi", "agent", "models.json"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }>;
    };
    const row = pi.providers[SERVER]!.models.find((entry) => entry.id === MODEL);
    expect(row?.contextWindow).toBe(32_768); // W19b-pi
  });
});
