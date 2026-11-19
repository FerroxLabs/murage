// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW r3.2.8 point 4 / r3.2.8a Mc / r3.2.8b (f) / r3.2.8d D3: the main-process reader drain before a reset.
// - D-CAP(a): a sliced scan in flight when the drain starts is cancelled by the epoch move, answers null, and scans active reach 0 well
//   inside 1 s (measured: max and p99 over 200 cancellations per case; the 500k leg is MEMW_DCAP_ROWS=500000 on a quiet host).
// - D-CAP(b): a scan waiting in admitScan at the block returns null and opens no connection.
// - D-CAP(b'): the same with an unblock before its admission resumes (mJ: `born` after borrowScan opens one).
// - D-CAP(c): a scan that never gives its slice back: "stuck" at the cap, never "drained"; released, the next drain is "drained".
// - mS: planRecall's yield stops at the first yield after the epoch moved.
// - D3: every DatabaseSync the reader opens goes through readerTestHooks.openIndexConnection (the open counter the D-FALLBACK rows use).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { openTestIndex } from "./testing/open-index.ts";
import {
  blockMemoryIndexReader, closeMemoryIndexReader, drainMemoryIndexReaders, lexicalPageSliced, memoryIndexReaderState, memoryIndexScansActive, ownerIndexHandle,
  readerTestHooks, RESET_DRAIN_MAX_MS, resetScanAdmission, setWalCheckpointRequester, setWalDrainThreshold, unblockMemoryIndexReader,
} from "./index-reader.ts";

const INDEX_PATH = () => join(DATA_DIR, "memory-index.db");
const LOG_SUFFIXES = ["-wal", "-shm", "-walok", "-walattempt", "-walstop"];
const realOpen = readerTestHooks.openIndexConnection;
const opens: string[] = [];
const countsAsIndex = (path: string) => path === INDEX_PATH() || LOG_SUFFIXES.some(suffix => path === `${INDEX_PATH()}${suffix}`);
beforeEach(() => {
  closeMemoryIndexReader(); unblockMemoryIndexReader(); resetScanAdmission(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  opens.length = 0;
  readerTestHooks.openIndexConnection = (path, options) => { if (countsAsIndex(path)) opens.push(path); return realOpen(path, options); };
});
afterEach(() => {
  readerTestHooks.openIndexConnection = realOpen;
  setWalCheckpointRequester(null); setWalDrainThreshold(Number.POSITIVE_INFINITY);
  vi.useRealTimers(); vi.restoreAllMocks();
  unblockMemoryIndexReader(); closeMemoryIndexReader(); resetScanAdmission();
});

const WORDS = Array.from({ length: 24 }, (_, n) => `w${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}zed`);
/** `rows` entries that all hold "quillwort" and the 24 WORDS (every word is common: planRecall probes each of them). */
async function populate(rows: number) {
  const index = await openTestIndex(INDEX_PATH());
  index.prepareModel("model");
  index.close();
  const db = new DatabaseSync(INDEX_PATH());
  // The index runs FTS automerge=0 (the helper merges in bounded steps), so a raw bulk load would pass FTS5's segment limit (SQLITE_FULL):
  // the fixture load merges as it goes and puts the file's own setting back afterwards.
  const automerge = (table: string) => Number((db.prepare(`SELECT v FROM ${table}_config WHERE k='automerge'`).get() as { v?: unknown } | undefined)?.v ?? 4);
  const saved = { lexical: automerge("lexical"), posting_words: automerge("posting_words") };
  for (const table of Object.keys(saved)) db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('automerge', 8)`).run();
  db.exec("BEGIN");
  const entry = db.prepare("INSERT INTO entries VALUES(?,1,'s',?)"), word = db.prepare("INSERT INTO lexical(id,version,text) VALUES(?,1,?)");
  for (let n = 0; n < rows; n++) {
    const text = `quillwort ${WORDS.join(" ")} ${"pad ".repeat(n % 7)}row ${n}`;
    const id = `q-${String(n).padStart(7, "0")}`;
    entry.run(id, text); word.run(id, text);
  }
  db.exec("COMMIT");
  for (const [table, value] of Object.entries(saved)) db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('automerge', ${Math.trunc(value)})`); // an integer literal: FTS5 refuses a bound REAL
  db.close();
}
/** The reader's state after it was asked for the shared handle ("ready" once open, "blocked" while blocked). */
const readerState = () => { ownerIndexHandle(); return memoryIndexReaderState(); };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const p99 = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]!; };

