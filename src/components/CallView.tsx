import { t } from "@/lib/i18n";
// Call mode — the bot on the line.
//
// The loop is deliberately HALF-DUPLEX: the microphone is live only when
// the bot is not speaking. The dictation helper is Apple's SFSpeechRecognizer
// running on raw AVAudioEngine input with no acoustic echo cancellation, so
// a mic left open through playback transcribes the bot's own voice back into
// the conversation and the two of them talk forever. Interrupting is a tap
// or Escape instead, which is honest and cannot feed back. (Full-duplex
// barge-in needs AEC on the capture path — a follow-up, not a footnote.)
//
// Turn-taking uses a small silence endpointer in the native helper. Apple's
// buffer-backed recognizer does not finalize on silence by itself: the helper
// has to end the audio stream, which then produces the final transcript.
//
// The other half of making a call bearable is narration. An agent turn is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
//
// 0.1.59: TWO LAYERS, ONE BOT. With a Flux key, what you say goes first to
// the voice host (server/voice/voice-host.ts), a fast model that speaks as
// this bot from what the bot already knows and starts talking in about a
// second. Anything that needs real work it hands down, and this screen sends
// that request through the ordinary send path, so the engine turn, the
// approvals and the transcript are exactly a typed message's. While the
// engine works the microphone stays open between spoken lines, so you can
// ask how it is going or talk about something else; a soft pulse fills the
// silence instead of narration. When the host is unavailable the call is
// the engine-only call it always was.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Mic, MicOff, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { BRIEF_OVER_CHARS, callRouteHeaders, HOST_OFF_FOR_CALL, hostTurn, openingOf, plainFailure, warmHost, type CallHandDown, type HostTurnInput } from "@/lib/voice-host";
import { WorkingPulse } from "@/lib/working-pulse";
import { callMicKind, createCallMic, createFallbackMic, type CallMic } from "@/lib/call-mic";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { CallAvatar } from "./CallAvatar";
import { isHostConsentApproval, isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt, spokenToolAction, type Pending } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;
/** Listening noises while the bot talks: "uh-huh", "yeah", "mm", "right". */
const BACKCHANNEL = /^(u+h+[- ]?h+u+h+|m+h?m+|mm+[- ]?h+m+|yeah|yep|yes|right|okay|ok|sure|got it|i see|oh|ah|wow|nice|cool|uh|um)[.!?]*$/i;
/** A yes that covers this kind of request until the call ends. */
const YES_FOR_CALL = /\b(for (the rest of |)(the|this) call|yes to (all|everything)|until (i|we) hang up|(for )?the rest of (the|this) call|don'?t (ask|keep asking)( me)?( again)?)\b/i;

/** The kind of request a call-long yes covers: the harness's own narrow
 *  allow key when it gives one, otherwise the tool and what it does. */
function grantKey(pending: Pending): string {
  return pending.allowKey || `${pending.tool}|${spokenToolAction(pending.tool, pending.detail)}`;
}

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;
/** How long the bot stays paused for what may be the owner before carrying
 *  on (LiveKit's false_interruption_timeout default). */
const FALSE_INTERRUPTION_MS = 2_000;
/** Voice while the echo canceller settles on the bot's first words is the
 *  bot (LiveKit uses 3 s of AEC warm-up). */
const ECHO_WARMUP_MS = 3_000;
/** While the engine works and nobody has spoken for this long, say what it
 *  is doing (LiveKit Agents' filler scheduler: delay, then interval, capped). */
const STILL_ON_IT_AFTER_MS = 14_000;
const STILL_ON_IT_EVERY_MS = 25_000;
const STILL_ON_IT_MAX = 3;
/** Engine work running this long gets one plain check-in (Pipecat's
 *  function-call timeout, softened: the work is not cancelled). */
const LONG_WORK_MS = 4 * 60_000;

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

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}

