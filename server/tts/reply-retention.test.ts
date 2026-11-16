// D24-SPEECH-RETENTION (design r5.1 + r5.2 + r5.3, frontier retention): every insert into a spoken-reply family first deletes at most two of
// that family's dead rows, found by one seek whose range is the dead set, inside the insert's transaction. There is no cursor. Every family
// stays within max(start, B) at every instant; no turn-path statement visits history; nothing live goes; no old reply is spoken again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { deleteSpeechSendMarkers, initializeReplySchema } from "./reply-schema.ts";
import {
  ReplyState, speechTransaction, SpeechRefusal, SPEECH_CLOSE_ACTIVE, SPEECH_COMMAND_RECONCILE, SPEECH_COMMAND_SETTLE, SPEECH_COMMAND_WINDOW,
  SPEECH_GENERATION_LOOKUP, SPEECH_GENERATION_LOOKUP_BOT, SPEECH_INVALIDATE_RUNNING, SPEECH_RECOVER_SESSIONS, SPEECH_RETAIN_MS, SPEECH_RETENTION_DELETES,
  SPEECH_MARKER_BOTS, SPEECH_RETENTION_SQL, SPEECH_RETENTION_TABLES, SPEECH_RETIRE_RUNNING,
  type SpeechConnection, type SpeechEvent, type SpeechReservation, type SpeechRetentionScope, type SpeechRetentionTable,
} from "./reply-state.ts";
import { SPEECH_INDEXES_AFTER_117 } from "../installation-app-schema-downgrade.ts";
import { ADDED_TABLE_LIFECYCLE } from "../added-table-lifecycle.ts";
import { initializeOwnerSends, SendStore } from "../send-store.ts";
import { afterCommit, scopedTx } from "../tx-scope.ts";

const DAY = 24 * 60 * 60 * 1000;
type Ready = Extract<SpeechEvent, { kind: "speech.ready" }>;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });

/** A world: one database, one ReplyState. `keepAll` makes the unpruned twin: every delete on a retained table is ignored, so the twin is the
 *  full ledger the retained world is compared with. */
