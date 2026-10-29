// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Health details (1.0.9 Sentinel, GAP-SENTINEL-109 section 8.1): one page of open or resolved issues from
// GET /api/sentinel/issues, newest-highest first, with "Show more" through the server's opaque cursor. When Health
// changes between pages the server answers 409 and the list starts again from the top with a note. Every sentence comes
// from the fixed catalogue in shared/sentinel-view.ts; nothing an input wrote is shown.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import {
  HEALTH_COPY, NEXT_ACTION_LABELS, ageLabel, durationLabel, healthTitle,
  type Coverage, type HealthIssue, type HealthIssuesResponse, type IssueState, type NextAction, type Resolution,
} from "../../shared/sentinel-view";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const tab = (selected: boolean) => `min-h-10 rounded-lg border px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${selected
  ? "border-accent bg-accent font-medium text-accent-ink" : "border-hairline/50 bg-control text-ink hover:bg-raised-hover"}`;

export const COVERAGE_LABELS: Readonly<Record<Coverage, string>> = Object.freeze({
  complete: "Every source was checked",
  partial: "Some sources were checked",
  unavailable: "Sources are waiting for fresh information",
  "not-applicable": "No sources apply",
});

/** The recovery state in plain words. Only an observed recovery is ever "Recovered". */
export function recoveryLabel(state: IssueState, resolution?: Resolution): string {
  if (state === "open") return HEALTH_COPY.open;
  if (state === "recovering") return "Improving, still being checked";
  if (resolution === "observed-recovery") return HEALTH_COPY.recovered;
  if (resolution === "policy-ended") return "Closed after the setting changed";
  return "Closed, the source is no longer in use";
}

export function HealthIssueRow({ issue, now, onNavigate }: { issue: HealthIssue; now: number; onNavigate?: (action: NextAction) => void }) {
  const action = NEXT_ACTION_LABELS[issue.nextAction];
  const titleId = `health-issue-${issue.fingerprint.slice(0, 16)}`;
  return <li aria-labelledby={titleId} className="rounded-xl border border-hairline/50 bg-inset p-3 text-[13px]">
    <p id={titleId} className="font-medium text-ink">{healthTitle(issue.titleKey)}</p>
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-ink-secondary sm:grid-cols-2">
      <div><dt className="inline">State: </dt><dd className="inline">{recoveryLabel(issue.state, issue.resolution)}</dd></div>
      <div><dt className="inline">Times seen: </dt><dd className="inline">{issue.count}</dd></div>
      <div><dt className="inline">First seen: </dt><dd className="inline">{ageLabel(issue.firstSeenAt, now)}</dd></div>
      <div><dt className="inline">Last seen: </dt><dd className="inline">{ageLabel(issue.lastSeenAt, now)}</dd></div>
      <div><dt className="inline">Measured over: </dt><dd className="inline">{durationLabel(issue.window.endAt - issue.window.startAt)}</dd></div>
      <div><dt className="inline">Checked sources: </dt><dd className="inline">{COVERAGE_LABELS[issue.coverage.overall] ?? COVERAGE_LABELS.unavailable}</dd></div>
      {issue.resolvedAt !== undefined && <div><dt className="inline">Closed: </dt><dd className="inline">{ageLabel(issue.resolvedAt, now)}</dd></div>}
    </dl>
    {action && onNavigate && <div className="mt-3"><button type="button" className={button} onClick={() => onNavigate(issue.nextAction)}>{action}</button></div>}
  </li>;
}

export function HealthDetails({ onNavigate, initialState = "open" }: { onNavigate?: (action: NextAction) => void; initialState?: "open" | "resolved" }) {
  const [state, setState] = useState<"open" | "resolved">(initialState);
  const [items, setItems] = useState<HealthIssue[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ state, limit: "25" });
    if (after) params.set("after", after);
    setLoading(true);
    void api(`/api/sentinel/issues?${params}`, { signal: controller.signal }).then((page: HealthIssuesResponse) => {
      if (controller.signal.aborted || !page.ok) return;
      setItems(current => (after ? [...current, ...page.items] : page.items));
      setNext(page.next);
      setError(null);
    }).catch((cause: { status?: number }) => {
      if (controller.signal.aborted) return;
      if (cause?.status === 409) { setNote(HEALTH_COPY.refresh); setAfter(null); setItems([]); setGeneration(n => n + 1); return; }
      setError(HEALTH_COPY.unavailable);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [state, after, generation]);
  const choose = (value: "open" | "resolved") => { if (value === state) return; setState(value); setAfter(null); setItems([]); setNext(null); setNote(null); };
  const now = Date.now();
  return <div className="mt-3" aria-busy={loading}>
    <div role="group" aria-label="Health issues" className="flex flex-wrap gap-2">
      <button type="button" className={tab(state === "open")} aria-pressed={state === "open"} onClick={() => choose("open")}>{HEALTH_COPY.open}</button>
      <button type="button" className={tab(state === "resolved")} aria-pressed={state === "resolved"} onClick={() => choose("resolved")}>{HEALTH_COPY.resolved}</button>
    </div>
    {note && <p role="status" className="mt-2 text-[13px] text-ink-secondary">{note}</p>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {!error && !loading && items.length === 0 && <p className="mt-3 text-[13px] text-ink-secondary">{state === "open" ? HEALTH_COPY.noIssues : "Nothing has closed recently."}</p>}
    <ul className="mt-3 space-y-2">{items.map(issue => <HealthIssueRow key={issue.fingerprint} issue={issue} now={now} onNavigate={onNavigate} />)}</ul>
    {next && <div className="mt-3"><button type="button" className={button} disabled={loading} onClick={() => setAfter(next)}>{HEALTH_COPY.loadMore}</button></div>}
  </div>;
}
