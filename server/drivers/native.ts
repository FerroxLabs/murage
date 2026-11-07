// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// retained next to the canonical stream, within a bounded diagnostic window.
import { appendFileSync, chmodSync, closeSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets, redactSecretsForSinkWalk, redactSecretsInText } from "../redact.ts";
import { createLabelStream, MD_STREAM_CAP, scanLabelDelta, type LabelStream } from "../../shared/md-secret-label.mjs";
import { redactPageOutputDeep } from "../browser-output-redaction.ts";
import { PHONE_TOOL_NAMES } from "../../shared/phone-jobs-contract.ts";
import { nativeTraceFrame } from "../runtime-event-out.ts";

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

/** 1.0.9 phone tools S19: a thread that used the phone tools keeps every text value of its engine protocol out of this log. Read
 * from the persisted mark and never gated on the feature flag (a mark outlives the flag, Astra AS9). */
let withholdThread: (threadId: string) => boolean = () => false;
export function withholdNativeThread(predicate: (threadId: string) => boolean): void { withholdThread = predicate; }
const NATIVE_WITHHELD = "[phone thread text withheld]";
const MAX_DEPTH = 40;

/** Every string value at any depth becomes the marker; keys, numbers, booleans and null stay. Depth-limited so a cyclic value cannot recurse. */
function withholdStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return NATIVE_WITHHELD;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return NATIVE_WITHHELD;
  if (Array.isArray(value)) return value.map((item) => withholdStrings(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = withholdStrings(item, depth + 1);
  return out;
}

/** The first phone call's frames are written before the mark exists (the mark is set when the call reaches the harness), so
 * a frame that names a phone tool is withheld on any thread, and so are the streamed argument fragments of that block. */
const PHONE_NAMES = new Set<string>(PHONE_TOOL_NAMES);
const PHONE_NAME_IN = /phone_[a-z0-9_]+/g;
const NAME_KEYS = new Set(["name", "tool", "toolName", "tool_name", "server", "namespace", "title", "kind", "toolKind"]);
function isPhoneName(text: string): boolean {
  if (/phoneJobs/.test(text)) return true;
  for (const hit of text.match(PHONE_NAME_IN) ?? []) if (PHONE_NAMES.has(hit)) return true;
  return false;
}
function namesPhoneTool(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => namesPhoneTool(item, depth + 1));
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" ? NAME_KEYS.has(key) && isPhoneName(item) : namesPhoneTool(item, depth + 1)) return true;
  }
  return false;
}
const openPhoneBlocks = new Map<string, Set<number>>();
function phoneFrame(threadId: string, msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const event = (msg as { event?: unknown }).event;
  const inner = event && typeof event === "object" ? event as { type?: unknown; index?: unknown; content_block?: unknown } : null;
  if (inner && typeof inner.index === "number") {
    const open = openPhoneBlocks.get(threadId);
    if (inner.type === "content_block_start" && namesPhoneTool(inner.content_block)) {
      if (openPhoneBlocks.size >= STREAM_TAIL_THREADS && !open) openPhoneBlocks.delete(openPhoneBlocks.keys().next().value!);
      (open ?? openPhoneBlocks.set(threadId, new Set()).get(threadId)!).add(inner.index);
      return true;
    }
    if (open?.has(inner.index)) {
      if (inner.type === "content_block_stop") open.delete(inner.index);
      return true;
    }
  }
  return namesPhoneTool(msg);
}

/** 09-A5: a streamed reply reaches this log a few characters per frame. A credential the model echoes arrives as a
 * short prefix in one frame and the rest in the next, and each frame alone is too short or too plain to match. So
 * each text-bearing delta is read together with the unmasked text that came just before it on the same
 * conversation, and the part of the result that belongs to this frame is what is stored. */
const STREAM_TAIL_CHARS = 512;
const STREAM_TAIL_THREADS = 256;
const STREAM_FIELDS = ["text", "partial_json", "thinking"] as const;