function world(options: { reconcileEveryTx?: boolean; keepAll?: boolean; ownerSends?: boolean } = {}) {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeReplySchema(db);
  if (options.ownerSends !== false) db.exec("CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, send_id TEXT); CREATE UNIQUE INDEX owner_sends_send ON owner_sends(thread_id, send_id);");
  if (options.keepAll) for (const table of SPEECH_RETENTION_TABLES) db.exec(`CREATE TRIGGER keep_${table} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
  const clock = { now: 1_000_000_000 };
  const plain = speechTransaction(db);
  // the pre-r3 behaviour, for the equivalence test: the global reconciliation after every speech transaction
  const tx: typeof plain = options.reconcileEveryTx ? work => plain(inner => { const result = work(inner); inner.exec(SPEECH_COMMAND_RECONCILE); return result; }) : plain;
  const make = () => { const state = new ReplyState({ db: () => db, transaction: tx, now: () => clock.now }); state.boot(); return state; };
  let state = make();
  const connection = (id: string): SpeechConnection => ({ id, principal: "owner", send: vi.fn(() => true), terminate: vi.fn() });
  const count = (table: string, where = "1") => Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get()!.n);
  /** Steps one family until a step removes nothing (tests only; inserts run the same step themselves). */
  const sweep = (table: SpeechRetentionTable, scope: SpeechRetentionScope = {}) => { for (let i = 0; i < 1_000_000; i++) if (!state.retainSpeechRows(table, scope).removed) return; };
  /** One owner turn as index.ts and the store hooks drive it: the prompt, begin, the provider id, the settled reply. */
  let turns = 0;
  const turn = (thread = "thread", bot = "bot", provider?: string) => {
    const n = ++turns, generation = `g${n}`, message = `m${n}`;
    state.prompt(thread, `message:u${n}`);
    state.begin(thread, bot, generation, `u${n}`);
    state.bind(generation, provider ?? `p${n}`);
    const ready = state.settle(thread, provider ?? `p${n}`, message, true, bot) as Ready | undefined;
    return { generation, message, ready };
  };
  /** A generation of `bot` bound to `provider` and ended without a prompt (no revision bump). */
  let quiet = 0;
  const ended = (thread: string, bot: string, provider?: string) => {
    const id = `q${++quiet}`;
    state.begin(thread, bot, id, "u"); state.bind(id, provider ?? `qp${quiet}`); state.invalidateGeneration(thread, id);
    return id;
  };
  const dump = () => SPEECH_RETENTION_TABLES.map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return { db, clock, tx, get state() { return state; }, reboot: () => { state = make(); return state; }, connection, count, sweep, turn, ended, dump };
}
type World = ReturnType<typeof world>;
function speaker(w: World, thread = "thread", connectionId = "connection", botId = "bot") {
  const connection = w.connection(connectionId);
  const session = w.state.session(connection, thread);
  const account = w.state.account("binding", "credential");
  let sequence = 0;
  const input = (messageId: string, action?: "speak", settlementId?: string, commandSequence = ++sequence): SpeechReservation => ({ sessionId: session.sessionId, principal: "owner", connectionId, threadId: thread, messageId, commandSequence, action, settlementId });
  const target = (messageId: string, bot = botId) => () => ({ target: { threadId: thread, messageId, botId: bot, eligible: true }, account });
  const cancel = (commandSequence = ++sequence) => w.state.cancel({ sessionId: session.sessionId, principal: "owner", connectionId, threadId: thread, commandSequence });
  return { session, account, input, target, connection, cancel, get sequence() { return sequence; }, set sequence(value: number) { sequence = value; } };
}
const refusal = (run: () => unknown) => { try { run(); } catch (error) { if (error instanceof SpeechRefusal) return { status: error.status, code: error.code }; throw error; } return null; };
const ids = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${n}) `;
/** Generations of one (bot, thread) pair and that pair's bound B (design r5.1 G: 18 + running). */
const pair = (w: World, bot: string, thread: string) => ({
  rows: w.count("speech_generations", `bot_id='${bot}' AND thread_id='${thread}'`),
  bound: 18 + w.count("speech_generations", `bot_id='${bot}' AND thread_id='${thread}' AND state='running'`),
});

describe("D24-SPEECH-RETENTION r5: every family stays within max(start, B) at every instant", () => {
  it("5,000 busy owner turns: after every turn each pair <= 18 + running, settlements <= the day's + 1, send markers <= owner rows (ret-H2-bound-every-op)", () => {
    const w = world();
    let bStarSettlements = 0;
    for (let i = 0; i < 5000; i++) {
      const thread = `t${i % 5}`, bot = i % 2 ? "bot-a" : "bot-b";
      w.db.prepare("INSERT INTO owner_sends (thread_id, send_id) VALUES (?,?)").run(thread, `s${i}`);
      w.state.acceptPrompt(thread, `s${i}`);
      // the send ledger keeps its newest 20 rows; each delete takes its marker in the same transaction, as SendStore does
      const old = w.db.prepare("SELECT thread_id, send_id FROM owner_sends WHERE seq <= ?").all(i - 20) as Array<{ thread_id: string; send_id: string }>;
      w.tx(db => { for (const row of old) { db.prepare("DELETE FROM owner_sends WHERE thread_id=? AND send_id=?").run(row.thread_id, row.send_id); deleteSpeechSendMarkers(db, row.thread_id, [row.send_id]); } });
      w.turn(thread, bot);
      const newest = Number(w.db.prepare("SELECT max(settled_at) AS s FROM speech_settlements").get()!.s);
      bStarSettlements = Math.max(bStarSettlements, w.count("speech_settlements", `settled_at > ${newest - DAY}`) + 1);
      expect(w.count("speech_settlements")).toBeLessThanOrEqual(bStarSettlements);
      for (const b of ["bot-a", "bot-b"]) { const p = pair(w, b, thread); expect(p.rows).toBeLessThanOrEqual(p.bound); }
      expect(w.count("speech_prompts", "prompt_id LIKE 'send:%'")).toBeLessThanOrEqual(w.count("owner_sends"));
      expect(w.count("speech_prompts", "prompt_id LIKE 'message:%'")).toBe(0);
      w.clock.now += 60 * 60 * 1000;
    }
    expect(bStarSettlements).toBeLessThanOrEqual(26);
  });

  it("a backlog falls by exactly one with each insert that finds two dead rows (each step removes 2, the insert adds 1)", () => {
    const w = world();
    w.db.exec(`${ids(20000)} INSERT INTO speech_settlements SELECT 'old'||i,'og'||i,'thread','om'||i,0,'earlier-boot',0,'completed' FROM n`);
    let before = w.count("speech_settlements");
    for (let i = 0; i < 1000; i++) {
      w.turn(`t${i % 3}`);
      const now = w.count("speech_settlements");
      expect(now).toBe(before - 1);
      before = now;
    }
  });

  it("stopped inserts: nothing grows and nothing is removed while nothing is inserted", () => {
    const w = world();
    for (let i = 0; i < 50; i++) w.turn();
    const before = w.dump();
    w.clock.now += 30 * DAY;
    expect(w.dump()).toEqual(before);
  });

  it("each step deletes at most 2 rows, inside the inserting transaction; a rolled-back insert rolls its step back", () => {
    const w = world();
    w.db.exec(`${ids(3)} INSERT INTO speech_settlements SELECT 'old'||i,'og'||i,'thread','om'||i,0,'earlier-boot',0,'completed' FROM n`);
    expect(w.state.retainSpeechRows("speech_settlements").removed).toBe(SPEECH_RETENTION_DELETES);
    expect(w.count("speech_settlements")).toBe(1);
    expect(w.state.retainSpeechRows("speech_settlements").removed).toBe(1);
    w.db.exec(`${ids(2)} INSERT INTO speech_settlements SELECT 'x'||i,'xg'||i,'thread','xm'||i,0,'earlier-boot',0,'completed' FROM n`);
    w.state.begin("thread", "bot", "g", "u"); w.state.bind("g", "p");
    w.db.exec("CREATE TRIGGER fail_settle BEFORE INSERT ON speech_settlements BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => w.state.settle("thread", "p", "m", true, "bot")).toThrow();
    expect(w.count("speech_settlements")).toBe(2);
  });

  it("an outer transaction that throws after the steps leaves every table and the marker map exactly as before (ret-H1-rollback)", () => {
    const w = world();
    for (let i = 0; i < 30; i++) w.turn("thread", "bot", "dup");
    w.state.begin("thread", "bot-2", "running", "u"); w.state.bind("running", "dup");
    w.clock.now += 2 * DAY;
    const before = w.dump(), markers = w.state.ambiguityMarkers();
    for (let i = 0; i < 20; i++) {
      expect(() => w.tx(() => { w.turn("thread", "bot", "dup"); w.state.begin("thread", "bot", `x${i}`, "u"); throw new Error("rolled back"); })).toThrow("rolled back");
      expect(w.dump()).toEqual(before);
      expect(w.state.ambiguityMarkers()).toEqual(markers);
    }
    // the next insert deletes the same rows the rolled-back one did
    w.state.begin("thread", "bot", "after", "u");
    expect(pair(w, "bot", "thread").rows).toBeLessThan(31);
  });

  it("a restart before every insert never lets a pair grow (ret-H1-restart-per-insert, Astra r4's counterexample)", () => {
    const w = world();
    // four live rows of pair A at the front of the table
    for (let i = 0; i < 4; i++) w.ended("thread", "bot-a");
    for (let i = 0; i < 2000; i++) {
      w.reboot();
      w.ended("thread", "bot-b");
      const b = pair(w, "bot-b", "thread");
      expect(b.rows).toBeLessThanOrEqual(b.bound);
      expect(w.count("speech_sessions")).toBe(0);
    }
    expect(pair(w, "bot-a", "thread").rows).toBe(4);
  });

  it("the generations table's highest rowid is never deleted, and a pair's thresholds never fall (ret-H2-rowid)", () => {
    const w = world();
    let floor = 0;
    for (let i = 0; i < 400; i++) {
      const bot = `bot${i % 3}`;
      w.ended("thread", bot);
      const max = Number(w.db.prepare("SELECT max(rowid) AS r FROM speech_generations").get()!.r);
      expect(max).toBeGreaterThan(floor);
      floor = max;
      const r8 = w.db.prepare(SPEECH_RETENTION_SQL.newestBoundInPair).get(bot, "thread");
      if (r8) expect(w.count("speech_generations", `bot_id='${bot}' AND provider_turn_id IS NOT NULL AND rowid >= ${Number(r8.r)}`)).toBe(8);
    }
  });
});

describe("D24-SPEECH-RETENTION r5: sessions and commands, one family", () => {
  it("thread views open a session each; closed sessions and their commands stay within 257 x active", () => {
    const w = world();
    const connection = w.connection("c");
    for (let i = 0; i < 2000; i++) {
      const session = w.state.session(connection, `t${i}`);
      w.state.cancel({ sessionId: session.sessionId, principal: "owner", connectionId: "c", threadId: `t${i}`, commandSequence: 1 });
      expect(w.count("speech_sessions") + w.count("speech_commands")).toBeLessThanOrEqual(257 * 1 + 1);
    }
    expect(w.count("speech_sessions", "state='active'")).toBe(1);
  });

  it("the real 257th reserve measures the window from its own sequence (ret-C-257th-reserve, M13b)", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w);
    for (let i = 0; i < 256; i++) s.cancel();
    expect(w.count("speech_commands")).toBe(256);
    w.state.finish(w.state.reserve(s.input(t.message, "speak"), s.target(t.message)), "complete");
    expect(w.count("speech_commands")).toBe(SPEECH_COMMAND_WINDOW);
    expect(w.count("speech_commands", "sequence=1")).toBe(0);
    expect(w.count("speech_commands", "sequence=2")).toBe(1);
  });

  it("an active session keeps 256 positions: last - 255 stays, last - 256 goes, and the stored answers replay before that", () => {
    const w = world();
    const s = speaker(w);
    const t = [w.turn(), w.turn(), w.turn(), w.turn()];
    const stored: Array<[number, number]> = [];
    const finishWith = (messageId: string, outcome: "complete" | "failed" | "budget") => {
      const input = s.input(messageId, "speak");
      w.state.finish(w.state.reserve(input, s.target(messageId)), outcome);
      w.clock.now += 61_000;
      return input.commandSequence;
    };
    stored.push([finishWith(t[0].message, "complete"), 200]);
    stored.push([finishWith(t[1].message, "failed"), 502]);
    s.cancel(); stored.push([s.sequence, 204]);
    stored.push([finishWith(t[2].message, "budget"), 402]);
    const attempts = w.count("speech_attempts");
    for (const [sequence, status] of stored) expect(refusal(() => w.state.reserve(s.input(t[3].message, "speak", undefined, sequence), s.target(t[3].message)))).toEqual({ status, code: "duplicate_command" });
    for (let i = 0; i < 300; i++) s.cancel();
    const last = s.sequence;
    expect(w.count("speech_commands", `sequence=${last - 255}`)).toBe(1);
    expect(w.count("speech_commands", `sequence=${last - 256}`)).toBe(0);
    expect(w.count("speech_commands")).toBe(256);
    for (const [sequence] of stored) expect(refusal(() => w.state.reserve(s.input(t[3].message, "speak", undefined, sequence), s.target(t[3].message)))).toEqual({ status: 409, code: "stale_command" });
    expect(w.count("speech_attempts")).toBe(attempts);
  });

  it("a sequence jump of a million never grows the session's commands (ret-C-jump)", () => {
    const w = world();
    const s = speaker(w);
    for (let i = 0; i < 10; i++) s.cancel();
    let before = w.count("speech_commands");
    s.sequence = 1_000_000;
    for (let i = 0; i < 20; i++) { s.cancel(); const now = w.count("speech_commands"); expect(now).toBeLessThanOrEqual(Math.max(before, SPEECH_COMMAND_WINDOW)); before = now; }
    expect(w.count("speech_commands", "sequence < 1000000")).toBe(0);
  });

  it("another active session's old backlog never grows while this session works (ret-C-other-backlog)", () => {
    const w = world();
    const other = speaker(w, "other", "c-other");
    w.db.exec(`${ids(10000)} INSERT INTO speech_commands SELECT '${other.session.sessionId}',i,204,'cancelled',NULL FROM n`);
    w.db.prepare("UPDATE speech_sessions SET last_sequence=10000 WHERE session_id=?").run(other.session.sessionId);
    const s = speaker(w);
    for (let i = 0; i < 500; i++) { s.cancel(); expect(w.count("speech_commands", `session_id='${other.session.sessionId}'`)).toBe(10000); }
    expect(w.count("speech_commands", `session_id='${s.session.sessionId}'`)).toBe(256);
  });

  it("a command insert never deletes an open session or its window; only closed sessions and their commands go (MurageMain 18:5xZ)", () => {
    const w = world();
    const open = Array.from({ length: 5 }, (_, i) => speaker(w, `open${i}`, `open-c${i}`));
    for (const s of open) for (let i = 0; i < 10; i++) s.cancel();
    for (let i = 0; i < 20; i++) { const s = speaker(w, `gone${i}`, `gone-c${i}`); for (let j = 0; j < 5; j++) s.cancel(); w.state.closeConnection(`gone-c${i}`); }
    const worker = open[0]!;
    for (let i = 0; i < 200; i++) {
      worker.cancel();
      for (const s of open) expect(w.count("speech_sessions", `session_id='${s.session.sessionId}' AND state='active'`)).toBe(1);
      for (const s of open.slice(1)) expect(w.count("speech_commands", `session_id='${s.session.sessionId}'`)).toBe(10);
    }
    expect(w.count("speech_sessions", "state='closed'")).toBe(0);
    expect(w.count("speech_commands")).toBe(4 * 10 + 210);
  });

  it("a session deleted only after its commands; a closed session's pending command goes and finish still succeeds (M7)", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w, "thread", "c1");
    const attempt = w.state.reserve(s.input(t.message, "speak"), s.target(t.message));
    w.db.prepare("UPDATE speech_sessions SET state='closed' WHERE session_id=?").run(s.session.sessionId);
    for (let i = 0; i < 3; i++) {
      w.state.retainSpeechRows("speech_sessions");
      const sessions = w.count("speech_sessions", `session_id='${s.session.sessionId}'`), commands = w.count("speech_commands", `session_id='${s.session.sessionId}'`);
      if (commands) expect(sessions).toBe(1);
    }
    expect(w.count("speech_commands", `session_id='${s.session.sessionId}'`)).toBe(0);
    expect(w.count("speech_sessions", `session_id='${s.session.sessionId}'`)).toBe(0);
    expect(() => w.state.finish(attempt, "complete")).not.toThrow();
  });

  it("a failed close leaves the session active only until the next session() closes it (ret-C-unclosed)", () => {
    const w = world();
    const s = speaker(w, "thread", "c1");
    w.db.exec("CREATE TRIGGER fail_close BEFORE UPDATE ON speech_sessions BEGIN SELECT RAISE(ABORT, 'close failed'); END");
    expect(() => w.state.closeConnection("c1")).toThrow();
    w.db.exec("DROP TRIGGER fail_close");
    expect(w.count("speech_sessions", `session_id='${s.session.sessionId}' AND state='active'`)).toBe(1);
    w.state.session(w.connection("c2"), "thread");
    expect(w.count("speech_sessions", `session_id='${s.session.sessionId}' AND state='active'`)).toBe(0);
    expect(w.count("speech_sessions", "state='active'")).toBe(1);
  });

  it("recover and closeConnection close only active sessions, behind an index, among a million closed ones (ret-H4-close-recover)", { timeout: 300_000 }, () => {
    const w = world();
    w.db.exec(`${ids(1_000_000)} INSERT INTO speech_sessions(session_id,principal,connection_id,thread_id,boot_id,state) SELECT 'old'||i,'owner','c1','thread','b','closed' FROM n`);
    const updates: string[] = [];
    const prepare = w.db.prepare.bind(w.db);
    w.db.prepare = ((sql: string) => { if (/UPDATE speech_sessions/.test(sql)) updates.push(sql); return prepare(sql); }) as typeof w.db.prepare;
    try {
      speaker(w, "thread", "c1");
      w.state.closeConnection("c1");
    } finally { w.db.prepare = prepare; }
    for (const sql of updates) expect(sql).toMatch(/state='active'|session_id=\?/);
    expect(w.count("speech_sessions", "state='active'")).toBe(0);
    for (const sql of [SPEECH_RECOVER_SESSIONS, "UPDATE speech_sessions SET state='closed' WHERE connection_id=? AND state='active'"]) {
      const plan = (w.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.match(/\?/g) ?? []).map(() => "x")) as Array<{ detail: string }>).map(row => row.detail).join(" | ");
      expect(plan).toMatch(/SEARCH speech_sessions USING INDEX speech_session_(active|connection)/);
    }
  });
});

