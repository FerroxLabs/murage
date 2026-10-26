// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SL-E EXTENDED (lanes/release104/designs/SL-E.md section 15): a linked person on the Slack fixture DMs the paired Chief with memory on, and the
// Chief hands the work on, through the real server (server/index.ts, real messages.db, real delegation, real result gate) with the fake ACP
// fleet as the engines (the lee-phantom-scenario.test.ts pattern). It asserts what reaches the person: the teammate's words in the person's
// conversation, no withheld, checking or no-answer line anywhere the person reads, and every footprint in the person's conversations within
// S(P) (no owner scope), and that the Chief's wake prompt holds the words on a fresh and a resumed session (section 11 (A)+(A2), r3.2). It
// measures how a chain Chief -> A -> B composes (chains are not promised, section 2).
// Relink: a hand-off in flight when the person is relinked never puts its words in any conversation of the person; a relink after the settle
// leaves the row where it landed.
// Owner memory in the worker's conversation (section 15, failure rows 2, 6, 14): an owner line seeded into the worker's conversation, a granted
// bot scope in the worker's footprint, and a shared folder grant withdrawn while the hand-off runs each give the person the neutral line, never
// the worker's words; the owner reads the words in the worker's conversation. The control (the same folder still granted) gives the words.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const GROK_MCP_READY = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" };
const PORT = 20800 + Math.floor(Math.random() * 9_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP_SECRET = "5e1e5e1e5e1e5e1e".repeat(4);
/** Every line a person must never see in place of a teammate's words. */
const BAD = /Reply withheld|deleted or changed|Reply left out|still being checked|no answer|Checking this reply/i;
const HELPER_WORDS = "hello from fake acp";
const RELINK_TASK = "RELINK_TASK_MARKER";

describe("SL-E EXTENDED: a linked person's hand-offs on the Slack fixture (real server, fake engines, memory on)", () => {
  let child: ChildProcess;
  let home = "";
  let gateFile = "";
  let promptDump = "";
  let stderr = "";
  const traces: Array<{ op: string; text?: string; eventId?: string }> = [];
  const measure = (entry: Record<string, unknown>) => { console.log(`SLE-MEASURE ${JSON.stringify(entry)}`); };

  const api = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${BASE}${path}`, {
        method, agent: false,
        headers: { connection: "close", "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject);
      req.end(payload);
    });
  };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const waitUntil = async <T>(probe: () => Promise<T | undefined | false> | T | undefined | false, timeout: number, what: string): Promise<T> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${what}. stderr tail: ${stderr.slice(-3000)}`);
      await sleep(200);
    }
  };
  /** One read-only look at the server's own file. */
  const readDb = <T>(read: (db: DatabaseSync) => T, fallback: T): T => {
    let db: DatabaseSync | undefined;
    try { db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true }); return read(db); }
    catch { return fallback; } finally { try { db?.close(); } catch { /* closed */ } }
  };

  const start = async () => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_PORT: String(PORT), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "slack-sdk-preload.mjs")).href, join(SERVER_DIR, "index.ts")],
      { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stderr!.on("data", c => (stderr += c));
    child.stdout!.on("data", () => undefined);
    child.on("message", value => { if ((value as any)?.kind === "slack-fixture") traces.push(value as any); });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr.slice(-4000)}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr.slice(-4000)}`);
      await sleep(150);
    }
  };

  const makeBot = async (name: string, section: string, instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { name, section, modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    return created as { id: string; threadId: string };
  };
  /** Switches a bot's engine for the person's conversations. Once the person's DM exists the Chief holds more than one thread, and a plain
   * bot-level engine change is refused by design (409 "Choose a thread or edit bot defaults explicitly", index.ts patchBot): each thread keeps
   * its own engine, and the person's turn runs on the DM thread's. So the defaults change explicitly (a thread made later, after a relink,
   * starts from them) and so does each of the bot's threads bound to the person. */
  const useInstance = async (botId: string, instanceId: string) => {
    const modelSelection = { instanceId, model: "fake-model" };
    const defaults = await api("PATCH", `/api/bots/${botId}`, { settingsScope: "defaults", modelSelection });
    expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
    // the bot's own conversations too (its owner thread and tasks are not bound to the person): a wake or a turn that lands on one of
    // them must not run on the previous test's engine and hand the work to the previous worker (1.0.6 CI x-owner-seed "never started")
    for (const t of new Set([...personThreads().map(({ t }) => t), ...ownThreads(botId).map(({ t }) => t)])) {
      const thread = await api("PATCH", `/api/bots/${botId}/tasks/${t}`, { modelSelection });
      if (thread.status !== 404) expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    }
  };
  const busy = async (id: string) => Boolean((await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === id)?.busy);
  const idle = (ids: string[]) => waitUntil(async () => { const all = (await api("GET", "/api/bots?messages=0")).body.bots; return ids.every(id => !all.find((b: any) => b.id === id)?.busy) || false; }, 90_000, "bots stayed busy");
  const event = (id: string, text: string) => child.send({ kind: "slack-fixture-event", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000), authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOTHER", user: "UOTHER", text } } });

  /** The bot's own conversations (its main thread and every task) with the engine each runs on, as the server's roster file holds them. */
  const ownThreads = (botId: string): Array<{ t: string; engine?: string }> => {
    try {
      const bot = (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as any[]).find(b => b.id === botId);
      if (!bot) return [];
      const rows = [{ t: String(bot.threadId), engine: bot.modelSelection?.instanceId }, ...(bot.tasks ?? []).map((task: any) => ({ t: String(task.threadId), engine: task.modelSelection?.instanceId ?? bot.modelSelection?.instanceId }))];
      return rows.filter((row, n) => rows.findIndex(other => other.t === row.t) === n);
    } catch { return []; }
  };
  /** Every conversation bound to the person, with the person each is bound to. */
  const personThreads = () => readDb(db => (db.prepare("SELECT subject_id AS t, json_extract(intent,'$.personId') AS p FROM memory_scope_bindings WHERE subject_type='human-thread' ORDER BY rowid").all() as Array<{ t: string; p: string }>), []);
  const rowsOf = (threadId: string) => readDb(db => (db.prepare("SELECT id,role,kind,text,json FROM messages WHERE thread_id=? ORDER BY at").all(threadId) as any[])
    .map(m => ({ ...m, from: (() => { try { return JSON.parse(m.json).from; } catch { return undefined; } })() })), [] as any[]);
  const threadOf = (label: string) => readDb(db => (db.prepare("SELECT thread_id FROM messages WHERE role='user' AND text LIKE ? ORDER BY at DESC LIMIT 1").get(`%${label}: please pick this up%`) as { thread_id?: string } | undefined)?.thread_id, undefined);
  /** S(P) exactly as memory/policy.ts personReadableScopes reads it, and every footprint member in the person's conversations outside it. */
  const footprintAudit = (personId: string) => readDb(db => {
    const s = new Set<string>();
    for (const r of db.prepare("SELECT s.id FROM memory_scope_bindings b JOIN memory_scopes s ON s.kind='conversation' AND s.owner_key=b.subject_id WHERE b.subject_type='human-thread' AND json_extract(b.intent,'$.personId')=?").all(personId) as any[]) s.add(String(r.id));
    for (const r of db.prepare("SELECT id FROM memory_scopes WHERE kind='preferences' AND owner_key=?").all("person:" + personId) as any[]) s.add(String(r.id));
    for (const r of db.prepare("SELECT s.id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id AND s.kind IN ('room','project','team','workspace') WHERE b.subject_type='person' AND b.subject_id=? AND b.state='granted'").all(personId) as any[]) s.add(String(r.id));
    const foreign: string[] = [];
    let star = 0, footprints = 0;
    for (const { t } of personThreads().filter(row => row.p === personId)) {
      for (const r of db.prepare("SELECT l.footprint AS f FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.footprint IS NOT NULL").all(t) as any[]) {
        footprints += 1;
        if (Number(r.f) === 0) { star += 1; continue; }
        for (const m of db.prepare("SELECT ss.scope_id AS id, sc.kind AS kind FROM memory_scope_sets ss LEFT JOIN memory_scopes sc ON sc.id=ss.scope_id WHERE ss.set_id=?").all(Number(r.f)) as any[])
          if (!s.has(String(m.id))) foreign.push(`${t}:${m.kind}:${m.id}`);
      }
    }
    return { scopes: s.size, footprints, star, foreign: [...new Set(foreign)] };
  }, { scopes: -1, footprints: -1, star: -1, foreign: ["unreadable"] as string[] });

  /** One message from the person: waits for the hand-off's result row in the person's conversation and reports what the person reads. */
  const personOnce = async (label: string, from: { id: string }, words = HELPER_WORDS) => {
    const sentAt = Date.now(), fromTrace = traces.length;
    const seen = new Set(personThreads().flatMap(({ t }) => rowsOf(t).map(m => m.id)));
    rmSync(promptDump, { force: true });
    event(`Ev-${label}`, `${label}: please pick this up`);
    const result = await waitUntil(() => { const t = threadOf(label); return t ? rowsOf(t).find(m => !seen.has(m.id) && m.role === "bot" && ((m.kind === "text" && m.from?.botId === from.id) || String(m.id).startsWith("dres-"))) || false : false; },
      150_000, `${label}: the result never came back to the person`);
    await idle(everyone());
    const dm = threadOf(label) ?? "";
    const sent = traces.slice(fromTrace).filter(t => t.op === "send" || t.op === "edit").map(t => String(t.text ?? ""));
    const wakePrompt = existsSync(promptDump) ? readFileSync(promptDump, "utf8") : "";
    const newRows = personThreads().flatMap(({ t }) => rowsOf(t).filter(m => !seen.has(m.id)).map(m => ({ t, ...m })));
    const outcome = { label, dm, ms: Date.now() - sentAt, rowId: String(result.id), rowText: String(result.text ?? "").slice(0, 200), wordsInRow: String(result.text ?? "").includes(words),
      wordsInWake: wakePrompt.includes(words), lastResort: /last resort|memoryLastResort/i.test(stderr),
      bad: [...sent.filter(t => BAD.test(t)).map(t => `slack: ${t.slice(0, 120)}`), ...newRows.filter(m => BAD.test(String(m.text ?? ""))).map(m => `${m.t}: ${String(m.text).slice(0, 120)}`)] };
    measure({ kind: "person", ...outcome });
    // what the gate read: the newest generated lines of each of the person's conversations (mem_lsn, footprint, output records)
    measure({ kind: "lineage", label, threads: readDb<unknown>(db => personThreads().map(({ t }) => ({ t: t.slice(0, 12),
      lines: (db.prepare("SELECT l.message_id AS id,l.lsn,l.turn_lsn AS turn,l.mem_lsn AS mem,l.footprint AS foot,(SELECT count(*) FROM memory_disclosure_outputs o WHERE o.thread_id=n.thread_id AND o.message_id=l.message_id) AS outputs,(SELECT count(*) FROM memory_receipt_lines r WHERE r.thread_no=l.thread_no AND r.first_lsn<=l.lsn) AS ranges FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.turn_lsn IS NOT NULL ORDER BY l.lsn DESC LIMIT 4").all(t) as any[])
        .map(r => ({ ...r, id: String(r.id).slice(0, 14) })) })), "unreadable") });
    return outcome;
  };

  /** Writes into the server's own file in one transaction (the server's writers wait on the same lock). */
  const writeDb = <T>(write: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, ".murage", "messages.db"));
    try {
      db.exec("PRAGMA busy_timeout=15000"); db.exec("BEGIN IMMEDIATE");
      try { const value = write(db); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  };
  /** A memory scope, made as memory/policy.ts ensureScope makes one when it does not exist yet. */
  const scopeOf = (kind: string, owner: string) => writeDb(db => {
    const held = db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind, owner) as { id?: string } | undefined;
    if (held?.id) return String(held.id);
    const id = randomUUID();
    db.prepare("INSERT INTO memory_scopes VALUES(?,?,?,'[]',0)").run(id, kind, owner);
    return id;
  });
  /** An owner line seeded at the head of `threadId`: a line with no turn whose footprint is `scopeIds` (interned exactly as memory/lineage-write.ts
   * internFootprint does). Every later line of the thread starts from the head's running values, so the worker's reply folds it. */
  const seedOwnerLine = (threadId: string, label: string, scopeIds: string[]) => writeDb(db => {
    const no = (db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId) as { no?: number } | undefined)?.no;
    if (no === undefined) throw new Error(`${label}: the worker's conversation has no lineage yet`);
    const lsn = Number((db.prepare("UPDATE memory_lsn SET next=next+1 WHERE id=1 RETURNING next-1 AS lsn").get() as { lsn: number }).lsn);
    const scopes = [...new Set(scopeIds)].sort();
    const hash = createHash("sha256").update(scopes.join("\u0000")).digest("hex");
    let set = (db.prepare("SELECT set_id FROM memory_scope_set_keys WHERE hash=?").get(hash) as { set_id?: number } | undefined)?.set_id;
    if (set === undefined) {
      set = Number((db.prepare("SELECT COALESCE(MAX(set_id),0)+1 AS id FROM memory_scope_set_keys").get() as { id: number }).id);
      db.prepare("INSERT INTO memory_scope_set_keys(hash,set_id) VALUES(?,?)").run(hash, set);
      for (const scope of scopes) db.prepare("INSERT INTO memory_scope_sets(set_id,scope_id) VALUES(?,?)").run(set, scope);
    }
    db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,NULL,NULL,?)").run(Number(no), lsn, `owner-seed-${label}`, set);
    return { lsn, set };
  });
  /** One hand-off to a gated worker: `during` runs while the worker's turn is held open (its conversation for the person known), then the gate
   * opens. Reports the person's result row, the worker's own reply in its conversation, and every line the person could read. */
  const gatedOnce = async (label: string, worker: { id: string }, gate: string, during: (workerThread: string) => Promise<void> | void, known?: string) => {
    rmSync(gate, { force: true });
    const fromTrace = traces.length;
    const threadsBefore = new Set(personThreads().map(({ t }) => t));
    const before = new Set(personThreads().flatMap(({ t }) => rowsOf(t).map(m => m.id)));
    event(`Ev-${label}`, `${label}: please pick this up`);
    try { await waitUntil(() => busy(worker.id), 60_000, `${label}: the worker never started`); }
    catch (error) {
      // name the cause on the next occurrence: who went busy instead, and the engine each Chief conversation runs on
      const bots = (await api("GET", "/api/bots?messages=0").catch(() => ({ body: { bots: [] } }))).body.bots as any[];
      const diag = { busy: bots.filter(b => b.busy).map(b => b.name), chiefThreads: ownThreads(chief.id), personThreads: personThreads().filter(({ p }) => p === personId).map(({ t }) => t) };
      throw new Error(`${(error as Error).message.split(". stderr tail:")[0]} ${JSON.stringify(diag)}. stderr tail: ${stderr.slice(-3000)}`);
    }
    const workerThread = known ?? await waitUntil(() => personThreads().find(({ t, p }) => p === personId && !threadsBefore.has(t))?.t, 30_000, `${label}: the worker has no conversation for the person`);
    await during(workerThread);
    writeFileSync(gate, "go");
    const dm = await waitUntil(() => threadOf(label), 30_000, `${label}: the message has no conversation`);
    const row = await waitUntil(() => rowsOf(dm).find(m => !before.has(m.id) && m.role === "bot" && (String(m.id).startsWith("dres-") || m.from?.botId === worker.id)) || false, 150_000, `${label}: the hand-off never settled`);
    await idle(everyone());
    const sent = traces.slice(fromTrace).filter(t => t.op === "send" || t.op === "edit").map(t => String(t.text ?? ""));
    const newRows = personThreads().flatMap(({ t }) => rowsOf(t).filter(m => !before.has(m.id)).map(m => ({ t, ...m })));
    const outcome = { label, dm, workerThread, rowText: String(row.text ?? "").slice(0, 200), wordsInRow: /echo:/.test(String(row.text ?? "")),
      ownerReadsWords: rowsOf(workerThread).some(m => !before.has(m.id) && m.role === "bot" && /echo:/.test(String(m.text ?? ""))),
      // the worker's words anywhere the person reads (the worker's own conversation is the owner's to read)
      leaked: [...sent.filter(t => /echo:/.test(t)).map(t => `slack: ${t.slice(0, 120)}`), ...newRows.filter(m => m.t !== workerThread && /echo:/.test(String(m.text ?? ""))).map(m => `${m.t}: ${String(m.text).slice(0, 120)}`)],
      bad: [...sent.filter(t => BAD.test(t)).map(t => `slack: ${t.slice(0, 120)}`), ...newRows.filter(m => m.t !== workerThread && BAD.test(String(m.text ?? ""))).map(m => `${m.t}: ${String(m.text).slice(0, 120)}`)],
      workerRows: rowsOf(workerThread).filter(m => !before.has(m.id)).map(m => `${m.role}/${m.kind}/${m.from?.botId === worker.id ? "worker" : m.from?.botId ?? "-"}: ${String(m.text ?? "").slice(0, 60)}`),
      // the reply's oldest receipt in its ancestry against the watermark (a policy or epoch bump since): older is stale for a person reader
      replyStale: readDb(db => { const mem = (db.prepare("SELECT l.mem_lsn AS m FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.turn_lsn IS NOT NULL ORDER BY l.lsn DESC LIMIT 1").get(workerThread) as { m?: number | null } | undefined)?.m; const mark = Number((db.prepare("SELECT max(value) AS w FROM memory_lineage_lsn_meta WHERE key IN ('policy_bump_lsn','epoch_bump_lsn')").get() as { w: number }).w); return mem === null || mem === undefined ? null : mem < mark; }, null as boolean | null),
      replyFootprint: readDb(db => (db.prepare("SELECT l.footprint AS f FROM memory_line_lineage l JOIN memory_thread_no n ON n.no=l.thread_no WHERE n.thread_id=? AND l.turn_lsn IS NOT NULL ORDER BY l.lsn DESC LIMIT 1").get(workerThread) as { f?: number | null } | undefined)?.f ?? null, null as number | null) };
    measure({ kind: "owner-memory", ...outcome, rowText: undefined, row: outcome.rowText, footprintKinds: readDb(db => (db.prepare("SELECT sc.kind AS kind FROM memory_scope_sets ss LEFT JOIN memory_scopes sc ON sc.id=ss.scope_id WHERE ss.set_id=?").all(outcome.replyFootprint ?? -1) as any[]).map(r => String(r.kind)), [] as string[]) });
    return outcome;
  };
  const footprintMembers = (set: number | null) => set === null ? [] : readDb(db => (db.prepare("SELECT scope_id AS s FROM memory_scope_sets WHERE set_id=?").all(set) as Array<{ s: string }>).map(r => String(r.s)), [] as string[]);

  let chief: { id: string; threadId: string }, helper: { id: string }, gated: { id: string }, chainA: { id: string }, chainB: { id: string };
  let seedB: { id: string }, grantB: { id: string }, shareB: { id: string }, shareC: { id: string };
  let personId = "";
  const everyone = () => [chief.id, helper.id, gated.id, chainA.id, chainB.id, seedB.id, grantB.id, shareB.id, shareC.id];

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-sle-extended-"));
    gateFile = join(home, "gate");
    promptDump = join(home, "chief-prompt.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    const fake = (environment: Record<string, string>) => ({ driver: "grokAgent", environment: { ...GROK_MCP_READY, ...environment }, config: { cli: FAKE_CLI, fullAuto: true } });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {
      toHelper: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "Helper", FAKE_ACP_PROMPT_DUMP: promptDump }),
      toGated: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "Gated", FAKE_ACP_DELEGATE_MESSAGE: RELINK_TASK, FAKE_ACP_PROMPT_DUMP: promptDump }),
      toChainA: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "ChainA", FAKE_ACP_PROMPT_DUMP: promptDump }),
      chainA: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "ChainB" }),
      helper: fake({ FAKE_ACP_MODE: "happy" }),
      gated: fake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile }),
      toSeedB: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "SeedB" }),
      toGrantB: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "GrantB" }),
      toShareB: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "ShareB" }),
      toShareC: fake({ FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_TO: "ShareC" }),
      seedB: fake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile + "-seed" }),
      grantB: fake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile + "-grant" }),
      shareB: fake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile + "-share" }),
      shareC: fake({ FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile + "-withdraw" }),
    } }));
    await start();
    expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active" })).status).toBe(200);
    chief = await makeBot("Chief", "Front", "toHelper");
    helper = await makeBot("Helper", "Front", "helper");
    gated = await makeBot("Gated", "Front", "gated");
    chainA = await makeBot("ChainA", "Front", "chainA");
    chainB = await makeBot("ChainB", "Front", "helper");
    seedB = await makeBot("SeedB", "Front", "seedB");
    grantB = await makeBot("GrantB", "Front", "grantB");
    shareB = await makeBot("ShareB", "Front", "shareB");
    shareC = await makeBot("ShareC", "Front", "shareC");
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
    expect((await api("PATCH", "/api/config?secretStorage=external", { slack: { appToken: "xapp-fixture-not-real", botToken: "xoxb-fixture-not-real", teamId: "TEAM", appId: "APP", ownerUserId: "UOTHER" } })).status).toBe(200); // the pairing user, then linked as a person (lee-phantom flow f)
    const pairing = await api("POST", "/api/slack/pair", { targetBotId: chief.id });
    expect(pairing.status, JSON.stringify(pairing.body)).toBe(200);
    event("EvPAIR", "/pair " + pairing.body.code);
    await waitUntil(async () => (await api("GET", "/api/slack/status")).body.paired || false, 20_000, "slack pairing never completed");
    event("EvFIRST", "hello there");
    await waitUntil(() => traces.some(t => t.eventId === "EvFIRST") || false, 20_000, "the first person event was never acknowledged");
    const binding = (await api("POST", "/api/memory/action", { action: "humans" })).body.bindings?.[0];
    expect(binding, "no human binding to link").toBeTruthy();
    expect((await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "person" })).status).toBe(200);
    await idle(everyone());
  }, 180_000);

  afterAll(async () => {
    for (const line of stderr.split("\n")) if (/last resort|continuation reset|origin_unconfirmed/.test(line)) console.log(`SLE-ERR ${line.slice(0, 600)}`);
    if (child && child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("fresh Chief session: the teammate's words reach the person and the Chief's wake, nothing withheld anywhere, every footprint within S(P)", async () => {
    const base = await personOnce("x-base", helper);
    personId = personThreads().find(({ t }) => t === base.dm)?.p ?? "";
    expect(personId).not.toBe("");
    expect({ words: base.wordsInRow, wake: base.wordsInWake, bad: base.bad }).toEqual({ words: true, wake: true, bad: [] });
    const audit = footprintAudit(personId);
    measure({ kind: "footprints", label: "x-base", ...audit });
    expect(audit.foreign).toEqual([]);
  }, 300_000);

  it("resumed Chief session: a second hand-off in the same conversation reaches the person and the resumed Chief's wake (A2)", async () => {
    const again = await personOnce("x-resumed", helper);
    measure({ kind: "resumed-wake", wordsInWake: again.wordsInWake, lastResort: again.lastResort });
    expect({ words: again.wordsInRow, wake: again.wordsInWake, lastResort: again.lastResort, bad: again.bad }).toEqual({ words: true, wake: true, lastResort: false, bad: [] });
    expect(footprintAudit(personId).foreign).toEqual([]);
  }, 300_000);

  it("chain Chief -> A -> B: nothing withheld reaches the person at any hop, every footprint within S(P); the words are measured", async () => {
    await useInstance(chief.id, "toChainA");
    const hop = await personOnce("x-chain", chainA, "delegated");
    expect(hop.bad).toEqual([]);
    // B's result reaches A's conversation for the person once B settles
    await sleep(3_000); await idle(everyone());
    const all = personThreads().filter(({ p }) => p === personId).flatMap(({ t }) => rowsOf(t).map(m => ({ t, ...m })));
    expect(all.filter(m => m.role === "bot" && BAD.test(String(m.text ?? ""))).map(m => `${m.t}: ${String(m.text).slice(0, 120)}`)).toEqual([]);
    measure({ kind: "chain", wordsInRow: hop.wordsInRow, bWordsAnywhere: all.some(m => m.from?.botId === chainB.id || String(m.text ?? "").includes(HELPER_WORDS)) });
    const audit = footprintAudit(personId);
    measure({ kind: "footprints", label: "x-chain", ...audit });
    expect(audit.foreign).toEqual([]);
  }, 300_000);

  it("an owner line seeded into the worker's conversation: the person reads the neutral line, the owner reads the worker's words there", async () => {
    await useInstance(chief.id, "toSeedB");
    const ownerScope = scopeOf("bot", seedB.id);
    const out = await gatedOnce("x-owner-seed", seedB, gateFile + "-seed", thread => { seedOwnerLine(thread, "x-owner-seed", [ownerScope]); });
    expect(footprintMembers(out.replyFootprint)).toContain(ownerScope);
    expect({ words: out.wordsInRow, owner: out.ownerReadsWords, leaked: out.leaked, bad: out.bad }).toEqual({ words: false, owner: true, leaked: [], bad: [] });
  }, 300_000);

  it("a granted bot scope in the worker's footprint never counts as the person's own: the person reads the neutral line", async () => {
    await useInstance(chief.id, "toGrantB");
    const botScope = scopeOf("bot", grantB.id);
    // a grant of a bot scope as shareHumanScope wrote one before it refused kinds the share screen never offers (the same row id)
    const grantId = "human-share:" + createHash("sha256").update(JSON.stringify([personId, botScope])).digest("hex");
    writeDb(db => db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'person',?,1,'granted','{}')").run(grantId, botScope, personId));
    try {
      const out = await gatedOnce("x-bot-grant", grantB, gateFile + "-grant", thread => { seedOwnerLine(thread, "x-bot-grant", [botScope]); });
      expect(footprintMembers(out.replyFootprint)).toContain(botScope);
      expect({ words: out.wordsInRow, owner: out.ownerReadsWords, leaked: out.leaked, bad: out.bad }).toEqual({ words: false, owner: true, leaked: [], bad: [] });
    } finally { writeDb(db => db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run(grantId)); }
  }, 300_000);

  it("a shared folder grant: granted, the person reads the worker's words; withdrawn while the next hand-off runs, the neutral line", async () => {
    await useInstance(chief.id, "toShareB");
    const folder = scopeOf("project", "/shared/sle-extended-plans");
    const share = (granted: boolean) => api("POST", "/api/memory/action", { action: "human-share", personId, scopeId: folder, granted });
    // a grant or a withdrawal changes memory policy and revokes every receipt (human-principals.ts shareHumanScope): their lines read
    // "checking" until the marker commits the flips, so the control waits for that before the hand-off
    const drained = () => waitUntil(() => readDb(db => Number((db.prepare("SELECT count(*) AS n FROM memory_receipt_flips").get() as { n: number }).n) === 0, false), 90_000, "the revoke marker never committed the grant's flips");
    const granted = await share(true);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    await drained();
    // control: the folder is the person's while the hand-off runs, so a reply that read it is the person's to read
    const held = await gatedOnce("x-share-held", shareB, gateFile + "-share", thread => { seedOwnerLine(thread, "x-share-held", [folder]); });
    expect(footprintMembers(held.replyFootprint)).toContain(folder);
    expect({ words: held.wordsInRow, bad: held.bad }).toEqual({ words: true, bad: [] });
    // measured, not asserted: a second hand-off to the same worker folds the person's conversation's history, whose oldest receipt predates the
    // grant's policy change, so the watermark withholds it (replyStale)
    const again = await gatedOnce("x-share-again", shareB, gateFile + "-share", () => undefined, held.workerThread);
    measure({ kind: "share-again", wordsInRow: again.wordsInRow, replyStale: again.replyStale, bad: again.bad });
    expect(again.bad).toEqual([]);
    // a fresh worker conversation that reads the folder (as the control did); the grant is withdrawn after the turn began, before the settle.
    // The withdrawal is a memory policy change, so the worker's receipt is stale too and its own turn may be refused at its send fence; either
    // way no words reach the person (measured: whether the worker's reply was written in its conversation)
    await useInstance(chief.id, "toShareC");
    const withdrawn = await gatedOnce("x-share-withdrawn", shareC, gateFile + "-withdraw", async thread => {
      seedOwnerLine(thread, "x-share-withdrawn", [folder]);
      const revoked = await share(false);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    });
    expect({ words: withdrawn.wordsInRow, leaked: withdrawn.leaked, bad: withdrawn.bad }).toEqual({ words: false, leaked: [], bad: [] });
  }, 400_000);

  it("relink mid hand-off: the in-flight result reaches no conversation of the person; a relink after the settle leaves the row where it landed", async () => {
    await useInstance(chief.id, "toGated");
    rmSync(gateFile, { force: true });
    const before = new Set(personThreads().flatMap(({ t }) => rowsOf(t).map(m => m.id)));
    event("Ev-x-relink", "x-relink: please pick this up");
    await waitUntil(() => busy(gated.id), 60_000, "the gated teammate never started");
    const binding = (await api("POST", "/api/memory/action", { action: "humans" })).body.bindings?.[0];
    expect((await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "person" })).status).toBe(200);
    writeFileSync(gateFile, "go");
    const dm = await waitUntil(() => threadOf("x-relink"), 30_000, "the relink message has no conversation");
    await waitUntil(() => rowsOf(dm).find(m => !before.has(m.id) && String(m.id).startsWith("dres-")) || false, 150_000, "the in-flight hand-off never settled");
    await idle(everyone());
    const gatedWork = new Set(personThreads().filter(({ t }) => rowsOf(t).some(m => m.from?.botId === gated.id || /^echo:/.test(String(m.text ?? "")) && m.role === "bot")).map(({ t }) => t));
    const leaked = personThreads().flatMap(({ t }) => rowsOf(t).filter(m => !before.has(m.id) && m.role === "bot" && /echo:/.test(String(m.text ?? "")) && !gatedWork.has(t)).map(m => `${t}: ${String(m.text).slice(0, 120)}`));
    const row = rowsOf(dm).find(m => !before.has(m.id) && String(m.id).startsWith("dres-"));
    measure({ kind: "relink", row: String(row?.text ?? "").slice(0, 200), leaked });
    expect(leaked).toEqual([]);
    expect(String(row?.text ?? "")).not.toMatch(/echo:/);
    expect(String(row?.text ?? "")).not.toMatch(BAD);
    // after the settle: a clean hand-off lands, then the person is relinked; the row stays in the conversation it landed in
    await useInstance(chief.id, "toHelper");
    const landed = await personOnce("x-relink-after", helper);
    expect(landed.wordsInRow).toBe(true);
    const again = (await api("POST", "/api/memory/action", { action: "humans" })).body.bindings?.[0];
    expect((await api("POST", "/api/memory/action", { action: "human-link", bindingId: again.id, expectedRevision: again.revision, as: "person" })).status).toBe(200);
    expect(rowsOf(landed.dm).find(m => m.id === landed.rowId)?.text).toContain(HELPER_WORDS);
  }, 400_000);
});
