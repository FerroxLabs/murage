// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyFrame, failureFrame, failureText, isElicitationRequest, rewriteInitializeCapabilities, serverRequestReply, splitUpstreamFrames, SseFrameReader } from "./remote-mcp-proxy-core.ts";

describe("rewriteInitializeCapabilities (decision D10, MCP-ELICITATION-109)", () => {
  it("keeps only the engine's own elicitation; sampling and roots are never announced", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { sampling: {}, elicitation: { form: { x: 1 }, url: {}, extra: {} }, roots: { listChanged: true } }, clientInfo: { name: "claude", version: "1" } } };
    expect(rewriteInitializeCapabilities(message)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {}, url: {} } }, clientInfo: { name: "claude", version: "1" } } });
    expect(message.params.capabilities).toEqual({ sampling: {}, elicitation: { form: { x: 1 }, url: {}, extra: {} }, roots: { listChanged: true } }); // input untouched
    // a bare `elicitation: {}` (form, 2025-06-18) stays bare
    expect(rewriteInitializeCapabilities({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { elicitation: {} } } })).toMatchObject({ params: { capabilities: { elicitation: {} } } });
  });
  it("announces nothing when the engine announced no elicitation, or for a legacy SSE server", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { sampling: {}, roots: {} } } };
    expect(rewriteInitializeCapabilities(message)).toMatchObject({ params: { capabilities: {} } });
    expect(rewriteInitializeCapabilities({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { elicitation: {} } } }, { elicitation: false })).toMatchObject({ params: { capabilities: {} } });
    expect(rewriteInitializeCapabilities({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: { elicitation: true } } })).toMatchObject({ params: { capabilities: {} } });
  });
  it("tells an elicitation request from anything else", () => {
    expect(isElicitationRequest({ jsonrpc: "2.0", id: 3, method: "elicitation/create" })).toBe(true);
    expect(isElicitationRequest({ jsonrpc: "2.0", method: "elicitation/create" })).toBe(false);
    expect(isElicitationRequest({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage" })).toBe(false);
  });
});

describe("SseFrameReader", () => {
  it("returns each frame as soon as its event is complete, across chunk boundaries", () => {
    const reader = new SseFrameReader();
    expect(reader.push('event: message\ndata: {"id":')).toEqual([]);
    expect(reader.push('1,"method":"elicitation/create"}\r\n')).toEqual([]);
    expect(reader.push("\r\n")).toEqual([{ id: 1, method: "elicitation/create" }]);
    expect(reader.push('data: [DONE]\n\ndata: junk\n\ndata: {"id":2}')).toEqual([]);
    expect(reader.end()).toEqual([{ id: 2 }]);
  });
  it("adds empty capabilities when the engine sent none, and leaves other methods alone", () => {
    expect(rewriteInitializeCapabilities({ jsonrpc: "2.0", id: 1, method: "initialize" })).toMatchObject({ params: { capabilities: {} } });
    expect(rewriteInitializeCapabilities({ jsonrpc: "2.0", id: 1, method: "initialize", params: [1] })).toMatchObject({ params: { capabilities: {} } });
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", capabilities: { keep: 1 } } };
    expect(rewriteInitializeCapabilities(call)).toBe(call);
  });
});

describe("splitUpstreamFrames", () => {
  it("reads a JSON body, an SSE body, and ignores junk", () => {
    expect(splitUpstreamFrames('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(splitUpstreamFrames('event: message\ndata: {"id":1}\n\ndata: {"method":"notifications/progress"}\r\n\r\ndata: [DONE]\n\ndata: not json\n\n', "text/event-stream")).toEqual([{ id: 1 }, { method: "notifications/progress" }]);
    expect(splitUpstreamFrames('data: {"id":\ndata: 2}\n\n', "text/event-stream")).toEqual([{ id: 2 }]);
    for (const empty of ["", "  ", "[1,2]", "{oops", "null"]) expect(splitUpstreamFrames(empty, "application/json")).toEqual([]);
    expect(splitUpstreamFrames('{"id":1}', "text/event-stream; charset=utf-8")).toEqual([]);
  });
});

describe("classifyFrame and serverRequestReply", () => {
  it("tells the answer from a notification and from a request the server made", () => {
    expect(classifyFrame({ jsonrpc: "2.0", id: 7, result: {} }, 7)).toBe("answer");
    expect(classifyFrame({ jsonrpc: "2.0", id: 7, error: { code: -1 } }, 7)).toBe("answer");
    expect(classifyFrame({ jsonrpc: "2.0", id: 8, result: {} }, 7)).toBe("other");
    expect(classifyFrame({ jsonrpc: "2.0", method: "notifications/message" }, 7)).toBe("notification");
    expect(classifyFrame({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage" }, 7)).toBe("server-request");
    expect(classifyFrame({ jsonrpc: "2.0", id: 7, method: "ping" }, 7)).toBe("server-request");
    expect(classifyFrame({ jsonrpc: "2.0", id: 7, result: {} }, undefined)).toBe("other");
    expect(classifyFrame({ jsonrpc: "2.0" }, 7)).toBe("other");
  });
  it("a server ping is answered, sampling, elicitation and roots get -32601", () => {
    expect(serverRequestReply({ jsonrpc: "2.0", id: 4, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    for (const method of ["sampling/createMessage", "elicitation/create", "roots/list", "anything/else"]) {
      expect(serverRequestReply({ jsonrpc: "2.0", id: "x", method })).toEqual({ jsonrpc: "2.0", id: "x", error: { code: -32601, message: "Method not found" } });
    }
  });
});

describe("failureFrame and failureText: every id is answered", () => {
  it("a failed tool call is a readable tool result, anything else a JSON-RPC error", () => {
    expect(failureFrame("tools/call", 5, "Sign in again.")).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "Sign in again." }], isError: true } });
    expect(failureFrame("tools/list", 6, "Nope.")).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32000, message: "Nope." } });
    expect(failureFrame("initialize", "a", "x")).toMatchObject({ id: "a", error: { message: "x" } });
  });
  it("uses the relay's sentence, bounded, or the fallback", () => {
    expect(failureText({ code: "sign-in-ended", error: "Your sign-in to x has ended. Sign in again." }, "fallback")).toBe("Your sign-in to x has ended. Sign in again.");
    expect(failureText({ error: "x".repeat(1000) }, "f")).toHaveLength(400);
    for (const bad of [null, [], "text", {}, { error: "" }, { error: 5 }]) expect(failureText(bad, "fallback")).toBe("fallback");
  });
});

describe("module hygiene", () => {
  const source = readFileSync(new URL("./remote-mcp-proxy-core.ts", import.meta.url), "utf8");
  it("imports nothing and carries the license header", () => {
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
  });
});
