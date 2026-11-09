import { scrubCore, safeAccounting } from "./scrub-accounting.mjs";
import { firstSendRecorder, allEldWindows } from "./smooth-config.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The smoothness gate's pure helpers (SMOOTHNESS-GATE-105): the user failure each guards is a whole-system symptom
// Sean saw that a lane's own test never counts (a card at No limits, a withheld hand-off, a Context changed kill, an
// io-budget storm, a routine held for connected apps).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { allTimed, cardStat, eldSummary, idleIoCounts, keptText, pageCovers, winLeftovers } from "./smooth-config.mjs";
import { controlAdapter, restoreControls, failureEventRecord, failedTurnKey, scrubAccounting, errorRowsIn, failedTurnRecord, keptTurnEnd, nativeRpcErrorsIn, rpcErrorsIn } from "./smooth-config.mjs";
import { roomProofRefusal, runRoomRouteProof } from "./smooth-config.mjs";
import { stats as statsOf } from "../scale/stats.mjs";
import { evidenceLedger, writeEvidence } from "./evidence.mjs";
import { routinePrompt } from "./smooth-config.mjs";
import { attributionWindow, boxQuiet, parseTopProcs, preStartBusy, preStartCheck, rigPidTracker, rigProvenance, topSampleCollector, treeCores } from "./smooth-config.mjs";
import { gate } from "./smooth-gate.mjs";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";
const asLoaded = r => ({ ...r, load: true, runId: `${r.runId ?? "idle"}-loaded` });
import { answerRoomCards, drainRoomCards, enforceRoomSettlement, settleRoomScenario, roomBudget, recordCleanupFailure, recordRoomDelete, measuredEld, warmIoCounts, roomOwnerAnswer, workerSliceWall } from "./smooth-config.mjs";
import { fakeVersionBanner, fakeVersionShell, FIXTURE_ENV_OMITTED, initialResults, proveFakeResolvers, stopOwnedServer } from "./packaged.mjs";
import { compileCacheFileCount, importUrl, observedDataDir, observedNativeFiles, packagedBoots, packagedCompileCacheDirectory, packagedLayout, packagedPreflightRefusal, packagedStartupPreflight, packagedTracePreflight, prepareCompileCache, readAppMetadata, readElectronVersion, refusePackagedLeg, serverLaunch } from "./packaged.mjs";
import { answerCards, botFolder, cardTimings, cardsIn, isQuestionCard, ownerAnswer, permissionWaits, chainFromManager, chainFromServer, heldPrompt, stopAndSettle, REAL_HELD_SECONDS, speakerOf, waitFor, workingDeleteVerdict, contextChangedIn, countSignatures, DEV_COMMANDS, eldStalls, expectedCards, judge, judgeRow, levelPatch, openCards, roomReplies, routineBurst, sampleWindow, withPeak, cgroupPathOf, cgroupCpuUsec, cgroupMemMb, coresBetween, coresFromTopLine, macTable, legRss, leftovers, leftoverNames, winLine, winPeakProcs, rssPeakLine, PEAK_PROCS_MAX, winCores, keptCard, traceLinesOf, realDelegationPrompt, browserHostVerdict, dataDirRealOk, MAX_GAP_MS, WIN_TELEMETRY_PS, isMainModule, dataDirAllowed, osPassThrough, encodedPowerShell, SERVER_START_MARK, startupNotesIn, STARTUP_NOTE_MARK, STOP_COMMANDS, table, verdictOf, withheldIn } from "./smooth-config.mjs";

const LOG = [
  "[2026-10-24T01:00:00.000Z] [err] [io-budget] writing 19.2 MB/min (budget 1); source: database:/x/messages.db; top statements: 12ms x700 INSERT OR IGNORE INTO memory_deny_memory(kind,id,version,revoke)",
  "[2026-10-24T01:00:01.000Z] [err] [memory] context revoked during dispatch on thread t-1; re-preparing (1 of 3)",
  "[2026-10-24T01:00:02.000Z] [err] [memory] context revoked during dispatch on thread t-1 after 3 rebuilds (Claude); the turn ends with a card",
  "[2026-10-24T01:00:03.000Z] [err] [memory] send fence refused (checking:pending, content reader): 2 of 2 parts",
  "[2026-10-24T01:00:04.000Z] [err] engine history: claude home not read: open by process holders [{}]",
  "[2026-10-24T01:00:05.000Z] [err] [memory] worker result for job j was STALE_MEMORY_LEASE (the authority moved while the job was leased); requeued",
  "[2026-10-24T01:00:06.000Z] [err] memory continuation reset thread=t-2 engine=claude reason=checking",
  "[2026-10-24T01:00:07.000Z] [err] conversation deletion: home left pending (claude): engine-running; recorded engine-running",
  "[2026-10-24T01:00:08.000Z] [out] a quiet line",
].join("\n");

