import { t } from "@/lib/i18n";
// The call controls that are on screen before anyone calls: the header's
// call buttons and the overlay switch. The call screens behind them (the
// turn-taking loop, the voice host, the microphone and its speech model)
// load on the first call (spec §6), so a phone that never calls never
// downloads them.
import { Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { useStore, viewedTaskBot, type Bot, type Group } from "@/state/store";
import { endCall, startCall, takeCallRequest, useCallRequest, useOnCall } from "@/lib/call";
import { useCallBarState } from "@/lib/call-bar";
import { CallBarContent } from "./CallBarContent";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { callSupport, helpPanelLeft, showsGroupCallButton } from "@/lib/call-support";
import { isPhoneClient } from "@/lib/phone-client";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { LazyFallback } from "./LazyFallback";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";

const CallChunk = retryableLazy(() => import("./CallView").then((module) => ({ default: module.Call })));
const GroupCallChunk = retryableLazy(() => import("./GroupCallView").then((module) => ({ default: module.GroupCall })));
const Call = CallChunk.Component;
const GroupCall = GroupCallChunk.Component;

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId })}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  voices,
  setupBotId,
  requireExplicitVoices,
  macOnly = false,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Agent profile to open when voice setup is missing (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  /** Only a Mac's own speech helper can drive this call (channel calls). */
  macOnly?: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const onCall = useOnCall();
  const active = onCall === targetId;
  // A Mac recognizes speech on the device. Windows and Linux capture the
  // microphone in the app and transcribe through the workspace's Flux key.
  const macSpeech = capabilities.dictation.available && Boolean(window.muragebox?.speechStart);
  // Windows and Linux transcribe through Flux or the owner's own Groq or
  // OpenAI key, whichever the harness reports can serve it.
  const hostedSpeech =
    Boolean(state.config?.tts?.routes?.transcribe) &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const { supported, label: unsupportedLabel, reason: unsupportedReason } = callSupport({ macSpeech, hostedSpeech, macOnly });
  const configured = Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice));
  const unavailable = !active && (!capabilitiesReady || !supported || !voiceReady);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
  const [panelLeft, setPanelLeft] = useState(0);
  // open the panel from whichever edge keeps it on screen
  useLayoutEffect(() => {
    if (!helpOpen || !buttonRef.current) return;
    setPanelLeft(helpPanelLeft(buttonRef.current.getBoundingClientRect(), window.innerWidth));
  }, [helpOpen]);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  // "Call a bot" from What's new: press this button once it can answer.
  const callRequest = useCallRequest();
  useEffect(() => {
    if (callRequest === targetId && capabilitiesReady && takeCallRequest(targetId)) buttonRef.current?.click();
  }, [callRequest, targetId, capabilitiesReady]);
  const label = active
    ? t("calls.hangUpOn", { name: targetName })
    : !capabilitiesReady
      ? t("calls.checkingAvailability")
      : !supported
        ? unsupportedLabel ?? "Add a Flux key, or an OpenAI or Groq key, in Settings to make calls on this computer"
        : !configured
          ? "Set up a voice in a bot's settings to make calls"
          : !voiceReady
            ? "Pick a voice in a bot's settings to make calls"
            : t("calls.call", { name: targetName });

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : !supported
      ? unsupportedReason ?? (capabilities.dictation.available
        ? "The speech service is unavailable in this app build. Restart or update Murage."
        : "Calls on this computer understand you through Flux, or your own OpenAI or Groq key. Add one in Settings.")
      : !configured
          ? "Add a Flux key, an ElevenLabs key, or switch to the built-in Mac voices so the bot can speak during calls."
          : !voiceReady
            ? voices.length > 1
              ? "Give every channel member a voice before starting a channel call."
              : "Choose a voice before starting a call."
            : "";

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        data-testid={`call-button-${targetId}`}
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
          // A call is already running elsewhere: end it first, with no
          // confirm dialog, so the new call never shares the old one's
          // Call instance and state (App.tsx's `key={activeCallId}`
          // handles the remount; this is what actually changes the key).
          if (onCall && onCall !== targetId) endCall(onCall);
          startCall(targetId);
        }}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full transition-colors",
          active
            ? "bg-danger text-white hover:brightness-110"
            : unavailable
              ? "text-ink-secondary/50 hover:bg-raised hover:text-ink-secondary"
              : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>

      {unavailable && helpOpen && (
        <div
          id={helpId}
          role="group"
          aria-label="Call unavailable"
          className={cn(
            "animate-pop-in absolute z-30 mt-1.5 w-[280px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl",
          )}
          style={{ left: panelLeft }}
        >
          <div className="text-[13px] font-medium text-ink">Call unavailable</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {voiceSetupRequired && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                if (setupBotId && setupBotId !== targetId) dispatch({ type: "select", id: setupBotId });
                dispatch({ type: "toggleSettings", open: true });
              }}
              className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              Open agent settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function GroupCallButton({ group, members }: { group: Group; members: Bot[] }) {
  if (group.dm) return null;
  if (!showsGroupCallButton({ desktopBridge: Boolean(window.muragebox), phone: isPhoneClient() })) return null;
  return (
    <CallTargetButton
      targetId={group.id}
      targetName={group.name}
      voices={members.map((member) => member.voice)}
      setupBotId={members.find((member) => !member.voice)?.id ?? members[0]?.id}
      requireExplicitVoices
      macOnly
      onStart={() => track("group_call_started", { memberCount: members.length })}
    />
  );
}

/** Mounted once, at Shell level, for whichever bot is on the call — not
 * inside the selected chat. `collapsed` only changes what's rendered; the
 * call itself (`Call`, in CallView.tsx) never unmounts on a thread switch,
 * which is the fix for the moss-approval-bug silent hang-up. */
export function CallOverlay({
  bot,
  collapsed = false,
  onExpand,
}: {
  bot: Bot;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  // Close ends the call: a call screen that cannot load must not leave the
  // app covered with a call still running.
  return (
    <LazyBoundary onRetry={CallChunk.retry} onDismiss={() => endCall(bot.id)}>
      <Suspense fallback={<LazyFallback />}>
        <Call bot={bot} collapsed={collapsed} onExpand={onExpand} />
      </Suspense>
    </LazyBoundary>
  );
}

export function GroupCallOverlay({
  group,
  members,
  collapsed = false,
  onExpand,
}: {
  group: Group;
  members: Bot[];
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return (
    <LazyBoundary onRetry={GroupCallChunk.retry} onDismiss={() => endCall(group.id)}>
      <Suspense fallback={<LazyFallback />}>
        <GroupCall group={group} members={members} collapsed={collapsed} onExpand={onExpand} />
      </Suspense>
    </LazyBoundary>
  );
}

type Store = ReturnType<typeof useStore>;

/** Mounts the call in progress, if any, keyed to the bot or room actually on
 * the line rather than to whatever is selected (App.tsx's `Shell`,
 * moss-approval-bug.md): switching threads must never unmount it, and
 * calling a different target while one call is collapsed must never reuse
 * its `Call`/`GroupCall` instance (`key={activeCallId}`, callbar-review.md
 * I1). Lives here rather than in App.tsx so the call-host e2e harness can
 * mount this exact block for real (callbar-rereview.md I7) instead of
 * hand-copying it — a revert of the `key`, or of CallView.tsx/
 * GroupCallView.tsx's portal, now fails that suite too, not just App.tsx's
 * own behavior. */
export function CallOverlaySlot({
  state,
  dispatch,
  isCallTargetCovered,
  uncoverCallTarget,
}: {
  state: Store["state"];
  dispatch: Store["dispatch"];
  /** True while some other full-screen surface (a workspace panel) is
   * covering the call's own bot/room, so the call must show its bar
   * instead of its full screen (callbar-rereview.md N4). App.tsx passes
   * its LocalVm/Browser workspace state; nothing else needs to. */
  isCallTargetCovered?: (id: string) => boolean;
  /** Closes whatever is covering the call's target, so returning to the
   * call actually shows it instead of leaving the bar in place. */
  uncoverCallTarget?: (id: string) => void;
}) {
  const activeCallId = useOnCall();
  const activeCallGroup = activeCallId ? state.groups.find((g) => g.id === activeCallId) : undefined;
  const activeCallBotRaw = !activeCallGroup && activeCallId ? state.bots.find((b) => b.id === activeCallId) : undefined;
  // Projected through the same task-thread view ChatView gives every other
  // conversation control (busy, activity, auto-approve), or the call's
  // narration and approval speech can read a different state than the
  // thread it is actually a call about (callbar-review.md I6).
  const activeCallBot = useMemo(() => (activeCallBotRaw ? viewedTaskBot(activeCallBotRaw) : undefined), [activeCallBotRaw]);
  const activeCallGroupMembers = useMemo(
    () =>
      activeCallGroup
        ? activeCallGroup.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b))
        : undefined,
    [activeCallGroup, state.bots],
  );
  // Full screen only while that call's own thread is the one on screen; any
  // other selection (or another view entirely) shows the bar instead.
  const callIsSelected =
    state.activeView === "chat" &&
    state.selectedId === activeCallId &&
    !(activeCallId && isCallTargetCovered?.(activeCallId));
  const bar = useCallBarState();
  const returnToCall = () => {
    if (!activeCallId) return;
    // Close whatever workspace was covering the call, or re-selecting the
    // same bot/room (already selected) would leave callIsSelected false
    // and the bar right back where it started (N4).
    uncoverCallTarget?.(activeCallId);
    dispatch({ type: "select", id: activeCallId });
    // Bring the call's own (frozen) thread back into view too — a push may
    // have moved what this bot/room currently shows, and selecting alone
    // leaves it on that thread, collapsed, with a second tap (on the
    // strip) needed to actually reach the call (callbar-rereview2.md G2;
    // the same restore CallBarStrip's own tap already does, below).
    if (bar && bar.targetId === activeCallId) {
      if (bar.kind === "bot") dispatch({ type: "switchTask", botId: bar.targetId, threadId: bar.threadId });
      else dispatch({ type: "switchGroupTask", groupId: bar.targetId, threadId: bar.threadId });
    }
  };
  return (
    <>
      {activeCallBot && (
        <CallOverlay key={activeCallId} bot={activeCallBot} collapsed={!callIsSelected} onExpand={returnToCall} />
      )}
      {activeCallGroup && activeCallGroupMembers && (
        <GroupCallOverlay
          key={activeCallId}
          group={activeCallGroup}
          members={activeCallGroupMembers}
          collapsed={!callIsSelected}
          onExpand={returnToCall}
        />
      )}
    </>
  );
}

/** The call's status strip: rendered by ChatView/GroupView at the top of
 * their own column, under the header, in normal document flow — never by
 * Call/GroupCall itself, which would either float it over the composer on
 * a phone or over the sidebar on desktop (callbar-review.md I4, I5).
 * Hidden on the call's own conversation: the full screen already covers
 * that (or, briefly, nothing does, while it portals in). */
export function CallBarStrip({ ownId, ownThreadId }: { ownId: string; ownThreadId?: string }) {
  const { dispatch } = useStore();
  const bar = useCallBarState();
  // Hide only on the call's OWN thread, not on any thread of that bot
  // (callbar-rereview.md N3): a push for a different task of the same bot
  // changes what thread is on screen without changing which bot it is.
  if (!bar || (bar.targetId === ownId && bar.threadId === ownThreadId)) return null;
  return (
    <div data-testid="call-bar" className="flex items-center gap-2.5 border-b border-hairline/40 bg-panel px-3 py-2">
      <CallBarContent
        name={bar.name}
        status={bar.status}
        onReturn={() => {
          // Select the call's target, then bring its own (frozen) thread
          // back into view — a push may have moved what this bot/room
          // currently shows (callbar-rereview.md N3, N4).
          dispatch({ type: "select", id: bar.targetId });
          if (bar.kind === "bot") dispatch({ type: "switchTask", botId: bar.targetId, threadId: bar.threadId });
          else dispatch({ type: "switchGroupTask", groupId: bar.targetId, threadId: bar.threadId });
        }}
        onHangUp={() => endCall(bar.targetId)}
      />
    </div>
  );
}
