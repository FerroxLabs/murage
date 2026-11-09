import { describe, expect, it } from "vitest";
import { PLAN_REPORT_PAGE, planCursor, parsePlanSubject, planUsageReport, refreshPlanUsage } from "./plan-usage-report.ts";
import { routePolicy } from "./route-policy.ts";
import type { PlanObservation } from "../shared/plan-usage.ts";

const window = { bucketId: "codex", windowId: "primary", label: "5-hour window", scope: "account" as const, model: null, usedPercent: 72, windowSeconds: 18000, resetsAt: 1_700_000_000_000, enforcement: "hard" as const, limitKind: null };
const obs = (subjectKey: string): PlanObservation => ({
  subjectKey, credentialRevision: "rev-secret-0123", source: "native-rpc", status: "current", reason: null,
  observedAt: 10, lastAttemptAt: 10, lastSuccessAt: 10, freshUntil: 60_010, retryAt: null, windows: [window],
});
function fake(keys: string[]) {
  const demanded: string[][] = [];
  return {
    demanded,
    allSubjectKeys: () => keys,
    refreshing: (k: string) => k.endsWith(":busy"),
    observation: obs,
    demand: (k: readonly string[], o?: { owner?: boolean }) => { expect(o?.owner).toBe(true); demanded.push([...k]); },
  };
}
const labels = {
  engine: (id: string) => (id === "codex" ? "Codex" : undefined),
  bot: (id: string) => (id === "b1" ? "Ada" : id === "b2" ? "Bo" : undefined),
};

describe("DG8 plan usage report", () => {
  it("parses the Codex subject key", () => {
    expect(parsePlanSubject("codex:codex:owner")).toEqual({ engineKind: "codex", instanceId: "codex", botId: null });
    expect(parsePlanSubject("codex:codex:b1")?.botId).toBe("b1");
    expect(parsePlanSubject("../etc")).toBeNull();
  });

  it("labels rows and never sends the credential revision or subject key", () => {
    const report = planUsageReport(fake(["codex:codex:owner", "codex:codex:b1", "codex:gone:b1", "codex:codex:gone"]), labels, 99);
    expect(report.accounts.map((a) => [a.engine, a.bot])).toEqual([["Codex", null], ["Codex", "Ada"]]);
    expect(report.accounts[0].windows[0]).toEqual({ label: "5-hour window", usedPercent: 72, resetsAt: 1_700_000_000_000, windowSeconds: 18000, limitReached: false });
    const wire = JSON.stringify(report);
    expect(wire).not.toContain("rev-secret");
    expect(wire).not.toContain("codex:codex");
    expect(report.serverNow).toBe(99);
    expect(report.accounts[0].freshUntil).toBe(60_010);
  });

  it("G25 scope: one bot sees only its own account", () => {
    const report = planUsageReport(fake(["codex:codex:owner", "codex:codex:b1", "codex:codex:b2"]), labels, 1, { onlyBotId: "b2" });
    expect(report.accounts.map((a) => a.bot)).toEqual(["Bo"]);
  });

  it("Refresh asks only for listed running accounts, as the owner", () => {
    const service = fake(["codex:codex:owner", "codex:gone:b1"]);
    const report = refreshPlanUsage(service, labels, 5);
    expect(service.demanded).toEqual([["codex:codex:owner"]]);
    expect(report.accounts).toHaveLength(1);
  });

  it("both routes are owner desktop reads", () => {
    expect(routePolicy("GET", "/api/plan-usage")?.class).toBe("desktop");
    expect(routePolicy("POST", "/api/plan-usage/refresh")?.class).toBe("desktop");
  });

  it("filters live accounts over the full set before the 32 cap, pages, and counts the rest", () => {
    const gone = Array.from({ length: 40 }, (_, i) => `codex:gone:x${i}`);
    const live = Array.from({ length: 34 }, (_, i) => (i === 0 ? "codex:codex:owner" : "codex:codex:b1"));
    const report = planUsageReport(fake([...gone, ...live]), labels, 1);
    expect(report.accounts).toHaveLength(PLAN_REPORT_PAGE);
    expect(report.omitted).toBe(2);
    expect(report.nextCursor).toBe(32);
    const pagingService = fake([...gone, ...live]);
    const next = planUsageReport(pagingService, labels, 1, { cursor: 32 });
    expect(next.accounts).toHaveLength(2);
    const expectedRow = {
      engine: "Codex", bot: "Ada", status: "current", reason: null, source: "native-rpc",
      checkedAt: 10, freshUntil: 60_010, refreshing: false,
      windows: [{ label: "5-hour window", usedPercent: 72, resetsAt: 1_700_000_000_000, windowSeconds: 18000, limitReached: false }],
    };
    expect(next.accounts.map(({ id, ...row }) => row)).toEqual([expectedRow, expectedRow]);
    expect(next.accounts.map((a) => a.id)).toEqual(planUsageReport(pagingService, labels, 2, { cursor: 32 }).accounts.map((a) => a.id));
    expect(next.accounts.every((a) => /^[a-f0-9]{64}$/.test(a.id))).toBe(true);
    expect([next.omitted, next.nextCursor]).toEqual([0, null]);
    const service = fake([...gone, ...live]);
    refreshPlanUsage(service, labels, 1, { cursor: 32 });
    expect(service.demanded).toEqual([["codex:codex:b1", "codex:codex:b1"]]);
  });

  it("reports refreshing apart from status and marks a Cloud home", () => {
    const report = planUsageReport(fake(["codex:codex:owner", "codex:codex:b1"]), { ...labels, bot: () => "Ada" }, 1, { cloud: true });
    expect(report.accounts.every((a) => a.refreshing === false && a.status === "current")).toBe(true);
    expect(report.cloud).toBe(true);
    const busy = planUsageReport(fake(["codex:codex:busy"]), { ...labels, bot: () => "Ada" }, 1);
    expect(busy.accounts[0]).toMatchObject({ status: "current", refreshing: true, windows: [{ usedPercent: 72 }] });
  });

  it("bounds the cursor", () => {
    expect([planCursor("5"), planCursor("-1"), planCursor("1e3"), planCursor("9999999"), planCursor(null)]).toEqual([5, 0, 0, 0, 0]);
  });
});

it("keeps opaque account IDs stable when another account leaves", () => {
  const keys = ["codex:codex:owner", "codex:codex:b1", "codex:codex:b2"];
  const service = fake(keys);
  const before = planUsageReport(service, labels, 10);
  keys.shift();
  const after = planUsageReport(service, labels, 20);
  expect(after.accounts.map((row) => row.id)).toEqual(before.accounts.slice(1).map((row) => row.id));
  expect(new Set(before.accounts.map((row) => row.id)).size).toBe(3);
  expect(JSON.stringify(after)).not.toContain("codex:codex");
});
