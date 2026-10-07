import { describe, expect, it, vi } from "vitest";
import { RELAY_DOWN_WAIT_MS, pushStatusCurrent, reportBadge, syncPush, type PushDeps } from "./push-enrol";

const TOKENS = { bindingId: "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", detail: "murage_pd_" + "A".repeat(43), respond: "murage_pr_" + "B".repeat(43), expiresAt: 1 };
function deps(native: Record<string, unknown>, routes: Record<string, { status: number; body: unknown }>): PushDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    has: (m) => m in native || m === "issuePushTokens",
    call: vi.fn(async (m: string, arg?: unknown) => {
      calls.push(`${m}:${JSON.stringify(arg ?? null)}`);
      const v = native[m];
      return typeof v === "function" ? (v as (a: unknown) => unknown)(arg) : v;
    }),
    post: vi.fn(async (path: string) => { calls.push(`POST ${path}`); return routes[path] ?? { status: 404, body: {} }; }),
    get: vi.fn(async (path: string) => routes[path] ?? { status: 404, body: {} }),
  };
}

describe("syncPush", () => {
  it("rechecks an earlier host-off answer on an explicit Turn on, while resumes wait out the timer", async () => {
    const routes = { "/api/mobile/push/enrol": { status: 503, body: { code: "push_off" } as unknown } };
    const phone = deps({ registerPush: { status: "granted", grant: "murage_pg_" + "C".repeat(43) }, issuePushTokens: true }, routes);
    expect(await syncPush(phone)).toBe("hostOff");
    routes["/api/mobile/push/enrol"] = { status: 200, body: TOKENS };
    expect(await syncPush(phone)).toBe("hostOff");
    // Every resume minting a relay grant would spend the phone's relay limits.
    for (let i = 0; i < 5; i++) expect(await syncPush(phone, "foreground")).toBe("hostOff");
    expect(phone.calls.filter((c) => c.startsWith("registerPush"))).toHaveLength(1);
    expect(phone.post).toHaveBeenCalledTimes(1);
    expect(await syncPush(phone, "manual")).toBe("enrolled");
    expect(phone.post).toHaveBeenCalledTimes(2);
  });
  it("rechecks when the phone reports a changed permission state", async () => {
    let permission = "denied";
    const routes = { "/api/mobile/push/enrol": { status: 503, body: { code: "push_off" } as unknown } };
    const phone = deps({ pushStatus: () => ({ permission }), registerPush: { status: "granted", grant: "murage_pg_" + "C".repeat(43) }, issuePushTokens: true }, routes);
    expect(await syncPush(phone)).toBe("hostOff");
    permission = "granted";
    routes["/api/mobile/push/enrol"] = { status: 200, body: TOKENS };
    expect(await syncPush(phone)).toBe("enrolled");
    expect(phone.post).toHaveBeenCalledTimes(2);
  });
  it("expires the host-off latch without a retry loop", async () => {
    vi.useFakeTimers();
    try {
      const phone = deps({ registerPush: { status: "granted", grant: "murage_pg_" + "C".repeat(43) } },
        { "/api/mobile/push/enrol": { status: 503, body: { code: "push_off" } } });
      await syncPush(phone);
      for (let i = 0; i < 10; i++) await syncPush(phone);
      expect(phone.post).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(phone.post).toHaveBeenCalledTimes(1);
      await syncPush(phone);
      expect(phone.post).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("does nothing in an app without registerPush", async () => {
    expect(await syncPush(deps({}, {}))).toBe("off");
  });
  it("enrols a new binding: grant to the host, tokens to native", async () => {
    const d = deps({ registerPush: { status: "granted", bindingId: TOKENS.bindingId, grant: "murage_pg_" + "C".repeat(43) }, issuePushTokens: true },
      { "/api/mobile/push/enrol": { status: 200, body: TOKENS } });
    expect(await syncPush(d)).toBe("enrolled");
    expect(d.calls).toEqual([`registerPush:{"fresh":false}`, "POST /api/mobile/push/enrol", `issuePushTokens:${JSON.stringify(TOKENS)}`]);
  });
  it("reissues tokens on every open once enrolled", async () => {
    const d = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 200, body: TOKENS } });
    expect(await syncPush(d)).toBe("enrolled");
    expect(d.calls).toContain("POST /api/mobile/push/tokens");
  });
  it("enrols afresh when the host no longer knows the binding (a restored or re-paired computer)", async () => {
    let first = true;
    const d = deps({
      registerPush: (arg: { fresh: boolean }) => (first && !arg.fresh ? ((first = false), { status: "enrolled", bindingId: TOKENS.bindingId }) : { status: "granted", bindingId: TOKENS.bindingId, grant: "murage_pg_" + "C".repeat(43) }),
      issuePushTokens: true,
    }, { "/api/mobile/push/tokens": { status: 404, body: { code: "not_enrolled" } }, "/api/mobile/push/enrol": { status: 200, body: TOKENS } });
    expect(await syncPush(d)).toBe("enrolled");
    expect(d.calls).toContain(`registerPush:{"fresh":true}`);
  });
  const OLD = "2e5b0941-7c0d-4a69-8b1d-4f9c6d30a8e2";
  const GRANT = "murage_pg_" + "C".repeat(43);
  it("tokens for another binding enrols afresh once", async () => {
    // The host took a replace this phone never committed (the app died in between).
    const TOKENS2 = { ...TOKENS, bindingId: "4a7d2b63-9e2f-4c8b-8d3f-6b1e8f52c0a4" };
    const d = deps({
      registerPush: (arg: { fresh: boolean }) => (arg.fresh ? { status: "granted", bindingId: TOKENS2.bindingId, grant: GRANT } : { status: "enrolled", bindingId: OLD }),
      issuePushTokens: (t: { bindingId: string }) => { if (t.bindingId !== TOKENS2.bindingId) throw new Error("unavailable"); return true; },
    }, { "/api/mobile/push/tokens": { status: 200, body: TOKENS }, "/api/mobile/push/enrol": { status: 200, body: TOKENS2 } });
    expect(await syncPush(d)).toBe("enrolled");
    expect(d.calls).toEqual([
      `registerPush:{"fresh":false}`, "POST /api/mobile/push/tokens", `issuePushTokens:${JSON.stringify(TOKENS)}`,
      `registerPush:{"fresh":true}`, "POST /api/mobile/push/enrol", `issuePushTokens:${JSON.stringify(TOKENS2)}`,
    ]);
  });
  it("tokens for the binding a pending replace waits on are adopted, with no new binding", async () => {
    const d = deps({ registerPush: { status: "enrolled", bindingId: OLD }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 200, body: TOKENS } });
    expect(await syncPush(d)).toBe("enrolled");
    expect(d.calls).not.toContain(`registerPush:{"fresh":true}`);
  });
  it("tokens for another binding enrol afresh at most once per sync", async () => {
    // A misbehaving native that answers "enrolled" even to fresh: still two registerPush calls, then failed.
    const d = deps({ registerPush: { status: "enrolled", bindingId: OLD }, issuePushTokens: () => { throw new Error("unavailable"); } },
      { "/api/mobile/push/tokens": { status: 200, body: TOKENS } });
    expect(await syncPush(d)).toBe("failed");
    expect(d.calls.filter((c) => c.startsWith("registerPush"))).toEqual([`registerPush:{"fresh":false}`, `registerPush:{"fresh":true}`]);
  });
  it("a 503 from /tokens is failed, not a fresh enrolment", async () => {
    for (const answer of [{ status: 503, body: { error: "Murage is not answering on this computer." } }, { status: 404, body: {} }, { status: 502, body: null }]) {
      const d = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: true },
        { "/api/mobile/push/tokens": answer });
      expect(await syncPush(d), JSON.stringify(answer)).toBe("failed");
      expect(d.calls).toEqual([`registerPush:{"fresh":false}`, "POST /api/mobile/push/tokens"]);
    }
  });
  it("a phone that refuses while locked or leaving is failed, and nothing else runs", async () => {
    const d = deps({ registerPush: () => { throw new Error("unavailable"); }, issuePushTokens: true }, {});
    expect(await syncPush(d)).toBe("failed");
    expect(d.calls).toEqual([`registerPush:{"fresh":false}`]);
    const refused = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: () => { throw new Error("unavailable"); } },
      { "/api/mobile/push/tokens": { status: 200, body: TOKENS } });
    expect(await syncPush(refused)).toBe("failed");
    expect(refused.calls).not.toContain(`registerPush:{"fresh":true}`);
  });
  it("stops quietly on no, on an unsupported phone, and on a host that says push is off", async () => {
    expect(await syncPush(deps({ registerPush: { status: "denied" } }, {}))).toBe("denied");
    expect(await syncPush(deps({ registerPush: { status: "unsupported" } }, {}))).toBe("unsupported");
  });
  it("a host that cannot reach the relay makes the page wait before asking for another binding (final re-review N3)", async () => {
    vi.useFakeTimers();
    try {
      const phone = deps({ registerPush: { status: "granted", bindingId: TOKENS.bindingId, grant: "murage_pg_" + "D".repeat(43) } },
        { "/api/mobile/push/enrol": { status: 503, body: { code: "relay_unavailable" } } });
      expect(await syncPush(phone)).toBe("failed");
      expect(await syncPush(phone)).toBe("failed");
      expect(phone.calls).toEqual([`registerPush:{"fresh":false}`, "POST /api/mobile/push/enrol"]);
      vi.advanceTimersByTime(RELAY_DOWN_WAIT_MS + 1);
      await syncPush(phone);
      expect(phone.calls.filter((c) => c.startsWith("registerPush"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a host with push off stops the page asking the phone for a binding (final review I1)", async () => {
    // A fresh phone: one grant, refused with push_off; every later sync is quiet.
    const fresh = deps({ registerPush: { status: "granted", bindingId: TOKENS.bindingId, grant: "murage_pg_" + "C".repeat(43) } },
      { "/api/mobile/push/enrol": { status: 503, body: { code: "push_off" } } });
    expect(await syncPush(fresh)).toBe("hostOff");
    expect(await syncPush(fresh)).toBe("hostOff");
    expect(fresh.calls).toEqual([`registerPush:{"fresh":false}`, "POST /api/mobile/push/enrol"]);
    // An enrolled phone: /tokens says push_off, so no replace and no new binding.
    const enrolled = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 503, body: { code: "push_off" } } });
    expect(await syncPush(enrolled)).toBe("hostOff");
    expect(await syncPush(enrolled)).toBe("hostOff");
    expect(enrolled.calls).toEqual([`registerPush:{"fresh":false}`, "POST /api/mobile/push/tokens"]);
    // A plain outage is not push off: the next sync tries again.
    const down = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 503, body: { error: "Murage is not answering on this computer." } } });
    expect(await syncPush(down)).toBe("failed");
    expect(await syncPush(down)).toBe("failed");
    expect(down.calls.filter((c) => c.startsWith("registerPush"))).toHaveLength(2);
  });
  it("overlapping syncs share one run, so only one token pair is minted (final review M7)", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    const d = deps({ registerPush: async () => { await gate; return { status: "enrolled", bindingId: TOKENS.bindingId }; }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 200, body: TOKENS } });
    const a = syncPush(d);
    const b = syncPush(d);
    release(null);
    expect(await Promise.all([a, b])).toEqual(["enrolled", "enrolled"]);
    expect(d.calls.filter((c) => c === "POST /api/mobile/push/tokens")).toHaveLength(1);
    expect(await syncPush(d)).toBe("enrolled"); // a later sync runs again
    expect(d.calls.filter((c) => c === "POST /api/mobile/push/tokens")).toHaveLength(2);
  });
  it("never hands native a malformed token set", async () => {
    const d = deps({ registerPush: { status: "enrolled", bindingId: TOKENS.bindingId }, issuePushTokens: true },
      { "/api/mobile/push/tokens": { status: 200, body: { ...TOKENS, detail: "nope" } } });
    expect(await syncPush(d)).toBe("failed");
    expect(d.calls.some((c) => c.startsWith("issuePushTokens"))).toBe(false);
  });
});

