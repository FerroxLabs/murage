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
import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useStore } from "@/state/store";
import { botRole } from "@/lib/bot-role";
import { t } from "@/lib/i18n";
import { offerUndo } from "@/lib/undo";
import { askAgainFromLine } from "@/lib/compose-link";
import { cachedConnectorStatus, preloadConnectedApps } from "@/lib/connected-apps-preload";
import { useConnectivity } from "@/lib/connectivity";
import { todayModel, type TodayAction, type TodayRow } from "@/lib/today-model";
import { workingNow, type WorkingItem } from "@/lib/working-now";
import { quietHoursActive, resolveNotificationPreferences } from "../../../shared/notification-preferences";
import { ClientsCard, FirstRunTodayCard, MonthCard, useClientsTag, useMonthTag } from "@/components/shell/lane-slots";
import type { HealthStatus, NeedsSummary, TodayTag } from "@/components/shell/shell-contract";
import { useShellNav } from "@/components/shell/shell-nav";
import { useEngineReading } from "./use-engine-health";
import { StatusLine } from "./StatusLine";
import { NeedsCard, RoutineRows, TeamRow, TodayCard, TryNextCard } from "./TodayCards";
import { WorkingNowCard } from "./WorkingNowCard";
import { OpenBotListButton } from "@/components/OpenBotListButton";

export const TRY_NEXT_HIDDEN_KEY = "murage.today.tryNextHidden";

function readTryHidden(): boolean {
  try { return globalThis.localStorage?.getItem(TRY_NEXT_HIDDEN_KEY) === "1"; } catch { return false; }
}
function writeTryHidden(hidden: boolean): void {
  try {
    if (hidden) globalThis.localStorage?.setItem(TRY_NEXT_HIDDEN_KEY, "1");
    else globalThis.localStorage?.removeItem(TRY_NEXT_HIDDEN_KEY);
  } catch { /* per-viewer convenience only */ }
}

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
  const monthTag = useMonthTag();
  const clientsTag = useClientsTag();
  const [apps, setApps] = useState<number | null>(connectedCount);
  const [tryHidden, setTryHidden] = useState(readTryHidden);
  const [stopped, setStopped] = useState("");

  useEffect(() => {
    if (firstRun || !state.connected) return;
    let live = true;
    void preloadConnectedApps().then(() => { if (live) setApps(connectedCount()); }).catch(() => undefined);
    return () => { live = false; };
  }, [firstRun, state.connected]);

  const visibleBots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const botNames = useMemo(() => Object.fromEntries(state.bots.map((bot) => [bot.id, bot.name])), [state.bots]);
  const chief = chiefBotId ?? visibleBots.find((bot) => botRole(bot) === "chief")?.id ?? null;
  const prefs = state.config?.notifications;
  const quiet = useMemo(() => {
    const active = quietHoursActive(prefs, new Date(now));
    return { active, until: active ? resolveNotificationPreferences(prefs).quietHours?.end ?? null : null };
  }, [prefs, now]);

  const model = todayModel({
    now: new Date(now),
    ownerName: state.config?.profile?.name ?? "",
    firstRun,
    connectivity,
    engine: reading.engine,
    flux: reading.flux,
    needsCount: needs.count,
    health,
    monthTag,
    clientsTag,
    appsConnected: apps,
    quiet,
    routines: state.routines,
    runs: state.routineRuns,
    botNames,
  });

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
  const openRow = (row: TodayRow) => {
    if (row.botId && row.threadId) nav.openChat(row.botId, row.threadId);
    else if (row.routineId) nav.openRoutines();
    else if (row.botId) nav.openChat(row.botId);
  };
  const teamNames = visibleBots.map((bot) => bot.name);
  const names = teamNames.length <= 3
    ? new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(teamNames)
    : t("ux.l2a.today.teamMore", { names: teamNames.slice(0, 2).join(", "), n: teamNames.length - 2 });
  const teamMeta = working.length > 0 ? t("ux.l2a.today.teamWorking", { n: working.length }) : t("ux.l2a.today.teamReady");

  const hideTry = () => {
    writeTryHidden(true);
    setTryHidden(true);
    offerUndo({ kind: "local", key: "today-try-next", message: t("ux.l2a.today.tryHidden"), undo: () => { writeTryHidden(false); setTryHidden(false); } });
  };
  const tryIt = () => {
    if (!chief) { nav.openRoutines(); return; }
    const bot = state.bots.find((candidate) => candidate.id === chief);
    nav.openChat(chief);
    if (bot) askAgainFromLine({ text: t("ux.l2a.today.trySentence") }, { botId: chief, threadId: bot.threadId });
  };

  return (
    <main aria-labelledby="today-greeting" data-view="today" className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app text-ink">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Phones only (OpenBotListButton.tsx): below md the rail is a drawer, and this opens it. */}
              <OpenBotListButton />
              <h1 id="today-greeting" className="text-[22px] font-semibold text-ink">{model.greeting}</h1>
            </div>
            <StatusLine tags={tags} />
          </div>
          <p className="text-[13px] text-ink-secondary">{model.dateLine}</p>
        </header>

        {model.firstRun ? (
          <div className="mt-5">
            <FirstRunTodayCard chiefBotId={chief} remote={remote} onContinueSetup={() => { if (chief) nav.openChat(chief); }} />
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <NeedsCard needs={needs} onOpen={() => nav.showNeedsYou()} />
              <ClientsCard onOpenWorkspace={() => nav.showNeedsYou()} onOpenUsage={nav.openUsage} />
              <TodayCard id="today-working" title={t("ux.l2a.working.title")}>
                <WorkingNowCard items={working} now={now} nextLine={nextLine} onWatch={watch} onStop={stop} />
                <p role="status" className="text-[13px] text-ink-secondary empty:hidden">{stopped}</p>
                <div className="mt-3 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-ink-secondary">{t("ux.l2a.today.routinesTitle")}</h3>
                  <button type="button" onClick={nav.openRoutines} aria-label={t("ux.l2a.today.openRoutines")} title={t("ux.l2a.today.openRoutines")}
                    className="flex size-11 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"><ArrowRight size={16} aria-hidden="true" /></button>
                </div>
                <RoutineRows rows={model.routinesToday} onOpen={openRow} emptyLine={t("ux.l2a.today.routinesEmpty")} />
              </TodayCard>
              <TodayCard id="today-finished" title={t("ux.l2a.today.finishedTitle")} arrowLabel={t("ux.l2a.today.openResults")} onArrow={() => nav.showNeedsYou("results")}>
                <RoutineRows rows={model.finished} onOpen={openRow} emptyLine={t("ux.l2a.today.finishedEmpty")} />
              </TodayCard>
              <TodayCard id="today-team" title={t("ux.l2a.today.teamTitle")}>
                <MonthCard onOpenUsage={nav.openUsage} />
                <TeamRow names={names} meta={teamMeta} onHire={() => dispatch({ type: "newBot" })} />
              </TodayCard>
            </div>
            {!tryHidden && (
              <div className="mt-3">
                <TryNextCard onTry={tryIt} onDismiss={hideTry} />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
