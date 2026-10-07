// Copyright 2026 Ferrox Labs
// The EventEmitter fake-socket pattern follows OpenClaw extensions/whatsapp/src/auto-reply.test-harness.ts and
// connection-controller.test.ts; reconnect, watchdog and ordering cases follow Hermes bridge.reconnect.test.mjs (MIT, both).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drives the real bridge engine with a scripted fake socket. Nothing here loads Baileys or touches a network.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStoreError } from "./core/auth-store.ts";
import type { ChildMessage, HostMessage, QuoteRef } from "./core/protocol.ts";
import { Bridge, extensionFor, IngressJournal, MediaStore, runBridgeProcess, type ProcessLike } from "./bridge.ts";
import { FAKE_PN, makeFakeLib, textMessage, voiceNote, type FakeLib, type FakeSocket } from "./testing/fake-baileys.ts";

const realSetTimeout = globalThis.setTimeout;
const tick = (ms = 4): Promise<void> => new Promise((resolve) => { realSetTimeout(resolve, ms); });
async function until(condition: () => boolean, label = "condition", limit = 1500): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (condition()) return;
    await tick(4);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const SELF_CHAT = "15550001111@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";

interface Rig {
  root: string;
  fake: FakeLib;
  out: ChildMessage[];
  fatal: string[];
  bridge: Bridge;
  ids: Set<number>;
  init(extra?: Record<string, unknown>): Promise<void>;
  of<K extends ChildMessage["kind"]>(kind: K): Array<Extract<ChildMessage, { kind: K }>>;
  sock(): FakeSocket;
  states(): string[];
  ingressFile(): string;
  outboundFile(): string;
  onEmit?: (message: ChildMessage) => void;
}

let roots: string[] = [];
let rigs: Rig[] = [];
let reqN = 0;

function rig(existing?: { root: string; fake?: FakeLib }, bridgeOptions: { random?: () => number } = {}): Rig {
  const root = existing?.root ?? mkdtempSync(join(tmpdir(), "murage-wa-bridge-"));
  if (!existing) roots.push(root);
  const fake = existing?.fake ?? makeFakeLib();
  const out: ChildMessage[] = [];
  const fatal: string[] = [];
  const r: Rig = {
    root, fake, out, fatal, ids: new Set(),
    bridge: undefined as unknown as Bridge,
    async init(extra = {}) {
      await r.bridge.handle({ kind: "init", v: 1, connectionId: "c1", dataDir: root, authKeyHex: KEY, mode: "self-chat", appVersion: "0.1.64", ...extra });
    },
    of: <K extends ChildMessage["kind"]>(kind: K) => out.filter((m) => m.kind === kind) as Array<Extract<ChildMessage, { kind: K }>>,
    sock: () => fake.last(),
    states: () => out.filter((m): m is Extract<ChildMessage, { kind: "connection" }> => m.kind === "connection").map((m) => m.state),
    ingressFile: () => join(root, "ingress", "c1.ndjson"),
    outboundFile: () => join(root, "outbound", "c1.json"),
  };
  r.bridge = new Bridge({
    lib: fake.lib,
    send: (message) => { out.push(message); r.onEmit?.(message); },
    onFatal: (message) => fatal.push(message),
    random: bridgeOptions.random ?? (() => 0),
  });
  rigs.push(r);
  return r;
}

async function linkAndOpen(r: Rig, extraInit: Record<string, unknown> = {}): Promise<FakeSocket> {
  await r.init(extraInit);
  await r.bridge.handle({ kind: "link", method: "qr" });
  const socket = r.sock();
  socket.open();
  await until(() => r.states().includes("connected"), "connected");
  return socket;
}

const send = (r: Rig, message: HostMessage | Record<string, unknown>): Promise<void> => r.bridge.handle(message);

async function reserveAndSend(r: Rig, chat: string, text: string, quote?: QuoteRef): Promise<Extract<ChildMessage, { kind: "send-result" }>> {
  const reqId = `q${++reqN}`;
  await send(r, { kind: "reserve", reqId, chatId: chat, payload: { type: "text", text } });
  const reserved = r.of("reserved").find((m) => m.reqId === reqId);
  if (!reserved) throw new Error(`reserve failed: ${JSON.stringify(r.of("result"))}`);
  const sendId = `s${++reqN}`;
  await send(r, { kind: "send", reqId: sendId, chatId: chat, ids: reserved.ids, payload: { type: "text", text, ...(quote ? { quote } : {}) } });
  const result = r.of("send-result").find((m) => m.reqId === sendId);
  if (!result) throw new Error("no send-result");
  return result;
}

/** With fake timers: run `promise` to completion by stepping the clock. */
async function drive<T>(promise: Promise<T>, stepMs = 100, max = 3000): Promise<T> {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < max && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await tick(1);
  }
  return promise;
}

