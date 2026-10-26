// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 final check D3 showed raw MEMORY_PIN_OVERFLOW codes when a member's
// pinned memory could not be carried; 1.0.4 goes further: pins past the
// model's share are left out and the turn runs. The Pin action refuses a pin
// that would not fit (409 MEMORY_PIN_BUDGET with used/allowed), and an install
// already over the share (pins written before 1.0.4) keeps answering while
// Murage says once per thread, in plain words, that some pins were left out.
// Real server, memory active, the repository's fake Claude CLI; synthetic
// text, loopback only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
  return value;
};
const idle = async () => { const state = await api("GET", "/api/bots?messages=0"); return !state.bots.some((bot: any) => bot.busy) && !state.groups.some((group: any) => group.busyBotId || group.working); };
const DROPPED = "Murage left some pinned memories out of this reply: together they are longer than this model has room for. To bring them back, unpin or shorten a few in Memory, or choose a model that takes more context.";
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];

posixOnly("pinned memories longer than the model has room for", () => {
  let moss: { id: string; threadId: string }, room: { id: string; threadId: string }, recordIds: string[] = [], refusal: { status: number; body: any } | undefined;
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false });
    room = (await api("POST", "/api/groups", { name: "Garden", memberIds: [moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: moss.id } } })).group;
    // Far more pinned words than any context share.
    mkdirSync(join(fixture.info.dataDir, "workspaces", moss.id, "memory"), { recursive: true });
    writeFileSync(join(fixture.info.dataDir, "workspaces", moss.id, "memory", "garden.md"),
      Array.from({ length: 60 }, (_, i) => `- Garden note ${i}: the greenhouse bed ${i} is watered at ${i % 12 + 1} o'clock and fed every third day.`).join("\n"));
    const preview = await api("POST", "/api/memory/action", { action: "import-preview", selections: [{ kind: "bot", botId: moss.id, topic: "garden.md" }] });
    const committed = await api("POST", "/api/memory/action", { action: "import-commit", previewId: preview.previewId, track: false });
    recordIds = committed.recordIds as string[];
    // The Pin action takes pins until the next one would not fit, then refuses it with how much room the pins take and have.
    for (const id of recordIds) {
      const response = await fetch(`${fixture.info.url}/api/memory/action`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "pin", id, version: 1, pinned: true }) });
      if (response.status === 200) continue;
      refusal = { status: response.status, body: await response.json() };
      break;
    }
    // An install upgraded from 1.0.3 holds pins written before the check: every note pinned, straight into the store.
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try { db.exec("PRAGMA busy_timeout=5000"); for (const id of recordIds) db.prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=1").run(id); }
    finally { db.close(); }
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("refuses the pin that would not fit with 409 and the room the pins take and have", () => {
    expect(refusal).toBeDefined();
    expect(refusal!.status).toBe(409);
    expect(refusal!.body).toMatchObject({ error: expect.stringMatching(/^MEMORY_PIN_BUDGET: \d+\/2048$/), allowed: 2048 });
    expect(refusal!.body.used).toBeGreaterThan(2048);
  });

  it("answers in a room over the share, and Murage says once, in plain words, that some pins were left out", async () => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "How is the greenhouse?" });
    await expect.poll(async () => (await messages(room.threadId)).some(message => message.role === "bot" && message.kind === "text" && message.from), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const all = await messages(room.threadId);
    expect(all.filter(message => message.kind === "activity" && message.tool?.ok === false)).toEqual([]);
    const notes = all.filter(message => message.kind === "activity" && message.tool?.name === DROPPED);
    expect(notes).toHaveLength(1);
    expect(notes[0].from).toBeUndefined();
    expect(JSON.stringify(all)).not.toMatch(/MEMORY_|—|\bsafe/);
  }, 60000);

  it("runs a goal in the same room without failing over pins, and does not say it again", async () => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "Plan the greenhouse week", mode: "goal" });
    await expect.poll(async () => (await messages(room.threadId)).some(message => message.kind === "goal.run"), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    const all = await messages(room.threadId);
    const run = all.find(message => message.kind === "goal.run")?.goalRun;
    expect(run?.status).not.toBe("failed");
    expect(JSON.stringify(run)).not.toContain("too long for this model");
    expect(all.filter(message => message.kind === "activity" && message.tool?.name === DROPPED)).toHaveLength(1);
    expect(JSON.stringify(all)).not.toMatch(/MEMORY_/);
  }, 60000);

  it("answers in a direct chat and says it there once too", async () => {
    await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: "How is the greenhouse?" });
    await expect.poll(async () => (await messages(moss.threadId)).some(message => message.role === "bot" && message.kind === "text"), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const all = await messages(moss.threadId);
    expect(all.filter(message => message.kind === "activity" && message.tool?.ok === false)).toEqual([]);
    expect(all.filter(message => message.kind === "activity" && message.tool?.name === DROPPED)).toHaveLength(1);
    expect(JSON.stringify(all)).not.toMatch(/MEMORY_/);
  }, 60000);
});
