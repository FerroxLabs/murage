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
  | "setBadgeCount";

export type NativeEventName = "resume" | "pause" | "notificationOpened" | "backButton";

export interface NativeHello {
  version: number;
  methods: readonly NativeMethod[];
}

export interface NotificationOpened {
  bindingId?: string;
  threadId: string;
  messageId?: string;
}

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

/** Subscribe to one of the app's events. Returns the unsubscribe, which is
 * always safe to call. A bridge without `on()` simply never fires. */
export function onNativeEvent(name: "notificationOpened", listener: (opened: NotificationOpened) => void): () => void;
export function onNativeEvent(name: Exclude<NativeEventName, "notificationOpened">, listener: () => void): () => void;
export function onNativeEvent(
  name: NativeEventName,
  listener: ((opened: NotificationOpened) => void) | (() => void),
): () => void {
  const native = bridge();
  if (!native || typeof native.on !== "function") return () => {};
  let active = true;
  let off: unknown;
  try {
    const call = listener as (opened?: NotificationOpened) => void;
    off = (native.on as (event: string, handler: (detail?: unknown) => void) => unknown)(name, (detail) => {
      if (!active) return;
      if (name !== "notificationOpened") {
        call();
        return;
      }
      const opened = parseNotificationOpened(detail);
      if (opened) call(opened);
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
