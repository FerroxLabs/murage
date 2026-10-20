// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2: a slow connected-app action is never dispatched twice. The bot's wait
// ends; the action does not, its outcome is kept, and the same request made
// again joins it instead of running again.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppCatalogState } from "./app-catalog.ts";
import { relayConnectedAppCall, resetConnectedAppOperations, restartConnectedAppOperations, setManagedBrokerAccess } from "./composio.ts";
import {
  ConnectedAppOperations, OPERATION_MAX_ENTRIES, OPERATION_MAX_PENDING, OperationRefused, normalizedJson, operationKey, replyMessage, type RelayReply,
} from "./connected-app-operations.ts";
import type { JournalRecord, OperationJournal } from "./connected-app-journal.ts";
import { classifyConnectedAppCall } from "../shared/connected-app-readonly.ts";
import { CONNECTED_APP_REPEAT_WINDOW_MS, CONNECTED_APP_RESULT_TTL_MS, connectedAppProvenance } from "../shared/connected-app-calls.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let server: Server, base: string;
const dispatched: Array<{ id: unknown; name: unknown; args: unknown }> = [];
/** How the fixture broker answers the next tools/call. */
let mode: "delay" | "hang" | "refuse" | "answer" | "unavailable" | "unavailable-undispatched" | "stream" = "answer";
let delayMs = 0;
/** When set, the next tools/call is answered with exactly this (and cleared). */
let override: { status: number; body: unknown; sse?: boolean; raw?: string } | null = null;
const hung: Array<() => void> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (message.method !== "tools/call") { res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} })); return; }
    dispatched.push({ id: message.id, name: message.params?.name, args: message.params?.arguments });
    const count = dispatched.length;
    const answer = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `sent #${count}` }] } }));
    if (override) {
      const next = override; override = null;
      res.statusCode = next.status;
      if (next.raw !== undefined) { res.end(next.raw); return; }
      if (next.sse) { res.setHeader("content-type", "text/event-stream"); res.end(`data: ${JSON.stringify(next.body)}\n\n`); return; }
      res.end(JSON.stringify(next.body));
      return;
    }
    if (mode === "hang") { hung.push(() => res.destroy()); return; }
    if (mode === "unavailable") { res.statusCode = 503; res.end(JSON.stringify({ error: "service unavailable" })); return; }
    if (mode === "unavailable-undispatched") { res.statusCode = 503; res.end(JSON.stringify({ error: "service unavailable", dispatched: false })); return; }
    if (mode === "stream") {
      // An event stream that also carries the answer to a different request, last.
      res.setHeader("content-type", "text/event-stream");
      const frame = (id: unknown, text: string) => `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })}\n\n`;
      res.end(frame(message.id, `own answer #${count}`) + frame(9999, "someone else's answer"));
      return;
    }
    if (mode === "refuse") { res.statusCode = 400; res.end(JSON.stringify({ error: "bad request" })); return; }
    // Committed upstream at once; the answer is what is slow.
    if (mode === "delay") { setTimeout(answer, delayMs); return; }
    answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = `http://127.0.0.1:${address.port}`;
  const localFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return localFetch(input, init);
    throw new Error(`Unexpected external request in the operations fixture: ${url.origin}`);
  });
});
afterAll(async () => {
  for (const end of hung) end();
  vi.unstubAllGlobals();
  setManagedBrokerAccess(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  setManagedBrokerAccess({ url: base, token: "9".repeat(64) });
  resetAppCatalogState({ disk: true });
  resetConnectedAppOperations();
  dispatched.length = 0;
  mode = "answer";
  delayMs = 0;
  override = null;
});

const send = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: args } });
const sendEmail = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Hi", body: "See you" } }] };
// The same request with its keys in another order.
const sendEmailReordered = { tools: [{ arguments: { body: "See you", subject: "Hi", to: "ana@example.com" }, tool_slug: "GMAIL_SEND_EMAIL" }] };
const read = (reply: RelayReply) => JSON.parse(new TextDecoder().decode(reply.bytes));
const text = (reply: RelayReply) => read(reply).result.content.map((item: { text: string }) => item.text).join("\n");
const handleOf = (reply: RelayReply) => /handle (?:is )?(op-[a-z0-9-]+)/.exec(text(reply))![1]!;
const status = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "CHECK_CONNECTED_APP_ACTION", arguments: args } });
const relay = (payload: unknown, options: { waitMs?: number; lifetimeMs?: number; statusWaitMs?: number; botId?: string; authorizeStored?: (used: { requirements: Array<{ tool: string; account?: string }>; complete: boolean }) => void } = {}) =>
  relayConnectedAppCall({}, payload as never, undefined, undefined, { botId: "bot-a", ...options });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("requests without a usable id are never forwarded", () => {
  const { id: _omit, ...noId } = send(1, sendEmail);
  for (const [label, payload] of [
    ["missing id", noId],
    ["null id", { ...noId, id: null }],
    ["object id", { ...noId, id: { a: 1 } }],
    ["empty string id", { ...noId, id: "" }],
    ["inside a batch", [send(7, sendEmail)]],
  ] as const) {
    it(`${label}: refused, nothing dispatched, twice`, async () => {
      for (let i = 0; i < 2; i++) {
        const reply = await relay(payload);
        expect(dispatched).toHaveLength(0);
        expect(JSON.parse(new TextDecoder().decode(reply.bytes)).error).toBeTruthy();
      }
    });
  }
  it("a notification-style lookup without an id still passes through", async () => {
    const lookup = { jsonrpc: "2.0", method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } };
    await relay(lookup);
    expect(dispatched).toHaveLength(1);
  });
});

