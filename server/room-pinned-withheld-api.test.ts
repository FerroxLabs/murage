// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 third check, P1, through the real server and a fake engine that
// records every prompt. The owner pinned the room's notes (its checkpoint)
// after forgetting something a reply in those notes rested on. The pinned
// note still reached every bot, the withheld reply's words included, and
// every later reply made with it was withheld in turn, so teammates stopped
// seeing each other until the pin was removed. A pinned note resting on a
// reply bots no longer see is now left out, Murage says so once in the room,
// and later replies stay visible.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const groupState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const prompts = (): string[] => {
  const file = join(fixture.info.dataDir, "pi-dump.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.prompt).map(row => String(row.message)) : [];
};
const PIN_NOTE = "Bots were not given a pinned note: it uses a reply they no longer see. Unpin it in Memory, then pin a newer one if you still want it.";

posixOnly("a pinned room note resting on a withheld reply", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piDump={driver:'piAgent',displayName:'Recording pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl'),FAKE_PI_UNIQUE:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("is not handed to bots, Murage says so once, and later replies stay visible", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piDump").models.options;
    const bot = async (name: string) => {
      const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "piDump", model: models[0].id } });
      expect(created.status).toBe(201);
      const bot = created.body.bot as { id: string; threadId: string };
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
      return bot;
    };
    const alpha = await bot("Alpha"), bravo = await bot("Bravo");
    const created = await api("POST", "/api/groups", { name: "Pinned notes room", memberIds: [alpha.id, bravo.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: alpha.id } } });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const idle = async () => { const state = await groupState(room.id); return !state.working && !state.busyBotId; };
      const pendingJobs = () => Number((db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(room.threadId) as { n: number }).n);
      const repliesBy = async (botId: string) => (await messages(room.threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text && message.from?.botId === botId);
      const send = async (text: string) => {
        expect((await api("POST", `/api/groups/${room.id}/messages`, { text })).status).toBe(202);
        await expect.poll(idle, { timeout: 20000 }).toBe(true);
        await expect.poll(() => pendingJobs(), { timeout: 20000 }).toBe(0);
      };
      const checkpoint = () => db.prepare("SELECT r.id,r.version,r.text FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=? AND r.state='active' ORDER BY r.version DESC LIMIT 1").get(room.threadId) as { id: string; version: number; text: string } | undefined;

      const evidenceOf = (id: string, version: number) => (db.prepare("SELECT e.source_id AS id,s.speaker FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=?").all(id, version) as Array<{ id: string; speaker: string }>);
      // Something to forget: an ask that a reply quoted in the room's current
      // notes was made with (through the notes that reply was given), while
      // the current notes no longer cite that ask. Forgetting it withholds the
      // reply from bots, and the current notes still quote the reply.
      const candidate = async () => {
        const current = checkpoint();
        if (!current) return undefined;
        const now = new Set(evidenceOf(current.id, current.version).map(row => row.id));
        for (const reply of (await repliesBy(alpha.id)).reverse()) {
          if (!current.text.includes(reply.text)) continue;
          const receipts = db.prepare("SELECT record_versions FROM memory_disclosures WHERE thread_id=? AND output_message_ids LIKE ?").all(room.threadId, `%${reply.id}%`) as Array<{ record_versions: string }>;
          const used = receipts.flatMap(receipt => (JSON.parse(receipt.record_versions) as Array<{ id: string; version: number }>).flatMap(row => evidenceOf(row.id, row.version)));
          const ask = used.find(row => row.speaker === "owner" && !now.has(row.id));
          if (ask) return { current, reply, ask: ask.id };
        }
        return undefined;
      };
      // Rounds of questions: each of Alpha's replies is made with the room's notes.
      let found: Awaited<ReturnType<typeof candidate>>;
      for (let round = 1; round <= 8 && !found; round++) {
        await send(`question ${round} about the garden`);
        await expect.poll(async () => (await repliesBy(alpha.id)).length, { timeout: 15000 }).toBe(round);
        found = await candidate();
      }
      expect(found).toBeDefined();
      const alphaReplies = await repliesBy(alpha.id);
      expect(new Set(alphaReplies.map(reply => reply.text)).size).toBe(alphaReplies.length);
      expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: found!.ask })).status).toBe(200);
      const notes = checkpoint()!;
      expect(notes).toMatchObject({ id: found!.current.id, version: found!.current.version });
      // the reply the notes quote, which bots no longer see
      const hidden = found!.reply;
      expect(notes.text).toContain(hidden.text);

      // The owner pins the room's notes as they are now.
      const pinned = await api("POST", "/api/memory/action", { action: "pin", id: notes.id, version: notes.version, pinned: true });
      expect(pinned.status).toBe(200);

      // Next round: no bot is handed the pinned note or the withheld words.
      const beforeFourth = prompts().length;
      await send("fourth question about the garden");
      const fourthPrompts = prompts().slice(beforeFourth);
      expect(fourthPrompts.length).toBeGreaterThan(0);
      for (const prompt of fourthPrompts) {
        expect(prompt).not.toContain("pinned by the owner");
        expect(prompt).not.toContain(hidden.text);
      }
      // Murage tells the owner, once, in plain words, with no raw code.
      const noticeCount = async () => (await messages(room.threadId)).filter(message => message.kind === "activity" && !message.from && message.tool?.name === PIN_NOTE).length;
      expect(await noticeCount()).toBe(1);
      const fourthReply = (await repliesBy(alpha.id)).at(-1)!;
      expect(fourthReply.text).not.toBe(alphaReplies.at(-1)!.text);

      // Bravo's turn next: Alpha's fourth reply is not withheld, and Bravo
      // reads it; the pinned note is still not handed over, and the notice
      // is not repeated.
      const beforeFifth = prompts().length;
      await send("@Bravo what do you make of Alpha's last answer?");
      await expect.poll(async () => (await repliesBy(bravo.id)).length, { timeout: 15000 }).toBe(1);
      const bravoPrompt = prompts().slice(beforeFifth).at(-1)!;
      expect(bravoPrompt).toContain(`Alpha: ${fourthReply.text}`);
      expect(bravoPrompt).not.toContain("pinned by the owner");
      expect(bravoPrompt).not.toContain(hidden.text);
      const shown = await messages(room.threadId);
      expect(shown.find(message => message.id === fourthReply.id).withheldFromBots).toBeUndefined();
      expect(shown.find(message => message.role === "bot" && message.from?.botId === bravo.id && message.kind === "text").withheldFromBots).toBeUndefined();
      expect(await noticeCount()).toBe(1);
      expect(JSON.stringify(shown)).not.toMatch(/MEMORY_/);
    } finally { db.close(); }
  }, 240000);
});