beforeEach(() => { reqN = 0; });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(rigs.map((r) => r.bridge.stop().catch(() => undefined)));
  rigs = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("init and linking", () => {
  it("idles after init and opens no socket without credentials", async () => {
    const r = rig();
    await r.init();
    expect(r.states()).toEqual(["idle"]);
    expect(r.fake.sockets).toHaveLength(0);
  });

  it("opens the socket with the designed options", async () => {
    const r = rig();
    await r.init({ lastGoodWebVersion: [2, 3000, 9] });
    r.fake.versionBehavior.mode = "reject";
    await send(r, { kind: "link", method: "qr" });
    const config = r.sock().config;
    expect(config.browser).toEqual(["Murage", "Desktop", "0.1.64"]);
    expect(config.markOnlineOnConnect).toBe(false);
    expect(config.syncFullHistory).toBe(false);
    expect(config.shouldSyncHistoryMessage()).toBe(false);
    expect(config.generateHighQualityLinkPreview).toBe(false);
    expect([config.keepAliveIntervalMs, config.connectTimeoutMs, config.defaultQueryTimeoutMs]).toEqual([25000, 60000, 60000]);
    expect(config.emitOwnEvents).toBeUndefined(); // left at the Baileys default: the echo path relies on own-message upserts
    expect(["status@broadcast", "1234@broadcast", "1@newsletter"].map((jid) => config.shouldIgnoreJid(jid))).toEqual([true, true, true]);
    expect(config.shouldIgnoreJid("1@s.whatsapp.net")).toBe(false);
    expect(config.auth.creds.noiseKey).toBeDefined();
    expect(config.logger.level).toBe("silent");
    expect(config.version).toEqual([2, 3000, 9]); // the version fetch failed, the last good one is used
  });

  it("takes the live web version when the fetch works", async () => {
    const r = rig();
    await r.init();
    await send(r, { kind: "link", method: "qr" });
    expect(r.sock().config.version).toEqual([2, 3000, 1]);
  });

  it("forwards each QR with a counter, never writes it to disk, and reports linking", async () => {
    const r = rig();
    await r.init();
    await send(r, { kind: "link", method: "qr" });
    r.sock().qr("2@SECRET-QR-ONE");
    r.sock().qr("2@SECRET-QR-TWO");
    await until(() => r.of("qr").length === 2);
    expect(r.of("qr").map((m) => [m.text, m.version])).toEqual([["2@SECRET-QR-ONE", 1], ["2@SECRET-QR-TWO", 2]]);
    expect(r.states()).toEqual(["idle", "linking"]);
    const files: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const path = join(dir, name); statSync(path).isDirectory() ? walk(path) : files.push(path); } };
    walk(r.root);
    for (const file of files) expect(readFileSync(file).includes("SECRET-QR")).toBe(false);
  });

  it("requests an 8 character pairing code once, after the first QR, and does not forward QRs in code mode", async () => {
    const r = rig();
    await r.init();
    await send(r, { kind: "link", method: "code", phone: "15550001111" });
    r.sock().qr();
    r.sock().qr();
    await until(() => r.of("pairing-code").length === 1);
    await tick(20);
    expect(r.sock().pairingRequests).toEqual(["15550001111"]);
    expect(r.of("pairing-code")[0]).toEqual({ kind: "pairing-code", code: "ABCD1234", phone: "15550001111" });
    expect(r.of("qr")).toHaveLength(0);
  });

  it("reports connected with the linked identity only after the credentials are on disk, encrypted", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const connected = r.of("connection").find((m) => m.state === "connected")!;
    expect(connected.self).toEqual({ pn: SELF_CHAT, lid: "99887766@lid" });
    expect(r.of("status").some((m) => m.credsPersisted)).toBe(true);
    const creds = readFileSync(join(r.root, "auth", "creds.bin"));
    expect(creds.includes("noiseKey")).toBe(false);
    expect(socket.user?.id).toBe(FAKE_PN);
  });

  it("restores a linked session on init without a QR", async () => {
    const first = rig();
    await linkAndOpen(first);
    await first.bridge.stop();
    const second = rig({ root: first.root });
    await second.init();
    expect(second.fake.sockets).toHaveLength(1);
    expect(second.of("qr")).toHaveLength(0);
    expect(second.sock().config.auth.creds.registered).toBe(true);
  });

  it("refuses to link again while connected", async () => {
    const r = rig();
    await linkAndOpen(r);
    await send(r, { kind: "link", method: "qr" });
    expect(r.fake.sockets).toHaveLength(1);
  });
});

describe("close handling (design 2.4)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });

  it("515 restarts once after the credentials settle, and a second 515 within 2 minutes is a retry", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(515);
    await until(() => r.states().includes("restarting"));
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => r.fake.sockets.length === 2);
    r.sock().open();
    await until(() => r.states().filter((s) => s === "connected").length === 2);
    r.sock().close(515);
    await until(() => r.states().at(-1) === "retry");
    expect(r.states().filter((s) => s === "restarting")).toHaveLength(1);
  });

  it("401 wipes every credential, reports logged-out and never reconnects", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(401);
    await until(() => r.states().at(-1) === "logged-out");
    expect(readdirSync(join(r.root, "auth"))).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await tick(20);
    expect(r.fake.sockets).toHaveLength(1);
    expect(r.of("connection").at(-1)?.decision).toMatchObject({ action: "stop-logged-out", reconnect: false, wipeAuth: true });
  });

  it("a remote logout that arrives while a restart is scheduled does not restart-loop", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(401);
    await until(() => r.states().at(-1) === "logged-out");
    await vi.advanceTimersByTimeAsync(60_000);
    await tick(20);
    expect(r.fake.sockets).toHaveLength(1);
    expect(r.fatal).toEqual([]);
  });

  it("440 is a conflict: no reconnect, credentials kept", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(440);
    await until(() => r.states().at(-1) === "conflict");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await tick(20);
    expect(r.fake.sockets).toHaveLength(1);
    expect(existsSync(join(r.root, "auth", "creds.bin"))).toBe(true);
  });

  it("403 and 411 block with their reasons", async () => {
    for (const [code, reason] of [[403, "forbidden"], [411, "multidevice-mismatch"]] as const) {
      const r = rig();
      const socket = await linkAndOpen(r);
      socket.close(code);
      await until(() => r.states().at(-1) === "blocked");
      expect(r.of("connection").at(-1)?.blockedReason).toBe(reason);
    }
  });

  it("428 retries with backoff and comes back; 12 failed attempts block with retry-limit", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(428);
    await until(() => r.states().at(-1) === "retry");
    expect(r.of("connection").at(-1)).toMatchObject({ attempt: 1, retryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => r.fake.sockets.length === 2);
    for (let attempt = 2; attempt <= 12; attempt++) {
      r.sock().close(428);
      await until(() => r.of("connection").at(-1)?.attempt === attempt);
      await vi.advanceTimersByTimeAsync(31_000);
      await until(() => r.fake.sockets.length === attempt + 1);
    }
    r.sock().close(428);
    await until(() => r.states().at(-1) === "blocked");
    expect(r.of("connection").at(-1)?.blockedReason).toBe("retry-limit");
    const count = r.fake.sockets.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await tick(20);
    expect(r.fake.sockets).toHaveLength(count);
  });

  it("sustained frames reset the failure count after recovery", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(428);
    await until(() => r.states().at(-1) === "retry");
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => r.fake.sockets.length === 2);
    r.sock().open();
    await until(() => r.states().filter((s) => s === "connected").length === 2);
    for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(60_000); r.sock().frame(); }
    r.sock().close(428);
    await until(() => r.states().at(-1) === "retry");
    expect(r.of("connection").at(-1)?.attempt).toBe(1);
  });

  it("restarts a connected socket after 3 minutes without any frame, and a frame resets the clock", async () => {
    const r = rig();
    await linkAndOpen(r);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      r.sock().frame();
    }
    expect(r.fake.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await until(() => r.fake.sockets.length === 2);
    expect(r.states()).toContain("retry");
  });

  it("an event from a replaced socket is ignored", async () => {
    const r = rig();
    const first = await linkAndOpen(r);
    first.close(428);
    await until(() => r.states().at(-1) === "retry");
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => r.fake.sockets.length === 2);
    const states = r.states().length;
    first.close(401);
    await tick(20);
    expect(r.states()).toHaveLength(states);
  });
});

