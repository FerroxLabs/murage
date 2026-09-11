// /api/local-models end to end against fake servers on loopback, plus the
// store's read-time validation, detection labels, the engine writers that
// accept a user-added server, removal cleanup and the Ollama context helper.
//
// Every request goes through `guardedFetch`, which only reaches the fake
// servers started here — the built-in detection ports on this machine
// (11434, 1234, 8080, 8000, 30000 …) are never contacted.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCAL_DETECTION_TARGETS, type LocalModelsListResponse, type LocalServerView } from "../shared/local-models.ts";
import { requiresDesktopAuthority } from "./desktop-policy.ts";
import { ensureDroidInjectModel } from "./drivers/acp/droid.ts";
import { ensureFuigoLocalModel, fuigoLocalSlug } from "./drivers/acp/fuigo.ts";
import { ensureGrokInjectSlug } from "./drivers/acp/grok.ts";
import { ensureHermesInjectProvider } from "./drivers/acp/hermes.ts";
import { ensureKimiInjectAlias } from "./drivers/acp/kimi.ts";
import { ensureOpenCodeInjectModel } from "./drivers/acp/opencode-go.ts";
import { ensureQwenInjectModel } from "./drivers/acp/qwen.ts";
import {
  applyClaudeInject,
  clearLocalContextCacheForTests,
  decodeInjectId,
  localHost,
  mergeLocalInject,
  probeLocalInjects,
} from "./drivers/local-inject.ts";
import { ensurePiInjectModel } from "./drivers/pi.ts";
import { configureLocalServerStore, readLocalServers } from "./local-servers.ts";
import { createLocalModelsRoute } from "./local-models.ts";
import { detectLocalServerKind, probeHost } from "./local-server-probe.ts";
import type { DelegatedRequest } from "./route-delegation.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const KEY = "sk-seanbeast-local-key";
const MODEL = "qwen3.8-27b";

const servers: Server[] = [];
const allowed = new Set<string>();
const guardedFetch: typeof fetch = (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!allowed.has(new URL(href).origin)) return Promise.reject(new TypeError("fetch failed (blocked by test)"));
  return fetch(input, init);
};

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "murage-local-models-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  configureLocalServerStore(join(root, "data"));
  clearLocalContextCacheForTests();
});
afterEach(async () => {
  configureLocalServerStore(null);
  clearLocalContextCacheForTests();
  allowed.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await removeTempDir(root);
});

const env = () => ({ HOME: home, USERPROFILE: home, VITEST: "true", MURAGE_PROBE_LOCAL_INJECT: "1" });

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => boolean | void;

async function fake(handler: Handler): Promise<{ root: string; auth: Array<string | undefined>; calls: Array<{ path: string; body: Record<string, unknown> }> }> {
  const auth: Array<string | undefined> = [];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    auth.push(req.headers.authorization);
    const body = await readBody(req);
    calls.push({ path: req.url ?? "", body });
    if (handler(req, body, res) !== true && !res.headersSent) send(res, 404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  allowed.add(origin);
  return { root: origin, auth, calls };
}

/** A llama-server with `-c 65536 --jinja` and one loaded model. */
function llamaServer() {
  return fake((req, body, res) => {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    switch (req.url) {
      case "/props":
        return (send(res, 200, { default_generation_settings: { n_ctx: 65_536 }, model_path: "D:/models/qwen.gguf", total_slots: 1 }), true);
      case "/health":
        return (send(res, 200, { status: "ok" }), true);
      case "/v1/models":
        return (send(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "llamacpp" }] }), true);
      case "/v1/chat/completions":
        if (messages.some((message) => message.role === "tool")) {
          return (send(res, 200, { choices: [{ message: { role: "assistant", content: "17°C and light rain." } }] }), true);
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }] })}\n\n`);
          res.end("data: [DONE]\n\n");
          return true;
        }
        return (
          send(res, 200, {
            choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }],
            usage: { prompt_tokens: tools.length * 190 },
          }),
          true
        );
      case "/v1/messages":
        return (send(res, 200, { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] }), true);
      case "/v1/responses":
        return (send(res, 200, { output: [{ type: "function_call", name: "get_weather", arguments: '{"city":"Paris"}' }] }), true);
    }
  });
}

function request(method: string, path: string, body?: unknown, desktop = true): DelegatedRequest {
  const url = new URL(`http://127.0.0.1${path}`);
  return { method, path: url.pathname, url, headers: {}, desktop, readBody: async () => body };
}

