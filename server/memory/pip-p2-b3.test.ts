// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 core, batch B3: the continuity ledger and second lease (group 5), the reflection state machine, its
// restart rows and the reaper (group 8), lived proposals and confirm, counters and Keep, episodes, and lane 5.
// Synthetic fixture text only; the engine is a stub function, no process and no network.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { captureMessage, captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setMemoryMode } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { CONTINUITY_FAMILY_CAP, continuityDay, continuityLedgerId, reportMemoryUsage, reserveExtraction, withContinuityInferenceLease, withMemoryInferenceLease } from "./extract.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { writeBotIdentity, readContinuity, botIdentityRecordId, type IdentityWrite } from "./identity.ts";
import { parseOwnerText } from "./pip-claims.ts";
import { confirmPipProposal, dismissPipProposal, keepPipRecord, listProposals, applyStanceEvents, pipDisputes, readCounter, expireProposals, PROPOSAL_EXPIRY_MS } from "./pip-lived.ts";
import { admissibleActionSources, admissibleOwnerSources } from "./pip-admission.ts";
import { episodeGate, episodeHits, listEpisodes, writeEpisode, writeTraceEpisode } from "./pip-episodes.ts";
import {
  DAILY_RUN_CAP, REQUEST_BYTES, buildSnapshot, fitSnapshot, mutateReflect, pipReflectPending, readReflectState, reflectThreadId, reflectionStatus,
  retryReflection, runPipReflect, reconcilePipRuns, sentenceRanges, settleRun, type ReflectBot, type ReflectDeps, type RunRecord,
} from "./pip-reflect.ts";
import type { IsolationReport, TextOnlyTurnInput, TextOnlyTurnResult, Verdict } from "./pip-transport.ts";
import { pipCounterId, pipProposalId } from "./pip-kinds.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { COUNTER_TEXT, LIVED_BASIS } from "./pip-lived.ts";
import { LIVED_SYSTEM, supportCopy } from "./pip-reflect.ts";
import { EPISODE_BASIS } from "./pip-episodes.ts";
import { HELD_PLUGIN_COPY, LOGIN_ROUTE_COPY } from "./pip-transport.ts";

const T0 = 1_760_000_000_000;
const MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }, { id: "other", threadId: "other-thread" }], groups: [] as never[] };
const ticket = ownerMemoryTicket();
const emptyBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { setMemoryCaptureRoster(null); vi.useRealTimers(); });

// ------------------------------------------------------------- fixtures ----

const done = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100");
function owner(id: string, at: number, text: string, thread = "private") {
  captureMessage(database(), thread, { id, at, role: "user", kind: "text", text, origin: "desktop" } as never); done();
  return `message:${thread}:${id}`;
}
function reply(id: string, at: number, text = "Sure.", thread = "private") {
  captureMessage(database(), thread, { id, at, role: "bot", kind: "text", text, turnTerminal: true, from: { botId: "moss" } } as never); done();
}
function action(id: string, at: number, label = "write_file", ok = true, thread = "private") {
  captureMessage(database(), thread, { id, at, role: "bot", kind: "activity", text: "done", tool: { name: label, ok } } as never); done();
}
const iso = (over: Partial<IsolationReport> = {}): IsolationReport => ({ mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn", ...over });
const result = (body: unknown, over: Partial<TextOnlyTurnResult> = {}): TextOnlyTurnResult => ({
  text: JSON.stringify(body), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso(), verdict: { state: "validated", structured: body }, ...over,
});
const verdictResult = (verdict: Verdict): TextOnlyTurnResult => ({ text: "", isolation: iso(), verdict });
const bot = (over: Partial<ReflectBot> = {}): ReflectBot => ({ id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true }, ...over });

interface Rig { deps: ReflectDeps; bot: ReflectBot; calls: TextOnlyTurnInput[]; clock: { now: number }; set(turn: (input: TextOnlyTurnInput) => Promise<TextOnlyTurnResult>): void }
function rig(over: { bot?: ReflectBot; fingerprint?: () => string; kind?: "cli" | "http"; reaper?: ReflectDeps["reaper"]; epoch?: { pid: number; startedAt: number } } = {}): Rig {
  const b = over.bot ?? bot(), calls: TextOnlyTurnInput[] = [], clock = { now: T0 + 60 * MIN };
  let turn: (input: TextOnlyTurnInput) => Promise<TextOnlyTurnResult> = async () => result({ proposals: [], stance: [], episode: null });
  const deps: ReflectDeps = {
    now: () => clock.now, bootEpoch: over.epoch ?? { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"),
    bots: () => [b], memoryMode: () => "active", reaper: over.reaper,
    resolveRoute: async () => ({ fingerprint: over.fingerprint?.() ?? "fp-1", engine: "Stub engine", kind: over.kind ?? "cli", model: "stub-model", textOnlyTurn: async (input) => { calls.push(input); return turn(input); } }),
  };
  return { deps, bot: b, calls, clock, set: (t) => { turn = t; } };
}
const run = (r: Rig) => runPipReflect(r.deps, undefined, new AbortController().signal);
const state = () => readReflectState(database(), "moss");
const scopeOf = (botId: string) => String(database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(botId)!.id);

/** A stub that proposes the first sentence of every owner turn with the act the host would derive. */
const proposeFirst = (input: TextOnlyTurnInput) => {
  const env = JSON.parse(input.text) as { turns: Array<{ sourceId?: string; from: string; sentences?: Array<{ start: number; end: number; text: string }> }> };
  const proposals = env.turns.filter(t => t.from === "owner" && t.sentences?.length).map(t => {
    const s = t.sentences![0], parsed = parseOwnerText(s.text)[0]?.result;
    return parsed && parsed.ok && parsed.production !== "RETRACT" ? { act: parsed.production, spans: [{ sourceId: t.sourceId!, start: s.start, end: s.end }] } : null;
  }).filter(Boolean);
  return result({ proposals, stance: [], episode: null });
};
const BRIEF_SENTENCE = "Please be brief.";
const ownerClaim = (text: string) => { const r = parseOwnerText(text)[0].result; if (!r.ok || r.production === "RETRACT") throw new Error("fixture does not parse: " + text); return r; };

function seedConversation(count = 1, text = BRIEF_SENTENCE) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) { ids.push(owner(`o${i + 1}`, T0 + i * MIN, text)); reply(`b${i + 1}`, T0 + i * MIN + 1000); }
  return ids;
}

// ------------------------------------------------------- group 5: ledger ----