describe("auth failures", () => {
  it("a different key cannot read an existing auth directory: blocked auth-unreadable, no socket", async () => {
    const first = rig();
    await linkAndOpen(first);
    await first.bridge.stop();
    const second = rig({ root: first.root });
    await second.init({ authKeyHex: OTHER_KEY });
    expect(second.of("connection").at(-1)).toMatchObject({ state: "blocked", blockedReason: "auth-unreadable" });
    expect(second.fake.sockets).toHaveLength(0);
  });

  it("a symlinked auth directory is refused", async () => {
    const r = rig();
    mkdirSync(join(r.root, "real"), { recursive: true });
    symlinkSync(join(r.root, "real"), join(r.root, "auth"));
    await r.init();
    expect(r.of("connection").at(-1)).toMatchObject({ state: "blocked", blockedReason: "auth-dir" });
  });

  it("a failed credential write ends the socket and asks the process to exit, so keys never run ahead of disk", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    rmSync(join(r.root, "auth"), { recursive: true, force: true });
    writeFileSync(join(r.root, "auth"), "not a directory");
    socket.ev.emit("creds.update", {});
    await until(() => r.fatal.length === 1);
    expect(r.fatal[0]).toContain("auth state could not be saved");
    expect(socket.ended).toBeGreaterThan(0);
  });

  it("a record that does not decrypt stops the socket with auth-unreadable", async () => {
    const r = rig();
    await r.init();
    await send(r, { kind: "link", method: "qr" });
    const auth = r.sock().config.auth;
    await auth.keys.set({ session: { a: { v: 1 } } });
    const file = join(r.root, "auth", "session-a.bin");
    writeFileSync(join(r.root, "auth", "session-b.bin"), readFileSync(file));
    await expect(auth.keys.get("session", ["b"])).rejects.toBeInstanceOf(AuthStoreError);
    expect(r.states().at(-1)).toBe("blocked");
    expect(r.of("connection").at(-1)?.blockedReason).toBe("auth-unreadable");
  });
});

describe("inbound journal (design 5.5)", () => {
  it("writes each message to disk before forwarding it", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const seen: string[] = [];
    r.onEmit = (message) => { if (message.kind === "inbound") seen.push(existsSync(r.ingressFile()) ? readFileSync(r.ingressFile(), "utf8") : ""); };
    socket.upsert([textMessage({ id: "IN1", chat: SELF_CHAT, text: "hello", fromMe: true })]);
    await until(() => r.of("inbound").length === 1);
    expect(seen[0]).toContain('"id":"IN1"');
    expect(seen[0]).toContain("hello");
    expect(statSync(r.ingressFile()).mode & 0o777).toBe(0o600);
    expect(r.of("inbound")[0]).toMatchObject({ seq: 1, envelope: { messageId: "IN1", chatJid: SELF_CHAT, text: "hello", fromMe: true, upsertType: "notify" } });
  });

  it("deduplicates a redelivered upsert and ignores messages with no content", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const message = textMessage({ id: "IN1", chat: SELF_CHAT, text: "hello", fromMe: true });
    socket.upsert([message, message]);
    socket.upsert([{ key: { remoteJid: SELF_CHAT, id: "R1" }, message: { reactionMessage: { text: "ok" } } }, { key: { remoteJid: SELF_CHAT, id: "P1" }, message: { protocolMessage: { type: 0 } } }, { key: { remoteJid: SELF_CHAT, id: "STUB" } }]);
    await until(() => r.of("inbound").length >= 1);
    await tick(30);
    expect(r.of("inbound")).toHaveLength(1);
    expect(readFileSync(r.ingressFile(), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("accepts notify and append upserts only", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.ev.emit("messages.upsert", { messages: [textMessage({ id: "H1", chat: SELF_CHAT, text: "old", fromMe: true })], type: "prepend" });
    socket.upsert([textMessage({ id: "A1", chat: SELF_CHAT, text: "typed", fromMe: true })], "append");
    await until(() => r.of("inbound").length === 1);
    expect(r.of("inbound")[0].envelope).toMatchObject({ messageId: "A1", upsertType: "append" });
  });

  it("an acknowledged row is finished; an unacknowledged one is resent after a restart with the same seq", async () => {
    const first = rig();
    const socket = await linkAndOpen(first);
    socket.upsert([textMessage({ id: "M1", chat: SELF_CHAT, text: "one", fromMe: true }), textMessage({ id: "M2", chat: SELF_CHAT, text: "two", fromMe: true })]);
    await until(() => first.of("inbound").length === 2);
    await send(first, { kind: "ack", seq: 1 });
    await first.bridge.stop();
    const second = rig({ root: first.root });
    await second.init();
    await until(() => second.of("inbound").length === 1);
    expect(second.of("inbound")[0]).toMatchObject({ seq: 2, envelope: { messageId: "M2", text: "two" } });
  });

  it("resends an unacknowledged row after 30 seconds, and a replay request resends everything pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.upsert([textMessage({ id: "M1", chat: SELF_CHAT, text: "one", fromMe: true })]);
    await until(() => r.of("inbound").length === 1);
    await vi.advanceTimersByTimeAsync(20_000);
    await tick(10);
    expect(r.of("inbound")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await until(() => r.of("inbound").length === 2);
    expect(r.of("inbound")[1].seq).toBe(1);
    await send(r, { kind: "replay" });
    await until(() => r.of("inbound").length === 3);
    await send(r, { kind: "ack", seq: 1 });
    await send(r, { kind: "replay" });
    await tick(30);
    expect(r.of("inbound")).toHaveLength(3);
  });

  it("holds at most 450 unacknowledged in flight and releases the next on each ack", async () => {
    const r = rig();
    const journal = IngressJournal.open(r.ingressFile(), Date.now);
    for (let i = 1; i <= 460; i++) journal.append(SELF_CHAT, `P${i}`, { type: "notify", msg: textMessage({ id: `P${i}`, chat: SELF_CHAT, text: `m${i}`, fromMe: true }) });
    journal.close();
    await linkAndOpen(r);
    await until(() => r.of("inbound").length === 450, "450 inbound", 4000);
    expect(r.of("status").some((m) => m.catchUpTruncated)).toBe(true);
    await tick(30);
    expect(r.of("inbound")).toHaveLength(450);
    await send(r, { kind: "ack", seq: 1 });
    await until(() => r.of("inbound").length === 451);
    expect(r.of("inbound")[450].seq).toBe(451);
  });

  it("never prunes a pending row, however many or however old", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-wa-journal-"));
    roots.push(root);
    const file = join(root, "ingress", "c1.ndjson");
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 3_600_000;
    const old = IngressJournal.open(file, () => thirtyOneDaysAgo);
    for (let i = 1; i <= 451; i++) old.append(SELF_CHAT, `P${i}`, { type: "notify", msg: { n: i } });
    old.close();
    const reopened = IngressJournal.open(file, Date.now);
    expect(reopened.pending()).toHaveLength(451);
    reopened.close();
  });

  it("a torn last line from a crash is ignored and the journal keeps working", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-wa-journal-"));
    roots.push(root);
    const file = join(root, "ingress", "c1.ndjson");
    const journal = IngressJournal.open(file, Date.now);
    journal.append(SELF_CHAT, "A", { type: "notify", msg: {} });
    journal.close();
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2,"recei`);
    const again = IngressJournal.open(file, Date.now);
    expect(again.pending().map((row) => row.id)).toEqual(["A"]);
    expect(again.append(SELF_CHAT, "B", { type: "notify", msg: {} })?.seq).toBe(2);
    again.close();
  });

  it("reports a failed journal write loudly and does not forward the message", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    (r.bridge as unknown as { journal: { append: () => never } }).journal.append = () => { throw new Error("ENOSPC"); };
    socket.upsert([textMessage({ id: "LOST", chat: SELF_CHAT, text: "x", fromMe: true })]);
    await until(() => r.of("status").some((m) => m.ingressWriteFailed));
    expect(r.of("status").find((m) => m.ingressWriteFailed)?.ingressWriteFailed).toEqual({ remoteJid: SELF_CHAT, id: "LOST" });
    expect(r.of("inbound")).toHaveLength(0);
  });

  it("carries alternate JIDs, participants, mentions and the quote to the host untouched", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.upsert([textMessage({ id: "G1", chat: GROUP, text: "hi @bot", participant: "9:3@lid", participantAlt: "19175395595@s.whatsapp.net", pushName: "Ada", mentioned: ["99887766:7@lid"], stanzaId: "Q1", quotedText: "earlier", quotedParticipant: "5@lid" })]);
    socket.upsert([textMessage({ id: "D1", chat: "777@lid", chatAlt: "19175395595@s.whatsapp.net", text: "dm" })]);
    await until(() => r.of("inbound").length === 2);
    expect(r.of("inbound")[0].envelope).toMatchObject({
      chatJid: GROUP, participant: "9:3@lid", participantAlt: "19175395595@s.whatsapp.net", pushName: "Ada", mentionedJids: ["99887766@lid"], quoted: { id: "Q1", text: "earlier", participant: "5@lid" },
    });
    expect(r.of("inbound")[1].envelope).toMatchObject({ chatJid: "777@lid", chatJidAlt: "19175395595@s.whatsapp.net", fromMe: false });
  });
});

