import { describe, expect, it } from "vitest";
import { createTurnTextPolicy, type ManifestBatch, type TurnAdmission } from "./redact-turn.ts";

const D = "dXNlcjpwYXNz";
function fixture() {
  const policy = createTurnTextPolicy(), cap = {} as TurnAdmission;
  policy.admit(cap);
  const feed = (text: string, stream = "a:assistant", mode: "delta" | "snapshot" | "whole" = "delta") => policy.consume(cap, {
    envelope: { eventId: "fixture", instanceId: "fixture", threadId: "fixture", generation: 1, intakeOrdinal: 1, createdAt: 0 },
    variant: "M15", carriers: [{ path: "text", text, stream, mode }], controls: {},
  } satisfies ManifestBatch);
  return { policy, cap, feed };
}
const shown = (r: ReturnType<ReturnType<typeof fixture>["feed"]>) => r.operations.map(o => o.text).join("");

describe("r3.1 policy regressions", () => {
  for (const [name, head, value] of [
    ["R1", "Authorization bauthorization Basic\n", D],
    ["R2e", "Authorization%3A%20BAuthorization%3A%20Basic\n", D],
    ["R3e", "Authorization%3A%20bauthorization%3A\nBasic ", D.slice(0, 8)],
    ["R5a", "Bearer\n", D], ["R5b", "password=\n", "hunter22"],
    ["R5c", "token\n= ", "hunter22abc"],
    ["R5d", `SG.${"a".repeat(22)}.\n`, "b".repeat(43)],
    ["R6c", "Authorization%3A%20Basic\n", D],
    ["R6d", "Authorization:\n\nBasic ", D.slice(0, 8)],
  ]) it(`${name} every within-item split`, () => {
    const input = head + value + "\n";
    for (let cut = 0; cut <= input.length; cut++) {
      const f = fixture();
      expect(shown(f.feed("Hello there.\n", "control:assistant", "snapshot"))).toBe("Hello there.\n");
      const results = [f.feed(input.slice(0, cut)), f.feed(input.slice(cut)), f.policy.finish(f.cap, "complete")];
      expect(results.some(r => r.masked), `split ${cut}`).toBe(true);
      expect(results.map(shown).join(""), `split ${cut}`).not.toContain(value);
    }
  });
  it("T41-ITEM-SERIAL: later items wait for completion", () => {
    const f = fixture();
    f.feed("first", "a:assistant");
    expect(shown(f.feed("second\n", "b:assistant"))).toBe("");
    expect(shown(f.feed("first", "a:assistant", "snapshot"))).toBe("first");
    expect(shown(f.feed("", "b:assistant"))).toBe("\nsecond\n");
  });
  it("osec2-H4: interleaved context cannot release payload", () => {
    const f = fixture();
    f.feed("Bearer\n", "a:assistant");
    expect(shown(f.feed(D + "\n", "b:assistant"))).toBe("");
    f.feed("Bearer\n", "a:assistant", "snapshot");
    const r = f.feed("", "b:assistant");
    expect(r.masked).toBe(true); expect(shown(r)).not.toContain(D);
  });
  it("osec2-H2: post-completion delta starts another item", () => {
    const f = fixture();
    expect(shown(f.feed("sk-abcdefgh", "a:assistant", "snapshot"))).toBe("sk-abcdefgh");
    expect(shown(f.feed("ijklmnop\n"))).toBe("\nijklmnop\n");
  });
  it("R4b: completed Basic head carries into the next item", () => {
    const f = fixture();
    expect(shown(f.feed("x Authorization Basic\n", "a:assistant", "snapshot"))).toBe("x Authorization Basic\n");
    const r = f.feed(D + "\n");
    expect(r.masked).toBe(true); expect(shown(r)).not.toContain(D);
    expect(r.operations.every(o => o.op !== "replace")).toBe(true);
  });
  it("T40-U6-SHAPE1: release at the internal word boundary", () => {
    const f = fixture();
    expect(shown(f.feed("See the Authorization:\n"))).toBe("");
    expect(shown(f.feed("The"))).toBe("");
    expect(shown(f.feed(" he"))).toBe("See the Authorization:\n");
  });
  it("T40-WHOLE-UNIT: whole values retain continuity", () => {
    const f = fixture();
    expect(shown(f.feed("Bearer\n", "field:path", "whole"))).toBe("Bearer\n");
    const r = f.feed(D, "field:path", "whole");
    expect(r.masked).toBe(true); expect(shown(r)).not.toContain(D);
  });
  it("T41-SG-BOUNDARY: LF and non-LF completions carry identical context", () => {
    for (const end of ["", "\n"]) for (const count of [42, 43]) {
      const f = fixture(), head = `SG.${"a".repeat(22)}.${end}`;
      expect(shown(f.feed(head, "a:assistant", "snapshot"))).toBe(head);
      const r = f.feed("b".repeat(count), "b:assistant", "snapshot");
      expect(r.masked).toBe(count === 43);
      if (count === 43) expect(shown(r)).not.toContain("bbbb");
    }
  });
});

