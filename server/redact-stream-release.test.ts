import { describe, expect, it } from "vitest";
import { scanSecretText } from "../shared/md-secret-label.mjs";
import { redactSecretsForSink } from "./redact.ts";
import { createTurnTextPolicy, type ManifestBatch, type TurnAdmission } from "./redact-turn.ts";

const check = (s: string) => redactSecretsForSink(scanSecretText(s, { mode: "turn" }).text);
const prefix = "4111 1111", suffix = " 1111 1111\n";
function batch(text: string, stream: string, mode: "delta" | "snapshot" = "delta"): ManifestBatch {
  return { envelope: { eventId: "fixture", instanceId: "fixture", threadId: "thread", generation: 1, intakeOrdinal: 1, createdAt: 0 }, variant: "M15", carriers: [{ path: "text", stream, mode, text }], controls: {} };
}
const splits = Array.from({ length: prefix.length + 1 }, (_, a) => Array.from({ length: suffix.length + 1 }, (_, b) => [a, b] as const)).flat();
describe("r3.1 target-model baseline REDs", () => {
  it("T41-ITEM-LF-LOCAL financial control", () => {
    expect(check(prefix)).toBe(prefix);
    expect(check(prefix + "\n" + suffix)).toBe(prefix + "\n" + suffix);
    expect(check(prefix + suffix)).not.toBe(prefix + suffix);
  });
  it.each(splits)("T41-ITEM-BOUNDARY-FIN splits %i/%i", (a, b) => {
    const p = createTurnTextPolicy(), cap = {} as TurnAdmission;
    p.admit(cap);
    let released = "";
    const feed = (s: string, key: string, mode: "delta" | "snapshot" = "delta") => {
      const result = p.consume(cap, batch(s, key, mode));
      expect(result.masked).toBe(false);
      const text = result.operations.map(op => op.text).join(""); released += text; return text;
    };
    expect(feed("Hello there.\n", "control:assistant", "snapshot")).toBe("Hello there.\n");
    feed(prefix.slice(0, a), "1:assistant"); feed(prefix.slice(a), "1:assistant");
    expect(feed(prefix, "1:assistant", "snapshot")).toBe(prefix);
    feed(suffix.slice(0, b), "2:assistant"); feed(suffix.slice(b), "2:assistant");
    released += p.finish(cap, "complete").operations.map(op => op.text).join("");
    expect(released).toBe("Hello there.\n4111 1111\n 1111 1111\n");
    expect(check(released)).toBe(released);
  });
  it.each(Array.from({length: (prefix + suffix).length + 1}, (_, i) => i))("T41-ITEM-WITHIN-FIN split %i", cut => {
    const p = createTurnTextPolicy(), cap = {} as TurnAdmission; p.admit(cap);
    const input = prefix + suffix;
    const results = [p.consume(cap, batch(input.slice(0, cut), "1:assistant")), p.consume(cap, batch(input.slice(cut), "1:assistant")), p.finish(cap, "complete")];
    expect(results.some(d => d.masked)).toBe(true);
    expect(results.flatMap(d => d.operations).map(op => op.text).join("")).not.toContain("4111");
  });
});

// Pure A2b contract; the stream corpus above intentionally runs through F2.
import { readFileSync } from "node:fs";
import {
  itemSep, joinItems, PROBES, decide, openAfter,
  lfDecision, ScanMeter, ScanLimit, A2_STREAM, SCAN_RATE, checkTurnUnit,
} from "./redact-stream-release.ts";
import { SECRET_SCAN_BUDGET } from "../shared/md-secret-label.mjs";

