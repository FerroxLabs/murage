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
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot, type OptionCardData } from "@/state/store";
import { currentCall, deferCallCleanup, endCall } from "@/lib/call";
import { publishCallBarState, type CallBarStatus } from "@/lib/call-bar";
import { CallBarContent } from "./CallBarContent";
import { useCallSlot } from "@/lib/call-slot";
import { callStartHeard, heardReplyAfter, unheardMessages } from "@/lib/scrollback";
import { speaker } from "@/lib/tts";
import { CueCache } from "@/lib/tts/cue-cache";
import { ACK_KEYS, AckGate, cueMayPlay, phaseAfterCue, pickAck, type AckKey } from "@/lib/call-ack";
import { localeCode, t } from "@/lib/i18n";
import { BRIEF_OVER_CHARS, callRouteHeaders, HOST_OFF_FOR_CALL, hostTurn, openingOf, plainFailure, warmHost, type CallHandDown, type HostTurnInput } from "@/lib/voice-host";
import { WorkingPulse } from "@/lib/working-pulse";
import { callMicKind, createFallbackMic, type CallMic, type MicLine } from "@/lib/call-mic";
import { CallAudio, micFor, offerResumeWhenHeld, type CallAudioPath } from "@/lib/call-audio";
import type { CallAudioEvent } from "@/lib/native-shell";
import type { NativeClipPlayer } from "@/lib/tts/native-player";
import { approvalAnswer } from "@/lib/call-answers";
import { answerCallQuestion, CALL_ENDPOINT_LONG_MS, CALL_ENDPOINT_MS, HeldLine, LONG_ENDPOINT_HOLD_MS, holdsOn, joinsTurn, micEndStep, turnTiming, VAD_ENDPOINT_LONG_MS, VAD_ENDPOINT_MS, MIN_SPEECH_SHARE, talkOverVerdict, UtteranceWords } from "@/lib/call-turns";
import { callTrace, wordCount } from "@/lib/call-trace";
import { freshAuthSpoken, type FreshAuthCode } from "@/lib/fresh-auth";
import { coveredForCall, FOR_CALL_OFFER, FOR_CALL_SPOKEN } from "@/lib/call-grant";
import { useSpeech } from "@/lib/tts/useSpeech";
import { AckCues, indexedDbStore } from "@/lib/tts/ack-cue";
import { Inhale } from "@/lib/tts/inhale";
import { usePushToTalk } from "@/lib/push-to-talk";
import { CallAvatar } from "./CallAvatar";
import { stillSignals, useAvatarAura } from "./CallAura";
import { CallMood } from "./CallMood";
import { botVoice } from "@/lib/audio-level";
import { callStatusText } from "@/lib/call-status";
import { auraPhaseFor } from "@/lib/call-aura";
import { useKeyboardHints } from "@/lib/use-keyboard-hints";
import { CallCaption } from "./CallCaption";
import { isHostConsentApproval, isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt, spokenToolAction } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */
/** Unmistakable as heard, even mid-utterance: "stop", "shut up", "be quiet". */
/** Pre-synthesized acknowledgement clips, kept across calls (see call-ack.ts). */
const cueCache = new CueCache((text, o) => speaker.fetchClip(text, o));

