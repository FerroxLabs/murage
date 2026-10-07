// When the owner's turn is really over. Pure pieces the call screen uses,
// kept here so they can be tested without mounting CallView.
//
// A live call on 2026-09-30 lost five of Sable's replies the same way. The
// 850 ms endpoint (since lengthened, see CALL_ENDPOINT_MS) closed the owner's sentence at a pause ("my favourite top
// three movies. Blues Brothers,"), the host answered that half, and the
// second half ("Heartbreak Ridge.") landed a second or two into the reply
// and cut it off as a barge-in. A line that sounds unfinished waits a
// moment for the rest (HeldLine), and a second half that lands just as the
// reply starts is joined to the first and asked again as one turn
// (joinsTurn).

import { isTranscriptionFailure } from "./call-mic";
import { dictationDisabledNote, isDictationDisabled } from "./dictation-notes";
import { ensureDesktopSurfaceSecret } from "./live-events";
import { callRouteHeaders } from "./voice-host";

/** A line that sounds unfinished waits this long for the owner to go on. */
export const CONTINUATION_WAIT_MS = 1_200;
/** Once they have gone on, their next line is waited for up to this long
 *  from the pause that ended the held line (the utterance's end, not the
 *  line's arrival: Flux's line lands 1.5-3 s after they stop). */
export const CONTINUATION_CAP_MS = 6_000;
/** "Hold on", "wait": the owner is thinking. The held line waits this long
 *  for them to go on before it is sent as it is. */
export const HOLD_ON_MS = 10_000;
/** How often a held line checks whether the rest is still coming. */
const CONTINUATION_CHECK_MS = 100;
/** A new line whose speech began this soon after the last send is the
 *  same thought... */
export const JOIN_WITHIN_MS = 3_000;
/** ...as long as less than this of the reply had been heard by then. */
export const JOIN_PLAYED_MS = 2_000;
/** An utterance start older than this is not the line now landing (an
 *  onset whose words never came); the line is timed from its arrival. A
 *  real second half lands well inside it (onset, speech, endpoint, Flux). */
export const STALE_ONSET_MS = 12_000;

/** The windows of silence that end the owner's turn. Apple's recognizer
 *  (Mac, in the helper) waits the base window, and the long one when the
 *  last word sounds unfinished: partials lag speech by 0.2-0.5 s, so the
 *  owner feels about 0.3 s more, which covers a breath. The voice-detector
 *  path (Windows, Linux, iPhone) pays Flux's 1.5-3 s transcription on top,
 *  so its base is shorter; it has no partial transcript to judge, so it
 *  uses the base alone. */
export const CALL_ENDPOINT_MS = 1_500;
export const CALL_ENDPOINT_LONG_MS = 2_800;
export const VAD_ENDPOINT_MS = 1_200;
/** What the voice-detector path would extend to if it had a partial. */
export const VAD_ENDPOINT_LONG_MS = 2_500;

/** Words a clause cannot end on: the owner is still mid-thought. The Mac
 *  helper (electron/resources/speech-helper.swift, `unfinishedWords`) keeps
 *  the very same list; a test holds them together. */
export const UNFINISHED_WORDS = [
  // conjunctions
  "and", "but", "because", "so", "or", "then", "also", "plus", "if", "which", "while", "though", "although", "since", "until", "unless",
  // articles
  "the", "a", "an",
  // prepositions that lead on ("that", "on", "in", "for" and "like" are left
  // out: they end whole sentences as often as not, "I like that")
  "to", "of", "with", "at", "by", "from", "about", "into",
  // possessives and verbs of being
  "my", "your", "is", "are", "was",
  // fillers
  "um", "uh", "er", "erm", "hmm",
] as const;

const WORDS = new Set<string>(UNFINISHED_WORDS);

/** True when the line sounds like the speaker will go on. The matching is
 *  the same on both sides (this and `soundsUnfinished` in
 *  electron/resources/speech-helper.swift; src/lib/unfinished-cases.json is
 *  the table both run):
 *  1. trailing whitespace is ignored;
 *  2. a trailing comma, "…" or "..." means unfinished;
 *  3. a sentence end (. ? !, then any closing quote or bracket) means done;
 *  4. otherwise the last token, split on whitespace and commas and stripped
 *     of leading and trailing punctuation, is unfinished when the WHOLE
 *     token is a listed word. "check-in", "Q&A" and "don't" are one token
 *     each, so nothing inside them counts. */
