import { expect, it, vi } from "vitest";
import { readPlanUsage } from "./plan-usage-read";
import { planUsageReport, refreshPlanUsage } from "../../server/plan-usage-report.ts";
import type { PlanObservation } from "../../shared/plan-usage.ts";

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

// Use the real report builder: positional IDs would hide a replacement account.
it.each([1, 33])("rejects Refresh when a target vanishes among %i accounts", async (count) => {
  vi.useFakeTimers();
  try {
    const keys = Array.from({ length: count }, (_, i) => `codex:codex:b${i}`);
    const service = fake(keys);
    const names = { ...labels, bot: () => "Same display name" };
    let pending = true;
    service.refreshing = () => pending;
    const read = vi.fn(async () => {
      if (pending) {
        const initial = refreshPlanUsage(service, names, 10);
        keys.shift();
        pending = false;
        return initial;
      }
      return planUsageReport(service, names, 20);
    });
    const work = readPlanUsage(read, vi.fn(), new AbortController().signal, true);
    const rejected = expect(work).rejects.toThrow("Plan usage read did not complete");
    await Promise.all([rejected, vi.advanceTimersByTimeAsync(1_000)]);
  } finally { vi.useRealTimers(); }
});

