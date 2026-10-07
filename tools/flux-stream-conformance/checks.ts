// tools/flux-stream-conformance/checks.ts
// Spec E.2 to E.4. Each check throws with a reason on failure, or Skip when
// it cannot run; acceptance mode counts a Skip of a required check as a fail.
import { DEFAULT_CONFIG, MAX_SESSION_CLOSE_REASON, SESSION_STARTS_PER_MINUTE, SUBPROTOCOL, billedSeconds } from "../../shared/flux-stream-contract.ts";
import { ConformanceClient, lastOpenAt, openClients, within, type OpenOptions, type Received } from "./client.ts";
import type { Fixture } from "./fixtures/analyse.ts";
import { replayCallTurns, type ProfileEvent } from "./murage-profile.ts";
import { normalizeWords, wer, werAccepting } from "./wer.ts";

export type Mode = "acceptance" | "dev";
/** Whose acceptance a run decides (Astra 2 I13). Flux: the contract checks and
 *  the protocol latency gates; Murage's profile is not Flux's to pass and is
 *  excluded. Murage: all of that plus the profile checks and their gates. */
export type Target = "flux" | "murage";
export const REQUIRED_GATES: Record<Target, readonly string[]> = {
  flux: ["T-text-p50", "T-text-p90", "T-eot-p50", "T-eot-p90"],
  murage: ["T-text-p50", "T-text-p90", "T-eot-p50", "T-eot-p90", "T-eot-murage-p90", "T-superseded", "T-audible-restarts"],
};
export type Tag = "sim-only" | "flux-only" | "flux-faults" | "latency" | "profile" | "report-only";

export interface Ctx {
  mode: Mode;
  /** Set for acceptance runs: which inventory applies. */
  target?: Target;
  base: string;
  key: string;
  key2?: string;
  freeKey?: string;
  restrictedKey?: string;
  /** The base is the simulator (magic keys, sim faults, traces). */
  sim: boolean;
  /** Provider faults are available: the simulator, or Flux staging with FLUX_AUDIO_STREAM_TEST_FAULTS. */
  fluxFaults: boolean;
  /** A real speech provider sits behind the base (latency and accuracy mean something). */
  latency: boolean;
  profile: boolean;
  /** Murage's punctuation commit in the profile runs (spec C.4); on unless false. */
  commit?: boolean;
  fixtures: Array<Fixture & { pcm: Buffer }>;
  eagerness?: string;
  extraQuery?: Record<string, string>;
  /** The server's fleet-wide start cap per minute, for L10 (default SESSION_STARTS_PER_MINUTE). */
  startsPerMinute?: number;
  /** L10: sessions open at once during the burst (default 4, the per-account concurrency limit). */
  maxInflight?: number;
  /** L10: the server's cap window (default 60 000 ms); tests shorten it. */
  capWindowMs?: number;
  /** L10: how long to wait before the one retry after an early cap refusal (default retry_after_ms plus the window). */
  startCapRetryWaitMs?: number;
  /** L10 test hook: delay before launch n connects, so admission order can differ from launch order. */
  openJitterMs?: (launch: number) => number;
}

