// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PlanUsageReport } from "./plan-usage-view";

type Read = (path: string, init: RequestInit) => Promise<unknown>;

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Follow the queued/running read without making any additional engine demand. */
export async function readPlanUsage(read: Read, take: (report: PlanUsageReport, requestStarted: number) => void, signal: AbortSignal, refresh = false, cursor = 0): Promise<void> {
  // A full 32-account page can take minutes through the service's shared token bucket.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Plan usage read timed out")), 5 * 60_000);
  const bounded = AbortSignal.any([signal, deadline.signal]);
  try {
    let first = true;
    let targets: string[] | undefined;
    for (;;) {
      bounded.throwIfAborted();
      const post = first && refresh;
      const path = post ? "/api/plan-usage/refresh" : "/api/plan-usage";
      const requestStarted = performance.now();
      const report = await read(path + (cursor ? `?cursor=${cursor}` : ""), { method: post ? "POST" : "GET", signal: bounded }) as PlanUsageReport;
      bounded.throwIfAborted();
      if (!report || !Array.isArray(report.accounts) || !Number.isFinite(report.serverNow)) throw new Error("Invalid plan usage report");
      take(report, requestStarted);
      if (refresh) {
        targets ??= report.accounts.map((row) => row.id);
        if (!targets.length || targets.some((id) => !report.accounts.some((row) => row.id === id))) {
          throw new Error("Plan usage read did not complete");
        }
      }
      if (!report.accounts.some((row) => row.refreshing)) {
        if (refresh && report.accounts.some((row) => row.status !== "current")) throw new Error("Plan usage read did not complete");
        return;
      }
      first = false;
      await delay(bounded);
    }
  } finally {
    clearTimeout(timer);
  }
}
