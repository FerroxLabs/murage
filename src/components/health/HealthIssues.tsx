// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The issues on the Health screen: identical ones folded to one line with a count and the time, each line answering
// what happened, does it matter, what can I do. Every sentence comes from fixed tables (health-guide.ts); nothing an
// input wrote is shown, except the deletion lines, which are the server's own fixed sentences (ownerNoticeText).
import { useId, useState, type ReactNode } from "react";
import { api, useStore, useStoreIfAny } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useDesktopSurface } from "@/lib/use-surface";
import { owedSettingsLines, retryResultLine, type OwedLine } from "@/lib/deletion-notes";
import { foldHealthRows, type HealthFold, type HealthIssueLevel } from "../../../shared/health-levels";
import {
  HEALTH_COPY, ageLabel, durationLabel, healthTitle, recoveredLine,
  type HealthDigest, type HealthIssue, type HealthIssuesResponse, type IssueState, type NextAction, type Resolution,
} from "../../../shared/sentinel-view";
import { foldTimeLine, goLabel, healthGuide, settingsPagesHere } from "./health-guide";
import { needButton as button } from "./HealthNeedCard";

/** One state's issues, every page, newest-highest first. Health that moves between pages starts again from the top. */
export async function readHealthIssues(state: "open" | "resolved", signal?: AbortSignal, read: typeof api = api): Promise<HealthIssue[]> {
  for (let attempt = 0; ; attempt++) {
    const items: HealthIssue[] = [];
    let after: string | null = null;
    try {
      for (let page = 0; page < 4; page++) {
        const params: URLSearchParams = new URLSearchParams({ state, limit: "50" });
        if (after) params.set("after", after);
        const answer = await read(`/api/sentinel/issues?${params}`, { signal }) as HealthIssuesResponse;
        if (!answer.ok) throw new Error(answer.reason);
        items.push(...answer.items);
        after = answer.next;
        if (!after) break;
      }
      return items;
    } catch (cause) {
      if ((cause as { status?: number })?.status !== 409 || attempt >= 2) throw cause;
    }
  }
}

/** The issues as the owner sees them: an issue shown under another issue's line (presentedBy) adds no line. */
export const healthFolds = (issues: readonly HealthIssue[]): HealthFold<HealthIssue>[] => foldHealthRows(issues.filter((issue) => !issue.presentedBy));

/** The recovery state in plain words. Only an observed recovery is ever "Recovered". */
export function recoveryLabel(state: IssueState, resolution?: Resolution): string {
  if (state === "open") return HEALTH_COPY.open;
  if (state === "recovering") return t("ux.l2b.health.improving");
  if (resolution === "observed-recovery") return HEALTH_COPY.recovered;
  if (resolution === "policy-ended") return "Closed after the setting changed";
  return "Closed, the source is no longer in use";
}

/** The most an issue group says about what is left to clear: engines share a deletion, so these never add up. */
export function deletionFigures(rows: readonly HealthIssue[]): { pending: number; oldestHours: number | null } {
  let pending = 0;
  let oldestHours: number | null = null;
  for (const row of rows) {
    pending = Math.max(pending, row.metrics?.pending ?? 0);
    const hours = row.metrics?.oldestPendingHours;
    if (typeof hours === "number") oldestHours = Math.max(oldestHours ?? 0, hours);
  }
  return { pending, oldestHours };
}

/** Try again now shows only where it can change something: on the computer that holds the files, for a line that is
 * neither waiting for an engine to close nor for Murage's next update. */
export function deletionCanRetry(note: { lines?: OwedLine[] } | null | undefined, desktop: boolean): boolean {
  return desktop && (note?.lines ?? []).some((line) => line.tryAgain && !line.byItself && !line.waitsForUpdate);
}

/** "Does it matter" for deleted conversations, by what the lines are waiting for: a line that waits for Murage's next
 * update is not finished by itself. */
export function deletionMattersKey(note: { lines?: OwedLine[] } | null | undefined): LocaleKey {
  const owed = (note?.lines ?? []).filter((line) => line.tryAgain);
  const waiting = owed.filter((line) => line.waitsForUpdate).length;
  if (!waiting) return "ux.l2b.health.issue.deletion.matters";
  return waiting === owed.length ? "ux.l2b.health.issue.deletion.mattersUpdate" : "ux.l2b.health.issue.deletion.mattersSomeUpdate";
}