describe("echo and the outbound journal (design 5.5)", () => {
  it("reserves ids on disk before confirming, and the id is the one sent", async () => {
    const r = rig();
    await linkAndOpen(r);
    const onDisk: string[] = [];
    r.onEmit = (message) => { if (message.kind === "reserved") onDisk.push(readFileSync(r.outboundFile(), "utf8")); };
    const result = await reserveAndSend(r, SELF_CHAT, "hello **world**");
    expect(result.ok).toBe(true);
    const ids = (result as Extract<typeof result, { ok: true }>).ids;
    expect(onDisk[0]).toContain(ids[0]);
    expect(r.sock().sent).toHaveLength(1);
    expect(r.sock().sent[0]).toMatchObject({ jid: SELF_CHAT, content: { text: "hello *world*" }, options: { messageId: ids[0] } });
    expect(statSync(r.outboundFile()).mode & 0o777).toBe(0o600);
  });

  it("drops the bot's own echo by id, and forwards the owner typing the same words under a new id", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const result = await reserveAndSend(r, SELF_CHAT, "same words");
    const id = (result as Extract<typeof result, { ok: true }>).ids[0];
    socket.upsert([textMessage({ id, chat: SELF_CHAT, text: "same words", fromMe: true })], "append");
    socket.upsert([textMessage({ id: "OWNER-TYPED", chat: SELF_CHAT, text: "same words", fromMe: true })], "append");
    await until(() => r.of("inbound").length === 1);
    await tick(30);
    expect(r.of("inbound")).toHaveLength(1);
    expect(r.of("inbound")[0].envelope.messageId).toBe("OWNER-TYPED");
    const lines = readFileSync(r.ingressFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; done: boolean });
    expect(lines.some((line) => line.id === id && line.done)).toBe(true);
  });

  it("drops an echo that arrives under the LID address of the same self chat", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const result = await reserveAndSend(r, SELF_CHAT, "hi");
    socket.upsert([textMessage({ id: (result as Extract<typeof result, { ok: true }>).ids[0], chat: "99887766@lid", text: "hi", fromMe: true })], "append");
    await tick(60);
    expect(r.of("inbound")).toHaveLength(0);
  });

  it("still recognises an id reserved before a crash that never reached the network", async () => {
    const first = rig();
    await linkAndOpen(first);
    await send(first, { kind: "reserve", reqId: "q1", chatId: SELF_CHAT, payload: { type: "text", text: "never sent" } });
    const id = first.of("reserved")[0].ids[0];
    await first.bridge.stop();
    const second = rig({ root: first.root });
    await second.init();
    second.sock().open();
    await until(() => second.states().includes("connected"));
    second.sock().upsert([textMessage({ id, chat: SELF_CHAT, text: "never sent", fromMe: true })], "append");
    await tick(60);
    expect(second.of("inbound")).toHaveLength(0);
    expect(JSON.parse(readFileSync(second.outboundFile(), "utf8")).records.map((x: { id: string }) => x.id)).toContain(id);
  });

  it("marks a reply to one of our messages so group reply gating can see it", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const result = await reserveAndSend(r, GROUP, "an answer");
    const id = (result as Extract<typeof result, { ok: true }>).ids[0];
    socket.upsert([textMessage({ id: "REPLY1", chat: GROUP, text: "thanks", participant: "9@lid", stanzaId: id, quotedText: "an answer" })]);
    await until(() => r.of("inbound").length === 1);
    expect(r.of("inbound")[0].envelope.quoted).toMatchObject({ id, outbound: true });
  });

  it("answers getMessage with the text it sent, so a retried send is not blank", async () => {
    const r = rig();
    await linkAndOpen(r);
    const result = await reserveAndSend(r, SELF_CHAT, "retry me");
    const id = (result as Extract<typeof result, { ok: true }>).ids[0];
    const config = r.sock().config;
    expect(await config.getMessage({ id })).toEqual({ conversation: "retry me" });
    expect(await config.getMessage({ id: "unknown" })).toBeUndefined();
  });
});

