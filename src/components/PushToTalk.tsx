import { Loader2, Mic } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

// Voice typing for every surface the native macOS helper cannot reach.
//
// WHAT THIS IS NOT
// ----------------
// It is not a replacement for `window.muragebox.speechStart`. On a Mac the
// Swift helper (`electron/resources/Murage Speech.app`) is faster, free, runs
// on-device and streams partials word by word into the composer. Nothing here
// should ever displace it. This is the path for the surfaces that have no
// helper at all: a phone browser through the companion door, a browser tab on
// another computer, and a Windows or Linux desktop.
//
// So the ENGINE CHOICE is not made in this file. It is made by the one flag
// that already distinguishes those surfaces — `capabilities.dictation.
// available` from `src/lib/desktop.ts`, which is true only when
// `window.muragebox.platform === "darwin"`. Composer.tsx already gates its
// native mic button on exactly that flag; this component is the else-branch
// of the same condition. One decision, in one place, and no surface can end
// up with two microphones or none.
//
// BATCH, NOT STREAMING — AND THE UI HAS TO SAY SO
// -----------------------------------------------
// Flux rejects `stream: true`. So this is hold-to-record, release, one round
// trip. Pretending otherwise would be the cruellest possible interface: the
// person speaks, nothing appears, and they assume it is broken. The two
// states are therefore visually different and both are named out loud —
// "Listening" while the mic is open, "Transcribing" while the clip is in
// flight — rather than one indicator doing double duty.
//
// CONTAINERS — MEASURED, NOT ASSUMED
// -----------------------------------
// `flux-voice.ts` prefers `.ogg` because the `flux-voice` auto-picker cannot
// probe the duration of a Matroska header and so always falls to the slow
// accuracy arm. That is real, and it does not apply here: the route pins
// `flux-voice-fast`, so no duration probe runs and the container no longer
// chooses the model.
//
// Which is fortunate, because ogg is not available. Measured on this machine
// rather than assumed:
//
//   Chromium 143 (the Electron engine, and Android Chrome's)
//     audio/ogg;codecs=opus  false
//     audio/webm;codecs=opus true
//     audio/mp4              true
//
//   Safari 26.3 / WebKit 605.1.15 (the iPhone's engine)
//     audio/ogg;codecs=opus  false
//     audio/webm;codecs=opus true
//     audio/mp4              true
//
// Neither engine that matters will record ogg. Firefox is the one that does,
// which is why ogg stays first in the preference list — but it is a bonus
// case, not the plan. webm/opus is what both phones actually produce, and
// with the arm pinned it is a fully supported path rather than a silent
// downgrade. Whatever MediaRecorder actually chose is what gets sent, and the
// route names the file from that content-type — never from a guess.
//
// SECURE CONTEXT
// --------------
// `getUserMedia` does not exist outside one. Over the tailnet with
// `tailscale serve --https=443` in front, that is satisfied. On the plain
// HTTP address the door serves before remote access is turned on, it is not,
// and no amount of pressing will change that. Showing a mic that cannot work
// is worse than showing none, so this says what is wrong and what to do about
// it — the same rule `install-prompt.ts` follows for the same reason.

/** The longest clip this will record before stopping itself.
 *
 * Not a byte limit — 8MB of Opus is roughly forty minutes, so the cap that
 * bites is time, not size. Two minutes is chosen against the companion
 * proxy's 30-second HEADER deadline (`companion/src/proxy.ts:85`): the phone
 * gets a 504 if the harness has not answered by then, and a two-minute clip
 * on the turbo arm returns in a few seconds with room to spare. A ten-minute
 * clip would not. */
export const MAX_CLIP_MS = 120_000;

/**
 * Containers to try, best first.
 *
 * ogg leads for Firefox, which is the only engine that offers it. webm/opus
 * is what Chromium and WebKit both actually give. mp4 is the fallback for a
 * WebKit old enough to predate its webm recorder. `null` means this browser
 * records nothing we can send, and the honest answer is no button.
 */
export const PREFERRED_TYPES = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/webm",
] as const;

/** Pure so the preference order can be tested without a browser. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of PREFERRED_TYPES) {
    if (isTypeSupported(type)) return type;
  }
  return null;
}

/** What this browser can be told about voice typing. */
export interface PushToTalkFacts {
  /** The native macOS helper is available. It is better; do not compete. */
  nativeDictation: boolean;
  /** A Flux key is configured on the workspace. */
  fluxConfigured: boolean;
  /** `window.isSecureContext`. */
  secure: boolean;
  /** MediaRecorder and getUserMedia both exist, and a container was found. */
  canRecord: boolean;
}