export interface Check {
  id: string;
  tags: Tag[];
  run(ctx: Ctx, metrics: Metrics): Promise<void | string>;
  /** The whole check's deadline (default CHECK_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** No check runs longer than this (Astra 3 I12); the long-session checks say more. */
export const CHECK_TIMEOUT_MS = 180_000;

export class Skip extends Error {}
export type Metrics = Record<string, number[]>;
export interface Result {
  id: string;
  status: "pass" | "fail" | "skip" | "excluded";
  detail?: string;
  ms: number;
}
export interface Gate {
  id: string;
  pass: boolean;
  value: number;
  limit: number;
  samples: number;
  needed: number;
}
export interface Report {
  mode: Mode;
  base: string;
  sim: boolean;
  results: Result[];
  metrics: Record<string, { p50: number; p90: number; n: number }>;
  gates: Gate[];
}

function assert(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why);
}
const fixture = (ctx: Ctx, id: string) => {
  const f = ctx.fixtures.find((x) => x.id === id);
  assert(f, `fixture ${id} missing`);
  return f;
};
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined || value === null || value === "") throw new Skip(`needs ${what}`);
  return value;
};
const open = (ctx: Ctx, options: OpenOptions & { script?: Fixture; query?: Record<string, string | string[]> } = {}) =>
  ConformanceClient.open(ctx.base, {
    key: options.key === undefined ? ctx.key : options.key,
    protocols: options.protocols,
    query: {
      ...(ctx.extraQuery ?? {}),
      ...(options.query ?? {}),
      ...(ctx.sim && options.script ? { sim_script: options.script.segments_text.join("|") } : {}),
    },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turnOf = (r: Received) => ("turn" in r.msg ? (r.msg as { turn: number | null }).turn : null);

/** A connect that must be refused: error first, then this close code. */
function refusal(id: string, tags: Tag[], code: number, errorCode: string, options: (ctx: Ctx) => OpenOptions & { query?: Record<string, string> }, param?: string): Check {
  return {
    id,
    tags,
    async run(ctx) {
      const c = await open(ctx, options(ctx));
      const closed = await c.closedWithin();
      assert(closed.code === code, `closed ${closed.code}, expected ${code}`);
      const first = c.messages[0]?.msg;
      assert(first?.type === "error" && first.error.code === errorCode, `first message ${first?.type}/${first?.type === "error" ? first.error.code : "-"}`);
      if (param) assert(first.error.param === param, `param ${first.error.param}, expected ${param}`);
      assert(!c.of("session.started").length, "session started before refusal");
    },
  };
}

async function runFixture(ctx: Ctx, f: Fixture & { pcm: Buffer }, query: Record<string, string | string[]> = {}, key?: string) {
  const c = await open(ctx, { key, script: f, query: { keyterms: f.keyterms ?? [], ...query } });
  await c.sendPaced(f.pcm);
  await sleep(500);
  c.close();
  await c.closedWithin();
  assert(!c.of("warning").length, `${f.id}: the server dropped audio from a paced sender`);
  assert(!c.invalid.length, `${f.id}: ${c.invalid.length} unparseable messages`);
  return c;
}

/** A fixture sent the way StreamMic would drive the stream: its punctuation
 *  commit (spec C.4) when a partial of an open turn ends in . ? or ! (not an
 *  ellipsis) and the fixture has been silent for 400 ms in what was sent;
 *  never on silence alone. Off with --commit off. */
async function runMurage(ctx: Ctx, f: Fixture & { pcm: Buffer }) {
  const c = await open(ctx, { script: f, query: { eagerness: ctx.eagerness ?? "medium", keyterms: f.keyterms ?? [], ...(ctx.extraQuery ?? {}) } });
  await c.started();
  const committed = new Set<number>();
  const watch = setInterval(() => {
    if (ctx.commit === false) return;
    const sentMs = c.sentAt.length * 64;
    if (f.speech_segments.some(([a, b]) => a <= sentMs && sentMs < b)) return;
    const lastEnd = f.speech_segments.filter(([, b]) => b <= sentMs).at(-1)?.[1];
    if (lastEnd === undefined || sentMs - lastEnd < 400) return;
    const partial = c.of("transcript.partial").at(-1);
    if (!partial || committed.has(partial.msg.turn) || c.of("turn.end").some((e) => e.msg.turn === partial.msg.turn)) return;
    const text = partial.msg.text.trim();
    if (/[.?!]$/.test(text) && !/(\.\.\.|…)$/.test(text)) {
      committed.add(partial.msg.turn);
      c.sendJson({ type: "turn.commit" });
    }
  }, 20);
  try {
    await c.sendPaced(f.pcm);
  } finally {
    clearInterval(watch);
  }
  await sleep(500);
  c.close();
  await c.closedWithin();
  return c;
}

/** The turns of a run: each turn.end with the finals and partials before it. */
function turns(c: ConformanceClient) {
  return c.of("turn.end").map((end) => ({
    end,
    finals: c.of("transcript.final").filter((r) => r.msg.turn === end.msg.turn),
    partials: c.of("transcript.partial").filter((r) => r.msg.turn === end.msg.turn),
    started: c.of("speech.started").filter((r) => r.msg.turn === end.msg.turn),
  }));
}

// one long session feeds L05 and L09
const longSessions = new WeakMap<Ctx, Promise<{ c: ConformanceClient; startedAt: number }>>();
function longSession(ctx: Ctx) {
  let p = longSessions.get(ctx);
  if (!p) {
    p = (async () => {
      const c = await open(ctx, { query: { max_session_s: "90" } });
      const startedAt = await c.started();
      const t = setInterval(() => c.ws.readyState === c.ws.OPEN && c.sendJson({ type: "keepalive" }), 5000);
      try {
        await c.closedWithin(120_000);
      } finally {
        clearInterval(t);
      }
      return { c, startedAt };
    })();
    longSessions.set(ctx, p);
  }
  return p;
}

type StartResult =
  | { n: number; kind: "started" }
  | { n: number; kind: "refused"; error: Extract<Received["msg"], { type: "error" }>["error"]; closeCode: number | null }
  | { n: number; kind: "failed"; why: string };

/** L10's burst: up to cap + 1 starts, at most `maxInflight` open at once. */
async function startBurst(ctx: Ctx, cap: number, maxInflight: number) {
  const results: StartResult[] = [];
  const began = Date.now();
  let finished = began;
  let launched = 0;
  let inflight = 0;
  let stop = false;
  const one = async (n: number): Promise<StartResult> => {
    try {
      if (ctx.openJitterMs) await sleep(ctx.openJitterMs(n));
      const c = await open(ctx);
      const first = await c.waitFor((r) => r.msg.type === "session.started" || r.msg.type === "error", 15_000);
      if (first.msg.type === "session.started") {
        c.close();
        await c.closedWithin();
        return { n, kind: "started" };
      }
      const closed = await c.closedWithin().then((x) => x.code, () => null);
      return { n, kind: "refused", error: (first.msg as Extract<Received["msg"], { type: "error" }>).error, closeCode: closed };
    } catch (error) {
      return { n, kind: "failed", why: error instanceof Error ? error.message : String(error) };
    }
  };
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inflight < maxInflight && launched < cap + 1 && !stop) {
        launched += 1;
        inflight += 1;
        void one(launched).then((r) => {
          results.push(r);
          finished = Date.now();
          inflight -= 1;
          if (r.kind !== "started") stop = true;
          pump();
        });
      }
      if (inflight === 0) resolve();
    };
    pump();
  });
  const failed = results.find((r) => r.kind === "failed");
  if (failed && failed.kind === "failed") throw new Error(`start ${failed.n}: ${failed.why}`);
  const refusals = results.filter((r): r is Extract<StartResult, { kind: "refused" }> => r.kind === "refused").sort((a, b) => a.n - b.n);
  return { first: refusals[0], refusals: refusals.length, started: results.filter((r) => r.kind === "started").length, launched, elapsedMs: finished - began };
}

const PLAIN = ["f01-plain", "f07-two", "f08-stop", "f09-backchannel", "f12-names"];
const PAUSE = ["f02-comma", "f03-list", "f04-clause", "f05-tail", "f06-frame"];

