// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LONGWORK-STALL-60: the no-activity limit for a direct turn is one hour, so a quiet tool may run a long time. The owner's Stop
// must still end that turn while the tool is running and silent. The fake engine starts a tool and never reports it finished or
// answers session/cancel (the harshest quiet tool), and the server runs on its default limit. Same server-spawn pattern as
// typed-stop-api.test.ts. The wait inside the test is seconds, not an hour: Stop is not on the silence clock, so it does not depend
// on how long the tool has been quiet (the clock itself is covered in turn-watchdog.test.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let headers: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const busy = async (botId: string) => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy;
const activityLines = async (threadId: string) =>
  ((await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[])
    .filter((m) => m.kind === "activity").map((m) => String(m.tool?.name ?? ""));
const rpcLog = () => join(home, "quietTool-rpc.log");
const prompts = () => (existsSync(rpcLog()) ? readFileSync(rpcLog(), "utf8").split("\n").filter(Boolean).filter((l) => (JSON.parse(l) as { method: string }).method === "session/prompt").length : 0);

posixOnly("owner Stop during a quiet tool (fake ACP CLI through the server)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-quiet-stop-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        quietTool: {
          driver: "customAcp",
          environment: { FAKE_ACP_RPC_LOG: rpcLog(), FAKE_ACP_MODE: "stall-after-tool", FAKE_ACP_TOOL_NEVER_FINISHES: "1" },
          config: { cli: FAKE_ACP, fullAuto: false },
        },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        MURAGE_PORT: String(port),
        MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
        MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
        MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Stop ends a turn whose tool is running and silent, with no stall line, and the thread takes the next message", async () => {
    const created = await request("POST", "/api/bots", { name: "Quiet tool stop", modelSelection: { instanceId: "quietTool", model: "fake-acp-model" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);

    const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Run the long build" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(prompts, { timeout: 30_000 }).toBe(1).catch((error) => { throw new Error(`${error.message}\nrpc: ${existsSync(rpcLog()) ? readFileSync(rpcLog(), "utf8").slice(-1500) : "none"}\nserver: ${stderr.slice(-3000)}`); });
    // the tool is running and the engine says nothing more: the turn stays busy and nothing has stopped it
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await busy(bot.id)).toBe(true);
    expect((await activityLines(bot.threadId)).some((line) => line.includes("no activity"))).toBe(false);

    const stop = await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    await expect.poll(() => busy(bot.id), { timeout: 30_000 }).toBe(false);
    expect((await activityLines(bot.threadId)).some((line) => line.includes("no activity"))).toBe(false);

    const next = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "And now the next thing" });
    expect(next.status, JSON.stringify(next.body)).toBe(202);
    await expect.poll(prompts, { timeout: 30_000 }).toBe(2);
    await request("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }).catch(() => undefined);
  }, 120_000);
});
