import { describe, it, expect, vi } from "vitest";
import * as labels from "../shared/md-secret-label.mjs";
import { redactSecretsForSink, redactSecretsInText } from "./redact.ts";
// @ts-expect-error Shared executable fixture intentionally needs no runtime dependency.
import { MD_SECRET_CASES, PLAIN_CASES, TYPE_WORDS, L7_CASES } from "../shared/testdata/md-secret-label-cases.mjs";
import type { ManifestBatch, TurnAdmission, TurnTextPolicy, PolicyDecision } from "./redact-turn.ts";
// Base adapter runs the actual per-field machine sink: assertion REDs, no absent-import REDs.
const baseline = () => ({ admit() {}, retire() {}, stats: () => ({ clean: 0, streams: 0, pending: 0, units: 0 }),
  consume(_a: unknown, b: ManifestBatch) { return { masked: false, exhausted: false, operations: b.carriers.map(c => ({ ...c, text: redactSecretsForSink(c.text), regionId: c.stream, revision: 1, op: "append", speech: "append" })) }; },
  reset: () => ({ masked: false, exhausted: false, operations: [] }), finish: () => ({ masked: false, exhausted: false, operations: [] }),
});
const mod = process.env.L5A_BASELINE === "1" ? { createTurnTextPolicy: baseline } : await import("./" + "redact-turn.ts");
const make = (options = {}): TurnTextPolicy & { stats(): { clean: number; streams: number; pending: number; units: number } } => mod.createTurnTextPolicy(options);
const cap = () => Object.freeze({}) as TurnAdmission;
let ordinal = 0;
function batch(s: string, stream = "assistant", mode: "delta" | "whole" | "snapshot" = "delta"): ManifestBatch {
  return { envelope: { eventId: `e${++ordinal}`, instanceId: "i", threadId: "t", generation: 1, intakeOrdinal: ordinal, createdAt: 0 }, variant: "M15", carriers: [{ path: "delta", stream, mode, text: s }], controls: {} };
}
const text = (d: PolicyDecision) => d.operations.map(o => o.text).join("");
function fresh(options = {}) { const p = make(options), a = cap(); p.admit(a); return { p, a }; }
const scan = (s: string, options = {}) => {
  const fn = (labels as unknown as { scanSecretText?: (s: string, o: object) => { text: string; exhausted: boolean; detected: boolean; workUnits: number; candidates: unknown[] } }).scanSecretText;
  return fn && process.env.L5A_BASELINE !== "1" ? fn(s, options) : { text: redactSecretsForSink(s), exhausted: false, detected: false, workUnits: 0, candidates: [] };
};
describe("redact-turn", () => {
  it("redact-turn.every-split", () => {
    for (const row of MD_SECRET_CASES.filter((r: { sourceIndex: number }) => r.sourceIndex <= 39)) for (let cut = 0; cut <= row.input.length; cut++) {
      const { p, a } = fresh();
      for (const part of [row.input.slice(0, cut), row.input.slice(cut)]) { const out = text(p.consume(a, batch(part))); for (const sentinel of row.sentinels) expect(out, `${row.id}/${cut}`).not.toContain(sentinel); }
      expect(p.finish(a, "complete").masked, `${row.id}/${cut}`).toBe(true);
    }
  });
  it("redact-turn.one-unit-chunks", () => { const { p, a } = fresh(); for (const c of "**password**:" + "S".repeat(650)) expect(text(p.consume(a, batch(c)))).not.toContain("S"); expect(p.finish(a, "complete").masked).toBe(true); });
  it("redact-turn.empty-label-immediate", () => { const { p, a } = fresh(); expect(p.consume(a, batch("**password**:")).masked).toBe(true); });
  for (const target of ["assistant", "tool"]) it(`redact-turn.reasoning-then-${target}`, () => { const { p, a } = fresh(); p.consume(a, batch("**password**:", "reasoning")); expect(text(p.consume(a, batch("hunter2", target, "whole")))).not.toContain("hunter2"); });
  it("redact-turn.cr-equivalence", () => {
    for (const s of ["*\rthe token: alpha beta", "**password**:\r\nhunter2", "**password**:\r\rhunter2", "api_\rkey: value"]) for (let cut = 0; cut <= s.length; cut++) {
      const { p, a } = fresh(); expect(text(p.consume(a, batch(s.slice(0, cut))))).not.toContain("hunter2"); p.consume(a, batch(s.slice(cut))); expect(p.finish(a, "complete").masked).toBe(scan(s, { mode: "turn" }).detected);
    }
    const { p, a } = fresh(); expect(text(p.consume(a, batch("clean\r")))).toBe("");
  });
  it("redact-turn.monotonic-all-carriers", () => {
    const { p, a } = fresh(), b = cap(); p.admit(b); p.consume(a, batch("**token**:", "reasoning"));
    for (let n = 1; n <= 29; n++) expect(text(p.consume(a, { ...batch("SENTINEL", `s${n}`, "whole"), variant: `M${String(n).padStart(2, "0")}` }))).not.toContain("SENTINEL");
    expect(text(p.consume(b, batch("clean\n")))).toBe("clean\n");
  });
  it("redact-turn.event-atomic", () => {
    const { p, a } = fresh(); p.consume(a, batch("pending", "third")); const b = batch("earlier sibling", "first", "whole");
    const d = p.consume(a, { ...b, carriers: [...b.carriers, ...batch("**password**: secret", "second", "whole").carriers] });
    expect(text(d)).not.toContain("earlier sibling"); expect(text(d)).not.toContain("pending");
  });
  it("redact-turn.reset-unfinished", () => {
    const { p, a } = fresh(); p.consume(a, batch("**pass")); expect(p.reset(a, "assistant").masked).toBe(true); expect(text(p.consume(a, batch("hunter2\n")))).not.toContain("hunter2");
    const f = fresh(); f.p.consume(f.a, batch("clean\n")); expect(f.p.reset(f.a, "assistant").masked).toBe(false);
  });
  for (const how of ["cancel", "exit"] as const) it(`redact-turn.${how === "cancel" ? "cancel-pending" : "session-exit"}`, () => {
    const { p, a } = fresh(); p.consume(a, batch("**pass")); const d = p.finish(a, how); if (how === "cancel") expect(text(d)).toBe("");
    expect(text(p.consume(a, batch("hunter2\n")))).not.toContain("hunter2"); expect(p.stats().clean).toBe(0);
  });
  for (const name of ["late-old-generation", "provider-replaced", "restart"]) it(`redact-turn.${name}`, () => {
    const { p, a } = fresh(); p.retire(a); const other = name === "restart" ? make() : p, b = cap(); other.admit(b);
    expect(text(other.consume(a, batch("old secret\n")))).not.toContain("old secret"); expect(text(other.consume(b, batch("new clean\n")))).toBe("new clean\n");
  });
  it("redact-turn.snapshot-no-restore", () => {
    const { p, a } = fresh(); p.consume(a, batch("clean\n")); expect(text(p.consume(a, batch("clean\n", "assistant", "snapshot")))).toBe("");
    const changed = p.consume(a, batch("replacement", "assistant", "snapshot")); expect(changed.operations[0]?.speech).toBe("append"); expect(changed.operations[0]?.op).toBe("append"); expect(text(changed)).toBe("replacement"); // r3.1 §3.5: a new item after completion.
    p.consume(a, batch("**password**:")); expect(text(p.consume(a, batch("replacement hunter2", "assistant", "snapshot")))).not.toContain("hunter2");
  });
  // cause22-E (b), MAIN-RULING 2026-11-22T17:47:36Z: "The audience display budgets ... are size cuts on shown text: remove them".
  // These three rows pinned the 64 KiB pending cut, the 256 live-turn cut and the 64 open-stream cut; each now pins that the
  // same input is NOT masked: an unfinished line past 64 KiB stays pending (held, never released on size) and is shown at its end.
  it("redact-turn.pending-64ki", () => {
    for (const n of [65535, 65536, 65537]) { const { p, a } = fresh(); expect(p.consume(a, batch("x".repeat(n))).masked).toBe(false); expect(p.stats().pending).toBe(n); expect(text(p.finish(a, "complete"))).toBe("x".repeat(n)); }
    const { p, a } = fresh(); p.consume(a, batch("x".repeat(40000))); expect(p.consume(a, batch("y".repeat(25537), "tool")).masked).toBe(false); expect(p.stats().pending).toBe(65537);
  });
  it("redact-turn.clean-256", () => { const p = make(), all = Array.from({ length: 257 }, cap); all.forEach(a => p.admit(a)); expect(p.stats().clean).toBe(257); const d = p.consume(all[256], batch("the 257th live turn\n")); expect(d.masked).toBe(false); expect(text(d)).toBe("the 257th live turn\n"); });
  it("redact-turn.streams-64-global4096", () => {
    const { p, a } = fresh(); for (let i = 0; i < 65; i++) expect(p.consume(a, batch("", `s${i}`)).masked).toBe(false); expect(p.stats().streams).toBe(65);
    const q = make(); for (let i = 0; i < 64; i++) { const c = cap(); q.admit(c); for (let j = 0; j < 64; j++) q.consume(c, batch("", `s${j}`)); }
    // 1.0.20 redact-acp (owner rule): a full process table no longer masks the next turn. Every entry here is an open
    // text item (never let go), so the one new carrier is withheld alone and the table stays at its limit.
    expect(q.stats().streams).toBe(4096); const c = cap(); q.admit(c); const over = q.consume(c, batch("", "overflow"));
    expect(over.masked).toBe(false); expect(over.operations.map(o => o.op)).toEqual(["omit"]); expect(text(over)).toBe("«redacted»"); expect(q.stats().streams).toBe(4096);
  });
  it("redact-turn.empty-id-flood", () => { const { p, a } = fresh(); for (let i = 0; i < 5000; i++) p.consume(a, batch("", "")); expect(p.stats().streams).toBe(1); });
  it("redact-turn.no-tombstones", () => { const p = make(); for (let i = 0; i < 10000; i++) p.consume(cap(), batch("secret")); expect(p.stats()).toMatchObject({ clean: 0, streams: 0, pending: 0 }); });
  // cause22-E (b) (same ruling): a 256 KiB + 1 field was the scalar cut; it is now scanned (work per character) and shown whole.
  it("redact-turn.huge-scalar", () => { const { p, a } = fresh(); const d = p.consume(a, batch("x".repeat(262145), "x", "whole")); expect(d.exhausted).toBe(false); expect(d.masked).toBe(false); expect(text(d)).toBe("x".repeat(262145)); });
  // Arbitrary map/depth/node extraction is 1B's job; F2 must never traverse unrelated data.
  for (const name of ["wide-object", "depth-nodes", "budget-no-second-walk"]) it(`redact-turn.${name}`, () => {
    const { p, a } = fresh(), b = batch("x".repeat(262145), "x", "whole"), getter = vi.fn(() => { throw new Error("must not inspect"); }); Object.defineProperty(b, "unknown", { get: getter }); const d = p.consume(a, b); expect(d.exhausted).toBe(false); expect(text(d)).toBe("x".repeat(262145)); expect(getter).not.toHaveBeenCalled(); // cause22-E (b): the text is no longer cut for size; the walk guarantee (no unrelated read) is unchanged
  });
  // cause22-E (b), MAIN-RULING 17:47:36Z SAFETY FLOOR: "If a chunk cannot be redacted, that chunk alone is withheld with a plain marker,
  // never the whole turn." The field the scanner failed on still reads «redacted» (nothing unscanned shows); the turn is no longer ended.
  it("redact-turn.detector-failure", () => { const { p, a } = fresh({ scan: () => { throw new Error("SECRET"); } }); const d = p.consume(a, batch("innocent", "x", "whole")); expect(d.exhausted).toBe(false); expect(d.masked).toBe(false); expect(d.withheld).toBe(true); expect(text(d)).toBe("«redacted»"); expect(p.stats().clean).toBe(1); });
  it("redact-turn.plain-colon-numeric-password", () => {
    for (const row of PLAIN_CASES) expect(scan(row.input).text, row.id).toBe(row.output);
    for (const s of ["password: hunter2 and more", "tokens: 1200", "token:", "foopassword: x", "password = x"]) expect(scan(s).text).toBe(s);
    expect(scan("password: 1234\nclean").text).toBe("password: «redacted 4 chars»\nclean");
    for (const t of TYPE_WORDS) { expect(scan(`\`token\`: ${t}\nmore`).detected).toBe(true); expect(scan(`\`token\`: ${t}`, { mode: "turn" }).detected).toBe(true); }
  });
  it("redact-turn.candidate-original-offsets", () => { const r = scan("prefix **password**: value\nTAIL"); expect(r.detected).toBe(true); expect(r.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ sepEnd: 20, wrapped: true })])); });
});