export type PushToTalkGate = "hidden" | "insecure" | "ready";
/**
 * Gather the four facts from the browser this is actually running in.
 *
 * Here rather than in the composer so the mount site is one element with two
 * props, and so `window.isSecureContext` and `MediaRecorder.isTypeSupported`
 * are read at the moment they are asked about — a module-level read would run
 * before anything and be wrong in a test rig that has no window at all.
 */
export function browserPushToTalkFacts(known: {
  nativeDictation: boolean;
  fluxConfigured: boolean;
}): PushToTalkFacts {
  const recorder = typeof MediaRecorder !== "undefined";
  const microphone = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  return {
    nativeDictation: known.nativeDictation,
    fluxConfigured: known.fluxConfigured,
    secure: typeof window !== "undefined" && window.isSecureContext,
    // A container we can name matters as much as a recorder existing: without
    // one the route would answer 415 and the button would be decoration.
    canRecord: recorder && microphone && pickMimeType((type) => MediaRecorder.isTypeSupported(type)) !== null,
  };
}


/**
 * Whether to offer voice typing, and if not, whether to say why.
 *
 * Only `insecure` gets a sentence, and that asymmetry is the point. Silence
 * is right when there is nothing the person can do — the native helper is
 * already handling it, or this browser simply cannot record — because an
 * explanation there is just noise attached to a control they never asked for.
 * An insecure context is the one case where something IS wrong, the fix is on
 * their own computer, and without being told they would conclude the feature
 * is broken. Same split `installInvite` draws, for the same reason.
 */
export function pushToTalkGate(facts: PushToTalkFacts): PushToTalkGate {
  if (facts.nativeDictation) return "hidden";
  if (!facts.canRecord) return "hidden";
  if (!facts.fluxConfigured) return "hidden";
  if (!facts.secure) return "insecure";
  return "ready";
}

/** The sentence for an insecure context. Names the setting as the settings
 *  page names it, so the instruction is followable.
 *
 *  It is reported through `onNote` rather than rendered as its own paragraph,
 *  because the composer already has exactly one place it puts this kind of
 *  sentence and `toggleMic` already writes into it for the same situation:
 *  "Dictation isn't available in this build." (`Composer.tsx:513`). One error
 *  surface, one voice, and no second banner competing with the first. */
export const INSECURE_NOTE =
  "Voice typing needs a secure address. Turn on “Serve on my tailnet” on your computer, then open Murage on the https link.";

/** A refusal reason from the route, mapped to something worth reading.
 *
 * The route sends `reason` alongside the status precisely so this does not
 * have to parse a sentence. `premium` is the one that must not be collapsed:
 * the key is valid and the plan is not, so "check your key" would send
 * someone round a loop they can never leave. */
export function noteForReason(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case "key":
      return "Add a Flux key in Settings on the computer to turn on voice typing.";
    case "premium":
      return "Voice typing needs a paid Flux plan. The key is fine — the plan doesn’t cover it yet.";
    case "auth":
      return "Flux rejected that key. Paste a fresh one in Settings on the computer.";
    case "unavailable":
      return "Voice typing isn’t switched on for this Flux account yet.";
    case "too_large":
      return "That was too long. Try again in shorter bursts.";
    case "rate_limit":
      return "Flux is busy right now. Wait a moment and try again.";
    default:
      return fallback;
  }
}

type Phase = "idle" | "listening" | "transcribing";

/** How long a clip may sit in flight before this gives up on it.
 *
 * Without a deadline a hung socket leaves the button disabled on
 * "Transcribing" forever, recoverable only by navigating away and back —
 * which on a phone reads as the app being broken.
 *
 * 45 seconds is chosen to sit just ABOVE the companion proxy's 30-second
 * header deadline (`companion/src/proxy.ts:85`), so on the phone path the
 * proxy's own 504 arrives first and the person gets its sentence rather than
 * a generic timeout. On a direct connection there is no proxy, and this is
 * the only backstop there is. A two-minute clip on the turbo arm returns in a
 * few seconds, so nothing that is actually working is cut off. */
export const CLIP_TIMEOUT_MS = 45_000;

