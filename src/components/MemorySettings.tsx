import { t } from "@/lib/i18n";
import type { MemoryLearning, SemanticIndexStatus } from "@/lib/memory-learning";
import { semanticPhrase } from "@/lib/memory-learning-text";
import { ProcedureEvaluationAdmissions } from "./ProcedureEvaluationAdmissions";
import type { ProcedureEvolutionStatus } from "@/lib/procedure-evaluation-admissions";
import { MemoryEvolutionControls } from "./MemoryEvolutionControls";
import type { MemoryEvolutionStatus } from "@/lib/memory-evolution-controls";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { InAdvanced, Switch } from "./SettingsPrimitives";
import { useAction } from "@/lib/use-action";
import { ActionButton, ActionStatus } from "./ActionButton";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { useUpgradeContext } from "@/lib/memory-integrity-feed";
import { settingsDescription } from "@/lib/memory-integrity-view";
import type { MachineContext } from "../../shared/upgrade-machine.mjs";
import type { MemoryRecord } from "../../shared/memory";
import { Disclosure, MemoryHealth, type MemoryHealthStatus } from "./MemoryLearningControls";
import { MemoryStorageReclaim, MemoryUpgradeDetail } from "./MemoryUpgradeDetail";
import { MemoryNotebookPicker } from "./MemoryNotebookPicker";
import { LearnAboutMe } from "./LearnAboutMe";
import { MemoryPeople, type HumanBindingsStatus, type HumanLinkIntent, type HumanShareIntent } from "./MemoryPeople";
import { MemoryReview, memoryButtonClass, memoryInputClass, memoryStateLabel, memoryRecordOriginLabel, memoryRecordText, type MemoryAction, type MemoryAudience, type MemoryInspection } from "./MemoryReview";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
// The review block loads the first time something waits; the first paint carries the screen, not the review.
const MemoryNeedsYouLazy = retryableLazy(() => import("./MemoryNeedsYou").then((module) => ({ default: module.MemoryNeedsYou })));
const NeedsYou = (props: { subject: ReviewSubject }) => <LazyBoundary inline onRetry={MemoryNeedsYouLazy.retry}><Suspense fallback={null}><MemoryNeedsYouLazy.Component {...props} /></Suspense></LazyBoundary>;
import { useMemoryWaiting } from "@/lib/use-memory-waiting";
import { errorSentence, type ReviewSubject } from "@/lib/memory-review";
import { countText, importSentence, modelSentence, workerSentence } from "@/lib/memory-words";
import { allHeldTasks } from "@/lib/task-window";

export interface MemoryStatus {
  /** From the same predicates as the capture path: a hold switches both off. Absent on an older server (no claim is then made). */
  held?: boolean; capture?: "on" | "off"; recall?: "on" | "off"; storedMode?: "off" | "capture" | "active" | "paused";
  evolution?:MemoryEvolutionStatus|null;
  classificationEvolution?:MemoryEvolutionStatus|null;
  procedureEvolution?:ProcedureEvolutionStatus|null;
  learning?: MemoryLearning;
  health?: MemoryHealthStatus;
  /** Smart search over memories: ready, indexing (done of total) or keyword-only. */
  semantic?: SemanticIndexStatus | null;
  mode: "off" | "capture" | "active" | "paused";
  policyRevision: number; deletionEpoch: number;
  configuration: { excludedThreadIds: string[]; extractorInstanceId: string | null };
  scopes: MemoryAudience[];
  /** How many per-conversation audiences the server left out of `scopes` (a long history); a record in one gets its name from a `scope-labels` call. */
  scopesOmitted?: number;
  backlog: { pending: number; leased: number; deferred: number; failed: number; oldestQueuedAt: number | null; more?: Record<string, boolean> };
  retention?: { sourceBytes: number; records: Array<{ state: string; count: number; bytes: number | null }> };
  records: Record<"candidate" | "active" | "archived" | "superseded" | "deleted", number>;
  recordsMore?: Record<string, boolean>;
  model: { state: "missing" | "unverified" | "downloading" | "ready" | "failed"; bytesDownloaded: number; totalBytes: number; revision: string; model: string; error?: string; bundled?: boolean };
  extractors: Array<{ instanceId: string; label: string; eligible: boolean; reason?: string }>;
  deletion: { pending: number; more?: boolean }; workerError: string | null;
  /** The past-conversations build of an install whose memory was switched on at upgrade (1.0.3): conversations read of listed, messages queued (each exact to 1,000). */
  pastChats?: { threads: number; threadsDone: number; messagesQueued: number; running: boolean } | null;
  runtime?: { running?: boolean; ready?: boolean; indexing?: boolean; error?: string | null } | null;
}
interface ImportPreview {
  previewId: string; expiresAt: number;
  items: Array<{ path: string; hash: string; bytes: number; text: string; scopeId: string; scopeLabel: string; alreadyImported: boolean }>;
}
export type MemoryView = "search" | "important" | "recent" | "review";
/** The status with the model block the server just returned, so a started download shows (and polls) at once. Null when there is no status yet to fold it into. */
export function withModelAnswer(status: MemoryStatus | null, model: unknown): MemoryStatus | null {
  if (!status || !model || typeof model !== "object") return null;
  return { ...status, model: model as MemoryStatus["model"] };
}

