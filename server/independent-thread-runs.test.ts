import { expect, it, vi } from "vitest";
import { IndependentThreadRuns, requireDirectThreadTarget } from "./independent-thread-runs.ts";

it("runs three detached per-thread snapshots and stopping one does not change its sibling", () => {
  const runs = new IndependentThreadRuns<{ model: string; account: string; effort: string; approval: string }>();
  const settings = { model: "one", account: "account-a", effort: "medium", approval: "ask" };
  const a = runs.admit("bot", "a", settings);
  settings.model = "two";settings.account = "account-b";settings.approval = "auto";
  const b = runs.admit("bot", "b", settings);
  runs.admit("bot", "c", settings);
  expect(() => runs.admit("bot", "d", settings)).toThrow("three threads");
  expect(a.snapshot).toMatchObject({ model: "one", account: "account-a", approval: "ask" });
  expect(b.snapshot).toMatchObject({ model: "two", account: "account-b", approval: "auto" });
  runs.dispatch(a);runs.dispatch(b);runs.accepted(a, "provider-a");runs.accepted(b, "provider-b");
  runs.cancel(a);
  expect(runs.get("b")).toMatchObject({ phase: "running", providerTurnId: "provider-b" });
  expect(() => runs.admit("bot", "d", settings)).toThrow("three threads");
  runs.release(a);expect(runs.admit("bot", "d", settings).threadId).toBe("d");
});
it("retains resource ownership through cancel and final settlement and rejects stale async acquisition", () => {
  const runs = new IndependentThreadRuns<object>();
  const a = runs.admit("bot", "a", {}, ["computer:host"]);
  runs.cancel(a);
  expect(runs.claim(a, ["browser:new"])).toBe(false);
  expect(() => runs.admit("other", "b", {}, ["computer:host"])).toThrow("Another thread");
  runs.settling(a);expect(runs.owns(a, "computer:host")).toBe(true);
  runs.release(a);
  const b = runs.admit("other", "b", {}, ["computer:host"]);
  expect(runs.claim(a, ["browser:new"])).toBe(false);
  expect(runs.release(a)).toBe(false);expect(runs.owns(b, "computer:host")).toBe(true);
});
it("cannot reactivate a completion-before-handshake or a replaced generation", () => {
  const runs = new IndependentThreadRuns<object>();
  const first = runs.admit("bot", "a", {});runs.dispatch(first);runs.settling(first);
  expect(runs.accepted(first, "late-provider")).toBe(false);
  runs.release(first);const next = runs.admit("bot", "a", {});
  expect(runs.cancel(first)).toBe(false);expect(runs.release(first)).toBe(false);
  expect(runs.current(next)).toBe(true);expect(runs.get("a")?.phase).toBe("setup");
});
it("keeps a stopped run stopping through its terminal event until teardown is confirmed", () => {
  const runs = new IndependentThreadRuns<object>();
  const a = runs.admit("bot", "a", {}, ["computer:host"]);
  runs.dispatch(a);runs.accepted(a, "provider-a");runs.cancel(a);
  expect(runs.settling(a)).toBe(true);
  expect(runs.get("a")?.phase).toBe("stopping");
  expect(runs.claim(a, ["browser:late"])).toBe(false);
  expect(() => runs.admit("bot", "b", {}, ["computer:host"])).toThrow("Another thread");
  expect(runs.release(a)).toBe(true);
  expect(runs.admit("bot", "b", {}, ["computer:host"]).threadId).toBe("b");
});
it("requires an unambiguous explicit thread and never falls back from a wrong target", () => {
  expect(requireDirectThreadTarget(["one"], undefined)).toBe("one");
  expect(requireDirectThreadTarget(["one", "two"], "two")).toBe("two");
  expect(() => requireDirectThreadTarget(["one", "two"], undefined)).toThrow("Choose a thread explicitly");
  expect(() => requireDirectThreadTarget(["one"], "other")).toThrow("No such thread");
  expect(() => requireDirectThreadTarget(["one"], "../one")).toThrow("task id");
});

