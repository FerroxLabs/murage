// 1.0.10 C3 end to end on an ACP engine: a permission card open while the
// server is frozen (SIGSTOP stands in for a sleeping laptop: the process runs
// nothing while the wall clock moves on) is still open after the wake. Since
// fix/1010-grok-stopped a permission card has no deny deadline, so it also stays
// open well past the old (env-shortened) deadline after the wake.
//
// HEADLESS ONLY: a throwaway temp HOME, a probed port, the fake ACP CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const OLD_DENY_MS = 4_000;
const FROZEN_MS = 8_000;

let base: string;
let headers: Record<string, string> = {};
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const cardFor = async (threadId: string) =>
  ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []).find((m: any) => m.kind === "options" && m.card?.requestId) ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

describe.skipIf(process.platform === "win32")("C3: an ACP permission card across a frozen server", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1], 19_299, 200);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-sleep-card-"));
    expect(home.startsWith(tmpdir())).toBe(true);
    writeFileSync(join(home, "fake-engine-setup.mjs"), "globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;\n");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      instances: { asker: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "printf 'tick' >> notes/log.md" }, config: { cli: FAKE_CLI, fullAuto: false } } },
    }));
    child = spawn(process.execPath, ["--import", pathToFileURL(join(home, "fake-engine-setup.mjs")).href, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, NODE_ENV: "test",
        MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_PERMISSION_DENY_MS: String(OLD_DENY_MS), // the old deny override: a card must ignore it now
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await sleep(150);
    }
    const proof = await request("GET", "/api/desktop-secret");
    expect(proof.status).toBe(200);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  }, 60_000);

  afterAll(async () => {
    if (child?.pid && child.exitCode === null) { try { process.kill(child.pid, "SIGCONT"); } catch { /* gone */ } }
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("is still open after the wake and stays open: a permission card has no deadline", async () => {
    const created = await request("POST", "/api/bots", { name: "Sleeper", modelSelection: { instanceId: "asker", model: "fake-model" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    expect((await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "log the time" })).status).toBe(202);
    const card = await poll(() => cardFor(bot.threadId), 20_000);
    expect(card, `no card. stderr: ${stderr.slice(-1500)}`).not.toBeNull();
    const openedAt = Date.now();
    // the laptop lid closes: the server process runs nothing for longer than the deadline
    process.kill(child.pid!, "SIGSTOP");
    await sleep(FROZEN_MS);
    process.kill(child.pid!, "SIGCONT");
    await sleep(1_000);
    const still = await cardFor(bot.threadId);
    expect(still.card.answered, "the card was denied at the wake").toBeUndefined();
    // well past the old deny deadline after the wake: still waiting for the owner
    await sleep(OLD_DENY_MS + 2_000);
    const later = await cardFor(bot.threadId);
    expect(later.card.answered, "the card was denied after the wake").toBeUndefined();
    expect(Date.now() - openedAt).toBeGreaterThanOrEqual(FROZEN_MS + OLD_DENY_MS);
  }, 90_000);
});
