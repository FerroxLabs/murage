// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// 1.0.21 cause6 r3 (DESIGN-R3 5): the session machine of the owner's MCP proxy under seeded interleavings.
// 500 schedules of 12 to 60 steps: late answers, bodies that break, rejected and timed-out POSTs, reopens,
// an engine initialize that supersedes, sessions that close. After every step the wire is checked:
//  A1 a fault about a session that is no longer the live one never seals (a tool call excepted, design 399);
//  A2 a fault about the live session seals exactly where the 1.0.21 rules seal, and nothing else does;
//  A3 every engine request gets exactly one answer, or the mount is sealed;
//  A4 no POST names a session the newest initialize did not open;
//  A5 one handshake per session, and no resent call before it was answered;
//  A7 a call is posted at most twice;
//  A8 no session state is written and no seal is made outside the one fence.
// Whether the mount is sealed is read from the real seal object (createProxyTurnRelease) that the real relay
// POST (relayDeps -> gatedFetch) and the machine seal into. The scheduled network never writes a seal.
// remote-mcp-proxy.replay.test.ts replays every DESIGN-R3 scenario on the real proxy process.
// SEED=<n> replays one seed. A failure prints the seed, the shrunk schedule and its trace.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFailure, runSchedule, shrink } from "./remote-mcp-proxy.interleave.ts";

const only = process.env.SEED ? [Number(process.env.SEED)] : null;
const FIRST = Number(process.env.INTERLEAVE_FIRST ?? "1");
const LAST = Number(process.env.INTERLEAVE_LAST ?? "500");

describe("the owner's MCP session under interleaved answers (seeded)", () => {
  it(`holds its invariants on seeds ${only ? only[0] : `${FIRST}..${LAST}`}`, async () => {
    const totals: Record<string, number> = {};
    const seeds = only ?? Array.from({ length: LAST - FIRST + 1 }, (_unused, index) => FIRST + index);
    for (const seed of seeds) {
      const outcome = await runSchedule(seed);
      for (const [key, value] of Object.entries(outcome.stats)) totals[key] = (totals[key] ?? 0) + value;
      if (outcome.violations.length > 0) {
        const small = await shrink(outcome.actions);
        throw new Error(`${describeFailure(outcome).split("\n").slice(0, 2).join("\n")}\n--- shrunk (${small.actions.length} of ${outcome.actions.length} steps) ---\n${describeFailure(small.violations.length > 0 ? small : outcome)}`);
      }
    }
    console.log(`interleave totals ${JSON.stringify(totals)}`);
    if (only) return;
    // The schedules reach what the invariants are about: without these the run would prove nothing.
    for (const key of ["stale fault", "stale fault on a tool call", "fault on the live session", "T21 own error", "T22 stale tool call sealed", "stale reopen-read", "stale reopen-status", "stale handshake", "stale stream-read", "reserve refused on a stale session", "reserve refused on the live session", "sealed", "not sealed"]) {
      expect(totals[key] ?? 0, `the schedules never reached: ${key}`).toBeGreaterThanOrEqual(seeds.length >= 500 ? 1 : 0);
    }
  }, 600_000);
});