describe("D24-SPEECH-RETENTION r5: live state survives", () => {
  it("the 10-minute hold after an interrupted attempt outlives a month of inserts", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w);
    w.state.reserve(s.input(t.message, "speak"), s.target(t.message));
    w.reboot();
    const held = Number(w.db.prepare("SELECT hold_until FROM speech_accounts").get()!.hold_until);
    expect(held).toBeGreaterThanOrEqual(w.clock.now + 600_000);
    w.clock.now += 30 * DAY;
    for (let i = 0; i < 20; i++) w.turn();
    expect(Number(w.db.prepare("SELECT hold_until FROM speech_accounts").get()!.hold_until)).toBe(held);
    expect(w.count("speech_accounts")).toBe(1);
  });

  it("before boot nothing is removed: a retention step refuses with 409 and changes no row (M9)", () => {
    const w = world();
    w.state.session(w.connection("c"), "t"); w.state.closeConnection("c");
    const fresh = new ReplyState({ db: () => w.db, transaction: w.tx, now: () => w.clock.now });
    for (const table of SPEECH_RETENTION_TABLES) expect(refusal(() => fresh.retainSpeechRows(table, { botId: "bot", threadId: "t" }))).toEqual({ status: 409, code: "speech_unavailable" });
    expect(w.count("speech_sessions")).toBe(1);
  });

  it("attempts inside the rate windows stay and still refuse the quota; only terminal attempts a day old go", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w);
    for (let i = 0; i < 3; i++) { const attempt = w.state.reserve(s.input(t.message, "speak"), s.target(t.message)); w.state.finish(attempt, "complete"); w.clock.now += 1000; }
    w.sweep("speech_attempts");
    expect(w.count("speech_attempts")).toBe(3);
    expect(refusal(() => w.state.reserve(s.input(t.message, "speak"), s.target(t.message)))).toEqual({ status: 429, code: "voice_quota" });
    const newest = Number(w.db.prepare("SELECT max(reserved_at) AS r FROM speech_attempts").get()!.r);
    const oldest = Number(w.db.prepare("SELECT min(reserved_at) AS r FROM speech_attempts").get()!.r);
    w.clock.now = oldest + SPEECH_RETAIN_MS;
    w.sweep("speech_attempts");
    expect(w.count("speech_attempts")).toBe(2);
    w.clock.now = newest + SPEECH_RETAIN_MS - 1;
    w.sweep("speech_attempts");
    expect(w.count("speech_attempts")).toBe(1);
  });

  it("a reserved attempt a day old stays (M1: the terminal state alone decides)", () => {
    const w = world();
    w.db.prepare("INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state) VALUES('live','s',1,'quiet','m','manual',0,?,0,'a','p','reserved')").run(w.state.bootId);
    w.clock.now += 2 * DAY;
    w.sweep("speech_attempts");
    expect(w.count("speech_attempts", "attempt_id='live'")).toBe(1);
  });

  it("reserved attempts, pending commands, running generations and active sessions survive any age", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w);
    const attempt = w.state.reserve(s.input(t.message, "speak"), s.target(t.message));
    w.state.begin("thread", "bot", "running", "u");
    w.state.bind("running", "p-running");
    w.clock.now += 365 * DAY;
    for (let i = 0; i < 40; i++) w.ended("thread", "bot");
    for (const table of ["speech_settlements", "speech_attempts", "speech_sessions"] as const) w.sweep(table);
    expect(w.count("speech_attempts", `attempt_id='${attempt.attemptId}'`)).toBe(1);
    expect(w.count("speech_commands", "outcome='pending'")).toBe(1);
    expect(w.count("speech_generations", "generation_id='running'")).toBe(1);
    expect(w.count("speech_sessions", "state='active'")).toBe(1);
    expect(w.state.current(attempt)).toBe(true);
  });

  it("an old terminal attempt goes even if a broken pending command names it, and that command still answers 409", () => {
    const w = world();
    const t = w.turn();
    const s = speaker(w);
    const input = s.input(t.message, "speak");
    const attempt = w.state.reserve(input, s.target(t.message));
    w.db.prepare("UPDATE speech_attempts SET state='complete', outcome='complete' WHERE attempt_id=?").run(attempt.attemptId);
    w.clock.now += 2 * DAY;
    w.sweep("speech_attempts");
    expect(w.count("speech_attempts", `attempt_id='${attempt.attemptId}'`)).toBe(0);
    expect(refusal(() => w.state.reserve(s.input(t.message, "speak", undefined, input.commandSequence), s.target(t.message)))).toEqual({ status: 409, code: "duplicate_command" });
  });

  it("an earlier boot's settlement stays until a day old and is never usable (the boot rule is dropped; reserve checks the boot)", () => {
    const w = world();
    const s0 = speaker(w);
    const t = w.turn();
    w.reboot();
    const s = speaker(w, "thread", "c2");
    w.state.retainSpeechRows("speech_settlements");
    expect(w.count("speech_settlements", `settlement_id='${t.ready!.settlementId}'`)).toBe(1);
    expect(refusal(() => w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message)))).toEqual({ status: 204, code: "stale_reply" });
    w.clock.now += DAY;
    w.state.retainSpeechRows("speech_settlements");
    expect(w.count("speech_settlements", `settlement_id='${t.ready!.settlementId}'`)).toBe(0);
    void s0;
  });

  it("only the thread's newest usable settlement protects; an expired or other-boot one does not (ret-H3-usable-only, M3)", () => {
    const usable = world();
    const first = usable.turn("thread", "bot", "p-first");
    for (let i = 0; i < 9; i++) usable.ended("thread", "bot");
    expect(usable.count("speech_generations", `generation_id='${first.generation}'`)).toBe(1);
    const s = speaker(usable);
    expect(usable.state.reserve(s.input(first.message, undefined, first.ready!.settlementId), s.target(first.message)).attemptId).toBeTruthy();

    const expired = world();
    const old = expired.turn("thread", "bot", "p-old");
    expired.clock.now += 60_001;
    for (let i = 0; i < 9; i++) expired.ended("thread", "bot");
    expect(expired.count("speech_generations", `generation_id='${old.generation}'`)).toBe(0);

    const rebooted = world();
    const before = rebooted.turn("thread", "bot", "p-before");
    rebooted.reboot();
    for (let i = 0; i < 9; i++) rebooted.ended("thread", "bot");
    expect(rebooted.count("speech_generations", `generation_id='${before.generation}'`)).toBe(0);
  });

  it("a protected front never hides dead rows: begin/bind/invalidate inside 60 s behind it keeps the pair at 18 + running (ret-G-protected-front)", () => {
    const w = world();
    w.turn("thread", "bot", "p-protected");
    for (let i = 0; i < 5000; i++) {
      w.ended("thread", "bot");
      const p = pair(w, "bot", "thread");
      expect(p.rows).toBeLessThanOrEqual(p.bound);
    }
  });

  it("an old running generation that completes after 8 newer bound ones is protected and still plays (ret-G-late-complete)", () => {
    const w = world();
    const s = speaker(w, "thread", "c", "bot");
    w.state.prompt("thread", "message:u");
    w.state.begin("thread", "bot", "old", "u"); w.state.bind("old", "p-old");
    for (let i = 0; i < 8; i++) w.ended("thread", "bot");
    const ready = w.state.settle("thread", "p-old", "m-old", true, "bot") as Ready;
    w.ended("thread", "bot");
    expect(w.count("speech_generations", "generation_id='old'")).toBe(1);
    expect(w.state.reserve(s.input("m-old", undefined, ready.settlementId), s.target("m-old")).attemptId).toBeTruthy();
  });

  it("G1, the one generation divergence besides G2: an older usable reply loses automatic play, 204, never a wrong one (ret-G1-twin)", () => {
    const run = (w: World) => {
      const s = speaker(w, "thread", "c", "bot-a");
      w.state.prompt("thread", "message:u");
      w.state.begin("thread", "bot-a", "ga", "u"); w.state.bind("ga", "pa");
      const a = w.state.settle("thread", "pa", "ma", true, "bot-a") as Ready;
      w.state.begin("thread", "bot-b", "gb", "u"); w.state.bind("gb", "pb");
      w.state.settle("thread", "pb", "mb", true, "bot-b");
      for (let i = 0; i < 8; i++) w.ended("thread", "bot-a");
      w.state.begin("thread", "bot-a", "ninth", "u");
      const present = w.count("speech_generations", "generation_id='ga'");
      return { present, answer: refusal(() => w.state.reserve(s.input("ma", undefined, a.settlementId), s.target("ma"))) };
    };
    expect(run(world({ keepAll: true }))).toEqual({ present: 1, answer: null });
    expect(run(world())).toEqual({ present: 0, answer: { status: 204, code: "stale_reply" } });
  });
});

