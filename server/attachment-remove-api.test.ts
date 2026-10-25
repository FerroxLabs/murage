// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-H through the real server (designs/SL-H.md section 6, GATE):
//  - Remove from Settings > Storage; GET of the removed name answers 410
//    {removed: true}, a name never saved still 404;
//  - a turn naming a removed image goes ahead without it on every delivery
//    mode: inline (fake Fuigo, the strictest unbound rule), mixed (a custom
//    ACP engine with an unbound tag beside it) and path (fake pi): the tag
//    never reaches the engine's text, and the owner gets one line that
//    counts it; a room member's turn does the same;
//  - an upload retry with the same uploadId after Remove answers 409 and
//    recreates nothing;
//  - a bot's picture is refused with "Change the bot's picture first".
//
// Same server-spawn pattern as turn-images-not-sent-api.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { IMAGES_NOT_SENT_PREFIX, imagesNotSentActivityName } from "../shared/turn-image-note.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_PI = join(SERVER_DIR, "testing", "fake-pi-cli.ts");
const BASE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const posixOnly = describe.skipIf(process.platform === "win32");

let base: string, home: string, child: ChildProcess, stderr = "";
let desktop: Record<string, string>;
let fuigoDump: string, customDump: string, piDump: string, gateFile: string;

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...desktop, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
let uploads = 0;
const pngNumber = (index: number) => Buffer.concat([BASE_PNG, Buffer.from([index])]);
/** One upload; `threadId` binds it to that conversation. Returns the path and the byte that tells it apart. */
const upload = async (threadId?: string, uploadId?: string) => {
  const query = new URLSearchParams({ ...(threadId ? { threadId } : {}), ...(uploadId ? { uploadId } : {}) });
  const marker = uploads++;
  const res = await fetch(`${base}/api/attachments?${query}`, { method: "POST", headers: { ...desktop, "content-type": "image/png" }, body: pngNumber(marker) });
  return { status: res.status, path: res.status === 201 ? ((await res.json()) as { path: string }).path : "", marker };
};
const remove = (path: string) => request("POST", "/api/storage/attachments/remove", { names: [basename(path)] });
const tag = (path: string) => `<attached-image path="${path}" />`;
const notes = async (threadId: string) => (await messages(threadId)).filter(m => m.kind === "activity" && String(m.tool?.name ?? "").startsWith(IMAGES_NOT_SENT_PREFIX)).map(m => m.tool.name);
const failures = async (threadId: string) => (await messages(threadId)).filter(m => m.kind === "activity" && (m.tool?.ok === false || String(m.tool?.name ?? "").startsWith("error:")));
const echoes = async (threadId: string) => (await messages(threadId)).filter(m => m.role === "bot" && m.kind === "text" && String(m.text ?? "").includes("echo:")).length;
type PromptBlock = { type: string; text?: string; data?: string };
const acpPrompt = (dump: string) => JSON.parse(readFileSync(dump, "utf8")) as PromptBlock[];
const acpText = (dump: string) => acpPrompt(dump).filter(b => b.type === "text").map(b => b.text).join("\n");
const acpImages = (dump: string) => acpPrompt(dump).filter(b => b.type === "image").map(b => Buffer.from(b.data!, "base64").at(-1));
const piPrompts = () => existsSync(piDump) ? readFileSync(piDump, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { prompt?: boolean; message?: string }).filter(row => row.prompt) : [];

