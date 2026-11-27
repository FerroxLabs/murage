// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 (MAIN ruling Q5): an owner source too large for one Pip reflection request is SPLIT, never trimmed and never skipped. It goes
// through in whole units (paragraphs, else sentences; a single sentence longer than a request is cut and marked, and offers no sentence),
// each request under REQUEST_BYTES, one piece per run, in order; the source is reflected (the cursor passes it) only when its last piece is
// applied, and a piece that fails leaves it unreflected with its progress as it was.
// Driven through runPipReflect, the production entry of a Pip reflection; the engine stub plays the model: it nominates the sentences its
// request offers, and its one write is released through the call's learning gate as the drivers do. Synthetic fixture text only.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { parseOwnerSentence } from "./pip-claims.ts";
import { COOLDOWN_MS, REQUEST_BYTES, pipReadHooks, readReflectState, resetPipPendingScans, runPipReflect, sentenceRanges, type ReflectBot, type ReflectDeps, type ReflectOutcome } from "./pip-reflect.ts";
import type { IsolationReport, TextOnlyTurnInput, TextOnlyTurnResult } from "./pip-transport.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";

const T0 = 1_760_000_000_000, MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private" }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never); resetPipPendingScans();
});
afterEach(() => { setMemoryCaptureRoster(null); pipReadHooks.between = undefined; vi.restoreAllMocks(); closeDatabase(); });

const done = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100");
const sourceIdOf = (id: string) => `message:private:${id}`;
let seq = 0;
/** One owner message and the assistant's settled reply to it. */
function say(id: string, text: string) {
  const at = T0 + seq++ * MIN;
  captureStoredMessage(database(), "private", { id, at, role: "user", kind: "text", text, origin: "desktop" } as never); done();
  captureStoredMessage(database(), "private", { id: `${id}-reply`, at: at + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never); done();
}
/** The lease paces learning calls by the wall clock (extract.ts: callsPerMinute); `wall` moves it for a test whose calls are instant. */
let wall = 0;
beforeEach(() => { seq = 0; wall = 0; const real = Date.now.bind(Date); vi.spyOn(Date, "now").mockImplementation(() => real() + wall); });

// ---- fixture: about 200 KB in one owner message -----------------------------------------------------------------------------------
const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "inlet", "jetty", "kelp", "larch", "marsh", "nook", "otter", "pier"];
const FILLER = "The harbor ledger shows the usual cargo moving through berth nine at the usual hour of the morning. ";
/** Sixteen paragraphs of about 8 KB, each holding one instruction the owner gives the assistant, in the middle of filler. */
const paragraphs = WORDS.map(word => FILLER.repeat(40) + `From now on check the ${word} tide table first. ` + FILLER.repeat(40).trimEnd());
/** One sentence of about 75 KB with no boundary in it: no request can hold it whole. */
const LONG_SENTENCE = "From now on check " + "the long tide table ".repeat(3750) + "first.";
const BIG = [...paragraphs.slice(0, 8), LONG_SENTENCE, ...paragraphs.slice(8)].join("\n\n");
const BIG_BYTES = Buffer.byteLength(BIG);
const longStart = Buffer.byteLength(BIG.slice(0, BIG.indexOf(LONG_SENTENCE))), longEnd = longStart + Buffer.byteLength(LONG_SENTENCE);

