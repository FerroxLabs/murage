// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today (UX 1.0.13, lane L2A; mockup Desktop.dc.html Today board). The page a
// returning owner lands on: what happened and what needs them, read in ten
// seconds. Trunk test: where am I (the lit Today door and the greeting), what
// is this for (the status tags), what can I do (each card's one action), what
// needs me (the Needs you card and tag), how do I find anything (the doors and
// Search in the rail).
//
// Everything shown is decided in src/lib/today-model.ts. During first run the
// page is the greeting, one "Getting set up" tag and the first-run card only
// (FIRSTRUN 1.2).
//
// Today slice 1.0.18 (designs/TODAY-SLICE-1104.md sections 1 to 5), Calm, top to bottom (one column under md):
//   head: greeting, date, the lead line, the status tags (engine tag Fuigo first, todayEngine)
//   Tell box (TellChiefBox: the Chief's own Composer, compact)
//   Needs you (NeedsBlock: Decide + Worth a look, 3 lines) | Your day (YourDay: now to midnight)
//   Working now (WorkingNowCard) | Done today (DoneTodayCard)
//   Your team: the L2C MonthCard slot, then the team chips with the working dot
// The browser door (`remote`) has no Needs you read, so the Needs you block is not drawn there at all.
// Nothing here calls a model; the only reads are the existing ones plus useWorthALook (needs-reconnect, team-map).
//
// Calm | Detailed (design 2b): the switch sits at the top right of the head (on the greeting row on a phone), not in
// first run. The choice is one owner pref on the server (use-today-view.ts); Calm until it answers. Detailed shows
// every Needs you line (needsCap Infinity, NeedsBlock mode "all"), the reported routine cost card and the routines
// line, Done today with every run and its detail line, and "Your team today" in place of the chips. The Detailed-only
// blocks load lazily, so Calm's first paint never carries them. Detailed adds no read beyond the pref.
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNarrowViewport } from "@/lib/media-query";
import { useStore } from "@/state/store";
import { tellChief, todayChiefId } from "@/lib/today-tell";
import { t } from "@/lib/i18n";
import { cachedConnectorStatus, preloadConnectedApps } from "@/lib/connected-apps-preload";
import { useConnectivity } from "@/lib/connectivity";
import { detailedOrder, leadLine, routinesRanToday, todayEngine, todayModel, type DetailedBlock, type DoneRow, type TodayAction } from "@/lib/today-model";
import { needsLines, NEEDS_LINE_CAP, withoutAnswered, type NeedsLine } from "@/lib/today-needs";
import { dayTimeline } from "@/lib/today-day";
import { workingNow, type WorkingItem } from "@/lib/working-now";
import { quietHoursActive, resolveNotificationPreferences } from "../../../shared/notification-preferences";
import { ClientsCard, MonthCard, useClientsTag, useMonthTag } from "@/components/shell/lane-slots";
import type { HealthStatus, NeedsSummary, TodayTag } from "@/components/shell/shell-contract";
import { useShellNav } from "@/components/shell/shell-nav";
import { useEngineHealthAnswer, useEngineReading } from "./use-engine-health";
import { useWorthALook } from "./use-worth-a-look";
import { StatusLine } from "./StatusLine";
import { DoneTodayCard, TeamChips, TodayCard } from "./TodayCards";
import { WorkingNowCard } from "./WorkingNowCard";
import { NeedsBlock } from "./NeedsBlock";
import { todayQuickAnswer } from "./today-quick";
import { YourDay } from "./YourDay";
import { TellChiefBox } from "./TellChiefBox";
import { leadSentence } from "./say";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { useTodayView } from "./use-today-view";
import { TodayViewSwitch } from "./TodayViewSwitch";

// Detailed only: out of the first paint.
const SpendCardChunk = retryableLazy(() => import("./SpendCard").then((module) => ({ default: module.SpendCard })));
const RoutinesLineChunk = retryableLazy(() => import("./SpendCard").then((module) => ({ default: module.RoutinesLine })));
const TeamTodayChunk = retryableLazy(() => import("./TeamToday").then((module) => ({ default: module.TeamToday })));
const DoneDetailedChunk = retryableLazy(() => import("./TeamToday").then((module) => ({ default: module.DoneDetailed })));
import { BOX_FRAME, BoxBody, BoxHead } from "@/components/ui/BoxShell";
import { useSetupView } from "@/components/FirstRunChrome";

