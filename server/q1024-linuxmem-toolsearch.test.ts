// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-linuxmem (customer report, Linux, Claude engine: "the bot tried twice to save to memory and both saves failed").
// Claude Code looks a deferred MCP tool up with its own ToolSearch before it calls it. That lookup is not outside content, but it
// was judged an outside tool and marked the turn. And every memory_save of a bot on Ask was held behind a "Review this change" card;
// answered or not, the held call ended with the turn stopped ("some of its context is no longer available"). MAIN-RULING memory:
// a bot saving to its own memory is never held.
// One row per tool name of that class (the CLI's own catalogue and to-do tools), each driven through a real turn of the Claude
// driver on a booted server: the fake CLI starts the tool, then the turn's own memory credential saves over HTTP.
// WebFetch is the control for the mark: a tool that does bring outside content in still marks the turn; its save is not held either.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

describe("q1024-linuxmem: a bot's own memory save is never held, and the CLI's own tool lookup is not outside content", () => {
  let fixture: VerificationServer;
  let headers: Record<string, string> = {};
  let model: string;
  let trigger: string;
  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
      process.env.FAKE_CLAUDE_ITEM_WHEN_FILE=process.env.MURAGE_DATA_DIR+'/q1024-item-trigger';
    ` });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await api("GET", "/api/desktop-secret")).body.secret };
    model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
    trigger = join(fixture.info.dataDir, "q1024-item-trigger");
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
  const marked = (threadId: string) => {
    try { return readFileSync(join(fixture.info.dataDir, "outside-state.jsonl"), "utf8").split("\n").some(line => { if (!line) return false; const row = JSON.parse(line); return row.k === "mark" && row.row.threadId === threadId; }); }
    catch { return false; }
  };

  it.each([
    // SITES.md rows 1-5: the CLI's own catalogue and to-do tools (local); row 6: the control
    ["ToolSearch", { query: "select:mcp__murage-memory__memory_save", max_results: 5 }, { marked: false }],
    ["TaskCreate", { subject: "Save the kettle name", description: "Save it to memory" }, { marked: false }],
    ["TaskGet", { taskId: "1" }, { marked: false }],
    ["TaskList", {}, { marked: false }],
    ["TaskUpdate", { taskId: "1", status: "completed" }, { marked: false }],
    ["WebFetch", { url: "https://example.invalid/outside", prompt: "read it" }, { marked: true }],
  ] as const)("%s then memory_save", async (tool, input, expected) => {
    const quote = `My kettle is called Brindle-${tool}.`;
    const bot = (await api("POST", "/api/bots", { name: `Kettle ${tool}`, modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200); // the level a new bot has, as on the customer rig
    const abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__fixture_hold_authority__ ${quote}` })).status).toBe(202);
      let memory: Record<string, string> | undefined;
      await expect.poll(() => {
        try {
          const servers = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))).mcpConfig?.mcpServers ?? {};
          const envs = Object.values(servers).map((server: any) => server?.env as Record<string, string> | undefined);
          if (envs.some(env => env?.MURAGE_BOT_ID === bot.id)) memory = envs.find(env => env?.MURAGE_MEMORY_TOKEN);
        } catch { /* this turn's launch is not written yet */ }
        return memory?.MURAGE_MEMORY_TOKEN;
      }, { timeout: 30_000 }).toBeTruthy();
      // the engine starts the tool; Murage has judged it once its activity row is in the conversation
      writeFileSync(trigger, JSON.stringify({ tool, input }));
      await expect.poll(async () => (await messages(bot.threadId)).some(message => message.tool?.name === tool), { timeout: 15_000 }).toBe(true);
      const save = async (signal: AbortSignal) => {
        for (;;) {
          const response = await fetch(new URL("/api/internal/memory/save", memory!.MURAGE_HARNESS_URL ?? fixture.info.url), { method: "POST", signal,
            headers: { authorization: `Bearer ${memory!.MURAGE_MEMORY_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ text: quote, evidence: [{ quote }], idempotencyKey: `q1024-${tool}` }) });
          // a refused turn answers in plain words, not JSON: keep them for the assertion's message
          const raw = await response.text(); let body: any; try { body = JSON.parse(raw); } catch { body = { raw }; }
          // the owner's message is captured in the background: only that documented answer is retried
          if (response.status === 409 && String(body.error).includes("Source capture is still pending")) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
          return { status: response.status, body };
        }
      };
      let settled: { status: number; body: any } | undefined;
      pending = save(abort.signal).then(result => { settled = result; });
      void pending.catch(() => {});
      let cards: any[] = [];
      await expect.poll(async () => {
        cards = (await messages(bot.threadId)).filter(message => message.card?.kind === "own-write" && message.card.writer?.tool === "memory_save");
        return cards.length > 0 || settled !== undefined;
      }, { timeout: 80_000 }).toBe(true);
      // base: the CLI's own lookup marked the turn, so what it saved was recorded as coming from outside
      expect({ tool, marked: marked(bot.threadId) }).toEqual({ tool, marked: expected.marked });
      // MAIN-RULING memory: a bot saving to its own memory is never held on a card, whatever the turn has read (base: held, no answer)
      expect({ held: cards.length > 0, status: settled?.status ?? null, saved: typeof settled?.body?.candidateId }, JSON.stringify(settled?.body ?? null)).toEqual({ held: false, status: 200, saved: "string" });
      // and the turn that saved is still there to say so (base: Murage stopped it once the card was answered)
      await new Promise(resolve => setTimeout(resolve, 1500));
      const after = await messages(bot.threadId);
      const stopped = after.filter(message => message.actorKind === "murage" && /I stopped this turn/.test(String(message.text ?? ""))).map(message => String(message.text));
      const busy = (await api("GET", `/api/bots/${bot.id}`)).body.bot.busy === true;
      expect({ tool, stopped, busy }).toEqual({ tool, stopped: [], busy: true });
    } finally {
      abort.abort();
      await pending?.catch(() => {});
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      for (const file of [trigger, `${trigger}.written`]) if (existsSync(file)) unlinkSync(file);
    }
  }, 150_000);

  // SITES.md row 7: the other held writer with a no-content acknowledgement. A lead's update of a bot, allowed by the owner.
  it("update_bot the owner allows reaches the bot and the turn carries on", async () => {
    const name = "Kettle lead";
    const lead = (await api("POST", "/api/bots", { name, section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    const target = (await api("POST", "/api/bots", { name: "Kettle specialist", section: name, modelSelection: { instanceId: "verification", model } })).body.bot;
    expect((await api("PATCH", `/api/bots/${lead.id}`, { chiefOfStaff: true, chiefScope: "section", computer: "off", browser: false, composio: false })).status).toBe(200);
    const abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      expect((await api("POST", `/api/bots/${lead.id}/messages`, { threadId: lead.threadId, text: `__fixture_hold_authority__ ${name}` })).status).toBe(202);
      let token: string | undefined;
      await expect.poll(() => {
        try { const env = withTurnSecrets(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"))).mcpConfig?.mcpServers?.agents?.env; if (env?.MURAGE_BOT_ID === lead.id) token = env.MURAGE_COMMS_TOKEN; } catch { /* this turn's launch is not written yet */ }
        return token;
      }, { timeout: 30_000 }).toBeTruthy();
      const manage = async (body: unknown, signal?: AbortSignal) => {
        const response = await fetch(fixture.info.url + "/api/internal/bot-management", { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        const raw = await response.text(); let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        return { status: response.status, body: parsed };
      };
      const original = await manage({ action: "get", targetBotId: target.id });
      expect(original.status, JSON.stringify(original.body)).toBe(200);
      let settled: { status: number; body: any } | undefined;
      pending = manage({ action: "update", targetBotId: target.id, revision: original.body.bot.revision, role: "Kettle keeper" }, abort.signal).then(result => { settled = result; });
      void pending.catch(() => {});
      let cards: any[] = [];
      await expect.poll(async () => {
        cards = (await messages(lead.threadId)).filter(message => message.card?.kind === "own-write" && message.card.writer?.tool === "update_bot");
        return cards.length > 0 || settled !== undefined;
      }, { timeout: 20_000 }).toBe(true);
      expect({ held: cards.length > 0, answered: settled !== undefined }).toEqual({ held: true, answered: false });
      expect((await api("POST", `/api/threads/${lead.threadId}/respond`, { requestId: cards[0].card.requestId, behavior: "allow", stateRevision: cards[0].card.writer.stateRevision })).status).toBe(200);
      await pending;
      await new Promise(resolve => setTimeout(resolve, 1500));
      const stopped = (await messages(lead.threadId)).filter(message => message.actorKind === "murage" && /I stopped this turn/.test(String(message.text ?? ""))).map(message => String(message.text));
      const busy = (await api("GET", `/api/bots/${lead.id}`)).body.bot.busy === true;
      expect({ status: settled?.status, stopped, busy }, JSON.stringify(settled?.body).slice(0, 300)).toEqual({ status: 200, stopped: [], busy: true });
    } finally {
      abort.abort();
      await pending?.catch(() => {});
      await api("POST", `/api/bots/${lead.id}/interrupt`, { threadId: lead.threadId });
    }
  }, 90_000);
});
