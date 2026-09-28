// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 final check D3: when a member's pinned memory could not be carried,
// the room showed the raw code twice per bot: a red "error: MEMORY_PIN_OVERFLOW:
// …" row under the bot and "X could not answer: MEMORY_PIN_OVERFLOW: …" from
// Murage. The owner now reads one plain sentence, once, from Murage, and a
// direct chat's error row says the same in plain words. Real server, memory
// active, the repository's fake Claude CLI; synthetic text, loopback only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];

posixOnly("a turn refused because of a pinned memory", () => {
  let moss: { id: string; threadId: string }, room: { id: string; threadId: string };
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env);
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret };
    expect((await api("GET", "/api/memory/status")).mode).toBe("active");
    const model = (await api("GET", "/api/instances")).instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
    moss = (await api("POST", "/api/bots", { name: "Moss", modelSelection: { instanceId: "verification", model } })).bot;
    await api("PATCH", `/api/bots/${moss.id}`, { computer: "off", browser: false, composio: false });
    room = (await api("POST", "/api/groups", { name: "Garden", memberIds: [moss.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: moss.id } } })).group;
    // Far more pinned words than any context share: every turn is refused.
    mkdirSync(join(fixture.info.dataDir, "workspaces", moss.id, "memory"), { recursive: true });
    writeFileSync(join(fixture.info.dataDir, "workspaces", moss.id, "memory", "garden.md"),
      Array.from({ length: 60 }, (_, i) => `- Garden note ${i}: the greenhouse bed ${i} is watered at ${i % 12 + 1} o'clock and fed every third day.`).join("\n"));
    const preview = await api("POST", "/api/memory/action", { action: "import-preview", selections: [{ kind: "bot", botId: moss.id, topic: "garden.md" }] });
    const committed = await api("POST", "/api/memory/action", { action: "import-commit", previewId: preview.previewId, track: false });
    for (const id of committed.recordIds as string[]) await api("POST", "/api/memory/action", { action: "pin", id, version: 1, pinned: true });
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  it("says why once, in plain words from Murage, with no raw code in the room", async () => {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "How is the greenhouse?" });
    await expect.poll(async () => (await messages(room.threadId)).some(message => message.kind === "activity" && !message.from && (message.tool?.name ?? "").startsWith("Moss could not answer: ")), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const failures = (await messages(room.threadId)).filter(message => message.kind === "activity" && message.tool?.ok === false);
    expect(failures).toHaveLength(1);
    expect(failures[0].from).toBeUndefined();
    expect(failures[0].tool.name).toBe("Moss could not answer: its pinned memories are too long for this model. Unpin some in Memory, or choose a model that takes more context.");
    expect(JSON.stringify(await messages(room.threadId))).not.toMatch(/MEMORY_|—|\bsafe/);
  }, 60000);

  it("says the same in plain words in a direct chat", async () => {
    await api("POST", `/api/bots/${moss.id}/messages`, { threadId: moss.threadId, text: "How is the greenhouse?" });
    await expect.poll(async () => (await messages(moss.threadId)).some(message => message.kind === "activity" && message.tool?.ok === false), { timeout: 20000 }).toBe(true);
    await expect.poll(idle, { timeout: 20000 }).toBe(true);
    const failures = (await messages(moss.threadId)).filter(message => message.kind === "activity" && message.tool?.ok === false);
    expect(failures.map(message => message.tool.name)).toEqual(["error: Moss's pinned memories are too long for this model. Unpin some in Memory, or choose a model that takes more context."]);
    expect(JSON.stringify(await messages(moss.threadId))).not.toMatch(/MEMORY_/);
  }, 60000);
});