describe("connected-app operations", () => {
  it("committed upstream, response delayed, retry attempted: the action is sent once", async () => {
    mode = "delay"; delayMs = 300;
    const first = await relay(send(1, sendEmail), { waitMs: 50 });
    expect(read(first).id).toBe(1);
    expect(read(first).result.isError).toBeUndefined();
    expect(text(first)).toMatch(/Gmail: send email\) is still running\. Its handle is op-/);
    expect(text(first)).toMatch(/Do not run it again/);
    const handle = handleOf(first);

    // The bot retries while the first is still on its way back.
    const retry = await relay(send(2, sendEmailReordered), { waitMs: 50 });
    expect(read(retry).id).toBe(2);
    expect(text(retry)).toContain("it was not started again");
    expect(handleOf(retry)).toBe(handle);

    await settle(400);
    // And once more after it finished upstream: the kept result, not a resend.
    const later = await relay(send(3, sendEmail), { waitMs: 50 });
    expect(read(later).id).toBe(3);
    expect(text(later)).toMatch(/already ran \d+ seconds ago \(handle op-[a-z0-9-]+\) and was not run again/);
    expect(text(later)).toContain("sent #1");
    expect(dispatched).toHaveLength(1);
  });

  it("a retry made while the action runs waits for it and returns its answer", async () => {
    mode = "delay"; delayMs = 150;
    const first = relay(send(1, sendEmail), { waitMs: 1_000 });
    await settle(20);
    const retry = await relay(send(2, sendEmail), { waitMs: 1_000 });
    expect(text(await first)).toBe("sent #1");
    expect(read(retry).id).toBe(2);
    expect(text(retry)).toContain("sent #1");
    expect(dispatched).toHaveLength(1);
  });

  it("a long action finishes in the background and its result is collected by handle", async () => {
    mode = "delay"; delayMs = 200;
    const first = await relay(send(1, { tools: [{ tool_slug: "GOOGLEDRIVE_EXPORT_FILE", arguments: { id: "f1" } }] }), { waitMs: 20 });
    const handle = handleOf(first);
    const early = await relay(status(2, { handle }), { statusWaitMs: 10 });
    expect(text(early)).toMatch(/still running/);
    const done = await relay(status(3, { handle }), { statusWaitMs: 1_000 });
    expect(read(done).id).toBe(3);
    expect(text(done)).toContain("sent #1");
    expect(dispatched).toHaveLength(1);
    // Another bot cannot read it.
    expect(text(await relay(status(4, { handle }), { botId: "bot-b" }))).toMatch(/No connected app action with handle/);
  });

  it("an action whose answer never comes is held as unknown until the bot checks and clears it", async () => {
    mode = "hang";
    const first = await relay(send(1, sendEmail), { waitMs: 20, lifetimeMs: 120 });
    const handle = handleOf(first);
    await settle(200);
    const retry = await relay(send(2, sendEmail), { waitMs: 20 });
    expect(read(retry).result.isError).toBe(true);
    expect(text(retry)).toMatch(/not known whether it finished\. It was not run again/);
    expect(dispatched).toHaveLength(1);
    const cleared = await relay(status(3, { handle, run_again: true }));
    expect(text(cleared)).toMatch(/was cleared/);
    mode = "answer";
    expect(text(await relay(send(4, sendEmail)))).toBe("sent #2");
    expect(dispatched).toHaveLength(2);
  });

  it("an HTTP 400 with no pre-send evidence may have been sent: the same request is not repeated", async () => {
    mode = "refuse";
    const first = await relay(send(1, sendEmail));
    expect(first.status).toBe(200);
    mode = "answer";
    expect(text(await relay(send(2, sendEmail)))).toMatch(/not known whether it finished/);
    expect(dispatched).toHaveLength(1);
  });

  it("different arguments or another bot are separate actions", async () => {
    await relay(send(1, sendEmail));
    await relay(send(2, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "bo@example.com", subject: "Hi", body: "See you" } }] }));
    await relay(send(3, sendEmail), { botId: "bot-b" });
    expect(dispatched).toHaveLength(3);
  });

  it("a lookup never enters the ledger", async () => {
    await relay({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: ["GMAIL_SEND_EMAIL"] } } });
    await relay({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: ["GMAIL_SEND_EMAIL"] } } });
    expect(text(await relay(status(3, { handle: "op-none" })))).toMatch(/No connected app action/);
  });
});