import { checkTurnUnit, A2_STREAM, A2_WHOLE, ScanLimit, ScanMeter, joinItems, rowChainStep, LOST, traceItemBoundaries } from "./redact-stream-release.ts";
import { scanTurnText } from "./redact.ts";
import { SECRET_SCAN_BUDGET } from "../shared/md-secret-label.mjs";

function multi(carriers: ManifestBatch["carriers"]): ManifestBatch {
  return { envelope: { eventId: "f", instanceId: "f", threadId: "f", generation: 1, intakeOrdinal: 1, createdAt: 0 }, variant: "M15", carriers, controls: {} };
}
function policyWith(options = {}) {
  const policy = createTurnTextPolicy(options), cap = {} as TurnAdmission; policy.admit(cap);
  return { policy, cap, feed: (text: string, stream = "a:assistant", mode: "delta" | "snapshot" | "whole" = "delta") => policy.consume(cap, multi([{ text, stream, mode, path: "text" }])) };
}

describe("stream scheduling, limits and completion", () => {
  it("T41-COMPLETION-COST / T40-COST admitted shapes", () => {
    for (const [name, input, mode] of [
      ["65500-z snapshot", "z".repeat(65_500), "snapshot"],
      ["10000 LF", "x\n".repeat(10_000), "delta"],
      ["blank-line guard", ("token\n" + " \n".repeat(125) + "x\n").repeat(254), "delta"],
      ["884/112", ("token:" + " ".repeat(100) + "token\n").repeat(586).slice(0, 65_536), "delta"],
    ] as const) {
      const f = policyWith(), r = f.feed(input, "a:assistant", mode), stats = f.policy.stats();
      expect(r.masked, name).toBe(false); expect(stats.a2Deferred, name).toBe(0);
      expect(stats.a2Work, name).toBeLessThanOrEqual(A2_STREAM);
      expect(stats.a2Decisions, name).toBeLessThanOrEqual(name === "10000 LF" ? 17 : 29);
      const tail = f.policy.finish(f.cap, "complete");
      expect(tail.masked, name).toBe(false); expect(shown(r) + shown(tail), name).toBe(input);
    }
    const f = policyWith(), input = "hello ".repeat(682) + "xxxx";
    expect(input.length).toBe(4096);
    const r = f.policy.consume(f.cap, multi(Array.from({ length: 16 }, () => ({ text: input, stream: "field:path", mode: "whole", path: "field" }))));
    expect(r.masked).toBe(false); expect(shown(r)).toBe(input.repeat(16));
    expect(f.policy.stats().a2WholeWork).toBeLessThanOrEqual(A2_WHOLE);
    const g = policyWith();
    const head = "token" + " ".repeat(65_531), prose = "ordinary prose.\n".repeat(6400);
    expect(shown(g.feed(head, "a:assistant", "snapshot"))).toBe(head);
    const second = g.feed(prose, "b:assistant"); expect(second.masked).toBe(false);
    expect(g.policy.stats().a2Decisions).toBeLessThanOrEqual(4);
    expect(shown(second) + shown(g.policy.finish(g.cap, "complete"))).toBe("\n" + prose);
  });
  it("T41-ITEM-BOUNDARY-FIN interleaves all 120 splits", () => {
    const A = "4111 1111", B = " 1111 1111\n";
    for (let a = 0; a <= A.length; a++) for (let b = 0; b <= B.length; b++) {
      const f = fixture(); f.feed("Hello there.\n", "control:assistant", "snapshot");
      let out = shown(f.feed(A.slice(0, a)));
      expect(shown(f.feed(B.slice(0, b), "b:assistant"))).toBe("");
      out += shown(f.feed(A.slice(a)));
      expect(shown(f.feed(B.slice(b), "b:assistant"))).toBe("");
      out += shown(f.feed(A, "a:assistant", "snapshot"));
      out += shown(f.policy.finish(f.cap, "complete"));
      expect(out).toBe(joinItems(A, B));
    }
  });
  it("T41-DEFER holds and resumes without latching; FC2 at finish", () => {
    // A full real scan fits this allowance; four checks of this unit do not.
    // Subsequent consume carries a small release which drains within a bound.
    const input = "ordinary prose.\n".repeat(100), cost = checkTurnUnit(input).workUnits;
    const f = policyWith({ streamAllowance: cost * 3 });
    const r = f.feed(input); expect(r.masked).toBe(false);
    expect(f.policy.stats().a2Deferred).toBeGreaterThan(0);
    expect(f.policy.stats().pending).toBeGreaterThan(0);
    const tail = f.policy.finish(f.cap, "complete");
    expect(tail.exhausted).toBe(true); expect(shown(tail)).toBe("«redacted»");
    // Inject the scanner's legal worst-case cap on the first consume only.
    let expensive = true;
    const g = policyWith({ scan: (s: string, o: { mode: "turn"; budget: number }) => {
      const r = scanTurnText(s, o);
      return expensive ? { ...r, workUnits: o.budget, exhausted: o.budget < SECRET_SCAN_BUDGET } : r;
    } });
    const long = "x\n".repeat(1000);
    const first = g.feed(long); expect(first.masked).toBe(false); expect(g.policy.stats().a2Deferred).toBeGreaterThan(0);
    expensive = false;
    const resumed = g.feed(""); expect(resumed.masked).toBe(false); expect(g.policy.stats().a2Deferred).toBe(0);
    expect(shown(first) + shown(resumed) + shown(g.policy.finish(g.cap, "complete"))).toBe(long);
  });
  it("T40-BUDGET named FC1, FC-SCAN, FC3, ctx LOST", () => {
    const f = fixture(); expect(f.feed("token\n".repeat(11_000)).masked).toBe(true);
    const g = policyWith({ wholeAllowance: 1 }); expect(g.feed("ordinary prose", "field:x", "whole").exhausted).toBe(true);
    const h = policyWith({ contexts: { assistant: LOST } }); expect(h.feed("hello\n").masked).toBe(true);
    const m = new ScanMeter(); expect(() => m.check("z".repeat(200_000))).toThrow(new ScanLimit("FC-SCAN"));
  });
  it("odes3-M2 and osec2-H3: cumulative proof never forgets pending history", () => {
    const f = fixture(); f.feed("unfinished"); expect(f.feed("replacement", "a:assistant", "snapshot").masked).toBe(true);
    const g = fixture();
    for (let i = 0; i < 80; i++) expect(g.feed("x".repeat(1023) + "\n").masked).toBe(false);
    g.feed("unfinished"); expect(g.feed("replacement", "a:assistant", "snapshot").masked).toBe(true);
  });
  it("T40-RESET/STOP/EXIT and T40-U6-SHAPE2", () => {
    const f = fixture(); f.feed("Bearer\n"); expect(f.policy.reset(f.cap, "a:assistant").masked).toBe(true);
    const g = fixture(); g.feed("Bearer\n"); expect(shown(g.policy.finish(g.cap, "cancel"))).toBe(""); expect(g.feed(D).masked).toBe(true);
    const h = fixture(); h.feed("plain final line"); expect(shown(h.policy.finish(h.cap, "exit"))).toBe("plain final line");
    const j = fixture(); expect(shown(j.feed("You will need a token\n"))).toBe("");
    expect(shown(j.feed("Then run"))).toBe("You will need a token\n");
  });
});