// UX L7 part 2: the once-only alerts card on a phone's Today, in its own chunk.
// The first-run card shows only while setup is going, so it loads in its own
// chunk then, never on a set-up Today's first paint (bundle budget). Same module
// lane-slots.tsx names for L6A; imported here directly so the split holds.
const FirstRunTodayCard = retryableLazy(() => import("@/components/today/FirstRunTodayCard").then((module) => ({ default: module.FirstRunTodayCard })));
const PhoneAlertsCard = retryableLazy(() => import("@/components/phone/PhoneAlertsCard").then((module) => ({ default: module.PhoneAlertsCard })));

// UX-L6A part 2: Hire a bot is the one-sentence sheet, loaded on first use.
const HireBotDialog = retryableLazy(() => import("@/components/hire/HireBotDialog").then((module) => ({ default: module.HireBotDialog })));

function connectedCount(): number | null {
  if (!cachedConnectorStatus) return null;
  return Object.values(cachedConnectorStatus).filter((status) => status.connected).length;
}

/** A clock that moves once a minute, so "4 min so far" and the greeting stay true without a render every second. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Moving a block to match a new layout takes it out of the DOM for a moment, which drops focus inside it. This keeps
 *  the last focused element inside `container` and gives focus back to it after the move, when nothing else took it. */
function useFocusKept(container: RefObject<HTMLElement | null>, layout: boolean): void {
  const held = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const box = container.current;
    if (!box) return;
    const onIn = (event: FocusEvent) => { held.current = event.target instanceof HTMLElement ? event.target : null; };
    const onOut = (event: FocusEvent) => {
      // Focus went somewhere else on purpose; a removal has no relatedTarget.
      if (event.relatedTarget instanceof Node && !box.contains(event.relatedTarget)) held.current = null;
    };
    box.addEventListener("focusin", onIn);
    box.addEventListener("focusout", onOut);
    return () => { box.removeEventListener("focusin", onIn); box.removeEventListener("focusout", onOut); };
  });
  useLayoutEffect(() => {
    const el = held.current;
    if (!el || !el.isConnected || !container.current?.contains(el)) return;
    const active = document.activeElement;
    if (active === el || (active && active !== document.body)) return;
    el.focus({ preventScroll: true });
  }, [container, layout]);
}

export interface TodayViewProps {
  needs: NeedsSummary;
  health: HealthStatus;
  /** first run owns the main view (server setup view) */
  firstRun: boolean;
  chiefBotId: string | null;
  /** a paired phone or the browser door, not this computer */
  remote: boolean;
}

