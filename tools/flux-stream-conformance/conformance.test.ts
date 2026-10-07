// tools/flux-stream-conformance/conformance.test.ts
// The suite against the simulator with the scripted and trace providers:
// offline, deterministic. The full inventory takes about ten minutes of real
// protocol time (idle timeouts, session limits, 10 s begin delays), so it is an
// explicit opt-in, not part of the default unit gate:
//   FLUX_CONFORMANCE_FULL=1 ./node_modules/.bin/vitest run tools/flux-stream-conformance/conformance.test.ts
//   (or: pnpm flux-stream:conformance:full)
// The default gate runs the fast tests below, plus the two backpressure checks
// (P04 coalescing, B02 slow consumer) on their own.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedProvider } from "../flux-stream-sim/providers/scripted.ts";
import { traceProvider } from "../flux-stream-sim/providers/trace.ts";
import { createSimServer } from "../flux-stream-sim/server.ts";
import { CHECKS, CHECK_IDS, REQUIRED_GATES, acceptanceFailures, runChecks, type Check, type Gate, type Report } from "./checks.ts";
import { ConformanceClient, openClients } from "./client.ts";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { loadFixtures } from "./fixtures/analyse.ts";

let sim: Awaited<ReturnType<typeof createSimServer>>;
beforeAll(async () => {
  sim = await createSimServer({ port: 0, provider: scriptedProvider(), traceProvider: traceProvider(), allowFaults: true, pingMs: 20_000 });
});
afterAll(async () => sim.close());

const simCtx = () => ({
    mode: "dev" as const, base: sim.baseUrl, key: "sim_key", key2: "sim_key2", freeKey: "sim_free", restrictedKey: "sim_forbidden",
    sim: true, fluxFaults: true, latency: false, profile: true, fixtures: loadFixtures(),
    // the scripted provider splits every paused fixture at medium; the profile's
    // join path is covered by murage-profile.test.ts, and the tuned live run
    // (Task 14) is where the superseded-send gate means something
    eagerness: "low" as const,
});

// the backpressure pair, in the default gate: P04 needs the flood to be
// coalesced and B02 needs a client that stops reading to be closed 4503, and
// the sim judges "stops reading" by unanswered pings, not by kernel buffers
it("P04 coalesces a partial flood and B02 closes a client that stops reading", async () => {
  const report = await runChecks(simCtx(), ["P04", "B02"]);
  expect(report.results.map((r) => [r.id, r.status, r.status === "fail" ? r.detail : ""])).toEqual([["P04", "pass", ""], ["B02", "pass", ""]]);
}, 60_000);

it.skipIf(!process.env.FLUX_CONFORMANCE_FULL)("passes every contract check on the simulator (opt-in: FLUX_CONFORMANCE_FULL=1)", async () => {
  const report = await runChecks(simCtx());
  const failed = report.results.filter((r) => r.status === "fail");
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  // every check ran except those a simulator run excludes by tag
  const ran = new Set(report.results.filter((r) => r.status === "pass").map((r) => r.id));
  const excluded = new Set(report.results.filter((r) => r.status === "excluded").map((r) => r.id));
  expect([...excluded].sort()).toEqual(["A06", "E-latency", "E-nosplit-flux", "T09"]);
  for (const id of CHECK_IDS) expect(ran.has(id) || excluded.has(id), id).toBe(true);
  expect(report.gates.filter((g) => !g.pass)).toEqual([]);
}, 900_000);

it("judges Flux and Murage acceptance on their own inventories (Astra 2 I13)", () => {
  const gate = (id: string, pass = true): Gate => ({ id, pass, value: 1, limit: 2, samples: 5, needed: 5 });
  const report = (ids: string[]): Report => ({ mode: "acceptance", base: "x", sim: false, results: [{ id: "P01", status: "pass", ms: 1 }], metrics: {}, gates: ids.map((id) => gate(id)) });
  // a Flux run has no profile gates, and that is a pass for Flux
  expect(acceptanceFailures(report([...REQUIRED_GATES.flux]), "flux")).toEqual([]);
  // the same run is not a Murage acceptance: its three profile gates are missing
  expect(acceptanceFailures(report([...REQUIRED_GATES.flux]), "murage")).toEqual(["gate T-eot-murage-p90: missing", "gate T-superseded: missing", "gate T-audible-restarts: missing"]);
  expect(acceptanceFailures(report([...REQUIRED_GATES.murage]), "murage")).toEqual([]);
  // any failed check or gate fails either target
  const bad = report([...REQUIRED_GATES.flux]);
  bad.gates[0] = gate("T-text-p50", false);
  expect(acceptanceFailures(bad, "flux")).toHaveLength(1);
});

it("refuses an acceptance run with no target", async () => {
  await expect(runChecks({ mode: "acceptance", base: "ws://127.0.0.1:1/v1", key: "k", sim: false, fluxFaults: false, latency: false, profile: false, fixtures: [] })).rejects.toThrow(/--target/);
});