export function soundsUnfinished(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (text.endsWith(",") || text.endsWith("…") || text.endsWith("...")) return true;
  if (/[.?!]["'”’)\]]*$/.test(text)) return false;
  const last = text.split(/[\s,]+/).filter(Boolean).pop() ?? "";
  return WORDS.has(last.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase());
}

/** The hold's wait for a line the Mac helper already waited its long window
 *  for (its final event carries `longEndpoint`): the owner has been silent
 *  2.8 s, so the hold adds only a short grace instead of stacking 1.2 s more.
 *  All of the hold's other behaviour (hold on, stop, the order of answers
 *  and approvals) is the same either way. */
export const LONG_ENDPOINT_HOLD_MS = 400;

/** Words in a line short enough that, with no sentence end, it is most
 *  likely only the start of one ("Sable, can you"). */
const SHORT_LINE_WORDS = 4;

/** What a room call holds for the rest: everything soundsUnfinished does,
 *  and a short line Apple closed without a sentence end. A room call has to
 *  catch "Sable, can you" ... "check the deploy" as one message, because a
 *  line sent to the room starts members working and cannot be taken back. */
export function soundsIncomplete(line: string): boolean {
  const text = line.trim();
  if (soundsUnfinished(text)) return true;
  if (/[.?!]["'”’)\]]*$/.test(text)) return false;
  return text.split(/\s+/).filter(Boolean).length <= SHORT_LINE_WORDS;
}

/** Asking for quiet: after a held line, the owner takes it back. */
const STOP_WORDS = /\b(stop|shut up|be quiet|quiet|hush|enough)\b/i;
/** Asking for a moment: the owner is thinking, the line stands. */
const HOLD_ON_WORDS = /\b(hold on|wait|pause)\b/i;

/** "Hold on", "wait" or "pause" after a held line, with no stop word
 *  anywhere in it: keep the line waiting. Any stop word wins ("wait,
 *  stop" and "no, wait, stop" take it back). */
export function holdsOn(line: string): boolean {
  return HOLD_ON_WORDS.test(line) && !STOP_WORDS.test(line);
}

/**
 * The owner's final line, held while it sounds unfinished. `take()` returns
 * the text to send now, joined to any line it continues, or null while it
 * waits; a held line is sent by `send` once the owner has not gone on
 * within CONTINUATION_WAIT_MS (or once the rest they began is not in by
 * CONTINUATION_CAP_MS).
 */
export class HeldLine {
  private text = "";
  private since = 0;
  /** How long from `since` more speech is waited for. */
  private cap = CONTINUATION_CAP_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (text: string) => void,
    /** True while more of the owner's speech, begun at or after `since`
     *  (epoch ms), is being recorded or transcribed. */
    private readonly pending: (since: number) => boolean,
    /** What counts as unfinished: a bot call's rule by default, a room
     *  call's broader one (soundsIncomplete) when given. */
    private readonly holds: (text: string) => boolean = soundsUnfinished,
    /** Trace sink: counts and states only (call-trace.ts). */
    private readonly trace: (label: string, fields?: Record<string, number | boolean>) => void = () => {},
  ) {}

  /** True while a line is waiting for the rest. */
  get holding(): boolean {
    return this.timer !== null;
  }

  /** `pausedAt`: when the owner stopped (the utterance's end), if known;
   *  otherwise the line's arrival. The cap runs from it. */
  take(line: string, pausedAt?: number, waitMs: number = CONTINUATION_WAIT_MS): string | null {
    const text = this.text ? `${this.text} ${line}` : line;
    this.clear();
    if (!this.holds(text)) return text;
    this.text = text;
    this.since = Math.min(pausedAt ?? Date.now(), Date.now());
    this.cap = CONTINUATION_CAP_MS;
    this.timer = setTimeout(this.check, waitMs);
    this.trace("hold start", { chars: text.length, waitMs });
    return null;
  }

  /** "Hold on", "wait", "pause" after a held line: the owner is thinking,
   *  not taking it back. The line keeps waiting, for up to HOLD_ON_MS and
   *  then for any line they have begun, so their next line joins it and the
   *  whole sentence is answered. Nothing held: nothing to do. */
  park(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.since = Date.now();
    this.cap = HOLD_ON_MS + CONTINUATION_CAP_MS;
    this.timer = setTimeout(this.check, HOLD_ON_MS);
  }

  private check = () => {
    this.timer = null;
    if (this.pending(this.since) && Date.now() - this.since < this.cap) {
      this.timer = setTimeout(this.check, CONTINUATION_CHECK_MS);
      this.trace("hold extend", { heldMs: Date.now() - this.since });
      return;
    }
    const text = this.text;
    this.text = "";
    if (text) {
      this.trace("hold send", { chars: text.length, heldMs: Date.now() - this.since });
      this.send(text);
    }
  };

  /** Forget the held line without sending it (a hold, "stop", hanging up). */
  drop(reason = "dropped"): void {
    if (this.text) this.trace(`hold drop ${reason}`, { chars: this.text.length });
    this.clear();
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.text = "";
  }
}

/**
 * Whether a new owner line joins the host turn still in flight. `sentAt`:
 * when that turn was sent; `playingAt`: when its reply began to sound, null
 * before; `began`: when the owner's new speech began (the bot pauses for it
 * then), or 0 when unknown.
 */
export function joinsTurn(turn: { sentAt: number; playingAt: number | null }, line: { began: number; now: number }): boolean {
  // nothing heard yet: asking both halves as one costs nothing
  if (turn.playingAt === null) return true;
  const began = line.began && line.now - line.began <= STALE_ONSET_MS ? line.began : line.now;
  const played = Math.max(0, Math.min(line.now, began) - turn.playingAt);
  return began - turn.sentAt < JOIN_WITHIN_MS && played < JOIN_PLAYED_MS;
}

/** Share of recent audio that must be speech for words heard over the bot
 *  to be the owner (music scores near zero). */
export const MIN_SPEECH_SHARE = 0.35;
/** A final over the bot needs at least this much speech in its utterance,
 *  in addition to the share bar. */
export const MIN_FINAL_SPEECH_MS = 250;
/** How much audio the mic keeps for its speech share (call-mic.ts `recent`). */
export const MIC_HISTORY_MS = 5_000;

/**
 * Whether words heard while the bot speaks are the owner talking over it.
 * A partial line is judged on the last moment (the trailing window and its
 * speech share). A FINAL lands well after the owner stopped (the endpoint
 * wait, the recognizer's own lag), so a trailing 1.5 s window reads it as
 * silence: it is judged on its own utterance instead, from where the owner
 * began (`began`, epoch ms, 0 when unknown), by the share of that utterance
 * that was speech. The span the mic remembers is only MIC_HISTORY_MS, so the
 * window never goes past it, and the endpoint wait (`endpointMs`, silence by
 * construction) is taken off the utterance's length. The same MIN_SPEECH_SHARE
 * bar as a partial applies, plus an absolute floor. `rejectedEarlier`: a
 * partial of this utterance was already turned away on its share (TV, echo),
 * which its final cannot overturn. A Flux line brings its own evidence.
 */
export function talkOverVerdict(input: {
  final: boolean;
  began: number;
  now: number;
  evidence: { heard: boolean; share: number } | undefined;
  /** The silence the endpointer waited before ending this utterance
   *  (fallback when the mic's last speech frame is unknown). */
  endpointMs?: number;
  /** How long ago the mic's last speech frame was (call-mic.ts
   *  lastSpeechAt): the utterance ends there, not at the recognizer's lag. */
  sinceSpeechMs?: number;
  rejectedEarlier?: boolean;
  speechWithin: (ms: number) => boolean | null;
  speechShare: (ms: number) => number | null;
}): { heard: boolean; share: number | null; accept: boolean } {
  const { final, began, now, evidence } = input;
  if (evidence) {
    const ok = evidence.share >= MIN_SPEECH_SHARE;
    return { heard: evidence.heard, share: evidence.share, accept: evidence.heard && ok };
  }
  if (final) {
    const endpoint = input.endpointMs ?? 0;
    const windowMs = began ? Math.min(12_000, Math.max(1_500, now - began + 400)) : 8_000;
    const heard = input.speechWithin(windowMs) !== false;
    const visible = Math.min(windowMs, MIC_HISTORY_MS);
    const raw = input.speechShare(visible);
    if (raw === null) return { heard, share: null, accept: heard && !input.rejectedEarlier };
    const speechMs = raw * visible;
    // the utterance as the mic can still see it: it ends at the mic's last
    // speech frame (the endpoint wait, the recognizer's lag and the final's
    // latency all come after it), or by the endpoint wait when that is unknown
    // never shorter than the endpoint wait: leftover bot echo can keep the
    // last speech frame fresh and would shrink the tail toward 0
    const tail = Math.max(endpoint, input.sinceSpeechMs ?? 0);
    const utteranceMs = began ? now - tail - began + 400 : visible - tail;
    const seen = Math.max(500, Math.min(utteranceMs, MIC_HISTORY_MS - tail));
    const share = Math.min(1, speechMs / seen);
    const ok = share >= MIN_SPEECH_SHARE && speechMs >= MIN_FINAL_SPEECH_MS;
    return { heard, share, accept: heard && ok && !input.rejectedEarlier };
  }
  const heard = input.speechWithin(1_500) !== false;
  const since = began ? now - began + 400 : 1_500;
  const share = input.speechShare(Math.min(1_500, Math.max(600, since)));
  return { heard, share, accept: heard && (share === null || share >= MIN_SPEECH_SHARE) };
}

const joinWords = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b);

const ruleWords = (t: string) =>
  t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[.,?!]+$/, ""))
    .filter(Boolean);