const route = () => createLocalModelsRoute({ fetchImpl: guardedFetch, env, probeTimeoutMs: 5_000 });

async function addSeanBeast(localRoot: string): Promise<LocalServerView> {
  const result = await route()(request("POST", "/api/local-models/servers", { address: localRoot, name: "SeanBeast", apiKey: KEY }));
  expect(result.status).toBe(201);
  return (result.body as { server: LocalServerView }).server;
}

describe("/api/local-models authority", () => {
  it("is desktop-only: hidden from other surfaces and listed in DESKTOP_AUTHORITY_ROUTES", async () => {
    expect((await route()(request("GET", "/api/local-models", undefined, false))).status).toBe(404);
    expect((await route()(request("POST", "/api/local-models/servers", { address: "127.0.0.1:1" }, false))).status).toBe(404);
    for (const [method, path] of [
      ["GET", "/api/local-models"],
      ["POST", "/api/local-models/servers"],
      ["PATCH", "/api/local-models/servers/srv_abcdef012345"],
      ["DELETE", "/api/local-models/servers/srv_abcdef012345"],
      ["POST", "/api/local-models/servers/srv_abcdef012345/test"],
      ["GET", "/api/local-models/preflight"],
    ] as const) {
      expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
    }
    expect(requiresDesktopAuthority("GET", "/api/local-modelsx")).toBe(false);
  });
});

describe("Local models list and add (spec V1, A1)", () => {
  it("always answers, saying where it looked when nothing runs", async () => {
    const result = await route()(request("GET", "/api/local-models"));
    expect(result.status).toBe(200);
    const body = result.body as LocalModelsListResponse;
    expect(body.servers).toEqual([]);
    expect(body.looked).toEqual(LOCAL_DETECTION_TARGETS);
    expect(body.looked.map((target) => target.address)).toContain("127.0.0.1:8080");
  });

  it("adds a server, auto-detects llama.cpp, reads its context and never echoes the key", async () => {
    const llama = await llamaServer();
    const result = await route()(request("POST", "/api/local-models/servers", { address: llama.root, name: "SeanBeast", apiKey: KEY }));
    expect(result.status).toBe(201);
    const { server } = result.body as { server: LocalServerView };
    expect(server).toMatchObject({
      kind: "llamacpp",
      label: "llama.cpp on SeanBeast",
      address: `${llama.root}/v1`,
      source: "added",
      editable: true,
      hasKey: true,
      status: "running",
    });
    expect(server.id).toMatch(/^srv_[a-z0-9]+$/);
    expect(server.models).toEqual([
      expect.objectContaining({ id: `${server.id}::${MODEL}`, model: MODEL, loaded: true, context: { contextWindow: 65_536, source: "llamacpp-props", loaded: true } }),
    ]);
    expect(JSON.stringify(result.body)).not.toContain(KEY);
    // The key reaches exactly this origin, and sits in a 0600 file on disk.
    expect(new Set(llama.auth)).toEqual(new Set([`Bearer ${KEY}`]));
    const file = join(root, "data", "local-models", "local-servers.json");
    expect(readFileSync(file, "utf8")).toContain(KEY);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const listed = (await route()(request("GET", "/api/local-models"))).body as LocalModelsListResponse;
    expect(listed.servers.map((row) => row.id)).toEqual([server.id]);
  });

  it("refuses http to a public host, credentials in the address, and duplicates", async () => {
    const llama = await llamaServer();
    const add = (body: unknown) => route()(request("POST", "/api/local-models/servers", body));
    expect(await add({ address: "http://gpu.example.com:8080" })).toMatchObject({ status: 400, body: { code: "https-required" } });
    expect(await add({ address: "http://me:pw@127.0.0.1:9" })).toMatchObject({ status: 400, body: { code: "credentials-in-address" } });
    expect(await add({ address: "127.0.0.1:11434" })).toMatchObject({ status: 409, body: { code: "duplicate-server" } });
    expect(await add({ address: llama.root, apiKey: "has space" })).toMatchObject({ status: 400, body: { code: "invalid-key" } });
    await addSeanBeast(llama.root);
    expect(await add({ address: `${llama.root}/v1/` })).toMatchObject({ status: 409, body: { code: "duplicate-server" } });
  });

  it("stores an unreachable server as not answering rather than refusing it", async () => {
    const result = await route()(request("POST", "/api/local-models/servers", { address: "192.168.77.5:8080", kind: "vllm" }));
    expect(result.status).toBe(201);
    expect((result.body as { server: LocalServerView }).server).toMatchObject({ kind: "vllm", status: "not-answering", models: [], hasKey: false });
  });
});