// ── waiting for shared resources ─────────────────────────────────────────
const settled = async <T,>(promise: Promise<T>) => {
  let state: { value?: T; done: boolean } = { done: false };
  void promise.then(value => { state = { value, done: true }; });
  // Resolution is event-driven: two microtask turns flush any resolve().
  await Promise.resolve();await Promise.resolve();
  return state;
};
it("waits for a held resource and wakes on release, without polling", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("petra", "sweep", {}, ["screen:bot:petra"]);
  const chat = runs.admit("petra", "chat", {});
  const seen: string[] = [];
  const waiting = runs.acquire(chat, ["screen:bot:petra"], blockers => seen.push(...blockers.map(blocker => `${blocker.owner.threadId}:${blocker.resource}:${blocker.queued}`)));
  expect((await settled(waiting)).done).toBe(false);
  expect(runs.waiting(chat)).toBe(true);
  expect(seen).toEqual(["sweep:screen:bot:petra:false"]);
  expect(runs.owns(chat, "screen:bot:petra")).toBe(false);
  runs.dispatch(holder);runs.accepted(holder, "provider");runs.settling(holder);
  expect((await settled(waiting)).done).toBe(false);
  runs.release(holder);
  expect(await waiting).toBe(true);
  expect(runs.owns(chat, "screen:bot:petra")).toBe(true);
  expect(runs.waiting(chat)).toBe(false);
});
it("serves waiters for the same resource first-in first-out and keeps newcomers behind the queue", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("bot", "holder", {}, ["computer:vm"]);
  const first = runs.admit("bot", "first", {}), second = runs.admit("other", "second", {});
  const order: string[] = [];
  const a = runs.acquire(first, ["computer:vm"]).then(granted => { order.push(`first:${granted}`); return granted; });
  const b = runs.acquire(second, ["computer:vm"]).then(granted => { order.push(`second:${granted}`); return granted; });
  runs.release(holder);
  expect(await a).toBe(true);
  expect((await settled(b)).done).toBe(false);
  // A new arrival cannot jump the queued waiter even though it holds nothing.
  const late = runs.admit("late", "late", {});
  expect(runs.claim(late, ["computer:vm"])).toBe(false);
  const c = runs.acquire(late, ["computer:vm"]).then(granted => { order.push(`late:${granted}`); return granted; });
  runs.release(first);
  expect(await b).toBe(true);
  expect((await settled(c)).done).toBe(false);
  runs.release(second);
  expect(await c).toBe(true);
  expect(order).toEqual(["first:true", "second:true", "late:true"]);
});
it("cancel while waiting resolves false, leaks no claim and never takes the resource", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("bot", "holder", {}, ["workspace:/project"]);
  const waiter = runs.admit("bot", "waiter", {}, ["browser:profile"]);
  const next = runs.admit("bot", "next", {});
  const waiting = runs.acquire(waiter, ["workspace:/project"]);
  const behind = runs.acquire(next, ["workspace:/project", "browser:profile"]);
  // Before waiting the waiter released its own browser claim.
  expect(runs.owns(waiter, "browser:profile")).toBe(false);
  expect(runs.cancel(waiter)).toBe(true);
  expect(await waiting).toBe(false);
  expect(runs.waiting(waiter)).toBe(false);
  runs.release(holder);
  expect(await behind).toBe(true);
  expect(runs.owns(waiter, "workspace:/project")).toBe(false);
  expect(runs.owns(next, "browser:profile")).toBe(true);
  // A cancelled generation cannot re-enter the queue.
  expect(await runs.acquire(waiter, ["computer:vm"])).toBe(false);
  expect(runs.release(waiter)).toBe(true);
  expect(runs.waiting(waiter)).toBe(false);
});
it("release of a waiting run (provider reload) and a replaced generation drop the waiter", async () => {
  const runs = new IndependentThreadRuns<object>();
  runs.admit("bot", "holder", {}, ["computer:bot:x"]);
  const waiter = runs.admit("bot", "waiter", {});
  const waiting = runs.acquire(waiter, ["computer:bot:x"]);
  expect(runs.release(waiter)).toBe(true);
  expect(await waiting).toBe(false);
  const replacement = runs.admit("bot", "waiter", {});
  expect(await runs.acquire(waiter, ["browser:free"])).toBe(false);
  expect(await runs.acquire(replacement, ["browser:free"])).toBe(true);
});
it("cannot deadlock when two turns claim folder and computer in opposite order", async () => {
  const runs = new IndependentThreadRuns<object>();
  const a = runs.admit("bot", "a", {}), b = runs.admit("bot", "b", {});
  expect(await runs.acquire(a, ["workspace:/shared"])).toBe(true);
  expect(await runs.acquire(b, ["computer:vm"])).toBe(true);
  // A needs the computer B holds: A releases its folder before waiting.
  const aNext = runs.acquire(a, ["computer:vm"]);
  expect(runs.owns(a, "workspace:/shared")).toBe(false);
  expect((await settled(aNext)).done).toBe(false);
  // B needs the folder A just released, so B completes its set instead of
  // both turns holding one resource each forever.
  expect(await runs.acquire(b, ["workspace:/shared"])).toBe(true);
  expect(runs.owns(b, "workspace:/shared") && runs.owns(b, "computer:vm")).toBe(true);
  runs.release(b);
  expect(await aNext).toBe(true);
  expect(runs.owns(a, "workspace:/shared") && runs.owns(a, "computer:vm")).toBe(true);
});
it("cannot deadlock when both turns block at once: the later waiter queues holding nothing", async () => {
  const runs = new IndependentThreadRuns<object>();
  const other = runs.admit("other", "other", {}, ["workspace:/shared"]);
  const a = runs.admit("bot", "a", {}, ["computer:vm"]), b = runs.admit("bot", "b", {});
  // A holds the computer and waits for the folder: it lets the computer go.
  const aNext = runs.acquire(a, ["workspace:/shared"]);
  expect(runs.owns(a, "computer:vm")).toBe(false);
  // B wants computer + folder while A is queued for both: B queues behind A.
  const bNext = runs.acquire(b, ["computer:vm", "workspace:/shared"]);
  expect((await settled(bNext)).done).toBe(false);
  runs.release(other);
  expect(await aNext).toBe(true);
  expect((await settled(bNext)).done).toBe(false);
  runs.release(a);
  expect(await bNext).toBe(true);
});
it("does not let a queued waiter displace a holder that extends or re-claims its own resources", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("bot", "holder", {}, ["workspace:/project"]);
  const waiter = runs.admit("bot", "waiter", {});
  const waiting = runs.acquire(waiter, ["workspace:/project", "browser:profile"]);
  expect(await runs.acquire(holder, ["workspace:/project"])).toBe(true);
  expect(await runs.acquire(holder, ["browser:profile"])).toBe(true);
  expect(runs.owns(holder, "workspace:/project") && runs.owns(holder, "browser:profile")).toBe(true);
  expect((await settled(waiting)).done).toBe(false);
  runs.release(holder);
  expect(await waiting).toBe(true);
});
it("keeps the three-thread limit for waiting runs and ignores unrelated releases", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("other", "holder", {}, ["computer:vm"]);
  const waits = ["a", "b", "c"].map(id => runs.admit("bot", id, {}));
  const pending = waits.map(run => runs.acquire(run, ["computer:vm", `browser:${run.threadId}`]));
  expect(() => runs.admit("bot", "d", {})).toThrow("three threads");
  const unrelated = runs.admit("third", "unrelated", {}, ["browser:unrelated"]);
  runs.release(unrelated);
  expect((await settled(pending[0])).done).toBe(false);
  runs.release(holder);
  expect(await pending[0]).toBe(true);
  for (const run of waits.slice(1)) runs.cancel(run);
  expect(await Promise.all(pending.slice(1))).toEqual([false, false]);
});

