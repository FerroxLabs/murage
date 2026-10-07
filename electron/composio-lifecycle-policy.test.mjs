// When the connected-apps lifecycle runs again, and what a rejected token means
// (0.1.62, Bug 2). Two things were wrong: a failed mint waited 10 minutes for
// the next tick whatever had gone wrong, and every rejection of the token
// forced a new mint, so two devices on one account took turns evicting each
// other. A cap eviction is "another device took over", said once in plain
// words with a button, never a retry loop.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { brokerTokenFingerprint } from "./flux-composio-token.mjs";
import { EventEmitter } from "node:events";

import {
  AUTO_REMINT_LOOP_WINDOW_MS,
  createLifecycleQueue,
  createLifecycleScheduler,
  createTokenRejectionHandler,
  EVICTION_CODES,
  LIFECYCLE_INTERVAL_MS,
  lifecycleDelay,
  shouldRunLifecycleNow,
  TOKEN_TAKEN_OVER,
  TRANSIENT_BACKOFF_MS,
} from "./composio-lifecycle-policy.mjs";

const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);
const SECOND = 1_000;
const rejection = (token, code = "broker_token_revoked") => ({ tokenFingerprint: brokerTokenFingerprint(token), code });

describe("when the lifecycle runs next", () => {
  it("retries a failed mint soon, backing off 15 s, 30 s, 60 s, 2 min and capping below the timer", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((failures) => lifecycleDelay({ transientFailures: failures }))).toEqual([
      15 * SECOND, 30 * SECOND, 60 * SECOND, 120 * SECOND, TRANSIENT_BACKOFF_MS.at(-1), TRANSIENT_BACKOFF_MS.at(-1), TRANSIENT_BACKOFF_MS.at(-1),
    ]);
    expect(TRANSIENT_BACKOFF_MS.at(-1)).toBeLessThanOrEqual(LIFECYCLE_INTERVAL_MS);
  });

  it("keeps the ten minute timer when nothing failed, and an hour after a rate limit", () => {
    expect(lifecycleDelay({ transientFailures: 0 })).toBe(LIFECYCLE_INTERVAL_MS);
    expect(lifecycleDelay({ transientFailures: 3, rateLimited: true })).toBe(60 * 60_000);
  });

  it("runs when the due time has passed", () => {
    expect(shouldRunLifecycleNow({ now: 100, nextAt: 200, online: true, wasOnline: true })).toBe(false);
    expect(shouldRunLifecycleNow({ now: 200, nextAt: 200, online: true, wasOnline: true })).toBe(true);
  });

  it("runs the moment the network comes back, without waiting out a long backoff", () => {
    expect(shouldRunLifecycleNow({ now: 100, nextAt: 10_000_000, online: true, wasOnline: false })).toBe(true);
  });

  it("does not run while offline, even when due", () => {
    expect(shouldRunLifecycleNow({ now: 500, nextAt: 200, online: false, wasOnline: false })).toBe(false);
  });
});