describe("user-added servers are the inject allowlist (spec A2 trust boundary)", () => {
  it("decodes a pick for an added server and drops a tampered entry on read", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    expect(decodeInjectId(`${server.id}::${MODEL}`)).toEqual({ host: server.id, model: MODEL });
    expect(localHost(server.id)).toMatchObject({ baseUrl: `${llama.root}/v1`, apiKey: KEY, label: "llama.cpp on SeanBeast", source: "added" });

    const file = join(root, "data", "local-models", "local-servers.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { servers: unknown[] };
    saved.servers.push(
      { id: "srv_000000000001", name: "evil", kind: "openai", apiBase: "http://evil.example.com/v1", createdAt: 1, updatedAt: 1 },
      { id: "srv_000000000002", name: "odd", kind: "openai", apiBase: "http://127.0.0.1:9/v1?x=1", createdAt: 1, updatedAt: 1 },
      { id: "../../etc", name: "path", kind: "openai", apiBase: "http://127.0.0.1:9/v1", createdAt: 1, updatedAt: 1 },
    );
    writeFileSync(file, JSON.stringify(saved));
    expect(readLocalServers().map((row) => row.id)).toEqual([server.id]);
    expect(decodeInjectId("srv_000000000001::m")).toBeNull();
    expect(decodeInjectId("srv_000000000002::m")).toBeNull();
    // An unconfigured store (tests, library imports) knows no user servers.
    configureLocalServerStore(null);
    expect(decodeInjectId(`${server.id}::${MODEL}`)).toBeNull();
  });
});

describe("Test before trust (spec T1, E3)", () => {
  it("runs the probe, caches it, and only then offers the model to Codex and Claude Code", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    const id = `${server.id}::${MODEL}`;
    const base = { default: "keep", options: [{ id: "keep", label: "Keep" }] };
    expect((await mergeLocalInject(base, env(), guardedFetch, { driver: "piAgent" })).options.some((o) => o.id === id)).toBe(true);
    expect((await mergeLocalInject(base, env(), guardedFetch, { driver: "codex" })).options.some((o) => o.id === id)).toBe(false);
    expect((await mergeLocalInject(base, env(), guardedFetch, { driver: "claudeAgent" })).options.some((o) => o.id === id)).toBe(false);

    const tested = await route()(request("POST", `/api/local-models/servers/${server.id}/test`, { model: MODEL }));
    expect(tested.status).toBe(200);
    const body = tested.body as { test: { outcome: string; surfaces: Record<string, boolean>; context?: { contextWindow?: number } }; engines: string[] };
    expect(body.test.outcome).toBe("tools-work");
    expect(body.test.context?.contextWindow).toBe(65_536);
    expect(body.engines).toEqual(expect.arrayContaining(["codex", "claudeAgent", "fuigoAgent", "piAgent"]));

    expect((await mergeLocalInject(base, env(), guardedFetch, { driver: "codex" })).options.some((o) => o.id === id)).toBe(true);
    expect((await mergeLocalInject(base, env(), guardedFetch, { driver: "claudeAgent" })).options.some((o) => o.id === id)).toBe(true);
    const listed = (await route()(request("GET", "/api/local-models"))).body as LocalModelsListResponse;
    expect(listed.servers[0]!.models[0]!.test?.outcome).toBe("tools-work");
  });

  it("refuses a malformed model id and an unknown server", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    expect(await route()(request("POST", `/api/local-models/servers/${server.id}/test`, { model: "bad id" }))).toMatchObject({ status: 400, body: { code: "invalid-model" } });
    expect(await route()(request("POST", "/api/local-models/servers/srv_ffffffffffff/test", { model: MODEL }))).toMatchObject({ status: 404 });
  });

  it("sets the local-gateway flags when Claude Code runs on a local model", () => {
    const envOut: Record<string, string | undefined> = {};
    applyClaudeInject(envOut, "ollama::qwen3:8b");
    expect(envOut.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(envOut.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(envOut.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
  });
});

describe("context preflight route (spec T2)", () => {
  it("uses the probed window and the engine's prompt estimate", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    const result = await route()(request("GET", `/api/local-models/preflight?model=${encodeURIComponent(`${server.id}::${MODEL}`)}&engine=claudeAgent`));
    expect(result).toMatchObject({ status: 200, body: { status: "ok", contextWindow: 65_536, promptTokens: 30_000 } });
    const tight = await route()(request("GET", `/api/local-models/preflight?model=${encodeURIComponent(`${server.id}::${MODEL}`)}&promptTokens=50000`));
    expect(tight.body).toMatchObject({ status: "tight" });
  });
});