/** The engines holding things up, by name: the record clears once they have been closed for one attempt. */
export function deletionHolders(note: { lines?: OwedLine[] } | null | undefined): string {
  const names = [...new Set((note?.lines ?? []).filter((line) => line.tryAgain && line.byItself && line.label).map((line) => line.label!))];
  return names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What is left of deleted conversations, in Murage's own words, and Try again now while a retry can change something. */
function DeletionState({ fold, onChanged }: { fold: HealthFold<HealthIssue>; onChanged?: () => void }) {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const lines = owedSettingsLines(state.owedNote);
  const canRetry = deletionCanRetry(state.owedNote, desktop === true);
  const { pending, oldestHours } = deletionFigures(fold.rows);
  const holders = deletionHolders(state.owedNote);
  const retry = async () => {
    setBusy(true); setSaid(null);
    try {
      const answer = await api("/api/deletions/retry", { method: "POST", body: "{}" }) as { result?: unknown; notices?: unknown; rev?: unknown };
      dispatch({ type: "deletionOwed", notices: answer?.notices, rev: answer?.rev, answer: true });
      setSaid(retryResultLine(answer?.result));
      onChanged?.();
    } catch { setSaid(t("ux.l2b.health.deletion.retryFailed")); } finally { setBusy(false); }
  };
  return <>
    {lines.length > 0
      ? <ul className="mt-2 space-y-1 text-ink-secondary">{lines.map((line) => <li key={line}>{line}</li>)}</ul>
      : pending > 0 && state.owedRev === 0 && <p className="mt-2 text-ink-secondary">{oldestHours === null ? t("ux.l2b.health.deletion.pendingNoAge", { n: pending }) : t("ux.l2b.health.deletion.pending", { n: pending, age: durationLabel(oldestHours * 3_600_000) })}</p>}
    {holders && <p className="mt-2 text-ink">{t("ux.l2b.health.deletion.holding", { engines: holders })}</p>}
    {canRetry && <div className="mt-3"><button type="button" className={button} disabled={busy} onClick={() => void retry()}>{busy ? t("ux.l2b.health.deletion.trying") : t("ux.l2b.health.deletion.retry")}</button></div>}
    {said && <p role="status" className="mt-2 text-ink-secondary">{said}</p>}
  </>;
}

/** `fix`: the Health page's one-tap fix for this check (Back up now), shown in place of the go button. `extra`: Ask your bot. */
export function HealthFoldRow({ fold, now, onGo, onChanged, fix, extra }: { fold: HealthFold<HealthIssue>; now: number; onGo?: (to: NextAction) => void; onChanged?: () => void; fix?: ReactNode; extra?: ReactNode }) {
  const guide = healthGuide(fold.titleKey);
  const desktop = useDesktopSurface();
  // The Inbox renders these rows with no store around them too (its own page fixtures).
  const owedNote = useStoreIfAny()?.state.owedNote;
  const matters = guide.action.kind === "retry-deletions" ? deletionMattersKey(owedNote) : guide.matters;
  const [open, setOpen] = useState(false);
  const detail = useId();
  const improving = fold.rows.every((row) => row.state === "recovering");
  return <li className="rounded-xl border border-hairline/50 bg-panel p-4 text-[13px]">
    <p className="font-medium text-ink">{t(guide.title)}</p>
    <p className="mt-0.5 text-[12px] text-ink-secondary">{foldTimeLine(fold.issues, ageLabel(fold.lastSeenAt, now))}{improving ? `. ${t("ux.l2b.health.improving")}` : ""}</p>
    <dl className="mt-3 space-y-2">
      <div><dt className="text-[12px] text-ink-secondary">{t("ux.l2b.health.q.happened")}</dt><dd className="text-ink">{t(guide.happened)}</dd></div>
      <div><dt className="text-[12px] text-ink-secondary">{t("ux.l2b.health.q.matters")}</dt><dd className="text-ink">{t(matters)}</dd></div>
      <div><dt className="text-[12px] text-ink-secondary">{t("ux.l2b.health.q.canDo")}</dt><dd className="text-ink">{t(guide.canDo)}</dd></div>
    </dl>
    {guide.action.kind === "retry-deletions" && <DeletionState fold={fold} onChanged={onChanged} />}
    {fix ? <div className="mt-3">{fix}</div> : guide.action.kind === "go" && onGo && settingsPagesHere(desktop) && <div className="mt-3"><button type="button" className={button} onClick={() => onGo((guide.action as { to: NextAction }).to)}>{goLabel(guide.action.to)}</button></div>}
    {extra}
    <button type="button" aria-expanded={open} aria-controls={detail} onClick={() => setOpen(!open)}
      className="mt-2 min-h-8 rounded-md text-[12px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      {open ? t("ux.l2b.health.less") : t("ux.l2b.health.more")}
    </button>
    <p id={detail} hidden={!open} className="text-[12px] text-ink-secondary">
      {fold.count === 1 ? t("ux.l2b.health.seenOnce", { age: ageLabel(fold.firstSeenAt, now) }) : t("ux.l2b.health.seen", { n: fold.count, age: ageLabel(fold.firstSeenAt, now) })}
    </p>
  </li>;
}

const GROUP_WORDS = { act: "ux.l2b.health.group.act", watch: "ux.l2b.health.group.watch", note: "ux.l2b.health.group.note" } as const satisfies Record<HealthIssueLevel, string>;

/** The open issues, by what they ask of the owner. */
export function HealthIssueGroups({ folds, now, onGo, onChanged }: { folds: readonly HealthFold<HealthIssue>[]; now: number; onGo?: (to: NextAction) => void; onChanged?: () => void }) {
  return <>{(["act", "watch", "note"] as const).map((level) => {
    const group = folds.filter((fold) => fold.level === level);
    if (group.length === 0) return null;
    return <section key={level} aria-label={t(GROUP_WORDS[level])} data-health-group={level} className="mt-5 max-w-2xl">
      <h2 className="text-[13px] font-semibold text-ink-secondary">{t(GROUP_WORDS[level])}</h2>
      <ul className="mt-2 space-y-2">{group.map((fold) => <HealthFoldRow key={fold.titleKey} fold={fold} now={now} onGo={onGo} onChanged={onChanged} />)}</ul>
    </section>;
  })}</>;
}

/** What closed lately, folded the same way, on request. */
export function HealthClosed({ now }: { now: number }) {
  const [open, setOpen] = useState(false);
  const [folds, setFolds] = useState<HealthFold<HealthIssue>[] | null>(null);
  const [failed, setFailed] = useState(false);
  const region = useId();
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && folds === null) void readHealthIssues("resolved").then((issues) => { setFolds(healthFolds(issues)); setFailed(false); }).catch(() => setFailed(true));
  };
  return <section className="mt-5 max-w-2xl">
    <button type="button" aria-expanded={open} aria-controls={region} onClick={toggle} className="min-h-10 rounded-lg text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      {t("ux.l2b.health.group.closed")}
    </button>
    <div id={region} hidden={!open}>
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{HEALTH_COPY.unavailable}</p>}
      {folds?.length === 0 && <p className="mt-2 text-[13px] text-ink-secondary">{t("ux.l2b.health.closedNone")}</p>}
      {folds && folds.length > 0 && <ul className="mt-2 space-y-1 text-[13px] text-ink-secondary">{folds.map((fold) => {
        const latest = fold.rows[0]!;
        return <li key={fold.titleKey}><span className="text-ink">{t(healthGuide(fold.titleKey).title)}</span>{`: ${recoveryLabel(latest.state, latest.resolution)}, ${ageLabel(latest.resolvedAt ?? fold.lastSeenAt, now)}`}</li>;
      })}</ul>}
    </div>
  </section>;
}

