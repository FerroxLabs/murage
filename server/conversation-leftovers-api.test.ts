// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const touch = (file: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture media"); return file; };
beforeAll(async () => {
  fixture = await launchVerificationServer();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });

for (const wholeBot of [false, true]) it(`the isolated server deletes a ${wholeBot ? "bot" : "chat"}'s media and keeps the other chat's files and schedule`, async () => {
  const models = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification").models.options;
  const make = async (name: string) => {
    const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model: models[0].id } });
    expect(made.status).toBe(201);
    const bot = made.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const routine = await api("POST", "/api/routines", { name: "Fixture schedule", prompt: "Write a note", botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
    expect(routine.status).toBe(201);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const uploaded = await fetch(`${fixture.info.url}/api/attachments?threadId=${bot.threadId}`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: image });
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json() as { path: string }).path;
    const pictureUpload = await fetch(`${fixture.info.url}/api/attachments`, { method: "POST", headers: { ...headers, "content-type": "image/png" }, body: Buffer.concat([image, Buffer.from("picture")]) });
    expect(pictureUpload.status).toBe(201);
    const picture = (await pictureUpload.json() as { path: string }).path;
    const pictureName = picture.split(/[\\/]/).at(-1)!;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl: `/api/attachments/${pictureName}` })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `<attached-image path="${attachment}" />\nRead this fixture image.` })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: any) => item.id === bot.id)?.tasks.every((task: any) => !task.busy), { timeout: 30_000 }).toBe(true);
    // Production media paths, including a note or image left before its Files copy was published.
    const root = join(fixture.info.dataDir, "workspaces", bot.id);
    const audio = touch(join(root, "generated-audio", bot.threadId, "note.mp3"));
    const generated = touch(join(root, "generated-images", bot.threadId, "image.png"));
    const topic = touch(join(root, "memory", "topic.md"));
    return { bot, routine: routine.body.routine, attachment: join(fixture.info.dataDir, "attachments", attachment.split(/[\\/]/).at(-1)!), picture: join(fixture.info.dataDir, "attachments", pictureName), audio, generated, topic };
  };
  const doomed = await make("Removed fixture"), kept = await make("Kept fixture");
  const removed = await api("DELETE", `/api/bots/${doomed.bot.id}${wholeBot ? "" : `/tasks/${doomed.bot.threadId}`}`);
  expect(removed.status).toBe(200);
  expect(removed.body.failed).toBeUndefined();
  for (const file of [doomed.attachment, doomed.audio, doomed.generated]) expect(existsSync(file), file).toBe(false);
  expect(existsSync(doomed.topic)).toBe(!wholeBot);
  expect(existsSync(doomed.picture)).toBe(!wholeBot);
  for (const file of [kept.attachment, kept.picture, kept.audio, kept.generated, kept.topic]) expect(existsSync(file), file).toBe(true);
  const routines = (await api("GET", "/api/routines")).body.routines;
  expect(routines.find((routine: any) => routine.id === kept.routine.id)?.enabled).toBe(true);
  expect(routines.find((routine: any) => routine.id === doomed.routine.id)?.enabled).toBe(!wholeBot);
  expect(readdirSync(join(fixture.info.dataDir, "attachments"))).toContain(kept.attachment.split(/[\\/]/).at(-1));
}, 90_000);
