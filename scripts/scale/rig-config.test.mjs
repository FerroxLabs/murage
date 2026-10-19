// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rcReceiptOutputs, SHAPES } from "./shapes.mjs";
import { dirBytes, groupBytes, liveBytes, measureStorage, slopeBytes } from "./storage.mjs";
import { acpPool, parseTrace, progressClock, turnClocks, upgradeChatResult, upgradeStatus, indexState, matchTurnEvent, openTraces, parseTurnLog, recallSuccess, resetLines, resumedShare, rigServerEnv, sentRecall, termsVersionFrom, trulyResumed, turnFromLog, waterfallRows } from "./rig-config.mjs";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/health-upgrade.json", import.meta.url), "utf8"));

describe("scale rig config", () => {
  test("the terms version is read from shared/terms.ts, so a bump follows", () => {
    const source = readFileSync(new URL("../../shared/terms.ts", import.meta.url), "utf8");
    expect(termsVersionFrom(source)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(termsVersionFrom('export const TERMS_VERSION = "2030-01-02";')).toBe("2030-01-02");
    expect(termsVersionFrom("")).toBeNull();
  });
  test("the server env declares the terms and the fake engine's instant MCP list", () => {
    const env = rigServerEnv({}, "2026-10-10");
    expect(env.MURAGE_TERMS_ACCEPTED).toBe("2026-10-10");
    expect(env.FAKE_ACP_MCP_LIST).toBe("all:ready");
    expect(env.MURAGE_ACP_POOL).toBeUndefined();
    expect(rigServerEnv({}, null).MURAGE_TERMS_ACCEPTED).toBeUndefined();
  });
  test("pooling is opt-in and reaches the server env", () => {
    expect(acpPool({})).toBe(false);
    expect(acpPool({ SCALE_ACP_POOL: "1" })).toBe(true);
    expect(rigServerEnv({ MURAGE_ACP_POOL: "1" }, "x").MURAGE_ACP_POOL).toBe("1");
  });
  test("recall success counts recalls that returned hits, not recalls attempted", () => {
    const done = hits => ({ outcome: "turn.completed", recallMode: "lexical", recallHits: hits });
    expect(recallSuccess([done(0), done(0), done(0)])).toBe(0);
    expect(recallSuccess([done(2), done(0), done(1), done(0)])).toBe(0.5);
    expect(recallSuccess([{ outcome: "timeout", recallHits: 3 }, done(1)])).toBe(0.5);
    expect(recallSuccess([{ outcome: "turn.completed" }])).toBeNull();
  });

  test("the post-upgrade check is read from the contract's own health shape (captured fixture)", () => {
    expect(upgradeStatus(fixtures.running)).toMatchObject({ kind: "running", percent: 50, stage: "background", phase: "message-index" });
    expect(upgradeStatus(fixtures.runningUnknownPercent)).toMatchObject({ kind: "running", percent: null });
    expect(upgradeStatus(fixtures.finished)).toMatchObject({ kind: "finished", percent: 100 });
    expect(upgradeStatus(fixtures.blocked)).toMatchObject({ kind: "failed", reason: "blocked DISK_FULL" });
  });
  test("a missing, old or malformed reading is never a success", () => {
    expect(upgradeStatus(null).kind).toBe("unknown");
    expect(upgradeStatus(fixtures.legacy)).toMatchObject({ kind: "unknown", reason: "no upgrade field" });
    expect(upgradeStatus({ upgrade: { stage: "background", complete: false } })).toMatchObject({ kind: "unknown", reason: "legacy" });
    expect(upgradeStatus({ upgrade: { ...fixtures.running.upgrade, v: 3 } }).kind).toBe("unknown");
    expect(upgradeStatus({ upgrade: { ...fixtures.running.upgrade, stage: "soon" } }).kind).toBe("unknown");
    expect(upgradeStatus({ upgrade: { ...fixtures.running.upgrade, overall: 1.5 } }).kind).toBe("unknown");
    // idle without the server saying complete is not completion
    expect(upgradeStatus({ upgrade: { ...fixtures.finished.upgrade, complete: "unknown" } }).kind).toBe("unknown");
  });
  test("a scenario that never finished, or that has a failed or untimed message, reports it", () => {
    const ok = { outcome: "turn.completed", acceptedMs: 20, engineStarted: 300, firstText: 500 };
    expect(upgradeChatResult({ finished: true, sends: [ok, ok], pollFailures: 0, pollCount: 9 })).toMatchObject({ finishedFlag: 1, failedSends: 0, samplesFlag: 1 });
    expect(upgradeChatResult({ finished: false, sends: [ok], pollFailures: 5, pollCount: 5 })).toMatchObject({ finishedFlag: 0 });
    expect(upgradeChatResult({ finished: true, sends: [ok, { outcome: "timeout" }], pollFailures: 0, pollCount: 3 })).toMatchObject({ failedSends: 1, samplesFlag: 0 });
    expect(upgradeChatResult({ finished: true, sends: [ok, { ...ok, engineStarted: undefined }], pollFailures: 0, pollCount: 3 })).toMatchObject({ failedSends: 0, samplesFlag: 0 });
    expect(upgradeChatResult({ finished: true, sends: [], pollFailures: 0, pollCount: 1 }).samplesFlag).toBe(0);
  });
  test("the progress clock keeps running while a long message is out", () => {
    // a 90 s message with the percent moving every 10 s: no gap near 90 s
    const clock = progressClock(10, 0);
    for (let t = 1; t <= 90; t++) clock.read(10 + Math.floor(t / 10), t * 1000);
    const { longest } = clock.finish(90_000);
    expect(longest).toBeLessThanOrEqual(10_000);
    // a percent that stands still for 45 s is seen to move at the next reading, 46 s
    const still = progressClock(10, 0);
    for (let t = 1; t <= 60; t++) still.read(t <= 45 ? 10 : 11, t * 1000);
    expect(still.finish(60_000).longest).toBe(46_000);
  });
  test("the check's progress is read from the contract: a step that only counts up is movement, a reading that never changes is a freeze", () => {
    const budget = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8")).metrics.find(b => b.id === "checkProgress").max;
    const at = (done, progressAt, overall = 0.5) => upgradeStatus({ ...fixtures.running, upgrade: { ...fixtures.running.upgrade, overall, step: { ...fixtures.running.upgrade.step, done }, progressAt } });
    // overall stands at 50% for 120 s while the counted step moves every second: never frozen
    const first = at(300, 1000);
    expect(first.percent).toBe(50);
    const moving = progressClock(first.progress, 0);
    for (let t = 1; t <= 120; t++) moving.read(at(300 + t, 1000).progress, t * 1000);
    expect(moving.finish(120_000).longest).toBeLessThanOrEqual(1000);
    // progressAt alone moving (an uncounted phase) is movement too
    const ticking = progressClock(first.progress, 0);
    for (let t = 1; t <= 120; t++) ticking.read(at(300, 1000 + t * 1000).progress, t * 1000);
    expect(ticking.finish(120_000).longest).toBeLessThanOrEqual(1000);
    // nothing changes for 61 s: the freeze is reported, over the 60 s budget
    const frozen = progressClock(first.progress, 0);
    for (let t = 1; t <= 61; t++) frozen.read(at(300, 1000).progress, t * 1000);
    const result = frozen.finish(61_000);
    expect(result.longest).toBe(61_000);
    expect(Math.max(...result.gaps)).toBeGreaterThan(budget);
  });
  test("the clocks name the events: engine started is the adapter hand-off, not the dispatch call", () => {
    const text = [
      "[turn-trace] id=aa11 phase=received at=0ms since=0ms",
      "[turn-trace] id=aa11 phase=memory.bundle at=40ms since=40ms outcome=ok ms=38 hits=7 searchMs=30",
      "[turn-trace] id=aa11 phase=dispatch.send at=90ms since=50ms engine=fake recallHits=2",
      "[turn-trace] id=aa11 phase=engine.submit at=1400ms since=1310ms",
      "[turn-trace] id=aa11 phase=turn.done at=1900ms since=500ms outcome=completed",
    ].join("\n");
    const turn = parseTrace(text).aa11;
    expect(turnClocks(turn)).toMatchObject({ prep: 90, engineStarted: 1400 });
    // the recall hits are the turn's own accepted bundle (dispatch.send), not the process-wide counter of the recall span
    expect(turn.hits).toBe(2);
    expect(parseTrace("[turn-trace] id=bb22 phase=memory.bundle at=5ms since=5ms ms=3 hits=9").bb22.hits).toBeUndefined();
  });
});

// Fixture logs, in the server's own line formats (server/turn-trace.ts, server/memory/turn-spans.ts, index.ts warnings).
const tr = (id, phase, at, extra = "") => `[turn-trace] id=${id} phase=${phase} at=${at}ms since=0ms${extra ? ` ${extra}` : ""}`;
const mem = fields => `[memory] turn route=native engine=grokAgent ${fields} assert=3 replayFilter=2 other=10 loopP99=12`;

describe("turn attribution (RC1-FULL-TURN 1c): a late event or trace of one turn never completes the next", () => {
  test("an engine turn seen before the send never matches; the wait binds to its own turn.started", () => {
    const wait = { threadId: "d37bc538", before: new Set(["t-prev"]), turnId: undefined };
    // the previous turn's turn.completed arrives after the next send (behind a 1.7 s block)
    expect(matchTurnEvent({ type: "turn.completed", threadId: "d37bc538", turnId: "t-prev" }, wait)).toBeNull();
    expect(matchTurnEvent({ type: "turn.completed", threadId: "other", turnId: "t-x" }, wait)).toBeNull();
    expect(matchTurnEvent({ type: "turn.completed", threadId: "d37bc538" }, wait)).toBeNull();
    expect(matchTurnEvent({ type: "turn.started", threadId: "d37bc538", turnId: "t-own" }, wait)).toBe("started");
    wait.turnId = "t-own";
    expect(matchTurnEvent({ type: "turn.completed", threadId: "d37bc538", turnId: "t-other" }, wait)).toBeNull();
    expect(matchTurnEvent({ type: "turn.completed", threadId: "d37bc538", turnId: "t-own" }, wait)).toBe("ended");
  });

  test("the window after a send: the earlier turn's tail lines are not this turn, and its prep is its own dispatch.send", () => {
    // ca3d8268's last lines land after 5bc6fc37's send; the old rig read a98fa2bb's prompt.sent (3350) as prep
    const window = [
      tr("ca3d8268", "prompt.sent", 2675), tr("ca3d8268", "engine.first-text", 2743),
      tr("5bc6fc37", "received", 0), tr("5bc6fc37", "context.built", 70), tr("5bc6fc37", "engine.acquire", 1720, "cold=true pooling=false poolable=false"),
      mem("resumed=true pre=228 recall=0 recallMode=lexical"), tr("5bc6fc37", "dispatch.send", 1715, "engine=grokAgent"),
      tr("ca3d8268", "turn.done", 2790, "outcome=ok"),
      tr("5bc6fc37", "prompt.sent", 2155), tr("5bc6fc37", "engine.first-text", 2285), tr("5bc6fc37", "turn.done", 2300, "outcome=ok"),
    ].join("\n");
    const t = turnFromLog(window, "d37bc538");
    expect(t).toMatchObject({ traceId: "5bc6fc37", prep: 1715, firstText: 2285, done: true, outcome: "ok", engineCold: true, pooling: false, resumed: true, foreignTraces: 0 });
    // done only when its own trace is
    expect(turnFromLog(window.split("\n").slice(0, 8).join("\n"), "d37bc538").done).toBe(false);
  });

  test("a turn is not sent while an earlier trace is still open", () => {
    const log = [tr("aaa", "received", 0), tr("aaa", "turn.done", 9, "outcome=ok"), tr("bbb", "received", 0), tr("bbb", "dispatch.send", 5)].join("\n");
    expect(openTraces(log)).toEqual(["bbb"]);
    expect(openTraces(log + "\n" + tr("bbb", "turn.done", 9, "outcome=failed"))).toEqual([]);
  });
});

describe("warm and cold engines (RC1-FULL-TURN row 2)", () => {
  test("each turn records whether its engine was cold and whether pooling was on", () => {
    const warm = [tr("w1", "received", 0), tr("w1", "engine.acquire", 300, "cold=false pooling=true poolable=true"), tr("w1", "engine.first-text", 420), tr("w1", "turn.done", 430, "outcome=ok")].join("\n");
    expect(turnFromLog(warm, "t")).toMatchObject({ engineCold: false, pooling: true, firstText: 420 });
  });
});

describe("slope and resets (RC1-FULL-TURN row 3)", () => {
  test("prep is never memory's own pre= field: a turn whose trace has no dispatch.send has no prep", () => {
    const window = [tr("6bf7d3b4", "received", 0), mem("resumed=false pre=247 recall=0 recallMode=lexical"), tr("6bf7d3b4", "turn.done", 900, "outcome=failed")].join("\n");
    const t = turnFromLog(window, "afee713f");
    expect(t.prep).toBeUndefined();
    // and the memory line is not the turn's own either: it was not written right before a dispatch.send
    expect(t.resumed).toBeUndefined();
  });

  test("resets are the thread's own `memory continuation reset thread=` lines, never the loop summaries", () => {
    const log = [
      "memory continuation reset thread=afee713f engine=grok reason=lineage (then memory-changed (receipt-already-revoked))",
      "memory continuation reset loop thread=afee713f engine=grok resets=3 window=10m reasons=lineage x3",
      "memory continuation reset thread=d37bc538 engine=grok reason=lineage-warming",
      "memory continuation reset thread=afee713f engine=grok reason=after-recall lineage-warming",
    ].join("\n");
    expect(resetLines(log, "afee713f")).toHaveLength(2);
    expect(resetLines(log)).toHaveLength(3);
  });

  test("a slope turn counts only when the engine resumed the session and nothing reset it; the share starts at turn 2", () => {
    const resumed = [tr("74504421", "received", 0), mem("resumed=true pre=230 recall=0 recallMode=lexical"), tr("74504421", "dispatch.send", 1000), tr("74504421", "turn.done", 1100, "outcome=ok")].join("\n");
    expect(turnFromLog(resumed, "afee713f")).toMatchObject({ resumed: true, resets: 0, prep: 1000 });
    const reset = ["memory continuation reset thread=afee713f engine=grok reason=lineage", resumed.replace("resumed=true", "resumed=false")].join("\n");
    const t = turnFromLog(reset, "afee713f");
    expect(t).toMatchObject({ resumed: false, resets: 1 });
    expect(trulyResumed(t)).toBe(false);
    // RC1: 81 resumed of 496
    const turns = [{ resumed: false, resets: 0 }, ...Array.from({ length: 495 }, (_, i) => (i < 80 ? { resumed: true, resets: 0 } : { resumed: false, resets: 1 }))];
    expect(resumedShare(turns)).toBeCloseTo(80 / 495);
    expect(resumedShare([{ resumed: false, resets: 0 }, { resumed: true, resets: 0 }])).toBe(1);
  });
});

describe("recall success scored by the turn's own sent bundle, per bot (RC1-FULL-SEARCH row 1b)", () => {
  // after L12860-12910: Orion's c0761965 fails at a late submission and the server re-dispatches it (1326c668), which
  // starts before Atlas's 5bb825cd. 5bb825cd's early recall found 2 hits but was dropped at the 300 ms wait.
  const orion = [
    tr("c0761965", "received", 0), tr("c0761965", "memory.bundle", 300, "overlapped=true outcome=ok ms=280 hits=1"),
    mem("resumed=true pre=400 recall=280 recallMode=lexical"), tr("c0761965", "dispatch.send", 410),
    "[memory] context revoked at a late submission on thread 5d912122; re-preparing once",
    tr("c0761965", "turn.done", 600, "outcome=failed"),
    tr("1326c668", "received", 0), tr("1326c668", "memory.bundle", 250, "overlapped=true outcome=ok ms=240 hits=4"),
    mem("resumed=false pre=300 recall=240 recallMode=hybrid"), tr("1326c668", "dispatch.send", 320),
  ];
  const atlas = [
    tr("5bb825cd", "received", 0), tr("5bb825cd", "memory.bundle", 333, "overlapped=true outcome=ok ms=333 hits=2"),
    "memory recall skipped thread=7e6b7332 engine=grok reason=budget wait=300",
    mem("resumed=true pre=640 recall=300 recallMode=skipped:budget"), tr("5bb825cd", "dispatch.send", 650),
    tr("1326c668", "turn.done", 700, "outcome=ok"),
    tr("5bb825cd", "engine.first-text", 760), tr("5bb825cd", "turn.done", 800, "outcome=ok"),
  ];

  test("Orion's turn follows its re-dispatch and is scored by it", () => {
    const t = turnFromLog([...orion, tr("1326c668", "turn.done", 700, "outcome=ok")].join("\n"), "5d912122");
    expect(t).toMatchObject({ traceId: "c0761965", redispatched: true, redispatchTraceId: "1326c668", done: true, outcome: "ok", recallHits: 4, recallMode: "hybrid", recallHitsSource: "early-bundle" });
    // not done while the re-dispatch runs
    expect(turnFromLog(orion.join("\n"), "5d912122").done).toBe(false);
  });

  test("Atlas's 5bb825cd, interleaved with Orion's re-dispatch, sent 0 hits and recallMode skipped:budget", () => {
    // the window after Atlas's send starts inside Orion's re-dispatch; the rig hands Orion's traces in as owned
    const t = turnFromLog([...orion.slice(6), ...atlas].join("\n"), "7e6b7332", new Set(["c0761965", "1326c668"]));
    expect(t).toMatchObject({ traceId: "5bb825cd", recallHits: 0, recallMode: "skipped:budget", recallHitsSource: "skipped", prep: 650, foreignTraces: 0 });
    expect(recallSuccess([t])).toBe(0);
    // without the exclusion the window is ambiguous, and says so
    expect(turnFromLog([...orion.slice(6), ...atlas].join("\n"), "7e6b7332").traceId).toBe("1326c668");
  });

  test("the sent bundle: dispatch recallHits wins; a skipped recall rebuilt after a reset counts the rebuild only", () => {
    const { byId } = parseTurnLog([tr("x", "received", 0), tr("x", "memory.bundle", 300, "overlapped=true outcome=ok ms=300 hits=2"), mem("resumed=true pre=1 recall=1 recallMode=lexical"), tr("x", "dispatch.send", 5, "engine=grokAgent recallHits=0")].join("\n"));
    expect(sentRecall(byId.x, false)).toEqual({ hits: 0, source: "dispatch" });
    const rebuilt = parseTurnLog([tr("y", "received", 0), tr("y", "memory.bundle", 330, "overlapped=true outcome=ok ms=330 hits=2"), tr("y", "memory.assemble", 900, "outcome=ok ms=880 hits=5"), mem("resumed=false pre=1 recall=1 recallMode=skipped:budget"), tr("y", "dispatch.send", 950)].join("\n")).byId.y;
    expect(sentRecall(rebuilt, true)).toEqual({ hits: 3, source: "rebuilt" });
    expect(sentRecall(rebuilt, false)).toEqual({ hits: 0, source: "skipped" });
    // the resumed path's own (not overlapped) bundle is the one sent
    const direct = parseTurnLog([tr("z", "received", 0), tr("z", "memory.bundle", 200, "outcome=ok ms=190 hits=3"), mem("resumed=true pre=1 recall=1 recallMode=lexical"), tr("z", "dispatch.send", 250)].join("\n")).byId.z;
    expect(sentRecall(direct, false)).toEqual({ hits: 3, source: "bundle" });
  });
});

describe("revoke index state per action (RC1-FULL-BACKGROUND row 3)", () => {
  test("ready, building, or flipped while the action ran", () => {
    expect(indexState(1, 1)).toBe("ready");
    expect(indexState(0, 0)).toBe("building");
    expect(indexState(0, 1)).toBe("flipped");
    expect(indexState(null, 1)).toBe("unknown");
  });
});

describe("network waterfall (RC1-FULL-APP)", () => {
  test("rows carry the path, start and end from the flow start, status and bytes, ordered by start", () => {
    const rows = waterfallRows([
      { url: "http://127.0.0.1:18899/api/bots?messages=100", method: "GET", type: "fetch", start: 1250, end: 1900, status: 200, bytes: 48_000 },
      { url: "http://127.0.0.1:18899/assets/index-GA3iONUE.js", method: "GET", type: "script", start: 1010, end: 1200, status: 200, bytes: 882_000 },
      { url: "https://registry.npmjs.org/x", method: "GET", type: "fetch", start: 1300 },
    ], 1000, "http://127.0.0.1:18899");
    expect(rows).toEqual([
      { url: "/assets/index-GA3iONUE.js", method: "GET", type: "script", start: 10, end: 200, ms: 190, status: 200, bytes: 882_000 },
      { url: "/api/bots?messages=100", method: "GET", type: "fetch", start: 250, end: 900, ms: 650, status: 200, bytes: 48_000 },
      { url: "https://registry.npmjs.org/x", method: "GET", type: "fetch", start: 300, end: null, ms: null, status: null, bytes: null },
    ]);
  });
});

describe("generator receipt shape (STORAGE-AUDIT section 1: gen.ts listed every later reply on every receipt)", () => {
  const turn = (n, receipts, rows = 3) => ({ bot: Array.from({ length: rows }, (_, i) => `t${n}-${i}`), receipts });

  test("a row is on its turn's frame and the session's newest receipt, never more than two", () => {
    // turn 0: frame + lookup; turn 1: none; turn 2: frame only; turn 3: none
    const out = rcReceiptOutputs([turn(0, 2), turn(1, 0), turn(2, 1), turn(3, 0)]);
    expect(out).toEqual([
      ["t0-0", "t0-1", "t0-2"],                                  // turn 0's frame
      ["t0-0", "t0-1", "t0-2", "t1-0", "t1-1", "t1-2"],          // turn 0's lookup: the newest until turn 2
      ["t2-0", "t2-1", "t2-2", "t3-0", "t3-1", "t3-2"],          // turn 2's frame: current and newest
    ]);
  });

  test("rows before the session's first receipt are on none", () => {
    expect(rcReceiptOutputs([turn(0, 0), turn(1, 1, 2)])).toEqual([["t1-0", "t1-1"]]);
    expect(rcReceiptOutputs([turn(0, 0)])).toEqual([]);
  });

  test("a 40-turn session with a receipt every turn: about 1.5 receipts per row, not the old 20", () => {
    const turns = Array.from({ length: 40 }, (_, k) => turn(k, k % 2 === 0 ? 2 : 1, 4));
    const out = rcReceiptOutputs(turns);
    const perRow = new Map();
    for (const list of out) for (const id of list) perRow.set(id, (perRow.get(id) ?? 0) + 1);
    expect(out).toHaveLength(60);
    expect(perRow.size).toBe(160);
    expect(Math.max(...perRow.values())).toBe(2);
    expect(out.reduce((a, l) => a + l.length, 0)).toBe(240);
    // the old shape (each receipt lists every row from its turn on) for the same session
    const old = turns.flatMap((t, k) => Array.from({ length: t.receipts }, () => turns.slice(k).flatMap(x => x.bot)));
    expect(old.reduce((a, l) => a + l.length, 0)).toBe(4960);
  });

  test("the owner shape: about 100k messages in 650 threads, cross-thread room transcripts, auto_vacuum off", () => {
    const o = SHAPES.owner;
    expect(o.rowsTotal).toBe(100_000);
    expect(o.bots + o.tasks + o.teams + 1 + o.groupTasks).toBe(650);
    expect(o.crossThreadLines).toBe(47);
    expect(o.roomRowsShare).toBeGreaterThan(0);
    expect(o.autoVacuumOff).toBe(1);
    expect(o.receiptsTotal).toBeLessThan(5_000);
    expect([SHAPES.extreme.autoVacuumOff, SHAPES.pr.autoVacuumOff, SHAPES.extreme.crossThreadLines]).toEqual([0, 0, 0]);
  });
});

describe("storage measurement (storage.mjs)", () => {
  test("dbstat per table, indexes with their table, the messages b-tree alone, live and file bytes, events/", () => {
    const dir = mkdtempSync(join(tmpdir(), "scale-storage-"));
    try {
      const file = join(dir, "messages.db");
      const db = new DatabaseSync(file);
      db.exec("PRAGMA auto_vacuum=0; PRAGMA journal_mode=WAL;");
      db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT, PRIMARY KEY(thread_id,id)); CREATE TABLE memory_disclosure_outputs(bundle_id TEXT, message_id TEXT, PRIMARY KEY(bundle_id,message_id)); CREATE INDEX memory_disclosure_outputs_message ON memory_disclosure_outputs(message_id); CREATE TABLE scratch(x)");
      const ins = db.prepare("INSERT INTO messages VALUES(?,?,?)"), out = db.prepare("INSERT INTO memory_disclosure_outputs VALUES(?,?)"), junk = db.prepare("INSERT INTO scratch VALUES(?)");
      db.exec("BEGIN");
      for (let i = 0; i < 2000; i++) { ins.run("t", `m${i}`, "x".repeat(200)); for (let b = 0; b < 3; b++) out.run(`b${b}-${i % 50}`, `m${i}`); junk.run("y".repeat(500)); }
      db.exec("COMMIT");
      db.exec("DELETE FROM scratch");
      mkdirSync(join(dir, "events", "sub"), { recursive: true });
      writeFileSync(join(dir, "events", "a.ndjson"), "x".repeat(1000));
      writeFileSync(join(dir, "events", "sub", "b.ndjson"), "x".repeat(24));
      const m = measureStorage(db, { file, eventsDir: join(dir, "events") });
      expect(m.error).toBeUndefined();
      expect(m.autoVacuum).toBe(0);
      expect(m.freelist).toBeGreaterThan(0);
      expect(m.liveBytes).toBe((m.pageCount - m.freelist) * m.pageSize);
      expect(m.fileBytes).toBe(m.pageCount * m.pageSize);
      expect(m.fileBytes).toBeGreaterThan(m.liveBytes);
      expect(m.liveBytes).toBe(liveBytes(db));
      expect(m.eventsBytes).toBe(1024);
      // messages: its own b-tree plus the PK autoindex; M is the b-tree alone
      expect(m.tables.messages).toBeGreaterThan(m.messagesBytes);
      expect(m.messagesBytes).toBeGreaterThan(400_000);
      // the outputs table counts its autoindex and its named index
      const outputs = db.prepare("SELECT sum(pgsize) AS b FROM dbstat WHERE name IN ('memory_disclosure_outputs','memory_disclosure_outputs_message') OR name LIKE 'sqlite_autoindex_memory_disclosure_outputs%'").get().b;
      expect(m.tables.memory_disclosure_outputs).toBe(outputs);
      expect(groupBytes(m.tables, ["memory_disclosure"])).toBe(outputs);
      expect(groupBytes(m.tables, ["nothing_"])).toBe(0);
      db.close();
    } finally { removeTempDirSync(dir); }
  });

  test("dbstat unavailable comes back as an error the gate fails on, never as numbers", () => {
    const fake = { exec() {}, prepare(sql) { if (sql.includes("dbstat")) throw new Error("no such table: dbstat"); return { get: () => ({ v: 1 }) }; } };
    const m = measureStorage(fake, {});
    expect(m.error).toBe("dbstat unavailable: no such table: dbstat (the storage gate cannot be judged without it)");
    expect(m.tables).toBeUndefined();
    expect(m.messagesBytes).toBeUndefined();
  });

  test("slope: bytes per new message over the first and last 10% of the turns", () => {
    // 100 turns, 2 messages a turn; 1,000 B per message early, 1,500 late
    const samples = [{ live: 0, messages: 0 }];
    for (let t = 1; t <= 100; t++) samples.push({ live: samples[t - 1].live + (t > 90 ? 3000 : 2000), messages: t * 2 });
    expect(slopeBytes(samples)).toEqual({ turns: 100, early: { turns: 10, bytes: 20_000, messages: 20, perMessage: 1000 }, late: { turns: 10, bytes: 30_000, messages: 20, perMessage: 1500 } });
    expect(slopeBytes(samples.slice(0, 2)).error).toBe("slope storage: 1 turns sampled (needs at least 2)");
    // no new messages in a window: no per-message figure (the gate fails it)
    expect(slopeBytes([{ live: 0, messages: 5 }, { live: 4096, messages: 5 }, { live: 4096, messages: 7 }]).early.perMessage).toBeNull();
  });

  test("events/ bytes are 0 when there is no events/", () => {
    expect(dirBytes(join(tmpdir(), "scale-no-such-dir-x"))).toBe(0);
  });
});
