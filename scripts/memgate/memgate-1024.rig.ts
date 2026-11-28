// q1024-memgate rig (owner: q1024-memgate; rulings: MAIN). Lives in _small/bannergate-rig, copied into a temp export of the tree under
// test by _small/memgate.sh; never committed to the product. Same private-data rules as bannergate-1023.test.ts: this file never prints,
// logs or stores message text; it writes counts, codes, durations and 8-char hashes only. The fixture sentences below are synthetic.
//
// REAL-DATA MEMORY GATE (MAIN 2026-11-27): on /data/snap/messages.db (a copy of the owner's real store) with the normal start-up background
// work running (no settle wait after listen), a real engine turn on the owner's busiest real bot SAVES 3 memories through the bot's own
// mounted memory_save tool (the engine's own MCP shim, reached through the fixture tool mailbox of the fake engine, as
// server/memory/field-replay/harness.ts does): zero refusals, no approval card, the turn is not stopped. It then recalls the 3 by the
// mounted memory_search tool (FULL search: no partial, no keyword recallMode, nothing missed) within a time budget, and again after a restart.
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";
import { raiseLevel } from "./testing/raise-level.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const SEARCH_BUDGET_MS = Number(process.env.MG_SEARCH_BUDGET_MS ?? 5000);
const RECALL_BUDGET_MS = Number(process.env.MG_RECALL_BUDGET_MS ?? 30_000);
const SAVE_BUDGET_MS = Number(process.env.MG_SAVE_BUDGET_MS ?? 30000);
const RETRY_WINDOW_MS = Number(process.env.MG_RETRY_WINDOW_MS ?? 120_000);
const home = "/data/home", dataDir = join(home, ".murage"), MAILBOX = "/data/mailbox";
const OUT = "/data/out.txt", RESULT = "/data/result.json", LOG = "/data/server.log", TURNS = "/data/turns.jsonl", GATE = "/data/release", ANSWER = "/data/answer.txt";
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const DESKTOP_PROOF = "cd".repeat(32);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_PROOF };
const h8 = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 8);
const note = (line: string) => { const text = `${new Date().toISOString()} ${line}\n`; appendFileSync(OUT, text); process.stdout.write(text); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const FACTS = [
  { token: "kestrel4417", sentence: "The gate fixture marker kestrel4417 means the blue folder." },
  { token: "marlin8830", sentence: "The gate fixture marker marlin8830 means the late shipment." },
  { token: "osprey2951", sentence: "The gate fixture marker osprey2951 means the spare key." },
];
type Reply = { isError?: boolean; text: string; ms: number };

describe("q1024-memgate: the real-data memory gate", () => {
  let child: ChildProcess | undefined;
  let output = "", allOutput = "";
  async function boot(label: string): Promise<number> {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: dataDir, MURAGE_PORT: String(PORT), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_PROOF };
    if (process.env.PATH) env.PATH = process.env.PATH;
    const started = Date.now();
    appendFileSync(LOG, `\n===== ${label} ${new Date().toISOString()} =====\n`);
    child = spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), env: { ...env, ...powerBlockTestEnv() }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => { output += chunk; allOutput += chunk; appendFileSync(LOG, chunk); });
    child.stdout!.on("data", chunk => { output += chunk; allOutput += chunk; appendFileSync(LOG, chunk); });
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return Date.now() - started; } catch { /* not up yet */ }
      if (Date.now() - started > 900_000) throw new Error(`${label}: server never came up`);
      if (child.exitCode !== null) throw new Error(`${label}: server exited ${child.exitCode} before listen`);
      await sleep(100);
    }
  }
  async function stop(): Promise<number | null> {
    const proc = child!;
    if (proc.exitCode !== null) return proc.exitCode;
    const done = new Promise<number | null>(resolve => proc.once("exit", code => resolve(code)));
    proc.kill("SIGTERM");
    const code = await Promise.race([done, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 60_000))]);
    if (code === "hung") { proc.kill("SIGKILL"); await done; return -9; }
    return code;
  }
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...DESKTOP_HEADERS }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body?.messages ?? []) as any[];
  const dumps = (): any[] => { try { return readFileSync(TURNS, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const pendingCapture = (): number | null => {
    try { const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true }); try { db.exec("PRAGMA busy_timeout=2000"); return Number((db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE stage='capture' AND status<>'complete'").get() as any).n); } finally { db.close(); } } catch { return null; }
  };
  /** one real turn, held by the fake engine until GATE exists; resolves with the engine process' pid and its memory mount name */
  async function heldTurn(botId: string, threadId: string, text: string): Promise<{ pid: number; server: string }> {
    const before = dumps().length;
    const posted = await api("POST", `/api/bots/${botId}/messages`, { threadId, text });
    expect(posted.status, "owner message accepted").toBe(202);
    const end = Date.now() + 90_000;
    for (;;) {
      const fresh = dumps().slice(before);
      const dump = fresh.find(d => Object.values(d.mcpConfig?.mcpServers ?? {}).some((s: any) => s.env?.MURAGE_THREAD_ID === threadId)) ?? fresh[0];
      if (dump) {
        const servers = Object.entries(dump.mcpConfig?.mcpServers ?? {}) as [string, any][];
        const found = servers.find(([key, value]) => key === "memory" || key === "murage-memory" || key.includes("murage-memory-") || value.args?.some((a: string) => a.endsWith("/memory-proxy.ts")))?.[0];
        if (!found) throw new Error(`turn has no mounted memory server (${servers.map(([k, v]) => `${k}:${(v.args ?? []).map((a: string) => a.split("/").pop()).join(",")}`).join(" ")})`);
        return { pid: Number(dump.pid), server: found };
      }
      if (Date.now() > end) throw new Error("the engine never started the held turn");
      await sleep(100);
    }
  }
  /** the mounted tool, through the fake engine's own native MCP session (the engine's real shim and relay) */
  async function tool(turn: { pid: number; server: string }, name: string, args: unknown): Promise<Reply> {
    const id = randomUUID(), t0 = Date.now();
    const response = join(MAILBOX, `${turn.pid}-${id}.json`), pending = join(MAILBOX, `${turn.pid}-${id}.pending`);
    writeFileSync(pending, JSON.stringify({ id, server: turn.server, name, args }), { mode: 0o600 });
    renameSync(pending, join(MAILBOX, `${turn.pid}-request.json`));
    while (!existsSync(response)) { if (Date.now() - t0 > 60_000) return { isError: true, text: "MAILBOX_TIMEOUT", ms: Date.now() - t0 }; await sleep(20); }
    const reply = JSON.parse(readFileSync(response, "utf8")); unlinkSync(response);
    if (reply.error) return { isError: true, text: String(reply.error), ms: Date.now() - t0 };
    return { isError: reply.result?.isError === true, text: (reply.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"), ms: Date.now() - t0 };
  }
  /** fixed code of a refusal: never the text */
  const classify = (r: Reply): string => {
    if (!r.isError) return "ok";
    if (/Source capture is still pending/.test(r.text)) return "CAPTURE_PENDING";
    if (r.text === "MAILBOX_TIMEOUT") return "MAILBOX_TIMEOUT";
    if (/^Error: the [\w-]+ server closed its output$/.test(r.text)) return "MCP_SERVER_CLOSED";
    if (/could not record this change/i.test(r.text)) return "OWN_WRITE_RECORD_FAILED";
    if (/hold|aborted|cancel/i.test(r.text)) return "HOLD_ABORT";
    if (/approval|needs the owner/i.test(r.text)) return "NEEDS_APPROVAL";
    return "OTHER_REFUSAL";
  };
  const asJson = (text: string): any => { try { return JSON.parse(text); } catch { return null; } };
  /** the bot's actual answer of the turn: its text rows. ended = the last quote arrived; answerFacts = how many saved facts the answer states in full */
  async function waitReply(threadId: string, seeded: Set<string>): Promise<{ ended: boolean; cards: number; stopped: boolean; answerFacts: number }> {
    const last = `FACT ${FACTS[FACTS.length - 1]!.token}`;
    const fresh = async () => (await transcript(threadId)).filter(m => !seeded.has(String(m.id)));
    const text = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text").map(m => String(m.text ?? "")).join("\n");
    const end = Date.now() + 90_000;
    let rows = await fresh();
    while (Date.now() < end && !text(rows).includes(last)) { await sleep(300); rows = await fresh(); }
    await sleep(500); rows = await fresh();
    const answer = text(rows);
    const cards = rows.filter(m => m.card && (m.card.kind === "own-write" || m.card.writer || m.kind === "options")).length;
    const stopped = rows.some(m => /stopp/i.test(String(m.kind ?? "")) || m.stopped === true);
    return { ended: answer.includes(last), cards, stopped, answerFacts: FACTS.filter(f => answer.includes(f.sentence.replace(/\.$/, ""))).length };
  }
  /** searches the 3 facts by the mounted memory_search until each answers by FULL search (a hit, not partial, no keyword recallMode, nothing missed) or
   * RECALL_BUDGET_MS is spent (the word index may still be warming right after a save or a start: DECISIONS.md D2). Each call must also fit SEARCH_BUDGET_MS.
   * Every field is a count, a code or a duration. */
  async function recall(turn: { pid: number; server: string }): Promise<{ rows: any[]; lines: string[] }> {
    const rows: any[] = FACTS.map(f => ({ f: f.token.slice(0, 3), ms: 0, maxMs: 0, attempts: 0, keywordFirst: null as boolean | null, fullAfterMs: null as number | null }));
    const t0 = Date.now(), lines: string[] = FACTS.map(f => `FACT ${f.token}`);
    do {
      for (const [n, f] of FACTS.entries()) {
        const row = rows[n];
        if (row.fullAfterMs !== null) continue;
        const r = await tool(turn, "memory_search", { query: f.token });
        const body = asJson(r.text);
        const hits: any[] = Array.isArray(body?.hits) ? body.hits : [];
        const seen = { ms: r.ms, error: r.isError ? classify(r) : null, hit: JSON.stringify(hits).includes(f.token), hits: hits.length,
          partial: body?.partial === true, recallMode: typeof body?.recallMode === "string" ? body.recallMode : null,
          degraded: typeof body?.degradedReason === "string" ? body.degradedReason.replace(/[^\w-]/g, "").slice(0, 40) : null, missed: body?.missed === true };
        // what the engine reads back from the tool result: the first string of a hit that holds the token (never written to the result file)
        const found = JSON.stringify(hits).match(new RegExp(`"([^"]*${f.token}[^"]*)"`))?.[1];
        if (found) lines[n] = `FACT ${f.token} ${found}`;
        const full = !seen.error && seen.hit && !seen.partial && !seen.recallMode && !seen.missed;
        Object.assign(row, seen, { attempts: row.attempts + 1, maxMs: Math.max(row.maxMs, r.ms) });
        if (row.keywordFirst === null) row.keywordFirst = !full;
        if (full) row.fullAfterMs = Date.now() - t0;
      }
      if (rows.every(r => r.fullAfterMs !== null)) break;
      await sleep(1000);
    } while (Date.now() - t0 < RECALL_BUDGET_MS);
    return { rows, lines };
  }
  const botThreadSources = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[])
    .map(r => r.name).filter(n => (db.prepare(`PRAGMA table_info("${n}")`).all() as { name: string }[]).some(c => c.name === "thread_id") && (db.prepare(`PRAGMA table_info("${n}")`).all() as { name: string }[]).some(c => c.name === "bot_id"));
  const memoryMode = (file: string): string => { try { const db = new DatabaseSync(file, { readOnly: true }); try { return String((db.prepare("SELECT mode FROM memory_meta WHERE id=1").get() as any)?.mode ?? "none"); } finally { db.close(); } } catch { return "unreadable"; } };

  it("memgate", async () => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true }); mkdirSync(MAILBOX, { recursive: true });
    chmodSync(FAKE_CLAUDE, 0o755);
    const env = { FIELD_REPLAY_MAILBOX: MAILBOX, FAKE_CLAUDE_DUMP: "/data/latest.json", FAKE_CLAUDE_DUMP_EACH_TURN: "1", FAKE_CLAUDE_DUMP_HISTORY: TURNS,
      FAKE_CLAUDE_HOLD_MARKER: "MEMGATE_HOLD", FAKE_CLAUDE_HOLD_GATE: GATE, FAKE_CLAUDE_SCRIPT: JSON.stringify(Array.from({ length: 8 }, () => [["read", ANSWER], ...FACTS.map(f => ["quote", `FACT ${f.token}`])])) };
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { memgate: { driver: "claudeAgent", displayName: "Gate memgate", config: { cli: FAKE_CLAUDE }, environment: env } } }));
    // ---- roster: one real bot made by the server, then pointed at the snapshot's busiest thread and its real bot id
    await boot("roster");
    const created = await api("POST", "/api/bots", { name: "Gate memgate", modelSelection: { instanceId: "memgate", model: "claude-sonnet-5" } });
    expect(created.status, "create bot").toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    await api("PATCH", `/api/bots/${made.id}`, { computer: "off", browser: false, composio: false });
    if (process.env.BG_SYNTH === "1") {
      expect((await api("POST", `/api/bots/${made.id}/messages`, { threadId: made.threadId, text: "synthetic history line" })).status).toBe(202);
      await sleep(15_000);
    }
    expect(await stop(), "roster stop").toBe(0);
    if (process.env.BG_SYNTH === "1") {
      mkdirSync("/data/snap", { recursive: true });
      const fresh = new DatabaseSync(join(dataDir, "messages.db"));
      try { fresh.exec("VACUUM INTO '/data/snap/messages.db'"); } finally { fresh.close(); }
    }
    const snap = new DatabaseSync("/data/snap/messages.db", { readOnly: true });
    let pick: { threadId: string; botId?: string; n: number } | undefined;
    try {
      snap.exec("PRAGMA busy_timeout=5000");
      const busiest = snap.prepare("SELECT thread_id AS t, count(*) AS n FROM messages WHERE role='user' GROUP BY thread_id ORDER BY n DESC LIMIT 12").all() as { t: string; n: number }[];
      const sources = botThreadSources(snap);
      for (const row of process.env.BG_SYNTH === "1" ? [{ t: made.threadId, n: 1 }] : busiest) {
        const votes = new Map<string, number>();
        for (const table of sources) for (const hit of snap.prepare(`SELECT bot_id AS b, count(*) AS n FROM "${table}" WHERE thread_id=? AND bot_id<>'' GROUP BY bot_id`).all(row.t) as { b: string; n: number }[]) votes.set(String(hit.b), (votes.get(String(hit.b)) ?? 0) + Number(hit.n));
        let botId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (process.env.BG_SYNTH === "1") botId = made.id;
        pick = { threadId: String(row.t), botId, n: Number(row.n) }; break;
      }
      note(`pick ${JSON.stringify(pick ? { t: h8(pick.threadId), b: pick.botId ? h8(pick.botId) : null, ownerLines: pick.n } : null)}`);
    } finally { snap.close(); }
    expect(pick, "busiest thread").toBeTruthy();
    const bot = { id: pick!.botId ?? made.id, threadId: pick!.threadId };
    let roster = readFileSync(join(dataDir, "bots.json"), "utf8");
    roster = roster.split(made.threadId).join(bot.threadId).split(made.id).join(bot.id);
    writeFileSync(join(dataDir, "bots.json"), roster, { mode: 0o600 });
    for (const sidecar of ["bot-turn-state.json", "bot-task-state"]) rmSync(join(dataDir, sidecar), { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `messages.db${suffix}`), { force: true });
    renameSync("/data/snap/messages.db", join(dataDir, "messages.db"));
    const dbFile = join(dataDir, "messages.db");
    const result: Record<string, any> = { mode0: memoryMode(dbFile), bot: h8(bot.id), thread: h8(bot.threadId) };

    // ---- START 1: normal start-up background work is running (no settle wait). Memory is turned on the way the Settings call does.
    output = ""; allOutput = "";
    result.start1 = { listenMs: await boot("start1") };
    const resumed = await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    // MG_NO_RAISE=1 (rig self-test only): the bot stays at its default level, so memory_save is held for an approval card (own-write hold)
    const raised = process.env.MG_NO_RAISE === "1" ? { status: 200 } : await raiseLevel(async (m, p, b) => api(m, p, b), bot.id, { noLimits: true, acknowledgeNoLimits: true });
    result.setup = { resume: resumed.status, raised: raised.status, pendingCaptureAtStart: pendingCapture() };
    expect(raised.status, "raise to no-limits").toBe(200);
    let seeded = new Set((await transcript(bot.threadId)).map(m => String(m.id)));
    const t0 = Date.now();
    const prompt = `MEMGATE_HOLD Please remember these notes. ${FACTS.map(f => f.sentence).join(" ")}`;
    const turn1 = await heldTurn(bot.id, bot.threadId, prompt);
    result.save = { turnStartMs: Date.now() - t0, pendingCaptureAtSave: pendingCapture(), rows: [] as any[] };
    for (const [n, f] of FACTS.entries()) {
      const args = { text: f.sentence, evidence: [{ quote: f.sentence }], idempotencyKey: `memgate-${n}-${randomUUID()}` };
      const first = await tool(turn1, "memory_save", args);
      const body = asJson(first.text);
      const row: any = { n, code: classify(first), ms: first.ms, state: body?.state ?? null, pendingReview: body?.pendingReview ?? null };
      // an unclassified refusal: length and an 8-char hash only (the product text itself never leaves the private run dir)
      if (row.code === "OTHER_REFUSAL") row.refusalId = `${h8(first.text.replace(/\s+/g, " "))}/${first.text.length}`;
      if (row.code !== "ok" && n === 0) {  // liveness only: is the server up and is any memory proxy process left (counts, no text)
        const procs = readdirSync("/proc").filter(d => /^\d+$/.test(d)).map(d => { try { return readFileSync(`/proc/${d}/cmdline`, "utf8"); } catch { return ""; } });
        row.diag = { serverUp: child!.exitCode === null, health: (await api("GET", "/api/health").catch(() => ({ status: -1 }))).status,
          proxies: procs.filter(c => c.includes("memory-proxy") || c.includes("murage-memory")).length, fakeEngines: procs.filter(c => c.includes("fake-claude-cli")).length };
      }
      if (row.code !== "ok") {  // diagnosis only: how long the same save keeps refusing (the first refusal already fails the gate)
        const stopAt = Date.now() + RETRY_WINDOW_MS; row.retries = 0;
        while (Date.now() < stopAt) { await sleep(2000); row.retries++; const again = await tool(turn1, "memory_save", args); if (!again.isError) { row.okAfterMs = Date.now() - t0; break; } }
      }
      result.save.rows.push(row);
      note(`save ${n} ${row.code} ${first.ms}ms state=${row.state}`);
    }
    const got1 = await recall(turn1); result.recall1 = got1.rows;
    writeFileSync(ANSWER, got1.lines.join("\n") + "\n");
    writeFileSync(GATE, "");
    result.turn1 = await waitReply(bot.threadId, seeded);
    rmSync(GATE, { force: true });
    result.start1.holdCodes = (output.match(/\[writer\][^\n]*|own-write[^\n]*(?:abort|fail)[^\n]*|writer-card-without-hold/gi) ?? []).length;
    result.start1.fatal = (output.match(/uncaught|unhandled rejection|FATAL|setup failed|integrity hold/gi) ?? []).length;
    result.start1.exit = await stop();

    // ---- START 2: restart, recall again from the saved store
    output = "";
    result.start2 = { listenMs: await boot("start2") };
    seeded = new Set((await transcript(bot.threadId)).map(m => String(m.id)));
    const from = output.length;
    const turn2 = await heldTurn(bot.id, bot.threadId, "MEMGATE_HOLD What do you remember about the gate fixture markers?");
    const got2 = await recall(turn2); result.recall2 = got2.rows;
    writeFileSync(ANSWER, got2.lines.join("\n") + "\n");
    writeFileSync(GATE, "");
    result.turn2 = await waitReply(bot.threadId, seeded);
    rmSync(GATE, { force: true });
    result.start2.dispatch = output.slice(from).split("\n").filter(l => l.includes(bot.threadId)).flatMap(l => /turn dispatch recall=(\S+)/.exec(l)?.[1] ?? []);
    result.start2.holdCodes = (output.match(/\[writer\][^\n]*|writer-card-without-hold/gi) ?? []).length;
    result.start2.exit = await stop();
    result.budgets = { searchMs: SEARCH_BUDGET_MS, saveMs: SAVE_BUDGET_MS, recallMs: RECALL_BUDGET_MS };
    writeFileSync(RESULT, JSON.stringify(result, null, 1));
    note(`RESULT written`);
  }, 40 * 60_000);
});
