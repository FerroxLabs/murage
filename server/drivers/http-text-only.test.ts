// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 B2 group 4: HTTP text-only bodies (openai-chat family, openai-compat) against a loopback server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { httpTextOnlyTurn, textOnlyBody, unwrapJsonFence } from "./http-text-only.ts";
import { httpVerdict } from "../memory/pip-transport.ts";
import { schemaPromptInstruction } from "./headless-text-only.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";
import { fixedPrompt } from "../memory/fixed-prompt.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";

const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
let server: Server, url: string, seen: Array<{ body: any; headers: IncomingMessage["headers"] }>, reply: (res: import("node:http").ServerResponse) => void;
beforeEach(async () => {
  seen = [];
  reply = (res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } })); };
  server = createServer((req, res) => {
    let data = ""; req.on("data", (c) => { data += c; });
    req.on("end", () => {
      if (req.method !== "POST") { res.setHeader("content-type", "application/json"); res.end('{"data":[]}'); return; }
      seen.push({ body: JSON.parse(data), headers: req.headers }); reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const turn = (over: Partial<TextOnlyTurnInput> = {}): TextOnlyTurnInput => ({
  system: fixedPrompt("SYS"), text: "USER", model: "model-x", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 1500, maxOutputBytes: 12 * 1024, context: { botId: "b", runId: "r", family: "lived", attempt: 1 }, transport: { gate: openLearningGate() }, ...over,
});
const options = (extra = {}) => ({ baseUrl: url, apiKey: "k", jsonSchemaResponse: true, buildBody: (model: string, messages: unknown[]) => ({ model, messages, stream: true, tools: [{ type: "function" }], tool_choice: "auto", stream_options: { include_usage: true } }), ...extra });

describe("httpTextOnlyTurn", () => {
  it("sends no tools field, max_tokens, the call's model and a json-schema response format; reports the A.5 facts", async () => {
    const r = await httpTextOnlyTurn(turn(), options());
    expect(r.verdict).toEqual({ state: "validated", structured: { ok: true } });
    const { body, headers } = seen[0];
    expect(body.tools).toBeUndefined(); expect(body.tool_choice).toBeUndefined(); expect(body.stream_options).toBeUndefined();
    expect(body).toMatchObject({ model: "model-x", max_tokens: 1500, stream: false });
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "pip_reflection", strict: true, schema: SCHEMA } });
    expect(headers.authorization).toBe("Bearer k");
    expect(r.isolation).toEqual({ mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], stopReason: "stop", exited: true, initLine: true });
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
  });
  it("omits response_format where unsupported", () => {
    expect(textOnlyBody(options({ jsonSchemaResponse: false }), turn(), "m").response_format).toBeUndefined();
  });
  it("a Flux endpoint (custom endpoint pointed at Flux) gets the schema in the prompt, not response_format", () => {
    for (const baseUrl of ["https://api.fluxrouter.ai/v1", "https://eu.fluxrouter.ai/v1"]) {
      const body = textOnlyBody(options({ baseUrl }), turn(), "m") as any;
      expect(body.response_format).toBeUndefined();
      expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
      expect(body.messages[1].content).toBe(`USER\n\n${schemaPromptInstruction(SCHEMA)}`);
    }
    const other = textOnlyBody(options({ baseUrl: "https://api.example.com/v1" }), turn(), "m") as any;
    expect(other.response_format).toEqual({ type: "json_schema", json_schema: { name: "pip_reflection", strict: true, schema: SCHEMA } });
    expect(other.messages[1].content).toBe("USER");
  });
  it("unwrapJsonFence keeps the enclosed text as written and leaves the byte cap and the validator in charge", () => {
    const cap = 12 * 1024;
    expect(unwrapJsonFence('{"ok":true}', cap)).toBe('{"ok":true}');
    expect(unwrapJsonFence('```json\n{"ok":true}\n```', cap)).toBe('{"ok":true}');
    expect(unwrapJsonFence('```\n{"ok":true}```', cap)).toBe('{"ok":true}');
    const trailing = '```json\n{"ok":true}\n```\nthanks';
    expect(unwrapJsonFence(trailing, cap)).toBe(trailing);
    const verdictOf = (text: string) => httpVerdict({ finishReason: "stop", content: unwrapJsonFence(text, cap), outputSchema: SCHEMA, maxOutputBytes: cap, exited: true });
    expect(verdictOf('```json\n{"ok":true}\n```').state).toBe("validated");
    expect(verdictOf('```json\n{"ok":"yes"}\n```')).toMatchObject({ state: "refused", reason: "bad-output" });
    expect(verdictOf(trailing)).toMatchObject({ state: "refused", reason: "bad-output", detail: "not-json" });
    const padded = '```json\n{"ok":true}' + " ".repeat(cap) + "\n```";
    expect(unwrapJsonFence(padded, cap)).toBe(padded);
    expect(verdictOf(padded)).toMatchObject({ state: "refused", reason: "bad-output", detail: "over-byte-cap" });
    // 1e400 parses to Infinity; re-serialising used to turn it into null, which a null-typed field would then accept
    const nullOnly = { type: "object", required: ["n"], properties: { n: { type: "null" } }, additionalProperties: false };
    const overflow = httpVerdict({ finishReason: "stop", content: unwrapJsonFence('```json\n{"n":1e400}\n```', cap), outputSchema: nullOnly, maxOutputBytes: cap, exited: true });
    expect(overflow.state).toBe("refused");
  });
  it("httpTextOnlyTurn: a Flux endpoint accepts a fenced reply and sends no response_format; a non-Flux endpoint refuses the fence", async () => {
    const fenced = (content: string): typeof fetch => (async (_u: unknown, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sentBodies: any[] = [];
    const flux = await httpTextOnlyTurn(turn(), options({ baseUrl: "https://api.fluxrouter.ai/v1", fetchImpl: fenced('```json\n{"ok":true}\n```') }));
    expect(flux.verdict.state).toBe("validated");
    expect(JSON.parse(flux.text)).toEqual({ ok: true });
    expect(sentBodies[0].response_format).toBeUndefined();
    expect(sentBodies[0].messages[1].content).toContain(schemaPromptInstruction(SCHEMA));
    const bad = await httpTextOnlyTurn(turn(), options({ baseUrl: "https://api.fluxrouter.ai/v1", fetchImpl: fenced('```json\n{"ok":"yes"}\n```') }));
    expect(bad.verdict).toMatchObject({ state: "refused", reason: "bad-output" });
    const padded = await httpTextOnlyTurn(turn(), options({ baseUrl: "https://api.fluxrouter.ai/v1", fetchImpl: fenced('{"ok":true}' + " ".repeat(13 * 1024)) }));
    expect(padded.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "over-byte-cap" });
    const control = await httpTextOnlyTurn(turn(), options({ baseUrl: "https://api.example.com/v1", fetchImpl: fenced('```json\n{"ok":true}\n```') }));
    expect(control.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "not-json" });
    expect(sentBodies[3].response_format).toMatchObject({ type: "json_schema" });
  });
  it("cancels a body over the cap and refuses; truncation is a failure, not a partial", async () => {
    reply = (res) => { res.setHeader("content-type", "application/json"); res.write('{"choices":[{"message":{"content":"'); res.end("x".repeat(70_000) + '"}}]}'); };
    const r = await httpTextOnlyTurn(turn(), options());
    expect(r.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "over-byte-cap" });
    expect(r.text).toBe("");
    const long = await httpTextOnlyTurn(turn({ maxOutputBytes: 8 }), options());
    expect(long.verdict.state).toBe("refused");
  });
  it("finish_reason length is refused; reported usage above the limit is recorded and still applies", async () => {
    reply = (res) => res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"ok":tr' } }] }));
    expect((await httpTextOnlyTurn(turn(), options())).verdict).toMatchObject({ reason: "bad-output", detail: "truncated" });
    reply = (res) => res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 4000 } }));
    const over = await httpTextOnlyTurn(turn(), options());
    expect(over.verdict.state).toBe("validated"); expect(over.reportedOverLimit).toBe(true);
  });
  it("a tool call in the response is unsupported tools; an HTTP error is transient", async () => {
    reply = (res) => res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{}] } }] }));
    expect((await httpTextOnlyTurn(turn(), options())).verdict).toMatchObject({ state: "unsupported", reason: "tools" });
    reply = (res) => { res.statusCode = 503; res.end("{}"); };
    expect((await httpTextOnlyTurn(turn(), options())).verdict).toMatchObject({ state: "refused", reason: "transient", detail: "http-503" });
  });
  it("classifies a Flux URL before cancellation and retains the empty-success refusal", async () => {
    const providerRoute = { connectionId:"fixture", revision:"1", preset:"flux" as const, protocol:"openai" as const, baseUrl:url, apiKey:"fixture", model:"flux-auto" };
    const stopped = await httpTextOnlyTurn(turn({providerRoute}), options({baseUrl:"https://api.fluxrouter.ai/v1",fetchImpl:async()=>new Response(null,{status:401})}));
    expect(stopped.fluxDecision).toEqual({reason:"keyRefused",action:"STOP",wait:"-"});
    const empty = await httpTextOnlyTurn(turn({providerRoute}), options({baseUrl:"https://api.fluxrouter.ai/v1",fetchImpl:async()=>new Response(null,{status:204})}));
    expect(empty.verdict).toMatchObject({state:"refused",reason:"transient",detail:"http-204"});
  });
  it("an abort rejects cancelled", async () => {
    const c = new AbortController(); c.abort();
    await expect(httpTextOnlyTurn(turn({ signal: c.signal }), options())).rejects.toMatchObject({ name: "cancelled" });
  });
});

