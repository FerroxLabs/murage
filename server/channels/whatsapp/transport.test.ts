import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSendError } from "../durable-delivery.ts";
import type { ForkFn } from "./bridge-host.ts";
import { BridgeRequestError } from "./bridge-host.ts";
import type { InboundEnvelope } from "./core/protocol.ts";
import { BridgeTransport, toChannelSendError, type HealthEvent, type LinkEvent, type StatusNote } from "./transport.ts";

const KEY = "cd".repeat(32);
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "testing", "fixture-child.ts");
const realSetTimeout = globalThis.setTimeout;
const tick = (ms = 4): Promise<void> => new Promise(resolve => { realSetTimeout(resolve, ms); });
async function until(condition: () => boolean, label: string, limit = 2500): Promise<void> {
  for (let i = 0; i < limit; i++) { if (condition()) return; await tick(4); }
  throw new Error(`timed out waiting for ${label}`);
}

class FakeChild extends EventEmitter {
  connected = true; pid = 7; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  sent: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  send(message: unknown): boolean {
    this.sent.push(message as Record<string, unknown>);
    if ((message as { kind?: string }).kind === "stop") queueMicrotask(() => this.kill("SIGTERM"));
    return true;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.exitCode = null; this.signalCode = signal; this.connected = false; this.emit("exit", null, signal); return true; }
  say(message: unknown): void { this.emit("message", message); }
}

const roots: string[] = [], transports: BridgeTransport[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(t => t.stop().catch(() => undefined))); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function scripted() {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-transport-")); roots.push(dir);
  const children: FakeChild[] = [];
  const fork: ForkFn = () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; };
  const transport = new BridgeTransport({ connectionId: "c1", dataDir: dir, mode: "contacts", appVersion: "0.1.64", getAuthKey: () => KEY, script: "bridge.js", fork });
  transports.push(transport);
  const health: HealthEvent[] = [], links: LinkEvent[] = [], notes: StatusNote[] = [], envelopes: Array<{ e: InboundEnvelope; ack: () => Promise<void> }> = [];
  transport.onLink(e => links.push(e));
  const start = async () => {
    await transport.start({ onEnvelope: (e, ack) => envelopes.push({ e, ack }), onHealth: h => health.push(h), onNote: n => notes.push(n) });
    children[0].say({ kind: "ready", v: 1 });
    await until(() => children[0].sent.some(m => m.kind === "init"), "init");
    children[0].say({ kind: "initialized" });
  };
  return { transport, children, health, links, notes, envelopes, start };
}
const envelope: InboundEnvelope = { messageId: "M1", chatJid: "15550002222@s.whatsapp.net", fromMe: false, timestampMs: 1_700_000_000_000, upsertType: "notify", mentionedJids: [], text: "hi" };

it("retains the host until shutdown confirms exit", async () => {
  const stop = vi.fn().mockRejectedValueOnce(new Error("exit not confirmed")).mockResolvedValue(undefined);
  const host = { start: vi.fn(), stop };
  const factory = vi.fn(() => host as unknown as import("./bridge-host.ts").BridgeHost);
  const transport = new BridgeTransport({ connectionId: "c1", dataDir: "unused", mode: "self-chat", appVersion: "test",
    getAuthKey: () => KEY, hostFactory: factory });
  const handlers = { onEnvelope: vi.fn(), onHealth: vi.fn() };
  await transport.start(handlers);
  await expect(transport.stop()).rejects.toThrow("exit not confirmed");
  await expect(transport.start(handlers)).rejects.toThrow("already started");
  expect(factory).toHaveBeenCalledOnce();
  await transport.stop(); expect(stop).toHaveBeenCalledTimes(2);
});

