// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// 1.0.21 cause6 r4 (DESIGN-R3 5.6): every DESIGN-R3 scenario replayed against the REAL proxy process.
// Each schedule runs twice with the same oracle (remote-mcp-proxy.interleave.ts): once on the spawned
// process (`realProxyRig`) and once on the machine in this process (`inProcessRig`). Whether the mount is
// sealed is read from the real seal object both times: the process's own terminal notice, and the
// createProxyTurnRelease object the in-process relay seals into. The rigs carry bytes and timing only.
// The two runs must also agree on what the proxy did: the same POSTs, the same answers to the engine.
//
// Not replayed here: a schedule step that moves a deadline. The process has the real clock (30 s for its
// own POSTs, 10 min for an engine call); those steps run in the seeded test, where the clock is the stand-in.
// REPLAY_SEEDS=a..b also runs generated schedules on the real process.
import { describe, expect, it } from "vitest";
import { describeFailure, inProcessRig, runSchedule, type Action, type Outcome } from "./remote-mcp-proxy.interleave.ts";
import { realProxyRig } from "./remote-mcp-proxy.replay.ts";

const E = (method: string): Action => ({ do: "engine", method });
const A = (post: string, as: string): Action => ({ do: "answer", post, as });
const Q = (nth: number): Action => ({ do: "engine-answer", nth });

/** The engine opens sess-1 and sends its handshake. */
const CONNECT = [E("initialize"), A("engine-init", "init-ok"), E("notifications/initialized"), A("handshake", "accepted")];
const CONNECT_ELICITS = [E("initialize+elicit"), ...CONNECT.slice(1)];
/** A call finds the session gone and the probe agrees: the session is closed and its reopen is on the wire. */
const LOSE = [E("tools/list"), A("call/tools/list", "gone"), A("probe", "gone")];
/** The engine initializes again while that reopen is unanswered; its session is used and the waiting call is answered on it. */
const SUPERSEDE = [E("initialize+elicit"), A("engine-init", "init-ok"), E("notifications/initialized"), A("handshake@last", "accepted"), A("call/tools/list", "ok")];
/** `first` is still streaming on sess-1 when another call finds sess-1 gone: sess-1 is closed under it. */
const closedUnder = (first: string) => [...CONNECT_ELICITS, E(first), A(`call/${first}`, "sse-hold"), ...LOSE];

interface Scenario {
  name: string; steps: Action[];
  /** The reason the REAL process seals for (null = it must not seal). */
  sealed: RegExp | null;
  /** In this process, when it differs: only a refused reserve does (there the refusal is a bare no, and
   * only the proxy's own code can seal; on the real wire the refusal seals in proxy-turn-release). */
  inProcess?: RegExp | null;
  /** Lines the proxy must have logged: its stale continuations, by site. */
  logs?: string[];
  /** Requests the engine must have been told "the session was replaced" for. */
  ownErrors?: number;
  /** How many POSTs of a kind the proxy must have made in all (`kind method`, as in `Outcome.wire`). */
  posts?: Record<string, number>;
}