describe("D24-SPEECH-RETENTION r5: the bounded ambiguity marker", () => {
  /** A terminal row of `bot` with identity `id`, then 8 newer bound rows of that pair, so the pair's next begin deletes it. */
  const doomed = (w: World, bot: string, id = "dup") => { const t = w.ended("thread", bot, id); for (let i = 0; i < 8; i++) w.ended("thread", bot); return t; };
  const running = (w: World, bot: string, gen: string, id = "dup") => { w.state.begin("thread", bot, gen, "u"); w.state.bind(gen, id); };

  it("three running siblings of bots A, B, C; T of C deleted: the C lookup and the bot-less lookup stay ambiguous (ret-G-marker-3run, M5a/M5b)", () => {
    for (const keepAll of [true, false]) {
      const w = world({ keepAll });
      const t = doomed(w, "C");
      running(w, "A", "ra"); running(w, "B", "rb"); running(w, "C", "rc");
      w.state.begin("thread", "C", "trigger", "u");
      if (!keepAll) expect(w.count("speech_generations", `generation_id='${t}'`)).toBe(0);
      expect(w.state.generation("thread", "dup", "C")).toBeUndefined();
      expect(w.state.generation("thread", "dup")).toBeUndefined();
    }
  });

  it("one running sibling of another bot: the bot-less lookup is ambiguous, the other bot's own lookup is exact (ret-G-marker-botless)", () => {
    const answers = (w: World) => {
      doomed(w, "A");
      running(w, "B", "rb");
      w.state.begin("thread", "A", "trigger", "u");
      return { any: w.state.generation("thread", "dup")?.generation_id ?? null, b: w.state.generation("thread", "dup", "B")?.generation_id ?? null };
    };
    expect(answers(world())).toEqual(answers(world({ keepAll: true })));
    expect(answers(world())).toEqual({ any: null, b: "rb" });
  });

  it("deletion order C then A keeps C's flag (ret-G-marker-mixedbot, M5d)", () => {
    // R runs identity k throughout, so both deletions happen beside a running row and both mark
    const w = world();
    running(w, "R", "r");
    doomed(w, "C"); doomed(w, "A");
    w.state.begin("thread", "C", "c-trigger", "u");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 1, memberships: 1 });
    w.state.begin("thread", "A", "a-trigger", "u");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 1, memberships: 2 });
    running(w, "C", "rc"); running(w, "A", "ra");
    expect(w.state.generation("thread", "dup", "C")).toBeUndefined();
    expect(w.state.generation("thread", "dup", "A")).toBeUndefined();
    expect(w.state.generation("thread", "dup")).toBeUndefined();
  });

  it("the marker is visible in the deleting transaction and in a commit callback registered before it (ret-G-marker-same-tx, -callback, M5c')", () => {
    const w = world();
    running(w, "R", "r");
    doomed(w, "A");
    const t = Number(w.db.prepare("SELECT count(*) AS n FROM speech_generations WHERE bot_id='A' AND provider_turn_id='dup'").get()!.n);
    expect(t).toBe(1);
    let inCallback: unknown = "unset";
    w.tx(() => {
      afterCommit(() => { inCallback = w.state.generation("thread", "dup")?.generation_id ?? null; });
      w.state.begin("thread", "A", "trigger", "u");
      expect(w.count("speech_generations", "bot_id='A' AND provider_turn_id='dup'")).toBe(0);
      expect(w.state.generation("thread", "dup")).toBeUndefined();
    });
    expect(inCallback).toBeNull();
    expect(w.state.generation("thread", "dup")).toBeUndefined();
    expect(w.state.generation("thread", "dup", "R")?.generation_id).toBe("r");
  });

  it("a savepoint or outer rollback takes the marker back with the row; 1,000 rollbacks leave the map empty (ret-G-marker-savepoint, -rollback)", () => {
    const w = world();
    running(w, "R", "r");
    doomed(w, "A");
    w.tx(() => {
      try { w.tx(() => { w.state.begin("thread", "A", "inner", "u"); expect(w.state.ambiguityMarkers().entries).toBe(1); throw new Error("inner"); }); } catch { /* rolled back */ }
      expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
    });
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
    expect(w.count("speech_generations", "bot_id='A' AND provider_turn_id='dup'")).toBe(1);
    for (let i = 0; i < 1000; i++) expect(() => w.tx(() => { w.state.begin("thread", "A", `r${i}`, "u"); throw new Error("outer"); })).toThrow("outer");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
    expect(w.count("speech_generations", "bot_id='A' AND provider_turn_id='dup'")).toBe(1);
    // the full ledger's answer: T and R both match, so the bot-less lookup stays ambiguous
    expect(w.state.generation("thread", "dup")).toBeUndefined();
  });

  it("1,000 rolled-back markings over distinct identities leave the auxiliary sets empty, with an idle speech commit between each (ret-G-pending-rollback, Fable/Astra final M1)", () => {
    const w = world();
    for (let i = 0; i < 1000; i++) {
      const bot = `b${i}`, id = `id${i}`;
      running(w, "R", `r${i}`, id);
      doomed(w, bot, id);
      expect(() => w.tx(() => { w.state.begin("thread", bot, `trigger${i}`, "u"); expect(w.state.auxiliaryMarkerSets().pending).toBe(1); throw new Error("outer"); })).toThrow("outer");
      // the rollback took the marking and its record, so nothing remains of it
      expect(w.state.auxiliaryMarkerSets()).toEqual({ unconfirmed: 0, pending: 0, sweepLater: 0 });
      w.state.prompt("thread", `message:elsewhere${i}`);
      w.state.invalidateGeneration("thread", `r${i}`);
    }
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
    expect(w.state.auxiliaryMarkerSets()).toEqual({ unconfirmed: 0, pending: 0, sweepLater: 0 });
  });

  it("memberships: exactly one per deleting bot up to the cap, then one 'any bot' membership, whatever the bot-id churn (ret-G-marker-botchurn, r5.5 Δ11)", () => {
    const w = world();
    running(w, "R", "r");
    for (let b = 0; b < 250; b++) {
      doomed(w, `bot${b}`);
      w.state.begin("thread", `bot${b}`, `t${b}`, "u");
      const markers = w.state.ambiguityMarkers();
      expect(markers.entries).toBe(1);
      // the cap: never more than SPEECH_MARKER_BOTS memberships in an entry (M <= running identities x (1 + MAX_WORKSPACE_BOTS))
      expect(markers.memberships).toBe(b < SPEECH_MARKER_BOTS ? b + 1 : 1);
      expect(markers.entries + markers.memberships).toBeLessThanOrEqual(1 + SPEECH_MARKER_BOTS);
      if (b === 49) expect(markers.memberships).toBe(50);
    }
    // past the cap every bot-aware lookup of k is ambiguous: more refusals than the full ledger, never an attribution it would not make
    running(w, "fresh-bot", "f");
    expect(w.state.generation("thread", "dup", "fresh-bot")).toBeUndefined();
    expect(w.state.generation("thread", "dup")).toBeUndefined();
    w.state.invalidateGeneration("thread", "r"); w.state.invalidateGeneration("thread", "f");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
  });

  it("a rollback of a raw transaction outside any tx-scope frame leaves a marker only where the restored row makes the full ledger ambiguous too (ret-G-marker-rawtx, r5.5 Δ12)", () => {
    const answers = (w: World) => {
      running(w, "R", "r");
      doomed(w, "A");
      w.db.exec("BEGIN IMMEDIATE");
      w.state.begin("thread", "A", "trigger", "u");
      w.db.exec("ROLLBACK");
      return { a: w.state.generation("thread", "dup", "A")?.generation_id ?? null, r: w.state.generation("thread", "dup", "R")?.generation_id ?? null, any: w.state.generation("thread", "dup")?.generation_id ?? null, t: w.count("speech_generations", "bot_id='A' AND provider_turn_id='dup' AND state<>'running'") };
    };
    const pruned = answers(world());
    expect(pruned).toEqual(answers(world({ keepAll: true })));
    expect(pruned).toMatchObject({ r: "r", any: null, t: 1 });
    expect(pruned.a).toMatch(/^q/);
    // the next speech commit with the connection idle sees the row back and drops the membership it stood for
    const w = world();
    running(w, "R", "r"); doomed(w, "A");
    w.db.exec("BEGIN IMMEDIATE"); w.state.begin("thread", "A", "trigger", "u"); w.db.exec("ROLLBACK");
    w.state.prompt("elsewhere", "message:x");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
  });

  it("a sweep inside a raw frameless transaction waits for the next framed commit, so a rolled-back ending keeps the marker (ret-G-marker-rawtx-sweep, Grok r5.5 rider)", () => {
    const answers = (w: World) => {
      w.ended("thread", "A", "dup"); for (let j = 0; j < 8; j++) w.ended("thread", "A");
      running(w, "R", "r");
      w.state.begin("thread", "A", "trigger", "u");
      w.db.exec("BEGIN IMMEDIATE");
      w.state.invalidateGeneration("thread", "r");
      w.db.exec("ROLLBACK");
      const afterRollback = { any: w.state.generation("thread", "dup")?.generation_id ?? null, r: w.state.generation("thread", "dup", "R")?.generation_id ?? null };
      // a framed transition elsewhere runs the deferred sweep; R still runs, so the entry stays
      w.state.prompt("elsewhere", "message:x");
      const afterFramed = { any: w.state.generation("thread", "dup")?.generation_id ?? null };
      w.state.invalidateGeneration("thread", "r");
      return { afterRollback, afterFramed, markers: w.state.ambiguityMarkers() };
    };
    const pruned = world();
    const result = answers(pruned);
    const keep = answers(world({ keepAll: true }));
    expect(result.afterRollback).toEqual(keep.afterRollback);
    expect(result.afterFramed).toEqual(keep.afterFramed);
    expect(result.afterRollback).toEqual({ any: null, r: "r" });
    expect(result.markers).toEqual({ entries: 0, memberships: 0 });
    // committed instead (Astra code review 3): the ending is durable; the next speech commit sweeps the entry, whatever transition it is
    const w = world();
    w.ended("thread", "A", "dup"); for (let j = 0; j < 8; j++) w.ended("thread", "A");
    running(w, "R", "r");
    w.state.begin("thread", "A", "trigger", "u");
    w.db.exec("BEGIN IMMEDIATE"); w.state.invalidateGeneration("thread", "r"); w.db.exec("COMMIT");
    expect(w.state.ambiguityMarkers().entries).toBe(1);
    w.state.account("other-binding", "credential");
    expect(w.state.ambiguityMarkers()).toEqual({ entries: 0, memberships: 0 });
  });

  it("under a raw transaction, through any frame opener, markers are exact while it runs and settle on committed rows after it ends (ret-G-marker-rawtx-running, Grok r5.6 M1/M2, Astra r5.6-1, code review 1)", () => {
    // three openers inside the raw BEGIN: none, the speech transaction, and a bare tx-scope frame as SendStore.within, roomRequestsTransaction
    // and bot-calls-schema open (scopedTx / txScopeBegin); detection is the connection itself, so every opener behaves the same
    const openers: Array<[string, (x: World, work: () => void) => void]> = [["none", (_x, work) => work()], ["speech", (x, work) => x.tx(() => work())], ["scope", (_x, work) => scopedTx(work)]];
    for (const [name, open] of openers) {
      const w = world();
      const keep = world({ keepAll: true });
      for (let i = 0; i < 100; i++) {
        const thread = `raw${i}`;
        const step = (x: World, end: "ROLLBACK" | "COMMIT") => {
          const t = x.ended(thread, "A", "dup"); for (let j = 0; j < 8; j++) x.ended(thread, "A");
          x.db.exec("BEGIN IMMEDIATE");
          open(x, () => { x.state.begin(thread, "R", `r${i}`, "u"); x.state.bind(`r${i}`, "dup"); x.state.begin(thread, "A", `trigger${i}`, "u"); });
          // inside: T is gone with its marker, so every lookup equals the full ledger's
          const inside = { any: x.state.generation(thread, "dup")?.generation_id ?? null, r: x.state.generation(thread, "dup", "R")?.generation_id ?? null };
          x.db.exec(end);
          const after = { any: x.state.generation(thread, "dup")?.generation_id ?? null, r: x.state.generation(thread, "dup", "R")?.generation_id ?? null };
          return { t, inside, after };
        };
        const end = i % 2 ? "COMMIT" : "ROLLBACK";
        const a = step(w, end), b = step(keep, end);
        expect([name, a.inside, a.after]).toEqual([name, b.inside, b.after]);
        if (end === "ROLLBACK") expect(w.count("speech_generations", `generation_id='${a.t}'`)).toBe(1);
        else { expect(w.count("speech_generations", `generation_id='${a.t}'`)).toBe(0); w.state.invalidateGeneration(thread, `r${i}`); keep.state.invalidateGeneration(thread, `r${i}`); }
      }
      // the next speech commit with the connection idle settles all of it: no running row is left, so no marker is
      w.state.prompt("elsewhere", "message:x");
      expect(w.count("speech_generations", "state='running' AND bot_id='R'")).toBe(0);
      expect([name, w.state.ambiguityMarkers()]).toEqual([name, { entries: 0, memberships: 0 }]);
    }
  });

  it("raw-committed begins beside a running sibling never stall the frontier: the pair stays within 18 + running (ret-G-rawtx-frontier, Astra code review 2)", () => {
    const w = world();
    w.ended("thread", "A", "dup"); w.ended("thread", "A", "dup");
    running(w, "B", "rb");
    for (let i = 0; i < 300; i++) {
      w.db.exec("BEGIN IMMEDIATE");
      w.state.begin("thread", "A", `a${i}`, "u"); w.state.bind(`a${i}`, `p${i}`); w.state.invalidateGeneration("thread", `a${i}`);
      w.db.exec("COMMIT");
      const p = pair(w, "A", "thread");
      expect(p.rows).toBeLessThanOrEqual(p.bound);
    }
    expect(w.state.generation("thread", "dup")).toBeUndefined();
  });

  it("G2 after a marker's running lifetime: the new turn's own message plays where the full ledger refuses (ret-G2-after-marker)", () => {
    const run = (w: World) => {
      const s = speaker(w, "thread", "c", "A");
      doomed(w, "A");
      running(w, "B", "rb");
      w.state.begin("thread", "A", "trigger", "u"); w.state.invalidateGeneration("thread", "trigger");
      w.state.invalidateGeneration("thread", "rb");
      running(w, "A", "new");
      const attributed = w.state.generation("thread", "dup", "A")?.generation_id ?? null;
      const ready = attributed ? w.state.settle("thread", "dup", "m-new", true, "A") as Ready | undefined : undefined;
      return { attributed, settled: Boolean(ready), answer: ready ? refusal(() => w.state.reserve(s.input("m-new", undefined, ready.settlementId), s.target("m-new"))) : "none" };
    };
    expect(run(world({ keepAll: true }))).toEqual({ attributed: null, settled: false, answer: "none" });
    expect(run(world())).toEqual({ attributed: "new", settled: true, answer: null });
  });

  it("G2 rebound: T deleted with no k-row running, then B and A both bind k; A's bot-aware lookup diverges as r5.4 allows (ret-G2-rebound)", () => {
    const run = (w: World) => {
      const s = speaker(w, "thread", "c", "A");
      doomed(w, "A");
      w.state.begin("thread", "A", "trigger", "u"); w.state.invalidateGeneration("thread", "trigger");
      running(w, "B", "rb");
      running(w, "A", "new");
      const attributed = w.state.generation("thread", "dup", "A")?.generation_id ?? null;
      const botless = w.state.generation("thread", "dup")?.generation_id ?? null;
      const ready = attributed ? w.state.settle("thread", "dup", "m-new", true, "A") as Ready | undefined : undefined;
      return { attributed, botless, settled: Boolean(ready), answer: ready ? refusal(() => w.state.reserve(s.input("m-new", undefined, ready.settlementId), s.target("m-new"))) : "none" };
    };
    expect(run(world({ keepAll: true }))).toEqual({ attributed: null, botless: null, settled: false, answer: "none" });
    expect(run(world())).toEqual({ attributed: "new", botless: null, settled: true, answer: null });
  });

  it("a constant-id driver stays ambiguous for ever, identical to the full ledger at every turn (ret-H3-constant-id)", () => {
    const keep = world({ keepAll: true }), pruned = world();
    for (let i = 0; i < 300; i++) for (const w of [keep, pruned]) { w.turn("thread", "bot", "fake-turn"); w.clock.now += 2 * DAY; }
    for (const w of [keep, pruned]) { w.state.begin("thread", "bot", "next", "u"); w.state.bind("next", "fake-turn"); }
    expect(pruned.state.generation("thread", "fake-turn")).toBeUndefined();
    expect(keep.state.generation("thread", "fake-turn")).toBeUndefined();
    const p = pair(pruned, "bot", "thread"); expect(p.rows).toBeLessThanOrEqual(p.bound);
    const before = pruned.state.revision("thread");
    pruned.state.invalidateBot("bot");
    expect(pruned.state.revision("thread")).toBe(before + 1);
  });

  it("cycling ids keep the newest 8 bound rows, two of each id, so the next bind of the first id stays ambiguous (M4, M16)", () => {
    const w = world();
    for (let i = 0; i < 20; i++) w.turn("thread", "bot", "ABCD"[i % 4]);
    w.state.prompt("thread", "message:end");
    for (let i = 0; i < 8; i++) { w.state.begin("thread", "bot", `unbound${i}`, "u"); w.state.invalidateGeneration("thread", `unbound${i}`); }
    w.state.begin("thread", "bot", "next", "u"); w.state.bind("next", "A");
    expect(w.count("speech_generations", "provider_turn_id IS NOT NULL AND state<>'running'")).toBeGreaterThanOrEqual(8);
    expect(w.state.generation("thread", "A", "bot")).toBeUndefined();
  });
});

