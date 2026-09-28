// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 transcript fix (R-A) through the real server and a fake engine that
// records every prompt it receives. In a room with memory on, adding a bot to
// the workspace revoked every memory receipt in the install, and the next
// member's prompt lost every teammate reply (the "roster change" simulation
// fell from 1.00 to 0.60). The reply now stays. A reply that used something
// the owner then forgot is shown to the next member as a withheld line with
// its author and time, and the owner's copy is marked, never removed.
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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const prompts = (): string[] => {
  const file = join(fixture.info.dataDir, "pi-dump.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.prompt).map(row => String(row.message)) : [];
};

posixOnly("a room member reads every teammate reply after a roster change", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piDump={driver:'piAgent',displayName:'Recording pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("keeps teammate replies through a roster change and withholds, visibly, a reply that used something forgotten", async () => {
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
    const created = await api("POST", "/api/groups", { name: "Transcript room", memberIds: [alpha.id, bravo.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: alpha.id } } });
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

      const checkpoint = () => db.prepare("SELECT r.state FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=? ORDER BY r.version DESC LIMIT 1").get(room.threadId) as { state: string } | undefined;
      const receiptFor = (messageId: string) => db.prepare("SELECT state,record_versions FROM memory_disclosures WHERE thread_id=? AND output_message_ids LIKE ? ORDER BY created_at DESC LIMIT 1").get(room.threadId, `%${messageId}%`) as { state: string; record_versions: string } | undefined;

      // Alpha answers twice, each under a memory receipt linked to the reply;
      // the second one's recall carries the room checkpoint, which cites the
      // owner's first message.
      await send("first question");
      await expect.poll(async () => (await repliesBy(alpha.id)).length, { timeout: 15000 }).toBe(1);
      await expect.poll(() => checkpoint()?.state, { timeout: 20000 }).toBe("active");
      // the version a dispatch of the next turn can select: it cites the
      // owner's first message and not the reply that turn will produce
      const selectable = db.prepare("SELECT r.id,r.version FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.owner_key=? AND r.state='active'").get(room.threadId) as { id: string; version: number };
      await send("second question");
      await expect.poll(async () => (await repliesBy(alpha.id)).length, { timeout: 15000 }).toBe(2);
      const [first, second] = await repliesBy(alpha.id);
      expect(receiptFor(first.id)?.state).toBe("delivered");
      if (!JSON.parse(receiptFor(second.id)!.record_versions).length) {
        // 0.1.60 counts the reference frame inside the recall share, so at
        // this engine's context size the checkpoint does not fit (fixed on
        // next/0161 by c43022db). Give the receipt the checkpoint the reply
        // would have used, so the forget below reaches it on either base.
        const writer = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
        try { writer.prepare("UPDATE memory_disclosures SET record_versions=? WHERE thread_id=? AND output_message_ids LIKE ? AND output_message_ids NOT LIKE ?").run(JSON.stringify([{ id: selectable.id, version: selectable.version }]), room.threadId, `%${second.id}%`, `%${first.id}%`); }
        finally { writer.close(); }
      }
      expect(JSON.parse(receiptFor(second.id)!.record_versions).length).toBeGreaterThan(0);

      // The roster changes: a bot is added to the workspace. Every receipt in
      // the install is revoked, the ones on Alpha's replies included.
      await bot("Charlie");
      await expect.poll(() => receiptFor(first.id)?.state, { timeout: 10000 }).toBe("revoked");

      // Bravo's next prompt still carries both of Alpha's replies.
      const before = prompts().length;
      await send("@Bravo what do you make of Alpha's answers?");
      await expect.poll(async () => (await repliesBy(bravo.id)).length, { timeout: 15000 }).toBe(1);
      const bravoPrompt = prompts().slice(before).at(-1)!;
      expect(bravoPrompt.split("\n").filter(line => line === "Alpha: Hello from pi").length).toBe(2);
      expect(bravoPrompt).not.toContain("Reply withheld");

      // The owner forgets their first message. Alpha's second reply used it
      // (through the checkpoint); the first did not.
      const owner = (await messages(room.threadId)).find(message => message.role === "user" && message.text === "first question");
      const forgot = await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: `message:${room.threadId}:${owner.id}` });
      expect(forgot.status).toBe(200);

      const afterForget = prompts().length;
      await send("@Bravo and now?");
      await expect.poll(async () => (await repliesBy(bravo.id)).length, { timeout: 15000 }).toBe(2);
      const lastPrompt = prompts().slice(afterForget).at(-1)!;
      // a visible withheld line, with author and time, where the reply was
      const stamp = new Date(second.at).toISOString().slice(0, 16).replace("T", " ");
      expect(lastPrompt).toContain(`[Reply withheld: it used something you deleted or changed] (Alpha, ${stamp} UTC)`);
      expect(lastPrompt.split("\n").filter(line => line === "Alpha: Hello from pi").length).toBe(1);
      // the owner's own words are never withheld
      expect(lastPrompt).toContain("User: first question");
      // the owner keeps the reply, marked; the other reply is not marked
      const shown = await messages(room.threadId);
      expect(shown.find(message => message.id === second.id)).toMatchObject({ text: "Hello from pi", withheldFromBots: true });
      expect(shown.find(message => message.id === first.id).withheldFromBots).toBeUndefined();
    } finally { db.close(); }
  }, 180000);
});