describe("no check can hang the run (Astra 3 I12)", () => {
  // a defective server: it upgrades every connect and never says or closes anything
  let server: WebSocketServer;
  let base = "";
  beforeAll(async () => {
    server = new WebSocketServer({ port: 0, handleProtocols: (p) => [...p][0] ?? false });
    await new Promise((r) => server.once("listening", r));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());
  const ctx = () => ({ mode: "dev" as const, base, key: "k", sim: true, fluxFaults: true, latency: false, profile: false, fixtures: [] });

  it("F04 fails, not hangs, when a refusal upgrades and stays open", async () => {
    const t = Date.now();
    const report = await runChecks(ctx(), ["F04"]);
    expect(report.results[0]).toMatchObject({ id: "F04", status: "fail" });
    expect(Date.now() - t).toBeLessThan(8_000);
  });

  it("a check past its deadline fails with its id, and its sockets are ended", async () => {
    const stuck: Check = { id: "STUCK", tags: [], timeoutMs: 300, async run(c) {
      const client = await ConformanceClient.open(c.base, { key: "k" });
      await client.closed; // never settles on this server
    } };
    const report = await runChecks(ctx(), undefined, [stuck]);
    expect(report.results[0].status).toBe("fail");
    expect(report.results[0].detail).toMatch(/STUCK/);
    expect(openClients.size).toBe(0);
  });
});

describe("L10: the fleet-wide start cap (rulings R6 and R7)", () => {
  const sims: Array<Awaited<ReturnType<typeof createSimServer>>> = [];
  afterAll(async () => {
    for (const s of sims) await s.close();
  });
  const run = async (simCap: number, ctxCap: number, mode: "dev" | "acceptance" = "dev", extra: Record<string, unknown> = {}) => {
    const s = await createSimServer({ port: 0, provider: scriptedProvider(), log: () => undefined, startsPerMinute: simCap, allowFaults: true });
    sims.push(s);
    // a fresh sim and a fresh window: only this check's starts count
    const ctx = { mode, target: "flux" as const, base: s.baseUrl, key: "sim_key", sim: true, fluxFaults: true, latency: false, profile: false, fixtures: [], startsPerMinute: ctxCap, startCapRetryWaitMs: 0, ...extra };
    return (await runChecks(ctx, mode === "dev" ? ["L10"] : undefined, CHECKS.filter((c) => c.id === "L10"))).results[0];
  };

  it("passes when the first refusal is start cap + 1, with the exact shape", async () => {
    expect(await run(3, 3)).toMatchObject({ id: "L10", status: "pass" });
  }, 60_000);

  it("is required in acceptance mode for the Flux target too, and runs there", async () => {
    expect(await run(3, 3, "acceptance")).toMatchObject({ id: "L10", status: "pass" });
  }, 60_000);

  it("still passes when every start takes 300 ms, because the burst is pipelined", async () => {
    const r = await run(8, 8, "dev", { extraQuery: { sim_fault: "begin_delay_ms=300" }, maxInflight: 4 });
    expect(r).toMatchObject({ status: "pass" });
    // 9 starts, 4 at a time: about 3 rounds of 300 ms, where one at a time would take 2.7 s
    const ms = Number(/; (\d+) ms/.exec(r.detail ?? "")?.[1]);
    expect(ms).toBeLessThan(2000);
  }, 60_000);

  it("passes when admission order differs from launch order (classified by count)", async () => {
    // later launches connect sooner: launches 1 to 4 start together, and the delays reverse their arrival
    const r = await run(8, 8, "dev", { maxInflight: 4, openJitterMs: (n: number) => (n <= 4 ? (5 - n) * 80 : (n % 3) * 40) });
    expect(r).toMatchObject({ status: "pass" });
    expect(r.detail).toMatch(/8 accepted then one refused \(launch #\d+\)/);
  }, 60_000);

  it("fails an early fleet-cap refusal with its start number, after one retry", async () => {
    const r = await run(2, 3);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/early fleet-cap refusal after \d accepted starts, expected 3.*service_unavailable\/api_error\/fatal=true.*retried once.*first burst was refused after 2 accepted starts/);
  }, 60_000);

  it("fails with cap not enforced when no refusal comes inside the window", async () => {
    const r = await run(6, 3);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/cap not enforced: 4 starts/);
  }, 60_000);

  it("fails with burst too slow when no refusal comes and the burst outlasted the window", async () => {
    const r = await run(100, 3, "dev", { extraQuery: { sim_fault: "begin_delay_ms=300" }, maxInflight: 1, capWindowMs: 500 });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/burst too slow: 4 starts in \d+ ms.*raise --max-inflight/);
  }, 60_000);

  it("blames per-account concurrency, not the fleet, when that is what refused", async () => {
    const r = await run(100, 3, "dev", { maxInflight: 6, extraQuery: { sim_fault: "begin_delay_ms=300" }, key: "sim_limited" });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/per-account concurrency hit after \d accepted starts; lower --max-inflight/);
  }, 60_000);
});
