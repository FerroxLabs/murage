import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let dataDir: string;
let base: string;
let port: number;
const secret = "1234abcd".repeat(8);
const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const streams: SseRecorder[] = [];
const sockets: Socket[] = [];
let stderrTail = "";
const testBots: Array<{ id: string; threadId: string }> = [];

function closeConnections() {
  for (const recorder of streams.splice(0)) recorder.close();
  for (const socket of sockets.splice(0)) socket.destroy();
}

async function failureDiagnostics() {
  // Never print environment, credentials, message contents or raw stderr.
  const read = async (path: string): Promise<Record<string, any>> => {
    try {
      const response = await fetch(`${base}${path}`, { headers: desktop, signal: AbortSignal.timeout(2000) });
      return response.ok ? await response.json() as Record<string, any> : { httpStatus: response.status };
    } catch { return { unavailable: true }; }
  };
  const health = await read("/api/health");
  const list = await read("/api/bots?messages=0");
  const bots = await Promise.all(testBots.slice(-4).map(async (bot) => {
    const current = list.bots?.find((entry: { id: string }) => entry.id === bot.id);
    const messages = await read(`/api/threads/${bot.threadId}/messages`);
    return {
      id: bot.id, busy: current?.busy,
      messages: messages.messages?.slice(-8).map((message: { text?: string; role?: string }) => ({
        role: ["user", "assistant", "system"].includes(message.role ?? "") ? message.role : "other",
        textLength: typeof message.text === "string" ? message.text.length : 0,
      })),
    };
  }));
  return {
    childExitCode: child?.exitCode, childSignal: child?.signalCode,
    stderrTailBytes: Buffer.byteLength(stderrTail),
    stderrCodes: [...new Set(stderrTail.match(/\b(?:MEMORY_[A-Z_]+|EACCES|ENOENT|EPIPE|ECONNRESET|ERR_[A-Z_]+)\b/g) ?? [])],
    metrics: health.eventStreams, bots,
    streams: streams.map((recorder) => ({ frames: recorder.frames.length })),
  };
}

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...desktop, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  if (method === "POST" && path === "/api/bots" && data.bot) {
    testBots.push({ id: data.bot.id, threadId: data.bot.threadId });
  }
  return data;
}
const metrics = async () => (await api("GET", "/api/health")).eventStreams;
const stream = async (query = "") => {
  const recorder = await openSse(`${base}/api/events${query}`, desktop);
  streams.push(recorder);
  return recorder;
};

