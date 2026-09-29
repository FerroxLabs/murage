// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An image limit never fails a turn (0.1.61). Sean's Sable turn died on
// "Attach at most four images per turn." and Retry sent the same text into
// the same wall. Through the real server and the fake Fuigo (the engine with
// the strictest image rule, unboundImagePolicy "refuse"):
//  - twelve attached images: the first ten reach the engine as image parts,
//    in order; the other two are left out of the text it reads; the owner
//    gets one quiet line; no error.
//  - images sent while the bot is busy wait in the queue, and the drained
//    turn still shows them: the queue binds them as they land, so Fuigo's
//    refusal of an unbound image does not fire on the owner's own upload.
//
// Same server-spawn pattern as fuigo-unbound-image-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { IMAGES_NOT_SENT_PREFIX, imagesNotSentActivityName } from "../shared/turn-image-note.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const REFUSAL = "This image is unavailable for this conversation. Reattach the image and send again.";
const BASE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
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
/** A distinct PNG per upload: the fixture's 1x1 picture with a trailing byte. */
const pngNumber = (index: number) => Buffer.concat([BASE_PNG, Buffer.from([index])]);
let uploads = 0;
let gateFile: string;
const upload = async (threadId?: string) => {
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
  const res = await fetch(`${base}/api/attachments${query}`, { method: "POST", headers: { ...desktopHeaders, "content-type": "image/png" }, body: pngNumber(uploads++) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { path: string }).path;
};
const settled = async (botId: string) => {
  await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy, { timeout: 30_000 }).toBe(false);
};
/** The turn's failure line, as the thread records it. */
const failures = async (threadId: string) => (await messages(threadId))
  .filter((m) => m.kind === "activity" && (m.tool?.ok === false || String(m.tool?.name ?? "").startsWith("error:")));
const notes = async (threadId: string) => (await messages(threadId))
  .filter((m) => m.kind === "activity" && String(m.tool?.name ?? "").startsWith(IMAGES_NOT_SENT_PREFIX));
/** Replies of the echo-gated fake engine: one per turn that reached it. */
const echoes = async (threadId: string) => (await messages(threadId)).filter((m) => m.role === "bot" && m.kind === "text" && String(m.text ?? "").includes("echo:")).length;
type PromptBlock = { type: string; text?: string; data?: string; mimeType?: string };
const lastPrompt = () => JSON.parse(readFileSync(promptDump, "utf8")) as PromptBlock[];

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
          environment: { FAKE_ACP_PROMPT_DUMP: promptDump, FAKE_ACP_RPC_DUMP: rpcDump, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile },
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

