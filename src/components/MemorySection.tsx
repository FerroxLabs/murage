// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { useAction } from "@/lib/use-action";
import { openDeepLink } from "@/lib/deep-link";
import { useMemoryWaiting } from "@/lib/use-memory-waiting";
import type { SettingsPage } from "@/lib/settings-pages";
import {
  formatTokens, learnAsWeTalk, learnAsWeTalkPatch, learningConnectionLabel, raisedCeiling, requestLearningAction, skippedSliceRetry,
  type LearningAction, type LearningEvent, type LearningPage, type LearningSource, type MemoryLearning,
} from "@/lib/memory-learning";
import { ceilingStatusLine, learningEventLabel, learningRequestError, memoryStatusLine, skippedSliceMessage } from "@/lib/memory-learning-text";
import { ActionButton, ActionStatus } from "./ActionButton";
import { AdvancedHost, AdvancedSection, AdvancedSlotTarget, Card, InAdvanced, Switch } from "./SettingsPrimitives";
import { MemorySettings, type MemoryStatus } from "./MemorySettings";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";
const buttonClass = `${memoryButtonClass} min-h-11`;
interface SectionStatus {
  mode: MemoryStatus["mode"]; learning?: MemoryLearning; configuration: { extractorInstanceId: string | null }; extractors: MemoryStatus["extractors"];
  records?: MemoryStatus["records"]; recordsMore?: MemoryStatus["recordsMore"]; semantic?: MemoryStatus["semantic"];
}
type Work = () => Promise<void> | void;