/**
 * What happens to a finished clip, extracted from the component on purpose.
 *
 * The suite has no jsdom and no testing-library — `renderToStaticMarkup` is
 * the whole rig — so a decision that lives inside `MediaRecorder.onstop`
 * cannot be driven by a test at all. This is the decision that MUST be
 * driven: it is the one that used to throw away two minutes of speech.
 */
export interface ClipDelivery {
  transcribe: (clip: Blob) => Promise<{ text: string }>;
  /** Where the finished utterance goes. Called whether or not the button is
   *  still on screen — see below. */
  onTranscript: (text: string) => void;
  onNote?: (note: string | null) => void;
  /** Is the button still mounted? Gates the SPINNER, and nothing else. */
  mounted: () => boolean;
  setPhase: (phase: Phase) => void;
}

/**
 * Deliver a recorded clip, mounted or not.
 *
 * WHY `mounted` GATES THE SPINNER AND NOTHING ELSE
 * ------------------------------------------------
 * This used to be one `if (!alive.current) return;` covering the whole
 * branch, which was harmless for the native macOS helper — that path streams
 * partials into the composer as the person speaks, so an unmount loses at
 * most the last word. This path is BATCH. The composer's mount condition
 * drops this button the moment the draft has content, the bot goes busy, or
 * an attachment lands; a single character typed while the clip is in flight
 * therefore unmounted the button and silently discarded up to two minutes of
 * speech — no note, no error, nothing.
 *
 * The transcript belongs to the person, not to the button. `onTranscript`
 * and `onNote` write into the composer, which is still mounted, so they are
 * called unconditionally. Only `setPhase` — which drives a spinner on an
 * element that may no longer exist — is gated.
 */
export async function deliverClip(clip: Blob, deps: ClipDelivery): Promise<void> {
  if (!clip.size) {
    if (deps.mounted()) deps.setPhase("idle");
    return;
  }
  try {
    const result = await deps.transcribe(clip);
    if (deps.mounted()) deps.setPhase("idle");
    const text = result.text.trim();
    if (text) deps.onTranscript(text);
    else deps.onNote?.("Nothing was said in that recording.");
  } catch (error) {
    if (deps.mounted()) deps.setPhase("idle");
    const fallback = error instanceof Error ? error.message : String(error);
    deps.onNote?.(noteForReason((error as { reason?: string }).reason, fallback));
  }
}

export interface PushToTalkProps {
  /** Called with the finished utterance. The composer decides where it goes. */
  onTranscript: (text: string) => void;
  /** Reported so the composer can show it in the same place it shows the
   *  native dictation errors, rather than inventing a second error surface. */
  onNote?: (note: string | null) => void;
  facts: PushToTalkFacts;
  /** Injected by the test; production leaves it alone. */
  transcribe?: (clip: Blob) => Promise<{ text: string }>;
}

/**
 * POST the clip and read the answer.
 *
 * The Blob's own type is the content-type, unmodified, so the route names the
 * file from what MediaRecorder actually produced. Sending the bytes raw
 * rather than as multipart is what lets the route answer 413 from the
 * content-length before the upload starts.
 */
export async function postClip(clip: Blob, timeoutMs: number = CLIP_TIMEOUT_MS): Promise<{ text: string }> {
  // A deadline, because the button is DISABLED while this is outstanding. A
  // socket that never answers — a tailnet that dropped between the release
  // and the response is the ordinary way this happens — otherwise leaves
  // "Transcribing" on screen forever, and the only cure is a remount the
  // person has no way to ask for.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": clip.type || "application/octet-stream" },
      body: clip,
      signal: controller.signal,
    });
  } catch (error) {
    // An abort is our own deadline, and it gets a sentence about what to do
    // rather than the DOM's "signal is aborted without reason".
    if (controller.signal.aborted) throw new Error("That took too long to transcribe. Try again in shorter bursts.");
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(body?.error ?? "Transcribing failed."), { reason: body?.reason });
  }
  return { text: typeof body?.text === "string" ? body.text : "" };
}

/**
 * Hold to talk. One clip, one round trip, one finished utterance.
 *
 * Pointer capture is what keeps a held button honest: without it, sliding a
 * thumb off the control mid-sentence loses the pointerup and leaves the
 * microphone open with nothing listening for the release.
 */