export const CHECKS: Check[] = [
  // ── protocol ──
  {
    id: "P01", tags: [], async run(ctx) {
      const a = await open(ctx);
      await a.opened;
      assert(a.ws.protocol === SUBPROTOCOL, `offered: protocol "${a.ws.protocol}"`);
      a.close();
      const b = await open(ctx, { protocols: [] });
      await b.started(); // a client that offers none is served v1 and is sent no subprotocol
      assert(b.ws.protocol === "", `not offered: protocol "${b.ws.protocol}"`);
      b.close();
    },
  },
  {
    id: "P02", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      const s = c.messages[0].msg;
      assert(s.type === "session.started" && s.seq === 1, "session.started is not first");
      assert(s.model.startsWith("flux-voice"), "model is not a public alias");
      assert(s.config.min_silence_ms !== null && s.config.max_silence_ms !== null, "silences not resolved");
      assert(!/assembly|deepgram|openai|whisper|universal/i.test(JSON.stringify(s)), "provider name leaked");
      // no max_session_s asked for: the 3 h cap is what the session reports
      assert(s.config.max_session_s === DEFAULT_CONFIG.max_session_s, `max_session_s ${s.config.max_session_s}, expected ${DEFAULT_CONFIG.max_session_s}`);
      c.close();
    },
  },
  {
    id: "P03", tags: [], async run(ctx) {
      const c = await open(ctx, { query: { not_a_param: "1" } });
      await c.started();
      const s = c.messages[0].msg;
      assert(s.type === "session.started" && s.ignored_params.includes("not_a_param"), "unknown param not listed");
      c.close();
    },
  },
  {
    id: "P04", tags: [], async run(ctx) {
      const c = await runFixture(ctx, fixture(ctx, "f10-long"));
      assert(c.messages.length > 10, "too few messages to judge");
      c.messages.forEach((r, i) => assert(r.msg.seq === i + 1, `seq ${r.msg.seq} at ${i}`));
      // the coalescing half: a flood of partials while the client stops reading
      if (!ctx.sim && !ctx.fluxFaults) {
        if (ctx.mode === "acceptance") throw new Error("P04's coalescing half needs --flux-faults");
        return;
      }
      // flood_partials: numbered 4 KB partials of one turn every 5 ms (spec D; Flux's
      // fake provider, hand-off Task 4), 1.6 MB while the client is not reading
      const f = await open(ctx, { query: ctx.sim ? { sim_fault: "flood_partials" } : { flux_test_fault: "flood_partials=1" } });
      await f.started();
      f.pauseReading();
      await sleep(2000);
      (f.ws as unknown as { _socket: { resume(): void } })._socket.resume();
      await sleep(1500);
      f.close();
      const closed = await f.closedWithin();
      // the coalescing path ran (Astra 2 I14): the flood arrived, some of it was
      // replaced rather than delivered, the session outlived more than the 1 MiB
      // that would otherwise be a slow consumer, and seq has no gap
      const numbers = f.of("transcript.partial").map((r) => Number(/^flood (\d+) /.exec(r.msg.text)?.[1])).filter((n) => Number.isFinite(n));
      assert(numbers.length >= 20, `only ${numbers.length} flood partials arrived: the fault did not run`);
      const span = Math.max(...numbers) - Math.min(...numbers) + 1;
      assert(span > numbers.length, "every flood partial was delivered: nothing was coalesced");
      assert(closed.code === 1000, `closed ${closed.code}: coalescing did not keep the queue under the slow-consumer limit`);
      f.messages.forEach((r, i) => assert(r.msg.seq === i + 1, `after coalescing: seq ${r.msg.seq} at ${i}`));
    },
  },
  {
    id: "P05", tags: [], async run(ctx) {
      const c = await runFixture(ctx, fixture(ctx, "f01-plain"));
      let last = 0;
      for (const r of c.messages) {
        assert(r.msg.received_audio_ms >= last, "received_audio_ms went backwards");
        last = r.msg.received_audio_ms;
      }
    },
  },
  // ── auth ──
  refusal("A01", [], 4401, "unauthorized", () => ({ key: null })),
  refusal("A02", [], 4401, "unauthorized", () => ({ key: "not-a-flux-key" })),
  // a dummy value: a real key must never be put in a URL, even to test that it is refused
  refusal("A03", [], 4400, "invalid_param", () => ({ query: { APIKEY: "not-a-flux-key" } }), "APIKEY"),
  refusal("A04", [], 4402, "premium_locked", (ctx) => ({ key: need(ctx.freeKey, "--free-key-env") })),
  refusal("A05", ["sim-only"], 4404, "not_found", () => ({ key: "sim_dark" })),
  {
    id: "A06", tags: ["flux-only", "report-only"], async run() {
      throw new Skip("client tokens are v1.1");
    },
  },
  refusal("A07", [], 4403, "forbidden", (ctx) => ({ key: need(ctx.restrictedKey, "--restricted-key-env") })),
  // ── validation ──
  refusal("V01", [], 4400, "invalid_param", () => ({ query: { sample_rate: "44100" } }), "sample_rate"),
  ...([["V02", 2047, 4400], ["V03", 35_200, 4413]] as const).map(([id, bytes, code]): Check => ({
    id, tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      c.sendRaw(Buffer.alloc(bytes));
      assert((await c.closedWithin()).code === code, `frame of ${bytes} bytes not refused with ${code}`);
    },
  })),
  {
    id: "V04", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      c.sendJson({ type: "dance" });
      const e = await c.waitFor((r) => r.msg.type === "error");
      assert(e.msg.type === "error" && e.msg.error.code === "unknown_message_type" && !e.msg.error.fatal, "wrong error");
      c.sendJson({ type: "keepalive" });
      await sleep(300);
      assert(c.ws.readyState === c.ws.OPEN, "session did not continue");
      c.close();
    },
  },
  {
    id: "V05", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      c.ws.send("{nope");
      const e = await c.waitFor((r) => r.msg.type === "error");
      assert(e.msg.type === "error" && e.msg.error.code === "invalid_json", "wrong error");
      c.close();
    },
  },
  {
    id: "V06", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      for (let i = 0; i < 5; i += 1) c.ws.send("{nope");
      assert((await c.closedWithin()).code === 4400, "no close after five protocol errors");
    },
  },
  {
    id: "V07", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      c.ws.send(JSON.stringify({ type: "keepalive", pad: "x".repeat(17 * 1024) }));
      assert((await c.closedWithin()).code === 4400, "oversize text frame not refused");
    },
  },
  // ── turns ──
  {
    id: "T01-T03", tags: [], timeoutMs: 300_000, async run(ctx, metrics) {
      for (const f of ctx.fixtures.filter((x) => x.expected_turns > 0 && x.id !== "f10-long")) {
        const c = await runFixture(ctx, f, { eagerness: "low" });
        // T01: numbering over turn.end and turn.cancelled, nothing after a turn closes
        const closes = c.messages.filter((r) => r.msg.type === "turn.end" || r.msg.type === "turn.cancelled");
        closes.forEach((r, i) => assert(turnOf(r) === i, `${f.id}: turn ${turnOf(r)} closed at position ${i}`));
        for (const r of closes) {
          const after = c.messages.filter((x) => turnOf(x) === turnOf(r) && x.msg.seq > r.msg.seq);
          assert(!after.length, `${f.id}: ${after.length} messages after turn ${turnOf(r)} closed`);
        }
        for (const t of turns(c)) {
          // T02: order within the turn
          if (t.started.length && t.partials.length) assert(t.started[0].msg.seq < t.partials[0].msg.seq, `${f.id}: partial before speech.started`);
          assert(t.finals.length > 0, `${f.id}: turn ${t.end.msg.turn} ended with no finals`);
          assert(t.finals.every((x) => x.msg.seq < t.end.msg.seq), `${f.id}: a final after turn.end`);
          const lastFinal = t.finals[t.finals.length - 1];
          assert(!t.partials.some((p) => p.msg.seq > lastFinal.msg.seq), `${f.id}: a partial after the last final`);
          // T03: finals agree with the end (formatting may differ, words may not)
          const finalsText = t.finals.map((x) => x.msg.text).join(" ");
          assert(lastFinal.msg.turn_text === finalsText, `${f.id}: turn_text is not the join of the finals`);
          const agree = wer(finalsText, t.end.msg.text);
          assert(agree <= 0.1, `${f.id}: turn.end disagrees with its finals (WER ${agree.toFixed(2)})`);
          assert(t.end.msg.text.trim().length > 0, `${f.id}: empty turn.end`);
        }
        if (ctx.latency) {
          const score = werAccepting(f.text, c.of("turn.end").map((r) => r.msg.text).join(" "));
          (metrics.wer ??= []).push(score);
          assert(score <= 0.15, `${f.id}: WER ${score.toFixed(2)}`);
        }
      }
    },
  },
  {
    id: "T04", tags: [], async run(ctx) {
      const c = await runFixture(ctx, fixture(ctx, "f11-silence"));
      assert(!c.of("turn.end").length, "turn.end on silence");
    },
  },
  {
    id: "T05", tags: [], async run(ctx) {
      const f = fixture(ctx, "f10-long");
      const c = await open(ctx, { script: f, query: { eagerness: "low" } });
      const sending = c.sendPaced(f.pcm.subarray(0, 32 * 6000), { trailingSilenceMs: 0 });
      await c.waitFor((r) => r.msg.type === "transcript.partial" || r.msg.type === "transcript.final", 8000);
      await sleep(1500);
      const at = Date.now();
      c.sendJson({ type: "turn.commit" });
      const end = await c.waitFor((r) => r.msg.type === "turn.end" && r.at >= at, 3000);
      assert(end.msg.type === "turn.end" && end.msg.reason === "forced", `reason ${end.msg.type === "turn.end" ? end.msg.reason : "-"}`);
      assert(end.at - at <= 1000, `forced end took ${end.at - at} ms`);
      await sending;
      c.close();
    },
  },
  {
    id: "T06", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      const at = Date.now();
      c.sendJson({ type: "turn.commit" });
      const r = await c.waitFor((x) => x.msg.type === "turn.committed", 2000);
      assert(r.msg.type === "turn.committed" && r.msg.turn === null, "expected turn null");
      assert(r.at - at <= 1500, `turn.committed after ${r.at - at} ms`);
      c.close();
    },
  },
  {
    id: "T07", tags: [], async run(ctx) {
      const f = fixture(ctx, "f02-comma");
      const c = await open(ctx, { script: f, query: { eagerness: "high" } });
      await c.started();
      c.sendJson({ type: "session.update", config: { eagerness: "low" } });
      const u = await c.waitFor((r) => r.msg.type === "session.updated");
      assert(u.msg.type === "session.updated" && u.msg.config.eagerness === "low", "update not acknowledged");
      await c.sendPaced(f.pcm);
      await sleep(500);
      c.close();
      await c.closedWithin();
      assert(c.of("turn.end").length === 1, `after the update f02 gave ${c.of("turn.end").length} turns`);
    },
  },
  {
    id: "T08", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      c.sendJson({ type: "session.update", config: { sample_rate: 8000 } });
      c.sendJson({ type: "session.update", config: { format: false } });
      await c.waitFor(() => c.of("error").length >= 2);
      const params = c.of("error").map((r) => r.msg.error.code === "config_immutable" && !r.msg.error.fatal ? r.msg.error.param : null);
      assert(params.includes("sample_rate") && params.includes("format"), "immutable fields not reported");
      c.close();
    },
  },
  {
    id: "T09", tags: ["latency"], async run(ctx) {
      const c = await runFixture(ctx, fixture(ctx, "f12-names"));
      assert(/\bSable\b/.test(c.of("turn.end").map((r) => r.msg.text).join(" ")), "keyterm not spelled");
    },
  },
  ...([["T10", "empty-opened", "turn.cancelled", ""], ["T11", "duplicate-eot", "turn.end", "Blues Brothers."]] as const).map(([id, trace, want, text]): Check => ({
    id, tags: ["sim-only"], async run(ctx) {
      const f = fixture(ctx, "f01-plain");
      const c = await open(ctx, { query: { sim_trace: trace } });
      await c.sendPaced(f.pcm);
      c.close();
      await c.closedWithin();
      const closes = c.messages.filter((r) => r.msg.type === "turn.end" || r.msg.type === "turn.cancelled");
      assert(closes.length === 1 && closes[0].msg.type === want, `${trace}: ${closes.map((r) => r.msg.type).join(",")}`);
      const end = closes[0].msg;
      if (text) assert(end.type === "turn.end" && end.text === text, `${trace}: the formatted end was not the one kept`);
    },
  })),
  // ── lifecycle ──
  {
    id: "L01", tags: [], async run(ctx) {
      const c = await open(ctx, { query: { idle_timeout_s: "30" } });
      await c.started();
      const t = setInterval(() => c.sendJson({ type: "keepalive" }), 10_000);
      await sleep(45_000);
      clearInterval(t);
      assert(c.ws.readyState === c.ws.OPEN, "closed during 45 s of keepalives");
      c.close();
    },
  },
  {
    id: "L02", tags: [], async run(ctx) {
      const c = await open(ctx, { query: { idle_timeout_s: "5" } });
      const since = await c.started();
      const closed = await c.closedWithin();
      assert(closed.code === 4408, `closed ${closed.code}`);
      assert(closed.at - since <= 7000, `idle close after ${closed.at - since} ms`);
    },
  },
  {
    id: "L03", tags: [], async run(ctx) {
      const f = fixture(ctx, "f10-long");
      const c = await open(ctx, { script: f });
      const sending = c.sendPaced(f.pcm);
      await c.waitFor((r) => r.msg.type === "transcript.partial" || r.msg.type === "transcript.final", 8000);
      await sleep(1000);
      const at = Date.now();
      c.sendJson({ type: "session.close" });
      const closed = await c.closedWithin();
      await sending;
      assert(closed.code === 1000 && closed.at - at <= 2000, `close ${closed.code} after ${closed.at - at} ms`);
      const tail = c.messages.slice(-2).map((r) => r.msg);
      assert(tail[1]?.type === "session.closed", "no session.closed last");
      assert((tail[0]?.type === "turn.end" && tail[0].reason === "session_end") || tail[0]?.type === "turn.cancelled", "open turn not flushed");
    },
  },
  {
    id: "L04", tags: [], async run(ctx) {
      for (const holdMs of [3000, 12_000]) {
        const c = await open(ctx);
        const startedAt = await c.started();
        await sleep(holdMs);
        const at = Date.now();
        c.sendJson({ type: "session.close" });
        await c.closedWithin();
        const last = c.messages.at(-1)?.msg;
        assert(last?.type === "session.closed", "no session.closed");
        const expected = billedSeconds(at - startedAt);
        assert(Math.abs(last.usage.billed_seconds - expected) <= 1, `billed ${last.usage.billed_seconds}, expected about ${expected}`);
      }
    },
  },
  {
    id: "L05", tags: [], timeoutMs: 240_000, async run(ctx) {
      const { c, startedAt } = await longSession(ctx);
      const expiring = c.of("session.expiring")[0];
      assert(expiring, "no session.expiring");
      assert(Math.abs(expiring.at - startedAt - 60_000) <= 2000, `session.expiring at ${expiring.at - startedAt} ms`);
      const closed = await c.closedWithin();
      assert(closed.code === 1000 && Math.abs(closed.at - startedAt - 90_000) <= 2000, `close ${closed.code} at ${closed.at - startedAt} ms`);
      const last = c.messages.at(-1)?.msg;
      assert(last?.type === "session.closed" && last.reason === MAX_SESSION_CLOSE_REASON, `session.closed reason ${last?.type === "session.closed" ? last.reason : "-"}, expected ${MAX_SESSION_CLOSE_REASON}`);
    },
  },
  {
    id: "L06", tags: [], async run(ctx, metrics) {
      const f = fixture(ctx, "f01-plain");
      const g = fixture(ctx, "f12-names");
      // the provider starts 1.5 s late on both targets: the simulator's
      // begin_delay, or Flux staging's connect_delay on the REAL provider
      if (!ctx.sim && !ctx.fluxFaults) throw new Skip("L06 needs --sim or --flux-faults to delay the start");
      const c = await open(ctx, { script: f, query: ctx.sim ? { sim_fault: "begin_delay_ms=1500" } : { flux_test_fault: "connect_delay_ms=1500" } });
      await c.opened;
      const sending = c.sendPaced(f.pcm, { early: true, trailingSilenceMs: 1500 }); // audio before session.started
      const startedAt = await c.started();
      assert(startedAt - c.openedAt >= 1200, `session.started after ${startedAt - c.openedAt} ms: too soon to test pre-start audio`);
      await sending;
      const rtt = await c.rtt();
      const gOrigin = await c.sendPaced(g.pcm); // g's positions are on its own send, not f's (Astra 2 I11)
      await sleep(500);
      c.close();
      await c.closedWithin();
      const ends = c.of("turn.end");
      assert(ends.length >= 2, "pre-start audio produced no turn");
      if (ctx.latency) {
        const first = normalizeWords(ends.map((r) => r.msg.text).join(" "))[0];
        assert(first === normalizeWords(f.text)[0], "the fixture's first word was lost"); // the word itself is not reported
        // no lasting lag: the next turn ends in time, measured on the fixture's clock, not a provider timestamp
        const lag = ends[ends.length - 1].at - c.sentTimeOf(g.speech_end_ms, gOrigin) - rtt;
        (metrics.l06_next_eot ??= []).push(lag);
        assert(lag < 2000, `the turn after pre-start audio ended ${Math.round(lag)} ms after speech (a lasting backlog)`);
      }
    },
  },
  {
    id: "L07", tags: ["sim-only"], async run(ctx) {
      const a = await open(ctx, { key: "sim_limited" });
      await a.started();
      const b = await open(ctx, { key: "sim_limited" });
      const closed = await b.closedWithin();
      a.close();
      assert(closed.code === 4429, `second session closed ${closed.code}`);
      assert(b.messages[0]?.msg.type === "error" && b.messages[0].msg.error.code === "concurrency_limit", "wrong error");
    },
  },
  {
    id: "L08", tags: [], async run(ctx) {
      const c = await open(ctx);
      await c.started();
      const t = setInterval(() => c.sendJson({ type: "keepalive" }), 5000);
      await sleep(26_000);
      clearInterval(t);
      assert(c.pings >= 1, "no server ping in 26 s");
      c.close();
    },
  },
  {
    id: "L09", tags: [], timeoutMs: 240_000, async run(ctx) {
      const { c, startedAt } = await longSession(ctx);
      const usage = c.of("usage").find((r) => r.at - startedAt >= 58_000);
      assert(usage && usage.at - startedAt <= 62_000, `no usage between 58 and 62 s (${usage ? usage.at - startedAt : "none"})`);
    },
  },
  // ── backpressure, faults, isolation, metering ──
  {
    id: "B01", tags: [], async run(ctx) {
      const g = fixture(ctx, "f12-names");
      const c = await open(ctx, { script: g });
      await c.started();
      for (let i = 0; i < 100; i += 1) c.sendRaw(Buffer.alloc(2048));
      const w = await c.waitFor((r) => r.msg.type === "warning", 5000);
      assert(w.msg.type === "warning" && w.msg.code === "audio_dropped" && typeof w.msg.at_audio_ms === "number", "no audio_dropped warning with at_audio_ms");
      assert(c.ws.readyState === c.ws.OPEN, "closed on a burst");
      await sleep(3500);
      await c.sendPaced(g.pcm);
      await sleep(500);
      c.close();
      await c.closedWithin();
      assert(c.of("turn.end").length >= 1, "no turn after the burst");
    },
  },
  {
    id: "B02", tags: ["flux-faults"], async run(ctx) {
      const c = await open(ctx, { query: ctx.sim ? { sim_fault: "flood" } : { flux_test_fault: "flood_finals=1" } });
      await c.started();
      c.pauseReading();
      await sleep(4000);
      (c.ws as unknown as { _socket: { resume(): void } })._socket.resume();
      const closed = await c.closedWithin();
      const last = c.messages.at(-1)?.msg;
      assert(closed.code === 4503 && last?.type === "error" && last.error.code === "slow_consumer", `closed ${closed.code}`);
    },
  },
  {
    id: "F01", tags: ["flux-faults"], async run(ctx) {
      const c = await open(ctx, { query: ctx.sim ? { sim_fault: "close_after_ms=800:4502" } : { flux_test_fault: "error_after_ms=800" } });
      await c.started();
      const closed = await c.closedWithin();
      const last = c.messages.at(-1)?.msg;
      assert(closed.code === 4502, `closed ${closed.code}`);
      assert(last?.type === "error" && last.error.code === "capability_unavailable" && last.error.fatal, "no fatal error before close");
    },
  },
  refusal("F02", ["flux-faults"], 4504, "upstream_timeout", (ctx) => ({ query: { [ctx.sim ? "sim_fault" : "flux_test_fault"]: ctx.sim ? "begin_delay_ms=10000" : "begin_delay_ms=11000" } })),
  {
    id: "F03", tags: ["sim-only"], async run(ctx) {
      const c = await open(ctx, { query: { sim_fault: "reject=429" } });
      await c.closedWithin();
      const e = c.messages[0]?.msg;
      assert(e?.type === "error" && e.error.retry_after_ms !== null, "no retry_after_ms");
    },
  },
  {
    id: "F04", tags: ["sim-only"], async run(ctx) {
      const c = await open(ctx, { query: { sim_fault: "reject=503" } });
      // bounded both ways (Astra 3 I12): a refusal that upgrades and then stays open fails here
      const outcome = await c.opened.then(async () => String((await c.closedWithin(5000)).code)).catch((e: Error) => e.message);
      assert(/503/.test(outcome), `outcome ${outcome}`);
    },
  },
  {
    id: "X01", tags: [], async run(ctx) {
      const key2 = need(ctx.key2, "--key2-env (a key on a second account)");
      const [a, b] = [fixture(ctx, "f01-plain"), fixture(ctx, "f12-names")];
      const [ca, cb] = await Promise.all([runFixture(ctx, a), runFixture(ctx, b, {}, key2)]);
      const ta = ca.of("turn.end").map((r) => r.msg.text).join(" ");
      const tb = cb.of("turn.end").map((r) => r.msg.text).join(" ");
      assert(ta.trim() && tb.trim(), "a session produced no text");
      if (ctx.latency) assert(wer(a.text, ta) <= 0.15 && wer(b.text, tb) <= 0.15, "a session's text does not match its own fixture");
      assert(!/sable|heartbreak/i.test(ta) && !/bangkok|weather/i.test(tb), "sessions crossed");
    },
  },
  {
    id: "M01", tags: [], timeoutMs: 200_000, async run(ctx) {
      // three leases: renewals at 60 and 120 s, the close at about 125 s
      const c = await open(ctx);
      const startedAt = await c.started();
      const t = setInterval(() => c.sendJson({ type: "keepalive" }), 5000);
      await sleep(125_000);
      clearInterval(t);
      const at = Date.now();
      c.sendJson({ type: "session.close" });
      await c.closedWithin();
      const usages = c.of("usage").map((r) => r.msg.billed_seconds);
      assert(usages.length >= 2 && Math.abs(usages[0] - 60) <= 1 && Math.abs(usages[1] - 120) <= 1, `usage messages billed ${usages.join(",")}`);
      const last = c.messages.at(-1)?.msg;
      assert(last?.type === "session.closed" && Math.abs(last.usage.billed_seconds - billedSeconds(at - startedAt)) <= 1, "closing usage disagrees with the billing rule");
    },
  },
  // ── latency (E.3, E.4) ──
  {
    id: "E-latency", tags: ["latency"], timeoutMs: 240_000, async run(ctx, metrics) {
      for (const id of PLAIN) {
        const f = fixture(ctx, id);
        const c = await open(ctx, { script: f, query: { eagerness: ctx.eagerness ?? "medium", keyterms: f.keyterms ?? [] } });
        await c.started();
        (metrics.rtt ??= []).push(await c.rtt());
        await c.sendPaced(f.pcm);
        await sleep(500);
        c.close();
        await c.closedWithin();
        assert(!c.of("warning").length, `${id}: the server dropped audio`);
        const speechEndAt = c.sentTimeOf(f.speech_end_ms);
        const end = c.of("turn.end").at(-1);
        assert(end, `${id}: no turn.end`);
        // stable text (Astra I3): the first message of the last turn after which its
        // running text, normalized, equals the final text and stays equal; this is the
        // spike's "final text" measure. Protocol finals arrive with the end of turn on
        // universal-3-6-pro, so they are measured as T-eot, not here.
        const want = normalizeWords(end.msg.text).join(" ");
        const ofTurn = c.messages.filter((r) => turnOf(r) === end.msg.turn && (r.msg.type === "transcript.partial" || r.msg.type === "transcript.final" || r.msg.type === "turn.end"));
        const running = ofTurn.map((r) => normalizeWords(r.msg.type === "transcript.partial" ? r.msg.text : r.msg.type === "transcript.final" ? r.msg.turn_text : r.msg.type === "turn.end" ? r.msg.text : "").join(" "));
        let stable = running.length - 1;
        while (stable > 0 && running[stable - 1] === want) stable -= 1;
        (metrics.text_client ??= []).push(ofTurn[stable].at - speechEndAt);
        (metrics.eot_client ??= []).push(end.at - speechEndAt);
        (metrics.server_lag ??= []).push(end.msg.server_lag_ms); // reported only: provider word times drift
        (metrics.start ??= []).push(c.messages[0].at - c.openedAt);
      }
    },
  },
  {
    id: "E-nosplit-flux", tags: ["latency"], async run(ctx) {
      for (const id of [...PAUSE, "f07-two"]) {
        const f = fixture(ctx, id);
        const c = await runFixture(ctx, f, { eagerness: "low" });
        const n = c.of("turn.end").length;
        assert(n === f.expected_turns, `${id}: ${n} turns at low, expected ${f.expected_turns}`);
      }
    },
  },
  {
    // Murage's end of turn as a call would see it (Astra I5): every fixture,
    // plain and pause alike, runs through ONE session policy, with StreamMic's
    // punctuation commit on unless --commit off, and the same sessions give the
    // speed metric (plain) and the split metrics (pause, f07).
    id: "E-murage", tags: ["profile"], timeoutMs: 360_000, async run(ctx, metrics) {
      for (const id of [...PLAIN, ...PAUSE]) {
        const f = fixture(ctx, id);
        const c = await runMurage(ctx, f);
        const end = c.of("turn.end").at(-1);
        assert(end, `${id}: no turn.end`);
        if (ctx.latency && PLAIN.includes(id)) (metrics.eot_murage ??= []).push(end.at - c.sentTimeOf(f.speech_end_ms));
        if (id === "f07-two") assert(c.of("turn.end").length === 2, `f07: ${c.of("turn.end").length} provider turns, expected 2`);
        if (!PAUSE.includes(id) && id !== "f07-two") continue;
        // Murage's own clock, not provider timestamps: an utterance starts when Silero
        // would hear it (a fixture segment start plus about 200 ms of onset) and ends
        // at the segment's end; lines land when turn.end arrived.
        const events: ProfileEvent[] = f.speech_segments.map(([a]) => ({ at: c.sentTimeOf(a) + 200, kind: "start" as const }));
        for (const r of c.of("turn.end")) {
          const segEnd = f.speech_segments.map(([, b]) => b).filter((b) => c.sentTimeOf(b) <= r.at).at(-1) ?? f.speech_end_ms;
          events.push({ at: r.at, kind: "line", text: r.msg.text, endedAt: c.sentTimeOf(segEnd) });
        }
        const result = replayCallTurns(events, { hostFirstAudioMs: 3500 });
        (metrics.audible_restarts ??= []).push(result.audibleRestarts);
        if (PAUSE.includes(id)) {
          (metrics.superseded ??= []).push(result.superseded);
          assert(result.ownerTurns.length === 1, `${id}: ${result.ownerTurns.length} owner turns, expected 1`);
        }
      }
    },
  },
  {
    // The fleet-wide start cap (rulings R6 and R7), last in the inventory so its
    // burst cannot refuse another check's connect. Over the cap the server
    // refuses with a retryable service_unavailable and a numeric retry_after_ms,
    // then closes 4503. Against a real server this spends cap + 1 short sessions.
    // The burst is pipelined (at most maxInflight open at once, each closed the
    // moment it starts) so that connect latency cannot stretch it past the 60 s
    // window; starts are numbered in open order and classified by that number.
    id: "L10", tags: [], timeoutMs: 480_000, async run(ctx) {
      const cap = ctx.startsPerMinute ?? SESSION_STARTS_PER_MINUTE;
      const maxInflight = ctx.maxInflight ?? 4;
      const windowMs = ctx.capWindowMs ?? 60_000;
      // this run's own earlier starts count in the server's window: wait for them to leave it
      const last = lastOpenAt.get(ctx.base);
      if (last !== undefined && last + windowMs + 1000 > Date.now()) await sleep(last + windowMs + 1000 - Date.now());
      let retried = false;
      let firstRefusedAt = 0;
      for (;;) {
        const burst = await startBurst(ctx, cap, maxInflight);
        const first = burst.first;
        const tail = retried ? ` (the burst was retried once after waiting out the window; the first burst was refused after ${firstRefusedAt} accepted starts)` : "";
        if (!first) {
          assert(false, burst.elapsedMs > windowMs
            ? `burst too slow: ${cap + 1} starts in ${burst.elapsedMs} ms; the cap cannot be observed at this latency, raise --max-inflight${tail}`
            : `cap not enforced: ${cap + 1} starts in ${burst.elapsedMs} ms and none was refused${tail}`);
          return;
        }
        const e = first.error;
        const shape = `launch #${first.n}: ${e.code}/${e.type}/fatal=${e.fatal}/retry_after_ms=${String(e.retry_after_ms)}/close=${first.closeCode}`;
        // by count, not launch number: starts are admitted in arrival order, which
        // connect jitter can make differ from launch order. cap accepted, one
        // refused and cap + 1 launched means the refusal was the (cap + 1)th admission.
        const atCap = burst.started === cap && burst.refusals === 1 && burst.launched === cap + 1;
        if (!atCap) {
          if (e.code === "service_unavailable" && !retried) {
            retried = true;
            firstRefusedAt = burst.started;
            await sleep(ctx.startCapRetryWaitMs ?? (e.retry_after_ms ?? 0) + windowMs);
            continue;
          }
          assert(false, e.code === "service_unavailable"
            ? `early fleet-cap refusal after ${burst.started} accepted starts, expected ${cap}; other traffic on the fleet counts toward the cap (${shape})${tail}`
            : e.code === "concurrency_limit"
              ? `per-account concurrency hit after ${burst.started} accepted starts; lower --max-inflight (${shape})`
              : `a start was refused with ${e.code} after ${burst.started} accepted starts, expected acceptance until start ${cap + 1} (${shape})`);
        }
        assert(e.code === "service_unavailable" && e.type === "api_error" && e.fatal === true, `refusal has the wrong shape, expected service_unavailable/api_error/fatal (${shape})`);
        assert(typeof e.retry_after_ms === "number" && e.retry_after_ms > 0, `retry_after_ms must be a number above 0 (${shape})`);
        assert(first.closeCode === 4503, `closed ${first.closeCode}, expected 4503 (${shape})`);
        return `${cap} accepted then one refused (launch #${first.n}); ${burst.elapsedMs} ms, max ${maxInflight} in flight; retried: ${retried ? "yes" : "no"}`;
      }
    },
  },
];

