import { expect, it } from "vitest";
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