describe("D24-SPEECH-RETENTION r5: prompts follow their owner rows", () => {
  const sends = () => {
    const w = world({ ownerSends: false });
    initializeOwnerSends(w.db);
    const store = new SendStore(() => w.db);
    store.setSpeechAccepted(input => { if (input.status !== "refused" && input.status !== "cancelled" && input.origin === "desktop") w.state.acceptPrompt(input.threadId, input.sendId); });
    const accept = (sendId: string, extra: Record<string, unknown> = {}) => store.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "words", sendId, fingerprint: "words", origin: "desktop", ...extra } as Parameters<SendStore["accept"]>[0]);
    const marker = (sendId: string) => w.count("speech_prompts", `thread_id='t1' AND prompt_id='send:${sendId}'`);
    return { w, store, accept, marker };
  };

  it("pruneResolved, retire and purgeOrphans each delete the marker with its row, in one transaction (ret-P-sites, M18a-c)", async () => {
    const { w, store, accept, marker } = sends();
    accept("s1"); accept("s2"); accept("s3");
    expect([marker("s1"), marker("s2"), marker("s3")]).toEqual([1, 1, 1]);
    w.db.exec("UPDATE owner_sends SET status='delivered', text='', updated_at=0 WHERE send_id='s1'");
    await store.pruneResolved(0, Date.now());
    expect(marker("s1")).toBe(0);
    w.db.exec("UPDATE owner_sends SET status='failed' WHERE send_id='s2'");
    store.retire(Number(w.db.prepare("SELECT seq FROM owner_sends WHERE send_id='s2'").get()!.seq));
    expect(marker("s2")).toBe(0);
    w.db.exec("CREATE TABLE IF NOT EXISTS owner_deleted_threads (thread_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL); INSERT INTO owner_deleted_threads VALUES('t1', 0);");
    store.purgeOrphans(() => false);
    expect(marker("s3")).toBe(0);
    expect(w.count("owner_sends")).toBe(0);
  });

  it("a refused, cancelled or excluded-origin replacement keeps the marker; a queue early return drops it (ret-P-sites Δ3, M18f)", () => {
    for (const extra of [{ status: "refused", notice: "refused" }, { status: "cancelled" }, { origin: "phone" }]) {
      const { w, accept, marker } = sends();
      accept("s1");
      w.db.exec("UPDATE owner_sends SET status='failed' WHERE send_id='s1'");
      // This ledger has no receipt schema: exercise its legacy replacement,
      // rather than an explicit resend with no required action identity.
      expect(accept("s1", extra).kind).toBe("new");
      expect(marker("s1")).toBe(1);
      const revision = w.state.revision("t1");
      w.state.prompt("t1", "send:s1");
      expect(w.state.revision("t1")).toBe(revision);
    }
    const { w, accept, marker } = sends();
    accept("s1"); accept("s2", { queueId: "q-other" });
    w.db.exec("UPDATE owner_sends SET status='failed' WHERE send_id='s1'");
    expect(accept("s1", { queueId: "q-other" }).kind).toBe("existing");
    expect(w.count("owner_sends", "send_id='s1'")).toBe(0);
    expect(marker("s1")).toBe(0);
  });

  it("prompt() writes a send: marker only beside its owner row (ret-P-orphan-prompt)", () => {
    const w = world();
    w.state.prompt("thread", "send:nobody");
    expect(w.count("speech_prompts")).toBe(0);
    w.db.prepare("INSERT INTO owner_sends (thread_id, send_id) VALUES ('thread','real')").run();
    w.state.prompt("thread", "send:real");
    expect(w.count("speech_prompts")).toBe(1);
  });

  it("pre-r5 orphan markers never grow: markers <= owner rows + O0 after every op (ret-P-orphans)", () => {
    const w = world();
    w.db.exec(`${ids(1000)} INSERT INTO speech_prompts SELECT 'thread','send:orphan'||i FROM n`);
    for (let i = 0; i < 1000; i++) {
      w.db.prepare("INSERT INTO owner_sends (thread_id, send_id) VALUES ('thread',?)").run(`s${i}`);
      w.state.acceptPrompt("thread", `s${i}`);
      if (i % 3 === 0) w.tx(db => { db.prepare("DELETE FROM owner_sends WHERE send_id=?").run(`s${i}`); deleteSpeechSendMarkers(db, "thread", [`s${i}`]); });
      expect(w.count("speech_prompts")).toBeLessThanOrEqual(w.count("owner_sends") + 1000);
    }
  });

  it("a message: backlog shrinks by up to two per prompt of its thread; a deleted thread takes all its markers (M14, M18e)", () => {
    const w = world();
    w.db.exec(`${ids(10)} INSERT INTO speech_prompts SELECT 'thread','message:old'||i FROM n`);
    w.state.prompt("thread", "message:new");
    expect(w.count("speech_prompts")).toBe(8);
    w.tx(db => deleteSpeechSendMarkers(db, "thread", "thread"));
    expect(w.count("speech_prompts")).toBe(0);
    const source = readFileSync(new URL("../message-db.ts", import.meta.url), "utf8");
    expect(source).toMatch(/DELETE FROM owner_sends WHERE thread_id=\?"\)\.run\(threadId\);\n(.*\n)?\s*deleteSpeechSendMarkers\(database, threadId, "thread"\);/);
  });
});