// ---- the engine --------------------------------------------------------------------------------------------------------------------
interface Sentence { start: number; end: number; text: string }
interface Turn { sourceId?: string; from: string; text?: string; sentences?: Sentence[]; part?: { start: number; end: number; of: number; cut?: boolean } }
const iso: IsolationReport = { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn" };
const turnsOf = (input: TextOnlyTurnInput) => (JSON.parse(input.text) as { turns: Turn[] }).turns.filter(t => t.from === "owner");
const requestBytes = (input: TextOnlyTurnInput) => Buffer.byteLength(JSON.stringify([{ role: "user", content: input.text }]));
/** What a model that follows its instructions returns: up to six of the sentences the request offers, each with the act it performs. */
function nominateOffered(input: TextOnlyTurnInput) {
  const proposals: Array<{ act: string; spans: Array<{ sourceId: string; start: number; end: number }> }> = [];
  for (const turn of turnsOf(input)) for (const s of turn.sentences ?? []) {
    const parsed = parseOwnerSentence(s.text, { botName: "Moss" });
    if (parsed.ok && parsed.production !== "RETRACT" && proposals.length < 6) proposals.push({ act: parsed.production, spans: [{ sourceId: turn.sourceId!, start: s.start, end: s.end }] });
  }
  return { proposals, stance: [], episode: null };
}
type Answer = (input: TextOnlyTurnInput, nth: number) => unknown | "garbage" | "dead";
function rig(answer: Answer = nominateOffered) {
  const bot: ReflectBot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true } };
  const sent: TextOnlyTurnInput[] = [];
  // `after` runs once the request has left and the engine answered, before publication (a turn stored while the request is out)
  const clock = { now: T0 + 600 * MIN }, engine: { answer: Answer; after?: (input: TextOnlyTurnInput) => void } = { answer };
  const deps: ReflectDeps = {
    now: () => clock.now++, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({
      fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model",
      textOnlyTurn: async input => {
        if (!input.transport?.gate) throw new Error("no gate");
        const reply = engine.answer(input, sent.length);
        // the engine process never started: nothing is written, nothing leaves
        if (reply === "dead") throw new Error("engine did not start");
        const out = await input.transport.gate.send((): TextOnlyTurnResult => {
          sent.push(input);
          const text = reply === "garbage" ? "not json" : JSON.stringify(reply);
          return { text, usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: reply } };
        });
        engine.after?.(input);
        return out;
      },
    }),
  };
  return { deps, sent, clock, engine };
}
type Rig = ReturnType<typeof rig>;
/** One idle pass of lane 5 (one runPipReflect, as index.ts onContinuity makes). A pass the lease refused for pace (more than its calls per
 *  minute: the existing queue, nothing sent) is waited out: the next minute, and the thread's spacing after a refused run. */
async function pass(r: Rig): Promise<ReflectOutcome> {
  const outcome = await runPipReflect(r.deps, undefined, new AbortController().signal);
  if (outcome.status === "refused" && outcome.reason === "call-pace") { wall += 61_000; r.clock.now += 31 * MIN; }
  return outcome;
}
/** Passes until two in a row have nothing to do with the thread's spacing waited out between them (or `limit` passes). */
async function reflectUntilIdle(r: Rig, limit = 80): Promise<ReflectOutcome[]> {
  const outcomes: ReflectOutcome[] = [];
  for (let i = 0, idle = 0; i < limit; i++) {
    const outcome = await pass(r);
    outcomes.push(outcome);
    if (outcome.status !== "idle" || readReflectState(database(), "moss").run) { idle = 0; continue; }
    if (++idle > 1) break;
    r.clock.now += 31 * MIN;
  }
  return outcomes;
}
const thread = () => readReflectState(database(), "moss").threads.private as (ReturnType<typeof readReflectState>["threads"][string] & { split?: { offset: number } }) | undefined;
/** The pieces of `id` the engine was shown, in the order they left. */
const piecesOf = (sent: TextOnlyTurnInput[], id: string) => sent.flatMap(turnsOf).filter(t => t.sourceId === sourceIdOf(id));
/** Every published proposal with the owner bytes it rests on. */
function published() {
  return database().prepare(`SELECT r.text AS statement,e.source_id AS sourceId,e.start_byte AS start,e.end_byte AS end FROM memory_records r
    JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='pip-proposal' AND r.state='active' ORDER BY e.start_byte`).all() as Array<{ statement: string; sourceId: string; start: number; end: number }>;
}
const bytesOf = (text: string, start: number, end: number) => Buffer.from(text).subarray(start, end).toString();

