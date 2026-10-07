// tools/flux-stream-conformance/owner.ts
// Sean's voice through the stream, per condition (spec E.4, F), scored EXACTLY
// as the provider bake-off scored it (stt-spike score.mjs and lib.mjs, ported
// here line for line; Astra 3 I10):
//   - one Levenshtein word alignment of all final texts (in arrival order)
//     against the whole script, words read aloud (`spokenWords`, the
//     bake-off's normalize);
//   - a line's covering final is the one holding the hyp word aligned (match
//     or substitution) to the line's LAST aligned reference word;
//   - its true end of speech is hindsight energy analysis of that condition's
//     own audio inside [line start, next line start): the last 10 ms frame
//     6 dB over the local noise floor;
//   - latency = when the covering final arrived minus when that true end was
//     sent; p50 and p90 interpolated as the bake-off's `pct`;
//   - a pause line is split when its aligned words came from more than one turn.
// The manifest is the bake-off run's own `lines.json` (25 lines). Before
// trusting T-owner, `replayBakeoff()` scores the bake-off's saved raw
// AssemblyAI events with this code and must reproduce its table.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { spokenWords } from "../../shared/flux-stream-contract.ts";
import { ConformanceClient } from "./client.ts";
import { speechSegments } from "./fixtures/analyse.ts";

export interface OwnerLine {
  id: number;
  text: string;
  pause: boolean;
  /** When the line began, and when the next one did, on the recording's clock. */
  startMs: number;
  endMs: number;
}

/** The session policy under qualification: the query Murage connects with
 *  and whether StreamMic's punctuation commit runs. */
export interface OwnerPolicy {
  query: Record<string, string>;
  commit: boolean;
}

export interface OwnerLineResult {
  id: number;
  status: "ok" | "anomaly" | "missing";
  latencyMs: number | null;
  trueEosMs: number | null;
  turns: number;
  split: boolean | null;
}

export interface OwnerResult {
  condition: string;
  lines: OwnerLineResult[];
  p50: number;
  p90: number;
  wer: number;
  splits: number;
  pauseLines: number;
  anomalies: number[];
  missing: number[];
  /** Every one of the 25 lines has a finite latency. */
  complete: boolean;
}

export const OWNER_LINES = 25;
export const OWNER_CONDITIONS = ["clean", "quiet", "noisy", "phone"] as const;
export const OWNER_TARGETS: Record<string, number> = { clean: 800, quiet: 900, noisy: 1100, phone: 900 };
export const OWNER_MAX_WER = 0.05;
const RATE = 16_000;

// ── the bake-off's scoring, ported ─────────────────────────────────────────
type Op = { type: "match" | "sub" | "del" | "ins"; refIdx: number | null; hypIdx: number | null };

/** score.mjs alignWords: the same recurrence and the same backtrace preferences. */
export function alignWords(ref: string[], hyp: string[]): Op[] {
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) d[i][0] = i;
  for (let j = 1; j <= m; j += 1) d[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      ops.push({ type: "match", refIdx: i - 1, hypIdx: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      ops.push({ type: "sub", refIdx: i - 1, hypIdx: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ type: "del", refIdx: i - 1, hypIdx: null });
      i -= 1;
    } else {
      ops.push({ type: "ins", refIdx: null, hypIdx: j - 1 });
      j -= 1;
    }
  }
  return ops.reverse();
}

/** lib.mjs pct: linear interpolation, rounded. */
export function pct(values: number[], p: number): number {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return Number.NaN;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(a[lo] + (a[hi] - a[lo]) * (idx - lo));
}

type Frame = { tMs: number; db: number };

/** lib.mjs frameEnergies: dBFS of each 10 ms frame. */
export function frameEnergies(pcm: Int16Array, frameMs = 10): Frame[] {
  const frame = Math.round((RATE * frameMs) / 1000);
  const out: Frame[] = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0;
    for (let j = 0; j < frame; j += 1) {
      const v = pcm[i + j] / 32768;
      sum += v * v;
    }
    out.push({ tMs: (i / RATE) * 1000, db: 10 * Math.log10(sum / frame + 1e-12) });
  }
  return out;
}

