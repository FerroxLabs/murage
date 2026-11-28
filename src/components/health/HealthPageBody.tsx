// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health screen (Sean 10-30, 11-01). Needs you shows only what the owner must act on; everything else about how
// Murage is doing lives here: the status, the engines, and every open issue with what it means and what to do.
// As a doctor (Sean 11-02, designs/HEALTH-DOCTOR.md): one line says how many things to fix and where to start, the
// findings follow in order of impact with one fix each, and What was checked sits beside them on a wide window.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { answerDefaultId, currentEngineHealthAnswer, refreshEngineHealthAnswer, useEngineHealthAnswer, useEngineReading } from "@/components/today/use-engine-health";
import { healthEngine } from "@/lib/today-model";
import { clearHealthResults, healthReadExited, readHealthLedger, subscribeHealthLedger, type HealthSnapshot } from "@/lib/health-actions";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { StatusDot } from "@/components/shell/StatusDot";
import { BoxBody, BoxHead } from "../ui/BoxShell";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { EngineHealthAnswer, HealthPageProps } from "@/components/shell/shell-contract";
import { strongestHealthLevel, type HealthFold } from "../../../shared/health-levels";
import { HEALTH_COPY, HEALTH_STALE_MS, healthStateLine, recoveredLine, type HealthIssue, type HealthSummaryResponse, type NextAction } from "../../../shared/sentinel-view";
import { healthFromEngines, healthWithChecks, healthWithRoutines } from "./health-status";
import { healthDestination, healthGuide } from "./health-guide";
import { healthFindings, summaryLine, type FindingEntry } from "./health-findings";
import { HEALTH_BODY, HEALTH_FRAME, HEALTH_HEAD, HealthHeadTop } from "./HealthExit";
import { HealthClosed, HealthDigestView, HealthIssueGroups, healthFolds, readHealthIssuesAt } from "./HealthIssues";
import { HealthFindingList, findingActionKey } from "./HealthFindings";
import { HealthPanel } from "./HealthPanel";


/** One READING's longest life: a hung read ends the READING as unavailable instead of leaving the page waiting. */
export const HEALTH_READING_BOUND_MS = 30_000;
/** The one retry after a CHECKING or UNAVAILABLE exit (never re-armed by itself, never for a 404). */
export const HEALTH_RETRY_MS = 10_000;

type Exit = "SETTLED" | "CHECKING" | "UNAVAILABLE";
type TriggerKind = "mount" | "epoch" | "owedRev" | "onChanged" | "engine" | "retry";
interface Shown { summary: HealthSummaryResponse | null; folds: HealthFold<HealthIssue>[]; alert: boolean; lastExit: Exit | null; accepted: { epoch: number; engineKey: string } | null }
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T,>(p: Promise<T>): Promise<Settled<T>> => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;

/** What a read of the engines says, for deciding whether the page must read again: the level and the finding keys. */
export function engineKey(answer: EngineHealthAnswer | null, desktop: boolean, now: number): string {
  if (!answer) return "none";
  const primaryId = answerDefaultId(answer);
  const level = healthFromEngines(healthEngine(answer.engines, primaryId), answer.flux, true).level;
  const keys = healthFindings({ engines: answer.engines, primaryId, flux: answer.flux, fluxInfo: answer.fluxInfo, folds: [], desktop, now })
    .map((entry) => (entry.kind === "finding" ? entry.finding.key : entry.fold.titleKey)).sort();
  return `${level}|${keys.join(",")}`;
}

/** The summary says every check ran lately: complete coverage, a running scanner, a fresh heartbeat, not retired. It does
 * not read openCount: an open note adds no colour, and act/watch issues are already excluded by the folds. */
export function coverageOk(summary: HealthSummaryResponse, now: number): boolean {
  const view = summary.view?.summary;
  return summary.status === "ready" && !!view && !summary.backgroundChecksRetired && view.coverage === "complete" && view.scanner === "running"
    && view.lastCheckedAt !== null && now - view.lastCheckedAt <= HEALTH_STALE_MS;
}