function rng(seed: number) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }
const familyPairs = [
  ["Bearer", D], ["Authorization%3A%20Basic", D], ["password=", "hunter22"], ["token", "= hunter22abc"],
  ["SG." + "a".repeat(22) + ".", "b".repeat(43)], ["-----BEGIN PRIVATE KEY-----", "PRIVATEBODY"],
  ["hello", "ordinary prose"], ["4111 1111", " 1111 1111"], ["sk-abcdefgh", "ijklmnop"],
] as const;

describe("target oracles", () => {
  it("T41-COMPLETION-INVARIANT / T40-STREAM-ORACLE 20000 sequences", () => {
    const next = rng(0x41a319);
    for (let i = 0; i < 20_000; i++) {
      const pair = familyPairs[next() % familyPairs.length], endings = ["", "\n", "\r", "\r\n", " \n", "\n\n"];
      const parts: string[] = [pair[0] + endings[next() % endings.length], pair[1] + endings[next() % endings.length]];
      if (next() % 2) parts.unshift("Hello there.\n");
      if (next() % 2) parts.push("Done.\n");
      const target = parts.reduce((a, b) => joinItems(a, b), ""), oracle = checkTurnUnit(target);
      const f = fixture(); let visible = "", masked = false;
      for (let k = 0; k < parts.length; k++) {
        const item = parts[k], key = `${k}:assistant`, cut = next() % (item.length + 1);
        for (const chunk of [item.slice(0, cut), item.slice(cut)]) {
          const r = f.feed(chunk, key);
          if (r.masked) { masked = true; continue; }
          const appended = shown(r);
          if (appended) {
            const end = visible.length + appended.length;
            expect(oracle.spans?.some(s => s.from < end && s.to > visible.length), JSON.stringify(parts)).toBe(false);
          }
          visible += appended;
          expect(target.startsWith(visible), JSON.stringify(parts)).toBe(true);
          expect(r.operations.every(o => o.op === "append")).toBe(true);
        }
        const r = f.feed(item, key, "snapshot");
        if (r.masked) masked = true;
        else { visible += shown(r); expect(target.startsWith(visible), JSON.stringify(parts)).toBe(true); }
      }
      const r = f.policy.finish(f.cap, "complete"); if (!r.masked) visible += shown(r);
      // Known full payloads cannot be released by a completion if their
      // context makes them protected, even if the head was already visible.
      const payloadAt = target.indexOf(pair[1]);
      for (const span of oracle.spans ?? []) {
        const start = Math.max(payloadAt, span.from), end = Math.min(payloadAt + pair[1].length, span.to);
        if (start < end) expect(visible.length, JSON.stringify(parts)).toBeLessThanOrEqual(start);
      }
      if (!oracle.detected && !masked) expect(visible).toBe(target);
    }
  }, 120_000);
  it("T41-ROW-STREAM-AGREE / T41-CTX-CARRY 5000 sequences", () => {
    const next = rng(0x4a112);
    for (let i = 0; i < 5000; i++) {
      const [left, right] = familyPairs[next() % familyPairs.length];
      // Only an independently clean item can distinguish a context-caused
      // latch from an ordinary local detector latch.
      if (checkTurnUnit(left).detected || checkTurnUnit(right).detected) continue;
      const f = fixture(), first = f.feed(left, "a:assistant", "snapshot");
      expect(first.masked).toBe(false);
      const second = f.feed(right, "b:assistant", "snapshot"), row = rowChainStep(left, right);
      expect(second.masked, JSON.stringify([left, right])).toBe(row.mask);
    }
  }, 120_000);
  it("T40-CONC admissions and target kinds stay independent", () => {
    const f = fixture(), other = {} as TurnAdmission; f.policy.admit(other);
    f.feed("Bearer\n");
    expect(shown(f.feed("clean\n", "r:reasoning"))).toBe("clean\n");
    expect(shown(f.policy.consume(other, multi([{ path: "text", stream: "a:assistant", mode: "delta", text: "other clean\n" }])))).toBe("other clean\n");
  });
});

