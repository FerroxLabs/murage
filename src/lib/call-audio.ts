// Where a call's audio goes: the desktop's (and Android's, and a browser's)
// getUserMedia plus <audio>, or the iPhone shell's own voice-processing
// engine (spec §4.3.2). CallView owns one of these per call.
//
// The choice is made in open(), never at render, because an app build only
// counts as able once hello() has answered. On the native path the page makes
// no sound of its own (§4.3.3): page media is paused before callAudioOpen,
// the replies go through player(), and the working pulse through pulse().
// Nothing here builds an AudioContext or an Audio element on that path.
//
// When native says no:
//   - denied: open() rejects with code "denied"; the call shows the Settings
//     note and "Try again" calls open() again, still natively;
//   - inactive: the app was not active (native already waited up to 2 s for
//     it to become active); tried once more on the app's next resume event
//     or after INACTIVE_RETRY_MS, whichever comes first (an interruption
//     during the open can answer inactive with no resume to follow), then
//     the web path;
//   - unavailable: the web path at once, logged.
// After `lost` (the engine could not come back from a hold), reopen() closes
// and reopens the SOURCE only, so the microphone's listeners stay.

import { nativeCallAudioWanted } from "./call-audio-native";
import { createCallMic, NativeFrameSource, type CallMic, type FrameSource, type NativeOpenError } from "./call-mic";
import { callNative, onNativeEvent } from "./native-shell";
import { pauseAllPageMedia } from "./page-media";
import { StreamMic } from "./stream-mic";
import { NativeClipPlayer } from "./tts/native-player";

export type CallAudioPath = "native" | "web";

/** The call's microphone for a recognizer kind; "stream" is Flux with
 *  streaming end of turn. Lives here, not in call-mic.ts, so call-mic never
 *  imports the class that extends it. */
export function micFor(kind: CallMic["kind"] | "stream", options: { source?: FrameSource } = {}): CallMic {
  return kind === "stream" ? new StreamMic(options.source) : createCallMic(kind, options);
}

/** How long an `inactive` open waits for the app's resume before it tries
 *  again anyway. */
export const INACTIVE_RETRY_MS = 3_000;

/** How long a hold lasts on screen before the call offers "Resume call",
 *  the same reopen as after `lost`. Nothing on the phone is guaranteed to
 *  end a hold: a call declined from the banner may post no `.ended`, and
 *  the app never left, so no return follows either. */
export const HELD_RESUME_OFFER_MS = 5_000;

/** The part of `document` the offer watches. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** While a hold lasts: `offer(true)` once the page has been on screen for
 *  HELD_RESUME_OFFER_MS, `offer(false)` when it is hidden again. Time off
 *  screen does not count (the app's own return restarts the engine), so the
 *  count starts over on return. Returns the stop, for when the hold ends. */
export function offerResumeWhenHeld(
  offer: (show: boolean) => void,
  doc: VisibilitySource | null = globalThis.document ?? null,
  ms = HELD_RESUME_OFFER_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(timer);
    timer = undefined;
    if (doc && doc.visibilityState !== "visible") return offer(false);
    timer = setTimeout(() => offer(true), ms);
  };
  doc?.addEventListener("visibilitychange", watch);
  watch();
  return () => {
    clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", watch);
  };
}

export interface CallAudioOptions {
  /** The recognizer this device uses, given whether capture is possible. */
  kindFor(capture: boolean): CallMic["kind"] | "stream" | null;
  /** The microphone built at render, for the web path. */
  web: CallMic;
}

function closedError(): Error & { code: "closed" } {
  return Object.assign(new Error("closed"), { code: "closed" as const });
}

export class CallAudio {
  /** The call's microphone: the web one until the native path is chosen. */
  mic: CallMic;
  /** The native engine's session source, on the native path only. */
  source: NativeFrameSource | null = null;
  /** null until open() has chosen. */
  path: CallAudioPath | null = null;
  private readonly web: CallMic;
  private readonly kindFor: CallAudioOptions["kindFor"];
  private choosing: Promise<void> | null = null;
  /** The pulse state native was last told; native forgets it on a hold. */
  private pulsing = false;
  /** Mute belongs to the call, not to whichever microphone happens to be
   *  live: choose()'s native swap and fallBack()'s web one both create a
   *  fresh CallMic whose own `muted` defaults false, so a mute set while
   *  either is in flight must be reapplied to the one that lands
   *  (callbar-rereview3.md A1). */
  private muted = false;
  /** Ends a wait for the app's resume, so a closed call never opens. */
  private stopWaiting: (() => void) | null = null;
  /** Bumped by close(). An open that began before it never opens anything
   *  after it, and closes what it did open: a call hung up while hello is
   *  still pending must not leave a microphone running after the page. */
  private closes = 0;