describe("connected-app operation ledger bounds", () => {
  const reply = (size: number): RelayReply => ({ status: 200, bytes: new Uint8Array(size), contentType: "application/json" });
  const never = () => true;

  it("normalizes argument order and drops undefined fields from an action's identity", () => {
    expect(normalizedJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
    expect(operationKey("X", { a: 1, b: 2 })).toBe(operationKey("X", { b: 2, a: 1 }));
    expect(operationKey("X", { a: 1 })).not.toBe(operationKey("Y", { a: 1 }));
  });

  it("joins a seen result only briefly; an unseen one keeps holding repeats after its bytes age out", async () => {
    let now = 1_000;
    const ops = new ConnectedAppOperations(() => now);
    const seen = ops.start("s", "k1", undefined, async () => reply(10), never);
    const unseen = ops.start("s", "k2", undefined, async () => reply(10), never);
    await seen.done; await unseen.done;
    ops.delivered(seen);
    now += CONNECTED_APP_REPEAT_WINDOW_MS + 1;
    expect(ops.blocking("s", "k1")).toBeUndefined();
    expect(ops.blocking("s", "k2")).toBe(unseen);
    expect(ops.byHandle("s", seen.handle)).toBeUndefined();
    now += CONNECTED_APP_RESULT_TTL_MS;
    // The bytes are gone; the record that blocks a repeat is not.
    expect(ops.blocking("s", "k2")).toBe(unseen);
    expect(unseen.outcome).toMatchObject({ kind: "unknown", cause: "result-gone" });
    expect(unseen.bytes).toBe(0);
    expect(ops.clear(unseen)).toBe(true);
    expect(ops.blocking("s", "k2")).toBeUndefined();
    expect(ops.size).toBe(0);
  });

  it("keeps at most its result and byte budget, never dropping a running action or its record", async () => {
    const ops = new ConnectedAppOperations();
    const running = ops.start("s", "running", undefined, () => new Promise<RelayReply>(() => {}), never);
    for (let i = 0; i < OPERATION_MAX_ENTRIES + 20; i++) await ops.start("s", `k${i}`, undefined, async () => reply(1), never).done;
    expect(ops.keptResults).toBeLessThanOrEqual(OPERATION_MAX_ENTRIES);
    expect(ops.byHandle("s", running.handle)).toBe(running);
    for (let i = 0; i < 5; i++) await ops.start("s", `big${i}`, undefined, async () => reply(20 * 1024 * 1024), never).done;
    expect(ops.keptBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(ops.byHandle("s", running.handle)).toBe(running);
  });
});

/** A journal held in memory, to see what was written and when. */
class MemoryJournal implements OperationJournal {
  rows = new Map<string, JournalRecord>();
  load() { return [...this.rows.values()].map((row) => ({ ...row })); }
  put(record: JournalRecord) { this.rows.set(record.handle, { ...record }); }
  remove(handle: string) { this.rows.delete(handle); }
  applies = 0;
  apply(changes: { put: JournalRecord[]; remove: string[] }) {
    this.applies += 1;
    for (const record of changes.put) this.put(record);
    for (const handle of changes.remove) this.remove(handle);
  }
  clear() { this.rows.clear(); }
}

describe("1.0.2 round 2: replay protection holds through restart, eviction and ambiguous failures", () => {
  const reply = (size: number): RelayReply => ({ status: 200, bytes: new Uint8Array(size), contentType: "application/json" });
  const sent = () => true;

  it("records the intent durably before anything is dispatched", async () => {
    const journal = new MemoryJournal();
    const ops = new ConnectedAppOperations(Date.now, journal);
    let seenAtDispatch: JournalRecord | undefined;
    const op = ops.start("s", "k", "Gmail: send email", async () => {
      seenAtDispatch = [...journal.rows.values()][0];
      return reply(1);
    }, sent, { requirements: [{ tool: "GMAIL_SEND_EMAIL", account: "ca_1" }] });
    await op.done;
    expect(seenAtDispatch).toMatchObject({ state: "pending", key: "k", requirements: [{ tool: "GMAIL_SEND_EMAIL", account: "ca_1" }] });
  });

  it("refuses to dispatch when the intent cannot be recorded", async () => {
    const journal = new MemoryJournal();
    journal.put = () => { throw new Error("disk full"); };
    const ops = new ConnectedAppOperations(Date.now, journal);
    const dispatch = vi.fn(async () => reply(1));
    expect(() => ops.start("s", "k", undefined, dispatch, sent)).toThrow(OperationRefused);
    await settle(10);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("restart mid-send: the interrupted action is unknown and blocks a repeat until it is cleared", async () => {
    const journal = new MemoryJournal();
    const before = new ConnectedAppOperations(Date.now, journal);
    const op = before.start("s", "k", "Gmail: send email", () => new Promise<RelayReply>(() => {}), sent);
    // The process stops here: memory is gone, the journal is not.
    const after = new ConnectedAppOperations(Date.now, journal);
    const held = after.blocking("s", "k");
    expect(held?.handle).toBe(op.handle);
    expect(held?.outcome).toMatchObject({ kind: "unknown", cause: "interrupted" });
    expect(after.pendingCount).toBe(0);
    // Stays held across a second restart.
    const third = new ConnectedAppOperations(Date.now, journal);
    expect(third.blocking("s", "k")?.handle).toBe(op.handle);
    expect(third.clear(third.byHandle("s", op.handle)!)).toBe(true);
    expect(third.blocking("s", "k")).toBeUndefined();
    expect(new ConnectedAppOperations(Date.now, journal).blocking("s", "k")).toBeUndefined();
  });

  it("restart after an answer nobody collected: the answer is gone, the hold is not", async () => {
    const journal = new MemoryJournal();
    const before = new ConnectedAppOperations(Date.now, journal);
    const op = before.start("s", "k", undefined, async () => reply(5), sent);
    await op.done;
    const after = new ConnectedAppOperations(Date.now, journal);
    expect(after.blocking("s", "k")?.outcome).toMatchObject({ kind: "unknown", cause: "result-gone" });
  });

  it("restart through the relay: the same email is not sent again", async () => {
    mode = "hang";
    const first = await relay(send(1, sendEmail), { waitMs: 20, lifetimeMs: 60_000 });
    const handle = handleOf(first);
    expect(dispatched).toHaveLength(1);
    restartConnectedAppOperations();
    mode = "answer";
    const retry = await relay(send(2, sendEmail), { waitMs: 20 });
    expect(read(retry).result.isError).toBe(true);
    expect(text(retry)).toMatch(/when Murage stopped, so it is not known whether it finished\. It was not run again/);
    expect(dispatched).toHaveLength(1);
    // The old handle still works for the bot that was given it.
    expect(text(await relay(status(3, { handle })))).toMatch(/when Murage stopped/);
    expect(text(await relay(status(4, { handle, run_again: true })))).toMatch(/was cleared/);
    expect(text(await relay(send(5, sendEmail)))).toBe("sent #2");
    expect(dispatched).toHaveLength(2);
  });

  it("200 other results never release an unresolved action, running or unknown", async () => {
    const ops = new ConnectedAppOperations();
    const unknown = ops.start("s", "lost", undefined, () => Promise.reject(new Error("socket closed")), sent);
    await unknown.done;
    const running = ops.start("s", "running", undefined, () => new Promise<RelayReply>(() => {}), sent);
    const uncollected = ops.start("s", "uncollected", undefined, async () => reply(3), sent);
    await uncollected.done;
    for (let i = 0; i < 250; i++) await ops.start("s", `other${i}`, undefined, async () => reply(1), sent).done;
    expect(ops.blocking("s", "lost")).toBe(unknown);
    expect(ops.blocking("s", "running")).toBe(running);
    // The uncollected answer lost its bytes, not its hold.
    expect(ops.blocking("s", "uncollected")).toBe(uncollected);
    expect(uncollected.outcome).toMatchObject({ kind: "unknown", cause: "result-gone" });
    expect(ops.keptResults).toBeLessThanOrEqual(OPERATION_MAX_ENTRIES);
  });

  it("200 other results through the relay: the unknown email is still not sent again", async () => {
    mode = "hang";
    await relay(send(1, sendEmail), { waitMs: 20, lifetimeMs: 100 });
    await settle(200);
    mode = "answer";
    for (let i = 0; i < OPERATION_MAX_ENTRIES + 10; i++) {
      await relay(send(100 + i, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: `p${i}@example.com`, subject: "Hi", body: "x" } }] }));
    }
    const before = dispatched.length;
    const retry = await relay(send(2, sendEmail));
    expect(text(retry)).toMatch(/not known whether it finished/);
    expect(dispatched).toHaveLength(before);
  });

  it("an HTTP 503 after dispatch is unknown, not not-sent: the same email is not resent", async () => {
    mode = "unavailable";
    const first = await relay(send(1, sendEmail));
    expect(dispatched).toHaveLength(1);
    expect(read(first).id).toBe(1);
    mode = "answer";
    const retry = await relay(send(2, sendEmail));
    expect(text(retry)).toMatch(/not known whether it finished\. It was not run again/);
    expect(dispatched).toHaveLength(1);
  });

  it("a 503 the broker marks as never dispatched may be repeated", async () => {
    mode = "unavailable-undispatched";
    await relay(send(1, sendEmail));
    mode = "answer";
    expect(text(await relay(send(2, sendEmail)))).toBe("sent #2");
    expect(dispatched).toHaveLength(2);
  });

  it("the model's commentary does not change an action's identity", async () => {
    const first = await relay(send(1, { ...sendEmail, thought: "Sending the note to Ana", current_step: "SENDING", current_step_metric: "0/1 sent", session_id: "s1" }));
    expect(text(first)).toBe("sent #1");
    const retry = await relay(send(2, { ...sendEmail, thought: "Trying again, reworded", current_step: "RETRY", session_id: "s2" }));
    expect(text(retry)).toContain("sent #1");
    expect(dispatched).toHaveLength(1);
    // A change to what the email says is a different email.
    await relay(send(3, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "ana@example.com", subject: "Hi", body: "Different" } }], thought: "x" }));
    expect(dispatched).toHaveLength(2);
  });

  it("a stored answer is read back only through the stored requirements: the owner's current grants decide", async () => {
    const first = await relay(send(1, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "ca_1", arguments: { to: "a@example.com" } }] }), { waitMs: 20 });
    expect(text(first)).toBe("sent #1");
    mode = "delay"; delayMs = 150;
    const slow = await relay(send(2, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "ca_2", arguments: { to: "b@example.com" } }] }), { waitMs: 20 });
    const handle = handleOf(slow);
    await settle(250);
    const asked: unknown[] = [];
    const revoked = relay(status(3, { handle }), {
      authorizeStored: (used) => { asked.push(used); throw Object.assign(new Error("This tool or connected account has not been approved for this bot."), { status: 403 }); },
    });
    await expect(revoked).rejects.toThrow(/not been approved/);
    expect(asked[0]).toEqual({ requirements: [{ tool: "GMAIL_SEND_EMAIL", account: "ca_2" }], complete: true });
    // Still granted: the same handle returns its result.
    const allowed = await relay(status(4, { handle }), { authorizeStored: () => {} });
    expect(text(allowed)).toContain("sent #2");
  });

  it("admits at most OPERATION_MAX_PENDING running actions and refuses the next without dispatching", () => {
    const ops = new ConnectedAppOperations();
    const dispatch = vi.fn(() => new Promise<RelayReply>(() => {}));
    for (let i = 0; i < OPERATION_MAX_PENDING; i++) ops.start("s", `p${i}`, undefined, dispatch, sent);
    expect(() => ops.start("s", "one-more", undefined, dispatch, sent)).toThrowError(OperationRefused);
    expect(ops.pendingCount).toBe(OPERATION_MAX_PENDING);
  });

  it("a refused request through the relay says nothing was sent", async () => {
    mode = "hang";
    for (let i = 0; i < OPERATION_MAX_PENDING; i++) {
      await relay(send(i, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: `p${i}@example.com` } }] }), { waitMs: 0, lifetimeMs: 60_000 });
    }
    for (let waited = 0; dispatched.length < OPERATION_MAX_PENDING && waited < 20_000; waited += 25) await settle(25);
    expect(dispatched).toHaveLength(OPERATION_MAX_PENDING);
    const refused = await relay(send(9_999, sendEmail), { waitMs: 0 });
    expect(read(refused).result.isError).toBe(true);
    expect(text(refused)).toMatch(/Nothing was sent to the app/);
    await settle(100);
    expect(dispatched).toHaveLength(OPERATION_MAX_PENDING);
    for (const end of hung.splice(0)) end();
  });

  it("a request that reached nothing leaves no retained buffer", async () => {
    const ops = new ConnectedAppOperations();
    const op = ops.start("s", "k", undefined, async () => ({ ...reply(4096), delivery: "not-sent" as const }), sent);
    await op.done;
    expect(ops.size).toBe(0);
    expect(ops.keptBytes).toBe(0);
  });

  it("a stored event stream answers with the frame for its own request, not the last one", async () => {
    mode = "stream";
    const first = await relay(send(1, sendEmail));
    expect(first.contentType).toContain("event-stream");
    const retry = await relay(send(2, sendEmail));
    expect(read(retry).id).toBe(2);
    expect(text(retry)).toContain("own answer #1");
    expect(text(retry)).not.toContain("someone else's answer");
    const frames = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 5, result: { a: 1 } })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 6, result: { a: 2 } })}\n\n`;
    const stream: RelayReply = { status: 200, bytes: new TextEncoder().encode(frames), contentType: "text/event-stream" };
    expect(replyMessage(stream, 5)?.result).toEqual({ a: 1 });
    expect(replyMessage(stream, 7)).toBeNull();
  });
});

// ── Round 4: verified reads run fresh; writes and unknowns stay protected ─────
const fetchEmails = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "is:unread", max_results: 5 } }] };

describe("1.0.2 round 4: a verified read runs every time", () => {
  it("the inbox read twice, 30 seconds apart, runs twice", async () => {
    const real = Date.now;
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    try {
      expect(text(await relay(send(1, fetchEmails)))).toBe("sent #1");
      offset = 30_000;
      expect(text(await relay(send(2, fetchEmails)))).toBe("sent #2");
      expect(dispatched).toHaveLength(2);
    } finally { vi.restoreAllMocks(); }
  });

  it("a read made again while the first is still running runs again and is not blocked", async () => {
    mode = "delay"; delayMs = 100;
    const first = relay(send(1, fetchEmails), { waitMs: 1_000 });
    await settle(20);
    const second = relay(send(2, fetchEmails), { waitMs: 1_000 });
    expect(text(await first)).toBe("sent #1");
    expect(text(await second)).toBe("sent #2");
    expect(dispatched).toHaveLength(2);
  });

  it("a slow read still gets a handle, and CHECK returns it as a historical record", async () => {
    mode = "delay"; delayMs = 80;
    const first = await relay(send(1, fetchEmails), { waitMs: 10 });
    const handle = handleOf(first);
    await settle(150);
    const checked = await relay(status(2, { handle }));
    expect(text(checked)).toMatch(/was read \d+ seconds ago/);
    expect(text(checked)).toMatch(/not the current state/);
    expect(text(checked)).toContain("sent #1");
    // And asking again reads again.
    expect(text(await relay(send(3, fetchEmails)))).toBe("sent #2");
  });

  it("GMAIL_SEND_EMAIL repeated is blocked", async () => {
    await relay(send(1, sendEmail));
    expect(text(await relay(send(2, sendEmail)))).toContain("sent #1");
    expect(dispatched).toHaveLength(1);
  });

  it("GMAIL_PATCH_SEND_AS (a write the owner's sessions use) is protected", async () => {
    const patch = { tools: [{ tool_slug: "GMAIL_PATCH_SEND_AS", arguments: { send_as_email: "a@example.com", signature: "x" } }] };
    await relay(send(1, patch)); await relay(send(2, patch));
    expect(dispatched).toHaveLength(1);
  });

  it("every slug the owner's sessions read runs fresh", async () => {
    for (const slug of ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_GET_PROFILE", "GMAIL_LIST_HISTORY", "GMAIL_LIST_LABELS", "GMAIL_LIST_SEND_AS", "GMAIL_LIST_THREADS"]) {
      const call = { tools: [{ tool_slug: slug, arguments: { id: "1" } }] };
      const before = dispatched.length;
      await relay(send(1, call)); await relay(send(2, call));
      expect(dispatched.length - before, slug).toBe(2);
    }
  });

  it("a batch holding any write or unknown tool is protected", async () => {
    const mixed = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } }] };
    await relay(send(1, mixed)); await relay(send(2, mixed));
    expect(dispatched).toHaveLength(1);
    const unknown = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "ACME_DO_THING", arguments: {} }] };
    await relay(send(3, unknown)); await relay(send(4, unknown));
    expect(dispatched).toHaveLength(2);
  });

  it("an unknown tool is protected even when its name reads like a lookup", async () => {
    const lookalike = { tools: [{ tool_slug: "ACME_GET_THING", arguments: {} }] };
    await relay(send(1, lookalike)); await relay(send(2, lookalike));
    expect(dispatched).toHaveLength(1);
  });

  it("workbench, remote bash and code tools are always protected", async () => {
    const workbench = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }], sync_response_to_workbench: true };
    await relay(send(1, workbench)); await relay(send(2, workbench));
    expect(dispatched).toHaveLength(1);
    for (const name of ["COMPOSIO_REMOTE_BASH_TOOL", "COMPOSIO_REMOTE_WORKBENCH"]) {
      const before = dispatched.length;
      const payload = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { command: "ls", tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] } } });
      await relay(payload(10)); await relay(payload(11));
      expect(dispatched.length - before, name).toBe(1);
    }
  });
});

describe("1.0.2 round 4: reads run fresh in the ledger itself", () => {
  const reply = (): RelayReply => ({ status: 200, bytes: new Uint8Array(3), contentType: "application/json" });
  it("leaves no journal row and blocks nothing; protected calls still do", async () => {
    const journal = new MemoryJournal();
    const ops = new ConnectedAppOperations(Date.now, journal);
    const read1 = ops.start("s", "k", undefined, async () => reply(), () => true, { fresh: true });
    await read1.done;
    expect(journal.rows.size).toBe(0);
    expect(ops.blocking("s", "k")).toBeUndefined();
    const write = ops.start("s", "w", undefined, async () => reply(), () => true);
    await write.done;
    expect(journal.rows.size).toBe(1);
    expect(ops.blocking("s", "w")).toBe(write);
  });
});

describe("1.0.2 round 4: provenance", () => {
  it("an unrecognised shape is not complete; a named batch is", () => {
    expect(connectedAppProvenance("COMPOSIO_MULTI_EXECUTE_TOOL", sendEmail)).toMatchObject({ complete: true, requirements: [{ tool: "GMAIL_SEND_EMAIL" }] });
    expect(connectedAppProvenance("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ arguments: {} }] }).complete).toBe(false);
    expect(connectedAppProvenance("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }).complete).toBe(false);
    expect(connectedAppProvenance("COMPOSIO_REMOTE_WORKBENCH", { code: "x" })).toMatchObject({ complete: false, requirements: [] });
    expect(connectedAppProvenance("COMPOSIO_REMOTE_BASH_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] }).complete).toBe(false);
  });

  it("is kept with the operation, through a restart", async () => {
    const journal = new MemoryJournal();
    const before = new ConnectedAppOperations(Date.now, journal);
    const op = before.start("s", "k", undefined, () => new Promise<RelayReply>(() => {}), () => true, { requirements: [], requirementsComplete: false });
    const after = new ConnectedAppOperations(Date.now, journal);
    expect(after.byHandle("s", op.handle)).toMatchObject({ requirements: [], requirementsComplete: false });
  });
});

describe("1.0.2 round 4: grants are rechecked after any wait, right before delivery", () => {
  it("revocation during CHECK's wait gets no result", async () => {
    mode = "delay"; delayMs = 150;
    const first = await relay(send(1, { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "ca_1", arguments: { to: "a@example.com" } }] }), { waitMs: 10 });
    const handle = handleOf(first);
    let granted = true;
    const check = relay(status(2, { handle }), {
      statusWaitMs: 2_000,
      authorizeStored: () => { if (!granted) throw Object.assign(new Error("not approved"), { status: 403 }); },
    });
    await settle(30);
    granted = false; // the owner revokes while CHECK waits
    await expect(check).rejects.toThrow(/not approved/);
  });

  it("a joined repeat that outlasted the grant also gets nothing", async () => {
    mode = "delay"; delayMs = 120;
    const call = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "ca_1", arguments: { to: "a@example.com" } }] };
    void relay(send(1, call), { waitMs: 1_000 });
    await settle(20);
    let granted = true;
    const joined = relay(send(2, call), { waitMs: 1_000, authorizeStored: () => { if (!granted) throw new Error("not approved"); } });
    await settle(20);
    granted = false;
    await expect(joined).rejects.toThrow(/not approved/);
  });
});

describe("1.0.2 round 4: restart keeps a delivered write's tombstone to its original deadline", () => {
  const reply = (): RelayReply => ({ status: 200, bytes: new Uint8Array(3), contentType: "application/json" });
  it("restart +30 s still blocks; +61 s releases and deletes in one batch", async () => {
    let now = 1_000_000;
    const journal = new MemoryJournal();
    const before = new ConnectedAppOperations(() => now, journal);
    const op = before.start("s", "k", undefined, async () => reply(), () => true);
    await op.done;
    before.delivered(op);
    now += 30_000;
    const after = new ConnectedAppOperations(() => now, journal);
    expect(after.blocking("s", "k")).toBeDefined();
    expect(journal.rows.size).toBe(1);
    now += 31_000;
    const later = new ConnectedAppOperations(() => now, journal);
    expect(later.blocking("s", "k")).toBeUndefined();
    expect(journal.rows.size).toBe(0);
  });

  it("recovery is one transaction and does not rewrite unchanged rows", async () => {
    const journal = new MemoryJournal();
    const base = { scope: "s", label: undefined, startedAt: 1, requirements: [] as JournalRecord["requirements"], requirementsComplete: false };
    for (let i = 0; i < 50; i++) journal.put({ ...base, handle: `u${i}`, key: `u${i}`, state: "unknown", cause: "no-answer" });
    journal.put({ ...base, handle: "p", key: "p", state: "pending" });
    const puts: string[] = [];
    const realPut = journal.put.bind(journal);
    journal.put = (record) => { puts.push(record.handle); realPut(record); };
    const ops = new ConnectedAppOperations(Date.now, journal);
    ops.blocking("s", "p");
    expect(journal.applies).toBe(1);
    expect(puts).toEqual(["p"]);
  });
});

describe("1.0.2 round 4: journal faults retry and are never swallowed", () => {
  const reply = (): RelayReply => ({ status: 200, bytes: new Uint8Array(3), contentType: "application/json" });
  it("a failed load refuses protected dispatch, retries with backoff, then recovers", async () => {
    let now = 5_000;
    const journal = new MemoryJournal();
    journal.put({ handle: "old", scope: "s", key: "kold", label: undefined, startedAt: 1, state: "unknown", cause: "no-answer", requirements: [], requirementsComplete: false });
    let failing = true;
    const realLoad = journal.load.bind(journal);
    let loads = 0;
    journal.load = () => { loads += 1; if (failing) throw new Error("locked"); return realLoad(); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ops = new ConnectedAppOperations(() => now, journal);
      const dispatch = vi.fn(async () => reply());
      expect(() => ops.start("s", "k", undefined, dispatch, () => true)).toThrow(OperationRefused);
      expect(ops.health.loaded).toBe(false);
      expect(ops.health.loadError).toBe("locked");
      // Inside the backoff: not retried.
      expect(() => ops.start("s", "k", undefined, dispatch, () => true)).toThrow(OperationRefused);
      expect(loads).toBe(1);
      // Storage comes back; after the backoff the next call recovers.
      failing = false; now += 1_500;
      expect(ops.blocking("s", "kold")).toBeDefined();
      const op = ops.start("s", "k", undefined, dispatch, () => true);
      await op.done;
      expect(ops.health.loaded).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      // A verified read was never held up by the ledger.
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("a verified read still runs while the journal cannot be read", async () => {
    const journal = new MemoryJournal();
    journal.load = () => { throw new Error("locked"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ops = new ConnectedAppOperations(Date.now, journal);
      const op = ops.start("s", "k", undefined, async () => reply(), () => true, { fresh: true });
      expect((await op.done).kind).toBe("answered");
    } finally { warn.mockRestore(); }
  });

  it("failed updates and deletes are counted, reported and retried until the journal takes them", async () => {
    let now = 1_000;
    const journal = new MemoryJournal();
    const ops = new ConnectedAppOperations(() => now, journal);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const op = ops.start("s", "k", undefined, async () => reply(), () => true);
      const realPut = journal.put.bind(journal);
      const realRemove = journal.remove.bind(journal);
      journal.put = () => { throw new Error("disk full"); };
      journal.remove = () => { throw new Error("disk full"); };
      await op.done;
      expect(ops.health).toMatchObject({ unsaved: 1 });
      expect(ops.health.lastFault).toMatch(/disk full/);
      ops.delivered(op);
      now += CONNECTED_APP_REPEAT_WINDOW_MS + 1;
      ops.blocking("s", "k"); // sweep drops it; the row delete is refused
      expect(ops.health.unremoved).toBe(1);
      expect(journal.rows.size).toBe(1);
      // Storage is back; after the backoff the deletion goes through.
      journal.put = realPut; journal.remove = realRemove;
      now += 2_000;
      ops.blocking("s", "k");
      expect(ops.health).toMatchObject({ unsaved: 0, unremoved: 0 });
      expect(journal.rows.size).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it("clear() fails loudly and keeps the record when the journal refuses the delete", async () => {
    const journal = new MemoryJournal();
    const ops = new ConnectedAppOperations(Date.now, journal);
    const op = ops.start("s", "k", undefined, async () => reply(), () => true);
    await op.done;
    journal.remove = () => { throw new Error("disk full"); };
    expect(() => ops.clear(op)).toThrow(/disk full/);
    expect(ops.blocking("s", "k")).toBe(op);
  });
});

describe("1.0.2 round 4: what Flux says about whether anything was sent", () => {
  const resend = async (id: number) => relay(send(id, sendEmail));
  const blockedAfter = async () => { const before = dispatched.length; await relay(send(99, sendEmail)); return dispatched.length === before; };

  for (const code of ["apps_unavailable", "composio_unavailable", "capability_unavailable"]) {
    it(`503 with code ${code} was never sent: the same email may go again`, async () => {
      override = { status: 503, body: { code, error: "unavailable" } };
      await resend(1);
      expect(await blockedAfter()).toBe(false);
    });
  }
  it("a code-less 503 \"service unavailable\" may have been sent: held", async () => {
    override = { status: 503, body: { error: "service unavailable" } };
    await resend(1);
    expect(await blockedAfter()).toBe(true);
  });
  it("503 with another code may have been sent: held", async () => {
    override = { status: 503, body: { code: "upstream_timeout" } };
    await resend(1);
    expect(await blockedAfter()).toBe(true);
  });
  it("a pre-send code on another status is not trusted: held", async () => {
    override = { status: 502, body: { code: "apps_unavailable" } };
    await resend(1);
    expect(await blockedAfter()).toBe(true);
  });
  it("top-level dispatched:false on a 5xx was never sent", async () => {
    override = { status: 500, body: { error: "x", dispatched: false } };
    await resend(1);
    expect(await blockedAfter()).toBe(false);
  });
  it("an in-band -32000 SSE frame with error.data.dispatched:false was never sent", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "apps unavailable", data: { dispatched: false } } } };
    await resend(1);
    expect(await blockedAfter()).toBe(false);
  });
  it("an in-band -32000 error without dispatched:false may have been sent: held", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } } };
    await resend(1);
    expect(await blockedAfter()).toBe(true);
  });
  it("an in-band error that says dispatched:false but with another code is not trusted: held", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom", data: { dispatched: false } } } };
    await resend(1);
    expect(await blockedAfter()).toBe(true);
  });
});

describe("1.0.2 round 5: pre-send evidence is explicit and belongs to this request", () => {
  const blockedAfter = async () => { const before = dispatched.length; await relay(send(99, sendEmail)); return dispatched.length === before; };

  for (const status of [400, 402, 403, 404, 409, 413, 422, 429]) {
    it(`HTTP ${status} without a dispatched flag may have been sent: held`, async () => {
      override = { status, body: { error: "refused" } };
      await relay(send(1, sendEmail));
      expect(await blockedAfter()).toBe(true);
    });
  }
  it("HTTP 400 that says dispatched:false was never sent", async () => {
    override = { status: 400, body: { error: "refused", dispatched: false } };
    await relay(send(1, sendEmail));
    expect(await blockedAfter()).toBe(false);
  });
  it("a dispatched:false frame for another request id is ignored: held", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", id: 4242, error: { code: -32000, message: "x", data: { dispatched: false } } } };
    await relay(send(1, sendEmail));
    expect(await blockedAfter()).toBe(true);
  });
  it("an id-less dispatched:false frame is ignored: held", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", error: { code: -32000, message: "x", data: { dispatched: false } } } };
    await relay(send(1, sendEmail));
    expect(await blockedAfter()).toBe(true);
  });
  it("the same frame for this request id was never sent", async () => {
    override = { status: 200, sse: true, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x", data: { dispatched: false } } } };
    await relay(send(1, sendEmail));
    expect(await blockedAfter()).toBe(false);
  });
  it("a session-gone 404 with no evidence is held too", async () => {
    override = { status: 404, body: { error: "session_gone" } };
    await relay(send(1, sendEmail), {});
    expect(await blockedAfter()).toBe(true);
  });
});

describe("1.0.2 round 5: classification follows the dispatched structure", () => {
  const readWrapper = { tool_name: "COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] } };
  it("a dummy read wrapper on an outer write batch is protected and journaled: the write is sent once", async () => {
    const hybrid = { ...sendEmail, ...readWrapper };
    expect(classifyConnectedAppCall("COMPOSIO_MULTI_EXECUTE_TOOL", hybrid)).toBe("protected");
    await relay(send(1, hybrid));
    const retry = await relay(send(2, hybrid));
    expect(dispatched).toHaveLength(1);
    expect(text(retry)).toContain("sent #1");
    const provenance = connectedAppProvenance("COMPOSIO_MULTI_EXECUTE_TOOL", hybrid);
    expect(provenance.complete).toBe(false);
    expect(provenance.requirements.map((item) => item.tool).sort()).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"]);
  });
  it("a read wrapper on the workbench is protected", async () => {
    await relay({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code: "x", ...readWrapper } } });
    await relay({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code: "x", ...readWrapper } } });
    expect(dispatched).toHaveLength(1);
  });
  it("a validated wrapper still classifies by what it wraps; extra or doubled fields do not", () => {
    expect(classifyConnectedAppCall("use_tool", readWrapper)).toBe("read");
    expect(classifyConnectedAppCall("use_tool", { ...readWrapper, tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] })).toBe("protected");
    expect(classifyConnectedAppCall("use_tool", { ...readWrapper, toolInput: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } })).toBe("protected");
    expect(classifyConnectedAppCall("use_tool", { tool_name: "COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { ...readWrapper.tool_input, tool_name: "x", tool_input: {} } })).toBe("protected");
    expect(classifyConnectedAppCall("GMAIL_SEND_EMAIL", readWrapper)).toBe("protected");
    expect(classifyConnectedAppCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }], surprise: 1 })).toBe("protected");
    expect(classifyConnectedAppCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", slug: "GMAIL_SEND_EMAIL" }] })).toBe("protected");
  });
});

describe("1.0.2 round 5: a failure before any request bytes could be written is the only network error that is not sent", () => {
  it("a refused connection never carried the request: the same email may go again", async () => {
    const { createServer: net } = await import("node:net");
    const probe = net(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    setManagedBrokerAccess({ url: `http://127.0.0.1:${port}`, token: "9".repeat(64) });
    await relay(send(1, sendEmail));
    setManagedBrokerAccess({ url: base, token: "9".repeat(64) });
    expect(text(await relay(send(2, sendEmail)))).toBe("sent #1");
    expect(dispatched).toHaveLength(1);
  });
  it("a connection dropped after the request was received may have been sent: held", async () => {
    mode = "hang";
    const pending = relay(send(1, sendEmail), { waitMs: 1000 });
    for (let waited = 0; dispatched.length < 1 && waited < 5000; waited += 25) await settle(25);
    expect(dispatched).toHaveLength(1);
    for (const end of hung.splice(0)) end();
    await pending;
    mode = "answer";
    expect(text(await relay(send(2, sendEmail)))).toMatch(/not known whether it finished/);
    expect(dispatched).toHaveLength(1);
  });
});