async function makeBot(name: string, instanceId: string) {
  const fixed: Record<string, string> = { fuigo: "fake-acp-model", custom: "agent-default" };
  const listed = (await request("GET", "/api/instances")).body.instances?.find((engine: any) => engine.instanceId === instanceId)?.models?.options?.[0]?.id;
  const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId, model: fixed[instanceId] ?? listed } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await request("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}

posixOnly("Remove an attachment (SL-H) through the harness", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_PI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-attachment-remove-api-"));
    fuigoDump = join(home, "fuigo-prompt.json");
    customDump = join(home, "custom-prompt.json");
    piDump = join(home, "pi-dump.jsonl");
    gateFile = join(home, "gate");
    writeFileSync(gateFile, "open");
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    const acp = (dump: string) => ({ FAKE_ACP_PROMPT_DUMP: dump, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({
      engineDiscovery: "explicit",
      instances: {
        fuigo: { driver: "fuigoAgent", environment: acp(fuigoDump), config: { cli: FAKE_ACP, fullAuto: false } },
        custom: { driver: "customAcp", displayName: "Custom fixture", environment: acp(customDump), config: { cli: FAKE_ACP } },
        pi: { driver: "piAgent", displayName: "pi fixture", environment: { FAKE_PI_DUMP: piDump }, config: { cli: FAKE_PI, fullAuto: true } },
      },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", c => (stderr += c));
    child.stdout!.on("data", c => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise(r => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then(r => r.json())) as { secret: string };
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("Remove answers per name; GET of a removed name is 410, a name never saved 404", async () => {
    const bot = await makeBot("Remove fixture", "fuigo");
    const saved = await upload(bot.threadId);
    expect((await request("GET", `/api/attachments/${basename(saved.path)}`)).status).toBe(200);
    expect(await remove(saved.path)).toEqual({ status: 200, body: { results: [{ name: basename(saved.path), state: "removed" }] } });
    expect(existsSync(saved.path)).toBe(false);
    expect(existsSync(join(dirname(saved.path), ".removed", basename(saved.path)))).toBe(true);
    expect(await request("GET", `/api/attachments/${basename(saved.path)}`)).toEqual({ status: 410, body: { removed: true } });
    expect(await request("GET", `/api/attachments/${basename(saved.path)}?w=320`)).toEqual({ status: 410, body: { removed: true } });
    expect((await request("GET", "/api/attachments/99999999-9999-4999-8999-999999999999.png")).status).toBe(404);
    // not a stored attachment's name: refused before anything is touched
    expect((await request("POST", "/api/storage/attachments/remove", { names: ["../config.json"] })).status).toBe(400);
    // the Storage list no longer shows it, and does not count the marker folder
    const list = (await request("GET", "/api/storage/attachments")).body;
    expect(list.items.map((item: any) => item.name)).not.toContain(basename(saved.path));
    expect(list.totals.other.count).toBe(0);
  }, 30_000);

  it("an upload retry with the same uploadId after Remove answers 409 and recreates nothing", async () => {
    const bot = await makeBot("Retry fixture", "fuigo");
    const uploadId = "66666666-6666-4666-8666-666666666666";
    const first = await upload(bot.threadId, uploadId);
    expect(first.status).toBe(201);
    expect((await remove(first.path)).status).toBe(200);
    const retry = await fetch(`${base}/api/attachments?threadId=${bot.threadId}&uploadId=${uploadId}`, { method: "POST", headers: { ...desktop, "content-type": "image/png" }, body: pngNumber(first.marker) });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "That attachment was removed" });
    expect(existsSync(first.path)).toBe(false);
    expect((await request("GET", `/api/attachments/${basename(first.path)}`)).status).toBe(410);
  }, 30_000);

  it("refuses to remove a bot's picture", async () => {
    const bot = await makeBot("Picture fixture", "fuigo");
    const picture = await upload();
    const avatarUrl = `/api/attachments/${basename(picture.path)}`;
    expect((await request("PATCH", `/api/bots/${bot.id}`, { avatarUrl })).status).toBe(200);
    expect(await remove(picture.path)).toEqual({ status: 409, body: { results: [{ name: basename(picture.path), state: "refused", error: "Change the bot's picture first" }] } });
    expect(existsSync(picture.path)).toBe(true);
    expect((await request("GET", avatarUrl)).status).toBe(200);
  }, 30_000);

  it("inline (Fuigo): the turn goes ahead without the removed image, its tag never reaches the engine, and one line counts it", async () => {
    const bot = await makeBot("Inline fixture", "fuigo");
    const gone = await upload(bot.threadId), kept = await upload(bot.threadId);
    expect((await remove(gone.path)).status).toBe(200);
    const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `What is this?\n\n${tag(gone.path)}\n\n${tag(kept.path)}` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => await echoes(bot.threadId), { timeout: 60_000 }).toBe(1);
    expect(acpImages(fuigoDump)).toEqual([kept.marker]);
    expect(acpText(fuigoDump)).toContain(tag(kept.path));
    expect(acpText(fuigoDump)).not.toContain(gone.path);
    expect(await failures(bot.threadId)).toEqual([]);
    await expect.poll(async () => await notes(bot.threadId), { timeout: 15_000 }).toEqual([imagesNotSentActivityName({ sent: 1, overCount: 0, tooLarge: 0, removed: 1 })]);
    // the owner's message keeps its tag and path; the chat row is never rewritten
    const own = (await messages(bot.threadId)).find(m => m.role === "user" && String(m.text ?? "").includes(gone.path));
    expect(own?.text).toContain(tag(gone.path));
  }, 90_000);

  it("mixed (an inline engine with an unbound tag): the removed image's tag never reaches the engine", async () => {
    const bot = await makeBot("Mixed fixture", "custom");
    const gone = await upload(bot.threadId), kept = await upload(bot.threadId), unbound = await upload();
    expect((await remove(gone.path)).status).toBe(200);
    const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `And these?\n\n${tag(kept.path)}\n\n${tag(gone.path)}\n\n${tag(unbound.path)}` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => await echoes(bot.threadId), { timeout: 60_000 }).toBe(1);
    expect(acpImages(customDump)).toEqual([kept.marker]);
    expect(acpText(customDump)).toContain(tag(unbound.path));
    expect(acpText(customDump)).not.toContain(gone.path);
    expect(await failures(bot.threadId)).toEqual([]);
  }, 90_000);

  it("path (pi): the removed image's path is never handed to the engine", async () => {
    const bot = await makeBot("Path fixture", "pi");
    const gone = await upload(bot.threadId), kept = await upload(bot.threadId);
    expect((await remove(gone.path)).status).toBe(200);
    const before = piPrompts().length;
    const sent = await request("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Open these.\n\n${tag(kept.path)}\n\n${tag(gone.path)}` });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => piPrompts().length, { timeout: 60_000 }).toBeGreaterThan(before);
    const prompt = String(piPrompts().at(-1)!.message);
    expect(prompt).toContain(kept.path);
    expect(prompt).not.toContain(gone.path);
  }, 90_000);

  it("a room member's turn leaves the removed image out the same way", async () => {
    const bot = await makeBot("Room fixture", "fuigo");
    const room = (await request("POST", "/api/groups", { name: "Remove room", memberIds: [bot.id] })).body.group as { id: string; threadId: string };
    await request("PATCH", `/api/groups/${room.id}/setup`, { action: "complete", bulletin: "", defaultResponder: { kind: "member", botId: bot.id } });
    const gone = await upload(room.threadId), kept = await upload(room.threadId);
    expect((await remove(gone.path)).status).toBe(200);
    writeFileSync(fuigoDump, "[]");
    const sent = await request("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: `Which colour?\n\n${tag(gone.path)}\n\n${tag(kept.path)}` });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await expect.poll(() => { try { return acpImages(fuigoDump).length; } catch { return 0; } }, { timeout: 60_000 }).toBe(1);
    expect(acpImages(fuigoDump)).toEqual([kept.marker]);
    expect(acpText(fuigoDump)).not.toContain(gone.path);
    await expect.poll(async () => await notes(room.threadId), { timeout: 30_000 }).toEqual([imagesNotSentActivityName({ sent: 1, overCount: 0, tooLarge: 0, removed: 1 })]);
    expect(await failures(room.threadId)).toEqual([]);
  }, 90_000);
});
