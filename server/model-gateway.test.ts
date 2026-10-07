// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan sign-in, server side: the in-memory registry, the loopback model
// gateway, the chat to Responses translation, the plan-limit pause, and
// engine parity. Fake upstreams only.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSignIns, planLimitLine } from "./model-signin.ts";
import { gatewayBaseUrl, handleModelGateway, isPlanLimit, limitResetsAt, redact } from "./model-gateway.ts";
import { chatToResponses, collectResponse, createChatStreamTranslator, createSseParser, normalizeResponsesBody, responseToChatCompletion } from "./model-gateway-translate.ts";
import { ProviderConnectionsService, normalizeProviderModels } from "./provider-connections.ts";
import { applyProviderRoute, type ProviderTurnRoute } from "./provider-routing.ts";
import { providerEngineProtocol, signInEngineGap } from "../shared/provider-engine.ts";
import type { ProviderCatalog } from "../shared/provider-connections.ts";

const TOKEN = "plan-access-token-SECRET-123";
const entry = (over: Record<string, unknown> = {}) => ({ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "rev-1", state: "connected", accessToken: TOKEN, accountId: "acct-9", expiresAt: Date.now() + 3_600_000, email: "o@example.com", plan: "plus", ...over });
const message = (...entries: unknown[]) => ({ type: "murage:model-signin", entries });

