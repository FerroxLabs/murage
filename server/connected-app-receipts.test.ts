// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 P1: a real Gmail send through a connected app was marked as an action
// with no record, although the email was in Sent. The relay every engine's
// connected-app calls pass now keeps a receipt of what the app completed, and
// the reply check counts it, whatever shape the engine's own tool events took.
// A claim with no call, a failed call and a refused call still get the note.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppCatalogState } from "./app-catalog.ts";
import { relayConnectedAppCall, resetConnectedAppOperations, setManagedBrokerAccess } from "./composio.ts";
import { ConnectedAppReceipts, answeredActionClasses } from "./connected-app-receipts.ts";
import { checkReplyActions, completedToolAction, startedToolAction, toolAction } from "./reply-action-guard.ts";
import type { Message } from "./store.ts";
import { UNMATCHED_ACTION_EXPLANATION, unmatchedActionLabel } from "../shared/reply-action-claims.ts";

let server: Server, base: string;
/** How the fixture broker answers the next tools/call. */
let answer: { status: number; body: (id: unknown) => unknown; delayMs?: number } = { status: 200, body: (id) => sentFrame(id) };

const composioResult = (successful: boolean) => ({
  successful,
  error: successful ? null : "Recipient address rejected",
  data: { results: [{ tool_slug: "GMAIL_SEND_EMAIL", index: 0, response: successful ? { successful: true, data: { id: "msg-1", labelIds: ["SENT"] } } : { successful: false, error: "Recipient address rejected" } }] },
});
const sentFrame = (id: unknown, successful = true) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(composioResult(successful)) }] } });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (message.method !== "tools/call") { res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} })); return; }
    const reply = answer;
    const send = () => { res.statusCode = reply.status; res.end(JSON.stringify(reply.body(message.id))); };
    if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return localFetch(input, init);
    throw new Error(`Unexpected external request in the receipts fixture: ${url.origin}`);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  setManagedBrokerAccess(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let receipts: ConnectedAppReceipts;
let callId = 0;
beforeEach(() => {
  setManagedBrokerAccess({ url: base, token: "9".repeat(64) });
  resetAppCatalogState({ disk: true });
  resetConnectedAppOperations();
  receipts = new ConnectedAppReceipts();
  answer = { status: 200, body: (id) => sentFrame(id) };
});

const sendArgs = () => ({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Invoice", body: `See attached #${++callId}` } }], sync_response_to_workbench: false });
/** One call through the relay, as the bridge of turn `generation` makes it; what the app completed becomes a receipt. */
async function relay(name: string, args: unknown, generation: string, options: { waitMs?: number; statusWaitMs?: number } = {}) {
  const payload = { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } };
  const reply = await relayConnectedAppCall({}, payload as never, undefined, undefined, {
    botId: "ember", ...options,
    onAnswered: (call, frame) => receipts.record({ threadId: "th", botId: "ember", generation, classes: answeredActionClasses(call.name, call.args, frame) }),
  });
  return JSON.parse(new TextDecoder().decode(reply.bytes));
}

let n = 0;
const row = (over: Partial<Message>): Message => ({ id: `r${++n}`, at: n, role: "bot", kind: "text", from: { botId: "ember", name: "Ember", color: "" }, ...over }) as Message;
const owner = () => row({ role: "user", text: "Send Ana the invoice email.", from: undefined });

/** A tool row as server/index.ts folds an engine's item.started and item.completed. */
function engineToolRow(started: Parameters<typeof startedToolAction>[0], completed: { ok: boolean; result?: unknown }, turnId = "turn-1"): Message {
  const name = started.title ?? "tool";
  const atStart = { name, action: startedToolAction(started), summary: started.summary };
  return row({ kind: "activity", turnId, tool: { name, action: completedToolAction(atStart, completed.ok, completed.result), ok: completed.ok } });
}

/** The engine shapes of one connected-app send, as each driver reports it. */
const ENGINES: Record<string, (args: unknown, ok: boolean) => Message> = {
  // Fuigo over ACP: the tool starts before its arguments arrive, and a long result is kept in a file.
  "Fuigo (ACP)": (_args, ok) => engineToolRow(
    { title: "COMPOSIO_MULTI_EXECUTE_TOOL", toolIdentity: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" }, input: {} },
    { ok, result: [{ type: "content", content: { type: "text", text: "Output saved to /tmp/fuigo/call_00_ab12.json (14 KB)." } }] }),
  // Codex app-server: mcpToolCall with arguments, a result whose structured part is null.
  Codex: (args, ok) => engineToolRow(
    { title: "COMPOSIO_MULTI_EXECUTE_TOOL", toolIdentity: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" }, input: args },
    { ok, result: { content: [{ type: "text", text: "[result truncated by the engine]" }], structuredContent: null } }),
  // Claude: the namespaced MCP name and a plain text result.
  Claude: (args, ok) => engineToolRow(
    { title: "mcp__murage-connectors__COMPOSIO_MULTI_EXECUTE_TOOL", input: args },
    { ok, result: "Done." }),
  // An engine that reports only a title and an ok flag.
  "title only": (_args, ok) => engineToolRow({ title: "Gmail: send email" }, { ok }),
};

function check(text: string, record: Message[], relayed: Iterable<import("../shared/reply-action-claims.ts").ActionClass>) {
  const reply = row({ text, turnId: "turn-1", turnTerminal: true });
  return checkReplyActions({ reply, path: [owner(), ...record, reply], relayed });
}

describe.each(Object.entries(ENGINES))("a real send through the connected-app relay on %s", (_engine, shape) => {
  it("records \"I sent it\" with no unmatched-action note", async () => {
    const args = sendArgs();
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", args, "gen-1");
    const result = check("I sent it to Ana.", [shape(args, true)], receipts.forTurn({ threadId: "th", generation: "gen-1" }));
    expect(result.state).toBe("recorded");
    expect(result.claims.filter((claim) => claim.state === "flagged")).toEqual([]);
  });
  it("a failed send still gets the note", async () => {
    const args = sendArgs();
    answer = { status: 200, body: (id) => sentFrame(id, false) };
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", args, "gen-1");
    expect(receipts.forTurn({ threadId: "th", generation: "gen-1" }).size).toBe(0);
    expect(check("I sent it to Ana.", [shape(args, false)], receipts.forTurn({ threadId: "th", generation: "gen-1" })).state).toBe("flagged");
  });
});

describe("what is not a receipt", () => {
  it("a claim with no tool call still gets the note, even when another turn sent mail", async () => {
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-other");
    const result = check("I sent it to Ana.", [], receipts.forTurn({ threadId: "th", generation: "gen-1" }));
    expect(result.state).toBe("flagged");
    expect(result.claims[0]).toMatchObject({ class: "send", state: "flagged" });
  });
  it("an error answer, a tool error and a refusal are not receipts", async () => {
    answer = { status: 200, body: (id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "not allowed" } }) };
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-1");
    answer = { status: 200, body: (id) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(composioResult(true)) }] } }) };
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-1");
    answer = { status: 400, body: () => ({ error: "bad request" }) };
    await relay("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-1");
    expect(receipts.forTurn({ threadId: "th", generation: "gen-1" }).size).toBe(0);
  });
  it("a lookup is not an action", async () => {
    answer = { status: 200, body: (id) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [] } }) }] } }) };
    await relay("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "send an email" }] }, "gen-1");
    expect(receipts.forTurn({ threadId: "th", generation: "gen-1" }).size).toBe(0);
  });
});

