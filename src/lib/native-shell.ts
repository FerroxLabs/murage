// The phone app's channel into this page, as the page sees it.
//
// The phone app loads this same bundle from the user's own Murage and injects
// `window.murageNative` at document start, in the main frame only, for the
// saved origin only (spec §2, §3.2). Everything on it is OPTIONAL from here:
// an older app, or an Android WebView without WEB_MESSAGE_LISTENER and
// DOCUMENT_START_SCRIPT, hands the page fewer methods or none at all, and the
// page must still be the ordinary web UI. So nothing is assumed. `hello()`
// lists what this app build supports, and a method counts only when it is
// both listed and actually present.
//
// `window.muragebox` is the DESKTOP (Electron's preload) and is never read
// here. The two bridges answer different questions; conflating them would
// hand a phone desktop-only affordances, which is the bug use-surface.ts
// exists to prevent.

/** The user agent token both workspace WebViews add (spec §3.2). It is the
 * one signal that exists before `hello()` answers and on a channel that
 * failed closed, which is exactly when the install prompt must already be
 * hidden. */
export const NATIVE_UA_TOKEN = "MurageApp/";

/** Native answers in a few milliseconds. A bridge that has not answered in
 * this long is treated as absent, not waited on. */
export const NATIVE_HELLO_TIMEOUT_MS = 1_500;

const MAX_METHODS = 64;
const MAX_ID = 512;

export type NativeMethod =
  | "ready"
  | "registerPush"
  | "pushStatus"
  | "issuePushTokens"
  | "saveFile"
  | "openExternal"
  | "haptic"
  | "appLock"
  | "signOut"
  | "rePair"
  | "setBadgeCount"
  // Plan 2: native remembers the open thread (Decision 2) and can show its
  // list of computers. Additive; an older app simply does not list them.
  | "setRoute"
  | "showLauncher"
  // iPhone native call audio (spec §4.1). iOS only: an older app, or
  // Android, simply never lists them, and the call falls back to the web
  // path (spec §4.3.2).
  | "callAudioOpen"
  | "callAudioClose"
  | "callAudioPlay"
  | "callAudioControl"
  // Both platforms now (callbar-rereview.md M4; callbar-rereview2.md G3):
  // this is the page telling native, fire-and-forget, that a call is open
  // or has really ended, so a notification tap's reload can keep the
  // route pending instead of silently ending the call the
  // moss-approval-bug way. Started as Android's own addition — Android's
  // native layer has no call-audio engine of its own and so no other way
  // to know a call is live — but iOS needs it too: its own native
  // call-audio session closes and reopens on every `lost`, Resume and a
  // retry's stale close, none of which are a real hang-up, so it cannot
  // tell when to actually deliver a held route. An older app simply never
  // lists it.
  | "callSessionOpen"
  | "callSessionClose"
  // Both platforms: one `[call-diag]` or `[call-trace]` console line, kept
  // in a file on the device so a device call test leaves a readable record
  // (src/lib/call-diag-forward.ts). A string argument, counts and enums only.
  | "diagLine"
  // SEC-006: native fresh authentication for a high-risk Allow. Both platforms; an older app never lists it and the page says to update.
  | "approveWithDevice";

export type NativeEventName = "resume" | "pause" | "notificationOpened" | "backButton" | "callAudio";

export interface NativeHello {
  version: number;
  methods: readonly NativeMethod[];
}

export interface NotificationOpened {
  bindingId?: string;
  threadId: string;
  messageId?: string;
}

/** The reply to `callAudioOpen`, sent once the microphone is running (spec
 * §4.1). */
export interface CallAudioOpened {
  session: string;
  sampleRate: 16000;
  frame: 1024;
}

/** The `callAudio` event's detail shapes (spec §4.1). Every variant carries
 * the open's `session`, so a stray event from a session the page already
 * closed can be told apart from the current one. */
export type CallAudioEvent =
  | { type: "mic"; session: string; pcm: string }
  | { type: "clip"; session: string; clip: string; state: "playing" | "progress" | "ended" | "failed" | "cut"; reason?: "stop" | "hold" | "next" }
  | { type: "hold"; session: string; reason: "interrupted" | "background" | "media-reset" }
  | { type: "resume"; session: string }
  | { type: "lost"; session: string; reason: string }
  | { type: "route"; session: string; output: "speaker" | "receiver" | "headphones" | "bluetooth" | "other" };