it("T41-CTX-LOST stores loss rather than retaining an oversized open tail", () => {
  const f = fixture(), head = "token" + " ".repeat(70_000);
  expect(f.feed(head, "a:assistant", "snapshot").masked).toBe(false);
  expect(f.feed("ordinary prose.\n", "b:assistant").masked).toBe(true);
});
it("R8 keeps the partial line held until completion", () => {
  const input = "Authorization: Basic dXNl\n cjpw";
  for (let cut = 0; cut <= input.length; cut++) {
    const f = fixture(), results = [f.feed(input.slice(0, cut)), f.feed(input.slice(cut)), f.policy.finish(f.cap, "complete")];
    expect(results.map(shown).join("")).not.toContain("dXNl");
    expect(results.map(shown).join("")).not.toContain("cjpw");
  }
});

it("T41-ONE-SEPARATOR 5000 traced stream, row and scanner sequences", () => {
  const next = rng(0x513181);
  for (let i = 0; i < 5000; i++) {
    const left = ["token", "Bearer", "hello", "hello\r", "hello\n", "hello\r\n", "hello \n", "hello\n\n"][next() % 8];
    const right = ["ordinary prose.\n", "The header goes here.\n", "x\n"][next() % 3];
    const traced: string[] = [], scans: string[] = [];
    traceItemBoundaries(text => traced.push(text), () => {
      const scan = (s: string, o: { mode: "turn"; budget: number }) => { scans.push(s); return scanTurnText(s, o); };
      const f = policyWith({ scan });
      const a = f.feed(left, "a:assistant", "snapshot"), b = f.feed(right, "b:assistant", "snapshot");
      expect(a.masked || b.masked).toBe(false);
      expect(shown(a) + shown(b)).toBe(joinItems(left, right));
      expect(rowChainStep(left, right, new ScanMeter(A2_STREAM, scan)).mask).toBe(false);
      const boundary = joinItems(left, "");
      for (const checked of scans) if (checked.startsWith(boundary) && checked.length > boundary.length) expect(traced).toContain(checked);
    });
  }
}, 120_000);