describe("the continuity ledger and its lease", () => {
  it("never reads perCallOutputTokens: continuity is not a key of the strict learning map", () => {
    const keys = Object.keys(readMemoryLearning(database()).perCallOutputTokens);
    expect(keys).not.toContain("continuity");
    expect(keys.sort()).toEqual(["extraction", "grounding", "reflection"]);
  });

  it("reserves at the family cap, settles at reported usage, and records the over-limit figure", async () => {
    const day = continuityDay(), id = continuityLedgerId("moss", day);
    const outcome = await withContinuityInferenceLease(async lease => lease.request(async () => { reportMemoryUsage({ prompt_tokens: 111, completion_tokens: 5000 }); return "{}"; }, "system text", 3000,
      new AbortController().signal, [{ role: "user", content: "{}" }], "continuity", { botId: "moss", family: "lived" }));
    expect(outcome.status).toBe("complete");
    const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
    expect(ledger.input).toBe(111);
    expect(ledger.output).toBe(5000); // reserved 3000, settled at what the provider reported
    expect(ledger.calls).toBe(1);
    expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()).toBeUndefined();
  });

  it("caps the reservation per family and settles against the handle even after midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T23:59:30"));
    const messages = [{ role: "user", content: "x" }];
    const dream = reserveExtraction(messages, 3000, undefined, "continuity", { botId: "moss", family: "dream" });
    expect(dream.reserved).toBe(true);
    expect(dream.output).toBe(CONTINUITY_FAMILY_CAP.dream);
    expect(dream.handle.ledgerId).toBe("continuity-budget:moss:2026-10-05");
    vi.setSystemTime(new Date("2026-10-06T00:00:30"));
    dream.settle({ prompt_tokens: 7, completion_tokens: 9 });
    const row = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get("continuity-budget:moss:2026-10-05")!.intent));
    expect(row).toMatchObject({ input: 7, output: 9 });
    expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get("continuity-budget:moss:2026-10-06")).toBeUndefined();
  });

  it("refuses a switched-off bot and a missing context without charging anything", () => {
    const messages = [{ role: "user", content: "x" }];
    expect(reserveExtraction(messages, 1000, undefined, "continuity", { botId: "moss", family: "lived", enabled: false }).reserved).toBe("continuity-disabled");
    expect(reserveExtraction(messages, 1000, undefined, "continuity").reserved).toBe("continuity-context-missing");
    expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_id IN ('continuity-budget','extract-budget')").get()).toBeUndefined();
  });

  it("holds a second lease: a learning run and a reflection run can be in flight together, two reflections cannot", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started!: () => void;
    const learningStarted = new Promise<void>(r => { started = r; });
    const learning = withMemoryInferenceLease(async lease => { const p = lease.request(async () => { started(); await gate; return "[]"; }, "src", 100, new AbortController().signal, [{ role: "user", content: "s" }]); return p; });
    await learningStarted;
    const ctx = { botId: "moss", family: "lived" as const };
    const first = await withContinuityInferenceLease(async lease => lease.request(async () => "{}", "sys", 1000, new AbortController().signal, [{ role: "user", content: "{}" }], "continuity", ctx));
    expect(first.status).toBe("complete");
    let inner: unknown;
    const held = withContinuityInferenceLease(async lease => {
      const long = lease.request(async () => { await gate; return "{}"; }, "sys", 1000, new AbortController().signal, [{ role: "user", content: "{}" }], "continuity", ctx);
      inner = await withContinuityInferenceLease(async () => "never");
      release(); return long;
    });
    await held; await learning;
    expect(inner).toEqual({ status: "notStarted", reason: "extractor-busy" });
  });

  it("budgets the serialized request to 60,000 bytes by dropping whole sources, never cutting one", () => {
    const sources = Array.from({ length: 9 }, (_, i) => ({ kind: "owner" as const, sourceId: `s${i}`, revision: 1, messageId: `m${i}`, threadId: "private", occurredAt: T0 + i, text: `Please be brief ${i}. ` + "x".repeat(9000) }));
    const { snap, envelope } = fitSnapshot(database(), { sources, replies: [], truncated: [], bytes: 0 }, bot(), []);
    expect(Buffer.byteLength(JSON.stringify([{ role: "user", content: envelope }]))).toBeLessThanOrEqual(REQUEST_BYTES);
    expect(snap.truncated.length).toBeGreaterThan(0);
    expect(snap.sources.map(s => s.sourceId)).toEqual(sources.slice(sources.length - snap.sources.length).map(s => s.sourceId));
    expect(snap.sources.every(s => s.text.length > 9000)).toBe(true);
  });

  it("keeps the daily window to 24 KB and reports the skipped prefix", () => {
    for (let i = 0; i < 6; i++) { owner(`big${i}`, T0 + i * 1000, `Please be brief ${i}. ` + "y".repeat(7000)); }
    reply("bb", T0 + 10_000);
    const snap = buildSnapshot(database(), "moss", "private", undefined, []);
    expect(snap.bytes).toBeLessThanOrEqual(24 * 1024);
    expect(snap.truncated.length).toBeGreaterThan(0);
    expect(snap.sources.length + snap.truncated.length).toBe(6);
  });
});

// ------------------------------------------------------------ admission ----

describe("admission", () => {
  it("admits attended owner turns and completed actions of the bot's own thread, and nothing else", () => {
    owner("o1", T0, "Please be brief."); reply("b1", T0 + 1); action("a1", T0 + 2, "write_file"); action("a2", T0 + 3, "bad_tool", false);
    owner("o9", T0, "Please be brief.", "other-thread");
    const db = database();
    expect(admissibleOwnerSources(db, "moss", { threadId: "private" }).map(s => s.messageId)).toEqual(["o1"]);
    expect(admissibleActionSources(db, "moss", { threadId: "private" }).map(s => [s.messageId, s.text])).toEqual([["a1", "write_file"]]);
    expect(admissibleOwnerSources(db, "moss", { threadId: "other-thread" })).toEqual([]); // not moss's thread
    expect(admissibleOwnerSources(db, "moss", { threadId: "private", excludedThreads: ["private"] })).toEqual([]);
    expect(admissibleOwnerSources(db, "moss", { threadId: "private", afterAt: T0, afterMessageId: "o1" })).toEqual([]);
  });
  it("splits an owner message into sentences with byte ranges on code point boundaries", () => {
    const ranges = sentenceRanges("Please be brief. Ünïcode stays whole!");
    expect(ranges.map(r => r.text)).toEqual(["Please be brief."]);
    const bytes = Buffer.from("Please be brief. Ünïcode stays whole!");
    for (const r of ranges) expect(bytes.subarray(r.start, r.end).toString("utf8")).toBe(r.text);
  });
});

// -------------------------------------------- group 8: the state machine ----

