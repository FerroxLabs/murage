// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L5B real-engine rows: the routine sheet's Run now, through the real
// server, on the Fuigo engine (ACP fake) first and then on Claude (CLI fake).
// The routine is saved the way the sheet's editor saves one (runOn "ember", so
// it runs on its bot's own engine), then POST /run must finish the run.
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
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const DESKTOP_SECRET = randomBytes(32).toString("hex");
const HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("routine sheet Run now on each engine", () => {
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
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-l5b-run-now-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    // Fuigo turns need a sign-in before the engine spawns; seed it the way the other Fuigo suites do.
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: {
        fuigo: { driver: "fuigoAgent", environment: { FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_ACP, fullAuto: false } },
        claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
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

  const MODELS: Record<string, string> = { fuigo: "fake-acp-model", claude: "claude-sonnet-5" };

  for (const instanceId of ["fuigo", "claude"]) {
    it(`${instanceId}: Run now finishes the run on the bot's own engine`, async () => {
      const modelSelection = { instanceId, model: MODELS[instanceId] };
      const created = await api("POST", "/api/bots", { name: `Brief ${instanceId}`, modelSelection });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const bot = created.body.bot as { id: string };
      expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);

      const routine = await api("POST", "/api/routines", {
        name: "Send me a brief", prompt: "Send me a brief", botId: bot.id, runOn: "ember", enabled: true,
        schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, attachments: [],
      });
      expect(routine.status, JSON.stringify(routine.body)).toBe(201);

      const stream = openStream();
      try {
        await expect.poll(() => stream.state.hello, { timeout: 10_000 }).toBe(true);
        const ran = await api("POST", `/api/routines/${routine.body.routine.id}/run`);
        expect(ran.status, JSON.stringify(ran.body)).toBeLessThan(300);
        const finished = () => stream.frames.find((frame) =>
          frame.kind === "routine.run" && frame.run?.routineId === routine.body.routine.id && ["completed", "failed"].includes(frame.run?.status))?.run;
        await expect.poll(() => finished()?.status, { timeout: 45_000 }).toBeDefined();
        expect(finished()?.status, JSON.stringify(finished())).toBe("completed");
      } finally {
        stream.close();
      }
    }, 90_000);
  }
});