describe("rig v5.9 failed-turn evidence", () => {
  const at = "2026-11-07T00:00:00.000Z";
  const input = result => ({ at, scenario: "trust", botId: "abcdefgh-more", result });
  it("rpcErrorsIn reads ACP error objects and native trace envelopes", () => {
    const error = { code: -32603, message: 'failed "now"', data: { tokens: 999, secret: "never kept" } };
    for (const line of [JSON.stringify({ error }), JSON.stringify({ at, dir: "in", source: "fuigo", msg: { jsonrpc: "2.0", id: 1, error } }),
      `[out] ${JSON.stringify({ error })}`]) expect(rpcErrorsIn([line])).toEqual([{ code: -32603, message: 'failed "now"' }]);
  });
  it("rpcErrorsIn reads key=value diagnostics and ignores current outcome-only spans", () => {
    expect(rpcErrorsIn(['[turn-trace] id=a phase=rpc.session/prompt code=-32603 message=Internal_error',
      '[turn-trace] id=a phase=rpc.session/prompt message="Internal error: \\"quoted\\"" code=-32602',
      '[turn-trace] id=a phase=rpc.session/prompt outcome=error ms=1'])).toEqual([
      { code: -32603, message: "Internal_error" }, { code: -32602, message: 'Internal error: "quoted"' },
    ]);
  });
  it("rpcErrorsIn ignores malformed lines and invalid fields without throwing", () => {
    expect(rpcErrorsIn([null, {}, 1, "{", '{"error":{"code":1,"message":"cut',
      '{"error":{"code":"1","message":"bad"}}', '{"error":{"code":1,"message":{}}}',
      'code=NaN message=bad', 'code=2 message="unterminated', 'rpcCode=-32603 outcome=error',
      '{"error":{"code":1e999,"message":"bad"}}'])).toEqual([]);
    for (const lines of [undefined, null, {}, "code=1 message=bad"]) expect(rpcErrorsIn(lines)).toEqual([]);
  });
  it("rpcErrorsIn deduplicates across forms and caps messages at 300 and records at 10", () => {
    const lines = ['{"error":{"code":1,"message":"same"}}', 'code=1 message=same',
      ...Array.from({ length: 20 }, (_, code) => JSON.stringify({ error: { code: code + 2, message: "x".repeat(400) } }))];
    const rows = rpcErrorsIn(lines);
    expect(rows).toHaveLength(10); expect(rows[0]).toEqual({ code: 1, message: "same" });
    expect(rows.slice(1).every(row => row.message.length === 300)).toBe(true);
  });
  it("nativeRpcErrorsIn keeps only redacted incoming errors within the turn window", () => {
    const frame = { at, dir: "in", msg: { error: { code: -32603, message: "private", data: { tokens: 999 } } } };
    const text = [frame, { ...frame, at: "2026-11-06T00:00:00.000Z", msg: { error: { code: 1, message: "stale" } } },
      { ...frame, dir: "out", msg: { error: { code: 2, message: "outbound" } } },
      { at, dir: "in", msg: { params: { text: "conversation", tokens: 999 } } }].map(row => JSON.stringify(row)).join("\n") + "\n{malformed";
    expect(nativeRpcErrorsIn(text, Date.parse(at), line => line.replaceAll("private", "[redacted]")))
      .toEqual([{ code: -32603, message: "[redacted]" }]);
    expect(nativeRpcErrorsIn(text, Date.parse(at), null)).toEqual([]);
    expect(nativeRpcErrorsIn(text, Date.parse(at), () => { throw Error("private"); })).toEqual([]);
  });
  it("completion fields retain only bounded redacted strings", () => {
    const end = keptTurnEnd({ stopReason: "x".repeat(400), deniedBy: { secret: "no" },
      denials: [null, 3, {}, ...Array(20).fill("deny")], usage: {}, tokens: 12 }, text => `redacted:${text}`);
    expect(end.stopReason).toHaveLength(300); expect(end.deniedBy).toBeNull();
    expect(end.denials).toEqual(Array(10).fill("redacted:deny"));
    expect(Object.keys(end)).toEqual(["stopReason", "deniedBy", "denials"]);
  });
  it("failedTurnRecord allowlists fields and redacts every retained text before capping", () => {
    const calls = [], redact = text => { calls.push(text); return `redacted:${text}`; };
    const result = { outcome: "turn.failed", stopReason: "rpc_error", deniedBy: "engine", denials: ["denied", {}],
      error: "engine broke", usage: { input: 777 }, cost: 888, charge: 999, tokens: 666,
      rpcErrors: [{ code: -32602, message: "native failure", usage: 777, tokens: 666 }],
      errorTrace: ['[turn-trace] id=a phase=rpc code=-32603 message="failure"',
        '[turn-trace] id=a phase=turn.done tokensIn=777 tokensOut=666', '{"usage":{"input":777}}'] };
    const record = failedTurnRecord(input(result), redact);
    expect(Object.keys(record)).toEqual(["at", "scenario", "botId8", "outcome", "stopReason", "deniedBy", "denials", "error", "rpcErrors", "errorTrace"]);
    expect(record).toMatchObject({ at, scenario: "redacted:trust", botId8: "redacted", outcome: "redacted:turn.failed",
      stopReason: "redacted:rpc_error", deniedBy: "redacted:engine", denials: ["redacted:denied"], error: "redacted:engine broke" });
    expect(record.rpcErrors).toEqual([{ code: -32602, message: "redacted:redacted:native failure" }, { code: -32603, message: "redacted:failure" }]);
    expect(record.errorTrace).toEqual(result.errorTrace.map(line => scrubAccounting(`redacted:${line}`)));
    for (const value of ["trust", "abcdefgh-more", "turn.failed", "rpc_error", "engine", "denied", "engine broke", "failure", result.errorTrace[0]]) expect(calls).toContain(value);
    expect(JSON.stringify(record)).not.toMatch(/777|888|999|666/);
  });
  it("failedTurnRecord keeps current Murage activity errors and older error details, never replies", () => {
    for (const tool of [
      { name: "error: private", ok: false, errorDetails: "private\nEngine error code: -32603", diagnostic: { rpcCode: -32603 } },
      { name: "error: private", ok: false, errorDetails: "private\nEngine error code: -32603" },
    ]) {
      const record = failedTurnRecord({ ...input({ outcome: "turn.failed" }), errorRows: [
        { role: "bot", kind: "activity", tool }, { role: "bot", text: "conversation must not survive" },
        { role: "user", kind: "error", text: "user must not survive" },
      ] }, text => text.replaceAll("private", "[redacted]"));
      expect(record.error).toBe("[redacted]\nEngine error code: -32603");
      expect(record.rpcErrors).toEqual([{ code: -32603, message: "[redacted]" }]);
      expect(JSON.stringify(record)).not.toMatch(/private|must not survive/);
    }
  });
  it("failedTurnRecord caps traces and errors and fails closed without redaction", () => {
    const values = input({ error: "s".repeat(4000), errorTrace: Array(60).fill("t".repeat(4000)) });
    const record = failedTurnRecord(values, text => text);
    expect(record.error).toHaveLength(2000); expect(record.errorTrace).toHaveLength(40);
    expect(record.errorTrace.every(line => line.length === 600)).toBe(true); // keptTrace cap is 600 (P1-4)
    for (const redact of [null, () => { throw Error("secret"); }]) {
      const kept = failedTurnRecord(values, redact);
      expect(kept.error).toMatch(/text not kept/); expect(kept.rpcErrors).toEqual([]);
      expect(JSON.stringify(kept)).not.toContain("ssss");
    }
  });
  it("traceLinesOf requires the exact trace id and omits token counts", () => {
    const log = ['[turn-trace] id=abc-other phase=x', '[turn-trace] id=abc phase=rpc outcome=error',
      '[turn-trace] id=abc phase=turn.done tokensIn=123 tokensOut=456', 'reply id=abc private'].join("\n");
    expect(traceLinesOf(log, "abc", text => text)).toEqual(['[turn-trace] id=abc phase=rpc outcome=error',
      '[turn-trace] id=abc phase=turn.done tokensIn="x" tokensOut="x"']);
  });

  it("SSE projection journals routine, delegated task and group failures without turn(), deduplicates turns and ignores non-runner threads", () => {
    const ownedThreads = new Set(["routine-thread", "worker-task", "group-thread"]), seen = new Set();
    const project = event => failureEventRecord({ event, ownedThreads, seen, at, scenario: "routineBurst" }, text => text);
    for (const [threadId, type] of [["routine-thread", "turn.completed"], ["worker-task", "turn.failed"], ["group-thread", "turn.failed"]]) {
      const event = { threadId, type, ok: false, turnId: `${threadId}-turn`, stopReason: "usage=777" };
      const before = seen.size;
      const record = project(event);
      expect(record).toMatchObject({ kind: "first", at, threadId8: threadId.slice(0, 8), turnId8: event.turnId.slice(0, 8), outcome: "turn.failed", stopReason: 'usage="x"' });
      expect(seen.size).toBe(before); // projection itself never mutates seen
      seen.add(failedTurnKey(event));
      expect(project(event)).toBeNull();
      expect(project({ ...event, threadId: "group-thread" })).toBeNull(); // identity is turnId, not thread+turnId
      expect(project({ ...event, turnId: `${event.turnId}-next` })).not.toBeNull();
    }
    expect(project({ threadId: "other-thread", type: "turn.failed", turnId: "other" })).toBeNull();
    expect(project({ threadId: "routine-thread", type: "turn.completed", ok: true })).toBeNull();
    const noId = { threadId: "routine-thread", type: "turn.failed", turn: 1 };
    expect(project(noId)).not.toBeNull(); seen.add(failedTurnKey(noId));
    expect(project(noId)).toBeNull();
    expect(project({ ...noId, turn: 2 })).not.toBeNull();
    expect(project({ ...noId, threadId: "group-thread" })).not.toBeNull();
  });

  it("scrubs accounting canaries in every retained diagnostic string after redaction", () => {
    const canary = 'usage=777 cost: 888 charge=999 tokens=666 tokensIn=123 tokensOut: 456 "inputTokens":789 OUTPUTTOKENS=321 cachedInput=654';
    const result = { outcome: "turn.failed", error: canary, stopReason: canary, deniedBy: canary, denials: [canary],
      rpcErrors: [{ code: -32603, message: canary }], errorTrace: [`[turn-trace] id=a phase=turn.done at=20ms outcome=failed ${canary}`] };
    const record = failedTurnRecord(input(result), text => text);
    for (const text of [record.error, record.stopReason, record.deniedBy, ...record.denials, record.rpcErrors[0].message, ...record.errorTrace]) {
      expect(text).not.toMatch(/777|888|999|666|123|456|789|321|654/);
      expect(text).toContain('usage="x"'); expect(text).toContain('cachedInput="x"');
    }
    expect(keptText("private", () => "usage=777")).toBe('usage="x"');
    expect(keptText("private", () => ({ replace: () => { throw Error("scrubber failure"); } }))).toContain("text not kept");
    expect(nativeRpcErrorsIn(JSON.stringify({ at, dir: "in", msg: { error: { code: -32603, message: canary } } }), Date.parse(at), text => text)[0].message).not.toMatch(/777|654/);
  });

  const persistence = (failure = null, overrides = {}) => {
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("function appendFailureRecord("), source.indexOf("async function quiesce("));
    const events = [], lines = [], R = { created: { bots: ["abcdefgh-more"] }, failedTurns: { count: 0, records: [] } };
    const operation = name => { events.push(name); if (failure === name) throw Error("private"); };
    const pendingEnrichments = new Set();
    let sequence = 0;
    // The real ledger and journal writer, wired as smooth.mjs wires them (no stand-ins).
    const exits = [];
    const evidence = evidenceLedger({ results: R, writeResults: () => events.push("save"), setExitCode: code => exits.push(code) });
    const deps = { evidence, writeEvidence, activeEvidenceTurns: new Map(), RUN_ID: "run-fixture", R, errorRowsIn, failedTurnRecord, failureEventRecord, failedTurnKey, roomBudget, keptText, traceLinesOf, nativeRpcErrorsIn,
      ownedThreads: new Set(["thread"]), journaledTurns: new Set(), pendingEnrichments,
      save: () => events.push("save"), DATA: "/smooth-data", OUT: "/out", LABEL: "fixture", join,
      readFileSync: () => JSON.stringify({ at, dir: "in", msg: { error: { code: -32603, message: "private" } } }),
      redact: text => text.replaceAll("private", "[redacted]"),
      threadMessages: async () => { events.push("transcript"); return [{ role: "bot", kind: "error", text: "private", at: 2 }]; },
      logFrom: () => "[turn-trace] id=abc phase=rpc outcome=error",
      openSync: () => { operation("open"); return 42; },
      appendFileSync: (fd, line) => { expect(fd).toBe(42); operation("append"); lines.push(line); },
      fsyncSync: fd => { expect(fd).toBe(42); operation("fsync"); }, closeSync: () => operation("close"), note: () => events.push("note"), ...overrides };
    const helpers = new Function(...Object.keys(deps), `${body}\nreturn { keepFailedTurn, journalFailureEvent, drainFailureEnrichments };`)(...Object.values(deps));
    return { R, events, lines, pendingEnrichments, evidence, exits, ownedThreads: deps.ownedThreads, ...helpers, run: (botId = "abcdefgh-more") => helpers.keepFailedTurn({ failed: true, outcome: "turn.failed", traceId: "abc" },
      { botId, threadId: "thread", turnId: `turn-${sequence++}`, mark: 0, sinceAt: 1, scenario: "trust" }) };
  };
  it("journals one JSON line and fsyncs before returning, retaining only 50 records", async () => {
    const fixture = persistence();
    for (let i = 0; i < 51; i++) await fixture.run();
    expect(fixture.events.slice(0, 4)).toEqual(["open", "append", "fsync", "close"]);
    expect(fixture.R.failedTurns.count).toBe(51); expect(fixture.R.failedTurns.records).toHaveLength(50);
    expect(fixture.lines).toHaveLength(102);
    expect(fixture.lines.every(line => line.endsWith("\n") && line.split("\n").length === 2)).toBe(true);
    const first = JSON.parse(fixture.lines[0]), enriched = JSON.parse(fixture.lines[1]);
    expect(first).toMatchObject({ kind: "first", outcome: "turn.failed", threadId8: "thread", turnId8: "turn-0" });
    expect(enriched).toMatchObject({ kind: "enriched", key: first.key, error: "[redacted]", botId8: "abcdefgh" });
    expect(enriched.rpcErrors).toEqual([{ code: -32603, message: "[redacted]" }]);
    expect(fixture.events.indexOf("fsync")).toBeLessThan(fixture.events.indexOf("transcript"));
    await fixture.run("real-conversation"); expect(fixture.lines).toHaveLength(102);
  });
  it("SSE first append is synchronous, deduplicated and precedes any enrichment transcript await", async () => {
    const f = persistence(), event = { type: "turn.completed", ok: false, threadId: "thread", turnId: "turn-0" };
    f.journalFailureEvent(event, "routineBurst"); f.journalFailureEvent(event, "routineBurst");
    expect(f.lines).toHaveLength(1); expect(f.events).toEqual(["open", "append", "fsync", "close"]);
    const pending = f.run();
    expect(f.lines).toHaveLength(1); expect(f.events).not.toContain("transcript");
    await f.drainFailureEnrichments("fixture deletion"); await pending;
    expect(f.lines).toHaveLength(2); expect(f.pendingEnrichments.size).toBe(0); expect(f.R.failedTurns.count).toBe(1);
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const reader = source.slice(source.indexOf("async function sse()"), source.indexOf("// ---- RIG-SMOOTH-R2 v3 telemetry"));
    expect(reader.indexOf("journalFailureEvent(e,")).toBeLessThan(reader.indexOf("w.resolve("));
    for (const boundary of ["resource deletion", "room deletion", "server stop"]) expect(source).toContain(`await drainFailureEnrichments("${boundary}")`);
  });
  it("SSE reader registers owned bot tasks and groups and journals failures with no turn waiter", async () => {
    const f = persistence(), source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    f.R.created.groups = ["owned-group"];
    const frames = [
      { kind: "bot", bot: { id: "abcdefgh-more", threadId: "routine-thread", tasks: [{ threadId: "worker-task" }] } },
      { kind: "group", group: { id: "owned-group", threadId: "group-thread" } },
      { kind: "bot", bot: { id: "unowned", threadId: "unowned-thread" } },
      ...["routine-thread", "worker-task", "group-thread", "unowned-thread"].map(threadId => ({ kind: "runtime",
        event: { type: "turn.completed", ok: false, threadId, turnId: `${threadId}-turn` } })),
      { kind: "runtime", event: { type: "turn.failed", threadId: "group-thread", turnId: "group-thread-turn" } },
    ];
    const registration = source.slice(source.indexOf("function registerOwnedThreads("), source.indexOf("// SMOOTH_DEBUG=1:"));
    const reader = source.slice(source.indexOf("async function sse()"), source.indexOf("// ---- RIG-SMOOTH-R2 v3 telemetry"));
    let connection, fetched = false;
    const deps = { R: f.R, ownedThreads: f.ownedThreads, ownedThreadScenarios: new Map(), activeJournalTurns: new Map(),
      currentScenario: "routineBurst", waits: new Set(), seenTurnIds: new Map(), URL_: "fixture", H: {},
      AbortController: class { constructor() { this.signal = { aborted: false }; connection = this; } },
      fetch: async () => {
        if (fetched) throw Error("fixture stream ended"); fetched = true;
        return { body: (async function* () {
          yield new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n`).join(""));
          connection.signal.aborted = true;
        })() };
      },
      journalFailureEvent: f.journalFailureEvent,
      matchTurnEvent: () => { throw Error("no waiter expected"); },
      sleep: async () => { throw Error("unexpected reconnect"); }, keptTurnEnd, redact: text => text };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(deps), `let sseAbort = null, journalTurnSequence = 0;\n${registration}\n${reader}\nawait sse();`)(...Object.values(deps));
    expect(f.lines.map(line => JSON.parse(line).threadId8)).toEqual(["routine-", "worker-t", "group-th"]);
    expect(f.R.failedTurns.count).toBe(3); expect(f.events).not.toContain("transcript");
    expect(f.ownedThreads.has("unowned-thread")).toBe(false);
  });
  it("enrichment drain records a bounded timeout before cleanup and suppresses late enrichment", async () => {
    let release, cap;
    const f = persistence(null, { threadMessages: () => new Promise(resolve => { release = resolve; }),
      setTimeout: (fn, ms) => { cap = ms; fn(); return 1; }, clearTimeout: () => {} });
    const pending = f.run();
    await Promise.resolve(); // begin the suspended transcript read
    await f.drainFailureEnrichments("fixture deletion");
    expect(cap).toBeLessThanOrEqual(10_000);
    expect(f.R.failedTurnEnrichmentTimeout).toBe("failed-turn enrichment timed out: 1 pending");
    expect(f.events).toContain("save"); expect(f.R.legFailed).toBe(true); expect(f.exits).toContain(1);
    expect(JSON.parse(f.lines[1])).toMatchObject({ kind: "enriched", key: JSON.parse(f.lines[0]).key, enrichmentError: f.R.failedTurnEnrichmentTimeout });
    release([]); await pending;
    expect(f.lines).toHaveLength(2); expect(f.pendingEnrichments.size).toBe(0);
  });
  it.each(["open", "append", "fsync", "close"])("journal %s failure is noted and never ends the scenario", async failure => {
    const fixture = persistence(failure);
    await expect(fixture.run()).resolves.toMatchObject({ failed: true });
    // A1: the code-only reason latches the leg: FAIL, a reason, exit code 1.
    expect(fixture.R.failedTurnLogError).toBe("failed-turn journal write failed: UNKNOWN"); expect(fixture.events).toContain("save");
    expect(fixture.R).toMatchObject({ legFailed: true, status: "FAIL", legFailureReason: "failed-turn journal write failed: UNKNOWN" });
    expect(fixture.exits).toContain(1);
    expect(fixture.R.failedTurns.count).toBe(1);
    if (failure !== "open") expect(fixture.events).toContain("close");
  });
});

describe("rig v5.8 packaged launch (plans only; no spawn)", () => {
  it("pins every mirrored fixture value and omitted desktop environment name", () => {
    const names = [
      "MURAGE_DESKTOP_PARENT", "MURAGE_INTERNAL_DATA_DIR_LEASE", "MURAGE_COMPANION_TOKEN", "MURAGE_COMPANION_TOKEN_VIA",
      "MURAGE_MODEL_PROVIDER_COMMIT_TOKEN", "MURAGE_MCP_COMMIT_TOKEN",
      "MURAGE_COMPOSIO_BROKER_URL", "MURAGE_COMPOSIO_BROKER_TOKEN", "MURAGE_FLUX_COMPOSIO_BROKER_URL", "MURAGE_FLUX_COMPOSIO_BROKER_TOKEN",
      "MURAGE_FLUX_COMPOSIO_ACCOUNT_KIND", "MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL", "MURAGE_COMPOSIO_LEGACY_CLAIM", "COMPOSIO_API_KEY", "MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED",
      "MURAGE_MODEL_PROVIDER_CONNECTIONS", "MURAGE_TELEGRAM_BOT_TOKEN", "MURAGE_SLACK_APP_TOKEN", "MURAGE_SLACK_BOT_TOKEN", "MURAGE_DISCORD_BOT_TOKEN",
      "XAI_API_KEY", "BOX_TOKEN", "MURAGE_TTS_KEY", "MURAGE_OPENAI_IMAGE_KEY", "OPENCODE_API_KEY", "MURAGE_TAVILY_SEARCH_KEY", "MURAGE_EXA_SEARCH_KEY", "MURAGE_FIRECRAWL_SEARCH_KEY",
      "FLUX_API_KEY", "MURAGE_FLUX_CONNECTION_ALIASES", "MURAGE_MCP_SERVER_SECRETS", "MURAGE_EMAIL_SECRETS", "MURAGE_BROWSER_CONNECTION",
    ];
    expect(FIXTURE_ENV_OMITTED.map(row => row.name)).toEqual(names);
    for (const row of FIXTURE_ENV_OMITTED) { expect(row.reason.length).toBeGreaterThan(20); expect(row.cite).toMatch(/^electron\/.+:\d+/); }
    const plan = serverLaunch({ appDir: "/app", appVersion: "1.0.18", electronVersion: "42.1.0", work: "/work", platform: "linux",
      env: { MURAGE_DATA_DIR: "/smooth/data", ...Object.fromEntries(names.map(name => [name, "must not inherit"])) } });
    expect(plan.fixtureEnvOmitted).toEqual(FIXTURE_ENV_OMITTED);
    for (const name of names) expect(plan.env[name]).toBeUndefined();
    expect(plan.env).toEqual({ MURAGE_DATA_DIR: "/smooth/data", ELECTRON_RUN_AS_NODE: "1", MURAGE_APP_VERSION: "1.0.18",
      MURAGE_SYSTEM_LANGUAGE: "en-US", MURAGE_CREDENTIAL_STORE: "unavailable", MURAGE_SECRET_SAVE_REFUSED: "", MURAGE_FLUX_AMBIENT_KEY: "",
      MURAGE_USER_DATA: "/smooth/data/smooth-user-data", MURAGE_BACKUP_CONTROL_DIR: `/smooth/.murage-backup-control/${createHash("sha256").update("/smooth/data").digest("hex")}`,
      MURAGE_RESOURCES_PATH: "/app/resources", MURAGE_STATIC_DIR: "/app/resources/ui", MURAGE_SKILLS_DIR: "/app/resources/skills",
      MURAGE_SKILL_LIBRARY: "/app/resources/skills-library", MURAGE_LIBRARY_DIR: "/app/resources/library", MURAGE_BOT_LIBRARY_DIR: "/app/resources/bot-library",
      MURAGE_FUIGO_DIR: "/app/resources/fuigo", MURAGE_GEPA_DIR: "/app/resources/gepa-worker", MURAGE_MEMORY_MODEL_DIR: "/app/resources/memory-model",
      MURAGE_GEPA_MANIFEST_SHA256: "", MURAGE_TURN_TRACE: "1", NODE_COMPILE_CACHE: "/smooth/data/smooth-user-data/node-compile-cache/1.0.18-electron-42.1.0" });
  });
  it.each([ ["fuigo", /^fuigo 999\.0\.0 /], ["grok", /^grok 1\.0\.62 /], ["claude", /^2\.1\.295 \(Claude Code\) /] ])("answers %s's resolver version contract in the wrapper", (engine, accepted) => {
    const banner = fakeVersionBanner(engine, "unique-leg");
    expect(banner).toMatch(accepted); expect(banner).toContain("smooth-wrapper=unique-leg");
    const shell = fakeVersionShell(engine, "unique-leg");
    expect(shell).toContain('[ "$arg" = "--version" ]'); expect(shell).toContain(banner); expect(shell).toContain("exit 0");
    const runner = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    expect(runner).toContain(engine === "claude" ? 'fakeVersionShell("claude", wrappers.claude.witness)' : 'fakeVersionShell(cli, wrappers[cli].witness)');
  });
  it("proves the selected wrappers and refuses a bundled source, foreign banner or missing route", async () => {
    const wrappers = Object.fromEntries(["fuigo", "grok", "claude"].map(engine => [engine, { path: `/smooth/bin/${engine}`, banner: fakeVersionBanner(engine, engine) }]));
    const instances = Object.entries(wrappers).map(([instanceId, row]) => ({ instanceId, cliDefault: instanceId, cliCandidates: [row.path], snapshot: { state: "available", version: row.banner } }));
    const call = async (_, route) => ({ status: 200, json: route === "/api/instances" ? { instances } : { source: "path" } });
    expect(await proveFakeResolvers({ call, wrappers })).toHaveLength(3);
    instances[0].cli = "/app/resources/fuigo/fuigo";
    await expect(proveFakeResolvers({ call, wrappers })).rejects.toThrow("selected /app/resources/fuigo/fuigo");
    delete instances[0].cli;
    await expect(proveFakeResolvers({ wrappers, call: async (method, route) => route.endsWith("/fuigo") ? { status: 200, json: { source: "bundled" } } : call(method, route) })).rejects.toThrow("bundled/managed");
    instances[0].snapshot.version = "fuigo 1.0.62";
    await expect(proveFakeResolvers({ call, wrappers })).rejects.toThrow("expected wrapper /smooth/bin/fuigo");
    await expect(proveFakeResolvers({ wrappers, call: async () => ({ status: 404 }) })).rejects.toThrow("evidence unavailable");
  });
  it("overwrites an earlier PASS before an early metadata refusal, retaining the new run id", async () => {
    const root = mkdtempSync(join(tmpdir(), "smooth-early-")), file = join(root, "results.json");
    try {
      writeFileSync(file, JSON.stringify({ status: "PASS", runId: "old", preflight: { ok: true } }));
      const results = initialResults({ mode: "packaged", label: "leg", runId: "fresh" });
      const save = () => writeFileSync(file, JSON.stringify(results));
      save();
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ phase: "running", status: "INVALID", runId: "fresh", preflight: { ok: false } });
      const exits = [];
      await refusePackagedLeg("invalid SMOOTH_APP_DIR (missing version)", { results, save, report: () => {}, stop: async () => {}, exit: code => exits.push(code) });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ mode: "packaged", label: "leg", runId: "fresh", status: "INVALID", preflight: { ok: false, refusal: expect.stringContaining("missing version") } });
      expect(exits).toEqual([2]);
      const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
      expect(source.indexOf('save(); // Supersede')).toBeLessThan(source.indexOf('appMetadata = readAppMetadata'));
    } finally { removeTempDirSync(root); }
  });
  it("links every named runner import without importing or starting the runner", async () => {
    const runner = new URL("./smooth.mjs", import.meta.url);
    const source = readFileSync(runner, "utf8");
    for (const [, names, specifier] of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/gm)) {
      const module = await import(specifier.startsWith(".") ? new URL(specifier, runner).href : specifier);
      for (const name of names.split(",").map(s => s.trim().split(/\s+as\s+/)[0])) expect(Object.hasOwn(module, name), `${specifier} exports ${name}`).toBe(true);
    }
  });
  const env = { PATH: "/bin", MURAGE_DATA_DIR: "/smooth/data", MURAGE_PORT: "18977", MURAGE_WEBHOOK_PORT: "18978",
    MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: "fixture-secret", MURAGE_TURN_TRACE: "1" };
  it.each(["linux", "darwin", "win32"])("uses the installed Electron, bundled server and resource paths on %s", platform => {
    const win = platform === "win32", work = win ? "C:\\smooth work#1" : "/smooth work#1";
    const appDir = win ? "C:\\Program Files\\Murage" : platform === "darwin" ? "/Applications/Murage.app" : "/opt/Murage";
    const data = win ? "C:\\smooth\\data" : env.MURAGE_DATA_DIR;
    const plan = serverLaunch({ appDir, appVersion: "1.0.18", electronVersion: "42.1.0", gepaPin: "a".repeat(64), work, execPath: "unused-node", platform,
      env: { ...env, MURAGE_DATA_DIR: data, NODE_OPTIONS: "--require wrong.cjs", NODE_COMPILE_CACHE: "/inherited/cache", NODE_DISABLE_COMPILE_CACHE: "1", MURAGE_DESKTOP_PARENT: "1", MURAGE_ENGINE_EXCLUSION_PATH: "wrong.node" } });
    const layout = packagedLayout(appDir, platform);
    expect(plan.mode).toBe("packaged"); expect(plan.serverEntry).toBe(layout.serverEntry); expect(plan.executable).toBe(layout.executable);
    expect(plan.args).toEqual(["--import", importUrl(`${work}/scripts/scale/eld.mjs`, platform), "--import", importUrl(`${work}/scripts/smoothness/packaged-preload.mjs`, platform), layout.serverEntry]);
    expect(plan.args).not.toContain("--experimental-strip-types"); expect(plan.cwd).toBe(work);
    expect(plan.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", MURAGE_DATA_DIR: data, MURAGE_PORT: "18977", MURAGE_WEBHOOK_PORT: "18978",
      MURAGE_DEV_DESKTOP_SECRET: "fixture-secret", MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_APP_VERSION: "1.0.18", MURAGE_TURN_TRACE: "1", MURAGE_GEPA_MANIFEST_SHA256: "a".repeat(64), MURAGE_RESOURCES_PATH: layout.resources });
    expect(plan.env.MURAGE_STATIC_DIR).toBe(layout.resources + (win ? "\\ui" : "/ui"));
    expect(plan.env.MURAGE_FUIGO_DIR).toBe(layout.resources + (win ? "\\fuigo" : "/fuigo"));
    expect(plan.env.NODE_COMPILE_CACHE).toBe(win ? "C:\\smooth\\data\\smooth-user-data\\node-compile-cache\\1.0.18-electron-42.1.0" : "/smooth/data/smooth-user-data/node-compile-cache/1.0.18-electron-42.1.0");
    for (const key of ["NODE_OPTIONS", "NODE_DISABLE_COMPILE_CACHE", "MURAGE_DESKTOP_PARENT", "MURAGE_ENGINE_EXCLUSION_PATH"]) expect(plan.env[key]).toBeUndefined();
    expect(plan.stdio).toEqual(["ignore", "log", "log", ...(win ? ["ipc"] : [])]);
  });
  it("encodes a Windows import as a file URL without treating the drive as a URL scheme", () => {
    expect(importUrl("C:\\smooth #1%\\eld.mjs", "win32")).toBe("file:///C:/smooth%20%231%25/eld.mjs");
    expect(importUrl("\\\\host\\share\\smooth work\\eld.mjs", "win32")).toBe("file://host/share/smooth%20work/eld.mjs");
    expect(importUrl("/smooth #1%/eld.mjs", "linux")).toBe("file:///smooth%20%231%25/eld.mjs");
  });
  it("locates the server outside ASAR and the platform's actual executable", () => {
    expect(packagedLayout("C:\\Apps\\Murage", "win32")).toEqual({ appDir: "C:\\Apps\\Murage", resources: "C:\\Apps\\Murage\\resources", serverEntry: "C:\\Apps\\Murage\\resources\\server\\index.js", executable: "C:\\Apps\\Murage\\Murage.exe" });
    expect(packagedLayout("/Applications/Murage.app", "darwin")).toMatchObject({ executable: "/Applications/Murage.app/Contents/MacOS/Murage", serverEntry: "/Applications/Murage.app/Contents/Resources/server/index.js" });
    expect(packagedLayout("/opt/murage", "linux")).toMatchObject({ executable: "/opt/murage/murage", serverEntry: "/opt/murage/resources/server/index.js" });
  });
  it("maps every shipped resource and retains fixture flags without mutating its input", () => {
    const input = { ...env, MURAGE_BOOT_NONCE: "nonce", HOME: "/smooth/home", MURAGE_TERMS_ACCEPTED: "terms", MURAGE_ANNOUNCEMENTS_URL: "off", NODE_OPTIONS: "bad", NODE_COMPILE_CACHE: "/inherited/cache" };
    const plan = serverLaunch({ appDir: "/app", work: "/work", appVersion: "1.2.3", electronVersion: "42.1.0", env: input, platform: "linux", cpuProf: ["--cpu-prof"] });
    expect(plan.env).toMatchObject({ MURAGE_BOOT_NONCE: "nonce", HOME: "/smooth/home", MURAGE_TERMS_ACCEPTED: "terms", MURAGE_ANNOUNCEMENTS_URL: "off", MURAGE_USER_DATA: "/smooth/data/smooth-user-data", MURAGE_GEPA_MANIFEST_SHA256: "" });
    for (const [key, dir] of Object.entries({ MURAGE_STATIC_DIR: "ui", MURAGE_SKILLS_DIR: "skills", MURAGE_SKILL_LIBRARY: "skills-library", MURAGE_LIBRARY_DIR: "library", MURAGE_BOT_LIBRARY_DIR: "bot-library", MURAGE_FUIGO_DIR: "fuigo", MURAGE_GEPA_DIR: "gepa-worker", MURAGE_MEMORY_MODEL_DIR: "memory-model" })) expect(plan.env[key]).toBe(`/app/resources/${dir}`);
    expect(plan.args[0]).toBe("--cpu-prof"); expect(input.NODE_OPTIONS).toBe("bad");
    expect(plan.env.NODE_COMPILE_CACHE).toBe("/smooth/data/smooth-user-data/node-compile-cache/1.2.3-electron-42.1.0"); expect(input.NODE_COMPILE_CACHE).toBe("/inherited/cache");
  });
  it.each(["linux", "win32"])("preserves the default source launch, env, wrappers and startup on %s", async platform => {
    const work = platform === "win32" ? "C:\\smooth" : "/smooth";
    const input = { ...env, NODE_COMPILE_CACHE: "/source/cache" };
    const plan = serverLaunch({ work, env: input, platform, execPath: "node", cpuProf: ["--cpu-prof"] });
    expect(plan.mode).toBe("source"); expect(plan.env).toBe(input); expect(plan.executable).toBe("node");
    expect(plan.args).toEqual(["--cpu-prof", "--experimental-strip-types", "--import", platform === "win32" ? "file:///C:/smooth/scripts/scale/eld.mjs" : "/smooth/scripts/scale/eld.mjs", "server/index.ts"]);
    // Exercise the runner's actual wrapper construction without writing or executing a shell.
    // These exact source wrapper bodies are the fb1f97a1a contract: --version reaches the fake CLI.
    const runner = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const wrapperBody = runner.slice(runner.indexOf("function writeWrappers() {") + "function writeWrappers() {".length,
      runner.indexOf('  for (const [name, body] of'));
    const wrappers = new Function("APP", "CTL", "WORK", "DEBUG", "wrappers", "fakeVersionShell",
      wrapperBody + '\nreturn { grok: acp("grok"), fuigo: acp("fuigo"), claude };')(null, "/ctl", "/work", "", {},
      () => { throw Error("source must delegate --version to the fake CLI"); });
    for (const cli of ["grok", "fuigo"]) expect(wrappers[cli]).toBe([
      "#!/bin/sh",
      `# ${cli}: the fake ACP engine (server/testing/fake-acp-cli.ts); mode and knobs from /ctl at spawn`,
      `M=$(cat "/ctl/${cli}.mode" 2>/dev/null); export FAKE_ACP_MODE="\${M:-happy}" FAKE_ACP_MCP_LIST=all:ready FAKE_ACP_UNIQUE_SESSIONS=1`,
      '[ -f "/ctl/delegate-to" ] && export FAKE_ACP_DELEGATE_TO="$(cat "/ctl/delegate-to")"',
      '[ -f "/ctl/permission-command" ] && export FAKE_ACP_PERMISSION_COMMAND="$(cat "/ctl/permission-command")"',
      '[ -f "/ctl/gate-file" ] && export FAKE_ACP_GATE_FILE="$(cat "/ctl/gate-file")"',
      `export FAKE_ACP_TOOL_MS=45000 FAKE_ACP_PROMPT_DUMP="/ctl/prompts/${cli}-$$.json"`, "",
      'exec node --experimental-strip-types "/work/server/testing/fake-acp-cli.ts" "$@"', "",
    ].join("\n"));
    expect(wrappers.claude).toBe([
      "#!/bin/sh", "# claude: the fake claude CLI (server/testing/fake-claude-cli.ts)",
      'export FAKE_CLAUDE_MODE=happy FAKE_CLAUDE_DUMP_LOG="/ctl/prompts/claude.jsonl"', "",
      'exec node --experimental-strip-types "/work/server/testing/fake-claude-cli.ts" "$@"', "",
    ].join("\n"));
    // Execute only the extracted orchestration and health function with in-memory dependencies.
    // No import of the runner, process, network, filesystem mutation or real timer is involved.
    const health = runner.slice(runner.indexOf("async function waitHealthy("), runner.indexOf("// An unreadable log throws:"));
    const startup = runner.slice(runner.indexOf("startTelemetry();"), runner.indexOf("// S1 morning burst:"));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const boot of [true, false]) {
      const events = [], results = { scenarios: {}, instances: [] };
      const record = name => async () => { events.push(name); };
      const unexpected = async () => { throw Error("packaged preflight reached source startup"); };
      const deps = { APP: null, ENGINES: "fake", SCEN: new Set(boot ? ["boot"] : []), R: results,
        startTelemetry: () => events.push("telemetry"), telemetryReady: record("telemetry ready"),
        existsSync: () => true, readdirSync: () => [], DATA: "/smooth/data",
        startServer: () => { events.push("start"); return 0; }, stopServer: record("stop"),
        fetch: async url => { expect(url).toBe("fixture/api/health"); events.push("health"); return { ok: true, json: unexpected }; },
        URL_: "fixture", AbortSignal: { timeout: () => undefined }, performance: { now: () => 10 },
        sleep: async ms => { events.push(`sleep ${ms}`); }, stats: statsOf, sse: record("sse"),
        loadInstances: record("instances"), log: () => events.push("log"),
        botsList: async () => { events.push("roster"); return { bots: [], groups: [] }; }, save: () => events.push("save"),
        packagedBoots: unexpected, packagedStartupPreflight: unexpected, packagedTracePreflight: unexpected,
        proveFakeResolvers: unexpected, refusePackaged: unexpected, wrappers: {},
      };
      await new AsyncFunction(...Object.keys(deps), health + startup)(...Object.values(deps));
      expect(events).toEqual(["telemetry", "telemetry ready", "start", "health",
        ...(boot ? ["sleep 3000", "stop", "start", "health"] : []),
        "sse", "sleep 2000", "instances", "log", "roster", "save"]);
      if (boot) expect(results.scenarios.boot.samples).toEqual([10, 10]);
      else expect(results.bootMs).toBe(10);
    }
  });
  it("reads the shipped app.asar version rather than the checkout's version", () => {
    const root = mkdtempSync(join(tmpdir(), "smooth-asar-"));
    try {
      const payload = Buffer.from(JSON.stringify({ version: "1.0.18", murageGepaManifests: { "win32-x64": "pin" } }));
      const json = Buffer.from(JSON.stringify({ files: { "package.json": { size: payload.length, offset: "0" } } }));
      const size = 8 + Math.ceil(json.length / 4) * 4, prefix = Buffer.alloc(8), header = Buffer.alloc(size);
      prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(size, 4); header.writeUInt32LE(size - 4, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
      writeFileSync(join(root, "app.asar"), Buffer.concat([prefix, header, payload]));
      expect(readAppMetadata(root)).toEqual({ version: "1.0.18", murageGepaManifests: { "win32-x64": "pin" } });
    } finally { removeTempDirSync(root); }
  });
  it.each(["app/package.json", "app.asar.unpacked/package.json", "package.json"])("reads metadata at %s", relative => {
    const root = mkdtempSync(join(tmpdir(), "smooth-meta-"));
    try {
      const file = join(root, relative); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{"version":"9.8.7"}'); expect(readAppMetadata(root).version).toBe("9.8.7");
      writeFileSync(file, "not JSON"); expect(() => readAppMetadata(root)).toThrow();
    } finally { removeTempDirSync(root); }
  });
  it("refuses missing, truncated and oversized ASAR metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "smooth-meta-"));
    try {
      expect(() => readAppMetadata(root)).toThrow();
      writeFileSync(join(root, "app.asar"), Buffer.alloc(4));
      expect(() => readAppMetadata(root)).toThrow("short app.asar metadata read");
      const header = Buffer.alloc(8); header.writeUInt32LE(0xffffffff, 4);
      writeFileSync(join(root, "app.asar"), header);
      expect(() => readAppMetadata(root)).toThrow("invalid app.asar header size");
    } finally { removeTempDirSync(root); }
  });
});

describe("owned server shutdown (injected children, no processes)", () => {
  const fixture = platform => {
    const child = { pid: 42, exitCode: null, signalCode: null }, events = [];
    const options = { child, platform, send: message => events.push(["send", message]), kill: signal => events.push(["kill", signal]),
      spawnSync: (...args) => events.push(["spawnSync", ...args]), sleep: async ms => { events.push(["sleep", ms]); child.exitCode = 0; } };
    return { child, events, options };
  };
  it.each(["win32", "linux"])("returns true only for a clean exit on %s", async platform => {
    const f = fixture(platform);
    expect(await stopOwnedServer(f.options)).toBe(true);
    expect(f.events[0]).toEqual(platform === "win32" ? ["send", { type: "murage:close" }] : ["kill", "SIGTERM"]);
    expect(f.events).toHaveLength(2);
  });
  it.each([{ exitCode: 1, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }])("refuses nonzero or signalled termination: %j", async ended => {
    const f = fixture("linux");
    expect(await stopOwnedServer({ ...f.options, sleep: async () => Object.assign(f.child, ended) })).toBe(false);
  });
  it("kills and stays false when IPC send throws, even if the subsequent exit is zero", async () => {
    const f = fixture("win32");
    expect(await stopOwnedServer({ ...f.options, send: () => { throw Error("IPC gone"); } })).toBe(false);
    expect(f.events).toEqual([["kill", undefined], ["sleep", 100]]);
  });
  it.each(["win32", "linux"])("forces the exact tree shutdown after the cap on %s", async platform => {
    const f = fixture(platform); let sleeps = 0;
    expect(await stopOwnedServer({ ...f.options, sleep: async ms => { expect(ms).toBe(100); sleeps++; } })).toBe(false);
    expect(sleeps).toBe(300);
    expect(f.events.at(-1)).toEqual(platform === "win32"
      ? ["spawnSync", "taskkill", ["/PID", "42", "/T", "/F"], { stdio: "ignore", windowsHide: true }] : ["kill", "SIGKILL"]);
  });
});

describe("WARM measurements stay informational", () => {
  it("keeps warm stalls out of ALL.eld while preserving raw and cold stalls", () => {
    const text = `${SERVER_START_MARK}\n[eld] t=1000 p50=1 p99=2 max=400\n${SERVER_START_MARK}\n[eld] t=5000 p50=1 p99=2 max=9000\n[eld] t=6000 p50=1 p99=2 max=5000\n[eld] t=7000 p50=1 p99=2 max=10\n`;
    const result = measuredEld(text, 0, 7000, statsOf, [{ from: 2000, to: 5500 }]);
    expect(result).toMatchObject({ max: 400, secondsOver250: 1, raw: { max: 9000 } });
    expect(measuredEld(text, 0, 7000, statsOf).max).toBe(9000);
  });
  it("excludes warm CPU/RSS, the CPU interval straddling its end, and only the named sampling gap", () => {
    const samples = Array.from({ length: 11 }, (_, i) => ({ t: i * 1000, cores: i >= 3 && i <= 7 ? 99 : 1, rss: i >= 3 && i <= 6 ? 9999 : 100 }));
    const result = sampleWindow(samples, 0, 10000, statsOf, [{ from: 3000, to: 6000 }]);
    expect(result).toMatchObject({ cpu: { max: 1 }, rssMb: { max: 100 }, telemetry: { cpu: { ok: true }, rss: { ok: true } } });
    expect(sampleWindow(samples.filter(s => s.t <= 7000), 0, 12000, statsOf, [{ from: 3000, to: 6000 }]).telemetry.cpu.ok).toBe(false);
  });
  it("counts warm IO and its overlapping minute separately, retaining cold and later IO in ALL", () => {
    const cold = "[io-budget] cold\n", warm = "[io-budget] warm\n";
    const text = cold + warm + "[io-budget] mixed\n[eld] t=63001 p50=1 p99=2 max=10\n[io-budget] measured\n";
    expect(warmIoCounts(text, [{ from: 1000, to: 3000, logFrom: Buffer.byteLength(cold), logTo: Buffer.byteLength(cold + warm) }])).toEqual({ all: 2, warm: 2, overlap: 1 });
    expect(warmIoCounts(text)).toEqual({ all: 4, warm: 0, overlap: 0 });
  });
});

describe("packaged compile cache and cold/warm boots (fixtures only)", () => {
  it("opens the warm window before cold stop and closes it after warm health plus settle", async () => {
    let time = 0, bytes = 0, starts = 0;
    const results = { scenarios: {}, compileCache: { dir: "fixture" } }, boundaries = [];
    await packagedBoots({ results, now: () => time, logSize: () => bytes,
      startServer: () => { starts++; return time; },
      waitHealthy: async () => { time += 100; bytes += 10; return 100; },
      settle: async () => { time += 3000; bytes += 20; },
      stopServer: async () => { boundaries.push({ time, bytes, starts }); time += 50; bytes += 5; return true; },
      countFiles: () => 1, save: () => {}, note: () => {}, measure: window => { boundaries.push({ ...window }); return { ioBudget: 2 }; } });
    expect(boundaries).toEqual([{ time: 3100, bytes: 30, starts: 1 }, { from: 3100, logFrom: 30, to: 6250, logTo: 65 }]);
    expect(results.scenarios.bootWarm.measurements).toEqual({ ioBudget: 2 });
  });
  it.each([
    ["linux", "/smooth/user data", "/smooth/user data/node-compile-cache/1.2.3_build-electron-42.0.0_beta"],
    ["win32", "C:\\smooth\\user data", "C:\\smooth\\user data\\node-compile-cache\\1.2.3_build-electron-42.0.0_beta"],
  ])("mirrors the app's version sanitization on %s", (platform, userData, expected) => {
    expect(packagedCompileCacheDirectory({ platform, userData, appVersion: "1.2.3+build", electronVersion: "42.0.0+beta" })).toBe(expected);
    expect(packagedCompileCacheDirectory({ platform, userData: "relative", appVersion: "1" })).toBeNull();
    expect(packagedCompileCacheDirectory({ platform, userData, appVersion: "" })).toBeNull();
  });
  it.each(["linux", "darwin", "win32"])("reads Electron's own version beside the executable or in resources on %s", platform => {
    const layout = packagedLayout(platform === "win32" ? "C:\\Apps\\Murage" : "/apps/Murage.app", platform);
    const separator = platform === "win32" ? "\\" : "/";
    const nextToExe = layout.executable.slice(0, layout.executable.lastIndexOf(separator) + 1) + "version";
    const calls = [], noSpawn = (...args) => { calls.push(args); throw Error("must not spawn"); };
    for (const file of [nextToExe, `${layout.resources}${separator}version`, `${layout.appDir}${separator}version`]) {
      const reads = [];
      expect(readElectronVersion(layout, { platform, exists: f => f === file, readFile: f => { reads.push(f); return "v42.1.0\n"; }, spawnSync: noSpawn })).toEqual({ version: "42.1.0", source: "file", file });
      expect(reads).toEqual([file]);
    }
    expect(readElectronVersion(layout, { platform, exists: () => true, readFile: () => "42.1.0", spawnSync: noSpawn })).toEqual({ version: "42.1.0", source: "file", file: nextToExe });
    expect(() => readElectronVersion(layout, { platform, exists: () => true, readFile: () => "^42.0.0", spawnSync: noSpawn })).toThrow("invalid Electron version file");
    expect(calls).toEqual([]);
    expect(() => serverLaunch({ appDir: layout.appDir, appVersion: "1", work: layout.appDir, env: {}, platform })).toThrow("Electron version is required");
  });
  it.each(["42.1.0", "42.1.0-beta.1+build.2"])("probes the selected executable for %s with exact args, isolated env and timeout", version => {
    const layout = packagedLayout("C:\\Apps\\Murage signed", "win32"), calls = [];
    const parentOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=parent-only.cjs";
    try {
      const evidence = readElectronVersion(layout, { platform: "win32", exists: () => false,
        readFile: () => { throw Error("must not read"); },
        spawnSync: (...args) => { calls.push(args); return { status: 0, signal: null, stdout: ` \r\n${version}\r\n ` }; } });
      expect(evidence).toEqual({ version, source: "exe", executable: layout.executable });
      expect(calls).toEqual([[layout.executable, ["-p", "process.versions.electron"], {
        env: { ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000,
      }]]);
      expect(calls[0][2].env.NODE_OPTIONS).toBeUndefined();
      expect(process.env.NODE_OPTIONS).toBe("--require=parent-only.cjs");
    } finally {
      if (parentOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = parentOptions;
    }
  });
  it.each([
    ["timeout", () => ({ error: Object.assign(Error("spawn timed out"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "42.1.0" }), "timed out after 30000 ms (ETIMEDOUT)"],
    ["spawn error", () => ({ error: Object.assign(Error("not found"), { code: "ENOENT" }), status: null }), "ENOENT: not found"],
    ["spawn throws", () => { throw Error("spawn denied"); }, "spawn denied"],
    ["nonzero exit", () => ({ status: 7, stdout: "42.1.0" }), "exit status 7"],
    ["signal exit", () => ({ status: null, signal: "SIGTERM", stdout: "42.1.0" }), "terminated by signal SIGTERM"],
    ["empty stdout", () => ({ status: 0, stdout: " \r\n " }), 'non-semver stdout: ""'],
    ["non-semver stdout", () => ({ status: 0, stdout: "undefined\n" }), 'non-semver stdout: "undefined"'],
    ["extra stdout", () => ({ status: 0, stdout: "42.1.0\nextra" }), 'non-semver stdout: "42.1.0\\nextra"'],
  ])("records %s as a packaged refusal with INVALID results and a failing gate", async (_name, spawnResult, reason) => {
    const layout = packagedLayout("C:\\Apps\\Murage", "win32"), calls = [], exits = [];
    const results = initialResults({ mode: "packaged", label: "leg", runId: "fresh" });
    let saved = null, reported = null, stopped = false;
    try {
      readElectronVersion(layout, { platform: "win32", exists: () => false,
        spawnSync: (...args) => { calls.push(args); return spawnResult(); } });
    } catch (error) {
      await refusePackagedLeg(`invalid SMOOTH_APP_DIR (${error.message})`, { results,
        save: () => { saved = JSON.parse(JSON.stringify(results)); }, report: message => { reported = message; },
        stop: async () => { stopped = true; }, exit: code => exits.push(code) });
    }
    const refusal = `smooth.mjs refuses packaged leg: invalid SMOOTH_APP_DIR (packaged Electron version probe failed (${layout.executable}): ${reason})`;
    expect(calls).toHaveLength(1);
    expect(saved).toMatchObject({ status: "INVALID", preflight: { ok: false, refusal } });
    expect(reported).toBe(refusal); expect(stopped).toBe(true); expect(exits).toEqual([2]);
    const out = gate({ idle: saved, loaded: saved, budgets: { rows: [] } });
    expect(out.exit).toBe(1); expect(out.verdict.pass).toBe(false);
    expect(out.idle.invalid).toBe(refusal); expect(out.md).toContain(`INVALID: ${refusal}`);
  });
  it("records Electron version provenance in the runner's results", () => {
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    expect(source).toContain("electronVersion: electronMetadata.version, electronVersionSource: electronMetadata.source");
    expect(source).toContain("electronVersionFile: electronMetadata.file, electronVersionExecutable: electronMetadata.executable");
  });
  it("creates each leg's empty directory and refuses a populated directory without erasing it", () => {
    const root = mkdtempSync(join(tmpdir(), "smooth-cache-"));
    try {
      const dir = join(root, "leg-a", "user-data", "node-compile-cache", "1-electron-42");
      expect(prepareCompileCache(dir)).toEqual({ dir, emptyAtStart: true });
      expect(compileCacheFileCount(dir)).toBe(0);
      expect(prepareCompileCache(dir)).toEqual({ dir, emptyAtStart: true });
      mkdirSync(join(dir, "v8")); writeFileSync(join(dir, "v8", "code"), "cold cache");
      writeFileSync(join(dir, "another"), "cache");
      expect(compileCacheFileCount(dir)).toBe(2);
      expect(() => prepareCompileCache(dir)).toThrow("compile cache must start empty");
      expect(readFileSync(join(dir, "v8", "code"), "utf8")).toBe("cold cache");
      const other = join(root, "leg-b", "user-data", "node-compile-cache", "1-electron-42");
      expect(prepareCompileCache(other)).toEqual({ dir: other, emptyAtStart: true });
      expect(compileCacheFileCount(other)).toBe(0);
    } finally { removeTempDirSync(root); }
  });
  it.each([0, 3])("settles cold, stops cleanly, counts %i cache files, then measures warm separately", files => {
    const results = { scenarios: {}, compileCache: { dir: "/smooth/cache", emptyAtStart: true }, notes: [] };
    const calls = [], snapshots = []; let starts = 0;
    return packagedBoots({ results,
      startServer: () => { calls.push("start"); return ++starts; },
      waitHealthy: async t0 => { calls.push("healthy"); return t0 === 1 ? 1200 : 90_000; },
      settle: async () => { calls.push("settle"); }, stopServer: async () => { calls.push("stop"); return true; },
      countFiles: dir => { expect(dir).toBe("/smooth/cache"); calls.push("count"); return files; },
      save: () => { snapshots.push(JSON.parse(JSON.stringify(results))); }, note: s => results.notes.push(s),
    }).then(() => {
      expect(calls).toEqual(["start", "healthy", "settle", "stop", "count", "start", "healthy", "settle"]);
      expect(results.scenarios.boot).toEqual({ healthy: { n: 1, p50: 1200, p90: 1200, max: 1200 }, samples: [1200] });
      expect(results.scenarios.bootWarm).toMatchObject({ healthy: { n: 1, p50: 90_000, p90: 90_000, max: 90_000 }, samples: [90_000] });
      expect(results.excludedWindows).toEqual([{ ...results.scenarios.bootWarm.window, reason: "S0 WARM info only" }]);
      expect(results.compileCache).toEqual({ dir: "/smooth/cache", emptyAtStart: true, filesAfterCold: files });
      expect(snapshots[0].scenarios.bootWarm).toBeUndefined();
      expect(snapshots[1].compileCache.filesAfterCold).toBe(files);
      expect(results.notes).toEqual(files ? [] : ["cache did not fill; S0 WARM is not a warm boot"]);
    });
  });
  it("does not claim a warm boot after a forced or failed cold shutdown", async () => {
    let starts = 0;
    const results = { scenarios: {}, compileCache: { dir: "/smooth/cache", emptyAtStart: true } };
    await expect(packagedBoots({ results, startServer: () => ++starts, waitHealthy: async () => 100,
      settle: async () => {}, stopServer: async () => false, save: () => {}, note: () => {},
      countFiles: () => { throw Error("must not count before clean stop"); },
    })).rejects.toThrow("cold server did not stop cleanly");
    expect(starts).toBe(1); expect(results.scenarios.bootWarm).toBeUndefined();
  });
});

describe("S3 worker slice wall trace", () => {
  it("uses wall ms including commit and nearest-rank p99, with row work beside it", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[turn-trace] phase=memory.indexSlice ms=${i + 1} rowMs=${(i + 1) / 10} rows=4`);
    lines.push("[turn-trace] phase=memory.other ms=99999 rowMs=99999 rows=1");
    expect(workerSliceWall(lines.join("\n"))).toEqual({ count: 100, max: 100, p99: 99, rowMsMax: 10 });
    expect(workerSliceWall("[turn-trace] phase=memory.indexSlice ms=12.5 rowMs=0 rows=0")).toEqual({ count: 1, max: 12.5, p99: 12.5, rowMsMax: 0 });
  });
  it("leaves missing or incomplete slice evidence unmeasured", () => {
    for (const text of ["", "[turn-trace] phase=startup.module.loaded ms=8", "[turn-trace] phase=memory.indexSlice ms=12", "[turn-trace] phase=memory.indexSlice ms=NaN rowMs=1 rows=2"]) {
      expect(workerSliceWall(text)).toEqual({ count: 0, max: null, p99: null, rowMsMax: null });
    }
  });
});

describe("packaged read-only observations (fake lease records, no app)", () => {
  const owner = { version: 1, pid: 42, host: "fixture", token: "11111111-1111-4111-8111-111111111111", createdAt: 1 }; // secret-scan: fixture
  it.each([
    ["linux", "/smooth/Data", "/smooth/Data", "/smooth/"],
    ["darwin", "/smooth/Cafe\u0301", "/smooth/café", "/smooth/"],
    ["win32", "C:\\Smooth\\Data", "c:\\smooth\\data", "c:\\smooth\\"],
    ["win32", "\\\\?\\C:\\Smooth\\Data", "c:\\smooth\\data", "c:\\smooth\\"],
    ["win32", "\\\\?\\UNC\\Host\\Share\\Data", "\\\\host\\share\\data", "\\\\host\\share\\"],
  ])("reads the server's canonical sibling lease on %s (%s)", (platform, resolved, identity, parent) => {
    const file = `${parent}.murage-data-owner-${createHash("sha256").update(identity).digest("hex")}.lease`, reads = [];
    const options = { platform, realpath: path => { expect(path).toBe("alias"); return resolved; },
      readFile: (path, encoding) => { reads.push([path, encoding]); if (path !== file) throw Error("missing lease"); return JSON.stringify(owner); } };
    expect(observedDataDir("alias", 42, options)).toBe(resolved);
    expect(reads).toEqual([[file, "utf8"]]);
    expect(observedDataDir("alias", 43, options)).toBeNull();
  });
  it("refuses absent, unreadable, malformed and other-process leases without using the env as evidence", () => {
    const options = { platform: "linux", realpath: p => p };
    for (const contents of ["bad JSON", "null", "{}", JSON.stringify({ ...owner, pid: 41 }), JSON.stringify({ ...owner, version: 2 }), JSON.stringify({ ...owner, token: "bad" })]) {
      expect(observedDataDir("/smooth/data", 42, { ...options, readFile: () => contents })).toBeNull();
    }
    for (const code of ["ENOENT", "EACCES"]) expect(observedDataDir("/smooth/data", 42, { ...options, readFile: () => { throw Object.assign(Error(code), { code }); } })).toBeNull();
    expect(observedDataDir("/smooth/data", 42, { ...options, realpath: () => { throw Error("missing dir"); }, readFile: () => JSON.stringify(owner) })).toBeNull();
    expect(observedDataDir("/smooth/data", null, { ...options, readFile: () => JSON.stringify(owner) })).toBeNull();
    const otherFile = `/other/.murage-data-owner-${createHash("sha256").update("/other/data").digest("hex")}.lease`;
    expect(observedDataDir("/smooth/data", 42, { ...options, readFile: path => { if (path === otherFile) return JSON.stringify(owner); throw Error("missing lease"); } })).toBeNull();
  });
  it("ignores malformed and other-process native witnesses", () => {
    expect(observedNativeFiles('[smooth-native] broken\n[smooth-native] {"pid":1,"files":["old"]}\n[smooth-native] {"pid":2,"files":[null]}\n[smooth-native] {"pid":2,"files":["new"]}', 2)).toEqual(["new"]);
    expect(observedNativeFiles("", 2)).toEqual([]);
  });
});

describe("packaged preflight refuses unproved legs", () => {
  const good = { expectedData: "C:\\smooth\\data", observedData: "c:/smooth/data", platform: "win32", pid: 42, expectedPid: 42,
    authStatus: 200, secretAccepted: true, log: "[eld] t=1 p99=0\n[turn-trace] id=abcd phase=received at=0ms", requireTrace: true };
  it("requires the server's data-dir lease, desktop auth, ELD and an actual turn trace", () => {
    expect(packagedPreflightRefusal(good)).toBeNull();
    for (const [patch, message] of [
      [{ pid: 99 }, "health belongs to another process (PID mismatch)"],
      [{ observedData: null }, "data-dir override unproven: no data-dir owner lease matching the packaged server PID"],
      [{ observedData: "C:\\other" }, "data-dir override ignored: opened C:\\other; expected C:\\smooth\\data"],
      [{ authStatus: 403 }, "desktop secret rejected"],
      [{ secretAccepted: false }, "desktop secret rejected"],
      [{ log: "" }, "ELD --import preload produced no [eld] lines"],
      [{ log: "[eld] t=1 p99=0" }, "MURAGE_TURN_TRACE=1 produced no [turn-trace] lines for the preflight turn"],
      [{ traceLog: "" }, "MURAGE_TURN_TRACE=1 produced no [turn-trace] lines for the preflight turn"],
    ]) expect(packagedPreflightRefusal({ ...good, ...patch })).toContain(`smooth.mjs refuses packaged leg: ${message}`);
    expect(packagedPreflightRefusal({ ...good, platform: "linux", expectedData: "/smooth/Data", observedData: "/smooth/data" })).toContain("data-dir override ignored");
  });
  it("cannot judge an incomplete packaged preflight green even when every budget passes", () => {
    expect(judge({ rows: [] }, { mode: "packaged", preflight: { ok: false, refusal: "data-dir override unproven" } })).toMatchObject({ pass: false, invalid: "data-dir override unproven" });
  });
  it("checks the owned PID before using the secret and proves the desktop-only read", async () => {
    const calls = [], log = '[eld] t=1 p99=0\n[smooth-native] {"pid":42,"files":["/app/engine-exclusion.node"]}';
    const options = { health: { pid: 42 }, expectedPid: 42, expectedData: "/smooth/data", secret: "fixture", platform: "linux", readLog: () => log,
      readDataDir: () => "/smooth/data",
      waitFor: async check => { expect(check()).toBe(true); },
      call: async (method, path) => { calls.push([method, path]); return { status: 200, json: { secret: "fixture" } }; } };
    await expect(packagedStartupPreflight({ ...options, health: { pid: 99 } })).rejects.toThrow("PID mismatch");
    expect(calls).toEqual([]);
    const proof = await packagedStartupPreflight({ ...options, expectedNative: "/app/engine-exclusion.node" });
    expect(calls).toEqual([["GET", "/api/desktop-secret"], ["GET", "/api/storage"]]);
    expect(proof).toMatchObject({ startupOk: true, secretAccepted: true, authStatus: 200, observedData: "/smooth/data" });
    expect(JSON.stringify(proof)).not.toContain('"fixture"');
    await expect(packagedStartupPreflight({ ...options, readDataDir: () => null })).rejects.toThrow("no data-dir owner lease matching the packaged server PID");
    await expect(packagedStartupPreflight({ ...options, readDataDir: () => "/other/data" })).rejects.toThrow("data-dir override ignored");
    await expect(packagedStartupPreflight({ ...options, expectedNative: "/wrong.node" })).rejects.toThrow("hashed packaged engine-exclusion.node");
    await expect(packagedStartupPreflight({ ...options, call: async () => ({ status: 404, json: {} }) })).rejects.toThrow("desktop secret rejected");
    await expect(packagedStartupPreflight({ ...options, call: async (_, path) => ({ status: path === "/api/storage" ? 403 : 200, json: { secret: "fixture" } }) })).rejects.toThrow("desktop secret rejected");
  });
  it("requires a fresh probe trace and stops/deletes that exact bot before accepting the leg", async () => {
    const calls = [];
    const options = { evidence: good, platform: "win32", makeBot: async (name, role) => { expect([name, role]).toEqual(["Smooth preflight", "fast"]); return { id: "probe", threadId: "thread" }; },
      logSize: () => 100, logFrom: mark => { expect(mark).toBe(100); return "[turn-trace] id=1234 phase=received at=0ms"; }, readStartupLog: () => good.log,
      waitFor: async check => { expect(check()).toBe(true); },
      call: async (...args) => { calls.push(args); return { status: 200 }; },
      settleBot: async (...args) => { calls.push(["settle", ...args]); return { settled: true }; } };
    expect(await packagedTracePreflight(options)).toMatchObject({ ok: true, turnTrace: true });
    expect(calls).toEqual([
      ["POST", "/api/bots/probe/messages", { threadId: "thread", text: "Reply with the single word ready." }, 30_000],
      ["settle", "probe", "thread", 30_000], ["DELETE", "/api/bots/probe"],
    ]);
    await expect(packagedTracePreflight({ ...options, logFrom: () => "", waitFor: async check => { expect(check()).toBe(false); } })).rejects.toThrow("produced no [turn-trace] lines");
    await expect(packagedTracePreflight({ ...options, call: async () => ({ status: 403 }) })).rejects.toThrow("preflight turn rejected (403)");
    await expect(packagedTracePreflight({ ...options, settleBot: async () => ({ settled: false }) })).rejects.toThrow("preflight turn did not stop");
    await expect(packagedTracePreflight({ ...options, call: async method => ({ status: method === "DELETE" ? 500 : 200 }) })).rejects.toThrow("preflight bot cleanup rejected (500)");
  });
  it("persists a failed preflight and exits 2 even if stopping the owned fixture fails", async () => {
    const results = { preflight: { ok: true, startupOk: true } }, events = [];
    const options = { results, save: () => events.push(["save", results.preflight.ok]), report: message => events.push(["report", message]), stop: async () => events.push(["stop"]), exit: code => events.push(["exit", code]) };
    await refusePackagedLeg("desktop secret rejected", options);
    expect(results.preflight).toMatchObject({ ok: false, startupOk: true, refusal: "smooth.mjs refuses packaged leg: desktop secret rejected" });
    expect(events).toEqual([["save", false], ["report", results.preflight.refusal], ["stop"], ["exit", 2]]);
    events.length = 0;
    await expect(refusePackagedLeg(results.preflight.refusal, { ...options, stop: async () => { events.push(["stop failed"]); throw Error("stop failed"); } })).rejects.toThrow("stop failed");
    expect(events).toEqual([["save", false], ["report", results.preflight.refusal], ["stop failed"], ["exit", 2]]);
    expect(results.preflight.refusal).toBe("smooth.mjs refuses packaged leg: desktop secret rejected");
  });
});

describe("rig v5.8 cleanup persistence (in-memory runner orchestration)", () => {
  const cleanup = async (failure = null) => {
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf('R.phase = "cleanup";'), source.indexOf('log("DONE",'));
    const results = initialResults({ rigVersion: "5.8", mode: "source", label: "fixture", runId: "fixture",
      all: {}, notes: [], created: { groups: ["room"], routines: ["routine"], bots: ["bot"] } });
    const snapshots = [structuredClone(results)], events = [];
    const operation = async step => {
      events.push(step);
      if (step === failure?.step) {
        events.push("failure");
        if (failure.throws) throw Error("transport lost");
        return step === "stop" ? false : { status: 503 };
      }
      return step === "stop" ? true : { status: 200 };
    };
    const deps = { R: results, recordCleanupFailure, keptText: value => String(value), redact: null,
      roomBudget, Date, roomCall: () => operation("room DELETE"),
      call: (method, path) => operation(path.includes("routines") ? "routine DELETE" : method === "POST" ? "bot interrupt" : "bot DELETE"),
      stopServer: () => operation("stop"),
      save: () => { const snapshot = structuredClone(results); snapshots.push(snapshot); events.push(snapshot); } };
    // The real ledger, exactly as smooth.mjs builds it; finish() runs the SSE abort and the drain.
    deps.evidence = evidenceLedger({ results, writeResults: () => deps.save(), setExitCode: () => {} });
    deps.shutdownSse = async () => { events.push("SSE abort"); return true; };
    deps.drainFailureEnrichments = async () => {};
    deps.exitCode = 0;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(deps), `let sampling = true;\n${body}`)(...Object.values(deps));
    return { results, snapshots, events };
  };
  it("saves running, cleanup and every successful outcome before finished", async () => {
    const { results, snapshots, events } = await cleanup();
    expect(snapshots[0].phase).toBe("running");
    expect(snapshots.slice(1, -1).every(row => row.phase === "cleanup")).toBe(true);
    expect(snapshots.at(-2).cleanup).toHaveLength(6);
    expect(results).toMatchObject({ phase: "finished", status: "COMPLETE" });
    expect(results.cleanup.every(row => row.ok)).toBe(true);
    expect(events.filter(row => typeof row === "string")).toEqual(["room DELETE", "routine DELETE", "bot interrupt", "bot DELETE", "stop", "SSE abort"]);
    expect(judge({ rows: [] }, snapshots[1])).toMatchObject({ pass: false, invalid: expect.stringContaining("cleanup") });
    expect(judge({ rows: [] }, results).pass).toBe(true);
  });
  it.each([
    { step: "room DELETE" }, { step: "room DELETE", throws: true },
    { step: "routine DELETE" }, { step: "routine DELETE", throws: true },
    { step: "bot interrupt" }, { step: "bot DELETE" }, { step: "stop" }, { step: "stop", throws: true },
  ])("saves cleanup failure immediately and still attempts later steps: %j", async failure => {
    const { results, events } = await cleanup(failure);
    const saved = events[events.indexOf("failure") + 1];
    expect(saved).toMatchObject({ phase: "cleanup", legFailed: true, status: "FAIL", legFailureReason: expect.stringContaining(failure.throws ? "transport lost" : "rejected") });
    expect(judge({ rows: [] }, saved)).toMatchObject({ pass: false, invalid: saved.legFailureReason });
    expect(events.filter(row => typeof row === "string" && row !== "failure")).toEqual(["room DELETE", "routine DELETE", "bot interrupt", "bot DELETE", "stop", "SSE abort"]);
    expect(results).toMatchObject({ phase: "finished", legFailed: true, status: "FAIL" });
    expect(results.cleanup).toHaveLength(6);
    expect(judge({ rows: [] }, results)).toMatchObject({ pass: false, invalid: saved.legFailureReason });
  });
});

describe("RIG-V58-ROOM-DRAIN rev 3 (fake clock and fetch only)", () => {
  const card = (id = "late", extra = {}) => ({ kind: "options", at: 100,
    card: { requestId: id, tool: "Read", cardClass: { reason: "no-grant" }, ...extra } });
  const fixture = (frames = [{}], overrides = {}) => {
    const f = { time: 0, poll: 0, interrupted: 0, kept: [], answers: [], calls: [], sleeps: [], state: { incomplete: false, notes: [] } };
    const check = (name, budget) => {
      expect(budget.timeout).toBeGreaterThan(0);
      expect(budget.timeout).toBeLessThanOrEqual(budget.deadline - f.time);
      f.calls.push({ name, at: f.time, deadline: budget.deadline, timeout: budget.timeout });
    };
    f.options = { state: f.state, known: new Set(), raised: new Set(), now: () => f.time,
      sleep: async ms => { f.sleeps.push(ms); f.time += ms; }, deadline: 15_000, round: 0,
      fetchRoom: async budget => {
        check("room", budget); f.poll++;
        f.frame = typeof frames === "function" ? frames(f) : frames[Math.min(f.poll - 1, frames.length - 1)];
        if (f.frame.roomError) throw Error(f.frame.roomError);
        return Object.hasOwn(f.frame, "room") ? f.frame.room : { working: f.frame.working ?? false };
      },
      fetchMembers: async budget => { check("members", budget); return Object.hasOwn(f.frame, "members") ? f.frame.members : [{ busy: f.frame.busy ?? false }]; },
      fetchOpen: async budget => {
        check("open", budget);
        if (f.frame.openError) throw Error(f.frame.openError);
        return { rows: f.frame.open ?? [], complete: !f.frame.partial };
      },
      fetchMessages: async budget => {
        check("messages", budget);
        if (f.frame.messageError) throw Error(f.frame.messageError);
        f.time += f.frame.readMs ?? 0;
        return { rows: f.frame.messages ?? [], complete: !f.frame.partialMessages };
      },
      keepCard: row => f.kept.push(row),
      respond: async (answer, budget) => { check("respond", budget); f.answers.push(answer); return { status: 200 }; },
      interrupt: async budget => { check("interrupt", budget); f.interrupted++; return { status: 200 }; },
      ...overrides,
    };
    f.run = patch => drainRoomCards({ ...f.options, ...patch });
    return f;
  };
  const later = ["trust", "autoEveryday", "longThread", "deletion", "engineSwitch", "stop", "idle"];
  // Exercise the actual scenario wrapper with in-memory dependencies, never import the runner.
  const wrap = async (f, runRoom = async () => ({ ...f.state })) => {
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function scenario(name, fn)"), source.indexOf("// ================================================================== run"));
    const results = { scenarios: { room: f.state }, notes: [] }, events = [], snapshots = [];
    f.onControlFailure = error => {
      results.controlRestoreFailed = true; recordCleanupFailure(results, error.message);
      snapshots.push(structuredClone(results));
    };
    const deps = { R: results, SCEN: new Set(["room", ...later]), ROOM_LATER: later, roomState: f.state, roomCleanup: f.options,
      Date: { now: () => f.time }, sleep: f.options.sleep, enforceRoomSettlement,
      stopServer: async () => events.push("stop server"), settleBot: async () => { throw Error("unexpected bot stop"); },
      keptText: text => String(text), redact: null, log: () => {}, note: text => results.notes.push(text), save: () => {},
      logSize: () => 0, logFrom: () => "", countSignatures: () => ({}), eldWindow: () => ({}), workerSliceWall: () => ({}), window_: () => ({}),
      runRoom, later, runLater: name => { events.push(name); return {}; } };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(deps), `let currentScenario, scenarioBots, scenarioFrom;\n${body}\nawait scenario("room", runRoom); for (const name of later) await scenario(name, () => runLater(name));`)(...Object.values(deps));
    return { results, events, snapshots };
  };
  const expectBlocked = async f => {
    const { results, events } = await wrap(f);
    expect(events).toEqual(["stop server"]);
    expect(results).toMatchObject({ legFailed: true, roomNeverSettled: true });
    for (const name of later) expect(results.scenarios[name]).toEqual({ invalid: "room never settled" });
    const rows = later.map(scenario => ({ id: scenario, scenario, path: `scenarios.${scenario}.cards`, op: "==", value: 0 }));
    const judged = judge({ rows }, results);
    expect(judged.pass).toBe(false);
    expect(judged.rows.every(row => row.invalid === "room never settled" && !row.pass)).toBe(true);
    expect(table(judged, "fixture")).toContain("INVALID (room never settled)");
  };
  const proofFixture = ({ stuck = false, responseStatus = 200, behavior = "allow", adapter } = {}) => {
    const f = fixture();
    f.state.done = true;
    const controls = new Map([["grok.mode", "happy"], ["permission-command", "old command"]]);
    const control = adapter ?? { ctl: (name, value) => controls.set(name, value), readControl: name => controls.get(name) ?? null };
    const levels = [], sends = [], answered = new Set();
    const members = ["a", "b", "c"].map(id => ({ id, autoApprove: false }));
    const cards = members.map(member => card(`request-${member.id}`, behavior === "deny" ? { cardClass: undefined } : {}));
    let working = false, phase = "";
    Object.assign(f.options, {
      fetchRoom: async () => ({ working }),
      fetchMembers: async () => members.map(() => ({ busy: working })),
      fetchOpen: async () => ({ rows: phase === "permission" ? cards.filter(row => !answered.has(row.card.requestId)) : [], complete: true }),
      fetchMessages: async () => ({ rows: phase ? cards.map(row => ({ ...row, card: { ...row.card, answered: answered.has(row.card.requestId) } })) : [], complete: true }),
      respond: async (answer, budget) => {
        f.answers.push(answer); expect(budget.deadline).toBeGreaterThan(f.time);
        if (responseStatus >= 200 && responseStatus < 300) answered.add(answer.requestId);
        if (answered.size === members.length) working = false;
        return { status: responseStatus };
      },
      interrupt: async () => { f.interrupted++; if (!stuck) working = false; return { status: 202 }; },
    });
    f.prove = engines => runRoomRouteProof({ engines: engines ?? "fake", options: f.options, members,
      ...control, onControlFailure: error => f.onControlFailure?.(error),
      setLevel: async (id, level) => { levels.push([id, level]); return { status: 200 }; },
      send: async (text, budget) => {
        expect(budget.deadline).toBeGreaterThan(f.time);
        phase = control.readControl("grok.mode"); sends.push(phase); working = true;
        if (phase === "permission") expect(control.readControl("permission-command")).toBe(DEV_COMMANDS[0]);
        return { status: 200 };
      },
    });
    return Object.assign(f, { controls, levels, sends });
  };
  it("room proof: real engines refuse INVALID before any proof effects", async () => {
    const f = proofFixture();
    const reason = roomProofRefusal(true, "real");
    expect(reason).toContain("requires fake engines");
    await expect(f.prove("real")).rejects.toThrow(reason);
    expect(f.sends).toEqual([]); expect(f.levels).toEqual([]);
    const results = initialResults({ mode: "source", label: "proof", runId: "proof" });
    let saved;
    await refusePackagedLeg(reason, { results, save: () => { saved = structuredClone(results); }, report: () => {}, stop: async () => {}, exit: () => {} });
    expect(saved).toMatchObject({ status: "INVALID", preflight: { ok: false, refusal: expect.stringContaining(reason) } });
    expect(roomProofRefusal(false, "real")).toBeNull();
  });
  it("room proof: one allowed card per member, working interrupt, DONE and control restoration", async () => {
    const f = proofFixture();
    const proof = await f.prove();
    expect(proof).toMatchObject({ ok: true, card: { raised: 3, answered: 3, respondStatus: 200, requestId8: "request-" },
      interrupt: { sawWorking: true, interruptStatus: 202, settled: true, settledMs: 1000 } });
    expect(f.answers.map(answer => answer.behavior)).toEqual(["allow", "allow", "allow"]);
    expect(f.sends).toEqual(["permission", "slow-tool"]); expect(f.interrupted).toBe(1);
    expect(f.state.done).toBe(true);
    expect([...f.controls]).toEqual([["grok.mode", "happy"], ["permission-command", "old command"]]);
    expect(f.levels).toEqual([...["a", "b", "c"].map(id => [id, "ask"]), ...["a", "b", "c"].map(id => [id, "ask"])]);
  });
  it.each(["permission", "slow-tool"])("room proof: production control adapter EACCES restoring %s saves failure and blocks later scenarios", async mode => {
    const root = mkdtempSync(join(tmpdir(), "smooth-controls-"));
    try {
      const adapter = controlAdapter({ pathOf: name => join(root, name), readFileSync, writeFileSync,
        rmSync: path => {
          if (path === join(root, "grok.mode") && readFileSync(path, "utf8") === mode) throw Object.assign(Error("denied"), { code: "EACCES" });
          rmSync(path);
        } });
      const f = proofFixture({ adapter });
      const { results, events, snapshots } = await wrap(f, async () => { await f.prove(); return f.state; });
      expect(snapshots[0]).toMatchObject({ legFailed: true, controlRestoreFailed: true, legFailureReason: expect.stringContaining("EACCES") });
      expect(results.scenarios.room.proof.ok).toBe(false);
      expect(results).toMatchObject({ legFailed: true, roomNeverSettled: true });
      expect(events).toEqual(["stop server"]);
      for (const name of later) expect(results.scenarios[name].invalid).toContain("control restoration failed");
      expect(adapter.readControl("grok.mode")).toBe(mode);
      expect(adapter.readControl("permission-command")).toBeNull(); // every restore was attempted
    } finally { removeTempDirSync(root); }
  });
  it("production control adapter ignores only ENOENT and restoration detects a silent no-op removal", () => {
    const root = mkdtempSync(join(tmpdir(), "smooth-controls-"));
    try {
      const io = { pathOf: name => join(root, name), readFileSync, writeFileSync, rmSync };
      const adapter = controlAdapter(io);
      expect(() => adapter.ctl("absent", null)).not.toThrow(); expect(adapter.readControl("absent")).toBeNull();
      adapter.ctl("grok.mode", "slow-tool");
      const noOp = controlAdapter({ ...io, rmSync: () => {} }), failures = [];
      expect(() => restoreControls({ ...noOp, values: { "grok.mode": null }, onFailure: error => failures.push(error.message) })).toThrow("read-back mismatch");
      expect(failures).toHaveLength(1);
      const denied = controlAdapter({ ...io, rmSync: () => { throw Object.assign(Error("denied"), { code: "EACCES" }); } });
      expect(() => denied.ctl("grok.mode", null)).toThrow("denied");
    } finally { removeTempDirSync(root); }
  });
  it("room proof: a denied card is never response proof even with HTTP 200", async () => {
    const f = proofFixture({ behavior: "deny" });
    expect(await f.prove()).toMatchObject({ ok: false, card: { raised: 3, answered: 0, respondStatus: null } });
    expect(f.answers.every(answer => answer.behavior === "deny")).toBe(true);
  });
  it("room proof: failed respond restores controls and cannot pass", async () => {
    const f = proofFixture({ responseStatus: 503 });
    expect(await f.prove()).toMatchObject({ ok: false, card: { answered: 0, respondStatus: 503 } });
    expect(f.controls.get("grok.mode")).toBe("happy");
    expect(f.controls.get("permission-command")).toBe("old command");
    expect(f.levels).toHaveLength(6);
  });
  it("room proof: non-DONE measured rooms refuse before sending", async () => {
    const f = proofFixture(); f.state.done = false;
    await expect(f.prove()).rejects.toThrow("requires measured room DONE");
    expect(f.sends).toEqual([]); expect(f.levels).toEqual([]);
  });
  it("room proof: interrupt transport failure restores mode and gates without retrying POST", async () => {
    const f = proofFixture();
    f.options.interrupt = async () => { f.interrupted++; throw Error("fixture transport failure"); };
    const { results, events } = await wrap(f, async () => { await f.prove(); return f.state; });
    expect(results.scenarios.room.proof).toMatchObject({ ok: false, interrupt: { sawWorking: true, interruptStatus: null, settled: false } });
    expect(f.controls.get("grok.mode")).toBe("happy");
    expect(f.interrupted).toBe(1); expect(events).toEqual(["stop server"]);
    expect(results.roomNeverSettled).toBe(true);
  });
  it("room proof: a proof ending working gates later scenarios and server cleanup with one interrupt", async () => {
    const f = proofFixture({ stuck: true });
    const { results, events } = await wrap(f, async () => { await f.prove(); return f.state; });
    expect(results.scenarios.room.proof).toMatchObject({ ok: false, interrupt: { sawWorking: true, interruptStatus: 202, settled: false } });
    expect(results).toMatchObject({ legFailed: true, roomNeverSettled: true });
    expect(events).toEqual(["stop server"]); expect(f.interrupted).toBe(1);
    for (const name of later) expect(results.scenarios[name]).toEqual({ invalid: "room never settled" });
    expect(f.controls.get("grok.mode")).toBe("happy");
    const runner = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    expect(runner).toContain("if (!R.roomNeverSettled && !R.controlRestoreFailed)");
  });
  it("room proof: wrapper preserves the measured window before proof work", async () => {
    const f = proofFixture();
    const { results } = await wrap(f, async ({ endMeasurement }) => {
      f.time = 4000; endMeasurement(); await f.prove(); return f.state;
    });
    expect(f.time).toBeGreaterThan(4000);
    expect(results.scenarios.room.window).toEqual({ from: 0, to: 4000 });
    expect(results.scenarios.room.proof.ok).toBe(true);
  });
  it("drain 7: idle members with working=true then a late card is kept, answered and counted once", async () => {
    const row = card();
    const f = fixture([{ working: true }, { working: true, open: [row] }, { messages: [row] }]);
    expect(await f.run()).toMatchObject({ status: "DONE", timeout: false, cards: [{ requestId: "late", resolvedMs: 2000 }] });
    expect(f.poll).toBe(5); expect(f.sleeps).toEqual([1000, 1000, 1000]);
    expect(f.kept).toContainEqual(row); expect([...f.options.raised]).toEqual(["late"]);
    expect(f.answers).toEqual([{ requestId: "late", behavior: "allow" }]);
  });
  it("drain 7: an approval holding working=true is serviced before DONE", async () => {
    const f = fixture(f => ({ working: f.answers.length === 0, open: f.answers.length ? [] : [card()] }));
    expect((await f.run()).status).toBe("DONE"); expect(f.answers).toHaveLength(1); expect(f.interrupted).toBe(0);
  });
  it("drain 7: working=false with a busy member is not DONE", async () => {
    const f = fixture([{ busy: true }, { busy: true }, {}]);
    expect((await f.run()).status).toBe("DONE"); expect(f.poll).toBe(5); expect(f.time).toBe(3000);
  });
  it("drain 7: done-eligible then fetch error then done-eligible resets the count", async () => {
    const f = fixture([{}, { roomError: "fetch failed" }, {}]);
    expect((await f.run()).status).toBe("DONE"); expect(f.poll).toBe(5); expect(f.time).toBe(3000);
  });
  it("drain 7: three failed polls expire now and send exactly one interrupt", async () => {
    const f = fixture(f => f.interrupted ? {} : { roomError: "offline" });
    expect(await f.run()).toMatchObject({ status: "TIMEOUT", timeout: true, settlement: { settled: true, startedAt: 2000 } });
    expect(f.interrupted).toBe(1); expect(f.state.cardCloseTimeout).toBe(true);
    expect(f.state.notes[0]).toContain("three consecutive failed polls");
    expect(f.state.notes[0]).toContain("last poll");
  });
  it.each([{ room: undefined }, { room: { working: "false" } }, { members: [undefined] }])("drain 7: missing group/member or non-boolean working is a scenario error: %j", async frame => {
    const f = fixture(f => f.interrupted ? {} : frame);
    expect(await f.run()).toMatchObject({ status: "ERROR", timeout: false });
    expect(f.state.incomplete).toBe(true); expect(f.state.error).toMatch(/missing/); expect(f.interrupted).toBe(1);
  });
  it("drain 7: an empty partial poll between eligible polls resets the streak", async () => {
    const f = fixture([{}, { partial: true, open: [] }, {}, {}]);
    expect((await f.run()).status).toBe("DONE");
    // After the partial poll at 1 s, complete polls at 2 s AND 3 s precede final collection.
    expect(f.calls.filter(call => call.name === "room").map(call => call.at)).toEqual([0, 1000, 2000, 3000, 3000]);
    expect(f.poll).toBe(5); expect(f.time).toBe(3000); expect(f.answers).toHaveLength(0);
  });
  it("drain 7: every poll partial with empty open cards reaches TIMEOUT, never DONE", async () => {
    const f = fixture([{ partial: true, open: [] }]);
    expect(await f.run({ deadline: 1500 })).toMatchObject({ status: "TIMEOUT", timeout: true, settlement: { settled: false } });
    expect(f.calls.filter(call => call.name === "room" && call.deadline === 1500).map(call => call.at)).toEqual([0, 1000]);
    expect(f.state.settlement.startedAt).toBe(1500);
    expect(f.state.cardCloseTimeout).toBe(true); expect(f.answers).toHaveLength(0);
  });
  it("drain 7: a successful poll crossing the deadline is TIMEOUT, never DONE", async () => {
    const f = fixture(f => f.interrupted ? {} : f.poll === 1 ? {} : { readMs: 1001 });
    expect(await f.run({ deadline: 2000 })).toMatchObject({ status: "TIMEOUT", timeout: true });
    expect(f.state.cardCloseTimeout).toBe(true); expect(f.state.notes[0]).toContain("deadline crossed inside poll");
  });
  it.each(["rejected", "transport timeout"])("drain 7: interrupt %s is recorded and observation starts on return", async kind => {
    const f = fixture(f => f.interrupted ? {} : { working: true });
    f.options.interrupt = async budget => {
      expect(budget.timeout).toBe(10_000); expect(budget.deadline).toBe(f.time + 10_000);
      f.interrupted++; f.time += 10_000;
      if (kind === "transport timeout") throw Error("interrupt transport timeout");
      return { status: 409 };
    };
    const seen = await f.run({ deadline: 1000 });
    expect(seen.status).toBe("TIMEOUT"); expect(f.state.interrupt.error).toContain(kind);
    expect(f.state.interrupt.status).toBe(kind === "rejected" ? 409 : null);
    expect(f.state.settlement).toMatchObject({ startedAt: 11_000, deadline: 41_000, settled: true });
    expect(f.state.notes.join(" ")).toContain("room interrupt");
  });
  it("drain 7: persistent work after interrupt blocks later scenarios and fails the leg", async () => {
    const f = fixture([{ working: true }]); await f.run({ deadline: 1000 });
    await expectBlocked(f); expect(f.interrupted).toBe(1); expect(f.time).toBe(31_000);
  });
  it("drain 7: a card in final collection cancels DONE and resumes under the same deadline", async () => {
    const f = fixture([{}, {}, { open: [card()] }, {}]);
    expect((await f.run()).status).toBe("DONE"); expect(f.poll).toBe(6); expect(f.time).toBe(3000);
    expect(f.answers).toHaveLength(1); expect(new Set(f.calls.map(c => c.deadline))).toEqual(new Set([15_000]));
  });
  it("drain 7: a round timeout followed by a clean tail still FAILs", async () => {
    const f = fixture(f => ({ working: f.interrupted === 0 }));
    expect((await f.run({ deadline: 1000 })).status).toBe("TIMEOUT");
    expect((await f.run({ deadline: f.time + 30_000, round: "tail" })).status).toBe("DONE");
    expect(f.state).toMatchObject({ incomplete: true, cardCloseTimeout: true });
    expect(judgeRow({ id: "S3.cards", scenario: "room", path: "scenarios.room.cards", op: "==", value: 0 }, { scenarios: { room: { ...f.state, cards: 0 } } }).pass).toBe(false);
  });
  it("drain 7: timeout with zero cards FAILs", async () => {
    const f = fixture([{ working: true }]); await f.run({ deadline: 1000 });
    expect(f.options.raised.size).toBe(0);
    expect(judgeRow({ id: "S3.cards", scenario: "room", path: "scenarios.room.cards", op: "==", value: 0 }, { scenarios: { room: { ...f.state, cards: 0 } } })).toMatchObject({ pass: false, value: null, roomIncomplete: true });
  });
  it("drain 7: an error with partial numbers FAILs", async () => {
    const f = fixture(f => f.interrupted ? {} : { room: undefined }); await f.run();
    expect(judgeRow({ id: "S3.first", scenario: "room", path: "scenarios.room.firstReply.p90", op: "<=", value: 5000 },
      { scenarios: { room: { ...f.state, firstReply: { p90: 1 } } } })).toMatchObject({ pass: false, value: null });
  });
  it.each(["fake", "real"])("drain 7: judgeRow incomplete overrides numeric PASS and engineTime exemptions on %s", engines => {
    for (const id of ["S3.cards", "S3.replies", "S3.first", "S3.last"]) {
      const row = { id, scenario: "room", path: "scenarios.room.number", op: "<=", value: 5, engineTime: ["S3.first", "S3.last"].includes(id) };
      const judged = judge({ rows: [row] }, { engines, scenarios: { room: { incomplete: true, number: 0 } } });
      expect(judged.pass).toBe(false); expect(judged.rows[0]).toMatchObject({ pass: false, missing: true, value: null });
      expect(table(judged, "fixture")).toContain("not measured (room did not settle) | FAIL");
    }
  });
  it("drain 7 rev 3: fatal roster error while work continues blocks every later scenario", async () => {
    const f = fixture(f => f.interrupted ? { working: true } : { members: [undefined] });
    expect((await f.run()).status).toBe("ERROR"); await expectBlocked(f);
  });
  it("drain 7 rev 3: observation reads that stay unavailable block every later scenario", async () => {
    const f = fixture([{ roomError: "unavailable" }]); await f.run(); await expectBlocked(f);
    expect(f.time).toBe(32_000); expect(f.interrupted).toBe(1);
  });
  it.each(["busy member", "open card"])("drain 7 rev 3: working=false with persistent %s blocks every later scenario", async kind => {
    const f = fixture([{ busy: kind === "busy member", open: kind === "open card" ? [card()] : [] }]);
    await f.run({ deadline: 1000 }); await expectBlocked(f);
  });
  it("drain 7 rev 3: clean two-poll observation allows later scenarios while S3 stays FAIL", async () => {
    const f = fixture(f => ({ working: f.interrupted === 0 })); await f.run({ deadline: 1000 });
    const { results, events } = await wrap(f);
    expect(events).toEqual(later); expect(results.scenarios.room).toMatchObject({ incomplete: true, cardCloseTimeout: true });
    expect(results.legFailed).toBe(true); expect(f.time).toBe(2000);
    expect(judge({ rows: [] }, results).pass).toBe(false);
  });
  it("drain 7 rev 3: at most one interrupt across expiry and settlement gate", async () => {
    const f = fixture([{ working: true }]); await f.run({ deadline: 1000 });
    const deadline = f.state.settlement.deadline;
    await settleRoomScenario(f.options); await expectBlocked(f);
    expect(f.interrupted).toBe(1); expect(f.state.settlement.deadline).toBe(deadline);
  });
  it("drain 4(d): a scenario-wrapper exception enters the same bounded cleanup", async () => {
    const f = fixture([{ working: true }]);
    const { results, events } = await wrap(f, async () => { throw Error("wrapper failure with partial numbers"); });
    expect(events).toEqual(["stop server"]); expect(results.scenarios.room.incomplete).toBe(true);
    expect(results.scenarios.room.error).toContain("wrapper failure"); expect(f.interrupted).toBe(1);
  });
  it("drain 4(d): final-collection error is incomplete and requires settlement", async () => {
    const f = fixture(f => !f.interrupted && f.poll === 3 ? { messageError: "final read failed" } : {});
    expect(await f.run()).toMatchObject({ status: "ERROR", settlement: { settled: true } });
    expect(f.state.incomplete).toBe(true); expect(f.interrupted).toBe(1);
  });
  it("drain 3: every read, answer retry and sleep uses min(default, remaining)", async () => {
    const f = fixture(f => f.interrupted ? {} : { working: true, open: [card()] });
    let attempts = 0;
    f.options.respond = async (answer, budget) => {
      expect(budget.timeout).toBeLessThanOrEqual(budget.deadline - f.time);
      expect(budget.deadline).toBe(1500); attempts++; return { status: 503 };
    };
    expect((await f.run({ deadline: 1500 })).status).toBe("TIMEOUT");
    expect(attempts).toBe(2); expect(f.sleeps.slice(0, 2)).toEqual([1000, 500]);
    expect(f.calls.filter(c => c.at < 1500).every(c => c.timeout <= 1500 - c.at)).toBe(true);
    const budget = roomBudget(f.time + 700, f.options.now, 60_000);
    expect(budget.timeout).toBe(700); f.time += 600; expect(budget.remaining(30_000)).toBe(100);
    f.time += 100; expect(() => budget.remaining(1)).toThrow("expired");
  });
  it("drain 4(e): non-2xx room DELETE records a note and fails even otherwise-green legs", () => {
    for (const status of [200, 204, 409, 500]) {
      const results = { notes: [], scenarios: {} }; recordRoomDelete(results, "room", { status });
      expect(judge({ rows: [] }, results).pass).toBe(status < 300);
      expect(results.notes.length).toBe(status < 300 ? 0 : 1);
    }
  });
  it("drain 2(c): renewed work in final collection cancels DONE", async () => {
    const f = fixture([{}, {}, { working: true }, {}]);
    expect((await f.run()).status).toBe("DONE"); expect(f.poll).toBe(6); expect(f.time).toBe(3000);
  });
  it("drain 4(d): skipped interrupt observes from cleanup start with its own absolute deadline", async () => {
    const f = fixture([{ working: true }]); f.time = 7000; f.state.interruptSent = true;
    expect(await settleRoomScenario(f.options)).toMatchObject({ startedAt: 7000, deadline: 37_000, settled: false });
    expect(f.interrupted).toBe(0); expect(f.time).toBe(37_000);
    expect(f.calls.every(call => call.deadline === 37_000)).toBe(true);
  });
  it("drain 3: wired fetch bounds the response body and never replays interrupt", async () => {
    const source = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function roomCall("), source.indexOf("/** Put a bot at a level"));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let now = 0; const requests = [], signals = [];
    const fetch = async (url, options) => {
      requests.push({ url, ...options });
      return { status: 200, text: async () => { now += 100; throw Error("body transport timeout"); } };
    };
    const call = await new AsyncFunction("fetch", "AbortSignal", "URL_", "H", "markSend", "recordTransportFailure", body + "\nreturn roomCall;")(
      fetch, { timeout: ms => { signals.push(ms); return { timeout: ms }; } }, "fixture", { "x-murage-surface": "desktop" }, () => {}, () => {});
    await expect(call("POST", "/api/groups/room/interrupt", {}, roomBudget(100, () => now, 10_000))).rejects.toThrow("body transport timeout");
    expect(signals).toEqual([100]);
    expect(requests).toEqual([{ url: "fixture/api/groups/room/interrupt", method: "POST", headers: { "x-murage-surface": "desktop" }, body: "{}", signal: { timeout: 100 } }]);
  });
});

describe("S3 room owner answers", () => {
  it("keeps answered and live payloads, answers every request once, and records shown/answered times", async () => {
    let now = 0, polls = 0;
    const row = (id, card = {}) => ({ kind: "options", at: 1000, card: { requestId: id, tool: "Bash", summary: "ls", cardClass: { reason: "no-grant" }, ...card } });
    const old = row("old", { answered: "allow" }), allow = row("allow"), wipe = row("wipe", { cardClass: { reason: "always-ask" } }), stop = row("stop", { cardClass: { reason: "stop-line" } });
    const question = row("question", { tool: undefined, questions: [{ question: "Which?" }] });
    const limit = row("limit", { tool: "murage_limit_offer" });
    const raised = new Set(), known = new Set(), kept = new Map(), answers = [];
    const options = { raised, known, now: () => now, wall: () => 1000 + now, sleep: async ms => { now += ms; }, every: 250,
      fetchMessages: async () => { polls++; return [old, allow, wipe, stop, question, limit]; },
      fetchOpen: async () => polls === 1 ? [allow, wipe, stop, question, limit] : [limit],
      keepCard: r => kept.set(r.card.requestId, r.card), respond: async answer => { answers.push(answer); now += 10; return { status: 200 }; }, isDone: () => polls >= 2 };
    const seen = await answerRoomCards(options);
    expect([...raised].sort()).toEqual(["allow", "limit", "old", "question", "stop", "wipe"]);
    expect(kept.get("wipe")).toEqual(wipe.card);
    expect(answers).toEqual([{ requestId: "allow", behavior: "allow" }, { requestId: "wipe", behavior: "deny" }, { requestId: "stop", behavior: "deny" }, { requestId: "question", behavior: "skip" }]);
    expect(seen.cards[0]).toMatchObject({ seenMs: 0, answeredMs: 10, resolvedMs: 290, status: 200 });
    expect(seen.cards.find(c => c.requestId === "limit").answeredMs).toBeNull();
    await answerRoomCards({ ...options, fetchOpen: async () => [allow, limit] });
    expect(answers).toHaveLength(4); expect(raised.size).toBe(6);
  });
  it("denies the legacy stop commands/keys and destructive class while allowing ordinary approvals", () => {
    for (const card of [{ summary: "rm -rf /" }, { summary: "shutdown -h now" }, { taskAllowKey: "stop:delete:/other" }, { allowKey: "stop:delete:/other" }, { allowKeys: ["read", "stop:delete:/other"] }, { cardClass: { reason: "destructive-guard" } }, { cardClass: { stop: { kind: "delete" } } }]) {
      expect(roomOwnerAnswer({ requestId: "x", tool: "Bash", ...card })).toEqual({ requestId: "x", behavior: "deny" });
    }
    expect(roomOwnerAnswer({ requestId: "x", tool: "Read", cardClass: { reason: "no-grant" } })).toEqual({ requestId: "x", behavior: "allow" });
    for (const summary of ["ls", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "Remove-Item -Recurse C:\\"]) {
      expect(roomOwnerAnswer({ requestId: "x", tool: "Bash", summary })).toEqual({ requestId: "x", behavior: "deny" });
    }
    expect(roomOwnerAnswer({ requestId: "q", questions: [{ question: "Which?" }] })).toEqual({ requestId: "q", behavior: "skip" });
    expect(roomOwnerAnswer({ requestId: "l", tool: "murage_limit_offer" })).toBeNull();
  });
  it("still answers a late card when replies are complete, preserves failures, and never turns an unreadable thread into zero", async () => {
    const row = { kind: "options", at: 100, card: { requestId: "late", tool: "Read", summary: "payload", cardClass: { reason: "no-grant" } } }, kept = [], replies = [];
    const options = { fetchMessages: async () => [], fetchOpen: async () => [row], keepCard: card => kept.push(card), respond: async answer => { replies.push(answer); return { status: 403 }; }, isDone: () => true, now: () => 0, wall: () => 100 };
    const seen = await answerRoomCards(options);
    expect(kept).toEqual([row]); expect(replies).toEqual([{ requestId: "late", behavior: "allow" }]);
    expect(seen.cards[0]).toMatchObject({ seenMs: 0, seenAt: 100, answeredMs: 0, status: 403 });
    await expect(answerRoomCards({ ...options, fetchMessages: async () => { throw Error("thread unreadable"); } })).rejects.toThrow("thread unreadable");
    await expect(answerRoomCards({ ...options, fetchOpen: async () => { throw Error("open cards pending"); } })).rejects.toThrow("open cards pending");
  });
});

describe("log signatures", () => {
  it("counts each of Sean's symptoms once per line and nothing for quiet lines", () => {
    expect(countSignatures(LOG)).toEqual({ ioBudget: 1, rePreparing: 1, contextCard: 1, fenceRefused: 1, homeNotRead: 1, staleLease: 1, resets: 1, deletionPending: 1, uncaught: 0 });
    expect(countSignatures("")).toMatchObject({ ioBudget: 0, contextCard: 0 });
  });
  it("tells a re-prepare from the card that ends the turn", () => {
    const c = countSignatures("[memory] context revoked during dispatch on thread t-9; re-preparing (2 of 3)\n[memory] context revoked during dispatch on thread t-9; re-preparing (3 of 3)");
    expect(c.rePreparing).toBe(2); expect(c.contextCard).toBe(0);
  });
  it("sorts the stop lines: rm -rf / is the wipe line, shutdown is the stop line No limits lifts (rig v5.8)", async () => {
    const { STOP_COMMANDS, WIPE_COMMANDS, stopKind } = await import("./smooth-config.mjs");
    expect(STOP_COMMANDS.map(stopKind)).toEqual(["wipe", "stopLine"]);
    expect(WIPE_COMMANDS).toEqual(["rm -rf /"]);
  });
  it("counts the late-submission re-prepare, plain and in a room, and its card (rig v5.6)", () => {
    const c = countSignatures([
      "[memory] context revoked at a late submission on thread 3ea28cf9-dbc2-4a6a-aabb-a9b2c13a73b4; re-preparing (1 of 3, room member Smooth Room B)",
      "[memory] context revoked at a late submission on thread t-3; re-preparing (2 of 3)",
      "[memory] context revoked during dispatch on thread t-4; re-preparing (1 of 3, room member Smooth Room A)",
      "[memory] context revoked at a late submission on thread t-3 after 3 rebuilds (claude); the turn ends with a card",
      "[memory] context revoked at a late submission on thread t-5 after a tool started (fuigo, room member A)",
    ].join("\n"));
    expect(c.rePreparing).toBe(3); expect(c.contextCard).toBe(1);
  });
});

describe("transcript reading", () => {
  const page = [
    { kind: "text", role: "user", text: "hi" },
    { kind: "options", role: "bot", card: { requestId: "r1", answered: false } },
    { kind: "options", role: "bot", card: { requestId: "r2", answered: true } },
    { kind: "options", role: "bot", card: {} },
    { kind: "text", role: "murage", text: "[Reply left out until earlier memory is checked] (Petra, 10:00 UTC)" },
    { kind: "text", role: "murage", text: "[Reply withheld] (Sable, 10:01 UTC)" },
    { kind: "text", role: "murage", text: "Context changed; previous attempt may have started. Review its output before trying again." },
    { kind: "error", role: "murage", text: "turn failed" },
  ];
  it("counts approval cards by their request id, open ones apart", () => { expect(cardsIn(page)).toHaveLength(2); expect(openCards(page)).toHaveLength(1); });
  it("counts withheld and checking mirrors and Context changed lines", () => { expect(withheldIn(page)).toHaveLength(2); expect(contextChangedIn(page)).toHaveLength(1); });
  it("reads a room's member replies after the send: first and last", () => {
    // room rows carry from: { botId, name, color } (store.ts), the shape every room writer in index.ts uses
    const ms = [{ role: "bot", kind: "text", at: 1000, from: { botId: "a", name: "A" } }, { role: "bot", kind: "text", at: 1500, from: { botId: "b", name: "B" } }, { role: "bot", kind: "text", at: 1600, from: { botId: "a", name: "A" } }, { role: "bot", kind: "text", at: 900, from: { botId: "c", name: "C" } }, { role: "user", kind: "text", at: 1200 }];
    expect(roomReplies(ms, 950, new Set(["a", "b", "c"]))).toEqual({ members: 2, first: 50, last: 550 });
    expect(roomReplies([], 0)).toEqual({ members: 0, first: null, last: null });
  });
  it("S3: counts a member by from.botId, never by a from.id that room rows do not carry", () => {
    const three = ["a", "b", "c"].map((id, i) => ({ role: "bot", kind: "text", at: 2000 + i * 100, from: { botId: id, name: id.toUpperCase(), color: "#fff" } }));
    expect(roomReplies(three, 1000, new Set(["a", "b", "c"]))).toEqual({ members: 3, first: 1000, last: 1200 });
    expect(roomReplies([{ role: "bot", kind: "text", at: 2000, from: { id: "a" } }], 1000, new Set(["a"])).members).toBe(0);
    expect(speakerOf({ botId: "z" })).toBe("z");
  });
  it("reads the fake lead's own words for the chain", () => {
    const ms = [{ role: "bot", text: "lead handed over: ok" }, { role: "bot", text: "lead saw the result and is done" }, { role: "bot", text: "lead was woken without a result" }, { role: "user", text: "lead saw the result" }];
    expect(chainFromManager(ms)).toEqual({ handedOver: 1, sawResult: 1, wokenEmpty: 1, leadErrors: 0 });
  });
});

describe("approval levels", () => {
  it("builds the PATCH that the server's full-access contract accepts", () => {
    expect(levelPatch("ask")).toEqual({ autoApprove: false });
    expect(levelPatch("auto", "linux")).toEqual({ autoApprove: true, fullAccess: false });
    expect(levelPatch("full")).toMatchObject({ fullAccess: true, acknowledgeFullAccess: true });
    expect(levelPatch("unlimited")).toMatchObject({ noLimits: true, acknowledgeNoLimits: true, fullAccess: true, autoApprove: true });
    expect(() => levelPatch("root")).toThrow();
  });
  it("expects every card at Ask, none at Full access or No limits, and only reports Auto", () => {
    expect(expectedCards("ask")).toEqual({ op: "==", value: DEV_COMMANDS.length });
    expect(expectedCards("unlimited")).toEqual({ op: "==", value: 0 });
    expect(expectedCards("full")).toEqual({ op: "==", value: 0 });
    expect(expectedCards("auto")).toBeNull();
    expect(STOP_COMMANDS).toHaveLength(2);
  });
});

describe("routine burst", () => {
  it("scores lateness from the slot, deferrals for connected apps and runs that never started", () => {
    const runs = [
      { routineId: "a", scheduledFor: 1000, slotAt: 1000, startedAt: 1500, status: "done" },
      { routineId: "b", scheduledFor: 1000, slotAt: 1010, dueAt: 1000, startedAt: 61_010, status: "done" },
      { routineId: "c", scheduledFor: 1000, attention: "Waiting for connected apps to load. Retrying in 2 minutes (attempt 1 of 2)", status: "queued" },
      { routineId: "zzz", scheduledFor: 1000, startedAt: 1001 },
    ];
    const b = routineBurst(runs, new Set(["a", "b", "c"]));
    expect(b).toMatchObject({ runs: 3, started: 2, unstarted: 1, deferred: 1, lateness: [500, 60_000], fromDue: [500, 60_010] });
    expect(b.statuses).toEqual({ done: 2, queued: 1 });
  });
  it("counts the startup note in the fakes' prompt dumps without reading anything else", () => {
    expect(startupNotesIn([`["x", "Note: ${STARTUP_NOTE_MARK}, so their tools may be missing."]`, "plain", undefined])).toBe(1);
  });
});

describe("the server tree without /proc (macOS ps, Windows Win32_Process)", () => {
  it("guards the data dir with either separator", () => {
    expect(dataDirAllowed("/home/u/smooth-real/data/murage")).toBe(true);
    expect(dataDirAllowed("C:\\Users\\u\\smooth-real\\data\\murage")).toBe(true);
    expect(dataDirAllowed("C:\\Users\\u\\.murage\\smooth")).toBe(false);
    expect(dataDirAllowed("/home/u/.murage/smooth-x")).toBe(false);
    expect(dataDirAllowed("/home/u/data/murage")).toBe(false);
    expect(dataDirAllowed("")).toBe(false);
  });
  it("folds case and Windows trailing dots/spaces when it looks for .murage", () => {
    expect(dataDirAllowed("C:\\Users\\smooth-owner\\.MURAGE")).toBe(false);
    expect(dataDirAllowed("C:\\Users\\smooth-owner\\.murage.\\x")).toBe(false);
    expect(dataDirAllowed("C:\\Users\\smooth-owner\\.Murage \\x")).toBe(false);
    expect(dataDirAllowed("/home/u/Smooth-real/.murage/x")).toBe(false);
    expect(dataDirAllowed("/home/u/smooth-real/data/murage")).toBe(true);
    expect(dataDirAllowed("/home/u/smooth-real/data/.murage-copy")).toBe(true);
  });
  it("finds the script entry by file URL, never by file:// plus a raw path", () => {
    const p = "/tmp/smooth x/smooth-gate.mjs";
    expect(isMainModule(pathToFileURL(p).href, p)).toBe(true);
    expect(isMainModule(pathToFileURL(p).href, "/tmp/other.mjs")).toBe(false);
    expect(isMainModule(pathToFileURL(p).href, undefined)).toBe(false);
    expect(`file://${p}` === pathToFileURL(p).href).toBe(false); // the old compare failed on a space too
  });
  it("sends the local Auto warning only where Auto mounts this computer", () => {
    expect(levelPatch("auto", "linux")).toEqual({ autoApprove: true, fullAccess: false });
    expect(levelPatch("auto", "darwin")).toEqual({ autoApprove: true, fullAccess: false, acknowledgeLocalAuto: true });
    expect(levelPatch("full", "win32")).toMatchObject({ acknowledgeFullAccess: true, acknowledgeLocalAuto: true });
    expect(levelPatch("unlimited", "darwin")).toMatchObject({ acknowledgeNoLimits: true, acknowledgeLocalAuto: true });
    expect(levelPatch("ask", "darwin")).toEqual({ autoApprove: false });
  });
  it("passes OS variables through on macOS and Windows only", () => {
    expect(osPassThrough("linux")).toEqual([]);
    expect(osPassThrough("darwin")).toEqual(["USER", "LOGNAME", "SHELL"]);
    expect(osPassThrough("win32")).toEqual(expect.arrayContaining(["SystemRoot", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA"]));
  });
});

describe("event-loop stalls (SMOOTH-RIG-RESTART-GAP)", () => {
  const eld = (t, max = 1) => `[eld] t=${t} p50=0 p99=0 max=${max}`;
  const stalls = w => w.map(r => r.stall);
  it("with start marks: the gap that ends at a new process's first line is left out of fixed, kept in raw; startup lines stay in", () => {
    const log = [`${SERVER_START_MARK} t=0`, eld(1000), eld(2000, 300), eld(3000), "server stopping", `${SERVER_START_MARK} t=20000`, eld(30000, 5), "[turn-trace] phase=startup.module.loaded ms=2100", eld(32500, 900), eld(33500)].join("\n");
    const { raw, fixed, restarts } = eldStalls(log);
    expect(stalls(raw)).toEqual([1, 300, 1, 26000, 1500, 1]);
    expect(stalls(fixed)).toEqual([1, 300, 1, 5, 1500, 1]);
    expect(restarts).toEqual([{ t: 30000, gapMs: 26000 }]);
  });
  it("a long silence inside one process is still a stall", () => {
    const { fixed } = eldStalls([`${SERVER_START_MARK} t=0`, eld(1000), eld(9000)].join("\n"));
    expect(stalls(fixed)).toEqual([1, 7000]);
  });
  it("without marks (older logs) a startup.module.loaded line marks the new process, before or after its first line", () => {
    const boot = "[turn-trace] phase=startup.module.loaded ms=500";
    const after = [boot, eld(1000), eld(2000), eld(30000), "[turn-trace] phase=startup.module.loaded ms=2200", eld(31000)].join("\n");
    expect(stalls(eldStalls(after).fixed)).toEqual([1, 1, 1, 1]);
    const before = [boot, eld(1000), eld(2000), "[turn-trace] phase=startup.module.loaded ms=900", eld(30000), eld(31000)].join("\n");
    expect(stalls(eldStalls(before).fixed)).toEqual([1, 1, 1, 1]);
    expect(stalls(eldStalls(before).raw)).toEqual([1, 1, 27000, 1]);
    // a slow box: module load 5.5 s, so the new process prints five lines before it
    const slow = [boot, eld(1000), eld(2000), eld(31000), eld(32000), eld(33000), eld(34000), eld(35000), "[turn-trace] phase=startup.module.loaded ms=5550", eld(36000, 700)].join("\n");
    expect(stalls(eldStalls(slow).fixed)).toEqual([1, 1, 1, 1, 1, 1, 1, 700]);
    expect(eldStalls(slow).restarts).toEqual([{ t: 31000, gapMs: 28000 }]);
  });
  it("the first process's startup never hides a stall", () => {
    const log = [eld(1000), eld(4000), "[turn-trace] phase=startup.module.loaded ms=2500", eld(5000)].join("\n");
    expect(stalls(eldStalls(log).fixed)).toEqual([1, 2000, 1]);
    expect(eldStalls(log).restarts).toEqual([]);
  });
  it("windows by time", () => { expect(eldStalls([eld(1000), eld(2000), eld(3000)].join("\n"), 1500, 2500).fixed).toEqual([{ t: 2000, stall: 1 }]); });
});

describe("judging", () => {
  const budgets = { loadedFactor: 1.5, rows: [
    { id: "L", scenario: "s", what: "wall p90", path: "scenarios.s.wall.p90", op: "<=", value: 1000, unit: "ms", latency: true },
    { id: "C", scenario: "s", what: "cards", path: "scenarios.s.cards", op: "==", value: 0 },
    { id: "N", scenario: "s", what: "started", path: "scenarios.s.started", op: ">=", value: 8 },
    { id: "B", scenario: "s", what: "refused (1 = yes)", path: "scenarios.s.refused", op: "==", value: 1 },
  ] };
  it("passes a row within budget and fails one over it, a missing value never passes", () => {
    const r = judge(budgets, { scenarios: { s: { wall: { p90: 900 }, cards: 1, started: 8, refused: true } } });
    expect(r.rows.map(x => x.pass)).toEqual([true, false, true, true]);
    expect(r.pass).toBe(false); expect(r.failed).toBe(1);
    expect(judgeRow(budgets.rows[0], { scenarios: {} })).toMatchObject({ pass: false, missing: true, value: null });
  });
  it("a loaded run keeps the same limit, shows the old factor as information only, and carries a scenario error into the row", () => {
    const res = { load: true, scenarios: { s: { wall: { p90: 1400 }, cards: 1, started: 8, refused: 1, error: "boom" } } };
    const r = judge(budgets, res);
    expect(r.rows[0]).toMatchObject({ pass: false, limit: 1000, error: "boom", oldFactor: { limit: 1500, wouldPass: true } });
    expect(r.rows[1]).toMatchObject({ pass: false, limit: 0 });
    expect(r.rows[1].oldFactor).toBeUndefined();
    expect(judgeRow(budgets.rows[0], { scenarios: { s: { wall: { p90: 1400 } } } }).oldFactor).toBeUndefined();
    expect(table(r, "t")).toContain("info only, old factor: limit 1500, would pass");
  });
  it("an optional row says none raised only on a real count of zero", () => {
    const row = { id: "O", scenario: "s", what: "card", path: "scenarios.s.card.max", op: "<=", value: 10, optional: true, noneWhenZero: "scenarios.s.cards" };
    expect(judgeRow(row, { scenarios: { s: { card: { max: null }, cards: 0 } } })).toMatchObject({ pass: true, none: true });
    expect(judgeRow(row, { scenarios: { s: { card: { max: null }, cards: 2 } } })).toMatchObject({ pass: false, missing: true });
    expect(judgeRow(row, { scenarios: { s: { card: { max: null } } } })).toMatchObject({ pass: false, missing: true });
    expect(judgeRow(row, { scenarios: { s: { cards: 0, error: "x" } } })).toMatchObject({ pass: false, missing: true });
    const { noneWhenZero, ...bare } = row;
    expect(judgeRow(bare, { scenarios: { s: { cards: 0 } } })).toMatchObject({ pass: false, missing: true });
  });
  it("a report-only row prints its value and whether it would pass, and can never fail the leg; a kill row beside it still fails", () => {
    const results = { all: { ioWrite: { lines: 40, mb: 90, peak: 99 } } };
    const rep = { id: "R", scenario: "all", what: "lines", path: "all.ioWrite.lines", op: "<=", value: 8, reportOnly: true };
    expect(judgeRow(rep, results)).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, value: 40, limit: 8 });
    expect(judgeRow({ ...rep, value: 50 }, results)).toMatchObject({ pass: true, reportOnly: true, wouldPass: true });
    expect(judgeRow({ ...rep, reportOnly: undefined }, results)).toMatchObject({ pass: false, value: 40 });
    expect(judgeRow({ ...rep, id: "K", path: "all.ioWrite.mb", value: 80, reportOnly: undefined }, results)).toMatchObject({ pass: false, value: 90 });
    expect(judgeRow(rep, {})).toMatchObject({ pass: false, missing: true });
    expect(table(judge({ ...budgets, rows: [rep] }, { all: { ioWrite: { lines: 40, mb: 90, peak: 99 } } }), "t")).toContain("report only (over the bound)");
    expect(table(judge({ ...budgets, rows: [{ ...rep, value: 50 }] }, results), "t")).toContain("report only (within the bound)");
  });
  it("shows an engine-time row of a real-engine run without judging it, and still judges Murage's own latency and its counts", () => {
    const real = { ...budgets, rows: [{ ...budgets.rows[0], engineTime: true }, ...budgets.rows.slice(1), { id: "M", scenario: "s", what: "boot", path: "scenarios.s.boot", op: "<=", value: 10, unit: "ms", latency: true }] };
    const r = judge(real, { engines: "real", scenarios: { s: { wall: { p90: 99_000 }, cards: 1, started: 8, refused: 1, boot: 50 } } });
    expect(r.rows[0]).toMatchObject({ pass: true, notApplicable: true, value: 99_000 });
    expect(r.rows[4]).toMatchObject({ pass: false, value: 50 });
    expect(r.rows[1]).toMatchObject({ pass: false });
    expect(table(r, "t")).toContain("| L | s | wall p90 <= 1000 ms | 99000 ms | n/a (real engine) |");
    expect(judge(budgets, { engines: "fake", scenarios: { s: { wall: { p90: 99_000 } } } }).rows[0]).toMatchObject({ pass: false });
  });
  it("writes a verdict that passes only when both the idle and the loaded run pass, and a readable table", () => {
    const ok = { pass: true, failed: 0, rows: [{ id: "L", value: 1, pass: true }] }, bad = { pass: false, failed: 1, rows: [{ id: "L", value: 9, pass: false }] };
    expect(verdictOf({ tree: "abc", idle: ok, loaded: ok }).pass).toBe(true);
    expect(verdictOf({ tree: "abc", idle: ok, loaded: bad }).pass).toBe(false);
    expect(verdictOf({ tree: "abc", idle: ok, loaded: null }).pass).toBe(false);
    const v = verdictOf({ tree: "abc", idle: ok, loaded: ok, at: 0 });
    expect(v).toMatchObject({ tree: "abc", engines: "fake", at: "1970-01-01T00:00:00.000Z", rows: { L: { value: 1, pass: true }, "L@load": { value: 1, pass: true } } });
    const md = table(judge(budgets, { scenarios: { s: { wall: { p90: 900 }, cards: 0, started: 8, refused: 1 } } }), "t");
    expect(md).toContain("| L | s | wall p90 <= 1000 ms | 900 ms | PASS |");
    expect(md).toContain("PASS: 4 of 4 rows pass.");
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const clock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

describe("S2: hand-offs counted from server state", () => {
  const worker = { workerId: "w-a", workerName: "Smooth Worker A" };
  const messaged = { role: "bot", kind: "activity", at: 5000, tool: { name: "Messaged @Smooth Worker A" }, from: { botId: "m" } };
  it("counts a real engine's hand-off from the Messaged row and its done receipt, with no fake text anywhere", () => {
    const r = chainFromServer({ ...worker, sinceAt: 1000, managerMessages: [messaged, { role: "bot", kind: "text", text: "Assigned the payments count to Smooth Worker A." }], receipts: [{ id: "d1", toBotId: "w-a", status: "done", finishedAt: 9000 }] });
    expect(r).toMatchObject({ handedOver: 1, messaged: 1, receipts: 1, sawResult: 1, failed: 0, statuses: { done: 1 } });
  });
  it("ignores other workers, earlier receipts and earlier rows; a failed receipt is a hand-off without a result", () => {
    const r = chainFromServer({ ...worker, sinceAt: 6000, managerMessages: [messaged, { ...messaged, tool: { name: "Messaged @Smooth Worker B" }, at: 7000 }],
      receipts: [{ toBotId: "w-b", status: "done", finishedAt: 9000 }, { toBotId: "w-a", status: "done", finishedAt: 100 }, { toBotId: "w-a", status: "busy_gave_up", finishedAt: 9000 }] });
    expect(r).toMatchObject({ handedOver: 1, messaged: 0, receipts: 1, sawResult: 0, failed: 1 });
    expect(chainFromServer({ ...worker, managerMessages: undefined, receipts: { not: "a list" } })).toMatchObject({ handedOver: 0, sawResult: 0 });
  });
  it("the fake lead's words alone no longer count as a hand-off", () => {
    expect(chainFromServer({ ...worker, managerMessages: [{ role: "bot", kind: "text", text: "lead handed over: ok", at: 5000 }], receipts: [] }).handedOver).toBe(0);
  });
});

describe("S6: the held turn is really held", () => {
  it("a real held turn is a shell sleep far longer than both deletes' budgets; the fake one waits on the gate", () => {
    expect(heldPrompt("real", 0)).toContain(`sleep ${REAL_HELD_SECONDS}`);
    expect(REAL_HELD_SECONDS * 1000).toBeGreaterThan(2 * 10_000 + 60_000);
    expect(heldPrompt("fake", 1)).toBe("Held turn 1: wait for the gate.");
  });
  it("judges the working DELETE only when the turn read busy as it was sent", () => {
    expect(workingDeleteVerdict(true, 409)).toEqual({ workingRefused: 1, workingConfirmed: 1, workingDeleteStatus: 409 });
    expect(workingDeleteVerdict(true, 200)).toMatchObject({ workingRefused: 0 });
    expect(workingDeleteVerdict(false, 200)).toMatchObject({ workingRefused: null, workingConfirmed: 0 });
    const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
    const row = budgets.rows.find(r => r.id === "S6.workingRefused");
    expect(judgeRow(row, { engines: "real", scenarios: { deletion: workingDeleteVerdict(false, 200) } })).toMatchObject({ pass: false, missing: true });
  });
  it("waits until the check holds, or gives up at the cap", async () => {
    let n = 0; const c = clock();
    expect(await waitFor(async () => ++n >= 3, { cap: 10_000, every: 500, ...c })).toEqual({ ok: true, ms: 1000 });
    expect(await waitFor(async () => false, { cap: 2000, every: 500, ...clock() })).toEqual({ ok: false, ms: 2000 });
  });
});

describe("own folders and settling after a timeout (S7/S8 cascade)", () => {
  it("gives every bot its own folder, by scenario and name, under the run's root", () => {
    expect(botFolder("/tmp/smooth-work/", "deletion", "Smooth Held 1")).toBe("/tmp/smooth-work/deletion--smooth-held-1");
    expect(botFolder("/tmp/smooth-work", "stop", "Smooth Stop")).toBe("/tmp/smooth-work/stop--smooth-stop");
    const names = ["Smooth Held 1", "Smooth Held 2", "Smooth Held 3", "Smooth Idle"].map(n => botFolder("/w", "deletion", n));
    expect(new Set(names).size).toBe(names.length);
    expect(botFolder("/w", "stop", "Smooth Stop")).not.toBe(botFolder("/w", "deletion", "Smooth Stop"));
    expect(botFolder("/w", "../x", "a/b")).toBe("/w/x--a-b");
  });
  it("sends one Stop and waits for idle; a bot-wide Stop follows only when the first does not settle", async () => {
    const stops = []; let busyReads = 0;
    const r = await stopAndSettle({ stop: async all => { stops.push(all); return 200; }, isBusy: async () => ++busyReads < 3, cap: 10_000, every: 500, ...clock() });
    expect(r).toMatchObject({ stopStatus: 200, settled: true, escalated: false });
    expect(stops).toEqual([false]);
    const stops2 = []; let allSent = false;
    const r2 = await stopAndSettle({ stop: async all => { stops2.push(all); if (all) allSent = true; return 200; }, isBusy: async () => !allSent, cap: 2000, every: 500, ...clock() });
    expect(r2).toMatchObject({ settled: true, escalated: true, allStatus: 200 });
    expect(stops2).toEqual([false, true]);
    const r3 = await stopAndSettle({ stop: async () => 200, isBusy: async () => true, cap: 1000, every: 500, ...clock() });
    expect(r3).toMatchObject({ settled: false, escalated: true, ms: 2000 });
  });
});

describe("S4: every card a turn raises is answered", () => {
  it("answers a second card for the same command (Codex asks again outside its sandbox), each request once", async () => {
    const pages = [[], [{ card: { requestId: "r1" } }], [{ card: { requestId: "r1" } }], [{ card: { requestId: "r2" } }], []];
    let i = 0; const responded = []; const c = clock();
    const r = await answerCards({ fetchCards: async () => pages[Math.min(i++, pages.length - 1)], respond: async card => { responded.push(card.requestId); }, isDone: () => i >= pages.length, ...c });
    expect(r).toMatchObject({ answered: ["r1", "r2"], timeout: false });
    expect(responded).toEqual(["r1", "r2"]);
  });
  it("answers nothing for a turn that raises no card, and stops at the cap when the turn never ends", async () => {
    expect(await answerCards({ fetchCards: async () => [], respond: async () => {}, isDone: () => true, ...clock() })).toEqual({ answered: [], timeout: false, cards: [] });
    expect(await answerCards({ fetchCards: async () => [{ card: { requestId: "x" } }], respond: async () => {}, isDone: () => false, cap: 1000, ...clock() })).toMatchObject({ answered: ["x"], timeout: true });
  });
});

describe("S7 at Ask: the runner answers each card as the owner would, and times it", () => {
  it("times a card from shown to answered to closed, with the tool name only", async () => {
    const c = clock(); let polls = 0;
    // shown on the 3rd poll, still open on the poll after the answer, gone on the next; the turn ends two polls later
    const pages = [[], [], [{ card: { requestId: "a", tool: "execute", title: "Run: secret words" } }], [{ card: { requestId: "a" } }], [], [], []];
    const r = await answerCards({ fetchCards: async () => pages[Math.min(polls++, pages.length - 1)], respond: async () => { c.sleep(40); return { status: 200 }; }, isDone: () => polls >= 6, every: 250, wall: () => 1000, ...c });
    expect(r.cards).toEqual([{ requestId: "a", kind: "approval", tool: "execute", seenMs: 500, seenAt: 1000, cardAt: null, answeredMs: 540, resolvedMs: 1040, status: 200 }]);
    expect(JSON.stringify(r)).not.toContain("secret words");
  });
  it("closes a card still open when the turn ends at the turn's end", async () => {
    const c = clock(); let n = 0;
    const r = await answerCards({ fetchCards: async () => [{ card: { requestId: "b" } }], respond: async () => ({ status: 403 }), isDone: () => ++n >= 3, every: 250, ...c });
    expect(r.cards[0]).toMatchObject({ seenMs: 0, answeredMs: 0, resolvedMs: 500, status: 403, tool: null, kind: "question" });
  });
  it("never answers or times again a card an earlier turn answered (a question can stay open past its turn)", async () => {
    const known = new Set(["q-old"]); const responded = [];
    const r = await answerCards({ fetchCards: async () => [{ card: { requestId: "q-old" } }, { card: { requestId: "n", tool: "execute" } }], respond: async c => { responded.push(c.requestId); }, isDone: () => true, known, ...clock() });
    expect(responded).toEqual(["n"]); expect(r.cards.map(c => c.requestId)).toEqual(["n"]); expect([...known]).toEqual(["q-old", "n"]);
  });
  it("answers as the owner would: Allow for an approval, the card's own Skip for a question", () => {
    expect(isQuestionCard({ requestId: "a", tool: "execute" })).toBe(false);
    expect(isQuestionCard({ requestId: "a", questions: [{ id: "q1" }] })).toBe(true);
    expect(isQuestionCard({ requestId: "a" })).toBe(true);
    expect(isQuestionCard({ requestId: "a", skillRequest: {} })).toBe(false);
    expect(ownerAnswer({ requestId: "a", tool: "execute" })).toEqual({ requestId: "a", behavior: "allow" });
    expect(ownerAnswer({ requestId: "q", questions: [{ id: "q1" }] })).toEqual({ requestId: "q", behavior: "skip" });
    expect(ownerAnswer({ requestId: "l", tool: "murage_limit_offer" })).toBeNull();
  });
  it("leaves an engine-limit offer for the owner: counted, never answered", async () => {
    const responded = [];
    const r = await answerCards({ fetchCards: async () => [{ card: { requestId: "l", tool: "murage_limit_offer" } }], respond: async c => { responded.push(c.requestId); }, isDone: () => true, ...clock() });
    expect(responded).toEqual([]); expect(r.cards[0]).toMatchObject({ kind: "limit", answeredMs: null, status: null });
    expect(cardTimings(r.cards).cards[0]).toMatchObject({ kind: "limit", resolveMs: null });
  });
  it("reads the engine's asks from the trace, in order, and only that trace's", () => {
    const log = [
      "[turn-trace] id=b340ef4c phase=tool.roundtrip at=9357ms since=32ms outcome=completed ms=21",
      "[turn-trace] id=b340ef4c phase=permission.wait at=50400ms since=1ms outcome=allow ms=400",
      "[turn-trace] id=other111 phase=permission.wait at=9000ms since=1ms outcome=allow ms=10",
      "[turn-trace] id=b340ef4c phase=permission.wait at=180051ms since=1ms outcome=cancel ms=131206",
    ].join("\n");
    expect(permissionWaits(log, "b340ef4c")).toEqual([{ askedMs: 50000, waitMs: 400 }, { askedMs: 48845, waitMs: 131206 }]);
    expect(permissionWaits(log, undefined)).toEqual([]);
    expect(permissionWaits(log, "x.*")).toEqual([]);
  });
  it("splits Murage's own card time from the owner's, and keeps the owner's out of the turn", () => {
    const cards = [{ tool: "execute", status: 200, seenMs: 50300, answeredMs: 50320, resolvedMs: 50600 }, { tool: null, status: 200, seenMs: 70000, answeredMs: 70010, resolvedMs: 70500 }];
    const t = cardTimings(cards, [{ askedMs: 50000, waitMs: 330 }]);
    expect(t.cards[0]).toEqual({ kind: "approval", tool: "execute", status: 200, appearMs: 50300, visibleMs: 300, visibleFrom: "ask", resolveMs: 280, waitMs: 330 });
    // no ask logged for the second card and no card time: shown is not measured, the wait comes from the runner's own polls
    expect(t.cards[1]).toMatchObject({ visibleMs: null, visibleFrom: null, resolveMs: 490, waitMs: 500 });
    expect(t.cardWaitMs).toBe(830);
    expect(cardTimings([], [])).toEqual({ cards: [], cardWaitMs: 0 });
    // a question logs no ask: its shown time is not Murage's to judge, and the asks pair with the approvals only
    const mixed = cardTimings([{ kind: "question", seenMs: 900, answeredMs: 910, resolvedMs: 1200 }, { kind: "approval", seenMs: 2000, answeredMs: 2010, resolvedMs: 2300 }], [{ askedMs: 1800, waitMs: 400 }]);
    expect(mixed.cards.map(c => c.visibleMs)).toEqual([null, 200]);
    // the Claude driver logs no ask: the card row's own server time to the owner seeing it
    expect(cardTimings([{ seenMs: 9616, seenAt: 50_300, cardAt: 50_120, answeredMs: 9620, resolvedMs: 9870 }]).cards[0]).toMatchObject({ visibleMs: 180, visibleFrom: "card", appearMs: 9616 });
    expect(mixed.cardWaitMs).toBe(300 + 400);
  });
  it("judges the card rows only when a card was raised (the real model decides whether a tool asks)", () => {
    const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
    const shown = budgets.rows.find(r => r.id === "S7.cardShown"), closed = budgets.rows.find(r => r.id === "S7.cardClosed");
    expect(shown).toMatchObject({ optional: true, latency: true }); expect(shown.engineTime).toBeUndefined(); expect(closed.engineTime).toBeUndefined();
    expect(judgeRow(shown, { engines: "real", scenarios: { engineSwitch: { approvalCards: 0, cardVisible: { n: 0, max: null } } } })).toMatchObject({ pass: true, none: true });
    expect(judgeRow(shown, { engines: "real", scenarios: { engineSwitch: { approvalCards: 1, cardVisible: { n: 0, max: null } } } })).toMatchObject({ pass: false, missing: true });
    expect(judgeRow(shown, { engines: "real", scenarios: { engineSwitch: { cardVisible: { n: 2, max: 2500 } } } })).toMatchObject({ pass: false, value: 2500 });
    expect(judgeRow(closed, { engines: "real", scenarios: { engineSwitch: { cardResolve: { n: 1, max: 300 } } } })).toMatchObject({ pass: true, value: 300 });
    expect(judgeRow(shown, { scenarios: { engineSwitch: { error: "boom" } } })).toMatchObject({ pass: false, missing: true });
    expect(table(judge({ rows: [shown] }, { scenarios: { engineSwitch: { approvalCards: 0 } } }), "t")).toContain("none raised");
    expect(table(judge({ rows: [shown] }, { scenarios: { engineSwitch: {} } }), "t")).toContain("not measured");
  });
});

describe("rig v5.5: S1 prompt and empty-dir rows", () => {
  const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
  const lt = { longThread: { error: "no top-40 thread belongs to a visible bot on claude/codex" } };
  const del = { deletion: { deleteThreadStatus: "no old conversation found" } };
  it("real prompts carry the list and say where the line goes; fake words do not change", () => {
    expect(routinePrompt("real", 3)).toContain("item 3 is dates");
    expect(routinePrompt("real", 3)).toContain("in this chat");
    expect(routinePrompt("real", 3)).not.toMatch(/do not ask/i);
    expect(routinePrompt("fake", 3)).toBe("Post one line about item 3.");
  });
  it("names exactly the five rows", () => {
    expect(budgets.rows.filter(r => r.realEmptyDir).map(r => r.id).sort()).toEqual(["S5.context", "S5.failed", "S5.resets", "S5.resumed", "S6.deleteThread"]);
  });
  it("prints not measured only on a real leg, with the dir proven empty and the scenario's own words", () => {
    const s5 = budgets.rows.find(r => r.id === "S5.failed"), s6 = budgets.rows.find(r => r.id === "S6.deleteThread");
    const good = { engines: "real", dataDirEmptyAtStart: true, scenarios: { ...lt, ...del } };
    expect(judgeRow(s5, good)).toMatchObject({ pass: true, missing: true, emptyDir: true });
    expect(judgeRow(s6, good)).toMatchObject({ pass: true, missing: true, emptyDir: true });
    expect(table({ rows: [judgeRow(s5, good)], failed: 0, pass: true }, "t")).toContain("not measured (empty data dir");
    for (const bad of [
      { ...good, engines: "fake" },
      { ...good, dataDirEmptyAtStart: false },
      { engines: "real", scenarios: good.scenarios },
      { ...good, scenarios: { longThread: { error: "boom" }, deletion: { deleteThreadStatus: 500 } } },
      { ...good, scenarios: {} },
      { ...good, scenarios: { longThread: { ...lt.longThread, failed: "1", resumed: null }, deletion: { ...del.deletion, deleteThreadMs: "20000" } } },
      { ...good, scenarios: { longThread: { ...lt.longThread, failed: null }, deletion: { ...del.deletion, error: "log unreadable" } } },
    ]) {
      expect(judgeRow(s5, bad)).toMatchObject({ pass: false, missing: true });
      expect(judgeRow(s6, bad)).toMatchObject({ pass: false, missing: true });
    }
  });
  it("a measured value is judged as ever, even on an empty dir", () => {
    const s6 = budgets.rows.find(r => r.id === "S6.deleteThread");
    expect(judgeRow(s6, { engines: "real", dataDirEmptyAtStart: true, scenarios: { deletion: { deleteThreadStatus: "no old conversation found", deleteThreadMs: 20000 } } }).pass).toBe(false);
  });
});

describe("S1.lateness on real engines", () => {
  it("is an engine-time row: shown, not judged, on a real run (8 runs share the 2-slot cap behind real engine turns)", () => {
    const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
    const row = budgets.rows.find(r => r.id === "S1.lateness");
    expect(row.engineTime).toBe(true);
    expect(judgeRow(row, { engines: "real", scenarios: { routineBurst: { lateness: { p90: 143_000 } } } })).toMatchObject({ pass: true, notApplicable: true });
    expect(judgeRow(row, { engines: "fake", scenarios: { routineBurst: { lateness: { p90: 143_000 } } } })).toMatchObject({ pass: false });
  });
});

describe("every run's server log is kept", () => {
  const keep = (...args) => spawnSync("bash", [join(HERE, "keep-logs.sh"), ...args, process.execPath], { encoding: "utf8" });
  it("copies the server log, failed-turn JSONL, results, gate table and debug dir without changing out", () => {
    const t = mkdtempSync(join(tmpdir(), "keeper-test-")), out = join(t, "out"), logs = join(t, "logs");
    try {
      mkdirSync(join(out, "debug"), { recursive: true });
      const serverLog = '[2026-11-07T00:00:00.000Z] [out] [turn-trace] id=abc phase=turn.done at=20ms outcome=failed tokensIn=123 tokensOut=456\n'
        + 'usage=777 cost: 888 charge=999 tokens=666 "inputTokens":789 OUTPUTTOKENS=321 cachedInput=654\n';
      writeFileSync(join(out, "server-real-x.log"), serverLog); writeFileSync(join(out, "results-real-x.json"), "{}"); writeFileSync(join(out, "gate-real-x.md"), "# t"); writeFileSync(join(out, "debug", "a.rpc"), "r");
      const failure = '{"outcome":"turn.failed","error":"fixture failure"}\n';
      writeFileSync(join(out, "failed-turns-real-x.jsonl"), failure);
      const r = keep(out, logs, "real-x-20261024T000000Z");
      expect(r.status).toBe(0);
      for (const f of ["server-real-x.log", "failed-turns-real-x.jsonl", "results-real-x.json", "gate-real-x.md", "debug/a.rpc"]) expect(existsSync(join(logs, "real-x-20261024T000000Z", f))).toBe(true);
      expect(readFileSync(join(logs, "real-x-20261024T000000Z", "failed-turns-real-x.jsonl"), "utf8")).toBe(failure);
      expect(readFileSync(join(out, "failed-turns-real-x.jsonl"), "utf8")).toBe(failure);
      const kept = readFileSync(join(logs, "real-x-20261024T000000Z", "server-real-x.log"), "utf8");
      expect(kept).toBe(scrubAccounting(serverLog));
      expect(kept).not.toMatch(/123|456|777|888|999|666|789|321|654/);
      expect(readFileSync(join(out, "server-real-x.log"), "utf8")).toBe(serverLog);
      expect(readFileSync(join(logs, "real-x-20261024T000000Z", "results-real-x.json"), "utf8")).toBe("{}");
    } finally { removeTempDirSync(t); }
  });
  it("failed server-log filter removes the partial copy, exits nonzero and preserves the original", () => {
    const t = mkdtempSync(join(tmpdir(), "keeper-test-")), out = join(t, "out"), logs = join(t, "logs"), bin = join(t, "bin");
    try {
      mkdirSync(out); mkdirSync(bin);
      writeFileSync(join(out, "server-test.log"), "tokensIn=123 tokensOut=456\n");
      writeFileSync(join(out, "failed-turns-test.jsonl"), "{not JSON}\n");
      const r = spawnSync("bash", [join(HERE, "keep-logs.sh"), out, logs, "failed-filter", process.execPath],
        { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(r.status).toBe(4);
      expect(existsSync(join(logs, "failed-filter", "server-test.log"))).toBe(false);
      expect(readdirSync(logs)).toEqual([]); // no published dir and no private temporary archive left behind
      expect(readFileSync(join(out, "server-test.log"), "utf8")).toBe("tokensIn=123 tokensOut=456\n");
    } finally { removeTempDirSync(t); }
  });
  it("fails without a server log (so the launcher keeps its working copy), and refuses a run id that is a path", () => {
    const t = mkdtempSync(join(tmpdir(), "keeper-test-"));
    try {
      mkdirSync(join(t, "out"));
      expect(keep(join(t, "out"), join(t, "logs"), "r1").status).toBe(3);
      expect(keep(join(t, "out"), join(t, "logs"), "../x").status).toBe(2);
    } finally { removeTempDirSync(t); }
  });
  it("both launchers keep the log before they delete the data copy, and the real leg keeps an earlier run's out dir before clearing it", () => {
    const real = readFileSync(join(HERE, "real-smooth.sh"), "utf8"), hz = readFileSync(join(HERE, "hz-smooth.sh"), "utf8");
    const keepAt = real.indexOf('if bash "$KEEP" "$R/out" "$LOGS" "$RUN_ID" "$R/node/bin/node"; then rm -rf'), orphanAt = real.indexOf('"orphan-$RUN_ID"'), clearAt = real.indexOf('rm -rf -- "${R:?}/data" "${R:?}/out/"*');
    expect(keepAt).toBeGreaterThan(0); expect(orphanAt).toBeGreaterThan(0); expect(orphanAt).toBeLessThan(clearAt);
    expect(real.slice(clearAt + 10).includes('rm -rf -- /tmp/smooth-ctl-real/prompts "${R:?}/data"; else')).toBe(true);
    const follower = readFileSync(join(HERE, "follow-run.sh"), "utf8");
    expect(follower.indexOf("keep-logs.sh")).toBeGreaterThan(0);
    expect(follower.indexOf("keep-logs.sh")).toBeLessThan(follower.indexOf('rm -rf -- "${L:?}/data"'));
    expect(follower.indexOf("keep-logs.sh")).toBeLessThan(follower.indexOf("docker rm"));
    // the previous run is preserved by the staged keeper (stage-keeper.sh archives server logs AND journals through keep-logs.sh)
    const orphan = hz.indexOf("keeper archive");
    expect(orphan).toBeGreaterThan(0);
    expect(orphan).toBeLessThan(hz.indexOf("find $L/src"));
    expect(orphan).toBeLessThan(hz.indexOf('rm -rf -- "\\${L:?}/data"'));
    expect(readFileSync(join(HERE, "stage-keeper.sh"), "utf8")).toContain('"$stage/view"/failed-turns-*.jsonl');
    expect(real.slice(0, clearAt)).toContain('"$R/out"/failed-turns-*.jsonl');
  });
});

describe("rig v3 telemetry: reads high, never low, an unreadable tick is never a zero", () => {
  const st = v => ({ n: v.length, max: v.length ? Math.max(...v) : null });
  const full = (from, n, extra) => Array.from({ length: n }, (_, i) => ({ t: from + i * 1000, ...extra }));
  it("reads the cgroup v2 path and refuses anything else", () => {
    expect(cgroupPathOf("0::/user.slice/user-1000.slice/session-5.scope\n")).toBe("/user.slice/user-1000.slice/session-5.scope");
    expect(cgroupPathOf("0::/\n")).toBe("/");
    expect(cgroupPathOf("12:cpu:/x\n")).toBeNull();
    expect(cgroupPathOf("0::/../../etc\n")).toBeNull();
    expect(cgroupPathOf(undefined)).toBeNull();
  });
  it("reads cgroup counters, null when unreadable, never 0", () => {
    expect(cgroupCpuUsec("usage_usec 1500000\nuser_usec 1\n")).toBe(1500000);
    expect(cgroupCpuUsec("user_usec 1\n")).toBeNull();
    expect(cgroupMemMb("1048576\n")).toBe(1);
    expect(cgroupMemMb("max\n")).toBeNull();
    expect(cgroupMemMb("")).toBeNull();
  });
  it("gives cores from a cumulative counter in the right unit, null when it runs backwards", () => {
    expect(coresBetween({ t: 0, cpuS: 1 }, { t: 2000, cpuS: 2 })).toBe(0.5);
    expect(coresBetween({ t: 0, cpuS: 2 }, { t: 1000, cpuS: 1 })).toBeNull();
    expect(coresBetween({ t: 5, cpuS: 1 }, { t: 5, cpuS: 2 })).toBeNull();
  });
  it("reads whole-box cores from a macOS top line", () => {
    expect(coresFromTopLine("CPU usage: 1.25% user, 1.25% sys, 97.50% idle", 8)).toBe(0.2);
    expect(coresFromTopLine("CPU usage: junk", 8)).toBeNull();
    expect(coresFromTopLine("", 8)).toBeNull();
  });
  it("sums only the leg user's processes born at or after the stamp's second, with a space in the name", () => {
    const stampMs = new Date(2026, 10, 6, 16, 21, 14, 700).getTime();
    const rows = macTable(["  10  501 Fri Nov  6 16:21:13 2026 102400 /bin/old", "  11  501 Fri Nov  6 16:21:14 2026 102400 /bin/same second", "  12    0 Fri Nov  6 16:30:00 2026 102400 /usr/libexec/daemon", "  13  501 Fri Nov  6 16:30:00 2026 51200 /Apps/My App/x"].join("\n"));
    expect(rows.length).toBe(4);
    expect(legRss(rows, { uid: 501, stampMs })).toEqual({ rss: 150, procs: 2 });
  });
  it("an unreadable row or empty table makes the whole tick unreadable, never a smaller sum", () => {
    expect(macTable("  10  501 Fri Nov  6 16:21:13 2026 102400 /bin/x\n  11  501 ??? 5 /bin/y")).toBeNull();
    expect(macTable("")).toBeNull();
    expect(legRss(null, { uid: 501, stampMs: 0 })).toBeNull();
  });
  it("finds a leftover server or engine of the leg user, not the runner, another user's or an unrelated app", () => {
    const stampMs = new Date(2026, 10, 6, 16, 21, 14).getTime();
    const rows = macTable(["  10  501 Fri Nov  6 16:00:00 2026 1 /opt/homebrew/bin/node", "  11  501 Fri Nov  6 16:00:00 2026 1 /Users/x/gate/npm/bin/claude", "  12  501 Fri Nov  6 16:00:00 2026 1 /Applications/Safari.app/Contents/MacOS/Safari", "  13    0 Fri Nov  6 16:00:00 2026 1 /usr/bin/codex", "  14  501 Fri Nov  6 16:30:00 2026 1 /usr/bin/fuigo"].join("\n"));
    expect(leftovers(rows, { uid: 501, stampMs, selfPid: 10 })).toEqual([{ pid: 11, name: "claude" }]);
    expect(leftoverNames(["powershell", "Claude.exe", "explorer"])).toEqual(["claude"]);
  });
  it("S9.cpuTree sums every process of the Murage tree: server, workers, Electron main and renderers, engine children", () => {
    const stampMs = new Date(2026, 10, 6, 16, 21, 14).getTime();
    const table = macTable([
      "  10  501 Fri Nov  6 16:00:00 2026 1 /opt/homebrew/bin/node",
      "  20  501 Fri Nov  6 16:21:14 2026 1 /app/Murage.app/Contents/MacOS/Murage",
      "  21  501 Fri Nov  6 16:21:15 2026 1 /app/Murage Helper (Renderer)",
      "  22  501 Fri Nov  6 16:21:15 2026 1 /app/Murage Helper (Renderer)",
      "  23  501 Fri Nov  6 16:21:16 2026 1 /usr/local/bin/node",
      "  24  501 Fri Nov  6 16:21:17 2026 1 /usr/local/bin/node",
      "  25  501 Fri Nov  6 16:21:18 2026 1 /gate/npm/bin/claude",
      "  30  501 Fri Nov  6 16:21:19 2026 1 /Users/x/rig/node",
      "  40  502 Fri Nov  6 16:21:20 2026 1 /usr/libexec/mediaanalysisd"].join("\n"));
    expect(table).toHaveLength(9);
    const top = ["PID    UID  %CPU", "20 501 1.5", "21 501 2.0", "22 501 0.5", "23 501 3.0", "24 501 1.0", "25 501 2.0", "10 501 40.0", "30 501 9.0", "40 502 80.0", "99 501 0.5"];
    const procs = parseTopProcs(top);
    expect(procs).toHaveLength(10);
    const base = { uid: 501, stampMs, expectedRows: 10, ncpu: 8 };
    // 20..25 are the tree (10.0 percent) and 99 is a pid the table has not seen (0.5, reads high); 10 is older, 30 is telemetry, 40 another user's
    const r = treeCores(procs, table, { ...base, rigPids: [30] });
    expect(r.cores).toBe(0.105);
    // the box beside the tree: 10 (an older node of the user) is other, 40 (another user, an Apple daemon path) is apple
    expect(r.otherCores).toBe(0.4);
    expect(r.appleCores).toBe(0.8);
    expect(Object.keys(r.procCpu)[0]).toBe("apple:mediaanalysisd");
    expect([...r.members.keys()].map(k => k.split(":")[0])).toEqual(["20", "21", "22", "23", "24", "25", "99"]);
    // without the exclusion the rig's own top would count
    expect(treeCores(procs, table, base).cores).toBe(0.195);
    // one process of the tree alone is not the tree
    expect(treeCores(procs.filter(p => p.pid === 23), table, { ...base, expectedRows: 1 }).cores).toBe(0.03);
  });
  it("S9.cpuTree charges a tree member that vanished between samples, by pid and start time, never nothing", () => {
    const stampMs = new Date(2026, 10, 6, 16, 21, 14).getTime();
    const table = macTable("  20  501 Fri Nov  6 16:21:14 2026 1 /app/Murage");
    const born20 = table[0].bornMs;
    const procs = [{ pid: 20, uid: 501, cpu: 1 }];
    const base = { uid: 501, stampMs, expectedRows: 1, ncpu: 4 };
    // pid 77 was in the last sample at 2.5 cores (25000 hundredths of a percent) and is gone: it is charged ITS LAST cpu (2.5 cores), not the whole box
    expect(treeCores(procs, table, { ...base, prev: new Map([["77:123", 25000]]) }).cores).toBe(2.51);
    // a pid still listed with the same start time is not charged
    expect(treeCores(procs, table, { ...base, prev: new Map([[`20:${born20}`, 7700]]) }).cores).toBe(0.01);
    // the same pid with another start time is a different process: the old one is gone and charged (a reused pid hides nothing)
    expect(treeCores(procs, table, { ...base, prev: new Map([["20:1", 300]]) }).cores).toBe(0.04);
  });
  it("S9.cpuTree is no reading when a sample cannot be trusted, never a low one", () => {
    const stampMs = new Date(2026, 10, 6, 16, 21, 14).getTime();
    const table = macTable("  20  501 Fri Nov  6 16:21:14 2026 1 /app/Murage");
    const one = [{ pid: 20, uid: 501, cpu: 1 }];
    expect(parseTopProcs(["PID UID %CPU", "20 501 garbled"])).toBeNull();
    expect(parseTopProcs(["PID UID %CPU", "20 501"])).toBeNull();
    expect(parseTopProcs(["PID UID %CPU"])).toBeNull();
    expect(treeCores(null, table, { uid: 501, stampMs, expectedRows: 1 })).toBeNull();
    expect(treeCores(one, null, { uid: 501, stampMs, expectedRows: 1 })).toBeNull();
    // top said 3 processes and only 1 row arrived (a partial or cut sample), or the count is unknown
    expect(treeCores(one, table, { uid: 501, stampMs, expectedRows: 3 })).toBeNull();
    expect(treeCores(one, table, { uid: 501, stampMs })).toBeNull();
  });
  it("S9.cpuTree is judged on macOS legs only, beside S9.cpu and never in its place", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const rows = budgets.rows.filter(r => r.id.startsWith("S9.cpu"));
    expect(rows.map(r => [r.id, r.path, r.op, r.value])).toEqual([["S9.cpu", "scenarios.idle.cpu.p90", "<=", 0.25], ["S9.cpuTree", "scenarios.idle.cpuTree.p90", "<=", 0.25]]);
    const tree = rows[1];
    // JUDGED on macOS (Sean 11-08): over the bound fails, at or under passes
    expect(tree.reportOnly).toBeUndefined();
    const mac = judgeRow(tree, { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: { cpuTree: { p90: 0.3 } } } });
    expect(mac).toMatchObject({ pass: false, value: 0.3 });
    expect(judgeRow(tree, { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: { cpuTree: { p90: 0.2 } } } }).pass).toBe(true);
    // a Mac leg that did not measure the tree is not measured and not green
    const missing = judgeRow(tree, { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: {} } });
    expect(missing).toMatchObject({ pass: false, missing: true });
    const linux = judgeRow(tree, { telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: {} } });
    expect(linux).toMatchObject({ pass: true, notApplicable: true });
    // the samples: a window with treeCores reports cpuTree, a window without keeps its old shape
    const w = sampleWindow([{ t: 1000, cores: 0.1, rss: 5, treeCores: 0.05, load1: 0.5 }, { t: 2000, cores: 0.1, rss: 5, treeCores: 0.07, load1: 0.5 }], 1000, 2000, statsOf);
    expect(w.cpuTree.p90).toBeCloseTo(0.07, 5);
    expect(w.telemetry.cpuTree.ok).toBe(true);
    expect(sampleWindow([{ t: 1000, cores: 0.1, rss: 5 }], 1000, 1000, statsOf)).not.toHaveProperty("cpuTree");
  });
  const MAC_TOP_SAMPLE = (total, stamp, rows) => ["Processes: " + total + " total, 2 running, " + (total - 2) + " sleeping, 21 threads ", stamp, "Load Avg: 1.52, 1.64, 1.60 ", "CPU usage: 3.12% user, 4.54% sys, 92.33% idle ", "SharedLibs: 612M resident, 109M data, 54M linkedit.", "MemRegions: 57433 total, 3042M resident, 128M private, 1021M shared.", "PhysMem: 15G used (2204M wired, 0B compressor), 949M unused.", "VM: 148T vsize, 4151M framework vsize, 0(0) swapins, 0(0) swapouts.", "Networks: packets: 12/7K in, 11/5K out.", "Disks: 25K/1M read, 3K/60K written.", "", "PID    UID  %CPU ", ...rows, ""];
  const runStream = lines => { const out = []; const c = topSampleCollector(b => out.push(b)); for (const l of lines) c.line(l); return { out, cut: c.end() }; };
  it("S9.cpuTree reads a real macOS top -l stream: the timestamp line after Processes: never nulls a sample", () => {
    const stream = [
      ...MAC_TOP_SAMPLE(4, "2026/11/08 03:05:44", ["1 0 9.0", "20 501 1.0", "21 501 2.0", "40 502 30.0"]),
      ...MAC_TOP_SAMPLE(4, "2026/11/08 03:05:45", ["1 0 8.0", "20 501 1.5", "21 501 2.5", "40 502 20.0"]),
      ...MAC_TOP_SAMPLE(4, "2026/11/08 03:05:46", ["1 0 7.0", "20 501 1.0", "21 501 2.0", "40 502 10.0"]),
    ];
    const { out, cut } = runStream(stream);
    // a sample closes only when the next one starts: three samples in, two out, the third is cut off at top exit
    expect(out).toHaveLength(2);
    expect(cut).toBe(true);
    for (const b of out) { expect(b.total).toBe(4); expect(b.lines).toHaveLength(5); expect(parseTopProcs(b.lines)).toHaveLength(4); }
    const stampMs = new Date(2026, 10, 8, 3, 5, 0).getTime();
    const table = macTable(["  1    0 Sun Nov  8 02:00:00 2026 1 /sbin/launchd", "  20  501 Sun Nov  8 03:05:10 2026 1 /app/Murage", "  21  501 Sun Nov  8 03:05:11 2026 1 /app/Murage Helper", "  40  502 Sun Nov  8 02:00:00 2026 1 /usr/libexec/mediaanalysisd"].join("\n"));
    const r = treeCores(parseTopProcs(out[1].lines), table, { uid: 501, stampMs, expectedRows: out[1].total, ncpu: 8 });
    expect(r).not.toBeNull();
    expect(r.cores).toBe(0.04);
    expect(r.appleCores).toBe(0.28);
  });
  it("S9.cpuTree does not charge the rig own process as a vanished member: rig pids are out by recorded pid, not by name", () => {
    const stampMs = new Date(2026, 10, 8, 3, 5, 0).getTime();
    const t1 = macTable(["  20  501 Sun Nov  8 03:05:10 2026 1 /app/Murage", "  50  501 Sun Nov  8 03:05:20 2026 1 /bin/ps"].join("\n"));
    const t2 = macTable("  20  501 Sun Nov  8 03:05:10 2026 1 /app/Murage");
    const k = treeCores([{ pid: 20, uid: 501, cpu: 1 }, { pid: 50, uid: 501, cpu: 5 }], t1, { uid: 501, stampMs, rigPids: [50], expectedRows: 2, ncpu: 8 });
    expect(k.cores).toBe(0.01);
    expect([...k.members.keys()].map(m => m.split(":")[0])).toEqual(["20"]);
    // the next sample: the short-lived rig ps is gone, and nothing is charged for it
    expect(treeCores([{ pid: 20, uid: 501, cpu: 1 }], t2, { uid: 501, stampMs, rigPids: [50], expectedRows: 1, ncpu: 8, prev: k.members }).cores).toBe(0.01);
    // the rig node itself and a rig child with a name that is not a ps are out too; by pid, a Murage ps-named process is still counted
    const t3 = macTable(["  20  501 Sun Nov  8 03:05:10 2026 1 /app/ps", "  60  501 Sun Nov  8 03:05:21 2026 1 /usr/local/bin/node"].join("\n"));
    expect(treeCores([{ pid: 20, uid: 501, cpu: 1 }, { pid: 60, uid: 501, cpu: 4 }], t3, { uid: 501, stampMs, rigPids: [60], expectedRows: 2 }).cores).toBe(0.01);
    // a previous member whose start time was unknown matches by pid alone, not a vanished charge
    expect(treeCores([{ pid: 20, uid: 501, cpu: 1 }], t2, { uid: 501, stampMs, expectedRows: 1, ncpu: 8, prev: new Map([["20:?", 500]]) }).cores).toBe(0.01);
  });
  it("S9.cpuTree: Spotlight mdworker_shared run as the leg user after the stamp is apple, never murage, and is never charged as a vanished member", () => {
    const stampMs = new Date(2026, 10, 8, 3, 5, 0).getTime();
    const t1 = macTable(["  20  501 Sun Nov  8 03:05:10 2026 1 /app/Murage", "  70  501 Sun Nov  8 03:05:20 2026 1 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared"].join("\n"));
    const k = treeCores([{ pid: 20, uid: 501, cpu: 1 }, { pid: 70, uid: 501, cpu: 50 }], t1, { uid: 501, stampMs, expectedRows: 2, ncpu: 8 });
    expect(k.cores).toBe(0.01);
    expect(k.appleCores).toBe(0.5);
    expect(Object.keys(k.procCpu)[0]).toBe("apple:mdworker_shared");
    const t2 = macTable("  20  501 Sun Nov  8 03:05:10 2026 1 /app/Murage");
    expect(treeCores([{ pid: 20, uid: 501, cpu: 1 }], t2, { uid: 501, stampMs, expectedRows: 1, ncpu: 8, prev: k.members }).cores).toBe(0.01);
  });
  it("S9.cpuTree reads a REAL captured macOS top -l 3 stream and ps table (EC2 Mac, macOS 15.8 arm64, 2026-11-08 07:56Z, unedited)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mac-top");
    const raw = readFileSync(join(dir, "top-raw.txt"), "utf8").split("\n");
    expect(raw.filter(l => /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(l))).toHaveLength(3); // the timestamp line that nulled every sample
    const { out, cut } = runStream(raw);
    expect(out).toHaveLength(2); // a sample closes on the next one; the third is cut off at top exit
    expect(cut).toBe(true);
    for (const b of out) { expect(b.total).toBeGreaterThan(500); expect(parseTopProcs(b.lines)).toHaveLength(b.total); }
    const table = macTable(readFileSync(join(dir, "ps-raw.txt"), "utf8"));
    expect(table).not.toBeNull();
    expect(table.every(r => Number.isInteger(r.ppid))).toBe(true);
    const stampMs = Date.parse("2026-11-08T07:57:00Z");
    const r = treeCores(parseTopProcs(out[1].lines), table, { uid: 501, stampMs, expectedRows: out[1].total, rigPids: [] });
    expect(r).not.toBeNull();
    expect(r.appleCores).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.cores + r.appleCores + r.otherCores)).toBe(true);
    // a count that is not top own total is no reading, on the real rows too
    expect(treeCores(parseTopProcs(out[1].lines), table, { uid: 501, stampMs, expectedRows: out[1].total - 1 })).toBeNull();
  });
  it("S9.cpuTree box-quiet preflight: a loud or unknown box is not measured, never a reading", () => {
    const q = (loads) => loads.map((l, i) => ({ t: 1000 * (i + 1), cores: 0.1, rss: 5, treeCores: 0.05, load1: l }));
    expect(boxQuiet(q([0.4, 0.8, 1.9]), 1000, 3000)).toMatchObject({ quiet: true, maxLoad1: 1.9, n: 3, bound: 2 });
    expect(boxQuiet(q([0.4, 2, 0.5]), 1000, 3000).quiet).toBe(false);
    expect(boxQuiet(q([0.4, NaN, 0.5]), 1000, 3000).quiet).toBe(false);
    expect(boxQuiet([{ t: 1000, treeCores: 0.05 }], 1000, 1000).quiet).toBe(false);
    // one low reading does not qualify a window whose load telemetry is otherwise missing
    expect(boxQuiet([{ t: 1000, load1: 0.1 }], 1000, 9000).quiet).toBe(false);
    expect(boxQuiet([{ t: 1000, load1: 0.1 }, { t: 2000, load1: 0.1 }, { t: 9000, load1: 0.1 }], 1000, 9000).quiet).toBe(false);
    const loud = sampleWindow(q([0.4, 12.9, 0.5]), 1000, 3000, statsOf);
    expect(loud.boxQuiet.quiet).toBe(false);
    expect(loud.cpuTree.p90 ?? null).toBeNull();
    expect(loud.telemetry.cpuTree.ok).toBe(false);
    expect(loud.attribution.boxQuiet).toBe(false);
    const quiet = sampleWindow(q([0.4, 0.5, 0.5]), 1000, 3000, statsOf);
    expect(quiet.cpuTree.p90).toBeCloseTo(0.05, 5);
    expect(judgeRow(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8")).rows.find(r => r.id === "S9.cpuTree"), { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: loud } })).toMatchObject({ pass: false, missing: true });
  });
  it("S9.cpuTree: a duplicate pid is no sample, and an invalid scenario fails the judged row as every other row of it", () => {
    expect(parseTopProcs(["PID UID %CPU", "20 501 1.0", "20 501 2.0"])).toBeNull();
    expect(parseTopProcs(["PID UID %CPU", "20 501 1.0", "21 501 2.0"])).toHaveLength(2);
    const row = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8")).rows.find(r => r.id === "S9.cpuTree");
    expect(judgeRow(row, { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: { invalid: "room did not settle" } } })).toMatchObject({ pass: false, missing: true, invalid: "room did not settle" });
    expect(judgeRow({ id: "S9.cpu", scenario: "idle", path: "scenarios.idle.cpu.p90", op: "<=", value: 0.25 }, { scenarios: { idle: { invalid: "x" } } }).pass).toBe(false);
  });
  it("every result file records the rig commit and the Spotlight state", () => {
    const sha = "d6fbd7a2b21cc6af3bbe96605d7f22fe0f6d834b";
    expect(rigProvenance({ env: { RIG_SHA: sha }, platform: "darwin", git: () => { throw new Error("no git"); }, mdutil: () => "/:\n\tIndexing enabled. \n" })).toEqual({ rigSha: sha, spotlight: "/: Indexing enabled." });
    expect(rigProvenance({ env: {}, platform: "darwin", git: () => sha + "\n", mdutil: () => "Indexing disabled." })).toEqual({ rigSha: sha, spotlight: "Indexing disabled." });
    // unknown stays null, never invented; a failing mdutil is unreadable; other platforms record no Spotlight
    expect(rigProvenance({ env: { RIG_SHA: "nothex" }, platform: "linux", git: () => "fatal: not a git repository" })).toEqual({ rigSha: null, spotlight: null });
    expect(rigProvenance({ env: {}, platform: "darwin", git: () => null, mdutil: () => { throw new Error("x"); } })).toEqual({ rigSha: null, spotlight: "unreadable" });
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "smooth.mjs"), "utf8");
    expect(src).toContain("Object.assign(R, rigProvenance(");
  });
  it("S9.cpuTree lineage: a child of a Murage root that execs an Apple path stays murage, an unrelated Apple process stays apple", () => {
    const stampMs = new Date(2026, 10, 8, 3, 5, 0).getTime();
    const table = macTable(["  1     0    0 Sun Nov  8 02:00:00 2026 1 /sbin/launchd", "  20    1  501 Sun Nov  8 03:05:10 2026 1 /app/Murage", "  30   20  501 Sun Nov  8 03:05:20 2026 1 /bin/zsh", "  31   30  501 Sun Nov  8 03:05:21 2026 1 /usr/bin/security", "  70    1  501 Sun Nov  8 03:05:22 2026 1 /usr/libexec/mdworker_shared", "  71    1  501 Sun Nov  8 03:05:22 2026 1 /bin/zsh"].join("\n"));
    const procs = [{ pid: 20, uid: 501, cpu: 1 }, { pid: 30, uid: 501, cpu: 2 }, { pid: 31, uid: 501, cpu: 3 }, { pid: 70, uid: 501, cpu: 50 }, { pid: 71, uid: 501, cpu: 4 }];
    const r = treeCores(procs, table, { uid: 501, stampMs, expectedRows: 5 });
    expect(r.cores).toBe(0.06);
    expect(r.appleCores).toBe(0.54);
    expect(Object.keys(r.procCpu)).toContain("murage:zsh");
    expect(Object.keys(r.procCpu)).toContain("apple:zsh");
    expect(macTable("  10  501 Fri Nov  6 16:00:00 2026 1 /x")[0]).not.toHaveProperty("ppid");
    expect(macTable("  10   4  501 Fri Nov  6 16:00:00 2026 1 /x")[0]).toMatchObject({ pid: 10, ppid: 4, uid: 501 });
  });
  it("S9.cpuTree lineage does not cross a rig pid: an Apple child of a rig process under a Murage root is not murage", () => {
    const stampMs = new Date(2026, 10, 8, 3, 5, 0).getTime();
    const table = macTable(["  1     0    0 Sun Nov  8 02:00:00 2026 1 /sbin/launchd", "  20    1  501 Sun Nov  8 03:05:10 2026 1 /app/Murage", "  50   20  501 Sun Nov  8 03:05:20 2026 1 /usr/local/bin/node", "  51   50  501 Sun Nov  8 03:05:21 2026 1 /bin/ps"].join("\n"));
    const procs = [{ pid: 20, uid: 501, cpu: 1 }, { pid: 51, uid: 501, cpu: 5 }];
    // 50 is a recorded rig pid (it is not listed by top here); its child 51 is an Apple path under it, not under Murage by lineage
    const r = treeCores(procs, table, { uid: 501, stampMs, rigPids: [50], expectedRows: 2 });
    expect(r.cores).toBe(0.01);
    expect(r.appleCores).toBe(0.05);
    expect(Object.keys(r.procCpu)).toContain("apple:ps");
  });
  it("the rig pid tracker keeps a released pid for the grace period, then drops it so a reused pid is a real child again", () => {
    const timers = []; const tr = rigPidTracker({ graceMs: 15000, timer: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
    tr.add(50); tr.add(51); tr.add(NaN);
    tr.release(50);
    expect(tr.list()).toEqual([50, 51]);
    expect(timers[0].ms).toBe(15000);
    timers[0].fn();
    expect(tr.list()).toEqual([51]);
  });
  it("a Mac leg that starts on a busy box is refused before Murage starts, and the refusal says why", () => {
    expect(preStartBusy(0.4)).toBeNull();
    expect(preStartBusy(1.99)).toBeNull();
    expect(preStartBusy(2)).toBe("not measured: box busy before Murage started, load1 2.00 (needs under 2)");
    expect(preStartBusy(NaN)).toContain("unreadable");
  });
  it("preStartCheck: an idle-only busy start refuses", () => {
    expect(preStartCheck(2.5, ["idle"])).toEqual({ busy: true, refuse: true, reason: "not measured: box busy before Murage started, load1 2.50 (needs under 2)" });
    expect(preStartCheck(NaN, ["idle"])).toMatchObject({ busy: true, refuse: true });
    expect(preStartCheck(2.5, [])).toMatchObject({ busy: true, refuse: false });
    expect(preStartCheck(2.5, undefined)).toMatchObject({ busy: true, refuse: false });
  });
  it("preStartCheck: a non-idle busy start runs and is flagged, not refused", () => {
    expect(preStartCheck(2.5, ["boot", "idle"])).toMatchObject({ busy: true, refuse: false });
    expect(preStartCheck(3, ["boot"])).toMatchObject({ busy: true, refuse: false });
    expect(preStartCheck(NaN, ["routineBurst"])).toMatchObject({ busy: true, refuse: false });
  });
  it("preStartCheck: a quiet start is neither busy nor refused", () => {
    expect(preStartCheck(0.4, ["idle"])).toEqual({ busy: false, refuse: false, reason: null });
    expect(preStartCheck(1.99, ["boot", "idle"])).toEqual({ busy: false, refuse: false, reason: null });
  });
  it("a busy start makes S9.cpu and the latency rows not measured, while the io rows stay measured", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const row = id => budgets.rows.find(r => r.id === id);
    const res = busy => ({ telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, boxBusyAtStart: busy, env: { engineExclusion: { verdict: "ok" } }, scenarios: { idle: { cpu: { p90: 0.1 }, ioBudget: 0 }, boot: { healthy: { p90: 100 } } }, all: { ioWrite: { mb: 5 } } });
    expect(row("S9.cpu").value).toBe(0.25);
    expect(judgeRow(row("S9.cpu"), res(true))).toMatchObject({ pass: true, reportOnly: true, wouldPass: true, value: 0.1, what: "whole machine, info only (macOS)" }); // macOS: info only, never judged
    expect(judgeRow(row("S0.boot"), res(true))).toMatchObject({ pass: false, missing: true, busyAtStart: true, value: null });
    expect(judgeRow(row("S9.io"), res(true))).toMatchObject({ pass: true, value: 0 });
    expect(judgeRow(row("ALL.ioMB"), res(true))).toMatchObject({ pass: true, value: 5 });
    expect(judgeRow(row("S9.cpu"), res(false))).toMatchObject({ pass: true, value: 0.1 });
    expect(judgeRow(row("S0.boot"), res(false))).toMatchObject({ pass: true, value: 100 });
    expect(judgeRow(row("S0.boot"), { ...res(false), scenarios: { boot: { healthy: { p90: 99999 } } } })).toMatchObject({ pass: false, value: 99999 }); // a quiet start still judges a real latency failure
    expect(judgeRow(row("S9.cpu"), { ...res(false), scenarios: { idle: { cpu: { p90: 0.9 } } } })).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, value: 0.9 }); // macOS info only
    expect(judgeRow(row("S9.cpu"), { ...res(false), telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { cpu: { p90: 0.9 } } } })).toMatchObject({ pass: false, value: 0.9 }); // Linux still judges
  });
  it("the busy-start load is read once, before the stamp and before any sample, from the scenario list and never from an env switch", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "smooth.mjs"), "utf8");
    const fn = src.slice(src.indexOf("async function macTelemetry()"), src.indexOf("function startTelemetry()"));
    const stampLine = src.split("\n").find(l => l.includes("const PRE_START_LOAD1")) ?? "";
    expect(stampLine).toContain("PRE_START_LOAD1 = loadavg()[0], STAMP_MS = Date.now()"); // the load is read first, then the stamp
    expect(src.split("\n").filter(l => l.includes("PRE_START_LOAD1") && l.includes("loadavg")).length).toBe(1);
    expect(fn).not.toContain("loadavg()[0], ["); // no second read of the load feeds the check
    const at = fn.indexOf("preStartCheck(PRE_START_LOAD1, [...SCEN])");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(fn.indexOf('spawn("top"'));
    expect(at).toBeLessThan(fn.indexOf("samples.push"));
    expect(fn.split("boxBusyAtStart:").length - 1).toBe(1);
    expect(fn).toContain("boxBusyAtStart: start.busy");
    expect(fn.split("\n").find(l => l.includes("preStartCheck(")) ?? "").not.toContain("process.env");
    expect(src).not.toMatch(/boxBusyAtStart\s*[:=][^\n]*(loadavg|process\.env)/);
  });
  it("a busy start never leaves S9.cpuTree green: no tree reading is no pass (macOS judged row)", () => {
    const row = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8")).rows.find(r => r.id === "S9.cpuTree");
    const j = judgeRow(row, { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, boxBusyAtStart: true, scenarios: { idle: { cpu: { p90: 0 } } } });
    expect(j.pass).toBe(false);
    expect(j.value).toBeNull();
  });
  it("ELD: a log that stops before the window's end, or starts late while the server was up, is not a measurement", () => {
    const l = (t, max) => `[eld] t=${t} p50=1 p99=2 max=${max}\n`;
    const full = [1000, 2000, 3000, 4000, 5000].map(t => l(t, 5)).join("");
    expect(measuredEld(full, 0, 6000, statsOf)).toMatchObject({ max: 5, secondsOver250: 0 });
    expect(measuredEld(full, 0, 60000, statsOf)).toMatchObject({ max: null, secondsOver250: null, coverageGap: true });
    expect(measuredEld(full, 20000, 6000, statsOf, [], { head: true }).coverageGap).toBe(true);
    expect(measuredEld(full, -9000, 6000, statsOf, [], { head: true })).toMatchObject({ coverageGap: true });
    expect(measuredEld(full, -9000, 6000, statsOf)).toMatchObject({ max: 5 }); // from run start: the server was not up yet
    expect(measuredEld("", 0, 6000, statsOf).coverageGap).toBe(true);
  });
  it("a Mac leg without the verified engine-exclusion addon reads io rows not measured: osBytes unknown, never a pass", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const row = id => budgets.rows.find(r => r.id === id);
    const res = verdict => ({ telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, ...(verdict ? { env: { engineExclusion: { verdict } } } : {}), scenarios: { idle: { ioBudget: 0 } }, all: { ioWrite: { mb: 5, lines: 2, peak: 3 } } });
    // the four disk-write rows are report-only in 1.0.18 (IO-AMP moved to 1.0.19, Sean 11-08): unknown bytes are shown, never a fail
    for (const id of ["S9.io", "ALL.ioMB", "ALL.io", "ALL.ioPeak"]) {
      expect(judgeRow(row(id), res("absent")), id).toMatchObject({ pass: true, value: null, osBytesUnknown: true, reportOnly: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
      expect(judgeRow(row(id), res(undefined)), id).toMatchObject({ pass: true, osBytesUnknown: true, reportOnly: true });
      expect(judgeRow(row(id), res("ok")).osBytesUnknown, id).toBeUndefined();
    }
    expect(judgeRow(row("S9.io"), res("ok"))).toMatchObject({ pass: true, value: 0 });
    expect(judgeRow(row("ALL.ioMB"), { ...res("ok"), all: { ioWrite: { mb: 90 } } })).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, value: 90 });
    expect(judgeRow(row("S9.io"), { ...res("absent"), telemetryMode: { mode: "linux-cgroup" } })).toMatchObject({ pass: true });
    expect(table(judge(budgets, res("absent")), "t").split("\n").filter(x => x.includes("not measured: osBytes unknown")).length).toBeGreaterThan(0);
  });
  it("ALL.io is report-only in 1.0.18 with the bound kept at 8 and the marker (gates in 1.0.19)", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const row = budgets.rows.find(r => r.id === "ALL.io");
    expect(row).toMatchObject({ op: "<=", value: 8, reportOnly: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    const res = lines => ({ env: { engineExclusion: { verdict: "ok" } }, telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, all: { ioWrite: { lines } } });
    expect(judgeRow(row, res(8))).toMatchObject({ pass: true, reportOnly: true, wouldPass: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    expect(judgeRow(row, res(9))).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
  });
  it("ALL.ioPeak is report-only in 1.0.18 with the bound kept at 60 MB/min and the marker (gates in 1.0.19)", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const row = budgets.rows.find(r => r.id === "ALL.ioPeak");
    expect(row).toMatchObject({ op: "<=", value: 60, path: "all.ioWrite.peak", reportOnly: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    const res = peak => ({ env: { engineExclusion: { verdict: "ok" } }, telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, all: { ioWrite: { peak } } });
    expect(judgeRow(row, res(60))).toMatchObject({ pass: true, reportOnly: true, wouldPass: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    expect(judgeRow(row, res(70.9))).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, value: 70.9, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
  });
  it("the report-only io rows carry the 1.0.19 marker in the table and the verdict JSON; every other io row still gates", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    expect(budgets.rows.filter(r => r.reportOnly === true && /^(ALL|S9)\.io/.test(r.id)).map(r => r.id).sort()).toEqual(["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]);
    expect(budgets.rows.filter(r => r.gatesIn).map(r => r.id).sort()).toEqual(["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]);
    expect(budgets.rows.filter(r => r.reportOnly === true && !r.macOnly).map(r => r.id).sort()).toEqual(["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]);
    for (const id of ["S9.cpu", "S9.rss", "ALL.eld", "ALL.eld250"]) expect(budgets.rows.find(r => r.id === id).reportOnly, id).toBeUndefined();
    for (const id of ["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]) expect(budgets.rows.find(r => r.id === id).value, id).toBe({ "ALL.io": 8, "ALL.ioMB": 80, "ALL.ioPeak": 60, "S9.io": 0 }[id]);
    const res = { env: { engineExclusion: { verdict: "ok" } }, telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { ioBudget: 1 } }, all: { ioWrite: { mb: 127, lines: 12, peak: 70 } } };
    const j = judge(budgets, res);
    expect(table(j, "t").split("\n").filter(x => x.includes("gates in 1.0.19 (IO-AMP, Sean 11-08)")).length).toBe(4);
    const v = verdictOf({ tree: "t", idle: j, loaded: null });
    for (const id of ["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]) expect(v.rows[id], id).toMatchObject({ pass: true, reportOnly: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    // the loaded run carries the same marker: an over-bound loaded value is never an unqualified pass (Astra 905f77eee Medium)
    const vl = verdictOf({ tree: "t", idle: j, loaded: judge(budgets, { ...res, load: true }) });
    for (const id of ["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"]) expect(vl.rows[id + "@load"], id).toMatchObject({ pass: true, reportOnly: true, gatesIn: "gates in 1.0.19 (IO-AMP, Sean 11-08)" });
    expect(vl.rows["S9.cpu@load"]?.reportOnly).toBeUndefined();
  });
  it("the four gatesIn rows are decided before every other branch: a null or absent value, an invalid scenario or unknown bytes never fail them, idle and loaded, and every gating row still fails", () => {
    const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
    const four = ["ALL.io", "ALL.ioMB", "ALL.ioPeak", "S9.io"], MARK = "gates in 1.0.19 (IO-AMP, Sean 11-08)";
    const shapes = {
      "ioBudget null (a >3 s idle poll gap) and all.ioWrite absent": { env: { engineExclusion: { verdict: "ok" } }, telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { ioBudget: null } }, all: {} },
      "no scenarios and no all": { telemetryMode: { mode: "linux-cgroup" } },
      "idle scenario invalid": { env: { engineExclusion: { verdict: "ok" } }, telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { ioBudget: 5, invalid: "poll gap" } }, all: { ioWrite: { mb: 500, lines: 50, peak: 900 } } },
      "mac, unknown bytes, null values": { telemetryMode: { mode: "mac-wholebox-cpu+leg-user-rss" }, scenarios: { idle: { ioBudget: null } }, all: {} },
    };
    for (const [name, res] of Object.entries(shapes)) for (const loaded of [false, true]) {
      const j = judge(budgets, loaded ? { ...res, load: true } : res);
      for (const id of four) expect(j.rows.find(r => r.id === id), `${name} ${loaded ? "loaded" : "idle"} ${id}`).toMatchObject({ pass: true, reportOnly: true, gatesIn: MARK });
      const v = verdictOf({ tree: "t", idle: judge(budgets, res), loaded: loaded ? j : null });
      for (const id of four) expect(v.rows[loaded ? id + "@load" : id], `${name} ${id} verdict`).toMatchObject({ pass: true, reportOnly: true, gatesIn: MARK });
      expect(j.rows.filter(r => !four.includes(r.id) && r.reportOnly !== true).every(r => r.pass === true || r.pass === false)).toBe(true);
    }
    const invalid = judge(budgets, shapes["idle scenario invalid"]);
    expect(invalid.rows.find(r => r.id === "S9.cpu")).toMatchObject({ pass: false, invalid: "poll gap" });
    expect(invalid.rows.find(r => r.id === "S9.io")).toMatchObject({ pass: true, value: null, invalid: "poll gap", gatesIn: MARK });
    expect(invalid.pass).toBe(false);
    expect(judge(budgets, shapes["ioBudget null (a >3 s idle poll gap) and all.ioWrite absent"]).rows.find(r => r.id === "S9.cpu").pass).toBe(false);
  });
  it("the verdict JSON rows carry the busyAtStart and osBytesUnknown markers", () => {
    const v = verdictOf({ tree: "t", idle: { pass: false, rows: [{ id: "A", value: null, pass: false, busyAtStart: true }, { id: "B", value: null, pass: false, osBytesUnknown: true }, { id: "C", value: 1, pass: true }] }, loaded: null });
    expect(v.rows.A).toEqual({ value: null, pass: false, busyAtStart: true });
    expect(v.rows.B).toEqual({ value: null, pass: false, osBytesUnknown: true });
    expect(v.rows.C).toEqual({ value: 1, pass: true });
  });
  it("hz-smooth.sh copies node_modules and never hard-links it before the chown", () => {
    const hz = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hz-smooth.sh"), "utf8");
    expect(hz).not.toMatch(/cp -a[a-z]*l/);
    expect(hz).toContain('cp -a "\\$NM/node_modules" "\\$L/src/node_modules"');
  });
  it("S9.cpuTree is n/a off macOS even when its scenario is invalid", () => {
    const row = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8")).rows.find(r => r.id === "S9.cpuTree");
    expect(judgeRow(row, { telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { invalid: "x" } } })).toMatchObject({ pass: true, notApplicable: true });
  });
  it("S9.cpuTree attribution window: mean cores by group and top processes, shown never judged", () => {
    const s = [{ t: 1000, treeCores: 0.1, vanishedCores: 0, appleCores: 0.2, otherCores: 0.1, procCpu: { "murage:node": 0.1, "apple:mds": 0.2 } }, { t: 2000, treeCores: 0.3, vanishedCores: 0, appleCores: 0.2, otherCores: 0.1, procCpu: { "murage:node": 0.3, "apple:mds": 0.2 } }, { t: 3000, treeCores: null }];
    const a = attributionWindow(s, 1000, 3000);
    expect(a.n).toBe(2);
    expect(a.meanCores).toEqual({ murage: 0.2, murageVanishedCharge: 0, apple: 0.2, other: 0.1 });
    expect(a.top[0]).toEqual({ key: "murage:node", meanCores: 0.2 });
    expect(attributionWindow([{ t: 1, treeCores: null }], 0, 9)).toBeNull();
  });
  it("the rig records every pid it spawns and uses the collector, not a line filter", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "smooth.mjs"), "utf8");
    expect(src).toContain("rigPids: rigPids.list()");
    expect(src).toContain("preStartCheck(PRE_START_LOAD1, [...SCEN])");
    expect(src).toContain("pid=,ppid=,uid=,lstart=,rss=,comm=");
    expect(src).toContain("topSampleCollector(");
    expect(src).not.toContain("exclude: liveTelPids");
  });
  it("reads the Windows data line and whole-box cores, INVALID is no reading", () => {
    expect(winLine("LEFTOVER node")).toBeNull();
    expect(winLine("400 1000 1048576 3")).toEqual({ busy: 400, total: 1000, rss: 1, procs: 3 });
    expect(winLine("INVALID")).toBeNull();
    expect(winLine("400 1000")).toBeNull();
    expect(winCores({ busy: 0, total: 0 }, { busy: 500, total: 1000 }, 2)).toBe(1);
    expect(winCores({ busy: 5, total: 10 }, { busy: 5, total: 10 }, 2)).toBeNull();
    expect(winCores({ busy: 9, total: 10 }, { busy: 5, total: 20 }, 2)).toBeNull();
  });
  it("the Windows script takes one handle-free snapshot, any owner, no WMI, and a failed snapshot is INVALID", () => {
    expect(WIN_TELEMETRY_PS).toContain("GetSystemTimes");
    expect(WIN_TELEMETRY_PS).toContain("NtQuerySystemInformation(5,");
    expect(WIN_TELEMETRY_PS).not.toMatch(/Win32_Process|Get-WmiObject|Get-CimInstance|GetProcesses|StartTime|denied/);
    expect(WIN_TELEMETRY_PS).toContain('if (s == null) return \\"INVALID\\"'.replace(/\\/g, ""));
    expect(WIN_TELEMETRY_PS).toContain("LEFTOVER-INVALID");
    expect(Buffer.from(encodedPowerShell(WIN_TELEMETRY_PS), "base64").toString("utf16le")).toBe(WIN_TELEMETRY_PS);
  });
  describe("Windows RSS peak snapshot (information only)", () => {
    const MB = 1048576;
    it("winLine ignores a PEAKPROCS line, so no sample or row can come from it", () => {
      expect(winLine("PEAKPROCS 4766212096 node.exe=1048576 claude.exe=2097152")).toBeNull();
      expect(winLine("PEAKPROCS 1 a=1")).toBeNull();
      expect(winLine("400 1000 1048576 3")).toEqual({ busy: 400, total: 1000, rss: 1, procs: 3 });
    });
    it("parses the summed peak and the per-process list, largest first", () => {
      const got = winPeakProcs(`PEAKPROCS ${4545 * MB} node.exe=${100 * MB} claude.exe=${2000 * MB} electron.exe=${300 * MB}`);
      expect(got).toEqual({ rssMb: 4545, top: [{ name: "claude.exe", mb: 2000 }, { name: "electron.exe", mb: 300 }, { name: "node.exe", mb: 100 }] });
    });
    it("rounds up like winLine and breaks ties by name", () => {
      expect(winPeakProcs(`PEAKPROCS ${MB + 1} b.exe=${MB + 1} a.exe=${MB + 1}`)).toEqual({ rssMb: 2, top: [{ name: "a.exe", mb: 2 }, { name: "b.exe", mb: 2 }] });
    });
    it("keeps at most 8 processes, however many the line carries", () => {
      const toks = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, "0")}.exe=${(i + 1) * MB}`).join(" ");
      const got = winPeakProcs(`PEAKPROCS ${78 * MB} ${toks}`);
      expect(PEAK_PROCS_MAX).toBe(8);
      expect(got.top).toHaveLength(8);
      expect(got.top.map(t => t.mb)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
    });
    it("cuts every name to image-name characters and 40 chars (no path, no command line, no secrets)", () => {
      const got = winPeakProcs(`PEAKPROCS ${MB} C:\\Users\\x\\tok.exe=${MB} ${"a".repeat(80)}=${MB}`);
      for (const t of got.top) { expect(t.name).toMatch(/^[A-Za-z0-9._-]{1,40}$/); }
      expect(got.top.map(t => t.name)).toContain("a".repeat(40));
    });
    it("a malformed or foreign line is no peak", () => {
      for (const bad of [null, "", "INVALID", "LEFTOVER node.exe", "400 1000 1048576 3", "PEAKPROCS", "PEAKPROCS x node=1", "PEAKPROCS 5 node", "PEAKPROCS 5 node=x"]) expect(winPeakProcs(bad)).toBeNull();
    });
    it("the sampler script emits the line from the same NtQuerySystemInformation walk and adds no denied API", () => {
      for (const part of ["PEAKPROCS", "TakePeak", "ws > peakWs", "j < 8", "Born >= stamp"]) expect(WIN_TELEMETRY_PS).toContain(part);
      expect(WIN_TELEMETRY_PS.match(/NtQuerySystemInformation\(/g)).toHaveLength(2); // the import and the one call, as before
      expect(WIN_TELEMETRY_PS).not.toMatch(/Win32_Process|Get-WmiObject|Get-CimInstance|GetProcesses|StartTime|denied|CommandLine|MainModule|FileName/);
      expect(WIN_TELEMETRY_PS).not.toMatch(/ProcessName|\.Path\b/);
    });
    it("the gate line reads results.rssPeakProcs, is absent without it, and is not a row", () => {
      expect(rssPeakLine({})).toBeNull();
      expect(rssPeakLine({ rssPeakProcs: { atMs: 0, rssMb: 5, top: [] } })).toBeNull();
      const line = rssPeakLine({ label: "idle", rssPeakProcs: { atMs: 1_700_000_000_000, rssMb: 4545, top: [{ name: "claude.exe", mb: 2000 }, { name: "bad name\\x.exe", mb: 3 }] } });
      expect(line).toBe("ALL.rss_peak_procs (idle, info only, no budget): Windows leg-user working set peaked at 4545 MB at 2023-11-14T22:13:20.000Z; top processes: claude.exe 2000 MB, bad_name_x.exe 3 MB");
      expect(line.startsWith("|")).toBe(false);
    });
  });
  it("the sampler's C# never sums a walk it could not finish", () => {
    for (const part of ["st != 0", "off + MIN_ENTRY > r", "nx < MIN_ENTRY", "return self ? list : null", "e.Born <= 0 && e.Pid != 0"]) expect(WIN_TELEMETRY_PS).toContain(part);
  });
  it("a failed leftover check refuses the leg, and only a second node counts", () => {
    expect(winLeftovers("LEFTOVER-INVALID")).toEqual({ invalid: true, left: [] });
    expect(winLeftovers("LEFTOVER node.exe explorer.exe")).toEqual({ invalid: false, left: [] });
    expect(winLeftovers("LEFTOVER node.exe node.exe claude.exe")).toEqual({ invalid: false, left: ["node", "node", "claude"] });
  });
  it("every resource reading rounds up, never to the nearest", () => {
    expect(cgroupMemMb(String(1048576 + 1))).toBe(2);
    expect(coresBetween({ t: 0, cpuS: 0 }, { t: 1000, cpuS: 0.2501 })).toBe(0.251);
    expect(coresFromTopLine("CPU usage: 3.13% user, 0.00% sys, 96.87% idle", 8)).toBeGreaterThanOrEqual(0.2504);
    expect(winLine("0 1 1572864 1").rss).toBe(2);
    expect(winCores({ busy: 0, total: 0 }, { busy: 2501, total: 10000 }, 1)).toBe(0.251);
  });
  describe("S9.io boundary", () => {
    // a simulated log: one io-budget line at each tick time (ms after the scenario starts); overshoot is how late each sleep wakes
    const run = async (ticks, { overshoot = 0, seconds = 180, stallAt = null, stallMs = 0 } = {}) => {
      let clock = 0, stalled = false; const pre = "x\n"; let log = pre; const pending = [...ticks].sort((a, b) => a - b);
      const flush = () => { while (pending.length && pending[0] <= clock) log += `[io-budget] t=${pending.shift()}\n`; };
      const sleep = async ms => { clock += ms + overshoot; if (stallAt !== null && !stalled && clock >= stallAt) { stalled = true; clock += stallMs; } flush(); };
      const logSize = () => Buffer.byteLength(log), logFrom = off => Buffer.from(log).subarray(off).toString();
      return idleIoCounts({ seconds, mark: Buffer.byteLength(pre), startMs: 0, now: () => clock, sleep, logSize, logFrom, count: t => (t.match(/\[io-budget\] /g) ?? []).length });
    };
    it("a tick at the 60 s mark, which reports the scenario's own first minute, counts, however late the polls wake", async () => {
      for (const overshoot of [0, 300, 900, 2400]) expect((await run([60_000], { overshoot })).ioBudget).toBe(1);
      expect((await run([60_001])).ioBudget).toBe(1);
    });
    it("a tick in the first minute reads the previous scenario: out of the new count, in the old one", async () => {
      expect(await run([30_000])).toEqual({ ioBudget: 0, ioBudgetOldWay: 1 });
    });
    it("every tick to just after 60 s + 180 s counts, including one just after 240 s", async () => {
      expect((await run([70_000, 130_000, 190_000, 239_000, 240_500, 241_900])).ioBudget).toBe(6);
    });
    it("the old count stops at the old 180 s, the new one does not", async () => {
      expect(await run([200_000])).toEqual({ ioBudget: 1, ioBudgetOldWay: 0 });
    });
    it("a short idle still waits the whole settle, then its seconds", async () => {
      expect((await run([70_000], { seconds: 20 })).ioBudget).toBe(1);
      expect((await run([81_500], { seconds: 20 })).ioBudget).toBe(1);
      expect((await run([30_000], { seconds: 20 })).ioBudget).toBe(0);
    });
    it("a gap between polls over 3 s reads not measured, never a count", async () => {
      expect(await run([70_000], { stallAt: 58_000, stallMs: 5_000 })).toMatchObject({ ioBudget: null, ioBudgetOldWay: null, ioPollGapMs: expect.any(Number) });
      expect((await run([70_000], { stallAt: 58_000, stallMs: 2_000 })).ioBudget).toBe(1);
    });
  });
  it("no eld samples, or one unreadable sample, never reads as no stalls", () => {
    expect(eldSummary([], statsOf)).toMatchObject({ max: null, secondsOver250: null });
    expect(eldSummary([{ stall: 900 }, { stall: NaN }], statsOf)).toMatchObject({ max: null, secondsOver250: null, unreadable: true });
    expect(eldSummary([{ stall: 900 }, { stall: 100 }], statsOf)).toMatchObject({ max: 900, secondsOver250: 1 });
  });
  it("a transcript page counts only if it reaches back past the scenario's start", () => {
    expect(pageCovers([{ at: 50 }], true, 100)).toBe(true);
    expect(pageCovers([{ at: 150 }], true, 100)).toBe(false);
    expect(pageCovers([], true, 100)).toBe(false);
    expect(pageCovers([{ at: 150 }], false, 100)).toBe(true);
    expect(pageCovers([{ at: 150 }], undefined, 100)).toBe(true);
    expect(pageCovers([{ at: 150 }], true, null)).toBe(true);
  });
  it("one turn with no first-text timing empties the row, never a max of the others", () => {
    expect(allTimed([100, undefined, 300], statsOf)).toMatchObject({ max: null, p90: null, untimed: 1 });
    expect(allTimed([100, 300], statsOf)).toMatchObject({ max: 300 });
    expect(allTimed([], statsOf)).toMatchObject({ max: null });
  });
  it("one approval card with no timing empties its row; a question card's missing timing does not", () => {
    expect(cardStat([{ kind: "approval", visibleMs: 100 }, { kind: "approval", visibleMs: null }], "visibleMs", statsOf)).toMatchObject({ max: null, untimed: 1 });
    expect(cardStat([{ kind: "approval", visibleMs: 100 }, { kind: "question", visibleMs: null }], "visibleMs", statsOf)).toMatchObject({ max: 100 });
    expect(cardStat([], "visibleMs", statsOf)).toMatchObject({ max: null });
  });
  it("a leg run with the CPU profiler is never a judged leg", () => {
    const budgets = { rows: [{ id: "N", scenario: "s", what: "n", path: "scenarios.s.n", op: "<=", value: 1 }] };
    const res = { scenarios: { s: { n: 0 } } };
    expect(judge(budgets, res).pass).toBe(true);
    const r = judge(budgets, { ...res, cpuProfiled: true });
    expect(r.pass).toBe(false); expect(r.invalid).toMatch(/CPU profiler/);
    expect(table(r, "t")).toContain("INVALID");
    expect(verdictOf({ tree: "a", idle: r, loaded: judge(budgets, res) }).pass).toBe(false);
  });
  it("S9.io shows the old count beside the new one, as information", () => {
    const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
    const row = budgets.rows.find(x => x.id === "S9.io");
    const r = judgeRow(row, { scenarios: { idle: { ioBudget: 0, ioBudgetOldWay: 1 } } });
    expect(r).toMatchObject({ pass: true, value: 0, oldWay: 1 });
    expect(table({ rows: [r], pass: true, failed: 0 }, "t")).toContain("old way: 1");
  });
  it("retained text goes through redaction or is not kept", () => {
    expect(keptText("sk-secret", t => t.replace("sk-secret", "[x]"))).toBe("[x]");
    expect(keptText("sk-secret", null)).toBe("redaction not loaded: text not kept");
    expect(keptText("sk-secret", () => { throw new Error("no"); })).toBe("redaction or accounting scrub failed: text not kept");
    expect(keptText("abcdef", t => t, 3)).toBe("abc");
  });
  it("a window with readings about every second is measured, per counter", () => {
    const s = full(1000, 60, { cores: 0.1, rss: 500 });
    const w = sampleWindow(s, 1000, 60000, st);
    expect(w.cpu).toEqual({ n: 60, max: 0.1 }); expect(w.rssMb).toEqual({ n: 60, max: 500 });
    expect(w.telemetry.cpu).toMatchObject({ samples: 60, invalid: 0, ok: true });
  });
  it("one gap over 3 s anywhere, including a window edge, reads not measured, with no restart exemption", () => {
    const s = full(1000, 60, { cores: 0.1, rss: 500 });
    expect(MAX_GAP_MS).toBe(3000);
    const mid = s.filter(x => x.t < 20000 || x.t > 24000);
    expect(sampleWindow(mid, 1000, 60000, st).cpu).toEqual({ n: 0, max: null });
    expect(sampleWindow(s.filter(x => x.t > 5000), 1000, 60000, st).rssMb).toEqual({ n: 0, max: null });
    expect(sampleWindow(s.filter(x => x.t < 50000), 1000, 60000, st).rssMb).toEqual({ n: 0, max: null });
    expect(sampleWindow(s.slice(0, 20), 1000, 90000, st).cpu).toEqual({ n: 0, max: null }); // 100 samples then an outage
  });
  it("one unreadable tick empties that counter only; the other stays", () => {
    const s = [...full(1000, 30, { cores: 0.1 }), ...full(1000, 30, { rss: 500 }), { t: 5000, rss: null }];
    const w = sampleWindow(s, 1000, 30000, st);
    expect(w.rssMb).toEqual({ n: 0, max: null }); expect(w.telemetry.rss.invalid).toBe(1);
    expect(w.cpu).toEqual({ n: 30, max: 0.1 });
    expect(sampleWindow([], 1000, 2000, st).cpu).toEqual({ n: 0, max: null });
  });
  it("ALL.rss on Linux takes the cgroup peak; an unreadable peak fails the row, never a lower number", () => {
    expect(withPeak({ n: 5, max: 100 }, 300)).toMatchObject({ max: 300, peakMb: 300 });
    expect(withPeak({ n: 5, max: 400 }, 300)).toMatchObject({ max: 400 });
    expect(withPeak({ n: 5, max: 400 }, null).max).toBeNull();
    expect(withPeak({ n: 0, max: null }, 300).max).toBeNull();
  });
  it("keeps a card's payload and a failed turn's trace only through redaction", () => {
    const redact = t => t.replaceAll("sk-secret", "[removed]");
    expect(keptCard({ title: "sk-secret" }, redact).payload).toBe('{"title":"[removed]"}');
    expect(keptCard({ title: "sk-secret" }, null)).toEqual({ unavailable: expect.any(String) });
    expect(JSON.stringify(keptCard({ title: "sk-secret" }, () => { throw new Error("x"); }))).not.toContain("sk-secret");
    const log = "[turn-trace] id=abc phase=x sk-secret\n[turn-trace] id=other phase=y\n";
    expect(traceLinesOf(log, "abc", redact)).toEqual(["[turn-trace] id=abc phase=x [removed]"]);
    expect(traceLinesOf(log, "abc", null)).toEqual([]);
    expect(traceLinesOf(log, "a.*", redact)).toEqual([]);
  });
  it("the real S2 prompt names the product's hand-off tool and the worker by id, without the fake's word", () => {
    const p = realDelegationPrompt({ id: "b-1", name: "Worker A" });
    expect(p).toContain("delegate_bot"); expect(p).toContain("b-1"); expect(p).not.toContain("LEAD_ASSIGN");
  });
  it("native files: match, mismatch, absent and unverified verdicts", () => {
    expect(browserHostVerdict({ sha256: "AB", expected: "ab" })).toBe("ok");
    expect(browserHostVerdict({ sha256: "ab", expected: "cd" })).toBe("mismatch");
    expect(browserHostVerdict({ sha256: null, expected: "cd" })).toBe("absent");
    expect(browserHostVerdict({ sha256: "ab" })).toBe("unverified");
  });
  it("data dir: an ancestor junction into .murage, a leaf link, a clean path and a throwing realpath", () => {
    const map = m => p => { if (p in m) return m[p]; return p; };
    expect(dataDirRealOk("/home/u/smooth-real/data", map({}))).toBe(true);
    expect(dataDirRealOk("/home/u/smooth-real/data", map({ "/home/u/smooth-real": "/home/u/.MURAGE/x" }))).toBe(false);
    expect(dataDirRealOk("/home/u/smooth-real/data", map({ "/home/u/smooth-real/data": "/home/u/.murage" }))).toBe(false);
    expect(dataDirRealOk("/home/u/smooth-real/data", () => { throw new Error("x"); })).toBe(false);
  });
});

// G15 guard: extraction retains the shared grammar and optional inspection budget.
it("G15 the unbounded core and bounded wrapper share grammar and visits", () => {
  for (const text of ['usage="SECRET"', "tokens={a:[1,2]}", "usage=[SECRET", 'cost=' + "9".repeat(513)]) {
    const visits = [], coreVisits = [];
    expect(scrubAccounting(text, i => visits.push(i))).toBe(scrubCore(text, i => coreVisits.push(i)));
    expect(visits).toEqual(coreVisits); expect(visits.length).toBeLessThan(text.length * 8 + 30);
  }
  const long = "a ".repeat(1100) + "usage=SECRET";
  expect(scrubCore(long).endsWith('usage="x"')).toBe(true);
  expect(scrubAccounting(long)).toHaveLength(2000);
});
// T21 red on rev 4: a second scrub loses the generated terminal cut marker.
it("T21 revalidates a cut generated from malformed accounting at its value boundary", () => {
  const malformed = 'prefix usage="' + "SECRET".repeat(100);
  const output = scrubCore(malformed);
  expect(output).toBe("prefix usage=[accounting value cut]");
  expect(safeAccounting(output)).toBe(true);
  expect(safeAccounting(output + " unsafe suffix")).toBe(false);
  expect(safeAccounting("cost=SECRET " + output)).toBe(false);
  expect(safeAccounting("ordinary [accounting value cut]")).toBe(false);
});
// T24 red on rev 4 and v5.8: ALL ELD starts at RUN_START and dispatch has no shared immutable mark.
describe("T24 first send attempt window", () => {
  const line = (t, max) => `[eld] t=${t} p50=0 p99=0 max=${max}\n`;
  it.each(["call", "room", "preflight", "failed-retry"])("T24 %s first attempt survives a late or failed send", async path => {
    const results = {}, events = [], failures = []; let clock = 9000;
    const mark = firstSendRecorder({ results, runId: "run", runStart: 0, now: () => clock,
      logSize: () => 123, ready: () => true, persist: value => events.push(value),
      save: () => true, fail: message => failures.push(message), requestId: () => path });
    mark("GET", "/api/health"); expect(results.firstSend).toBeUndefined();
    const endpoint = path === "room" ? "/api/groups/g/messages" : "/api/bots/b/messages";
    const dispatch = async () => {
      mark("POST", endpoint, { requestId: path });
      if (path === "failed-retry") throw Error("transport rejected first attempt");
    };
    if (path === "failed-retry") await expect(dispatch()).rejects.toThrow("transport rejected");
    else await dispatch();
    clock = 12_000;
    mark("POST", endpoint, { requestId: "retry" });
    expect(results.firstSend).toEqual({ epochMs: 9000, runId: "run", requestId: path, logByteOffset: 123 });
    expect(events).toEqual([results.firstSend]); expect(results.firstSendDelayMs).toBe(9000); expect(failures).toEqual([]);
    const text = line(1000, 9000) + line(8000, 5) + line(9000, 10) + line(10000, 20);
    const measured = allEldWindows(text, results.firstSend, 0, 10000, statsOf);
    expect(measured.eld.max).toBe(20); expect(measured.eldFromRunStart.max).toBe(9000);
    expect(eldStalls(text, results.firstSend.epochMs, 10000).fixed.map(r => r.t)).toEqual([9000, 10000]);
    expect(measured.eld.secondsOver250).toBe(0);
  });
  // T24 red on rev 4 and v5.8: no-send ELD is still measured from run start.
  it("T24 no send or no post-send sample is not measured; run-start info remains", () => {
    const text = line(1000, 9000);
    expect(allEldWindows(text, null, 0, 6000, statsOf)).toMatchObject({ eld: null, eldFromRunStart: { max: 9000 } });
    expect(allEldWindows(text, { epochMs: 9000 }, 0, 6000, statsOf).eld).toMatchObject({ max: null, secondsOver250: null });
  });
  // T24 red on rev 4 and v5.8: dispatch has no readiness or first-mark persistence check.
  it("T24 premature send and mark persistence failures invalidate without moving the mark", () => {
    const results = {}, failures = [];
    const mark = firstSendRecorder({ results, runId: "r", runStart: 0, now: () => 99, logSize: () => 1,
      ready: () => false, persist: () => { throw Error("write"); }, save: () => false,
      fail: reason => failures.push(reason), requestId: () => "q" });
    mark("POST", "/api/groups/g/messages"); mark("POST", "/api/bots/b/messages");
    expect(results.firstSend.epochMs).toBe(99);
    expect(failures).toContain("message send attempted before server readiness");
    expect(failures).toContain("first send event persistence failed");
    expect(failures).toContain("first send results persistence failed");
  });
  // T24 red on rev 4 and v5.8: neither dispatch adapter records a first attempt.
  it("T24 both actual adapters mark before dispatch and other ALL windows retain their sources", () => {
    const source = readFileSync(join(HERE, "smooth.mjs"), "utf8");
    const request = source.slice(source.indexOf("function request("), source.indexOf("async function call("));
    const room = source.slice(source.indexOf("async function roomCall("), source.indexOf("async function setLevel("));
    // F3 fails on 90b8e01c6 under the missing-mark mutation: -1 previously passed the order check.
    const assertOrder = (adapter, network) => {
      const mark = adapter.indexOf("markSend("), send = adapter.indexOf(network);
      expect(mark).toBeGreaterThanOrEqual(0); expect(send).toBeGreaterThanOrEqual(0);
      expect(mark).toBeLessThan(send);
    };
    for (const [adapter, network] of [[request, "http.request("], [room, "await fetch("]]) {
      assertOrder(adapter, network);
      expect(() => assertOrder(adapter.replace("markSend(", "removedMark("), network)).toThrow();
      expect(() => assertOrder(adapter.replace(network, "removedNetwork("), network)).toThrow();
    }
    expect(source).toContain("sampleWindow(samples, windowFrom, to, stats, excluded)");
    expect(source).toContain("warmIoCounts(text, excluded)");
    expect(source).toContain("...countSignatures(text)");
    expect(source).toContain("...allEldWindows(text, R.firstSend, RUN_START, to, stats, excluded)");
  });
});

// F3 fails with a mark removed on 90b8e01c6: the original source-order check accepts an absent mark.
it.each(["call", "roomCall"])("F3 actual %s adapter marking detects a missing-mark mutation", async path => {
  const { adapterFixture } = await import("./adapter-fixture.mjs");
  const source = readFileSync(join(HERE, "smooth.mjs"), "utf8");
  const start = source.indexOf(path === "call" ? "function request(" : "async function roomCall(");
  expect(start).toBeGreaterThanOrEqual(0);
  const at = source.indexOf("markSend(method, path, body);", start);
  expect(at).toBeGreaterThanOrEqual(start);
  const assertMarked = events => {
    const mark = events.findIndex(e => e[0] === "mark"), network = events.findIndex(e => e[0] === "network");
    expect(mark).toBeGreaterThanOrEqual(0); expect(network).toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(network);
  };
  const original = adapterFixture({}, source);
  await expect(original.send(path)).rejects.toThrow("transport rejected");
  assertMarked(original.events);
  const mutated = adapterFixture({}, source.slice(0, at) + source.slice(at).replace("markSend(method, path, body);", ""));
  await expect(mutated.send(path)).rejects.toThrow("transport rejected");
  expect(() => assertMarked(mutated.events)).toThrow();
});

describe("ALL.io r2: ioWriteStats counts writing lines only", () => {
  it("sums the MB/min of real writing lines and ignores cpu-only lines", async () => {
    const { ioWriteStats } = await import("./smooth-config.mjs");
    const text = "[io-budget] writing 9.4 MB/min (budget 1); source: a\n[io-budget] cpu 90% for 3 min; source: b\n[io-budget] writing 5.0 MB/min, cpu 90% for 3 min; source: c\nother\n";
    expect(ioWriteStats(text)).toEqual({ lines: 2, mb: 14.4, peak: 9.4 });
    expect(ioWriteStats("")).toEqual({ lines: 0, mb: 0, peak: 0 });
  });
});
describe("real-engine room and build sha (MurageMain 8 Nov ruling)", () => {
  it("S3 room bots are put at Full access on real engines, like S5, so S3 counts room smoothness not Ask cards", () => {
    const src = readFileSync(new URL("./smooth.mjs", import.meta.url), "utf8");
    const room = src.slice(src.indexOf("await scenario(\"room\""));
    expect(room.indexOf("ENGINES === \"real\") for (const m of members) { const set = await setLevel(m.id, \"full\")")).toBeGreaterThan(0);
    expect(room.indexOf("setLevel(m.id, \"full\")")).toBeLessThan(room.indexOf("\"/api/groups\""));
  });
  it("real-smooth.sh exports TREE_SHA so the gate header carries the build sha", () => {
    expect(readFileSync(new URL("./real-smooth.sh", import.meta.url), "utf8")).toContain("export TREE_SHA=\"$sha\"");
  });
});

describe("S9 CPU row per OS (Sean 11-08): macOS judges the Murage tree, the whole machine is info only", () => {
  const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "budgets.json"), "utf8"));
  const cpu = budgets.rows.find(r => r.id === "S9.cpu"), tree = budgets.rows.find(r => r.id === "S9.cpuTree");
  const MAC = "mac-wholebox-cpu+leg-user-rss";
  it("bounds are unchanged and the S9.cpu label no longer says server CPU for the Mac case", () => {
    expect(cpu.value).toBe(0.25); expect(tree.value).toBe(0.25);
    expect(cpu.macWhat).toBe("whole machine, info only (macOS)");
  });
  it("macOS: S9.cpuTree decides the leg, a hot whole machine alone cannot fail it", () => {
    const hotBox = { telemetryMode: { mode: MAC }, scenarios: { idle: { cpu: { p90: 1.568 }, cpuTree: { p90: 0.012 } } } };
    expect(judgeRow(tree, hotBox)).toMatchObject({ pass: true, value: 0.012 });
    expect(judgeRow(cpu, hotBox)).toMatchObject({ pass: true, reportOnly: true, wouldPass: false, value: 1.568, what: "whole machine, info only (macOS)" });
    const hotTree = { telemetryMode: { mode: MAC }, scenarios: { idle: { cpu: { p90: 0.05 }, cpuTree: { p90: 0.4 } } } };
    expect(judgeRow(tree, hotTree)).toMatchObject({ pass: false, value: 0.4 });
  });
  it("Linux still judges S9.cpu (cgroup) and the Mac-only tree row is n/a there", () => {
    const lin = { telemetryMode: { mode: "linux-cgroup" }, scenarios: { idle: { cpu: { p90: 0.4 } } } };
    expect(judgeRow(cpu, lin)).toMatchObject({ pass: false, value: 0.4 });
    expect(judgeRow(cpu, { ...lin, scenarios: { idle: { cpu: { p90: 0.1 } } } })).toMatchObject({ pass: true, value: 0.1 });
    expect(judgeRow(tree, lin)).toMatchObject({ pass: true, notApplicable: true });
    expect(judgeRow(cpu, { scenarios: { idle: { cpu: { p90: 0.4 } } } }).pass).toBe(false); // no telemetry mode (Windows shape): judged
  });
});