describe("the reflection state machine", () => {
  it("reflects a settled thread, writes a proposal, advances the cursor, and replays nothing", async () => {
    seedConversation();
    const r = rig(); r.set(async i => proposeFirst(i));
    const first = await run(r);
    expect(first.status).toBe("applied");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].context).toMatchObject({ botId: "moss", family: "lived", attempt: 1 });
    expect(r.calls[0].maxOutputBytes).toBe(12 * 1024);
    const s = state();
    expect(s.run).toBeUndefined();
    expect(s.threads.private.cursorMessageId).toBe("o1");
    expect(s.dailyRuns.count).toBe(1);
    const proposals = listProposals(ticket, "moss", roster as never);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].statement).toBe(ownerClaim(BRIEF_SENTENCE).statement);
    expect(proposals[0].quotes[0].text).toBe(BRIEF_SENTENCE);
    // nothing new since the cursor: nothing runs
    expect((await run(r)).status).toBe("idle");
    expect(r.calls).toHaveLength(1);
  });

  it("waits for a settled bot reply older than ten minutes, and for a new admissible turn", async () => {
    owner("o1", T0, BRIEF_SENTENCE);
    const r = rig();
    expect((await run(r)).status).toBe("idle"); // newest message is the owner's own
    reply("b1", T0 + 1000);
    r.clock.now = T0 + 5 * MIN;
    expect((await run(r)).status).toBe("idle"); // reply is under ten minutes old
    r.clock.now = T0 + 12 * MIN;
    r.set(async i => proposeFirst(i));
    expect((await run(r)).status).toBe("applied");
    r.clock.now = T0 + 20 * MIN;
    expect(pipReflectPending(r.deps)).toBeUndefined(); // no new turn since the cursor
  });

  it("honours the switch, the memory mode and the thirty-minute spacing", async () => {
    seedConversation();
    const off = rig({ bot: bot({ continuity: false }) });
    expect((await run(off)).status).toBe("idle");
    const noReflect = rig({ bot: bot({ options: {} }) });
    expect((await run(noReflect)).status).toBe("idle");
    const r = rig(); r.set(async i => proposeFirst(i));
    expect((await run(r)).status).toBe("applied");
    owner("o2", r.clock.now - 1000, "You should double-check totals."); reply("b2", r.clock.now - 500);
    r.clock.now += 5 * MIN;
    expect((await run(r)).status).toBe("idle"); // lastRunAt is under thirty minutes old
    r.clock.now += 30 * MIN;
    expect((await run(r)).status).toBe("applied");
  });

  it("refuses at the daily cap before any request", async () => {
    seedConversation();
    const r = rig();
    mutateReflect("moss", (s) => { s.dailyRuns = { day: new Date(r.clock.now).toISOString().slice(0, 10), count: DAILY_RUN_CAP, dreamCalls: 0 }; });
    expect((await run(r)).status).toBe("idle");
    expect(r.calls).toHaveLength(0);
    expect(DAILY_RUN_CAP).toBe(24);
  });

  it("a bad body is refused:bad-output, retried up to three attempts under one deadline, then unstable with a cooldown", async () => {
    seedConversation();
    const r = rig(), deadlines = new Set<number | undefined>();
    r.set(async i => { deadlines.add(i.transport?.deadlineAt); return verdictResult({ state: "refused", reason: "bad-output", detail: "schema", counted: true }); });
    const out = await run(r);
    expect(out).toMatchObject({ status: "refused", reason: "unstable" });
    expect(r.calls.map(c => c.context.attempt)).toEqual([1, 2, 3]);
    expect(deadlines.size).toBe(1);
    const s = state();
    expect(s.cooldownUntil).toBeGreaterThan(r.clock.now);
    expect(s.refusals.length).toBeLessThanOrEqual(3);
    expect(s.refusals[0].state).toBe("refused:unstable");
    expect(s.threads.private?.cursorMessageId ?? null).toBeNull(); // refused leaves the cursor
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
    // cooldown honoured
    owner("o2", r.clock.now, "You should double-check totals."); reply("b2", r.clock.now + 1000);
    r.clock.now += 20 * MIN + 31 * MIN;
    expect(pipReflectPending(r.deps)).toBeUndefined();
  });

  it("a result that is not valid JSON for the lived schema is a counted bad output, never applied", async () => {
    seedConversation();
    const r = rig(); r.set(async () => result({ nonsense: true }));
    expect((await run(r)).status).toBe("refused");
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
    expect(r.calls).toHaveLength(3);
  });

  it("an unsupported route is held without spinning the idle lane, and clears when the fingerprint changes", async () => {
    seedConversation();
    let fp = "fp-1";
    const r = rig({ fingerprint: () => fp });
    r.set(async () => verdictResult({ state: "unsupported", reason: "tools", detail: "read_file" }));
    expect((await run(r)).status).toBe("refused");
    expect(r.calls).toHaveLength(1); // not counted toward three, not retried
    const status = reflectionStatus("moss", r.clock.now);
    expect(status.support.status).toBe("unsupported");
    expect(status.support.copy).toContain("text-only request");
    expect(status.refusals[0].state).toBe("refused:unsupported");
    expect(pipReflectPending(r.deps)).toBeUndefined();
    fp = "fp-2"; // new binary or route
    r.set(async i => proposeFirst(i));
    r.clock.now += 40 * MIN;
    expect(await run(r)).toMatchObject({ status: "applied" });
  });

  it("a transient miss backs off by the published schedule and the owner can try again", async () => {
    seedConversation();
    const r = rig(); r.set(async () => verdictResult({ state: "refused", reason: "transient", detail: "no first byte", counted: false }));
    expect((await run(r)).status).toBe("refused");
    const entry = Object.values(state().support)[0];
    expect(entry).toMatchObject({ status: "transient" });
    expect(entry.retryAt! - r.clock.now).toBe(3_600_000);
    expect(pipReflectPending(r.deps)).toBeUndefined();
    retryReflection("moss");
    r.clock.now += 40 * MIN;
    expect(pipReflectPending(r.deps)).toBe("moss");
  });

  it("switching off mid-run applies nothing and ends refused:off", async () => {
    seedConversation();
    const r = rig(); r.set(async i => { r.bot.continuity = false; return proposeFirst(i); });
    expect(await run(r)).toMatchObject({ status: "refused", reason: "off" });
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
    expect(state().threads.private?.cursorMessageId ?? null).toBeNull();
    expect(state().run).toBeUndefined();
  });

  it("re-snapshots when a shown source changes before publication, then applies the new snapshot", async () => {
    seedConversation();
    const r = rig(); let n = 0;
    r.set(async i => {
      n++;
      if (n === 1) { captureSource(database(), { id: "message:private:o1", threadId: "private", messageId: "o1", kind: "text", speaker: "owner", outcome: "recorded", text: "You should double-check totals.", origin: { kind: "attended" }, occurredAt: T0 }); done(); }
      return proposeFirst(i);
    });
    done();
    expect(await run(r)).toMatchObject({ status: "applied" });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].context.attempt).toBe(2);
    const proposals = listProposals(ticket, "moss", roster as never);
    expect(proposals.map(p => p.quotes[0].text)).toEqual(["You should double-check totals."]);
  });

  it("a validated result persisted by an earlier process is applied with no model call", async () => {
    seedConversation();
    const r = rig(); r.set(async i => proposeFirst(i));
    // Run once to learn the snapshot, then replay it from a durable validated state.
    expect((await run(r)).status).toBe("applied");
    const proposalsBefore = listProposals(ticket, "moss", roster as never).length;
    owner("o2", r.clock.now - 10 * MIN, "You should double-check totals."); reply("b2", r.clock.now - 9 * MIN);
    r.clock.now += 40 * MIN;
    const snap = buildSnapshot(database(), "moss", "private", state().threads.private, []);
    const env = JSON.parse(fitSnapshot(database(), snap, r.bot, []).envelope) as { turns: Array<{ sourceId?: string; from: string; sentences?: Array<{ start: number; end: number }> }> };
    const turn = env.turns.find(t => t.from === "owner")!;
    const persisted = { proposals: [{ act: ownerClaim("You should double-check totals.").production, spans: [{ sourceId: turn.sourceId!, start: turn.sentences![0].start, end: turn.sentences![0].end }] }], stance: [], episode: null };
    const { snapshotGen } = await import("./pip-reflect.ts");
    mutateReflect("moss", (s) => {
      s.run = { runId: "persisted", kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: "o2", toAt: snap.sources[snap.sources.length - 1].occurredAt, window: { bytes: 1 }, bootEpoch: r.deps.bootEpoch,
        createdAt: r.clock.now, fingerprint: "fp-1", families: { lived: { state: "validated", attempt: 1, snapshotGen: snapshotGen(snap.sources, [], "private"), fromAt: snap.sources[0].occurredAt, result: persisted as never, targets: [] } } } as RunRecord;
    });
    r.calls.length = 0; r.set(async () => { throw new Error("must not be asked again"); });
    expect((await run(r)).status).toBe("applied");
    expect(r.calls).toHaveLength(0);
    expect(listProposals(ticket, "moss", roster as never).length).toBe(proposalsBefore + 1);
    expect(state().threads.private.cursorMessageId).toBe("o2");
  });

  it("names the attempt's pseudo thread so provider events for it are ignored", () => {
    expect(reflectThreadId({ botId: "moss", runId: "r1", family: "lived", attempt: 2 })).toBe("pip-reflect:moss:r1:lived:2");
  });
});

// ------------------------------------------- A.2 restart rows and reaper ----