/**
 * THE shared segment rule (speech-helper.swift `restates`, speech.mjs
 * `restates`, and here): `text` restates `kept` when it is the same words, or
 * those words followed by more. By whole words, ignoring case and trailing
 * punctuation, so "No" is not restated by "Nothing else" and a closing "."
 * cannot double a segment. Used to drop a kept segment Apple re-sends, and to
 * tell a closed segment's revision from a new segment.
 */
export function restates(kept: string, text: string): boolean {
  const k = ruleWords(kept);
  if (!k.length) return false;
  const t = ruleWords(text);
  return t.length >= k.length && k.every((w, i) => w === t[i]);
}

/**
 * The words of one utterance across recognizer resets. Apple can reset its
 * transcript to "" mid-sentence and carry on: the text before the reset is
 * committed, the text since is current, and what is sent is both. Flux's
 * "…" (speech began, nothing transcribed) is never words.
 */
export class UtteranceWords {
  private committed = "";
  private current = "";

  push(text: string): void {
    const t = text.trim();
    if (t === "…") return;
    if (!t) {
      if (this.current) {
        this.committed = joinWords(this.committed, this.current);
        this.current = "";
      }
      return;
    }
    // a helper that already merges its segments, or Apple re-sending the kept
    // words a word at a time, starts with what we hold: not said twice
    if (restates(this.committed, text)) this.committed = "";
    this.current = text;
  }

