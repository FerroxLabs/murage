// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The OS ending the session (Windows logoff, restart or shutdown) may end the harness with no signal and no time for a graceful close.
// The desktop asks it first to write what it holds (electron/session-end.mjs, "murage:flush"): a roster save still inside its 250 ms
// coalescing window reaches bots.json at once, the harness answers "murage:flushed" and keeps serving. Here the process is then killed
// outright (SIGKILL, as Windows ends it) inside that window, over both channels the desktop uses: the packaged app's private parent port
// and a plain IPC parent.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_SECRET = "f1f1f1f1f1f1f1f1".repeat(4);
/** The app's shape: Electron's private parent port, one listener, fed from the IPC channel (engine-change-and-close.test.ts). */
const PARENT_PORT_PRELUDE = `data:text/javascript,${encodeURIComponent(`
  let listener;
  process.on("message", (data) => listener?.({ data }));
  Object.defineProperty(process, "parentPort", { value: {
    on(event, callback) { if (event === "message") listener = callback; },
    postMessage(message) { process.send?.(message); },
  } });
`)}`;

let child: ChildProcess | undefined;
let home = "";
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGKILL" });
  child = undefined;
  if (home) await removeTempDir(home);
  home = "";
});

async function serve(packaged: boolean) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "murage-session-end-"));
  mkdirSync(join(home, ".murage"), { recursive: true });
  let stderr = "";
  const replies: Array<{ type?: string; ok?: boolean; secret?: string }> = [];
  child = spawn(process.execPath, [...(packaged ? ["--import", PARENT_PORT_PRELUDE] : []), join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr!.on("data", chunk => (stderr += chunk));
  child.stdout!.on("data", () => undefined);
  child.on("message", message => replies.push(message as (typeof replies)[number]));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr.slice(-4000)}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr.slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const secret = () => replies.find(reply => reply.type === "murage:desktop-secret")?.secret ?? DESKTOP_SECRET;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() as any };
  };
  return { api, replies, stderr: () => stderr };
}

const savedThread = (botId: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as Array<{ id: string; threadId: string }>).find(bot => bot.id === botId)?.threadId;

for (const packaged of [true, false]) {
  it(`a session-end flush writes a deferred roster save before the OS ends the harness (${packaged ? "packaged parent port" : "plain IPC parent"})`, async () => {
    const { api, replies, stderr } = await serve(packaged);
    const created = await api("POST", "/api/bots", { name: "Flush" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    const task = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "second" });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    const onDisk = savedThread(bot.id);
    const target = onDisk === bot.threadId ? task.body.task.threadId as string : bot.threadId;
    // Opening a task is a deferred (coalesced) roster write: it reaches bots.json up to 250 ms later.
    const switched = await api("POST", `/api/bots/${bot.id}/tasks/${target}?messages=0`);
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    const asked = replies.length;
    // the desktop's request names the answer file its bounded wait looks for (electron/session-end.mjs)
    const ack = join(home, `murage-flush-1-${randomUUID()}-0`);
    child!.send({ type: "murage:flush", ack });
    await expect.poll(() => existsSync(ack), { timeout: 5_000 }).toBe(true);
    // the OS ends the process as soon as the desktop's callback returns: no handler runs
    await waitForExit(child!, { signal: "SIGKILL" });
    expect(readFileSync(ack, "utf8")).toBe("1");
    expect(replies.slice(asked).filter(reply => reply.type === "murage:flushed"), stderr().slice(-2000)).toEqual([{ type: "murage:flushed", ok: true }]);
    expect(savedThread(bot.id)).toBe(target);
  }, 60_000);
}

it("the harness keeps serving after a flush, and writes no answer file whose name is not the desktop's", async () => {
  const { api, replies } = await serve(true);
  const stray = join(home, "bots.json.flushed");
  child!.send({ type: "murage:flush", ack: stray });
  await expect.poll(() => replies.some(reply => reply.type === "murage:flushed"), { timeout: 5_000 }).toBe(true);
  expect(existsSync(stray)).toBe(false);
  expect((await api("POST", "/api/bots", { name: "After" })).status).toBe(201);
  expect(child!.exitCode).toBeNull();
}, 60_000);