describe("A2b pure decisions", () => {
  it("T41-ONE-SEPARATOR table and empty-tail context", () => {
    for (const left of ["", "a", "a\n", "a\r", "a\r\n", "a \n", "a\n\n", "a "]) {
      for (const right of ["", "b", "\nb", " b"]) {
        const sep = !left || left.endsWith("\n") ? "" : "\n";
        expect(joinItems(left, right)).toBe(left + sep + right);
        expect(joinItems("", right, left.at(-1))).toBe(sep + right);
      }
    }
    expect(itemSep(undefined)).toBe("");
  });
  it("T41-ONE-SEPARATOR source guard", () => {
    for (const path of ["server/redact-stream-release.ts", "server/redact-turn.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/(?:["']\\n["']\s*\+|\+\s*["']\\n["']|`\\n)/);
    }
  });
  it("T40-PROBE-SELFCLEAN", () => {
    expect(PROBES).toEqual(["basic," + "Q".repeat(48), "=" + "Q".repeat(48), "Q".repeat(48)]);
    for (const p of PROBES) for (const lead of ["", "\n", "\n \t"]) {
      const r = checkTurnUnit(lead + p); expect(r.detected).toBe(false); expect(r.text).toBe(lead + p);
    }
  });
  it("T40-DECIDE holds open heads and releases closed prose", () => {
    for (const U of ["Bearer\n", "token\n", "password=\n", `SG.${"a".repeat(22)}.\n`]) {
      expect(decide(U, "", new ScanMeter())).toBe("HOLD");
    }
    expect(decide("Hello there.\n", "", new ScanMeter())).toBe("RELEASE");
    expect(decide("Bearer\ndXNlcjpwYXNz\n", "", new ScanMeter())).toBe("LATCH");
    expect(decide("See the Authorization:\n", "The ", new ScanMeter())).toBe("RELEASE");
  });
  it("T41-ONE-SEPARATOR in-item probes keep U+t+p bytes", () => {
    const scans: string[] = [];
    const meter = new ScanMeter(A2_STREAM, (s, o) => { scans.push(s); return scanSecretText(s, o); });
    expect(decide("Hello.\n", "The ", meter)).toBe("RELEASE");
    expect(scans).toEqual(["Hello.\nThe ", ...PROBES.map(p => "Hello.\nThe " + p)]);
  });
  it("T41-SG-BOUNDARY completion probes use the same separator", () => {
    const head = `SG.${"a".repeat(22)}.`;
    for (const ending of ["", "\n"]) expect(openAfter(head + ending, (head + ending).at(-1), new ScanMeter())).toBe(true);
    expect(openAfter("Hello", "o", new ScanMeter())).toBe(false);
  });
  it("T41-METER charges scanner-reported work including failed scans", () => {
    let sum = 0;
    const m = new ScanMeter(A2_STREAM, (s, o) => { const r = scanSecretText(s, o); sum += r.workUnits; return r; });
    m.check("token:" + " ".repeat(100) + "token\n");
    expect(m.work).toBe(sum); expect(m.work).toBeGreaterThan(7 * 112);
    const deferred = new ScanMeter(10);
    // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design 5.3): a scan is never cut short for work it is owed per character, so the unit that meets a small
    // remaining allowance is finished (and charged) and the NEXT unit is deferred. Deferral is a delay, never a cut.
    expect(deferred.check("ordinary prose").exhausted).toBe(false); expect(deferred.work).toBeGreaterThan(10);
    expect(() => deferred.check("ordinary prose")).toThrow(new ScanLimit("DEFER"));
    expect(deferred.scanExhausted).toBe(0);
    // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design S5): one scan's work is per character, so 200,000 characters are scanned, not refused at 1 MiB of work.
    const long = new ScanMeter();
    expect(long.check("z".repeat(200_000)).exhausted).toBe(false); expect(long.scanExhausted).toBe(0);
    // FC-SCAN is now only a scanner that reports it could not finish; its reported work is still charged.
    const exhausted = new ScanMeter(A2_STREAM, () => ({ text: "«redacted»", detected: true, exhausted: true, workUnits: SECRET_SCAN_BUDGET, candidates: [] }));
    expect(() => exhausted.check("z".repeat(200_000))).toThrow(new ScanLimit("FC-SCAN"));
    expect(exhausted.work).toBe(SECRET_SCAN_BUDGET); expect(exhausted.scanExhausted).toBe(1);
  });
  it("T40-COST schedule bounds 10000 clean LF decisions", () => {
    let d = 0, decisions = 0, U = "";
    const m = new ScanMeter();
    for (let i = 0; i < 10_000; i++) {
      U += "x\n";
      if (lfDecision(U.length, d, false, i === 9_999)) {
        d = Math.max(d, U.length); decisions++;
        if (decide(U, "", m) === "RELEASE") U = "";
      }
    }
    expect(decisions).toBeLessThanOrEqual(17); expect(U).toBe("");
    expect(m.work).toBeLessThanOrEqual(A2_STREAM);
  });
});

import { scanTurnText } from "./redact.ts";
import { rowChainStep, turnUnitSpans, readChainContext, LOST, H_ROW, A2_ROW } from "./redact-stream-release.ts";

describe("B3 aggregate checker and row chain", () => {
  it("T41-METER aggregate includes compatibility and financial passes", () => {
    for (const s of ["ordinary prose\n", "token:" + " ".repeat(100) + "token\n", "4111 1111 1111 1111\n", "Authorization Basic dXNlcjpwYXNz", "-----BEGIN PRIVATE KEY-----\nBODY"]) {
      const primary = scanSecretText(s, { mode: "turn" });
      const result = checkTurnUnit(s);
      expect(result.workUnits).toBeGreaterThan(primary.workUnits);
      expect(result.workUnits).toBeLessThanOrEqual(SECRET_SCAN_BUDGET);
      expect(result.exhausted).toBe(false);
    }
    let sum = 0;
    const meter = new ScanMeter(A2_STREAM, (s, o) => { const r = scanTurnText(s, o); sum += r.workUnits; return r; });
    for (const text of ["hello\n", "token:" + " ".repeat(100) + "token\n", "4111 1111 1111 1111"]) meter.check(text);
    expect(meter.work).toBe(sum);
    // The primary pass fits; the compatibility pass binds the aggregate cap.
    const input = "z".repeat(65_500), primary = scanSecretText(input, { mode: "turn" });
    // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design X2/S5): checkTurnUnit adds work per character, so the fixed cap is pinned on the scanner it wraps.
    expect(scanTurnText(input, { budget: primary.workUnits + 1 })).toMatchObject({ exhausted: true, workUnits: primary.workUnits + 1 });
    expect(checkTurnUnit(input)).toMatchObject({ exhausted: false }); expect(checkTurnUnit(input).workUnits).toBeGreaterThan(primary.workUnits);
  });
  // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z (design 5.3): the bound on one scan is SSB plus SCAN_RATE units per character (linear), no longer SSB alone.
  it("T41-METER worst-case aggregate remains at or below SSB plus the per-character rate", () => {
    const seeds = ["token:" + " ".repeat(100) + "token\n", "-----BEGIN PRIVATE KEY-----", "Authorization%20Basic%20", "token\n", "SG.", "1234 "];
    for (const seed of seeds) for (const n of [1, 100, 65_536, 262_144]) {
      const s = seed.repeat(Math.ceil(n / seed.length)).slice(0, n), r = checkTurnUnit(s);
      expect(r.workUnits).toBeLessThanOrEqual(SECRET_SCAN_BUDGET + SCAN_RATE * s.length);
      if (n === 262_144) expect(r.exhausted, seed.slice(0, 12)).toBe(false);
      if (r.exhausted) expect(r.text).toBe("«redacted»");
    }
  });
  it("T40-CHECK-IDENTITY spans and text share one composite result", () => {
    for (const s of ["hello", "Bearer\ndXNlcjpwYXNz", "Authorization%20Basic%20dXNlcjpwYXNz", "token=abcdefgh", "4111 1111 1111 1111"]) {
      const result = checkTurnUnit(s), meter = new ScanMeter();
      expect(result).toEqual(scanTurnText(s));
      expect(turnUnitSpans(s, meter)).toEqual(result.spans);
      expect(meter.work).toBe(result.workUnits);
      expect(Boolean(result.spans?.length)).toBe(result.detected);
    }
  });
  it("T41-ROW-CROSS checks R even when it is already unclean", () => {
    for (const [L, R] of [["Bearer", "dXNlcjpwYXNz\nsk-abcdefghijklmnop"], ["Bearer", "xx-sk-" + "a".repeat(20)], ["SG." + "a".repeat(22) + ".", "b".repeat(43)], ["pypi-" + "a".repeat(16), "bbbb"], ["-----BEGIN PRIVATE KEY-----", "BODY"], ["Authorization: Basic", "dXNlcjpwYXNz"]]) {
      expect(rowChainStep(L, R).mask, L).toBe(true);
    }
    expect(rowChainStep("Hello", "world").mask).toBe(false);
    expect(rowChainStep("", "world")).toMatchObject({ mask: false, lost: false });
  });
  it("T41-CTX-LOST and FC-ROW propagate loss", () => {
    expect(rowChainStep(LOST, "hello")).toMatchObject({ mask: true, open: true, lost: true });
    expect(rowChainStep("a".repeat(65_537), "hello").mask).toBe(true);
    expect(rowChainStep("Bearer", "hello", new ScanMeter(1))).toMatchObject({ mask: true, open: true, lost: true });
    expect(A2_ROW).toBe(A2_STREAM);
  });
  it("T41-ROW-HOPS counts skipped tools and stops at cached state", () => {
    for (const n of [254, 300]) {
      let reads = 0;
      const read = (id: string) => { reads++; const i = Number(id); return { id, parentId: i ? String(i - 1) : undefined, role: "bot", kind: i ? "tool" : "text", turnId: "turn", text: i ? "" : "Bearer" }; };
      const ctx = readChainContext(String(n), read);
      expect(reads).toBe(Math.min(n + 1, H_ROW));
      expect(ctx).toBe(n === 254 ? "Bearer" : LOST);
      expect(rowChainStep(ctx, "dXNlcjpwYXNz").mask).toBe(true);
    }
    let reads = 0;
    expect(readChainContext("cached", id => { reads++; return { id, role: "bot", kind: "text", text: "", context: "" }; })).toBe("");
    expect(reads).toBe(1);
    expect(readChainContext("300", id => ({ id, parentId: String(Number(id) - 1), role: "bot", kind: "tool", text: "" }), () => "")).toBe("");
  });
});

// Frozen bounded token enumeration: 1 + 24 + 24² + 24³, times 16
// continuations = 230,800 cases, below the ruling's 300,000 ceiling.
const alphabet = ["Authorization", "basic", "Bearer", "token", "password", "b", "a", "ba", "bas", "au", "bauthorization:", "%", "%2", "%20", "%3A", "\r", "\n", " ", "\t", "'", '"', "=", ":", "SG."];
const continuations = ["", "hello\n", "The header goes here.\n", "dXNlcjpwYXNz\n", "=hunter22\n", "basic,dXNlcjpwYXNz\n", "Basic dXNlcjpwYXNz\n", "\nBasic dXNlcjpwYXNz", " hunter22abcd\n", "\tQ".repeat(8), "Q".repeat(48), "b".repeat(43), "4111 1111 1111 1111", "sk-abcdefghijklmnop", '"hunter22"', "%20Basic%20dXNlcjpwYXNz"];
function random(seed: number) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }
const cleanUnit = (text: string) => { const r = checkTurnUnit(text); return !r.detected && !r.exhausted && r.text === text; };
function certifiedBoundary(A: string) { return cleanUnit(A) && PROBES.every(p => cleanUnit(A + p)); }
function assertBoundary(A: string, B: string) {
  const whole = checkTurnUnit(A + B);
  // Locality is asserted only at certified clean release boundaries (odes3 M6).
  expect(whole.spans?.filter(s => s.from < A.length), JSON.stringify([A, B])).toEqual([]);
  expect(whole.spans?.map(s => ({ from: s.from - A.length, to: s.to - A.length })), JSON.stringify([A, B])).toEqual(checkTurnUnit(B).spans);
}