  get text(): string {
    return joinWords(this.committed, this.current).trim();
  }

  /** The line's own final text, with whatever came before it. */
  final(text: string): string {
    this.push(text);
    return this.text;
  }

  clear(): void {
    this.committed = "";
    this.current = "";
  }
}

/** One `[call-diag]` line per turn: where the time from the owner's pause
 *  to the reply's first sound went. Numbers, keys and kinds only, never words. */
export function turnTiming(t: {
  endedAt?: number;
  lineAt: number;
  sentAt: number;
  firstSentenceAt: number | null;
  playingAt: number | null;
  /** The first clip's TTS request, response headers and first audio bytes. */
  ttsRequestedAt?: number | null;
  ttsHeadersAt?: number | null;
  ttsFirstByteAt?: number | null;
  piece?: "clause" | "sentence" | null;
  pieceChars?: number;
  player?: "native" | "mse" | "blob" | null;
  path?: "host" | "engine";
  /** When a cue started sounding, if one did. */
  ackAt?: number | null;
}): string {
  const ms = (from: number | null | undefined, to: number | null | undefined) => (from && to ? `${Math.max(0, to - from)}` : "-");
  const piece = t.piece ? `${t.piece}:${t.pieceChars ?? 0}` : "-";
  return [
    `[call-diag] turn timing: endpoint->transcript ${ms(t.endedAt, t.lineAt)} ms`,
    `transcript->sent ${ms(t.lineAt, t.sentAt)} ms`,
    `sent->host first sentence ${ms(t.sentAt, t.firstSentenceAt)} ms`,
    `piece->tts headers ${ms(t.ttsRequestedAt ?? t.firstSentenceAt, t.ttsHeadersAt)} ms`,
    `headers->first byte ${ms(t.ttsHeadersAt, t.ttsFirstByteAt)} ms`,
    `first byte->playing ${ms(t.ttsFirstByteAt, t.playingAt)} ms`,
    `->first clip playing ${ms(t.firstSentenceAt, t.playingAt)} ms`,
    `sent->playing ${ms(t.sentAt, t.playingAt)} ms`,
    `total ${ms(t.endedAt ?? t.lineAt, t.playingAt)} ms`,
    `piece=${piece}`,
    `player=${t.player ?? "-"}`,
    `path=${t.path ?? "host"}`,
    `ack=${ms(t.sentAt, t.ackAt)}`,
  ].join(", ");
}

