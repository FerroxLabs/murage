// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2248 (Apache-2.0).
//
// A scheduled run's task, as an event stream sees it, through the real server.
// The frame announcing the run's task used to carry the bot's whole active
// transcript; past a phone stream's frame ceiling that ended the stream and the
// resume cursor replayed the same frame on every reconnect.
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

posixOnly("a routine run's task on the event stream", () => {
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

  function openStream() {
    const controller = new AbortController();
    const frames: any[] = [];
    const state = { hello: false };
    void (async () => {
      try {
        const res = await fetch(`${base}/api/events`, { headers: HEADERS, signal: controller.signal });
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
    home = mkdtempSync(join(tmpdir(), "murage-routine-broadcast-"));
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

  it("announces the run's task without the bot's transcript", async () => {
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name: "Report Otter", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    // Something in the active conversation for a frame to have carried.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Summarise the week" })).status).toBe(202);
    await expect.poll(async () => {
      const { body } = await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`);
      return (body.messages ?? []).some((m: any) => m.role === "bot" && m.text);
    }, { timeout: 30_000 }).toBe(true);

    const routine = await api("POST", "/api/routines", {
      name: "Hourly report", botId: bot.id, prompt: "Write the report.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 },
    });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);

    const stream = openStream();
    try {
      await expect.poll(() => stream.state.hello, { timeout: 10_000 }).toBe(true);
      expect((await api("POST", `/api/routines/${routine.body.routine.id}/run`)).status).toBeLessThan(300);
      await expect.poll(() => stream.frames.some((frame) =>
        frame.kind === "routine.run" && ["completed", "failed"].includes(frame.run?.status)), { timeout: 30_000 }).toBe(true);
      const botFrames = stream.frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === bot.id);
      // The frame that announced the run's task (the task list grew) has no transcript.
      const announced = botFrames.find((frame) => (frame.bot.tasks ?? []).length > 1);
      expect(announced).toBeDefined();
      expect("messages" in announced.bot).toBe(false);
    } finally {
      stream.close();
    }
  }, 90_000);
});
