// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as atomic from "../../atomic.ts";
import { diagnosticsFor, SERVER_DIR, virtualProgram } from "../../testing/virtual-program.ts";
import { ChannelSendError, DurableDelivery } from "../durable-delivery.ts";
import { wrapUntrusted } from "../core/wrap.ts";
import { parseRequest, parseResponse } from "./rpc.ts";
import { SignalProcessHost, type HostRequestOptions } from "./process-host.ts";
import type { DeliveryAttempt, RpcRequest, RpcResponse } from "./types.ts";
import { SignalTransport, formatSignalResult, formatSignalRuns, prepareSignalPrompt, SIGNAL_MAX_RESPONSE,
  type SignalTransportOptions } from "./transport.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
const epoch = 1_800_000_000_000;
const proof = { signalCliVersion: "test-pin", citation: "fixture:1", reviewedBy: "fixture-review" };
const attempt: DeliveryAttempt = { deliveryId: "delivery", purpose: "reply", attempt: 1 };
const roots: string[] = [];
const hosts: SignalProcessHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
function limited(delay: unknown = 17): RpcResponse<"send"> {
  return { jsonrpc: "2.0", id: "test", error: { code: -5, message: "private provider text", data: { response: {
    timestamp: epoch, results: [{ recipientAddress: { uuid: owner, number: null }, type: "RATE_LIMIT_FAILURE",
      ...(delay === undefined ? {} : { retryAfterSeconds: delay }) }],
  } } } };
}
function successful(request: RpcRequest<"send">): RpcResponse<"send"> {
  return { jsonrpc: "2.0", id: request.id, result: { timestamp: request.params.timestamp ?? epoch,
    results: [{ recipientAddress: { uuid: owner, number: null }, type: "SUCCESS" }] } };
}
function fixture(overrides: Partial<SignalTransportOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "signal-transport-")); roots.push(root);
  let now = epoch, redacted = false;
  const writes: RpcRequest<"send">[] = [];
  const log = vi.fn(), count = vi.fn();
  const host = { generation: 7, spawnToken: Symbol("child"), request: vi.fn(async (request: RpcRequest<"send">, options: HostRequestOptions) => {
    parseRequest(request, { timestampSupported: true, isReservedTimestamp: timestamp => transport.isReservedTimestamp(timestamp) });
    if (before) await before();
    if (options.spawnToken !== host.spawnToken) throw Object.assign(new Error("host"), { code: "offline" });
    if (preError) throw Object.assign(new Error("host"), { code: preError });
    if (options.beforeWrite && !options.beforeWrite()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    writes.push(request);
    onWrite?.(request);
    return reply(request);
  }) };
  let before: (() => Promise<void>) | undefined, preError: string | undefined;
  let onWrite: ((request: RpcRequest<"send">) => void) | undefined;
  let reply = async (request: RpcRequest<"send">): Promise<RpcResponse<"send">> => successful(request);
  const options: SignalTransportOptions = { file: join(root, "outbox.json"), connectionId: "connection", ownAci: owner,
    generation: 7, host: host as unknown as SignalTransportOptions["host"], isCurrent: () => true, timestampSupported: true,
    pin: { signalCliVersion: "test-pin", rateLimitNotSentProof: null }, liveVersion: () => "test-pin",
    now: () => now, log, count, ...overrides };
  let transport = new SignalTransport(options);
  const send = (text = "hello", input: Partial<DeliveryAttempt> & { reserved?: string[] } = {}) =>
    transport.sendNoteToSelf({ ...attempt, ...input, text, isRedacted: () => redacted } as Parameters<SignalTransport["sendNoteToSelf"]>[0]);
  const ledger = (output = "hello") => {
    const file = join(root, "ledger.json");
    let current: DurableDelivery;
    current = new DurableDelivery({ file, bindingKey: "connection", recipient: transport.recipient, isCurrent: () => true,
      now: () => now, maxResponse: SIGNAL_MAX_RESPONSE, noticeAtMostOnce: true,
      runs: formatSignalRuns({ enqueue: () => ({ id: "run" }), result: () => ({ status: "completed", output }) }),
      ...transport.ledgerHooks(id => current.isRedacted(id)),
    });
    return { ledger: current, rows: () => JSON.parse(readFileSync(file, "utf8")).records };
  };
  return { root, options, host, writes, log, count, send, ledger,
    get transport() { return transport; }, read: () => JSON.parse(readFileSync(options.file, "utf8")),
    restart: () => { transport = new SignalTransport(options); },
    clock: (value: number) => { now = value; }, redact: () => { redacted = true; },
    before: (fn: () => Promise<void>) => { before = fn; }, preError: (code?: string) => { preError = code; },
    onWrite: (fn: typeof onWrite) => { onWrite = fn; }, reply: (fn: typeof reply) => { reply = fn; },
  };
}

