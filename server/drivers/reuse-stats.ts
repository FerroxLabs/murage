// What the warm engine actually did for the owner, this server lifetime: how many
// user turns found a live engine, what became of every spare, and why engines closed.
// Counts and fixed reasons only, held in memory, never a message or a value.
//
// A turn is counted once, by its turnId, the first time it is seen submitted or
// refused, so a retry adds nothing and a refused turn stays in the denominator.
// Prewarms and steers are never turns here. Sealed and reset turns stay in: leaving
// them out would hide a thread that can never reuse.

export type ReuseProcess = "reused" | "spare" | "spawned";

/** A repeat user turn: its thread's previous user turn settled within this. */
export const REPEAT_WINDOW_MS = 15 * 60_000;
/** Below this many repeat turns a rate says nothing. */
export const MIN_REPEAT_TURNS = 5;
const NOTE_INSUFFICIENT = "insufficient evidence";
const MAX_TURNS = 2_048;
const MAX_THREADS = 1_024;
const MAX_REASONS = 40;
const MAX_SAMPLES = 512;

export interface ReuseTurn {
  engine: string;
  threadId: string;
  turnId: string;
  background?: boolean;
  sealed?: boolean;
}

/** One spare's life: started, maybe parked, then exactly one final state. */
export interface SpareHandle {
  parked(): void;
  served(): void;
  /** It ended with no turn on it. `no-send` when nobody came for it. */
  lost(reason: string): void;
}

const percentile = (sorted: number[], share: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;
const summarize = (samples: number[]) => {
  if (!samples.length) return { p50: null, p90: null, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), n: sorted.length };
};
/** A close reason without its count: `child processes alive at settle (8)`. */
/** The fixed part of a reason, up to any count or detail: a counter name, never a value.
 * A reason can end in an engine's own error text, which stays out of the gauge. */
const reasonKey = (reason: string) => (/^(?:key|fence):[\w-]+/.exec(reason)?.[0] ?? reason.split(/[:(]/, 1)[0]!.trim()).slice(0, 60) || "other";
const bump = (counts: Record<string, number>, key: string) => {
  if (key in counts || Object.keys(counts).length < MAX_REASONS) counts[key] = (counts[key] ?? 0) + 1;
  else counts.other = (counts.other ?? 0) + 1;
};
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1_000) / 1_000 : null);

export function createReuseStats(now: () => number = Date.now) {
  const lifetime = new Date(now()).toISOString();
  const turns = new Map<string, { repeat: boolean; submitted: boolean }>();
  const lastUserSettle = new Map<string, number>();
  const counts = { userTurns: 0, repeatTurns: 0, hot: 0, hotRepeat: 0, sealedTurns: 0, backgroundTurns: 0 };
  const spares = { started: 0, parked: 0, served: 0, noSend: 0, lost: {} as Record<string, number> };
  const closes: Record<string, number> = {};
  const resets: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  const spawnReasons: Record<string, number> = {};
  const firstToken = { hot: [] as number[], cold: [] as number[] };

  /** The turn's entry, counted the first time it is seen. Background turns are not user turns. */
  const entry = (turn: ReuseTurn) => {
    const key = `${turn.engine}\0${turn.turnId}`;
    const known = turns.get(key);
    if (known) return known;
    const made = { repeat: false, submitted: false };
    if (turn.background) counts.backgroundTurns++;
    else {
      counts.userTurns++;
      if (turn.sealed) counts.sealedTurns++;
      const last = lastUserSettle.get(turn.threadId);
      made.repeat = last !== undefined && now() - last <= REPEAT_WINDOW_MS;
      if (made.repeat) counts.repeatTurns++;
    }
    turns.set(key, made);
    if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value!);
    return made;
  };

  const snapshot = () => {
    const lostTotal = Object.values(spares.lost).reduce((sum, n) => sum + n, 0);
    const enough = counts.repeatTurns >= MIN_REPEAT_TURNS;
    return {
      lifetime,
      userTurns: counts.userTurns,
      repeatTurns: counts.repeatTurns,
      hot: counts.hot,
      hotRepeatTurns: counts.hotRepeat,
      reuseRate: enough ? rate(counts.hotRepeat, counts.repeatTurns) : null,
      ...(enough ? {} : { reuseRateNote: NOTE_INSUFFICIENT }),
      hotShare: rate(counts.hot, counts.userTurns),
      sealedTurns: counts.sealedTurns,
      excluded: { backgroundTurns: counts.backgroundTurns },
      spares: { started: spares.started, parked: spares.parked, served: spares.served, lost: { ...spares.lost }, noSend: spares.noSend },
      spareHitRate: rate(spares.served, spares.started),
      spareServeRate: rate(spares.served, spares.served + lostTotal),
      firstToken: { hot: summarize(firstToken.hot), cold: summarize(firstToken.cold) },
      closes: { ...closes },
      resets: { ...resets },
      refused: { ...refusals },
      spawnReasons: { ...spawnReasons },
    };
  };

  return {
    /** The prompt reached the engine (after a successful write). Never for a prewarm or a steer. */
    submitted(turn: ReuseTurn & { process: ReuseProcess; spawnReason?: string | null }) {
      const seen = entry(turn);
      if (seen.submitted) return; // a retry of the same turn
      seen.submitted = true;
      if (turn.spawnReason) bump(spawnReasons, reasonKey(turn.spawnReason));
      if (turn.background || turn.process === "spawned") return;
      counts.hot++;
      if (seen.repeat) counts.hotRepeat++;
    },
    /** The turn was refused before its prompt was written. */
    refused(turn: ReuseTurn & { reason: string }) {
      entry(turn);
      bump(refusals, turn.reason);
    },
    settled(turn: { threadId: string; background?: boolean }) {
      if (turn.background) return;
      lastUserSettle.delete(turn.threadId);
      lastUserSettle.set(turn.threadId, now());
      if (lastUserSettle.size > MAX_THREADS) lastUserSettle.delete(lastUserSettle.keys().next().value!);
    },
    closed(reason: string) { bump(closes, reasonKey(reason)); },
    reset(route: string) { bump(resets, route); },
    firstToken(process: ReuseProcess, ms: number) {
      const samples = process === "spawned" ? firstToken.cold : firstToken.hot;
      samples.push(ms);
      if (samples.length > MAX_SAMPLES) samples.shift();
    },
    /** A spare was started on intent. Every spare ends in exactly one final state. */
    spare(): SpareHandle {
      spares.started++;
      let parked = false, ended = false;
      const end = (record: () => void) => { if (!ended) { ended = true; record(); } };
      return {
        parked() { if (!parked && !ended) { parked = true; spares.parked++; } },
        served() { end(() => { spares.served++; }); },
        lost(reason) { end(() => { if (reason === "no-send") spares.noSend++; else bump(spares.lost, reasonKey(reason)); }); },
      };
    },
    snapshot,
    /** The figures for the 5-minute `warm pool` line. */
    line(): string {
      const s = snapshot();
      return `userTurns=${s.userTurns} repeatTurns=${s.repeatTurns} hot=${s.hot} reuseRate=${s.reuseRate ?? "none"} hotShare=${s.hotShare ?? "none"} sealedTurns=${s.sealedTurns} spares=${s.spares.served}/${s.spares.started}`;
    },
  };
}

export const reuseStats = createReuseStats();
