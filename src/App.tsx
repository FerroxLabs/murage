import { ConnectorReconnectDialog } from "@/components/ConnectorReconnectDialog";
import { ReconnectAppsBanner } from "@/components/ReconnectAppsBanner";
import { settingsOpener } from "@/lib/settings-leave";
import { LazyOverlay } from "@/components/LazyOverlay";
import { EngineChatLinkHost } from "@/components/EngineChatLink";
import { adjacentSidebarBot, sidebarBotOrder, sidebarCycleDirection } from "@/lib/sidebar-layout";
import { loadSectionOrder } from "@/lib/sidebar-preferences";
import { imeComposing } from "@/lib/composer-enter";
import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { api, StoreProvider, useStore } from "@/state/store";
import { CallOverlaySlot } from "@/components/CallControls";
import { BotCallRing } from "@/components/BotCallRing";
import { initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { preloadConnectedApps } from "@/lib/connected-apps-preload";
import { UpdateBanner } from "@/components/UpdateBanner";
import { UpdateStaleNotice } from "@/components/UpdateStaleNotice";
import { ServerLifecycleBanner } from "@/components/ServerLifecycleBanner";
import { LazyMemoryIntegrityStrip } from "@/components/MemoryIntegrityStripLazy";
import { CloudUnreachableBanner } from "@/components/cloud/CloudUnreachableBanner";
import { WorkspaceSwitch } from "@/components/cloud/WorkspaceSwitch";
import { isCloudHome, isCloudOrigin, notificationBridge } from "@/lib/cloud-workspace";
import { RemoteConnectionBanner } from "@/components/RemoteConnectionBanner";
import { FluxKeyProblemBanner } from "@/components/FluxKeyProblemBanner";
import { SignedOutCard } from "@/components/SignedOutCard";
import { DesktopCapabilitiesProvider, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { NoEngines } from "@/components/NoEngines";
import { enginesOnlySwitchedOff } from "@/lib/engines-off";
import { drawerCloseKey } from "@/lib/drawer-close";
import { CommandPaletteHost } from "@/components/CommandPaletteHost";
import { DictationStatusBar } from "@/components/DictationStatusBar";
import { FirstRunPhases } from "@/components/FirstRunPhases";
import { FirstRunWelcome } from "@/components/FirstRunWelcome";
import { StartupPictureWriter } from "@/components/StartupPictureWriter";
import { pictureHeld } from "@/lib/startup-picture-schedule";
import { useRefreshSetupOnBotChange, useSetupView } from "@/components/FirstRunChrome";
import { firstRunOwnsMainView } from "@/lib/first-run";
import { settleSendKeyForUpgrade } from "@/lib/send-key";
import { BotListDrawerProvider, PhoneBotListBar, useBotListDrawer } from "@/components/OpenBotListButton";
import { heldComputerControlBotIds } from "@/lib/computer-control";
import { skillRecorderAvailable } from "@/lib/feature-flags";
import { trackVisualViewport } from "@/lib/visual-viewport";
import { localeVersion, rememberLanguage, setLocale, subscribeLocale } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { InstallPrompt } from "./components/InstallPrompt";
import { useDeepLinks } from "@/components/useDeepLinks";
import { usePushEnrol } from "@/components/usePushEnrol";
import { usePresence } from "@/components/usePresence";
import { LazyFallback } from "@/components/LazyFallback";
import { loadPlainApproval } from "@/lib/plain-approval";
import { canPrefetchWhenIdle, loadBotSettings, loadedBotSettings, preloadBotSettings, subscribeBotSettings } from "@/lib/preload-bot-settings";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { loadGroupView, preloadGroupView } from "@/lib/group-view-preload";
import { TermsGate } from "@/components/TermsGate";
import { NoLimitsFollowers } from "@/components/NoLimitsFollowers";
import { NoLimitsTermsPrompt } from "@/components/NoLimitsTermsPrompt";
import { HelpHost } from "@/components/help/HelpHost";
import { CoachMarks } from "@/components/ui/CoachMarks";
import { UndoToastHost } from "@/components/ui/UndoToast";
import { feedbackSurface } from "@/lib/feedback-surface";
import { OfflineBand } from "@/components/shell/OfflineBand";
import { HealthPage, NeedsYouPage, PhoneTabs, useHealthStatus, useNeedsSummary } from "@/components/shell/lane-slots";
import { doorForView, healthReturn, shellNav, trackShellOrigins, type CalendarOrigin, type HealthOrigin } from "@/components/shell/shell-nav";
import type { ShellDoor } from "@/components/shell/shell-contract";
import { TodayView } from "@/components/today/TodayView";
import { useConnectivity } from "@/lib/connectivity";
import { NewBotSignInStep } from "@/components/cloud/BotSignInOffer";
import { OwnerCodeDialog } from "@/components/cloud/OwnerCodeDialog";
import { OwnerExpiredBanner } from "@/components/cloud/OwnerExpiredBanner";

// Opened by a tap, so loaded by one (spec §6). Settings alone pulls in every
// settings page and, through House rules and the skill editor, Tiptap; a phone
// that never opens them never downloads them. One Suspense per surface, so a
// panel loading does not blank one that is already open. One LazyBoundary per
// surface too, so a chunk that fails to arrive costs that panel a retry
// button, not the whole app (LazyBoundary.tsx).
const BotSettings = retryableLazy(() => loadBotSettings().then((module) => ({ default: module.BotSettingsDialog })));
const Computer = retryableLazy(() => import("@/components/ComputerPanel").then((module) => ({ default: module.ComputerPanel })));
const Settings = retryableLazy(() => import("@/components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
const BotSettingsDialog = BotSettings.Component;
const ComputerPanel = Computer.Component;
const SettingsModal = Settings.Component;
// The Inspector opens from a tap; its claim rows and runtime lookups stay off the first paint.
const Inspector = retryableLazy(() => import("@/components/InspectorPanel").then((module) => ({ default: module.InspectorPanel })));
const InspectorPanel = Inspector.Component;

const PluginsPanelLazy = retryableLazy(() => import("@/components/PluginsPanel").then((module) => ({ default: module.PluginsPanel })));
const PluginsPanel = PluginsPanelLazy.Component;

const RoutinesPageLazy = retryableLazy(() => import("@/components/RoutinesPage").then((module) => ({ default: module.RoutinesPage })));
const RoutinesPage = RoutinesPageLazy.Component;

const TeamMapPageLazy = retryableLazy(() => import("@/components/TeamMapPage").then((module) => ({ default: module.TeamMapPage })));
const TeamMapPage = TeamMapPageLazy.Component;
const AllChatsPageLazy = retryableLazy(() => import("@/components/AllChatsPage").then((module) => ({ default: module.AllChatsPage })));
const AllChatsPage = AllChatsPageLazy.Component;

const SkillRecorderPageLazy = retryableLazy(() => import("@/components/SkillRecorderPage").then((module) => ({ default: module.SkillRecorderPage })));
const SkillRecorderPage = SkillRecorderPageLazy.Component;

const LocalVmWorkspaceLazy = retryableLazy(() => import("@/components/LocalVmWorkspace").then((module) => ({ default: module.LocalVmWorkspace })));
const LocalVmWorkspace = LocalVmWorkspaceLazy.Component;

const BrowserWorkspaceLazy = retryableLazy(() => import("@/components/BrowserWorkspace").then((module) => ({ default: module.BrowserWorkspace })));
const BrowserWorkspace = BrowserWorkspaceLazy.Component;

// A group or project chat opens from the rail, not on the first frame (Today
// is the landing), so its room view, details panel and group routing load on
// first open, a pointer or focus on a room in the rail, or once the app is
// idle, whichever comes first (BUNDLE-HEADROOM-1017).
const GroupViewLazy = retryableLazy(() => loadGroupView().then((module) => ({ default: module.GroupView })));
/** A room that could not load keeps the phone's way back to the bot list. */
const roomFrame = (alert: ReactNode) => (
  <div className="flex h-full min-w-0 flex-1 flex-col bg-app">
    <PhoneBotListBar />
    <div className="flex min-h-0 flex-1 items-center justify-center">{alert}</div>
  </div>
);
const GroupView = GroupViewLazy.Component;

function Shell() {
  const { state, dispatch } = useStore();
  // Sidebar publishes the layout it actually renders, including unsaved drags.
  const sidebarLayout = useRef({ sectionOrder: loadSectionOrder(), showHidden: false });
  const onSidebarLayout = useCallback((layout: typeof sidebarLayout.current) => {
    sidebarLayout.current = layout;
  }, []);
  const settingsSession = useRef<HTMLElement | null>(null);
  const settingsWasOpen = useRef(false);
  const settingsIsOpen = state.appSettingsOpen || state.settingsOpen;
  if (settingsIsOpen && !settingsWasOpen.current) {
    settingsSession.current = typeof document === "undefined" ? null : settingsOpener(document.activeElement as HTMLElement | null);
  }
  settingsWasOpen.current = settingsIsOpen;
  // #open=<thread>&msg=<message> and the phone app's notificationOpened.
  useDeepLinks();
  usePushEnrol();
  // Tells the host this tab is visible, so phones stay quiet (spec §3.4).
  usePresence();
  // The same cached `GET /api/setup` the phase bar reads, so the band and the
  // view underneath it cannot disagree about whose screen this is.
  const { view: setupView } = useSetupView();
  // The Inbox rows and counts follow the visible bots; re-read the view when they change.
  useRefreshSetupOnBotChange(state.bots);
  // 1.0.4 made Ctrl/Cmd+Enter the Japanese default; an install set up before it keeps Enter.
  const setupFirstRun = setupView?.firstRun;
  useEffect(() => settleSendKeyForUpgrade(setupFirstRun), [setupFirstRun]);
  // Same three-state answer the whole app uses, and the same rule: only a
  // CONFIRMED desktop gets a first-run surface. See the comment on App().
  const desktop = useDesktopSurface();
  // Teach a skill records the screen on macOS only.
  const { capabilities } = useDesktopCapabilities();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && bot.unread).length +
    state.groups.filter((group) => group.unread).length;
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  // Apply the configured UI language the moment config arrives or changes;
  // "" follows the system. A pack other than English arrives as its own
  // chunk, and t() reads a module variable, so the app re-renders its
  // extracted strings when the locale version moves, not when this is asked.
  const language = state.config?.language ?? "";
  const configLoaded = state.config !== undefined && state.config !== null;
  useSyncExternalStore(subscribeLocale, localeVersion);
  const LoadedBotSettings = useSyncExternalStore(subscribeBotSettings, loadedBotSettings);
  // Desktop: fetch the bot-settings chunk once the app is idle, so the first open has no loading step.
  useEffect(() => {
    if (!canPrefetchWhenIdle()) return;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1500));
    const handle = idle(preloadBotSettings);
    return () => { if (window.cancelIdleCallback) window.cancelIdleCallback(handle as number); else window.clearTimeout(handle as number); };
  }, []);
  // Every device: fetch the approval cards' plain words once the app is idle
  // (a few KiB), so a card rarely shows its pre-plain-words wording.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1500));
    const handle = idle(() => { void loadPlainApproval().catch(() => undefined); preloadGroupView(); });
    return () => { if (window.cancelIdleCallback) window.cancelIdleCallback(handle as number); else window.clearTimeout(handle as number); };
  }, []);
  useEffect(() => {
    // Before config arrives "" means "not known yet": the first paint's
    // language (i18n.ts bootLanguage) stands until config says otherwise.
    if (!configLoaded) return;
    void setLocale(language || globalThis.navigator?.language);
    rememberLanguage(language);
  }, [language, configLoaded]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<CalendarOrigin>("chat");
  // Where Health was opened from (Sean 11-02): its Back, close button and Esc return there; unknown means Today.
  const healthOriginRef = useRef<HealthOrigin | undefined>(undefined);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  // The Settings window can show any bot from its Bots group without changing the chat behind it.
  const settingsBot = (state.settingsBotId ? state.bots.find((b) => b.id === state.settingsBotId) : undefined) ?? bot;
  // UX 1.0.13 (L2A): the rail shows on every view, Routines included, so a door is always one click away.
  const { drawerOpen, setDrawerOpen, closeDrawer, returnDrawerFocus, control: drawerControl } = useBotListDrawer(true);
  // One read of each for the whole shell: the rail's door, Today and the phone tabs show the same numbers.
  const needs = useNeedsSummary();
  const health = useHealthStatus(needs.healthLevel);
  const connectivity = useConnectivity();
  const nav = shellNav(dispatch, () => state);
  const openDoor = useCallback((door: ShellDoor) => {
    if (door === "today") dispatch({ type: "showToday" });
    else if (door === "chats") dispatch({ type: "showAllChats" });
    else if (door === "needs-you") dispatch({ type: "showNeedsYou" });
    else dispatch({ type: "showRoutines" });
  }, [dispatch]);
  const phoneTab = state.activeView === "chat" ? null : doorForView(state.activeView);
  // A workspace panel (LocalVm/Browser) covers the call's own bot/room's
  // screen the same way another selection does, with nothing to return to
  // otherwise (callbar-rereview.md N4). CallOverlaySlot (CallControls.tsx)
  // owns the call itself — keyed to the bot or room actually on the line,
  // never to whatever is selected, so switching threads (to approve
  // another bot's request, say) never unmounts it; that used to hang the
  // call up silently (.superpowers/sdd/2026-09-29-iphone-native-call-audio/
  // moss-approval-bug.md).
  const isCallTargetCovered = useCallback(
    (id: string) => localVmWorkspaceBotId === id || browserWorkspaceBotId === id,
    [localVmWorkspaceBotId, browserWorkspaceBotId],
  );
  const uncoverCallTarget = useCallback(
    (id: string) => {
      if (localVmWorkspaceBotId === id) setLocalVmWorkspaceBotId(null);
      if (browserWorkspaceBotId === id) setBrowserWorkspaceBotId(null);
    },
    [localVmWorkspaceBotId, browserWorkspaceBotId],
  );

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  //
  // AVAILABLE IS NOT THE SAME AS USABLE, AND THIS GATE USED TO CONFUSE THEM.
  //
  // Murage SHIPS the Fuigo binary, so on a machine with no key, no login and
  // no local runtime, `fuigo --version` still answers and its snapshot reads
  // "available" — with a catalogue that has merged down to nothing. This test
  // said "an engine exists, so hide the setup screen", and the person landed
  // in a chat with a bot that had no model behind it: the single worst first
  // run the app can produce, and precisely the one a blank machine gets.
  //
  // server/default-engine.ts has always been stricter (it refuses to hand a
  // bot an engine with an empty `models.default`), so the two readings
  // disagreed: the selector said "no engine", this said "we have one". The
  // condition below is `runnable()` from server/setup.ts, kept deliberately
  // identical so they cannot drift apart again.
  //
  // AND IT YIELDS TO THE FIRST RUN, BECAUSE IT WAS SHADOWING IT.
  //
  // This predicate is true on exactly the machine `nothingToThinkWith` is
  // true on, so on a blank computer it replaced the Chief of Staff's thread —
  // and every first-run card lives in that thread, including the only card
  // that can take a Flux key. The person was told "Murage doesn't ship a
  // model of its own", which contradicts what the first run says on the very
  // next screen, and offered a list of CLIs to install with no way to enter a
  // key, while the phase bar above read `2 · switch it on`. See
  // `firstRunOwnsMainView`.
  const setupOwnsView = firstRunOwnsMainView(setupView);
  // UX 1.0.13: the launch's Today landing waits for the setup view. While first run owns the main view it gives way
  // to the Chief's chat (a saved conversation can exist before the setup flow is done); until the view answers, the
  // chat shows, so a first run never flashes Today.
  const todayLandingOnHold = state.activeView === "today" && state.todayLanding === true && (setupView === null || setupOwnsView);
  useEffect(() => {
    if (state.activeView === "today" && state.todayLanding && setupOwnsView) dispatch({ type: "cancelTodayLanding" });
  }, [dispatch, setupOwnsView, state.activeView, state.todayLanding]);
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !setupOwnsView &&
    !state.instances.some(
      (i) =>
        i.enabled !== false &&
        i.snapshot.state === "available" &&
        (i.models?.default ?? "").trim().length > 0,
    );

  // Engines switched off (a restored copy) never hide the conversations: the
  // chat stays, with a notice above it (D7).
  const enginesOff = noEngines && enginesOnlySwitchedOff(state.instances) && Boolean(bot || group);
  // App-wide shortcuts: ⌘N new bot · ⌘, Settings · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next · ⌘⇧K All chats.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.defaultPrevented || imeComposing(e)) return;
      const bots = sidebarBotOrder(state.bots, state.groups.filter((group) => !group.hidden), sidebarLayout.current.sectionOrder, sidebarLayout.current.showHidden);
      const cycleDirection = sidebarCycleDirection(e);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (e.key === "," && !e.shiftKey && !e.altKey) {
        // Settings, the way every Mac app opens its settings.
        e.preventDefault();
        dispatch({ type: "toggleAppSettings", open: true });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && !e.altKey && (e.key.toLowerCase() === "k" || e.code === "KeyK")) {
        // All chats; again (or Escape) goes back to the chat
        e.preventDefault();
        dispatch(state.activeView === "all-chats" ? { type: "closeAllChats" } : { type: "showAllChats" });
      } else if (cycleDirection !== null) {
        const next = adjacentSidebarBot(bots, state.selectedId, cycleDirection);
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.groups, state.selectedId, state.activeView, dispatch]);

  useEffect(() => {
    notificationBridge()?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Re-assert every authoritative positive hold in the process that owns the
  // native browser. This covers initial hydration, SSE updates from another
  // computer surface, and renderer reloads. Deliberately never mirror false:
  // only a trusted two-phase release may open Electron's direct browser gate.
  useEffect(() => {
    const setter = window.muragebox?.browser?.setHumanControl;
    if (!setter) return;
    for (const botId of heldComputerControlBotIds(state.computerControl)) {
      void setter(botId, true).catch(() => {});
    }
  }, [state.computerControl]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. A pick is the person's
  // own (conversationPicks), so hydration settling the selection or another
  // surface moving the thread leaves an open drawer alone. pluginsOpen and
  // settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat (drawer-close.ts).
  const closeKey = drawerCloseKey(state);
  useEffect(() => {
    setDrawerOpen(false);
  }, [closeKey]);

  useEffect(() => {
    // Routines' and Health's Back targets (shell-nav.ts trackShellOrigins): All chats returns to the chat, and a
    // return between the two keeps the first origin, so Back never bounces between them.
    const origins = trackShellOrigins(previousViewRef.current, state.activeView, state.selectedId, { calendar: calendarOriginRef.current, health: healthOriginRef.current });
    calendarOriginRef.current = origins.calendar;
    healthOriginRef.current = origins.health;
    previousViewRef.current = state.activeView;
    // selectedId is read as the view moves, not tracked: a later pick does not change where Back goes.
  }, [state.activeView]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };
  const openBrowserWorkspace = useCallback((botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  }, [dispatch]);
  const closeBrowserWorkspace = useCallback(() => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  }, [dispatch]);
  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const closeCalendar = useCallback(() => {
    if (calendarOriginRef.current === "today") { dispatch({ type: "showToday" }); return; }
    if (calendarOriginRef.current === "needs-you") { dispatch({ type: "showNeedsYou" }); return; }
    if (calendarOriginRef.current === "health") { dispatch({ type: "showHealth" }); return; }
    if (calendarOriginRef.current === "team-map") {
      dispatch({ type: "showTeamMap" });
      return;
    }
    if (calendarOriginRef.current === "skill-recorder" && skillRecorderAvailable(state.config, desktop, isCloudOrigin(), capabilities.host.platform)) {
      dispatch({ type: "showSkillRecorder" });
      return;
    }
    dispatch({ type: "select", id: state.selectedId });
  }, [desktop, dispatch, state.config, state.selectedId]);
  // Reads the latest state through a ref, so Health's Esc listener is bound once, not on every render.
  const leaveHealthState = useRef(state);
  leaveHealthState.current = state;
  const leaveHealth = useCallback(() => {
    const now = leaveHealthState.current;
    dispatch(healthReturn(healthOriginRef.current, now, skillRecorderAvailable(now.config, desktop, isCloudOrigin(), capabilities.host.platform)));
  }, [capabilities.host.platform, desktop, dispatch]);
  const openCalendarRoom = useCallback((id: string) => {
    dispatch({ type: "select", id });
  }, [dispatch]);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.muragebox?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void api(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action: "release" }),
      })
        .then(async (snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
          // Closing a viewer is not itself permission to open Electron's
          // browser gate. The authoritative server release must succeed first.
          if (snap?.held === false) {
            await window.muragebox?.browser?.setHumanControl?.(botId, false).catch(() => {});
          }
        })
        .catch(() => {});
      void api(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  const cloudBrowser = isCloudHome() && !isCloudOrigin();
  return (
    <div className="flex h-full flex-col">
      {/* ABOVE everything, and not dismissible while the engine is down. A
          dead server is indistinguishable from a dozen broken features from
          in here, and that cost the owner an hour on 2026-09-22. */}
      <ServerLifecycleBanner />
      {/* After an update, later memory work runs while chat is open: say so, calmly, with the progress. */}
      {desktop === true && <LazyMemoryIntegrityStrip />}
      <CloudUnreachableBanner />
      <OwnerExpiredBanner />
      <WorkspaceSwitch />
      {/* The remote counterpart: a phone or browser whose computer went quiet. */}
      {desktop === false && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}
      {/* An owner's browser on a Cloud home counts as the desktop surface, so it needs its own ask. The Cloud window has CloudUnreachableBanner. */}
      {desktop === true && cloudBrowser && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}
      {/* The saved Flux key is not one, or Flux refused it: say so, with the fix. */}
      {desktop === true && <FluxKeyProblemBanner />}
      {/* Only after the door itself said 401 (lib/session-check.ts). */}
      {state.signedOut && <SignedOutCard />}
      {/* UX 1.0.13 band slot: no internet on this device. Bots on the computer keep working; it says what waits. */}
      <OfflineBand connectivity={connectivity} desktop={desktop} />
      {/* The update pop-up is mounted in App, beside the terms gate. */}
      <UpdateStaleNotice />
      {/* The first run's phases, as a band ABOVE whatever is in the main view
          rather than on top of it or beside it. It owns its own visibility
          (src/lib/first-run.ts): the server's `view.firstRun` offers it, and
          `/setup` or the Settings row bring it back on any install. Mounted
          on a confirmed desktop only. A paired phone coming through the
          browser door is not a fresh machine and must never be shown a
          first-run screen. */}
      {desktop === true && <FirstRunPhases />}
      {/* The welcome (Ember pops in): the first paint of a brand-new install, above everything, desktop only. Its rule is
          welcomeShouldShow (src/lib/first-run-welcome.ts). */}
      {desktop === true && <FirstRunWelcome />}
      {/* The cached start-up picture (FIRSTRUN-1019 slice B): the next start's tip and the Chief's own face, drawn off screen. Nothing on screen; held while the welcome is up. */}
      {desktop === true && <StartupPictureWriter chiefBotId={setupView?.chiefBotId ?? null} suspended={pictureHeld(setupView ?? null)} />}
      <div className="relative flex min-h-0 flex-1">
      <BotListDrawerProvider value={drawerControl}>
      {/* The "Open bot list" button is not drawn here. Each main view's header
          draws it as the first item of its own row (OpenBotListButton.tsx), so
          it is centred with the name and the ••• instead of floating over
          them. The calendar focus view gets no provider, so no button. */}
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <Sidebar
        onLayoutChange={onSidebarLayout}
        needs={needs}
        health={health}
        open={drawerOpen}
        // Focus goes back to the bot-list button once the view the pick
        // opened has mounted its own (useBotListDrawer).
        onClose={closeDrawer}
        // Closed by an effect (closeKey: something opened over the chat) with
        // focus still inside: the now inert drawer would drop it to the page.
        onReturnFocus={returnDrawerFocus}
      />
      {/* UX 1.0.13 main slot: Today (L2A), Needs you and Health (L2B through lane-slots), then the views as before. */}
      {state.activeView === "today" && !todayLandingOnHold ? (
        <TodayView needs={needs} health={health} firstRun={setupOwnsView} chiefBotId={setupView?.chiefBotId ?? null} remote={desktop !== true} />
      ) : state.activeView === "needs-you" ? (
        <NeedsYouPage tab={state.needsYouTab ?? "decisions"} onTabChange={(tab) => dispatch({ type: "setNeedsYouTab", tab })} onLeave={() => dispatch({ type: "showToday" })} onOpenChat={nav.openChat} health={health} />
      ) : state.activeView === "health" ? (
        <HealthPage onOpenNeedsYou={() => nav.showNeedsYou()} onLeave={leaveHealth} />
      ) : state.activeView === "all-chats" ? (
        <LazyOverlay name="page-all-chats" kind="page" covers="while-loading" key="all-chats" onRetry={AllChatsPageLazy.retry} onDismiss={() => dispatch({ type: "closeAllChats" })}><AllChatsPage /></LazyOverlay>
      ) : state.activeView === "team-map" ? (
        <LazyOverlay name="page-team-map" kind="page" covers="while-loading" key="team-map" onRetry={TeamMapPageLazy.retry} onDismiss={() => dispatch({ type: "showToday" })}><TeamMapPage /></LazyOverlay>
      ) : state.activeView === "routines" ? (
        <LazyOverlay name="page-routines" kind="page" covers="while-loading" key="routines" onRetry={RoutinesPageLazy.retry} onDismiss={closeCalendar}><RoutinesPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} /></LazyOverlay>
      ) : state.activeView === "skill-recorder" && skillRecorderAvailable(state.config, desktop, isCloudOrigin(), capabilities.host.platform) ? (
        <LazyOverlay name="page-skill-recorder" kind="page" covers="while-loading" key="skill-recorder" onRetry={SkillRecorderPageLazy.retry} onDismiss={() => dispatch({ type: "showToday" })}><SkillRecorderPage /></LazyOverlay>
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <LazyOverlay name="page-browser-workspace" kind="page" covers="while-loading" key="browser-workspace" onRetry={BrowserWorkspaceLazy.retry} onDismiss={closeBrowserWorkspace}><BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} /></LazyOverlay>
      ) : localVmWorkspaceBotId ? (
        <LazyOverlay name="page-local-vm-workspace" kind="page" covers="while-loading" key="local-vm-workspace" onRetry={LocalVmWorkspaceLazy.retry} onDismiss={() => setLocalVmWorkspaceBotId(null)}><LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        /></LazyOverlay>
      ) : enginesOff ? (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div role="status" className="flex flex-wrap items-center gap-3 border-b border-hairline/40 bg-inset px-4 py-2 text-[13px] text-ink">
            <span className="min-w-0 flex-1">Your conversations are all here. AI engines are switched off in this copy, so bots can't answer yet. Turn one on in Settings, then Engines.</span>
            <button type="button" className="min-h-9 rounded-lg border border-hairline/40 px-3 text-[13px] font-medium text-ink hover:bg-app focus-visible:ring-2 focus-visible:ring-accent-border"
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}>Open Engines</button>
          </div>
          <div className="flex min-h-0 flex-1">{group ? <LazyBoundary key={group.id} inline frame={roomFrame} onRetry={GroupViewLazy.retry}><Suspense fallback={<LazyFallback inline />}><GroupView group={group} /></Suspense></LazyBoundary> : <ChatView bot={bot!} />}</div>
        </div>
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <LazyBoundary key={group.id} inline frame={roomFrame} onRetry={GroupViewLazy.retry}><Suspense fallback={<LazyFallback inline />}><GroupView group={group} /></Suspense></LazyBoundary>
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col bg-app text-ink-secondary">
          <PhoneBotListBar />
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Reconnecting to Murage…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              {desktop === true
                ? "This usually clears on its own. If it does not, quit Murage and open it again."
                : "This usually clears on its own once your computer is awake and online."}
            </div>
          )}
          </div>
        </main>
      )}
      {state.settingsOpen && settingsBot && (
        <LazyOverlay name="bot-settings" kind="window" covers="always" opener={settingsSession.current} holdFocus={false} onRetry={BotSettings.retry} onDismiss={() => dispatch({ type: "toggleSettings", open: false })}>
            {LoadedBotSettings ? <LoadedBotSettings key={settingsBot.id} bot={settingsBot} /> : <BotSettingsDialog key={settingsBot.id} bot={settingsBot} />}
        </LazyOverlay>
      )}
      {state.computerOpen && bot && (
        <LazyOverlay name="computer" kind="window" covers="while-loading" onRetry={Computer.retry} onDismiss={() => dispatch({ type: "toggleComputer", open: false })}>
            <ComputerPanel
              key={bot.id}
              bot={bot}
              onOpenVmWorkspace={openLocalVmWorkspace}
              onExpandBrowser={openBrowserWorkspace}
            />
        </LazyOverlay>
      )}
      {state.inspectorOpen && bot && (
        <LazyOverlay name="inspector" kind="window" covers="while-loading" onRetry={Inspector.retry} onDismiss={() => dispatch({ type: "toggleInspector", open: false })}>
            <InspectorPanel bot={bot} />
        </LazyOverlay>
      )}
      {state.appSettingsOpen && (
        <LazyOverlay name="settings" kind="window" covers="always" opener={settingsSession.current} holdFocus={false} onRetry={Settings.retry} onDismiss={() => dispatch({ type: "toggleAppSettings", open: false })}>
            <SettingsModal />
        </LazyOverlay>
      )}
      <div className="fixed bottom-4 left-4 z-40 max-w-sm"><ReconnectAppsBanner enabled /></div>
      {state.reconnectIncidentId && <ConnectorReconnectDialog key={state.reconnectIncidentId} incidentId={state.reconnectIncidentId} />}
      <NewBotSignInStep />
      {state.pluginsOpen && <LazyOverlay name="plugins" kind="window" covers="always" onRetry={PluginsPanelLazy.retry} onDismiss={() => dispatch({ type: "togglePlugins", open: false })}><PluginsPanel /></LazyOverlay>}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPaletteHost onOpenChange={setPaletteOpen} />
      {/* The stop control for composer dictation when no Composer can draw it (thread switch, another view, a layer on top). */}
      <DictationStatusBar />
      {desktop === true && <NoLimitsTermsPrompt />}
      {desktop === true && <NoLimitsFollowers upgrade />}
      <EngineChatLinkHost />
      {/* Bot calls 1.0.9: the ring banner (call.ring hints re-read GET /api/calls/active) */}
      <BotCallRing />
      <CallOverlaySlot
        state={state}
        dispatch={dispatch}
        isCallTargetCovered={isCallTargetCovered}
        uncoverCallTarget={uncoverCallTarget}
      />
      <UndoToastHost />
      {/* 1.0.12 UX slice 4: the "?" help panel, its tab and keys (? and Cmd/Ctrl+/), on every surface. */}
      <HelpHost
        surface={feedbackSurface(desktop, isCloudOrigin())}
        noEngines={noEngines}
        enginesOff={enginesOff}
        firstRun={setupOwnsView && setupView ? { next: setupView.next, chiefBotId: setupView.chiefBotId, blocked: setupView.blocked } : null}
      />
      {/* L4C: hints once (each coach mark shows one time on this device; "Show hints again" in help resets them). */}
      <CoachMarks firstRun={Boolean(setupOwnsView && setupView)} />
      </BotListDrawerProvider>
      </div>
      {/* UX 1.0.13 phoneTabs slot (L7): below md only, on the four door pages. An open chat is a screen pushed
          over Chats (its header's bot-list button is the way back), so the composer keeps the bottom of the screen. */}
      {phoneTab && (
        <div className="md:hidden">
          <PhoneTabs active={phoneTab} needsCount={needs.count} onSelect={openDoor} />
        </div>
      )}
    </div>
  );
}

