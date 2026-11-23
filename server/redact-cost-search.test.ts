import { expect, it } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { A2_STREAM, CONTEXT_LIMIT, PROBES, SCAN_RATE, checkTurnUnit, ScanMeter, ScanLimit, decide } from "./redact-stream-release.ts";
import { scanTurnText } from "./redact.ts";
import { createTurnTextPolicy, type ManifestBatch, type TurnAdmission } from "./redact-turn.ts";
import { SECRET_SCAN_BUDGET } from "../shared/md-secret-label.mjs";

// Frozen initial corpus and PRNG make discoveries reproducible. This searches
// three objectives independently, rather than selecting only large inputs.
const SEEDS = Object.freeze([
  "z".repeat(65_500), "x\n".repeat(10_000), ("token\n" + " \n".repeat(125) + "x\n").repeat(254),
  "hello ".repeat(682) + "xxxx", "token" + " ".repeat(65_500),
  ("token:" + " ".repeat(100) + "token\n").repeat(586).slice(0, 65_536), "token:" + " ".repeat(100) + "token\n",
  "token\n".repeat(11_000), "password" + " ".repeat(2000) + "=\n",
  "a: b: c: token: ".repeat(100), "\r".repeat(4000), ("-----BEGIN PRIVATE " + "KEY-----").repeat(100),
  "sk-SG.pypi-".repeat(300), "Bearer\n", "Authorization%3A%20Basic\n", "hello\n".repeat(1000),
]);
const TOKENS = ["token", "password", "Authorization", "basic", "Bearer", "=", ":", " ", "\t", "\n", "\r", "sk-", "SG.", "pypi-", "Q", "%20", ("-----BEGIN PRIVATE " + "KEY-----")];
const LIMIT = 262_144;
function generator(seed: number) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }
function batch(text: string): ManifestBatch {
  return { envelope: { eventId: "cost", instanceId: "cost", threadId: "cost", generation: 1, intakeOrdinal: 1, createdAt: 0 }, variant: "M15", carriers: [{ text, path: "text", stream: "a:assistant", mode: "delta" }], controls: {} };
}

/** Most decisions one fresh delta consume of n characters can make, given the scan work it was charged (derivation at the assertion). */
function decisionBound(n: number, work: number): number {
  const schedule = Math.floor(Math.log2(Math.max(1, n))) + 1 + 2;
  return n <= CONTEXT_LIMIT ? schedule : schedule + 2 * Math.floor((n - 1) / CONTEXT_LIMIT) + Math.floor(work / (4 * CONTEXT_LIMIT)) + 2;
}

it("T41-COST-BOUND arithmetic of the derived decision bound", () => {
  expect(decisionBound(65_536, 1e12)).toBe(19); // n <= C: no cap-guard term, whatever the work
  expect(decisionBound(LIMIT, 0)).toBe(19 + 2 + 6 + 2);
  const worst = A2_STREAM + 8 * SCAN_RATE * LIMIT; // 5.3 ceiling of a2Work for n = LIMIT
  expect(decisionBound(LIMIT, worst)).toBe(29 + 96 + LIMIT / 512);
  // Linear in the characters offered: doubling n adds at most a constant per C characters.
  expect(decisionBound(2 * LIMIT, A2_STREAM + 8 * SCAN_RATE * 2 * LIMIT) - decisionBound(LIMIT, worst)).toBe(1 + 8 + LIMIT / 512);
});

it("T41-COST-HISTORY decisions and work for new text do not grow with the turn's released history", () => {
  // Held shapes (a probe completes a label, so every LF past C is decided again), clean prose, and one long held line.
  for (const [name, text] of [["token", "token\n".repeat(30_000)], ["bearer", "Bearer\n".repeat(30_000)], ["prose", "hello world\n".repeat(20_000)]] as const) {
    const seen: string[] = [];
    for (const history of [0, 20_000, 200_000]) {
      const p = createTurnTextPolicy(), cap = {} as TurnAdmission; p.admit(cap);
      if (history) {
        const shown = p.consume(cap, batch("hello\n".repeat(history)));
        expect(shown.masked, name).toBe(false); expect(shown.operations.map(o => o.text).join("").length, name).toBe(6 * history);
      }
      const result = p.consume(cap, batch(text)), stats = p.stats();
      expect(result.masked, name).toBe(false);
      expect(stats.a2Work, name).toBeLessThanOrEqual(A2_STREAM + 8 * SCAN_RATE * text.length);
      expect(stats.a2Decisions, name).toBeLessThanOrEqual(decisionBound(text.length, stats.a2Work));
      seen.push(JSON.stringify([stats.a2Decisions, stats.a2Work, stats.a2Deferred, stats.pending, result.withheld ?? false, result.operations.map(o => o.text).join("")]));
    }
    expect(seen[1], name).toBe(seen[0]); expect(seen[2], name).toBe(seen[0]);
  }
}, 600_000);