posixOnly("an image limit never fails a turn (fake Fuigo through the harness)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-turn-images-left-out-"));
    promptDump = join(home, "fake-acp-prompt.json");
    rpcDump = join(home, "fake-acp-rpc.json");
    gateFile = join(home, "gate");
    writeFileSync(gateFile, "open");
    ({ child, desktop: desktopHeaders } = await bootServer(home, port));
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  let bot: { id: string; threadId: string };
  it("sends the first ten of twelve images in order, leaves two out of the text, and says so in one line", async () => {
    const created = await request("POST", "/api/bots", { name: "Image limit fixture", modelSelection: { instanceId: "fuigo", model: "fake-acp-model" } });
    expect(created.status).toBe(201);
    bot = created.body.bot;
    expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
    const first = uploads;
    const paths: string[] = [];
    for (let index = 0; index < 12; index++) paths.push(await upload(bot.threadId));
    const text = `What do you see?\n\n${paths.map((path) => `<attached-image path="${path}" />`).join("\n\n")}`;
    const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    // The 202 comes before the turn starts: wait for the engine's reply, not
    // for an idle flag that is still idle under a loaded machine.
    await expect.poll(async () => (await echoes(bot.threadId)), { timeout: 60_000 }).toBe(1);
    await settled(bot.id);
    const prompt = lastPrompt();
    const images = prompt.filter((block) => block.type === "image");
    expect(images.map((block) => Buffer.from(block.data!, "base64").at(-1))).toEqual(Array.from({ length: 10 }, (_, index) => first + index));
    const turnText = prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    for (const path of paths.slice(0, 10)) expect(turnText).toContain(`<attached-image path="${path}" />`);
    for (const path of paths.slice(10)) expect(turnText).not.toContain(path);
    expect(JSON.stringify(await failures(bot.threadId))).toBe("[]");
    const lines = await notes(bot.threadId);
    expect(lines.map((m) => m.tool)).toEqual([{ name: imagesNotSentActivityName({ sent: 10, overCount: 2, tooLarge: 0 }), ok: true }]);
    // The owner's own message keeps all twelve: the chat shows what they sent.
    const recorded = (await messages(bot.threadId)).find((m) => m.role === "user" && String(m.text ?? "").includes(paths[11]!));
    expect(recorded?.attachments).toHaveLength(12);
    // ...and records which two were not sent, so no later replay names them.
    expect(recorded?.imagesNotSent).toEqual(paths.slice(10));
  }, 60_000);

  it("shows a picture sent while the bot was busy once the queued turn runs", async () => {
    rmSync(gateFile, { force: true });
    const busy = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold on a moment." });
    expect(busy.status).toBe(202);
    await expect.poll(async () => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(true);
    const path = await upload(bot.threadId);
    const expected = uploads - 1;
    const queued = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `And this one?\n\n<attached-image path="${path}" />` });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    expect(queued.body.queued).toBe(true);
    writeFileSync(gateFile, "open");
    await expect.poll(async () => (await messages(bot.threadId)).some((m) => m.role === "user" && String(m.text ?? "").includes(path)), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => { try { return lastPrompt().some((block) => block.type === "text" && block.text?.includes(path)); } catch { return false; } }, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await echoes(bot.threadId)), { timeout: 60_000 }).toBe(3);
    await settled(bot.id);
    const images = lastPrompt().filter((block) => block.type === "image");
    expect(images.map((block) => Buffer.from(block.data!, "base64").at(-1))).toEqual([expected]);
    expect(JSON.stringify(await failures(bot.threadId))).toBe("[]");
    expect(String(JSON.stringify(await messages(bot.threadId)))).not.toContain(REFUSAL);
  }, 90_000);

  it("does the same for a room member's turn", async () => {
    const room = (await request("POST", "/api/groups", { name: "Image room", memberIds: [bot.id] })).body.group as { id: string; threadId: string };
    expect(room?.threadId).toBeTruthy();
    await request("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", bulletin: "", defaultResponder: { kind: "member", botId: bot.id } });
    const first = uploads;
    const paths: string[] = [];
    for (let index = 0; index < 11; index++) paths.push(await upload(room.threadId));
    rmSync(promptDump, { force: true });
    const sent = await request("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: `Which colours?\n\n${paths.map((path) => `<attached-image path="${path}" />`).join("\n\n")}` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await expect.poll(() => { try { return lastPrompt().filter((block) => block.type === "image").length; } catch { return 0; } }, { timeout: 30_000 }).toBe(10);
    const images = lastPrompt().filter((block) => block.type === "image");
    expect(images.map((block) => Buffer.from(block.data!, "base64").at(-1))).toEqual(Array.from({ length: 10 }, (_, index) => first + index));
    const turnText = lastPrompt().filter((block) => block.type === "text").map((block) => block.text).join("\n");
    expect(turnText).toContain(paths[9]);
    expect(turnText).not.toContain(paths[10]);
    await expect.poll(async () => (await notes(room.threadId)).map((m) => m.tool?.name), { timeout: 30_000 }).toEqual([imagesNotSentActivityName({ sent: 10, overCount: 1, tooLarge: 0 })]);
    expect(await failures(room.threadId)).toEqual([]);
  }, 90_000);
});