describe("restart rows and the reaper", () => {
  const OLD = { pid: 1, startedAt: 1 }, NEW = { pid: 2, startedAt: 2 };
  function seedRun(over: { kind?: "cli" | "http"; child?: { pid: number; startTime: string; registeredAt: number }; state?: "requested" | "uncertain-transport"; attempt?: number; reaperFailures?: number; withTransport?: boolean } = {}) {
    const tempRoot = join(DATA_DIR, "pip-tmp", "run-1-" + (over.attempt ?? 1));
    mkdirSync(tempRoot, { recursive: true });
    mutateReflect("moss", (s) => {
      s.run = { runId: "run-1", kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: "o1", toAt: T0, window: { bytes: 1 }, bootEpoch: OLD, createdAt: T0, fingerprint: "fp-1", deadlineAt: T0 + 270_000,
        families: { lived: { state: over.state ?? "requested", attempt: over.attempt ?? 1, snapshotGen: "g",
          ...(over.withTransport === false ? {} : { transport: { kind: over.kind ?? "cli", reaperFailures: over.reaperFailures, ...(over.child ? { child: over.child } : {}), intent: { runId: "run-1", family: "lived", attempt: over.attempt ?? 1, tempRoot, bootEpoch: OLD, intentAt: T0, deadlineAt: T0 + 270_000 } } }) } } } as RunRecord;
    });
    return tempRoot;
  }
  const noKill = { sweep: async () => [], termGraceMs: 0, forceWaitMs: 0, wait: async () => {} };

  it.each(["requested", "refused:unstable"])("Windows restart reopens the persisted job and settles %s", async terminal => {
    const root = seedRun();
    const jobName = "Local\\murage-pip-restart";
    mutateReflect("moss", s => {
      s.run!.families.lived.state = terminal as never;
      s.run!.families.lived.transport!.intent.jobName = jobName;
    });
    // Reload from SQLite under a new epoch, with no live ChildProcess handle.
    const jobRunner = vi.fn(async () => ({ ok: true, out: '{"state":"present","activeProcesses":0}' }));
    const r = rig({ epoch: NEW, reaper: { platform: "win32", jobRunner, sweep: async () => [] } });
    await reconcilePipRuns(r.deps);
    expect(jobRunner).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-JobName", jobName, "-Stop"]), expect.any(Number));
    expect(existsSync(root)).toBe(false);
    if (terminal === "requested") expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
    else expect(state().run).toBeUndefined();
  });

  it("requested with an older boot epoch and a vanished child: temp root removed, back to pending with attempt + 1", async () => {
    const root = seedRun({ child: { pid: 999_999, startTime: "Mon", registeredAt: T0 } });
    // "vanished" is an observation (absent), not a failed look: a start-time read that returns null is unknown and keeps the root.
    const r = rig({ epoch: NEW, reaper: { ...noKill, observe: async () => ({ state: "absent" as const }) } });
    const out = await reconcilePipRuns(r.deps);
    expect(out.retried).toBe(1);
    expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
    expect(existsSync(root)).toBe(false);
  });

  it("a failed look at the child (start time unreadable) keeps the root and leaves the attempt uncertain-transport", async () => {
    const root = seedRun({ child: { pid: 999_994, startTime: "Mon", registeredAt: T0 } });
    const r = rig({ epoch: NEW, reaper: { ...noKill, startTime: async () => null } });
    const out = await reconcilePipRuns(r.deps);
    expect(out.unconfirmed).toBe(1);
    expect(state().run!.families.lived).toMatchObject({ state: "uncertain-transport" });
    expect(existsSync(root)).toBe(true);
  });

  it("kills and verifies a live orphan before the root goes; a child that will not die keeps the root and fails three times to unstable", async () => {
    const root = seedRun({ child: { pid: 999_998, startTime: "Mon", registeredAt: T0 } });
    const stubborn = { ...noKill, startTime: async () => "Mon", signal: () => { /* alive */ } };
    const r = rig({ epoch: NEW, reaper: stubborn });
    for (let i = 1; i <= 2; i++) {
      await reconcilePipRuns(r.deps);
      const f = state().run!.families.lived;
      expect(f.state).toBe("uncertain-transport");
      expect(f.transport!.reaperFailures).toBe(i);
      expect(existsSync(root)).toBe(true);
    }
    const third = await reconcilePipRuns(r.deps);
    expect(third.unstable).toBe(1);
    expect(state().run?.families.lived.transport?.reaperFailures).toBe(3); // durable ownership is retained
    expect(state().refusals[0].state).toBe("refused:unstable");
    expect(state().cooldownUntil).toBeGreaterThan(0);
  });

  it("an orphan with a real child is signalled, reaped and the group verified gone", async () => {
    const root = seedRun({ child: { pid: 999_997, startTime: "Mon", registeredAt: T0 } });
    const alive = new Set([999_997]), sent: string[] = [];
    const signal = (pid: number, sig: NodeJS.Signals | 0) => {
      const p = Math.abs(pid);
      if (sig === 0) { if (!alive.has(p)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return; }
      sent.push(`${pid}:${sig}`); if (sig === "SIGKILL") alive.delete(p);
    };
    const r = rig({ epoch: NEW, reaper: { ...noKill, startTime: async () => "Mon", signal } });
    await reconcilePipRuns(r.deps);
    expect(sent).toContain("-999997:SIGTERM");
    expect(sent).toContain("-999997:SIGKILL");
    expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
    expect(existsSync(root)).toBe(false);
  });

  it("an attempt with no child registration is found by the argv sweep", async () => {
    seedRun({});
    const swept: string[] = [];
    const alive = new Set([999_996]);
    const signal = (pid: number, sig: NodeJS.Signals | 0) => { const p = Math.abs(pid); if (sig === 0) { if (!alive.has(p)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); return; } if (sig === "SIGKILL") alive.delete(p); };
    const r = rig({ epoch: NEW, reaper: { ...noKill, sweep: async (needle) => { swept.push(needle); return [999_996]; }, signal } });
    await reconcilePipRuns(r.deps);
    expect(swept[0]).toContain("run-1-1");
    expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
  });

  it("a requested HTTP attempt with an older epoch goes straight to a fresh request", async () => {
    seedRun({ kind: "http" });
    const r = rig({ epoch: NEW, reaper: noKill });
    await reconcilePipRuns(r.deps);
    expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
  });

  it("a request that never wrote an intent retries on an older epoch and fails after three", async () => {
    seedRun({ withTransport: false });
    const r = rig({ epoch: NEW, reaper: noKill });
    await reconcilePipRuns(r.deps);
    expect(state().run!.families.lived).toMatchObject({ state: "pending", attempt: 2 });
    mutateReflect("moss", (s) => { s.run!.families.lived.state = "requested"; s.run!.families.lived.attempt = 3; });
    await reconcilePipRuns(r.deps);
    expect(state().run).toBeUndefined();
    expect(state().cooldownUntil).toBeGreaterThan(0);
  });

  it("the same epoch is left alone", async () => {
    seedRun({});
    const r = rig({ epoch: OLD, reaper: noKill });
    await reconcilePipRuns(r.deps);
    expect(state().run!.families.lived).toMatchObject({ state: "requested", attempt: 1 });
  });

  it("an unconfirmed exit during a run keeps the temp root and is retried by the reaper at the next tick", async () => {
    seedConversation();
    const stubborn = { ...noKill, startTime: async () => "Mon", signal: () => { /* alive */ } };
    const r = rig({ reaper: stubborn });
    r.set(async (i) => {
      await i.transport?.hooks?.onIntent?.({ runId: i.context.runId, family: "lived", attempt: i.context.attempt, tempRoot: join(DATA_DIR, "pip-tmp", "live"), bootEpoch: i.transport!.bootEpoch!, intentAt: T0, deadlineAt: i.transport!.deadlineAt! });
      await i.transport?.hooks?.onChild?.({ pid: 999_995, startTime: "Mon", registeredAt: T0 });
      mkdirSync(join(DATA_DIR, "pip-tmp", "live"), { recursive: true });
      return verdictResult({ state: "uncertain-transport", reason: "exit-unconfirmed" });
    });
    expect((await run(r)).status).toBe("uncertain");
    expect(state().run!.families.lived.state).toBe("uncertain-transport");
    await reconcilePipRuns(r.deps);
    expect(state().run!.families.lived.transport!.reaperFailures).toBe(1);
    expect(existsSync(join(DATA_DIR, "pip-tmp", "live"))).toBe(true);
  });

  it("directories with no run record are removed only when nothing names them", async () => {
    const base = join(DATA_DIR, "pip-tmp"); mkdirSync(join(base, "orphan-a"), { recursive: true }); mkdirSync(join(base, "orphan-b"), { recursive: true });
    const r = rig({ reaper: { ...noKill, sweep: async (needle) => (needle.endsWith("orphan-b") ? [4242] : []) } });
    const out = await reconcilePipRuns(r.deps, { discoverOrphans: true });
    expect(out.swept).toBe(1);
    expect(existsSync(join(base, "orphan-a"))).toBe(false);
    expect(existsSync(join(base, "orphan-b"))).toBe(true);
  });
});

// ------------------------------------------------- lived self-model rows ----

describe("proposals, confirm, counters and Keep", () => {
  async function proposeOne(text = BRIEF_SENTENCE) {
    seedConversation(1, text);
    const r = rig(); r.set(async i => proposeFirst(i));
    expect((await run(r)).status).toBe("applied");
    return { r, proposal: listProposals(ticket, "moss", roster as never)[0] };
  }

  it("confirm writes an observed row from the template statement, grounded in the owner's words", async () => {
    const { proposal } = await proposeOne();
    const out = confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    expect(out.ok).toBe(true);
    const rows = readContinuity(ticket, "moss", roster as never).records;
    const observed = rows.find(x => x.text === proposal.statement)!;
    expect(observed).toMatchObject({ tier: "observed", generation: 1 });
    const basis = database().prepare("SELECT confidence_basis,entities FROM memory_record_details WHERE record_id=? AND record_version=?").get(observed.id, observed.version)!;
    expect(String(basis.confidence_basis)).toMatch(/^pip:observed/);
    expect(JSON.parse(String(basis.entities))).toEqual(expect.arrayContaining(["gen:1", expect.stringMatching(/^reinforcedAt:\d+$/), expect.stringMatching(/^claim:/)]));
    expect(database().prepare("SELECT count(*) AS n FROM memory_evidence WHERE record_id=?").get(observed.id)!.n).toBe(1);
    // idempotent: a second confirm returns the stored record id
    const again = confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    expect(again).toMatchObject({ ok: true, already: true });
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
  });

  it("confirm re-checks admission: a thread that became excluded invalidates the proposal", async () => {
    const { proposal } = await proposeOne();
    mutateReflect("moss", (s) => { s.excludedThreads = ["private"]; });
    expect(confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never)).toEqual({ ok: false, reason: "invalid" });
    expect(readContinuity(ticket, "moss", roster as never).records.filter(x => x.text === proposal.statement)).toHaveLength(0);
  });

  it("a stale version is refused, and an owner-only ticket is required", async () => {
    const { proposal } = await proposeOne();
    expect(confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version + 1 }, roster as never)).toEqual({ ok: false, reason: "stale" });
    expect(() => confirmPipProposal({}, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never)).toThrow("MEMORY_OWNER_REQUIRED");
  });

  it("dismiss tombstones the id so the same statement is never proposed again", async () => {
    const { r, proposal } = await proposeOne();
    dismissPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
    owner("o2", r.clock.now, BRIEF_SENTENCE); reply("b2", r.clock.now + 1000);
    r.clock.now += 60 * MIN;
    await run(r);
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
  });

  it("proposals that nobody answers expire at thirty days without being deleted", async () => {
    const { proposal } = await proposeOne();
    expect(expireProposals("moss", Date.now() + PROPOSAL_EXPIRY_MS + 1000)).toBe(1);
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
    expect(database().prepare("SELECT 1 FROM memory_records WHERE id=?").get(proposal.id)).toBeTruthy();
  });

  it("an owner edit with different bytes makes the row attested with the next generation; identical bytes change nothing", async () => {
    const { proposal } = await proposeOne();
    confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    const row = readContinuity(ticket, "moss", roster as never).records.find(x => x.text === proposal.statement)!;
    const same = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: row.kind as never, key: row.key, expectedVersion: row.version, text: row.text, basis: "owner-fact", audience: "owner-private" } as IdentityWrite, roster as never);
    expect(same.version).toBe(row.version);
    const edited = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: row.kind as never, key: row.key, expectedVersion: row.version, text: "I will be brief with invoices.", basis: "owner-fact", audience: "owner-private" } as IdentityWrite, roster as never);
    expect(edited.version).toBe(row.version + 1);
    const details = database().prepare("SELECT confidence_basis,entities FROM memory_record_details WHERE record_id=? AND record_version=?").get(edited.id, edited.version)!;
    expect(String(details.confidence_basis)).toMatch(/^pip:attested/);
    expect(JSON.parse(String(details.entities))).toEqual(expect.arrayContaining(["gen:2"]));
  });

  it("contradicting words add counter occasions; enough of them dispute the row; Keep clears it and survives a new counter version", async () => {
    const { r, proposal } = await proposeOne();
    confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    const target = readContinuity(ticket, "moss", roster as never).records.find(x => x.text === proposal.statement)!;
    const db = database(), scopeId = scopeOf("moss");
    const contradict = (n: number) => {
      const id = owner(`c${n}`, T0 + 100_000 + n, "Please be detailed.");
      const rows = db.prepare("SELECT revision FROM memory_sources WHERE id=?").get(id)!;
      const quote = "Please be detailed.";
      return applyStanceEvents(db, "moss", scopeId, [{ targetId: target.id, quote, handle: { sourceId: id, revision: Number(rows.revision), start: 0, end: Buffer.byteLength(quote) } }]);
    };
    expect(contradict(1)).toMatchObject({ countered: 1 });
    expect(contradict(1)).toMatchObject({ countered: 0 }); // one occasion counts once
    for (let n = 2; n <= 5; n++) contradict(n);
    const counter = readCounter(db, "moss", target.id, 1)!;
    expect(counter.occasions).toHaveLength(5);
    expect(counter.disputed).toBe(true);
    const disputes = pipDisputes(ticket, "moss", roster as never);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({ targetId: target.id, generation: 1, unkept: 5 });
    expect(readContinuity(ticket, "moss", roster as never).records.find(x => x.id === target.id)).toMatchObject({ disputed: true });
    expect(keepPipRecord(ticket, { botId: "moss", targetId: target.id, generation: 1, counterVersion: disputes[0].counterVersion + 1 }, roster as never)).toEqual({ ok: false, reason: "stale" });
    expect(keepPipRecord(ticket, { botId: "moss", targetId: target.id, generation: 1, counterVersion: disputes[0].counterVersion }, roster as never)).toEqual({ ok: true });
    const kept = readCounter(db, "moss", target.id, 1)!;
    expect(kept.kept).toHaveLength(5);
    expect(kept.disputed).toBe(false);
    // a sixth contradiction writes a new counter version that copies the kept entries forward
    contradict(6);
    const next = readCounter(db, "moss", target.id, 1)!;
    expect(next.kept).toHaveLength(5);
    expect(next.occasions).toHaveLength(6);
    expect(next.disputed).toBe(false);
    const { setReflectExcluded } = await import("./pip-reflect.ts");
    setReflectExcluded("moss", "private", true);
    expect(readCounter(db, "moss", target.id, 1)?.occasions).toEqual([]);
    setReflectExcluded("moss", "private", false);
    expect(readCounter(db, "moss", target.id, 1)?.kept).toEqual(next.kept);
    void r;
  });

  it("reinforcing words count once per occasion and never write a counter", async () => {
    const { proposal } = await proposeOne();
    confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never);
    const target = readContinuity(ticket, "moss", roster as never).records.find(x => x.text === proposal.statement)!;
    const db = database(), id = owner("again", T0 + 500_000, BRIEF_SENTENCE), rev = Number(db.prepare("SELECT revision FROM memory_sources WHERE id=?").get(id)!.revision);
    const draft = { targetId: target.id, quote: BRIEF_SENTENCE, handle: { sourceId: id, revision: rev, start: 0, end: 16 } };
    expect(applyStanceEvents(db, "moss", scopeOf("moss"), [draft])).toMatchObject({ reinforced: 1, countered: 0 });
    expect(applyStanceEvents(db, "moss", scopeOf("moss"), [draft])).toMatchObject({ reinforced: 0, dropped: 1 });
    expect(readCounter(db, "moss", target.id, 1)).toBeNull();
  });

  it("derived ids are deterministic and the counter id carries the generation", () => {
    expect(pipProposalId("moss", "commitment", "k", "I will be brief.")).toBe(pipProposalId("moss", "commitment", "k", "I will be brief."));
    expect(pipCounterId("identity:a", 1)).not.toBe(pipCounterId("identity:a", 2));
    expect(botIdentityRecordId("moss", "commitment", "k")).toMatch(/^identity:/);
  });
});