it("T41-COST-SEARCH 16 seeds, 200 generations x 64 mutations", () => {
  expect(SEEDS).toHaveLength(16);
  const next = generator(0x41c057), best = [SEEDS[6], SEEDS[1], SEEDS[1]], scores = [0, 0, 0];
  let highestRatio = 0, highestConsume = 0, highestDecisions = 0, evaluated = 0;
  const outcomes = new Set<string>();
  const evaluate = (input: string) => {
    const oracle = checkTurnUnit(input);
    // 5.3: "Every scan call gets SECRET_SCAN_BUDGET + RATE * text.length work".
    expect(oracle.workUnits).toBeLessThanOrEqual(SECRET_SCAN_BUDGET + SCAN_RATE * input.length);
    let sum = 0, total = 0;
    const scan = (text: string, options: { mode: "turn"; budget: number }) => {
      const r = scanTurnText(text, options); sum += r.workUnits;
      // The work floor the a2Decisions derivation uses: a finished scan is charged at least 2 units per character.
      if (!r.exhausted) expect(r.workUnits).toBeGreaterThanOrEqual(2 * text.length);
      return r;
    };
    const meter = new ScanMeter(A2_STREAM, scan);
    try { decide(input.endsWith("\n") ? input : input + "\n", "", meter); } catch (error) { expect(error).toBeInstanceOf(ScanLimit); }
    // One decision is 1 + 3 probe scans (5.2) of at most the unit, its LF and the longest probe, each under the 5.3 per-scan grant.
    expect(meter.work).toBe(sum); expect(meter.work).toBeLessThanOrEqual(4 * (SECRET_SCAN_BUDGET + SCAN_RATE * (input.length + 1 + PROBES[0].length)));
    sum = 0;
    const p = createTurnTextPolicy({ scan }), cap = {} as TurnAdmission; p.admit(cap);
    const result = p.consume(cap, batch(input)), stats = p.stats();
    // Delta-only consume has no primary whole/snapshot intake scan.
    // MAIN-RULING 2026-11-22T17:47:36Z (b) removed the fixed display budgets, and MAIN-RULING 2026-11-22T17:58:19Z binds
    // designs/REDACT-AUDIENCE-1021.md 5.3: "ScanMeter allowance for one consume or finish = base + 4 * RATE * (characters of new
    // carriers ...). It is a rate, so it cannot be reached by size." and "COUNTED UNIT ...: scanner work units per input character
    // of the unit scanned, bounded by 8 * RATE across the 1 + 3 probe scans plus completion." One fresh delta consume offers the input.
    expect(stats.a2Work).toBe(sum); expect(stats.a2Work).toBeLessThanOrEqual(A2_STREAM + 8 * SCAN_RATE * input.length);
    // a2Decisions, derived (MAIN-RULING 2026-11-23T04:17:54Z row (a)). n = characters offered to this fresh consume, C = CONTEXT_LIMIT.
    // 5.1: a decision is scheduled at an LF only by lfDecision (first, doubling, cap guard, last LF), plus one trailing-word decision.
    //   first + doubling: each is at least twice the running maximum, so the k-th is >= 2^(k-1) characters: <= floor(log2 n) + 1.
    //   last LF: 1. trailing word: 1.
    //   cap guard, RELEASE: the released chunk plus the line after it is > C characters, and every second such stretch is
    //     disjoint, so ceil(R / 2) * C < n: R <= 2 * floor((n - 1) / C).
    //   cap guard, HOLD (5.2 "HOLD has no size limit ... decided again with the next chunk appended"): the held text plus the
    //     next line is > C, so the LF decision that follows each such HOLD sees > C pending characters. Those followers are
    //     distinct; at most one HOLD has none (the consume ended or deferred) and at most one follower is the LATCH that ends
    //     the consume. Every other follower finishes >= 2 scans of > C characters, and a finished scan is charged >= 2 units
    //     per character (asserted in `scan` above): > 4 * C units each of the 5.3 allowance that a2Work counts. So
    //     H <= floor(a2Work / (4 * C)) + 2. None when n <= C.
    // A resume (empty consume) offers n = the pending characters: its resumed unit is the first decision of the same chain
    // (the running maximum restarts per consume) and the trailing word is not decided twice, so the same bound holds.
    // n = 262,144: 19 + 2 + 6 = 27 (+ H). With a2Work <= A2_STREAM + 8 * RATE * n (5.3, the line above) H <= 98 + n / 512: the
    // bound is linear in the characters offered and has no term in the turn's released history (this consume has none).
    expect(stats.a2Decisions).toBeLessThanOrEqual(decisionBound(input.length, stats.a2Work));
    highestRatio = Math.max(highestRatio, oracle.workUnits / Math.max(1, input.length));
    highestConsume = Math.max(highestConsume, stats.a2Work); highestDecisions = Math.max(highestDecisions, stats.a2Decisions);
    if (result.masked) outcomes.add(result.exhausted ? "FC1" : stats.a2ScanExhausted ? "FC-SCAN" : "LATCH");
    else {
      let released = result.operations.map(o => o.text).join(""), settled = false;
      expect(input.startsWith(released)).toBe(true);
      if (!oracle.exhausted) expect(oracle.spans?.some(s => s.from < released.length && s.to > 0)).toBe(false);
      if (stats.a2Deferred) {
        outcomes.add("DEFER");
        // 5.2 "HOLD has no size limit" and 5.3 "DEFER stays legal during a turn: it is a delay (the text is decided on the next
        // consume or at finish), never a cut" (MAIN-RULING 2026-11-22T17:58:19Z). The old claim that eight resumes always finish
        // held only while held text was capped at C (the display budget MAIN-RULING 2026-11-22T17:47:36Z (b) removed): a held
        // text past C is decided again at each later LF. What 5.3 promises instead is pinned here: every resume that is still
        // deferred made at least one more decision under its own O(pending) allowance, and finish settles the rest at once.
        // One resume per input keeps this search inside the scan work it had with the fixed allowance (1 + 8 consumes of
        // 24 budgets then; a consume is granted up to 24 budgets + 4 * RATE * n now).
        let pending = stats.a2Deferred;
        while (pending && total++ < 1) {
          const resumed = p.consume(cap, batch(""));
          if (resumed.masked) { pending = 0; settled = true; break; }
          released += resumed.operations.map(o => o.text).join(""); const now = p.stats(); pending = now.a2Deferred;
          expect(now.a2Work).toBeLessThanOrEqual(A2_STREAM + 8 * SCAN_RATE * input.length);
          expect(now.a2Decisions).toBeLessThanOrEqual(decisionBound(input.length, now.a2Work));
          if (pending) expect(now.a2Decisions).toBeGreaterThanOrEqual(1);
        }
        expect(input.startsWith(released)).toBe(true);
        if (!oracle.exhausted) expect(oracle.spans?.some(s => s.from < released.length && s.to > 0)).toBe(false);
        if (pending) {
          // Still deferred after the resume: finish decides all of it. Exhaustion never masks the turn (5.3), and what is
          // shown is the whole input unless a unit was withheld under its marker (5.5).
          const tail = p.finish(cap, "complete"); settled = true;
          expect(tail.exhausted).toBe(false);
          if (!tail.masked && !tail.withheld) {
            expect(released + tail.operations.map(o => o.text).join("")).toBe(input);
            if (!oracle.exhausted) expect(oracle.detected).toBe(false);
          }
        }
      } else outcomes.add("RELEASE");
      if (!settled) p.finish(cap, "cancel");
    }
    evaluated++;
    return [oracle.workUnits / Math.max(1, input.length), stats.a2Work, stats.a2Decisions];
  };
  for (const seed of SEEDS) evaluate(seed);
  for (let generation = 0; generation < 200; generation++) for (let mutation = 0; mutation < 64; mutation++) {
    const source = mutation % 4 === 0 ? SEEDS[next() % SEEDS.length] : best[mutation % 3];
    const at = next() % (source.length + 1), end = at + next() % (source.length - at + 1), token = TOKENS[next() % TOKENS.length];
    const candidate = [
      () => source.slice(0, at) + token + source.slice(at),
      () => source.slice(0, at) + source.slice(end),
      () => source.slice(0, at) + source.slice(at, end).repeat(2) + source.slice(end),
      () => source.slice(0, at) + token + source.slice(end),
    ][next() % 4]().slice(0, LIMIT);
    const result = evaluate(candidate);
    for (let objective = 0; objective < 3; objective++) if (result[objective] > scores[objective]) { scores[objective] = result[objective]; best[objective] = candidate; }
  }
  expect(evaluated).toBe(12_816);
  if (existsSync(".s1-evidence")) writeFileSync(".s1-evidence/cost-search.json", JSON.stringify({ evaluated, highestRatio, highestConsume, highestDecisions, outcomes: [...outcomes], scores }, null, 2));
// Remote workers have different CPU speeds; this wall-clock timeout does
// not change any scanner allowance or the fixed 12,816-input search.
}, 1_200_000);