describe("historical shared candidates", () => {
  it("redact-turn.provider-complete-spans", () => {
    for (const row of L7_CASES) for (const cr of [false, true]) {
      const input = cr ? row.input.replaceAll("\n", "\r\n") : row.input;
      const out = scan(input).text;
      if (row.user) expect(out, row.id).toBe(cr ? row.user.replaceAll("\n", "\r\n") : row.user);
      else for (const sentinel of row.secrets) expect(out, row.id).not.toContain(sentinel);
    }
  });
  it("golden.move-equality.shared-candidates", () => {
    expect(MD_SECRET_CASES.map((r: { sourceIndex: number }) => r.sourceIndex)).toEqual(Array.from({ length: 49 }, (_, i) => i + 1));
    for (const row of MD_SECRET_CASES) {
      expect(redactSecretsInText(row.input), `${row.id} revised standalone policy`).toBe(row.expected.user);
      expect(redactSecretsInText(scan(row.input).text), `${row.id} final`).toBe(row.expected.user);
    }
  });
  it("redact-turn.machine-and-speech-budget-guard", () => {
    expect(labels.maskSecretLabelsToEnd("x".repeat(1048577), () => "mask")).toBe("«redacted»");
    expect(() => labels.findSecretLabels("x".repeat(1048577))).toThrow();
  });
  it("redact-turn.candidate-bounds-and-idempotence", () => {
    for (const row of MD_SECRET_CASES) { const r = scan(row.input); expect(scan(r.text).text, row.id).toBe(r.text); }
    for (const n of [1048575, 1048576, 1048577]) expect(scan("x".repeat(n)).exhausted).toBe(true);
    for (const marker of ["«redacted»", "«redacted 8 chars»", "«redacted private key»", "«redacted provider credentials»"]) {
      expect(scan(`**password**: ${marker}`).text).toBe(`**password**: ${marker}`);
      expect(scan(`**password**: ${marker}TAIL`).text).not.toContain("TAIL");
    }
  });
});