export const CHECK_IDS = CHECKS.map((c) => c.id);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : Number.NaN;
};

/** Whether a check applies to this target: "run", or "excluded" by its tags. */
function applies(check: Check, ctx: Ctx): "run" | "excluded" | "missing" {
  const t = check.tags;
  if (t.includes("sim-only") && !ctx.sim) return "excluded";
  if (t.includes("flux-only") && ctx.sim) return "excluded";
  if (t.includes("flux-faults") && !ctx.sim && !ctx.fluxFaults) return ctx.mode === "acceptance" ? "missing" : "excluded";
  if (t.includes("latency") && !ctx.latency) return ctx.mode === "acceptance" ? "missing" : "excluded";
  if (t.includes("profile") && ctx.target === "flux") return "excluded";
  if (t.includes("profile") && !ctx.profile) return ctx.mode === "acceptance" ? "missing" : "excluded";
  return "run";
}

/** Why an acceptance run fails, or [] when it passes: any failed check, any
 *  failed gate, and any gate of the target's inventory that is missing. */
export function acceptanceFailures(report: Report, target: Target): string[] {
  const out = report.results.filter((r) => r.status === "fail").map((r) => `check ${r.id}: ${r.detail ?? "failed"}`);
  out.push(...report.gates.filter((g) => !g.pass).map((g) => `gate ${g.id}: ${Math.round(g.value)} against ${g.limit} (${g.samples}/${g.needed} samples)`));
  for (const id of REQUIRED_GATES[target]) if (!report.gates.some((g) => g.id === id)) out.push(`gate ${id}: missing`);
  return out;
}