describe("an oversized Pip source is split into whole units, every piece reflected in order (MAIN ruling Q5)", () => {
  it("W1: a 200 KB source reflects fully: every byte is shown once, in order, each request under REQUEST_BYTES, and the cursor passes it", async () => {
    say("big", BIG);
    expect(BIG_BYTES).toBeGreaterThan(200_000);
    const r = rig();
    await reflectUntilIdle(r);
    const pieces = piecesOf(r.sent, "big");
    // the whole source went out, piece after piece, nothing twice and nothing missing
    expect(pieces.map(p => p.text).join("")).toBe(BIG);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.map(p => p.part!.start)).toEqual([0, ...pieces.slice(0, -1).map(p => p.part!.end)]);
    expect(pieces[pieces.length - 1]!.part!.end).toBe(BIG_BYTES);
    for (const input of r.sent) expect(requestBytes(input)).toBeLessThanOrEqual(REQUEST_BYTES);
    // one piece per request, and nothing else of the source in it
    expect(r.sent.map(input => turnsOf(input).length)).toEqual(r.sent.map(() => 1));
    // every sentence of the source a request can hold was offered, exactly once, in order
    const whole = sentenceRanges(BIG, { botName: "Moss" });
    const offered = pieces.flatMap(p => p.sentences ?? []).map(s => [s.start, s.end]);
    expect(offered).toEqual(whole.filter(s => !(s.start === longStart && s.end === longEnd)).map(s => [s.start, s.end]));
    expect(offered).toHaveLength(WORDS.length);
    // reflected: the cursor is past it and it is no longer noted as unreflected
    expect(thread()?.cursorMessageId).toBe("big");
    expect(thread()?.unreflected).toEqual([]);
    expect(thread()?.split).toBeUndefined();
    expect(published().map(p => p.statement)).toEqual(WORDS.map(word => `From now on, I will check the ${word} tide table first`));
  }, 120_000);

  it("W2: no published sentence is a cut fragment: each rests on one whole sentence of the stored text, and a cut piece offers none", async () => {
    say("big", BIG);
    const r = rig();
    await reflectUntilIdle(r);
    const pieces = piecesOf(r.sent, "big"), whole = sentenceRanges(BIG, { botName: "Moss" });
    // every sentence any request offered is a whole sentence of the stored text: same range, same words, inside its piece
    const offered = pieces.flatMap(p => (p.sentences ?? []).map(s => ({ ...s, piece: p.part! })));
    expect(offered.length).toBeGreaterThan(0);
    for (const s of offered) {
      expect(whole.find(w => w.start === s.start && w.end === s.end)?.text).toBe(s.text);
      expect(bytesOf(BIG, s.start, s.end)).toBe(s.text);
      expect(s.start >= s.piece.start && s.end <= s.piece.end).toBe(true);
    }
    // the fixture bites: the long sentence is one admissible sentence of the stored text, and it was cut across several pieces
    expect(whole.some(s => s.start === longStart && s.end === longEnd)).toBe(true);
    const cut = pieces.filter(p => p.part!.cut);
    expect(cut.length).toBeGreaterThan(2);
    // (the last of them carries the blank line that follows the sentence)
    expect(cut.map(p => p.text).join("")).toBe(LONG_SENTENCE + "\n\n");
    // a cut piece is marked and offers no sentence
    expect(cut.flatMap(p => p.sentences ?? [])).toEqual([]);
    // no piece that is not marked cut starts or ends inside a sentence of the stored text
    const spans = BIG.split("\n\n").flatMap(paragraph => paragraph === LONG_SENTENCE ? [paragraph] : paragraph.split(/(?<=\. )/));
    const edges = new Set<number>([0]); let at = 0;
    for (const paragraph of BIG.split("\n\n")) { for (const span of paragraph === LONG_SENTENCE ? [paragraph] : paragraph.split(/(?<=\. )/)) { at += Buffer.byteLength(span); edges.add(at); } at += 2; edges.add(at); }
    expect(spans.length).toBeGreaterThan(1000);
    for (const p of pieces.filter(p => !p.part!.cut)) expect([edges.has(p.part!.start), edges.has(p.part!.end) || p.part!.end === BIG_BYTES]).toEqual([true, true]);
    // what was published: sixteen proposals, each resting on exactly one whole sentence of the stored text, none on any part of the long one
    const rows = published();
    expect(rows).toHaveLength(WORDS.length);
    for (const row of rows) {
      const sentence = whole.find(w => w.start === row.start && w.end === row.end);
      expect(sentence?.text).toBe(bytesOf(BIG, row.start, row.end));
      expect(row.end <= longStart || row.start >= longEnd).toBe(true);
    }
  }, 120_000);

  it("W2b: a model that names a range inside a cut piece, or a sentence outside its piece, publishes nothing from that piece", async () => {
    say("big", BIG);
    const whole = sentenceRanges(BIG, { botName: "Moss" });
    const r = rig(input => {
      const turn = turnsOf(input)[0]!, part = turn.part;
      // a cut piece: the model names the piece's own bytes as if they were a sentence; a whole piece: a real sentence, but of another piece
      if (part?.cut) return { proposals: [{ act: "INSTR-DO", spans: [{ sourceId: turn.sourceId!, start: part.start, end: part.end }] }], stance: [], episode: null };
      const outside = whole.find(s => part && (s.end <= part.start || s.start >= part.end) && !(s.start === longStart))!;
      return { proposals: [{ act: "INSTR-DO", spans: [{ sourceId: turn.sourceId!, start: outside.start, end: outside.end }] }], stance: [], episode: null };
    });
    const outcomes = await reflectUntilIdle(r, 4);
    expect(r.sent.length).toBeGreaterThan(0);
    expect(piecesOf(r.sent, "big")[0]!.part).toBeDefined();
    expect(outcomes.some(o => o.status === "refused" && o.reason === "bad-output")).toBe(true);
    expect(published()).toEqual([]);
    expect(thread()?.cursorMessageId ?? null).toBeNull();
    // then the long sentence itself: its pieces are reached by a model that behaves until then
    r.engine.answer = input => turnsOf(input)[0]!.part?.cut ? { proposals: [{ act: "INSTR-DO", spans: [{ sourceId: sourceIdOf("big"), start: turnsOf(input)[0]!.part!.start, end: turnsOf(input)[0]!.part!.end }] }], stance: [], episode: null } : nominateOffered(input);
    r.clock.now += COOLDOWN_MS + 31 * MIN;
    let refusedAtCut = false;
    for (let i = 0; i < 40 && !refusedAtCut; i++) {
      const outcome = await pass(r);
      if (outcome.status === "refused" && outcome.reason !== "call-pace") { refusedAtCut = outcome.reason === "bad-output" || outcome.reason === "unstable"; r.clock.now += COOLDOWN_MS + 31 * MIN; }
    }
    expect(piecesOf(r.sent, "big").some(p => p.part!.cut)).toBe(true);
    expect(refusedAtCut).toBe(true);
    // the eight sentences before the long one were published by then, and nothing of the long one
    expect(published()).toHaveLength(8);
    for (const row of published()) expect(row.end <= longStart).toBe(true);
    expect(thread()?.cursorMessageId ?? null).toBeNull();
  }, 120_000);

  it.each([
    ["the engine answers the third piece with nothing usable, every time it is asked", "garbage" as const],
    ["the engine does not start for the third piece (nothing leaves, nothing is paid)", "dead" as const],
  ])("W3: a mid-split failure leaves the source unreflected and unpaid: %s", async (_name, failure) => {
    say("big", BIG);
    const r = rig();
    const pieceStart = (input: TextOnlyTurnInput) => turnsOf(input)[0]!.part!.start;
    // two pieces go through
    for (let i = 0; i < 2; i++) expect((await pass(r)).status).toBe("applied");
    expect(r.sent).toHaveLength(2);
    const secondEnd = turnsOf(r.sent[1]!)[0]!.part!.end, twoPieces = published();
    expect(thread()?.split?.offset).toBe(secondEnd);
    // the source is not reflected yet: the cursor has not moved and it is noted as unreflected
    expect(thread()?.cursorMessageId ?? null).toBeNull();
    expect(thread()?.unreflected).toEqual(["big"]);
    // the third piece fails
    const asked: number[] = [];
    r.engine.answer = input => { asked.push(pieceStart(input)); return failure; };
    const first = await pass(r);
    if (failure === "dead") {
      // unpaid: the attempt is on record as not answered, nothing left, and no call of it was charged
      const attempt = readReflectState(database(), "moss").run?.families.lived;
      expect([first.status, attempt?.state, attempt?.part?.start]).toEqual(["uncertain", "uncertain-transport", secondEnd]);
      expect(attempt?.paidCalls).toBe(0);
      expect(r.sent).toHaveLength(2);
    }
    const failed = [first, ...await reflectUntilIdle(r, 8)];
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([secondEnd]));
    expect(failed.some(o => o.status === "applied")).toBe(false);
    // unreflected: no cursor, still noted, progress exactly where the second piece left it, nothing published from the failed piece
    expect(thread()?.cursorMessageId ?? null).toBeNull();
    expect(thread()?.unreflected).toEqual(["big"]);
    expect(thread()?.split?.offset).toBe(secondEnd);
    expect(published()).toEqual(twoPieces);
    // unpaid: a piece whose request never left is charged nothing, and no failure re-sends (pays again for) a piece already applied
    if (failure === "dead") expect(r.sent).toHaveLength(2);
    expect(r.sent.filter(input => pieceStart(input) < secondEnd)).toHaveLength(2);
    // the queue retries it: the same piece again, then the rest, and only then is the source reflected
    r.engine.answer = nominateOffered;
    r.clock.now += COOLDOWN_MS + 31 * MIN;
    const before = r.sent.length;
    await reflectUntilIdle(r);
    expect(pieceStart(r.sent[before]!)).toBe(secondEnd);
    expect(r.sent.filter(input => pieceStart(input) < secondEnd)).toHaveLength(2);
    expect(thread()?.cursorMessageId).toBe("big");
    expect(thread()?.unreflected).toEqual([]);
    expect(published()).toHaveLength(WORDS.length);
  }, 120_000);

  it("order: what the owner said before the oversized source goes first, the source next piece by piece, what came after it last; nothing is skipped", async () => {
    say("early", "From now on check the early tide table first.");
    say("big", BIG);
    say("late", "From now on check the late tide table first.");
    const r = rig();
    await reflectUntilIdle(r);
    const order = r.sent.map(input => turnsOf(input).map(t => t.sourceId!.replace("message:private:", "")).join("+"));
    const pieces = piecesOf(r.sent, "big");
    expect(order).toEqual(["early", ...pieces.map(() => "big"), "late"]);
    expect(pieces.map(p => p.text).join("")).toBe(BIG);
    expect(thread()?.cursorMessageId).toBe("late");
    expect(thread()?.unreflected).toEqual([]);
    expect(published()).toHaveLength(WORDS.length + 2);
  }, 120_000);

  it("request leg: a source inside the read window whose request is over REQUEST_BYTES is split on sentence edges too, not dropped for a newer one", async () => {
    // about 19 KB of short sentences: each is listed again with its range, so the request alone is over the limit
    const many = Array.from({ length: 1100 }, () => "Always be kind.").join(" ");
    expect(Buffer.byteLength(many)).toBeLessThan(20 * 1024);
    say("many", many);
    say("late", "From now on check the late tide table first.");
    const r = rig();
    await reflectUntilIdle(r);
    const pieces = piecesOf(r.sent, "many");
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map(p => p.text).join("")).toBe(many);
    expect(pieces.filter(p => p.part?.cut)).toEqual([]);
    for (const p of pieces) expect(p.text!.trimEnd().endsWith("kind.") && p.text!.trimStart().startsWith("Always")).toBe(true);
    for (const input of r.sent) expect(requestBytes(input)).toBeLessThanOrEqual(REQUEST_BYTES);
    expect(r.sent.map(input => turnsOf(input)[0]!.sourceId)).toEqual([...pieces.map(() => sourceIdOf("many")), sourceIdOf("late")]);
    expect(thread()?.cursorMessageId).toBe("late");
    expect(thread()?.unreflected).toEqual([]);
  }, 120_000);
});

