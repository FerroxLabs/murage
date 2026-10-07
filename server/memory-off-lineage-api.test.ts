// Output lineage with memory off (round 3, item 3; memory schema v6). An OFF
// turn paraphrases a reply that was made with memory and is still allowed.
// X is revoked with memory still off. The paraphrase is withheld from the
// next turn, and that turn does not resume the session that was shown it.
//
// Real server, the repository's fake Claude CLI with scripted replies.
import { existsSync, readFileSync } from "node:fs";
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
const replies = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).filter(message => message.role === "bot" && message.kind === "text" && message.text);
const log = () => existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
const REPLIES = ["X-PRIME the gate is green", "SECOND answer", "PARAPHRASE-Y the gate is green", "FOURTH answer"];

posixOnly("memory off: a paraphrase of a memory-derived reply follows its source", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const { join } = await import('node:path');
      process.env.FAKE_CLAUDE_DUMP = join(process.env.MURAGE_DATA_DIR, 'claude-dump.json');
      process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
      process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify(REPLIES))};
      process.env.FAKE_CLAUDE_REPLY_STATE = join(process.env.MURAGE_DATA_DIR, 'reply-state');
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const query = <T>(sql: string, ...params: string[]): T[] => {
    const handle = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try { return handle.prepare(sql).all(...params) as T[]; } finally { handle.close(); }
  };
  const pendingJobs = (threadId: string) => Number(query<{ n: number }>("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')", threadId)[0]!.n);
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    const answered = (await replies(bot.threadId)).length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBeLessThan(300);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 20000 }).toBe(answered + 1);
    await expect.poll(() => pendingJobs(bot.threadId), { timeout: 30000 }).toBe(0);
    return (await replies(bot.threadId)).at(-1) as { id: string; text: string };
  };
  const dump = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "claude-dump.json"), "utf8")) as { argv: string[]; prompt: unknown };

  it("an OFF paraphrase of X' is withheld once X is revoked, and the next turn starts over", async () => {
    const created = await api("POST", "/api/bots", { name: "Lineage bot" });
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    // X is disclosed while memory is active, and X' is made under that receipt
    const xPrime = await turn(bot, "the garden gate is green");
    expect(xPrime.text).toContain("X-PRIME");
    await turn(bot, "and the shed is blue");
    const given = [...new Set(query<{ source_versions: string }>("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered'", bot.threadId)
      .flatMap(row => (JSON.parse(row.source_versions) as Array<{ id: string }>).map(source => source.id)))];
    expect(given.length).toBeGreaterThan(0);
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    // memory off: the turn is shown X' (still allowed) and paraphrases it
    const y = await turn(bot, "say that again in other words");
    expect(y.text).toContain("PARAPHRASE-Y");
    expect(JSON.stringify(dump().prompt)).toContain("X-PRIME");
    // Y rests on X' (its root), recorded with memory off
    expect(query<{ root_message_id: string }>("SELECT m.root_message_id FROM memory_output_roots o JOIN memory_root_set_members m ON m.set_id=o.set_id WHERE o.thread_id=? AND o.message_id=?", bot.threadId, y.id).map(row => row.root_message_id)).toContain(xPrime.id);
    const ySession = dump().argv[dump().argv.indexOf("--session-id") + 1] ?? dump().argv[dump().argv.indexOf("--resume") + 1];
    expect(ySession).toBeTruthy();
    // X is revoked with memory still off
    for (const id of given) expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id })).status).toBe(200);
    const next = await turn(bot, "what colour is the gate");
    expect(next.text).toContain("FOURTH");
    const prompt = JSON.stringify(dump().prompt);
    // the paraphrase and its source are withheld from the next turn's replay
    expect(prompt).not.toContain("PARAPHRASE-Y");
    expect(prompt).not.toContain("X-PRIME");
    // and the session that was shown X' was not resumed
    expect(dump().argv).not.toContain(ySession);
    expect(log()).toMatch(new RegExp(`memory continuation reset thread=${bot.threadId} engine=\\S+ reason=memory-off session-roots`));
  }, 120000);
});