export async function runChecks(ctx: Ctx, only?: string[], checks: readonly Check[] = CHECKS): Promise<Report> {
  if (ctx.mode === "acceptance" && !ctx.target) throw new Error("acceptance mode needs --target flux or --target murage");
  if (only) {
    if (ctx.mode === "acceptance") throw new Error("--only is not allowed in acceptance mode");
    const unknown = only.filter((id) => !CHECK_IDS.includes(id));
    if (!only.length || unknown.length) throw new Error(`unknown or empty --only: ${unknown.join(",") || "(none)"}`);
  }
  const metrics: Metrics = {};
  const results: Result[] = [];
  for (const check of checks.filter((c) => !only || only.includes(c.id))) {
    const started = Date.now();
    const verdict = applies(check, ctx);
    if (verdict === "excluded") {
      results.push({ id: check.id, status: "excluded", ms: 0 });
      continue;
    }
    if (verdict === "missing") {
      results.push({ id: check.id, status: "fail", detail: "required in acceptance mode but not runnable against this target", ms: 0 });
      continue;
    }
    try {
      // an overall deadline per check: a stuck check fails with its own id, and
      // the finally below still terminates whatever it left open
      const limit = check.timeoutMs ?? CHECK_TIMEOUT_MS;
      const note = await within(check.run(ctx, metrics), limit, `the end of check ${check.id} (${limit} ms)`);
      results.push({ id: check.id, status: "pass", ...(typeof note === "string" ? { detail: note } : {}), ms: Date.now() - started });
    } catch (error) {
      const skip = error instanceof Skip;
      const detail = error instanceof Error ? error.message : String(error);
      const reportOnly = check.tags.includes("report-only");
      results.push({ id: check.id, status: skip && (ctx.mode === "dev" || reportOnly) ? "skip" : "fail", detail, ms: Date.now() - started });
    } finally {
      // whatever this check left open is ended before the next one runs, so a
      // failed check cannot hold a concurrency slot or feed later checks (Astra 2 I15)
      for (const client of [...openClients]) client.dispose();
    }
  }
  const summary = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, { p50: pct(v, 50), p90: pct(v, 90), n: v.length }]));
  const rtt = summary.rtt?.p50 ?? Number.NaN;
  const gates: Gate[] = [];
  const gate = (id: string, metric: string, value: number, limit: number, needed: number) =>
    gates.push({ id, value, limit, samples: summary[metric]?.n ?? 0, needed, pass: (summary[metric]?.n ?? 0) >= needed && Number.isFinite(value) && value <= limit });
  const ran = (id: string) => results.some((r) => r.id === id && r.status !== "excluded");
  // Targets from the spike's direct measurements (final text 661/703 ms, end of
  // turn 672/1749 ms at p50/p90, no Flux hop), with room for the hop (spec E.4).
  // server_lag_ms is reported, not gated: it inherits the provider's word-time error.
  if (ran("E-latency")) {
    // stable text is the spike's "final text" (661/703 ms); the protocol end of turn (672/1749 ms) is T-eot
    gate("T-text-p50", "text_client", (summary.text_client?.p50 ?? Number.NaN) - rtt, 800, PLAIN.length);
    gate("T-text-p90", "text_client", (summary.text_client?.p90 ?? Number.NaN) - rtt, 1000, PLAIN.length);
    gate("T-eot-p50", "eot_client", (summary.eot_client?.p50 ?? Number.NaN) - rtt, 900, PLAIN.length);
    gate("T-eot-p90", "eot_client", (summary.eot_client?.p90 ?? Number.NaN) - rtt, 2000, PLAIN.length);
  }
  if (ran("E-murage") && ctx.latency) gate("T-eot-murage-p90", "eot_murage", (summary.eot_murage?.p90 ?? Number.NaN) - rtt, 1300, PLAIN.length);
  if (ran("E-murage")) {
    // the spike split 16 of 34 pause sessions at medium, mostly "Blues Brothers.", of which this set has one
    gate("T-superseded", "superseded", (metrics.superseded ?? []).reduce((a, b) => a + b, 0), 2, PAUSE.length);
    gate("T-audible-restarts", "audible_restarts", (metrics.audible_restarts ?? []).reduce((a, b) => a + b, 0), 0, PAUSE.length + 1);
  }
  return { mode: ctx.mode, base: ctx.base, sim: ctx.sim, results, metrics: summary, gates };
}