const STOP_NOW = /^(?:(?:ok(?:ay)?|please|hey|no|just)[,.!\s]*)*(?:(?:stop(?: talking)?|shut up|be quiet|quiet|enough|that'?s enough)[,.!\s]*)+$/i;
/** Only asking for quiet: "stop", "stop, stop, stop", "shut up", "enough". */
const STOP_ONLY = /^(?:(?:ok(?:ay)?|please|hey|no|just|all right|alright)[,.!\s]*)*(?:(?:stop(?: talking| it| that)?|shut up|be quiet|quiet|hush|enough|that'?s enough|pause|hold on|wait)[,.!\s]*)+$/i;
/** Listening noises while the bot talks: "uh-huh", "yeah", "mm", "right". */
const BACKCHANNEL = /^(u+h+[- ]?h+u+h+|m+h?m+|mm+[- ]?h+m+|yeah|yep|yes|right|okay|ok|sure|got it|i see|oh|ah|wow|nice|cool|uh|um)[.!?]*$/i;

/** One acknowledgement cue per voice, kept between calls. */
const ackCues = new AckCues(undefined, typeof indexedDB === "undefined" ? null : indexedDbStore());

type Phase = "listening" | "sending" | "working" | "speaking";
/** How long the bot stays paused for what may be the owner before carrying
 *  on (LiveKit's false_interruption_timeout default). */
const FALSE_INTERRUPTION_MS = 2_000;
/** Flux's line lands 1.5-3 s after the owner stops, after the timer above:
 *  while it is still coming the bot stays paused for it, but no longer than
 *  this after their voice ended (a transcription that never answers). */
const TRANSCRIPT_WAIT_MS = 6_000;
/** However long the owner (or a noise that never ends) goes on, the bot
 *  paused for them carries on after this. */
const TALK_OVER_MAX_HOLD_MS = 15_000;
/** How often a pause held for Flux's line checks whether it came. */
const TRANSCRIPT_CHECK_MS = 100;
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
/** The iPhone refused the microphone (spec §4.3.2). */
const DENIED_NOTE = "Allow the microphone for Murage in Settings, then try again";
/** How long "Connecting…" waits for real audio (native open resolved and mic
 *  frames flowing, or the web mic ready) before offering a retry instead of
 *  sitting on "Listening" with nothing actually open (moss-approval-bug.md). */
const CONNECT_TIMEOUT_MS = 8_000;
// Neutral on purpose: on a Mac or in a browser this is often a microphone
// permission prompt still sitting unanswered, not a network problem, so
// "Check your connection" was the wrong advice there (callbar-review.md I2).
const CONNECT_TIMEOUT_NOTE = "Still connecting.";

export function Call({
  bot,
  collapsed = false,
  onExpand,
}: {
  bot: Bot;
  /** The call is running but a different thread or screen is on top. The
   *  mic, the turn loop and the native session keep going unchanged; only
   *  the rendered screen shrinks to a bar (App.tsx mounts this once per
   *  call, not once per selected chat, so switching threads can never
   *  unmount it — see the moss-approval-bug writeup). */
  collapsed?: boolean;
  /** Tap the bar: bring the full call screen back. */
  onExpand?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // One microphone for the whole call (src/lib/call-mic.ts): Apple's
  // recognizer on a Mac, Flux transcription elsewhere, both fed from an
  // echo-cancelled capture so the owner can talk over the bot.
  const micRef = useRef<CallMic | null>(null);
  // Where the call's audio goes (src/lib/call-audio.ts): this microphone and
  // the page's own speaker, or, on an iPhone build that lists it, the shell's
  // voice-processing engine. Chosen when the call opens, never here.
  const audioRef = useRef<CallAudio | null>(null);
  // A fresh CallAudio, never a reused one: its `mic`/`source` fields are its
  // own, so a stale attempt's late resolution can only ever close what THAT
  // attempt opened, never a newer attempt's live session or stream
  // (callbar-rereview.md N1 — closing and reopening the SAME CallAudio let a
  // stale open's cleanup close the retry's session on the native path, and
  // orphan a getUserMedia stream on the web path, since `mic`/`source` are
  // shared instance state).
  const buildAudio = () => {
    const kindFor = (capture: boolean) => {
      const kind = callMicKind({
        appleSpeech: capabilities.dictation.available && Boolean(window.muragebox?.speechStart),
        fluxConfigured: Boolean(state.config?.tts?.routes?.transcribe),
        capture,
      });
      return kind === "flux" && state.config?.tts?.streamTranscribe ? ("stream" as const) : kind;
    };
    const kind = kindFor(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
    return new CallAudio({ kindFor, web: kind ? micFor(kind) : createFallbackMic() });
  };
  if (!audioRef.current) {
    audioRef.current = buildAudio();
    micRef.current = audioRef.current.mic;
  }
  /** A recognition turn is running in the recognizer. */
  const micLive = useRef(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  /** The question whose spoken answer is on its way to the server. */
  const answering = useRef<string | null>(null);
  /** Questions whose spoken answer was refused for good: left to the screen,
   *  and never the one the call waits on, so a later question is still asked. */
  const leftToScreen = useRef<Set<string>>(new Set());
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
  const hostOffForCall = useRef(false);
  const hostOn = useRef(false);
  // read per render: a call opened before the config loads gets the host once it does
  hostOn.current = Boolean(state.config?.tts?.routes?.host) && !hostOffForCall.current;
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
  /** The last non-empty words shown this turn. An empty partial or final
   *  (the recognizer resetting after a pause) never discards them. */
  const lastWordsRef = useRef(new UtteranceWords());
  /** An engine reply that arrived while the owner was mid-sentence. */
  /** Answers that landed while the owner or the bot was talking, oldest
   *  first. A queue, not a slot: a second answer used to overwrite the first
   *  and the owner never heard it (Pipecat and LiveKit both queue results
   *  owed to the user until the conversation is idle). */
  const deferredReplies = useRef<string[]>([]);
  /** Call speech waits until begin() has chosen where it is heard, so nothing
   *  said as the call opens goes to the wrong player (spec §4.3.5). */
  const outputReady = useRef(false);
  /** True until the call's audio really opens: native open resolved and mic
   *  frames flowing, or the web mic ready. Drives the "Connecting…" status
   *  so an open that never answers doesn't read as "Listening" forever. */
  const [connecting, setConnecting] = useState(true);
  /** The iPhone's engine is holding the call: a phone call, Siri, an alarm,
   *  the app in the background, a route change. A ref for the callbacks and
   *  a flag for the render; not a Phase, so the avatar and caption keep
   *  their inputs. */
  const heldRef = useRef(false);
  const [held, setHeld] = useState(false);
  /** The engine could not come back from a hold: only "Resume call" reopens. */
  const lostRef = useRef(false);
  const [lost, setLost] = useState(false);
  /** A hold that has lasted a while on screen: "Resume call" is offered
   *  too, since nothing on the phone is sure to end it. */
  const [heldLong, setHeldLong] = useState(false);
  const resuming = useRef(false);
  /** Counts resumes, so the pulse is re-sent after one even when the hold
   *  and the resume landed in the same render and `pulsing` never changed. */
  const [resumes, setResumes] = useState(0);
  /** Approval and question prompts owed to the owner: asked FIRST once the
   *  call may speak again, through sayThenListen, exactly once. Never put
   *  with the replies, whose long ones the host tells as a brief. */
  const owed = useRef<Array<{ requestId: string; text: string }>>([]);
  /** The words each approval or question was asked with, by request. */
  const prompts = useRef(new Map<string, string>());
  /** The native call player for the open session, while there is one. */
  const nativePlayer = useRef<NativeClipPlayer | null>(null);
  /** null until the call has chosen its path. */
  const [audioPath, setAudioPath] = useState<CallAudioPath | null>(null);
  // The live voices the visuals read (CallAura.tsx, CallMood.tsx): the
  // bot's clip loudness and the owner's microphone or dictation activity.
  // Getters read per frame, never state, so nothing here re-renders.
  const [signals] = useState(() => stillSignals());
  // The bot's clips are tapped on the web path only: on the native path the
  // page plays nothing (spec §4.3.3), and an AudioContext of its own there
  // could unsettle the shell's engine.
  useEffect(() => {
    if (audioPath !== "web") return;
    return botVoice.attach();
  }, [audioPath]);
  const readAlongProgress = useCallback((chars: number) => botVoice.progress(chars), []);
  /** What the note's button does: listen again, re-run the open (a refused
   *  iPhone microphone), or nothing ("Resume call" is its own button). */
  const [noteRetry, setNoteRetry] = useState<"listen" | "open" | "none">("listen");
  const retryOpen = useRef<() => void>(() => {});
  /** Which open attempt is current. A retry bumps it, so a stale attempt's
   *  begin or error handler (the first open's, still resolving after the
   *  retry closed it) can tell it is no longer the one in flight. */
  const openAttempt = useRef(0);
  // A line held for the rest of the owner's sentence counts too: the owner is
  // mid-thought, and anything said now would be cut by the send that follows.
  const gated = () => !outputReady.current || heldRef.current || Boolean(heldLine.current?.holding);
  const pulse = useRef<WorkingPulse | null>(null);
  /** The host's sentences are being voiced; an engine reply waits for them. */
  const hostSpeaking = useRef(false);
  const engineCue = useRef<object | null>(null);
  const quietRestartAt = useRef(0);
  /** The host is looking something up on the web right now. */
  const [lookingUp, setLookingUp] = useState(false);
  /** What happened to each thing the owner said: the call note's source. */
  const callLog = useRef<Array<{ said: string; outcome: "answered" | "looked_up" | "handed_down" | "engine" | "decision" | "not_started"; detail?: string }>>([]);
  /** Sends the server refused, by what the owner said: the log records them
   *  as not started even when the refusal beats the log entry. */
  const refusedSends = useRef(new Map<string, string>());
  const callStartedAt = useRef(Date.now());
  // Fixed for the call's lifetime, never the live `bot.threadId`: a push for
  // another of this bot's tasks moves `bot.threadId` on the store while the
  // call is still about its own thread (callbar-review.md M8). Read by the
  // call-note payload and by the drift check below that collapses the
  // screen instead of tearing the call's own listeners down over it.
  const threadRef = useRef(bot.threadId);
  // The voice and the name are read through refs, as the thread is: say,
  // tellReply, hostReply and openTurn are dependencies of the microphone
  // effect, so listing bot.voice or bot.name there would tear the mic down
  // and reopen it when the owner edits either mid-call (A8).
  const voiceRef = useRef(bot.voice);
  voiceRef.current = bot.voice;
  const nameRef = useRef(bot.name);
  nameRef.current = bot.name;

  // Feels instant: the moment the owner's turn is sent, a short cached "Mm."
  // in the bot's voice says they were heard (no network on this path), and if
  // no audio has started 300 ms later the avatar takes a subtle inhale. A fast
  // reply never shows it. The cue is made once per voice when the call opens.
  const [inhale, setInhale] = useState(false);
  const inhaleRef = useRef<Inhale | null>(null);
  inhaleRef.current ??= new Inhale(setInhale);
  const lastPhase = useRef<Phase>(initialPhase);
  // the instant cue played for this turn: the later spoken cue stays quiet
  const instantCued = useRef(false);
  useEffect(() => {
    void ackCues.prime(bot.id, voiceRef.current);
    const timer = inhaleRef.current;
    return () => timer?.cancel();
  }, [bot.id]);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (phase === "sending" && was === "listening") {
      const cued = ackCues.play(bot.id, voiceRef.current, speaker);
      instantCued.current = cued;
      if (cued) console.warn("[voice-diag] ack cue played from cache");
      inhaleRef.current?.start();
    } else if (phase === "listening") {
      instantCued.current = false;
      inhaleRef.current?.cancel();
    }
  }, [phase, bot.id]);
  useEffect(() => {
    if (speech.status === "speaking") inhaleRef.current?.cancel();
  }, [speech.status]);
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
  /** "Yes for the rest of the call": everyday lookups until hang-up
   *  (src/lib/call-grant.ts lists them). Anything else, including messages,
   *  payments, deletes, commands, file changes, routines, skills and the
   *  computer, always shows its own card and gets its own yes. */
  const allowedForCall = useRef(false);
  /** When the owner last cut the bot off. */
  const interruptedAt = useRef(0);
  /** When the owner last really cut a reply off: a barge-in or "stop". A
   *  clip that failed or stalled is not the owner, and the host must not be
   *  told they interrupted (the "[the owner cut in here]" note). */
  const ownerCutInAt = useRef(0);
  /** When the owner's speech now being heard began (their voice, or the
   *  first partial line), 0 when none is; cleared by each final line. */
  const utteranceBegan = useRef(0);
  /** The host turn now in flight, until hostReply is done with it: a second
   *  half of the same sentence can still join it (call-turns.ts). */
  /** A turn the engine took (host off, or the host failed): its timing line is
   *  written when the engine's reply first sounds, path=engine. */
  const engineTurn = useRef<{ endedAt?: number; lineAt: number; sentAt: number } | null>(null);
  /** Takes the pending engine turn; returns the callback that logs it once
   *  the reply's sound starts, or undefined when none is pending. */
  const takeEngineTurn = () => {
    const turn = engineTurn.current;
    engineTurn.current = null;
    if (!turn) return undefined;
    return (playingAt: number | null) => console.warn(turnTiming({ ...turn, firstSentenceAt: null, playingAt, path: "engine" }));
  };
  /** The acknowledgement gate of the host turn in flight, so a barge-in, a
   *  hold, a hang-up or a join can cancel it. */
  const ackGate = useRef<AckGate | null>(null);
  /** The cue used last, so two turns in a row never open the same way. */
  const lastAck = useRef<AckKey | null>(null);
  /** The two cue phrases warmed for this call (all four until then). */
  const ackPool = useRef<readonly AckKey[]>(ACK_KEYS);
  /** A turn joined into the next one had already cued: the joined turn does not. */
  const carriedAck = useRef(false);
  const turnInFlight = useRef<{
    said: string;
    sentAt: number;
    controller: AbortController;
    playingAt: () => number | null;
    /** It handed work down or cancelled some: done, never asked again. */
    acted: boolean;
    superseded: boolean;
    /** What it wrote to the history and the call log, taken back on a join. */
    history: HostTurnInput["history"];
    log: Array<(typeof callLog.current)[number]>;
  } | null>(null);
  /** A final line that sounds unfinished, waiting for the rest. */
  const heldLine = useRef<HeldLine | null>(null);
  const sendTurnRef = useRef<(said: string, timing?: { endedAt?: number; lineAt: number }) => void>(() => {});
  /** Says what waited on a held line when nothing else will: the engine
   *  path (with the host, hostReply's end asks and tells it). */
  const drainAfterHeldRef = useRef<() => void>(() => {});
  /** When the newest final line's utterance ended and when it landed. */
  const lineTiming = useRef<{ endedAt?: number; lineAt: number } | undefined>(undefined);
  if (!heldLine.current) {
    heldLine.current = new HeldLine(
      (text) => {
        sendTurnRef.current(text, lineTiming.current);
        if (!hostOn.current) drainAfterHeldRef.current();
      },
      // more is coming: Flux is recording or transcribing it, or the owner's
      // voice (or a partial line) began after the pause
      (since) => Boolean(micRef.current?.pending()) || utteranceBegan.current >= since,
      undefined,
      callTrace,
    );
  }
  /** A partial of the utterance now being heard over the bot was turned away
   *  on its speech share (TV, echo): its final cannot overturn that. */
  const utteranceRejected = useRef(false);
  const offeredForCall = useRef(false);
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed &&
      !leftToScreen.current.has(message.card.requestId),
  );

  // Everything already on screen or held when the call starts has been read
  // or ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    spokenIds.current = callStartHeard(messages, bot.messages);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{
    requestId: string;
    /** The card as read aloud: the proof is checked against exactly this. */
    card?: OptionCardData;
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
    if (phaseRef.current !== next) callTrace(`phase ${phaseRef.current}>${next}`);
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
    // nothing to hear before the microphone is open, or while the call is held
    if (!outputReady.current || heldRef.current) return;
    micLive.current = true;
    lastWordsRef.current.clear();
    utteranceRejected.current = false;
    console.warn(`[call-diag] session start phase=${phaseRef.current}`);
    // Apple's recognizer judges the unfinished-word window itself; the
    // voice detector (Flux) has no partial text, so it runs its base flat
    const apple = micRef.current?.kind === "apple";
    void micRef.current?.start({ endpointMs: apple ? CALL_ENDPOINT_MS : VAD_ENDPOINT_MS, endpointLongMs: apple ? CALL_ENDPOINT_LONG_MS : VAD_ENDPOINT_LONG_MS, hints: [nameRef.current] }).catch(() => {
      micLive.current = false;
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id]);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    // held: resume picks the call up again (resumeFromHold)
    if (heldRef.current) return;
    move("listening");
    setHeard("");
    heardRef.current = "";
    lastWordsRef.current.clear();
    setNote(null);
    openTurn();
  }, [bot.id, move, openTurn]);

  // Whenever the bot starts to speak on an echo-cancelled microphone, the
  // owner must be heard. The recognizer's session ends after each sentence;
  // when it ended while the call waited for an answer, nothing reopened it
  // and "stop" went unheard for the whole reply (a live call, 2026-09-23).
  useEffect(() => {
    if ((phase === "speaking" || phase === "sending") && micRef.current?.duplex && !micLive.current) openTurn();
  }, [phase, openTurn]);

  /** Forget a pause held for what may be the owner, and its timer. Anything
   *  that stops or takes over the bot's speech does this, or the stale pause
   *  outlives it and the next reply cannot be talked over. */
  const dropMaybeOwner = () => {
    if (maybeOwner.current?.timer) clearTimeout(maybeOwner.current.timer);
    maybeOwner.current = null;
  };

  /** The owner talked over the bot: stop speaking and listen to them. */
  const bargeIn = useCallback(() => {
    interruptedAt.current = Date.now();
    ownerCutInAt.current = Date.now();
    dropMaybeOwner();
    ackGate.current?.cancel();
    carriedAck.current = false;
    sayGeneration.current += 1;
    hostSpeaking.current = false;
    // quiet at once: playback torn down, queued and in-flight clips aborted
    speaker.cut();
    move("listening");
  }, [move]);

  // Talking over the bot, the way LiveKit Agents does it (voice/
  // agent_activity.py, Apache-2.0): the first sign of the owner PAUSES the
  // bot; it stops for good only once it is clearly speech (two words, or a
  // finished sentence), and resumes after FALSE_INTERRUPTION_MS otherwise. A
  // cough or a keyboard used to end its sentence for good.
  // On Flux the line decides, not the timer: the bot waits for it while it
  // is being transcribed (mic.pending()), up to TRANSCRIPT_WAIT_MS after the
  // owner's voice ended, and never past TALK_OVER_MAX_HOLD_MS from the pause.
  const maybeOwner = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    voice: boolean;
    pausedAt: number;
    voiceEndedAt?: number;
    waited?: boolean;
  } | null>(null);
  const resumeBot = useCallback(() => {
    dropMaybeOwner();
    speaker.resume();
  }, []);
  const settleMaybeOwner = useCallback(() => {
    const pending = maybeOwner.current;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    const decide = () => {
      const held = maybeOwner.current;
      if (!held) return;
      const now = Date.now();
      const ceiling = held.pausedAt + TALK_OVER_MAX_HOLD_MS;
      // still hearing them: wait for them to finish before deciding
      if (held.voice && now < ceiling) return settleMaybeOwner();
      // what they said is still being transcribed: its line decides (stop,
      // their turn, or carry on), unless it takes too long
      const left = Math.min(ceiling, (held.voiceEndedAt ?? held.pausedAt) + TRANSCRIPT_WAIT_MS) - now;
      if (!held.voice && micRef.current?.pending() && left > 0) {
        if (!held.waited) console.warn("[call-diag] talk-over: holding for the transcript");
        held.waited = true;
        held.timer = setTimeout(decide, Math.min(TRANSCRIPT_CHECK_MS, left));
        return;
      }
      if (held.voice) console.warn("[call-diag] talk-over: hold ceiling reached, carrying on");
      else if (held.waited) console.warn(`[call-diag] talk-over: ${left > 0 ? "transcription done" : "transcript wait capped"}, carrying on`);
      resumeBot();
    };
    pending.timer = setTimeout(decide, FALSE_INTERRUPTION_MS);
  }, [resumeBot]);
  const holdForOwner = useCallback(() => {
    if (maybeOwner.current) {
      maybeOwner.current.voice = true;
      return;
    }
    if (!speaker.pause()) return;
    maybeOwner.current = { timer: null, voice: true, pausedAt: Date.now() };
    settleMaybeOwner();
  }, [settleMaybeOwner]);

  /** The next owed prompt whose card is still open, or null. */
  const takeOwed = useCallback((): string | null => {
    for (;;) {
      const next = owed.current.shift();
      if (!next) return null;
      const open = askedApproval.current;
      if (open?.requestId === next.requestId && !open.submitted) return next.text;
      if (askedQuestion.current?.requestId === next.requestId) return next.text;
    }
  }, []);

  /** Speak. With an echo-cancelled microphone it stays open, so the owner can
   * talk over the bot; on the fallback it closes for the duration (an open,
   * uncancelled mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string, onPlaying?: () => void) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      if (gated()) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      if (!duplex()) hush();
      await speaker.speak(text, { botId: bot.id, voiceId: voiceRef.current, ...(onPlaying ? { onPlaying } : {}) });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string, onCut?: () => void, onPlaying?: () => void) => {
      // not yet, or held: said when the call may speak again, before the
      // rest (listenOrCatchUp already took it off the front)
      if (gated()) {
        deferredReplies.current.unshift(text);
        return;
      }
      const stillMine = await say(text, onPlaying);
      if (!stillMine) onCut?.();
      if (!stillMine || phaseRef.current !== "speaking") return;
      // anything owed or held while this was said is next, then the owner's turn
      const prompt = takeOwed();
      if (prompt) return void sayThenListenRef.current(prompt);
      const held = deferredReplies.current.shift();
      if (held) void tellNext.current(held);
      else listen();
    },
    [listen, say, takeOwed],
  );

  const sayThenListenRef = useRef(sayThenListen);
  sayThenListenRef.current = sayThenListen;

  /** Tell the engine's finished answer. A long one is told the way people
   *  do on the phone (each item in a sentence, then "details are in the chat")
   *  through the host; a short one, or any failure, is read out as written. */
  const tellReply = useCallback(
    async (text: string) => {
      if (gated()) {
        deferredReplies.current.unshift(text);
        return;
      }
      // the engine's reply is what the pending engine stamp times: only here
      // is it taken, never by a prompt or a "still on it" line
      const logEngine = takeEngineTurn();
      const onPlaying = logEngine ? () => logEngine(Date.now()) : undefined;
      if (!hostOn.current || text.length <= BRIEF_OVER_CHARS) return sayThenListen(text, undefined, onPlaying);
      if (!alive.current || currentCall() !== bot.id) return;
      const mine = ++sayGeneration.current;
      const startedAt = Date.now();
      move("speaking");
      if (!duplex()) hush();
      let stream: ReturnType<typeof speaker.stream> | null = null;
      await hostTurn(
        bot.id,
        { text, threadId: threadRef.current, history: hostHistory.current, handDowns: handDowns.current, brief: true },
        (event) => {
          if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;
          if (event.type === "sentence") {
            if (!stream) {
              hostSpeaking.current = true;
              stream = speaker.stream({ botId: bot.id, voiceId: voiceRef.current, ...(onPlaying ? { onPlaying } : {}) });
              void stream.done.finally(() => {
                hostSpeaking.current = false;
              });
            }
            stream.push(event.text);
          }
        },
      );
      if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;
      if (!stream) return sayThenListen(openingOf(text), undefined, onPlaying);
      const told = stream as ReturnType<typeof speaker.stream>;
      told.end();
      const heardAll = await told.done;
      hostHistory.current = [
        ...hostHistory.current,
        { role: "host" as const, text: `${told.heard().join(" ")}${heardAll || ownerCutInAt.current < startedAt ? "" : " [the owner cut in here]"}`.trim() },
      ].slice(-12);
      // A genuine barge-in has already left "speaking" and bumped the
      // generation (bargeIn); a clip that merely failed or stalled has done
      // neither, and must not strand the call in "speaking" for good.
      if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine || phaseRef.current !== "speaking") return;
      // a prompt owed to the owner comes first
      const prompt = takeOwed();
      if (prompt) return void sayThenListen(prompt);
      // another answer landed while this one was being told: tell it next
      const held = deferredReplies.current.shift();
      if (held) void tellNext.current(held);
      else listen();
    },
    // threadRef is a ref, not a dep: it never changes after mount, and
    // depending on the live bot.threadId here would recreate this callback
    // (and every effect that depends on it) on a task-drift push
    // (callbar-rereview.md N3).
    [bot.id, hush, listen, move, sayThenListen, takeOwed],
  );
  const tellNext = useRef(tellReply);
  tellNext.current = tellReply;

  /** Ask any owed prompt, speak whatever was held back while the owner was
   *  talking, then listen. */
  const listenOrCatchUp = useCallback(() => {
    if (gated()) return;
    const prompt = takeOwed();
    if (prompt) return void sayThenListen(prompt);
    const held = deferredReplies.current.shift();
    if (held) void tellReply(held);
    else listen();
  }, [listen, sayThenListen, takeOwed, tellReply]);
  /** Listen, asking first any prompt owed to the owner: after "stop", work
   *  waiting on an approval must not wait in silence for the next turn. */
  const listenAskingOwed = useCallback(() => {
    const prompt = gated() ? null : takeOwed();
    if (prompt) return void sayThenListen(prompt);
    listen();
  }, [listen, sayThenListen, takeOwed]);
  drainAfterHeldRef.current = () => {
    if (!gated() && (owed.current.length || deferredReplies.current.length)) listenOrCatchUp();
  };

  /** Ask an approval or a question aloud; while the call may not speak, owe
   *  it instead. Never deferred with the replies and never told through the
   *  host, which would paraphrase a long one (spec §4.3.5). */
  const askPrompt = useCallback(
    (requestId: string, text: string) => {
      prompts.current.set(requestId, text);
      const owe = () => {
        if (!owed.current.some((p) => p.requestId === requestId)) owed.current.push({ requestId, text });
      };
      // While the host fetches or speaks its reply, a prompt read now would
      // silence that reply (its sentences belong to an older generation)
      // while the reply is still recorded as said: owed instead, and asked
      // first when the host's turn ends.
      if (gated() || (hostOn.current && (phaseRef.current === "sending" || hostSpeaking.current))) return owe();
      const startedAt = Date.now();
      // Cut by the call itself (the host's reply starting, another answer),
      // not by the owner talking over it or a hold (which owes it itself):
      // owed again, so it is asked in full before a yes can answer it.
      void sayThenListen(text, () => {
        if (!alive.current || heldRef.current || ownerCutInAt.current >= startedAt) return;
        owe();
      });
    },
    [sayThenListen],
  );

  /** Say what is owed and held back, one after another, without opening a
   *  turn: for a call whose microphone could not open. */
  const sayQuietly = useCallback(async () => {
    for (;;) {
      const next = takeOwed() ?? deferredReplies.current.shift();
      if (!next) break;
      if (!(await say(next))) return;
    }
    if (alive.current && phaseRef.current === "speaking") move("listening");
  }, [move, say, takeOwed]);

  // ── hold, resume and lost: the iPhone's engine (spec §4.3.5) ─────────
  /** Stop everything the call is saying or hearing, in the spec's order, and
   *  park it until native says the engine is back. */
  const holdCall = useCallback(() => {
    if (heldRef.current) return;
    sayGeneration.current += 1;
    dropMaybeOwner();
    ackGate.current?.cancel();
    carriedAck.current = false;
    hostAbort.current?.abort();
    hostSpeaking.current = false;
    speaker.stop();
    // also aborts a Flux transcription in flight: an utterance the hold cut
    // off is dropped, not sent, and so is a line waiting for the rest
    hush();
    heldLine.current?.drop("hold");
    utteranceBegan.current = 0;
    micRef.current?.resetDetection();
    micRef.current?.suspend?.();
    audioRef.current?.pulse(false);
    // An approval or question not yet answered is asked again, once, when
    // the call is back: the hold may have cut its prompt off.
    const open = askedApproval.current;
    for (const requestId of [open && !open.submitted ? open.requestId : null, askedQuestion.current?.requestId ?? null]) {
      const text = requestId ? prompts.current.get(requestId) : undefined;
      if (requestId && text && !owed.current.some((p) => p.requestId === requestId)) owed.current.push({ requestId, text });
    }
    heldRef.current = true;
    setHeld(true);
  }, [hush]);

  /** The engine is running again: pick the call up where it was. */
  const resumeFromHold = useCallback(() => {
    if (!heldRef.current || lostRef.current) return;
    heldRef.current = false;
    setHeld(false);
    setResumes((n) => n + 1);
    micRef.current?.resetDetection();
    void micRef.current?.resume?.();
    // the echo canceller starts over, so the warm-up runs again on the next
    // line; and "This is taking a while" does not fire the moment it is back
    firstSpokeAt.current = 0;
    lastSpeechAt.current = Date.now();
    // Work still running with the host off: back to working, as before the
    // hold. A prompt owed to the owner is asked first all the same.
    if (!owed.current.length && busyRef.current && !hostOn.current) move("working");
    else listenOrCatchUp();
  }, [listenOrCatchUp, move]);

  /** The engine could not come back. Only "Resume call" reopens it. */
  const loseCall = useCallback(() => {
    holdCall();
    lostRef.current = true;
    setLost(true);
    micRef.current?.resetDetection();
  }, [holdCall]);

  /** "Resume call": a new native session on the same microphone, whose
   *  listeners stay, and a new player for it. */
  const resumeCall = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || resuming.current) return;
    resuming.current = true;
    setNoteRetry("listen");
    setNote(null);
    try {
      await audio.reopen();
    } catch {
      resuming.current = false;
      if (!alive.current) return;
      setNoteRetry("none");
      setNote("The microphone couldn't start.");
      return;
    }
    resuming.current = false;
    if (!alive.current) return;
    nativePlayer.current = audio.player();
    speaker.useOutput(nativePlayer.current);
    lostRef.current = false;
    setLost(false);
    resumeFromHold();
  }, [resumeFromHold]);

  useEffect(() => {
    if (!held || lost) {
      setHeldLong(false);
      return;
    }
    return offerResumeWhenHeld(setHeldLong);
  }, [held, lost]);

  const onCallAudio = useRef<(event: CallAudioEvent) => void>(() => {});
  onCallAudio.current = (event) => {
    if (event.type === "hold") holdCall();
    else if (event.type === "resume") resumeFromHold();
    else if (event.type === "lost") loseCall();
  };

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
        threadId: threadRef.current,
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
    [bot.id, dispatch], // threadRef is a ref; see tellReply's comment above
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
    async (said: string, approvalOpen?: string, timing?: { endedAt?: number; lineAt: number }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      move("sending");
      if (!duplex()) hush();
      const controller = new AbortController();
      hostAbort.current?.abort();
      hostAbort.current = controller;
      const mine = ++sayGeneration.current;
      let stream: ReturnType<typeof speaker.stream> | null = null;
      const turn: NonNullable<typeof turnInFlight.current> = {
        said,
        sentAt: Date.now(),
        controller,
        playingAt: () => (stream as ReturnType<typeof speaker.stream> | null)?.playingAt() ?? null,
        acted: false,
        superseded: false,
        history: [],
        log: [],
      };
      turnInFlight.current = turn;
      let firstSentenceAt: number | null = null;
      let firstPiece: { kind: "clause" | "sentence"; chars: number } | null = null;
      // `quiet`: a cue standing alone for an engine turn must not move the
      // call into "speaking" while it waits for the engine
      const voice = (quiet = false) => {
        if (!stream) {
          if (!quiet) move("speaking");
          hostSpeaking.current = true;
          const own = speaker.stream({ botId: bot.id, voiceId: voiceRef.current });
          stream = own;
          // the engine cue is the only audio: tracked so an engine turn that
          // ends while it sounds can stop it and listen at once
          if (quiet) engineCue.current = stream;
          void own.done.finally(() => {
            hostSpeaking.current = false;
            if (engineCue.current === own) engineCue.current = null;
            if (quiet && alive.current && currentCall() === bot.id && sayGeneration.current === mine && (hostOn.current || !busyRef.current) && (phaseRef.current === "working" || phaseRef.current === "sending")) listenOrCatchUp();
          });
        }
        return stream;
      };
      // The acknowledgement for a slow turn (call-ack.ts): a short cue played
      // first, kept out of everything the reply is recorded in.
      let realStarted = false;
      let turnOver = false;
      // the turn finished without handing the owner's words to the engine: a
      // cue fetched live that lands after this must not start a stream nobody ends
      let closed = false;
      const fireAck = (key: AckKey) => {
        const firedAt = Date.now();
        const voiceId = voiceRef.current;
        const cached = cueCache.get({ botId: bot.id, voiceId, locale: localeCode(), key });
        lastAck.current = key;
        console.warn(`[call-diag] ack ${key} cached=${cached ? "yes" : "no"} at ${firedAt - turn.sentAt} ms`);
        const play = (clip: Blob) => {
          if (
            !cueMayPlay({
              live: alive.current && currentCall() === bot.id && sayGeneration.current === mine,
              superseded: turn.superseded,
              held: heldRef.current,
              realStarted,
              otherSpeech: !stream && (speaker.isSpeaking() || hostSpeaking.current),
              closed,
              ageMs: Date.now() - firedAt,
              instantCued: instantCued.current,
            })
          )
            return;
          const cueStream = voice(turnOver);
          const cueEnded = cueStream.cue(clip);
          if (turnOver) cueStream.end();
          // "speaking" fits the cue itself (echo, barge-in); once it ends with
          // no real piece yet the call is waiting again
          void cueEnded.then(() => {
            const back = phaseAfterCue({ live: alive.current && currentCall() === bot.id && sayGeneration.current === mine && !turn.superseded && !turnOver, realStarted, phase: phaseRef.current, busy: false });
            if (back) move(back);
          });
        };
        if (cached) play(cached);
        else
          void speaker.fetchClip(t(key), { botId: bot.id, voiceId }).then((clip) => {
            cueCache.put({ botId: bot.id, voiceId, locale: localeCode(), key }, clip);
            play(clip);
          }, () => undefined);
      };
      const gate = new AckGate({ fire: fireAck, last: lastAck.current, keys: ackPool.current });
      ackGate.current?.cancel();
      ackGate.current = gate;
      if (carriedAck.current) carriedAck.current = false;
      else gate.start(turn.sentAt);
      let spoken = "";
      let handed = false;
      let handedRequest = "";
      let handedId = "";
      let lookedUp = false;
      let failed = false;
      try {
        await hostTurn(
          bot.id,
          { text: said, threadId: threadRef.current, history: hostHistory.current, handDowns: handDowns.current, ...(approvalOpen ? { approval: approvalOpen } : {}) },
          (event) => {
            if (!alive.current || currentCall() !== bot.id || turn.superseded) return;
            if (event.type === "lookup") {
              lookedUp = true;
              setLookingUp(true);
              gate.slow("lookup");
            } else if (event.type === "sentence") {
              setLookingUp(false);
              realStarted = true;
              gate.realPiece();
              firstSentenceAt ??= Date.now();
              firstPiece ??= { kind: event.clause ? "clause" : "sentence", chars: event.text.length };
              spoken += `${event.text} `;
              if (sayGeneration.current === mine) voice().push(event.text);
            } else if (event.type === "hand_down" && !handed) {
              handed = true;
              turn.acted = true;
              handedRequest = event.request;
              handedId = crypto.randomUUID();
              handDowns.current = [...handDowns.current, { id: handedId, request: event.request, at: Date.now(), state: "sending" as const }].slice(-12);
              sendFromCall(event.request, said, handedId);
            } else if (event.type === "cancel") {
              turn.acted = true;
              cancelledAt.current = Date.now();
              for (const h of handDowns.current) if (h.state === "sending" || h.state === "accepted") h.state = "cancelled";
              dispatch({ type: "interrupt", botId: bot.id, threadId: threadRef.current });
            } else if (event.type === "error") {
              failed = true;
              if (HOST_OFF_FOR_CALL.has(event.reason)) {
                hostOffForCall.current = true;
                hostOn.current = false;
              }
            }
          },
          controller.signal,
        );
        if (hostAbort.current === controller) hostAbort.current = null;
        // joined to the owner's next line and asked again as one turn: that
        // turn records and speaks everything
        if (turn.superseded) return;
        if (alive.current) setLookingUp(false);
        if (!alive.current || currentCall() !== bot.id) return;
        // A hold aborted the fetch (holdCall): nothing was answered, so the
        // turn is not logged and the owner's question is not put in the
        // host's history, as joinTurn takes a superseded one back out
        // (callbar-rereview3.md A6).
        if (controller.signal.aborted && heldRef.current && !handed && !turn.acted) {
          turn.superseded = true;
          return;
        }
        if (failed && !handed && !spoken) {
          // the host could not take this turn (it was already asked twice on
          // a stall, voice-host.ts); the engine takes it, as before
          turn.acted = true;
          move("sending");
          // the engine will take a while: cue now, and let that clip end the stream
          turnOver = true;
          gate.slow("engine");
          (stream as ReturnType<typeof speaker.stream> | null)?.end();
          callLog.current.push(sentEntry(said, "engine"));
          if (timing) engineTurn.current = { ...timing, sentAt: turn.sentAt };
          sendFromCall(said, said);
          // a prompt owed while the host was asked is asked now, as it would
          // have been on the engine path
          // with the host on the owner talks to it while the engine works
          if (owed.current.length || (hostOn.current && duplex())) listenOrCatchUp();
          return;
        }
        // the host has finished: nothing real is still to come that a cue could beat
        gate.cancel();
        const logEntry: (typeof callLog.current)[number] = handed
          ? sentEntry(said, "handed_down", handedRequest)
          : lookedUp
            ? { said, outcome: "looked_up", detail: spoken.trim() }
            : { said, outcome: "answered", detail: spoken.trim() };
        callLog.current.push(logEntry);
        turn.log.push(logEntry);
        const ownerEntry: HostTurnInput["history"][number] = { role: "owner", text: said };
        hostHistory.current.push(ownerEntry);
        // The host's line goes in as it was HEARD, not as it was written: cut
        // off after one sentence, the model must not believe it said the rest
        // (LiveKit keeps the played transcript with interrupted=True; Pipecat
        // adds text to the context only once it is spoken).
        const entry: HostTurnInput["history"][number] = { role: "host", text: "", ...(handedId ? { handDown: { id: handedId, request: handedRequest } } : {}) };
        hostHistory.current.push(entry);
        hostHistory.current = hostHistory.current.slice(-12);
        turn.history.push(ownerEntry, entry);
        // a hand-down with nothing said would be dead air: a claim-free line
        if (handed && !spoken.trim() && sayGeneration.current === mine) {
          realStarted = true;
          voice().push("On it.");
        }
        if (stream) {
          const told = stream as ReturnType<typeof speaker.stream>;
          told.end();
          const heardAll = await told.done;
          if (turn.superseded) return;
          // "[the owner cut in here]" only when the owner did: a clip that
          // failed or stalled is not them
          const cutIn = !heardAll && ownerCutInAt.current >= turn.sentAt;
          entry.text = `${told.heard().join(" ")}${cutIn ? " [the owner cut in here]" : ""}`.trim();
          // A genuine barge-in has already left "speaking" and bumped the
          // generation (bargeIn); a clip that merely failed or stalled has
          // done neither, and falls through below to recover the call
          // instead of stranding it in "speaking" for good.
          if (!alive.current || currentCall() !== bot.id || sayGeneration.current !== mine) return;
        } else {
          entry.text = spoken.trim();
        }
        if (!entry.text && !entry.handDown) hostHistory.current = hostHistory.current.filter((e) => e !== entry);
        if (phaseRef.current === "speaking" || phaseRef.current === "sending") listenOrCatchUp();
      } finally {
        gate.cancel();
        closed = !turnOver;
        if (turnInFlight.current === turn) turnInFlight.current = null;
        if (hostAbort.current === controller) hostAbort.current = null;
        if (!turn.superseded && timing && firstSentenceAt) {
          const told = stream as ReturnType<typeof speaker.stream> | null;
          const clip = told?.firstClip() ?? null;
          console.warn(
            turnTiming({
              ...timing,
              sentAt: turn.sentAt,
              firstSentenceAt,
              playingAt: turn.playingAt(),
              ttsRequestedAt: clip?.requestedAt,
              ttsHeadersAt: clip?.headersAt,
              ttsFirstByteAt: clip?.firstByteAt,
              piece: (firstPiece as { kind: "clause" | "sentence"; chars: number } | null)?.kind ?? null,
              pieceChars: (firstPiece as { chars: number } | null)?.chars,
              player: told?.player() ?? null,
              ackAt: told?.cueAt() ?? null,
              path: "host",
            }),
          );
        }
      }
    },
    [bot.id, dispatch, hush, listenOrCatchUp, move, sendFromCall], // threadRef is a ref
  );

  /**
   * The owner's next line, when it is the rest of the turn still in flight
   * (call-turns.ts joinsTurn): that turn is stopped, its audio with it, and
   * taken back out of the history and the call log, and the two halves are
   * asked again as one. Otherwise the line as it is.
   */
  const joinTurn = useCallback((said: string, began: number): string => {
    const turn = turnInFlight.current;
    if (!hostOn.current || !turn || turn.superseded || turn.acted) return said;
    const now = Date.now();
    const playingAt = turn.playingAt();
    if (!joinsTurn({ sentAt: turn.sentAt, playingAt }, { began, now })) return said;
    console.warn(`[call-diag] joined the owner's next line to the turn in flight (${playingAt === null ? "nothing" : `${now - playingAt} ms`} heard)`);
    turn.superseded = true;
    // one cue per spoken turn: the joined turn inherits whether this one cued
    carriedAck.current = ackGate.current?.fired ?? false;
    ackGate.current?.cancel();
    turn.controller.abort();
    sayGeneration.current += 1;
    dropMaybeOwner();
    hostSpeaking.current = false;
    speaker.stop();
    hostHistory.current = hostHistory.current.filter((e) => !turn.history.includes(e));
    callLog.current = callLog.current.filter((e) => !turn.log.includes(e));
    // nothing is in flight now: the owner is heard as in any turn
    move("listening");
    return `${turn.said} ${said}`;
  }, [move]);

  /** Send what the owner said: to the host, or without it, to the engine. */
  const sendTurn = useCallback(
    (said: string, timing?: { endedAt?: number; lineAt: number }) => {
      if (!alive.current || currentCall() !== bot.id || heldRef.current) return;
      callTrace("send", { chars: said.length, words: wordCount(said), host: hostOn.current });
      if (hostOn.current) {
        void hostReply(said, undefined, timing);
        return;
      }
      move("sending");
      callLog.current.push(sentEntry(said, "engine"));
      if (timing) engineTurn.current = { ...timing, sentAt: Date.now() };
      sendFromCall(said, said);
    },
    [bot.id, hostReply, move, sendFromCall],
  );
  sendTurnRef.current = sendTurn;

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
      if (gated()) return;
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
      engineTurn.current = null;
      sayGeneration.current += 1;
      dropMaybeOwner();
      ackGate.current?.cancel();
      heldLine.current?.drop("hang up");
      hostAbort.current?.abort();
      pulse.current?.dispose();
      pulse.current = null;
      outputReady.current = false;
      // A native call: its speech stops first, then speech goes back to the
      // page's own player, then the session closes (spec §4.3.4).
      if (nativePlayer.current) {
        speaker.stop();
        speaker.useOutput(null);
        nativePlayer.current = null;
      }
      audioRef.current?.close();
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

  // Two short acknowledgement clips in this bot's voice, synthesized now so a
  // slow turn can cue at once. Best effort: a failure just means no cue.
  useEffect(() => {
    if (!hostOn.current) return;
    const first = pickAck(null, Math.random);
    const keys = [first, pickAck(first, Math.random)];
    ackPool.current = keys;
    void cueCache.prewarm({ botId: bot.id, voiceId: bot.voice, locale: localeCode(), keys });
  }, [bot.id, bot.voice]);

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let offTranscript = () => {};
    let offEnd = () => {};
    let offVoice = () => {};
    let offLevel = () => {};
    let offAudio = () => {};
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    const attach = (mic: CallMic) => {
    // Idempotent: a retry that still lands after the first attempt already
    // attached must not double-subscribe, or every line the owner says is
    // handled twice (callbar-review.md I2).
    offTranscript();
    offEnd();
    offVoice();
    offLevel();
    // loudness for the visuals only; a microphone the page never hears
    // (the helper's own) has none, and the partials below stand in
    offLevel = mic.onLevel?.((rms) => signals.owner.push(rms)) ?? (() => {});
    const handleLine = (line: MicLine) => {
      // held: whatever was being said is dropped, not sent
      if (heldRef.current) return;
      // With an echo-cancelled mic, words heard while the bot is speaking are
      // the owner talking over it.
      const bargeable = mic.duplex && phaseRef.current === "speaking";
      // While the host fetches its answer, a final line is the rest of what
      // the owner said (call-turns.ts): it joins that turn instead of being
      // dropped. Not while an approval or question waits on an answer.
      const joinable =
        mic.duplex &&
        phaseRef.current === "sending" &&
        line.partial === false &&
        Boolean(turnInFlight.current && !turnInFlight.current.acted) &&
        !askedApproval.current &&
        !askedQuestion.current;
      // This line's speech began at its first sign (a partial line, or the
      // voice), else unknown. A final or failed line ends the utterance on
      // every path below, early returns included, so no start outlives it.
      const began = utteranceBegan.current;
      if (line.partial === false || line.error) utteranceBegan.current = 0;
      else if (typeof line.text === "string" && !utteranceBegan.current) utteranceBegan.current = Date.now();
      // [call-diag]: counts and states only, never the words
      // Flux's final line says what Silero heard in its own utterance; it
      // lands seconds after the owner stopped, when the windows below
      // (ending now) hold only silence. Without it, the windows. (A Flux
      // recording starts only on Silero's speech, so `heard` is true in
      // practice: its share is what tells music from the owner.)
      const evidence = line.speech;
      const diag = (what: string) =>
        console.warn(`[call-diag] line ${line.partial === false ? "final" : "partial"} ${(line.text ?? "").trim().split(/\s+/).filter(Boolean).length}w phase=${phaseRef.current} speech=${mic.speechWithin(1_500)} share=${mic.speechShare(1_500)?.toFixed(2) ?? "n/a"} utterance=${evidence ? `${evidence.heard}/${evidence.share.toFixed(2)}` : "n/a"}: ${what}`);
      if (mutedRef.current) return;
      if (!alive.current || currentCall() !== bot.id || (phaseRef.current !== "listening" && !bargeable && !joinable)) {
        if (alive.current && phaseRef.current !== "listening") {
          diag("ignored (not listening, not talk-over)");
          callTrace(`discard not listening phase ${phaseRef.current}`, { final: line.partial === false, words: wordCount(line.text) });
        }
        return;
      }
      if (bargeable) diag("heard while the bot speaks");
      else if (joinable) diag("heard while the answer is fetched");
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      // Nothing was said: an empty final over the bot (a cough, a breath, an
      // echo the recognizer gave up on) is no reason to cut the bot off.
      if (bargeable && line.partial === false && !line.text.trim()) {
        callTrace("discard empty final talk-over", { joinable });
        resumeBot();
        return;
      }
      // Words with no speech behind them are the recognizer guessing at a
      // noise (a TradingView alert beep interrupted a live call). Silero
      // heard no speech: the line is dropped, whatever it says.
      // A final over the bot is judged on its own utterance (talkOverVerdict),
      // not on the last 1.5 s: it lands well after the owner stopped.
      const verdict = bargeable
        ? talkOverVerdict({
            final: line.partial === false,
            began,
            now: Date.now(),
            evidence,
            // the silence the recognizer waited before ending this utterance
            endpointMs:
              mic.kind === "apple"
                ? line.longEndpoint ? CALL_ENDPOINT_LONG_MS : CALL_ENDPOINT_MS
                : line.longEndpoint ? VAD_ENDPOINT_LONG_MS : VAD_ENDPOINT_MS,
            sinceSpeechMs: mic.sinceSpeechMs() ?? undefined,
            rejectedEarlier: utteranceRejected.current,
            speechWithin: (ms) => mic.speechWithin(ms),
            speechShare: (ms) => mic.speechShare(ms),
          })
        : null;
      const noSpeech = evidence ? !evidence.heard : verdict ? !verdict.heard : mic.speechWithin(8_000) === false;
      if (noSpeech && line.text.trim()) {
        diag("dropped: no speech heard");
        callTrace("discard no speech", { final: line.partial === false, talkOver: bargeable, words: wordCount(line.text) });
        if (bargeable) resumeBot();
        if (line.partial === false && !bargeable && !joinable) listenOrCatchUp();
        return;
      }
      // "Stop" while the bot talks, with speech heard behind it: stop now.
      // Music and beeps score near zero on the speech model, so the check
      // above already guards this; the share test below would not, since a
      // one-word command is too short to fill it.
      if (bargeable && STOP_NOW.test(line.text.trim())) {
        diag("stop word: quiet now");
        callTrace("discard stop word talk-over", { final: line.partial === false });
        bargeIn();
        deferredReplies.current = [];
        if (line.partial === false) {
          callLog.current.push({ said: line.text.trim(), outcome: "answered", detail: "(stopped talking)" });
          listenAskingOwed();
        }
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
        // Flux's "…" only says an utterance began: the owner is talking now,
        // and their voice (onVoice) says when they stop, not this line
        if (mic.kind === "flux" && line.partial !== false && line.text === "…") {
          holdForOwner();
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
        // One word from Flux: with its utterance's speech behind it, a turn
        // ("yes" to an approval being read, "Tuesday" to a question), as on
        // the Apple path; without that evidence, a transcript of a noise.
        if (mic.kind === "flux" && (!words.length || (words.length < 2 && !(evidence && evidence.share >= MIN_SPEECH_SHARE)))) {
          resumeBot();
          return;
        }
        // Music trips the speech model now and then and the recognizer
        // invents words from it; a person talking keeps it busy. Too little
        // of the last moment was speech: not the owner. Logged, numbers
        // only, so the threshold can be tuned from real calls.
        // Share of speech since the owner started this utterance, not over a
        // fixed 1.5 s: a spoken "stop" lasts a third of a second, and the
        // silence before it read as 8% speech, under the bar (measured live).
        const share = verdict ? verdict.share : null;
        console.warn(`[call-diag] talk-over: ${words.length} words, speech share ${share === null ? "n/a" : share.toFixed(2)} -> ${verdict && !verdict.accept ? "ignored" : "stop"}`);
        if (verdict && !verdict.accept) {
          callTrace("discard talk-over speech share", { final: line.partial === false, words: words.length, share });
          if (line.partial !== false) utteranceRejected.current = true;
          resumeBot();
          return;
        }
        bargeIn();
      }
      lastSpeechAt.current = Date.now();
      // Apple's recognizer can reset its transcript to "" after a pause. The
      // words already shown stay shown, and are what an empty final sends.
      // (Flux has no partial words to keep, and its "…" is never words.)
      if (mic.kind !== "flux") lastWordsRef.current.push(line.text);
      const shown = mic.kind !== "flux" ? lastWordsRef.current.text : line.text.trim() === "…" ? "" : line.text;
      // Flux's "…" is shown (the owner is heard) but never remembered or sent
      setHeard(shown || (line.text.trim() === "…" ? "…" : ""));
      // a new partial: the owner is talking (the aura's listening ripple)
      if (line.partial !== false) signals.owner.pulse();
      heardRef.current = line.partial === false ? "" : shown;
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = shown.trim();
      if (!line.text.trim() && said) callTrace("empty final recovered", { chars: said.length });
      lastWordsRef.current.clear();
      if (!said) {
        callTrace("discard empty final", { joinable });
        return joinable ? undefined : listenOrCatchUp();
      }
      callTrace("final accepted", { chars: said.length, words: wordCount(said), longEndpoint: line.longEndpoint === true });
      // listening noises while the answer is fetched are not the rest of it
      if (joinable && (BACKCHANNEL.test(said) || STOP_ONLY.test(said))) {
        diag("not joined: a listening noise");
        callTrace("discard listening noise joinable", { chars: said.length });
        return;
      }
      // The rest of a held line is the owner's sentence, never an answer to a
      // card that opened meanwhile (its prompt is owed until the turn ends).
      const continuing = Boolean(heldLine.current?.holding);
      /** A card whose prompt the owner has not heard in full: no line
       *  answers it until it has been asked. */
      const unheard = (requestId: string) => owed.current.some((p) => p.requestId === requestId);

      const open = continuing ? null : askedApproval.current;
      if (open && !(!open.submitted && unheard(open.requestId))) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        const answer = approvalAnswer(said);
        if (answer) {
          const allow = answer !== "deny";
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
          const forCall = answer === "allow-for-call" && pending && !open.routine && !open.skill && !isHostConsentApproval(pending);
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: threadRef.current,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
            card: open.card,
            botName: bot.name,
            // The rest-of-the-call yes counts, and is said, only once the
            // decision has gone through (after the phone prompt, when there is one).
            onSuccess: () => {
              if (!forCall || !alive.current || currentCall() !== bot.id) return;
              allowedForCall.current = true;
              void sayThenListen(FOR_CALL_SPOKEN);
            },
            onError: (error: string, code?: FreshAuthCode) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              // A refused or cancelled phone prompt (SEC-006 Decision 7): say it plainly, leave the
              // card pending, keep the call going. A yes for the call is not kept if it was not confirmed,
              // whatever the failure was.
              if (forCall) allowedForCall.current = false;
              if (code) {
                void sayThenListen(freshAuthSpoken(code));
                return;
              }
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

      const openQuestion = continuing ? null : askedQuestion.current;
      if (openQuestion && !unheard(openQuestion.requestId)) {
        askedQuestion.current = null;
        move("working");
        // Through the thread's own respond route, with the request's own id
        // and the call's frozen thread — never `answerCard` by messageId,
        // which re-finds the card in the bot's LIVE messages. Switching to
        // another task of the same bot between the ask and the answer
        // leaves nothing there to find, and the dispatch fell through to an
        // ordinary message with no threadId: a 409 from the server, and the
        // question lost (callbar-rereview3.md A2). A failed post puts the
        // question back, unless a newer one has already taken its place.
        // The card stays open on the client until the server's update lands:
        // `answering` keeps the narration from reading it out again meanwhile.
        answering.current = openQuestion.requestId;
        void answerCallQuestion(threadRef.current, openQuestion.requestId, said).then((result) => {
          if (result === "sent" || !alive.current || currentCall() !== bot.id) return;
          if (result === "refused") {
            // a refusal will not change on a second try: say so once, leave
            // the question to the screen, and stop asking it
            leftToScreen.current.add(openQuestion.requestId);
            const line = "I couldn't send that answer from the call. You can answer it on screen.";
            // said now unless something is playing: then after it, not over it
            if (phaseRef.current === "speaking") deferredReplies.current.unshift(line);
            else void sayThenListen(line);
            return;
          }
          answering.current = null;
          // Not sent (the network or the server): the question is open again
          // and asked again, with a word that the answer did not go through,
          // and the call leaves "working" to listen for it.
          if (askedQuestion.current && askedQuestion.current.requestId !== openQuestion.requestId) return;
          askedQuestion.current = openQuestion;
          const text = prompts.current.get(openQuestion.requestId);
          if (text && !owed.current.some((p) => p.requestId === openQuestion.requestId)) {
            owed.current.push({ requestId: openQuestion.requestId, text: `That answer didn't go through. ${text}` });
          }
          if (phaseRef.current === "working" || phaseRef.current === "sending") listenOrCatchUp();
        });
        return;
      }

      // "Stop", "stop, stop", "be quiet" while the bot was talking: be quiet.
      // Heard live: each "stop" became a turn the bot answered out loud, and
      // answers waiting their turn were then spoken too. Now nothing is
      // said and nothing held is spoken. With work running and the bot not
      // talking, "stop" still goes to the host, which stops the work.
      // After a held line, "hold on", "wait" or "pause" is the owner thinking:
      // the line keeps waiting and their next line joins it. "Stop" takes it
      // back: quiet, and a prompt owed meanwhile is asked.
      if (continuing && STOP_ONLY.test(said)) {
        if (!holdsOn(said)) {
          heldLine.current?.drop("stop");
          callLog.current.push({ said, outcome: "answered", detail: "(stopped talking)" });
          listenAskingOwed();
        } else {
          diag("hold on: the held line waits for the rest");
          heldLine.current?.park();
          listen();
        }
        return;
      }
      if (STOP_ONLY.test(said) && (Date.now() - interruptedAt.current < 10_000 || speaker.isSpeaking() || hostSpeaking.current)) {
        heldLine.current?.drop("stop");
        ownerCutInAt.current = Date.now();
        sayGeneration.current += 1;
        hostSpeaking.current = false;
        speaker.stop();
        deferredReplies.current = [];
        callLog.current.push({ said, outcome: "answered", detail: "(stopped talking)" });
        listenAskingOwed();
        return;
      }
      const timing = { endedAt: line.endedAt, lineAt: Date.now() };
      lineTiming.current = timing;
      // The rest of what the owner said, landing as the answer starts: that
      // turn is stopped and both halves are asked as one (joinTurn). A line
      // that sounds unfinished ("Blues Brothers,") waits a moment for the
      // rest, which arrives joined to it (HeldLine).
      const whole = heldLine.current!.take(joinTurn(said, began), line.endedAt, line.longEndpoint ? LONG_ENDPOINT_HOLD_MS : undefined);
      if (whole === null) {
        diag("sounds unfinished: waiting for the rest");
        return;
      }
      sendTurn(whole, timing);
    };
    offTranscript = mic.onLine((line) => {
      try {
        handleLine(line);
      } finally {
        // every final or failed line ends its utterance: nothing it heard
        // outlives it, whether it was sent, held or dropped
        if (line.partial === false || line.error) {
          lastWordsRef.current.clear();
          utteranceRejected.current = false;
        }
      }
    });
    offEnd = mic.onEnd(({ code, reason }) => {
      micLive.current = false;
      // a failed transcription ends its utterance with no line
      if (code !== 0) utteranceBegan.current = 0;
      console.warn(`[call-diag] session ended (${code}, ${reason ?? "-"}) phase=${phaseRef.current}`);
      callTrace("session end", { code, heard: lastWordsRef.current.text.length > 0 });
      lastWordsRef.current.clear();
      utteranceRejected.current = false;
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return;
      }
      // With the host on, the microphone can sit open through minutes of
      // engine work with nobody talking, and Apple's recognizer may give up
      // on a long silence. That is not a permission problem: reopen quietly,
      // no more than once every few seconds so a real fault still surfaces.
      // A transcription that did not come back is the network's: it says so
      // and listens again the same way (micEndStep).
      if (code === 1) {
        const step = micEndStep({
          code,
          reason,
          hostOn: hostOn.current,
          phase: phaseRef.current,
          heard: Boolean(heardRef.current),
          sinceRestartMs: Date.now() - quietRestartAt.current,
        });
        if (step.listen) {
          quietRestartAt.current = Date.now();
          listen();
          // after listen(), which clears the note: the owner must see why
          // nothing was heard (callbar-rereview3.md I2)
          if (step.note) setNote(step.note);
        } else if (step.note) {
          setNote(step.note);
        }
        if (step.listen || step.note) return;
      }
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") listen();
      // talking over the bot needs a turn running while it speaks
      // talking over the bot, or cutting in while it fetches an answer,
      // needs a turn running then too: the session ends with each sentence
      else if (mic.duplex && (phaseRef.current === "speaking" || phaseRef.current === "sending")) openTurn();
    });
    // Flux transcription has no partial words to barge in on; sustained
    // voice while the bot speaks is the owner talking over it.
    offVoice = mic.onVoice((speaking) => {
      if (!alive.current || mic.kind !== "flux" || !mic.duplex) return;
      if (speaking && !mutedRef.current && !utteranceBegan.current) utteranceBegan.current = Date.now();
      if (!speaking) {
        if (maybeOwner.current) {
          maybeOwner.current.voice = false;
          maybeOwner.current.voiceEndedAt = Date.now();
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
    // Which open attempt this is. A retry bumps it; a stale attempt's begin
    // or error handler (the first open's, still resolving after the retry
    // closed it) checks this and does nothing instead of double-attaching
    // or overwriting the retry's own note (callbar-review.md I2).
    const begin = (attempt: number) => {
      if (cancelled || attempt !== openAttempt.current) return;
      const audio = audioRef.current!;
      micRef.current = audio.mic;
      // The iPhone's engine: every reply is heard through it from now on,
      // and its hold, resume and lost reach the call (spec §4.3.4, §4.3.5).
      if (audio.path === "native" && audio.source) {
        if (!nativePlayer.current) {
          nativePlayer.current = audio.player();
          speaker.useOutput(nativePlayer.current);
        }
        offAudio();
        offAudio = audio.source.onEvent((event) => onCallAudio.current(event));
      }
      setAudioPath(audio.path);
      attach(micRef.current!);
      // Speech may start now. Anything owed or held back as the call opened
      // (an approval already open, say) is asked first.
      outputReady.current = true;
      setConnecting(false);
      // The 8 s note was a guess that this attempt was hanging; it wasn't.
      setNote((prev) => (prev === CONNECT_TIMEOUT_NOTE ? null : prev));
      // held (the effect re-ran mid-hold): resume decides what comes next
      if (heldRef.current) return;
      if (bot.busy && !approval && !question && !hostOn.current) move("working");
      else listenOrCatchUp();
    };
    const openCall = () => {
      openAttempt.current += 1;
      const attempt = openAttempt.current;
      const audio = audioRef.current!;
      clearTimeout(connectTimeout);
      // An open that never answers must not sit on "Connecting…" forever.
      // Re-armed on every attempt, including a retry: the timer only ever
      // watches the attempt actually in flight.
      connectTimeout = setTimeout(() => {
        if (cancelled || attempt !== openAttempt.current || outputReady.current) return;
        setNoteRetry("open");
        setNote(CONNECT_TIMEOUT_NOTE);
      }, CONNECT_TIMEOUT_MS);
      // the web path's pulse need not wait for the microphone; the native
      // one waits for its session (begin)
      void audio.chosen().then((path) => {
        if (!cancelled && attempt === openAttempt.current && path === "web") setAudioPath("web");
      });
      void audio.open().then(
        () => begin(attempt),
        (error: unknown) => {
          if (cancelled || attempt !== openAttempt.current) return;
          // Our own retryOpen closed this attempt to start a fresh one:
          // expected, not a failure, and the fresh attempt already owns
          // the note and the mic.
          if ((error as { code?: unknown } | null)?.code === "closed") return;
          micRef.current = audio.mic;
          setAudioPath(audio.path);
          if ((error as { code?: unknown } | null)?.code === "denied") {
            // "Try again" re-runs this open, not listen()
            setConnecting(false);
            setNoteRetry("open");
            setNote(DENIED_NOTE);
            return;
          }
          // Capture first: if the microphone cannot be opened here, a Mac falls
          // back to the helper's own microphone (half duplex, as before 0.1.59).
          if (audio.mic.kind === "apple") {
            audio.mic.close();
            audio.mic = createFallbackMic();
            // the helper's mic is a new one: the call's mute applies to it too
            audio.setMuted(mutedRef.current);
            begin(attempt);
          } else {
            outputReady.current = true;
            setConnecting(false);
            setNote("The microphone couldn't start. Check Microphone access for Murage.");
            // As before the output gate: what was due as the call opened (an
            // approval already open) is still said, without listen(), which
            // would clear the note.
            void sayQuietly();
          }
        },
      );
    };
    retryOpen.current = () => {
      setNoteRetry("listen");
      setNote(null);
      setConnecting(true);
      // Retire the stale attempt's own CallAudio (closing it settles its
      // in-flight open with the "closed" error openCall's handler already
      // treats as expected) and build a fresh one for the retry. Never the
      // same instance: see the comment on `buildAudio` (N1).
      audioRef.current?.close();
      audioRef.current = buildAudio();
      // A fresh CallAudio starts unmuted; the owner's mute still applies to
      // whatever microphone it ends up choosing (A1).
      audioRef.current.setMuted(mutedRef.current);
      micRef.current = audioRef.current.mic;
      openCall();
    };
    openCall();
    return () => {
      cancelled = true;
      clearTimeout(connectTimeout);
      offTranscript();
      offEnd();
      offVoice();
      offLevel();
      offAudio();
      micLive.current = false;
      void micRef.current?.stop().catch(() => undefined);
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // bot.threadId is deliberately NOT here: every server-facing call in
    // this effect (and the callbacks it depends on) now reads
    // threadRef.current, frozen for the call's lifetime, so a push that
    // moves the bot's live thread must not tear the mic down and reopen it
    // (callbar-rereview.md N3 — the drift case is handled by collapsing
    // the screen, not by restarting the call).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bargeIn, bot.id, dispatch, holdForOwner, hush, hostReply, joinTurn, listen, listenAskingOwed, listenOrCatchUp, move, openTurn, resumeBot, sayQuietly, sayThenListen, sendFromCall, sendTurn, settleMaybeOwner]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // `approval`/`question` are read from the bot's LIVE messages
    // (visibleMessages(bot), above) — whichever task is currently on the
    // store for this bot, not necessarily the call's own thread. While
    // drifted, asking about or deciding one of those would send the
    // call's own (frozen) threadId alongside a requestId that belongs to
    // the OTHER thread — worse than doing nothing. The call is already
    // collapsed to the bar for exactly this case (callbar-rereview.md N3);
    // this is the same guard for what it might otherwise say or decide.
    if (bot.threadId !== threadRef.current) return;
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
    if (answering.current && question?.card?.requestId !== answering.current) answering.current = null;
    // With the host on, the owner can keep talking while the engine works.
    if (!approval && !question && bot.busy && phaseRef.current === "listening" && !hostOn.current && !heldRef.current) {
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
      allowedForCall.current &&
      coveredForCall(approval)
    ) {
      // allowed for the rest of this call: answered without asking again
      askedApproval.current = { requestId: approval.requestId, routine: false, skill: false, submitted: true, card: approval.message.card };
      spokenIds.current.add(approval.message.id);
      callLog.current.push({ said: `(${spokenToolAction(approval.tool, approval.detail)}, allowed for this call)`, outcome: "decision" });
      const requestId = approval.requestId;
      const asked = spokenApprovalPrompt(approval, bot.name, true);
      dispatch({
        type: "decideRequest",
        threadId: bot.threadId,
        requestId,
        behavior: "allow",
        card: approval.message.card,
        botName: bot.name,
        // not saved: ask aloud rather than leave the work waiting on a card
        // nobody mentions
        onError: (_error: string, code?: FreshAuthCode) => {
          const pending = askedApproval.current;
          if (!alive.current || currentCall() !== bot.id || pending?.requestId !== requestId) return;
          pending.submitted = false;
          // a prompt: owed while the call may not speak, never a reply. A refused phone prompt is
          // said plainly first.
          const lead = code && code !== "cancelled" ? `${freshAuthSpoken(code)} ` : "I couldn't allow that on my own. ";
          askPrompt(requestId, `${lead}${asked}`);
        },
      });
      return;
    }
    // held: asked (owed) now, heard when the call is back
    if (approval && askedApproval.current?.requestId !== approval.requestId && (phase !== "speaking" || held)) {
      askedApproval.current = {
        requestId: approval.requestId,
        card: approval.message.card,
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
      askPrompt(
        approval.requestId,
        isSkillApproval(approval)
          ? skillPrompt
          : offerForCall
            ? `${ask.replace(/ Yes or no\.$/, "")} ${FOR_CALL_OFFER}`
            : ask,
      );
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      answering.current !== question.card.requestId &&
      (phase !== "speaking" || held)
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      askPrompt(question.card.requestId, `${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    // unheardMessages: a scrollback page loaded mid-call is not news.
    // Known gap: a live lead-in saved in front of a row this client never loaded
    // stays out of visibleMessages (and unsaid) until that older page loads.
    const fresh = unheardMessages(messages, spokenIds.current, bot.messages);
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    // Text saved in front of a reply that was already said (a hosted tool's
    // lead-in, inserted at response completion) stays in the chat only.
    const isReply = (m: (typeof messages)[number]) => m.role === "bot" && m.kind === "text" && Boolean(m.text?.trim());
    const reply = [...fresh].reverse().find((m) => isReply(m) && !heardReplyAfter(messages, spokenIds.current, m, isReply));
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
      if (busyTalking || gated()) deferredReplies.current.push(line);
      else void sayThenListen(line);
      return;
    }
    if (reply?.text) {
      // Never talk over the owner or over the host's own sentence: hold the
      // answer until that turn ends (listenOrCatchUp speaks it).
      const busyTalking =
        hostOn.current &&
        (hostSpeaking.current || phaseRef.current === "sending" || (phaseRef.current === "listening" && heardRef.current));
      if (busyTalking || gated()) deferredReplies.current.push(reply.text);
      else void tellReply(reply.text);
    } else if (chip?.tool?.spoken && phase === "working" && !hostOn.current) {
      if (gated()) deferredReplies.current.push(chip.tool.spoken);
      else {
        void say(chip.tool.spoken).then((stillMine) => {
          if (stillMine && phaseRef.current === "speaking") move("working");
        });
      }
    }
  }, [messages, bot.messages, approval, question, phase, held, bot.busy, bot.name, bot.threadId, askPrompt, hush, listen, move, say, sayThenListen, tellReply]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    // While drifted, bot.busy belongs to whatever thread the push left on
    // screen, not the call's own frozen thread — following it would hush
    // the mic (or resume listening) for the wrong conversation
    // (callbar-rereview2.md G5, the same guard as the narration effect).
    if (bot.threadId !== threadRef.current) return;
    // held: the phase stays put, and resume decides what comes next
    if (heldRef.current) return;
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
      (!speaker.isSpeaking() || engineCue.current)
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      // An engine cue still sounding is pointless once the work is done: it
      // is stopped so the mic opens now and catches the owner's next words.
      if (engineCue.current) {
        sayGeneration.current += 1;
        hostSpeaking.current = false;
        engineCue.current = null;
        speaker.stop();
      }
      listen();
    }
  }, [bot.busy, bot.threadId, hush, listen, move]);

  // A push for another of this bot's own tasks moves `bot.threadId` while
  // the call is still about its own thread: collapse rather than leaving
  // the full screen up over the approval it was opened for, and reopening
  // the mic underneath it (callbar-review.md M8).
  const threadDrifted = bot.threadId !== threadRef.current;
  const effectiveCollapsed = collapsed || threadDrifted;

  // Escape hangs up; space interrupts whatever is being said. Neither fires
  // while the call is collapsed to a bar: another thread is on screen and
  // owns the keyboard, and Esc there must not silently end the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (effectiveCollapsed) return;
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        dropMaybeOwner();
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, effectiveCollapsed, listen]);

  // The latest step of the running turn, as a phrase: the activity line.
  const activity = lookingUp
    ? "looking it up"
    : bot.busy
      ? [...messages].reverse().find((m) => m.kind === "activity" && m.tool?.spoken)?.tool?.spoken
      : undefined;
  // Pulse only for real work, and only while nobody is speaking. Never while
  // held: the pulse goes off on a hold and comes back on resume if the work
  // is still running (the page is the pulse's only owner).
  const pulsing =
    !held &&
    ((lookingUp && speech.status !== "speaking") ||
      (Boolean(bot.busy) &&
        !approval &&
        !question &&
        !heard &&
        (hostOn.current ? phase === "listening" : phase === "working")));
  useEffect(() => {
    if (audioPath === "native") {
      // the shell's engine plays it; the page makes no sound (spec §4.3.3)
      audioRef.current?.pulse(pulsing);
      return;
    }
    // no page audio before the path is chosen
    if (audioPath !== "web") return;
    if (pulsing) (pulse.current ??= new WorkingPulse()).start();
    else pulse.current?.stop();
  }, [pulsing, audioPath, resumes]);

  // The precedence (paused, then connecting, then muted, then the phase) and
  // the words live in src/lib/call-status.ts, tested there.
  const status = callStatusText({ phase, held, connecting, muted, pushToTalk });

  // What the strip ChatView/GroupView render (CallControls.tsx's
  // CallBarStrip) shows for this call, whenever it isn't the one on
  // screen. Published on every change, not read back here — this
  // component is the only writer (callbar-review.md I4, I5).
  const barStatus: CallBarStatus = lost ? "lost" : held ? "paused" : connecting ? "connecting" : "live";
  useEffect(() => {
    // The call's own (frozen) thread, never the bot's live one — so the
    // strip hides only on the call's own thread, and its tap can bring
    // that exact thread back (callbar-rereview.md N3).
    publishCallBarState({ targetId: bot.id, threadId: threadRef.current, name: bot.name, status: barStatus, kind: "bot" });
  }, [bot.id, bot.name, barStatus]);
  useEffect(() => () => publishCallBarState(null), []);

  // Where the full screen portals to: the chat or room column currently on
  // screen (src/lib/call-slot.ts), so it covers exactly that column, never
  // the sidebar or side panels (callbar-review.md I3).
  const slot = useCallSlot();
  // The avatar's colour and shape, for the aura and the mood (CallAura.tsx).
  const avatarAura = useAvatarAura(bot);
  const auraPhase = auraPhaseFor({ phase, connecting, muted, held, lost });
  // No keyboard hints on a phone (use-keyboard-hints.ts).
  const keyboardHints = useKeyboardHints();

  // Fixed, not in any layout: for the rare case where no chat/room column
  // is mounted at all — Routines, the team map, the skill recorder, an
  // empty state, or the call's own bot/room's workspace (App.tsx excludes
  // that from `callIsSelected`) — so a live call is never silent and
  // hang-up-less (callbar-review.md I3; callbar-rereview.md N2, N4). Reads
  // the real barStatus, never a hard-coded "live" (N2), and its tap
  // genuinely returns to the call (N4): `onExpand` (App.tsx's
  // `returnToCall`) re-selects the call's target, restores its own frozen
  // thread and closes whatever workspace was covering it.
  const fallbackBar = (
    <div
      data-testid="call-bar"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-2.5 rounded-2xl border border-hairline/50 bg-panel px-3 py-2.5 shadow-2xl md:left-4 md:right-auto"
    >
      <CallBarContent name={bot.name} status={barStatus} onReturn={() => onExpand?.()} onHangUp={() => endCall(bot.id)} />
    </div>
  );

  // Another thread or screen is on top, or this bot's own thread drifted
  // out from under the call (M8, N3). Everything above this point (the
  // mic, the turn loop, the native session) keeps running unchanged — only
  // the screen changes here. If a chat/room column is on screen, its own
  // CallBarStrip already shows the indicator (hang up there is still the
  // only way to end it); otherwise this renders the same indicator itself
  // (N2), so a live call is never invisible.
  if (effectiveCollapsed) return slot ? null : fallbackBar;

  // pointer-events-auto: the slot it portals into (ChatView/GroupView's own
  // call-slot div) is pointer-events-none so an EMPTY slot never blocks the
  // chat underneath, and pointer-events is inherited — without this the
  // whole call screen would silently stop taking clicks.
  const fullScreen = (
    <div className="pointer-events-auto absolute inset-0 isolate z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <CallMood phase={auraPhase} color={avatarAura.mood} signals={signals} />
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang up"
        className="absolute right-5 top-[calc(1.25rem+env(safe-area-inset-top))] rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <CallAvatar bot={bot} phase={phase} held={held} inhale={inhale} connecting={connecting} muted={muted} lost={lost} signals={signals} />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {!held && (phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
        {activity && !held && (lookingUp || phase === "working" || (hostOn.current && phase === "listening")) && (
          <div className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary/80">
            <Loader2 size={11} className="animate-spin" />
            {activity.charAt(0).toUpperCase() + activity.slice(1)}
          </div>
        )}
      </div>

      <CallCaption phase={phase} heard={heard} caption={speech.caption} spoken={speech.spoken} queued={speech.queued} progress={readAlongProgress} pushToTalk={pushToTalk} />

      {(lost || heldLong) && (
        <button
          onClick={() => void resumeCall()}
          className="rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          Resume call
        </button>
      )}

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          {noteRetry !== "none" && (
            <button
              onClick={noteRetry === "open" ? () => retryOpen.current() : listen}
              className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
            >
              {noteRetry === "open" ? "Try again" : "Try microphone again"}
            </button>
          )}
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGeneration.current += 1;
              dropMaybeOwner();
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        {micRef.current && (
          <button
            onClick={() => {
              const next = !muted;
              // Through the call, not the microphone directly: a native open
              // or a Capture fallback still in flight replaces micRef with a
              // fresh, unmuted CallMic once it lands, and audio.setMuted
              // reapplies the call's own mute to whichever one that is
              // (callbar-rereview3.md A1).
              audioRef.current?.setMuted(next);
              mutedRef.current = next;
              // muting drops a half-heard utterance: its start goes with it
              utteranceBegan.current = 0;
              lastWordsRef.current.clear();
              utteranceRejected.current = false;
              // the helper's own mic (no echo cancellation) only runs when
              // started: unmuting starts it again, muting stopped it
              if (!next && micRef.current && !micRef.current.duplex && phaseRef.current === "listening") {
                micLive.current = false;
                listen();
              }
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

      {keyboardHints && (
        <div className="text-[11.5px] text-ink-secondary/70" data-call-keyboard-hints>
          {micRef.current?.duplex
            ? "Talk over me to interrupt · Space interrupts · Esc hangs up"
            : "Hold Control + Option to talk · Space interrupts · Esc hangs up"}
        </div>
      )}
    </div>
  );

  // The full screen wants to show (callIsSelected, no drift) but no slot
  // is mounted — should not happen given App.tsx's `callIsSelected`, but a
  // render can land here for one frame before the slot ref's effect runs.
  if (!slot) return fallbackBar;

  return createPortal(fullScreen, slot);
}