// ---- never skipped before it is split (MAIN on Astra 9961b72a77) -------------------------------------------------------------------
// Every source that must be split, old or new, with or without progress, by either budget, reaches its first piece: the read keeps only
// the newest 456 sources of a backlog (readSnapshotSliced) and only the newest 24 KiB of them (snapshotWindow), and neither may drop it.
/** About 40 KB in five paragraphs, one instruction in each: over the read window. */
const MID = paragraphs.slice(0, 5).join("\n\n");
/** About 19 KB of short sentences: inside the read window, but each sentence is listed again with its range, so its request alone is over REQUEST_BYTES. */
const MANY = Array.from({ length: 1100 }, () => "Always be kind.").join(" ");
/** More newer owner turns than the read keeps (456). */
const backlog = (n = 460) => { for (let i = 0; i < n; i++) say(`n${i}`, `Berth ${i} was quiet today.`); };
/** One ordinary owner turn of about 10 KB: with MANY before it, the two are over the 24 KiB read window together. */
const WIDE = FILLER.repeat(100).trimEnd();
describe("an oversized source is never skipped before it is split (MAIN on Astra 9961b72a77)", () => {
  let progress: number | undefined;
  beforeEach(() => { progress = undefined; });
  it.each<[string, string, number, (r: Rig) => Promise<void>]>([
    ["scan cap, no progress: over the read window, then more newer turns than the read keeps", MID, 5, async () => { say("old", MID); backlog(); }],
    ["scan cap, no progress: over the request size only, then more newer turns than the read keeps", MANY, -1, async () => { say("old", MANY); backlog(); }],
    ["byte window: over the request size only, then one newer turn that fills the read window", MANY, -1, async () => { say("old", MANY); say("wide", WIDE); }],
    ["scan cap, with progress: one piece applied, then more newer turns than the read keeps", MID, 5, async r => { say("old", MID); await pass(r); progress = thread()?.split?.offset; backlog(); }],
  ])("S: %s", async (name, text, instructions, arrange) => {
    const r = rig(); 
    await arrange(r);
    await reflectUntilIdle(r);
    const pieces = piecesOf(r.sent, "old");
    // the whole source went out in pieces, in order, nothing twice and nothing missing
    expect(pieces.map(p => p.text).join("")).toBe(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map(p => p.part!.start)).toEqual([0, ...pieces.slice(0, -1).map(p => p.part!.end)]);
    expect(pieces.filter(p => p.part!.cut)).toEqual([]);
    // the "with progress" row had its first piece applied (and no more) before the newer turns arrived
    if (name.includes("with progress")) expect(progress).toBe(pieces[0]!.part!.end);
    for (const input of r.sent) expect(requestBytes(input)).toBeLessThanOrEqual(REQUEST_BYTES);
    // nothing newer went before its last piece, and the newer turns went after it
    const own = r.sent.map(input => turnsOf(input).every(t => t.sourceId === sourceIdOf("old")));
    expect(own.slice(0, pieces.length)).toEqual(pieces.map(() => true));
    expect(own.length).toBeGreaterThan(pieces.length);
    // reflected: not noted as skipped, no split left open, and what it holds was published from whole sentences
    expect(thread()?.unreflected ?? []).not.toContain("old");
    expect(thread()?.split).toBeUndefined();
    expect(thread()?.cursorMessageId).not.toBe("old");
    const rows = published().filter(row => row.sourceId === sourceIdOf("old"));
    if (instructions >= 0) expect(rows.map(row => row.statement)).toEqual(WORDS.slice(0, instructions).map(word => `From now on, I will check the ${word} tide table first`));
    const whole = sentenceRanges(text, { botName: "Moss" });
    for (const row of rows) expect(whole.some(w => w.start === row.start && w.end === row.end)).toBe(true);
  }, 240_000);

  it("S5: turns before a source that is over the request size only go first, and none of them is left noted as unreflected", async () => {
    say("a", "From now on check the early tide table first.");
    say("old", MANY);
    say("b", "From now on check the late tide table first.");
    const r = rig();
    await reflectUntilIdle(r);
    const pieces = piecesOf(r.sent, "old");
    const order = r.sent.map(input => turnsOf(input).map(t => t.sourceId!.replace("message:private:", "")).join("+"));
    expect(order).toEqual(["a", ...pieces.map(() => "old"), "b"]);
    expect(pieces.map(p => p.text).join("")).toBe(MANY);
    // every turn was reflected, so none is noted as skipped (the status count reads this list)
    expect(thread()?.unreflected).toEqual([]);
    expect(thread()?.cursorMessageId).toBe("b");
  }, 120_000);

  it("S6: an older oversized source stored while a newer one is mid-split is split too, before the cursor passes the newer one", async () => {
    const OLDER = paragraphs.slice(5, 10).join("\n\n");
    seq = 5; say("old", MID);
    const r = rig();
    await pass(r);
    const progress = thread()?.split?.offset;
    // a turn the owner made earlier is stored late (its time is before the source under way, after the cursor)
    seq = 2; say("older", OLDER);
    const before = r.sent.length;
    await reflectUntilIdle(r);
    expect(piecesOf(r.sent, "older").map(p => p.text).join("")).toBe(OLDER);
    // it goes first: the very next request is its first piece, not the rest of the source under way (the cursor hold of S7 alone would
    // reach it only after that source's last piece)
    expect(turnsOf(r.sent[before]!)[0]?.sourceId).toBe(sourceIdOf("older"));
    expect(progress).toBeGreaterThan(0);
    // the newer source still goes through whole, after it; nothing is left noted as skipped
    const shown = r.sent.map(input => turnsOf(input)[0]!), later = shown.slice(shown.map(t => t.sourceId).lastIndexOf(sourceIdOf("older")) + 1).filter(t => t.sourceId === sourceIdOf("old"));
    expect(later.map(p => p.text).join("")).toBe(MID);
    expect(thread()?.cursorMessageId).toBe("old");
    expect(thread()?.unreflected).toEqual([]);
    expect(thread()?.split).toBeUndefined();
    expect(published().map(p => p.statement).sort()).toEqual(WORDS.slice(0, 10).map(word => `From now on, I will check the ${word} tide table first`).sort());
  }, 240_000);

  it("S7: an older oversized source stored while the LAST piece of a newer one is out is split too, never passed by the cursor (Astra 8f0e715746)", async () => {
    const OLDER = paragraphs.slice(5, 10).join("\n\n");
    seq = 5; say("old", MID);
    const r = rig();
    let storedAfter: number | undefined;
    // once the newer source's last piece has left (and before it is published), a turn the owner made earlier is stored: its time is
    // before the source, after the cursor
    r.engine.after = input => {
      const last = turnsOf(input).find(t => t.sourceId === sourceIdOf("old") && t.part && t.part.end === t.part.of);
      if (!last || storedAfter !== undefined) return;
      storedAfter = r.sent.length; seq = 2; say("older", OLDER);
    };
    await reflectUntilIdle(r);
    // the older source went out whole, in pieces, after the newer one's last piece left (never stored = never reached that point)
    const after = storedAfter ?? r.sent.length;
    expect(piecesOf(r.sent.slice(after), "older").map(p => p.text).join("")).toBe(OLDER);
    // premise: it arrived while that last piece was out, with the newer one already split over more than one piece
    expect(storedAfter ?? 0).toBeGreaterThan(1);
    expect(piecesOf(r.sent.slice(0, after), "old").map(p => p.text).join("")).toBe(MID);
    expect(thread()?.unreflected).toEqual([]);
    expect(thread()?.split).toBeUndefined();
    expect(published().map(p => p.statement).sort()).toEqual(WORDS.slice(0, 10).map(word => `From now on, I will check the ${word} tide table first`).sort());
  }, 240_000);
});