describe("OpenAICompatDriver.textOnlyTurn", () => {
  it("is advertised and sends the provider-ordered body with no tools", async () => {
    const instance = await OpenAICompatDriver.create({ instanceId: "c1", displayName: "compat", enabled: true, environment: {}, config: OpenAICompatDriver.decodeConfig({ url, key: "secret", model: "model-x" }) });
    try {
      expect(instance.adapter.capabilities.textOnlyTurn).toBe(true);
      const r = await instance.adapter.textOnlyTurn!(turn());
      expect(r.verdict.state).toBe("validated");
      expect(seen[0].body.tools).toBeUndefined();
      expect(seen[0].body).toMatchObject({ model: "model-x", max_tokens: 1500, stream: false });
      expect(seen[0].body.response_format.type).toBe("json_schema");
      expect(seen[0].headers.authorization).toBe("Bearer secret");
    } finally { await instance.dispose(); }
  });

  it("a routed turn sends the route's model with the route's key and validates the route like an ordinary turn (audit 14)", async () => {
    const instance = await OpenAICompatDriver.create({ instanceId: "c2", displayName: "compat", enabled: true, environment: {}, config: OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:1/never", key: "own-key", model: "own-model" }) });
    const route = { connectionId: "conn-a", preset: "openai", protocol: "openai", baseUrl: url, apiKey: "route-key", model: "route-model", revision: "r1" } as const;
    try {
      const r = await instance.adapter.textOnlyTurn!(turn({ model: "turn-model", providerRoute: { ...route } }));
      expect(r.verdict.state).toBe("validated");
      expect(seen[0].body.model).toBe("route-model");
      expect(seen[0].headers.authorization).toBe("Bearer route-key");
      // an incomplete route is refused before any request, as in sendTurn
      seen.length = 0;
      await expect(instance.adapter.textOnlyTurn!(turn({ providerRoute: { ...route, revision: "" } }))).rejects.toThrow("Selected provider connection is incomplete");
      expect(seen).toHaveLength(0);
    } finally { await instance.dispose(); }
  });
  it("refuses a schema keyword the host cannot enforce before any request (audit 13)", async () => {
    await expect(httpTextOnlyTurn(turn({ outputSchema: { type: "object", properties: { a: { type: "string", pattern: "(" } } } }), options())).rejects.toThrow("PIP_SCHEMA_UNSUPPORTED");
    await expect(httpTextOnlyTurn(turn({ outputSchema: { type: "object", properties: { a: { $ref: "#/x" } } } }), options())).rejects.toThrow("PIP_SCHEMA_UNSUPPORTED");
    expect(seen).toHaveLength(0);
  });
  it("keeps reported usage on a rejected attempt (audit 15)", async () => {
    reply = (res) => res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"wrong":1}' } }], usage: { prompt_tokens: 20, completion_tokens: 9 } }));
    const r = await httpTextOnlyTurn(turn(), options());
    expect(r.verdict).toMatchObject({ state: "refused", reason: "bad-output" });
    expect(r.text).toBe("");
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 9 });
  });
});

describe("httpTextOnlyTurn redirects", () => {
  it("a 307 to another origin is never followed: the second server receives nothing", async () => {
    const elsewhere: string[] = [];
    const other = createServer((req, res) => { let d = ""; req.on("data", c => { d += c; }); req.on("end", () => { elsewhere.push(d); res.end("{}"); }); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/v1/chat/completions`;
    reply = (res) => { res.statusCode = 307; res.setHeader("location", otherUrl); res.end(); };
    try {
      const r = await httpTextOnlyTurn(turn({ text: "a private sentence" }), options()).catch((error: unknown) => error);
      expect(r).not.toMatchObject({ verdict: { state: "validated" } });
      expect(seen).toHaveLength(1);
      expect(elsewhere).toEqual([]);
    } finally { other.closeAllConnections(); await new Promise<void>((r) => other.close(() => r())); }
  });
});