export function PushToTalk({ onTranscript, onNote, facts, transcribe = postClip }: PushToTalkProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // The LATEST composer callbacks, not the ones captured when recording
  // started. `active.onstop` is assigned once, at the top of the press; the
  // composer's `onTranscript` closes over its own `text`, and that text can
  // change while the clip is in flight. Calling the captured one would append
  // to a stale draft and overwrite whatever the person typed in the meantime.
  const latest = useRef({ onTranscript, onNote });
  latest.current = { onTranscript, onNote };
  const gate = pushToTalkGate(facts);

  const release = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
    chunks.current = [];
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // The microphone must not outlive the composer. A recorder left running
      // holds the OS indicator on and keeps the tab marked as recording.
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      release();
    };
  }, [release]);

  const stop = useCallback(() => {
    const active = recorder.current;
    if (!active || active.state === "inactive") return;
    // Moving to "transcribing" HERE, on release rather than on the response,
    // is what makes the batch nature legible: the pulse stops the instant the
    // finger lifts and is replaced by a spinner that is plainly a different
    // thing happening.
    setPhase("transcribing");
    active.stop();
  }, []);

  const start = useCallback(async () => {
    if (gate !== "ready" || phase !== "idle") return;
    onNote?.(null);
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      // Matches the sentence the call view already uses for the same refusal,
      // minus the Speech Recognition half, which is a macOS-only permission.
      onNote?.("The microphone couldn’t start. Allow microphone access for this site and try again.");
      return;
    }
    if (!alive.current) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    stream.current = mic;
    chunks.current = [];
    const active = new MediaRecorder(mic, mimeType ? { mimeType } : undefined);
    recorder.current = active;
    active.ondataavailable = (event) => {
      if (event.data.size) chunks.current.push(event.data);
    };
    active.onstop = () => {
      // `active.mimeType` and not the requested one: what the recorder
      // actually settled on is what the bytes are, and the route names the
      // file from this. A wrong name is a guaranteed 400 after a full upload.
      const clip = new Blob(chunks.current, { type: active.mimeType || mimeType || "audio/webm" });
      release();
      // Deliberately NOT gated on `alive.current`. The unmount cleanup below
      // stops a running recorder, which lands here — and a clip that has been
      // recorded must reach the composer or say why, never evaporate.
      void deliverClip(clip, {
        transcribe,
        onTranscript: (said) => latest.current.onTranscript(said),
        onNote: (note) => latest.current.onNote?.(note),
        mounted: () => alive.current,
        setPhase,
      });
    };
    active.start();
    setPhase("listening");
    // A held button can be forgotten. Stopping ourselves keeps a pocket from
    // uploading two minutes of nothing, and keeps the round trip inside the
    // proxy's header deadline.
    timer.current = setTimeout(stop, MAX_CLIP_MS);
  }, [gate, onNote, phase, release, stop, transcribe]);

  if (gate === "hidden") return null;
  if (gate === "insecure") {
    // Not a dead button, and not a hidden feature either. Pressing it says
    // what is wrong and what to do — the same thing `toggleMic` does when the
    // native helper is missing, into the same banner. Muted, and labelled as
    // unavailable, so a screen reader is told before the press rather than
    // after it.
    return (
      <button
        type="button"
        aria-label="Voice typing unavailable — tap to find out why"
        title={INSECURE_NOTE}
        onClick={() => onNote?.(INSECURE_NOTE)}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary/40 hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <Mic size={18} />
      </button>
    );
  }

  const listening = phase === "listening";
  const transcribing = phase === "transcribing";
  return (
    <button
      type="button"
      disabled={transcribing}
      aria-label={listening ? "Listening — release to transcribe" : transcribing ? "Transcribing" : "Hold to talk"}
      title={listening ? "Release to transcribe" : transcribing ? "Transcribing…" : "Hold to talk"}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        void start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      // Keyboard parity: a held Space or Enter is the same gesture, and
      // without it this control is unreachable without a pointer.
      onKeyDown={(event) => {
        if (event.repeat || (event.key !== " " && event.key !== "Enter")) return;
        event.preventDefault();
        void start();
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        stop();
      }}
      onBlur={stop}
      className={cn(
        "flex size-8 shrink-0 touch-none select-none items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-accent/70",
        listening
          ? "animate-pulse bg-danger/20 text-danger"
          : transcribing
            ? "bg-raised text-ink-secondary"
            : "text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {transcribing ? <Loader2 size={16} className="animate-spin" /> : <Mic size={18} />}
      <span className="sr-only">{listening ? "Listening" : transcribing ? "Transcribing" : "Hold to talk"}</span>
    </button>
  );
}