export default function App() {
  // A stable mark that the bundle loaded and React mounted (the Cloud door sets the same mark first).
  useEffect(() => { document.documentElement.dataset.murageMounted = "1"; }, []);
  // WHO IS ALLOWED TO SEE A FIRST-RUN SCREEN.
  //
  // The welcome / email gate keys off localStorage, and a phone reaching this
  // app through the browser door is a fresh browser: no key, so `emailGateDone`
  // said "never used Murage" to the person holding the paired device. He had
  // used it — pairing that phone is what he used it FOR. The gate is a
  // first-run screen for the machine, and only the machine can answer it, so
  // it renders on a CONFIRMED desktop and nowhere else.
  //
  // `undefined` (not asked yet) renders nothing. Nothing is the neutral thing
  // here: the app underneath is already correct on both surfaces, and a frame
  // of the welcome screen on a phone is the whole bug.
  //
  // That gate has since been folded into the Chief of Staff's thread and the
  // progress rail beside it, and the rule survives the screen unchanged: the
  // rail renders on a CONFIRMED desktop and nowhere else (see Shell above).
  // Its answer is the server's `view.firstRun`, which no phone's empty
  // localStorage can get wrong, and it is still withheld on `undefined`.
  const desktop = useDesktopSurface();
  useEffect(() => {
    initAnalytics();
  }, []);
  // One listener for the whole app: publishes --vvh/--kb/data-keyboard on
  // <html> so #root tracks the visual viewport instead of the layout viewport.
  // Without it the composer sits behind the iOS keyboard (styles.css #root).
  useEffect(() => trackVisualViewport(), []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        {/* Before the first-run flow and everything else: nothing is mounted,
            so nothing can be sent, until the terms are accepted (TermsGate). */}
        <TermsGate>
          <Shell />
        </TermsGate>
        {/* The 6-digit code step for an owner browser on a Cloud home (src/lib/owner-code.ts). Outside the terms gate: nothing in it can be sent without it. */}
        <OwnerCodeDialog />
        {/* The update pop-up (above the sidebar footer once it mounts; a top-layer popover inside an open modal window). Beside the gate, not behind it: an update that downloads
            while the terms screen is up still shows, and it sends nothing. It renders nothing without the updater bridge. */}
        <UpdateBanner />
        {/* A CONFIRMED remote surface only. The desktop app is already an app;
            `undefined` renders nothing, the same neutral answer the welcome
            gate above takes. */}
        {desktop === false && <InstallPrompt />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
