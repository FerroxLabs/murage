// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// retained next to the canonical stream, within a bounded diagnostic window.
import { appendFileSync, chmodSync, closeSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { redactPageOutputDeep } from "../browser-output-redaction.ts";

const RECORD_BYTES = 64 * 1024;
const SEGMENT_BYTES = 4 * 1024 * 1024;
/** The diagnostic folder as a whole, across every conversation: at most this much, for at most this long. */
export const NATIVE_BUDGET_BYTES = 256 * 1024 * 1024;
export const NATIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tunable for tests only. A sweep runs after a write when this long has passed, or when this many bytes have been written since the last one. */
export const nativeBudget = { maxBytes: NATIVE_BUDGET_BYTES, maxAgeMs: NATIVE_MAX_AGE_MS, sweepEveryMs: 60_000, sweepEveryBytes: 8 * 1024 * 1024 };
let lastSweep = 0;
let writtenSinceSweep = 0;
let ageTimer: ReturnType<typeof setInterval> | undefined;

/** Keeps the diagnostic folder inside its global budget: traces older than the age limit go first (including idle previous segments), then the
 * oldest traces until the total fits. Files named in `keep` (the segment being written right now) are never evicted for size. Returns the number
 * of files removed. Best effort, never throws. */
export function enforceNativeBudget(dir: string = NATIVE_DIR, options: { maxBytes?: number; maxAgeMs?: number; now?: number; keep?: readonly string[] } = {}): number {
  const maxBytes = options.maxBytes ?? nativeBudget.maxBytes, maxAge = options.maxAgeMs ?? nativeBudget.maxAgeMs, now = options.now ?? Date.now();
  const keep = new Set(options.keep ?? []);
  let removed = 0;
  try {
    const files: { path: string; name: string; bytes: number; at: number }[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ndjson")) continue;
      try { const path = join(dir, name), st = statSync(path); if (st.isFile()) files.push({ path, name, bytes: st.size, at: st.mtimeMs }); } catch { /* gone already */ }
    }
    const drop = (file: { path: string }) => { try { unlinkSync(file.path); removed++; return true; } catch { return false; } };
    const live = files.filter(file => now - file.at <= maxAge || !drop(file));
    live.sort((a, b) => a.at - b.at);
    let total = live.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of live) {
      if (total <= maxBytes) break;
      if (keep.has(file.name)) continue;
      if (drop(file)) total -= file.bytes;
    }
  } catch { /* the folder may not exist yet */ }
  return removed;
}
function sweepAfterWrite(threadId: string, bytes: number): void {
  writtenSinceSweep += bytes;
  const now = Date.now();
  if (now - lastSweep < nativeBudget.sweepEveryMs && writtenSinceSweep < nativeBudget.sweepEveryBytes) return;
  lastSweep = now; writtenSinceSweep = 0;
  enforceNativeBudget(NATIVE_DIR, { keep: [`${threadId}.ndjson`] });
  // Idle folders age out too: a timer, not only a write, expires traces.
  if (!ageTimer) { ageTimer = setInterval(() => { enforceNativeBudget(NATIVE_DIR); }, 60 * 60 * 1000); ageTimer.unref?.(); }
}

function marker(type: string, detail: Record<string, number | string> = {}): string {
  return JSON.stringify({ at: new Date().toISOString(), dir: "out", source: "murage.native-log",
    msg: { type, ...detail } }) + "\n";
}

function size(file: string): number {
  try { return statSync(file).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

/** Legacy oversized files retain only complete recent records. Read a bounded
 * tail, not the whole trace; leave room for the explicit incomplete-history marker. */
function capExisting(file: string): number {
  const bytes = size(file);
  if (bytes <= SEGMENT_BYTES) return bytes;
  const capacity = SEGMENT_BYTES - 1024;
  const tail = Buffer.alloc(capacity);
  const fd = openSync(file, "r");
  let read: number;
  try { read = readSync(fd, tail, 0, tail.length, bytes - capacity); }
  finally { closeSync(fd); }
  const contents = tail.subarray(0, read);
  const newline = contents.indexOf(10);
  const records = newline < 0 ? [] : contents.subarray(newline + 1).toString("utf8").split("\n");
  const retained: string[] = [];
  for (const record of records) {
    if (!record) continue;
    if (Buffer.byteLength(record) + 1 > RECORD_BYTES) {
      retained.push(marker("native_trace_record_omitted", { reason: "legacy record exceeds byte limit" }));
      continue;
    }
    try { JSON.parse(record); retained.push(record + "\n"); }
    catch { /* A trailing partial legacy record is not valid NDJSON. */ }
  }
  const encoded = marker("native_trace_retention", { reason: "legacy trace exceeded segment limit", previousBytes: bytes }) + retained.join("");
  writeFileSync(file, encoded, { mode: 0o600 });
  chmodSync(file, 0o600);
  return Buffer.byteLength(encoded);
}

/** `lifecycle` rows are harness-authored engine_lifecycle diagnostics
 * (lifecycle-diagnostic.ts), kept apart from in/out protocol messages. */
/** Threads whose engine protocol is never written (the Chief's hidden
 * New project proposal turns): set once by the harness. */
let omitThread: (threadId: string) => boolean = () => false;
export function omitNativeLog(predicate: (threadId: string) => boolean): void { omitThread = predicate; }

export function appendNative(threadId: string, entry: { dir: "in" | "out" | "lifecycle"; source: string; msg: unknown }) {
  if (omitThread(threadId)) return;
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. People paste these diagnostic
    // files into bug reports, so values are masked while
    // the shape stays intact unless the record exceeds its byte budget.
    // Lifecycle rows are harness-authored and allowlisted field by field
    // (lifecycle-diagnostic.ts): their ids are random UUIDs. The page-output
    // scrub reads a run of digits inside a UUID as a secret number and rewrote
    // the turn id to "ab[hidden]-...", so a trace could no longer be tied to
    // its turn. Secret-name masking still applies.
    let encoded = JSON.stringify({ at: new Date().toISOString(), ...entry, msg: entry.dir === "lifecycle" ? redactSecrets(entry.msg) : redactPageOutputDeep(redactSecrets(entry.msg)) }) + "\n";
    const encodedBytes = Buffer.byteLength(encoded);
    if (encodedBytes > RECORD_BYTES) encoded = marker("native_trace_record_omitted", { encodedBytes, limitBytes: RECORD_BYTES });
    const current = join(NATIVE_DIR, `${threadId}.ndjson`);
    const previous = join(NATIVE_DIR, `${threadId}.previous.ndjson`);
    const currentBytes = capExisting(current);
    capExisting(previous);
    if (currentBytes + Buffer.byteLength(encoded) > SEGMENT_BYTES) {
      renameSync(current, previous);
      chmodSync(previous, 0o600);
      writeFileSync(current, marker("native_trace_retention", { reason: "rotated; only current and previous segments are retained", segmentLimitBytes: SEGMENT_BYTES }), { mode: 0o600 });
    }
    appendFileSync(current, encoded, { mode: 0o600 });
    chmodSync(current, 0o600);
    sweepAfterWrite(threadId, Buffer.byteLength(encoded));
  } catch {
    /* never let logging break a run */
  }
}