export function memoryListAction(query: string, scopeId: string, state: string, botId?: string, cursor?: string, view?: MemoryView): MemoryAction {
  return { action: "list", ...(query.trim() ? { query: query.trim() } : {}), ...(scopeId ? { scopeId } : {}), ...(state ? { state } : {}), ...(botId ? { botId } : {}), ...(cursor ? { cursor } : {}), ...(view ? { view } : {}) };
}
const request = (action: MemoryAction) => api("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
const message = (error: unknown) => errorSentence(error);

/** The scope ids a page of records points at that the audiences held do not name (a per-conversation audience the status left out). */
export function unnamedScopeIds(scopeIds: readonly string[], audiences: ReadonlyArray<{ id: string }>, asked: ReadonlySet<string>): string[] {
  const known = new Set(audiences.map(audience => audience.id));
  return [...new Set(scopeIds)].filter(id => !known.has(id) && !asked.has(id));
}
/** A record's audience name. While its name is on the way it reads "Loading audience"; a conversation that exists never reads as a generic one. */
export function recordAudienceLabel(scopeId: string, audiences: ReadonlyArray<{ id: string; label: string }>, settled: boolean): string {
  return audiences.find(audience => audience.id === scopeId)?.label ?? (settled ? t("memorySettings.audience.unavailable") : t("memorySettings.audience.loading"));
}
/** "Folder memory" is the audience of a bound folder (scope kind "project"):
 * nothing to do with a channel project, so it is never called one (PM5). */
export function memoryAudienceLabel(scope: { kind: string; label: string }): string {
  return scope.kind === "project" ? t("memorySettings.audience.folder", { label: scope.label }) : scope.label;
}
/** Folder memory is offered only where it is already in use (PM5). */
export function folderMemoryInUse(scopes: ReadonlyArray<{ kind: string }>): boolean {
  return scopes.some(scope => scope.kind === "project");
}

/** The mode line in Settings, from the reducer's context and what /api/memory/status says now. A known hold (from either) overrides every cached mode, and
 * a claim that new things are noted is made only where a source that knows there is no hold says capture is on (src/lib/memory-integrity-view.ts). */
export function memoryModeDescription(ctx: MachineContext, status: Pick<MemoryStatus, "mode"> & Partial<Pick<MemoryStatus, "held" | "capture" | "recall" | "storedMode">>): string {
  return settingsDescription(ctx, { mode: status.storedMode ?? status.mode, held: status.held, capture: status.capture, recall: status.recall });
}

export function MemorySettings({ botId, onNavigate, compact = false, onStatusChange, sharedStatus, onMutation, refreshToken }: { botId?: string; onNavigate?: () => void; compact?: boolean; onStatusChange?: (status: MemoryStatus) => void; sharedStatus?: MemoryStatus; onMutation?: () => void; refreshToken?: number }) {
  const desktop = useDesktopSurface();
  const upgradeContext = useUpgradeContext();
  const { state, dispatch } = useStore();
  const [localStatus, setStatus] = useState<MemoryStatus | null>(null);
  const status = sharedStatus ?? localStatus;
  const [people, setPeople] = useState<HumanBindingsStatus | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  // Audiences the status left out (per-conversation ones on a long history), named on demand by scope id.
  const [extraAudiences, setExtraAudiences] = useState<MemoryAudience[]>([]);
  const [askedScopes, setAskedScopes] = useState<ReadonlySet<string>>(new Set());
  const [answeredScopes, setAnsweredScopes] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [recordState, setRecordState] = useState("");
  const [view, setView] = useState<MemoryView>("search");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [scopeIds, setScopeIds] = useState<string[] | null>(null);
  const [searchNotice, setSearchNotice] = useState<string>();
  const [matchCountLabel, setMatchCountLabel] = useState<string>();
  const [conflicts, setConflicts] = useState<Array<{ id: string; selection: { kind: string; botId?: string; topic?: string; section?: string }; error?: string }>>([]);
  const [conflictCursor, setConflictCursor] = useState<string>();
  const applied = useRef({ query: "", scopeId: "", recordState: "", view: "search" as MemoryView });
  const [cursor, setCursor] = useState<string>();
  const [inspection, setInspection] = useState<MemoryInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One action runs at a time. It is state, so every control disables on the press, says "Working…", and the line at the bottom
  // reports the slow case, the result, or the reason it failed with a Retry.
  const doing = useAction(async (work: () => Promise<string | void>, success?: string) => (await work()) || success || "", {
    idle: t("memorySettings.working"), pending: t("memorySettings.working"), success: (line: string) => line, failure: t("memorySettings.didNotWork"),
    slowHint: t("memorySettings.stillWorking"), describeError: cause => message(cause),
  });
  const acting = doing.pending;
  const [importOpen, setImportOpen] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [bindingScope, setBindingScope] = useState("");
  const [subject, setSubject] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [importChoice, setImportChoice] = useState(botId ? `bot:${botId}` : "");
  const [topic, setTopic] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [trackImports, setTrackImports] = useState(false);
  const [fluxMemory, setFluxMemory] = useState<{ external: boolean; keyPresent: boolean; last?: { text: string } } | null>(null);
  const mounted = useRef(true);
  const waiting = useMemoryWaiting();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // "Use Flux memory": the one switch for external memory. It shows only with a Flux key, on by default. Its label matches
  // FLUX_MEMORY_DISCLOSURE and FLUX_MEMORY_PRIVACY_LINE (server/flux-memory-envelope.ts).
  useEffect(() => { void api("/api/memory/flux-memory").then(next => { if (mounted.current) setFluxMemory(next as NonNullable<typeof fluxMemory>); }, () => {}); }, []);
  const toggleFluxMemory = () => { if (!fluxMemory) return; const external = !fluxMemory.external; setFluxMemory({ ...fluxMemory, external }); void api("/api/memory/flux-memory", { method: "POST", body: JSON.stringify({ external }) }).then(next => { if (mounted.current) setFluxMemory(next as NonNullable<typeof fluxMemory>); }, () => { if (mounted.current) setFluxMemory(fluxMemory); }); };
  const applyStatus = useCallback((next: MemoryStatus) => {
    if (!mounted.current) return;
    setStatus(next); onStatusChange?.(next); setExcluded(next.configuration.excludedThreadIds);
  }, [onStatusChange]);
  const loadStatus = useCallback(async () => { applyStatus(await api("/api/memory/status") as MemoryStatus); }, [applyStatus]);
  const loadPeople = useCallback(async () => {
    const next = await request({ action: "humans" }) as HumanBindingsStatus;
    if (mounted.current) setPeople(next);
  }, []);
  const loadRecords = useCallback(async (nextCursor?: string, filters = applied.current) => {
    let result: { records: MemoryRecord[]; nextCursor?: string; scopeIds?: string[] | null; searchNotice?: string; matchCountLabel?: string };
    try { result = await request(memoryListAction(filters.query, filters.scopeId, filters.recordState, botId, nextCursor, filters.view)); }
    catch (error) {
      // The list's order changed under the page (the search index was reordered or reset): start again from the newest and say so.
      if (!nextCursor || !/INVALID_MEMORY_CURSOR/.test(error instanceof Error ? error.message : String(error))) throw error;
      result = await request(memoryListAction(filters.query, filters.scopeId, filters.recordState, botId, undefined, filters.view));
      nextCursor = undefined;
      result.searchNotice = `The list was refreshed; starting from the newest.${result.searchNotice ? ` ${result.searchNotice}` : ""}`;
    }
    if (!mounted.current) return;
    applied.current = filters;
    setRecords(result.records); setCursor(result.nextCursor); if (!filters.scopeId) setScopeIds(result.scopeIds ?? null); setSearchNotice(result.searchNotice);
    // the count comes with the first page of a search ("1,000+" past its cap) and stays while the owner pages
    if (!nextCursor) { setPageIndex(0); setPageCursors([undefined]); setMatchCountLabel(filters.query.trim() ? result.matchCountLabel : undefined); }
  }, [botId]);
  const loadConflicts = async (nextCursor?: string) => {
    const result = await request({ action: "import-review-list", ...(botId ? { botId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
    if (mounted.current) { setConflicts(result.links); setConflictCursor(result.nextCursor); }
  };
  useEffect(() => {
    if (desktop !== true) return;
    let cancelled = false;
    setError(null);
    applied.current = { query: "", scopeId: "", recordState: "", view: "search" };
    setQuery(""); setScopeId(""); setRecordState(""); setView("search"); setPageIndex(0); setPageCursors([undefined]); setInspection(null); setRecords([]); setCursor(undefined); setConflicts([]); setConflictCursor(undefined); setSearchNotice(undefined); setPeople(null);
    void Promise.all([loadStatus(), request(memoryListAction("", "", "", botId, undefined, "search")), botId ? Promise.resolve() : loadPeople()]).then(([, result]) => {
      if (!cancelled) { setRecords(result.records); setCursor(result.nextCursor); setScopeIds(result.scopeIds ?? null); }
    }).catch(error => { if (!cancelled) setError(message(error)); });
    return () => { cancelled = true; };
  }, [desktop, botId, loadPeople, loadStatus]);
  // A change made elsewhere on the page (a learning Keep or Undo) refreshes the list in place: no remount, no loading line.
  const firstToken = useRef(true);
  useEffect(() => {
    if (firstToken.current) { firstToken.current = false; return; }
    if (desktop === true) void loadRecords(undefined, applied.current).catch(() => undefined);
  }, [refreshToken]);
  useEffect(() => {
    if (status?.model.state !== "downloading" && !(status?.model.bundled && status.model.state === "unverified") && status?.semantic?.state !== "indexing") return;
    const timer = window.setInterval(() => { void loadStatus().catch(error => { if (mounted.current) setError(message(error)); }); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.model.state, status?.semantic?.state, loadStatus]);

  const heldScopeIds = records.map(record => record.scopeId).concat(inspection ? [inspection.record.scopeId] : []);
  const wanted = status ? unnamedScopeIds(heldScopeIds, [...status.scopes, ...extraAudiences], askedScopes) : [];
  const wantedKey = wanted.join(",");
  useEffect(() => {
    if (!wantedKey) return;
    const ids = wantedKey.split(",");
    setAskedScopes(previous => new Set([...previous, ...ids]));
    void (async () => {
      for (let at = 0; at < ids.length; at += 50) {
        const chunk = ids.slice(at, at + 50);
        try {
          const answer = await request({ action: "scope-labels", scopeIds: chunk });
          if (mounted.current && Array.isArray(answer?.scopes)) setExtraAudiences(previous => [...previous, ...(answer.scopes as MemoryAudience[])]);
        } catch { /* the label stays unavailable; the record itself is untouched */ }
        if (mounted.current) setAnsweredScopes(previous => new Set([...previous, ...chunk]));
      }
    })();
  }, [wantedKey]);
  const audiences = [...(status?.scopes ?? []), ...extraAudiences];

  const run = (work: () => Promise<string | void>, success?: string) => doing.run(work, success);
  // Actions that change what the status itself lists (audiences, imports). Record actions never reload it.
  const changesStatus = new Set(["bind", "project", "import-commit", "enable-and-import", "import-stop-tracking", "model-download", "rebuild-index"]);
  const perform = async (action: MemoryAction, success: string): Promise<void> => { await run(async () => {
    const answer = await request(action);
    if (!mounted.current) return success;
    setInspection(null);
    // The answer carries what changed: a new status for a settings save, the changed record for a record action.
    if (action.action === "configure" && answer?.mode) applyStatus(answer as MemoryStatus);
    else if (action.action === "enable-and-import" && answer?.status?.mode) applyStatus(answer.status as MemoryStatus);
    else if (action.action === "model-download" && answer?.model) {
      // The server starts the download and answers at once with "downloading". Apply it now so the 1.5 s poll starts and the progress line appears.
      const next = withModelAnswer(status, answer.model);
      if (next) applyStatus(next); else await loadStatus();
    }
    else if (changesStatus.has(action.action)) await loadStatus();
    await loadRecords(undefined, applied.current);
    onMutation?.();
    if (view === "review") await loadConflicts();
    return success;
  }, success); };
  // Download button (Macs without the bundled model): pending label at once, the answer applied, a visible failure with Retry.
  // Advanced "Rebuild search index": starts the same batched re-embedding in the background; progress is status.semantic.
  const rebuild = useAction(async () => { await perform({ action: "rebuild-index" }, t("settings.reindex.started")); }, {
    idle: t("settings.reindex.button"), pending: t("settings.reindex.pending"), success: null, failure: t("settings.reindex.failure"), slowHint: t("settings.reindex.slow"), describeError: cause => message(cause),
  });
  const download = useAction(async () => { await perform({ action: "model-download", confirm: true }, t("memorySettings.download.started")); }, {
    idle: t("memorySettings.download.button"), pending: t("memorySettings.download.starting"), success: null, failure: t("memorySettings.download.failed"), slowHint: t("memorySettings.download.slow"),
  });
  // The press goes through `perform`, which reports pending, the result or the reason through the line at the bottom of this section.
  const go = (action: MemoryAction, success: string) => { void perform(action, success); };
  const changePerson = async (intent: HumanLinkIntent) => {
    await request({ action: "human-link", ...intent });
    await loadPeople();
  };
  const sharePerson = async (intent: HumanShareIntent) => {
    await request({ action: "human-share", ...intent });
    await loadPeople();
  };
  const subjects = [...state.bots.map(bot => ({ value: `bot:${bot.id}`, label: bot.name })), ...state.groups.map(group => ({ value: `room:${group.id}`, label: t("memorySettings.channel", { name: group.name }) }))];
  const subjectFields = () => { const separator = subject.indexOf(":"); return { subjectType: subject.slice(0, separator), subjectId: subject.slice(separator + 1) }; };
  const threads = [...new Map([
    ...excluded.map(id => ({ id, label: t("memorySettings.threadGone") })),
    ...state.bots.flatMap(bot => [{ id: bot.threadId, label: bot.name }, ...allHeldTasks(bot).map(task => ({ id: task.threadId, label: t("memorySettings.threadTask", { bot: bot.name, task: task.title ?? t("memorySettings.taskFallback") }) }))]),
    ...state.groups.map(group => ({ id: group.threadId, label: t("memorySettings.channel", { name: group.name }) })),
  ].map(item => [item.id, item])).values()];
  const sections = [...new Set(state.bots.map(bot => bot.section ?? ""))];
  const filters = <>
    <label className="block space-y-1 text-[13px]">{t("memorySettings.audience.label")}<select className={memoryInputClass} value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">{botId ? t("memorySettings.allAudiencesBot") : t("memorySettings.allAudiencesWorkspace")}</option>{status?.scopes.filter(scope => !scopeIds || scopeIds.includes(scope.id) || scope.id === scopeId).map(scope => <option key={scope.id} value={scope.id}>{memoryAudienceLabel(scope)}</option>)}</select></label>
    {view === "search" && <label className="block space-y-1 text-[13px]">{t("memorySettings.show")}<select className={memoryInputClass} value={recordState} onChange={event => setRecordState(event.target.value)}><option value="">{t("memorySettings.everything")}</option>{["candidate", "active", "archived", "superseded", "deleted"].map(value => <option key={value} value={value}>{memoryStateLabel(value)}</option>)}</select></label>}
  </>;
  const folderMemoryUsed = folderMemoryInUse(status?.scopes ?? []);
  if (desktop !== true) return <section className="rounded-xl bg-card p-4"><h2 className="text-[15px] font-medium">{t("memorySettings.managed")}</h2><p role="status" className="mt-2 text-[13px] text-ink-secondary">{desktop === undefined ? t("memorySettings.checkingAccess") : t("memorySettings.desktopOnly")}</p></section>;
  const workspacePage = !compact && !botId;
  return <section aria-label={botId ? t("memorySettings.botMemory") : t("memorySettings.workspaceMemory")} className={`min-w-0 space-y-4 text-ink ${compact ? "p-3" : "rounded-xl bg-card p-4"}`} data-testid="memory-settings" data-compact={compact || undefined}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[16px] font-medium">{botId ? t("memorySettings.botMemory") : t("memorySettings.workspaceMemory")}</h2><button className={memoryButtonClass} disabled={acting} onClick={() => void run(async () => { await Promise.all([loadStatus(), loadRecords(), ...(botId ? [] : [loadPeople()])]); return t("memorySettings.upToDate"); })}>{acting ? t("memorySettings.working") : t("memorySettings.refresh")}</button></div>
    {!compact && <p className="text-[13px] text-ink-secondary">{t("memorySettings.subtitle")}</p>}
    {botId
      ? <NeedsYou subject={{ kind: "bot", id: botId, name: state.bots.find(bot => bot.id === botId)?.name ?? t("memorySettings.yourBot") }} />
      : waiting.subjects.filter(item => item.waiting > 0 || item.later > 0).map(item => <NeedsYou key={`${item.kind}:${item.id}`} subject={{ kind: item.kind, id: item.id, name: item.name || (item.kind === "bot" ? state.bots.find(bot => bot.id === item.id)?.name : state.groups.find(group => group.id === item.id)?.name) || t("memorySettings.sharedNotes") }} />)}
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {status && <>
      {!workspacePage && <MemoryHealth status={status} />}
      <MemoryUpgradeDetail />
      {workspacePage && <InAdvanced><div id="memory-storage-heading"><MemoryStorageReclaim /></div></InAdvanced>}
      {!botId && people && <div id="memory-people-heading"><MemoryPeople people={people} audiences={audiences} disabled={false} onLink={changePerson} onShare={sharePerson} onRefresh={loadPeople} /></div>}
      {compact ? <p role="status" className="text-[13px] text-ink-secondary">{memoryModeDescription(upgradeContext, status)}{status.mode !== "active" && <>{" "}{t("memorySettings.savedRecordsRemain")}</>}{status.workerError ? <>{" "}{t("memorySettings.processingAttention")}</> : status.runtime?.indexing ? <>{" "}{t("memorySettings.indexUpdating")}</> : ""}</p> : <>
      <p className="text-[12px] text-ink-secondary">{botId ? `${t(records.length === 1 ? "memorySettings.pageOne" : "memorySettings.pageOther", { n: records.length })}${cursor ? ` ${t("memorySettings.moreAvailable")}` : ""}` : t(status.records.active === 1 && !status.recordsMore?.active ? "memorySettings.savedOne" : "memorySettings.savedOther", { count: countText(status.records.active, status.recordsMore?.active), waiting: waiting.total })}{" "}{t("memorySettings.workspaceMode", { mode: status.mode === "active" ? t("memorySettings.mode.active") : status.mode === "capture" ? t("memorySettings.mode.capture") : status.mode === "paused" ? t("memorySettings.mode.paused") : t("memorySettings.mode.off") })}</p>
      <p className="text-[12px] text-ink-secondary">{memoryModeDescription(upgradeContext, status)} {status.semantic ? semanticPhrase(status.semantic) : status.mode === "active" && status.model.state !== "ready" ? t("memorySettings.keywordOnly") : status.model.state === "ready" ? status.model.bundled ? t("memorySettings.smartReady") : t("memorySettings.semanticReady") : t("memorySettings.modelNotReady")} {status.workerError ? t("memorySettings.processingAttention") : status.runtime?.indexing ? t("memorySettings.indexUpdating") : ""}</p>
      </>}
      {status.workerError && <p role="status" className="text-[13px] text-ink-secondary">{workerSentence(status.workerError)}</p>}
      {!compact && botId && <div className="space-y-2 text-[13px]"><p className="text-ink-secondary">{t("memorySettings.botNote")}</p><button type="button" className={memoryButtonClass} onClick={() => { onNavigate?.(); dispatch({ type: "toggleAppSettings", open: true, section: "memory" }); }}>{t("memorySettings.openWorkspace")}</button></div>}
      {!compact && status.mode === "off" && <div className="space-y-2 rounded-lg border border-hairline/50 p-3 text-[13px]"><p>{t("memorySettings.off.note")}</p><button type="button" className={memoryButtonClass} disabled={acting} onClick={() => go({ action: "enable-and-import" }, t("memorySettings.off.enabled"))}>{acting ? t("memorySettings.working") : t("memorySettings.off.button")}</button></div>}
      <nav aria-label={t("memorySettings.viewsLabel")} className="flex flex-wrap gap-2">{([["search", t("memorySettings.search")], ["important", t("memorySettings.important")], ["recent", t("memorySettings.recent")], ["review", t("memorySettings.waitingView")]] as const).map(([value, label]) => <button key={value} type="button" disabled={acting} aria-label={value === "search" ? t("memorySettings.searchView") : label} aria-pressed={view === value} className={`${memoryButtonClass} ${view === value ? "border-focus bg-inset" : ""}`} onClick={() => void run(async () => { setView(value); setRecordState(""); setInspection(null); await loadRecords(undefined, { query, scopeId, recordState: "", view: value }); if (value === "review") await loadConflicts(); })}>{label}</button>)}</nav>
      <form className="grid min-w-0 gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))" }} onSubmit={event => { event.preventDefault(); setInspection(null); void run(() => loadRecords(undefined, { query, scopeId, recordState, view })); }}>
        <label className="col-span-full block min-w-0 space-y-1 text-[13px]">{t("memorySettings.searchMemory")}<input className={memoryInputClass} value={query} maxLength={4096} onChange={event => setQuery(event.target.value)} /></label>
        {compact ? <Disclosure className="col-span-full border-0 p-0" label={<>{t("memorySettings.filters")}{scopeId || recordState ? <>{" "}{t("memorySettings.filtersSelected")}</> : ""}</>}><div className="space-y-3 pt-2">{filters}</div></Disclosure> : filters}
        <button className={memoryButtonClass} disabled={acting}>{acting ? t("memorySettings.working") : t("memorySettings.search")}</button>
      </form>
      {matchCountLabel && <p className="text-[12px] text-ink-secondary">{matchCountLabel === "1" ? t("memorySettings.matchOne") : t("memorySettings.matchOther", { count: matchCountLabel })}</p>}
      {searchNotice && <p role="status" className="text-[12px] text-ink-secondary">{searchNotice}</p>}
      {compact && records.length > 0 && <p className="text-[12px] text-ink-secondary">{t(records.length === 1 ? "memorySettings.pageOne" : "memorySettings.pageOther", { n: records.length })}{cursor ? ` ${t("memorySettings.moreAvailable")}` : ""}</p>}
      <ul aria-label={t("memorySettings.recordsLabel")} className="space-y-2">
        {records.map(record => <li key={`${record.id}:${record.version}`} className="rounded-lg border border-hairline/40 p-3" data-memory-id={record.id}>
          <p className="whitespace-pre-wrap break-words text-[13px] line-clamp-3">{memoryRecordText(record)}</p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-[12px] text-ink-secondary">{!compact && <>{recordAudienceLabel(record.scopeId, audiences, answeredScopes.has(record.scopeId))} · </>}{memoryStateLabel(record.state)}{record.ownerPinned ? ` ${t("memorySettings.pinned")}` : ""}{!compact && <> · {memoryRecordOriginLabel(record)}</>} · <time dateTime={new Date(record.validFrom).toISOString()}>{new Date(record.validFrom).toLocaleDateString()}</time></span><button className={memoryButtonClass} disabled={acting} onClick={() => void run(async () => { const result = await request({ action: "inspect", id: record.id, version: record.version }); if (mounted.current) setInspection(result); })}>{t("memorySettings.inspect")}</button></div>
        </li>)}
      </ul>
      {!records.length && <p className="text-[13px] text-ink-secondary">{t("memorySettings.noMatches")}</p>}
      {(cursor || pageIndex > 0) && <nav aria-label={t("memorySettings.pagesLabel")} className="flex items-center gap-3"><button className={memoryButtonClass} disabled={pageIndex === 0} onClick={() => void run(async () => { const previous = pageIndex - 1; const history = pageCursors; await loadRecords(history[previous]); setPageCursors(history); setPageIndex(previous); setInspection(null); })}>{t("memorySettings.previousPage")}</button><span className="text-[12px] text-ink-secondary">{t("memorySettings.page", { n: pageIndex + 1 })}</span><button className={memoryButtonClass} disabled={!cursor} onClick={() => void run(async () => { const next = pageIndex + 1; const history = [...pageCursors.slice(0, next), cursor]; await loadRecords(cursor); setPageCursors(history); setPageIndex(next); setInspection(null); })}>{t("memorySettings.nextPage")}</button></nav>}
      {view === "review" && <section aria-label={t("memorySettings.changes.aria")} className="space-y-2"><h3 className="text-[14px] font-medium">{t("memorySettings.changes.title")}</h3><p className="text-[12px] text-ink-secondary">{t("memorySettings.changes.note")}</p>{conflicts.map(link => <div key={link.id} className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px]"><p>{link.selection.kind === "bot" ? t("memorySettings.botTopic", { name: state.bots.find(bot => bot.id === link.selection.botId)?.name ?? t("memorySettings.botGone"), topic: link.selection.topic ?? "MEMORY.md" }) : t("memorySettings.teamBrief", { section: link.selection.section || t("memorySettings.general") })}</p><p className="text-ink-secondary">{link.error === "MEMORY_IMPORT_REVIEW_CONFLICT" ? t("memorySettings.changes.conflict") : importSentence(link.error, t("memorySettings.changes.attention"))}</p><button className={memoryButtonClass} onClick={() => go({ action: "import-stop-tracking", id: link.id }, t("memorySettings.changes.stopped"))}>{t("memorySettings.changes.stop")}</button></div>)}{!conflicts.length && <p className="text-[12px] text-ink-secondary">{t("memorySettings.changes.none")}</p>}{conflictCursor && <button className={memoryButtonClass} onClick={() => void run(() => loadConflicts(conflictCursor))}>{t("memorySettings.changes.next")}</button>}</section>}
      {inspection && <MemoryReview key={`${inspection.record.id}:${inspection.record.version}`} inspection={inspection} audiences={audiences} onAction={perform} onClose={() => setInspection(null)} />}

      {compact && <div className="space-y-2 border-t border-hairline/40 pt-3 text-[13px]"><p className="text-ink-secondary">{t("memorySettings.compactNote")}</p><button type="button" className={memoryButtonClass} onClick={() => { onNavigate?.(); dispatch({ type: "toggleAppSettings", open: true, section: "memory" }); }}>{t("memorySettings.openWorkspace")}</button></div>}
      {!compact && status.retention && <p className="text-[12px] text-ink-secondary">{t("memorySettings.retention")}</p>}
      {workspacePage && <InAdvanced>
        <MemoryEvolutionControls status={status.evolution??null} disabled={acting} onRefresh={loadStatus}/>
        <MemoryEvolutionControls kind="classification" status={status.classificationEvolution??null} disabled={acting} onRefresh={loadStatus}/>
        <ProcedureEvaluationAdmissions status={status.procedureEvolution??null} disabled={acting} onRefresh={loadStatus}/>
        {!status.model.bundled && <section aria-label={t("memorySettings.model.title")} className="rounded-lg border border-hairline/40 p-3 text-[13px]"><h3 className="text-[14px] font-medium">{t("memorySettings.model.title")}</h3>
          <p className="mt-1" data-testid="memory-model-status">{({ missing: t("memorySettings.model.missing"), unverified: t("memorySettings.model.unverified"), downloading: t("memorySettings.model.downloading", { percent: status.model.totalBytes > 0 ? Math.round(100 * status.model.bytesDownloaded / status.model.totalBytes) : 0 }), ready: t("memorySettings.model.ready"), failed: t("memorySettings.model.failed") } as const)[status.model.state]}</p>
          {status.model.state === "downloading" && <progress data-testid="memory-model-progress" aria-label={t("memorySettings.model.progress")} className="h-2 w-full accent-accent" max={100} value={status.model.totalBytes > 0 ? Math.round(100 * status.model.bytesDownloaded / status.model.totalBytes) : 0} />}
          {status.model.state === "ready" && <p role="status" className="text-success">{t("memorySettings.model.finished")}</p>}
          {status.model.state !== "ready" && <p className="text-ink-secondary">{t("memorySettings.model.smartNote")}</p>}
          {status.model.error && <p role="alert" className="text-danger">{modelSentence(status.model.error)}</p>}
          <div className="mt-2"><ActionButton action={download} className={memoryButtonClass} blocked={status.model.state === "downloading" || status.model.state === "ready" || acting}>{t("memorySettings.download.button")}</ActionButton></div>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("memorySettings.model.downloadNote")}</p></section>}
        <MemoryHealth status={status} open />
        <section aria-labelledby="memory-reindex-heading" className="rounded-lg border border-hairline/40 p-3 text-[13px]"><h3 id="memory-reindex-heading" className="text-[14px] font-medium">{t("settings.reindex.title")}</h3>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("settings.reindex.note")}</p>
          {status.semantic && <p role="status" data-testid="memory-reindex-progress" className="mt-1">{semanticPhrase(status.semantic)}</p>}
          {status.mode === "off" && <p className="mt-1 text-ink-secondary">{t("settings.reindex.off")}</p>}
          {status.mode !== "off" && status.model.state !== "ready" && <p className="mt-1 text-ink-secondary">{t("settings.reindex.modelNotReady")}</p>}
          <div className="mt-2"><ActionButton action={rebuild} className={memoryButtonClass} blocked={acting || status.mode === "off" || status.model.state !== "ready" || status.semantic?.state === "indexing"}>{t("settings.reindex.button")}</ActionButton></div></section>
        <section aria-label={t("memorySettings.excluded.title")} className="rounded-lg border border-hairline/40 p-3">
          <h3 className="text-[14px] font-medium">{t("memorySettings.excluded.title")}</h3>
          <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); go({ action: "configure", excludedThreadIds: excluded }, t("memorySettings.excluded.saved")); }}>
            <fieldset className="space-y-3" disabled={acting}><legend className="sr-only">{t("memorySettings.excluded.legend")}</legend>
              <fieldset className="space-y-1"><legend className="text-[13px] font-medium">{t("memorySettings.excluded.exclude")}</legend><p className="text-[12px] text-ink-secondary">{t("memorySettings.excluded.note")}</p>{threads.map(thread => <label key={thread.id} className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" checked={excluded.includes(thread.id)} onChange={event => setExcluded(previous => event.target.checked ? [...previous, thread.id] : previous.filter(id => id !== thread.id))} />{thread.label}</label>)}</fieldset>
              <button className={memoryButtonClass}>{acting ? t("memorySettings.working") : t("memorySettings.excluded.save")}</button>
            </fieldset>
          </form>
          <div className="mt-4 space-y-2 text-[12px] text-ink-secondary"><h4 className="text-[13px] font-medium text-ink">{t("memorySettings.backlog.title")}</h4><p>{t("memorySettings.backlog", { pending: countText(status.backlog.pending, status.backlog.more?.pending), leased: countText(status.backlog.leased, status.backlog.more?.leased), deferred: countText(status.backlog.deferred, status.backlog.more?.deferred), failed: countText(status.backlog.failed, status.backlog.more?.failed) })}</p>{status.backlog.oldestQueuedAt !== null && <p>{t("memorySettings.oldestQueued", { date: new Date(status.backlog.oldestQueuedAt).toLocaleString() })}</p>}<p>{t("memorySettings.deletionPending", { count: countText(status.deletion.pending, status.deletion.more) })}</p>{status.workerError && <p role="status">{workerSentence(status.workerError)}</p>}
          </div>
        </section>
        <section aria-label={t("memorySettings.audienceAccess")} className="rounded-lg border border-hairline/40 p-3"><h3 id="memory-audience-heading" className="text-[14px] font-medium">{folderMemoryUsed ? t("memorySettings.audienceAccessFolder") : t("memorySettings.audienceAccess")}</h3><p className="mt-1 text-[12px] text-ink-secondary">{t("memorySettings.access.note")}</p><fieldset className="mt-3 space-y-3" disabled={acting}><legend className="sr-only">{t("memorySettings.access.legend")}</legend>
          <label className="block space-y-1 text-[13px]">{t("memorySettings.access.allowFor")}<select className={memoryInputClass} value={subject} onChange={event => setSubject(event.target.value)}><option value="">{t("memorySettings.access.chooseSubject")}</option>{subjects.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <form className="space-y-2" onSubmit={event => { event.preventDefault(); go({ action: "bind", scopeId: bindingScope, ...subjectFields() }, t("memorySettings.access.saved")); }}><label className="block space-y-1 text-[13px]">{t("memorySettings.access.shared")}<select className={memoryInputClass} value={bindingScope} onChange={event => setBindingScope(event.target.value)}><option value="">{t("memorySettings.access.chooseAudience")}</option>{status.scopes.filter(scope => ["project", "team", "workspace", "preferences", "room"].includes(scope.kind)).map(scope => <option key={scope.id} value={scope.id}>{memoryAudienceLabel(scope)}</option>)}</select></label><button className={memoryButtonClass} disabled={!subject || !bindingScope}>{acting ? t("memorySettings.working") : t("memorySettings.access.grant")}</button></form>
          {/* Folder memory (the "project" scope kind) is not a channel project; shown only where it is already used (plan 3.8, PM5). */}
          {folderMemoryUsed && <form className="space-y-2" onSubmit={event => { event.preventDefault(); go({ action: "project", path: projectPath, ...subjectFields() }, t("memorySettings.access.folderCreated")); }}><label className="block space-y-1 text-[13px]">{t("memorySettings.access.folder")}<input className={memoryInputClass} value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder={t("memorySettings.access.folderPlaceholder")} /></label><button className={memoryButtonClass} disabled={!subject || !projectPath.trim()}>{acting ? t("memorySettings.working") : t("memorySettings.access.addFolder")}</button></form>}
        </fieldset></section>
      </InAdvanced>}
      {status?.pastChats?.running && <p role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary" data-testid="memory-past-chats"><span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />Reading past conversations: {status.pastChats.threadsDone.toLocaleString()} of {status.pastChats.threads.toLocaleString()} read, {status.pastChats.messagesQueued >= 1000 ? "1,000+" : status.pastChats.messagesQueued.toLocaleString()} messages queued. Chat works meanwhile.</p>}
      {fluxMemory?.keyPresent && <div className="rounded-lg border border-hairline/40 p-3 text-[13px]"><div className="flex items-start justify-between gap-3"><span id="memory-use-flux">Use Flux memory. Flux Router remembers what you tell your bots in your own Flux conversations and brings it back when it helps, so they keep up with you from one chat to the next. With each of those turns Murage also sends a short copy of what it recalls, so the right details are there even when Flux has nothing to add. Murage's own memory keeps working either way. Switch this off any time: from your next message, Flux stops saving and adding memory, and Murage carries your memory on its own.</span><Switch aria-labelledby="memory-use-flux" checked={fluxMemory.external} onClick={toggleFluxMemory} /></div>{fluxMemory.last && <p className="mt-2 text-[12px] text-ink-secondary">Last Flux turn: {fluxMemory.last.text}</p>}</div>}
      {workspacePage && <LearnAboutMe desktop={desktop} memoryActive={status.mode === "active"} request={request} />}
      {!compact && <section aria-label={t("memorySettings.import.title")} className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 id="memory-import-heading" className="text-[14px] font-medium">{t("memorySettings.import.title")}</h3><p className="text-[13px] text-ink-secondary">{t("memorySettings.import.subtitle")}</p></div><button type="button" className={memoryButtonClass} aria-expanded={importOpen} aria-controls="memory-import-panel" onClick={() => setImportOpen(!importOpen)}>{importOpen ? t("memorySettings.import.hide") : t("memorySettings.import.title")}</button></div>
        <div id="memory-import-panel" hidden={!importOpen} className="space-y-3 rounded-lg border border-hairline/40 p-3"><p className="text-[12px] text-ink-secondary">{t("memorySettings.import.previewNote")}</p>
        <MemoryNotebookPicker botId={botId} onPreview={setPreview} />
        <div className="flex items-start justify-between gap-3 text-[13px]"><span id="memory-track-imports">{t("memorySettings.import.track")}</span><Switch aria-labelledby="memory-track-imports" checked={trackImports} onClick={() => setTrackImports(!trackImports)} /></div>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void run(async () => {
          const separator = importChoice.indexOf(":"); const kind = importChoice.slice(0, separator), value = importChoice.slice(separator + 1);
          const selection = kind === "bot" ? { kind, botId: value, ...(topic.trim() ? { topic: topic.trim() } : {}) } : { kind: "section", section: value };
          const result = await request({ action: "import-preview", selections: [selection] }); if (mounted.current) setPreview(result);
          return t("memorySettings.import.previewReady");
        }); }}>
          <label className="block space-y-1 text-[13px]">{t("memorySettings.import.notes")}<select className={memoryInputClass} value={importChoice} onChange={event => { setImportChoice(event.target.value); setPreview(null); }}><option value="">{t("memorySettings.import.choose")}</option>{state.bots.filter(bot => !botId || bot.id === botId).map(bot => <option key={bot.id} value={`bot:${bot.id}`}>{t("memorySettings.import.notebookOption", { name: bot.name })}</option>)}{!botId && sections.map(section => <option key={section} value={`section:${section}`}>{t("memorySettings.import.teamBriefOption", { section: section || t("memorySettings.general") })}</option>)}</select></label>
          {importChoice.startsWith("bot:") && <label className="block space-y-1 text-[13px]">{t("memorySettings.import.topic")}<input className={memoryInputClass} value={topic} onChange={event => { setTopic(event.target.value); setPreview(null); }} placeholder={t("memorySettings.import.topicPlaceholder")} /></label>}
          <button className={memoryButtonClass} disabled={!importChoice || acting}>{acting ? t("memorySettings.working") : t("memorySettings.import.preview")}</button>
        </form>
        {preview && <section aria-label={t("memorySettings.import.previewLabel")} className="space-y-2">{preview.items.map(item => <div key={item.path} className="rounded-lg border border-hairline/40 p-3"><p className="break-all text-[12px]">{item.path}</p><p className="text-[12px] text-ink-secondary">{item.scopeLabel} · {item.alreadyImported ? t("memorySettings.import.already") : t("memorySettings.import.new")}</p><p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{item.text}</p></div>)}<p className="text-[12px] text-ink-secondary">{t("memorySettings.import.expires", { date: new Date(preview.expiresAt).toLocaleString() })}</p><button className={memoryButtonClass} disabled={preview.expiresAt <= Date.now() || acting} onClick={() => void run(async () => { const result = await request({ action: "import-commit", previewId: preview.previewId, track: trackImports }); if (!mounted.current) return; setPreview(null); await Promise.all([loadStatus(), loadRecords()]); return t("memorySettings.import.result", { imported: result.imported, skipped: result.skipped, originals: result.originals }); })}>{acting ? t("memorySettings.working") : t("memorySettings.import.commit")}</button></section>}
      </div></section>}
    </>}
    <div className="sticky bottom-3 z-10 rounded-lg bg-card/95 px-1"><ActionStatus action={doing} /></div>
  </section>;
}