describe("D24-SPEECH-RETENTION r5: no old reply is spoken again", () => {
  it("a settled, claimed reply a day old stays refused after retention, a reboot and a full disposal", () => {
    const w = world();
    const s = speaker(w);
    const t = w.turn();
    const attempt = w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message));
    w.state.finish(attempt, "complete");
    w.clock.now += DAY + 1;
    w.state.retainSpeechRows("speech_settlements"); w.state.retainSpeechRows("speech_attempts");
    expect(w.count("speech_settlements")).toBe(0);
    expect(w.count("speech_attempts", "mode='automatic'")).toBe(0);
    expect(refusal(() => w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message)))).toEqual({ status: 204, code: "stale_reply" });
    w.reboot();
    const again = speaker(w, "thread", "c2");
    expect(refusal(() => w.state.reserve(again.input(t.message, undefined, t.ready!.settlementId), again.target(t.message)))?.status).not.toBe(200);
    expect(w.count("speech_attempts", `message_id='${t.message}' AND mode='automatic'`)).toBe(0);
  });

  it("with the claim gone but the settlement kept, the 60 s age still refuses", () => {
    const w = world();
    const s = speaker(w);
    const t = w.turn();
    w.state.finish(w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message)), "complete");
    w.clock.now += 61_000;
    w.db.exec("DELETE FROM speech_attempts");
    expect(refusal(() => w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message)))).toEqual({ status: 204, code: "stale_reply" });
  });

  it("an owner prompt revokes a completed reply (204) without rewriting it, and still invalidates a running turn (ret-T2-decisions)", () => {
    const w = world();
    const s = speaker(w);
    const t = w.turn();
    w.state.prompt("thread", "message:next");
    expect(w.count("speech_generations", `generation_id='${t.generation}' AND state='completed'`)).toBe(1);
    expect(refusal(() => w.state.reserve(s.input(t.message, undefined, t.ready!.settlementId), s.target(t.message)))).toEqual({ status: 204, code: "stale_reply" });
    w.state.begin("thread", "bot", "live", "u"); w.state.bind("live", "p-live");
    w.state.prompt("thread", "message:later");
    expect(w.state.settle("thread", "p-live", "m-live", true, "bot")).toBeUndefined();
    expect(w.count("speech_settlements", "message_id='m-live'")).toBe(0);
    // closeAll: running rows retired, completed rows unusable through the new incarnation
    const u = w.turn();
    w.state.closeAll(); w.reboot();
    const s2 = speaker(w, "thread", "c9");
    expect(refusal(() => w.state.reserve(s2.input(u.message, undefined, u.ready!.settlementId), s2.target(u.message)))).toEqual({ status: 204, code: "stale_reply" });
  });

  it("T1 equivalence with empty, omitted and real bot ids (ret-T1-bots)", () => {
    for (const botId of [undefined, "", "bot", "other"]) {
      const keep = world({ keepAll: true }), pruned = world();
      const answers = [keep, pruned].map(w => { w.turn("thread", "bot", "x"); w.state.begin("thread", "bot", "r", "u"); w.state.bind("r", "y"); return w.state.generation("thread", "y", botId)?.generation_id ?? null; });
      expect(answers[1]).toBe(answers[0]);
    }
  });

  it("the wall clock moving back does not age rows early", () => {
    const w = world();
    w.turn();
    w.clock.now -= 2 * DAY;
    w.state.retainSpeechRows("speech_settlements");
    expect(w.count("speech_settlements")).toBe(1);
  });
});