describe("engine writers accept an added server and remove what they wrote (spec E2, A3)", () => {
  it("writes every engine entry with the probed window, then removes only those on delete", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    const pick = `${server.id}::${MODEL}`;
    const apiBase = `${llama.root}/v1`;
    const writerEnv = { HOME: home, USERPROFILE: home };

    // Grok's writer expects the CLI's own home to exist, as it does on an install.
    mkdirSync(join(home, ".grok"), { recursive: true });
    // A user's own provider must survive the cleanup.
    mkdirSync(join(home, ".qwen"), { recursive: true });
    writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ modelProviders: { openai: [{ id: "mine", baseUrl: "https://api.example.com/v1", envKey: "MINE" }] } }));

    expect(ensureQwenInjectModel(pick, writerEnv)).toBe(MODEL);
    expect(ensurePiInjectModel(pick, writerEnv)).toEqual({ provider: server.id, modelId: MODEL });
    const slug = ensureFuigoLocalModel(pick, writerEnv);
    expect(slug).toBe(fuigoLocalSlug(localHost(server.id)!, MODEL));
    ensureKimiInjectAlias(pick, writerEnv);
    ensureHermesInjectProvider(pick, writerEnv);
    ensureDroidInjectModel(pick, writerEnv);
    ensureOpenCodeInjectModel(pick, writerEnv);
    ensureGrokInjectSlug(pick, writerEnv);

    const pi = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string; compat: Record<string, unknown>; models: Array<{ contextWindow: number; maxTokens: number }> }>;
    };
    expect(pi.providers[server.id]!.baseUrl).toBe(apiBase);
    expect(pi.providers[server.id]!.models[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 16_384 });
    expect(pi.providers[server.id]!.compat).toMatchObject({ supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" });
    expect(readFileSync(join(home, ".kimi-code", "config.toml"), "utf8")).toContain("max_context_size = 65536");
    const fuigoToml = readFileSync(join(home, ".fuigo", "config.toml"), "utf8");
    expect(fuigoToml).toContain(`[model."${slug}"]`);
    expect(fuigoToml).toContain(`base_url = "${apiBase}"`);
    expect(fuigoToml).toContain('api_backend = "chat_completions"');
    expect(fuigoToml).toContain("context_window = 65536");
    expect(fuigoToml).not.toContain(KEY);

    const removed = await route()(request("DELETE", `/api/local-models/servers/${server.id}`));
    expect(removed.status).toBe(200);
    const cleanup = (removed.body as { cleanup: Array<{ engine: string; status: string }> }).cleanup;
    expect(Object.fromEntries(cleanup.map((row) => [row.engine, row.status]))).toEqual({
      piAgent: "removed",
      qwenAgent: "removed",
      opencodeGo: "removed",
      hermesAgent: "removed",
      droidAgent: "removed",
      kimiAgent: "removed",
      grokAgent: "removed",
      fuigoAgent: "removed",
    });
    for (const file of [
      join(home, ".pi", "agent", "models.json"),
      join(home, ".qwen", "settings.json"),
      join(home, ".hermes", "config.yaml"),
      join(home, ".factory", "settings.json"),
      join(home, ".kimi-code", "config.toml"),
      join(home, ".grok", "config.toml"),
      join(home, ".fuigo", "config.toml"),
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toContain(apiBase);
    }
    expect(readFileSync(join(home, ".qwen", "settings.json"), "utf8")).toContain("https://api.example.com/v1");
    expect(decodeInjectId(pick)).toBeNull();
    expect(readLocalServers()).toEqual([]);
  });

  it("refuses to rewrite an unreadable engine config during cleanup and still removes the server", async () => {
    if (process.platform === "win32") return; // POSIX modes make the file unreadable
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    ensureKimiInjectAlias(`${server.id}::${MODEL}`, { HOME: home });
    const kimi = join(home, ".kimi-code", "config.toml");
    const before = readFileSync(kimi);
    chmodSync(kimi, 0o000);
    try {
      const removed = await route()(request("DELETE", `/api/local-models/servers/${server.id}`));
      const rows = (removed.body as { cleanup: Array<{ engine: string; status: string; message?: string }> }).cleanup;
      expect(rows.find((row) => row.engine === "kimiAgent")).toMatchObject({ status: "refused" });
      expect(rows.find((row) => row.engine === "kimiAgent")?.message).toContain("left it unchanged");
    } finally {
      chmodSync(kimi, 0o600);
    }
    expect(readFileSync(kimi)).toEqual(before);
    expect(readLocalServers()).toEqual([]);
  });

  it("a new key or address clears the stale engine entries; a rename does not", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    ensureKimiInjectAlias(`${server.id}::${MODEL}`, { HOME: home });
    const renamed = await route()(request("PATCH", `/api/local-models/servers/${server.id}`, { name: "Beast" }));
    expect(renamed).toMatchObject({ status: 200, body: { server: { label: "llama.cpp on Beast" }, cleanup: [] } });
    const rekeyed = await route()(request("PATCH", `/api/local-models/servers/${server.id}`, { apiKey: "sk-new-key" }));
    const cleanup = (rekeyed.body as { cleanup: Array<{ engine: string; status: string }> }).cleanup;
    expect(cleanup.find((row) => row.engine === "kimiAgent")?.status).toBe("removed");
    expect(localHost(server.id)?.apiKey).toBe("sk-new-key");
  });
});

