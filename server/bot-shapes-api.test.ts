// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What shapes <bot>" through the real routes and real turns: a real server
// with its own data directory and port (launchVerificationServer), the
// repository's fake Claude CLI dumping each turn's system prompt. The last
// turn's text the route returns must be the prompt the engine received, byte
// for byte, and the per-bot team brief switch must reach the next turn.
// Synthetic fixture text only; loopback server, no network or credentials.
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SECTION = "Ops";
const BRIEF = "SHAPES_BRIEF_CANARY the Ops team ships on Thursdays.";
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, secret = "";
let moss: { id: string; threadId: string; name: string };
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

async function captured(tag: string) {
  let dump: any;
  await expect.poll(() => { dump = readJson(fixture.fixtureDumpPath); return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  await expect.poll(idle, { timeout: 20000 }).toBe(true);
  return dump as { systemPrompt: string | null; mcpConfig?: unknown; env?: Record<string, string> };
}
const directTurn = async () => {
  const tag = `SHAPES_TURN_${++sequence}`;
  await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: `Please answer briefly. ${tag}` });
  return captured(tag);
};
const roomTurn = async () => {
  const tag = `SHAPES_TURN_${++sequence}`;
  await api("POST", `/api/groups/${room.id}/messages`, { text: `Please answer briefly. ${tag}` });
  return captured(tag);
};
const shapes = () => api("GET", `/api/bots/${moss.id}/shapes`);
const rowOf = (view: any, id: string) => view.rows.find((row: any) => row.id === id);

/** Every string in the dumped engine launch that looks like a credential. */
function credentialValues(dump: { mcpConfig?: unknown; env?: Record<string, string> }): string[] {
  const found: string[] = [];
  const walk = (value: unknown, key = "") => {
    if (typeof value === "string") { if (/token|secret|key|password/i.test(key) && value.length >= 12) found.push(value); return; }
    if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(dump.mcpConfig);
  for (const [key, value] of Object.entries(dump.env ?? {})) if (/^MURAGE_.*(TOKEN|SECRET)/.test(key) && value.length >= 12) found.push(value);
  return found;
}

posixOnly("what shapes a bot", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';" });
    secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false, section: SECTION, description: "Keeps the garden notes." });
    await api("PUT", `/api/section-context?section=${SECTION}`, { text: BRIEF });
    room = (await api("POST", "/api/groups", { name: "Shapes room", memberIds: [moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: moss.id } } })).group;
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("is desktop only", async () => {
    expect((await call("GET", `/api/bots/${moss.id}/shapes`, undefined, {})).status).toBe(404);
    expect((await call("GET", `/api/bots/no-such-bot/shapes`)).status).toBe(404);
    expect((await call("POST", `/api/bots/${moss.id}/shapes`, {})).status).toBe(405);
  });

  it("before any turn, lists what is known now and leaves the rest to the first message", async () => {
    const view = await shapes();
    expect(view).toMatchObject({ botId: moss.id, botName: "Moss", team: { section: SECTION, label: SECTION }, lastTurn: null });
    expect(view.rows[0]).toMatchObject({ id: "house-rules", group: "rules", switchable: true, on: true });
    expect(rowOf(view, "persona").text).toContain("About: Keeps the garden notes.");
    expect(rowOf(view, "team-brief")).toMatchObject({ switchable: true, on: true });
    expect(rowOf(view, "team-brief").text).toContain(BRIEF);
    expect(rowOf(view, "memory").text).toContain("MEMORY.md");
    expect(rowOf(view, "capabilities")).toMatchObject({ text: null, locked: true });
  });

  it("returns the last direct turn's system prompt exactly as the engine received it, and no credential", async () => {
    const dump = await directTurn();
    const view = await shapes();
    expect(view.lastTurn).toMatchObject({ where: "chat" });
    expect(view.lastTurn.text).toBe(dump.systemPrompt);
    expect(view.lastTurn.text).toContain(BRIEF);
    // The turn-dependent rows now carry that turn's words.
    const primer = rowOf(view, "capabilities");
    expect(primer.text && dump.systemPrompt!.includes(primer.text)).toBe(true);
    const everything = JSON.stringify(view);
    expect(everything).not.toContain(secret);
    const credentials = credentialValues(dump);
    expect(credentials.length).toBeGreaterThan(0);
    for (const value of credentials) expect(everything).not.toContain(value);
  }, 60000);

  it("returns the last room turn's system prompt exactly too", async () => {
    const dump = await roomTurn();
    const view = await shapes();
    expect(view.lastTurn).toMatchObject({ where: "room" });
    expect(view.lastTurn.text).toBe(dump.systemPrompt);
    expect(rowOf(view, "speak-as").text).toContain("You speak only as Moss.");
  }, 60000);

  it("switches the team brief off for this bot only, and back on", async () => {
    expect((await call("PATCH", `/api/bots/${moss.id}`, { teamBrief: "no" })).status).toBe(400);
    await api("PATCH", `/api/bots/${moss.id}`, { teamBrief: false });
    expect(rowOf(await shapes(), "team-brief").on).toBe(false);
    const off = await directTurn();
    expect(off.systemPrompt).not.toContain(BRIEF);
    expect(off.systemPrompt).toContain("MEMORY.md");
    expect((await shapes()).lastTurn.text).toBe(off.systemPrompt);

    await api("PATCH", `/api/bots/${moss.id}`, { teamBrief: true });
    const bot = (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === moss.id);
    expect("teamBrief" in bot).toBe(false);
    expect((await directTurn()).systemPrompt).toContain(BRIEF);
  }, 90000);

  it("shows House Rules switched off and leaves them out of the next turn", async () => {
    await api("PUT", "/api/house-rules", { enabled: false });
    const view = await shapes();
    expect(rowOf(view, "house-rules")).toMatchObject({ on: false });
    expect(rowOf(view, "house-rules").text.length).toBeGreaterThan(50);
    expect((await directTurn()).systemPrompt).not.toContain("<house-rules>");
    await api("PUT", "/api/house-rules", { enabled: true });
  }, 60000);
});