describe("what a rejected token means", () => {
  // `mint` stands in for one lifecycle pass: it replaces the token held, or
  // (when `mintFails`) leaves it as it was, as a 503 or an offline mint does.
  function setup(over = {}) {
    let credentials = { fluxComposioBrokerToken: TOKEN, ...over.credentials };
    let clock = 1_000_000;
    let mintFails = false;
    let next = 0;
    const minted = [];
    const remint = vi.fn(async () => {
      if (mintFails) return;
      const token = "c".repeat(63) + String(next++ % 10);
      minted.push(token);
      credentials = { ...credentials, fluxComposioBrokerToken: token };
    });
    const markTakenOver = vi.fn(async () => { credentials = { ...credentials, fluxComposioTokenError: TOKEN_TAKEN_OVER }; });
    const handler = createTokenRejectionHandler({ getCredentials: () => credentials, markTakenOver, remint, now: () => clock });
    return {
      handler, remint, markTakenOver, minted,
      advance: (ms) => { clock += ms; },
      held: () => credentials.fluxComposioBrokerToken,
      failMints: (value) => { mintFails = value; },
      set: (value) => { credentials = value; },
    };
  }
  it("re-mints once for a revoked token", async () => {
    const { handler, remint } = setup();
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("reminted");
    expect(remint).toHaveBeenCalledWith(brokerTokenFingerprint(TOKEN));
  });

  it("re-mints for ANY code it does not know, never leaving apps dead until expiry", async () => {
    for (const code of ["something_new", undefined, "broker_token_expired"]) {
      const { handler, remint } = setup();
      await expect(handler.onRejected(rejection(TOKEN, code))).resolves.toBe("reminted");
      expect(remint).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores a rejection of a token that has already been replaced", async () => {
    const { handler, remint, markTakenOver } = setup();
    await expect(handler.onRejected(rejection(OTHER))).resolves.toBe("ignored");
    expect(remint).not.toHaveBeenCalled();
    expect(markTakenOver).not.toHaveBeenCalled();
  });

  it("ignores a rejection when this install holds no token", async () => {
    const { handler, remint } = setup({ credentials: { fluxComposioBrokerToken: undefined } });
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("ignored");
    expect(remint).not.toHaveBeenCalled();
  });

  it("joins four simultaneous rejections into one re-mint", async () => {
    const { handler, remint } = setup();
    await Promise.all([1, 2, 3, 4].map(() => handler.onRejected(rejection(TOKEN))));
    expect(remint).toHaveBeenCalledTimes(1);
  });

  it.each([...EVICTION_CODES])("known code %s is a fast path to 'another device took over'", async (code) => {
    const { handler, remint, markTakenOver } = setup();
    await expect(handler.onRejected(rejection(TOKEN, code))).resolves.toBe("taken-over");
    expect(markTakenOver).toHaveBeenCalledTimes(1);
    expect(remint).not.toHaveBeenCalled();
  });

  it("shows 'took over' when the token our own re-mint produced is rejected soon after", async () => {
    const { handler, remint, markTakenOver, advance, held } = setup();
    await handler.onRejected(rejection(TOKEN));
    const ours = held();
    advance(60 * SECOND);
    await expect(handler.onRejected(rejection(ours, "whatever_flux_says"))).resolves.toBe("taken-over");
    expect(remint).toHaveBeenCalledTimes(1);
    expect(markTakenOver).toHaveBeenCalledTimes(1);
  });

  it("re-mints again once the loop window has passed", async () => {
    const { handler, remint, advance, held } = setup();
    await handler.onRejected(rejection(TOKEN));
    advance(AUTO_REMINT_LOOP_WINDOW_MS + SECOND);
    await expect(handler.onRejected(rejection(held()))).resolves.toBe("reminted");
    expect(remint).toHaveBeenCalledTimes(2);
  });

  it("F3: a re-mint that fails (503, timeout, offline) is retried, never called 'took over'", async () => {
    const { handler, remint, markTakenOver, advance, failMints } = setup();
    failMints(true);
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("failed");
    // The same dead token is rejected again a little later: try again.
    advance(TRANSIENT_BACKOFF_MS[0] + SECOND);
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("failed");
    failMints(false);
    advance(TRANSIENT_BACKOFF_MS[0] + SECOND);
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("reminted");
    expect(remint).toHaveBeenCalledTimes(3);
    expect(markTakenOver).not.toHaveBeenCalled();
  });

  it("does not hammer the mint: a rejection right after a failed one waits for the backoff", async () => {
    const { handler, remint, failMints } = setup();
    failMints(true);
    await handler.onRejected(rejection(TOKEN));
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("backoff");
    expect(remint).toHaveBeenCalledTimes(1);
  });

  it("says nothing more once taken over", async () => {
    const { handler, remint, markTakenOver } = setup();
    await handler.onRejected(rejection(TOKEN, [...EVICTION_CODES][0]));
    await handler.onRejected(rejection(TOKEN));
    expect(markTakenOver).toHaveBeenCalledTimes(1);
    expect(remint).not.toHaveBeenCalled();
  });

  it("reconnects on request and arms the guard for the new token, never loosening it", async () => {
    const { handler, remint, markTakenOver, held, advance, set } = setup();
    await handler.onRejected(rejection(TOKEN, [...EVICTION_CODES][0]));
    set({ fluxComposioBrokerToken: TOKEN, fluxComposioTokenError: TOKEN_TAKEN_OVER });
    await handler.reconnect();
    expect(remint).toHaveBeenCalledTimes(1);
    expect(remint).toHaveBeenLastCalledWith(undefined);
    // The other device pushes back at once: no second automatic exchange.
    advance(30 * SECOND);
    set({ fluxComposioBrokerToken: held() });
    await expect(handler.onRejected(rejection(held()))).resolves.toBe("taken-over");
    expect(remint).toHaveBeenCalledTimes(1);
    expect(markTakenOver).toHaveBeenCalledTimes(2);
  });
});

describe("the lifecycle queue (F2: a forced re-mint is never swallowed by a running pass)", () => {
  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("shares a running pass with an ordinary request", async () => {
    const gate = deferred();
    const pass = vi.fn(async () => { await gate.promise; });
    const run = createLifecycleQueue(pass);
    const first = run({});
    const second = run({});
    gate.resolve();
    await Promise.all([first, second]);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("runs a forced pass AFTER a running one rather than joining it", async () => {
    const gate = deferred();
    const calls = [];
    const pass = vi.fn(async (options) => { calls.push(options); if (calls.length === 1) await gate.promise; });
    const run = createLifecycleQueue(pass);
    const first = run({});
    const forced = run({ force: true, rejectedTokenFingerprint: "fp" });
    gate.resolve();
    await Promise.all([first, forced]);
    expect(calls).toEqual([{}, { force: true, rejectedTokenFingerprint: "fp" }]);
  });

  it("end to end: a rejection that lands while a pass runs still produces a new token and arms the guard", async () => {
    let credentials = { fluxComposioBrokerToken: TOKEN };
    const gate = deferred();
    let n = 0;
    const pass = vi.fn(async (options) => {
      if (n++ === 0) { await gate.promise; return; } // the wake-up pass: valid token, mints nothing
      if (options.force) credentials = { ...credentials, fluxComposioBrokerToken: OTHER };
    });
    const run = createLifecycleQueue(pass);
    let clock = 5_000_000;
    const handler = createTokenRejectionHandler({
      getCredentials: () => credentials,
      markTakenOver: async () => { credentials = { ...credentials, fluxComposioTokenError: TOKEN_TAKEN_OVER }; },
      remint: (fp) => run({ force: true, rejectedTokenFingerprint: fp }),
      now: () => clock,
    });
    const wake = run({});
    const decision = handler.onRejected(rejection(TOKEN));
    gate.resolve();
    await wake;
    await expect(decision).resolves.toBe("reminted");
    expect(credentials.fluxComposioBrokerToken).toBe(OTHER);
    // The old token's straggler is ignored; the new token's rejection is a takeover.
    await expect(handler.onRejected(rejection(TOKEN))).resolves.toBe("ignored");
    clock += 30 * SECOND;
    await expect(handler.onRejected(rejection(OTHER))).resolves.toBe("taken-over");
  });
});

describe("the lifecycle scheduler", () => {
  function setup(over = {}) {
    const powerMonitor = new EventEmitter();
    const network = { online: true, isOnline: () => network.online };
    const run = vi.fn(async () => {});
    const scheduler = createLifecycleScheduler({ net: network, powerMonitor, run, isShuttingDown: over.isShuttingDown, now: () => Date.now() });
    return { powerMonitor, network, run, scheduler };
  }
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("runs once, 3 seconds after the machine wakes", async () => {
    const { powerMonitor, run, scheduler } = setup();
    scheduler.start();
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(2_900);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs on the next tick when the network comes back, whatever backoff is pending", async () => {
    const { network, run, scheduler } = setup();
    scheduler.start();
    scheduler.afterPass({ transient: true });
    network.online = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    network.online = true;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never runs while offline, even when due", async () => {
    const { network, run, scheduler } = setup();
    scheduler.start();
    network.online = false;
    await vi.advanceTimersByTimeAsync(LIFECYCLE_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("retries a failed pass after 15 seconds, not ten minutes", async () => {
    const { run, scheduler } = setup();
    run.mockImplementation(async () => scheduler.afterPass({}));
    scheduler.start();
    scheduler.afterPass({ transient: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("N1: after a failed forced re-mint the retries are themselves forced, 15 s, 30 s, 60 s, until one succeeds", async () => {
    const { run, scheduler } = setup();
    let fails = 2;
    run.mockImplementation(async (options) => {
      // a forced pass that still cannot mint reports a retry; a success reports none
      scheduler.afterPass(fails-- > 0 ? { transient: true, retryForce: options?.rejectedTokenFingerprint ?? "fp" } : {});
    });
    scheduler.start();
    scheduler.afterPass({ transient: true, retryForce: "fp" });
    await vi.advanceTimersByTimeAsync(15_100);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith({ force: true, rejectedTokenFingerprint: "fp" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1); // the next wait is 30 s, not 15
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_100);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith({ force: true, rejectedTokenFingerprint: "fp" });
    // that one succeeded: the following pass is the ordinary, unforced one
    await vi.advanceTimersByTimeAsync(LIFECYCLE_INTERVAL_MS + 5_100);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenLastCalledWith({});
  });

  it("a wake does not override the rate-limit backoff", async () => {
    const { powerMonitor, run, scheduler } = setup();
    scheduler.start();
    scheduler.afterPass({ rateLimited: true });
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("registers one wake listener however often it is started, and none after stop()", async () => {
    const { powerMonitor, run, scheduler } = setup();
    scheduler.start();
    scheduler.start();
    expect(powerMonitor.listenerCount("resume")).toBe(1);
    scheduler.stop();
    expect(powerMonitor.listenerCount("resume")).toBe(0);
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(LIFECYCLE_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing once the app is shutting down", async () => {
    const down = { value: false };
    const { powerMonitor, run, scheduler } = setup({ isShuttingDown: () => down.value });
    scheduler.start();
    down.value = true;
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(LIFECYCLE_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});

// main.mjs is too large to run in a test, so only the wiring is pinned by
// shape; the behaviour it wires (queue, scheduler, handler) is tested above.
describe("what main.mjs wires", () => {
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");

  it("uses the tested queue, scheduler and rejection handler", () => {
    expect(main).toMatch(/const runComposioLifecycle = createLifecycleQueue\(runComposioLifecyclePass\)/);
    expect(main).toMatch(/createLifecycleScheduler\(\{\s+net,\s+powerMonitor,/);
    expect(main).toMatch(/composioScheduler\.afterPass\(\{\s+rateLimited,\s+transient: transient/);
    expect(main).toMatch(/murage:flux-composio-token-rejected[\s\S]{0,500}composioTokenRejections\.onRejected/);
    expect(main).not.toMatch(/runComposioLifecycle\(\{ force: true \}\)/);
  });

  it("revokes a replaced token only after the new document is saved", () => {
    expect(main).toMatch(/updateSecureCredentialDocument[\s\S]{0,900}saved \? entry\.previous : entry\.minted/);
  });
});
