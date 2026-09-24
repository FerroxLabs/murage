// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// House Rules through the real HTTP routes and into real turns, on a real
// server with its own data directory (launchVerificationServer gives the
// child its own MURAGE_DATA_DIR and port; nothing touches the owner's).
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { DEFAULT_HOUSE_RULES } from "./house-rules.ts";

const RULES = "HOUSE_RULES_CANARY Always sign off with the word Cheers.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string> = {};
let sequence = 0;

const api = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const readJson = (path: string) => { try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; } };
const idle = async () => { const state = (await api("GET", "/api/bots?messages=0")).body; return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };

async function captured(tag: string) {
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return String(dump.systemPrompt ?? "");
}

posixOnly("house rules", () => {
  let bot: { id: string; threadId: string };
  let room: { id: string };

  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    bot = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    room = (await api("POST", "/api/groups", { name: "Rules room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  const directTurn = async () => {
    const tag = `HOUSE_TURN_${++sequence}`;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Please answer briefly. ${tag}` })).status).toBeLessThan(300);
    return captured(tag);
  };
  const roomTurn = async () => {
    const tag = `HOUSE_TURN_${++sequence}`;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` })).status).toBeLessThan(300);
    return captured(tag);
  };

  it("serves the shipped default, saves, resets and bounds the size", async () => {
    const first = await api("GET", "/api/house-rules");
    expect(first).toMatchObject({ status: 200, body: { text: DEFAULT_HOUSE_RULES, enabled: true, isDefault: true, defaultText: DEFAULT_HOUSE_RULES } });
    expect(first.body.words).toBeGreaterThan(100);

    expect(await api("PUT", "/api/house-rules", { text: RULES })).toMatchObject({ status: 200, body: { text: RULES, isDefault: false, enabled: true } });
    expect((await api("GET", "/api/house-rules")).body.text).toBe(RULES);
    expect(readFileSync(`${fixture.info.dataDir}/house-rules.md`, "utf8")).toBe(RULES);

    expect(await api("PUT", "/api/house-rules", { text: "x".repeat(23 * 1024) })).toMatchObject({
      status: 413,
      body: { error: "House rules can be up to 20 KB. Yours are 23 KB. Shorten them and save again." },
    });
    expect(await api("PUT", "/api/house-rules", { text: 7 })).toMatchObject({ status: 400 });
    expect(await api("PUT", "/api/house-rules", { enabled: "no" })).toMatchObject({ status: 400 });
    expect((await api("GET", "/api/house-rules")).body.text).toBe(RULES);

    expect(await api("POST", "/api/house-rules/reset")).toMatchObject({ status: 200, body: { text: DEFAULT_HOUSE_RULES, isDefault: true, enabled: true } });
  }, 60000);

  it("is refused to every surface but the desktop app", async () => {
    expect((await api("GET", "/api/house-rules", undefined, {})).status).toBe(404);
    expect((await api("PUT", "/api/house-rules", { text: "x" }, {})).status).toBe(404);
    expect((await api("POST", "/api/house-rules/reset", undefined, {})).status).toBe(404);
    expect((await api("GET", "/api/house-rules", undefined, { "x-murage-surface": "desktop", "x-murage-surface-secret": "wrong" })).status).toBe(404);
  });

  it("opens every direct and room turn when on, and is absent when off", async () => {
    await api("PUT", "/api/house-rules", { text: RULES, enabled: true });
    const direct = await directTurn();
    expect(direct.startsWith(`<house-rules>\n${RULES}\n</house-rules>\n\nYou are Moss`)).toBe(true);
    const member = await roomTurn();
    expect(member.startsWith(`<house-rules>\n${RULES}\n</house-rules>\n\nYou are Moss, a bot in the room`)).toBe(true);

    expect(await api("PUT", "/api/house-rules", { enabled: false })).toMatchObject({ status: 200, body: { enabled: false, text: RULES } });
    const off = await directTurn();
    expect(off).not.toContain("<house-rules>");
    expect(off).not.toContain("HOUSE_RULES_CANARY");
    expect(off.startsWith("You are Moss")).toBe(true);
  }, 120000);
});
