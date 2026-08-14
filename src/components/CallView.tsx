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
// Turn-taking costs nothing: `result.isFinal` from the on-device recognizer
// IS endpointing, already streaming to the renderer, so there is no VAD
// model to bundle, no worklet asset to serve and nothing to break offline.
//
// The other half of making a call bearable is narration. An agent turn is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { MausAvatar } from "./Avatar";
import { pendingApprovals } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

type Phase = "listening" | "sending" | "working" | "speaking";

export function CallButton({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const active = useOnCall() === bot.id;
  // dictation is the microphone half; without it there is no call to make
  const dictation = window.ogb?.speechStart !== undefined;
  if (!dictation) return null;
  const ready = Boolean(state.config?.tts?.ready);
  const label = active
    ? `Hang up on ${bot.name}`
    : ready
      ? `Call ${bot.name}`
      : "Add an ElevenLabs key in App Settings to make calls";
  return (
    <button
      onClick={() => {
        if (active) return endCall();
        track("call_started", { driver: bot.modelSelection?.instanceId });
        startCall(bot.id);
      }}
      disabled={!ready && !active}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-9 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        active ? "bg-danger text-white hover:brightness-110" : "text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {active ? <PhoneOff size={17} /> : <Phone size={17} />}
    </button>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}

function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const [phase, setPhase] = useState<Phase>("listening");
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];

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
  const askedApproval = useRef<string | null>(null);
  const phaseRef = useRef<Phase>("listening");
  phaseRef.current = phase;

  const hush = useCallback(() => {
    void window.ogb?.speechStop();
  }, []);

  const listen = useCallback(() => {
    setPhase("listening");
    setHeard("");
    void window.ogb?.speechStart();
  }, []);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string) => {
      hush();
      setPhase("speaking");
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
    },
    [bot.id, bot.voice, hush],
  );

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listen();

      const open = askedApproval.current;
      if (open) {
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          askedApproval.current = null;
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
          });
          setPhase("working");
          return;
        }
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
        void say("Sorry — is that a yes or a no?").then(listen);
        return;
      }

      setPhase("sending");
      dispatch({ type: "send", botId: bot.id, text: said });
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return endCall();
      }
      if (code === 1) {
        setNote("Dictation needs Microphone + Speech Recognition access in System Settings.");
        return;
      }
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") void window.ogb?.speechStart();
    });
    listen();
    return () => {
      offTranscript();
      offEnd();
      void window.ogb?.speechStop();
    };
  }, [bot.id, bot.threadId, dispatch, listen, say]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    if (approval && askedApproval.current !== approval.requestId && phase !== "speaking") {
      askedApproval.current = approval.requestId;
      spokenIds.current.add(approval.message.id);
      void say(`${bot.name} wants to ${approval.tool}. ${approval.detail}. Should I allow it?`).then(listen);
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
      void say(reply.text).then(listen);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then(() => setPhase("working"));
    }
  }, [messages, approval, phase, bot.name, say, listen]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    if (bot.busy) setPhase((p) => (p === "speaking" ? p : "working"));
  }, [bot.busy]);

  // Escape hangs up; space interrupts whatever is being said
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall();
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listen]);

  const mascotState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const status =
    phase === "listening"
      ? "Listening"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <button
        onClick={endCall}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <MausAvatar color={bot.color} state={mascotState} size={220} animated trackPointer />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      {/* one line, whichever is current: what you're saying, or what it is */}
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (
          heard || <span className="text-ink-secondary">Say something…</span>
        ) : (
          speech.caption
        )}
      </div>

      {note && <div className="max-w-[420px] text-center text-[12.5px] text-warning">{note}</div>}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={endCall}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-secondary/70">Space interrupts · Esc hangs up</div>
    </div>
  );
}