function Call({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // One microphone for the whole call (src/lib/call-mic.ts): Apple's
  // recognizer on a Mac, Flux transcription elsewhere, both fed from an
  // echo-cancelled capture so the owner can talk over the bot.
  const micRef = useRef<CallMic | null>(null);
  if (!micRef.current) {
    const kind = callMicKind({
      appleSpeech: capabilities.dictation.available && Boolean(window.muragebox?.speechStart),
      fluxConfigured: Boolean(state.config?.tts?.routes?.transcribe),
      capture: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    });
    micRef.current = kind ? createCallMic(kind) : createFallbackMic();
  }
  /** A recognition turn is running in the recognizer. */
  const micLive = useRef(false);
  const [muted, setMuted] = useState(false);
  const duplex = () => Boolean(micRef.current?.duplex);
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // The voice host answers first when the workspace has a Flux key. It is
  // switched off for the rest of the call by a failure that will not fix
  // itself mid-call (no key, a plan without it); a network blip only sends
  // that one turn down the engine path.
  const hostOn = useRef(Boolean(state.config?.tts?.routes?.host));
  const hostHistory = useRef<HostTurnInput["history"]>([]);
  /** When the bot first spoke on this call (echo warm-up). */
  const firstSpokeAt = useRef(0);
  /** Work handed down on this call and what the call screen knows of it;
   *  the host sees each as a tool call with its live status. */
  const handDowns = useRef<CallHandDown[]>([]);
  /** When the owner last cancelled work on this call. A reply the stopped
   *  work still writes is not spoken (Pipecat drops results that arrive
   *  after a call was cancelled). */
  const cancelledAt = useRef(0);
  const hostAbort = useRef<AbortController | null>(null);
  const heardRef = useRef("");
  /** An engine reply that arrived while the owner was mid-sentence. */
  /** Answers that landed while the owner or the bot was talking, oldest
   *  first. A queue, not a slot: a second answer used to overwrite the first
   *  and the owner never heard it (Pipecat and LiveKit both queue results
   *  owed to the user until the conversation is idle). */
  const deferredReplies = useRef<string[]>([]);
  const pulse = useRef<WorkingPulse | null>(null);
  /** The host's sentences are being voiced; an engine reply waits for them. */
  const hostSpeaking = useRef(false);
  const quietRestartAt = useRef(0);
  /** The host is looking something up on the web right now. */
  const [lookingUp, setLookingUp] = useState(false);
  /** What happened to each thing the owner said: the call note's source. */
  const callLog = useRef<Array<{ said: string; outcome: "answered" | "looked_up" | "handed_down" | "engine" | "decision" | "not_started"; detail?: string }>>([]);
  /** Sends the server refused, by what the owner said: the log records them
   *  as not started even when the refusal beats the log entry. */
  const refusedSends = useRef(new Map<string, string>());
  const callStartedAt = useRef(Date.now());
  const threadRef = useRef(bot.threadId);
  threadRef.current = bot.threadId;
  // Push to talk drives the Mac helper directly; there is none elsewhere.
  const pushToTalk = usePushToTalk(bot.id, phase === "listening" && micRef.current?.kind === "apple", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = visibleMessages(bot);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** The last time anyone spoke on the call, for the "still on it" lines. */
  const lastSpeechAt = useRef(Date.now());
  const approval = pendingApprovals(messages)[0];
  /** Kinds of request the owner said yes to for the rest of this call. Held
   *  only here: never saved, gone when the call ends. Not the permanent
   *  "Always allow" the trust design rules out. */
  const callGrants = useRef(new Set<string>());
  const offeredForCall = useRef(false);
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  // Everything already on screen when the call starts has been read or
  // ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{
    requestId: string;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  /** Change the rendered phase and the synchronous phase used by native
   * callbacks together. React state alone is too late: the helper can exit
   * in the same tick as a final transcript or an intentional mute. */
  const move = useCallback((next: Phase) => {
    if (next === "speaking") {
      if (!firstSpokeAt.current) firstSpokeAt.current = Date.now();
      lastSpeechAt.current = Date.now();
    }
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    micLive.current = false;
    void micRef.current?.stop();
  }, []);

  /** Make sure a recognition turn is running, without changing phase. */
  const openTurn = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id || micLive.current) return;
    micLive.current = true;
    void micRef.current?.start({ endpointMs: CALL_ENDPOINT_MS, hints: [bot.name] }).catch(() => {
      micLive.current = false;
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, bot.name]);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    heardRef.current = "";
    setNote(null);
    openTurn();
  }, [bot.id, move, openTurn]);

  /** The owner talked over the bot: stop speaking and listen to them. */
  const bargeIn = useCallback(() => {
    if (maybeOwner.current?.timer) clearTimeout(maybeOwner.current.timer);
    maybeOwner.current = null;
    sayGeneration.current += 1;
    hostSpeaking.current = false;
    speaker.stop();
    move("listening");
  }, [move]);

  // Talking over the bot, the way LiveKit Agents does it (voice/
  // agent_activity.py, Apache-2.0): the first sign of the owner PAUSES the
  // bot; it stops for good only once it is clearly speech (two words, or a
  // finished sentence), and resumes after FALSE_INTERRUPTION_MS otherwise. A
  // cough or a keyboard used to end its sentence for good.
  const maybeOwner = useRef<{ timer: ReturnType<typeof setTimeout> | null; voice: boolean } | null>(null);
  const resumeBot = useCallback(() => {
    if (maybeOwner.current?.timer) clearTimeout(maybeOwner.current.timer);
    maybeOwner.current = null;
    speaker.resume();
  }, []);
  const settleMaybeOwner = useCallback(() => {
    const pending = maybeOwner.current;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    // still hearing them: wait for them to finish before deciding
    pending.timer = setTimeout(() => (maybeOwner.current?.voice ? settleMaybeOwner() : resumeBot()), FALSE_INTERRUPTION_MS);
  }, [resumeBot]);
  const holdForOwner = useCallback(() => {
    if (maybeOwner.current) {
      maybeOwner.current.voice = true;
      return;
    }
    if (!speaker.pause()) return;
    maybeOwner.current = { timer: null, voice: true };
    settleMaybeOwner();
  }, [settleMaybeOwner]);

  /** Speak. With an echo-cancelled microphone it stays open, so the owner can
   * talk over the bot; on the fallback it closes for the duration (an open,
   * uncancelled mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      if (!duplex()) hush();
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (!stillMine || phaseRef.current !== "speaking") return;
      // anything held while this was said is next, then the owner's turn
      const held = deferredReplies.current.shift();
      if (held) void tellNext.current(held);
      else listen();
    },
    [listen, say],
  );

  const sayThenListenRef = useRef(sayThenListen);
  sayThenListenRef.current = sayThenListen;

  /** Tell the engine's finished answer. A long one is told the way people
   *  do on the phone (each item in a sentence, then "details are in the chat")
   *  through the host; a short one, or any failure, is read out as written. */
  const tellReply = useCallback(
    async (text: string) => {
      if (!hostOn.current || text.length <= BRIEF_OVER_CHARS) return sayThenListen(text);
      if (!alive.current || currentCall() !== bot.id) return;
      const mine = ++sayGeneration.current;
      move("speaking");
      if (!duplex()) hush();
      let stream: ReturnType<typeof speaker.stream> | null = null;
      await hostTurn(
        bot.id,
        { text, threadId: bot.threadId, history: hostHistory.current, handDowns: handDowns.current, brief: true },
        (event) => {
          if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;
          if (event.type === "sentence") {
            if (!stream) {
              hostSpeaking.current = true;
              stream = speaker.stream({ botId: bot.id, voiceId: bot.voice });
              void stream.done.finally(() => {
                hostSpeaking.current = false;
              });
            }
            stream.push(event.text);
          }
        },
      );
      if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;
      if (!stream) return sayThenListen(openingOf(text));
      const told = stream as ReturnType<typeof speaker.stream>;
      told.end();
      const heardAll = await told.done;
      hostHistory.current = [
        ...hostHistory.current,
        { role: "host" as const, text: `${told.heard().join(" ")}${heardAll ? "" : " [the owner cut in here]"}`.trim() },
      ].slice(-12);
      // talked over or hung up: the owner has moved on
      if (!heardAll) return;
      if (sayGeneration.current !== mine || phaseRef.current !== "speaking") return;
      // another answer landed while this one was being told: tell it next
      const held = deferredReplies.current.shift();
      if (held) void tellNext.current(held);
      else listen();
    },
    [bot.id, bot.threadId, bot.voice, hush, listen, move, sayThenListen],
  );
  const tellNext = useRef(tellReply);
  tellNext.current = tellReply;

  /** Speak whatever was held back while the owner was talking, then listen. */
  const listenOrCatchUp = useCallback(() => {
    const held = deferredReplies.current.shift();
    if (held) void tellReply(held);
    else listen();
  }, [listen, tellReply]);

  /** Send work to the engine from the call, and hear back if it was refused.
   *  Without this a refused send (no model connected, a full queue) died
   *  quietly while the call went on saying it was on it. */
  const sendFromCall = useCallback(
    (text: string, said: string, handDownId?: string) => {
      const record = handDownId ? handDowns.current.find((h) => h.id === handDownId) : undefined;
      dispatch({
        type: "send",
        botId: bot.id,
        text,
        threadId: bot.threadId,
        onSent: () => {
          if (record && record.state === "sending") record.state = "accepted";
        },
        onError: (error: unknown) => {
          if (!alive.current || currentCall() !== bot.id) return false;
          const reason = plainFailure(error instanceof Error ? error.message : String(error));
          if (record) {
            record.state = "refused";
            record.reason = reason;
          }
          refusedSends.current.set(said, reason);
          for (const entry of callLog.current) {
            if (entry.said === said && (entry.outcome === "handed_down" || entry.outcome === "engine")) {
              entry.outcome = "not_started";
              entry.detail = reason;
            }
          }
          // the host learns it from the hand-down's status, in order; a line
          // pushed here landed before the turn it belonged to
          const line = `I couldn't start that. ${reason}`;
          // never over the bot's own sentence: said once the turn ends
          if (hostSpeaking.current || phaseRef.current === "sending") deferredReplies.current.push(line);
          else void sayThenListenRef.current(line);
          return true;
        },
      });
    },
    [bot.id, bot.threadId, dispatch],
  );
  /** A log entry for work sent from the call, unless the send was refused. */
  const sentEntry = (said: string, outcome: "handed_down" | "engine", detail?: string) => {
    const refused = refusedSends.current.get(said);
    return refused ? { said, outcome: "not_started" as const, detail: refused } : { said, outcome, detail };
  };

  /** One spoken turn through the voice host. Its sentences are voiced as
   * they stream; a hand-down becomes an ordinary send. Any failure hands
   * the owner's words to the engine exactly as a call did before. */
  const hostReply = useCallback(
    async (said: string, approvalOpen?: string) => {
      if (!alive.current || currentCall() !== bot.id) return;
      move("sending");
      if (!duplex()) hush();
      const controller = new AbortController();
      hostAbort.current?.abort();
      hostAbort.current = controller;
      const mine = ++sayGeneration.current;
      let stream: ReturnType<typeof speaker.stream> | null = null;
      const voice = () => {
        if (!stream) {
          move("speaking");
          hostSpeaking.current = true;
          stream = speaker.stream({ botId: bot.id, voiceId: bot.voice });
          void stream.done.finally(() => {
            hostSpeaking.current = false;
          });
        }
        return stream;
      };
      let spoken = "";
      let handed = false;
      let handedRequest = "";
      let handedId = "";
      let lookedUp = false;
      let failed = false;
      await hostTurn(
        bot.id,
        { text: said, threadId: bot.threadId, history: hostHistory.current, handDowns: handDowns.current, ...(approvalOpen ? { approval: approvalOpen } : {}) },
        (event) => {
          if (!alive.current || currentCall() !== bot.id) return;
          if (event.type === "lookup") {
            lookedUp = true;
            setLookingUp(true);
          } else if (event.type === "sentence") {
            setLookingUp(false);
            spoken += `${event.text} `;
            if (sayGeneration.current === mine) voice().push(event.text);
          } else if (event.type === "hand_down" && !handed) {
            handed = true;
            handedRequest = event.request;
            handedId = crypto.randomUUID();
            handDowns.current = [...handDowns.current, { id: handedId, request: event.request, at: Date.now(), state: "sending" as const }].slice(-12);
            sendFromCall(event.request, said, handedId);
          } else if (event.type === "cancel") {
            cancelledAt.current = Date.now();
            for (const h of handDowns.current) if (h.state === "sending" || h.state === "accepted") h.state = "cancelled";
            dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId });
          } else if (event.type === "error") {
            failed = true;
            if (HOST_OFF_FOR_CALL.has(event.reason)) hostOn.current = false;
          }
        },
        controller.signal,
      );
      if (hostAbort.current === controller) hostAbort.current = null;
      if (alive.current) setLookingUp(false);
      if (!alive.current || currentCall() !== bot.id) return;
      if (failed && !handed && !spoken) {
        // the host could not take this turn; the engine takes it, as before
        move("sending");
        callLog.current.push(sentEntry(said, "engine"));
        sendFromCall(said, said);
        return;
      }
      callLog.current.push(
        handed
          ? sentEntry(said, "handed_down", handedRequest)
          : lookedUp
            ? { said, outcome: "looked_up", detail: spoken.trim() }
            : { said, outcome: "answered", detail: spoken.trim() },
      );
      hostHistory.current.push({ role: "owner", text: said });
      // The host's line goes in as it was HEARD, not as it was written: cut
      // off after one sentence, the model must not believe it said the rest
      // (LiveKit keeps the played transcript with interrupted=True; Pipecat
      // adds text to the context only once it is spoken).
      const entry: HostTurnInput["history"][number] = { role: "host", text: "", ...(handedId ? { handDown: { id: handedId, request: handedRequest } } : {}) };
      hostHistory.current.push(entry);
      hostHistory.current = hostHistory.current.slice(-12);
      // a hand-down with nothing said would be dead air: a claim-free line
      if (handed && !spoken.trim() && sayGeneration.current === mine) voice().push("On it.");
      if (stream) {
        const told = stream as ReturnType<typeof speaker.stream>;
        told.end();
        const heardAll = await told.done;
        entry.text = `${told.heard().join(" ")}${heardAll ? "" : " [the owner cut in here]"}`.trim();
        if (!heardAll || sayGeneration.current !== mine || !alive.current || currentCall() !== bot.id) return;
      } else {
        entry.text = spoken.trim();
      }
      if (!entry.text && !entry.handDown) hostHistory.current = hostHistory.current.filter((e) => e !== entry);
      if (phaseRef.current === "speaking" || phaseRef.current === "sending") listenOrCatchUp();
    },
    [bot.id, bot.threadId, bot.voice, hush, listenOrCatchUp, move, sendFromCall],
  );

  // "Still on it": while the engine works and the call has gone quiet, say
  // the newest step now and then, and once, after a long while, check in.
  // Only with the host on (without it the engine's chips are narrated as
  // before). Any speech on the call resets the clock.
  const busyRef = useRef(bot.busy);
  busyRef.current = bot.busy;
  useEffect(() => {
    let said = 0;
    let lastSaidAt = 0;
    let lastStep = "";
    let busySince = 0;
    let checkedIn = false;
    const tick = setInterval(() => {
      if (!alive.current || currentCall() !== bot.id || !hostOn.current) return;
      if (!busyRef.current) {
        busySince = 0;
        said = 0;
        lastStep = "";
        checkedIn = false;
        return;
      }
      const now = Date.now();
      if (!busySince) busySince = now;
      const idle = phaseRef.current === "listening" && !heardRef.current && !hostSpeaking.current && !speaker.isSpeaking();
      if (!idle || now - lastSpeechAt.current < STILL_ON_IT_AFTER_MS) return;
      const steps = messagesRef.current.filter((m) => m.kind === "activity" && m.tool?.spoken).map((m) => m.tool!.spoken!);
      const step = steps.at(-1);
      if (!checkedIn && now - busySince > LONG_WORK_MS) {
        checkedIn = true;
        void sayThenListen(`This is taking a while${step ? `; right now I'm ${step}` : ""}. I'll keep going, or say stop and I'll leave it.`);
        return;
      }
      if (said >= STILL_ON_IT_MAX || now - lastSaidAt < STILL_ON_IT_EVERY_MS) return;
      // a new step is news; the same step again, or one not worth naming, is
      // one plain "still working" at most (heard live: the same raw tool id
      // read out over and over)
      const named = step && step !== "using a tool" && !/[A-Z]{3,}|_/.test(step) ? step : "";
      const line = named && named !== lastStep ? `Still on it: ${named}.` : lastStep === "(generic)" ? "" : "Still working on it.";
      if (!line) return;
      said += 1;
      lastSaidAt = now;
      lastStep = named && named !== lastStep ? named : "(generic)";
      void sayThenListen(line);
    }, 1_000);
    return () => clearInterval(tick);
  }, [bot.id, sayThenListen]);

  // Navigating away from this bot hangs up. Without ownership checking, the
  // overlay disappeared but `currentCall()` remained set and auto-speak was
  // permanently disabled for a call nobody could see.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      hostAbort.current?.abort();
      pulse.current?.dispose();
      pulse.current = null;
      micRef.current?.close();
      // Leave the call's record in the conversation. Only when the host took
      // part: an engine-only call is already fully in the transcript.
      const log = callLog.current;
      callLog.current = [];
      if (log.some((entry) => entry.outcome === "answered" || entry.outcome === "looked_up" || entry.outcome === "not_started")) {
        void fetch(`/api/bots/${bot.id}/call-note`, {
          method: "POST",
          headers: callRouteHeaders(),
          body: JSON.stringify({ threadId: threadRef.current, durationMs: Date.now() - callStartedAt.current, log }),
          // the overlay is closing; the request must outlive it
          keepalive: true,
        }).catch(() => undefined);
      }
      // StrictMode immediately remounts effects once in development. A
      // microtask distinguishes that probe from real navigation: the probe
      // has set alive=true again before this runs; a genuine unmount has not.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  // Wake the host's model as the call opens, so the first answer is warm.
  useEffect(() => {
    if (hostOn.current) warmHost(bot.id);
  }, [bot.id]);

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let offTranscript = () => {};
    let offEnd = () => {};
    let offVoice = () => {};
    const attach = (mic: CallMic) => {
    offTranscript = mic.onLine((line) => {
      // With an echo-cancelled mic, words heard while the bot is speaking are
      // the owner talking over it.
      const bargeable = mic.duplex && phaseRef.current === "speaking";
      if (!alive.current || currentCall() !== bot.id || (phaseRef.current !== "listening" && !bargeable)) return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      // Words with no speech behind them are the recognizer guessing at a
      // noise (a TradingView alert beep interrupted a live call). Silero
      // heard no speech: the line is dropped, whatever it says.
      const noSpeech = mic.speechWithin(bargeable ? 1_500 : 8_000) === false;
      if (noSpeech && line.text.trim()) {
        if (bargeable) resumeBot();
        if (line.partial === false && !bargeable) listenOrCatchUp();
        return;
      }
      if (bargeable) {
        // a word could be a cough the recognizer guessed at: hold the bot
        // and wait; two words, or a finished sentence, is the owner
        const words = line.text.trim().split(/\s+/).filter(Boolean);
        // "uh-huh", "yeah", "right": listening noises, not a turn (LiveKit's
        // backchannel handling). The bot carries on; a finished line of only
        // those is not a turn either.
        const answering = (askedApproval.current && !askedApproval.current.submitted) || askedQuestion.current;
        if (!answering && BACKCHANNEL.test(line.text.trim())) {
          if (line.partial === false) {
            resumeBot();
          } else {
            // could still become "yeah, but...": hold, and carry on if not
            holdForOwner();
            if (maybeOwner.current) maybeOwner.current.voice = false;
            settleMaybeOwner();
          }
          return;
        }
        if (line.partial !== false && words.length < 2) {
          if (words.length) {
            holdForOwner();
            if (maybeOwner.current) maybeOwner.current.voice = false;
            settleMaybeOwner();
          }
          return;
        }
        // a Flux transcript of a noise: not the owner after all
        if (mic.kind === "flux" && words.length < 2) {
          resumeBot();
          return;
        }
        bargeIn();
      }
      lastSpeechAt.current = Date.now();
      setHeard(line.text);
      heardRef.current = line.partial === false ? "" : line.text;
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listenOrCatchUp();

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          if (allow && open.skill) {
            setHeard("");
            void sayThenListen("Open this chat to review the complete skill before enabling it. You can say no now to deny it.");
            return;
          }
          // Keep this request claimed until the server's durable card patch
          // arrives. Clearing it here lets a render in that network gap read
          // and submit the same approval again.
          open.submitted = true;
          callLog.current.push({ said, outcome: "decision" });
          const pending = approvalRef.current;
          const forCall = allow && pending && YES_FOR_CALL.test(said) && !open.routine && !open.skill && !isHostConsentApproval(pending);
          if (forCall) {
            callGrants.current.add(grantKey(pending));
            void sayThenListen(`Okay. I'll ${spokenToolAction(pending.tool, pending.detail)} without asking until you hang up.`);
          }
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "routine decision" : "approval";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        // Not a decision: never guess consent from it. With the host on, a
        // question about the request ("what is it searching for?") gets an
        // answer from the host, which knows the card and ends by asking for
        // a yes or no; the card stays open either way.
        if (hostOn.current && approvalRef.current) {
          void hostReply(said, spokenApprovalPrompt(approvalRef.current, bot.name, true));
          return;
        }
        void sayThenListen("Sorry, is that a yes or a no?");
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, messageId: openQuestion.messageId, answer: said });
        move("working");
        return;
      }

      if (hostOn.current) {
        void hostReply(said);
        return;
      }
      move("sending");
      callLog.current.push(sentEntry(said, "engine"));
      sendFromCall(said, said);
    });
    offEnd = mic.onEnd(({ code, reason }) => {
      micLive.current = false;
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return;
      }
      // With the host on, the microphone can sit open through minutes of
      // engine work with nobody talking, and Apple's recognizer may give up
      // on a long silence. That is not a permission problem: reopen quietly,
      // no more than once every few seconds so a real fault still surfaces.
      if (
        code === 1 &&
        reason === "recognition-error" &&
        hostOn.current &&
        phaseRef.current === "listening" &&
        !heardRef.current &&
        Date.now() - quietRestartAt.current > 3_000
      ) {
        quietRestartAt.current = Date.now();
        listen();
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : reason === "helper-stop-pending"
              ? "The previous dictation session is still closing. Try again in a moment."
              : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") listen();
      // talking over the bot needs a turn running while it speaks
      else if (mic.duplex && phaseRef.current === "speaking") openTurn();
    });
    // Flux transcription has no partial words to barge in on; sustained
    // voice while the bot speaks is the owner talking over it.
    offVoice = mic.onVoice((speaking) => {
      if (!alive.current || mic.kind !== "flux" || !mic.duplex) return;
      if (!speaking) {
        if (maybeOwner.current) {
          maybeOwner.current.voice = false;
          settleMaybeOwner();
        }
        return;
      }
      if (phaseRef.current !== "speaking") return;
      // the echo canceller is still settling on the first things the bot
      // says: a spike then is the bot, not the owner (LiveKit's AEC warm-up)
      if (firstSpokeAt.current && Date.now() - firstSpokeAt.current < ECHO_WARMUP_MS) return;
      holdForOwner();
    });
    };
    const begin = () => {
      if (cancelled) return;
      attach(micRef.current!);
      if (bot.busy && !approval && !question && !hostOn.current) move("working");
      else listen();
    };
    // Capture first: if the microphone cannot be opened here, a Mac falls
    // back to the helper's own microphone (half duplex, as before 0.1.59).
    void micRef.current!.open().then(begin, () => {
      if (cancelled) return;
      if (micRef.current?.kind === "apple") {
        micRef.current.close();
        micRef.current = createFallbackMic();
        begin();
      } else {
        setNote("The microphone couldn't start. Check Microphone access for Murage.");
      }
    });
    return () => {
      cancelled = true;
      offTranscript();
      offEnd();
      offVoice();
      micLive.current = false;
      void micRef.current?.stop().catch(() => undefined);
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bargeIn, bot.id, bot.threadId, dispatch, holdForOwner, hush, hostReply, listen, move, openTurn, resumeBot, sayThenListen, sendFromCall, settleMaybeOwner]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // The request may be resolved from the normal approval UI or by another
    // client while this call is open. Do not keep treating future speech as
    // an answer to a card that no longer exists.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    // With the host on, the owner can keep talking while the engine works.
    if (!approval && !question && bot.busy && phaseRef.current === "listening" && !hostOn.current) {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (
      approval &&
      askedApproval.current?.requestId !== approval.requestId &&
      !isRoutineApproval(approval) &&
      !isSkillApproval(approval) &&
      !isHostConsentApproval(approval) &&
      callGrants.current.has(grantKey(approval))
    ) {
      // allowed for the rest of this call: answered without asking again
      askedApproval.current = { requestId: approval.requestId, routine: false, skill: false, submitted: true };
      spokenIds.current.add(approval.message.id);
      callLog.current.push({ said: `(${spokenToolAction(approval.tool, approval.detail)}, allowed for this call)`, outcome: "decision" });
      dispatch({ type: "decideRequest", threadId: bot.threadId, requestId: approval.requestId, behavior: "allow" });
      return;
    }
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const skillPrompt = approval.message.card?.skillRequest?.action === "update"
        ? `${bot.name} wants to update a learned skill. Open this chat to review the complete skill before replacing the current version. You can say no to deny it.`
        : `${bot.name} wants to enable a new learned skill. Open this chat to review the complete skill before enabling it. You can say no to deny it.`;
      const offerForCall = !offeredForCall.current && !isRoutineApproval(approval) && !isHostConsentApproval(approval);
      if (offerForCall) offeredForCall.current = true;
      const ask = spokenApprovalPrompt(approval, bot.name, true);
      void sayThenListen(
        isSkillApproval(approval)
          ? skillPrompt
          : offerForCall
            ? `${ask.replace(/ Yes or no\.$/, "")} Say yes, no, or yes for the rest of the call.`
            : ask,
      );
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    // a turn that failed ends in an error step, not a reply: say so, or the
    // call goes on as if the work were running
    const failure = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.ok === false && /^error:/i.test(m.tool.name ?? ""));
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    // written by work the owner cancelled on this call: in the chat, not said
    const lastSent = handDowns.current.at(-1)?.at ?? 0;
    if (reply && cancelledAt.current > lastSent && reply.at >= cancelledAt.current - 1_000) return;
    if (!reply?.text && failure?.tool) {
      const why = plainFailure(failure.tool.errorDetails || failure.tool.name);
      const line = `That didn't work. ${why}${/[.!?]$/.test(why) ? "" : "."}`;
      const sent = [...callLog.current].reverse().find((e) => e.outcome === "handed_down" || e.outcome === "engine");
      if (sent) {
        sent.outcome = "not_started";
        sent.detail = why;
      }
      hostHistory.current.push({ role: "host", text: line });
      const busyTalking =
        hostOn.current &&
        (hostSpeaking.current || phaseRef.current === "sending" || (phaseRef.current === "listening" && heardRef.current));
      if (busyTalking) deferredReplies.current.push(line);
      else void sayThenListen(line);
      return;
    }
    if (reply?.text) {
      // Never talk over the owner or over the host's own sentence: hold the
      // answer until that turn ends (listenOrCatchUp speaks it).
      const busyTalking =
        hostOn.current &&
        (hostSpeaking.current || phaseRef.current === "sending" || (phaseRef.current === "listening" && heardRef.current));
      if (busyTalking) deferredReplies.current.push(reply.text);
      else void tellReply(reply.text);
    } else if (chip?.tool?.spoken && phase === "working" && !hostOn.current) {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen, tellReply]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    if (bot.busy) {
      // An open approval deliberately keeps the mic live for yes/no. Every
      // other busy phase is half-duplex and must close capture, except with
      // the host on, where the owner talks to it while the engine works.
      if (
        !hostOn.current &&
        phaseRef.current !== "speaking" &&
        !askedApproval.current &&
        !askedQuestion.current
      ) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  // Escape hangs up; space interrupts whatever is being said
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  // The latest step of the running turn, as a phrase: the activity line.
  const activity = lookingUp
    ? "looking it up"
    : bot.busy
      ? [...messages].reverse().find((m) => m.kind === "activity" && m.tool?.spoken)?.tool?.spoken
      : undefined;
  // Pulse only for real work, and only while nobody is speaking.
  const pulsing =
    (lookingUp && speech.status !== "speaking") ||
    (Boolean(bot.busy) &&
      !approval &&
      !question &&
      !heard &&
      (hostOn.current ? phase === "listening" : phase === "working"));
  useEffect(() => {
    if (pulsing) (pulse.current ??= new WorkingPulse()).start();
    else pulse.current?.stop();
  }, [pulsing]);

  const status = muted
    ? "Muted"
    : phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <CallAvatar bot={bot} phase={phase} />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
        {activity && (lookingUp || phase === "working" || (hostOn.current && phase === "listening")) && (
          <div className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary/80">
            <Loader2 size={11} className="animate-spin" />
            {activity.charAt(0).toUpperCase() + activity.slice(1)}
          </div>
        )}
      </div>

      {/* one line, whichever is current: what you're saying, or what it is */}
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (
          heard || (
            <span className="text-ink-secondary">
              {pushToTalk ? "Release Control + Option to send…" : "Say something…"}
            </span>
          )
        ) : (
          speech.caption
        )}
      </div>

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGeneration.current += 1;
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        {micRef.current?.duplex && (
          <button
            onClick={() => {
              const next = !muted;
              micRef.current?.setMuted(next);
              setMuted(next);
            }}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            className={cn(
              "flex items-center gap-2 rounded-full border px-4 py-2.5 text-[13.5px] hover:bg-raised",
              muted ? "border-warning/60 text-warning" : "border-hairline/50 text-ink",
            )}
          >
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
            {muted ? "Unmute" : "Mute"}
          </button>
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-secondary/70">
        {micRef.current?.duplex
          ? "Talk over me to interrupt · Space interrupts · Esc hangs up"
          : "Hold Control + Option to talk · Space interrupts · Esc hangs up"}
      </div>
    </div>
  );
}