async function realHostFixture() {
  const f = fixture();
  const number = "+12025550123";
  for (const dir of ["auth/data", "tmp", "log"]) mkdirSync(join(f.root, "signal", dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, "signal/auth/data/accounts.json"), JSON.stringify({ accounts: [{ path: "account", uuid: owner, number }] }), { mode: 0o600 });
  writeFileSync(join(f.root, "signal/auth/data/account"), JSON.stringify({ storage: { deviceId: 2 } }), { mode: 0o600 });
  class FakeChild extends EventEmitter {
    pid = 123;
    stdout = new PassThrough();
    stderr = new PassThrough();
    sends: RpcRequest<"send">[] = [];
    stdin = new Writable({ write: (chunk, _encoding, done) => {
      const request = JSON.parse(chunk.toString()) as RpcRequest;
      if (request.method === "send") this.sends.push(request as RpcRequest<"send">);
      const response = request.method === "send" ? successful(request as RpcRequest<"send">)
        : { jsonrpc: "2.0", id: request.id, result: request.method === "version" ? { version: "test-pin" }
          : request.method === "listAccounts" ? [{ number, aci: owner }] : {} };
      queueMicrotask(() => this.stdout.write(JSON.stringify(response) + "\n"));
      done();
    } });
    kill(signal = "SIGTERM") { queueMicrotask(() => this.emit("exit", 0, signal)); return true; }
  }
  const children: FakeChild[] = [];
  const check = async () => ({ state: "ok" as const });
  const host = new SignalProcessHost({ dataDir: f.root, storage: { check, repair: check },
    verifyRuntime: async () => ({ java: join(f.root, "bin/java"), jar: join(f.root, "signal-cli.jar"), version: "test-pin" }),
    spawnChild: () => { const child = new FakeChild(); children.push(child); return child; },
    rpc: { timestampSupported: true, isReservedTimestamp: value => f.transport.isReservedTimestamp(value),
      contracts: { subscribeReceive: { params: z.strictObject({}), result: z.strictObject({}) } } },
  });
  hosts.push(host);
  const start = () => host.spawn({ generation: 7, account: number });
  await start();
  f.options.host = host;
  return { ...f, host, children, start };
}