// ----------------------------------------------------------- episodes ----

describe("episodes", () => {
  const handles = (n: number) => Array.from({ length: n }, (_, i) => ({ sourceId: owner(`e${i}`, T0 + i, `Message number ${i} about the harbour log.`), revision: 1, start: 0, end: 10 }));
  const GOOD = "We spent the morning on the harbour log and agreed to review the tide tables on Friday.";

  it("gates length, platitudes, broken output and repetition deterministically", () => {
    expect(episodeGate(GOOD)).toBeNull();
    expect(episodeGate("Short.")).toBe("too-short");
    expect(episodeGate("x ".repeat(400))).toBe("too-long");
    expect(episodeGate("We had a nice chat today about things and so on")).toBe("platitude");
    expect(episodeGate('{"summary": "we talked about the harbour log and the tide tables today"}')).toBe("broken-output");
    expect(episodeGate("log log log log log log log log log log log log log log log log")).toBe("repetitive");
  });

  it("needs three to twelve owner turns, is idempotent, and is recalled only as a summary", () => {
    const db = database(), scopeId = scopeOf("moss"), h = handles(4);
    expect(writeEpisode(db, { botId: "moss", scopeId, threadId: "private", closingMessageId: "e3", text: GOOD, handles: h.slice(0, 2) })).toEqual({ written: false, reason: "too-few-turns" });
    expect(writeEpisode(db, { botId: "moss", scopeId, threadId: "private", closingMessageId: "e3", text: GOOD, handles: h }).written).toBe(true);
    expect(writeEpisode(db, { botId: "moss", scopeId, threadId: "private", closingMessageId: "e3", text: GOOD, handles: h }).written).toBe(false);
    expect(episodeHits(db, "moss", "what about the tide tables?")).toHaveLength(1);
    expect(episodeHits(db, "moss", "unrelated quantum topic")).toHaveLength(0);
    expect(episodeHits(db, "other", "tide tables")).toHaveLength(0);
    expect(listEpisodes(db, "moss")).toHaveLength(1);
    expect(String(db.prepare("SELECT confidence_basis FROM memory_record_details WHERE record_id=?").get(listEpisodes(db, "moss")[0].id)!.confidence_basis)).toMatch(/^pip:summary/);
  });

  it("a day with owner turns and no episode leaves one deterministic trace, once, with no em dash", () => {
    const db = database(), scopeId = scopeOf("moss");
    const turns = admissibleOwnerSources(db, "moss", { threadId: "private" });
    const h = handles(2); void h;
    const all = admissibleOwnerSources(db, "moss", { threadId: "private" });
    expect(all.length).toBeGreaterThan(0);
    const byThread = [{ threadId: "private", title: "Harbour — log", turns: all }];
    expect(writeTraceEpisode(db, { botId: "moss", scopeId, day: T0, byThread }).written).toBe(true);
    expect(writeTraceEpisode(db, { botId: "moss", scopeId, day: T0, byThread })).toEqual({ written: false, reason: "day-has-episode" });
    const ep = listEpisodes(db, "moss")[0];
    expect(ep.trace).toBe(true);
    expect(Buffer.byteLength(ep.text)).toBeLessThanOrEqual(300);
    expect(ep.text).not.toMatch(/[—–]/);
    void turns;
  });

  it("merges episode hits after the shared search for a direct owner turn with Continuity on, and not when it is off", async () => {
    const db = database(), scopeId = scopeOf("moss");
    writeEpisode(db, { botId: "moss", scopeId, threadId: "private", closingMessageId: "e3", text: GOOD, handles: handles(4) });
    const registry = new InternalCapabilities(), generation = registry.begin("moss", "private");
    const token = registry.mint({ botId: "moss", threadId: "private", generation, depth: 0, kind: "memory", skillAuthoring: false });
    const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster as never);
    const on = await buildMemoryBundle("tide tables", access, emptyBridge, { continuity: true });
    expect(on.text).toContain("review the tide tables on Friday");
    expect(on.text).toContain("a summary I wrote of an earlier conversation");
    const off = await buildMemoryBundle("tide tables", access, emptyBridge);
    expect(off.text).not.toContain("tide tables on Friday");
  });
});

// ---------------------------------------------------------- the lane ----