describe.skipIf(process.platform === "win32")("bounded SSE at the actual TCP boundary", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "murage-sse-pressure-"));
    mkdirSync(join(dataDir, ".murage"));
    const largeCli = join(dataDir, "large-reply.mjs");
    const fake = join(root, "server/testing/fake-claude-cli.ts");
    // Reuse the actual fixture CLI; construct the large response inside its
    // process so no operating-system argv/environment size limit is involved.
    writeFileSync(largeCli, `#!${process.execPath}\nprocess.env.FAKE_CLAUDE_REPLIES = JSON.stringify(['large-terminal:' + 'x'.repeat(2500000)]);\nawait import(${JSON.stringify(pathToFileURL(fake).href)});\n`, { mode: 0o755 });
    writeFileSync(join(dataDir, ".murage/config.json"), JSON.stringify({ instances: {
      pressureFixture: { driver: "claudeAgent", config: { cli: fake } },
      largeFixture: { driver: "claudeAgent", config: { cli: largeCli } },
    } }));
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(root, "server/index.ts")], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: dataDir, USERPROFILE: dataDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: secret, MURAGE_SSE_HEARTBEAT_MS: "100" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-4000); });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`fixture exited: ${stderrTail}`);
      if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) break;
      if (Date.now() > deadline) throw new Error(`fixture did not start: ${stderrTail}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  beforeEach(() => { testBots.length = 0; stderrTail = ""; });

  afterEach(async (context) => {
    try {
      if (context.task.result?.state === "fail") {
        console.error("SSE fixture failure metadata:", JSON.stringify(await failureDiagnostics()));
      }
    } finally {
      closeConnections();
      // Abort propagation is asynchronous; settle it before the next admission test.
      await expect.poll(async () => (await metrics()).clients).toBe(0);
    }
  });

  afterAll(async () => {
    closeConnections();
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
  });

  it("disconnects a real stalled TCP reader while a healthy reader receives every durable mutation", async () => {
    const { bot } = await api("POST", "/api/bots", { name: "Pressure fixture", modelSelection: { instanceId: "pressureFixture", model: "fixture" } });
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "pressure:" + "x".repeat(850_000) });
    await expect.poll(async () => {
      const list = await api("GET", "/api/bots?messages=0");
      return list.bots.find((entry: { id: string }) => entry.id === bot.id)?.busy === false;
    }, { timeout: 10_000 }).toBe(true);
    const messageId = sent.message.id;
    const healthy = await stream();
    const hello = await healthy.until((frame) => frame.kind === "hello");
    const slow = connect({ host: "127.0.0.1", port });
    sockets.push(slow);
    slow.on("error", () => {});
    await new Promise<void>((resolve, reject) => { slow.once("connect", resolve); slow.once("error", reject); });
    slow.write(`GET /api/events?surface=desktop&surfaceSecret=${secret} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
    // Do not attach a data listener or resume this socket: its receive window
    // fills for real, unlike a mocked response.write(false).
    await expect.poll(async () => (await metrics()).clients).toBe(2);
    const before = await metrics();
    let mutations = 0;
    for (; mutations < 40; mutations++) {
      await api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`, { emoji: "👍" });
      await healthy.until((frame) => frame.kind === "message.patch" && frame.message?.id === messageId && frame.seq > Number(hello.cursor.split(":")[1]) && healthy.frames.filter((candidate) => candidate.kind === "message.patch" && candidate.message?.id === messageId).length >= mutations + 1);
      if ((await metrics()).backpressureDisconnects > before.backpressureDisconnects) { mutations++; break; }
    }
    const after = await metrics();
    expect(after.backpressureDisconnects).toBeGreaterThan(before.backpressureDisconnects);
    expect(after.clients).toBe(1);
    expect(after.pendingBytes).toBeLessThanOrEqual(after.limits.pendingBytes);
    expect(after.peakClientPendingBytes).toBeLessThanOrEqual(after.limits.pendingBytes);
    expect(after.peakPendingBytes).toBeLessThanOrEqual(after.limits.pendingBytes * after.limits.clients);
    expect(after.replayBytes).toBeLessThanOrEqual(after.limits.replayBytes);
    expect(after.replayEntries).toBeLessThanOrEqual(after.limits.replayEntries);
    expect(healthy.frames.filter((frame) => frame.kind === "message.patch" && frame.message?.id === messageId)).toHaveLength(mutations);
    slow.resume();
    await expect.poll(() => slow.destroyed).toBe(true);
    await api("PATCH", `/api/bots/${bot.id}`, { name: "Healthy after pressure" });
    await healthy.until((frame) => frame.kind === "bot" && frame.bot?.name === "Healthy after pressure");
    const recovered = await stream(`?since=${encodeURIComponent(hello.cursor)}`);
    expect((await recovered.until((frame) => frame.kind === "hello")).resumed).toBe(false);
    const evidence = { mutations, frameTextBytes: 850_009, before, after };
    if (process.env.MURAGE_SSE_EVIDENCE_DIR) {
      writeFileSync(join(process.env.MURAGE_SSE_EVIDENCE_DIR, `slow-reader-${process.pid}-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
    }
    healthy.close();
    recovered.close();
    slow.destroy();
    await expect.poll(async () => (await metrics()).clients).toBe(0);
  }, 60_000);

  it("recovers past an oversized terminal message without a reconnect replay loop", async () => {
    const { bot } = await api("POST", "/api/bots", { name: "Large terminal fixture", modelSelection: { instanceId: "largeFixture", model: "fixture" } });
    const first = await stream();
    const start = await first.until((frame) => frame.kind === "hello");
    const before = await metrics();
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "produce a large terminal message" });
    await expect.poll(async () => (await metrics()).oversizedDisconnects, { timeout: 10_000 }).toBeGreaterThan(before.oversizedDisconnects);
    await expect.poll(async () => {
      const list = await api("GET", "/api/bots?messages=0");
      return list.bots.find((entry: { id: string }) => entry.id === bot.id)?.busy === false;
    }, { timeout: 10_000 }).toBe(true);
    const second = await stream(`?since=${encodeURIComponent(start.cursor)}`);
    const snapshot = await second.until((frame) => frame.kind === "hello");
    expect(snapshot.resumed).toBe(false);
    const messages = await api("GET", `/api/threads/${bot.threadId}/messages`);
    const terminal = messages.messages.find((message: { text?: string }) => message.text?.startsWith("large-terminal:"));
    expect(terminal?.text.length).toBe("large-terminal:".length + 2_500_000);
    expect(terminal.text.slice(-100)).toBe("x".repeat(100));
    second.close();
    const third = await stream(`?since=${encodeURIComponent(snapshot.cursor)}`);
    expect((await third.until((frame) => frame.kind === "hello")).resumed).toBe(true);
    await third.until((frame) => frame.kind === "ping");
    first.close();
    third.close();
    await expect.poll(async () => (await metrics()).clients).toBe(0);
  }, 30_000);

  it("bounds client admission and releases a slot after disconnect", async () => {
    const limit = (await metrics()).limits.clients;
    const connected: SseRecorder[] = [];
    for (let index = 0; index < limit; index++) {
      const recorder = await stream();
      await recorder.until((frame) => frame.kind === "hello");
      connected.push(recorder);
    }
    const refused = await fetch(`${base}/api/events`, { headers: desktop });
    expect(refused.status).toBe(503);
    await refused.json();
    expect((await metrics()).clients).toBe(limit);
    const witness = await api("POST", "/api/bots", { name: "Capacity witness", modelSelection: { instanceId: "pressureFixture", model: "fixture" } });
    await connected.at(-1)!.until((frame) => frame.kind === "bot" && frame.bot?.id === witness.bot.id);
    connected[0].close();
    await expect.poll(async () => (await metrics()).clients).toBe(limit - 1);
    const replacement = await stream();
    await replacement.until((frame) => frame.kind === "hello");
    await connected.at(-1)!.until((frame) => frame.kind === "ping");
    for (const recorder of connected) recorder.close();
    replacement.close();
    await expect.poll(async () => (await metrics()).clients).toBe(0);
  });
});