const SCENARIOS: Scenario[] = [
  { name: "Z1 (ASTRA 1597) a superseded reopen's body breaks after the engine's own session is in use",
    steps: [...CONNECT, ...LOSE, A("reopen-init", "sse-hold"), ...SUPERSEDE, A("reopen-init", "break")], sealed: null, logs: ["stale reopen-read"] },
  { name: "Z2 a superseded reopen is answered 503 late",
    steps: [...CONNECT, ...LOSE, ...SUPERSEDE, A("reopen-init", "html-503")], sealed: null, logs: ["stale reopen-status"] },
  { name: "Z3 the handshake of a superseded automatic session is answered 503 late",
    steps: [...CONNECT, ...LOSE, A("reopen-init", "init-ok"), E("initialize+elicit"), A("engine-init", "init-ok"), A("handshake", "html-503"), E("notifications/initialized"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null, logs: ["stale handshake"] },
  { name: "Z4 (T21) a call still streaming on a session another call found gone gets its own error once",
    steps: [...closedUnder("resources/list"), A("call/resources/list", "break"), A("reopen-init", "init-ok"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null, logs: ["stale stream-read"], ownErrors: 1 },
  { name: "Z5 (T22, design 399) the same late break on a tool call still seals",
    steps: [...closedUnder("tools/call"), A("call/tools/call", "break")], sealed: /^upstream-body$/ },
  { name: "T22 a tool call's stream on a closed session ends with no answer: sealed by the stale disposition itself",
    steps: [...closedUnder("tools/call"), A("call/tools/call", "end")], sealed: /^stale-tool:stream-no-answer$/ },
  { name: "T22 a tool call's POST on a closed session is cut: still sealed in the transport",
    steps: [...CONNECT, E("tools/call"), ...LOSE, A("call/tools/call", "reject")], sealed: /^fetch:/ },
  { name: "Z6 the current reopen's own body breaking still seals",
    steps: [...CONNECT, ...LOSE, A("reopen-init", "sse-hold"), A("reopen-init", "break")], sealed: /^upstream-body$/ },
  { name: "Z7 an engine initialize a second one superseded gets its own error when its stream breaks",
    steps: [E("initialize"), A("engine-init", "sse-hold"), E("initialize+elicit"), A("engine-init@last", "init-ok"), E("notifications/initialized"), A("handshake", "accepted"), A("engine-init", "break")], sealed: null, logs: ["stale stream-read"], ownErrors: 1 },
  { name: "Z8 an engine initialize answered with an error, on a stream that then breaks: closed, nothing opened after it",
    steps: [E("initialize"), A("engine-init", "sse-hold"), A("engine-init", "error-answer"), A("engine-init", "break"), E("initialize+elicit"), A("engine-init", "init-ok"), E("notifications/initialized"), A("handshake", "accepted"), E("tools/list"), A("call/tools/list", "ok")], sealed: null, logs: ["stale stream-read"] },
  { name: "Z9 a superseded reopen's POST is cut",
    steps: [...CONNECT, ...LOSE, ...SUPERSEDE, A("reopen-init", "reject")], sealed: null, logs: ["stale reopen-post"] },
  { name: "T20 a probe for a session the engine replaced meanwhile is cut",
    steps: [...CONNECT, E("tools/list"), A("call/tools/list", "gone"), E("initialize+elicit"), A("engine-init", "init-ok"), A("probe", "reject"), E("notifications/initialized"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null },
  { name: "T23 a notification's POST on a closed session is cut: nothing is owed, nothing seals",
    steps: [...CONNECT, E("notifications/roots/list_changed"), ...LOSE, A("note", "reject"), A("reopen-init", "init-ok"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null, logs: ["stale call-post"] },
  { name: "T20 the reply to a server's ping on a closed session is cut",
    steps: [...closedUnder("resources/list"), A("call/resources/list", "server-ping"), A("reply", "reject"), A("call/resources/list", "answer")], sealed: null },
  { name: "T20 the engine's answer to a forwarded question goes back on a closed session and is cut",
    steps: [...CONNECT_ELICITS, E("resources/list"), A("call/resources/list", "sse-hold"), A("call/resources/list", "server-asks"), ...LOSE, Q(0), A("reply", "reject"), A("call/resources/list", "answer")], sealed: null },
  { name: "Z3 the handshake of a superseded automatic session is cut",
    steps: [...CONNECT, ...LOSE, A("reopen-init", "init-ok"), E("initialize+elicit"), A("engine-init", "init-ok"), A("handshake", "reject"), E("notifications/initialized"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null, logs: ["stale handshake"] },
  { name: "T20 the reply to a server's ping in a whole answer is cut after the session was closed",
    steps: [...CONNECT, E("resources/list"), A("call/resources/list", "ok-asks"), ...LOSE, A("reply", "reject"), A("reopen-init", "init-ok"), A("handshake", "accepted"), A("call/tools/list", "ok")], sealed: null },
  { name: "T12 a call on the engine's new session asks its own probe, never the one still out for the session before",
    steps: [...CONNECT, E("tools/list"), A("call/tools/list", "gone"), E("initialize+elicit"), A("engine-init", "init-ok"), E("notifications/initialized"), A("handshake", "accepted"),
      E("resources/list"), A("call/resources/list", "gone"), A("probe", "gone"), A("probe", "ok"), A("call/tools/list", "ok")], sealed: null, logs: ["stale call-session-gone"], posts: { "probe ping": 2, "reopen-init initialize": 0 } },
  { name: "T15 a session closed while a superseded reopen is still out is reopened at once, not after that reopen",
    steps: [...CONNECT, ...LOSE, ...SUPERSEDE, E("resources/list"), A("call/resources/list", "gone"), A("probe", "gone"), A("reopen-init@last", "init-ok"), A("handshake", "accepted"), A("call/resources/list", "ok"), A("reopen-init", "reject")], sealed: null, logs: ["stale reopen-post"], posts: { "reopen-init initialize": 2 } },
  { name: "T13 the engine's handshake for a session replaced long ago is answered while the current one is closed: it opens nothing",
    steps: [E("initialize"), A("engine-init", "init-ok"), E("notifications/initialized"), ...LOSE,
      E("initialize+elicit"), A("engine-init", "init-ok"), E("notifications/initialized"), A("handshake@last", "accepted"), A("call/tools/list", "ok"),
      E("resources/list"), A("call/resources/list", "gone"), A("probe", "gone"), A("reopen-init", "relay-server-error"), A("handshake", "accepted")],
    sealed: null, logs: ["stale handshake"], posts: { "reopen-init initialize": 1 } },
  { name: "live: a call's POST on the live session is cut",
    steps: [...CONNECT, E("tools/list"), A("call/tools/list", "reject")], sealed: /^fetch:/ },
  { name: "live: a call's body on the live session breaks",
    steps: [...CONNECT, E("tools/list"), A("call/tools/list", "sse-hold"), A("call/tools/list", "break")], sealed: /^upstream-body$/ },
  // ASTRA cause6-v2 a2efdf95e5: a POST that lost the turn's authority seals, whatever its session
  { name: "T24 (ASTRA a2efdf95e5) the turn refuses a chunk on a superseded reopen: the mount is sealed",
    steps: [...CONNECT, ...LOSE, A("reopen-init", "sse-hold"), ...SUPERSEDE, A("reopen-init", "reserve-refused")], sealed: /^upstream-reserve$/, inProcess: null, logs: ["stale reopen-read"] },
  { name: "T24 the turn refuses a chunk of a call streaming on a closed session: the mount is sealed",
    steps: [...closedUnder("resources/list"), A("call/resources/list", "reserve-refused")], sealed: /^upstream-reserve$/, inProcess: null, logs: ["stale stream-read"], ownErrors: 1 },
  { name: "T24 the turn refuses a chunk on the live session: the mount is sealed",
    steps: [...CONNECT, E("tools/list"), A("call/tools/list", "sse-hold"), A("call/tools/list", "reserve-refused")], sealed: /^upstream-reserve$/, inProcess: /^upstream-body$/ },
];

/** DESIGN-R3 5.6: what a generated seed must reach on the real process. */
type Reach = "T14g" | "T21" | "T22";
const reached = (outcome: Outcome): Reach[] => [
  ...outcome.trace.some((line) => /reopen-init initialize <- break/.test(line)) ? ["T14g" as const] : [],
  ...(outcome.stats["T21 own error"] ?? 0) > 0 ? ["T21" as const] : [],
  ...outcome.trace.some((line) => /call tools\/call <- (?:break|end|reject|reserve-refused|no-frame|html-503) \(stale\)/.test(line)) ? ["T22" as const] : [],
];
const N = (post: number, as: string): Action => ({ do: "answer", post, as });
interface Fixed { name: string; steps?: Action[]; seed?: number; reaches?: Reach }
const FIXED: Fixed[] = [
  { name: "fM1+fM2+fM6 (fence off / no seal gate / stale always seals; shrunk from seed 4): a superseded engine initialize's POST is cut",
    steps: [E("initialize+elicit"), E("initialize+elicit"), N(0, "reject")] },
  { name: "fM3 (close keeps the epoch; shrunk from seed 51): a refused engine initialize's stream breaks after the next one began",
    steps: [E("initialize"), N(0, "init-rpc-error"), E("tools/call"), E("tools/call"), E("initialize+elicit"), N(3, "sse-hold"), N(3, "error-answer"), N(3, "break")] },
  { name: "fM4+fM2+fM6 (T21 answers nothing / no seal gate / stale always seals; shrunk from seed 5): a call on a replaced session is cut",
    steps: [E("initialize+elicit"), E("notifications/initialized"), E("notifications/initialized"), N(0, "init-rpc-error"), E("notifications/roots/list_changed"), E("tools/list"), E("tools/call"), E("initialize+elicit"), N(6, "init-ok-reused"), E("notifications/initialized"), E("initialize"), N(8, "init-ok-reused"), E("tools/call"), N(9, "sse-hold"), E("tools/list"), N(9, "server-ping"), N(10, "gone"), E("notifications/initialized"), E("tools/call"), E("initialize+elicit"), N(9, "server-ping"), N(15, "init-ok"), N(9, "server-ping"), E("resources/list"), E("initialize+elicit"), N(18, "reject")] },
  { name: "fM5 (E399 dropped; shrunk from seed 10): a stale tool call's relay decision still seals",
    steps: [E("initialize+elicit"), E("initialize+elicit"), E("initialize+elicit"), E("initialize"), N(3, "init-non-object"), E("notifications/initialized"), E("notifications/initialized"), E("tools/list"), E("tools/list"), E("tools/list"), E("resources/list"), E("tools/list"), E("initialize+elicit"), N(11, "init-rpc-error"), E("notifications/roots/list_changed"), E("tools/call"), E("tools/call"), E("initialize+elicit"), N(15, "relay-no-answer"), E("ping"), E("tools/call"), E("initialize+elicit"), N(17, "relay-wrong-address")] },
  { name: "fM7 (fresh never; shrunk from seed 1): a call waiting on the engine's initialize is answered",
    steps: [E("initialize+elicit"), E("tools/list")] },
  { name: "fM8 (the probe closes the session again; shrunk from seed 45): a server ping's reply on a replaced session is cut",
    steps: [E("initialize"), E("initialize"), E("initialize+elicit"), E("initialize+elicit"), N(3, "init-ok"), E("tools/call"), E("initialize+elicit"), N(4, "gone"), N(5, "init-rpc-error"), E("notifications/initialized"), E("initialize+elicit"), E("resources/list"), N(8, "init-ok"), E("resources/list"), E("tools/call"), E("notifications/initialized"), N(12, "gone"), E("initialize+elicit"), N(13, "gone"), E("tools/call"), E("notifications/initialized"), N(14, "relay-server-error"), E("tools/list"), N(15, "ok-asks"), N(18, "reject")] },
  { name: "T14g seed 138", seed: 138, reaches: "T14g" },
  { name: "T14g seed 537", seed: 537, reaches: "T14g" },
  { name: "T14g seed 781", seed: 781, reaches: "T14g" },
  { name: "T14g seed 940", seed: 940, reaches: "T14g" },
  { name: "T14g seed 1228", seed: 1228, reaches: "T14g" },
  { name: "T21 seed 4", seed: 4, reaches: "T21" },
  { name: "T21 seed 5", seed: 5, reaches: "T21" },
  { name: "T21 seed 9", seed: 9, reaches: "T21" },
  { name: "T21 seed 13", seed: 13, reaches: "T21" },
  { name: "T21 seed 22", seed: 22, reaches: "T21" },
  { name: "T22 seed 40", seed: 40, reaches: "T22" },
  { name: "T22 seed 57", seed: 57, reaches: "T22" },
  { name: "T22 seed 64", seed: 64, reaches: "T22" },
  { name: "T22 seed 103", seed: 103, reaches: "T22" },
];

const told = (outcome: Outcome) => `${describeFailure(outcome)}\nskipped: ${outcome.skipped.join(" ")}`;
const sorted = (lines: string[]) => [...lines].sort();
function judge(outcome: Outcome, expected: RegExp | null, where: string): void {
  if (expected === null) expect(outcome.sealed, `${where}: the mount was sealed\n${told(outcome)}`).toBeNull();
  else expect(outcome.sealed ?? "(not sealed)", `${where}: the mount's seal (the real seal object)\n${told(outcome)}`).toMatch(expected);
  expect(outcome.violations, `${where}: invariants\n${told(outcome)}`).toEqual([]);
  // the schedule ran as written: no step met a state it was not written for
  expect(outcome.skipped, `${where}: skipped steps\n${told(outcome)}`).toEqual([]);
}

describe("the owner's MCP session scenarios on the real proxy process", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const here = await runSchedule(null, scenario.steps, inProcessRig);
      const real = await runSchedule(null, scenario.steps, realProxyRig);
      const inProcess = scenario.inProcess === undefined ? scenario.sealed : scenario.inProcess;
      judge(real, scenario.sealed, "real process");
      judge(here, inProcess, "in process");
      // the stale continuation was reached and logged by the proxy itself (a sealed process may exit before its last line)
      for (const line of scenario.logs ?? []) {
        expect(here.logs, `in process\n${told(here)}`).toContain(line);
        if (real.sealed === null) expect(real.logs, `real process\n${told(real)}`).toContain(line);
      }
      expect(here.stats["T21 own error"] ?? 0, told(here)).toBe(scenario.ownErrors ?? 0);
      for (const [kind, count] of Object.entries(scenario.posts ?? {})) {
        expect(real.wire.filter((line) => line.startsWith(`${kind} @`)), `real process\n${told(real)}`).toHaveLength(count);
        expect(here.wire.filter((line) => line.startsWith(`${kind} @`)), `in process\n${told(here)}`).toHaveLength(count);
      }
      // both runs saw the proxy do the same things
      expect(sorted(real.wire), `real process\n${told(real)}\nin process\n${told(here)}`).toEqual(sorted(here.wire));
      if (real.sealed === null) {
        expect(real.stats["T21 own error"] ?? 0, told(real)).toBe(scenario.ownErrors ?? 0);
        expect(sorted(real.answers), `real process\n${told(real)}\nin process\n${told(here)}`).toEqual(sorted(here.answers));
        expect(sorted(real.logs), `real process\n${told(real)}\nin process\n${told(here)}`).toEqual(sorted(here.logs));
      }
    }, 90_000);
  }

  // DESIGN-R3 5.6 (ASTRA cause6-v2 fc04b6a282): twenty FIXED schedules on the real process, every gate run. Each fuzz
  // mutant fM1-fM8 of DESIGN-R3 5.5 is killed by one named here: the first seed that failed under that mutant (in
  // process, without the clock, so a real process can run it), shrunk, and pinned as written. fM2 and fM6 shrink to the
  // schedules of fM1 and fM4, so six are mutant-derived; each is GREEN here and RED on the real process under every
  // mutant in its name (receipts: cause6-v5-opus/CHECKLIST.md). The other fourteen are generated seeds that reach
  // T14g (a reopen's body breaks), T21 (a stale request's own error) or T22 (a stale tool call),
  // and each must still reach it on the real process, so a generator change cannot turn one into a no-op.
  for (const fixed of FIXED) {
    it(`5.6 ${fixed.name}`, async () => {
      const real = await runSchedule(fixed.seed ?? null, fixed.steps ?? null, realProxyRig);
      expect(real.violations, `real process\n${told(real)}`).toEqual([]);
      if (fixed.steps) expect(real.skipped, `real process: the schedule did not run as written\n${told(real)}`).toEqual([]);
      if (fixed.reaches) expect(reached(real), `real process: seed ${fixed.seed} no longer reaches ${fixed.reaches}\n${told(real)}`).toContain(fixed.reaches);
    }, 120_000);
  }

  // generated schedules on the real process: the same generator and oracle as the seeded test, minus the clock
  const range = (process.env.REPLAY_SEEDS ?? "1..4").split("..").map(Number);
  it(`holds the invariants on generated schedules ${range[0]}..${range[1] ?? range[0]} on the real process`, async () => {
    const totals: Record<string, number> = {};
    for (let seed = range[0]!; seed <= (range[1] ?? range[0]!); seed++) {
      const outcome = await runSchedule(seed, null, realProxyRig);
      for (const [key, value] of Object.entries(outcome.stats)) totals[key] = (totals[key] ?? 0) + value;
      expect(outcome.violations, told(outcome)).toEqual([]);
    }
    console.log(`replay totals ${JSON.stringify(totals)}`);
    expect(totals.posts ?? 0).toBeGreaterThan(0);
  }, 600_000);
});
