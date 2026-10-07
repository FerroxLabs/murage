import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { respondFromPush } from "./mobile-push-respond.ts";
import { pushRiskFor, ratePushRevision } from "./mobile-push-risk.ts";

// Local-computer control is never allowed straight from a notification: the
// stop line exempts the `computer` server, so without the scope a coordinate
// click rated "low" and the lock screen could Allow it.
const BINDING = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const click = { x: 100, y: 200 };
const ws = () => true;

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: BINDING, deviceId: "d1", publisherToken: "murage_pt_x", createdAt: 1 });
  store.insertEvent({ eventRef: "a".repeat(64), bindingId: BINDING, kind: "approval", category: "approval", botId: "lena", threadId: "t1", requestId: "req-1",
    messageId: "m1", collapseKey: "c".repeat(32), threadGroup: "g".repeat(16), revision: 1, timeSensitive: true, resolvedBy: null,
    createdAt: 0, expiresAt: 10_000, holdUntil: 0, state: "sent", attempts: 1, nextAttemptAt: 0 });
  return store;
}
const allow = (store: PushStore, card: () => unknown) => respondFromPush(
  { deviceId: "d1", bindingId: BINDING, body: { requestId: "req-1", decision: "allow", revision: 1 } },
  { store, now: () => 5000, visible: () => true, liveRating: () => "low", card: card as never, answer: vi.fn(async () => "allowed-once"), log: () => {} });
const deny = (store: PushStore, card: () => unknown) => respondFromPush(
  { deviceId: "d1", bindingId: BINDING, body: { requestId: "req-1", decision: "deny", revision: 1 } },
  { store, now: () => 5000, visible: () => true, liveRating: () => "low", card: card as never, answer: vi.fn(async () => "rejected"), log: () => {} });

describe("local-computer scope forces step-up on push", () => {
  it("(a) a coordinate click in local-computer scope rates risky, with or without the engine's call", () => {
    const call = { input: click, name: "mcp__computer__click", inside: ws };
    expect(pushRiskFor(null, "mcp__computer__click", "click (100, 200)", { ...call, scope: "local-computer" })).toBe("risky");
    expect(pushRiskFor(null, "mcp__computer__click", "click (100, 200)", { cardOnly: true, scope: "local-computer" })).toBe("risky");
    // fail-closed: any scope value at all
    expect(pushRiskFor(null, "mcp__computer__click", "click", { ...call, scope: "something-new" as never })).toBe("risky");
  });

  it("(b) the revision re-rating keeps it risky, even when the first rating was low", () => {
    const store = fresh();
    store.rateRisk("t1", "req-1", "low", 1);
    const live = { stopHit: null, tool: "mcp__computer__click", summary: "click (100, 200)", inside: ws, scope: "local-computer" };
    expect(ratePushRevision(store, "t1", "req-1", 1, live, 2)).toBe("risky");
    expect(store.risk("t1", "req-1", 1)).toBe("risky");
  });

  it("(c) the responder refuses an Allow when the live card is local-computer, even rated low before the scope changed", async () => {
    const store = fresh();
    store.rateRisk("t1", "req-1", "low", 1, 1);
    const res = await allow(store, () => ({ pending: true, scope: "local-computer" }));
    expect(res).toEqual({ status: 403, body: { code: "step_up", error: "Open Murage to allow this." } });
    // a refused Allow does not use up the decision, and Deny still works
    expect((await deny(store, () => ({ pending: true, scope: "local-computer" }))).status).toBe(200);
  });

  it("(d) a non-computer low-risk request still rates low and its Allow still works", async () => {
    expect(pushRiskFor(null, "Bash", "ls", { input: { command: "ls" }, inside: ws })).toBe("low");
    const store = fresh();
    store.rateRisk("t1", "req-1", "low", 1);
    expect(ratePushRevision(store, "t1", "req-1", 1, { stopHit: null, tool: "Bash", summary: "ls", inside: ws }, 2)).toBe("low");
    expect((await allow(store, () => ({ pending: true }))).status).toBe(200);
  });

  it("index.ts hands the scope to both ratings", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/pushRiskFor\(stopHit, event\.tool, event\.summary, \{[^\n]*scope: event\.approvalScope/);
    const live = source.slice(source.indexOf("function pushLiveContent"), source.indexOf("function pushBadge"));
    expect(live).toContain("card.approvalScope");
    const respond = source.slice(source.indexOf("respond: (input) => respondFromPush"), source.indexOf("answer: async (threadId, requestId, decision)"));
    expect(respond).toContain("approvalScope");
  });
});
