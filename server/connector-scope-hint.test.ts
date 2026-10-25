// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAppCatalogState } from "./app-catalog.ts";
import { relayConnectedAppCall, resetConnectedAppOperations, scopeRouteFor, setManagedBrokerAccess } from "./composio.ts";
import { scopeHint, toolSlugsOf, withScopeHint } from "./connector-scope-hint.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const REFUSED = "403 ACCESS_TOKEN_SCOPE_INSUFFICIENT: Request had insufficient authentication scopes.";
const frame = (id: unknown, text: string) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });

describe("the missing-permission note (item 112)", () => {
  it("adds one text block to a refused JSON result and leaves the provider's text alone", () => {
    const out = JSON.parse(dec.decode(withScopeHint(enc.encode(JSON.stringify(frame(1, REFUSED))), "application/json", ["GMAIL_CREATE_FILTER"])));
    expect(out.result.content).toHaveLength(2);
    expect(out.result.content[0].text).toBe(REFUSED);
    expect(out.result.content[1].text).toContain("Gmail");
    expect(out.result.content[1].text).toContain("filters, vacation replies and mail settings");
    expect(out.result.content[1].text).toContain("do not retry");
  });

  it("annotates a refused event-stream frame once, whatever else the stream carries", () => {
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\ndata: ${JSON.stringify(frame(2, REFUSED))}\n\n`;
    const out = dec.decode(withScopeHint(enc.encode(body), "text/event-stream", ["GMAIL_SETTINGS_FORWARD"]));
    expect(out.match(/Note from Murage/g)).toHaveLength(1);
    expect(out).toContain("forwarding, send-as addresses and delegates");
    expect(out).toContain("notifications/progress");
  });

  it("returns a normal result, an unreadable body and a body with no content byte for byte", () => {
    for (const body of [JSON.stringify(frame(3, "all good")), "not json at all", JSON.stringify({ jsonrpc: "2.0", id: 4, error: { code: -1, message: "nope" } })]) {
      const bytes = enc.encode(body);
      expect(withScopeHint(bytes, "application/json", [])).toBe(bytes);
    }
    const unreadable = enc.encode(`${REFUSED} {broken`);
    expect(withScopeHint(unreadable, "application/json", [])).toBe(unreadable);
  });

  it("names the app generally when the tool is not a known one, and never uses a dash, a vendor or a price", () => {
    const note = scopeHint(["SLACK_POST_MESSAGE"]);
    expect(note).toContain("Slack");
    expect(note).toContain("the permission this action needs");
    for (const text of [note, scopeHint([]), scopeHint(["GMAIL_CREATE_FILTER"])]) {
      expect(text).not.toMatch(/—|–|composio|\bsafe|\bunsafe|\bprice|OpenMaus/i);
    }
  });

  it("reads the tool slugs from a batch call or from the tool's own name", () => {
    expect(toolSlugsOf("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_CREATE_FILTER", arguments: {} }, { tool_slug: "GMAIL_CREATE_FILTER" }] })).toEqual(["GMAIL_CREATE_FILTER"]);
    expect(toolSlugsOf("GMAIL_SETTINGS_FORWARD", {})).toEqual(["GMAIL_SETTINGS_FORWARD"]);
    expect(toolSlugsOf("COMPOSIO_MULTI_EXECUTE_TOOL", {})).toEqual([]);
  });
});

describe("through the connected-app relay (item 112)", () => {
  let server: Server;
  let base: string;
  let answer: (id: unknown) => unknown = (id) => frame(id, "ok");
  let calls = 0;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = body ? JSON.parse(body) : {};
      res.setHeader("content-type", "application/json");
      if (message.method !== "tools/call") { res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} })); return; }
      calls += 1;
      res.end(JSON.stringify(answer(message.id)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    base = `http://127.0.0.1:${address.port}`;
    const localFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === base) return localFetch(input, init);
      throw new Error(`Unexpected external request: ${url.origin}`);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    setManagedBrokerAccess(null);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    setManagedBrokerAccess({ url: base, token: "9".repeat(64) });
    resetAppCatalogState({ disk: true });
    resetConnectedAppOperations();
    calls = 0;
  });

  const call = async (id: number) => {
    const args = { tools: [{ tool_slug: "GMAIL_CREATE_FILTER", arguments: { from: "a@example.com" } }], sync_response_to_workbench: false };
    const payload = { jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: args } };
    const reply = await relayConnectedAppCall({}, payload as never, undefined, undefined, { botId: "ember" });
    return JSON.parse(dec.decode(reply.bytes));
  };

  it("a refused Gmail filter call gets the note, and the same call repeated gets the same answer plus the same note", async () => {
    answer = (id) => frame(id, REFUSED);
    const first = await call(7);
    expect(first.result.content.map((item: { text: string }) => item.text.slice(0, 12))).toEqual(["403 ACCESS_T", "Note from Mu"]);
    const again = await call(8);
    const notes = again.result.content.filter((item: { text: string }) => item.text.startsWith("Note from Murage"));
    expect(notes).toHaveLength(1);
    expect(again.result.content.some((item: { text: string }) => item.text === REFUSED)).toBe(true);
    expect(calls).toBe(1);
  });

  it("an ordinary answer is not annotated", async () => {
    answer = (id) => frame(id, "filter created");
    const out = await call(9);
    expect(out.result.content).toEqual([{ type: "text", text: "filter created" }]);
  });

  it("L3: reconnecting is ruled out on the managed route only; on the person's own account it can help", () => {
    const managed = scopeHint(["GMAIL_CREATE_FILTER"]);
    const own = scopeHint(["GMAIL_CREATE_FILTER"], "own");
    expect(managed).toContain("reconnecting the app will not change it");
    expect(own).not.toContain("will not change it");
    expect(own).toMatch(/reconnect/i);
    expect(own).toMatch(/can (?:help|fix)/);
    expect(own).not.toMatch(/—|–|composio|\bsafe|\bunsafe|\bprice/i);
  });

  it("L3b: both broker kinds are the managed route; only no broker (the person's own workspace key) is the own route", () => {
    expect(scopeRouteFor("flux")).toBe("managed");
    expect(scopeRouteFor("legacy")).toBe("managed");
    expect(scopeRouteFor(null)).toBe("own");
    expect(scopeHint(["GMAIL_CREATE_FILTER"], scopeRouteFor("flux"))).toContain("reconnecting the app will not change it");
    expect(scopeHint(["GMAIL_CREATE_FILTER"], scopeRouteFor("legacy"))).toContain("reconnecting the app will not change it");
    expect(scopeHint(["GMAIL_CREATE_FILTER"], scopeRouteFor(null))).not.toContain("will not change it");
  });

  it("L3c: a refused call through the managed broker relay carries the managed copy", async () => {
    answer = (id) => frame(id, REFUSED);
    const out = await call(11);
    const note = out.result.content.find((item: { text: string }) => item.text.startsWith("Note from Murage"));
    expect(note.text).toContain("reconnecting the app will not change it");
  });
});