function floorDb(frames: Frame[], p = 0.1, minRealisticDb = -90): number {
  if (!frames.length) return -60;
  const realistic = frames.filter((f) => f.db >= minRealisticDb);
  const sorted = (realistic.length ? realistic : frames).map((f) => f.db).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

/** score.mjs trueEosForLine: the line's last frame 6 dB over its local floor. */
export function trueEos(frames: Frame[], startMs: number, nextStartMs: number): number | null {
  const local = frames.filter((f) => f.tMs >= Math.max(0, startMs - 6000) && f.tMs <= nextStartMs);
  const thresh = floorDb(local.length ? local : frames) + 6;
  let last: number | null = null;
  for (const f of frames) {
    if (f.tMs < startMs) continue;
    if (f.tMs > nextStartMs) break;
    if (f.db > thresh) last = f.tMs + 10;
  }
  return last;
}

/** One condition. `finals` are the texts the stream produced, each with when it
 *  arrived and its turn; `sentTimeOf` maps a recording position to when it was sent. */
export function scoreOwner(
  condition: string,
  lines: OwnerLine[],
  finals: Array<{ at: number; text: string; turn: number }>,
  pcm: Int16Array,
  sentTimeOf: (ms: number) => number,
): OwnerResult {
  const refWords: string[] = [];
  const lineOf: number[] = [];
  for (const [k, l] of lines.entries()) for (const w of spokenWords(l.text)) (refWords.push(w), lineOf.push(k));
  const hyp: Array<{ word: string; turn: number; event: number }> = [];
  finals.forEach((f, e) => {
    for (const w of spokenWords(f.text)) hyp.push({ word: w, turn: f.turn, event: e });
  });
  const ops = alignWords(refWords, hyp.map((h) => h.word));
  const rows = lines.map(() => ({ last: null as number | null, turns: new Set<number>() }));
  let current = 0;
  let errors = 0;
  for (const op of ops) {
    if (op.type === "match" || op.type === "sub") {
      current = lineOf[op.refIdx!];
      rows[current].last = op.hypIdx;
      rows[current].turns.add(hyp[op.hypIdx!].turn);
      if (op.type === "sub") errors += 1;
    } else if (op.type === "del") {
      current = lineOf[op.refIdx!];
      errors += 1;
    } else {
      rows[current].turns.add(hyp[op.hypIdx!].turn); // an insertion belongs to the line the alignment was in
      errors += 1;
    }
  }
  const frames = frameEnergies(pcm);
  const durationMs = (pcm.length / RATE) * 1000;
  const results: OwnerLineResult[] = lines.map((l, k) => {
    const eos = trueEos(frames, l.startMs, k + 1 < lines.length ? lines[k + 1].startMs : durationMs);
    const last = rows[k].last;
    const turns = rows[k].turns.size;
    const split = l.pause ? turns > 1 : null;
    if (last === null || eos === null) return { id: l.id, status: "missing", latencyMs: null, trueEosMs: eos, turns, split };
    const latencyMs = finals[hyp[last].event].at - sentTimeOf(eos);
    return { id: l.id, status: latencyMs < -50 ? "anomaly" : "ok", latencyMs, trueEosMs: eos, turns, split };
  });
  const latencies = results.map((r) => r.latencyMs).filter((x): x is number => x !== null);
  const missing = results.filter((r) => r.status === "missing").map((r) => r.id);
  return {
    condition,
    lines: results,
    p50: pct(latencies, 0.5),
    p90: pct(latencies, 0.9),
    wer: refWords.length ? errors / refWords.length : 0,
    splits: results.filter((r) => r.split).length,
    pauseLines: lines.filter((l) => l.pause).length,
    anomalies: results.filter((r) => r.status === "anomaly").map((r) => r.id),
    missing,
    complete: lines.length === OWNER_LINES && missing.length === 0 && latencies.length === OWNER_LINES && latencies.every(Number.isFinite),
  };
}

/** Pass: all 25 lines scored with finite samples, p50 at or under the
 *  condition's target, session WER at most 5 %. */
export function ownerPasses(o: OwnerResult): boolean {
  const target = OWNER_TARGETS[o.condition];
  return o.complete && Number.isFinite(o.p50) && target !== undefined && o.p50 <= target && o.wer <= OWNER_MAX_WER;
}

// ── the recording ──────────────────────────────────────────────────────────
function pcmOf(buf: Buffer): Int16Array {
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** The bake-off run's lines.json, checked: exactly 25 lines, ids in order,
 *  text present, starts increasing, each end after its start. */
export function loadOwnerLines(dir: string): OwnerLine[] {
  const raw = JSON.parse(readFileSync(join(dir, "lines.json"), "utf8")) as { lines?: OwnerLine[] };
  const lines = raw.lines ?? [];
  if (lines.length !== OWNER_LINES) throw new Error(`lines.json: ${lines.length} lines, expected ${OWNER_LINES}`);
  lines.forEach((l, k) => {
    const ok = typeof l.text === "string" && l.text.trim() !== "" && Number.isFinite(l.startMs) && Number.isFinite(l.endMs)
      && l.endMs > l.startMs && (k === 0 || l.startMs >= lines[k - 1].startMs) && typeof l.pause === "boolean";
    if (!ok) throw new Error(`lines.json: line ${k + 1} is malformed`);
  });
  return lines;
}

/** StreamMic's punctuation commit (spec C.4), replayed on the recording's own
 *  speech segments (the clean take: the other conditions are degraded copies
 *  of the same audio, so their speech timing is the same), INCLUDING the
 *  pauses inside a line: a partial ending in . ? or ! (not an ellipsis) after
 *  400 ms of silence commits, exactly as StreamMic would. */
export function commitDue(segments: Array<[number, number]>, sentMs: number, partial: string | undefined): boolean {
  if (!partial) return false;
  if (segments.some(([a, b]) => a <= sentMs && sentMs < b)) return false;
  const lastEnd = segments.filter(([, b]) => b <= sentMs).at(-1)?.[1];
  if (lastEnd === undefined || sentMs - lastEnd < 400) return false;
  const text = partial.trim();
  return /[.?!]$/.test(text) && !/(\.\.\.|…)$/.test(text);
}

export async function runOwner(base: string, key: string, dir: string, policy: OwnerPolicy): Promise<OwnerResult[]> {
  const lines = loadOwnerLines(dir);
  const segments = speechSegments(pcmOf(readFileSync(join(dir, "clean.pcm"))));
  const results: OwnerResult[] = [];
  for (const condition of OWNER_CONDITIONS) {
    const audio = readFileSync(join(dir, `${condition}.pcm`));
    if ((audio.length / 2 / RATE) * 1000 < lines[lines.length - 1].startMs) throw new Error(`${condition}.pcm is shorter than the script`);
    const c = await ConformanceClient.open(base, { key, query: policy.query });
    await c.started();
    const committed = new Set<number>();
    const watch = setInterval(() => {
      if (!policy.commit) return;
      const partial = c.of("transcript.partial").at(-1);
      if (!partial || committed.has(partial.msg.turn) || c.of("turn.end").some((e) => e.msg.turn === partial.msg.turn)) return;
      if (commitDue(segments, c.sentAt.length * 64, partial.msg.text)) {
        committed.add(partial.msg.turn);
        c.sendJson({ type: "turn.commit" });
      }
    }, 20);
    try {
      await c.sendPaced(audio);
    } finally {
      clearInterval(watch);
    }
    c.close();
    await c.closedWithin(30_000);
    const finals = c.of("turn.end").map((r) => ({ at: r.at, text: r.msg.text, turn: r.msg.turn }));
    results.push(scoreOwner(condition, lines, finals, pcmOf(audio), (ms) => c.sentTimeOf(ms)));
  }
  return results;
}

/** Scores the bake-off's own saved AssemblyAI events with this code (no
 *  network): `raw/assemblyai-<condition>.jsonl` holds `{audioMs, kind, text,
 *  turnId}` per event, `audioMs` being the send clock when it arrived, so the
 *  send time of a recording position is the position itself. */
export function replayBakeoff(runDir: string, pcmFor: (condition: string) => Int16Array): OwnerResult[] {
  const lines = loadOwnerLines(runDir);
  return OWNER_CONDITIONS.map((condition) => {
    const events = readFileSync(join(runDir, "raw", `assemblyai-${condition}.jsonl`), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as { type?: string; kind?: string; text?: string; audioMs: number; turnId: number })
      .filter((e) => e.type !== "meta" && e.kind === "final" && e.text?.trim())
      .sort((a, b) => a.audioMs - b.audioMs);
    return scoreOwner(condition, lines, events.map((e) => ({ at: e.audioMs, text: e.text!, turn: e.turnId })), pcmFor(condition), (ms) => ms);
  });
}
