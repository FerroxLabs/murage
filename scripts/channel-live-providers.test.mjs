// Offline checks of the live run's stop path: no server, network, credentials or operator.
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { abortableSleep, abortableWait, askOperator, createRunAbort, finalizeLive, LiveStop } from "./channel-live-providers.ts";

function fakeHarness({ revokeStatus = 200, pairedAfter = false, unreachable = false } = {}) {
  const calls = [], records = [];
  return {
    calls, records,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      if (unreachable) throw new Error("connect ECONNREFUSED");
      if (path.endsWith("/revoke")) return { status: revokeStatus, body: {} };
      if (path.endsWith("/status")) return { status: 200, body: { paired: pairedAfter } };
      return { status: 200, body: {} };
    },
    record(step, data) { records.push({ step, data }); },
    async close() { calls.push("close"); return null; },
  };
}
const neverAnswers = () => {
  const rl = new EventEmitter();
  rl.question = (_query, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  return rl;
};
const base = { revokePath: "/api/slack/revoke", statusPath: "/api/slack/status", statePaired: status => status?.paired === true };

it("Ctrl-C at a prompt aborts the run, a second signal cannot, and cleanup revokes, demotes and closes in that order", async () => {
  const proc = new EventEmitter(), rl = neverAnswers(), notes = [];
  const abort = createRunAbort(rl, proc, text => notes.push(text));
  expect([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM"), proc.listenerCount("SIGHUP"), rl.listenerCount("SIGINT")]).toEqual([1, 1, 1, 1]);
  const prompt = askOperator(rl, "Press Enter after sending it", abort.signal, 60_000);
  rl.emit("SIGINT");
  const stopped = await prompt.catch(error => error);
  expect(stopped).toBeInstanceOf(LiveStop);
  expect(stopped.message).toContain("SIGINT");
  proc.emit("SIGTERM");
  expect(notes.at(-1)).toContain("Cleanup is in progress");
  expect(abort.signal.reason).toBe(stopped);
  const harness = fakeHarness();
  const outcome = await finalizeLive({ ...base, harness, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false });
  expect(outcome).toMatchObject({ revoke: "confirmed", demote: "done", closed: true, order: ["revoke", "demote", "close"] });
  expect(harness.calls).toEqual(["POST /api/slack/revoke", "GET /api/slack/status", "PATCH /api/bots/chief-1", "close"]);
  expect(harness.records.map(r => [r.step, r.data.outcome])).toEqual([["stop-revoke", "confirmed"], ["stop-demote", "done"]]);
  abort.dispose();
  expect([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM"), proc.listenerCount("SIGHUP"), rl.listenerCount("SIGINT")]).toEqual([0, 0, 0, 0]);
});

it("SIGHUP ends waits and sleeps as a LiveStop", async () => {
  const proc = new EventEmitter();
  const abort = createRunAbort(undefined, proc, () => {});
  const waiting = abortableWait("never", () => false, value => value === true, 60_000, 50, abort.signal);
  const sleeping = abortableSleep(60_000, abort.signal);
  setTimeout(() => proc.emit("SIGHUP"), 20);
  await expect(waiting).rejects.toBeInstanceOf(LiveStop);
  await expect(sleeping).rejects.toBeInstanceOf(LiveStop);
  abort.dispose();
});

it("the run's time limit at a prompt is a LiveStop, and a probe timeout is too", async () => {
  const abort = createRunAbort(undefined, new EventEmitter(), () => {});
  const error = await askOperator(neverAnswers(), "attest", abort.signal, 25).catch(e => e);
  expect(error).toBeInstanceOf(LiveStop);
  expect(error.message).toContain("time limit");
  await expect(abortableWait("reply", () => 0, n => n > 0, 30, 10, abort.signal)).rejects.toThrow("timed out waiting for reply");
  abort.dispose();
});

it("cleanup revokes when pairing started but the pair request never answered, and never assumes success", async () => {
  const inFlight = fakeHarness();
  expect(await finalizeLive({ ...base, harness: inFlight, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: true }))
    .toMatchObject({ revoke: "confirmed", demote: "not-needed", order: ["revoke", "close"] });
  expect((await finalizeLive({ ...base, harness: fakeHarness({ revokeStatus: 500 }), pairingStarted: true, revokeConfirmed: false, chiefDemoted: true })).revoke).toBe("failed");
  expect((await finalizeLive({ ...base, harness: fakeHarness({ pairedAfter: true }), pairingStarted: true, revokeConfirmed: false, chiefDemoted: true })).revoke).toBe("failed");
  const down = fakeHarness({ unreachable: true });
  const outcome = await finalizeLive({ ...base, harness: down, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false });
  expect(outcome).toMatchObject({ revoke: "failed", demote: "failed", closed: true, order: ["revoke", "demote", "close"] });
});

it("cleanup does not revoke a pairing that never started or was already confirmed", async () => {
  const harness = fakeHarness();
  expect(await finalizeLive({ ...base, harness, pairingStarted: false, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false })).toMatchObject({ revoke: "not-needed", order: ["demote", "close"] });
  const confirmed = fakeHarness();
  expect(await finalizeLive({ ...base, harness: confirmed, pairingStarted: true, revokeConfirmed: true, chiefId: "chief-1", chiefDemoted: true })).toMatchObject({ revoke: "not-needed", demote: "not-needed", order: ["close"] });
  expect(confirmed.calls).toEqual(["close"]);
});