describe("bounded release properties", () => {
  it("T40-PROBE-COMPLETE / T40-LF-LOCALITY exhaustive 230800 cases", () => {
    const all = [""]; let layer = [""];
    for (let depth = 0; depth < 3; depth++) { layer = layer.flatMap(a => alphabet.map(b => a + b)); all.push(...layer); }
    expect(all.length * continuations.length).toBe(230_800);
    for (const input of all) {
      const A = input + "\n";
      if (!certifiedBoundary(A)) continue;
      for (const B of continuations) assertBoundary(A, B);
    }
  }, 120_000);
  it("T40-PROBE-COMPLETE-WS / T40-CROSS-MONOTONE 50000 seeded pairs", () => {
    const rng = random(0x413104);
    for (let i = 0; i < 50_000; i++) {
      const U = alphabet[rng() % alphabet.length] + alphabet[rng() % alphabet.length] + "\n";
      const t = ["The ", "basic ", "x\t", " "][rng() % 4], B = continuations[rng() % continuations.length];
      const decision = decide(U, t, new ScanMeter());
      if (decision === "RELEASE") {
        const spans = checkTurnUnit(U + t + B).spans ?? [];
        expect(spans.filter(s => s.from < U.length), JSON.stringify([U, t, B])).toEqual([]);
      }
      if (!cleanUnit(U + t) && cleanUnit(t)) {
        expect(decision).toBe("LATCH");
        expect(checkTurnUnit(U + t + B).spans?.some(s => s.from < U.length && s.to > 0), JSON.stringify([U, t, B])).toBe(true);
      }
    }
  }, 120_000);
  it("T41-ITEM-LF-LOCAL 50000 seeded line-local financial pairs", () => {
    const rng = random(0x41992), values = ["4111 1111 1111 1111", "account 12345678", "GB82 WEST 1234 5698 7654 32", "SSN 123-45-6789", "ordinary prose", "sk-abcdefghijklmnop", "eyJabcdefgh.abcdefgh.abcdefgh"];
    for (let i = 0; i < 50_000; i++) {
      const value = values[rng() % values.length], cut = rng() % (value.length + 1);
      const A = value.slice(0, cut), B = value.slice(cut), joined = joinItems(A, B);
      if (certifiedBoundary(joinItems(A, ""))) assertBoundary(joinItems(A, ""), B);
      expect(checkTurnUnit(joined).exhausted).toBe(false);
    }
  }, 120_000);
});