// DESIGN-R3 5.4: the real file, every run. A seal, a close or a write to session state that is not inside the
// one fence (or an engine event's same-tick code) fails here before any schedule has to find it.
describe("the owner's MCP session source: one fence", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "remote-mcp-proxy.ts"), "utf8");
  const start = source.indexOf("export function createProxySession(");
  const end = source.indexOf("/** The process:");
  const machine = source.slice(start, end);
  /** The text from `open` at `from` to its matching close. */
  const span = (text: string, from: number, open: string, close: string): [number, number] => {
    let depth = 0;
    for (let at = text.indexOf(open, from); at < text.length; at++) {
      if (text[at] === open) depth++;
      else if (text[at] === close && --depth === 0) return [from, at];
    }
    throw new Error(`unbalanced at ${from}`);
  };
  const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match.index!);
  // where session state may be written: a fenced fx, an engine event's same-tick code, the state change `fail`
  // runs inside its own fenced fx, and the bodies of the four functions that ARE the fence
  const allowed: Array<[number, number]> = [
    ...all(machine, /\b(?:fenced|engineTick|fail)\(/g).map((at) => span(machine, at, "(", ")")),
    ...all(machine, /function (?:seal|begin|close|fenced|engineTick)\(/g).map((at) => span(machine, machine.indexOf("{", machine.indexOf(")", at)), "{", "}")),
    ...all(machine, /const settleFx = /g).map((at) => span(machine, machine.indexOf("{", at), "{", "}")),
  ];
  const inside = (at: number) => allowed.some(([from, to]) => at >= from && at <= to);
  const lineOf = (at: number) => `${source.slice(0, start + at).split("\n").length}: ${machine.slice(at, machine.indexOf("\n", at)).trim().slice(0, 90)}`;

  it("has the machine between its two marks", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(allowed.length).toBeGreaterThan(20);
  });
  it("seals, closes and writes session state only inside the fence", () => {
    const writes = [/(?<!function )\bseal\(/g, /(?<!function )\bclose\(/g, /\bsettleFx\??\.?\(/g, /\.(?:state|id|handshake|failure|gen|origin) [-+*]?= /g, /(?:\+\+|--)(?:m|cur|session)\.\w+/g, /\bm\.\w+(?:\+\+|--| [-+*]?= )/g, /\bcur = /g, /deps\.transportLost\(/g];
    const outside = writes.flatMap((pattern) => all(machine, pattern)).filter((at) => !inside(at)).map(lineOf);
    expect(outside).toEqual([]);
  });
  it("takes a fence only when a POST is about to be issued, and never as the argument of its own check", () => {
    // `fenced(fenceNow(), ...)` after an await would always be fresh: the fence must be the one taken before the await
    expect(all(machine, /fenced\(\s*fenceNow\(\)/g)).toEqual([]);
    expect(all(machine, /const f = fenceNow\(\);/g)).toHaveLength(3); // the handshake, the reopen, the engine's call
    expect(all(machine, /return fail\(cur\.failure \?\? NO_ANSWER, call, fenceNow\(\)\);/g)).toHaveLength(1); // a call that reads `cur` in the same tick
    expect(all(machine, /fenceNow\(\)/g)).toHaveLength(4);
    // an engine event's same-tick write: the engine's initialize and the engine's handshake, nowhere else
    expect(all(machine, /(?<!function )\bengineTick\(/g).map((at) => machine.slice(at, machine.indexOf("\n", at)))).toEqual([
      "engineTick(() => { m.initializeFrame = null; });",
      'engineTick(() => { session.handshake = "sending"; });',
    ]);
  });
  it("opens a generation in two places only: the engine's initialize and the reopen", () => {
    expect(all(machine, /\bbegin\("(?:engine|auto)"\)/g)).toHaveLength(2);
    expect(all(machine, /\bbegin\(/g)).toHaveLength(3); // those two and the function itself
  });
  it("has one seal in the machine, and the process seals elsewhere only in the gated transport and when the machine throws", () => {
    expect(all(machine, /deps\.transportLost\(/g)).toHaveLength(1);
    expect(all(machine, /proxyTransportLost\(|ports\.lost\(|relay\.lost\(/g)).toEqual([]);
    const elsewhere = source.slice(0, start) + source.slice(end);
    // the transport's two seals, each behind the gate; the machine's seal is the same port; the real seal is passed once
    expect(all(elsewhere, /ports\.lost\(/g)).toHaveLength(2);
    expect(all(elsewhere, /sealGate\(\)\) (?:\{ logSwallowedConsumingError\("proxy\.fetch", error\); )?ports\.lost\(/g)).toHaveLength(2);
    expect(all(elsewhere, /relay\.lost/g)).toHaveLength(1);
    expect(elsewhere).toContain("transportLost: relay.lost,");
    expect(all(elsewhere, /proxyTransportLost\("remoteMcp"/g)).toHaveLength(2);
    expect(elsewhere).toContain('lost: (reason) => proxyTransportLost("remoteMcp", reason),');
    expect(elsewhere).toContain('proxyTransportLost("remoteMcp", "handle")');
    // every chunk is reserved against the turn before it is examined, by the real reserve
    expect(all(elsewhere, /await ports\.reserve\(next\.value\.byteLength\);/g)).toHaveLength(1);
    expect(elsewhere).toContain('reserve: (bytes) => reserveProxyUpstream("remoteMcp", bytes),');
  });
  it("passes a seal gate with every POST", () => {
    const calls = all(machine, /(?<![.\w])post\(/g).map((at) => machine.slice(...span(machine, at, "(", ")")));
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.filter((call) => !/, (?:sealGate|gate\(f(?:, method)?\))$/.test(call))).toEqual([]);
  });
});