describe("sending (design 6)", () => {
  it("shows composing, sends, then pauses; a presence failure never fails the send", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.onPresence = async () => { throw new Error("presence rejected"); };
    const result = await reserveAndSend(r, SELF_CHAT, "hello");
    expect(result.ok).toBe(true);
    expect(socket.presence.map((p) => p.state)).toEqual(["composing", "paused"]);
    expect(socket.sent).toHaveLength(1);
  });

  it("chunks a long reply: one reserved id per chunk, one send per chunk, in order, 300 ms apart", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const text = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(" ");
    const stamps: number[] = [];
    socket.onSend = async () => { stamps.push(Date.now()); };
    const result = await reserveAndSend(r, SELF_CHAT, text);
    const ids = (result as Extract<typeof result, { ok: true }>).ids;
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(socket.sent.map((s) => s.options?.messageId)).toEqual(ids);
    expect(socket.sent.map((s) => s.content.text as string).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(280);
  });

  it("serializes replies: a second reply to another chat waits for the first", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    let release: () => void = () => undefined;
    socket.onSend = async (call) => { if (call === 1) await new Promise<void>((resolve) => { release = resolve; }); };
    await send(r, { kind: "reserve", reqId: "a", chatId: SELF_CHAT, payload: { type: "text", text: "first" } });
    await send(r, { kind: "reserve", reqId: "b", chatId: "19175395595@s.whatsapp.net", payload: { type: "text", text: "second" } });
    const [a, b] = r.of("reserved");
    const first = send(r, { kind: "send", reqId: "sa", chatId: SELF_CHAT, ids: a.ids, payload: { type: "text", text: "first" } });
    const second = send(r, { kind: "send", reqId: "sb", chatId: "19175395595@s.whatsapp.net", ids: b.ids, payload: { type: "text", text: "second" } });
    await until(() => socket.sent.length === 1);
    await tick(40);
    expect(socket.sent).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(socket.sent.map((s) => s.jid)).toEqual([SELF_CHAT, "19175395595@s.whatsapp.net"]);
  });

  it("refuses a send whose ids were never reserved, or were already used, or belong to another chat", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    await send(r, { kind: "send", reqId: "x1", chatId: SELF_CHAT, ids: ["MADE-UP"], payload: { type: "text", text: "hi" } });
    expect(r.of("send-result")[0]).toMatchObject({ ok: false, error: { code: "unavailable" }, sentIds: [] });
    const done = await reserveAndSend(r, SELF_CHAT, "hello");
    const ids = (done as Extract<typeof done, { ok: true }>).ids;
    await send(r, { kind: "send", reqId: "x2", chatId: SELF_CHAT, ids, payload: { type: "text", text: "hello" } });
    expect(r.of("send-result").find((m) => m.reqId === "x2")).toMatchObject({ ok: false });
    await send(r, { kind: "reserve", reqId: "q9", chatId: SELF_CHAT, payload: { type: "text", text: "mine" } });
    await send(r, { kind: "send", reqId: "x3", chatId: "19175395595@s.whatsapp.net", ids: r.of("reserved").at(-1)!.ids, payload: { type: "text", text: "mine" } });
    expect(r.of("send-result").find((m) => m.reqId === "x3")).toMatchObject({ ok: false });
    await send(r, { kind: "send", reqId: "x4", chatId: SELF_CHAT, ids: r.of("reserved").at(-1)!.ids, payload: { type: "text", text: "a different text entirely that chunks differently" + " x".repeat(3000) } });
    expect(r.of("send-result").find((m) => m.reqId === "x4")).toMatchObject({ ok: false });
    expect(socket.sent).toHaveLength(1);
  });

  it("retries connection errors up to 3 times, 500 ms apart, then succeeds", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.onSend = async (call) => { if (call <= 2) throw Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } }); };
    const result = await reserveAndSend(r, SELF_CHAT, "persist");
    expect(result.ok).toBe(true);
    expect(socket.sent).toHaveLength(3);
    expect(new Set(socket.sent.map((s) => s.options?.messageId)).size).toBe(1); // same reserved id every attempt
  });

  it("does not retry a forbidden error, and reports it", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.onSend = async () => { throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } }); };
    const result = await reserveAndSend(r, SELF_CHAT, "no");
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" }, sentIds: [] });
    expect(socket.sent).toHaveLength(1);
  });

  it("a failure after the first chunk is partial and uncertain, and names what was sent", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.onSend = async (call) => { if (call === 2) throw Object.assign(new Error("forbidden"), { output: { statusCode: 403 } }); };
    const text = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(" ");
    const result = await reserveAndSend(r, SELF_CHAT, text);
    expect(result.ok).toBe(false);
    const failed = result as Extract<typeof result, { ok: false }>;
    expect(failed.sentIds).toHaveLength(1);
    expect(failed.error.uncertain).toBe(true);
    expect(failed.error.message.startsWith("partial:")).toBe(true);
    expect(socket.sent).toHaveLength(2);
  });

  it("is offline when the socket is not open: three attempts, then an offline error and nothing sent", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const result0 = await reserveAndSend(r, SELF_CHAT, "warm up");
    expect(result0.ok).toBe(true);
    socket.close(428);
    await until(() => r.states().at(-1) === "retry");
    const result = await reserveAndSend(r, SELF_CHAT, "offline");
    expect(result).toMatchObject({ ok: false, error: { code: "offline" }, sentIds: [] });
    expect(socket.sent).toHaveLength(1);
  });

  it("quotes only the first chunk, and only in groups by default; no quote text means no quote", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    const quote = { remoteJid: GROUP, id: "Q1", participant: "9@lid", text: "the question" };
    await reserveAndSend(r, GROUP, "an answer", quote);
    expect(socket.sent[0].options?.quoted).toMatchObject({ key: { id: "Q1", participant: "9@lid" }, message: { conversation: "the question" } });
    await reserveAndSend(r, SELF_CHAT, "dm answer", { remoteJid: SELF_CHAT, id: "Q2", text: "q" });
    expect(socket.sent[1].options?.quoted).toBeUndefined();
    await reserveAndSend(r, GROUP, "no text", { remoteJid: GROUP, id: "Q3" });
    expect(socket.sent[2].options?.quoted).toBeUndefined(); // cache miss: unquoted rather than a blank bubble
    const long = Array.from({ length: 1400 }, (_, i) => `w${i}`).join(" ");
    await reserveAndSend(r, GROUP, long, quote);
    const chunked = socket.sent.slice(3);
    expect(chunked.length).toBeGreaterThan(1);
    expect(chunked[0].options?.quoted).toBeDefined();
    expect(chunked.slice(1).every((s) => s.options?.quoted === undefined)).toBe(true);
  });

  it("honours quoteReplies: all", async () => {
    const r = rig();
    const socket = await linkAndOpen(r, { options: { quoteReplies: "all" } });
    await reserveAndSend(r, SELF_CHAT, "dm answer", { remoteJid: SELF_CHAT, id: "Q2", text: "q" });
    expect(socket.sent[0].options?.quoted).toBeDefined();
  });

  it("sends an Ogg note as a voice bubble and mp3 as plain audio, with the clip's own MIME (Ogg gets its codec parameter)", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    for (const [mime, ptt] of [["audio/ogg", true], ["audio/mpeg", false]] as const) {
      const reqId = `v-${mime}`;
      await send(r, { kind: "reserve", reqId, chatId: SELF_CHAT, payload: { type: "audio" } });
      const ids = r.of("reserved").find((m) => m.reqId === reqId)!.ids;
      await send(r, { kind: "send", reqId: `s-${mime}`, chatId: SELF_CHAT, ids, payload: { type: "audio", name: "note", mime, bytesBase64: Buffer.from("AUDIO").toString("base64") } });
      const call = socket.sent.at(-1)!;
      expect(call.content).toMatchObject({ mimetype: ptt ? "audio/ogg; codecs=opus" : mime, ptt });
      expect(Buffer.isBuffer(call.content.audio) && (call.content.audio as Buffer).toString()).toBe("AUDIO");
    }
  });

  it("a dry run reserves and reports what it would send, and transmits nothing", async () => {
    const r = rig();
    const socket = await linkAndOpen(r, { dryRun: true });
    const result = await reserveAndSend(r, SELF_CHAT, "would send **this**");
    expect(result.ok).toBe(true);
    expect(socket.sent).toHaveLength(0);
    expect(r.of("dry-run")[0]).toMatchObject({ chatId: SELF_CHAT, chunks: ["would send *this*"] });
  });
});