describe("1.0.2 round 4: the SQLite journal", () => {
  it("round-trips provenance, applies a batch atomically, and upgrades a ledger written without the column", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { SqliteOperationJournal } = await import("./connected-app-journal.ts");
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    let opened: { close(): void } | undefined;
    try {
      const file = join(dir, "ledger.db");
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE connected_app_ops (handle TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, label TEXT, started_at INTEGER NOT NULL,
        state TEXT NOT NULL, cause TEXT, delivered_at INTEGER, requirements TEXT NOT NULL)`);
      old.prepare("INSERT INTO connected_app_ops VALUES ('h-old','s','k',NULL,1,'unknown','no-answer',NULL,?)").run(JSON.stringify([{ tool: "GMAIL_SEND_EMAIL", account: "ca_1" }]));
      old.prepare("INSERT INTO connected_app_ops VALUES ('h-empty','s','k2',NULL,2,'unknown','no-answer',NULL,'[]')").run();
      old.close();
      const journal = new SqliteOperationJournal(file);
      opened = journal;
      const loaded = journal.load();
      // A migrated row never certifies its provenance: the old extractor silently dropped unnamed rows.
      expect(loaded.find((row) => row.handle === "h-old")?.requirementsComplete).toBe(false);
      expect(loaded.find((row) => row.handle === "h-empty")?.requirementsComplete).toBe(false);
      const base = { scope: "s", label: undefined, startedAt: 3, state: "unknown" as const, requirements: [], requirementsComplete: false };
      journal.apply({ put: [{ ...base, handle: "a", key: "a" }, { ...base, handle: "b", key: "b", requirementsComplete: true }], remove: ["h-old"] });
      expect(journal.load().map((row) => row.handle).sort()).toEqual(["a", "b", "h-empty"]);
      expect(journal.load().find((row) => row.handle === "b")?.requirementsComplete).toBe(true);
      // A batch with a bad row changes nothing.
      expect(() => journal.apply({ put: [{ ...base, handle: "c", key: "c" }, { ...base, handle: "d", key: null as unknown as string }], remove: ["a"] })).toThrow();
      expect(journal.load().map((row) => row.handle).sort()).toEqual(["a", "b", "h-empty"]);
    } finally {
      // the journal lets go of ledger.db first: Windows will not remove a file another handle holds open
      opened?.close();
      removeTempDirSync(dir);
    }
  });
});

// ── Round 5: only a frame with THIS request's id answers it ──────────────────
describe("1.0.2 round 5: foreign, empty or malformed bodies are an unknown outcome", () => {
  const frame = (id: unknown, rest: Record<string, unknown>) => ({ jsonrpc: "2.0", id, ...rest });
  const heldAfter = async (afterMs: number) => {
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real() + afterMs);
    // The ledger holds the clock it was built with: rebuild it from the journal
    // under the shifted clock, as if that much time passed before a restart.
    restartConnectedAppOperations();
    try {
      const before = dispatched.length;
      await relay(send(99, sendEmail));
      return dispatched.length === before;
    } finally { vi.restoreAllMocks(); restartConnectedAppOperations(); }
  };
  const cases: Array<[string, { status: number; body: unknown; sse?: boolean; raw?: string }]> = [
    ["an event stream with only another request's refusal", { status: 200, sse: true, body: frame(4242, { error: { code: -32000, message: "no", data: { dispatched: false } } }) }],
    ["an event stream with only another request's result", { status: 200, sse: true, body: frame(4242, { result: { content: [] } }) }],
    ["plain JSON for another id", { status: 200, body: frame(4242, { result: { content: [] } }) }],
    ["a frame with no id", { status: 200, body: { jsonrpc: "2.0", result: { content: [] } } }],
    ["an empty body", { status: 200, body: null, raw: "" }],
    ["a malformed body", { status: 200, body: null, raw: "{not json" }],
  ];
  for (const [name, answer] of cases) {
    it(`${name}: still held 61 seconds later`, async () => {
      override = answer;
      await relay(send(1, sendEmail));
      expect(await heldAfter(CONNECTED_APP_REPEAT_WINDOW_MS + 1_000)).toBe(true);
    });
  }
  it("a matching result answers: the repeat window ends it", async () => {
    await relay(send(1, sendEmail));
    expect(await heldAfter(CONNECTED_APP_REPEAT_WINDOW_MS + 1_000)).toBe(false);
  });
  it("a matching error frame answers too", async () => {
    override = { status: 200, body: frame(1, { error: { code: -32602, message: "bad arguments" } }) };
    await relay(send(1, sendEmail));
    expect(await heldAfter(CONNECTED_APP_REPEAT_WINDOW_MS + 1_000)).toBe(false);
  });
});
