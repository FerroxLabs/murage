// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 B2 group 4: HTTP text-only bodies (openai-chat family, openai-compat) against a loopback server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { httpTextOnlyTurn, textOnlyBody } from "./http-text-only.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";

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
  system: "SYS", text: "USER", model: "model-x", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 1500, maxOutputBytes: 12 * 1024, context: { botId: "b", runId: "r", family: "lived", attempt: 1 }, ...over,
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