it("T40-COST running maximum survives a smaller cap-guard decision", () => {
  const trace: { size: number; runningMax: number }[] = [];
  const f = policyWith({ traceDecision: (event: { size: number; runningMax: number }) => trace.push(event) });
  const text = "x".repeat(65_000) + "\n" + "x\n" + "y".repeat(65_535) + "\n" + "z\n";
  expect(f.feed(text).masked).toBe(false);
  let max = 0;
  for (const entry of trace) { max = Math.max(max, entry.size); expect(entry.runningMax).toBe(max); }
  expect(trace.some((event, i) => i > 0 && event.size < trace[i - 1].size)).toBe(true);
});

it("R1 / R6c P_BASIC preserves NAME across separate LF decisions", () => {
  for (const name of ["Authorization", "Authorization%3A%20", "Authorization bauthorization"]) {
    const f = fixture();
    const first = f.feed(name + "\n"), second = f.feed("Basic\n"), last = f.feed(D + "\n");
    expect(shown(first)).toBe(""); expect(shown(second)).toBe("");
    expect(last.masked).toBe(true); expect(shown(last)).not.toContain(D);
  }
});

it("T40-PRESERVE Fable H1 seven pairs within and across items at every split", () => {
  const pairs = [
    ["token=abc", "defgh\n"], ["Bearer abcdefghijk", "l"], ["sk-" + "a".repeat(15), "x"],
    ["SG." + "a".repeat(22) + "." + "b".repeat(42), "b"], ['token="abc', 'defgh"'],
    ["eyJabcdefgh.abcdefgh.abc", "defgh"], ["AKIA" + "A".repeat(10), "A".repeat(6)],
  ];
  for (const [A, B] of pairs) {
    const joined = joinItems(A, B), input = A + B;
    expect(checkTurnUnit(input).detected).toBe(true);
    for (let cut = 0; cut <= input.length; cut++) {
      const f = fixture(), r = [f.feed(input.slice(0, cut)), f.feed(input.slice(cut)), f.policy.finish(f.cap, "complete")];
      expect(r.some(x => x.masked), input).toBe(true);
      expect(r.map(shown).join(""), input).not.toContain(input);
    }
    for (let cut = 0; cut <= B.length; cut++) {
      const f = fixture(), a = f.feed(A, "a:assistant", "snapshot");
      const r = [a, f.feed(B.slice(0, cut), "b:assistant"), f.feed(B.slice(cut), "b:assistant"), f.policy.finish(f.cap, "complete")];
      if (!checkTurnUnit(joined).detected) { expect(r.some(x => x.masked), joined).toBe(false); expect(r.map(shown).join("")).toBe(joined); }
    }
  }
});