describe("send timeout", () => {
  it("a send that never answers times out after 60 s as uncertain, is not retried, and its id stays known", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.onSend = () => new Promise(() => undefined);
    const result = await drive(reserveAndSend(r, SELF_CHAT, "stuck"), 1000, 200);
    expect(result).toMatchObject({ ok: false, error: { code: "timeout", uncertain: true } });
    expect(socket.sent).toHaveLength(1);
    const id = socket.sent[0].options?.messageId as string;
    socket.upsert([textMessage({ id, chat: SELF_CHAT, text: "stuck", fromMe: true })], "append");
    await tick(60);
    expect(r.of("inbound")).toHaveLength(0);
  });
});

describe("media (design 5.6)", () => {
  it("saves a voice note from the owner's own chat under a generated name and passes its path", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.upsert([voiceNote({ id: "VN1", chat: SELF_CHAT, fromMe: true })]);
    await until(() => r.of("inbound").length === 1);
    const media = r.of("inbound")[0].envelope.media!;
    expect(media).toMatchObject({ kind: "audio", ptt: true });
    expect(media.path).toMatch(/media\/c1\/[0-9a-f]{24}\/VN1\.ogg$/);
    expect(readFileSync(media.path!, "utf8")).toBe("OggS-fake-voice-note");
    expect(statSync(media.path!).mode & 0o777).toBe(0o600);
  });

  it("aborts a download over the 4 MB cap, deletes the partial file and forwards the note without a path", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    r.fake.media.chunks = [Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024)];
    socket.upsert([voiceNote({ id: "BIG", chat: SELF_CHAT, fromMe: true })]);
    await until(() => r.of("inbound").length === 1);
    expect(r.of("inbound")[0].envelope.media?.path).toBeUndefined();
    expect(r.fake.media.destroyed).toBeGreaterThan(0);
    const dir = join(r.root, "media", "c1");
    const leftovers: string[] = [];
    const walk = (d: string): void => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : leftovers.push(p); } };
    walk(dir);
    expect(leftovers).toEqual([]);
  });

  it("does not download a descriptor already over the cap, or anything from a stranger in self-chat mode", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.upsert([voiceNote({ id: "HUGE", chat: SELF_CHAT, fromMe: true, bytes: 5 * 1024 * 1024 }), voiceNote({ id: "STRANGER", chat: "19175395595@s.whatsapp.net" })]);
    await until(() => r.of("inbound").length === 2);
    expect(r.fake.downloads).toHaveLength(0);
  });

  it("a failed download is logged and the message still arrives", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    r.fake.media.failure = new Error("expired media key");
    socket.upsert([voiceNote({ id: "GONE", chat: SELF_CHAT, fromMe: true })]);
    await until(() => r.of("inbound").length === 1);
    expect(r.of("log").some((m) => m.message.includes("media download failed"))).toBe(true);
  });

  it("derives the extension from the MIME allowlist, never from sender text", () => {
    expect(extensionFor("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("application/x-evil/../../etc")).toBe("bin");
    expect(extensionFor(undefined)).toBe("bin");
  });

  it("sweeps files older than 7 days except those of unfinished messages", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-wa-media-"));
    roots.push(root);
    const store = new MediaStore(root, () => Date.now() + 8 * 24 * 3_600_000);
    mkdirSync(join(root, "chat"), { recursive: true });
    writeFileSync(join(root, "chat", "OLD.ogg"), "x");
    writeFileSync(join(root, "chat", "KEEP.ogg"), "x");
    expect(store.sweep(new Set(["KEEP"]))).toBe(1);
    expect(existsSync(join(root, "chat", "KEEP.ogg"))).toBe(true);
    expect(existsSync(join(root, "chat", "OLD.ogg"))).toBe(false);
  });
});