describe("lane 5", () => {

  it("ignores the pseudo thread of a reflection attempt in provider events", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/isPipReflectThread/);
  });
  it("routes the learning destination for the pip-reflection writer to the bot's own scope only", async () => {
    const { learningDestination, LEARNING_WRITERS } = await import("./learning-destination.ts");
    expect(LEARNING_WRITERS).toContain("pip-reflection");
    const own = ensureScope("conversation", "private"), other = ensureScope("conversation", "other-thread"), room = ensureScope("room", "r1");
    const botScope = scopeOf("moss");
    expect(learningDestination({ botId: "moss", evidenceScopeIds: [own], target: "identity" })).toMatchObject({ ok: true, scopeId: botScope, audienceKey: "bot:moss:owner" });
    expect(learningDestination({ botId: "moss", evidenceScopeIds: [other], target: "identity" })).toEqual({ ok: false, reason: "cross-partition" });
    expect(learningDestination({ botId: "moss", evidenceScopeIds: [own, other], target: "identity" })).toEqual({ ok: false, reason: "cross-partition" });
    expect(learningDestination({ botId: "moss", evidenceScopeIds: [room], target: "identity" })).toEqual({ ok: false, reason: "cross-partition" });
    expect(learningDestination({ evidenceScopeIds: [own], target: "identity" })).toEqual({ ok: false, reason: "cross-partition" });
  });
  it("settleRun clears a finished run and leaves the cursor of a refused one", () => {
    const r = rig();
    mutateReflect("moss", (s) => { s.run = { runId: "x", kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: "o1", toAt: T0, window: { bytes: 1 }, bootEpoch: r.deps.bootEpoch, createdAt: T0, fingerprint: "f", families: { lived: { state: "applied", attempt: 1, snapshotGen: "g" } } } as RunRecord; });
    settleRun(r.deps, "moss");
    expect(state().run).toBeUndefined();
    expect(state().threads.private.cursorMessageId).toBe("o1");
  });
});

// ------------------------------------------------- owner route and copy ----

describe("the owner route, the copy rules and the engine wiring", () => {
  const ACTION = "/api/memory/action";
  it("lists, confirms, and reports reflection status through the owner action route; a non-owner is refused", async () => {
    seedConversation();
    const r = rig(); r.set(async i => proposeFirst(i)); await run(r);
    const listed = await memoryOwnerRoute(ACTION, { action: "pip-proposals", botId: "moss" }, ticket, roster as never) as { proposals: Array<{ id: string; version: number }>; counters: unknown[] };
    expect(listed.proposals).toHaveLength(1);
    expect(listed.counters).toEqual([]);
    expect(await memoryOwnerRoute(ACTION, { action: "pip-reflect-status", botId: "moss" }, ticket, roster as never)).toMatchObject({ dailyCap: 24, running: false, engine: "Stub engine" });
    const confirmed = await memoryOwnerRoute(ACTION, { action: "pip-proposal-confirm", botId: "moss", id: listed.proposals[0].id, expectedVersion: listed.proposals[0].version }, ticket, roster as never);
    expect(confirmed).toMatchObject({ ok: true });
    expect(await memoryOwnerRoute(ACTION, { action: "pip-reflect-retry", botId: "moss" }, ticket, roster as never)).toEqual({ ok: true });
    await expect(memoryOwnerRoute(ACTION, { action: "pip-proposals", botId: "moss" }, {} as never, roster as never)).rejects.toThrow("MEMORY_OWNER_REQUIRED");
    await expect(memoryOwnerRoute(ACTION, { action: "pip-proposals", botId: "ghost" }, ticket, roster as never)).rejects.toThrow("MEMORY_SUBJECT_UNKNOWN");
  });
  it("I-24: no em dash, and none of the banned words, in any string the reflection path adds", () => {
    const strings = [LIVED_SYSTEM, COUNTER_TEXT, ...Object.values(LIVED_BASIS), EPISODE_BASIS, HELD_PLUGIN_COPY, LOGIN_ROUTE_COPY,
      supportCopy({ status: "unsupported", reason: "tools", at: 0 }, "Fuigo")!, supportCopy({ status: "unsupported", reason: "plugins", at: 0 })!, supportCopy({ status: "transient", reason: "x", at: 0 })!];
    for (const text of strings) {
      expect(text, text).not.toMatch(/[\u2014\u2013]/);
      expect(text, text).not.toMatch(/\b(safe|safety|unsafe)\b|always-on|self-evolving/i);
      expect(text, text).not.toMatch(/\b(feel|feels|aware|conscious|alive)\b/i);
    }
  });
  it("the Fuigo and Grok engines provide a text-only turn through the shared headless transport", () => {
    const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    const core = read("../drivers/acp/core.ts"), fuigo = read("../drivers/acp/fuigo.ts"), grok = read("../drivers/acp/grok.ts");
    expect(core).toContain("...(support.textOnlyTurn ? { textOnlyTurn: true as const } : {})");
    expect(fuigo).toContain('headlessTextOnlyTurn(turn, { engine: "fuigo"');
    expect(grok).toContain('headlessTextOnlyTurn(turn, { engine: "grok"');
  });
});