/** A switch that reacts on the press, says when it is slow, and ends with a line saying what happened (or why it did not). */
function ActionSwitch({ id, label, hint, checked, disabled = false, run, success, failure }: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean; run: Work; success: string; failure?: string }) {
  const action = useAction(async () => { await run(); }, { pending: t("memoryPage.saving"), success, failure: failure ?? t("memoryPage.saveFailed"), slowHint: t("memoryPage.stillSaving") });
  return <div className="min-w-0">
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div className="min-w-0"><span id={id}>{label}</span>{hint && <p className="text-[12px] text-ink-secondary">{hint}</p>}</div>
      <Switch aria-labelledby={id} checked={checked} disabled={disabled || action.pending} aria-busy={action.pending} onClick={() => void action.run()} />
    </div>
    <ActionStatus action={action} />
  </div>;
}
/** A button with the shared pending, slow, progress and result behaviour. */
function ActionBtn({ label, pending = t("memoryPage.working"), run, success, failure, blocked = false, className = buttonClass, ...rest }: { label: string; pending?: string; run: Work; success: string | null; failure?: string; blocked?: boolean; className?: string; "aria-pressed"?: boolean; "aria-describedby"?: string; "aria-label"?: string }) {
  const action = useAction(async () => { await run(); }, { idle: label, pending, success, failure: failure ?? t("memoryPage.didNotWork"), slowHint: t("memoryPage.stillWorking") });
  return <ActionButton action={action} blocked={blocked} className={className} {...rest}>{label}</ActionButton>;
}
function ConnectionSelect({ value, options, run }: { value: string; options: ReactNode; run: (next: string) => Promise<void> | void }) {
  const action = useAction(async (next: string) => { await run(next); }, { pending: t("memoryPage.saving"), success: t("memoryPage.connection.saved"), failure: t("memoryPage.saveFailed"), slowHint: t("memoryPage.stillSaving") });
  return <div className="space-y-1">
    <label className="block space-y-1">{t("memoryPage.connection.label")}<select className={`${memoryInputClass} min-h-11`} disabled={action.pending} aria-busy={action.pending} value={value} onChange={event => void action.run(event.target.value)}>{options}</select></label>
    <ActionStatus action={action} />
  </div>;
}
const millions = (tokens: number) => String(Math.round(tokens / 100_000) / 10);
const parseMillions = (text: string): number | null => { const n = Number(text); return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 1_000_000) : null; };
/** Change the monthly limit: two numbers in millions of tokens, saved with the learning revision. */
function CeilingEditor({ ceiling, onSave, onCancel }: { ceiling: { input: number; output: number }; onSave: (next: { input: number; output: number }) => Promise<void> | void; onCancel: () => void }) {
  const [read, setRead] = useState(millions(ceiling.input)), [written, setWritten] = useState(millions(ceiling.output));
  const input = parseMillions(read), output = parseMillions(written), valid = input !== null && output !== null;
  return <div className="mt-3 space-y-3 rounded-lg border border-hairline/40 p-3 text-[13px]">
    <label className="block space-y-1">{t("memoryPage.ceiling.readLabel")}<input className={`${memoryInputClass} min-h-11`} inputMode="decimal" value={read} onChange={event => setRead(event.target.value)} /></label>
    <label className="block space-y-1">{t("memoryPage.ceiling.writtenLabel")}<input className={`${memoryInputClass} min-h-11`} inputMode="decimal" value={written} onChange={event => setWritten(event.target.value)} /></label>
    {!valid && <p role="status" className="text-[12px] text-ink-secondary">{t("memoryPage.ceiling.invalid")}</p>}
    {valid && (input === 0 || output === 0) && <p role="status" className="text-[12px] text-ink-secondary">{t("memoryPage.ceiling.zero")}</p>}
    <div className="flex flex-wrap items-start gap-2">
      <ActionBtn label={t("memoryPage.ceiling.save")} pending={t("memoryPage.saving")} blocked={!valid} success={t("memoryPage.ceiling.saved")} run={() => onSave({ input: input!, output: output! })} />
      <button type="button" className={buttonClass} onClick={onCancel}>{t("memoryPage.cancel")}</button>
    </div>
  </div>;
}
/** A retry the server no longer knows (404, MEMORY_SKIPPED_SLICE_UNKNOWN) was retried already. */
const isAlreadyRetried = (cause: unknown) => (cause as { status?: number } | null)?.status === 404 || (cause instanceof Error && cause.message.includes("MEMORY_SKIPPED_SLICE_UNKNOWN"));
const percentOf = (used: number, limit: number) => limit > 0 ? Math.min(100, Math.round(100 * used / limit)) : 100;
const modeSentence = (mode: MemoryStatus["mode"]): string => ({
  active: t("memoryPage.modeSentence.active"),
  capture: t("memoryPage.modeSentence.capture"),
  paused: t("memoryPage.modeSentence.paused"),
  off: t("memoryPage.modeSentence.off"),
})[mode];