it("redact-turn.snapshot-unfinished-history", () => {
  const { p, a } = fresh(); p.consume(a, batch("**pass"));
  expect(p.consume(a, batch("replacement", "assistant", "snapshot")).masked).toBe(true);
});
it("redact-turn.accessor-carrier-fails-closed", () => {
  const { p, a } = fresh(), b = batch("clean"), getter = vi.fn(() => "SECRET");
  Object.defineProperty(b.carriers[0], "text", { get: getter });
  expect(p.consume(a, b).exhausted).toBe(true); expect(getter).not.toHaveBeenCalled();
});

it("redact-turn.historical-machine-registry", () => {
  for (const row of L7_CASES) {
    const out = scan(row.input, { mode: "machine" }).text;
    for (const sentinel of row.secrets) expect(out, row.id).not.toContain(sentinel);
  }
});
it("redact-turn.invalid-budget", () => {
  for (const budget of [NaN, Infinity, -1]) expect(scan("clean", { budget }).exhausted).toBe(true);
});
it("redact-turn.every-label-and-wrap", () => {
  for (const name of ["api key", "api_key", "api-key", "apikey", "secret", "token", "password", "passwd", "authorization", "auth token", "auth_token", "auth-token", "access key", "access_key", "access-key", "private key", "private_key", "private-key"]) {
    for (const [left, right] of [["**", "**"], ["`", "`"], ["_", "_"], ["+ ", ""], ["> ", ""], ["  ", ""], ["~~", "~~"]]) {
      const input = `${left}${name}${right}: SENTINEL`;
      for (let at = 0; at <= input.length; at++) {
        const { p, a } = fresh(); p.consume(a, batch(input.slice(0, at))); expect(text(p.consume(a, batch(input.slice(at))))).not.toContain("SENTINEL"); expect(p.finish(a, "complete").masked).toBe(true);
      }
    }
  }
});
it("redact-turn.internal-whitespace-equivalence", () => {
  for (const line of ["**api  key**: value", "**api\tkey**: value", "**auth \ttoken**: value", "**private\t key**: value", "**password**" + "\t ".repeat(300) + ": value"]) {
    const expected = labels.findSecretLabels(line).some(l => l.wrapped);
    for (let split = 0; split <= line.length; split++) {
      const state = labels.createLabelStream();
      const hit = labels.scanLabelDelta(state, line.slice(0, split)) >= 0 || labels.scanLabelDelta(state, line.slice(split)) >= 0;
      expect(hit, `${JSON.stringify(line)} / ${split}`).toBe(expected);
    }
  }
});
it("redact-turn.region-restart-identity", () => {
  const first = fresh(), restarted = fresh(), input = batch("clean\n");
  const before = first.p.consume(first.a, input).operations[0].regionId;
  const after = restarted.p.consume(restarted.a, input).operations[0].regionId;
  expect(after).not.toBe(before);
});
