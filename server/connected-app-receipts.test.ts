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
import { ConnectedAppReceipts, answeredActionClasses, receiptForAnswer } from "./connected-app-receipts.ts";
import { SqliteReceiptStore } from "./connected-app-journal.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReplyActions, completedToolAction, startedToolAction, toolAction } from "./reply-action-guard.ts";
import type { Message } from "./store.ts";
import { UNMATCHED_ACTION_EXPLANATION, unmatchedActionLabel } from "../shared/reply-action-claims.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
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

it("a send collected by a later turn's status check is credited to the turn that dispatched it (lane 5.6)", async () => {
  answer = { status: 200, body: (id) => sentFrame(id), delayMs: 300 };
  const relayAs = async (name: string, args: unknown, generation: string, options: { waitMs?: number; statusWaitMs?: number } = {}) => {
    const claim = { threadId: "th", botId: "ember", generation };
    const payload = { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } };
    const reply = await relayConnectedAppCall({}, payload as never, undefined, undefined, {
      botId: "ember", ...options, origin: claim,
      onAnswered: (call, frame) => receipts.record(receiptForAnswer(claim, call, frame)),
    });
    return JSON.parse(new TextDecoder().decode(reply.bytes));
  };
  const first = await relayAs("COMPOSIO_MULTI_EXECUTE_TOOL", sendArgs(), "gen-A", { waitMs: 20 });
  const handle = /handle (?:is )?(op-[a-z0-9-]+)/.exec(JSON.stringify(first))![1]!;
  await relayAs("CHECK_CONNECTED_APP_ACTION", { handle }, "gen-B", { statusWaitMs: 2_000 });
  expect([...receipts.forTurn({ threadId: "th", generation: "gen-A" })]).toEqual(["send"]);
  expect(receipts.forTurn({ threadId: "th", generation: "gen-B" }).size).toBe(0);
});