interface ContentProps {
  status: SectionStatus; bots: Array<{ id: string; name: string }>;
  events: LearningEvent[]; cursor: string | null; filter: string; busy: boolean; historyBusy: boolean;
  refusals: Record<string, string>; workspace: ReactNode; waiting?: number;
  /** Events whose skipped part has been retried: the row says so instead of offering Try again again. */
  retried?: ReadonlySet<string>; onRetried?(eventId: string): void;
  /** Runs one request. It resolves when the server has answered and throws a plain sentence when it refused. */
  onAction(action: LearningAction): Promise<void> | void;
  onFilter(botId: string): void; onMore(): Promise<void> | void; onOpen(source: LearningSource): void; onRefresh(): Promise<void> | void;
  /** Opens the page's Advanced and scrolls to the monthly limit. */
  onOpenAdvanced?(): void;
}
export function EventRow({ event, busy, refusal, retried = false, onRetried, onAction, onOpen }: { event: LearningEvent; busy: boolean; refusal?: string; retried?: boolean; onRetried?: () => void; onAction: ContentProps["onAction"]; onOpen: ContentProps["onOpen"] }) {
  const lesson = event.lesson ?? null, retry = skippedSliceRetry(event);
  const changeable = (["activated", "superseded"].includes(event.kind) && event.undone_at === null) || (event.kind === "lesson-learned" && lesson?.state === "active");
  const changed = lesson ? false : !event.record || event.record.version !== event.record_version || event.record.state !== "active";
  const reason = refusal ?? (changed ? t("memoryPage.event.changed") : undefined);
  const from = event.source?.roomName ? t("memoryPage.event.fromRoom", { name: event.source.roomName }) : event.source?.botName ? t("memoryPage.event.fromBot", { name: event.source.botName }) : t("memoryPage.event.fromChat");
  return <li className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px]">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{learningEventLabel(event.kind)}</h3><time className="text-[12px] text-ink-secondary" dateTime={new Date(event.created_at).toISOString()}>{new Date(event.created_at).toLocaleString()}</time></div>
    {retry
      ? <><p className="break-words">{skippedSliceMessage()}</p><p className="text-[12px] text-ink-secondary">{event.scopeLabel}</p></>
      : <><p className="whitespace-pre-wrap break-words">{lesson?.text ?? event.record?.text ?? t("memoryPage.event.removed")}</p><p className="text-[12px] text-ink-secondary">{event.scopeLabel}</p></>}
    {event.source && <a className="inline-flex min-h-11 items-center text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" href={`#open=${encodeURIComponent(event.source.threadId)}${event.source.messageId ? `&msg=${encodeURIComponent(event.source.messageId)}` : ""}`} onClick={e => { e.preventDefault(); onOpen(event.source!); }}>{from}</a>}
    {retry && (retried ? <p role="status" className="text-[12px] text-ink-secondary">{t("memoryPage.event.retriedNote")}</p>
      : <ActionBtn label={t("memoryPage.event.retry")} pending={t("memoryPage.event.retrying")} blocked={busy} success={t("memoryPage.event.retryingDone")} failure={t("memoryPage.event.retryFailed")} run={async () => { await onAction(retry); onRetried?.(); }} />)}
    {changeable && <><div className="flex flex-wrap items-start gap-2">
      <ActionBtn label={event.kept_at !== null ? t("memoryPage.event.kept") : t("memoryPage.event.keep")} pending={t("memoryPage.event.keeping")} blocked={busy || changed || event.kept_at !== null} success={t("memoryPage.event.keptDone")} run={() => onAction({ action: "learning-keep", eventId: event.id })} />
      <ActionBtn label={t("memoryPage.event.undo")} pending={t("memoryPage.event.undoing")} blocked={busy || Boolean(reason)} aria-describedby={reason ? `learning-refusal-${event.id}` : undefined} success={t("memoryPage.event.undone")} run={() => onAction({ action: "learning-undo", eventId: event.id })} />
    </div>{reason && <p id={`learning-refusal-${event.id}`} className="text-[12px] text-ink-secondary">{reason}</p>}</>}
  </li>;
}