describe("Signal transport isolated fixtures", () => {
  it("T-SPAWN-TOKEN: real host confirms every chunk with the originating token (mutant: drop spawnToken)", async () => {
    const f = await realHostFixture();
    await expect(f.send("x".repeat(2001))).resolves.toEqual({ timestamps: [epoch, epoch + 1] });
    expect(f.children[0].sends.map(request => request.params.message.length)).toEqual([2000, 1]);
    expect(f.read().entries[0].chunks.map((chunk: { state: string }) => chunk.state)).toEqual(["confirmed", "confirmed"]);
  });

  it("T-SPAWN-TOKEN: delayed send cannot adopt a replacement child's token (mutant: refresh token after await)", async () => {
    const f = await realHostFixture();
    await f.send("paired", { deliveryId: "paired" });
    const originalToken = f.host.spawnToken;
    const reserve = f.transport.reserve.bind(f.transport);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(f.transport, "reserve").mockImplementationOnce(async input => {
      const reserved = await reserve(input);
      await gate;
      return reserved;
    });
    const pending = f.send();
    const rejected = expect(pending).rejects.toMatchObject({ code: "offline", uncertain: false });
    await f.start();
    expect(f.host.spawnToken).not.toBe(originalToken);
    resume();
    await rejected;
    expect(f.children[0].sends).toHaveLength(1);
    expect(f.children[1].sends).toHaveLength(0);
    expect(f.read().entries[1].chunks[0].state).toBe("reserved");
    await expect(f.send()).resolves.toEqual({ timestamps: [epoch + 1] });
    expect(f.children[1].sends).toHaveLength(1);
  });

  it("T-SPAWN-TOKEN: remaining chunks retain the first child's token (mutant: refresh token per chunk)", async () => {
    const f = fixture();
    await f.send("x".repeat(2001), { deliveryId: "paired" });
    const originalToken = f.host.spawnToken;
    f.onWrite(() => { f.host.spawnToken = Symbol("replacement child"); });
    await expect(f.send("x".repeat(2001))).rejects.toMatchObject({ code: "offline", uncertain: true, partial: true });
    expect(f.writes).toHaveLength(3);
    expect(f.host.request.mock.calls.at(-1)![1].spawnToken).toBe(originalToken);
    expect(f.read().entries[1].chunks.map((chunk: { state: string }) => chunk.state)).toEqual(["confirmed", "reserved"]);
  });

  it("T-HOOK-ID: reservations distinguish delivery, purpose and attempt, stable across restart (mutant: key by text)", async () => {
    const f = fixture();
    const ids = await f.transport.reserve({ ...attempt, text: "same" });
    f.restart();
    expect(await f.transport.reserve({ ...attempt, text: "same" })).toEqual(ids);
    for (const identity of [{ ...attempt, deliveryId: "other" }, { ...attempt, purpose: "notice" as const, attempt: 1 as const }, { ...attempt, attempt: 2 }]) {
      expect(await f.transport.reserve({ ...identity, text: "same" })).not.toEqual(ids);
    }
    expect(f.read().entries).toHaveLength(4);
    await expect(f.send("changed", { reserved: ids })).rejects.toMatchObject({ code: "invalid-request", uncertain: false });
    expect(f.writes).toHaveLength(0);
    await f.send("same", { reserved: ids });
    expect(f.writes[0].params.timestamp).toBe(Number(ids[0]));
  });

  it("T-A8: every reservation and written marker is durable before write; restart never repeats (mutant: persist after send)", async () => {
    const f = fixture();
    f.onWrite(request => {
      const disk = f.read();
      expect(disk.entries[0].chunks[f.writes.length - 1].state).toBe("written");
      expect(disk.sent).toHaveLength(2);
      const restarted = new SignalTransport(f.options);
      expect(restarted.hasSentTimestamp(request.params.timestamp!)).toBe(true);
    });
    expect((await f.send("x".repeat(2001))).timestamps).toEqual([epoch, epoch + 1]);
    expect(f.read().entries[0].chunks.map((chunk: { state: string }) => chunk.state)).toEqual(["confirmed", "confirmed"]);
    if (process.platform !== "win32") expect(statSync(f.options.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.options.file, "utf8")).not.toContain("x".repeat(30));
    f.restart();
    await expect(f.send("x".repeat(2001))).rejects.toMatchObject({ uncertain: true });
    expect(f.writes).toHaveLength(2);
  });

  it("T-A8: returned timestamps persist without S1-TS and expire at seven days (mutant: memory-only echoes)", async () => {
    const f = fixture({ timestampSupported: false });
    expect(await f.transport.reserve({ ...attempt, text: "hello" })).toEqual([]);
    await f.send();
    expect(f.writes[0].params).toEqual({ noteToSelf: true, message: "hello" });
    f.restart(); expect(f.transport.hasSentTimestamp(epoch)).toBe(true);
    f.clock(epoch + 7 * 86400000); f.transport.prune();
    expect(f.transport.hasSentTimestamp(epoch)).toBe(true);
    f.clock(epoch + 7 * 86400000 + 1); f.transport.prune(); f.restart();
    expect(f.transport.hasSentTimestamp(epoch)).toBe(false);
    expect(f.read().entries).toEqual([]);
  });

  it.each(["timeout", "offline", "broken-pipe", "invalid-frame"])("T-ERRORS: %s after write is uncertain (mutant: retry after submission)", async code => {
    const f = fixture(); await f.send("accepted", { deliveryId: "accepted" });
    f.reply(async () => { throw Object.assign(new Error("private details"), { code }); });
    const { ledger, rows } = f.ledger(); ledger.accept({ deliveryId: "failed", prompt: "note", occurredAt: epoch });
    await ledger.drain(); await ledger.drain(); await ledger.drain();
    expect(rows()[0]).toMatchObject({ state: "uncertain", attempts: 1 });
    expect(f.writes).toHaveLength(2);
  });

  it("T-ERRORS: offline before write retries with a new persisted attempt across restart (mutant: mark written before readiness)", async () => {
    const f = fixture(); f.preError("offline");
    let current = f.ledger(); current.ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch });
    await current.ledger.drain();
    expect(current.rows()[0]).toMatchObject({ state: "queued", attempts: 1 });
    expect(f.read().entries[0].chunks[0].state).toBe("reserved");
    f.restart(); f.preError(); f.clock(epoch + 2000); current = f.ledger(); await current.ledger.drain();
    expect(current.rows()[0]).toMatchObject({ state: "sent", attempts: 2, messageId: String(epoch + 2000) });
    expect(f.read().entries.map((entry: DeliveryAttempt) => entry.attempt)).toEqual([1, 2]);
    expect(f.writes).toHaveLength(1);
  });

  it("T-SEND-SCHEMA: invalid or unreserved input rejects before any write (mutant: trust caller timestamps)", async () => {
    const f = fixture(); await f.send("valid", { deliveryId: "valid" });
    for (const text of ["", "x".repeat(12001)]) await expect(f.send(text)).rejects.toMatchObject({ code: "invalid-request", uncertain: false });
    await expect(f.send("hello", { reserved: ["123"] })).rejects.toMatchObject({ code: "invalid-request", uncertain: false });
    f.preError("invalid-request");
    await expect(f.send()).rejects.toMatchObject({ code: "invalid-request", uncertain: false });
    expect(f.writes).toHaveLength(1);
  });

  it.each(["FAILURE", "foreign", "empty", "mixed", "timestamp"])("T-ERRORS: %s success result cannot confirm (mutant: trust any result)", async kind => {
    const f = fixture(); await f.send("accepted", { deliveryId: "accepted" });
    f.reply(async request => {
      const response = successful(request); if (!("result" in response) || !response.result) throw new Error();
      if (kind === "foreign") response.result.results[0].recipientAddress.uuid = stranger;
      else if (kind === "empty") response.result.results = [];
      else if (kind === "mixed") response.result.results.push({ recipientAddress: { uuid: owner, number: null }, type: "FAILURE" });
      else if (kind === "timestamp") response.result.timestamp++;
      else response.result.results[0].type = kind;
      return response;
    });
    await expect(f.send()).rejects.toMatchObject({ uncertain: true });
    expect(f.read().entries[1].chunks[0].state).toBe("written");
  });

  it("T-RL / T-RL-DEADLINE: null proof never retries across drains and restart, retains reply and cooldown (mutant: retry -5)", async () => {
    const f = fixture(); await f.send("accepted", { deliveryId: "accepted" });
    f.reply(async request => parseResponse("send", { ...limited(), id: request.id }));
    let current = f.ledger(); current.ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch });
    for (let i = 0; i < 3; i++) await current.ledger.drain();
    f.restart(); f.clock(epoch + 100000); current = f.ledger(); await current.ledger.drain();
    expect(current.rows()[0]).toMatchObject({ state: "uncertain", error: "rate-limit", response: "hello", resendAfter: epoch + 17000 });
    expect(f.writes).toHaveLength(2);
    expect(f.log.mock.calls).toEqual([["[signal] reply may have been sent: rate-limit retryAfter=17"]]);
    expect(f.count.mock.calls).toEqual([["signal.send.uncertain", { reason: "rate-limit" }]]);
  });

  it.each([undefined, -1, "17", NaN, Infinity, Number.MAX_VALUE])("T-RL-DEADLINE: invalid delay %s defaults to 60 (mutant: omit cooldown)", async delay => {
    const f = fixture(); f.reply(async request => ({ ...limited(17), id: request.id }));
    await expect(f.send("paired", { deliveryId: "paired" })).rejects.toMatchObject({ retryAfterSeconds: 17 });
    const error = limited();
    const result = (error as any).error.data.response.results[0];
    if (delay === undefined) delete result.retryAfterSeconds; else result.retryAfterSeconds = delay;
    f.reply(async request => ({ ...error, id: request.id }));
    await expect(f.send()).rejects.toMatchObject({ code: "rate-limit", uncertain: true, retryAfterSeconds: 60 });
  });

  it.each(["live-version", "pin-version", "two", "success", "foreign", "old-shape", "extra", "no-citation"])(
    "T-RL-PIN: %s closes the corrected proof gate (mutant: trust pin or ignore results)", async guard => {
      const f = fixture({ pin: { signalCliVersion: "test-pin", rateLimitNotSentProof: { ...proof } } });
      f.reply(async request => ({ ...limited(), id: request.id }));
      await expect(f.send("paired", { deliveryId: "paired" })).rejects.toMatchObject({ uncertain: false, retryAfterSeconds: 17 });
      const response = limited() as any;
      if (guard === "live-version") f.options.liveVersion = () => "other";
      if (guard === "pin-version") f.options.pin.signalCliVersion = "other";
      if (guard === "no-citation") f.options.pin.rateLimitNotSentProof!.citation = "";
      if (guard === "two") response.error.data.response.results.push(structuredClone(response.error.data.response.results[0]));
      if (guard === "success") response.error.data.response.results[0].type = "SUCCESS";
      if (guard === "foreign") response.error.data.response.results[0].recipientAddress.uuid = stranger;
      if (guard === "old-shape") response.error.data = response.error.data.response;
      if (guard === "extra") response.error.data.response.results[0].success = true;
      f.reply(async request => ({ ...response, id: request.id }));
      await expect(f.send()).rejects.toMatchObject({ code: "rate-limit", uncertain: true });
    });

  it("T-RL-PIN: proved owner-only rate limit retries once after its deadline (mutant: bypass retryAfter)", async () => {
    const f = fixture({ pin: { signalCliVersion: "test-pin", rateLimitNotSentProof: proof } });
    f.reply(async request => f.writes.length === 1 ? { ...limited(), id: request.id } : successful(request));
    const { ledger, rows } = f.ledger(); ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch });
    await ledger.drain(); f.clock(epoch + 16999); await ledger.drain(); expect(f.writes).toHaveLength(1);
    f.clock(epoch + 17000); await ledger.drain();
    expect(f.writes).toHaveLength(2); expect(rows()[0].state).toBe("sent");
  });

  it.each(["rate-limit", "offline", "invalid-request"])("T-RL-PARTIAL / T-ERRORS: chunk two %s is never retried (mutant: retry whole reply)", async code => {
    const f = fixture({ pin: { signalCliVersion: "test-pin", rateLimitNotSentProof: proof } });
    await f.send("x".repeat(2001), { deliveryId: "paired" });
    f.reply(async request => {
      if (f.writes.length === 3) return successful(request);
      if (code === "rate-limit") return { ...limited(), id: request.id };
      throw Object.assign(new Error("private"), { code });
    });
    await expect(f.send("x".repeat(2001))).rejects.toMatchObject({ uncertain: true, partial: true });
    f.restart(); await expect(f.send("x".repeat(2001))).rejects.toMatchObject({ uncertain: true });
    expect(f.writes).toHaveLength(4);
  });

  it("T-REDACT: cancellation at the delayed host boundary prevents the next chunk (mutant: fence only before request)", async () => {
    const f = fixture(); await f.send("x".repeat(2001), { deliveryId: "paired" });
    f.before(async () => { if (f.writes.length === 3) f.redact(); });
    await expect(f.send("x".repeat(2001))).rejects.toMatchObject({ uncertain: true, partial: true });
    expect(f.writes).toHaveLength(3);
    expect(f.read().entries[1].chunks[1].state).toBe("reserved");
  });

  it.each(["generation", "spawn-token", "current", "abort"])("T-REDACT: %s is checked at every write (mutant: use stale readiness)", async guard => {
    const f = fixture(); await f.send("paired", { deliveryId: "paired" });
    const controller = new AbortController();
    f.before(async () => {
      if (guard === "generation") f.host.generation++;
      if (guard === "spawn-token") f.host.spawnToken = Symbol("replacement child");
      if (guard === "current") f.options.isCurrent = () => false;
      if (guard === "abort") controller.abort();
    });
    await expect(f.transport.sendNoteToSelf({ ...attempt, text: "hello", signal: controller.signal, isRedacted: () => false })).rejects.toBeInstanceOf(ChannelSendError);
    expect(f.writes).toHaveLength(1);
  });

  it.each(["line\n".repeat(6000), "word ".repeat(6000), "x".repeat(30000)])("T-FORMAT: full output is formatted before the ledger cuts (mutant: format after ledger)", async output => {
    const f = fixture();
    expect(formatSignalResult("x".repeat(12000))).toBe("x".repeat(12000));
    const { ledger, rows } = f.ledger(output); ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch });
    await ledger.drain();
    const sent = f.writes.map(request => request.params.message).join("");
    expect(sent).toBe(formatSignalResult(output)); expect(rows()[0].response).toBe(sent);
    expect(sent.length).toBeLessThanOrEqual(12000); expect(sent.endsWith("\nThe rest is in Murage.")).toBe(true);
    expect(f.writes.length).toBeLessThanOrEqual(6);
    expect(f.writes.every(request => request.params.message.length <= 2000)).toBe(true);
  });

  it("T-WRAP-SIZE: actual wrapped 6,000 accepted, 6,001 and expanded sentinels refused (mutant: body length only)", () => {
    const overhead = wrapUntrusted("SIGNAL", { body: "" }).length;
    const accepted = "x".repeat(6000 - overhead);
    expect(prepareSignalPrompt(accepted)).toBe(wrapUntrusted("SIGNAL", { body: accepted }));
    expect(prepareSignalPrompt(accepted)?.length).toBe(6000);
    expect(prepareSignalPrompt(accepted + "x")).toBeNull();
    expect(prepareSignalPrompt("x".repeat("[UNTRUSTED A]".repeat(269).length))).not.toBeNull();
    expect(prepareSignalPrompt("[UNTRUSTED A]".repeat(269))).toBeNull();
  });

  it("T-FORMAT: Unicode at the six-chunk boundary remains complete text (mutant: split surrogate pairs)", async () => {
    const f = fixture();
    await f.send("x".repeat(12000), { deliveryId: "paired" });
    const output = "x" + "😀".repeat(5999) + "x";
    expect(output.length).toBe(12000);
    const { ledger, rows } = f.ledger(output); ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch });
    await ledger.drain();
    expect(rows()[0].state).toBe("sent");
    const messages = f.writes.slice(6).map(request => request.params.message);
    expect(messages.length).toBeLessThanOrEqual(6);
    expect(messages.every(message => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(message))).toBe(true);
    expect(messages.join("")).toBe(formatSignalResult(output));
    expect(messages.join("").endsWith("\nThe rest is in Murage.")).toBe(true);
  });

  it.each(["before", "after"])("T-A8: %s-commit disk failure stops writes and requires reopening (mutant: send without durable progress)", async boundary => {
    const f = fixture(); await f.send("paired", { deliveryId: "paired" });
    await f.transport.reserve({ ...attempt, text: "hello" });
    const write = atomic.writeFileAtomic;
    const fault = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, data, options) => {
      if (boundary === "after") write(file, data, options);
      throw new Error("disk");
    });
    await expect(f.send()).rejects.toBeInstanceOf(ChannelSendError);
    expect(f.writes).toHaveLength(1);
    fault.mockRestore();
    await expect(f.send()).rejects.toMatchObject({ uncertain: true });
    expect(f.writes).toHaveLength(1);
    f.restart();
    if (boundary === "before") await f.send();
    else await expect(f.send()).rejects.toMatchObject({ uncertain: true });
    expect(f.writes).toHaveLength(boundary === "before" ? 2 : 1);
  });

  it("T-NOTICE-ONCE: a lost notice answer is not repeated after restart; reply gets a separate entry (mutant: retry notices)", async () => {
    const f = fixture(); let done = false;
    f.reply(async request => { if (!done) throw Object.assign(new Error("lost"), { code: "timeout" }); return successful(request); });
    const open = () => {
      let ledger: DurableDelivery;
      ledger = new DurableDelivery({ file: join(f.root, "ledger.json"), bindingKey: "connection", recipient: f.transport.recipient,
        isCurrent: () => true, now: () => epoch, maxResponse: SIGNAL_MAX_RESPONSE, noticeAtMostOnce: true,
        runs: formatSignalRuns({ enqueue: () => ({ id: "run" }), result: () => done ? { status: "completed", output: "hello" }
          : { status: "running", notice: "hello" } }), ...f.transport.ledgerHooks(id => ledger.isRedacted(id)),
      });
      return ledger;
    };
    let ledger = open(); ledger.accept({ deliveryId: "delivery", prompt: "note", occurredAt: epoch }); await ledger.drain();
    f.restart(); ledger = open(); await ledger.drain(); expect(f.writes).toHaveLength(1);
    done = true; await ledger.drain();
    expect(f.writes).toHaveLength(2);
    expect(f.read().entries.map((entry: DeliveryAttempt) => [entry.purpose, entry.attempt])).toEqual([["notice", 1], ["reply", 1]]);
  });

  it("T-ERRORS: corrupt outbox fails closed and preserves bytes (mutant: reset damaged progress)", async () => {
    const f = fixture(); await f.transport.reserve({ ...attempt, text: "hello" }); f.restart();
    writeFileSync(f.options.file, "{bad");
    expect(() => f.restart()).toThrow(); expect(readFileSync(f.options.file, "utf8")).toBe("{bad");
  });

  it("T-HOOK-ID contract: B6 compiles against frozen B0 and B1 (mutant: omit cancellation fence)", () => {
    const accepted = join(SERVER_DIR, "channels/signal/transport-contract-accepted.ts");
    const rejected = join(SERVER_DIR, "channels/signal/transport-contract-rejected.ts");
    const prelude = `import { SignalTransport } from "./transport.ts"; import type { Transport } from "./types.ts";
      declare const transport: SignalTransport; const frozen: Transport = transport;`;
    const program = virtualProgram({
      [accepted]: prelude + `frozen.sendNoteToSelf({ deliveryId: "d", purpose: "reply", attempt: 1, text: "hello", isRedacted: () => false });`,
      [rejected]: prelude + `frozen.sendNoteToSelf({ deliveryId: "d", purpose: "reply", attempt: 1, text: "hello" });`,
    });
    expect(diagnosticsFor(program, accepted)).toEqual([]);
    expect(diagnosticsFor(program, rejected)).toHaveLength(1);
    expect(diagnosticsFor(program, rejected)[0]).toMatch(/^2345:.*SendNoteToSelfInput/);
    expect(diagnosticsFor(program, join(SERVER_DIR, "channels/signal/transport.ts"))).toEqual([]);
  });
});