describe("reportBadge", () => {
  it("sends the Inbox's decision count to native", async () => {
    const d = deps({ setBadgeCount: true }, { "/api/inbox?view=decisions&page=0&pageSize=1": { status: 200, body: { decisions: 4 } } });
    await reportBadge(d);
    expect(d.calls).toContain("setBadgeCount:4");
  });
});

describe("pushStatusCurrent", () => {
  const now = 1_000_000;
  it("is on only for granted, enrolled and not expired", () => {
    expect(pushStatusCurrent({ permission: "granted", enrolled: true, expiresAt: now + 1 }, now)).toBe(true);
    expect(pushStatusCurrent({ permission: "granted", enrolled: true, expiresAt: now }, now)).toBe(false);
    expect(pushStatusCurrent({ permission: "granted", enrolled: true, expiresAt: now - 1 }, now)).toBe(false);
  });
  it("a shell that reports no expiry keeps its old meaning", () => {
    expect(pushStatusCurrent({ permission: "granted", enrolled: true }, now)).toBe(true);
    expect(pushStatusCurrent({ permission: "granted", enrolled: true, expiresAt: "soon" as unknown as number }, now)).toBe(true);
  });
  it("not enrolled or not granted is off whatever the expiry", () => {
    expect(pushStatusCurrent({ permission: "granted", enrolled: false, expiresAt: now + 5 }, now)).toBe(false);
    expect(pushStatusCurrent({ permission: "denied", enrolled: true, expiresAt: now + 5 }, now)).toBe(false);
  });
});
