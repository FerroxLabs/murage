// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Task deltas are negotiated per stream (lane E review, finding 6): a stream
// that asks with `?tasks=delta` gets only the changed task rows, numbered so a
// gap is visible; every other stream (a 1.0.1 desktop, a phone, a companion)
// keeps getting the whole list in every bot frame. Through the real server.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = randomBytes(32).toString("hex");
const HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("task deltas on the event stream", () => {
  let child: ChildProcess | undefined;
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...HEADERS, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };

  function openStream(query: string) {
    const controller = new AbortController();
    const frames: any[] = [];
    const state = { hello: false };
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events${query}`, { headers: HEADERS, signal: controller.signal });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const frame = JSON.parse(line.slice(6));
              if (frame.kind === "hello") state.hello = true;
              else if (frame.kind !== "ping") frames.push(frame);
            }
          }
        }
      } catch { /* aborted */ }
    })();
    return { frames, state, close: () => controller.abort() };
  }

  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-task-delta-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } } },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home,
        MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("sends the changed rows only to a stream that asked, and the whole list to every other", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name: "Delta Otter", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    const legacy = openStream("");
    const negotiated = openStream("?tasks=delta");
    try {
      await expect.poll(() => legacy.state.hello && negotiated.state.hello, { timeout: 10_000 }).toBe(true);
      // the snapshot names the task frame its list is current with
      const snapshot = await api("GET", "/api/bots?messages=1");
      const held = snapshot.body.bots.find((entry: any) => entry.id === bot.id);
      expect(typeof held.tasksSeq).toBe("number");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Say hello" })).status).toBe(202);
      const ofBot = (frames: any[]) => frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot.tasksSeq !== undefined);
      await expect.poll(() => ofBot(negotiated.frames).some((frame) => frame.bot.tasksDelta), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => ofBot(legacy.frames).length >= ofBot(negotiated.frames).length, { timeout: 10_000 }).toBe(true);
      // every legacy frame carries the whole list and no delta
      for (const frame of ofBot(legacy.frames)) {
        expect(Array.isArray(frame.bot.tasks)).toBe(true);
        expect(frame.bot.tasksDelta).toBeUndefined();
      }
      // the negotiated stream's numbers chain: each delta builds on the frame before it
      const numbered = ofBot(negotiated.frames);
      for (let i = 1; i < numbered.length; i++) {
        const frame = numbered[i].bot;
        if (frame.tasksDelta) expect(frame.tasksDelta.base).toBe(numbered[i - 1].bot.tasksSeq);
        expect(frame.tasksSeq).toBe(numbered[i - 1].bot.tasksSeq + 1);
      }
      // the same frame, two forms: same stream sequence number on both streams
      const delta = numbered.find((frame) => frame.bot.tasksDelta);
      const twin = legacy.frames.find((frame) => frame.seq === delta.seq);
      expect(twin?.bot.tasksSeq).toBe(delta.bot.tasksSeq);
      expect(twin?.bot.tasks.length).toBe(delta.bot.tasksDelta.count);
    } finally {
      legacy.close();
      negotiated.close();
    }
  }, 90_000);

  it("sends a page frame in the shape each stream negotiated, and the same frame number to both", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name: "Cards Otter", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Say hello" })).status).toBe(202);
    await expect.poll(async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=10`)).body.messages ?? []).length, { timeout: 30_000 }).toBeGreaterThan(1);
    const legacy = openStream("");
    const beside = openStream("?cards=beside");
    try {
      await expect.poll(() => legacy.state.hello && beside.state.hello, { timeout: 10_000 }).toBe(true);
      // a second task, then back to the first: the switch frame carries the first thread's page
      expect((await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Other" })).status).toBe(201);
      expect((await api("POST", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).status).toBe(200);
      const pageFrames = (frames: any[]) => frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot.threadId === bot.threadId && Array.isArray(frame.bot.messages));
      await expect.poll(() => pageFrames(legacy.frames).length > 0 && pageFrames(beside.frames).length > 0, { timeout: 10_000 }).toBe(true);
      const old = pageFrames(legacy.frames).at(-1);
      const next = pageFrames(beside.frames).at(-1);
      expect(old.seq).toBe(next.seq);
      expect(old.bot.openCardsLeaf).toBeUndefined();
      expect(next.bot.openCardsLeaf).toBe(next.bot.activeLeafId);
      // the same rows; a page without old cards is the same page for both
      expect(old.bot.messages.map((m: any) => m.id)).toEqual(next.bot.messages.map((m: any) => m.id));
      // an HTTP listing is negotiated by header
      const plain = await fetch(`${base}/api/bots?messages=50`, { headers: HEADERS });
      const modern = await fetch(`${base}/api/bots?messages=50`, { headers: { ...HEADERS, "x-murage-cards": "beside" } });
      const ofBot = async (res: Response) => ((await res.json()) as any).bots.find((entry: any) => entry.id === bot.id);
      expect((await ofBot(plain)).openCardsLeaf).toBeUndefined();
      expect((await ofBot(modern)).openCardsLeaf).toBeTruthy();
    } finally {
      legacy.close();
      beside.close();
    }
  }, 90_000);
});
