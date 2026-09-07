// The authorization DECISION log: one fleet-wide, append-only NDJSON file
// answering "which tool call was allowed, denied, or carded — by which
// rule, when, for which bot".
//
// The per-thread event log (harness/bus.ts) cannot answer that. It records
// that a request opened and later resolved, but the WHY — a grant waved it
// through, a guard held it, an unattended block overrode a grant that
// would otherwise have fired — exists only for a moment at the fold point
// and is gone by the time the event is on disk. So the fold writes the
// reason down here at the moment it is known, and the human-answer path
// writes a second row when a card comes back.
//
// Same discipline as the event tee: 0600 (rows name tools and command
// lines), through redactSecrets (summaries carry whatever the agent typed,
// credentials included), and fire-and-forget — an audit log must never
// take down the decision it is auditing.
//
// Deliberately NOT covered: ask_bot peer-approval cards. They never cross
// the runtime bus (peer-approval.ts appends its cards straight to the
// store), so wiring them here would mean a second, parallel tap — a
// separate change if it earns its keep.
import { readFileSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AutoVerdictSource } from "./auto-approve.ts";
import { redactSecrets } from "./redact.ts";

export type DecisionKind =
  | "auto-approved"
  | "card-shown"
  | "user-approved"
  | "user-denied"
  | "review-would-approve"
  | "review-would-deny"
  | "log-omitted";

/** Who or what produced the decision. The AutoVerdictSource values carry
 * straight through from auto-approve.ts; `question` marks cards a rule may
 * never answer, `auto-fallback` a card shown after delivery failed, `routine`
 * a durable chat scheduling proposal, `skill` a staged learned-skill card,
 * `user` the human's answer, and auto-review sources the isolated model reviewer. */
export type DecisionSource =
  | AutoVerdictSource
  | "question"
  | "auto-fallback"
  | "routine"
  | "skill"
  | "user"
  | "auto-review"
  | "auto-review-shadow"
  | "logger";

export interface DecisionRow {
  at: string;
  threadId: string;
  requestId?: string;
  botId?: string;
  botName?: string;
  tool?: string;
  summary?: string;
  decision: DecisionKind;
  source: DecisionSource;
  /** which rule decided: a guard's regex source, or the granted key */
  rule?: string;
  /** the turn ran with nobody at the keyboard when this was decided */
  unattended?: boolean;
  /** Diagnostic rows unavailable because of overload, oversize or write failure. */
  omitted?: number;
}

const FILE_NAME = "decisions.ndjson";

// Rotation is logrotate at its simplest: when the live file crosses the cap
// it becomes `.1` (clobbering the previous `.1`) and a fresh file starts.
// Total disk is bounded at ~2× the cap; at a few hundred bytes per row that
// is years of human-scale approvals, and anything fancier — dated segments,
// compression — is more machinery than an audit trail this size warrants.
const MAX_BYTES = 4 * 1024 * 1024;
export const DECISION_MAX_PENDING_BYTES = 1024 * 1024;
export const DECISION_MAX_PENDING_RECORDS = 256;
export const DECISION_MAX_RECORD_BYTES = 64 * 1024;
interface WriteQueue {
  items: Array<{ encoded: string; bytes: number; maxBytes: number }>;
  bytes: number;
  omitted: number;
  markerBytes: number;
  maxBytes: number;
  running?: Promise<void>;
}
const writeQueues = new Map<string, WriteQueue>();
const addOmissions = (queue: WriteQueue, count = 1) => { queue.omitted = Math.min(Number.MAX_SAFE_INTEGER, queue.omitted + count); };

async function writeDecision(
  dataDir: string,
  encoded: string,
  maxBytes: number,
): Promise<void> {
  const file = join(dataDir, FILE_NAME);
  try {
    if ((await stat(file)).size >= maxBytes) await rename(file, `${file}.1`);
  } catch {
    /* no live file yet — nothing to rotate */
  }
  await appendFile(file, encoded, { mode: 0o600 });
}