it("receiptForAnswer falls back to the collecting call when no origin is known", () => {
  const claim = { threadId: "th", botId: "ember", generation: "gen-B" };
  const frame = sentFrame(1) as Record<string, unknown>;
  const args = sendArgs();
  expect(receiptForAnswer(claim, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", args }, frame).generation).toBe("gen-B");
  expect(receiptForAnswer(claim, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", args, origin: { ...claim, generation: "gen-A" } }, frame).generation).toBe("gen-A");
});

it("receipts survive a restart between the send and the end of the turn (lane 5.7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipts-"));
  try {
    const file = join(dir, "connected-app-ledger.db");
    let now = 1_000_000;
    const before = new ConnectedAppReceipts(() => now, new SqliteReceiptStore(file), (_thread, generation) => generation === "gen-1" ? "turn-1" : undefined);
    before.record({ threadId: "th", botId: "ember", generation: "gen-1", classes: ["send"] });
    // a new process: a fresh object reading the same file, with no generation known
    now += 5_000;
    const after = new ConnectedAppReceipts(() => now, new SqliteReceiptStore(file), () => undefined);
    expect([...after.forTurn({ threadId: "th", turnId: "turn-1" })]).toEqual(["send"]);
    // the earlier process's generation is not an owner here, and another thread's turn of the same id is its own
    expect(after.forTurn({ threadId: "th", generation: "gen-1" }).size).toBe(0);
    expect(after.forTurn({ threadId: "th-2", turnId: "turn-1" }).size).toBe(0);
    // old receipts are dropped on load
    now += 7 * 60 * 60_000;
    expect(new ConnectedAppReceipts(() => now, new SqliteReceiptStore(file)).forTurn({ threadId: "th", turnId: "turn-1" }).size).toBe(0);
  } finally { removeTempDirSync(dir); }
});

it("a store that cannot be written never stops the in-memory receipt", () => {
  const broken = { load: () => [], add: () => { throw new Error("disk full"); } } as unknown as SqliteReceiptStore;
  const local = new ConnectedAppReceipts(Date.now, broken);
  local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"] });
  expect(local.forTurn({ threadId: "th", generation: "g" }).has("send")).toBe(true);
});

describe("lane 5 round 2: receipts keep who dispatched, when the app answered, and one row per operation", () => {
  const withStore = <T>(run: (file: string) => Promise<T> | T) => {
    const dir = mkdtempSync(join(tmpdir(), "receipts-r2-"));
    return Promise.resolve(run(join(dir, "connected-app-ledger.db"))).finally(() => removeTempDirSync(dir));
  };

  it("a later turn that collected the answer is never credited, before or after a restart (T1)", () => withStore((file) => {
    let now = 300;
    const first = new ConnectedAppReceipts(() => now, new SqliteReceiptStore(file));
    const claimB = { threadId: "th", botId: "ember", generation: "gen-B" };
    first.record(receiptForAnswer(claimB, { name: "COMPOSIO_MULTI_EXECUTE_TOOL", args: sendArgs(), origin: { ...claimB, generation: "gen-A", turnId: "turn-A" }, key: "op-1", dispatchedAt: 100 }, sentFrame(1) as Record<string, unknown>));
    const assertOwner = (receipts: ConnectedAppReceipts) => {
      expect(receipts.forTurn({ threadId: "th", turnId: "turn-B" }).size).toBe(0);
      expect(receipts.forTurn({ threadId: "th", turnId: "turn-B", generation: "gen-B" }).size).toBe(0);
      expect([...receipts.forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
    };
    assertOwner(first);
    now = 400;
    assertOwner(new ConnectedAppReceipts(() => now, new SqliteReceiptStore(file)));
    // @ts-expect-error since is not an owner
    first.forTurn({ threadId: "th", since: 0 });
    // @ts-expect-error botId is not an owner
    first.forTurn({ threadId: "th", botId: "ember" });
  }));

  it("a row written before receipts named their turn is never anyone's (T2)", () => withStore((file) => {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE connected_app_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, generation TEXT NOT NULL, classes TEXT NOT NULL, at INTEGER NOT NULL, op_key TEXT, dispatched_at INTEGER)`);
    db.exec("CREATE UNIQUE INDEX connected_app_receipts_op_key ON connected_app_receipts(op_key)");
    db.prepare("INSERT INTO connected_app_receipts (thread_id,bot_id,generation,classes,at,op_key,dispatched_at) VALUES (?,?,?,?,?,?,?)").run("th", "ember", "gen-A", JSON.stringify(["send"]), 300, "op-old", 100);
    db.close();
    const local = new ConnectedAppReceipts(() => 400, new SqliteReceiptStore(file), () => "turn-A");
    for (const turnId of ["turn-A", "turn-B", "op-old"]) expect(local.forTurn({ threadId: "th", turnId }).size).toBe(0);
    expect(local.forTurn({ threadId: "th", generation: "gen-A" }).size).toBe(0);
    expect(local.forTurn({ threadId: "th", generation: "gen-B" }).size).toBe(0);
    expect(local.forTurn({ threadId: "th", turnId: "turn-A", generation: "gen-A" }).size).toBe(0);
    expect(new SqliteReceiptStore(file).load(0)[0]?.turnId).toBeUndefined();
  }));

  it("a receipt kept before its turn was bound is named once the turn is known, and keeps the name across a restart (T3)", () => withStore((file) => {
    let bound: string | undefined;
    const store = new SqliteReceiptStore(file);
    const local = new ConnectedAppReceipts(Date.now, store, (_thread, generation) => generation === "gen-A" ? bound : undefined);
    local.record({ threadId: "th", botId: "ember", generation: "gen-A", classes: ["send"], key: "op-1" });
    expect(store.load(0)[0]?.turnId).toBeUndefined();
    bound = "turn-A";
    expect([...local.forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
    expect(store.load(0)[0]?.turnId).toBe("turn-A");
    expect([...new ConnectedAppReceipts(Date.now, new SqliteReceiptStore(file), () => undefined).forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
  }));

  it("a learned turn whose write fails once is written on the next try and survives a restart", () => withStore((file) => {
    const real = new SqliteReceiptStore(file);
    let failBind = 1;
    const flaky = Object.assign(Object.create(SqliteReceiptStore.prototype) as SqliteReceiptStore, {
      load: (c: number) => real.load(c),
      add: (...a: Parameters<SqliteReceiptStore["add"]>) => real.add(...a),
      bindTurn: (key: string, turnId: string) => { if (failBind-- > 0) throw new Error("locked"); real.bindTurn(key, turnId); },
    });
    let bound: string | undefined;
    const local = new ConnectedAppReceipts(Date.now, flaky, () => bound);
    local.record({ threadId: "th", botId: "ember", generation: "gen-A", classes: ["send"], key: "op-1" });
    bound = "turn-A";
    // the first write of the learned turn fails; memory still credits the turn
    expect([...local.forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
    expect(real.load(0)[0]?.turnId).toBeUndefined();
    // the next lookup drains the queued binding
    expect([...local.forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
    expect(real.load(0)[0]?.turnId).toBe("turn-A");
    expect([...new ConnectedAppReceipts(Date.now, new SqliteReceiptStore(file), () => undefined).forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
  }));

  it("a slow action that finishes after the bot's wait is kept without any status read, across a restart", () => withStore(async (file) => {
    resetConnectedAppOperations();
    answer = { status: 200, body: (id) => sentFrame(id), delayMs: 150 };
    const live = new ConnectedAppReceipts(Date.now, new SqliteReceiptStore(file));
    const claim = { threadId: "th", botId: "ember", generation: "gen-A", turnId: "turn-A" };
    const payload = { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: sendArgs() } };
    const reply = await relayConnectedAppCall({}, payload as never, undefined, undefined, {
      botId: "ember", waitMs: 10, origin: claim,
      onAnswered: (call, frame) => live.record(receiptForAnswer(claim, call, frame)),
    });
    expect(JSON.stringify(JSON.parse(new TextDecoder().decode(reply.bytes)))).toMatch(/handle/);
    expect(live.forTurn({ threadId: "th", generation: "gen-A" }).size).toBe(0);
    await vi.waitFor(() => expect(live.forTurn({ threadId: "th", generation: "gen-A" }).has("send")).toBe(true), { timeout: 3_000 });
    // a new process, no status read: the turn id is the owner that survives
    expect([...new ConnectedAppReceipts(Date.now, new SqliteReceiptStore(file)).forTurn({ threadId: "th", turnId: "turn-A" })]).toEqual(["send"]);
    expect(new SqliteReceiptStore(file).load(0).map((r) => r.turnId)).toEqual(["turn-A"]);
  }));

  it("a send answered, then collected by a status check and joined by a repeat, leaves one receipt in memory and one row in the store (104 P6)", () => withStore(async (file) => {
    resetConnectedAppOperations();
    answer = { status: 200, body: (id) => sentFrame(id), delayMs: 100 };
    const store = new SqliteReceiptStore(file);
    const live = new ConnectedAppReceipts(Date.now, store);
    const claim = { threadId: "th", botId: "ember", generation: "gen-A", turnId: "turn-A" };
    const call = async (name: string, args: unknown, options: { waitMs?: number; statusWaitMs?: number } = {}) => {
      const payload = { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } };
      const reply = await relayConnectedAppCall({}, payload as never, undefined, undefined, {
        botId: "ember", ...options, origin: claim,
        onAnswered: (c, frame) => live.record(receiptForAnswer(claim, c, frame)),
      });
      return JSON.parse(new TextDecoder().decode(reply.bytes));
    };
    const args = sendArgs();
    const first = await call("COMPOSIO_MULTI_EXECUTE_TOOL", args, { waitMs: 10 });
    const handle = /handle (?:is )?(op-[a-z0-9-]+)/.exec(JSON.stringify(first))![1]!;
    await vi.waitFor(() => expect(live.forTurn({ threadId: "th", generation: "gen-A" }).has("send")).toBe(true), { timeout: 3_000 });
    await call("CHECK_CONNECTED_APP_ACTION", { handle }, { statusWaitMs: 2_000 });
    await call("COMPOSIO_MULTI_EXECUTE_TOOL", args, { waitMs: 2_000 });
    expect(store.load(0)).toHaveLength(1);
  }));

  it("reading the same operation's answer again keeps one receipt", () => withStore((file) => {
    const store = new SqliteReceiptStore(file);
    const local = new ConnectedAppReceipts(Date.now, store);
    for (let i = 0; i < 3; i++) local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], key: "op-1", dispatchedAt: 1 });
    expect(store.load(0)).toHaveLength(1);
  }));

  it("a store that fails once keeps the receipt in memory and writes it on the next try", () => withStore((file) => {
    const real = new SqliteReceiptStore(file);
    let fail = true;
    const flaky = { load: (c: number) => { if (fail) throw new Error("locked"); return real.load(c); }, add: (...a: Parameters<SqliteReceiptStore["add"]>) => { if (fail) throw new Error("locked"); return real.add(...a); } } as unknown as SqliteReceiptStore;
    const local = new ConnectedAppReceipts(Date.now, flaky);
    local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], key: "op-1" });
    local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], key: "op-1" });
    expect(real.load(0)).toHaveLength(0);
    fail = false;
    // a repeat of a kept receipt returns early, but drains what the store missed first (T4)
    local.record({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], key: "op-1" });
    expect(real.load(0)).toHaveLength(1);
    expect(local.forTurn({ threadId: "th", generation: "g" }).has("send")).toBe(true);
    expect(real.load(0)).toHaveLength(1);
  }));

  it("old rows are pruned when a receipt is added, without a restart", () => withStore((file) => {
    const store = new SqliteReceiptStore(file);
    store.add({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], at: 10, key: "old" }, 0, 10);
    store.add({ threadId: "th", botId: "ember", generation: "g", classes: ["send"], at: 5_000, key: "new" }, 1_000, 10);
    expect(store.load(0).map((r) => r.key)).toEqual(["new"]);
  }));
});

describe("lane 5 redesign: the reply check matches receipts by turn, never by time (T8)", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("server/index.ts asks for the turn's receipts by turn id and generation only", () => {
    const index = source("./index.ts");
    const start = index.indexOf("async function recordReplyActionCheck(");
    const check = index.slice(start, index.indexOf("\n}\n", start));
    expect(check).toContain("forTurn({ threadId, turnId: reply.turnId, generation })");
    expect(check).not.toContain("since:");
    expect(check).not.toContain("turnRows(threadId, reply.turnId)");
    expect(index).toMatch(/origin: \{[^}]*turnId: internalCapabilities\.providerTurnOf\(/);
    expect(index).toContain("new ConnectedAppReceipts(Date.now, new SqliteReceiptStore(defaultJournalFile(DATA_DIR)), (threadId, generation) => internalCapabilities.providerTurnOf(threadId, generation))");
  });
  it("no receipt match compares a timestamp", () => {
    const receipts = source("./connected-app-receipts.ts");
    const match = receipts.slice(receipts.indexOf("  forTurn("));
    expect(receipts).not.toMatch(/dispatchedAt \?\? /);
    expect(match).not.toMatch(/since|\.at\b|dispatchedAt|botId/);
  });
});