describe("the sign-in registry", () => {
  it("holds pushed tokens in memory, lists rows without a key, and never lists a turned-off provider", () => {
    const changed: string[][] = [];
    const signIns = new ModelSignIns({ onChange: ids => changed.push(ids), env: {} });
    expect(signIns.apply({ type: "something-else" })).toBe(false);
    expect(signIns.apply(message(entry(), entry({ provider: "supergrok", connectionId: "signin-grok", accessToken: "g", revision: "g1" })))).toBe(true);
    expect(changed).toEqual([["signin-chatgpt", "signin-grok"]]);
    const rows = signIns.records();
    expect(rows.map(row => [row.id, row.preset, row.enabled, row.key])).toEqual([["signin-chatgpt", "chatgpt", true, ""], ["signin-grok", "supergrok", true, ""]]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(signIns.info("signin-chatgpt"))).not.toContain(TOKEN);
    expect(signIns.info("signin-grok")?.unofficial).toBe(true);
    const off = new ModelSignIns({ env: { MURAGE_SIGNIN_GROK: "off" } });
    off.apply(message(entry(), entry({ provider: "supergrok", connectionId: "signin-grok", revision: "g1" })));
    expect(off.records().map(row => row.id)).toEqual(["signin-chatgpt"]);
    expect(off.bearer("signin-grok")).toBeNull();
  });

  it("refuses a malformed push and keeps what it had", () => {
    const signIns = new ModelSignIns({ env: {} });
    signIns.apply(message(entry()));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(signIns.apply(message(entry({ connectionId: "not-the-id" })))).toBe(true);
    expect(signIns.apply(message({ ...entry(), refreshToken: "never-accepted" }))).toBe(true);
    spy.mockRestore();
    expect(signIns.bearer("signin-chatgpt")?.accessToken).toBe(TOKEN);
  });

  it("a refresh keeps the revision (running turns continue); an ended sign-in disables the row", () => {
    const changed: string[][] = [];
    const signIns = new ModelSignIns({ onChange: ids => changed.push(ids), env: {} });
    signIns.apply(message(entry()));
    signIns.apply(message(entry({ accessToken: "rotated" })));
    expect(changed).toEqual([["signin-chatgpt"]]);
    signIns.apply(message(entry({ state: "needs-sign-in", accessToken: undefined })));
    expect(changed.at(-1)).toEqual(["signin-chatgpt"]);
    expect(signIns.records()[0].enabled).toBe(false);
  });

  it("gateway keys are per turn: random, bound to one connection and revision, revocable, and expire when idle", () => {
    let now = 1_000;
    const signIns = new ModelSignIns({ env: {}, now: () => now });
    signIns.apply(message(entry(), entry({ provider: "supergrok", connectionId: "signin-grok", revision: "g1" })));
    const key = signIns.issueGatewayKey("signin-chatgpt"), other = signIns.issueGatewayKey("signin-chatgpt");
    expect(key).not.toContain(TOKEN);
    expect(other).not.toBe(key);
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${key}`)).toBe(true);
    expect(signIns.verifyGatewayKey("signin-grok", `Bearer ${key}`)).toBe(false);
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${TOKEN}`)).toBe(false);
    signIns.revokeGatewayKey(key);
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${key}`)).toBe(false);
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${other}`)).toBe(true);
    now += 7 * 60 * 60 * 1000;
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${other}`)).toBe(false);
    const fresh = signIns.issueGatewayKey("signin-chatgpt");
    signIns.apply(message(entry({ revision: "rev-2" })));
    expect(signIns.verifyGatewayKey("signin-chatgpt", `Bearer ${fresh}`)).toBe(false);
  });

  it("asks main to refresh and wakes when the new token lands, or gives up when none can", async () => {
    const asked: string[] = [];
    const signIns = new ModelSignIns({ env: {}, requestRefresh: provider => { asked.push(provider); return true; } });
    signIns.apply(message(entry()));
    const waiting = signIns.freshToken("chatgpt", TOKEN);
    signIns.apply(message(entry({ accessToken: "fresh" })));
    await expect(waiting).resolves.toBe(true);
    expect(asked).toEqual(["chatgpt"]);
    const ending = signIns.freshToken("chatgpt", "fresh");
    signIns.apply(message(entry({ state: "needs-sign-in", accessToken: undefined })));
    await expect(ending).resolves.toBe(false);
    await expect(new ModelSignIns({ env: {} }).freshToken("chatgpt", "x")).resolves.toBe(false);
  });
});

describe("chat completions to the ChatGPT plan backend", () => {
  it("translates messages, tools and tool results", () => {
    const { request, wantStream } = chatToResponses({
      model: "gpt-5.5", stream: true, temperature: 0.2, max_tokens: 50, reasoning_effort: "low",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"p\":1}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "file text" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    });
    expect(wantStream).toBe(true);
    expect(request).toMatchObject({ model: "gpt-5.5", instructions: "Be brief.", store: false, stream: true, reasoning: { effort: "low" }, tool_choice: "auto" });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("max_tokens");
    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"p\":1}" },
      { type: "function_call_output", call_id: "call_1", output: "file text" },
    ]);
    expect(request.tools).toEqual([{ type: "function", name: "read", description: "Read", parameters: { type: "object", properties: {} }, strict: false }]);
  });

  it("normalizes a Responses body: store off, streamed, instructions present, refused fields gone", () => {
    const { request, wantStream } = normalizeResponsesBody({ model: "gpt-5.5", input: [{ type: "message", role: "system", content: "Rules" }, { type: "message", role: "user", content: "hi" }], max_output_tokens: 10, temperature: 1, store: true, previous_response_id: "r", metadata: {} });
    expect(wantStream).toBe(false);
    expect(request).toMatchObject({ store: false, stream: true, instructions: "Rules" });
    for (const field of ["max_output_tokens", "temperature", "previous_response_id", "metadata"]) expect(request).not.toHaveProperty(field);
    expect(normalizeResponsesBody({ model: "m", input: "hi" }).request.instructions).toBeTruthy();
  });

  it("replays Fuigo history by content with store off: no stored ids, reasoning only with encrypted content, summary auto", () => {
    const { request } = normalizeResponsesBody({ model: "gpt-5.5", reasoning: { effort: "low", summary: "concise" }, input: [
      { type: "message", role: "user", id: "msg_1", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "enc" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "t", arguments: "{}" },
      { type: "item_reference", id: "msg_0" },
    ] });
    expect(request.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", summary: [], encrypted_content: "enc" },
      { type: "function_call", call_id: "call_1", name: "t", arguments: "{}" },
    ]);
    expect(request.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(chatToResponses({ model: "m", messages: [], reasoning_effort: "none" }).request).not.toHaveProperty("reasoning");
  });

  it("turns a streamed answer with a tool call into chat chunks", () => {
    const translator = createChatStreamTranslator("gpt-5.5", "chatcmpl-1", 1, true);
    const out = [
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"a\"" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: ":1}" },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
    ].flatMap(event => translator.push(event)) as Array<{ choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: unknown }>;
    const text = out.map(chunk => chunk.choices[0].delta.content ?? "").join("");
    expect(text).toBe("Hello");
    const calls = out.flatMap(chunk => (chunk.choices[0].delta.tool_calls as Array<{ id?: string; function: { name?: string; arguments: string } }> | undefined) ?? []);
    expect(calls[0]).toMatchObject({ id: "call_9", function: { name: "read" } });
    expect(calls.map(call => call.function.arguments).join("")).toBe("{\"a\":1}");
    expect(out.at(-1)!.choices[0].finish_reason).toBe("tool_calls");
    expect(out.at(-1)!.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it("collects a whole stream into one chat completion, and SSE frames split anywhere", () => {
    const events: Record<string, unknown>[] = [];
    const parser = createSseParser(event => events.push(event));
    const stream = [
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Hi" }] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "t", arguments: "{}" } })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 2 } } })}\n\n`,
    ].join("");
    for (let i = 0; i < stream.length; i += 7) parser.push(stream.slice(i, i + 7));
    parser.end();
    const completion = responseToChatCompletion(collectResponse(events), "m", "id", 1) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }>; usage: unknown };
    expect(completion.choices[0].message.content).toBe("Hi");
    expect(completion.choices[0].message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }]);
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(() => collectResponse([{ type: "response.failed", response: { error: { message: "nope" } } }])).toThrow("nope");
  });
});