  constructor(options: CallAudioOptions) {
    this.web = options.web;
    this.mic = options.web;
    this.kindFor = options.kindFor;
  }

  private async choose(): Promise<void> {
    // Apple's recognizer is a Mac's, and a Mac never has the native engine:
    // it is not even asked, so a desktop call starts exactly as before.
    const kind = this.kindFor(true);
    const native = (kind === "flux" || kind === "stream") && (await nativeCallAudioWanted());
    if (native) {
      this.source = new NativeFrameSource();
      this.mic = micFor(kind, { source: this.source });
      this.mic.setMuted(this.muted);
      this.path = "native";
    } else {
      this.path = "web";
    }
  }

  /** The call's mute. Applied to whichever microphone is live now, and
   *  remembered for the next one if choose() or fallBack() replaces it
   *  before this one has even opened. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.mic.setMuted(muted);
  }

  /** The path, once chosen (before the microphone is open). */
  async chosen(): Promise<CallAudioPath> {
    this.choosing ??= this.choose();
    await this.choosing;
    return this.path ?? "web";
  }

  /** Opens the call's microphone on the chosen path. Rejects with the web
   *  path's own error, with code "denied" on the native path, or with code
   *  "closed" when close() came first. */
  async open(): Promise<void> {
    const closes = this.closes;
    const stillOpen = () => {
      if (closes !== this.closes) throw closedError();
    };
    this.choosing ??= this.choose();
    await this.choosing;
    stillOpen();
    if (this.path === "native") {
      try {
        await this.openNative(stillOpen);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "denied" || code === "closed") throw error;
        stillOpen();
        this.fallBack();
      }
    }
    if (this.path === "web") await this.mic.open();
    if (closes !== this.closes) {
      // hung up while it opened: nothing may outlive the call
      this.mic.close();
      throw closedError();
    }
  }

  private async openNative(stillOpen: () => void): Promise<void> {
    if (this.source?.opened) return this.mic.open();
    pauseAllPageMedia();
    try {
      await this.mic.open();
    } catch (error) {
      if ((error as NativeOpenError).code !== "inactive") throw error;
      // not active yet (a transition, Control Center, an alarm): once more on
      // return, or in a moment if no return comes; never after a hang-up
      stillOpen();
      await this.resumeOrTimeout();
      stillOpen();
      pauseAllPageMedia();
      await this.mic.open();
    }
  }

  private resumeOrTimeout(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.stopWaiting = null;
        off();
        clearTimeout(timer);
      };
      const off = onNativeEvent("resume", () => {
        done();
        resolve();
      });
      const timer = setTimeout(() => {
        done();
        resolve();
      }, INACTIVE_RETRY_MS);
      this.stopWaiting = () => {
        done();
        reject(closedError());
      };
    });
  }

  /** The engine cannot run: today's web path for the rest of the call. */
  private fallBack() {
    console.warn("[call-diag] audio web, native unavailable");
    this.source?.close();
    this.source = null;
    this.mic.close();
    this.mic = this.web;
    this.mic.setMuted(this.muted);
    this.path = "web";
    this.pulsing = false;
  }

  /** A player for the open native session, or null on the web path. Each
   *  session gets its own. */
  player(): NativeClipPlayer | null {
    const source = this.source;
    const session = source?.session;
    if (!source || !session) return null;
    return new NativeClipPlayer({ session, onEvent: (fn) => source.onEvent(fn) });
  }

  /** "Resume call" after `lost`: a new session on the same microphone. */
  async reopen(): Promise<void> {
    const source = this.source;
    if (!source) throw closedError();
    source.close();
    this.pulsing = false;
    pauseAllPageMedia();
    await this.mic.open();
  }

  /** The working pulse, played natively. Sent only on a change; a no-op on
   *  the web path, where CallView plays its own. */
  pulse(on: boolean): void {
    const session = this.path === "native" ? this.source?.session : null;
    if (!session || this.pulsing === on) return;
    this.pulsing = on;
    void callNative("callAudioControl", { session, action: on ? "pulseOn" : "pulseOff" }).catch(() => undefined);
  }

  /** Closes the microphone (and the native session). CallView's StrictMode
   *  probe opens it again, as it does the web microphone. */
  close(): void {
    this.closes += 1;
    this.stopWaiting?.();
    this.pulsing = false;
    this.mic.close();
  }
}
