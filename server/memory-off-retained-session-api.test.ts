// Session revocation does not depend on the recall mode (round 3, item 2).
// Trace: X is disclosed to a resumed engine session while memory is active,
// memory is switched off, X is revoked, and a direct turn is sent. The engine
// session that was shown X must not be resumed: the turn resets it and
// replays only what the content rule allows now.
//
// Real server, the repository's fake Claude CLI, the turn trace on.
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

posixOnly("memory off: a retained session that was shown revoked memory is not resumed", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.MURAGE_TURN_TRACE = '1'; process.env.FAKE_CLAUDE_DUMP = (await import('node:path')).join(process.env.MURAGE_DATA_DIR, 'claude-dump.json'); process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';" });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const db = () => new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  const pendingJobs = (threadId: string) => {
    const handle = db();
    try { return Number((handle.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(threadId) as { n: number }).n); }
    finally { handle.close(); }
  };
  const givenSources = (threadId: string) => {
    const handle = db();
    try {
      const rows = handle.prepare("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered'").all(threadId) as Array<{ source_versions: string }>;
      return [...new Set(rows.flatMap(row => (JSON.parse(row.source_versions) as Array<{ id: string }>).map(source => source.id)))];
    } finally { handle.close(); }
  };
  const turn = async (bot: { id: string; threadId: string }, text: string) => {
    const answered = (await replies(bot.threadId)).length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBeLessThan(300);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 20000 }).toBe(answered + 1);
    await expect.poll(() => pendingJobs(bot.threadId), { timeout: 30000 }).toBe(0);
  };
  const argv = (): string[] => JSON.parse(readFileSync(join(fixture.info.dataDir, "claude-dump.json"), "utf8")).argv;
  const dispatches = (threadId: string) => log().split("\n").filter(line => line.includes(`claude dispatch thread=${threadId} `));

  it("disclose X while active, switch memory off, revoke X, send a direct turn: the session resets", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const created = await api("POST", "/api/bots", { name: "Off switch bot" });
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    await turn(bot, "the garden gate is green");
    await turn(bot, "and the shed is blue");
    // the second turn resumed the first one's session
    expect(argv()).toContain("--resume");
    const shownSession = argv()[argv().indexOf("--resume") + 1];
    expect(log()).toMatch(/phase=memory\.assemble.*resumed=true/);
    const given = givenSources(bot.threadId);
    expect(given.length).toBeGreaterThan(0);
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "off" })).status).toBe(200);
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("off");
    for (const id of given) expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id })).status).toBe(200);
    const before = dispatches(bot.threadId).length;
    await turn(bot, "what colour is the gate");
    const latest = dispatches(bot.threadId).slice(before);
    expect(latest).toHaveLength(1);
    // not resumed: the retained session was reset, and a new one started
    expect(latest[0]).not.toContain("process=reused");
    expect(argv()).not.toContain(shownSession);
    expect(log()).toMatch(new RegExp(`memory continuation reset thread=${bot.threadId} engine=\\S+ reason=memory-off`));
  }, 120000);
});