describe("plan limits", () => {
  it("reads the reset time and tells a plan limit from a short rate limit", () => {
    expect(limitResetsAt({ error: { type: "usage_limit_reached", resets_at: 2_000_000_000 } }, null, 0)).toBe(2_000_000_000_000);
    expect(limitResetsAt({ error: { resets_in_seconds: 60 } }, null, 1000)).toBe(61_000);
    expect(limitResetsAt({}, "30", 1000)).toBe(31_000);
    expect(isPlanLimit("chatgpt", { error: { type: "usage_limit_reached" } })).toBe(true);
    expect(isPlanLimit("chatgpt", { error: { type: "rate_limit_exceeded", message: "slow down" } })).toBe(false);
    expect(planLimitLine("chatgpt", 0)).toMatch(/did not switch to another provider/);
    expect(planLimitLine("chatgpt", undefined)).not.toMatch(/\u2014/);
  });

  it("redacts tokens and bearer strings from anything passed back", () => {
    expect(redact(`bad token ${TOKEN} and Bearer abcdefghijkl`, [TOKEN])).toBe("bad token [redacted] and Bearer [redacted]");
  });
});

// ── the gateway over a real loopback socket, with a fake upstream ─────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
type UpstreamCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let server: Server | null = null;
afterEach(async () => { await new Promise(resolve => server ? server.close(resolve) : resolve(undefined)); server = null; });

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function gateway(opts: { upstream: (call: UpstreamCall, n: number) => Response | Promise<Response>; entries?: unknown[]; requestRefresh?: (signIns: ModelSignIns) => boolean }) {
  const calls: UpstreamCall[] = [];
  const signIns: ModelSignIns = new ModelSignIns({ env: {}, requestRefresh: () => opts.requestRefresh?.(signIns) ?? false });
  signIns.apply(message(...(opts.entries ?? [entry(), entry({ provider: "supergrok", connectionId: "signin-grok", revision: "g1", accessToken: "grok-token", accountId: undefined })])));
  const catalog = (id: string): ProviderCatalog => ({ connectionId: id, stale: false, assurance: "catalog-only", models: [{ connectionId: id, preset: "chatgpt", id: "gpt-5.5", label: "GPT-5.5", enabled: true, chatEligible: true, capabilities: { chat: true }, outputModalities: ["text"] }] });
  const fetchStub = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), headers: Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    return opts.upstream(call, calls.length);
  }) as typeof fetch;
  server = createServer((req, res) => { void handleModelGateway(req, res, new URL(req.url ?? "/", "http://127.0.0.1").pathname, { signIns, catalog, fetch: fetchStub }); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = (id = "signin-chatgpt") => gatewayBaseUrl(port, id);
  const keys = new Map<string, string>();
  const auth = (id = "signin-chatgpt") => { if (!keys.has(id)) keys.set(id, signIns.issueGatewayKey(id)); return { authorization: `Bearer ${keys.get(id)}`, "content-type": "application/json" }; };
  return { calls, signIns, base, auth };
}

describe("the model gateway", () => {
  it("refuses a missing or wrong key and never calls upstream", async () => {
    const g = await gateway({ upstream: () => sse([]) });
    const none = await fetch(`${g.base()}/responses`, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    const real = await fetch(`${g.base()}/responses`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(real.status).toBe(401);
    expect(g.calls).toHaveLength(0);
  });

  it("serves the model list from the saved catalog", async () => {
    const g = await gateway({ upstream: () => sse([]) });
    const list = await (await fetch(`${g.base()}/models`, { headers: g.auth() })).json();
    expect(list).toEqual({ object: "list", data: [{ id: "gpt-5.5", object: "model", created: 0, owned_by: "openai" }] });
  });

  it("sends a Responses call to the pinned ChatGPT backend with Wayland's headers, and collects it when the caller did not stream", async () => {
    const g = await gateway({ upstream: () => sse([{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "ok" }] } }, { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }]) });
    const response = await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", input: "hi", max_output_tokens: 99, temperature: 0 }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_1", output: [{ type: "message" }] });
    const [call] = g.calls;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "chatgpt-account-id": "acct-9", originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.0.0 (Murage)", "openai-beta": "responses=experimental", accept: "text/event-stream" });
    expect(call.body).toMatchObject({ store: false, stream: true });
    expect(call.body).not.toHaveProperty("max_output_tokens");
    expect(call.body).not.toHaveProperty("temperature");
  });

  it("serves chat completions from the Responses backend, streamed and not", async () => {
    const events = [{ type: "response.output_text.delta", delta: "Hi" }, { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Hi" }] } }, { type: "response.completed", response: { status: "completed", output: [] } }];
    const g = await gateway({ upstream: () => sse(events) });
    const plain: Body = await (await fetch(`${g.base()}/chat/completions`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }) })).json();
    expect(plain.choices[0].message.content).toBe("Hi");
    const streamed = await (await fetch(`${g.base()}/chat/completions`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }) })).text();
    expect(streamed).toContain("chat.completion.chunk");
    expect(streamed.trim().endsWith("data: [DONE]")).toBe(true);
    expect(g.calls.every(call => call.url === "https://chatgpt.com/backend-api/codex/responses")).toBe(true);
  });

  it("a chat stream that stops before the answer finished is an error, not a quiet ending", async () => {
    const g = await gateway({ upstream: () => sse([{ type: "response.created" }]) });
    const response = await fetch(`${g.base()}/chat/completions`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }) });
    expect(response.status).toBe(502);
    const cut = await gateway({ upstream: () => sse([{ type: "response.output_text.delta", delta: "Hal" }]) });
    const text = await (await fetch(`${cut.base()}/chat/completions`, { method: "POST", headers: cut.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [] }) })).text();
    expect(text).toContain("stopped before the answer finished");
    expect(text).toContain("\"object\":\"chat.completion.chunk\"");
  });

  it("a streamed Responses pass-through fills an empty completed output from the finished items, and forwards every event", async () => {
    const item = { type: "message", content: [{ type: "output_text", text: "Hi" }] };
    const g = await gateway({ upstream: () => sse([{ type: "response.output_text.delta", delta: "Hi" }, { type: "response.output_item.done", item }, { type: "response.completed", response: { id: "resp_9", status: "completed", output: [] } }]) });
    const text = await (await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) })).text();
    const events = text.split("\n\n").filter(block => block.startsWith("data: {")).map(block => JSON.parse(block.slice(6)));
    expect(events.map(event => event.type)).toEqual(["response.output_text.delta", "response.output_item.done", "response.completed"]);
    expect(events[2].response.output).toEqual([item]);
    expect(text).toContain("data: [DONE]");
  });

  it("a streamed Responses pass-through keeps a non-empty completed output and says so when the stream ends with no terminal event", async () => {
    const full = [{ type: "message", content: [{ type: "output_text", text: "kept" }] }];
    const g = await gateway({ upstream: () => sse([{ type: "response.output_item.done", item: { type: "message" } }, { type: "response.completed", response: { status: "completed", output: full } }]) });
    const text = await (await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) })).text();
    expect(text).toContain(JSON.stringify(full));
    const cut = await gateway({ upstream: () => sse([{ type: "response.output_text.delta", delta: "Hal" }]) });
    const ended = await (await fetch(`${cut.base()}/responses`, { method: "POST", headers: cut.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) })).text();
    expect(ended).toContain("response.failed");
    expect(ended).toContain("stopped before the answer finished");
  });

  describe("a Responses stream that ends with no terminal event", () => {
    const raw = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
    const run = async (body: string) => {
      const g = await gateway({ upstream: () => raw(body) });
      return (await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "hi" }) })).text();
    };
    // A strict decoder shaped like Fuigo's typed Response: these fields are required.
    const strictDecode = (block: string) => {
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      const event = JSON.parse(data);
      expect(typeof event.sequence_number).toBe("number");
      if (event.type === "response.failed") {
        const r = event.response;
        for (const key of ["id", "object", "model", "status", "created_at", "output"]) expect(r[key], key).toBeDefined();
        expect(Array.isArray(r.output)).toBe(true);
        expect(r.status).toBe("failed");
        expect(typeof r.error.code).toBe("string");
        expect(typeof r.error.message).toBe("string");
      }
      return event;
    };
    // A consumer like Fuigo's: decodes in order, stops at [DONE] or a terminal event.
    const consume = (text: string) => {
      const seen: Array<{ type: string; sequence_number: number; response?: Record<string, unknown> }> = [];
      for (const block of text.split("\n\n").filter(Boolean)) {
        if (block.includes("data: [DONE]")) break;
        const event = strictDecode(block);
        seen.push(event);
        if (event.type === "response.failed") break;
      }
      return seen;
    };

    it("emits a schema-valid response.failed with the stream's metadata, before [DONE], for a consumer that stops at [DONE]", async () => {
      const text = await run(frame({ type: "response.created", sequence_number: 0, response: { id: "resp_7", object: "response", created_at: 1700000000, model: "gpt-5.5", status: "in_progress", output: [] } })
        + frame({ type: "response.output_text.delta", sequence_number: 1, delta: "Hal" }) + "data: [DONE]\n\n");
      const seen = consume(text);
      expect(seen.map(event => event.type)).toEqual(["response.created", "response.output_text.delta", "response.failed"]);
      const failed = seen[2];
      expect(failed.sequence_number).toBe(2);
      expect(failed.response).toMatchObject({ id: "resp_7", object: "response", created_at: 1700000000, model: "gpt-5.5", status: "failed", error: { code: "upstream_stream_ended" } });
      expect(text.indexOf("response.failed")).toBeLessThan(text.indexOf("[DONE]"));
    });

    it("drops a half-written final event and still emits one valid failure", async () => {
      const text = await run(frame({ type: "response.output_text.delta", sequence_number: 4, delta: "Hal" }) + 'data: {"type":"response.output_text.delta","sequence_number":5,"del');
      expect(text).not.toContain('"sequence_number":5,"del');
      const seen = consume(text);
      expect(seen.map(event => event.type)).toEqual(["response.output_text.delta", "response.failed"]);
      expect(seen[1].sequence_number).toBe(5);
    });

    it("adds no failure after a terminal event", async () => {
      const text = await run(frame({ type: "response.completed", sequence_number: 0, response: { id: "r", status: "completed", output: [{ type: "message" }] } }) + "data: [DONE]\n\n");
      expect(text).not.toContain("response.failed");
    });
  });

  it("passes Grok straight through to api.x.ai with the plan token", async () => {
    const g = await gateway({ upstream: () => Response.json({ id: "x", choices: [] }) });
    const response = await fetch(`${g.base("signin-grok")}/chat/completions`, { method: "POST", headers: g.auth("signin-grok"), body: JSON.stringify({ model: "grok-4", messages: [] }) });
    expect(response.status).toBe(200);
    expect(g.calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect(g.calls[0].headers.authorization).toBe("Bearer grok-token");
  });

  it("a plan usage limit pauses the connection with a clear line, no retry and no fallback", async () => {
    const g = await gateway({ upstream: () => Response.json({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 600 } }, { status: 429 }) });
    const first = await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", input: "hi" }) });
    expect(first.status).toBe(429);
    const body: Body = await first.json();
    expect(body.error.code).toBe("plan_limit_reached");
    expect(body.error.type).toBe("usage_limit_reached");
    expect(Number(first.headers.get("retry-after"))).toBeGreaterThan(500);
    expect(body.error.message).toMatch(/ChatGPT plan limit is reached.*did not switch to another provider/);
    expect(g.calls).toHaveLength(1);
    expect(g.signIns.pausedUntil("signin-chatgpt")).toBeGreaterThan(Date.now());
    const second = await fetch(`${g.base()}/chat/completions`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", messages: [] }) });
    expect(second.status).toBe(429);
    expect(g.calls).toHaveLength(1);
    expect(g.calls.every(call => call.url.startsWith("https://chatgpt.com/"))).toBe(true);
  });

  it("a refused token triggers one refresh and one retry with the new token", async () => {
    const g = await gateway({
      upstream: (_call, n) => n === 1 ? new Response("{}", { status: 401 }) : sse([{ type: "response.completed", response: { status: "completed", output: [] } }]),
      requestRefresh: signIns => { setTimeout(() => signIns.apply(message(entry({ accessToken: "fresh-token" }))), 5); return true; },
    });
    const response = await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", input: "hi" }) });
    expect(response.status).toBe(200);
    expect(g.calls.map(call => call.headers.authorization)).toEqual([`Bearer ${TOKEN}`, "Bearer fresh-token"]);
  });

  it("a still refused token says to sign in again; a Grok 403 names the xAI allowlist; tokens never echo back", async () => {
    const g = await gateway({ upstream: call => call.url.includes("x.ai") ? new Response("{}", { status: 403 }) : Response.json({ error: { message: `upstream saw ${TOKEN}` } }, { status: 400 }) });
    const echoed = await fetch(`${g.base()}/responses`, { method: "POST", headers: g.auth(), body: JSON.stringify({ model: "gpt-5.5", input: "hi" }) });
    const text = await echoed.text();
    expect(echoed.status).toBe(400);
    expect(text).not.toContain(TOKEN);
    const grok: Body = await (await fetch(`${g.base("signin-grok")}/chat/completions`, { method: "POST", headers: g.auth("signin-grok"), body: "{}" })).json();
    expect(grok.error.message).toMatch(/xAI has not enabled this sign-in for your account yet/);
    // A refused token with no refresh coming: "try again", not "signed out".
    const stuck = await gateway({ upstream: () => new Response("{}", { status: 401 }) });
    const retry = await fetch(`${stuck.base()}/responses`, { method: "POST", headers: stuck.auth(), body: "{}" });
    expect(retry.status).toBe(503);
    expect(stuck.calls).toHaveLength(1);
    // The refresher ended the sign-in: 403 with its own code, never 401 (engines read 401 as "bad API key").
    const dead = await gateway({ upstream: () => new Response("{}", { status: 401 }), requestRefresh: signIns => { setTimeout(() => signIns.apply(message(entry({ state: "needs-sign-in", accessToken: undefined }))), 5); return true; } });
    const endedResponse = await fetch(`${dead.base()}/responses`, { method: "POST", headers: dead.auth(), body: "{}" });
    const ended: Body = await endedResponse.json();
    expect(endedResponse.status).toBe(403);
    expect(ended.error.code).toBe("needs_sign_in");
    expect(ended.error.message).toMatch(/sign-in ended/);
  });
});

