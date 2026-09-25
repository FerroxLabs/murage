// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// About me through the real routes and into real turns: a real server with
// its own data directory and port (launchVerificationServer), the fake
// Claude CLI dumping each turn's system prompt. The owner's own turns carry
// it (direct chat, a room of the owner's, a routine and a webhook run on the
// owner's behalf, the same rule MEMORY.md follows), and the per-bot switch
// takes it out. Channel people are proven in about-me-channels.test.ts.
// Synthetic fixture text only; loopback server, no network or credentials.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const ABOUT = "ABOUT_ME_CANARY I run a small candle shop and like short answers.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
let moss: { id: string; threadId: string };
let room: { id: string };
let sequence = 0;

const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as any };
};
const api = async (method: string, path: string, body?: unknown) => {
  const answer = await call(method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body;
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const marker = () => `ABOUT_TURN_${++sequence}`;

async function captured(tag: string): Promise<string> {
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return String(dump.systemPrompt ?? "");
}
const directTurn = async () => {
  const tag = marker();
  await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: `Please answer briefly. ${tag}` });
  return captured(tag);
};
const shapesRow = async (id: string) => (await api("GET", `/api/bots/${moss.id}/shapes`)).rows.find((row: any) => row.id === id);

posixOnly("About me", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false });
    room = (await api("POST", "/api/groups", { name: "Shop room", memberIds: [moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: moss.id } } })).group;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is desktop only, and offers a starting text made of what Murage knows until the first save", async () => {
    expect((await call("GET", "/api/about-me", undefined, {})).status).toBe(404);
    expect((await call("PUT", "/api/about-me", { text: "x" }, {})).status).toBe(404);
    const first = await api("GET", "/api/about-me");
    expect(first).toMatchObject({ text: "", saved: false, maxChars: 4000 });
    expect(first.suggestion).toMatch(/^(My name is .+\.\n)?My time zone is .+\.\n$/);
    expect(await shapesRow("about-me")).toBeUndefined();
    // nothing is sent before the owner saves
    expect(await directTurn()).not.toContain("<about-the-owner>");
  }, 60000);

  it("saves owner-only and reaches the owner's direct chat, in the stable prefix after House Rules", async () => {
    expect((await call("PUT", "/api/about-me", { text: "z".repeat(4001) })).status).toBe(413);
    expect(await api("PUT", "/api/about-me", { text: ABOUT })).toMatchObject({ text: ABOUT, saved: true, suggestion: "" });
    expect(statSync(join(fixture.info.dataDir, "about-me.md")).mode & 0o777).toBe(0o600);
    const system = await directTurn();
    expect(system).toContain(ABOUT);
    expect(system.indexOf("</house-rules>")).toBeLessThan(system.indexOf(ABOUT));
    expect(system.indexOf(ABOUT)).toBeLessThan(system.indexOf("You are Moss"));
    const row = await shapesRow("about-me");
    expect(row).toMatchObject({ on: true, switchable: true, editor: "aboutMe" });
    expect((await api("GET", `/api/bots/${moss.id}/shapes`)).lastTurn.text).toContain(ABOUT);
  }, 60000);

  it("reaches a room turn whose audience is the owner", async () => {
    const tag = marker();
    await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` });
    expect(await captured(tag)).toContain(ABOUT);
  }, 60000);

  it("reaches a routine run and a webhook run on the owner's own thread, as MEMORY.md does", async () => {
    const tag = marker();
    const routine = (await api("POST", "/api/routines", { botId: moss.id, name: "About check", prompt: `Please answer briefly. ${tag}`, schedule: { type: "once", at: Date.now() + 3_600_000 } })).routine;
    await api("POST", `/api/routines/${routine.id}/run`, {});
    const run = await captured(tag);
    expect(run).toContain("This task is a routine run and nobody is watching it.");
    expect(run).toContain(ABOUT);

    const hookTag = marker();
    const hook = await call("POST", "/api/webhooks", { name: "Inbound", prompt: `Please answer briefly. ${hookTag}`, botId: moss.id });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const hooked = await captured(hookTag);
    expect(hooked).toContain("authenticated external webhook");
    expect(hooked).toContain(ABOUT);
  }, 90000);

  it("switches off for this bot only, and back on", async () => {
    expect((await call("PATCH", `/api/bots/${moss.id}`, { aboutMe: "no" })).status).toBe(400);
    await api("PATCH", `/api/bots/${moss.id}`, { aboutMe: false });
    const offRow = await shapesRow("about-me");
    expect(offRow).toMatchObject({ on: false });
    expect(offRow.text).toContain(ABOUT);
    const off = await directTurn();
    expect(off).not.toContain(ABOUT);
    expect(off).not.toContain("<about-the-owner>");
    await api("PATCH", `/api/bots/${moss.id}`, { aboutMe: true });
    const bot = (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === moss.id);
    expect("aboutMe" in bot).toBe(false);
    expect(await directTurn()).toContain(ABOUT);
  }, 90000);

  it("clearing it takes it out of every turn and offers no starting text again", async () => {
    await api("PUT", "/api/about-me", { text: "" });
    expect(await api("GET", "/api/about-me")).toMatchObject({ saved: true, text: "", suggestion: "" });
    expect(await shapesRow("about-me")).toBeUndefined();
    expect(await directTurn()).not.toContain("<about-the-owner>");
  }, 60000);
});
