// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G11 through the real server: a Flux turn on an engine-managed model that
// cannot see (deepseek-v4-pro, text only in every listing) used to receive
// the picture anyway and end in the provider's 400. The picture is now left
// out, the conversation says so in one plain note naming the bot, and the
// turn goes on to its reply. A sighted model on the same engine still gets
// the bytes (positive control, first).
//
// Same server-spawn pattern as fuigo-unbound-image-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let desktopHeaders: Record<string, string>;
let child: ChildProcess;
let home: string;
let promptDump: string;
let rpcDump: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...desktopHeaders, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const upload = async (threadId?: string) => {
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
  const res = await fetch(`${base}/api/attachments${query}`, { method: "POST", headers: { ...desktopHeaders, "content-type": "image/png" }, body: PNG });
  expect(res.status).toBe(201);
  return ((await res.json()) as { path: string }).path;
};
const settled = async (botId: string) => {
  await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy, { timeout: 30_000 }).toBe(false);
};

async function bootServer(homeDir: string, port: number): Promise<{ child: ChildProcess; desktop: Record<string, string> }> {
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(join(homeDir, ".murage"), { recursive: true });
  mkdirSync(join(homeDir, ".fuigo"), { recursive: true });
  writeFileSync(join(homeDir, ".fuigo", "auth.json"), "{}");
  writeFileSync(
    join(homeDir, ".murage", "config.json"),
    JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigo: {
          driver: "fuigoAgent",
          environment: { FAKE_ACP_PROMPT_DUMP: promptDump, FAKE_ACP_RPC_DUMP: rpcDump },
          config: { cli: FAKE_ACP, fullAuto: false },
        },
      },
    }),
  );
  const proc = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: homeDir,
      USERPROFILE: homeDir,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1",
      MURAGE_MODEL_PROVIDER_CONNECTIONS: "",
      MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (c) => (stderr += c));
  proc.stdout!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const proof = (await fetch(`${url}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
  return { child: proc, desktop: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}

posixOnly("a model that cannot see gets a note, not the picture (fake ACP CLI through the harness)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-images-left-out-"));
    promptDump = join(home, "fake-acp-prompt.json");
    rpcDump = join(home, "fake-acp-rpc.json");
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  const imageParts = () => (JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ type: string }>).filter((block) => block.type === "image").length;
  const notes = async (threadId: string) => (await messages(threadId)).filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("images left out:"));

  it("sends a sighted model the picture, and leaves it out with a note for deepseek-v4-pro", async () => {
    const make = async (name: string, model: string) => {
      const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "fuigo", model } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
      return bot;
    };
    const sighted = await make("Sighted", "claude-opus-5");
    const path = await upload(sighted.threadId);
    expect((await request("POST", `/api/bots/${sighted.id}/messages`, { threadId: sighted.threadId, text: `And this?\n\n<attached-image path="${path}" />` })).status).toBe(202);
    await settled(sighted.id);
    expect(imageParts()).toBe(1);
    expect(await notes(sighted.threadId)).toEqual([]);

    const dax = await make("Dax", "deepseek-v4-pro");
    rmSync(promptDump, { force: true });
    const second = await upload(dax.threadId);
    expect((await request("POST", `/api/bots/${dax.id}/messages`, { threadId: dax.threadId, text: `What is this?\n\n<attached-image path="${second}" />` })).status).toBe(202);
    await settled(dax.id);
    // The turn ran, without the bytes, and ended in a reply rather than an error.
    expect(existsSync(promptDump)).toBe(true);
    expect(imageParts()).toBe(0);
    const thread = await messages(dax.threadId);
    expect(await notes(dax.threadId)).toEqual([expect.objectContaining({ role: "bot", tool: expect.objectContaining({ name: "images left out: 1", ok: true }) })]);
    expect(thread.filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith("error:"))).toEqual([]);
    expect(thread.some((m) => m.role === "bot" && m.kind === "text" && String(m.text ?? "").trim())).toBe(true);
  }, 60_000);
});