export function TodayView({ needs, health, firstRun, chiefBotId, remote }: TodayViewProps) {
  const { state, dispatch } = useStore();
  const nav = useShellNav();
  const now = useMinuteClock();
  const connectivity = useConnectivity();
  const reading = useEngineReading();
  const engineAnswer = useEngineHealthAnswer();
  const monthTag = useMonthTag();
  const clientsTag = useClientsTag();
  const [apps, setApps] = useState<number | null>(connectedCount);
  const [stopped, setStopped] = useState("");
  const [needsExpanded, setNeedsExpanded] = useState(false);
  const [hireOpen, setHireOpen] = useState(false);
  const { view: setup } = useSetupView();

  useEffect(() => {
    if (firstRun || !state.connected) return;
    let live = true;
    void preloadConnectedApps().then(() => { if (live) setApps(connectedCount()); }).catch(() => undefined);
    return () => { live = false; };
  }, [firstRun, state.connected]);

  const visibleBots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const botNames = useMemo(() => Object.fromEntries(state.bots.map((bot) => [bot.id, bot.name])), [state.bots]);
  const chief = todayChiefId(state.bots, chiefBotId);
  const prefs = state.config?.notifications;
  const quiet = useMemo(() => {
    const active = quietHoursActive(prefs, new Date(now));
    return { active, until: active ? resolveNotificationPreferences(prefs).quietHours?.end ?? null : null };
  }, [prefs, now]);

  // Fuigo first: the engine tag names Fuigo on Flux Router when any visible bot runs on it.
  const engineReadings = useMemo(() => state.instances.map((instance) => ({ instanceId: instance.instanceId, displayName: instance.displayName, enabled: instance.enabled, driverKind: instance.driverKind, snapshot: instance.snapshot })), [state.instances]);
  const usedEngines = visibleBots.map((bot) => bot.modelSelection?.instanceId).filter((id): id is string => Boolean(id));
  const engine = todayEngine(reading.engine, engineReadings, usedEngines, engineAnswer?.engines ?? null);

  // The Needs you block is not drawn on the browser door (no Needs you read there), nor in first run.
  const needsShown = !firstRun && !remote;
  const worth = useWorthALook(needsShown);
  // Calm | Detailed (2b): not in first run; Calm until the pref answers.
  const todayView = useTodayView(!firstRun);
  const detailed = !firstRun && todayView.view === "detailed";
  // Calm caps at 3; Detailed shows every line (D1).
  const needsCap = detailed ? Number.POSITIVE_INFINITY : NEEDS_LINE_CAP;
  // A row answered in one click (NEEDSYOU-INLINE-APPROVE) leaves at once; `said` is what each answerable row asks.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<Readonly<Record<string, string>>>({});
  // the count comes from the same read as the rows while an answered row is still listed (one snapshot)
  const kept = withoutAnswered(needs.rows ?? [], needs.count, answered, needs.rowsCount);
  const lines = needsLines({
    now, count: kept.count, rows: kept.rows, restore: needs.restore ?? [], reconnectApps: worth.reconnect, handoffs: worth.handoffs,
    routines: state.routines, runs: state.routineRuns, bots: visibleBots, botNames, cap: needsCap,
  });
  // Detailed desktop and phone stack the blocks in different orders; the DOM follows the active one.
  const narrow = useNarrowViewport();
  const detailedGrid = useRef<HTMLDivElement>(null);
  useFocusKept(detailedGrid, narrow);

  const model = todayModel({
    now: new Date(now),
    ownerName: state.config?.profile?.name ?? "",
    firstRun,
    firstRunBare: firstRun && setup?.nothingCanAnswer === true,
    connectivity,
    engine,
    flux: reading.flux,
    needsCount: kept.count,
    // The head's tag on NeedsBlock's own conditions: never green while stale, unknown or with a line below.
    needsState: { stale: needsShown && needs.stale === true, lines: needsShown ? lines.all.length : 0, reads: needsShown },
    health,
    monthTag,
    clientsTag,
    appsConnected: apps,
    quiet,
    routines: state.routines,
    runs: state.routineRuns,
    botNames,
  });

  const timeline = useMemo(() => dayTimeline(state.routines, now), [state.routines, now]);
  const decideOwed = needs.split ? Math.max(0, needs.split.approvals + needs.split.questions - ((needs.rows?.length ?? 0) - kept.rows.length)) : 0;
  const firstToday = timeline.rows[0];
  const lead = model.firstRun ? "" : leadSentence(leadLine({
    ran: routinesRanToday(state.routineRuns, new Date(now)),
    look: needsShown ? lines.look : 0,
    decide: needsShown ? Math.max(lines.decide, decideOwed) : 0,
    next: firstToday ? { name: firstToday.name, at: firstToday.at } : null,
  }));

  const act = (action: TodayAction | undefined): (() => void) | undefined => {
    switch (action) {
      case "engines": return () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" });
      case "flux": return () => dispatch({ type: "toggleAppSettings", open: true, section: "models" });
      case "needs": return () => nav.showNeedsYou();
      case "health": return () => nav.showHealth();
      case "apps": return () => dispatch({ type: "togglePlugins", open: true });
      case "notifications": return () => dispatch({ type: "toggleAppSettings", open: true, section: "general" });
      case "setup": return chief ? () => nav.openChat(chief) : undefined;
      default: return undefined;
    }
  };
  // L2C's and L6C's tags keep their own onClick; ours get theirs from `action`.
  const own = new Map<string, TodayTag>([monthTag, clientsTag].filter((tag): tag is TodayTag => Boolean(tag)).map((tag) => [tag.key, tag]));
  const tags: TodayTag[] = model.tags.map((tag) => own.get(tag.key) ?? { key: tag.key, tone: tag.tone, text: tag.text, ...(act(tag.action) ? { onClick: act(tag.action) } : {}) });

  const working = workingNow(state.bots);
  const workingBots = new Set(working.map((item) => item.botId));
  const watch = (item: WorkingItem) => nav.openChat(item.botId, item.threadId);
  const stop = (item: WorkingItem) => {
    // The same interrupt as the chat's own Stop. A stopped turn cannot be put back, so there is no Undo: the line says where the work went.
    dispatch({ type: "interrupt", botId: item.botId, threadId: item.threadId });
    setStopped(t("ux.l2a.working.stopping", { name: item.botName }));
  };
  const nextRoutine = state.routines
    .filter((routine) => routine.enabled && routine.nextRunAt !== null && routine.nextRunAt > now)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  const nextLine = nextRoutine?.nextRunAt
    ? t("ux.l2a.working.next", { name: nextRoutine.name, when: new Intl.DateTimeFormat(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" }).format(nextRoutine.nextRunAt) })
    : "";
  const botForThread = (threadId: string) => state.bots.find((bot) => bot.threadId === threadId || bot.tasks?.some((task) => task.threadId === threadId));
  const openLine = (line: NeedsLine) => {
    const target = line.target;
    switch (target.type) {
      case "needs": target.open(); return;
      case "apps": dispatch({ type: "togglePlugins", open: true }); return;
      case "usage": nav.openUsage(); return;
      case "chat": nav.openChat(target.botId, target.threadId); return;
      case "run": if (target.threadId) nav.openChat(target.botId, target.threadId); else nav.openRoutines(); return;
      case "link": {
        const bot = botForThread(target.threadId);
        if (bot) nav.openChat(bot.id, target.threadId); else nav.showNeedsYou();
        return;
      }
    }
  };
  const openDone = (row: DoneRow) => {
    if (row.threadId) nav.openChat(row.botId, row.threadId);
    else nav.openRoutines();
  };
  const tellBot = tellChief(state.bots, chief, model.firstRun);
  const chiefName = (chief ? botNames[chief] : "") ?? "";
  const viewSwitch = model.firstRun ? null : <TodayViewSwitch view={todayView.view} failed={todayView.failed} onPick={todayView.press} />;
  const needsBlock = needsShown && (
    <NeedsBlock needs={lines} count={kept.count} stale={needs.stale} mode={detailed ? "all" : "calm"} expanded={needsExpanded} onExpand={() => setNeedsExpanded(true)} onCollapse={() => setNeedsExpanded(false)}
      onOpenLine={openLine} onOpenDoor={() => nav.showNeedsYou()}
      quickAnswer={todayQuickAnswer} onAnswered={(line) => setAnswered((current) => new Set(current).add(line.id))}
      said={said} onSaid={(line, text) => setSaid((current) => (current[line.id] === text ? current : { ...current, [line.id]: text }))} />
  );
  const yourDay = <YourDay timeline={timeline} now={now} botNames={botNames} chiefName={chiefName} onOpenRoutines={nav.openRoutines} />;
  const workingCard = (
    <TodayCard id="today-working" title={t("ux.l2a.working.title")}>
      <WorkingNowCard items={working} now={now} nextLine={nextLine} onWatch={watch} onStop={stop} />
      <p role="status" className="text-[13px] text-ink-secondary empty:hidden">{stopped}</p>
    </TodayCard>
  );
  const lazyBlock = (retry: () => void, node: ReactNode) => (
    <LazyBoundary inline onRetry={retry}><Suspense fallback={null}>{node}</Suspense></LazyBoundary>
  );
  // Detailed (2b) blocks, keyed so a layout change moves them rather than remounting them.
  const detailedBlocks: Record<DetailedBlock, { node: ReactNode; className?: string }> | null = detailed ? {
    needs: { node: needsBlock || null },
    cost: { node: lazyBlock(SpendCardChunk.retry, <SpendCardChunk.Component runs={state.routineRuns} now={now} onOpenUsage={nav.openUsage} />) },
    day: { node: yourDay, className: needsBlock ? undefined : "md:col-span-2" },
    routines: { node: lazyBlock(RoutinesLineChunk.retry, <RoutinesLineChunk.Component routines={state.routines} runs={state.routineRuns} now={now} />), className: "self-end" },
    working: { node: workingCard },
    done: { node: lazyBlock(DoneDetailedChunk.retry, <DoneDetailedChunk.Component rows={model.done} runs={state.routineRuns} bots={state.bots} instances={state.instances} onOpen={openDone} onOpenResults={() => nav.showNeedsYou("results")} />) },
  } : null;

  return (
    <main aria-labelledby="today-greeting" data-view="today" className={`${BOX_FRAME} h-full min-w-0 flex-1 bg-app text-ink`}>
      <BoxHead className="block border-b border-hairline/40">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-start justify-between gap-2 px-4 py-4 md:px-8">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Phones only (OpenBotListButton.tsx): below md the rail is a drawer, and this opens it. */}
              <OpenBotListButton />
              <h1 id="today-greeting" className="text-[22px] font-semibold text-ink">{model.greeting}</h1>
              {/* Phone: the switch sits at the right of the greeting row. */}
              {viewSwitch && <div className="ml-auto md:hidden">{viewSwitch}</div>}
            </div>
            {lead && <p data-today="lead" className="mt-1 text-[14px] text-ink-secondary">{lead}</p>}
            <StatusLine tags={tags} />
          </div>
          <div className="flex flex-col items-end gap-2">
            {viewSwitch && <div className="hidden md:block">{viewSwitch}</div>}
            <p className="text-[13px] text-ink-secondary">{model.dateLine}</p>
          </div>
        </div>
      </BoxHead>
      <BoxBody>
      <div className="mx-auto w-full max-w-5xl px-4 pb-6 md:px-8">
        {model.firstRun ? (
          <div className="mt-5">
            <LazyBoundary inline onRetry={FirstRunTodayCard.retry}><Suspense fallback={null}><FirstRunTodayCard.Component chiefBotId={chief} remote={remote} onContinueSetup={() => { if (chief) nav.openChat(chief); }} /></Suspense></LazyBoundary>
          </div>
        ) : (
          <>
            {/* UX L7 part 2: the once-only alerts card, phone door only, first on the page. */}
            {remote && <div className="mt-5 empty:hidden md:hidden"><LazyBoundary inline onRetry={PhoneAlertsCard.retry}><Suspense fallback={null}><PhoneAlertsCard.Component /></Suspense></LazyBoundary></div>}
            {tellBot && (
              <div className="mt-5">
                <TellChiefBox chief={tellBot} onOpenChat={nav.openChat} />
              </div>
            )}
            {detailedBlocks ? (
              // Detailed (2b). Phone, top to bottom: Needs you, cost, Your day, routines line, Working now, Done today.
              // Desktop rows: Needs you (all) | Your day, cost | routines line, Working now | Done today (detailed).
              // DOM order is the order seen (detailedOrder), never CSS `order`, so reading and Tab follow the layout.
              <div ref={detailedGrid} data-today-view="detailed" className="mt-3 grid gap-3 md:grid-cols-2">
                {detailedOrder(narrow).map((key) => {
                  const block = detailedBlocks[key];
                  return block.node ? <div key={key} data-today-block={key} className={block.className}>{block.node}</div> : null;
                })}
              </div>
            ) : (
              <>
                <div data-today-view="calm" className="mt-3 grid gap-3 md:grid-cols-2">
                  {needsBlock}
                  <div className={needsShown ? undefined : "md:col-span-2"}>{yourDay}</div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {workingCard}
                  <DoneTodayCard rows={model.done} onOpen={openDone} onOpenResults={() => nav.showNeedsYou("results")} />
                </div>
              </>
            )}
            <div className="mt-3 grid gap-3">
              <ClientsCard onOpenWorkspace={() => nav.showNeedsYou()} onOpenUsage={nav.openUsage} />
              {detailed ? lazyBlock(TeamTodayChunk.retry, (
                <TeamTodayChunk.Component bots={state.bots} routines={state.routines} runs={state.routineRuns} now={now}
                  onOpen={(botId) => nav.openChat(botId)} onHire={() => setHireOpen(true)}>
                  <MonthCard onOpenUsage={nav.openUsage} />
                </TeamTodayChunk.Component>
              )) : (
                <TodayCard id="today-team" title={t("ux.l2a.today.teamTitle")}>
                  <MonthCard onOpenUsage={nav.openUsage} />
                  <TeamChips bots={visibleBots.map((bot) => ({ id: bot.id, name: bot.name, working: workingBots.has(bot.id) }))}
                    onOpen={(botId) => nav.openChat(botId)} onHire={() => setHireOpen(true)} />
                </TodayCard>
              )}
            </div>
          </>
        )}
      </div>
      </BoxBody>
      {hireOpen && (
        <LazyBoundary onRetry={HireBotDialog.retry} onDismiss={() => setHireOpen(false)}>
          <Suspense fallback={null}><HireBotDialog.Component onClose={() => setHireOpen(false)} /></Suspense>
        </LazyBoundary>
      )}
    </main>
  );
}