/**
 * A spoken answer to an open question, through the thread's own respond
 * route — never the bot's current task, which may have moved on to another
 * one of the bot's threads between the ask and the answer. The call freezes
 * its thread for its whole lifetime (threadRef), so this takes it and the
 * request's own id directly, the same way `answerQuestion` already does for
 * a typed answer; the old path (dispatching `answerCard` by messageId) had
 * to re-find the card in the bot's LIVE messages, which a drifted task
 * doesn't have, and fell through to an ordinary message with no threadId —
 * a 409 from the server, and the owner's answer lost (callbar-rereview3.md
 * A2). Never throws. Resolves "sent"; "failed" when nothing landed for a
 * reason that may pass (network, 5xx, 408, 429), so the caller can put the
 * question back; or "refused" for a 4xx that will not change.
 */
export async function answerCallQuestion(
  threadId: string,
  requestId: string,
  said: string,
  fetchImpl?: typeof fetch,
): Promise<"sent" | "failed" | "refused"> {
  try {
    // The respond route refuses an answer unless the request proves it is the
    // desktop app (server mayApprove): the same proof every other call route
    // carries, resolved before the first request like the store's api().
    await ensureDesktopSurfaceSecret();
    const res = await (fetchImpl ?? fetch)(`/api/threads/${threadId}/respond`, {
      method: "POST",
      headers: callRouteHeaders(),
      body: JSON.stringify({ requestId, behavior: "answer", message: said }),
    });
    if (res.ok) return "sent";
    // a 5xx, a timeout or a rate limit may pass; any other 4xx (not allowed,
    // already settled) will not
    return res.status >= 500 || res.status === 408 || res.status === 429 ? "failed" : "refused";
  } catch {
    return "failed";
  }
}

/**
 * What a room's busy state does to a group call. The call is about the thread
 * it opened on (GroupCall freezes it), but `group` is the room's LIVE state:
 * a push that moves the room to another of its tasks must not let THAT task's
 * work park this call on "working" or hush its microphone, nor let its idling
 * start listening over this call's own running work. A drifted room therefore
 * keeps whatever the call last knew and changes nothing (callbar-rereview3.md
 * A3; the narration effect already had this guard, the microphone-controlling
 * busy effect did not). `step`: "work" parks the call and hushes recognition,
 * "listen" resumes it, "none" leaves both alone.
 */
export function groupBusyStep(o: {
  live: { threadId: string; working?: boolean; busyBotId?: string | null };
  frozenThreadId: string;
  lastBusy: boolean;
  phase: "listening" | "sending" | "working" | "speaking";
  /** An approval or question is open: the microphone stays for its answer. */
  asking: boolean;
  allowBargeIn: boolean;
}): { busy: boolean; step: "work" | "listen" | "none" } {
  if (o.live.threadId !== o.frozenThreadId) return { busy: o.lastBusy, step: "none" };
  const busy = Boolean(o.live.working || o.live.busyBotId);
  if (busy) {
    const work = (o.phase === "listening" || o.phase === "sending") && !o.asking && !o.allowBargeIn;
    return { busy, step: work ? "work" : "none" };
  }
  const listen = (o.phase === "working" || o.phase === "sending") && !o.asking;
  return { busy, step: listen ? "listen" : "none" };
}

/**
 * What a microphone session ending with an error does to a call (the branch
 * CallView's `onEnd` takes for `code === 1`). A failed or unreachable
 * transcription is a network matter, not a macOS permissions one: it says what
 * failed and listens again, rate-limited like a recognition-error restart so a
 * real fault still surfaces (callbar-rereview3.md A5). `note` null leaves the
 * note as it is; `listen` reopens the microphone.
 */
export function micEndStep(o: {
  code: number;
  reason?: string;
  hostOn: boolean;
  phase: "listening" | "sending" | "working" | "speaking";
  heard: boolean;
  sinceRestartMs: number;
}): { note: string | null; listen: boolean } {
  if (o.code === 1 && isTranscriptionFailure(o.reason)) {
    return { note: "Couldn't reach Murage to transcribe that.", listen: o.phase === "listening" && o.sinceRestartMs > 3_000 };
  }
  if (o.code === 1 && o.reason === "recognition-error" && o.hostOn && o.phase === "listening" && !o.heard && o.sinceRestartMs > 3_000) {
    return { note: null, listen: true };
  }
  return {
    note:
      o.reason === "helper-build-failed"
        ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
        : o.reason === "helper-stop-pending"
          ? "The previous dictation session is still closing. Try again in a moment."
          : isDictationDisabled(o.reason)
            ? dictationDisabledNote()
            : "Dictation needs Microphone + Speech Recognition access in System Settings.",
    listen: false,
  };
}