it("D3: the reader's two connections (the shared handle and a scan's) are made through readerTestHooks.openIndexConnection", async () => {
  await populate(50);
  expect(readerState()).toBe("ready");
  expect(opens).toEqual([INDEX_PATH()]);
  const page = await lexicalPageSliced("quillwort", ["s"], 10, 0, tick, { deadlineAt: Date.now() + 60_000 });
  expect(page?.hits.length).toBe(10);
  expect(opens).toEqual([INDEX_PATH(), INDEX_PATH()]);
});

it("mV' control: while blocked no main-process open of the index happens (handle(), owner search, sliced and plain pages)", async () => {
  await populate(50);
  blockMemoryIndexReader();
  expect(readerState()).toBe("blocked");
  expect(await lexicalPageSliced("quillwort", ["s"], 10, 0, tick, { deadlineAt: Date.now() + 60_000 })).toBeNull();
  expect(opens).toEqual([]);
});

/** One cancellation: a scan started on `query`; the drain starts at its `at`-th yield; the time from the drain's start to 0 active scans. */
async function cancelOnce(query: string, offset: number, at: number): Promise<{ ms: number; result: unknown; verdict: string } | null> {
  unblockMemoryIndexReader();
  // the real clock (hrtime): the planRecall case drives performance.now() so that every probe pause yields
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  let calls = 0, started = 0, drain: Promise<"drained" | "stuck"> | null = null, zeroAt = 0;
  const yieldTurn = async () => {
    calls++;
    if (calls === at && !drain) { started = now(); drain = drainMemoryIndexReaders(RESET_DRAIN_MAX_MS).then(verdict => { zeroAt = now(); return verdict; }); }
    await tick();
  };
  const result = await lexicalPageSliced(query, ["s"], 50, offset, yieldTurn, { deadlineAt: Date.now() + 60_000 });
  if (!drain) return null; // finished before its at-th yield: no cancellation happened
  const verdict = await drain;
  expect(memoryIndexScansActive()).toBe(0);
  return { ms: zeroAt - started, result, verdict };
}

const ROWS = Number(process.env.MEMW_DCAP_ROWS ?? 20_000);
it(`D-CAP(a): 200 cancellations per case (walk, planRecall), ${ROWS} rows: null, "drained", 0 scans active within 1 s (max, p99 recorded)`, { timeout: 1_800_000 }, async () => {
  await populate(ROWS);
  // walk: the drain starts at the scan's first yield inside the walk (its words are one common word, so planRecall is one probe);
  // planRecall: 24 common words with every probe pause past the slice budget, so the drain starts at a yield inside planRecall.
  const cases: Record<string, { query: string; offset: number; slicedProbes: boolean }> = {
    walk: { query: "quillwort", offset: 2_100, slicedProbes: false },
    planRecall: { query: WORDS.join(" "), offset: 0, slicedProbes: true },
  };
  const evidence: Record<string, { n: number; max: number; p99: number }> = {};
  for (const [name, { query, offset, slicedProbes }] of Object.entries(cases)) {
    const times: number[] = [];
    let clock = 0;
    const spy = slicedProbes ? vi.spyOn(performance, "now").mockImplementation(() => (clock += 10)) : null;
    for (let attempt = 0; times.length < 200 && attempt < 2_000; attempt++) {
      const one = await cancelOnce(query, offset, 1);
      if (!one) continue;
      expect(one.result).toBeNull();
      expect(one.verdict).toBe("drained");
      times.push(one.ms);
    }
    spy?.mockRestore();
    expect(times.length).toBe(200);
    evidence[name] = { n: times.length, max: Math.max(...times), p99: p99(times) };
    expect(evidence[name]!.max).toBeLessThan(1_000);
  }
  // after the drain the same search answers again (the reset's completion unblocks the reader)
  unblockMemoryIndexReader();
  expect((await lexicalPageSliced("quillwort", ["s"], 50, 0, tick, { deadlineAt: Date.now() + 60_000 }))?.hits.length).toBe(50);
  console.log(`D-CAP(a) rows=${ROWS} ${JSON.stringify(evidence)}`);
});