it("forwards link events only to the link listener and connection state to health", async () => {
  const f = scripted(); await f.start();
  f.children[0].say({ kind: "qr", text: "2@qr", version: 2, issuedAt: 5 });
  f.children[0].say({ kind: "pairing-code", code: "ABCD1234", phone: "15550001111" });
  f.children[0].say({ kind: "connection", state: "connected", self: { pn: "15550001111@s.whatsapp.net", lid: "99@lid" }, lastSeenAtMs: 77 });
  expect(f.links).toEqual([{ kind: "qr", text: "2@qr", version: 2, issuedAt: 5 }, { kind: "pairing-code", code: "ABCD1234", phone: "15550001111" }]);
  expect(f.health).toEqual([{ state: "connected", self: { pn: "15550001111@s.whatsapp.net", lid: "99@lid" }, lastSeenAtMs: 77 }]);
  expect(f.transport.self()).toEqual({ pn: "15550001111@s.whatsapp.net", lid: "99@lid" });
  expect(JSON.stringify(f.health)).not.toContain("2@qr");
});
it("hands over an inbound message and sends the bridge ack only when the service calls ack", async () => {
  const f = scripted(); await f.start();
  f.children[0].say({ kind: "inbound", seq: 9, envelope });
  expect(f.envelopes).toHaveLength(1); expect(f.envelopes[0].e).toMatchObject({ messageId: "M1" });
  expect(f.children[0].sent.some(m => m.kind === "ack")).toBe(false);
  await f.envelopes[0].ack();
  expect(f.children[0].sent.filter(m => m.kind === "ack")).toEqual([{ kind: "ack", seq: 9 }]);
});
it("reports ingress write failures and truncated catch-up as notes", async () => {
  const f = scripted(); await f.start();
  f.children[0].say({ kind: "status", ingressWriteFailed: { remoteJid: "1@s.whatsapp.net", id: "X" }, catchUpTruncated: true });
  expect(f.notes).toEqual([{ kind: "ingress-write-failed", remoteJid: "1@s.whatsapp.net", id: "X" }, { kind: "catch-up-truncated" }]);
});
it("reserves, then sends under the reserved ids with the quote, and answers with the ids", async () => {
  const f = scripted(); await f.start();
  const reserved = f.transport.reserve({ chatId: "15550002222@s.whatsapp.net", text: "hello" });
  await until(() => f.children[0].sent.some(m => m.kind === "reserve"), "reserve");
  const req = f.children[0].sent.find(m => m.kind === "reserve")!;
  f.children[0].say({ kind: "reserved", reqId: req.reqId, ids: ["W1"] });
  expect(await reserved).toEqual({ ids: ["W1"] });
  const sent = f.transport.sendText({ chatId: "15550002222@s.whatsapp.net", text: "hello", ids: ["W1"], quote: { remoteJid: "15550002222@s.whatsapp.net", id: "M1", text: "hi" }, signal: new AbortController().signal });
  await until(() => f.children[0].sent.some(m => m.kind === "send"), "send");
  const send = f.children[0].sent.find(m => m.kind === "send")!;
  expect(send).toMatchObject({ ids: ["W1"], payload: { type: "text", text: "hello", quote: { id: "M1", text: "hi" } } });
  f.children[0].say({ kind: "send-result", reqId: send.reqId, ok: true, ids: ["W1"] });
  expect(await sent).toEqual({ ids: ["W1"] });
});
it("maps a bridge failure to the ledger's error codes, with partial sends uncertain", async () => {
  const f = scripted(); await f.start();
  const sent = f.transport.sendText({ chatId: "1@s.whatsapp.net", text: "a", ids: ["A", "B"], signal: new AbortController().signal });
  await until(() => f.children[0].sent.some(m => m.kind === "send"), "send");
  const send = f.children[0].sent.find(m => m.kind === "send")!;
  f.children[0].say({ kind: "send-result", reqId: send.reqId, ok: false, error: { code: "unavailable", message: "x" }, sentIds: ["A"] });
  await expect(sent).rejects.toMatchObject({ code: "unavailable", uncertain: true, partial: true });
});
it("maps request errors directly", () => {
  expect(toChannelSendError(new BridgeRequestError({ code: "rate-limit", message: "x", retryAfterSeconds: 12 }))).toMatchObject({ code: "rate-limit", uncertain: false, partial: false, retryAfterSeconds: 12 });
  expect(toChannelSendError(new BridgeRequestError({ code: "timeout", message: "x", uncertain: true }))).toMatchObject({ code: "timeout", uncertain: true });
  expect(toChannelSendError(new Error("anything"))).toMatchObject({ code: "unavailable", uncertain: false });
  const own = new ChannelSendError("auth", false); expect(toChannelSendError(own)).toBe(own);
});
it("refuses to send once stopped and treats a failed lookup as no mapping", async () => {
  const f = scripted(); await f.start();
  await f.transport.stop();
  await expect(f.transport.reserve({ chatId: "1@s.whatsapp.net", text: "a" })).rejects.toMatchObject({ code: "offline" });
  expect(await f.transport.resolve.pnForLid("1@lid")).toBeUndefined();
  expect(f.transport.self()).toBeNull();
});
it("turns an unavailable credential store into a blocked health event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-transport-")); roots.push(dir);
  const child = new FakeChild(); const health: HealthEvent[] = [];
  const t = new BridgeTransport({ connectionId: "c1", dataDir: dir, mode: "self-chat", appVersion: "1", getAuthKey: () => { throw new Error("locked"); }, script: "bridge.js", fork: () => child as unknown as ChildProcess });
  transports.push(t);
  await t.start({ onEnvelope: () => undefined, onHealth: h => health.push(h) });
  child.say({ kind: "ready", v: 1 });
  await until(() => health.length > 0, "blocked");
  expect(health[0]).toMatchObject({ state: "blocked", blockedReason: "credential-store" });
});
it("runs end to end against the real bridge engine and its fake socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-transport-")); roots.push(dir);
  const health: HealthEvent[] = [], links: LinkEvent[] = [];
  const t = new BridgeTransport({ connectionId: "c1", dataDir: dir, mode: "self-chat", appVersion: "0.1.64", getAuthKey: () => KEY, script: FIXTURE, env: { WA_FIXTURE_MODE: "engine", WA_FIXTURE_OPEN: "1" } });
  transports.push(t); t.onLink(e => links.push(e));
  await t.start({ onEnvelope: () => undefined, onHealth: h => health.push(h) });
  await until(() => health.some(h => h.state === "idle"), "idle");
  await t.link({ method: "qr" });
  await until(() => health.some(h => h.state === "connected"), "connected");
  expect(links[0]).toMatchObject({ kind: "qr", text: "2@fixture-qr" });
  const { ids } = await t.reserve({ chatId: "15550002222@s.whatsapp.net", text: "hello **there**" });
  expect(ids).toHaveLength(1);
  expect((await t.sendText({ chatId: "15550002222@s.whatsapp.net", text: "hello **there**", ids, signal: new AbortController().signal })).ids).toEqual(ids);
});
void vi;

