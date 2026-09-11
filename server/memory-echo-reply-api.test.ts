// MEMJSON1 (smoke round 1, feature 15): a Flux Auto turn answered with only
// {"sourceId":"message:reply","revision":1,"startByte":0,"endByte":4} — the
// model copied Murage's own memory provenance instead of replying "pong".
// The prompt no longer carries that JSON (server/memory/reference-delivery
// .test.ts); this proves the defensive half through the real server: a
// completed reply that is nothing but provenance JSON is not presented as the
// answer. The thread gets a retryable error row, the turn settles as failed,
// the bot goes idle, and the very next turn answers normally.
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
const ECHO = '{"sourceId":"message:reply","revision":1,"startByte":0,"endByte":4}';
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
// Bot rows produced by engine turns (the creation greeting has no turn).
const botRows = (rows: any[]) => rows.filter(message => message.role === "bot" && message.turnId);
/** Terminal memory settlements for the thread's turns, in capture order. */
const turnOutcomes = (threadId: string): string[] => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn' AND outcome!='working' ORDER BY rowid").all(threadId) as Array<{ outcome: string }>).map(row => row.outcome);
  } finally { db.close(); }
};

posixOnly("a reply that only copies memory provenance JSON is not the answer", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.echo={driver:'claudeAgent',displayName:'Echo fixture',config:{cli:${JSON.stringify(FAKE_CLAUDE)}},
        environment:{FAKE_CLAUDE_REPLIES:${JSON.stringify(JSON.stringify([ECHO, "pong"]))},FAKE_CLAUDE_REPLY_STATE:path.join(process.env.MURAGE_DATA_DIR,'reply-state')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("shows a retryable notice instead of the JSON, settles failed, and the next turn answers", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "echo").models.options;
    const created = await api("POST", "/api/bots", { name: "Echo fixture", modelSelection: { instanceId: "echo", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);

    // Turn 1: the engine's only text item is the provenance handle.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Reply with exactly the single word: pong" })).status).toBe(202);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
    const afterEcho = botRows(await messages(bot.threadId));
    // Nothing shown as an answer carries the JSON; the notice names the problem and says retry.
    expect(afterEcho.filter(message => message.kind === "text").map(message => message.text)).not.toContain(ECHO);
    expect(afterEcho.some(message => message.kind === "text" && message.turnTerminal)).toBe(false);
    const notice = afterEcho.find(message => message.kind === "activity" && message.tool?.ok === false && /memory references/i.test(String(message.tool?.name)));
    expect(notice, JSON.stringify(afterEcho)).toBeTruthy();
    expect(String(notice.tool.name)).toMatch(/^error: /);
    expect(String(notice.tool.name)).toMatch(/retry/i);
    expect(notice.tool.errorDetails).toBe(ECHO);
    // Memory settlement records the turn as failed, not completed.
    expect(turnOutcomes(bot.threadId)).toEqual(["failed"]);

    // Turn 2: an ordinary reply lands as the terminal answer, untouched.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Reply with exactly the single word: pong" })).status).toBe(202);
    await expect.poll(async () => botRows(await messages(bot.threadId)).some(message => message.kind === "text" && message.text === "pong" && message.turnTerminal), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
    const all = botRows(await messages(bot.threadId));
    expect(all.filter(message => message.kind === "text").map(message => message.text)).toEqual(["pong"]);
    expect(turnOutcomes(bot.threadId)).toEqual(["failed", "completed"]);
  });
});