describe("engine parity", () => {
  const drivers = ["fuigoAgent", "codex", "qwenAgent", "hermesAgent", "grok", "grokAgent", "openai-compat", "claudeAgent", "piAgent", "opencodeGo", "droidAgent", "kimiAgent", "cursorAgent", "geminiAgent"];
  it("every engine that takes model connections can use both plans; Claude Code says why it cannot", () => {
    const table = Object.fromEntries(drivers.map(driver => [driver, [providerEngineProtocol(driver, "chatgpt", "responses"), providerEngineProtocol(driver, "supergrok", "openai")]]));
    expect(table).toEqual({
      fuigoAgent: ["responses", "openai"], codex: ["responses", "responses"],
      qwenAgent: ["openai", "openai"], hermesAgent: ["openai", "openai"], grok: ["openai", "openai"], grokAgent: ["openai", "openai"], "openai-compat": ["openai", "openai"],
      claudeAgent: [null, null], piAgent: [null, null], opencodeGo: [null, null], droidAgent: [null, null], kimiAgent: [null, null], cursorAgent: [null, null], geminiAgent: [null, null],
    });
    for (const driver of drivers) {
      const keyed = ["openai", "xai"].some(preset => providerEngineProtocol(driver, preset as "openai", "openai"));
      if (keyed) expect(signInEngineGap(driver), `${driver} takes key connections, so it takes plans too`).toBeNull();
    }
    expect(signInEngineGap("claudeAgent")).toBe("claude");
    expect(signInEngineGap("piAgent")).toBe("no-connections");
  });

  it("an engine only ever sees the gateway URL and gateway key, never the plan token", () => {
    const signIns = new ModelSignIns({ env: {} });
    signIns.apply(message(entry()));
    const key = signIns.issueGatewayKey("signin-chatgpt");
    for (const driver of ["codex", "qwenAgent", "grok", "openai-compat"]) {
      const protocol = providerEngineProtocol(driver, "chatgpt", "responses")!;
      const route: ProviderTurnRoute = { connectionId: "signin-chatgpt", preset: "chatgpt", protocol, baseUrl: gatewayBaseUrl(8799, "signin-chatgpt"), apiKey: key, model: "gpt-5.5", revision: "rev-1" };
      const env: NodeJS.ProcessEnv = {};
      const bound = applyProviderRoute(driver, env, route);
      const seen = JSON.stringify([env, bound.args]);
      expect(seen).not.toContain(TOKEN);
      expect(seen).toContain(key);
      expect(seen).toContain("/api/model-gateway/signin-chatgpt/v1");
    }
  });
});

