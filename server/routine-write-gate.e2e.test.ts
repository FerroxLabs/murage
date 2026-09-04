import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// Interval schedules turned "write a routine" into "write a spawn schedule":
// `{ type: "interval", everyMinutes: 5 }` starts a provider process every five
// minutes, forever, with no further human act between the write and the
// process. So the three routine write routes take the same desktop gate as
// /api/cli-test and the local-VM lifecycle routes, and answer 404 — never 403,
// which would confirm the route is here — to anything that cannot prove it is
// the renderer.
//
// The proof is a per-launch secret, not the marker: a bare
// `x-murage-surface: desktop` header is something any local process can type,
// and this file asserts that it is not enough.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_SECRET = "0123456789abcdef".repeat(4);
const DESKTOP_HEADERS = {
  "x-murage-surface": "desktop",
  "x-murage-surface-secret": DESKTOP_SECRET,
} as const;

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const desktop = (method: string, path: string, body?: unknown) =>
  api(method, path, body, { ...DESKTOP_HEADERS });

/** Every way in that is not a proven desktop: an unmarked local caller, a
 * caller that types the marker without the secret, and a paired phone. */
const REMOTE_SURFACES: Array<[string, Record<string, string>]> = [
  ["unmarked", {}],
  ["marker without the secret", { "x-murage-surface": "desktop" }],
  ["companion", { "x-murage-companion": "1" }],
];

const intervalRoutine = (name: string, botId: string) => ({
  name,
  prompt: "Check the build queue",
  botId,
  schedule: { type: "interval" as const, everyMinutes: 5, anchorAt: Date.now() + 60_000 },
  enabled: true,
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "murage-routine-gate-"));
  const data = join(home, ".murage");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Routine gate test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      quiet: {
        driver: "claudeAgent",
        displayName: "Quiet fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_STATIC_DIR: staticDir,
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("routine write routes are desktop-only", () => {
  it("lets the desktop create, update and delete an interval routine", async () => {
    const bot = (await desktop("POST", "/api/bots")).body.bot;
    const created = await desktop("POST", "/api/routines", intervalRoutine("Desktop interval", bot.id));
    expect(created.status).toBe(201);
    expect(created.body.routine.schedule).toMatchObject({ type: "interval", everyMinutes: 5 });

    const patched = await desktop("PATCH", `/api/routines/${created.body.routine.id}`, {
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.routine.schedule.everyMinutes).toBe(15);

    expect((await desktop("DELETE", `/api/routines/${created.body.routine.id}`)).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses POST from a %s surface", async (_label, headers) => {
    const bot = (await desktop("POST", "/api/bots")).body.bot;
    const before = (await desktop("GET", "/api/routines")).body.routines.length;

    const blocked = await api("POST", "/api/routines", intervalRoutine("Smuggled interval", bot.id), headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });
    // the refusal is real, not cosmetic: nothing was stored
    expect((await desktop("GET", "/api/routines")).body.routines).toHaveLength(before);
  });

  it.each(REMOTE_SURFACES)("refuses PATCH from a %s surface", async (_label, headers) => {
    const bot = (await desktop("POST", "/api/bots")).body.bot;
    const routine = (await desktop("POST", "/api/routines", intervalRoutine("Patch target", bot.id))).body.routine;

    const blocked = await api("PATCH", `/api/routines/${routine.id}`, {
      schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() + 60_000 },
    }, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });

    const current = (await desktop("GET", "/api/routines")).body.routines
      .find((candidate: { id: string }) => candidate.id === routine.id);
    expect(current.schedule).toEqual(routine.schedule);
    expect((await desktop("DELETE", `/api/routines/${routine.id}`)).status).toBe(200);
  });

  it.each(REMOTE_SURFACES)("refuses DELETE from a %s surface", async (_label, headers) => {
    const bot = (await desktop("POST", "/api/bots")).body.bot;
    const routine = (await desktop("POST", "/api/routines", intervalRoutine("Delete target", bot.id))).body.routine;

    const blocked = await api("DELETE", `/api/routines/${routine.id}`, undefined, headers);
    expect(blocked.status).toBe(404);
    expect(blocked.body).toEqual({ error: "no such route" });

    expect((await desktop("GET", "/api/routines")).body.routines
      .some((candidate: { id: string }) => candidate.id === routine.id)).toBe(true);
    expect((await desktop("DELETE", `/api/routines/${routine.id}`)).status).toBe(200);
  });

  it("still lets a remote surface read the calendar", async () => {
    // The gate is on writing a spawn schedule, not on seeing one. A phone
    // that could not read its own routines would be a different product.
    const listed = await api("GET", "/api/routines", undefined, { "x-murage-companion": "1" });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.routines)).toBe(true);
  });
});