async function drain(dataDir: string, queue: WriteQueue): Promise<void> {
  while (queue.items.length || queue.omitted) {
    const item = queue.items[0];
    if (item) {
      try { await writeDecision(dataDir, item.encoded, item.maxBytes); }
      catch {
        // Keep bounded evidence of the gap, not rows or a retry promise chain.
        addOmissions(queue, queue.items.length);
        queue.items = []; queue.bytes = 0;
        return;
      }
      queue.items.shift(); queue.bytes -= item.bytes;
    } else {
      const omitted = queue.omitted;
      queue.omitted = 0;
      const encoded = JSON.stringify({ at: new Date().toISOString(), threadId: "", decision: "log-omitted", source: "logger", omitted,
        summary: "Diagnostic decision rows omitted by queue/record limits or write failure; authorization and transcript records are unchanged." }) + "\n";
      queue.markerBytes = Buffer.byteLength(encoded);
      try { await writeDecision(dataDir, encoded, queue.maxBytes); }
      catch { addOmissions(queue, omitted + queue.items.length); queue.items = []; queue.bytes = 0; return; }
      finally { queue.markerBytes = 0; }
    }
  }
}

/** Append one decision row. Fire-and-forget, mirroring the event bus tee:
 * the fold that calls this is delivering approvals and cards, and a full
 * disk must not turn into denied tools. */
export function appendDecision(
  dataDir: string,
  row: Omit<DecisionRow, "at">,
  opts?: { maxBytes?: number },
): void {
  let queue = writeQueues.get(dataDir);
  if (!queue) {
    queue = { items: [], bytes: 0, omitted: 0, markerBytes: 0, maxBytes: opts?.maxBytes ?? MAX_BYTES };
    writeQueues.set(dataDir, queue);
  }
  // Encode/redact before retaining anything. The bounds include the current
  // write; already-admitted records stay FIFO. Overload retains only a count.
  try {
    const encoded = JSON.stringify(redactSecrets({ at: new Date().toISOString(), ...row })) + "\n";
    const bytes = Buffer.byteLength(encoded);
    if (bytes > DECISION_MAX_RECORD_BYTES || queue.bytes + queue.markerBytes + bytes > DECISION_MAX_PENDING_BYTES || queue.items.length + (queue.markerBytes ? 1 : 0) >= DECISION_MAX_PENDING_RECORDS) addOmissions(queue);
    else {
      queue.items.push({ encoded, bytes, maxBytes: opts?.maxBytes ?? MAX_BYTES });
      queue.bytes += bytes;
    }
  } catch { addOmissions(queue); }
  if (!queue.running) {
    const current = queue;
    current.running = drain(dataDir, current).finally(() => {
      current.running = undefined;
      if (!current.items.length && !current.omitted) writeQueues.delete(dataDir);
    });
  }
}

/** Bounded diagnostic counters; never exposes retained row content. */
export function decisionLogQueueStatus(dataDir: string) {
  const queue = writeQueues.get(dataDir);
  return { pendingBytes: (queue?.bytes ?? 0) + (queue?.markerBytes ?? 0), pendingRecords: (queue?.items.length ?? 0) + (queue?.markerBytes ? 1 : 0), omitted: queue?.omitted ?? 0 };
}

/** Test/shutdown seam: wait until every decision already queued for this
 * directory has reached disk. Normal request paths deliberately do not wait. */
export async function flushDecisionLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir)?.running;
}

const isDecisionRow = (value: unknown): value is DecisionRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DecisionRow).at === "string" &&
  typeof (value as DecisionRow).threadId === "string" &&
  typeof (value as DecisionRow).decision === "string" &&
  typeof (value as DecisionRow).source === "string";

/** The newest `limit` rows, oldest first — the same order the inspector
 * uses for thread events. Reads `.1` before the live file so a request
 * right after a rotation still sees history instead of a nearly empty
 * log; whole-file reads are fine here because rotation caps both files,
 * unlike the unbounded per-thread event logs that need a tail walk. */
export function readDecisions(dataDir: string, limit: number): DecisionRow[] {
  const file = join(dataDir, FILE_NAME);
  const rows: DecisionRow[] = [];
  for (const path of [`${file}.1`, file]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isDecisionRow(value)) rows.push(value);
      } catch {
        /* a line torn mid-write — skip the fragment, keep the rest */
      }
    }
  }
  return rows.slice(-limit);
}