// ── queued automation waits for a free thread slot ───────────────────────
it("queues an automation run past the three-thread limit and serves slots first-in first-out", async () => {
  const runs = new IndependentThreadRuns<object>();
  const held = ["a", "b", "c"].map(id => runs.admit("bot", id, {}));
  const first = runs.admit("bot", "routine-1", {}, [], { queueForSlot: true });
  const second = runs.admit("bot", "routine-2", {}, [], { queueForSlot: true });
  const shown: string[] = [];
  const firstSlot = runs.awaitSlot(first, () => shown.push("routine-1"));
  const secondSlot = runs.awaitSlot(second, () => shown.push("routine-2"));
  expect(shown).toEqual(["routine-1", "routine-2"]);
  expect((await settled(firstSlot)).done).toBe(false);
  // A direct chat cannot take a slot ahead of a queued automation run.
  expect(() => runs.admit("bot", "chat", {})).toThrow("three threads");
  // Another bot's release frees nothing here.
  runs.release(runs.admit("other", "elsewhere", {}));
  expect((await settled(firstSlot)).done).toBe(false);
  runs.release(held[0]);
  expect(await firstSlot).toBe(true);
  expect((await settled(secondSlot)).done).toBe(false);
  expect(() => runs.admit("bot", "chat", {})).toThrow("three threads");
  runs.release(held[1]);
  expect(await secondSlot).toBe(true);
  runs.release(held[2]);
  expect(runs.admit("bot", "chat", {}).threadId).toBe("chat");
});
it("grants a slot at once while one is free and never waits a run admitted with a slot", async () => {
  const runs = new IndependentThreadRuns<object>();
  runs.admit("bot", "a", {});
  const routine = runs.admit("bot", "routine", {}, [], { queueForSlot: true });
  let shown = false;
  expect(await runs.awaitSlot(routine, () => { shown = true; })).toBe(true);
  expect(shown).toBe(false);
  const direct = runs.admit("bot", "b", {});
  expect(await runs.awaitSlot(direct)).toBe(true);
});
it("stopping or releasing a run queued for a slot resolves false and hands the slot on", async () => {
  const runs = new IndependentThreadRuns<object>();
  const held = ["a", "b", "c"].map(id => runs.admit("bot", id, {}));
  const stopped = runs.admit("bot", "stopped", {}, [], { queueForSlot: true });
  const reloaded = runs.admit("bot", "reloaded", {}, [], { queueForSlot: true });
  const next = runs.admit("bot", "next", {}, [], { queueForSlot: true });
  const stoppedSlot = runs.awaitSlot(stopped), reloadedSlot = runs.awaitSlot(reloaded), nextSlot = runs.awaitSlot(next);
  expect(runs.cancel(stopped)).toBe(true);
  expect(await stoppedSlot).toBe(false);
  expect(runs.release(reloaded)).toBe(true);
  expect(await reloadedSlot).toBe(false);
  expect((await settled(nextSlot)).done).toBe(false);
  // Releasing a run that never held a slot frees none; the next real release goes to the next waiter.
  runs.release(stopped);
  expect((await settled(nextSlot)).done).toBe(false);
  runs.release(held[0]);
  expect(await nextSlot).toBe(true);
  expect(await runs.awaitSlot(stopped)).toBe(false);
});