describe("detection labels and loaded context (spec A2, T2)", () => {
  const stub = (responses: Record<string, unknown>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const hit = Object.keys(responses).find((suffix) => href.endsWith(suffix));
      return hit ? new Response(JSON.stringify(responses[hit]), { status: 200 }) : new Response("nope", { status: 500 });
    }) as typeof fetch;

  it("labels a llama-server on :8080 as llama.cpp, not oMLX, with its n_ctx", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":8080/props": { default_generation_settings: { n_ctx: 32_768 }, model_path: "m.gguf" },
      ":8080/v1/models": { data: [{ id: "gemma-4-31b" }] },
    }));
    expect(rows).toEqual([
      expect.objectContaining({ id: "llamacpp::gemma-4-31b", label: "gemma-4-31b (llama.cpp)", loaded: true, contextWindow: 32_768 }),
    ]);
  });

  it("still labels a real oMLX on :8080 as oMLX", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":8080/v1/models/status": { models: [{ id: "mlx-model", loaded: true }] },
      ":8080/v1/models": { data: [{ id: "mlx-model" }] },
    }));
    expect(rows.map((row) => row.id)).toEqual(["omlx::mlx-model"]);
  });

  it("finds vLLM on :8000 and SGLang on :30000 with max_model_len", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":8000/v1/models": { data: [{ id: "Qwen/Qwen3-Coder-30B", owned_by: "vllm", max_model_len: 32_000 }] },
      ":30000/v1/models": { data: [{ id: "glm-4.7", owned_by: "sglang", max_model_len: 131_072 }] },
    }));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "vllm::Qwen/Qwen3-Coder-30B", label: "Qwen/Qwen3-Coder-30B (vLLM)", contextWindow: 32_000, loaded: true }),
      expect.objectContaining({ id: "sglang::glm-4.7", label: "glm-4.7 (SGLang)", contextWindow: 131_072 }),
    ]));
  });

  it("reads LM Studio's loaded context and Ollama's native /api when /v1 is off", async () => {
    const rows = await probeLocalInjects(env(), stub({
      ":1234/v1/models": { data: [{ id: "qwen" }] },
      ":1234/api/v0/models": { data: [{ id: "qwen", state: "loaded", loaded_context_length: 8_192, max_context_length: 262_144 }] },
      ":11434/api/tags": { models: [{ name: "llama3.2:latest" }] },
      ":11434/api/ps": { models: [{ name: "llama3.2:latest", context_length: 4_096 }] },
    }));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "lmstudio::qwen", loaded: true, contextWindow: 8_192 }),
      expect.objectContaining({ id: "ollama::llama3.2:latest", loaded: true, contextWindow: 4_096 }),
    ]));
  });

  it.each([
    ["ollama", { "/api/version": { version: "0.14.2" }, "/v1/models": { data: [{ id: "qwen3:8b" }] } }],
    ["lmstudio", { "/api/v0/models": { data: [{ id: "qwen", state: "loaded" }] }, "/v1/models": { data: [{ id: "qwen" }] } }],
    ["llamacpp", { "/props": { default_generation_settings: { n_ctx: 8192 } }, "/v1/models": { data: [{ id: "m" }] } }],
    ["sglang", { "/get_model_info": { model_path: "glm" }, "/v1/models": { data: [{ id: "glm" }] } }],
    ["vllm", { "/v1/models": { data: [{ id: "q", owned_by: "vllm" }] } }],
    ["omlx", { "/v1/models/status": { models: [] }, "/v1/models": { data: [{ id: "m" }] } }],
    ["openai", { "/v1/models": { data: [{ id: "m" }] } }],
  ] as const)("auto-detects %s from its own endpoints", async (kind, responses) => {
    const detected = await detectLocalServerKind(probeHost("http://127.0.0.1:18080/v1", undefined), env(), stub(responses));
    expect(detected).toMatchObject({ reachable: true, kind });
  });

  it("reports nothing answering as unreachable", async () => {
    const detected = await detectLocalServerKind(probeHost("http://127.0.0.1:18080/v1", undefined), env(), (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(detected).toEqual({ reachable: false, kind: null, models: [] });
  });
});