/** The daily summary (GAP-SENTINEL-109 section 8.3): at most five grouped rows and one Recovered line. */
export function HealthDigestView({ digest, now }: { digest: HealthDigest; now: number }) {
  return <section aria-labelledby={`health-digest-${digest.id}`} className="mt-5 max-w-2xl rounded-lg border border-hairline/50 bg-inset p-3">
    <h2 id={`health-digest-${digest.id}`} className="text-[13px] font-medium text-ink">{HEALTH_COPY.digestHeading}</h2>
    {digest.rows.length > 0 && <ul className="mt-2 space-y-1 text-[13px] text-ink-secondary">
      {digest.rows.map((row) => <li key={row.titleKey}>
        <span className="text-ink">{healthTitle(row.titleKey)}</span>
        {`: seen ${row.count} ${row.count === 1 ? "time" : "times"} over ${durationLabel(row.lastSeenAt - row.firstSeenAt)}${row.issues > 1 ? `, ${row.issues} issues` : ""}`}
      </li>)}
    </ul>}
    {digest.moreCount > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{`${digest.moreCount} more in Health`}</p>}
    {digest.recoveredCount > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{recoveredLine(digest.recoveredCount)}</p>}
    <p className="mt-1 text-[12px] text-ink-secondary">{`Made ${ageLabel(digest.createdAt, now)}`}</p>
  </section>;
}
