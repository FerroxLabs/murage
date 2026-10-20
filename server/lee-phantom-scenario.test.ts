// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Discord report (Lee_J, Phantom, 1.0.2): every delegated team reply read "[Reply withheld: it used something you deleted or changed]",
// even on fresh tasks, often right after a permission, roster or settings change ("talk to everyone"). This drives the user's own flows through
// the real server (server/index.ts, real messages.db, real delegation, real result gate) with the fake ACP fleet as the engines (the comms
// e2e pattern), and asserts each time that the asking bot RECEIVES THE WORDS of its teammate's reply and that no "Reply withheld", checking or
// no-answer line reaches the bot or the owner's rows. It also records how long the revocation window stays open after each change (LP-MEASURE
// lines on stdout), so the no-holds build can be judged on the risk that a fresh reply reads "checking" and comes back as no-answer.
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { denyLookup } from "./memory/deny-read.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const GROK_MCP_READY = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" };
const PORT = 20800 + Math.floor(Math.random() * 9_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP_SECRET = "1ee7fa4710ee7fa4".repeat(4);
/** Every line a user must never see in place of a teammate's words. */
const BAD = /Reply withheld|deleted or changed|Reply left out|still being checked|no answer|Checking this reply/i;
const HELPER_WORDS = "hello from fake acp";

describe("Lee_J / Phantom: delegated team replies after permission, roster and settings changes (real server, fake engines)", () => {
  let child: ChildProcess;
  let home = "";
  let gateFile = "";
  let gate2File = "";
  let promptDump = "";
  let stderr = "";
  const traces: Array<{ op: string; text?: string; eventId?: string; channel?: string }> = [];
  const measures: Array<Record<string, unknown>> = [];
  const measure = (entry: Record<string, unknown>) => { measures.push(entry); console.log(`LP-MEASURE ${JSON.stringify(entry)}`); };

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
  const waitUntil = async <T>(probe: () => Promise<T | undefined | false>, timeout: number, what: string): Promise<T> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${what}. stderr tail: ${stderr.slice(-3000)}`);
      await sleep(200);
    }
  };

  const start = async () => {
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_PORT: String(PORT), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    // the Slack SDK fixture (human-principals-api.test.ts): a person's conversation over a paired bot, no network; traces carry what Slack would show
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
  const stop = async () => { await waitForExit(child, { signal: "SIGTERM" }); };

  /** The revocation state that can make a fresh reply read "checking" (deny-read.ts pendingWindows): queued receipt flips (no cap), pending
   * rows (own and '*') and revoke jobs not yet done. Read straight from the server's own file, read-only. */
  const windowState = () => {
    let db: DatabaseSync | undefined;
    const one = (sql: string) => { try { return Number((db!.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0); } catch { return -1; } };
    try {
      db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      return {
        flips: one("SELECT count(*) AS n FROM memory_receipt_flips"),
        pendingStar: one("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'"),
        pending: one("SELECT count(*) AS n FROM memory_deny_pending"),
        jobsOpen: one("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('seeding','active','undoing')"),
        seeding: one("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='seeding'"),
        receiptsLive: one("SELECT count(*) AS n FROM memory_disclosures WHERE state IN ('prepared','delivered')"),
        receiptsRevoked: one("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'"),
        certReady: one("SELECT ready AS n FROM memory_lineage_cert WHERE id=1"),
      };
    } catch { return { flips: -1, pendingStar: -1, pending: -1, jobsOpen: -1, seeding: -1, receiptsLive: -1, receiptsRevoked: -1, certReady: -1 }; }
    finally { try { db?.close(); } catch { /* closed */ } }
  };
  /** Diagnostics for a reply that did not come back as words: the lineage and revoke rows of the worker's conversation. */
  const dumpLineage = (label: string, threadId: string) => {
    let db: DatabaseSync | undefined;
    const all = (sql: string, ...args: any[]) => { try { return db!.prepare(sql).all(...args); } catch (error) { return String(error); } };
    try {
      db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      const no = (db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId) as { no?: number } | undefined)?.no ?? -1;
      measure({ kind: "diag", label, threadNo: no,
        lines: all("SELECT * FROM memory_line_lineage WHERE thread_no=? ORDER BY lsn DESC LIMIT 6", no),
        ranges: all("SELECT * FROM memory_deny_range WHERE thread_id=? ORDER BY from_lsn DESC LIMIT 8", threadId),
        denyLines: all("SELECT * FROM memory_deny_line WHERE thread_id=? ORDER BY lsn DESC LIMIT 8", threadId),
        sessions: all("SELECT * FROM memory_deny_session WHERE thread_id=? LIMIT 8", threadId),
        sessionLineage: all("SELECT * FROM memory_session_lineage WHERE thread_id=? LIMIT 8", threadId),
        carriesInto: all("SELECT * FROM memory_lineage_carry WHERE child_thread_no=? ORDER BY from_lsn DESC LIMIT 24", no),

        jobs: all("SELECT revoke_id,kind,substr(root,1,120) AS root,root_lsn,started_lsn,phase,state FROM memory_revoke_jobs ORDER BY revoke_id DESC LIMIT 12"),
        carriesFromLeadInto: all("SELECT * FROM memory_lineage_carry WHERE parent_thread_no=? ORDER BY to_lsn DESC LIMIT 6", no),
        meta: all("SELECT * FROM memory_lineage_lsn_meta"),
        audienceOnly: all("SELECT revoke_id FROM memory_revoke_audience ORDER BY revoke_id DESC LIMIT 12"),
        verdicts: (() => { try {
          const ids = (db!.prepare("SELECT message_id FROM memory_line_lineage WHERE thread_no=? ORDER BY lsn DESC LIMIT 4").all(no) as Array<{ message_id: string }>).map(r => r.message_id);
          const page = { threadId, lines: ids.map(messageId => ({ messageId, author: "generated" as const })) };
          const content = denyLookup(db!, page, { audience: null }), owner = denyLookup(db!, page, { audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true });
          return ids.map(id => ({ id, content: content.get(id), owner: owner.get(id) }));
        } catch (error) { return String(error); } })() });
    } catch (error) { measure({ kind: "diag", label, error: String(error) }); }
    finally { try { db?.close(); } catch { /* closed */ } }
  };
  /** The gate's verdict on a conversation's newest generated lines, by every reader the result gate can use: the content reader (audience null),
   * the owner's own chat (owner audience + ownerOwnChat), the plain owner audience (a room) and a not-owner audience (a person's conversation).
   * Reason strings as deny-read.ts gives them: what delegate_bot and ask_bot each ran into. */
  const reasons = (label: string, threadId: string) => {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
      const no = (db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(threadId) as { no?: number } | undefined)?.no ?? -1;
      const ids = (db.prepare("SELECT message_id FROM memory_line_lineage WHERE thread_no=? AND turn_lsn IS NOT NULL ORDER BY lsn DESC LIMIT 4").all(no) as Array<{ message_id: string }>).map(r => r.message_id);
      const page = { threadId, lines: ids.map(messageId => ({ messageId, author: "generated" as const })) };
      const read = (reader: Parameters<typeof denyLookup>[2], options?: Parameters<typeof denyLookup>[3]) => { const v = denyLookup(db!, page, reader, options); return (id: string) => { const x = v.get(id); return x ? `${x.state}${(x as any).reason ? "/" + (x as any).reason : ""}` : "?"; }; };
      const content = read({ audience: null }), ownChat = read({ audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true }), owner = read({ audience: { owner: true, scopeIds: [] } }), notOwner = read({ audience: { owner: false, scopeIds: [] } });
      measure({ kind: "reasons", label, threadNo: no, lines: ids.map(id => ({ id: id.slice(0, 14), content: content(id), ownChat: ownChat(id), owner: owner(id), notOwner: notOwner(id) })) });
    } catch (error) { measure({ kind: "reasons", label, error: String(error) }); }
    finally { try { db?.close(); } catch { /* closed */ } }
  };
  const REASONED = /settings|add-bot|remove-bot|room|person|restart/;
  const windowOpen = (s: ReturnType<typeof windowState>) => s.flips > 0 || s.pending > 0 || s.jobsOpen > 0;
  /** Waits for the revocation window to close and says how long it was open. */
  const waitWindowClosed = async (label: string, startedAt = Date.now(), timeout = 180_000) => {
    let s = windowState();
    while (windowOpen(s) && Date.now() - startedAt < timeout) { await sleep(100); s = windowState(); }
    measure({ kind: "window", label, openMs: Date.now() - startedAt, closed: !windowOpen(s), state: s });
    return !windowOpen(s);
  };
  const revokeCount = () => (stderr.match(/memory receipts revoked scope=global/g) ?? []).length;

  const bots = async () => (await api("GET", "/api/bots")).body as { bots: any[]; groups: any[] };
  const bot = async (id: string) => (await bots()).bots.find(b => b.id === id);
  const makeBot = async (name: string, section: string, instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { name, section, modelSelection: { instanceId, model: "fake-model" } })).status).toBe(200);
    return created as { id: string; threadId: string };
  };
  /** Only these bots are visible (the fake engines ask the first bot list_bots names). */
  const only = async (ids: string[]) => {
    for (const b of (await bots()).bots) {
      const hidden = !ids.includes(b.id);
      if (Boolean(b.hidden) !== hidden) await api("PATCH", `/api/bots/${b.id}`, { hidden });
    }
  };
  const idleBots = (ids: string[]) => waitUntil(async () => { const all = (await api("GET", "/api/bots?messages=0")).body.bots; return ids.every(id => !all.find((b: any) => b.id === id)?.busy) || false; }, 60_000, "bots stayed busy");

  /** Rows the owner reads that are new since `seen` (the lead's conversation and every channel), for the bad-line check. */
  const newOwnerRows = async (seen: Set<string>) => {
    const state = await bots();
    const rows: any[] = [];
    for (const b of state.bots) for (const m of b.messages ?? []) if (!seen.has(`${b.threadId}:${m.id}`)) rows.push({ where: b.name, ...m });
    for (const g of state.groups) for (const m of g.messages ?? []) if (!seen.has(`${g.threadId}:${m.id}`)) rows.push({ where: `#${g.name ?? g.id}`, ...m });
    return rows;
  };
  const snapshotSeen = async () => {
    const state = await bots();
    const seen = new Set<string>();
    for (const b of state.bots) for (const m of b.messages ?? []) seen.add(`${b.threadId}:${m.id}`);
    for (const g of state.groups) for (const m of g.messages ?? []) seen.add(`${g.threadId}:${m.id}`);
    return seen;
  };
  const badRows = (rows: any[]) => rows.filter(m => BAD.test(String(m.text ?? "")) || BAD.test(JSON.stringify(m.murage ?? "")));

  /** delegate_bot: the lead hands a task to its teammate; the teammate's reply comes back as the `dres-` row in the lead's conversation and
   * the lead is woken with it (the wake prompt is what the lead's engine reads). */
  const delegateOnce = async (label: string, lead: { id: string; threadId: string }, helper: { id: string }, words = HELPER_WORDS) => {
    const seen = await snapshotSeen();
    const before = windowState();
    const sentAt = Date.now();
    rmSync(promptDump, { force: true });
    expect((await api("POST", `/api/bots/${lead.id}/messages`, { text: `${label}: please pick this up` })).status).toBe(202);
    const result = await waitUntil(async () => {
      const b = await bot(lead.id);
      return b.messages.find((m: any) => !seen.has(`${b.threadId}:${m.id}`) && m.role === "bot" && m.kind === "text" && m.from?.botId === helper.id) || false;
    }, 60_000, `${label}: the teammate's result never came back`).catch(async error => { throw new Error(`${(error as Error).message.slice(0, 600)}\nlead tail: ${JSON.stringify((await bot(lead.id)).messages.slice(-6).map((m: any) => [m.id, m.role, m.kind, m.from?.botId, String(m.text ?? m.tool?.name ?? "").slice(0, 200)]))}\nhelper tail: ${JSON.stringify((await bot(helper.id)).messages.slice(-4).map((m: any) => [m.id, m.role, m.kind, String(m.text ?? m.tool?.name ?? "").slice(0, 200)]))}`); });
    // the lead's follow-through turn: what its engine was handed
    const resumed = await waitUntil(async () => {
      const b = await bot(lead.id);
      return (!b.busy && b.messages.find((m: any) => !seen.has(`${b.threadId}:${m.id}`) && m.role === "bot" && m.kind === "text" && m.at >= result.at && m.id !== result.id && !m.from?.botId)) || false;
    }, 30_000, `${label}: the lead was never woken with the result`);
    await idleBots([lead.id, helper.id]);
    const wakePrompt = existsSync(promptDump) ? readFileSync(promptDump, "utf8") : "";
    measure({ kind: "wake", label, leadAfterWake: String(resumed.text).slice(0, 100) });
    const rows = await newOwnerRows(seen);
    const outcome = { kind: "delegate", label, ms: Date.now() - sentAt, windowAtSend: before, windowAfter: windowState(), rowText: String(result.text).slice(0, 160),
      wordsInRow: String(result.text).includes(words), wordsInWake: wakePrompt.includes(words), bad: badRows(rows).map(m => `${m.where}: ${String(m.text).slice(0, 120)}`) };
    measure(outcome);
    if (REASONED.test(label)) { reasons(`${label} (helper)`, (await bot(helper.id)).threadId); reasons(`${label} (lead)`, lead.threadId); }
    if (!outcome.wordsInRow) { dumpLineage(label, (await bot(helper.id)).threadId); dumpLineage(`${label} (lead)`, lead.threadId); }
    return { ...outcome, result };
  };
  /** ask_bot (sync): the asker's own reply quotes what the tool handed it ("peer says: ..."). */
  const askOnce = async (label: string, asker: { id: string; threadId: string }, helper: { id: string }, words = HELPER_WORDS) => {
    const seen = await snapshotSeen();
    const before = windowState();
    const sentAt = Date.now();
    expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: `${label}: ask your teammate` })).status).toBe(202);
    const reply = await waitUntil(async () => {
      const b = await bot(asker.id);
      return (!b.busy && b.messages.find((m: any) => !seen.has(`${b.threadId}:${m.id}`) && m.role === "bot" && m.kind === "text" && /peer (says|error):/.test(m.text ?? ""))) || false;
    }, 60_000, `${label}: the asker never finished`);
    await idleBots([asker.id, helper.id]);
    const rows = await newOwnerRows(seen);
    const outcome = { kind: "ask", label, ms: Date.now() - sentAt, windowAtSend: before, windowAfter: windowState(), rowText: String(reply.text).slice(0, 160),
      wordsInRow: String(reply.text).includes(words), bad: badRows(rows).map(m => `${m.where}: ${String(m.text).slice(0, 120)}`) };
    measure(outcome);
    if (REASONED.test(label)) { reasons(`${label} (helper)`, (await bot(helper.id)).threadId); reasons(`${label} (asker)`, asker.threadId); }
    return outcome;
  };
  const expectWords = (o: { wordsInRow: boolean; bad: string[]; wordsInWake?: boolean; label: string }) => {
    expect({ label: o.label, words: o.wordsInRow, bad: o.bad }).toEqual({ label: o.label, words: true, bad: [] });
    if (o.wordsInWake !== undefined) expect({ label: o.label, wake: o.wordsInWake }).toEqual({ label: o.label, wake: true });
  };

  // the teams: one lead per path, each with its own teammate in its own section
  let lead: { id: string; threadId: string }, helper: { id: string; threadId: string };
  let asker: { id: string; threadId: string }, askHelper: { id: string; threadId: string };
  let qAsker: { id: string; threadId: string }, qHelper: { id: string; threadId: string };
  const results: Record<string, "PASS" | "FAIL"> = {};
  const record = async (flow: string, run: () => Promise<void>) => {
    try { await run(); results[flow] = "PASS"; } catch (error) { results[flow] = "FAIL"; throw error; }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-lee-phantom-"));
    gateFile = join(home, "gate-1");
    gate2File = join(home, "gate-2");
    promptDump = join(home, "lead-prompt.json");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {
      lead: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_PROMPT_DUMP: promptDump }, config: { cli: FAKE_CLI, fullAuto: true } },
      asker: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "ask-peer" }, config: { cli: FAKE_CLI, fullAuto: true } },
      helper: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_CLI, fullAuto: true } },
      helperGate: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile }, config: { cli: FAKE_CLI, fullAuto: true } },
      helperGate2: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate2File }, config: { cli: FAKE_CLI, fullAuto: true } },
    } }));
    await start();
  }, 60_000);

  afterAll(async () => {
    console.log(`LP-RESULTS ${JSON.stringify(results)}`);
    console.log(`LP-REVOKES ${revokeCount()}`);
    for (const line of stderr.split("\n")) if (/LP-GATE|continuation reset|memory receipts revoked/.test(line)) console.log(`LP-ERR ${line.slice(0, 1500)}`);
    if (child && child.exitCode === null) await stop();
    if (home) await removeTempDir(home);
  });

  it("setup: memory on, a team per path (fresh install)", async () => {
    const status = await api("GET", "/api/memory/status");
    measure({ kind: "memory-status", status: status.status, mode: status.body?.mode ?? status.body?.state?.mode });
    const on = await api("POST", "/api/memory/action", { action: "configure", mode: "active" });
    measure({ kind: "memory-on", status: on.status, error: on.body?.error });
    lead = await makeBot("Lead", "Alpha", "lead");
    helper = await makeBot("Helper", "Alpha", "helper");
    asker = await makeBot("Asker", "Beta", "asker");
    askHelper = await makeBot("AskHelper", "Beta", "helper");
    qAsker = await makeBot("QueueAsker", "Gamma", "asker");
    qHelper = await makeBot("QueueHelper", "Gamma", "helperGate");
    await waitWindowClosed("after team setup");
  }, 240_000);

  it("a. fresh install, nothing changed: delegate_bot, ask_bot and a queued hand-off all return the teammate's words", async () => {
    await record("a", async () => {
      await only([lead.id, helper.id]);
      await waitWindowClosed("a: before delegate");
      expectWords(await delegateOnce("a-delegate", lead, helper));
      // a second fresh task: the teammate's thread now holds a receipt from its first turn
      expectWords(await delegateOnce("a-delegate-2", lead, helper));
      await only([asker.id, askHelper.id]);
      await waitWindowClosed("a: before ask");
      expectWords(await askOnce("a-ask", asker, askHelper));
      // queued: the teammate is busy, so ask_bot becomes a hand-off that runs once it frees up
      await only([qAsker.id, qHelper.id]);
      await waitWindowClosed("a: before queued");
      rmSync(gateFile, { force: true });
      expect((await api("POST", `/api/bots/${qHelper.id}/messages`, { text: "hold the line" })).status).toBe(202);
      await waitUntil(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === qHelper.id)?.busy || false, 20_000, "queue helper never went busy");
      const seen = await snapshotSeen();
      expect((await api("POST", `/api/bots/${qAsker.id}/messages`, { text: "a-queued: ask your teammate" })).status).toBe(202);
      await waitUntil(async () => { const b = await bot(qAsker.id); return (!b.busy && b.messages.some((m: any) => !seen.has(`${b.threadId}:${m.id}`) && /queued as a delegation/.test(m.text ?? ""))) || false; }, 30_000, "never queued");
      writeFileSync(gateFile, "go");
      const returned = await waitUntil(async () => { const b = await bot(qAsker.id); return b.messages.find((m: any) => !seen.has(`${b.threadId}:${m.id}`) && m.role === "bot" && m.kind === "text" && m.from?.botId === qHelper.id) || false; }, 60_000, "queued result never returned");
      await idleBots([qAsker.id, qHelper.id]);
      const rows = await newOwnerRows(seen);
      const o = { label: "a-queued", wordsInRow: String(returned.text).includes("ping from fake"), bad: badRows(rows).map(m => `${m.where}: ${String(m.text).slice(0, 120)}`) };
      measure({ kind: "queued", ...o, rowText: String(returned.text).slice(0, 160) });
      expectWords(o);
    });
  }, 300_000);

  /** One change, then a brand-new task `delayMs` after it, by delegate_bot and by ask_bot. */
  const afterChange = async (label: string, change: () => Promise<void>, delayMs: number) => {
    await only([lead.id, helper.id, asker.id, askHelper.id]);
    await waitWindowClosed(`${label}: before change`);
    const revokesBefore = revokeCount();
    const at = Date.now();
    await change();
    const state = windowState();
    measure({ kind: "change", label, revoked: revokeCount() - revokesBefore, stateRightAfter: state });
    // the window, sampled in the background while the fresh tasks run
    const watcher = waitWindowClosed(`${label}: window after change`, at);
    if (delayMs) await sleep(Math.max(0, delayMs - (Date.now() - at)));
    // lead and asker are in different sections, so each one's list_bots names only its own teammate
    const [d, a] = await Promise.all([delegateOnce(`${label}-delegate`, lead, helper), askOnce(`${label}-ask`, asker, askHelper)]);
    await watcher;
    expectWords(d);
    expectWords(a);
  };

  it("b. a settings change, a permission change or 'talk to everyone', then a brand-new task at once, 1 s, 10 s and 60 s later", async () => {
    await record("b", async () => {
      let flip = false;
      const settings = async () => { flip = !flip; expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active", excludedThreadIds: flip ? [qAsker.threadId] : [] })).status).toBe(200); };
      let all = false;
      const talkToEveryone = async () => { all = !all; expect((await api("PATCH", `/api/bots/${qAsker.id}/message-allow`, { mode: all ? "all" : "team" })).status).toBe(200); };
      let auto = false;
      const permission = async () => { auto = !auto; expect((await api("PATCH", `/api/bots/${qHelper.id}`, { autoApprove: auto, acknowledgeLocalAuto: true })).status).toBe(200); };
      const failures: string[] = [];
      const quick = process.env.LP_QUICK === "1";
      for (const [name, change] of (quick ? [["settings", settings]] : [["talk-to-everyone", talkToEveryone], ["permission", permission], ["settings", settings]]) as Array<[string, () => Promise<void>]>) {
        try { await afterChange(`b-${name}-0s`, change, 0); } catch (error) { failures.push(`${name}-0s: ${(error as Error).message.slice(0, 400)}`); }
      }
      for (const delay of quick ? [60_000] : [1_000, 10_000, 60_000]) {
        try { await afterChange(`b-settings-${delay / 1000}s`, settings, delay); } catch (error) { failures.push(`settings-${delay / 1000}s: ${(error as Error).message.slice(0, 400)}`); }
      }
      expect(failures).toEqual([]);
    });
  }, 900_000);

  it("c. a roster change (a bot added, a bot removed), then a fresh task", async () => {
    await record("c", async () => {
      const failures: string[] = [];
      let added: { id: string } | undefined;
      try { await afterChange("c-add-bot", async () => { added = await makeBot("Newcomer", "Alpha", "helper"); await api("PATCH", `/api/bots/${added.id}`, { hidden: true }); }, 0); } catch (error) { failures.push(`add: ${(error as Error).message.slice(0, 400)}`); }
      try { await afterChange("c-remove-bot", async () => { expect((await api("DELETE", `/api/bots/${added!.id}`)).status).toBe(200); }, 0); } catch (error) { failures.push(`remove: ${(error as Error).message.slice(0, 400)}`); }
      expect(failures).toEqual([]);
    });
  }, 600_000);

  it("d. a server restart between the change and the fresh task, and a restart in the middle of a delegation", async () => {
    await record("d", async () => {
      await only([lead.id, helper.id, asker.id, askHelper.id]);
      await waitWindowClosed("d: before change");
      expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active", excludedThreadIds: [qHelper.threadId] })).status).toBe(200);
      measure({ kind: "change", label: "d-settings-then-restart", stateRightAfter: windowState() });
      await stop();
      const restartAt = Date.now();
      await start();
      measure({ kind: "restart", label: "d", state: windowState() });
      const watcher = waitWindowClosed("d: window after restart", restartAt);
      const [d, a] = await Promise.all([delegateOnce("d-delegate-after-restart", lead, helper), askOnce("d-ask-after-restart", asker, askHelper)]);
      await watcher;
      expectWords(d); expectWords(a);
      // mid-delegation: the teammate is working on the hand-off when the server stops
      const gated = await makeBot("SlowHelper", "Delta", "helperGate2");
      const deltaLead = await makeBot("DeltaLead", "Delta", "lead");
      await only([deltaLead.id, gated.id]);
      await waitWindowClosed("d: before mid-delegation");
      rmSync(gate2File, { force: true });
      const seen = await snapshotSeen();
      expect((await api("POST", `/api/bots/${deltaLead.id}/messages`, { text: "d-mid: please pick this up" })).status).toBe(202);
      await waitUntil(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === gated.id)?.busy || false, 30_000, "slow helper never started");
      await stop();
      writeFileSync(gate2File, "go");
      await start();
      // what comes back: the teammate's reply, or the explicit restart line (delegations.ts settleAfterFailure: a turn the provider accepted
      // is never run again, the owner gets "interrupted by a restart"); never a withheld, checking or no-answer line
      const tail = async (id: string) => (await bot(id)).messages.slice(-8).map((m: any) => [m.id, m.role, m.kind, m.from?.botId, String(m.text ?? "").slice(0, 100)]);
      const returned = await waitUntil(async () => { const b = await bot(deltaLead.id); return b.messages.find((m: any) => !seen.has(`${b.threadId}:${m.id}`) && m.role === "bot" && (m.from?.botId === gated.id || String(m.id).startsWith("dres-") || /restart/i.test(String(m.text ?? "")))) || false; }, 90_000, "mid-delegation result never came back after the restart")
        .catch(async error => { throw new Error(`${(error as Error).message.slice(0, 300)}\nlead tail: ${JSON.stringify(await tail(deltaLead.id))}\nhelper tail: ${JSON.stringify(await tail(gated.id))}\nstate: ${JSON.stringify(windowState())}`); });
      await idleBots([deltaLead.id, gated.id]);
      const rows = await newOwnerRows(seen);
      // the explicit outcome a restart gives (never a withheld, checking or no-answer line): the restart receipt, or the failed-delegation
      // receipt when the teammate's turn died with the server ("Delegation to @X did not finish"), carried as the dres activity row's tool name
      const restartLine = /interrupted by a restart|Murage restarted while handing|receipt_restart|did not finish/.test(`${returned.text ?? ""} ${JSON.stringify(returned.murage ?? "")} ${JSON.stringify((returned as any).tool ?? "")}`);
      const o = { label: "d-mid-delegation", wordsInRow: /Delegated by @DeltaLead|delegated task/.test(String(returned.text)) || restartLine, bad: badRows(rows).map(m => `${m.where}: ${String(m.text).slice(0, 120)}`) };
      measure({ kind: "mid-restart", ...o, restartLine, rowText: String(returned.text).slice(0, 200), row: JSON.stringify(returned).slice(0, 400) });
      reasons("d-mid-delegation (helper)", gated.threadId); reasons("d-mid-delegation (lead)", deltaLead.threadId);
      expectWords(o);
    });
  }, 600_000);

  it("f. a settings change, then a fresh task inside a team room and inside a person's conversation (what rooms and people get)", async () => {
    let flip = false;
    const settings = async () => { flip = !flip; expect((await api("POST", "/api/memory/action", { action: "configure", mode: "active", excludedThreadIds: flip ? [qAsker.threadId] : [] })).status).toBe(200); };
    const tailOf = (rows: any[]) => rows.slice(-8).map((m: any) => [m.id, m.role, m.kind, m.from?.botId, String(m.text ?? "").slice(0, 100)]);
    const failures: string[] = [];
    const check = (o: Parameters<typeof expectWords>[0]) => { try { expectWords(o); } catch (error) { failures.push((error as Error).message.slice(0, 500)); } };

    // a team room: the lead answers the room; its delegate_bot result is the teammate's row in the room, then the lead's follow-through
    const roomLead = await makeBot("RoomLead", "Echo", "lead"), roomHelper = await makeBot("RoomHelper", "Echo", "helper");
    const made = await api("POST", "/api/groups", { name: "Echo room", memberIds: [roomLead.id, roomHelper.id], setup: { bulletin: "team room", defaultResponder: { kind: "member", botId: roomLead.id } } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const room = made.body.group as { id: string; threadId: string };
    const roomRows = async () => ((await bots()).groups.find((g: any) => g.id === room.id)?.messages ?? []) as any[];
    const roomOnce = async (label: string) => {
      const seen = await snapshotSeen();
      const before = windowState();
      const sentAt = Date.now();
      rmSync(promptDump, { force: true });
      expect([200, 202]).toContain((await api("POST", `/api/groups/${room.id}/messages`, { text: `${label}: please pick this up` })).status);
      const result = await waitUntil(async () => (await roomRows()).find((m: any) => !seen.has(`${room.threadId}:${m.id}`) && m.role === "bot" && m.from?.botId === roomHelper.id) || false, 90_000, `${label}: the teammate's result never came back to the room`)
        .catch(async error => { throw new Error(`${(error as Error).message.slice(0, 300)}\nroom tail: ${JSON.stringify(tailOf(await roomRows()))}\nhelper tail: ${JSON.stringify(tailOf((await bot(roomHelper.id)).messages))}`); });
      await idleBots([roomLead.id, roomHelper.id]);
      const wakePrompt = existsSync(promptDump) ? readFileSync(promptDump, "utf8") : "";
      const rows = await newOwnerRows(seen);
      const outcome = { kind: "room", label, ms: Date.now() - sentAt, windowAtSend: before, windowAfter: windowState(), rowText: String(result.text).slice(0, 160),
        wordsInRow: String(result.text).includes(HELPER_WORDS), wordsInWake: wakePrompt.includes(HELPER_WORDS), bad: badRows(rows).map(m => `${m.where}: ${String(m.text).slice(0, 120)}`) };
      measure(outcome);
      reasons(`${label} (helper)`, roomHelper.threadId); reasons(`${label} (room)`, room.threadId);
      return outcome;
    };
    const straddle = async <T>(label: string, send: () => Promise<T>): Promise<T> => {
      const pending = send();
      await sleep(400);
      const at = Date.now();
      await settings();
      measure({ kind: "change", label, stateRightAfter: windowState() });
      const watcher = waitWindowClosed(`${label}: window after change`, at);
      const out = await pending;
      await watcher;
      return out;
    };
    if (process.env.LP_PERSON_ONLY !== "1") await record("f-straddle-direct", async () => {
      await only([lead.id, helper.id]);
      await waitWindowClosed("f-straddle-direct: before");
      check(await straddle("f-straddle-direct", () => delegateOnce("f-straddle-direct-delegate", lead, helper)));
      expect(failures).toEqual([]);
    }).catch(error => { failures.push(`f-straddle-direct: ${(error as Error).message.slice(0, 600)}`); });
    if (process.env.LP_PERSON_ONLY !== "1") await record("f-room", async () => {
      await only([roomLead.id, roomHelper.id]);
      await waitWindowClosed("f-room: before");
      check(await roomOnce("f-room-base"));
      check(await straddle("f-room-straddle", () => roomOnce("f-room-straddle")));
      const at = Date.now();
      await settings();
      measure({ kind: "change", label: "f-room-settings", stateRightAfter: windowState() });
      const watcher = waitWindowClosed("f-room: window after change", at);
      check(await roomOnce("f-room-0s"));
      await watcher;
      check(await roomOnce("f-room-after-window"));
      expect(failures).toEqual([]);
    }).catch(error => { failures.push(`f-room: ${(error as Error).message.slice(0, 600)}`); });

    // a person's conversation: a Slack DM from a linked person to the paired lead (human-principals-api.test.ts fixture); the person sees what
    // Slack was sent (the fixture's send/edit traces), and the rows of the person's own conversation
    const personLead = await makeBot("PersonLead", "Foxtrot", "lead"), personHelper = await makeBot("PersonHelper", "Foxtrot", "helper");
    await only([personLead.id, personHelper.id]);
    expect((await api("PATCH", `/api/bots/${personLead.id}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200); // Slack pairs only with the Chief
    const event = (id: string, text: string, user = "UOTHER") => child.send({ kind: "slack-fixture-event", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000), authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOTHER", user, text } } });
    // the person's conversations: the DM thread first (made at the first event), then the nested threads a hand-off from it opens (the
    // teammate works in a request-bound nested thread, not in its own conversation; result-egress-privacy.test.ts)
    const personThreads = (): string[] => {
      let db: DatabaseSync | undefined;
      try { db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true }); return (db.prepare("SELECT subject_id FROM memory_scope_bindings WHERE subject_type='human-thread' ORDER BY rowid").all() as Array<{ subject_id: string }>).map(r => r.subject_id); }
      catch { return []; } finally { try { db?.close(); } catch { /* closed */ } }
    };
    /** The person's DM conversation: the thread holding the person's own row for this task (the nested threads hold the bots' rows only). */
    const personThread = (label: string) => {
      let db: DatabaseSync | undefined;
      try { db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true }); return (db.prepare("SELECT thread_id FROM messages WHERE role='user' AND text LIKE ? ORDER BY at DESC LIMIT 1").get(`%${label}: please pick this up%`) as { thread_id?: string } | undefined)?.thread_id; }
      catch { return undefined; } finally { try { db?.close(); } catch { /* closed */ } }
    };
    const personRows = (threadId: string) => {
      let db: DatabaseSync | undefined;
      try { db = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true }); return (db.prepare("SELECT id,role,kind,text,json FROM messages WHERE thread_id=? ORDER BY at").all(threadId) as any[]).map(m => ({ ...m, from: (() => { try { return JSON.parse(m.json).from; } catch { return undefined; } })() })); }
      catch { return [] as any[]; } finally { try { db?.close(); } catch { /* closed */ } }
    };
    const personOnce = async (label: string) => {
      const before = windowState();
      const sentAt = Date.now();
      const from = traces.length;
      const seen = new Set(personThreads().flatMap(t => personRows(t).map(m => m.id)));
      rmSync(promptDump, { force: true });
      event(`Ev-${label}`, `${label}: please pick this up`);
      const result = await waitUntil(async () => { const t = personThread(label); return t ? personRows(t).find(m => !seen.has(m.id) && m.role === "bot" && ((m.kind === "text" && m.from?.botId === personHelper.id) || String(m.id).startsWith("dres-"))) || false : false; }, 120_000, `${label}: the teammate's result never reached the person's conversation`)
        .catch(async error => { throw new Error(`${(error as Error).message.slice(0, 300)}\nperson threads: ${JSON.stringify(personThreads().map(t => [t, tailOf(personRows(t))]))}\ntraces: ${JSON.stringify(traces.slice(from).map(t => [t.op, String(t.text ?? "").slice(0, 100)]))}`); });
      await idleBots([personLead.id, personHelper.id]);
      const sent = traces.slice(from).filter(t => t.op === "send" || t.op === "edit").map(t => String(t.text ?? ""));
      const wakePrompt = existsSync(promptDump) ? readFileSync(promptDump, "utf8") : "";
      const dm = personThread(label) ?? "";
      const outcome = { kind: "person", label, ms: Date.now() - sentAt, windowAtSend: before, windowAfter: windowState(), rowText: String(result.text).slice(0, 160), slack: sent.map(t => t.slice(0, 120)),
        wordsInRow: String(result.text).includes(HELPER_WORDS), wordsInWake: wakePrompt.includes(HELPER_WORDS), bad: [...sent.filter(t => BAD.test(t)).map(t => `slack: ${t.slice(0, 120)}`), ...personRows(dm).filter(m => !seen.has(m.id) && BAD.test(String(m.text ?? ""))).map(m => `person: ${String(m.text).slice(0, 120)}`)],
        dmTail: tailOf(personRows(dm).filter(m => !seen.has(m.id))), resultRow: String(result.json ?? "").slice(0, 500) };
      measure(outcome);
      reasons(`${label} (dm)`, dm); personThreads().forEach((t, i) => reasons(`${label} (nested ${i})`, t));
      return outcome;
    };
    await record("f-person", async () => {
      expect((await api("PATCH", "/api/config?secretStorage=external", { slack: { appToken: "xapp-fixture-not-real", botToken: "xoxb-fixture-not-real", teamId: "TEAM", appId: "APP", ownerUserId: "UOTHER" } })).status).toBe(200);
      const pairing = await api("POST", "/api/slack/pair", { targetBotId: personLead.id });
      expect(pairing.status, JSON.stringify(pairing.body)).toBe(200);
      event("EvPAIR", "/pair " + pairing.body.code);
      await waitUntil(async () => (await api("GET", "/api/slack/status")).body.paired || false, 20_000, "slack pairing never completed");
      event("EvFIRST", "hello there");
      await waitUntil(async () => traces.some(t => t.eventId === "EvFIRST") || false, 20_000, "the first person event was never acknowledged");
      const binding = (await api("POST", "/api/memory/action", { action: "humans" })).body.bindings?.[0];
      expect(binding, "no human binding to link").toBeTruthy();
      expect((await api("POST", "/api/memory/action", { action: "human-link", bindingId: binding.id, expectedRevision: binding.revision, as: "person" })).status).toBe(200);
      // measured, not required: with memory on, a delegated reply never reaches a linked person today, changed or not (the dres row carries
      // "Delegation to @X did not finish: Result not shown: where it came from was not recorded", result-egress.ts origin_unconfirmed on the
      // nested hand-off, not a revocation). What this flow guards is that no withheld, checking or no-answer line reaches the person either.
      const noBad = (o: { label: string; bad: string[]; wordsInRow: boolean }) => { measure({ kind: "person-verdict", label: o.label, words: o.wordsInRow }); expect({ label: o.label, bad: o.bad }).toEqual({ label: o.label, bad: [] }); };
      await waitWindowClosed("f-person: before");
      noBad(await personOnce("f-person-base"));
      const at = Date.now();
      await settings();
      measure({ kind: "change", label: "f-person-settings", stateRightAfter: windowState() });
      const watcher = waitWindowClosed("f-person: window after change", at);
      noBad(await personOnce("f-person-0s"));
      await watcher;
      noBad(await personOnce("f-person-after-window"));
    }).catch(error => { failures.push(`f-person: ${(error as Error).message.slice(0, 3000)}`); });
    measure({ kind: "f-summary", failures });
    expect(failures).toEqual([]);
  }, 900_000);

  it("e. data from 1.0.2 with a frozen \"[Reply withheld]\" row: after the upgrade start the owner sees the teammate's words beside it", async () => {
    await record("e", async () => {
      await only([lead.id, helper.id]);
      await waitWindowClosed("e: before");
      const done = await delegateOnce("e-source", lead, helper);
      expectWords(done);
      const rowId = String(done.result.id);
      expect(rowId.startsWith("dres-")).toBe(true);
      await stop();
      // the row as 1.0.2 froze it (frozen-replies.ts R6: the wrapper ending in the fixed line, no copy link)
      const db = new DatabaseSync(join(home, ".murage", "messages.db"));
      const stored = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(lead.threadId, rowId) as { json: string };
      const message = JSON.parse(stored.json);
      const frozenText = `@Helper replied to the delegated task:\n\n[Reply withheld: it used something you deleted or changed]`;
      delete message.copyOf; delete message.murage; message.text = frozenText;
      db.prepare("UPDATE messages SET text=?, json=? WHERE thread_id=? AND id=?").run(frozenText, JSON.stringify(message), lead.threadId, rowId);
      db.close();
      rmSync(join(home, ".murage", "frozen-replies-recovery.json"), { force: true });
      await start();
      const restored = await waitUntil(async () => { const b = await bot(lead.id); return b.messages.find((m: any) => m.id === `${rowId}-restored`) || false; }, 120_000, "the frozen reply was never restored");
      measure({ kind: "frozen", restoredText: String(restored.text).slice(0, 160), state: windowState() });
      expect(String(restored.text)).toContain(HELPER_WORDS);
      expect(String(restored.text)).not.toMatch(BAD);
    });
  }, 300_000);
});