/** REDACT-MD-SINKS §3: a secret label wrapped in markdown marks LATCHES its (thread, field): from there on nothing of
 * that stream is written but a mask, until the thread's next prompt or tool result. Every path that loses line context (eviction,
 * the 64 KiB line cap, the latched-table cap) latches instead of dropping the context, so it fails closed. */
type PendingStream = { tail: string; label: LabelStream };
const pendingStreams = new Map<string, PendingStream>();
const latchedStreams = new Map<string, number>();
export const LATCHED_MAX = 65_536;
let latchedOverflow = false;
const streamKey = (threadId: string, field: string) => `${threadId}\u0000${field}`;
const streamMask = (text: string) => `«redacted ${text.length} chars»`;

function latchStream(key: string, masked = 0): void {
  pendingStreams.delete(key);
  if (latchedStreams.has(key)) { latchedStreams.set(key, latchedStreams.get(key)! + masked); return; }
  if (latchedStreams.size >= LATCHED_MAX) { latchedOverflow = true; return; }
  latchedStreams.set(key, masked);
}

function freshPending(key: string): PendingStream {
  if (pendingStreams.size >= STREAM_TAIL_THREADS) {
    const [oldKey, oldest] = pendingStreams.entries().next().value!;
    pendingStreams.delete(oldKey);
    if (oldest.label.len > 0) latchStream(oldKey);
  }
  const entry = { tail: "", label: createLabelStream() };
  pendingStreams.set(key, entry);
  return entry;
}

/** The thread's next prompt or tool result (a `type: "user"` entry) starts its streams over, except a line still unfinished
 * when it arrives: appendNative has no response-start signal, so that line may go on after the `in`, and it latches. */
function resetStreams(threadId: string): void {
  for (const field of STREAM_FIELDS) {
    const key = streamKey(threadId, field), pending = pendingStreams.get(key);
    if (pending) { if (pending.label.len > 0) latchStream(key); else { pendingStreams.delete(key); freshPending(key); } continue; }
    if (latchedStreams.delete(key) || latchedOverflow) freshPending(key);
  }
}

/** Today's path: the delta read with the unmasked text just before it, keeping the part that belongs to this frame. */
function maskWithTail(entry: PendingStream, raw: string): string {
  const combined = redactSecretsInText(entry.tail + raw);
  const before = redactSecretsInText(entry.tail);
  let common = 0;
  while (common < before.length && common < combined.length && before[common] === combined[common]) common++;
  entry.tail = (entry.tail + raw).slice(-STREAM_TAIL_CHARS);
  return combined.slice(common);
}

function maskLatched(key: string, raw: string): string {
  const count = (latchedStreams.get(key) ?? 0) + raw.length;
  if (latchedStreams.has(key)) latchedStreams.set(key, count);
  return count > MD_STREAM_CAP ? "«redacted»" : streamMask(raw);
}

function maskStreamField(threadId: string, field: string, raw: string): string {
  const key = streamKey(threadId, field);
  let entry = pendingStreams.get(key);
  if (latchedStreams.has(key) || (!entry && latchedOverflow)) return maskLatched(key, raw);
  if (entry) { pendingStreams.delete(key); pendingStreams.set(key, entry); } else entry = freshPending(key);
  const firstLine = raw.indexOf("\n");
  if (entry.label.len + (firstLine < 0 ? raw.length : firstLine) > MD_STREAM_CAP) {
    latchStream(key);
    return maskLatched(key, raw);
  }
  const at = scanLabelDelta(entry.label, raw);
  if (at < 0) return maskWithTail(entry, raw);
  const head = maskWithTail(entry, raw.slice(0, at)), rest = raw.slice(at);
  latchStream(key, rest.length);
  return rest ? head + streamMask(rest) : head;
}

