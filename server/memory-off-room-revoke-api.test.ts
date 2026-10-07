// OFF rooms submit only what the content rule allows at the write (round 4,
// item 2). A room member's reply X' is made with memory (X) while memory is
// active. Memory is switched off, and the next room turn is sent: its
// transcript is read before setup, which resets the member's retained
// session (it was shown memory). X is revoked while that reset is under way.
// The prompt the engine receives must not carry X': the transcript is rebuilt
// after the reset, and every write is fenced in every mode.
//
// Real server, the repository's fake Claude CLI. Its exit gate is never
// opened, so the reset waits out the driver's close grace and the CLI's
// SIGTERM delay: a window of several seconds in which the test revokes X.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const botReplies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const REPLIES = ["R1-NOTED the gate", "R2-XPRIME the gate is green", "R3-ANSWER", "R4-ANSWER", "R5-ANSWER", "R6-ANSWER"];

posixOnly("memory off: a room member is never handed a line revoked during its setup", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const { join } = await import('node:path');
      const { mkdirSync } = await import('node:fs');
      process.env.FAKE_CLAUDE_DUMP_LOG = join(process.env.MURAGE_DATA_DIR, 'claude-turns.jsonl');
      process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify(REPLIES))};
      process.env.FAKE_CLAUDE_REPLY_STATE = join(process.env.MURAGE_DATA_DIR, 'reply-state');
      process.env.FAKE_CLAUDE_EXIT_GATE_DIR = join(process.env.MURAGE_DATA_DIR, 'exit-gates');
      process.env.FAKE_CLAUDE_SIGTERM_DELAY_MS = '2500';
      mkdirSync(process.env.FAKE_CLAUDE_EXIT_GATE_DIR, { recursive: true });
    ` });
    mkdirSync(join(fixture.info.dataDir, "exit-gates"), { recursive: true });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); }, 60000);

  const query = <T>(sql: string, ...params: string[]): T[] => {
    const handle = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return handle.prepare(sql).all(...params) as T[]; } finally { handle.close(); }
  };
  const pendingJobs = () => Number(query<{ n: number }>("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')")[0]!.n);
  const prompts = (): string[] => {
    const file = join(fixture.info.dataDir, "claude-turns.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => String(JSON.parse(line).prompt ?? "")) : [];
  };

  it("rebuilds the transcript after the reset and fences the write: X' never reaches the engine", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const created = await api("POST", "/api/bots", { name: "Gate keeper" });
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    // X: something the owner told the bot
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "remember: the garden gate is green" })).status).toBeLessThan(300);
    await expect.poll(async () => (await botReplies(bot.threadId)).length, { timeout: 20000 }).toBe(1);
    await expect.poll(pendingJobs, { timeout: 30000 }).toBe(0);

    const room = (await api("POST", "/api/groups", { name: "Gate room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group as { id: string; threadId: string };
    const idle = async () => { const state = (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === room.id); return !state.working && !state.busyBotId; };
    // X': the member's room reply, made with X while memory is active. Its
    // engine process is closed when the turn ends and, held by the exit gate,
    // takes the close grace plus its SIGTERM delay to go.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "what colour is the garden gate?" })).status).toBe(202);
    await expect.poll(async () => (await botReplies(room.threadId)).length, { timeout: 30000 }).toBe(1);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    const xPrime = (await botReplies(room.threadId))[0]!;
    const receipts = query<{ source_versions: string }>("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' AND output_message_ids LIKE ?", room.threadId, `%${xPrime.id}%`);
    const given = [...new Set(receipts.flatMap(row => (JSON.parse(row.source_versions) as Array<{ id: string }>).map(source => source.id)))];
    expect(given.length).toBeGreaterThan(0);

    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    const promptsBefore = prompts().length;
    // The OFF turn: its transcript is read as it starts (X' still allowed),
    // then setup resets the member's retained session (it was shown memory),
    // which waits for that closing process.
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "and say it once more" })).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === room.id).busyBotId, { timeout: 10000, interval: 20 }).toBe(bot.id);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(prompts().length).toBe(promptsBefore);
    // X is revoked while the reset is still under way
    for (const id of given) expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id })).status).toBe(200);
    expect(prompts().length).toBe(promptsBefore);
    await expect.poll(async () => (await botReplies(room.threadId)).length, { timeout: 40000 }).toBe(2);
    await expect.poll(idle, { timeout: 30000 }).toBe(true);
    const offPrompts = prompts().slice(promptsBefore);
    expect(offPrompts.length).toBeGreaterThan(0);
    for (const prompt of offPrompts) {
      expect(prompt).toContain("say it once more");
      expect(prompt).not.toContain(xPrime.text);
    }
  }, 180000);
});