it("T41-DEFER a sealed completion cannot absorb a later delta on its key", () => {
  const options = { streamAllowance: 1 }, f = policyWith(options);
  expect(f.feed("first", "a:assistant", "snapshot").masked).toBe(false);
  expect(f.feed("second\n", "a:assistant").masked).toBe(false);
  options.streamAllowance = A2_STREAM;
  const resumed = f.feed("");
  expect(resumed.masked).toBe(false);
  expect(shown(resumed) + shown(f.policy.finish(f.cap, "complete"))).toBe("first\nsecond\n");
});

it("T40-SNAPSHOT-REPLACE within an open item and T40-COMPLETE final tail", () => {
  const f = fixture(); expect(shown(f.feed("first\n"))).toBe("first\n");
  const r = f.feed("replacement", "a:assistant", "snapshot");
  expect(r.masked).toBe(false);
  expect(r.operations).toEqual([expect.objectContaining({ text: "replacement", op: "replace", speech: "none" })]);
  const g = fixture(); expect(shown(g.feed("final tail"))).toBe("");
  expect(shown(g.policy.finish(g.cap, "complete"))).toBe("final tail");
});

it("T41-CTX-CARRY restart seeds are resolved per admission and target", () => {
  const a = {} as TurnAdmission, b = {} as TurnAdmission;
  const options = { streamAllowance: A2_STREAM, contextFor: (cap: TurnAdmission, target: string) => cap === a && target === "assistant" ? "Bearer" : "" };
  const p = createTurnTextPolicy(options); p.admit(a); p.admit(b);
  const input = multi([{ text: D + "\n", stream: "a:assistant", path: "text", mode: "delta" }]);
  expect(p.consume(a, input).masked).toBe(true);
  expect(shown(p.consume(b, input))).toBe(D + "\n");
});

it("T41-DEFER resumes the failed unit instead of repeating completed HOLDs", () => {
  const f = policyWith({ scan: (text: string, options: { mode: "turn"; budget: number }) => {
    const result = scanTurnText(text, options);
    return { ...result, workUnits: options.budget, exhausted: options.budget < SECRET_SCAN_BUDGET };
  } });
  const input = "token\n".repeat(256);
  expect(f.feed(input).masked).toBe(false); expect(f.policy.stats().a2Deferred).toBe(1);
  expect(f.feed("").masked).toBe(false); expect(f.policy.stats().a2Deferred).toBe(0);
  expect(shown(f.policy.finish(f.cap, "complete"))).toBe(input);
});

it("T41-DEFER queues later eligible targets while intake continues", () => {
  const f = policyWith({ scan: (text: string, options: { mode: "turn"; budget: number }) => {
    const result = scanTurnText(text, options);
    return { ...result, workUnits: options.budget, exhausted: options.budget < SECRET_SCAN_BUDGET };
  } });
  const first = f.policy.consume(f.cap, multi([
    { text: "token\n".repeat(256), stream: "a:assistant", mode: "delta", path: "text" },
    { text: "plain\n", stream: "r:reasoning", mode: "delta", path: "reasoning" },
  ]));
  expect(first.masked).toBe(false); expect(shown(first)).toBe("");
  const resumed = f.feed(""); expect(resumed.masked).toBe(false);
  expect(shown(resumed)).toBe("plain\n");
});
