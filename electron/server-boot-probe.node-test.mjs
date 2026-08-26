import assert from "node:assert/strict";
import test from "node:test";

import { pollServerIdentity } from "./server-boot-probe.mjs";

const OUR_BODY = () => ({ app: "openmausbot", pid: 4242, static: true });

function okFetch({ body = OUR_BODY(), status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test("returns ready when our own child answers with its identity", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "ready");
});

test("a never-completing /api/health cannot wedge the launcher past the boot budget", async () => {
  // Hangs until the probe aborts it, exactly like a server that accepts the
  // connection but never writes a response.
  const hangUntilAborted = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 300,
    fetchImpl: hangUntilAborted,
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(Date.now() - startedAt < 5_000, "must bail out well before an unbounded wait");
});

test("a non-2xx health response is a foreign owner, reported without waiting out the budget", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 503, json: async () => null };
  };
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 18799,
    pid: 4242,
    bootTimeoutMs: 60_000,
    fetchImpl,
  });
  assert.equal(outcome.outcome, "foreign-owner");
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a non-JSON body on an HTTP response counts as a foreign owner too", async () => {
  const outcome = await pollServerIdentity({
    port: 28799,
    pid: 4242,
    bootTimeoutMs: 60_000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => "not json-shaped" }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("an identity mismatch (same payload shape, wrong pid) stays foreign", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch({ body: { app: "openmausbot", pid: 999, static: true } }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("a response that lands after the deadline never returns ready", async () => {
  // The clock crosses the budget while the matching response is in flight.
  let reads = 0;
  const now = () => [0, 0, 1_001][Math.min(reads++, 2)];
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 1_000,
    now,
    sleep: async () => {},
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "timeout");
});

test("connection failures keep retrying until the budget runs out", async () => {
  let attempts = 0;
  const refused = async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 1_500,
    fetchImpl: refused,
    sleep: async () => {},
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(attempts >= 2, `expected several polls, saw ${attempts}`);
});

test("reports exit instead of polling after the child has died", async () => {
  let attempts = 0;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: 4242,
    bootTimeoutMs: 5_000,
    isExited: () => true,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("should not be reached");
    },
  });
  assert.equal(outcome.outcome, "exited");
  assert.equal(attempts, 0);
});