describe("Astra audit2 production regressions", () => {
  it.each(["routing", "publication", "re-enabled"])("16: rereads the store bot at %s with detached runner settings", async phase => {
    const { Store } = await import("../store.ts");
    const store = new Store(() => ({ instanceId: "stub", model: "model" }));
    const live = store.createBot({ name: "Moss" }, { seedMessages: false });
    store.patchBot(live.id, { continuity: true, continuityOptions: { reflect: true } });
    setMemoryCaptureRoster(() => store);
    owner("o1", T0, BRIEF_SENTENCE, live.threadId); reply("b1", T0 + 1000, "Sure.", live.threadId);
    const r = rig({ bot: bot({ id: live.id, threadIds: [live.threadId] }) });
    r.deps.bots = () => store.bots.map(b => ({ id: b.id, name: b.name, threadIds: [b.threadId], continuity: b.continuity === true, options: b.continuityOptions, settingsGeneration: b.continuityGeneration }));
    const resolve = r.deps.resolveRoute;
    if (phase === "routing") r.deps.resolveRoute = async (...args) => { const route = await resolve(...args); store.patchBot(live.id, { continuity: undefined }); return route; };
    else r.set(async input => { store.patchBot(live.id, { continuityOptions: undefined }); if (phase === "re-enabled") store.patchBot(live.id, { continuityOptions: { reflect: true } }); return proposeFirst(input); });
    expect((await run(r)).reason).toBe("off");
    expect(r.calls.length).toBe(phase === "routing" ? 0 : 1);
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind IN ('pip-proposal','episode')").get()!.n).toBe(0);
    expect(readReflectState(database(), live.id).threads[live.threadId].cursorMessageId).toBeNull();
  });

  it("17: retains cancelled ownership until the adapter settles and fences old hooks", async () => {
    seedConversation();
    const r = rig(), abort = new AbortController();
    let finish!: (v: TextOnlyTurnResult) => void, input!: TextOnlyTurnInput;
    r.set(async i => {
      input = i;
      await i.transport!.hooks!.onIntent!({ ...i.context, tempRoot: join(DATA_DIR, "pip-tmp", "held"), bootEpoch: r.deps.bootEpoch, intentAt: T0, deadlineAt: T0 + 270000 });
      await i.transport!.hooks!.onChild!({ pid: 999900, startTime: "owned", registeredAt: T0 });
      return new Promise(resolve => { finish = resolve; });
    });
    let settled = false;
    const pending = runPipReflect(r.deps, "moss", abort.signal).then(v => { settled = true; return v; });
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      abort.abort(); await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      expect(state().run?.families.lived).toMatchObject({ state: "uncertain-transport", attempt: 1, transport: { child: { pid: 999900 } } });
      finish(verdictResult({ state: "uncertain-transport", reason: "exit-not-confirmed" }));
      expect((await pending).status).toBe("uncertain");
      const original = state().run!;
      mutateReflect("moss", s => { s.run = { ...original, runId: "new-run", families: { lived: { state: "pending", attempt: 1, snapshotGen: "new" } } }; });
      await input.transport!.hooks!.onIntent!({ ...input.context, tempRoot: "old", bootEpoch: r.deps.bootEpoch, intentAt: T0, deadlineAt: T0 });
      await input.transport!.hooks!.onChild!({ pid: 999901, startTime: "late", registeredAt: T0 });
      expect(state().run?.families.lived.transport).toBeUndefined();
    } finally { finish?.(verdictResult({ state: "uncertain-transport", reason: "fixture-end" })); await pending; }
  });

  it.each(['"You are reliable. You always apologize."', 'You are reliable?', 'You are reliable if the build is green.', 'You said: You are reliable.', '> You are reliable.', 'From: Pat\nSubject: note\nYou are reliable.', '"Quoted:\n> a pasted line\nYou are reliable.\n"'])("18: rejects interior nominations from %s and leaves the cursor", async text => {
    seedConversation(1, text);
    const r = rig(), start = Buffer.byteLength(text.slice(0, text.indexOf("You are reliable")));
    r.set(async () => result({ proposals: [{ act: "OBS-STATE", spans: [{ sourceId: "message:private:o1", start, end: start + 16 }] }], stance: [], episode: null }));
    expect((await run(r)).status).toBe("refused");
    expect(r.calls).toHaveLength(3);
    expect(state().threads.private.cursorMessageId).toBeNull();
    expect(state().refusals[0]).toMatchObject({ state: "refused:bad-output", reason: "bad-output:owner-evidence" });
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(0);
  });

  it("18: confirmation rejects a persisted interior span from a quoted source", async () => {
    const { writeProposals } = await import("./pip-lived.ts");
    const sourceId = owner("quoted", T0, '"You are reliable."');
    const claim = ownerClaim("You are reliable.");
    writeProposals(database(), "moss", scopeOf("moss"), [{ targetKind: "self-trait", statement: claim.statement, claim: claim.claim, act: claim.production, handles: [{ sourceId, revision: 1, start: 1, end: 17 }] }]);
    const proposal = listProposals(ticket, "moss", roster as never)[0];
    expect(confirmPipProposal(ticket, { botId: "moss", id: proposal.id, expectedVersion: proposal.version }, roster as never)).toEqual({ ok: false, reason: "invalid" });
  });

  it("19: startup and maintenance recover disabled applied-only runs and orphan roots with memory off", async () => {
    const { maintainPip } = await import("./pip-reflect.ts");
    const { MemoryWorkerController, MEMORY_IDLE_SWEEP_MS } = await import("./worker-controller.ts");
    const r = rig({ bot: bot({ continuity: false }), reaper: { sweep: async () => [] } });
    const root = join(r.deps.tmpBase, "orphan"); mkdirSync(root, { recursive: true });
    const seed = (runId: string) => mutateReflect("moss", s => { s.run = { runId, kind: "reflect", threadId: "private", toMessageId: "o1", fromMessageId: null, toAt: T0, createdAt: T0, bootEpoch: r.deps.bootEpoch, fingerprint: "fp", window: { bytes: 1 }, families: { lived: { state: "applied", attempt: 1, snapshotGen: "g" } } }; });
    seed("startup"); setMemoryMode("off"); vi.useFakeTimers();
    const worker = new MemoryWorkerController({ onMaintenance: startup => maintainPip(r.deps, { startup }) });
    try {
      worker.start(); await vi.advanceTimersByTimeAsync(1);
      expect(state().run).toBeUndefined(); expect(state().threads.private.cursorMessageId).toBe("o1"); expect(existsSync(root)).toBe(false);
      seed("tick"); mutateReflect("moss", s => { s.run!.families.lived.state = "pending"; }); await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS);
      expect(state().run).toBeUndefined(); expect(state().refusals[0].state).toBe("refused:off"); expect(r.calls).toHaveLength(0);
    } finally { await worker.stop(); }
  });

  it("20: the worker admits learning beside continuity and owns both through shutdown", async () => {
    const { MemoryWorkerController, MEMORY_IDLE_SWEEP_MS } = await import("./worker-controller.ts");
    const releases: Array<() => void> = [], began: string[] = [];
    const work = (name: string) => { began.push(name); return new Promise<void>(resolve => releases.push(resolve)); };
    vi.useFakeTimers();
    const worker = new MemoryWorkerController({ onContinuity: () => work("continuity"), onIdleConsolidation: () => work("learning") });
    try {
      worker.start(); await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS + 1);
      expect(began).toEqual(["continuity", "learning"]);
      let stopped = false; const stopping = worker.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      releases.forEach(release => release()); await stopping; expect(stopped).toBe(true);
    } finally { releases.forEach(release => release()); await worker.stop(); }
  });

  it("21: runs and persists a trivial-schema probe before the content request", async () => {
    seedConversation(); const r = rig(); const resolve = r.deps.resolveRoute;
    r.deps.resolveRoute = async (...args) => ({ ...await resolve(...args), probeRequired: true });
    r.set(async input => (input.outputSchema.required as string[] | undefined)?.[0] === "ok" ? result({ ok: true }) : proposeFirst(input));
    expect((await run(r)).status).toBe("applied");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].text).not.toContain(BRIEF_SENTENCE);
    expect(r.calls[0].outputSchema.required).toEqual(["ok"]);
    const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'continuity-budget:moss:%'").get()!.intent));
    expect(ledger.bytes).toBe(r.calls.reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify([{ role: "user", content: call.text }])), 0));
    expect(state().support["fp-1"].probe?.verdict.state).toBe("validated");
    expect(listProposals(ticket, "moss", roster as never)).toHaveLength(1);
  });

  it("15: settles an unreported output at its byte estimate", async () => {
    seedConversation(); const r = rig(); const body = { proposals: [], stance: [], episode: null };
    r.set(async () => result(body, { usage: undefined })); await run(r);
    const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'continuity-budget:moss:%'").get()!.intent));
    expect(ledger.output).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3.5));
  });

  it("24: repeated owner edits keep incrementing the generation", async () => {
    const first = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "brief", expectedVersion: 0, text: "I will be brief", basis: "owner-fact", audience: "owner-private" }, roster as never);
    for (let n = 1; n <= 2; n++) writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "brief", expectedVersion: n, text: n === 1 ? "I will be detailed" : "I will be brief", basis: "owner-fact", audience: "owner-private" }, roster as never);
    const row = database().prepare("SELECT entities FROM memory_record_details WHERE record_id=? AND record_version=3").get(first.id)!;
    expect(JSON.parse(String(row.entities))).toContain("gen:3");
  });

  it("24: an occasion has one stance and exclusion, edits and deletion subtract membership", async () => {
    const { supportCount } = await import("./pip-lived.ts");
    const { setReflectExcluded } = await import("./pip-reflect.ts");
    const { applyMemoryTombstones } = await import("./restore.ts");
    const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "brief", expectedVersion: 0, text: "I will be brief", basis: "owner-fact", audience: "owner-private" }, roster as never);
    const text = "Please be brief. Please be detailed.", sourceId = owner("stance", T0, text);
    const apply = (quote: string, start: number) => applyStanceEvents(database(), "moss", scopeOf("moss"), [{ targetId: target.id, quote, handle: { sourceId, revision: 1, start, end: start + Buffer.byteLength(quote) } }]);
    apply("Please be brief.", 0); expect(supportCount(database(), "moss", target.id, 1)).toBe(1);
    apply("Please be detailed.", 17); expect(supportCount(database(), "moss", target.id, 1)).toBe(0);
    expect(readCounter(database(), "moss", target.id, 1)?.occasions).toEqual([sourceId]);
    setReflectExcluded("moss", "private", true); expect(readCounter(database(), "moss", target.id, 1)?.occasions).toEqual([]);
    setReflectExcluded("moss", "private", false); expect(readCounter(database(), "moss", target.id, 1)?.occasions).toEqual([sourceId]);
    owner("stance", T0, "Please be brief."); expect(readCounter(database(), "moss", target.id, 1)?.occasions).toEqual([]);
    const next = owner("other-stance", T0 + 1000, "Please be detailed.");
    applyStanceEvents(database(), "moss", scopeOf("moss"), [{ targetId: target.id, quote: "Please be detailed.", handle: { sourceId: next, revision: 1, start: 0, end: 19 } }]);
    database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(next); applyMemoryTombstones(database());
    expect(readCounter(database(), "moss", target.id, 1)?.occasions).toEqual([]);
    expect(await memoryOwnerRoute("/api/memory/action", { action: "pip-reflect-exclude", botId: "moss", threadId: "private", excluded: true }, ticket, roster as never)).toEqual({ ok: true });
    await expect(memoryOwnerRoute("/api/memory/action", { action: "pip-reflect-exclude", botId: "moss", threadId: "other-thread", excluded: true }, ticket, roster as never)).rejects.toThrow();
  });

  it("25: confirmation enforces expiry and maintenance recovers missed trace days without inference", async () => {
    const { maintainPip } = await import("./pip-reflect.ts");
    seedConversation(); const r = rig(); r.set(async input => proposeFirst(input)); await run(r);
    const p = listProposals(ticket, "moss", roster as never)[0];
    database().prepare("UPDATE memory_records SET created_at=? WHERE id=?").run(Date.now() - PROPOSAL_EXPIRY_MS - 1, p.id);
    expect(confirmPipProposal(ticket, { botId: "moss", id: p.id, expectedVersion: p.version }, roster as never)).toEqual({ ok: false, reason: "invalid" });
    r.clock.now = T0 + 4 * 86400000; r.calls.length = 0;
    await maintainPip(r.deps);
    expect(state().lastTraceDay).toBe(continuityDay(r.clock.now - 86400000));
    expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='episode' AND state='active'").get()!.n).toBeGreaterThan(0);
    expect(r.calls).toHaveLength(0);
  });

  it("26: records a single oversized source as unreflected and never dispatches it", async () => {
    seedConversation(1, "You are " + "reliable ".repeat(4000)); const r = rig();
    await run(r); expect(r.calls).toHaveLength(0);
    expect(reflectionStatus("moss", r.clock.now).unreflected).toBe(1);
    expect(state().threads.private.cursorMessageId).toBeNull();
    const huge = { ...admissibleOwnerSources(database(), "moss", { threadId: "private" })[0], text: "You are " + "reliable ".repeat(10000) };
    const fitted = fitSnapshot(database(), { sources: [huge], replies: [], truncated: [], bytes: Buffer.byteLength(huge.text) + 96 }, r.bot, []);
    expect(fitted.snap.sources).toEqual([]); expect(fitted.snap.truncated).toEqual([huge]);
    expect(Buffer.byteLength(JSON.stringify([{ role: "user", content: fitted.envelope }]))).toBeLessThanOrEqual(REQUEST_BYTES);
  });

  it("27: only an applied run has a reflected timestamp and reported overruns survive settlement", async () => {
    seedConversation(); const r = rig();
    r.set(async () => verdictResult({ state: "refused", reason: "transient", detail: "unavailable", counted: false }));
    await run(r); expect(reflectionStatus("moss", r.clock.now)).toMatchObject({ lastRunAt: r.clock.now, lastAppliedAt: null });
    retryReflection("moss"); r.clock.now += 40 * MIN;
    r.set(async () => result({ proposals: [], stance: [], episode: null }, { reportedOverLimit: true }));
    await run(r); expect(reflectionStatus("moss", r.clock.now)).toMatchObject({ lastAppliedAt: r.clock.now, reportedOverLimit: true });
  });
});