it("a slow send collected with the status tool is a receipt once its outcome arrives", async () => {
  answer = { status: 200, body: (id) => sentFrame(id), delayMs: 300 };
  const first = await relay("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-1", { waitMs: 20 });
  const handle = /handle (?:is )?(op-[a-z0-9-]+)/.exec(JSON.stringify(first))![1]!;
  expect(receipts.forTurn({ threadId: "th", generation: "gen-1" }).size).toBe(0);
  await relay("CHECK_CONNECTED_APP_ACTION", { handle }, "gen-1", { statusWaitMs: 2_000 });
  expect([...receipts.forTurn({ threadId: "th", generation: "gen-1" })]).toEqual(["send"]);
});

it("without a known generation, the same bot's receipts in the thread since the turn began count", () => {
  let now = 100;
  const local = new ConnectedAppReceipts(() => now);
  local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"] });
  now = 200;
  expect(local.forTurn({ threadId: "th", botId: "ember", since: 50 }).has("send")).toBe(true);
  expect(local.forTurn({ threadId: "th", botId: "ember", since: 150 }).size).toBe(0);
  expect(local.forTurn({ threadId: "th", botId: "other", since: 50 }).size).toBe(0);
  expect(local.forTurn({ threadId: "th-2", botId: "ember", since: 50 }).size).toBe(0);
});

it("a workbench run leaves a send claim unverifiable, never flagged; a failed one proves nothing", () => {
  const ran = row({ kind: "activity", turnId: "turn-1", tool: { name: "COMPOSIO_REMOTE_WORKBENCH", ok: true, action: toolAction("COMPOSIO_REMOTE_WORKBENCH", true, { code_to_execute: "run_composio_tool('GMAIL_SEND_EMAIL', {...})" }, { successful: true }) } });
  expect(check("I sent it to Ana.", [ran], []).state).toBe("unverifiable");
  const failed = row({ kind: "activity", turnId: "turn-1", tool: { name: "COMPOSIO_REMOTE_WORKBENCH", ok: false, action: toolAction("COMPOSIO_REMOTE_WORKBENCH", false) } });
  expect(check("I sent it to Ana.", [failed], []).state).toBe("flagged");
});

it("the note's words follow the copy rules", () => {
  for (const words of [UNMATCHED_ACTION_EXPLANATION, unmatchedActionLabel("I sent it to Ana.")]) {
    expect(words).not.toMatch(/—|–/);
    expect(words).not.toMatch(/composio/i);
    expect(words).not.toMatch(/Nothing was done/);
  }
});