describe("a split piece is charged only once it is dispatched (MAIN on Astra 5460ee9b24)", () => {
  it("S8: a piece whose release finds the write lock taken (nothing leaves) is charged nothing, however often; once the lock is free it leaves and is paid once", async () => {
    say("big", BIG);
    const r = rig();
    for (let i = 0; i < 2; i++) expect((await pass(r)).status).toBe("applied");
    const secondEnd = turnsOf(r.sent[1]!)[0]!.part!.end;
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      // the next three tries of the third piece: just before the gate's release transaction begins (production releaseTransaction, whose
      // BEGIN IMMEDIATE is passed through), another connection takes the write lock and holds it until the try is over
      const db = database(), exec = db.exec.bind(db);
      let take = false, taken = 0;
      db.exec = (sql: string) => {
        if (take && sql === "BEGIN IMMEDIATE" && /releaseTransaction/.test(new Error().stack ?? "")) { take = false; taken++; other.exec("BEGIN IMMEDIATE"); queueMicrotask(() => other.exec("ROLLBACK")); }
        return exec(sql);
      };
      const answer = r.engine.answer;
      r.engine.answer = (input, nth) => { take = true; return answer(input, nth); };
      const busy: ReflectOutcome[] = [];
      for (let i = 0; i < 3; i++) busy.push(await pass(r));
      const attempt = readReflectState(database(), "moss").run?.families.lived;
      // premise: every try found the lock taken at its release, and nothing left
      expect(taken).toBeGreaterThanOrEqual(3);
      expect(r.sent).toHaveLength(2);
      // the behaviour: a piece never dispatched is charged nothing, so the busy lock never spends the paid-call cap (on 5460ee9b24 the
      // charge made before the release stayed, its refund refused by the same lock, and the piece was refused for paid calls, unsent)
      expect(busy.filter(o => o.status === "refused")).toEqual([]);
      expect(attempt?.paidCalls).toBe(0);
      expect(busy.map(o => [o.status, o.reason])).toEqual([["uncertain", "busy"], ["uncertain", "busy"], ["uncertain", "busy"]]);
      expect(attempt?.part?.start).toBe(secondEnd);
      // the lock is free: the piece leaves, is paid once and applied
      r.engine.answer = answer; delete (db as { exec?: unknown }).exec;
      let paidAtSend: number | undefined;
      r.engine.after = () => { paidAtSend = readReflectState(database(), "moss").run?.families.lived?.paidCalls; };
      expect((await pass(r)).status).toBe("applied");
      expect(r.sent).toHaveLength(3);
      // charged with its release, the moment it left (before the turn even returned), and once
      expect(paidAtSend).toBe(1);
      expect(turnsOf(r.sent[2]!)[0]!.part!.start).toBe(secondEnd);
      expect(thread()?.split?.offset).toBe(turnsOf(r.sent[2]!)[0]!.part!.end);
    } finally { delete (database() as { exec?: unknown }).exec; if (other.isTransaction) other.exec("ROLLBACK"); other.close(); }
  }, 120_000);

  it("S8b: the lock is held through the gate's refund and the turn's refund too: the unsent piece is still never refused for paid calls, and is paid once when it leaves", async () => {
    say("big", BIG);
    const r = rig();
    for (let i = 0; i < 2; i++) expect((await pass(r)).status).toBe("applied");
    const secondEnd = turnsOf(r.sent[1]!)[0]!.part!.end;
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    const db = database(), exec = db.exec.bind(db);
    try {
      // another connection takes the write lock just before the release and holds it through every refund of that try (the gate's, from
      // learning-send, and any later one), letting go at the first other write
      let take = false, taken = 0;
      db.exec = (sql: string) => {
        if (sql === "BEGIN IMMEDIATE") {
          const stack = new Error().stack ?? "";
          if (take && /releaseTransaction/.test(stack)) { take = false; taken++; other.exec("BEGIN IMMEDIATE"); }
          else if (other.isTransaction && !/learning-send\.ts|\brefund\b/.test(stack)) other.exec("ROLLBACK");
        }
        return exec(sql);
      };
      const answer = r.engine.answer;
      r.engine.answer = (input, nth) => { take = true; return answer(input, nth); };
      const busy: ReflectOutcome[] = [];
      for (let i = 0; i < 4; i++) busy.push(await pass(r));
      if (other.isTransaction) other.exec("ROLLBACK");
      // premise: the tries found the lock taken at their release (three at least: a fourth may be refused before it), and nothing left
      expect(taken).toBeGreaterThanOrEqual(3);
      expect(r.sent).toHaveLength(2);
      // the behaviour: the charges of the unsent tries never spend the paid-call cap
      expect(busy.filter(o => o.status === "refused")).toEqual([]);
      // and the refund is durable: the stored count a restart reads is 0 (the busy deferral after each try carried it)
      expect(readReflectState(database(), "moss").run?.families.lived?.paidCalls).toBe(0);
      r.engine.answer = answer; delete (db as { exec?: unknown }).exec;
      let paidAtSend: number | undefined;
      r.engine.after = () => { paidAtSend = readReflectState(database(), "moss").run?.families.lived?.paidCalls; };
      expect((await pass(r)).status).toBe("applied");
      expect(turnsOf(r.sent[2]!)[0]!.part!.start).toBe(secondEnd);
      // paid once: the owed refunds were settled by the charge of the try that left
      expect(paidAtSend).toBe(1);
    } finally { delete (db as { exec?: unknown }).exec; if (other.isTransaction) other.exec("ROLLBACK"); other.close(); }
  }, 120_000);
});
