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
import { Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { HOST_OFF_FOR_CALL, hostTurn, warmHost } from "@/lib/voice-host";
import { WorkingPulse } from "@/lib/working-pulse";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { CallAvatar } from "./CallAvatar";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

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
  const supported = capabilities.dictation.available && Boolean(window.muragebox?.speechStart);
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
        ? t("calls.macOnly")
        : !configured
          ? "Set up a voice in a bot's settings to make calls"
          : !voiceReady
            ? "Pick a voice in a bot's settings to make calls"
            : t("calls.call", { name: targetName });

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : !capabilities.dictation.available
      ? "Calls require Murage for macOS because speech recognition runs on-device."
      : !window.muragebox?.speechStart
        ? "The speech service is unavailable in this app build. Restart or update Murage."
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
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // The voice host answers first when the workspace has a Flux key. It is
  // switched off for the rest of the call by a failure that will not fix
  // itself mid-call (no key, a plan without it); a network blip only sends
  // that one turn down the engine path.
  const hostOn = useRef(Boolean(state.config?.flux?.configured));
  const hostHistory = useRef<Array<{ role: "owner" | "host"; text: string }>>([]);
  const hostAbort = useRef<AbortController | null>(null);
  const heardRef = useRef("");
  /** An engine reply that arrived while the owner was mid-sentence. */
  const deferredReply = useRef<string | null>(null);
  const pulse = useRef<WorkingPulse | null>(null);
  /** The host's sentences are being voiced; an engine reply waits for them. */
  const hostSpeaking = useRef(false);
  const quietRestartAt = useRef(0);
  /** The host is looking something up on the web right now. */
  const [lookingUp, setLookingUp] = useState(false);
  /** What happened to each thing the owner said: the call note's source. */
  const callLog = useRef<Array<{ said: string; outcome: "answered" | "looked_up" | "handed_down" | "engine" | "decision"; detail?: string }>>([]);
  const callStartedAt = useRef(Date.now());
  const threadRef = useRef(bot.threadId);
  threadRef.current = bot.threadId;
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
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
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.muragebox?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    heardRef.current = "";
    setNote(null);
    void window.muragebox?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, move]);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      hush();
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  /** Speak whatever was held back while the owner was talking, then listen. */
  const listenOrCatchUp = useCallback(() => {
    const held = deferredReply.current;
    deferredReply.current = null;
    if (held) void sayThenListen(held);
    else listen();
  }, [listen, sayThenListen]);

  /** One spoken turn through the voice host. Its sentences are voiced as
   * they stream; a hand-down becomes an ordinary send. Any failure hands
   * the owner's words to the engine exactly as a call did before. */
  const hostReply = useCallback(
    async (said: string) => {
      if (!alive.current || currentCall() !== bot.id) return;
      move("sending");
      hush();
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
      let lookedUp = false;
      let failed = false;
      await hostTurn(
        bot.id,
        { text: said, threadId: bot.threadId, history: hostHistory.current },
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
            dispatch({ type: "send", botId: bot.id, text: event.request, threadId: bot.threadId });
          } else if (event.type === "cancel") {
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
        callLog.current.push({ said, outcome: "engine" });
        dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
        return;
      }
      callLog.current.push(
        handed
          ? { said, outcome: "handed_down", detail: handedRequest }
          : lookedUp
            ? { said, outcome: "looked_up", detail: spoken.trim() }
            : { said, outcome: "answered", detail: spoken.trim() },
      );
      hostHistory.current.push({ role: "owner", text: said });
      if (spoken.trim()) hostHistory.current.push({ role: "host", text: spoken.trim() });
      hostHistory.current = hostHistory.current.slice(-12);
      // a hand-down with nothing said would be dead air: a claim-free line
      if (handed && !spoken.trim() && sayGeneration.current === mine) voice().push("On it.");
      if (stream) {
        (stream as ReturnType<typeof speaker.stream>).end();
        const heard = await (stream as ReturnType<typeof speaker.stream>).done;
        if (!heard || sayGeneration.current !== mine || !alive.current || currentCall() !== bot.id) return;
      }
      if (phaseRef.current === "speaking" || phaseRef.current === "sending") listenOrCatchUp();
    },
    [bot.id, bot.threadId, bot.voice, dispatch, hush, listenOrCatchUp, move],
  );

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
      // Leave the call's record in the conversation. Only when the host took
      // part: an engine-only call is already fully in the transcript.
      const log = callLog.current;
      callLog.current = [];
      if (log.some((entry) => entry.outcome === "answered" || entry.outcome === "looked_up")) {
        void fetch(`/api/bots/${bot.id}/call-note`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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
    const bridge = window.muragebox;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
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
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
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
      callLog.current.push({ said, outcome: "engine" });
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
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
    });
    if (bot.busy && !approval && !question && !hostOn.current) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.muragebox?.speechStop();
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, hostReply, listen, move, sayThenListen]);

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
      void sayThenListen(isSkillApproval(approval) ? skillPrompt : spokenApprovalPrompt(approval, bot.name));
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
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      // Never talk over the owner or over the host's own sentence: hold the
      // answer until that turn ends (listenOrCatchUp speaks it).
      const busyTalking =
        hostOn.current &&
        (hostSpeaking.current || phaseRef.current === "sending" || (phaseRef.current === "listening" && heardRef.current));
      if (busyTalking) deferredReply.current = reply.text;
      else void sayThenListen(reply.text);
    } else if (chip?.tool?.spoken && phase === "working" && !hostOn.current) {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

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

  const status =
    phase === "listening"
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
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-secondary/70">
        Hold Control + Option to talk · Space interrupts · Esc hangs up
      </div>
    </div>
  );
}