describe("queries, receipts and unlink", () => {
  it("lists groups sorted by name and resolves PN and LID through the library", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.groups = { "b@g.us": { id: "b@g.us", subject: "Zeta", participants: [1, 2] }, "a@g.us": { id: "a@g.us", subject: "Alpha", participants: [1] } };
    socket.lidMap = { "777@lid": "19175395595@s.whatsapp.net" };
    await send(r, { kind: "groups", reqId: "g1" });
    expect(r.of("result").find((m) => m.reqId === "g1")).toMatchObject({ ok: true, value: [{ jid: "a@g.us", subject: "Alpha", size: 1 }, { jid: "b@g.us", subject: "Zeta", size: 2 }] });
    await send(r, { kind: "resolve", reqId: "r1", op: "pn-for-lid", jid: "777@lid" });
    await send(r, { kind: "resolve", reqId: "r2", op: "lid-for-pn", jid: "19175395595@s.whatsapp.net" });
    await send(r, { kind: "resolve", reqId: "r3", op: "pn-for-lid", jid: "nobody@lid" });
    const results = r.of("result");
    expect(results.find((m) => m.reqId === "r1")).toMatchObject({ ok: true, value: { jid: "19175395595@s.whatsapp.net" } });
    expect(results.find((m) => m.reqId === "r2")).toMatchObject({ ok: true, value: { jid: "777@lid" } });
    expect(results.find((m) => m.reqId === "r3")).toMatchObject({ ok: true, value: { jid: null } });
  });

  it("answers queries with an offline error when not connected", async () => {
    const r = rig();
    await r.init();
    await send(r, { kind: "groups", reqId: "g1" });
    await send(r, { kind: "resolve", reqId: "r1", op: "pn-for-lid", jid: "1@lid" });
    expect(r.of("result").map((m) => [m.ok, m.ok === false && m.error.code])).toEqual([[false, "offline"], [false, "offline"]]);
  });

  it("sends read receipts only when the option is on", async () => {
    const off = rig();
    const offSocket = await linkAndOpen(off);
    await send(off, { kind: "read", keys: [{ remoteJid: "1@s.whatsapp.net", id: "A" }] });
    expect(offSocket.reads).toHaveLength(0);
    const on = rig();
    const onSocket = await linkAndOpen(on, { options: { readReceipts: true } });
    await send(on, { kind: "read", keys: [{ remoteJid: "1@s.whatsapp.net", id: "A", participant: "2@lid" }] });
    expect(onSocket.reads).toEqual([[{ remoteJid: "1@s.whatsapp.net", id: "A", participant: "2@lid" }]]);
  });

  it("passes a presence update through when connected", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    await send(r, { kind: "presence", chatId: SELF_CHAT, state: "composing" });
    expect(socket.presence).toEqual([{ state: "composing", jid: SELF_CHAT }]);
  });

  it("logout tells WhatsApp, wipes the credentials and idles; the ledgers and the key are not its business", async () => {
    const r = rig();
    const socket = await linkAndOpen(r);
    await send(r, { kind: "logout" });
    expect(socket.loggedOut).toBe(1);
    expect(readdirSync(join(r.root, "auth"))).toEqual([]);
    expect(r.states().at(-1)).toBe("idle");
  });

  it("logout does not wait longer than 10 seconds for WhatsApp", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.logout = () => new Promise(() => undefined);
    await drive(send(r, { kind: "logout" }), 1000, 50);
    expect(readdirSync(join(r.root, "auth"))).toEqual([]);
    expect(r.states().at(-1)).toBe("idle");
  });

  it("stop ends the socket, finishes the writes and does not reconnect afterwards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const r = rig();
    const socket = await linkAndOpen(r);
    socket.close(428);
    await until(() => r.states().at(-1) === "retry");
    await send(r, { kind: "stop" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await tick(20);
    expect(r.fake.sockets).toHaveLength(1);
    expect(r.states().at(-1)).toBe("idle");
  });

  it("answers ping with pong and ignores malformed messages", async () => {
    const r = rig();
    await send(r, { kind: "ping", n: 4 } as HostMessage);
    await r.bridge.handle({ kind: "nonsense" });
    await r.bridge.handle(null);
    expect(r.out).toEqual([{ kind: "pong", n: 4 }]);
  });
});

describe("process entry", () => {
  function fakeProcess(): { proc: ProcessLike & EventEmitter; sent: unknown[]; exits: number[] } {
    const emitter = new EventEmitter() as ProcessLike & EventEmitter;
    const sent: unknown[] = [];
    const exits: number[] = [];
    emitter.send = (message: unknown) => { sent.push(message); return true; };
    emitter.exit = ((code?: number) => { exits.push(code ?? 0); }) as ProcessLike["exit"];
    return { proc: emitter, sent, exits };
  }

  it("announces ready, handles host messages, and exits cleanly on stop", async () => {
    const { proc, sent, exits } = fakeProcess();
    await runBridgeProcess(proc, makeFakeLib().lib);
    expect(sent[0]).toEqual({ kind: "ready", v: 1 });
    proc.emit("message", { kind: "ping", n: 1 });
    await until(() => sent.some((m) => (m as { kind: string }).kind === "pong"));
    proc.emit("message", { kind: "stop" });
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
  });

  it("turns an uncaught exception into a fatal message and a non-zero exit", async () => {
    const { proc, sent, exits } = fakeProcess();
    await runBridgeProcess(proc, makeFakeLib().lib);
    proc.emit("uncaughtException", new Error("boom"));
    expect(sent.at(-1)).toMatchObject({ kind: "fatal" });
    await until(() => exits.length > 0);
    expect(exits).toEqual([1]);
  });

  it("stops and exits when the parent disconnects", async () => {
    const { proc, exits } = fakeProcess();
    await runBridgeProcess(proc, makeFakeLib().lib);
    proc.emit("disconnect");
    await until(() => exits.length > 0);
    expect(exits).toEqual([0]);
  });
});

it.each(['{', '{"version":1,"records":[{"id":"bot"}]}', '{"version":1}'])("preserves corrupt outbound state and blocks intake: %s", async contents => {
  const r = rig();
  mkdirSync(join(r.root, "outbound")); writeFileSync(r.outboundFile(), contents);
  await r.init();
  await send(r, { kind: "link", method: "qr" });
  await send(r, { kind: "replay" });
  expect(r.of("fatal")).toHaveLength(1);
  expect(r.of("initialized")).toHaveLength(0);
  expect(r.of("inbound")).toHaveLength(0);
  expect(readFileSync(r.outboundFile(), "utf8")).toBe(contents);
});

it("journals the entire upsert before a media download can stall", async () => {
  const r = rig(), socket = await linkAndOpen(r);
  r.fake.lib.downloadMediaMessage = () => new Promise(() => {});
  socket.ev.emit("messages.upsert", { type: "notify", messages: [voiceNote({ id: "STALL", chat: SELF_CHAT, fromMe: true }), textMessage({ id: "AFTER", chat: SELF_CHAT, text: "second", fromMe: true })] });
  await tick();
  expect(readFileSync(r.ingressFile(), "utf8")).toContain('"AFTER"');
});

it("revokes queued group chunks before each network send", async () => {
  const r = rig(), socket = await linkAndOpen(r);
  socket.onSend = async () => { await send(r, { kind: "authorize", chatId: GROUP, generation: 1 }); };
  const result = await reserveAndSend(r, GROUP, "x ".repeat(4000));
  expect(socket.sent).toHaveLength(1);
  expect(result).toMatchObject({ ok: false, sentIds: [socket.sent[0].options!.messageId] });
});