const KNOWN_METHODS: ReadonlySet<string> = new Set<NativeMethod>([
  "ready",
  "registerPush",
  "pushStatus",
  "issuePushTokens",
  "saveFile",
  "openExternal",
  "haptic",
  "appLock",
  "signOut",
  "rePair",
  "setBadgeCount",
  "setRoute",
  "showLauncher",
  "callAudioOpen",
  "callAudioClose",
  "callAudioPlay",
  "callAudioControl",
  "callSessionOpen",
  "callSessionClose",
  "diagLine",
  "approveWithDevice",
]);

type Bridge = Record<string, unknown> & { hello: () => unknown };

function bridge(): Bridge | null {
  const candidate = (globalThis as { murageNative?: unknown }).murageNative;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof (candidate as { hello?: unknown }).hello === "function" ? (candidate as Bridge) : null;
}

export function hasNativeUserAgent(userAgent: string = globalThis.navigator?.userAgent ?? ""): boolean {
  return userAgent.includes(NATIVE_UA_TOKEN);
}

/** Inside the phone app at all, whatever it can do. Synchronous, for the
 * first render. */
export function inNativeShell(): boolean {
  return bridge() !== null || hasNativeUserAgent();
}

let greeting: NativeHello | null = null;
let pendingHello: Promise<NativeHello | null> | null = null;

/** Unknown method names are dropped rather than trusted: a newer app may list
 * something this page has no code for, and an older page must not call it. */
export function parseNativeHello(value: unknown): NativeHello | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, methods } = value as { version?: unknown; methods?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (!Array.isArray(methods)) return null;
  const known = methods
    .slice(0, MAX_METHODS)
    .filter((method): method is NativeMethod => typeof method === "string" && KNOWN_METHODS.has(method));
  return { version, methods: [...new Set(known)] };
}

/** Ask once. A failure or a timeout answers null and is not remembered, so a
 * later caller may ask again; a real answer is remembered for the page. */
export function nativeHello(timeoutMs = NATIVE_HELLO_TIMEOUT_MS): Promise<NativeHello | null> {
  if (greeting) return Promise.resolve(greeting);
  const native = bridge();
  if (!native) return Promise.resolve(null);
  pendingHello ??= new Promise<NativeHello | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    let answer: unknown;
    try {
      answer = native.hello();
    } catch {
      answer = null;
    }
    Promise.resolve(answer).then(
      (value) => {
        clearTimeout(timer);
        greeting = parseNativeHello(value);
        resolve(greeting);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  }).finally(() => {
    pendingHello = null;
  });
  return pendingHello;
}

export function nativeHas(method: NativeMethod): boolean {
  const native = bridge();
  return Boolean(native && greeting?.methods.includes(method) && typeof native[method] === "function");
}

export async function nativeAvailable(method: NativeMethod): Promise<boolean> {
  await nativeHello();
  return nativeHas(method);
}

export async function callNative(method: NativeMethod, ...args: unknown[]): Promise<unknown> {
  await nativeHello();
  const native = bridge();
  if (!native || !nativeHas(method)) {
    throw Object.assign(new Error(`This version of the app cannot ${method}.`), { code: "native-unavailable" });
  }
  return (native[method] as (...values: unknown[]) => unknown)(...args);
}

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

export function parseNotificationOpened(value: unknown): NotificationOpened | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { bindingId, threadId, messageId } = value as Record<string, unknown>;
  if (!id(threadId)) return null;
  return {
    ...(id(bindingId) ? { bindingId } : {}),
    threadId,
    ...(id(messageId) ? { messageId } : {}),
  };
}

const MAX_CALL_AUDIO_PCM = 8_192;

const CALL_AUDIO_CLIP_STATES = new Set(["playing", "progress", "ended", "failed", "cut"]);
const CALL_AUDIO_CLIP_CUT_REASONS = new Set(["stop", "hold", "next"]);
const CALL_AUDIO_HOLD_REASONS = new Set(["interrupted", "background", "media-reset"]);
const CALL_AUDIO_ROUTE_OUTPUTS = new Set(["speaker", "receiver", "headphones", "bluetooth", "other"]);

const isCallAudioClipState = (value: unknown): value is Extract<CallAudioEvent, { type: "clip" }>["state"] =>
  typeof value === "string" && CALL_AUDIO_CLIP_STATES.has(value);
const isCallAudioClipCutReason = (value: unknown): value is "stop" | "hold" | "next" =>
  typeof value === "string" && CALL_AUDIO_CLIP_CUT_REASONS.has(value);
const isCallAudioHoldReason = (value: unknown): value is Extract<CallAudioEvent, { type: "hold" }>["reason"] =>
  typeof value === "string" && CALL_AUDIO_HOLD_REASONS.has(value);
