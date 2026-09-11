// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// retained next to the canonical stream, within a bounded diagnostic window.
import { appendFileSync, chmodSync, closeSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";

const RECORD_BYTES = 64 * 1024;
const SEGMENT_BYTES = 4 * 1024 * 1024;

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
export function appendNative(threadId: string, entry: { dir: "in" | "out" | "lifecycle"; source: string; msg: unknown }) {
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. People paste these diagnostic
    // files into bug reports, so values are masked while
    // the shape stays intact unless the record exceeds its byte budget.
    let encoded = JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(entry.msg) }) + "\n";
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
  } catch {
    /* never let logging break a run */
  }
}
