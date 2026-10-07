// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyFrame, failureFrame, failureText, rewriteInitializeCapabilities, serverRequestReply, splitUpstreamFrames } from "./remote-mcp-proxy-core.ts";

describe("rewriteInitializeCapabilities (decision D10)", () => {
  it("replaces whatever the engine announced with nothing, and keeps the rest", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } }, clientInfo: { name: "claude", version: "1" } } };
    expect(rewriteInitializeCapabilities(message)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
    expect(message.params.capabilities).toEqual({ sampling: {}, elicitation: {}, roots: { listChanged: true } }); // input untouched
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