const isCallAudioRouteOutput = (value: unknown): value is Extract<CallAudioEvent, { type: "route" }>["output"] =>
  typeof value === "string" && CALL_AUDIO_ROUTE_OUTPUTS.has(value);

/** Drops anything native did not send exactly as spec §4.1 describes: an
 * unknown `type`, a missing or wrong-typed field, or a `session`/`clip` past
 * its id cap or a `pcm` past its own (2,048 bytes of PCM is about 2.7 KB of
 * base64 text, so 8,192 chars leaves headroom without accepting anything
 * unbounded). Nothing here is trusted enough to widen without a matching
 * case in `CallAudioEvent`. */
export function parseCallAudioEvent(value: unknown): CallAudioEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const session = detail.session;
  if (!id(session)) return null;
  switch (detail.type) {
    case "mic": {
      const pcm = detail.pcm;
      if (typeof pcm !== "string" || pcm.length > MAX_CALL_AUDIO_PCM) return null;
      return { type: "mic", session, pcm };
    }
    case "clip": {
      const clip = detail.clip;
      const state = detail.state;
      if (!id(clip) || !isCallAudioClipState(state)) return null;
      // reason is only meaningful with state "cut" (spec §4.1 rev 3); an
      // unrecognised reason is dropped on its own, not the whole event, and
      // a reason sent alongside any other state is ignored outright.
      if (state === "cut" && isCallAudioClipCutReason(detail.reason)) {
        return { type: "clip", session, clip, state, reason: detail.reason };
      }
      return { type: "clip", session, clip, state };
    }
    case "hold": {
      const reason = detail.reason;
      if (!isCallAudioHoldReason(reason)) return null;
      return { type: "hold", session, reason };
    }
    case "resume":
      return { type: "resume", session };
    case "lost": {
      const reason = detail.reason;
      if (typeof reason !== "string" || reason.length === 0) return null;
      return { type: "lost", session, reason };
    }
    case "route": {
      const output = detail.output;
      if (!isCallAudioRouteOutput(output)) return null;
      return { type: "route", session, output };
    }
    default:
      return null;
  }
}

/** Subscribe to one of the app's events. Returns the unsubscribe, which is
 * always safe to call. A bridge without `on()` simply never fires.
 *
 * The wrapper handed to native's `on()` answers `true` for
 * `notificationOpened` and `callAudio` exactly when the payload parsed, the
 * subscription is still active, and the listener ran without throwing;
 * otherwise it answers nothing. The native shells (`ChannelScript.java` /
 * `.swift`) treat any other answer as unhandled: for `notificationOpened`
 * that means a full reload onto the notification's thread route instead of
 * the page updating in place; for `callAudio` it feeds the mic liveness
 * watchdog (spec §4.2.7) — after 32 consecutive unhandled mic events (about
 * 2 s) native closes the engine, on the theory that nothing is listening.
 * Other events (`resume`, `pause`, `backButton`) always answer nothing,
 * whatever the listener returns. */
export function onNativeEvent(name: "notificationOpened", listener: (opened: NotificationOpened) => void): () => void;
export function onNativeEvent(name: "callAudio", listener: (event: CallAudioEvent) => void): () => void;
export function onNativeEvent(
  name: Exclude<NativeEventName, "notificationOpened" | "callAudio">,
  listener: () => void,
): () => void;
export function onNativeEvent(
  name: NativeEventName,
  listener: ((opened: NotificationOpened) => void) | ((event: CallAudioEvent) => void) | (() => void),
): () => void {
  const native = bridge();
  if (!native || typeof native.on !== "function") return () => {};
  let active = true;
  let off: unknown;
  try {
    off = (native.on as (event: string, handler: (detail?: unknown) => unknown) => unknown)(name, (detail) => {
      if (!active) return;
      if (name === "notificationOpened") {
        const opened = parseNotificationOpened(detail);
        if (!opened) return;
        try {
          (listener as (opened: NotificationOpened) => void)(opened);
        } catch {
          return;
        }
        return true;
      }
      if (name === "callAudio") {
        const event = parseCallAudioEvent(detail);
        if (!event) return;
        try {
          (listener as (event: CallAudioEvent) => void)(event);
        } catch {
          return;
        }
        return true;
      }
      (listener as () => void)();
      return;
    });
  } catch {
    return () => {};
  }
  return () => {
    active = false;
    if (typeof off !== "function") return;
    try {
      off();
    } catch {
      /* a torn-down bridge has nothing left to unsubscribe */
    }
  };
}

/** Test seam; the renderer never calls this. */
export function resetNativeShellForTest(): void {
  greeting = null;
  pendingHello = null;
}