it("T40-DRIFT composite Clean agrees with original candidate and sink checks", () => {
  const next = random(0x41d21f);
  const words = ["ordinary prose", "token=abcdefgh", "Bearer dXNlcjpwYXNz", "Authorization%20Basic%20dXNlcjpwYXNz", "4111 1111 1111 1111", "sk-abcdefghijklmnop", "\r\n", "\n", " ", "**token**: value"];
  for (let i = 0; i < 5000; i++) {
    const text = words[next() % words.length] + words[next() % words.length];
    const primary = scanSecretText(text, { mode: "turn" });
    const expected = !primary.exhausted && !primary.detected && redactSecretsForSink(primary.text) === text;
    expect(cleanUnit(text), text).toBe(expected);
  }
});

it("B3 no scanner bypass and exact aggregate component charges", () => {
  for (const path of ["server/redact.ts", "server/redact-stream-release.ts", "server/redact-turn.ts"]) expect(readFileSync(path, "utf8")).not.toMatch(/\bscanSecretText\s*\(/);
  const input = "token:" + " ".repeat(100) + "token\n";
  expect(scanSecretText(input, { mode: "turn" }).workUnits).toBe(884);
  // 884 primary units, one 112-unit compatibility dispatch, one 112-unit
  // KEY_VALUE native pass. No matches means no span/edit merge charges.
  expect(checkTurnUnit(input).workUnits).toBe(1108);
  const card = "4111 1111 1111 1111", primary = scanSecretText(card, { mode: "turn" });
  // Four digit groups produce four tracked edits and four merge entries.
  expect(checkTurnUnit(card).workUnits).toBe(primary.workUnits + card.length * 2 + 4 + 16);
});