describe("routed Hermes cannot fall back to another provider", () => {
  it("strips other provider keys and hides the Codex CLI login from a routed Hermes turn", () => {
    const signIns = new ModelSignIns({ env: {} });
    signIns.apply(message(entry()));
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "or", DEEPSEEK_API_KEY: "ds", GROQ_API_KEY: "gq", NOUS_API_KEY: "n" };
    const route: ProviderTurnRoute = { connectionId: "signin-chatgpt", preset: "chatgpt", protocol: "openai", baseUrl: gatewayBaseUrl(8799, "signin-chatgpt"), apiKey: signIns.issueGatewayKey("signin-chatgpt"), model: "gpt-5.5", revision: "rev-1" };
    const bound = applyProviderRoute("hermesAgent", env, route, { threadId: "t" });
    try {
      for (const name of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "NOUS_API_KEY"]) expect(env[name], name).toBeUndefined();
      expect(env.CODEX_HOME).toContain(String(env.HERMES_HOME));
    } finally { bound.cleanup(); }
  });
});

describe("the connection list", () => {
  it("lists plan sign-ins, reads the ChatGPT plan's model list shape, and marks an ended sign-in", async () => {
    const signIns = new ModelSignIns({ env: {} });
    signIns.apply(message(entry()));
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
      expect(init?.headers as Record<string, string>).toMatchObject({ authorization: `Bearer ${TOKEN}`, "chatgpt-account-id": "acct-9", originator: "codex_cli_rs", "user-agent": "codex_cli_rs/0.0.0 (Murage)" });
      return Response.json({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", context_window: 400000 }, { slug: "internal", visibility: "hide" }] });
    });
    const service = new ProviderConnectionsService({ readBank: () => "[]", cacheDir: mkdtempSync(join(tmpdir(), "signin-catalog-")), fetch: fetcher as unknown as typeof fetch, signIns });
    const catalog = await service.refresh("signin-chatgpt");
    expect(catalog.models.map(model => [model.id, model.label, model.chatEligible, model.contextWindow])).toEqual([["gpt-5.5", "GPT-5.5", true, 400000]]);
    const [row] = service.list();
    expect(row).toMatchObject({ id: "signin-chatgpt", preset: "chatgpt", label: "ChatGPT plan", enabled: true, signIn: { provider: "chatgpt", state: "connected", email: "o@example.com" } });
    expect(JSON.stringify(service.list())).not.toContain(TOKEN);
    signIns.apply(message(entry({ state: "needs-sign-in", accessToken: undefined })));
    expect(service.list()[0]).toMatchObject({ enabled: false, state: "needs-attention", signIn: { state: "needs-sign-in" } });
  });

  it("a plan sign-in cannot be saved into the pasted-key bank", async () => {
    const { mutateProviderBank } = await import("../electron/provider-connections.mjs");
    expect(() => mutateProviderBank("[]", { action: "create", preset: "chatgpt", key: "sk-proj-abcdefghijk" }, () => "id")).toThrow();
    expect(normalizeProviderModels({ id: "signin-grok", preset: "supergrok", label: "Grok", enabled: true, key: "", revision: "r" }, { data: [{ id: "grok-4" }, { id: "grok-imagine-image" }] }, 0).map(model => [model.id, model.chatEligible])).toEqual([["grok-4", true], ["grok-imagine-image", false]]);
  });
});