it("invalidates the chat generation when an in-flight send is aborted", async () => {
  const f = scripted(); await f.start(); const controller = new AbortController();
  const pending = f.transport.sendText({ chatId: "123@g.us", ids: ["R"], text: "hello", signal: controller.signal });
  await until(() => f.children[0].sent.some(m => m.kind === "send"), "send");
  const request = f.children[0].sent.find(m => m.kind === "send")!;
  controller.abort();
  expect(f.children[0].sent.at(-1)).toMatchObject({ kind: "authorize", chatId: "123@g.us", generation: 1 });
  f.children[0].say({ kind: "send-result", reqId: request.reqId, ok: false, error: { code: "forbidden", message: "changed" }, sentIds: [] });
  await expect(pending).rejects.toMatchObject({ code: "forbidden" });
});

it("waits for the bridge logout acknowledgment", async () => {
  const f = scripted(); await f.start(); let settled = false;
  const pending = f.transport.unlink().then(() => { settled = true; });
  await until(() => f.children[0].sent.some(m => m.kind === "logout"), "logout");
  expect(settled).toBe(false);
  const request = f.children[0].sent.find(m => m.kind === "logout")!;
  f.children[0].say({ kind: "result", reqId: request.reqId, ok: true });
  await pending; expect(settled).toBe(true);
});

it("revokes a chat after its send request listener has been removed", async () => {
  const f = scripted(); await f.start();
  const chatId = "1@s.whatsapp.net", signal = new AbortController();
  const sent = f.transport.sendText({ chatId, text: "a", ids: ["A"], signal: signal.signal });
  const request = f.children[0].sent.find(m => m.kind === "send")!;
  f.children[0].say({ kind: "send-result", reqId: request.reqId, ok: false, error: { code: "timeout", message: "deadline", uncertain: true }, sentIds: [] });
  await expect(sent).rejects.toMatchObject({ code: "timeout" });
  signal.abort();
  f.transport.revoke(chatId);
  expect(f.children[0].sent).toContainEqual({ kind: "authorize", chatId, generation: 1 });
});