export function MemorySectionContent({ status, bots, events, cursor, filter, busy, historyBusy, refusals, workspace, waiting = 0, retried, onRetried, onAction, onFilter, onMore, onOpen, onRefresh, onOpenAdvanced }: ContentProps) {
  const learning = status.learning, settings = learning?.settings;
  const configure = (value: Partial<Omit<NonNullable<typeof settings>, "version" | "ceiling">>): Work => () => onAction({ action: "configure", learning: value, learningRevision: learning!.revision });
  const setMode = (mode: MemoryStatus["mode"]): Work => () => onAction({ action: "configure", mode });
  const stored = status.configuration.extractorInstanceId;
  const fast = status.extractors.find(item => item.instanceId === "@murage/flux-fast");
  const selected = stored === "@murage/flux-fast" ? "" : stored ?? "";
  const ceiling = learning?.ceiling, ceilingLine = ceiling ? ceilingStatusLine(ceiling) : null;
  const composite = settings ? learnAsWeTalk(settings) : null;
  const memories = status.records?.active ?? 0;
  return <div className="min-w-0 space-y-4" data-testid="memory-section">
    <section aria-label={t("memoryPage.title")}><Card>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="memory-status-heading" className="text-[15px] font-medium">{t("memoryPage.title")}</h2><ActionBtn label={t("memoryPage.refresh")} pending={t("memoryPage.refreshing")} blocked={busy || historyBusy} success={t("memoryPage.upToDate")} failure={t("memoryPage.refreshFailed")} run={onRefresh} /></div>
      <p className="mt-1 text-[13px] text-ink-secondary">{t("memoryPage.subtitle")}</p>
      <div className="mt-3 text-[13px]">
        <ActionSwitch id="memory-on-label" label={t("memoryPage.on.label")} hint={status.mode === "capture" ? t("memoryPage.on.captureHint") : undefined} checked={status.mode === "active"} disabled={busy}
          run={setMode(status.mode === "active" ? "paused" : "active")} success={status.mode === "active" ? t("memoryPage.on.pausedDone") : t("memoryPage.on.onDone")} />
        {!learning || !settings ? <p role="status" className="mt-3 text-[13px] text-ink-secondary">{t("memoryPage.learningUnavailable")}</p> : <div className="mt-3 space-y-2">
          <p role="status">{memoryStatusLine({ mode: status.mode, learning, memories, memoriesMore: status.recordsMore?.active, waiting, semantic: status.semantic })}</p>
          {ceilingLine && <p className="flex flex-wrap items-center gap-2 text-ink-secondary">{ceilingLine.text}
            {ceilingLine.follow === "raise" && <ActionBtn label={t("memoryPage.ceiling.raise")} pending={t("memoryPage.ceiling.raising")} blocked={busy} success={t("memoryPage.ceiling.raised")} failure={t("memoryPage.ceiling.raiseFailed")} run={() => onAction({ action: "configure", ceiling: raisedCeiling(ceiling!), learningRevision: learning.revision })} />}
            {ceilingLine.follow === "advanced" && onOpenAdvanced && <button type="button" className={buttonClass} onClick={onOpenAdvanced}>{t("memoryPage.openAdvanced")}</button>}
          </p>}
        </div>}
      </div>
    </Card></section>
    {learning && settings && composite && <section aria-label={t("memoryPage.learn.title")}><Card><h2 id="memory-how-heading" className="text-[15px] font-medium">{t("memoryPage.learn.title")}</h2><div className="mt-3 space-y-1 text-[13px]">
      <ActionSwitch id="memory-learn-label" label={t("memoryPage.learn.asWeTalk")} hint={composite.partial ? t("memoryPage.learn.partly", { what: composite.partial }) : t("memoryPage.learn.asWeTalkHint")} checked={composite.on} disabled={busy}
        run={configure(learnAsWeTalkPatch(settings))} success={composite.on ? t("memoryPage.learn.asWeTalkOff") : t("memoryPage.learn.asWeTalkOn")} />
      <ActionSwitch id="memory-review-label" label={t("memoryPage.learn.review")} hint={t("memoryPage.learn.reviewHint")} checked={settings.reviewMode} disabled={busy}
        run={configure({ reviewMode: !settings.reviewMode })} success={settings.reviewMode ? t("memoryPage.learn.reviewOff") : t("memoryPage.learn.reviewOn")} />
      <ActionSwitch id="memory-chats-label" label={t("memoryPage.learn.chats")} checked={settings.learnFrom.chats} disabled={busy}
        run={configure({ learnFrom: { ...settings.learnFrom, chats: !settings.learnFrom.chats } })} success={settings.learnFrom.chats ? t("memoryPage.learn.chatsOff") : t("memoryPage.learn.chatsOn")} />
      <ActionSwitch id="memory-channels-label" label={t("memoryPage.learn.channels")} checked={settings.learnFrom.channels} disabled={busy}
        run={configure({ learnFrom: { ...settings.learnFrom, channels: !settings.learnFrom.channels } })} success={settings.learnFrom.channels ? t("memoryPage.learn.channelsOff") : t("memoryPage.learn.channelsOn")} />
    </div></Card></section>}
    <section aria-label={t("memoryPage.bots.title")}><Card><h2 id="memory-bots-heading" className="text-[15px] font-medium">{t("memoryPage.bots.title")}</h2><p className="mt-1 text-[13px] text-ink-secondary">{t("memoryPage.bots.subtitle")}</p><ul className="mt-3 divide-y divide-hairline/40">{bots.map(bot => <li key={bot.id} className="min-h-16 py-2 text-[13px]">
      <ActionSwitch id={`memory-bot-${bot.id}`} label={bot.name} hint={t("memoryPage.bots.hint")} checked={Boolean(settings && !settings.botsPaused.includes(bot.id))} disabled={busy || !learning}
        run={() => onAction({ action: "learning-bot", botId: bot.id, enabled: settings!.botsPaused.includes(bot.id), learningRevision: learning!.revision })} success={settings?.botsPaused.includes(bot.id) ? t("memoryPage.bots.learningAgain", { name: bot.name }) : t("memoryPage.bots.paused", { name: bot.name })} />
    </li>)}</ul>{!bots.length && <p className="mt-3 text-[13px] text-ink-secondary">{t("memoryPage.bots.empty")}</p>}</Card></section>
    <section aria-label={t("memoryPage.history.title")}><Card><h2 id="memory-learned-heading" className="text-[15px] font-medium">{t("memoryPage.history.title")}</h2><div className="mt-3 space-y-3">
      <label className="block space-y-1 text-[13px]">{t("memoryPage.history.filter")}<select className={`${memoryInputClass} min-h-11`} value={filter} disabled={busy} onChange={event => onFilter(event.target.value)}><option value="">{t("memoryPage.history.allBots")}</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      {historyBusy && <p role="status" className="text-[13px] text-ink-secondary">{t("memoryPage.history.loading")}</p>}
      <ul aria-label={t("memoryPage.history.listLabel")} className="space-y-3">{events.map(event => <EventRow key={event.id} event={event} busy={busy} refusal={refusals[event.id]} retried={retried?.has(event.id)} onRetried={() => onRetried?.(event.id)} onAction={onAction} onOpen={onOpen} />)}</ul>
      {!historyBusy && !events.length && <p className="text-[13px] text-ink-secondary">{t("memoryPage.history.empty")}</p>}
      {cursor && <ActionBtn label={t("memoryPage.history.seeAll")} pending={t("memoryPage.loading")} blocked={busy || historyBusy} success={null} failure={t("memoryPage.history.moreFailed")} run={onMore} />}
    </div></Card></section>
    {learning && settings && ceiling && <InAdvanced>
      <section aria-label={t("memoryPage.mode.title")} className="rounded-lg border border-hairline/40 p-3 text-[13px]">
        <h3 id="memory-mode-heading" className="text-[14px] font-medium">{t("memoryPage.mode.title")}</h3>
        <div role="group" aria-label={t("memoryPage.mode.title")} className="mt-2 flex flex-wrap items-start gap-2">
          {([["active", t("memoryPage.mode.on")], ["capture", t("memoryPage.mode.capture")], ["paused", t("memoryPage.mode.paused")]] as const).map(([mode, label]) => <ActionBtn key={mode} label={label} aria-pressed={status.mode === mode} blocked={busy || status.mode === mode} className={`${buttonClass} ${status.mode === mode ? "border-focus bg-inset" : ""}`} success={t("memoryPage.mode.set", { label })} run={setMode(mode)} />)}
          {status.mode === "off" && <span className="inline-flex min-h-11 items-center px-2 text-ink-secondary">{t("memoryPage.mode.offNow")}</span>}
        </div>
        <p className="mt-2 text-[12px] text-ink-secondary">{modeSentence(status.mode)}</p>
        <div className="mt-2 space-y-1">
          <ActionSwitch id="memory-facts-label" label={t("memoryPage.mode.facts")} checked={settings.automaticFacts} disabled={busy} run={configure({ automaticFacts: !settings.automaticFacts })} success={settings.automaticFacts ? t("memoryPage.mode.factsOff") : t("memoryPage.mode.factsOn")} />
          <ActionSwitch id="memory-procedures-label" label={t("memoryPage.mode.procedures")} checked={settings.automaticProcedures} disabled={busy} run={configure({ automaticProcedures: !settings.automaticProcedures })} success={settings.automaticProcedures ? t("memoryPage.mode.proceduresOff") : t("memoryPage.mode.proceduresOn")} />
        </div>
      </section>
      <LimitCard ceiling={ceiling} busy={busy} onSave={next => onAction({ action: "configure", ceiling: next, learningRevision: learning.revision })} />
      <section aria-label={t("memoryPage.connection.title")} className="rounded-lg border border-hairline/40 p-3 text-[13px]">
        <h3 id="memory-connection-heading" className="text-[14px] font-medium">{t("memoryPage.connection.title")}</h3>
        <div className="mt-2 space-y-2">
          <ConnectionSelect value={selected} run={next => onAction({ action: "configure", extractorInstanceId: next || null })} options={<>
            <option value="">{stored === "@murage/flux-fast" ? t("memoryPage.connection.fluxChosen") : fast?.eligible ? t("memoryPage.connection.fluxDefault") : t("memoryPage.connection.fluxAddKey")}</option>
            {selected && !status.extractors.some(item => item.instanceId === selected) && <option value={selected} disabled>{t("memoryPage.connection.unavailable", { name: learningConnectionLabel(learning.connection.label) })}</option>}
            {status.extractors.filter(item => item.instanceId !== "@murage/flux-fast").map(item => <option key={item.instanceId} value={item.instanceId} disabled={!item.eligible}>{learningConnectionLabel(item.label)}{!item.eligible ? `: ${item.reason ?? t("memoryPage.connection.reasonFallback")}` : ""}</option>)}
          </>} />
          <p className="text-[12px] text-ink-secondary">{t("memoryPage.connection.note")}</p>
          {learning.connection.suggestion && <p className="flex flex-wrap items-center gap-2 text-ink-secondary">{t("memoryPage.connection.canUse", { name: learning.connection.suggestion.label })}<ActionBtn label={t("memoryPage.connection.use", { name: learning.connection.suggestion.label })} blocked={busy} success={t("memoryPage.connection.saved")} run={() => onAction({ action: "configure", extractorInstanceId: learning.connection.suggestion!.instanceId })} /></p>}
        </div>
      </section>
    </InAdvanced>}
    {workspace}
  </div>;
}
function LimitCard({ ceiling, busy, onSave }: { ceiling: NonNullable<MemoryLearning["ceiling"]>; busy: boolean; onSave: (next: { input: number; output: number }) => Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  const rows = [[t("memoryPage.limit.read"), ceiling.inputUsed, ceiling.input], [t("memoryPage.limit.written"), ceiling.outputUsed, ceiling.output]] as const;
  return <section aria-label={t("memoryPage.limit.title")} className="rounded-lg border border-hairline/40 p-3 text-[13px]">
    <h3 id="memory-limit-heading" className="text-[14px] font-medium">{t("memoryPage.limit.title")}</h3>
    <p className="mt-1 text-[12px] text-ink-secondary">{t("memoryPage.limit.note")}</p>
    <div className="mt-3 space-y-2">{rows.map(([name, used, limit]) => <div key={name}>
      <p>{t("memoryPage.limit.row", { name, used: formatTokens(used), limit: formatTokens(limit) })}{" "}<span className="text-ink-secondary">{percentOf(used, limit)}%</span></p>
      <progress aria-label={t("memoryPage.limit.thisMonth", { name })} className="h-2 w-full accent-accent" max={100} value={percentOf(used, limit)} />
    </div>)}</div>
    <p className="mt-2 text-[12px] text-ink-secondary">{t("memoryPage.limit.reset")}</p>
    {!editing ? <button type="button" className={`${buttonClass} mt-2`} disabled={busy} onClick={() => setEditing(true)}>{t("memoryPage.limit.change")}</button>
      : <CeilingEditor ceiling={ceiling} onCancel={() => setEditing(false)} onSave={async next => { await onSave(next); setEditing(false); }} />}
  </section>;
}

export default function MemorySection({ advanced }: { advanced?: { section: SettingsPage; open: boolean; onOpenChange: (open: boolean) => void } } = {}) {
  const desktop = useDesktopSurface(), { state, dispatch } = useStore();
  const waiting = useMemoryWaiting();
  const [localOpen, setLocalOpen] = useState(false);
  const adv = advanced ?? { section: "memory" as SettingsPage, open: localOpen, onOpenChange: setLocalOpen };
  const [status, setStatus] = useState<MemoryStatus | null>(null), [events, setEvents] = useState<LearningEvent[]>([]), [cursor, setCursor] = useState<string | null>(null), [filter, setFilter] = useState("");
  const [working, setWorking] = useState(false), [historyBusy, setHistoryBusy] = useState(false), [error, setError] = useState<string | null>(null), [conflict, setConflict] = useState(false), [refusals, setRefusals] = useState<Record<string, string>>({}), [memoryRevision, setMemoryRevision] = useState(0), [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(false), historyGeneration = useRef(0), inFlight = useRef(false);
  // A save disables the controls, and the browser drops focus from a disabled
  // control. The control that was pressed gets focus back when the save ends,
  // so a keyboard user can press it again without finding their place.
  const pressed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (working) return;
    const target = pressed.current; pressed.current = null;
    if (!target?.isConnected || target.matches(":disabled")) return;
    const active = document.activeElement;
    if (!active || active === document.body) target.focus();
  }, [working]);
  const refreshStatus = useCallback(async () => { const value = await api("/api/memory/status") as MemoryStatus; if (mounted.current) setStatus(value); }, []);
  // `quiet` re-reads in place: the rows already shown stay until the new ones arrive, and no loading line is inserted above them.
  const loadHistory = useCallback(async (botId: string, next?: string, quiet = false) => {
    const generation = ++historyGeneration.current; setHistoryBusy(!quiet);
    try {
      const page = await requestLearningAction(api, { action: "learning-history", ...(botId ? { botId } : {}), ...(next ? { cursor: next } : {}), limit: 20 }) as LearningPage;
      if (!mounted.current || generation !== historyGeneration.current) return;
      setEvents(previous => next ? [...previous, ...page.events.filter(row => !previous.some(item => item.id === row.id))] : page.events); setCursor(page.nextCursor);
    } finally { if (!quiet && mounted.current && generation === historyGeneration.current) setHistoryBusy(false); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; historyGeneration.current++; }; }, []);
  useEffect(() => {
    if (desktop !== true) return;
    void refreshStatus().catch(() => { if (mounted.current) setError(t("memoryPage.loadFailed")); });
  }, [desktop, refreshStatus]);
  useEffect(() => {
    if (desktop !== true) return;
    setEvents([]); setCursor(null);
    void loadHistory(filter).catch(() => { if (mounted.current) setError(t("memoryPage.historyFailed")); });
  }, [desktop, filter, loadHistory]);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setWorking(true); setError(null);
    try { await Promise.all([refreshStatus(), loadHistory(filter)]); if (mounted.current) { setConflict(false); setRefusals({}); } }
    catch { throw new Error(t("memoryPage.refreshFailed")); }
    finally { inFlight.current = false; if (mounted.current) setWorking(false); }
  };
  const act = async (action: LearningAction) => {
    if (inFlight.current) throw new Error(t("memoryPage.busy"));
    if (conflict) throw new Error(t("memoryPage.conflict"));
    if (desktop !== true) return;
    inFlight.current = true; setWorking(true); setError(null);
    pressed.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    try {
      const answer = await requestLearningAction(api, action) as Partial<MemoryStatus> | null;
      // A settings change answers with the new status; nothing is read again.
      if (answer && typeof answer === "object" && "learning" in answer && "mode" in answer) { if (mounted.current) setStatus(answer as MemoryStatus); }
      if (action.action === "learning-keep" || action.action === "learning-undo") { await loadHistory(filter, undefined, true); if (mounted.current) setMemoryRevision(n => n + 1); }
      if (action.action === "retry-skipped") await loadHistory(filter, undefined, true);
    } catch (cause) {
      // The slice was already retried (the server no longer lists it as skipped): that is the answer the person wanted, not a failure.
      if (action.action === "retry-skipped" && isAlreadyRetried(cause)) { await loadHistory(filter, undefined, true).catch(() => { if (mounted.current) setError(t("memoryPage.historyFailed")); }); return; }
      const message = learningRequestError(cause);
      if (mounted.current) {
        if (cause instanceof Error && cause.message.includes("MEMORY_LEARNING_REVISION_CONFLICT")) setConflict(true);
        if (action.action === "learning-undo" && cause instanceof Error && (cause.message.startsWith("This memory") || cause.message === "This learning item cannot be changed.")) setRefusals(previous => ({ ...previous, [action.eventId]: message }));
      }
      throw new Error(message);
    } finally { inFlight.current = false; if (mounted.current) setWorking(false); }
  };
  const workspaceMutated = () => {
    if (!mounted.current) return;
    void loadHistory(filter, undefined, true).catch(() => { if (mounted.current) setError(t("memoryPage.historyFailed")); });
  };
  const openAdvanced = () => {
    adv.onOpenChange(true);
    window.setTimeout(() => document.getElementById("memory-limit-heading")?.scrollIntoView?.({ block: "center" }), 60);
  };
  if (desktop !== true) return <p role="status" className="text-[13px] text-ink-secondary">{t("memoryPage.desktopOnly")}</p>;
  return <AdvancedHost><div className="space-y-4">
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {conflict && <ActionBtn label={t("memoryPage.refreshChanged")} pending={t("memoryPage.refreshing")} blocked={working} success={t("memoryPage.settingsUpToDate")} failure={t("memoryPage.refreshFailed")} run={refresh} />}
    {!status ? <><p role="status" className="text-[13px] text-ink-secondary">{t("memoryPage.settingsLoading")}</p>{error && <ActionBtn label={t("memoryPage.refreshSettings")} pending={t("memoryPage.refreshing")} blocked={working} success={t("memoryPage.settingsUpToDate")} failure={t("memoryPage.refreshFailed")} run={refresh} />}</> : <MemorySectionContent status={status} bots={state.bots.filter(bot => !bot.hidden)} events={events} cursor={cursor} filter={filter} busy={working || conflict} historyBusy={historyBusy} refusals={refusals} waiting={waiting.total}
      retried={retried} onRetried={id => setRetried(previous => new Set(previous).add(id))} onAction={act} onFilter={setFilter} onRefresh={refresh} onOpenAdvanced={openAdvanced}
      onMore={async () => { if (!cursor) return; try { await loadHistory(filter, cursor); } catch { throw new Error(t("memoryPage.history.moreFailed")); } }}
      onOpen={source => { if (openDeepLink({ threadId: source.threadId, ...(source.messageId ? { messageId: source.messageId } : {}) }, state, dispatch)) dispatch({ type: "toggleAppSettings", open: false }); else setError(t("memoryPage.conversationGone")); }}
      workspace={<MemorySettings refreshToken={memoryRevision} sharedStatus={status} onStatusChange={setStatus} onMutation={workspaceMutated} onNavigate={() => dispatch({ type: "toggleAppSettings", open: false })} />} />}
    <AdvancedSection {...adv} summary={t("settings.l2.advanced.memory")}><AdvancedSlotTarget /></AdvancedSection>
  </div></AdvancedHost>;
}
