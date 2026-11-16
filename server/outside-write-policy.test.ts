import { openSse } from "./testing/sse.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

describe("C-ASK-WRITER authenticated ordinary writer hold", () => {
  let fixture: VerificationServer;
  let headers: Record<string, string> = {};
  let model: string;
  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
      process.env.FAKE_CLAUDE_ITEM_WHEN_FILE=process.env.MURAGE_DATA_DIR+'/outside-trigger';
      process.env.FAKE_CLAUDE_PERM_TOOL='WebFetch';
      process.env.FAKE_CLAUDE_PERM_INPUT=JSON.stringify({url:'https://example.invalid/outside'});
    ` });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
  const state = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);

  it.each([
    [false, "allow"], [false, "deny"], [true, "allow"], [true, "deny"],
  ] as const)("marked=%s decision=%s holds a real lead update before its first effect", async (marked, behavior) => {
    const name = `Writer lead ${marked} ${behavior}`;
    const lead = (await api("POST", "/api/bots", { name, section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    const target = (await api("POST", "/api/bots", { name: "Specialist", section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { chiefOfStaff: true, chiefScope: "section", computer: "off", browser: false, composio: false, autoApprove: false })).status).toBe(200);
    const stream = await openSse(fixture.info.url + "/api/events", headers);
    const abort = new AbortController();
    const trigger = join(fixture.info.dataDir, "outside-trigger");
    let pending: Promise<unknown> | undefined;
    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { threadId: lead.threadId, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
      let token: string | undefined;
      await expect.poll(() => {
        try {
          const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
          const env = dump.mcpConfig?.mcpServers?.agents?.env;
          if (env?.MURAGE_BOT_ID === lead.id) token = env.MURAGE_COMMS_TOKEN;
        } catch { /* await this exact fixture launch */ }
        return token;
      }, { timeout: 30_000 }).toBeTruthy();
      const manage = async (body: unknown, signal?: AbortSignal) => {
        const response = await fetch(fixture.info.url + "/api/internal/bot-management", { method: "POST", signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        const result = { status: response.status, body: await response.json() as any };
        if (result.status >= 400) console.error("writer fixture refusal", result);
        return result;
      };
      const original = await manage({ action: "get", targetBotId: target.id });
      expect(original.status).toBe(200);
      if (marked) {
        writeFileSync(trigger, "outside read");
        await expect.poll(() => readFileSync(join(fixture.info.dataDir, "outside-state.jsonl"), "utf8").split("\n").some(line => {
          if (!line) return false;
          const row = JSON.parse(line);
          return row.k === "mark" && row.row.threadId === lead.threadId;
        }), { timeout: 10_000 }).toBe(true);
      }
      let settled = false;
      pending = manage({ action: "update", targetBotId: target.id, revision: original.body.bot.revision, role: "Reviewed role" }, abort.signal)
        .finally(() => { settled = true; });
      // Consume a transport cancellation on assertion failure as well.
      void pending.catch(() => {});
      let cards: any[] = [];
      await expect.poll(async () => {
        cards = (await messages(lead.threadId)).filter(message => message.card?.requestId && message.card.answered === undefined);
        return cards.length > 0 || settled;
      }, { timeout: 10_000 }).toBe(true);
      expect((await state(target.id)).title ?? "", "Ask must perform zero effects before Allow").toBe(original.body.bot.role);
      expect(cards, "exactly one handler-owned card, no engine card").toHaveLength(1);
      expect(settled, "the original live call must remain held").toBe(false);
      await stream.until(frame => frame.kind === "message" && frame.threadId === lead.threadId && frame.message?.id === cards[0].id, 5000);
      const card = cards[0].card;
      expect(card.writer, "shared writer metadata is required").toMatchObject({ version: 1, state: "waiting" });
      expect((await api("POST", `/api/threads/${lead.threadId}/respond`, { requestId: card.requestId, behavior, stateRevision: card.writer.stateRevision })).status).toBe(200);
      await pending;
      expect((await state(target.id)).title ?? "").toBe(behavior === "allow" ? "Reviewed role" : original.body.bot.role);
      expect((await state(lead.id)).noLimits).not.toBe(true);
    } finally {
      stream.close();
      abort.abort();
      await pending?.catch(() => {});
      await api("POST", `/api/bots/${lead.id}/interrupt`, { threadId: lead.threadId });
      if (existsSync(trigger)) unlinkSync(trigger);
    }
  }, 60_000);
  it("an authenticated marked No limits owner update runs without a writer card", async () => {
    const name = "Writer No limits owner";
    const lead = (await api("POST", "/api/bots", { name, section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    const target = (await api("POST", "/api/bots", { name: "No limits target", section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { chiefOfStaff: true, chiefScope: "section", computer: "off", browser: false, composio: false })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${lead.id}/tasks/${lead.threadId}`, { noLimits: true, acknowledgeNoLimits: true })).status).toBe(200);
    const trigger = join(fixture.info.dataDir, "outside-trigger");
    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { threadId: lead.threadId, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
      let token: string | undefined;
      await expect.poll(() => {
        try {
          const dump = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
          const env = dump.mcpConfig?.mcpServers?.agents?.env;
          if (env?.MURAGE_BOT_ID === lead.id) token = env.MURAGE_COMMS_TOKEN;
        } catch { /* wait for this fixture turn */ }
        return token;
      }, { timeout: 30_000 }).toBeTruthy();
      const manage = async (body: unknown) => {
        const response = await fetch(fixture.info.url + "/api/internal/bot-management", { method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as any };
      };
      const original = await manage({ action: "get", targetBotId: target.id });
      expect(original.status).toBe(200);
      writeFileSync(trigger, "outside read");
      await expect.poll(() => readFileSync(join(fixture.info.dataDir, "outside-state.jsonl"), "utf8").split("\n").some(line => {
        if (!line) return false;
        const row = JSON.parse(line);
        return row.k === "mark" && row.row.threadId === lead.threadId;
      }), { timeout: 10_000 }).toBe(true);
      const changed = await manage({ action: "update", targetBotId: target.id, revision: original.body.bot.revision, role: "No limits role" });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect((await state(target.id)).title).toBe("No limits role");
      expect((await messages(lead.threadId)).filter(message => message.card?.kind === "own-write")).toHaveLength(0);
      expect((await messages(lead.threadId)).filter(message => message.card?.requestId && message.card.answered === undefined)).toHaveLength(0);
    } finally {
      await api("POST", `/api/bots/${lead.id}/interrupt`, { threadId: lead.threadId });
      if (existsSync(trigger)) unlinkSync(trigger);
    }
  }, 60_000);

});
