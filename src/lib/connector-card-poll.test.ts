// A connect card that polls for its sign-in must end: connected, failed, or a
// final timed-out state. It used to stop polling after 75 tries and leave the
// card on "Waiting for sign-in…" with a spinner for ever (0.1.62, Bug 1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTOR_POLL_INTERVAL_MS, CONNECTOR_POLL_MAX_TRIES, CONNECTOR_TIMED_OUT_SENTENCE, endConnectorWait, startConnectorPoll } from "./connector-card-poll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const tick = async (times: number, ms = CONNECTOR_POLL_INTERVAL_MS) => {
  for (let i = 0; i < times; i += 1) await vi.advanceTimersByTimeAsync(ms);
};

describe("the connect card's poll", () => {
  it("covers at least the sign-in link's whole life", () => {
    expect(CONNECTOR_POLL_INTERVAL_MS * CONNECTOR_POLL_MAX_TRIES).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("ends with a final timed-out call when the sign-in never finishes, and then stops asking", async () => {
    const check = vi.fn(async () => ({ connected: false }));
    const onTimeout = vi.fn(async () => {});
    startConnectorPoll({ check, onTimeout });
    await tick(CONNECTOR_POLL_MAX_TRIES);
    expect(check).toHaveBeenCalledTimes(CONNECTOR_POLL_MAX_TRIES);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await tick(20);
    expect(check).toHaveBeenCalledTimes(CONNECTOR_POLL_MAX_TRIES);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("counts a failed check as a try, so a service that never answers still ends", async () => {
    const check = vi.fn(async () => { throw new Error("offline"); });
    const onTimeout = vi.fn(async () => {});
    startConnectorPoll({ check, onTimeout });
    await tick(CONNECTOR_POLL_MAX_TRIES);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stops without a timeout once the app is connected", async () => {
    let calls = 0;
    const check = vi.fn(async () => ({ connected: ++calls >= 3 }));
    const onTimeout = vi.fn();
    startConnectorPoll({ check, onTimeout });
    await tick(10);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops without a timeout once the provider has ended the link", async () => {
    const check = vi.fn(async () => ({ connected: false, failed: true }));
    const onTimeout = vi.fn();
    startConnectorPoll({ check, onTimeout });
    await tick(10);
    expect(check).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops quietly when the card goes away", async () => {
    const check = vi.fn(async () => ({ connected: false }));
    const onTimeout = vi.fn();
    const stop = startConnectorPoll({ check, onTimeout });
    await tick(2);
    stop();
    await tick(CONNECTOR_POLL_MAX_TRIES);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("never runs two checks at once", async () => {
    let running = 0;
    let most = 0;
    const check = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, CONNECTOR_POLL_INTERVAL_MS * 2.5));
      running -= 1;
      return { connected: false };
    });
    startConnectorPoll({ check, onTimeout: vi.fn(), maxTries: 4 });
    await tick(30);
    expect(most).toBe(1);
  });
});

// Review F4: the card used to reach "timed out" only after POST /timeout
// succeeded, so a dropped connection (the very case) left it spinning for ever.
describe("ending the wait locally first", () => {
  it("reaches the timed-out state and sentence even when the server call rejects", async () => {
    const shown: Array<{ timedOut: boolean; error: string }> = [];
    const notify = vi.fn(async () => { throw new Error("offline"); });
    await endConnectorWait({ show: (state) => shown.push(state), notify });
    expect(shown).toEqual([{ timedOut: true, error: CONNECTOR_TIMED_OUT_SENTENCE }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("lets the server reconcile: connected wins, its sentence replaces ours", async () => {
    const shown: Array<{ timedOut: boolean; error: string }> = [];
    await endConnectorWait({ show: (state) => shown.push(state), notify: async () => ({ connected: true }) });
    expect(shown.at(-1)).toEqual({ timedOut: false, error: "" });
    const other: Array<{ timedOut: boolean; error: string }> = [];
    await endConnectorWait({ show: (state) => other.push(state), notify: async () => ({ connected: false, error: "Server sentence." }) });
    expect(other.at(-1)).toEqual({ timedOut: true, error: "Server sentence." });
  });

  it("is what the poll calls when its budget is spent, with the server down", async () => {
    vi.useFakeTimers();
    const shown: Array<{ timedOut: boolean }> = [];
    startConnectorPoll({
      check: async () => ({ connected: false }),
      onTimeout: () => endConnectorWait({ show: (state) => shown.push(state), notify: async () => { throw new Error("offline"); } }),
      maxTries: 3,
    });
    await vi.advanceTimersByTimeAsync(CONNECTOR_POLL_INTERVAL_MS * 4);
    expect(shown[0]).toMatchObject({ timedOut: true });
  });
});