/** A closed admission gate: the log is over the threshold and the checkpoint request is answered only when `open()` is called. */
function closeGate() {
  const writer = new DatabaseSync(INDEX_PATH());
  writer.exec("INSERT INTO index_meta(key,value) VALUES('dcap-wal','1') ON CONFLICT(key) DO UPDATE SET value=value||'1'");
  let answer: ((ok: boolean) => void) | null = null;
  setWalDrainThreshold(0);
  setWalCheckpointRequester(() => new Promise<boolean>(resolve => { answer = resolve; }));
  return { open: () => { setWalDrainThreshold(Number.POSITIVE_INFINITY); answer?.(true); }, writer, asked: () => answer !== null };
}

it("D-CAP(b): a scan waiting in admitScan at the block returns null and opens no connection", async () => {
  await populate(200);
  ownerIndexHandle(); opens.length = 0; // the shared handle is open before the scan; only the scan's own opens count below
  const gate = closeGate();
  try {
    const scan = lexicalPageSliced("quillwort", ["s"], 50, 0, tick, { deadlineAt: Date.now() + 60_000 });
    for (let i = 0; i < 50 && !gate.asked(); i++) await tick();
    expect(gate.asked()).toBe(true);
    expect(memoryIndexScansActive()).toBe(0);
    expect(await drainMemoryIndexReaders(RESET_DRAIN_MAX_MS)).toBe("drained");
    gate.open();
    expect(await scan).toBeNull();
    expect(opens).toEqual([]);
    expect(memoryIndexScansActive()).toBe(0);
  } finally { gate.writer.close(); }
});

it("D-CAP(b'): block, then unblock before its admission resumes: the scan returns null and opens nothing under the new epoch (mJ)", async () => {
  await populate(200);
  ownerIndexHandle(); opens.length = 0;
  const gate = closeGate();
  try {
    const scan = lexicalPageSliced("quillwort", ["s"], 50, 0, tick, { deadlineAt: Date.now() + 60_000 });
    for (let i = 0; i < 50 && !gate.asked(); i++) await tick();
    expect(gate.asked()).toBe(true);
    expect(await drainMemoryIndexReaders(RESET_DRAIN_MAX_MS)).toBe("drained");
    unblockMemoryIndexReader();
    gate.open();
    expect(await scan).toBeNull();
    expect(opens).toEqual([]);
    expect(memoryIndexScansActive()).toBe(0);
  } finally { gate.writer.close(); }
});

it("D-CAP(c): a scan that never gives its slice back: \"stuck\" at the cap (never \"drained\"), the reader stays blocked; released, the next drain is \"drained\" (mH)", async () => {
  await populate(6_000);
  let release: (() => void) | null = null, held = false;
  const yieldTurn = () => { if (held) return tick(); held = true; return new Promise<void>(resolve => { release = resolve; }); };
  const scan = lexicalPageSliced("quillwort", ["s"], 50, 2_100, yieldTurn, { deadlineAt: Date.now() + 600_000 });
  for (let i = 0; i < 200 && !release; i++) await tick();
  expect(release).not.toBeNull();
  expect(memoryIndexScansActive()).toBe(1);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = drainMemoryIndexReaders(RESET_DRAIN_MAX_MS);
  let verdict: string | null = null;
  void first.then(v => { verdict = v; });
  await vi.advanceTimersByTimeAsync(RESET_DRAIN_MAX_MS - 1);
  expect(verdict).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(verdict).toBe("stuck");
  expect(memoryIndexScansActive()).toBe(1);
  expect(readerState()).toBe("blocked");
  vi.useRealTimers();
  release!();
  expect(await scan).toBeNull();
  expect(memoryIndexScansActive()).toBe(0);
  expect(await drainMemoryIndexReaders(RESET_DRAIN_MAX_MS)).toBe("drained");
});

it("mS: planRecall's yield stops the scan at the first yield after the epoch moved (SCAN_CANCELLED, null)", async () => {
  await populate(3_000);
  // every probe pause is past the slice budget, so planRecall yields once per word (24 words)
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
  let yields = 0;
  const yieldTurn = async () => { yields++; if (yields === 1) closeMemoryIndexReader(); await tick(); };
  expect(await lexicalPageSliced(WORDS.join(" "), ["s"], 50, 0, yieldTurn, { deadlineAt: Date.now() + 600_000 })).toBeNull();
  expect(yields).toBe(1);
  expect(memoryIndexScansActive()).toBe(0);
});

it("the reader is left blocked by a drain until its caller unblocks it", async () => {
  await populate(50);
  expect(await drainMemoryIndexReaders(RESET_DRAIN_MAX_MS)).toBe("drained");
  expect(readerState()).toBe("blocked");
  unblockMemoryIndexReader();
  expect(readerState()).toBe("ready");
});
