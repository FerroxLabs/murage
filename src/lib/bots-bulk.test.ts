// Settings v10 A9-bots (roster): the Bots page's bulk level and Move all, on the real helpers with a fake api.
import { describe, expect, it } from "vitest";

import type { NoLimitsPlan } from "../../shared/settings-v10/no-limits-plan";
import { applyBulkLevel, commitMoveAll, moveAllReview, reviewBulkLevel } from "./bots-bulk";

const plan: NoLimitsPlan = {
  digest: "d1",
  bots: [
    ...Array.from({ length: 34 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, archived: false, levelCleared: null })),
    { id: "a1", name: "Old one", archived: true, levelCleared: "auto" as const },
    { id: "a2", name: "Old two", archived: true, levelCleared: null },
  ],
  routines: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, name: `Routine ${i}`, botId: `b${i}`, levelCleared: (["ask", "auto", "full"] as const)[i % 3], pendingApprovalWithdrawn: i === 0 })),
  chats: [
    { id: "c0", name: "Q4 board pack", botId: "b1", levelCleared: "unlimited", guest: false },
    { id: "c1", name: "Hiring plan", botId: "b2", levelCleared: "auto", guest: false },
    { id: "c2", name: "Payroll", botId: "b3", levelCleared: "full", guest: false },
    { id: "c3", name: "Shop front", botId: "b4", levelCleared: "ask", guest: true },
  ],
};

describe("moveAllReview", () => {
  it("names every routine and chat with its bot and the level it loses, from the plan", () => {
    const view = moveAllReview(plan);
    expect(view.activeBots).toBe(34);
    expect(view.archivedBots).toBe(2);
    expect(view.routines).toHaveLength(6);
    expect(view.chats).toHaveLength(4);
    expect(view.routines[1]).toEqual({ id: "r1", text: "Routine 1 (Bot 1), at Auto", withdrawn: false });
    expect(view.routines[0].withdrawn).toBe(true);
    expect(view.chats[0].text).toBe("Q4 board pack (Bot 1), at No limits");
    expect(view.chats[3]).toMatchObject({ text: "Shop front (Bot 4), at Ask", guest: true });
  });
});

describe("commitMoveAll", () => {
  it("posts the reviewed set id and reads Moved", async () => {
    const calls: unknown[] = [];
    const api = async (path: string, init?: RequestInit) => { calls.push([path, JSON.parse(String(init?.body))]); return { result: "moved", plan }; };
    expect(await commitMoveAll(api, plan)).toMatchObject({ kind: "moved" });
    expect(calls).toEqual([["/api/permissions/no-limits", { reviewedSetId: "d1" }]]);
  });
  it("a changed list moves nothing and hands back the new plan", async () => {
    const next = { ...plan, digest: "d2" };
    const api = async () => { throw Object.assign(new Error("changed"), { status: 409, body: { error: "PLAN_CHANGED", plan: next } }); };
    expect(await commitMoveAll(api, plan)).toEqual({ kind: "changed", plan: next });
  });
  it("Not moved and Pending are told apart, and a bare failure is never Moved", async () => {
    expect(await commitMoveAll(async () => ({ result: "notMoved", plan, error: "x" }), plan)).toMatchObject({ kind: "notMoved" });
    expect(await commitMoveAll(async () => ({ result: "pending" }), plan)).toEqual({ kind: "pending" });
    // A refusal the server sent is a sure Not moved; a lost reply or a 503 may follow a commit, so it is Pending, never Moved or Not moved.
    expect(await commitMoveAll(async () => { throw Object.assign(new Error("Choose No limits first."), { status: 409, body: { error: "other" } }); }, plan)).toMatchObject({ kind: "notMoved" });
    expect(await commitMoveAll(async () => { throw new Error("offline"); }, plan)).toEqual({ kind: "pending" });
    expect(await commitMoveAll(async () => { throw Object.assign(new Error("reconnecting"), { status: 503 }); }, plan)).toEqual({ kind: "pending" });
  });
});

const bot = (id: string, over: object = {}) => ({ id, name: id.toUpperCase(), autoApprove: false, fullAccess: false, noLimits: false, ...over });

describe("bulk level", () => {
  const deps = (log: string[], opts: { stale?: string } = {}) => ({
    api: async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      log.push(`${init?.method ?? "GET"} ${path} ${JSON.stringify(body)}`);
      if (path.endsWith("/permissions/refresh")) return { previewId: "p", rosterId: "r", targetLevel: body.targetLevel, botLevel: "ask", botRev: 4, eligible: [], skipped: [], routines: [] };
      if (init?.method === "PATCH" && path.includes(opts.stale ?? "\u0000")) throw Object.assign(new Error("stale"), { status: 409, body: { code: "preview_stale", level: "auto", permissionRev: 9 } });
      return { permissionRev: 5 };
    },
    flush: async () => {},
    onBot: () => {},
  });

  it("Ask saves at once; a raise reviews each bot with its own preview and acknowledgements", async () => {
    const log: string[] = [];
    const review = await reviewBulkLevel(deps(log), [{ bot: bot("a", { autoApprove: true }), drivesComputer: false }, { bot: bot("b"), drivesComputer: true }], "full");
    expect(review.map((r) => [r.botId, r.preview?.previewId ?? null, r.acks])).toEqual([["a", "p", { acknowledgeFullAccess: true }], ["b", "p", { acknowledgeFullAccess: true, acknowledgeLocalAuto: true }]]);
    const none = await reviewBulkLevel(deps([]), [{ bot: bot("a", { fullAccess: true }), drivesComputer: false }], "ask");
    expect(none[0].preview).toBeNull();
  });
  it("applies each bot by itself; a bot changed since the review is not saved and says so", async () => {
    const log: string[] = [];
    const d = deps(log, { stale: "/api/bots/b" });
    const review = await reviewBulkLevel(d, [{ bot: bot("a"), drivesComputer: false }, { bot: bot("b"), drivesComputer: false }, { bot: bot("c"), drivesComputer: false }], "auto");
    const out = await applyBulkLevel(d, review, "auto", true);
    expect(out.map((o) => [o.botId, o.state])).toEqual([["a", "saved"], ["b", "changed"], ["c", "saved"]]);
    expect(log.filter((l) => l.startsWith("PATCH")).length).toBe(3);
  });
});
