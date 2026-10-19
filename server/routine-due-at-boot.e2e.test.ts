// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A routine already due when the server starts, through the real server.
// Rehearsal 2 (1.0.3): the scheduler started halfway down server/index.ts, so a
// run due at boot dispatched while the module was still being evaluated, read
// routine state the module had not created yet, threw, and kept its thread's
// slot: every later run on that thread stayed queued until a restart.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = randomBytes(32).toString("hex");
const HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET } as const;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a routine due when the server starts", () => {
  let child: ChildProcess | undefined;
  let home = "";
  let base = "";
  let port = 0;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...HEADERS, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };

  async function boot(): Promise<void> {
    stderr = "";
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
    child.stdout!.on("data", () => {});
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async function shutdown(): Promise<void> {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
  }

  const runsOf = async (routineId: string) =>
    ((await api("GET", "/api/routines")).body.runs ?? []).filter((run: any) => run.routineId === routineId);

  afterAll(async () => {
    await shutdown();
    if (home) await removeTempDir(home);
  });

  it("runs the due routine and leaves its thread free for the next run", async () => {
    port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-routine-due-at-boot-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } } },
    }));

    // First start: a bot and a one-time routine due a few seconds from now; the server stops before it is due.
    await boot();
    const modelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
    const created = await api("POST", "/api/bots", { name: "Morning Otter", modelSelection, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection, computer: "off" })).status).toBe(200);
    const dueAt = Date.now() + 5_000;
    const routine = await api("POST", "/api/routines", {
      name: "Morning brief", botId: bot.id, prompt: "Write the morning brief.", enabled: true,
      schedule: { type: "once", at: dueAt },
    });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    const routineId = routine.body.routine.id as string;
    await shutdown();

    // Second start, with the routine already due: its run happens and finishes.
    while (Date.now() < dueAt + 1_000) await new Promise((resolve) => setTimeout(resolve, 250));
    await boot();
    await expect.poll(async () => (await runsOf(routineId)).map((run: any) => run.status), { timeout: 60_000, interval: 500 })
      .toContain("completed");
    const [first] = (await runsOf(routineId)).filter((run: any) => run.status === "completed");
    expect(stderr).not.toMatch(/Cannot read properties of undefined|before initialization/);

    // The thread the run used is free: no run holds it, and a second run of the same routine goes through.
    const task = ((await api("GET", `/api/bots/${bot.id}`)).body.bot?.tasks ?? []).find((t: any) => t.threadId === first.threadId);
    expect(task?.busy ?? false).toBe(false);
    expect((await api("POST", `/api/routines/${routineId}/run`)).status).toBeLessThan(300);
    await expect.poll(async () => (await runsOf(routineId)).filter((run: any) => run.status === "completed").length, { timeout: 60_000, interval: 500 })
      .toBe(2);
  }, 180_000);
});
