// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r15.1 GATE tests for Grok's S1 ALLOWLIST and S2 REVOKE VOIDS (MurageMain 18:01Z), plus L3's worker-commit FLAG.
// Every case is asserted in work units through the r14 surface's dispatch (the turn from IX:12707 on).
//   S1: a pending lineage_dirty row other than m|t|U or s|message:t:X (X = U or the previous bot reply) makes the send INELIGIBLE, with no
//       dependents fallback (drainDirty rewrites k -> r at RL:1884; d never enters the graph at RL:1881). Kills allow-unlisted-kind.
//   S2: a claim certifies only an E2 that answers not-revoked; a revoking E2 runs the renew path and E1 in full. Kills match-survives-revoke.
//   L3 FLAG: a background worker's commit on its own connection (root-set-reclaim.ts:302, root-set-compaction.ts:666,
//       provenance-stamp.ts:261, optional-index.ts:83) between a reply and the next send moves data_version: that send is ineligible.
// Each ineligible case: verdict miss, the turn's answer equals the cold legacy one (today's path ran), and the control send still matches.
import { describe, expect, it } from "vitest";
import { HIT_ONLY, HOT_DEADLINE, RECALL_RESERVE, hitOnly, lineageThreadState, r14Surface, type R14Surface } from "./testing/turnstart-r14-surface.ts";

const SEP = "\u001f";
/** The gate fixture's op index of "foreign-commit" (a commit from another connection to the same DB file). */
const FOREIGN_COMMIT = 6;
/** L2 surface extensions (not in the L4 contract): raw pending rows at the compare, and a stale receipt fixture. */
type Ext = R14Surface & {
  dispatch(thread: string, options?: Parameters<R14Surface["dispatch"]>[1] & { pendingRows?: string[] }): ReturnType<R14Surface["dispatch"]>;
  fixture(kind: string, options?: Record<string, number>): string[];
};
const surface = (): Ext => r14Surface() as Ext;
function warm(s: Ext): string {
  const [t] = s.fixture("plain");
  s.send(t!); s.dispatch(t!); s.advance(HOT_DEADLINE);
  expect(lineageThreadState(t!)).toBe("warm");
  return t!;
}
const sameAsLegacy = (d: ReturnType<R14Surface["dispatch"]>) =>
  expect({ revoked: d.counts.revoked, withheld: [...d.counts.withheld].sort() }).toEqual({ revoked: d.legacy.revoked, withheld: [...d.legacy.withheld].sort() });

describe("control (T12 / R1 stay reachable)", () => {
  it("a plain send with only its own rows pending matches, hit-only", () => {
    const s = surface(); const t = warm(s);
    const u = s.send(t);
    const d = s.dispatch(t, { recallNodes: RECALL_RESERVE, pendingRows: [`m${SEP}${t}${SEP}${u}`, `s${SEP}message:${t}:${u}`] });
    expect(d.verdict).toBe("match");
    expect(hitOnly(d.counts)).toEqual(HIT_ONLY);
    sameAsLegacy(d);
  });
});

describe("S1 ALLOWLIST: an unlisted pending row is ineligible (no dependents fallback)", () => {
  for (const [label, row] of [
    ["a k row (rewritten k -> r by drainDirty, RL:1884)", (t: string) => `k${SEP}${t}${SEP}unrelated`],
    ["a d row (never enters the graph, RL:1881)", (t: string) => `d${SEP}${t}`],
    ["an m row of another message of t", (t: string) => `m${SEP}${t}${SEP}not-U`],
    ["an m row of another thread", () => `m${SEP}elsewhere${SEP}x`],
    ["an unparseable row", () => "garbage"],
  ] as const) {
    it(`${label}: miss, counted under dirty, the turn ran today's path`, () => {
      const s = surface(); const t = warm(s);
      const before = s.counters().footprintMissByKind.dirty ?? 0;
      s.send(t);
      const d = s.dispatch(t, { recallNodes: RECALL_RESERVE, pendingRows: [row(t)] });
      expect(d.verdict).toBe("miss:not-covered");
      expect(s.counters().footprintMissByKind.dirty ?? 0).toBe(before + 1);
      sameAsLegacy(d);
    });
  }
  it("more than PENDING_CHECK_MAX (64) pending rows, all of them t's own kinds: ineligible", () => {
    const s = surface(); const t = warm(s);
    const u = s.send(t);
    const rows = Array.from({ length: 65 }, (_, index) => `s${SEP}message:${t}:${index === 0 ? u : `${u}-${index}`}`);
    const d = s.dispatch(t, { pendingRows: rows });
    expect(d.verdict).toBe("miss:not-covered");
    sameAsLegacy(d);
  });
});

describe("S2 REVOKE VOIDS: a match never spans renew()", () => {
  it("the session's E2 answers revoked: no claim (checking: revoked), the send misses, E1 runs in full and equals legacy", () => {
    const s = surface(); const t = warm(s);
    s.fixture("stale-receipt", { thread: 0 });
    s.advance(HOT_DEADLINE);
    expect(lineageThreadState(t)).not.toBe("warm");
    s.send(t);
    const d = s.dispatch(t, { recallNodes: RECALL_RESERVE });
    expect(d.verdict).toMatch(/^miss/);
    expect(d.counts.revoked).toBe(true);
    sameAsLegacy(d);
  });
});

describe("L3 FLAG: a worker's commit on its own connection between a reply and the next send", () => {
  it("data_version moved: the send is ineligible (W3' stamps/epochs), checked as today; no loosening", () => {
    const s = surface(); const t = warm(s);
    const by = () => { const k = s.counters().footprintMissByKind; return (k.epochs ?? 0) + (k.stamps ?? 0); };
    const before = by(), misses = s.counters().footprintMiss;
    s.fixture("gate", { op: FOREIGN_COMMIT, seed: 11 });
    s.send(t);
    const d = s.dispatch(t, { recallNodes: RECALL_RESERVE });
    expect(d.verdict).toBe("miss:not-covered");
    expect(s.counters().footprintMiss).toBe(misses + 1);
    expect(by(), "W3'(3)/(4): the other connection's commit (data_version) is a stamp or epoch miss").toBe(before + 1);
    sameAsLegacy(d);
  });
});
