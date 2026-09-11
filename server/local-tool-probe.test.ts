// The Local models tool-calling test against a real HTTP server on loopback.
// No model is involved: the fake server plays llama.cpp / Ollama / a broken
// server, so every outcome code and every safety property is pinned without a
// live call (LM2 does the live SeanBeast proof).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_TOOL_CHECKS } from "../shared/local-models.ts";
import { classifyLocalToolTest, runLocalToolProbe } from "./local-tool-probe.ts";

const KEY = "sk-local-probe-key";
/** Planted in every error body: nothing a server says may reach the result. */
const LEAK = "SERVER-SUPPLIED-TEXT-7f3a";

type Mode = "good" | "objectArgs" | "ollamaStream" | "text" | "rejectsTools" | "overflow" | "noModel" | "chatOnly";

interface Seen {
  paths: string[];
  auth: Array<string | undefined>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const WEATHER_CALL = { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } };

async function fakeServer(mode: Mode): Promise<{ base: string; seen: Seen }> {
  const seen: Seen = { paths: [], auth: [] };
  const server = createServer(async (req, res) => {
    seen.paths.push(req.url ?? "");
    seen.auth.push(req.headers.authorization);
    const body = await readBody(req);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
    if (mode === "noModel") return json(res, 404, { error: { message: `model 'x' not found ${LEAK}` } });
    if (req.url === "/v1/chat/completions") {
      if (mode === "rejectsTools" && tools.length) {
        return json(res, 400, { error: { message: `tools param requires --jinja flag ${LEAK}` } });
      }
      if (mode === "overflow" && tools.length > 5) {
        return json(res, 400, { error: { type: "exceed_context_size_error", message: `request exceeds n_ctx ${LEAK}` } });
      }
      if (messages.some((message) => message.role === "tool")) {
        return json(res, 200, { choices: [{ message: { role: "assistant", content: "It is 17°C with light rain in Paris." } }] });
      }
      if (mode === "text") {
        return json(res, 200, { choices: [{ message: { role: "assistant", content: "It is probably sunny." }, finish_reason: "stop" }] });
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunks =
          mode === "ollamaStream"
            ? [{ choices: [{ delta: { tool_calls: [{ index: 0, ...WEATHER_CALL }] } }] }]
            : [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ];
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const call = mode === "objectArgs" ? { ...WEATHER_CALL, function: { name: "get_weather", arguments: { city: "Paris" } } } : WEATHER_CALL;
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: tools.length * 190 },
      });
    }
    if (req.url === "/v1/messages") {
      if (mode === "text" || mode === "chatOnly") return json(res, 404, { error: `no route ${LEAK}` });
      return json(res, 200, { content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }], stop_reason: "tool_use" });
    }
    if (req.url === "/v1/responses") {
      if (mode === "text" || mode === "chatOnly") return json(res, 404, { error: `no route ${LEAK}` });
      return json(res, 200, { output: [{ type: "function_call", name: "get_weather", arguments: '{"city":"Paris"}', call_id: "c1" }] });
    }
    json(res, 404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/v1`, seen };
}

function probe(base: string, overrides: Partial<Parameters<typeof runLocalToolProbe>[0]> = {}) {
  return runLocalToolProbe({ serverId: "llamacpp", kind: "llamacpp", apiBase: base, apiKey: KEY, model: "qwen3.8-27b", requestTimeoutMs: 5_000, ...overrides });
}

describe("runLocalToolProbe — the seven SeanBeast checks", () => {
  it("passes all seven against a working server and unlocks every surface", async () => {
    const { base, seen } = await fakeServer("good");
    const result = await probe(base, { context: { contextWindow: 65_536, source: "llamacpp-props", loaded: true } });
    expect(result.checks.map((check) => check.name)).toEqual([...LOCAL_TOOL_CHECKS]);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.outcome).toBe("tools-work");
    expect(result.surfaces).toEqual({ chat: true, responses: true, messages: true });
    expect(result.checks.find((check) => check.name === "chat.manyTools")?.promptTokens).toBe(41 * 190);
    expect(result.apiBase).toBe(base);
    expect(result.context?.contextWindow).toBe(65_536);
    // Seven requests, all to this origin, all carrying this server's key.
    expect(seen.paths).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ]);
    expect(new Set(seen.auth)).toEqual(new Set([`Bearer ${KEY}`]));
  });

  it("accepts arguments sent as an object (llama.cpp #20198) and records the type", async () => {
    const { base } = await fakeServer("objectArgs");
    const result = await probe(base);
    expect(result.checks.find((check) => check.name === "chat.auto")).toMatchObject({ status: "pass", argumentsType: "object" });
    expect(result.checks.find((check) => check.name === "chat.roundtrip")?.status).toBe("pass");
  });

  it("reads Ollama's whole-call stream chunks the same as argument deltas", async () => {
    const { base } = await fakeServer("ollamaStream");
    const result = await probe(base, { kind: "ollama" });
    expect(result.checks.find((check) => check.name === "chat.stream")?.status).toBe("pass");
  });

  it("says 'answers but can't use tools' when the call comes back as text", async () => {
    const { base } = await fakeServer("text");
    const result = await probe(base, { kind: "ollama" });
    expect(result.outcome).toBe("text-instead-of-tools");
    expect(result.fix).toEqual({ kind: "pick-tool-model" });
    expect(result.checks.find((check) => check.name === "chat.roundtrip")).toMatchObject({ status: "skipped", detail: "no-first-call" });
    expect(result.checks.find((check) => check.name === "messages.toolUse")?.detail).toBe("no-endpoint");
    expect(result.surfaces).toEqual({ chat: false, responses: false, messages: false });
  });

  it("names the exact flag when the server rejects tools, and copies no server text", async () => {
    const { base } = await fakeServer("rejectsTools");
    const result = await probe(base);
    expect(result.outcome).toBe("server-rejects-tools");
    expect(result.fix).toEqual({ kind: "server-flag", value: "--jinja" });
    expect(result.checks.find((check) => check.name === "chat.auto")).toMatchObject({ status: "fail", detail: "tools-rejected", httpStatus: 400 });
    expect(JSON.stringify(result)).not.toContain(LEAK);
  });

  it("gives the vLLM parser flags for a vLLM server that rejects tools", () => {
    const checks = LOCAL_TOOL_CHECKS.map((name) => ({ name, status: "fail" as const, detail: "tools-rejected" as const, httpStatus: 400 }));
    expect(classifyLocalToolTest(checks, "vllm")).toEqual({
      outcome: "server-rejects-tools",
      fix: { kind: "server-flag", value: "--enable-auto-tool-choice --tool-call-parser <parser>" },
    });
  });

  it("reports a small loaded context even when the small tests pass", async () => {
    const { base } = await fakeServer("good");
    const result = await probe(base, { kind: "ollama", context: { contextWindow: 4_096, source: "ollama-ps", loaded: true } });
    expect(result.outcome).toBe("context-too-small");
    expect(result.fix).toEqual({ kind: "ollama-context-copy", value: "OLLAMA_CONTEXT_LENGTH=65536" });
  });

  it("recognises a context overflow from the 41-tool schema as too small", async () => {
    const { base } = await fakeServer("overflow");
    const result = await probe(base);
    expect(result.checks.find((check) => check.name === "chat.manyTools")?.detail).toBe("context-exceeded");
    expect(result.outcome).toBe("context-too-small");
    expect(result.fix).toEqual({ kind: "server-flag", value: "-c 65536" });
    expect(JSON.stringify(result)).not.toContain(LEAK);
  });

  it("says the model is not on the server", async () => {
    const { base } = await fakeServer("noModel");
    expect((await probe(base)).outcome).toBe("model-not-found");
  });

  it("keeps chat engines but not Codex/Claude Code when only chat works", async () => {
    const { base } = await fakeServer("chatOnly");
    const result = await probe(base);
    expect(result.outcome).toBe("tools-work");
    expect(result.surfaces).toEqual({ chat: true, responses: false, messages: false });
  });

  it("is unreachable when nothing listens, without throwing", async () => {
    const { base } = await fakeServer("good");
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    const result = await probe(base);
    expect(result.outcome).toBe("unreachable");
    expect(result.checks.every((check) => check.status !== "pass")).toBe(true);
  });

  it("refuses a redirect, so the key is never presented to another origin", async () => {
    const elsewhere = await fakeServer("good");
    const redirector = createServer((req, res) => {
      res.writeHead(307, { location: `${elsewhere.base.replace(/\/v1$/, "")}${req.url}` });
      res.end();
    });
    servers.push(redirector);
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", () => resolve()));
    const { port } = redirector.address() as AddressInfo;
    const result = await probe(`http://127.0.0.1:${port}/v1`);
    expect(result.outcome).toBe("unreachable");
    const ran = result.checks.filter((check) => check.status !== "skipped");
    expect(ran).toHaveLength(6); // the round trip is skipped: no first call ever came back
    expect(ran.every((check) => check.detail === "redirect-refused")).toBe(true);
    expect(elsewhere.seen.paths).toEqual([]);
  });
});