const entryLevel = (entry: FindingEntry) => (entry.kind === "finding" ? entry.finding.level : entry.fold.level);

export function HealthPageBody({ onLeave }: HealthPageProps) {
  const { state, dispatch } = useStore();
  const server = useEngineHealthAnswer();
  const reading = useEngineReading();
  const ledger = useSyncExternalStore(subscribeHealthLedger, readHealthLedger, readHealthLedger);
  const desktop = useDesktopSurface();
  const now = Date.now();
  const idle = ledger.pending === 0;
  const [shown, setShown] = useState<Shown>(() => ({ summary: ledger.lastSnapshot?.summary ?? null, folds: ledger.lastSnapshot?.folds ?? [], alert: false, lastExit: null, accepted: null }));
  const [trigger, setTrigger] = useState<{ n: number; kind: TriggerKind }>({ n: 0, kind: "mount" });
  const bump = useCallback((kind: TriggerKind) => setTrigger((previous) => ({ n: previous.n + 1, kind })), []);
  const reread = useCallback(() => bump("onChanged"), [bump]);
  // One READING at a time. `lastKey` is the engine key of the engine answer the last READING itself read ("none" for
  // none): the engine trigger compares the live answer with it, so an unchanged tick never reads again.
  const run = useRef({ reading: null as object | null, lastKey: null as string | null, retry: 0, first: true, n: 0, owed: state.owedRev, desktop: desktop === true, now, shown });
  run.current.desktop = desktop === true; run.current.now = now; run.current.shown = shown;

  useEffect(() => {
    const r = run.current;
    const kind: TriggerKind = r.first ? "mount" : trigger.n !== r.n ? trigger.kind : state.owedRev !== r.owed ? "owedRev" : "epoch";
    r.first = false; r.n = trigger.n; r.owed = state.owedRev;
    const controller = new AbortController();
    const { signal } = controller;
    const epoch = ledger.epoch;
    const pair = async () => {
      const [summary, issues] = await Promise.all([settle(api("/api/sentinel/summary", { signal }) as Promise<HealthSummaryResponse>), settle(readHealthIssuesAt("open", signal))]);
      return { summary, issues };
    };
    if (!idle) {
      // ACTING. On a remount show what is open at once: one display-only pair that never decides anything.
      if (kind === "mount") void pair().then(({ summary, issues }) => {
        if (signal.aborted || !summary.ok) return;
        const view = summary.value.view;
        if (summary.value.status === "ready" && view) { if (!issues.ok || issues.value.storeRevision !== view.storeRevision) return; }
        setShown((previous) => ({ ...previous, summary: summary.value, folds: issues.ok ? healthFolds(issues.value.items) : previous.folds }));
      });
      return () => controller.abort();
    }
    window.clearTimeout(r.retry);
    const token = {};
    r.reading = token;
    const startExitSeq = ledger.exitSeq;
    const independent = kind === "owedRev" || kind === "onChanged" || kind === "engine" || kind === "retry";
    let own: EngineHealthAnswer | null | undefined;
    let done = false;
    const stale = () => done || signal.aborted || r.reading !== token || readHealthLedger().epoch !== epoch || readHealthLedger().pending > 0;
    const finish = (apply: (previous: Shown) => Shown, key: string, accepted?: HealthSnapshot, retry = false): boolean => {
      if (stale()) return false;
      done = true; window.clearTimeout(bound); r.reading = null;
      setShown(apply); r.lastKey = key; healthReadExited(accepted);
      if (retry && kind !== "retry") r.retry = window.setTimeout(() => bump("retry"), HEALTH_RETRY_MS);
      // A real change published while this READING ran starts one more (its own answer is then the latest publish).
      if (engineKey(currentEngineHealthAnswer(), r.desktop, r.now) !== key) bump("engine");
      return true;
    };
    const failClosed = (key: string, retry: boolean) => finish((previous) => ({ ...previous, summary: { status: "unavailable", view: null }, alert: true, lastExit: "UNAVAILABLE" }), key, undefined, retry);
    const bound = window.setTimeout(() => {
      // No engine answer (hung, or null): nothing arms a retry, and the key is the live one so the exit recheck cannot loop.
      if (own === undefined) failClosed(engineKey(currentEngineHealthAnswer(), r.desktop, r.now), false);
      else if (own === null) failClosed("none", false);
      else failClosed(engineKey(own, r.desktop, r.now), true);
      controller.abort();
    }, HEALTH_READING_BOUND_MS);
    void (async () => {
      const engineRead = refreshEngineHealthAnswer().then((value) => { own = value; return value; }, () => { own = null; return null; });
      for (let attempt = 0; attempt < 3; attempt++) {
        const [engine, { summary, issues }] = await Promise.all([engineRead, pair()]);
        if (stale()) return;
        const key = engineKey(engine, r.desktop, r.now);
        if (!engine) { failClosed("none", false); return; }
        if (!summary.ok) { failClosed(key, statusOf(summary.error) !== 404); return; }
        if (summary.value.status !== "ready" || summary.value.view === null) {
          // Not set up (or no view yet): the summary decides. Its sentence is the answer; never an all-clear.
          const folds = issues.ok ? healthFolds(issues.value.items) : r.shown.folds;
          if (finish((previous) => ({ ...previous, summary: summary.value, folds, alert: !issues.ok, lastExit: "SETTLED", accepted: { epoch, engineKey: key } }), key, { epoch, summary: summary.value, folds, engineKey: key }) && independent) clearHealthResults((_, line) => startExitSeq > line.atExit);
          return;
        }
        if (!issues.ok && statusOf(issues.error) !== 409) { failClosed(key, statusOf(issues.error) !== 404); return; }
        if (issues.ok && issues.value.storeRevision === summary.value.view.storeRevision) {
          const folds = healthFolds(issues.value.items);
          if (finish(() => ({ summary: summary.value, folds, alert: false, lastExit: "SETTLED", accepted: { epoch, engineKey: key } }), key, { epoch, summary: summary.value, folds, engineKey: key }) && independent) clearHealthResults((_, line) => startExitSeq > line.atExit);
          return;
        }
        // The two reads are from different moments: read the pair again, at most twice more.
        if (attempt === 2) { finish((previous) => ({ ...previous, alert: false, lastExit: "CHECKING" }), key, undefined, true); return; }
      }
    })();
    return () => { controller.abort(); window.clearTimeout(bound); if (r.reading === token) r.reading = null; };
    // The READING is keyed on the ledger's epoch, whether anything is pending, and the explicit triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger.epoch, idle, trigger.n, state.owedRev]);

  // The engine trigger: the live answer differs from the one the last READING read (and nothing is running).
  const liveKey = engineKey(server, desktop === true, now);
  useEffect(() => {
    const r = run.current;
    if (idle && r.reading === null && r.lastKey !== null && liveKey !== r.lastKey) bump("engine");
  }, [liveKey, idle, bump]);
  // Leaving the page: result lines go (those of an action still running stay), and the pending retry with them.
  useEffect(() => () => { window.clearTimeout(run.current.retry); const pending = readHealthLedger().pendingKeys; clearHealthResults((key) => !pending.has(key)); }, []);

  const { summary, folds } = shown;
  const [panelOpen, setPanelOpen] = useState(false);
  const panelId = useId();
  const status = healthWithRoutines(healthWithChecks(healthFromEngines(reading.health, reading.flux, reading.fromServer || state.instances.length > 0), strongestHealthLevel(folds)), state.routineRuns);
  const checks = summary ? healthStateLine(summary.status, summary.view?.summary ?? null, now) : null;
  const checksLine = summary?.backgroundChecksRetired && summary.status !== "unavailable" && !summary.view?.summary.openCount
    ? t("ux.l2b.health.backgroundChecksRetired") : checks?.sentence;
  const quiet = folds.length > 0 && folds.every((fold) => fold.level === "note");
  // Every finding in order of impact (Flux Router and Fuigo first), from what the page already holds.
  // The engine actually chosen as the default; an older server only sends the fallback it names on Today.
  const defaultId = server ? server.defaultId !== undefined ? server.defaultId : server.primary?.id ?? null : null;
  const entries = healthFindings({ engines: server?.engines ?? [], primaryId: defaultId, flux: server?.flux ?? reading.flux, fluxInfo: server?.fluxInfo, folds, desktop: desktop === true, now });
  const counted = summaryLine(entries, (fold) => t(healthGuide(fold.titleKey).title));
  // Nothing to fix: the sentence is the one the page said before (how far the checks got), said as an all-clear only
  // when the page holds one finished snapshot: every action ended, then the engines, the summary and the open issues read
  // as one, the live engines still those it read, nothing to act on or watch, and the checks complete and fresh.
  const settled = idle && shown.lastExit === "SETTLED" && shown.accepted?.epoch === ledger.epoch;
  const affirmative = settled && liveKey === shown.accepted?.engineKey && summary?.view != null && status.level === "ok"
    && entries.every((entry) => entryLevel(entry) === "note") && coverageOk(summary, now);
  const said = counted
    ?? (status.level === "act" || status.level === "watch" ? status.line
      : quiet ? t("ux.l2b.health.lineNote")
        : checksLine ?? status.line);
  const line = !affirmative && (said === t("ux.l2a.health.ok") || said === HEALTH_COPY.noIssues) ? t("ux.l2a.health.unknown") : said;
  const dotLevel = status.level === "ok" && !affirmative ? "unknown" : status.level;
  // A result line shows in its card while the card is there; one whose card is gone is said here instead.
  const cardKeys = new Set(entries.map((entry) => (entry.kind === "finding" ? findingActionKey(entry.finding.fix, desktop) : null)));
  const strays = Array.from(ledger.results).filter(([key]) => !cardKeys.has(key));
  const go = (to: NextAction) => { const place = healthDestination(to); if (place) dispatch({ type: "toggleAppSettings", open: true, section: place.section }); };
  const recovered = summary?.view?.summary.recoveredCount ?? 0;
  return (
    <main aria-labelledby="health-page-title" className={HEALTH_FRAME}>
      <BoxHead className={HEALTH_HEAD}>
        {/* The way out (Sean 11-02): the same header as while loading (HealthExit.tsx), Back and close on every screen. */}
        <HealthHeadTop onLeave={onLeave} menu={<OpenBotListButton />} dot={<StatusDot level={dotLevel} />} />
        <p role="status" className="mt-1 text-[14px] text-ink-secondary">{line}</p>
        {strays.map(([key, entry]) => <p key={key} role="status" className="mt-1 text-[13px] text-ink-secondary">{entry.line}</p>)}
      </BoxHead>
      <BoxBody className={HEALTH_BODY}>
      {!summary?.backgroundChecksRetired && checks?.time && <p className="mt-0.5 text-[12px] text-ink-secondary">{checks.time}</p>}
      {shown.alert && <p role="alert" className="mt-2 text-[13px] text-danger">{HEALTH_COPY.unavailable}</p>}
      {/* Two columns from 1024 px: findings on the left (7/12), What was checked on the right (5/12), centred up to 1200 px. */}
      <div className="mx-auto mt-4 grid w-full max-w-[1200px] grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <HealthFindingList entries={entries} now={now} onGo={go} onChanged={reread} />
          {/* What Murage is on (notes) stays out of the count and out of the findings. */}
          <HealthIssueGroups folds={folds.filter((fold) => fold.level === "note")} now={now} onGo={go} onChanged={reread} />
          {recovered > 0 && <p className="mt-4 text-[13px] text-ink-secondary">{recoveredLine(recovered)}</p>}
          {summary?.digest && <HealthDigestView digest={summary.digest} now={now} />}
          <HealthClosed now={now} />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <button type="button" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen(!panelOpen)}
            className="min-h-10 rounded-lg text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus lg:hidden">
            {t("ux.l2a.health.checked")}
          </button>
          <div id={panelId} className={`${panelOpen ? "block" : "hidden"} lg:sticky lg:top-0 lg:block`}>
            <HealthPanel answer={server} folds={folds} affirm={affirmative} />
          </div>
        </div>
      </div>
      </BoxBody>
    </main>
  );
}
