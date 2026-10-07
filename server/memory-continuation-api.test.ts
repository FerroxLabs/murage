// A turn resumes the engine session it already has unless something the
// session was given has stopped being usable. The thread's own checkpoint
// rolls on every captured message, so a changed memory frame alone (new
// checkpoint version, new recall hits) is not an invalidation: an ordinary
// appended conversation keeps the session, the changed frame rides on the
// prompt (harness/memory-adapter.ts), and the bundle is built once per
// dispatch. A deletion of evidence the session was given, a roster/policy
// change that revokes its receipts, and an unproven session each still end
// the session and replay authorized history.
//
// Real server, memory active, the repository's fake Claude CLI, with the turn
// trace on: its lines say whether each turn resumed (memory.assemble) and how
// many bundles it built (memory.bundle.built, one per buildMemoryBundle).
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
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const replies = async (threadId: string) => (await messages(threadId)).filter(message => message.role === "bot" && message.kind === "text" && message.text);

type Turn = { id: string; resumed?: boolean; built: number };
/** Every traced dispatch that reached memory assembly, in order. */
const turns = (): Turn[] => {
  const byId = new Map<string, Turn>(), order: string[] = [];
  const log = existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "";
  for (const line of log.split("\n")) {
    const match = /^\[turn-trace\] id=(\w+) phase=(\S+)(.*)$/.exec(line);
    if (!match) continue;
    const [, id, phase, rest] = match;
    let turn = byId.get(id!);
    if (!turn) { turn = { id: id!, built: 0 }; byId.set(id!, turn); order.push(id!); }
    if (phase === "memory.bundle.built") turn.built++;
    if (phase === "memory.assemble") turn.resumed = /resumed=true/.test(rest!);
  }
  return order.map(id => byId.get(id)!).filter(turn => turn.resumed !== undefined);
};

posixOnly("a memory-active thread keeps its engine session across ordinary turns", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: "process.env.MURAGE_TURN_TRACE = '1';" });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  const createBot = async (name: string) => {
    const created = await api("POST", "/api/bots", { name });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    return bot;
  };
  const db = () => new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  const checkpointVersion = (threadId: string) => {
    const handle = db();
    try { return Number((handle.prepare("SELECT max(r.version) AS v FROM memory_records r JOIN memory_scopes s ON s.id=r.scope_id WHERE r.kind='checkpoint' AND s.kind='conversation' AND s.owner_key=?").get(threadId) as { v: number | null }).v ?? 0); }
    finally { handle.close(); }
  };
  const pendingJobs = (threadId: string) => {
    const handle = db();
    try { return Number((handle.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status NOT IN ('complete','cancelled','failed')").get(threadId) as { n: number }).n); }
    finally { handle.close(); }
  };
  /** One turn, run to its reply and to the worker having captured it, so the
   * next dispatch sees the rolled checkpoint. Returns that turn's trace. */
  const turn = async (bot: { id: string; threadId: string }, text: string): Promise<Turn> => {
    const before = turns().length, answered = (await replies(bot.threadId)).length;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBeLessThan(300);
    await expect.poll(async () => (await replies(bot.threadId)).length, { timeout: 20000 }).toBe(answered + 1);
    await expect.poll(() => pendingJobs(bot.threadId), { timeout: 30000 }).toBe(0);
    await expect.poll(() => turns().length, { timeout: 5000 }).toBe(before + 1);
    return turns()[before]!;
  };
  /** The sources the thread's latest delivered frame cited. */
  const givenSources = (threadId: string) => {
    const handle = db();
    try {
      const row = handle.prepare("SELECT source_versions FROM memory_disclosures WHERE thread_id=? AND state='delivered' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId) as { source_versions: string } | undefined;
      return row ? JSON.parse(row.source_versions) as Array<{ id: string; revision: number }> : [];
    } finally { handle.close(); }
  };

  it("resumes on ordinary appended turns and builds one bundle per dispatch", async () => {
    expect((await api("GET", "/api/memory/status")).body.mode).toBe("active");
    const bot = await createBot("Continuing bot");
    const first = await turn(bot, "the garden gate is green");
    const rolled = checkpointVersion(bot.threadId);
    const second = await turn(bot, "and the shed is blue");
    // the checkpoint really did roll between the two dispatches
    expect(checkpointVersion(bot.threadId)).toBeGreaterThan(rolled);
    const third = await turn(bot, "what colour is the gate");
    expect(first).toMatchObject({ resumed: false, built: 1 });
    expect(second).toMatchObject({ resumed: true, built: 1 });
    expect(third).toMatchObject({ resumed: true, built: 1 });
  }, 120000);

  it("ends the session when a bot is added to the roster", async () => {
    // policy.ts treats any added bot as a roster change: the policy revision
    // moves and every receipt is revoked, so no session outlives it.
    const bot = await createBot("Roster bystander");
    await turn(bot, "first");
    expect((await turn(bot, "second")).resumed).toBe(true);
    await createBot("Newcomer");
    expect(await turn(bot, "third")).toMatchObject({ resumed: false, built: 1 });
  }, 120000);

  it("ends the session when evidence it was given is forgotten", async () => {
    const bot = await createBot("Forgetting bot");
    await turn(bot, "the garden gate is green");
    const kept = await turn(bot, "and the shed is blue");
    expect(kept.resumed).toBe(true);
    const given = givenSources(bot.threadId);
    expect(given.length).toBeGreaterThan(0);
    for (const source of given) expect((await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: source.id })).status).toBe(200);
    const after = await turn(bot, "what do you remember");
    expect(after).toMatchObject({ resumed: false, built: 1 });
    // nothing forgotten stays usable: the new frame cites none of it
    const forgotten = new Set(given.map(source => source.id));
    expect(givenSources(bot.threadId).filter(source => forgotten.has(source.id))).toEqual([]);
  }, 120000);

  it("ends the session when a bot is removed from the roster", async () => {
    const bot = await createBot("Roster bot");
    const other = await createBot("Departing bot");
    await turn(bot, "first");
    expect((await turn(bot, "second")).resumed).toBe(true);
    expect((await api("DELETE", `/api/bots/${other.id}`)).status).toBeLessThan(300);
    expect(await turn(bot, "third")).toMatchObject({ resumed: false, built: 1 });
  }, 120000);
});