/** The stream fields a delta frame carries, or none when the entry is not a stream delta. */
function streamDelta(msg: unknown): { delta: Record<string, unknown>; fields: (typeof STREAM_FIELDS)[number][] } | null {
  if (!msg || typeof msg !== "object") return null;
  const holder = msg as { event?: { delta?: unknown }; delta?: unknown };
  const delta = holder.event && typeof holder.event === "object" && holder.event.delta && typeof holder.event.delta === "object" ? holder.event.delta : holder.delta;
  if (!delta || typeof delta !== "object") return null;
  const fields = STREAM_FIELDS.filter((field) => typeof (delta as Record<string, unknown>)[field] === "string");
  return fields.length ? { delta: delta as Record<string, unknown>, fields } : null;
}

function maskStreamDelta(threadId: string, msg: unknown): unknown {
  const found = streamDelta(msg);
  if (!found) return msg;
  const holder = msg as { event?: { delta?: unknown }; delta?: unknown };
  const { delta, fields } = found;
  const masked: Record<string, string> = {};
  for (const field of fields) masked[field] = maskStreamField(threadId, field, (delta as Record<string, string>)[field]!);
  const swapped = { ...(delta as Record<string, unknown>), ...masked };
  return holder.event && typeof holder.event === "object" && holder.event.delta === delta
    ? { ...holder, event: { ...holder.event, delta: swapped } }
    : { ...holder, delta: swapped };
}

/** The harness ids a lifecycle row carries. Each is a random UUID the harness made, never a value a user or engine
 * supplied, so it is kept as written: the card-number rule reads a UUID's digit tail ("4111-111111111111") as a card and
 * masked it, and the row could no longer be tied to the diagnostic that names the same generation. */
const LIFECYCLE_ID_FIELDS = ["processGeneration", "turnId", "instanceId"] as const;
const HARNESS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redactLifecycle(msg: unknown): unknown {
  const out = redactSecrets(msg);
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || !out || typeof out !== "object" || Array.isArray(out)) return out;
  const kept = { ...(out as Record<string, unknown>) };
  for (const field of LIFECYCLE_ID_FIELDS) {
    const raw = (msg as Record<string, unknown>)[field];
    if (typeof raw === "string" && HARNESS_UUID.test(raw)) kept[field] = raw;
  }
  return kept;
}

export function appendNative(threadId: string, entry: { dir: "in" | "out" | "lifecycle"; source: string; msg: unknown }) {
  if (omitThread(threadId)) return;
  try {
    if (entry.dir !== "lifecycle") {
      // the phone policy recognises on the engine's own frame; the row written is the projected one
      const withhold = withholdThread(threadId) || phoneFrame(threadId, entry.msg);
      // GrokBuild case 20: a tool or command frame keeps its ids and paths only (runtime-event-out.ts nativeTraceFrame)
      const projected = nativeTraceFrame(entry.msg);
      entry = { ...entry, msg: withhold ? withholdStrings(projected) : projected };
    }
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
    // §3 Reset: ONLY the next prompt or tool result resets (MurageMain, 11-03). Direction cannot mark either: drivers
    // log engine OUTPUT as dir "in" (the Claude driver writes every SDK frame as "in") and the Claude prompt goes out as
    // dir "out" (claude.ts promptMsg). Both a prompt and an SDK tool result are a `type: "user"` message, so that is the
    // one reset. Every other frame of the live reply (stream_event, system/thinking_tokens, assistant, tool_progress,
    // control_*, task_*, result) and every other `out` entry keeps a latch: it fails closed.
    if (entry.dir !== "lifecycle" && (entry.msg as { type?: unknown } | null)?.type === "user") resetStreams(threadId);
    let encoded = JSON.stringify({ at: new Date().toISOString(), ...entry, msg: entry.dir === "lifecycle" ? redactLifecycle(entry.msg) : redactPageOutputDeep(redactSecretsForSinkWalk(maskStreamDelta(threadId, entry.msg))) }) + "\n";
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