// W14: acquire() pushed a waiter with no deadline. Stop ends the wait for a
// person who is watching; an unattended queued routine behind a thread that
// never lets go waited forever, and never ran, failed or said why.
it("gives up on a wait that hits its deadline and says so", async () => {
  vi.useFakeTimers();
  try {
    const runs = new IndependentThreadRuns<object>();
    runs.admit("bot", "holder", {}, ["computer:bot:x"]);
    const waiter = runs.admit("bot", "waiter", {});
    const waiting = runs.acquire(waiter, ["computer:bot:x"], undefined, 60_000);
    const settled = waiting.then(() => "granted").catch((error: Error) => error.name);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(runs.waiting(waiter)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBe("ResourceWaitTimeout");
  } finally { vi.useRealTimers(); }
});

// The hazard the deadline must avoid: a bare Promise.race abandons the caller
// but leaves the waiter QUEUED, so the next release hands it the computer on
// behalf of a turn that has already failed, with nobody left to release it.
it("removes the expired waiter from the queue instead of letting it win later", async () => {
  vi.useFakeTimers();
  try {
    const runs = new IndependentThreadRuns<object>();
    const holder = runs.admit("bot", "holder", {}, ["computer:bot:x"]);
    const waiter = runs.admit("bot", "waiter", {});
    const expired = runs.acquire(waiter, ["computer:bot:x"], undefined, 60_000).catch(() => "expired");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await expired).toBe("expired");
    expect(runs.waiting(waiter)).toBe(false);
    runs.release(holder);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs.owns(waiter, "computer:bot:x")).toBe(false);
  } finally { vi.useRealTimers(); }
});

