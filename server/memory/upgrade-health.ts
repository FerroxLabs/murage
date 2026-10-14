// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// While the memory upgrade runs before the server listens, the server thread is busy in synchronous database calls and cannot answer
// anything. Two worker threads of this same process speak for it:
//   - the heartbeat (blocking-heartbeat.ts) keeps the start-up note moving, for the desktop shell;
//   - the responder below binds the port the server is about to bind and answers /api/health with 503 and the progress, so a launcher
//     that probes the port, or a browser tab, sees a live upgrade instead of a refused connection.
// Both read the same progress board: a small shared block the server thread writes at every step boundary and a worker reads without
// ever waiting on the server thread. The responder is closed, and the close awaited, before the server calls listen on the port, so
// the two never hold it at once. Only the port the server would bind is ever opened, on 127.0.0.1.
import { Worker } from "node:worker_threads";
import { bootLaunchId, bootProofKey } from "./boot-nonce.ts";
import { CHALLENGE_PATTERN, PROOF_CHALLENGE_HEADER, PROOF_DATA_SOURCE } from "../../shared/boot-proof.mjs";
import { COUNTS_OVERLAY_SOURCE } from "./upgrade-counts.ts";
import { AWAKE_GAP_CAP_MS, UPGRADE_CONTRACT_SOURCE } from "../../shared/upgrade-contract.mjs";

const BOARD_BYTES = 16 + 12_288;
/** A progress board: written by the server thread, read from any worker. A reader never sees a half-written value (it retries on a changed sequence number). */
export interface ProgressBoard { shared: SharedArrayBuffer; /** The block the counting thread publishes exact counts into (upgrade-counts.ts); the threads that speak for a blocked server merge it into what they say. */ counts?: SharedArrayBuffer; set(value: object): void; read(): Record<string, unknown> | null }

export function createProgressBoard(counts?: SharedArrayBuffer): ProgressBoard {
  const shared = new SharedArrayBuffer(BOARD_BYTES), ctl = new Int32Array(shared, 0, 4), bytes = new Uint8Array(shared, 16);
  return {
    shared, counts,
    set(value) {
      const raw = Buffer.from(JSON.stringify(value), "utf8");
      if (raw.length > bytes.length) return; // too big to show: the last value stays
      Atomics.add(ctl, 0, 1); // odd: being written
      bytes.set(raw); Atomics.store(ctl, 1, raw.length);
      Atomics.add(ctl, 0, 1);
    },
    read() { return readBoard(shared); },
  };
}
export function readBoard(shared: SharedArrayBuffer): Record<string, unknown> | null {
  const ctl = new Int32Array(shared, 0, 4), bytes = new Uint8Array(shared, 16);
  for (let tries = 0; tries < 20; tries++) {
    const before = Atomics.load(ctl, 0);
    if (before % 2 === 1) continue;
    const length = Atomics.load(ctl, 1);
    if (!length) return null;
    const copy = Buffer.from(bytes.slice(0, length));
    if (Atomics.load(ctl, 0) === before) { try { return JSON.parse(copy.toString("utf8")) as Record<string, unknown>; } catch { return null; } }
  }
  return null;
}
/** The same reader as plain source, for a worker created from a string. */
export const BOARD_READER_SOURCE = `
const readBoard = (shared) => {
  const ctl = new Int32Array(shared, 0, 4), bytes = new Uint8Array(shared, 16);
  for (let tries = 0; tries < 20; tries++) {
    const before = Atomics.load(ctl, 0);
    if (before % 2 === 1) continue;
    const length = Atomics.load(ctl, 1);
    if (!length) return null;
    const copy = Buffer.from(bytes.slice(0, length));
    if (Atomics.load(ctl, 0) === before) { try { return JSON.parse(copy.toString("utf8")); } catch { return null; } }
  }
  return null;
};`;

/** What the worker threads that speak for a blocked server add to the board's last reading: their own source, clock, the time awake since the board was
 * written and the exact counts once they exist. Plain source, shared by the responder and the heartbeat (same text, one place). */
export const STAMP_SOURCE = `
const makeStamper = (source, cap) => {
  const meter = createAwakeMeter(cap);
  let lastSeq = -1, base = 0, shownKey = "", shownHigh = 0;
  return (progress, counts) => {
    const total = meter.tick();
    const state = progress && progress.upgrade;
    if (!state) return null;
    if (state.seq !== lastSeq) { lastSeq = state.seq; base = total; }
    // time awake in a phase never goes back within a launch: a newer board that counted less than the thread already showed does not pull it down
    let awake = Math.round(state.step.awakeElapsedMs + (total - base));
    const key = state.launch + "|" + state.phase;
    if (key === shownKey) awake = Math.max(awake, shownHigh);
    shownKey = key; shownHigh = awake;
    const patch = { source, heartbeatAt: Date.now(), step: { ...state.step, awakeElapsedMs: awake } };
    // an estimate is only as fresh as the progress behind it: a heartbeat does not revalidate one that was made before a gap (a sleep, a stall)
    if (state.eta && state.eta.stable && !(typeof state.progressAt === "number" && Date.now() - state.progressAt <= 30000)) patch.eta = { stable: false };
    if (counts && !state.counts.exact) patch.counts = { exact: true, messages: counts.messages, conversations: counts.conversations, memoryRecords: counts.memoryRecords, firstMessageAt: counts.firstMessageAt };
    return restampUpgradeState(state, patch);
  };
};`;