it("25: expired proposals release the open cap before the next application", async () => {
  const { writeProposals } = await import("./pip-lived.ts");
  const sourceId = owner("cap", T0, "You are reliable."), parsed = ownerClaim("You are reliable.");
  const draft = (n: number) => ({ targetKind: "self-trait" as const, statement: `I am reliable ${n}`, claim: parsed.claim, act: parsed.production, handles: [{ sourceId, revision: 1, start: 0, end: 17 }] });
  writeProposals(database(), "moss", scopeOf("moss"), Array.from({ length: 24 }, (_, n) => draft(n)));
  database().prepare("UPDATE memory_records SET created_at=? WHERE kind='pip-proposal'").run(Date.now() - PROPOSAL_EXPIRY_MS - 1);
  expect(writeProposals(database(), "moss", scopeOf("moss"), [draft(25)]).written).toBe(1);
  expect(listProposals(ticket, "moss", roster as never)).toHaveLength(1);
});

it("26: continuity reservations and run caps share the server-local day", async () => {
  const at = new Date(2026, 9, 6, 0, 1).getTime();
  vi.useFakeTimers(); vi.setSystemTime(at);
  const reserved = reserveExtraction([{ role: "user", content: "{}" }], 1, undefined, "continuity", { botId: "local-day", family: "lived", enabled: true });
  expect(reserved.handle.ledgerId).toBe("continuity-budget:local-day:2026-10-06");
  const r = rig(); r.clock.now = at;
  owner("local", at - 60 * MIN, BRIEF_SENTENCE); reply("local-reply", at - 59 * MIN);
  mutateReflect("moss", s => { s.dailyRuns = { day: "2026-10-05", count: DAILY_RUN_CAP, dreamCalls: 0 }; });
  expect((await run(r)).status).toBe("applied");
  expect(state().dailyRuns).toMatchObject({ day: "2026-10-06", count: 1 });
});

it("27: preflight details reach the owner status with bounded plugin copy", async () => {
  seedConversation(); const r = rig();
  r.deps.resolveRoute = async () => ({ fingerprint: "held", engine: "Fixture", model: "fixture", kind: "cli", unsupported: { reason: "managed-config", detail: "inspection-failed: /fixture/plugins" } });
  await run(r);
  expect(reflectionStatus("moss").support.copy).toContain("plugins are installed");
  expect(reflectionStatus("moss").support.copy).toContain("/fixture/plugins");
});

it("24: legacy support membership is subtracted by the owner exclusion action", async () => {
  const { supportCount } = await import("./pip-lived.ts");
  const target = writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "commitment", key: "legacy", expectedVersion: 0, text: "I will be brief", basis: "owner-fact", audience: "owner-private" }, roster as never);
  const sourceId = owner("legacy-support", T0, BRIEF_SENTENCE);
  database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','pip-stance',0,'granted',?)").run("pip-stance:moss", scopeOf("moss"), JSON.stringify({ support: { [`${target.id}#1`]: [sourceId] } }));
  await memoryOwnerRoute("/api/memory/action", { action: "pip-reflect-exclude", botId: "moss", threadId: "private", excluded: true }, ticket, roster as never);
  expect(supportCount(database(), "moss", target.id, 1)).toBe(0);
});

describe("AUDIT2 round 2", () => {
  it.each([false, true])("25: model episodes use their source day, including legacy rows (marker=%s)", async marker => {
    const { maybeTraceEpisode } = await import("./pip-reflect.ts");
    const monday = new Date(2026, 9, 5, 12).getTime(), tuesday = new Date(2026, 9, 6, 12).getTime();
    for (let i = 0; i < 3; i++) owner(`monday-${i}`, monday + i, BRIEF_SENTENCE);
    owner("tuesday", tuesday, BRIEF_SENTENCE);
    const handles = admissibleOwnerSources(database(), "moss", { threadId: "private", untilAt: monday + 3 }).map(a => ({ sourceId: a.sourceId, revision: a.revision, start: 0, end: Buffer.byteLength(a.text) }));
    vi.spyOn(Date, "now").mockReturnValue(tuesday);
    try {
      expect(writeEpisode(database(), { botId: "moss", scopeId: scopeOf("moss"), threadId: "private", closingMessageId: "monday-2", ...(marker ? { day: monday } : {}), text: "We planned the harbour log, the tide table, and the lantern checks.", handles }).written).toBe(true);
      const r = rig(); r.clock.now = new Date(2026, 9, 7, 12).getTime();
      expect(maybeTraceEpisode(r.deps, r.bot)).toBe(false);
      expect(maybeTraceEpisode(r.deps, r.bot)).toBe(true);
      expect(listEpisodes(database(), "moss")).toHaveLength(2);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(["unsupported", "transient"])("3/new-medium: confirmed terminal %s settles without Windows reaping", async reason => {
    seedConversation(); const sweep = vi.fn(async () => []);
    const r = rig({ reaper: { platform: "win32", sweep } });
    r.set(async input => {
      await input.transport!.hooks!.onIntent!({ ...input.context, tempRoot: join(r.deps.tmpBase, "terminal"), bootEpoch: r.deps.bootEpoch, intentAt: r.clock.now, deadlineAt: r.clock.now + MIN });
      return verdictResult(reason === "unsupported" ? { state: "unsupported", reason: "tools" } : { state: "refused", reason: "transient", detail: "try-later", counted: false });
    });
    expect((await run(r)).status).toBe("refused");
    expect(state().run).toBeUndefined(); expect(state().threads.private.cursorMessageId).toBeNull();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("25: catch-up traces use represented days across midnight", async () => {
    const { maybeTraceEpisode } = await import("./pip-reflect.ts");
    const monday = new Date(2026, 9, 5, 12).getTime(), tuesday = new Date(2026, 9, 6, 12).getTime();
    owner("monday", monday, BRIEF_SENTENCE); owner("tuesday", tuesday, BRIEF_SENTENCE);
    const r = rig(); r.clock.now = tuesday;
    vi.spyOn(Date, "now").mockReturnValue(tuesday);
    try {
      expect(maybeTraceEpisode(r.deps, r.bot)).toBe(true);
      r.clock.now = new Date(2026, 9, 7, 12).getTime();
      expect(maybeTraceEpisode(r.deps, r.bot)).toBe(true);
      expect(listEpisodes(database(), "moss")).toHaveLength(2);
    } finally { vi.restoreAllMocks(); }
  });

  it("27: cancellation exposes reported CLI overrun in owner status", async () => {
    seedConversation(); const r = rig();
    r.set(async input => {
      input.transport?.hooks?.onUsage?.({ inputTokens: 11, outputTokens: 4001 });
      reportMemoryUsage({ prompt_tokens: 11, completion_tokens: 4001 });
      throw Object.assign(new Error("cancelled"), { name: "cancelled" });
    });
    expect((await run(r)).status).toBe("uncertain");
    expect(reflectionStatus("moss", r.clock.now).reportedOverLimit).toBe(true);
    expect(state().run?.families.lived.reportedOverLimit).toBe(true);
  });

  it.each([false, true])("absent: maintenance does one query and no sweep or writes without Continuity or PIP state (empty-root=%s)", async emptyRoot => {
    const { maintainPip } = await import("./pip-reflect.ts");
    const r = rig({ bot: bot({ continuity: false }) });
    if (emptyRoot) mkdirSync(r.deps.tmpBase, { recursive: true });
    const db = database(), prepare = vi.spyOn(db, "prepare");
    try {
      await maintainPip(r.deps);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(prepare.mock.calls[0][0]).toMatch(/^SELECT /);
    } finally { prepare.mockRestore(); }
  });
});