// An expired waiter must not take the thread behind it down with it.
it("lets the next waiter in once an expired one leaves the queue", async () => {
  vi.useFakeTimers();
  try {
    const runs = new IndependentThreadRuns<object>();
    const holder = runs.admit("bot", "holder", {}, ["computer:bot:x"]);
    const first = runs.admit("bot", "first", {});
    const second = runs.admit("bot", "second", {});
    const expiring = runs.acquire(first, ["computer:bot:x"], undefined, 60_000).catch(() => "expired");
    const patient = runs.acquire(second, ["computer:bot:x"]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await expiring).toBe("expired");
    runs.release(holder);
    expect(await patient).toBe(true);
    expect(runs.owns(second, "computer:bot:x")).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("a granted wait clears its timer and never rejects afterwards", async () => {
  vi.useFakeTimers();
  try {
    const runs = new IndependentThreadRuns<object>();
    const holder = runs.admit("bot", "holder", {}, ["computer:bot:x"]);
    const waiter = runs.admit("bot", "waiter", {});
    const waiting = runs.acquire(waiter, ["computer:bot:x"], undefined, 60_000);
    runs.release(holder);
    expect(await waiting).toBe(true);
    let rejected = false;
    void waiting.catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rejected).toBe(false);
    expect(runs.owns(waiter, "computer:bot:x")).toBe(true);
  } finally { vi.useRealTimers(); }
});

// W14, the other half: a turn claims the bot's computer optimistically and
// must be able to hand back what it did not mount, without dropping its
// working folder and without disturbing the generation that replaced it.
it("releases part of a turn's claims and admits whoever was queued behind them", async () => {
  const runs = new IndependentThreadRuns<object>();
  const holder = runs.admit("bot", "holder", {}, ["computer:bot:x", "screen:bot:x", "workspace:/project"]);
  const waiter = runs.admit("bot", "waiter", {});
  const waiting = runs.acquire(waiter, ["computer:bot:x"]);
  expect(runs.releaseResources(holder, ["computer:bot:x", "screen:bot:x"])).toEqual(["computer:bot:x", "screen:bot:x"]);
  expect(await waiting).toBe(true);
  expect(runs.owns(holder, "workspace:/project")).toBe(true);
  expect(runs.owns(holder, "computer:bot:x")).toBe(false);
});
it("ignores a partial release from a generation that has been replaced", () => {
  const runs = new IndependentThreadRuns<object>();
  const stale = runs.admit("bot", "thread", {}, ["computer:bot:x"]);
  runs.release(stale);
  const current = runs.admit("bot", "thread", {}, ["computer:bot:x"]);
  expect(runs.releaseResources(stale, ["computer:bot:x"])).toEqual([]);
  expect(runs.owns(current, "computer:bot:x")).toBe(true);
});
