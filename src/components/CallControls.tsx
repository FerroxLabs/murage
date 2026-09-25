import { t } from "@/lib/i18n";
// The call controls that are on screen before anyone calls: the header's
// call buttons and the overlay switch. The call screens behind them (the
// turn-taking loop, the voice host, the microphone and its speech model)
// load on the first call (spec §6), so a phone that never calls never
// downloads them.
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { useStore, type Bot, type Group } from "@/state/store";
import { endCall, startCall, takeCallRequest, useCallRequest, useOnCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
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
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Agent profile to open when voice setup is missing (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const active = useOnCall() === targetId;
  // A Mac recognizes speech on the device. Windows and Linux capture the
  // microphone in the app and transcribe through the workspace's Flux key.
  const macSpeech = capabilities.dictation.available && Boolean(window.muragebox?.speechStart);
  // Windows and Linux transcribe through Flux or the owner's own Groq or
  // OpenAI key, whichever the harness reports can serve it.
  const hostedSpeech =
    Boolean(state.config?.tts?.routes?.transcribe) &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const supported = macSpeech || hostedSpeech;
  const configured = Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice));
  const unavailable = !active && (!capabilitiesReady || !supported || !voiceReady);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
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
        ? "Add a Flux key, or an OpenAI or Groq key, in Settings to make calls on this computer"
        : !configured
          ? "Set up a voice in a bot's settings to make calls"
          : !voiceReady
            ? "Pick a voice in a bot's settings to make calls"
            : t("calls.call", { name: targetName });

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : !supported
      ? capabilities.dictation.available
        ? "The speech service is unavailable in this app build. Restart or update Murage."
        : "Calls on this computer understand you through Flux, or your own OpenAI or Groq key. Add one in Settings."
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
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
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
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[280px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
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
  return (
    <CallTargetButton
      targetId={group.id}
      targetName={group.name}
      voices={members.map((member) => member.voice)}
      setupBotId={members.find((member) => !member.voice)?.id ?? members[0]?.id}
      requireExplicitVoices
      onStart={() => track("group_call_started", { memberCount: members.length })}
    />
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return (
    <LazyBoundary onRetry={CallChunk.retry}>
      <Suspense fallback={<LazyFallback />}>
        <Call bot={bot} />
      </Suspense>
    </LazyBoundary>
  );
}

export function GroupCallOverlay({ group, members }: { group: Group; members: Bot[] }) {
  const active = useOnCall() === group.id;
  if (!active) return null;
  return (
    <LazyBoundary onRetry={GroupCallChunk.retry}>
      <Suspense fallback={<LazyFallback />}>
        <GroupCall group={group} members={members} />
      </Suspense>
    </LazyBoundary>
  );
}