const RESPONDER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const http = require("node:http");
${BOARD_READER_SOURCE}
${COUNTS_OVERLAY_SOURCE}
${UPGRADE_CONTRACT_SOURCE}
${STAMP_SOURCE}
${PROOF_DATA_SOURCE}
const { createHmac } = require("node:crypto");
const stamp = makeStamper("responder", workerData.cap);
setInterval(() => stamp(null, null), 1000).unref();
const server = http.createServer((req, res) => {
  const counts = readCounts(workerData.counts);
  const board = overlayCounts(readBoard(workerData.shared) || {}, counts);
  // What this answer knows is stamped by the contract's own builder; before the server thread has written anything it says so, field by field.
  let upgrade = null;
  try { upgrade = stamp(board, counts); } catch {}
  if (!upgrade) upgrade = unknownUpgradeState({ launch: workerData.launch, source: "responder", stage: "starting", complete: false, keepOpen: true, heartbeatAt: Date.now() });
  // the proof of ownership: an HMAC over the probe's challenge and this answer's status fields (launch is only a label)
  const challenge = req.headers[workerData.challengeHeader];
  const answer = { app: "murage", pid: process.pid, launch: workerData.launch, static: false, ...board, upgrade, upgrading: true };
  if (typeof challenge === "string" && workerData.challengePattern.test(challenge)) answer.proof = createHmac("sha256", workerData.proofKey).update(proofData(challenge, { status: 503, pid: process.pid, launch: workerData.launch, isStatic: false, upgrading: true })).digest("hex");
  const body = JSON.stringify(answer);
  res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "1", "content-length": Buffer.byteLength(body) });
  res.end(body);
});
server.on("error", (error) => parentPort.postMessage({ type: "error", code: error && error.code ? String(error.code) : "ERROR" }));
server.listen(workerData.port, "127.0.0.1", () => parentPort.postMessage({ type: "listening" }));
parentPort.on("message", (message) => {
  if (message !== "close") return;
  const done = () => parentPort.postMessage({ type: "closed" });
  try { server.close(done); server.closeAllConnections && server.closeAllConnections(); } catch { done(); }
});
`;

export interface PreListenHealth {
  /** Resolves when the port is bound (true) or could not be (false: another process owns it; the server's own listen reports that). */
  ready: Promise<boolean>;
  board: ProgressBoard;
  /** Stops answering and resolves once the port is free again. Safe to call twice. */
  close(): Promise<void>;
}

/** Binds `port` on loopback and answers every request with 503 and the board's progress, from a worker thread. Never throws. */
export function startPreListenHealth(port: number, board: ProgressBoard = createProgressBoard()): PreListenHealth {
  let worker: Worker | null = null, listening = false, closing: Promise<void> | null = null;
  let resolveReady!: (value: boolean) => void, resolveClosed!: () => void;
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  try {
    worker = new Worker(RESPONDER_SOURCE, { eval: true, workerData: { port, shared: board.shared, counts: board.counts, launch: bootLaunchId(), cap: AWAKE_GAP_CAP_MS, proofKey: bootProofKey(), challengeHeader: PROOF_CHALLENGE_HEADER, challengePattern: CHALLENGE_PATTERN } });
    worker.on("message", (message: { type?: string }) => {
      if (message.type === "listening") { listening = true; resolveReady(true); }
      else if (message.type === "error") { resolveReady(false); if (!listening) resolveClosed(); }
      else if (message.type === "closed") resolveClosed();
    });
    worker.on("error", () => { resolveReady(false); resolveClosed(); });
    worker.on("exit", () => { resolveReady(false); resolveClosed(); });
    worker.unref();
  } catch { worker = null; resolveReady(false); resolveClosed(); }
  return {
    ready, board,
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (!worker) return;
        await ready;
        if (listening) {
          try { worker.postMessage("close"); } catch { resolveClosed(); }
          await Promise.race([closed, new Promise<void>(resolve => { const t = setTimeout(resolve, 3_000); t.unref?.(); })]);
        }
        try { await worker.terminate(); } catch { /* already gone */ }
        worker = null;
      })();
      return closing;
    },
  };
}

let current: PreListenHealth | null = null;
/** The responder started for this process's upgrade, if any (database.ts starts it; index.ts hands the port over). */
export function activePreListenHealth(): PreListenHealth | null { return current; }
export function setActivePreListenHealth(health: PreListenHealth | null): void { current = health; }
/** Called by the server just before it binds: closes the responder (if any) and resolves once the port is free. */
export async function releasePreListenHealth(): Promise<void> {
  const health = current; current = null;
  if (health) await health.close();
}
/** The port the server binds (index.ts reads the same variables). */
export function serverPort(): number { return Number(process.env.MURAGE_PORT || process.env.MURAGEBOX_PORT || 8799); }

let enabled = false, portOverride: number | null = null;
/** Called first thing by the server's entry module (pre-listen-enable.ts): only the real server process answers on its port while it upgrades.
 * A tool that merely opens the database never binds anything, and a test run never does unless it asks (setPreListenHealthForTest). */
export function enablePreListenHealth(): void { if (!process.env.VITEST) enabled = true; }
/** Test hook: answer on `port` (a port the test owns) for upgrades in this process; null turns it off again. */
export function setPreListenHealthForTest(port: number | null): void { portOverride = port; }
/** The port to answer on for an upgrade now starting, or null when this process does not answer. */
export function preListenHealthPort(): number | null { return portOverride ?? (enabled ? serverPort() : null); }