describe("D24-SPEECH-RETENTION r5: reconciliation without a global walk", () => {
  it("every command row matches the pre-r3 global reconciliation after each transition, in all nine families", () => {
    const script = (w: World) => {
      const rows = () => w.db.prepare("SELECT sequence,status,outcome,attempt_id IS NULL AS bare FROM speech_commands ORDER BY rowid").all().map(row => JSON.stringify(row));
      const snapshots: string[][] = [];
      const step = (run: () => unknown) => { try { run(); } catch { /* refusals are part of the script */ } snapshots.push(rows()); };
      const t = [w.turn(), w.turn(), w.turn(), w.turn(), w.turn()];
      const s = speaker(w);
      const reserve = (i: number) => w.state.reserve(s.input(t[i].message, "speak"), s.target(t[i].message));
      for (const outcome of ["complete", "failed", "cancelled", "budget"] as const) { step(() => w.state.finish(reserve(0), outcome)); w.clock.now += 11 * 60_000; }
      step(() => { reserve(1); s.cancel(); });
      step(() => { reserve(1); w.state.invalidate("thread"); });
      step(() => {
        w.clock.now += 11 * 60_000;
        reserve(1);
        w.db.exec("CREATE TRIGGER fail_stop BEFORE UPDATE ON speech_threads BEGIN SELECT RAISE(ABORT, 'stop failed'); END");
        try { w.state.invalidate("thread"); } catch { /* quarantined */ }
        w.db.exec("DROP TRIGGER fail_stop");
        w.state.recoverPending();
      });
      step(() => { reserve(2); reserve(2); });
      step(() => { reserve(3); w.state.session(s.connection, "thread"); });
      const s2 = speaker(w, "thread", "c2");
      step(() => { w.state.reserve(s2.input(t[4].message, "speak"), s2.target(t[4].message)); w.state.closeConnection("c2"); });
      const s3 = speaker(w, "thread", "c3");
      step(() => { w.clock.now += 11 * 60_000; w.state.reserve(s3.input(t[4].message, "speak"), s3.target(t[4].message)); w.reboot(); });
      const s4 = speaker(w, "thread", "c4");
      step(() => { w.clock.now += 11 * 60_000; w.state.reserve(s4.input(t[3].message, "speak"), s4.target(t[3].message)); w.state.closeAll(); });
      step(() => w.tx(() => { w.state.reserve(s4.input(t[3].message, "speak"), s4.target(t[3].message)); throw new Error("rolled back"); }));
      return snapshots;
    };
    expect(script(world())).toEqual(script(world({ reconcileEveryTx: true })));
  });
});

