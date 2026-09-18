// Fuigo's refusal of an image the conversation never bound, through the real
// server. `unboundImagePolicy` keeps Fuigo on "refuse": an
// `<attached-image path>` that is one of Murage's own uploads but was never
// bound to this thread (a legacy upload made without a thread, or a tag
// carried in from another thread) loses the turn with a "reattach it"
// message, rather than the bot quietly not seeing a picture the person
// plainly attached. Every other inline engine carries such a tag as a path
// instead (server/index.test.ts pins that half on the fake Claude).
//
// The positive control runs first on the same bot: a bound upload reaches
// the fake Fuigo as an inline image part, so a refusal afterwards is the
// policy and not a fixture that could never have run.
//
// Same server-spawn pattern as folder-trust-api.test.ts.
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
const REFUSAL = "This image is unavailable for this conversation. Reattach the image and send again.";
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
/** The turn's failure line, as the thread records it. */
const refusals = async (threadId: string) => (await messages(threadId))
  .filter((m) => m.kind === "activity" && m.tool?.ok === false && String(m.tool?.name ?? "").includes(REFUSAL));
const promptRequests = () => (existsSync(rpcDump) ? (JSON.parse(readFileSync(rpcDump, "utf8")) as string[]) : [])
  .filter((method) => method === "session/prompt").length;

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

posixOnly("Fuigo refuses an unbound attached image (fake ACP CLI through the harness)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-fuigo-unbound-image-"));
    promptDump = join(home, "fake-acp-prompt.json");
    rpcDump = join(home, "fake-acp-rpc.json");
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("inlines a bound image, then refuses the turn for an unbound one and never reaches the engine", async () => {
    const created = await request("POST", "/api/bots", { name: "Fuigo image fixture", modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);

    // Positive control: an upload bound to this thread reaches the fake Fuigo
    // as an inline image part beside the tagged text.
    const boundPath = await upload(bot.threadId);
    const first = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `And this?\n\n<attached-image path="${boundPath}" />` });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    await settled(bot.id);
    expect(promptRequests()).toBe(1);
    const prompt = JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(prompt.some((block) => block.type === "text" && block.text?.includes(`<attached-image path="${boundPath}" />`))).toBe(true);
    expect(prompt).toContainEqual(expect.objectContaining({ type: "image", mimeType: "image/png", data: PNG.toString("base64") }));
    expect(await refusals(bot.threadId)).toEqual([]);

    // An upload made without a thread is one of Murage's own files, but this
    // conversation never bound it. Fuigo loses the turn over it.
    const unboundPath = await upload();
    rmSync(promptDump, { force: true });
    const second = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `What is this?\n\n<attached-image path="${unboundPath}" />` });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    await expect.poll(async () => (await refusals(bot.threadId)).length, { timeout: 30_000 }).toBe(1);
    await settled(bot.id);
    // The refused turn never reached the engine: no second prompt, no bytes.
    expect(promptRequests()).toBe(1);
    expect(existsSync(promptDump)).toBe(false);
    // The user message recorded the truth: nothing bound.
    const recorded = (await messages(bot.threadId)).find((m) => m.role === "user" && String(m.text ?? "").includes(unboundPath));
    expect(recorded?.attachments ?? []).toEqual([]);
  }, 60_000);
});