it("restored binding metadata without credentials requests relinking", async () => {
  const r = rig(); await r.init({ retainedBinding: true });
  expect(r.states()).toContain("logged-out");
  await send(r, { kind: "link", method: "qr" });
  expect(r.sock()).toBeDefined();
});

it("acknowledges logout only after the remote operation finishes", async () => {
  const r = rig(), socket = await linkAndOpen(r);
  let finish!: () => void;
  socket.logout = () => new Promise(resolve => { finish = resolve; });
  const pending = send(r, { kind: "logout", reqId: "logout" }); await tick();
  expect(r.of("result").some(m => m.reqId === "logout")).toBe(false);
  finish(); await pending;
  expect(r.of("result").find(m => m.reqId === "logout")).toMatchObject({ ok: true });
});

it("applies group and contact access before downloading media", async () => {
  const r = rig(), socket = await linkAndOpen(r, { options: { access: { allowFrom: [], groups: { policy: "allowlist", senders: "members", allow: [{ jid: GROUP, activation: "always" }] } } } });
  const groupVoice = voiceNote({ id: "GROUP-VOICE", chat: GROUP });
  (groupVoice.key as Record<string, unknown>).participant = "15550002222@s.whatsapp.net";
  socket.upsert([groupVoice]); await until(() => r.of("inbound").length === 1);
  expect(r.of("inbound")[0].envelope.media?.path).toBeDefined();
  const other = rig(), contact = await linkAndOpen(other, { mode: "contacts" });
  contact.upsert([voiceNote({ id: "STRANGER", chat: "15550003333@s.whatsapp.net" })]);
  await until(() => other.of("inbound").length === 1);
  expect(other.of("inbound")[0].envelope.media?.path).toBeUndefined();
});

it("replays cached voice content before a socket reconnects", async () => {
  const first = rig(), socket = await linkAndOpen(first);
  socket.upsert([voiceNote({ id: "CACHED", chat: SELF_CHAT, fromMe: true })]);
  await until(() => first.of("inbound").length === 1);
  const path = first.of("inbound")[0].envelope.media!.path;
  await first.bridge.stop();
  const second = rig({ root: first.root }); await second.init();
  expect(second.of("inbound")[0]?.envelope.media?.path).toBe(path);
});

it("qualifies the runtime in dry-run initialization without creating a socket", async () => {
  const r = rig(); r.fake.lib.qualify = async () => ({ baileysVersion: "7.0.0-rc14", jimp: true });
  await r.init({ dryRun: true });
  expect(r.of("ready")[0]).toMatchObject({ baileysVersion: "7.0.0-rc14", jimp: true });
  expect(r.sock()).toBeUndefined();
});

it("counts watchdog restarts with intervening frames toward the retry limit", async () => {
  vi.useFakeTimers();
  const r = rig(); await r.init(); await send(r, { kind: "link", method: "qr" });
  for (let i = 0; i < 13; i++) {
    const old = r.sock(); old.open(); old.frame();
    await until(() => r.of("connection").at(-1)?.state === "connected");
    await vi.advanceTimersByTimeAsync(200_000);
    if (r.states().includes("blocked")) break;
    await vi.advanceTimersByTimeAsync(2_000_000);
    await until(() => r.sock() !== old);
  }
  expect(r.states()).toContain("blocked");
  expect(r.of("connection").some(m => m.blockedReason === "retry-limit")).toBe(true);
});

it("checkpoints catch-up only after the provider finishes replay and every receipt is acknowledged", async () => {
  const r = rig(), socket = await linkAndOpen(r);
  socket.upsert([textMessage({ id: "FIRST", chat: SELF_CHAT, fromMe: true, text: "one" }), textMessage({ id: "SECOND", chat: SELF_CHAT, fromMe: true, text: "two" })], "append");
  await until(() => r.of("inbound").length === 2);
  socket.ev.emit("connection.update", { receivedPendingNotifications: true });
  expect(r.of("status").some(m => m.admittedAtMs !== undefined)).toBe(false);
  await send(r, { kind: "ack", seq: r.of("inbound")[0].seq });
  expect(r.of("status").some(m => m.admittedAtMs !== undefined)).toBe(false);
  await send(r, { kind: "ack", seq: r.of("inbound")[1].seq });
  expect(r.of("status").some(m => m.admittedAtMs !== undefined)).toBe(true);
});

it("persists PN and LID aliases and dedupes their ingress rows across restart", async () => {
  const first = rig(), socket = await linkAndOpen(first, { mode: "contacts" });
  const pn = "15550002222@s.whatsapp.net", lid = "222@lid";
  socket.upsert([textMessage({ id: "DUAL", chat: pn, text: "hello" })]);
  await until(() => first.of("inbound").length === 1);
  await send(first, { kind: "ack", seq: first.of("inbound")[0].seq });
  socket.upsert([textMessage({ id: "DUAL", chat: lid, chatAlt: pn, text: "hello" })]);
  await tick(30); await first.bridge.stop();
  const second = rig({ root: first.root }); await second.init({ mode: "contacts" }); second.sock().open();
  await until(() => second.states().includes("connected"));
  second.sock().upsert([textMessage({ id: "DUAL", chat: lid, text: "hello" })]);
  await tick(30); expect(second.of("inbound")).toHaveLength(0);
});

it("rejects a linked chat directory when caching media", async () => {
  const r = rig(), root = join(r.root, "media", "c1"), outside = join(r.root, "outside");
  mkdirSync(root, { recursive: true }); mkdirSync(outside);
  const media = new MediaStore(root, Date.now), target = media.pathFor(SELF_CHAT, "LINKED", "image/jpeg");
  symlinkSync(outside, join(target, ".."));
  const stream = (async function* () { yield Buffer.from("photo"); })();
  expect(await media.save(SELF_CHAT, "LINKED", "image/jpeg", stream, 100)).toBeNull();
  expect(readdirSync(outside)).toEqual([]);
});

it("recovers an interrupted media download without following a linked ancestor", async () => {
  const r = rig(), root = join(r.root, "media", "c1"), outside = join(r.root, "outside");
  mkdirSync(outside); symlinkSync(outside, join(r.root, "media"));
  const media = new MediaStore(root, Date.now);
  const stream = () => (async function* () { yield Buffer.from("complete"); })();
  expect(await media.save(SELF_CHAT, "RECOVER", "image/jpeg", stream(), 100)).toBeNull();
  expect(readdirSync(outside)).toEqual([]);
  rmSync(join(r.root, "media"));
  const target = media.pathFor(SELF_CHAT, "RECOVER", "image/jpeg");
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(`${target}.part`, "partial");
  expect(await media.save(SELF_CHAT, "RECOVER", "image/jpeg", stream(), 100)).toEqual({ path: target, bytes: 8 });
});