describe("Ollama: create a 64k copy (spec T3)", () => {
  function ollama(version: string, options: { honourCreate?: boolean } = {}) {
    const created = new Set<string>();
    return fake((req, body, res) => {
      switch (req.url) {
        case "/api/version":
          return (send(res, 200, { version }), true);
        case "/api/tags":
          return (send(res, 200, { models: [{ name: "qwen3:8b" }] }), true);
        case "/v1/models":
          return (send(res, 200, { data: [{ id: "qwen3:8b" }] }), true);
        case "/api/ps":
          return (send(res, 200, { models: [] }), true);
        case "/api/create":
          if (options.honourCreate !== false) created.add(String(body.model));
          return (send(res, 200, { status: "success" }), true);
        case "/api/show":
          return (send(res, 200, { parameters: created.has(String(body.model)) ? "num_ctx                        65536" : "", model_info: { "qwen3.context_length": 40_960 } }), true);
      }
    });
  }

  async function addOllama(localRoot: string): Promise<string> {
    const result = await route()(request("POST", "/api/local-models/servers", { address: localRoot, name: "desktop" }));
    expect((result.body as { server: LocalServerView }).server.kind).toBe("ollama");
    return (result.body as { server: LocalServerView }).server.id;
  }

  it("creates the copy with from + parameters.num_ctx and verifies it", async () => {
    const server = await ollama("0.14.2");
    const id = await addOllama(server.root);
    const result = await route()(request("POST", `/api/local-models/servers/${id}/ollama-context-copy`, { model: "qwen3:8b" }));
    expect(result).toMatchObject({ status: 200, body: { status: "created", model: "qwen3:8b-64k", numCtx: 65_536, verified: true } });
    expect(server.calls.find((call) => call.path === "/api/create")?.body).toEqual({
      model: "qwen3:8b-64k",
      from: "qwen3:8b",
      parameters: { num_ctx: 65_536 },
      stream: false,
    });
  });

  it("falls back to exact instructions on an Ollama too old for that create shape", async () => {
    const server = await ollama("0.5.1");
    const id = await addOllama(server.root);
    const result = await route()(request("POST", `/api/local-models/servers/${id}/ollama-context-copy`, { model: "qwen3:8b" }));
    expect(result.body).toEqual({
      status: "instructions",
      reason: "old-version",
      model: "qwen3:8b-64k",
      numCtx: 65_536,
      modelfile: "FROM qwen3:8b\nPARAMETER num_ctx 65536\n",
      command: "ollama create qwen3:8b-64k -f Modelfile",
      environment: "OLLAMA_CONTEXT_LENGTH=65536",
      ollamaVersion: "0.5.1",
    });
    expect(server.calls.some((call) => call.path === "/api/create")).toBe(false);
  });

  it("does not claim success when the copy does not carry the new context", async () => {
    const server = await ollama("0.14.2", { honourCreate: false });
    const id = await addOllama(server.root);
    const result = await route()(request("POST", `/api/local-models/servers/${id}/ollama-context-copy`, { model: "qwen3:8b" }));
    expect(result.body).toMatchObject({ status: "instructions", reason: "not-verified" });
  });

  it("is only offered for Ollama servers", async () => {
    const llama = await llamaServer();
    const server = await addSeanBeast(llama.root);
    expect(await route()(request("POST", `/api/local-models/servers/${server.id}/ollama-context-copy`, { model: MODEL }))).toMatchObject({
      status: 409,
      body: { code: "not-ollama" },
    });
  });
});

describe("store is inert until configured", () => {
  it("has no file and no servers before boot configures it", () => {
    configureLocalServerStore(null);
    expect(readLocalServers()).toEqual([]);
    expect(existsSync(join(root, "data", "local-models"))).toBe(false);
  });
});
