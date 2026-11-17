import { expect, it } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { A2_STREAM, checkTurnUnit, ScanMeter, ScanLimit, decide } from "./redact-stream-release.ts";
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

it("T41-COST-SEARCH 16 seeds, 200 generations x 64 mutations", () => {
  expect(SEEDS).toHaveLength(16);
  const next = generator(0x41c057), best = [SEEDS[6], SEEDS[1], SEEDS[1]], scores = [0, 0, 0];
  let highestRatio = 0, highestConsume = 0, highestDecisions = 0, evaluated = 0;
  const outcomes = new Set<string>();
  const evaluate = (input: string) => {
    const oracle = checkTurnUnit(input);
    expect(oracle.workUnits).toBeLessThanOrEqual(SECRET_SCAN_BUDGET);
    let sum = 0, total = 0;
    const scan = (text: string, options: { mode: "turn"; budget: number }) => {
      const r = scanTurnText(text, options); sum += r.workUnits; return r;
    };
    const meter = new ScanMeter(A2_STREAM, scan);
    try { decide(input.endsWith("\n") ? input : input + "\n", "", meter); } catch (error) { expect(error).toBeInstanceOf(ScanLimit); }
    expect(meter.work).toBe(sum); expect(meter.work).toBeLessThanOrEqual(6 * SECRET_SCAN_BUDGET);
    sum = 0;
    const p = createTurnTextPolicy({ scan }), cap = {} as TurnAdmission; p.admit(cap);
    const result = p.consume(cap, batch(input)), stats = p.stats();
    // Delta-only consume has no primary whole/snapshot intake scan.
    expect(stats.a2Work).toBe(sum); expect(stats.a2Work).toBeLessThanOrEqual(A2_STREAM);
    expect(stats.a2Decisions).toBeLessThanOrEqual(29);
    highestRatio = Math.max(highestRatio, oracle.workUnits / Math.max(1, input.length));
    highestConsume = Math.max(highestConsume, stats.a2Work); highestDecisions = Math.max(highestDecisions, stats.a2Decisions);
    if (result.masked) outcomes.add(result.exhausted ? "FC1" : stats.a2ScanExhausted ? "FC-SCAN" : "LATCH");
    else {
      let released = result.operations.map(o => o.text).join("");
      expect(input.startsWith(released)).toBe(true);
      if (!oracle.exhausted) expect(oracle.spans?.some(s => s.from < released.length && s.to > 0)).toBe(false);
      if (stats.a2Deferred) {
        outcomes.add("DEFER");
        // One stream has <=29 decisions and one completion. Every full
        // allowance resumes at least four maximal units, so eight suffice.
        let pending = stats.a2Deferred;
        while (pending && total++ < 8) {
          const resumed = p.consume(cap, batch(""));
          if (resumed.masked) break;
          released += resumed.operations.map(o => o.text).join(""); pending = p.stats().a2Deferred;
        }
        expect(total).toBeLessThanOrEqual(8);
      } else outcomes.add("RELEASE");
      p.finish(cap, "cancel");
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