describe("D24-SPEECH-RETENTION r5: bounded work (EQP primary, drop-index mutants, flat 1k..1M)", () => {
  const explain = (db: DatabaseSync, sql: string) => {
    const params = (sql.match(/\?/g) ?? []).map(() => "x");
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail);
  };
  /** Every statement on a retained table, by class (design r5.2 Δ5, r5.3 Δ8). */
  const shipped = (): Record<string, { sql: string; cls: "pt" | "cr" | "lr" | "ir" | "lw" }> => ({
    ...Object.fromEntries(Object.entries(SPEECH_RETENTION_SQL).map(([name, sql]) => [`step ${name}`, { sql, cls: "cr" as const }])),
    lookup: { sql: SPEECH_GENERATION_LOOKUP, cls: "cr" }, lookupBot: { sql: SPEECH_GENERATION_LOOKUP_BOT, cls: "cr" },
    invalidate: { sql: SPEECH_INVALIDATE_RUNNING, cls: "lr" }, recoverSessions: { sql: SPEECH_RECOVER_SESSIONS, cls: "lr" },
    commandSettle: { sql: SPEECH_COMMAND_SETTLE, cls: "ir" },
    threadLive: { sql: "UPDATE speech_attempts SET state='cancelled',outcome='invalidated' WHERE thread_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", cls: "ir" },
    sessionLive: { sql: "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='cancelled',outcome='cancelled' WHERE session_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", cls: "lr" },
    attemptLive: { sql: "UPDATE speech_attempts SET state='cancelled',outcome='replaced' WHERE attempt_id=? AND state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", cls: "pt" },
    closeByConnection: { sql: "UPDATE speech_sessions SET state='closed' WHERE connection_id=? AND state='active'", cls: "ir" },
    closeBySession: { sql: "UPDATE speech_sessions SET state='closed' WHERE session_id=? AND state='active'", cls: "pt" },
    busy: { sql: "SELECT attempt_id,session_id FROM speech_attempts WHERE thread_id=? AND state IN ('reserved','streaming')", cls: "ir" },
    claim: { sql: "SELECT 1 FROM speech_attempts WHERE message_id=? AND mode='automatic'", cls: "pt" },
    rate: { sql: "SELECT count(*) n FROM speech_attempts WHERE reserved_at>?", cls: "ir" },
    messageRate: { sql: "SELECT count(*) n FROM speech_attempts WHERE message_id=? AND reserved_at>?", cls: "ir" },
    join: { sql: "SELECT s.*,g.state,g.bot_id FROM speech_settlements s JOIN speech_generations g USING(generation_id) WHERE settlement_id=? AND s.thread_id=? AND message_id=?", cls: "pt" },
    current: { sql: "SELECT a.state,s.active_attempt,s.state AS session_state,t.revision FROM speech_attempts a JOIN speech_sessions s USING(session_id) JOIN speech_threads t ON t.thread_id=a.thread_id WHERE attempt_id=?", cls: "pt" },
    duplicate: { sql: "SELECT status,outcome FROM speech_commands WHERE session_id=? AND sequence=?", cls: "pt" },
    ownerSend: { sql: "SELECT 1 FROM owner_sends WHERE thread_id=? AND send_id=? LIMIT 1", cls: "pt" },
    markerDelete: { sql: "DELETE FROM speech_prompts WHERE thread_id=? AND prompt_id=?", cls: "pt" },
    retireRunning: { sql: SPEECH_RETIRE_RUNNING, cls: "lw" }, closeActive: { sql: SPEECH_CLOSE_ACTIVE, cls: "lw" },
    bootLive: { sql: "UPDATE speech_attempts INDEXED BY speech_attempt_live_session SET state='interrupted',outcome='boot' WHERE state IN ('reserved','streaming') RETURNING attempt_id,state,outcome", cls: "lw" },
  });
  /** Adversarial history of n rows per family, with the live rows held constant. */
  const adversarial = (w: World, n: number) => {
    const boot = w.state.bootId;
    w.db.exec(`${ids(n)} INSERT INTO speech_generations SELECT 'h'||i,'thread','bot','u',0,'${boot}','dup','completed' FROM n`);
    w.db.exec(`${ids(n)} INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state,outcome) SELECT 'a'||i,'big',i,'thread','hm'||i,'manual',0,'${boot}',${w.clock.now},'acc','plan','complete','complete' FROM n`);
    w.db.exec(`${ids(n)} INSERT INTO speech_commands SELECT 'gone'||(i % 1000),i,204,'cancelled',NULL FROM n`);
    w.db.exec(`${ids(n)} INSERT INTO speech_sessions(session_id,principal,connection_id,thread_id,boot_id,state) SELECT 'closed'||i,'owner','c1','thread','b','closed' FROM n`);
    w.db.exec(`${ids(n)} INSERT INTO speech_settlements SELECT 'st'||i,'h'||i,'thread','sm'||i,0,'${boot}',${w.clock.now},'completed' FROM n`);
    w.db.exec(`${ids(n)} INSERT INTO speech_prompts SELECT 'thread','send:h'||i FROM n`);
  };
  const plansOk = (w: World) => {
    const bad: string[] = [];
    for (const [name, { sql, cls }] of Object.entries(shipped())) {
      const details = explain(w.db, sql);
      for (const detail of details) {
        if (/TEMP B-TREE/.test(detail)) bad.push(`${name}: ${detail}`);
        if (/\bSCAN\b/.test(detail) && !(cls === "lw" && /USING (COVERING )?INDEX speech_/.test(detail))) bad.push(`${name}: ${detail}`);
      }
      if (cls === "cr" && !/LIMIT/.test(sql)) bad.push(`${name}: capped range without LIMIT`);
    }
    return bad;
  };

  it("every statement meets its class, fresh and after ANALYZE on a million-row adversarial history", { timeout: 300_000 }, () => {
    const w = world();
    expect(plansOk(w)).toEqual([]);
    adversarial(w, 1_000_000);
    w.db.exec("ANALYZE");
    expect(plansOk(w)).toEqual([]);
  });

  it("drop-index mutants: an INDEXED BY site fails to prepare; any other relied-on index changes its statement's plan", () => {
    const relied = ["speech_settlement_time", "speech_settlement_thread", "speech_attempt_terminal", "speech_attempt_live_session", "speech_session_closed", "speech_session_active", "speech_session_connection",
      "speech_generation_unbound_done", "speech_generation_bound_done", "speech_generation_bot", "speech_generation_bound", "speech_generation_running", "speech_generation_identity",
      "speech_commands_pending_attempt", "speech_automatic_claim", "speech_attempt_rate", "speech_message_rate", "speech_thread_active"];
    for (const index of relied) {
      const fresh = world();
      // whole names only: speech_generation_bound must not match speech_generation_bound_done
      const named = new RegExp(`\\b${index}(?![A-Za-z0-9_])`);
      const usesIndex = (detail: string) => named.test(detail);
      const using = Object.entries(shipped()).filter(([, { sql }]) => explain(fresh.db, sql).some(usesIndex));
      expect(using.length, index).toBeGreaterThan(0);
      fresh.db.exec(`DROP INDEX ${index}`);
      for (const [name, { sql }] of using) {
        let changed: boolean;
        try { changed = !explain(fresh.db, sql).some(usesIndex); } catch { changed = true; }
        expect(changed, `${index} ${name}`).toBe(true);
      }
    }
  });

  it("each new index is listed for the downgrade; the six tables are retained by retainSpeechRows; speech_generation_valid is gone", () => {
    for (const index of ["speech_settlement_time", "speech_settlement_thread", "speech_attempt_terminal", "speech_session_closed", "speech_session_active", "speech_generation_unbound_done", "speech_generation_bound_done", "speech_generation_identity", "speech_attempt_live_session", "speech_commands_pending_attempt"]) expect(SPEECH_INDEXES_AFTER_117).toContain(index);
    expect(SPEECH_INDEXES_AFTER_117).not.toContain("speech_generation_valid");
    for (const table of SPEECH_RETENTION_TABLES) expect(ADDED_TABLE_LIFECYCLE[table]).toEqual({ kind: "retained", by: "retainSpeechRows" });
  });

  it("per-step rows read and deleted are the same at 1k and 1M history and within the caps (logical accounting)", { timeout: 300_000 }, () => {
    const steps = (n: number) => {
      const w = world();
      adversarial(w, n);
      const s = speaker(w, "thread", "work");
      const out: string[] = [];
      for (let i = 0; i < 20; i++) {
        w.state.begin("thread", "bot", `b${i}`, "u"); out.push(JSON.stringify(w.state.lastRetention));
        s.cancel(); out.push(JSON.stringify(w.state.lastRetention));
        w.state.prompt("thread", `message:p${i}`);
      }
      for (const work of out.map(item => JSON.parse(item) as { returned: number; removed: number })) { expect(work.returned).toBeLessThanOrEqual(8); expect(work.removed).toBeLessThanOrEqual(2); }
      return out;
    };
    expect(steps(1_000_000)).toEqual(steps(1000));
  });

  // design r5.1 d.3 + r5.3 Δ8: the VM-step gate. With D24_VMSTEPS_DIR set, this writes a 1k and a 1M history (dead backlog in every family,
  // the invariant-bounded live and recent rows held constant) and every shipped statement with its literals; the gate script runs each through
  // the sqlite3 CLI's `.stats vmstep` on both files and requires equal steps for [pt] [cr] [lr] [ir]. Off by default.
  it.skipIf(!process.env.D24_VMSTEPS_DIR)("vm-step gate export: 1k and 1M histories and the shipped statements", { timeout: 600_000 }, () => {
    const dir = process.env.D24_VMSTEPS_DIR!;
    const literal = (value: string | number) => typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
    for (const n of [1000, 1_000_000]) {
      const w = world();
      const boot = w.state.bootId, now = w.clock.now, old = now - 2 * DAY;
      // dead backlog, n rows per family
      w.db.exec(`${ids(n)} INSERT INTO speech_generations SELECT 'h'||i,'thread','bot','u',0,'${boot}','dup','completed' FROM n`);
      w.db.exec(`${ids(n)} INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state,outcome) SELECT 'a'||i,'big',i,'thread','hm'||i,'manual',0,'${boot}',${old}-i,'acc','plan','complete','complete' FROM n`);
      w.db.exec(`${ids(n)} INSERT INTO speech_commands SELECT 'gone'||(i % 1000),i,204,'cancelled',NULL FROM n`);
      w.db.exec(`${ids(n)} INSERT INTO speech_sessions(session_id,principal,connection_id,thread_id,boot_id,state) SELECT 'gone'||i,'owner','c1','thread','b','closed' FROM n`);
      w.db.exec(`${ids(n)} INSERT INTO speech_settlements SELECT 'st'||i,'h'||i,'thread','sm'||i,0,'${boot}',${old}-i,'completed' FROM n`);
      w.db.exec(`${ids(n)} INSERT INTO speech_prompts SELECT 'thread','message:h'||i FROM n`);
      // invariant-bounded live and recent rows, the same at both sizes: 6 recent attempts (3 of one message), one live attempt with its
      // pending command, one active session per connection, 8 newest bound rows of the pair, one running row
      const s = speaker(w, "thread", "live");
      w.db.exec(`${ids(6)} INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state,outcome) SELECT 'recent'||i,'${s.session.sessionId}',100+i,'thread',CASE WHEN i<=3 THEN 'm-rate' ELSE 'm'||i END,'manual',0,'${boot}',${now}-i,'acc','plan','complete','complete' FROM n`);
      w.db.exec(`INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state) VALUES('live','${s.session.sessionId}',200,'thread','m-live','manual',0,'${boot}',${now},'acc','plan','reserved')`);
      w.db.exec(`INSERT INTO speech_commands VALUES('${s.session.sessionId}',200,409,'pending','live')`);
      for (let i = 0; i < 8; i++) w.ended("thread", "bot", `k${i}`);
      w.state.begin("thread", "bot", "run", "u"); w.state.bind("run", "dup");
      const r8 = Number(w.db.prepare(SPEECH_RETENTION_SQL.newestBoundInPair).get("bot", "thread")!.r);
      const values: Record<string, string | number> = {
        thread_id: "thread", bot_id: "bot", provider_turn_id: "dup", boot_id: boot, settled_at: now - DAY, reserved_at: now - DAY, session_id: s.session.sessionId,
        sequence: 150, rowid: r8, attempt_id: "live", message_id: "m-rate", connection_id: "live", send_id: "h1", prompt_id: "send:h1", settlement_id: "st1",
      };
      const exported = Object.entries(shipped()).map(([name, { sql, cls }]) => {
        let text = sql.replace(/SET status=\?,outcome=\?/, "SET status=204,outcome='cancelled'").replace(/(\w+)\s*(=|<=|<|>=|>)\s*\?/g, (_, column: string, op: string) => {
          const value = column === "reserved_at" && op === ">" ? now - 60_000 : values[column];
          if (value === undefined) throw new Error(`no gate value for ${column} in ${name}`);
          return `${column}${op}${literal(value)}`;
        });
        text = text.replace(/SET status=\?,outcome=\?/, "SET status=204,outcome='cancelled'").replace(/LIMIT \?/g, "LIMIT 2");
        expect(text, name).not.toContain("?");
        return { name, cls, sql: text };
      });
      w.db.exec(`VACUUM INTO '${dir}/vm-${n}.db'`);
      // each history's own literals (boot and session ids differ per world), one per line: class TAB name TAB sql, the same order in both
      writeFileSync(`${dir}/statements-${n}.tsv`, exported.map(item => `${item.cls}\t${item.name}\t${item.sql}`).join("\n") + "\n");
    }
  });

  it("T2 never visits a million completed rows of the thread (ret-T2-1M-completed, M19)", { timeout: 300_000 }, () => {
    const w = world();
    adversarial(w, 1_000_000);
    const updates: string[] = [];
    const prepare = w.db.prepare.bind(w.db);
    w.db.prepare = ((sql: string) => { if (/UPDATE speech_generations/.test(sql)) updates.push(sql); return prepare(sql); }) as typeof w.db.prepare;
    try { w.state.invalidate("thread"); } finally { w.db.prepare = prepare; }
    expect(updates).toEqual([SPEECH_INVALIDATE_RUNNING]);
    expect(w.count("speech_generations", "state='completed'")).toBe(1_000_000);
  });

  it("secondary: turn and insert time at 1M rows of history is within 5x of 1k", { timeout: 600_000 }, () => {
    const time = (n: number) => {
      const w = world();
      adversarial(w, n);
      const s = speaker(w, "thread", "timing");
      const samples: number[] = [];
      for (let i = 0; i < 60; i++) {
        const started = process.hrtime.bigint();
        w.turn("thread", "bot", "dup");
        w.state.generation("thread", "dup", "bot");
        s.cancel();
        samples.push(Number(process.hrtime.bigint() - started));
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)]!;
    };
    time(1000);
    const small = time(1000), large = time(1_000_000);
    expect(large / small).toBeLessThan(5);
  });
});
