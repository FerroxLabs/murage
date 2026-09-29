import { afterEach, expect, it, vi } from "vitest";
import type { ProviderStopResult } from "./contracts.ts";
import { RoomPendingStop } from "./room-turn-timeout.ts";

afterEach(() => vi.useRealTimers());
const no: ProviderStopResult = { closeConfirmed: false, reason: "timeout" };
const yes: ProviderStopResult = { closeConfirmed: true };

it.each(["false", "reject"])("keeps ownership after %s and observes the exact late close without another kill", async mode => {
  vi.useFakeTimers();let closed = false;
  const release = vi.fn(), observe = vi.fn(async (_turnId: string) => closed ? yes : no);
  const stop = vi.fn(async () => { if (mode === "reject") throw new Error("unconfirmed");return no; });
  const pending = new RoomPendingStop({ current: () => true, observe, closed: release });
  await pending.stop("turn-1", stop);
  await vi.advanceTimersByTimeAsync(6500);
  expect(release).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledOnce();
  expect(observe.mock.calls.every(args => args[0] === "turn-1")).toBe(true);
  closed = true;await vi.advanceTimersByTimeAsync(1000);
  expect(release).toHaveBeenCalledExactlyOnceWith("turn-1");
  await vi.advanceTimersByTimeAsync(10000);expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps legacy void explicitly unconfirmed without a teardown observer", async () => {
  vi.useFakeTimers();const release = vi.fn();
  const pending = new RoomPendingStop({ current: () => true, closed: release });
  await pending.stop("legacy", async () => {});
  await vi.advanceTimersByTimeAsync(60000);
  expect(release).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it("does not observe an unbound handshake, then binds the accepted identity once", async () => {
  vi.useFakeTimers();const release = vi.fn(), observe = vi.fn(async () => yes);
  const pending = new RoomPendingStop({ current: () => true, observe, closed: release });
  await vi.advanceTimersByTimeAsync(6500);
  expect(observe).not.toHaveBeenCalled();expect(pending.turnId).toBeUndefined();
  await pending.stop("accepted", async () => no);
  const anotherStop = vi.fn(async () => yes);
  await pending.stop("replacement", anotherStop);
  await vi.advanceTimersByTimeAsync(1000);
  expect(anotherStop).not.toHaveBeenCalled();expect(release).toHaveBeenCalledExactlyOnceWith("accepted");
});

it("a late receipt cannot release a replacement generation", async () => {
  vi.useFakeTimers();let current = true;let resolve!: (result: ProviderStopResult) => void;
  const release = vi.fn(), observe = vi.fn(() => new Promise<ProviderStopResult>(done => { resolve = done; }));
  const pending = new RoomPendingStop({ current: () => current, observe, closed: release });
  await pending.stop("old-turn", async () => no);await vi.advanceTimersByTimeAsync(1000);
  current = false;resolve(yes);await vi.advanceTimersByTimeAsync(0);
  expect(release).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});

it("a rejected observation retains ownership and independent rooms still release", async () => {
  vi.useFakeTimers();const blockedRelease = vi.fn(), independentRelease = vi.fn();
  const pending = new RoomPendingStop({ current: () => true, observe: async () => { throw new Error("observer unavailable"); }, closed: blockedRelease });
  await pending.stop("blocked", async () => no);
  const independent = new RoomPendingStop({ current: () => true, closed: independentRelease });
  await independent.stop("independent", async () => yes);
  await vi.advanceTimersByTimeAsync(6500);
  expect(blockedRelease).not.toHaveBeenCalled();expect(independentRelease).toHaveBeenCalledExactlyOnceWith("independent");
  pending.cancel();expect(vi.getTimerCount()).toBe(0);
});

it("shutdown cancellation prevents outstanding receipts or timers from releasing", async () => {
  vi.useFakeTimers();const release = vi.fn(), observe = vi.fn(async () => yes);
  const pending = new RoomPendingStop({ current: () => true, observe, closed: release });
  await pending.stop("closing", async () => no);pending.cancel();
  await vi.advanceTimersByTimeAsync(10000);
  expect(observe).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
});

it("an engine with no teardown receipt releases on its own stopped turn's terminal event, never another turn's", async () => {
  // Claude, Codex and Box end a stop without a close receipt. Their stopped
  // turn's terminal event is the receipt, as it is for a direct turn; without
  // it a stalled room stayed busy until the app restarted.
  vi.useFakeTimers();const release = vi.fn();
  const pending = new RoomPendingStop({ current: () => true, closed: release });
  pending.terminal("stopped-turn");
  expect(release).not.toHaveBeenCalled(); // nothing stopped yet: not a receipt
  await pending.stop("stopped-turn", async () => {});
  pending.terminal("some-other-turn");
  expect(release).not.toHaveBeenCalled();
  pending.terminal("stopped-turn");
  expect(release).toHaveBeenCalledExactlyOnceWith("stopped-turn");
  pending.terminal("stopped-turn");
  expect(release).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it("an engine with a teardown receipt is never released by a terminal event alone", async () => {
  vi.useFakeTimers();const release = vi.fn(), observe = vi.fn(async () => no);
  const pending = new RoomPendingStop({ current: () => true, observe, closed: release });
  await pending.stop("held", async () => no);
  pending.terminal("held");
  expect(release).not.toHaveBeenCalled();
  pending.cancel();
});

it("a terminal event cannot release a room a replacement now owns", async () => {
  vi.useFakeTimers();let current = true;const release = vi.fn();
  const pending = new RoomPendingStop({ current: () => current, closed: release });
  await pending.stop("old-turn", async () => {});
  current = false;pending.terminal("old-turn");
  expect(release).not.toHaveBeenCalled();
});
