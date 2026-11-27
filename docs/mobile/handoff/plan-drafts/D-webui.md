# Group D — Web UI plumbing (spec §3.6 "Plumbing")

Scope: spec §3.6 **Plumbing** only. Not phone polish, not presence reporting.
Base: `mobile/v1` @ `121c79fb` (58 commits behind `next/0160`; every line number below is
from `mobile/v1` HEAD and must be re-checked after any rebase).

Test environment facts that shape every task below (read, not assumed):

- `vite.config.ts:11-21` runs vitest with `environment: "node"` and only `*.test.ts` files.
  There is no jsdom and no testing-library. Behaviour is tested through pure functions with
  injected globals (`vi.stubGlobal`), the pattern `conversation-export.test.ts:4-17` and
  `live-events.test.ts:21-99` already use. React wiring is pinned by reading the component
  source, the pattern `install-prompt.test.ts:73-95` and `composer-key-guard.test.ts:28-43`
  already use.
- Commit style on `next/0160`: `type(scope): plain sentence` (e.g. `fix(security): …`).

Order: D1 first (everything consumes it), then D2 → D3 → D4. D5–D15 depend only on D1
(and D6 → D7, D9 → D10).

---

### Task D1: Native shell detection (`src/lib/native-shell.ts`)

**Files:**
- Create: `src/lib/native-shell.ts`
- Modify: `src/main.tsx:22-24` (kick off `hello()` at boot)
- Test: `src/lib/native-shell.test.ts`

**Interfaces:**
- Consumes: `globalThis.murageNative` (the object the phone app's document-start script
  injects, spec §3.2) and `navigator.userAgent`. Never reads `window.muragebox`.
- Produces (exact names later tasks import):
  - `NATIVE_UA_TOKEN = "MurageApp/"`, `NATIVE_HELLO_TIMEOUT_MS = 1_500`
  - `type NativeMethod = "ready" | "registerPush" | "pushStatus" | "issuePushTokens" | "saveFile" | "openExternal" | "haptic" | "appLock" | "signOut" | "rePair" | "setBadgeCount"`
  - `type NativeEventName = "resume" | "pause" | "notificationOpened" | "backButton"`
  - `interface NativeHello { version: number; methods: readonly NativeMethod[] }`
  - `interface NotificationOpened { bindingId?: string; threadId: string; messageId?: string }`
  - `hasNativeUserAgent(userAgent?: string): boolean`
  - `inNativeShell(): boolean` — synchronous; bridge present OR UA token
  - `parseNativeHello(value: unknown): NativeHello | null`
  - `nativeHello(timeoutMs?: number): Promise<NativeHello | null>` — single-flight, bounded
  - `nativeHas(method: NativeMethod): boolean` — synchronous, true only after `hello()` listed it AND the function exists
  - `nativeAvailable(method: NativeMethod): Promise<boolean>`
  - `callNative(method: NativeMethod, ...args: unknown[]): Promise<unknown>` — rejects with `code: "native-unavailable"` when not advertised
  - `onNativeEvent(name, listener): () => void` — via `murageNative.on(name, listener)`; `notificationOpened` payloads are validated
  - `parseNotificationOpened(value: unknown): NotificationOpened | null`
  - `resetNativeShellForTest(): void`

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/native-shell.test.ts
// The phone app's channel, as the page sees it. Nothing here may assume a
// method exists: an older app, or an Android WebView missing a feature,
// hands the page less than the newest one does (spec §3.2).
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callNative,
  hasNativeUserAgent,
  inNativeShell,
  nativeAvailable,
  nativeHas,
  nativeHello,
  onNativeEvent,
  parseNativeHello,
  parseNotificationOpened,
  resetNativeShellForTest,
} from "./native-shell";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeBridge(hello: unknown, extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(detail?: unknown) => void>>();
  const bridge = {
    hello: vi.fn(async () => hello),
    on: vi.fn((name: string, listener: (detail?: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    }),
    emit(name: string, detail?: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(detail);
    },
    ...extra,
  };
  vi.stubGlobal("murageNative", bridge);
  return bridge;
}

describe("knowing we are inside the phone app", () => {
  it("reads the user agent token, which works before hello() and on a fail-closed channel", () => {
    expect(hasNativeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) MurageApp/1.0.0 (android)")).toBe(true);
    expect(hasNativeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) MurageApp/1.0.0 (ios)")).toBe(true);
    expect(hasNativeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; wv) MurageApp/1.0.0 (android)" });
    expect(inNativeShell()).toBe(true);
  });

  it("is not fooled by the desktop bridge", () => {
    // window.muragebox is Electron's preload. It proves the DESKTOP; it must
    // never be read as the phone app (src/lib/use-surface.ts).
    vi.stubGlobal("muragebox", { platform: "darwin", openExternal: vi.fn() });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh) Electron/37.0.0" });
    expect(inNativeShell()).toBe(false);
  });

  it("counts a bridge without a UA token (a future shell that drops the token)", () => {
    fakeBridge({ version: 1, methods: [] });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0" });
    expect(inNativeShell()).toBe(true);
  });
});

describe("feature detection", () => {
  it("offers a method only when hello() listed it AND the function is there", async () => {
    fakeBridge({ version: 1, methods: ["saveFile", "rePair", "teleport"] }, { saveFile: vi.fn(), openExternal: vi.fn() });
    expect(nativeHas("saveFile")).toBe(false); // nothing is assumed before hello()
    expect(await nativeHello()).toEqual({ version: 1, methods: ["saveFile", "rePair"] });
    expect(nativeHas("saveFile")).toBe(true);
    expect(nativeHas("rePair")).toBe(false); // listed, but no function to call
    expect(nativeHas("openExternal")).toBe(false); // a function, but not listed
  });

  it.each([
    ["no object", null],
    ["a string version", { version: "1", methods: ["saveFile"] }],
    ["a zero version", { version: 0, methods: ["saveFile"] }],
    ["methods that are not a list", { version: 1, methods: "saveFile" }],
  ])("treats a malformed hello (%s) as no features at all", async (_label, hello) => {
    fakeBridge(hello, { saveFile: vi.fn() });
    expect(await nativeHello()).toBeNull();
    expect(nativeHas("saveFile")).toBe(false);
    await expect(callNative("saveFile", {})).rejects.toMatchObject({ code: "native-unavailable" });
  });

  it("gives up on a hello() that never answers, so a hung bridge cannot hang the page", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("murageNative", { hello: () => new Promise(() => {}) });
    const answer = nativeHello(1_500);
    vi.advanceTimersByTime(1_500);
    expect(await answer).toBeNull();
  });

  it("survives a hello() that throws synchronously", async () => {
    vi.stubGlobal("murageNative", { hello: () => { throw new Error("bridge torn down"); } });
    expect(await nativeHello()).toBeNull();
  });

  it("asks hello() once however many callers race it", async () => {
    const bridge = fakeBridge({ version: 2, methods: ["ready"] }, { ready: vi.fn() });
    await Promise.all([nativeHello(), nativeHello(), nativeAvailable("ready")]);
    expect(bridge.hello).toHaveBeenCalledOnce();
  });

  it("passes arguments through and returns what native answered", async () => {
    const saveFile = vi.fn(async () => ({ saved: true }));
    fakeBridge({ version: 1, methods: ["saveFile"] }, { saveFile });
    await expect(callNative("saveFile", { kind: "url", url: "https://h/x", filename: "x" })).resolves.toEqual({ saved: true });
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: "https://h/x", filename: "x" });
  });

  it("answers no for everything in a plain browser", async () => {
    expect(await nativeHello()).toBeNull();
    expect(await nativeAvailable("openExternal")).toBe(false);
  });
});

describe("events", () => {
  it("delivers a well-formed notificationOpened and drops a malformed one", () => {
    const bridge = fakeBridge({ version: 1, methods: [] });
    const opened = vi.fn();
    const stop = onNativeEvent("notificationOpened", opened);
    bridge.emit("notificationOpened", { bindingId: "b1", threadId: "t1", messageId: "m1" });
    bridge.emit("notificationOpened", { threadId: "" });
    bridge.emit("notificationOpened", { threadId: "x".repeat(513) });
    bridge.emit("notificationOpened", "t1");
    expect(opened.mock.calls).toEqual([[{ bindingId: "b1", threadId: "t1", messageId: "m1" }]]);
    stop();
    bridge.emit("notificationOpened", { threadId: "t2" });
    expect(opened).toHaveBeenCalledOnce();
  });

  it("is a no-op without a bridge or without on()", () => {
    expect(() => onNativeEvent("resume", vi.fn())()).not.toThrow();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: [] }) });
    expect(() => onNativeEvent("resume", vi.fn())()).not.toThrow();
  });

  it("keeps optional ids optional", () => {
    expect(parseNotificationOpened({ threadId: "t1" })).toEqual({ threadId: "t1" });
    expect(parseNotificationOpened({ threadId: "t1", messageId: 7 })).toEqual({ threadId: "t1" });
    expect(parseNativeHello({ version: 1, methods: ["ready", "ready"] })).toEqual({ version: 1, methods: ["ready"] });
  });
});

it("is asked at boot, so synchronous checks have an answer by the first tap", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("void nativeHello();");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/native-shell.test.ts`
Expected: FAIL with "Failed to resolve import "./native-shell""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/native-shell.ts
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
export function onNativeEvent(name: NativeEventName, listener: (opened?: NotificationOpened) => void): () => void {
  const native = bridge();
  if (!native || typeof native.on !== "function") return () => {};
  let active = true;
  let off: unknown;
  try {
    off = (native.on as (event: string, handler: (detail?: unknown) => void) => unknown)(name, (detail) => {
      if (!active) return;
      if (name !== "notificationOpened") {
        listener();
        return;
      }
      const opened = parseNotificationOpened(detail);
      if (opened) listener(opened);
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
```
In `src/main.tsx`, add the import beside the others (after line 5) and, after `registerServiceWorker();` (line 24), add:
```ts
import { nativeHello } from "./lib/native-shell";
// …
// The phone app's feature list. Asked now so that the synchronous checks a
// tap makes (save, open a link) already have the answer; a plain browser
// answers null at once and costs nothing.
void nativeHello();
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/native-shell.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/native-shell.ts src/lib/native-shell.test.ts src/main.tsx`
`git commit -m "feat(mobile): the page can tell it is inside the phone app, and asks what it can do"`

---

### Task D2: One save helper (`src/lib/save-file.ts`)

**Files:**
- Create: `src/lib/save-file.ts`
- Test: `src/lib/save-file.test.ts`

**Interfaces:**
- Consumes: D1 `nativeAvailable`, `callNative`.
- Produces:
  - `NATIVE_SAVE_CHUNK_BYTES = 1_048_576`, `NATIVE_SAVE_MAX_BYTES = 26_214_400`
  - `type NativeSaveRequest = { kind: "url"; url: string; filename: string } | { kind: "begin"; id: string; filename: string; mime: string; size: number } | { kind: "chunk"; id: string; index: number; base64: string } | { kind: "end"; id: string } | { kind: "abort"; id: string }` — **the contract Plan 2's `saveFile` must implement**
  - `saveUrl(url: string, filename: string): Promise<void>`
  - `saveBlob(blob: Blob, filename: string, revokeAfterMs?: number): Promise<void>`
  - `clickDownload(url: string, filename: string): void` (the existing `a[download]` fallback, shared)

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/save-file.test.ts
// Every "save a copy" goes through one door. In a browser that door is the
// same a[download] click the app has always made. Inside the phone app a
// blob: link has nowhere to go — Android's DownloadListener cannot read a
// blob URL (spec §3.2) — so the bytes go to native instead: a server file by
// its URL, generated content in 1 MB pieces, never more than 25 MB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNativeShellForTest } from "./native-shell";
import { NATIVE_SAVE_CHUNK_BYTES, NATIVE_SAVE_MAX_BYTES, saveBlob, saveUrl } from "./save-file";

let link: { href: string; download: string; rel: string; referrerPolicy: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  link = { href: "", download: "", rel: "", referrerPolicy: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
  vi.stubGlobal("location", { href: "https://desk.tail000000.ts.net/" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  resetNativeShellForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function nativeSave(impl: (request: any) => unknown = async () => undefined) {
  const saveFile = vi.fn(impl);
  vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile"] }), saveFile });
  return saveFile;
}

describe("in a plain browser", () => {
  it("clicks the same a[download] it always did, and frees the object URL later", async () => {
    await saveBlob(new Blob(["hello"]), "note.md");
    expect(link.href).toBe("blob:synthetic");
    expect(link.download).toBe("note.md");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });

  it("still cleans up when the browser refuses the click", async () => {
    link.click.mockImplementation(() => { throw new Error("Download unavailable"); });
    await expect(saveBlob(new Blob(["x"]), "x.txt")).rejects.toThrow("Download unavailable");
    expect(link.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("saves a server file by pointing the anchor at it", async () => {
    await saveUrl("/api/artifacts/a1/download", "report.pdf");
    expect(link.href).toBe("/api/artifacts/a1/download");
    expect(link.download).toBe("report.pdf");
  });
});

describe("inside the phone app", () => {
  it("hands a server file over by absolute URL, so its bytes never cross the channel", async () => {
    const saveFile = nativeSave();
    await saveUrl("/api/artifacts/a1/download", "report.pdf");
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: "https://desk.tail000000.ts.net/api/artifacts/a1/download", filename: "report.pdf" });
    expect(link.click).not.toHaveBeenCalled();
  });

  it("sends generated content in 1 MB pieces that reassemble byte for byte", async () => {
    const saveFile = nativeSave();
    const bytes = new Uint8Array(NATIVE_SAVE_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    await saveBlob(new Blob([bytes], { type: "application/zip" }), "team.zip");
    const requests = saveFile.mock.calls.map(([request]) => request);
    expect(requests.map((r) => r.kind)).toEqual(["begin", "chunk", "chunk", "chunk", "end"]);
    expect(requests[0]).toMatchObject({ filename: "team.zip", mime: "application/zip", size: bytes.length });
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
    const joined = Buffer.concat(requests.filter((r) => r.kind === "chunk").map((r) => Buffer.from(r.base64, "base64")));
    expect(new Uint8Array(joined)).toEqual(bytes);
    expect(requests.filter((r) => r.kind === "chunk").map((r) => r.index)).toEqual([0, 1, 2]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("refuses more than 25 MB before sending anything", async () => {
    const saveFile = nativeSave();
    await expect(saveBlob(new Blob([new Uint8Array(NATIVE_SAVE_MAX_BYTES + 1)]), "huge.bin")).rejects.toMatchObject({ code: "too-large" });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("aborts the transfer when native fails part way, and says why", async () => {
    const saveFile = nativeSave(async (request) => {
      if (request.kind === "chunk" && request.index === 1) throw new Error("disk full");
    });
    await expect(saveBlob(new Blob([new Uint8Array(NATIVE_SAVE_CHUNK_BYTES * 2)]), "a.bin")).rejects.toThrow("disk full");
    expect(saveFile.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "abort" });
  });

  it("saves an empty file as begin and end with no chunks", async () => {
    const saveFile = nativeSave();
    await saveBlob(new Blob([]), "empty.txt");
    expect(saveFile.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "end"]);
  });

  it("reads a blob: or data: link locally and sends its bytes, since native cannot fetch it", async () => {
    const saveFile = nativeSave();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png-bytes"], { type: "image/png" }))));
    await saveUrl("blob:https://desk.tail000000.ts.net/1234", "photo.png");
    expect(saveFile.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "chunk", "end"]);
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ mime: "image/png", filename: "photo.png" });
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/save-file.test.ts`
Expected: FAIL with "Failed to resolve import "./save-file""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/save-file.ts
// Every "save a copy" in the app, through one door.
//
// In a browser, and on the desktop, this is the a[download] click the app has
// always made — moved here from seven call sites that each spelled it out.
//
// Inside the phone app that click has nowhere to go: a blob: URL lives in the
// page's memory, and neither WKDownload nor Android's DownloadListener can
// read it. So the phone gets the file through `murageNative.saveFile`
// (spec §3.2):
//   - a file the server already serves is passed as its URL, and native
//     downloads it with the WebView's own cookie — large files never cross
//     the channel;
//   - generated bytes go in 1 MB base64 pieces, and never more than 25 MB,
//     because each piece is a string held in two processes at once.
import { callNative, nativeAvailable } from "./native-shell";

export const NATIVE_SAVE_CHUNK_BYTES = 1024 * 1024;
export const NATIVE_SAVE_MAX_BYTES = 25 * 1024 * 1024;

/** The shape `murageNative.saveFile` accepts. Plan 2's native code implements
 * exactly this; change both together. */
export type NativeSaveRequest =
  | { kind: "url"; url: string; filename: string }
  | { kind: "begin"; id: string; filename: string; mime: string; size: number }
  | { kind: "chunk"; id: string; index: number; base64: string }
  | { kind: "end"; id: string }
  | { kind: "abort"; id: string };

const save = (request: NativeSaveRequest) => callNative("saveFile", request);

/** The browser half: a temporary anchor, always removed. */
export function clickDownload(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.referrerPolicy = "no-referrer";
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // String.fromCharCode with a spread overflows the stack past ~100k args.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function transferId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function saveBlobNatively(blob: Blob, filename: string): Promise<void> {
  if (blob.size > NATIVE_SAVE_MAX_BYTES) {
    throw Object.assign(
      new Error("This file is bigger than 25 MB, too big to save on this phone. Save it from Murage on your computer."),
      { code: "too-large" },
    );
  }
  const id = transferId();
  await save({ kind: "begin", id, filename, mime: blob.type || "application/octet-stream", size: blob.size });
  try {
    for (let index = 0, offset = 0; offset < blob.size; index += 1, offset += NATIVE_SAVE_CHUNK_BYTES) {
      const piece = new Uint8Array(await blob.slice(offset, offset + NATIVE_SAVE_CHUNK_BYTES).arrayBuffer());
      await save({ kind: "chunk", id, index, base64: base64(piece) });
    }
    await save({ kind: "end", id });
  } catch (error) {
    // Native holds a half-written file until told otherwise.
    await save({ kind: "abort", id }).catch(() => {});
    throw error;
  }
}

/** Bytes this page made or already fetched. */
export async function saveBlob(blob: Blob, filename: string, revokeAfterMs = 60_000): Promise<void> {
  if (await nativeAvailable("saveFile")) return saveBlobNatively(blob, filename);
  const url = URL.createObjectURL(blob);
  try {
    clickDownload(url, filename);
  } finally {
    // Chromium may read the URL after the click task; 60 s is what every
    // call site used before this existed.
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
  }
}

/** A file behind a URL: a server route, or a blob:/data: link in the page. */
export async function saveUrl(url: string, filename: string): Promise<void> {
  if (!(await nativeAvailable("saveFile"))) {
    clickDownload(url, filename);
    return;
  }
  if (/^(?:blob|data):/i.test(url)) {
    // Only this page can read these; native would get nothing.
    const response = await fetch(url);
    return saveBlobNatively(await response.blob(), filename);
  }
  await save({ kind: "url", url: new URL(url, globalThis.location?.href).href, filename });
}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/save-file.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/save-file.ts src/lib/save-file.test.ts`
`git commit -m "feat(mobile): one save helper that hands files to the phone app, by URL or in 1 MB pieces"`

---

### Task D3: Links that leave the page (`src/lib/open-external.ts`)

**Files:**
- Create: `src/lib/open-external.ts`
- Modify: `src/main.tsx` (install click routing inside the phone app only)
- Test: `src/lib/open-external.test.ts`

**Interfaces:**
- Consumes: D1 `nativeHas`, `callNative`, `inNativeShell`; D2 `saveUrl`.
- Produces:
  - `openExternalPage(url: string, blockedMessage: string): Promise<void>` — desktop bridge, then phone app, then the existing blank-tab-then-navigate
  - `type NativeClick = { kind: "save"; url: string; filename: string } | { kind: "external"; url: string } | null`
  - `nativeClickAction(anchor: { href: string; target: string; hasDownload: boolean; download: string }, pageOrigin: string): NativeClick`
  - `routeNativeClicks(doc?: Pick<Document, "addEventListener" | "removeEventListener">, pageOrigin?: string): () => void`

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/open-external.test.ts
// A link out of the app, and an a[download] in the page, inside the phone
// app. The WebView has no tabs: `window.open` returns null there and a
// target=_blank link does nothing, so the phone app opens them in the system
// browser (spec §3.6). The desktop keeps its own bridge; a browser keeps the
// blank-tab-then-navigate that keeps an opener away from OAuth pages.
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "./native-shell";
import { nativeClickAction, openExternalPage, routeNativeClicks } from "./open-external";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://desk.tail000000.ts.net";

describe("opening a page outside Murage", () => {
  it("uses the desktop bridge when there is one", async () => {
    const openExternal = vi.fn(async () => true);
    const open = vi.fn();
    vi.stubGlobal("window", { muragebox: { openExternal }, open });
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(openExternal).toHaveBeenCalledWith("https://composio.dev/auth");
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the phone app when it offers openExternal", async () => {
    const openExternal = vi.fn(async () => undefined);
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["openExternal"] }), openExternal });
    await nativeHello();
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(openExternal).toHaveBeenCalledWith("https://composio.dev/auth");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a blank tab first in a browser, then navigates it without an opener", async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() } };
    vi.stubGlobal("window", { open: vi.fn(() => tab) });
    await openExternalPage("https://composio.dev/auth", "blocked");
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith("https://composio.dev/auth");
  });

  it("says what happened when the browser blocks the tab", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    await expect(openExternalPage("https://x.example", "Allow pop-ups, then try again.")).rejects.toThrow("Allow pop-ups, then try again.");
  });
});

describe("which clicks the phone app takes over", () => {
  const anchor = (over: Partial<Parameters<typeof nativeClickAction>[0]>) => ({ href: "", target: "", hasDownload: false, download: "", ...over });

  it("saves any a[download], naming it from the attribute or the path", () => {
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/api/attachments/a1`, hasDownload: true, download: "clip.mp4" }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/api/attachments/a1`, filename: "clip.mp4" });
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/files/My%20Report.pdf`, hasDownload: true }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/files/My%20Report.pdf`, filename: "My Report.pdf" });
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/files/%E0%A4%A`, hasDownload: true }), ORIGIN))
      .toEqual({ kind: "save", url: `${ORIGIN}/files/%E0%A4%A`, filename: "download" });
  });

  it("sends a cross-origin target=_blank link to the system browser", () => {
    expect(nativeClickAction(anchor({ href: "https://docs.murage.ai/x", target: "_blank" }), ORIGIN))
      .toEqual({ kind: "external", url: "https://docs.murage.ai/x" });
  });

  it("leaves same-origin, same-tab and non-web links alone", () => {
    expect(nativeClickAction(anchor({ href: `${ORIGIN}/api/artifacts/a1/view`, target: "_blank" }), ORIGIN)).toBeNull();
    expect(nativeClickAction(anchor({ href: "https://docs.murage.ai/x" }), ORIGIN)).toBeNull();
    expect(nativeClickAction(anchor({ href: "mailto:a@b.c", target: "_blank" }), ORIGIN)).toBeNull();
  });

  it("routes a real click, but never one a component already handled", async () => {
    const saveFile = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile", "openExternal"] }), saveFile, openExternal });
    await nativeHello();
    let handler: ((event: any) => void) | undefined;
    const doc = { addEventListener: vi.fn((_: string, h: any) => { handler = h; }), removeEventListener: vi.fn() };
    const stop = routeNativeClicks(doc as any, ORIGIN);
    const click = (a: Record<string, unknown>, defaultPrevented = false) => {
      const event = {
        defaultPrevented,
        button: 0,
        preventDefault: vi.fn(),
        target: { closest: () => ({ hasAttribute: (n: string) => n === "download" && "download" in a, getAttribute: () => a.download ?? "", target: "", href: "", ...a }) },
      };
      handler!(event);
      return event;
    };
    expect(click({ href: "https://docs.murage.ai/x", target: "_blank" }).preventDefault).toHaveBeenCalled();
    expect(click({ href: `${ORIGIN}/api/attachments/a1`, download: "a.png" }).preventDefault).toHaveBeenCalled();
    expect(click({ href: "https://docs.murage.ai/y", target: "_blank" }, true).preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: `${ORIGIN}/api/attachments/a1`, filename: "a.png" });
    stop();
    expect(doc.removeEventListener).toHaveBeenCalledWith("click", handler);
  });
});

it("is installed only inside the phone app", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("if (inNativeShell()) routeNativeClicks();");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/open-external.test.ts`
Expected: FAIL with "Failed to resolve import "./open-external""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/open-external.ts
// Leaving the page, on each surface.
//
//   desktop  window.muragebox.openExternal — the system browser, via Electron.
//   phone    murageNative.openExternal — the system browser, via the app.
//            The workspace WebView has no tabs: window.open answers null and
//            a target=_blank link does nothing at all (spec §3.2, §3.6).
//   browser  a blank tab opened FIRST, then navigated, so the OAuth origin
//            never receives an opener reference while a real null still
//            means "blocked" (unchanged from ConnectorCard and PluginsPanel).
import { callNative, nativeHas } from "./native-shell";
import { saveUrl } from "./save-file";

/** `nativeHas` is synchronous on purpose: this runs inside a click, and a
 * browser only lets a tab open during the gesture that asked for it. The
 * feature list is fetched at boot (main.tsx), long before the first tap. */
export async function openExternalPage(url: string, blockedMessage: string): Promise<void> {
  if (window.muragebox?.openExternal) {
    await window.muragebox.openExternal(url);
    return;
  }
  if (nativeHas("openExternal")) {
    await callNative("openExternal", url);
    return;
  }
  const opened = window.open("", "_blank");
  if (!opened) throw new Error(blockedMessage);
  opened.opener = null;
  opened.location.replace(url);
}

export type NativeClick = { kind: "save"; url: string; filename: string } | { kind: "external"; url: string } | null;

function nameFromPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split("/").pop() ?? "") || "download";
  } catch {
    return "download";
  }
}

/** What the phone app should do with a click on this anchor, if anything.
 *
 * A same-origin target=_blank link is deliberately left alone: the system
 * browser has no session cookie, so sending it there would land on the
 * sign-in page. Native keeps same-origin navigation inside the WebView. */
export function nativeClickAction(
  anchor: { href: string; target: string; hasDownload: boolean; download: string },
  pageOrigin: string,
): NativeClick {
  let url: URL;
  try {
    url = new URL(anchor.href, pageOrigin);
  } catch {
    return null;
  }
  if (anchor.hasDownload) return { kind: "save", url: url.href, filename: anchor.download || nameFromPath(url) };
  if (anchor.target !== "_blank") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin === pageOrigin ? null : { kind: "external", url: url.href };
}

/** One listener for every anchor in the app, instead of an edit per link.
 *
 * Bubble phase on the document, so it runs AFTER React's own handlers: a
 * component that handled the click itself (MediaPlayer renews an expired
 * download link and saves through that) has already called preventDefault,
 * and is left alone. */
export function routeNativeClicks(
  doc: Pick<Document, "addEventListener" | "removeEventListener"> = document,
  pageOrigin: string = globalThis.location?.origin ?? "",
): () => void {
  const onClick = (event: Event) => {
    const mouse = event as MouseEvent;
    if (mouse.defaultPrevented || mouse.button !== 0) return;
    const anchor = (mouse.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const action = nativeClickAction(
      { href: anchor.href, target: anchor.target, hasDownload: anchor.hasAttribute("download"), download: anchor.getAttribute("download") ?? "" },
      pageOrigin,
    );
    if (!action) return;
    if (action.kind === "save" ? !nativeHas("saveFile") : !nativeHas("openExternal")) return;
    mouse.preventDefault();
    const done = action.kind === "save" ? saveUrl(action.url, action.filename) : callNative("openExternal", action.url);
    void done.catch((error) => console.warn("murage: the phone app could not finish that", error));
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
```
In `src/main.tsx`, extend the D1 import to `import { inNativeShell, nativeHello } from "./lib/native-shell";`, add `import { routeNativeClicks } from "./lib/open-external";`, and directly after `void nativeHello();` add:
```ts
// Links that leave the page, and a[download] anchors, inside the phone app.
// A browser and the desktop never install this listener at all.
if (inNativeShell()) routeNativeClicks();
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/open-external.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/open-external.ts src/lib/open-external.test.ts src/main.tsx`
`git commit -m "feat(mobile): links out of the app and download anchors go to the phone app's own browser and save"`

---

### Task D4: Route every download and window.open call site through D2/D3

**Files:**
- Modify: `src/components/Files.tsx:20-28` (`downloadSavedArtifact`)
- Modify: `src/lib/conversation-export.ts:9-31`
- Modify: `src/lib/team-files.ts:10-27, 49-56`
- Modify: `src/components/WorkspacePane.tsx:736-742` (`download`)
- Modify: `src/lib/code-block.ts:62-77` (`saveCodeSnippet`)
- Modify: `src/components/MediaPlayer.tsx:278-293` (`onDownload`)
- Modify: `src/components/ConnectorCard.tsx:6-15`, `src/components/PluginsPanel.tsx:729-743`, `src/components/ComputerPanel.tsx:797-826`
- (No edit) `src/components/ImageMedia.tsx:465-475` and `MediaPlayer.tsx:152-159` `DownloadAction` are in-DOM `a[download]` anchors, which D3's `routeNativeClicks` handles.
- Test: `src/lib/conversation-export.test.ts` (extend), `src/lib/native-routing.test.ts` (new, source pins)

**Interfaces:**
- Consumes: D2 `saveBlob`, `saveUrl`; D3 `openExternalPage`; D1 `nativeAvailable`, `nativeHas`, `callNative`.
- Produces: no new exports; `downloadPlaybook` becomes `async` (internal).

- [ ] **Step 1: Write the failing test**
Append to `src/lib/conversation-export.test.ts` (its `beforeEach` at lines 8-17 already stubs `document`, `window`, `fetch`):
```ts
import { resetNativeShellForTest } from "./native-shell";

it("inside the phone app, hands the export route to native by URL instead of reading it here", async () => {
  const saveFile = vi.fn(async () => undefined);
  vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile"] }), saveFile });
  vi.stubGlobal("location", { href: "https://desk.tail000000.ts.net/" });
  try {
    expect(await downloadConversation("task/one", "Quarterly report")).toBe("conversation-quarterly-report.md");
    expect(saveFile).toHaveBeenCalledWith({
      kind: "url",
      url: "https://desk.tail000000.ts.net/api/threads/task%2Fone/export?format=markdown",
      filename: "conversation-quarterly-report.md",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(link.click).not.toHaveBeenCalled();
  } finally {
    resetNativeShellForTest();
  }
});
```
Create `src/lib/native-routing.test.ts`:
```ts
// Every place the app saves a file or opens a page outside itself goes
// through save-file.ts / open-external.ts, so the phone app is never
// skipped by one call site that still builds its own anchor or tab.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("downloads", () => {
  it.each([
    ["../components/Files.tsx"],
    ["./conversation-export.ts"],
    ["./team-files.ts"],
    ["../components/WorkspacePane.tsx"],
  ])("%s never builds its own blob anchor", (path) => {
    const source = read(path);
    expect(source).not.toContain("URL.createObjectURL");
    expect(source).toMatch(/from "@\/lib\/save-file"/);
  });

  it("the expired-link renewal saves through saveUrl, not a detached anchor", () => {
    const source = read("../components/MediaPlayer.tsx");
    expect(source).toContain("saveUrl(next.url, asset.name)");
    expect(source).not.toContain("anchor.download = asset.name");
  });

  it("a code snippet goes to the phone app when it can take it", () => {
    expect(read("./code-block.ts")).toContain('if (nativeHas("saveFile"))');
  });
});

describe("pages outside Murage", () => {
  it.each([["../components/ConnectorCard.tsx"], ["../components/PluginsPanel.tsx"]])("%s opens through openExternalPage", (path) => {
    const source = read(path);
    expect(source).toContain("openExternalPage(url,");
    expect(source).not.toContain('window.open("", "_blank")');
  });

  it("the live desktop only pre-opens a browser tab when neither app can open it", () => {
    const source = read("../components/ComputerPanel.tsx");
    expect(source).toContain('!window.muragebox?.desktopViewer && !window.muragebox?.openExternal && !nativeHas("openExternal")');
    expect(source).toContain('await callNative("openExternal", viewerUrl)');
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/conversation-export.test.ts src/lib/native-routing.test.ts`
Expected: FAIL — conversation export calls `fetch` instead of `saveFile`; source pins find `URL.createObjectURL` and `window.open("", "_blank")`.
- [ ] **Step 3: Write minimal implementation**

`src/components/Files.tsx` — add `import { saveBlob, saveUrl } from "@/lib/save-file";` and `import { nativeAvailable } from "@/lib/native-shell";`; replace lines 20-28 with:
```ts
export async function downloadSavedArtifact(artifact: Artifact) {
  const path = `/api/artifacts/${artifact.id}/download`;
  // Inside the phone app the file is fetched by native with this page's
  // cookie, so a large file never crosses the channel (spec §3.2).
  if (await nativeAvailable("saveFile")) return saveUrl(path, artifact.filename);
  await ensureDesktopSurfaceSecret();
  const response = await fetch(path, { headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? "The saved copy could not be downloaded."); }
  await saveBlob(await response.blob(), artifact.filename);
}
```
`src/lib/conversation-export.ts` — add `import { nativeAvailable } from "@/lib/native-shell";` and `import { saveBlob, saveUrl } from "@/lib/save-file";`; replace lines 9-31 with:
```ts
/** Capture the selected task before awaiting authentication or download. */
export async function downloadConversation(threadId: string, title: string): Promise<string> {
  const filename = conversationExportFilename(title);
  const path = `/api/threads/${encodeURIComponent(threadId)}/export?format=markdown`;
  // The phone app downloads the route itself with the page's cookie; it
  // reports a refused or non-Markdown answer as a failed save.
  if (await nativeAvailable("saveFile")) {
    await saveUrl(path, filename);
    return filename;
  }
  await ensureDesktopSurfaceSecret();
  const response = await fetch(path, {
    headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() },
  });
  if (!response.ok) throw new Error(response.status === 404
    ? "This conversation is unavailable or you no longer have access."
    : "Could not export this conversation. Try again.");
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/markdown") {
    throw new Error("The server did not return a Markdown conversation.");
  }
  await saveBlob(await response.blob(), filename);
  return filename;
}
```
(The existing test at `conversation-export.test.ts:20-30` pins `fetch` being called only after `ensure` resolves; `nativeAvailable` resolves on the first microtask without a bridge, so `expect(fetchMock).not.toHaveBeenCalled()` at line 24 still holds because `ensure` is still pending.)

`src/lib/team-files.ts` — add `import { saveBlob } from "@/lib/save-file";`; replace `downloadPlaybook` (lines 10-27) with:
```ts
async function downloadPlaybook(playbook: ExportedPlaybook): Promise<{ name: string; members: number }> {
  const slug =
    playbook.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "team";
  await saveBlob(new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" }), `${slug}.emberbot.md`);
  return { name: playbook.name, members: playbook.members };
}
```
replace lines 49-56 of `downloadSelectedBotPackageZip` with:
```ts
  const blob = await response.blob();
  const slug = reviewed.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "murage-package";
  await saveBlob(blob, slug + ".zip");
  return reviewed;
```
and in `downloadSelectedBotPackage` change `return downloadPlaybook(playbook);` (line 65) to `return await downloadPlaybook(playbook);`.

`src/components/WorkspacePane.tsx` — add `import { saveBlob } from "@/lib/save-file";`; replace `download` (lines 736-742) with:
```ts
  const download = () => {
    const text = currentText();
    const blob = new Blob([currentBom() ? "﻿" + text : text], { type: "text/plain;charset=utf-8" });
    // Over 25 MB inside the phone app is refused with a sentence; show it.
    void saveBlob(blob, name).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
```
(Keep the BOM literal exactly as the file has it at line 738.)

`src/lib/code-block.ts` — add `import { nativeHas } from "./native-shell";` and `import { saveBlob } from "./save-file";`; at the top of `saveCodeSnippet` (after line 62's signature, before the `typeof document` check) insert:
```ts
  // Inside the phone app a blob anchor goes nowhere. This stays synchronous
  // for ChatMarkdown's boolean contract: the feature list was fetched at boot.
  if (nativeHas("saveFile")) {
    void saveBlob(new Blob([code], { type: "text/plain;charset=utf-8" }), fileName).catch((error) =>
      console.warn("murage: the phone app could not save the snippet", error));
    return true;
  }
```
`src/components/MediaPlayer.tsx` — add `import { saveUrl } from "@/lib/save-file";`; in `onDownload` replace lines 285-291 (from `if (typeof document === "undefined") return;` through `anchor.click();`) with:
```ts
      void saveUrl(next.url, asset.name).catch(() => {});
```
`src/components/ConnectorCard.tsx` — add `import { openExternalPage } from "@/lib/open-external";`; replace lines 6-15 with:
```ts
async function openConnectionPage(url: string) {
  await openExternalPage(url, "Your browser blocked the connection page. Allow pop-ups, then try again.");
}
```
`src/components/PluginsPanel.tsx` — add `import { openExternalPage } from "@/lib/open-external";`; replace the body of `openConnectUrl` (lines 729-743) with:
```ts
  const openConnectUrl = async (url: string) => {
    // If a popup blocker rejects the first asynchronous open, the visible
    // Continue button retries from a direct user gesture using the URL
    // retained in pendingUrls.
    await openExternalPage(url, "Your browser blocked the connection page. Click Continue to open it.");
  };
```
`src/components/ComputerPanel.tsx` — add `import { callNative, nativeHas } from "@/lib/native-shell";`; change line 799 to:
```ts
    if (!window.muragebox?.desktopViewer && !window.muragebox?.openExternal && !nativeHas("openExternal")) {
```
and insert a branch between the `fallbackTab` branch (line 819-820) and the `window.muragebox?.openExternal` branch (line 821):
```ts
      } else if (nativeHas("openExternal")) {
        // The phone app: the live desktop opens in the system browser.
        await callNative("openExternal", viewerUrl);
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/conversation-export.test.ts src/lib/native-routing.test.ts src/lib/code-block.test.ts src/components/Files.test.ts src/components/WorkspacePane.test.ts src/components/PluginsPanel.test.ts src/components/ComputerPanel.test.ts`
Expected: PASS (the existing code-block tests at `code-block.test.ts:43-80` still pass: no bridge means `nativeHas` is false and the original anchor path runs unchanged).
- [ ] **Step 5: Commit**
`git add src/components/Files.tsx src/lib/conversation-export.ts src/lib/team-files.ts src/components/WorkspacePane.tsx src/lib/code-block.ts src/components/MediaPlayer.tsx src/components/ConnectorCard.tsx src/components/PluginsPanel.tsx src/components/ComputerPanel.tsx src/lib/conversation-export.test.ts src/lib/native-routing.test.ts`
`git commit -m "feat(mobile): every save and every page out of the app goes through the phone app when it is there"`

---

### Task D5: No install prompt inside the phone app

**Files:**
- Modify: `src/lib/install-prompt.ts:23-50`
- Modify: `src/lib/use-install-prompt.ts:88-94`
- Test: `src/lib/install-prompt.test.ts`

**Interfaces:**
- Consumes: D1 `inNativeShell`.
- Produces: `InstallFacts.nativeShell: boolean` (new required field).

- [ ] **Step 1: Write the failing test**
In `src/lib/install-prompt.test.ts`, add `nativeShell: false,` to the `facts()` defaults (lines 10-17), then add inside `describe("who gets invited to install", …)`:
```ts
  it("never invites the phone app to install itself", () => {
    // It IS the app. Android's WebView can still fire beforeinstallprompt on
    // an installable origin, and the iOS hint would point at a Share button
    // the app does not have.
    expect(installInvite(facts({ nativeShell: true, captured: true }))).toBe("hidden");
    expect(installInvite(facts({ nativeShell: true, ios: true }))).toBe("hidden");
  });
```
and inside `describe("where the invitation is allowed to appear", …)`:
```ts
  it("asks native-shell.ts, synchronously, so the first frame is already right", () => {
    const hook = readFileSync(fileURLToPath(new URL("./use-install-prompt.ts", import.meta.url)), "utf8");
    expect(hook).toContain("nativeShell: inNativeShell(),");
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/install-prompt.test.ts`
Expected: FAIL — `installInvite` returns `"prompt"` / `"manual"`; hook source lacks `nativeShell`.
- [ ] **Step 3: Write minimal implementation**
In `src/lib/install-prompt.ts`, add to `InstallFacts` after `dismissed` (line 35):
```ts
  /** Inside the Murage phone app, which is already the app. */
  nativeShell: boolean;
```
and change the first line of `installInvite` (line 46) to:
```ts
  if (facts.nativeShell || facts.standalone || !facts.secure || facts.dismissed) return "hidden";
```
In `src/lib/use-install-prompt.ts`, add `import { inNativeShell } from "./native-shell";` and add to the `installInvite({...})` call (lines 88-94):
```ts
    nativeShell: inNativeShell(),
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/install-prompt.test.ts src/lib/pwa-install.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/install-prompt.ts src/lib/use-install-prompt.ts src/lib/install-prompt.test.ts`
`git commit -m "fix(mobile): the phone app is never invited to add itself to the home screen"`

---

### Task D6: Session check (`src/lib/session-check.ts`) and the door's `GET /session`

**Files:**
- Create: `src/lib/session-check.ts`
- Test: `src/lib/session-check.test.ts`
- Test: `companion/test/browser.test.ts` (extend `describe("sessions", …)` at line 459)

**Interfaces:**
- Consumes: companion `GET /session` (`companion/src/browser.ts:1270-1277`): 200 `{device:{name}, expiresAt}` with a live cookie; 401 `{error:"sign in", signIn:"/enter"}` without one. It is terminated above the allowlist (line 1217) and a GET needs no Origin.
- Produces:
  - `SESSION_PATH = "/session"`, `SESSION_CHECK_MIN_GAP_MS = 5_000`, `PAIR_AGAIN_PATH = "/enter"`
  - `type SessionVerdict = "signed-in" | "signed-out" | "unknown"`
  - `sessionVerdict(status: number | null): SessionVerdict`
  - `createSessionWatch(deps: { fetch: (path: string, init: RequestInit) => Promise<{ status: number }>; now: () => number; desktop: () => boolean })` → `{ check(): Promise<SessionVerdict>; isSignedOut(): boolean; onSignedOut(listener: () => void): () => void }`
  - module singletons: `checkSession`, `sessionSignedOut`, `onSignedOut`

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/session-check.test.ts
// A 401 from an API route is not proof of being signed out: a harness route
// answers 401 for a provider IT could not sign in to (server/avatar-image.ts
// :297). And the event stream cannot report a status at all. Only the door's
// own GET /session can say this browser has lost its session (spec §3.6).
import { describe, expect, it, vi } from "vitest";

import { SESSION_CHECK_MIN_GAP_MS, createSessionWatch, sessionVerdict } from "./session-check";

function watch(answer: () => Promise<{ status: number }>, options: { desktop?: boolean } = {}) {
  let now = 0;
  const fetch = vi.fn(answer);
  const session = createSessionWatch({ fetch, now: () => now, desktop: () => options.desktop ?? false });
  return { session, fetch, advance: (ms: number) => { now += ms; } };
}

describe("reading the door's answer", () => {
  it("only an actual 401 means signed out", () => {
    expect(sessionVerdict(401)).toBe("signed-out");
    expect(sessionVerdict(200)).toBe("signed-in");
    // A network failure is a host that is asleep, not a person signed out.
    expect(sessionVerdict(null)).toBe("unknown");
    // The desktop dev server answers /session with the SPA shell; a harness
    // restart answers 502 through the door. Neither may sign anyone out.
    expect(sessionVerdict(404)).toBe("unknown");
    expect(sessionVerdict(502)).toBe("unknown");
  });
});

describe("the watch", () => {
  it("announces signed-out once, and stays signed out", async () => {
    const { session, fetch } = watch(async () => ({ status: 401 }));
    const listener = vi.fn();
    session.onSignedOut(listener);
    expect(await session.check()).toBe("signed-out");
    expect(await session.check()).toBe("signed-out");
    expect(listener).toHaveBeenCalledOnce();
    expect(session.isSignedOut()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/session", { credentials: "same-origin", cache: "no-store" });
  });

  it("keeps the app signed in when an API 401 turns out to be the harness's own", async () => {
    const { session } = watch(async () => ({ status: 200 }));
    const listener = vi.fn();
    session.onSignedOut(listener);
    expect(await session.check()).toBe("signed-in");
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats an unreachable door as unknown, so reconnecting continues", async () => {
    const { session } = watch(async () => { throw new TypeError("Failed to fetch"); });
    expect(await session.check()).toBe("unknown");
    expect(session.isSignedOut()).toBe(false);
  });

  it("asks once for a burst of 401s, and not again inside the gap", async () => {
    let release!: (value: { status: number }) => void;
    const { session, fetch, advance } = watch(() => new Promise((resolve) => { release = resolve; }));
    const burst = [session.check(), session.check(), session.check()];
    release({ status: 200 });
    expect(await Promise.all(burst)).toEqual(["signed-in", "signed-in", "signed-in"]);
    expect(await session.check()).toBe("signed-in");
    expect(fetch).toHaveBeenCalledOnce();
    advance(SESSION_CHECK_MIN_GAP_MS);
    void session.check();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never asks on the desktop, which has no door and no session", async () => {
    const { session, fetch } = watch(async () => ({ status: 401 }), { desktop: true });
    expect(await session.check()).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells a late subscriber that sign-out already happened", async () => {
    const { session } = watch(async () => ({ status: 401 }));
    await session.check();
    const late = vi.fn();
    session.onSignedOut(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledOnce();
  });
});
```
Append to `companion/test/browser.test.ts` inside `describe("sessions", …)` (after the test ending at line 523):
```ts
  it("answers the page's signed-out check: 401 on /session and on the stream, with where to go", async () => {
    // The web UI asks GET /session after an API 401 or a stream error
    // (src/lib/session-check.ts). EventSource cannot see a status, so this
    // pair — a dead stream AND a 401 here — is how a phone learns it was
    // signed out instead of retrying forever.
    const cookie = await signedIn();
    expect((await knock("DELETE", "/session", write(cookie))).status).toBe(200);
    const who = await knock("GET", "/session", cookie);
    expect(who.status).toBe(401);
    expect(JSON.parse(who.body)).toEqual({ error: "sign in", signIn: "/enter" });
    expect((await knock("GET", "/api/events", cookie)).status).toBe(401);
    // A wiped cookie store reads the same, and a GET needs no Origin.
    expect((await knock("GET", "/session")).status).toBe(401);
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/session-check.test.ts companion/test/browser.test.ts -t "signed-out check|reading the door|the watch"`
Expected: FAIL with "Failed to resolve import "./session-check"" (the companion test PASSES already — it confirms the route and status this task relies on; keep it as a pin).
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/session-check.ts
// Is this browser still signed in at the door?
//
// Asked after any API 401 and after the event stream drops (spec §3.6). A
// 401 on its own proves nothing: harness routes answer 401 for a provider
// they could not authenticate to (server/avatar-image.ts:297), and the
// companion's renewal deliberately never answers 401 (companion/src/
// browser.ts:1194-1199). The event stream cannot report its status at all.
// So the door's own `GET /session` decides (browser.ts:1270-1277):
//
//   200  signed in; carry on
//   401  signed out; stop reconnecting and ask the person to pair again
//   else unknown — asleep, restarting, or no door at all; carry on
//
// Signed-out is final for the page. A new session arrives only through
// /enter, which is a new page load.

export const SESSION_PATH = "/session";
export const SESSION_CHECK_MIN_GAP_MS = 5_000;
/** The door's code-entry page; `/enter` with no fragment asks for the six
 * digits (companion/src/browser.ts:1170). */
export const PAIR_AGAIN_PATH = "/enter";

export type SessionVerdict = "signed-in" | "signed-out" | "unknown";

export function sessionVerdict(status: number | null): SessionVerdict {
  if (status === 401) return "signed-out";
  if (status !== null && status >= 200 && status < 300) return "signed-in";
  return "unknown";
}

export interface SessionWatchDeps {
  fetch: (path: string, init: RequestInit) => Promise<{ status: number }>;
  now: () => number;
  /** The desktop app has no door and no session to lose. */
  desktop: () => boolean;
}

export function createSessionWatch(deps: SessionWatchDeps) {
  let signedOut = false;
  let pending: Promise<SessionVerdict> | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let last: SessionVerdict = "unknown";
  const listeners = new Set<() => void>();

  const check = (): Promise<SessionVerdict> => {
    if (signedOut) return Promise.resolve("signed-out");
    if (deps.desktop()) return Promise.resolve("unknown");
    if (pending) return pending;
    // A reconnect loop and a burst of failing panels arrive together; one
    // answer covers all of them.
    if (deps.now() - lastAt < SESSION_CHECK_MIN_GAP_MS) return Promise.resolve(last);
    lastAt = deps.now();
    pending = deps
      .fetch(SESSION_PATH, { credentials: "same-origin", cache: "no-store" })
      .then((response) => sessionVerdict(response.status), () => sessionVerdict(null))
      .then((verdict) => {
        last = verdict;
        if (verdict === "signed-out" && !signedOut) {
          signedOut = true;
          for (const listener of [...listeners]) listener();
        }
        return verdict;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    check,
    isSignedOut: () => signedOut,
    onSignedOut(listener: () => void): () => void {
      listeners.add(listener);
      if (signedOut) queueMicrotask(listener);
      return () => listeners.delete(listener);
    },
  };
}

const watch = createSessionWatch({
  fetch: (path, init) => globalThis.fetch(path, init),
  now: () => Date.now(),
  // The Electron preload is the one signal that cannot be forged through the
  // door (src/lib/use-surface.ts). Its absence proves nothing, which is fine:
  // the desktop dev server answers /session with the SPA shell, "unknown".
  desktop: () => Boolean((globalThis as { muragebox?: unknown }).muragebox),
});

export const checkSession = watch.check;
export const sessionSignedOut = watch.isSignedOut;
export const onSignedOut = watch.onSignedOut;
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/session-check.test.ts companion/test/browser.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/session-check.ts src/lib/session-check.test.ts companion/test/browser.test.ts`
`git commit -m "feat(mobile): ask the door whether a 401 really means signed out"`

---

### Task D7: Act on a signed-out answer (API 401, stream error, retries, card, rePair)

**Files:**
- Modify: `src/state/store.tsx:1884-1921` (`api()`), `:615-686` (`AppState`), `:921` (Action union), `:1560-1561` (reducer), `:1850-1874` (`initialState`), `:2747-2773` (`schedulePeripheralRetry`), `:3046-3083` (live stream + cleanup)
- Modify: `src/lib/live-events.ts:47-60` (handlers), `:371-376` (`connectionLost`), `:529-538` (stop)
- Create: `src/components/SignedOutCard.tsx`
- Modify: `src/App.tsx:267-271` (mount the card)
- Test: `src/lib/live-events.test.ts`, `src/state/store.test.ts`, `src/components/SignedOutCard.test.ts`

**Interfaces:**
- Consumes: D6 `checkSession`, `sessionSignedOut`, `onSignedOut`, `PAIR_AGAIN_PATH`; D1 `nativeAvailable`, `nativeHas`, `callNative`.
- Produces:
  - `LiveEventsHandlers.stillSignedIn?: () => Promise<boolean>`
  - `AppState.signedOut?: boolean`; `Action` `{ type: "signedOut" }`
  - `SignedOutCard` component; `pairAgain(): Promise<void>`

- [ ] **Step 1: Write the failing test**
Append to `src/lib/live-events.test.ts` (uses its `harness()` at lines 63-99):
```ts
describe("a stream that died because the session did", () => {
  it("stops reconnecting once the door says this browser is signed out", async () => {
    const fixture = harness();
    let answer!: (signedIn: boolean) => void;
    const stillSignedIn = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const onError = vi.fn();
    openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true, onError, stillSignedIn }, fixture.platform);
    fixture.sources[0]!.error();
    expect(onError).toHaveBeenCalledOnce();
    expect(stillSignedIn).toHaveBeenCalledOnce();
    answer(false);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    fixture.windowTarget.emit("online");
    fixture.documentTarget.emit("visibilitychange");
    expect(fixture.sources).toHaveLength(1);
    expect(fixture.windowTarget.count("online")).toBe(0);
  });

  it("keeps reconnecting when the door says signed in, or cannot be reached", async () => {
    const fixture = harness();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, stillSignedIn: async () => true },
      fixture.platform,
    );
    fixture.sources[0]!.error();
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(fixture.sources).toHaveLength(2);
    stop();
  });
});
```
Append to `src/state/store.test.ts`:
```ts
describe("signed out", () => {
  it("is off until the door says otherwise, and going offline is part of it", () => {
    expect(initialState.signedOut).toBe(false);
    const next = reducer({ ...initialState, connected: true }, { type: "signedOut" });
    expect(next.signedOut).toBe(true);
    expect(next.connected).toBe(false);
  });

  it("a 401 from any API call asks the door, never signs out on its own", () => {
    const source = readFileSync(fileURLToPath(new URL("./store.tsx", import.meta.url)), "utf8");
    expect(source).toContain("if (res.status === 401) void checkSession();");
    // The panel retry loop gives up on a signed-out browser instead of
    // spending the battery on a 401 every 30 seconds.
    expect(source).toMatch(/if \(isPermanentlyRefused\(error\)\) \{[\s\S]*?\}\s*if \(sessionSignedOut\(\)\) return;/);
    expect(source).toContain('stillSignedIn: async () => (await checkSession()) !== "signed-out"');
  });
});
```
(add `import { readFileSync } from "node:fs";` and `import { fileURLToPath } from "node:url";` at the top of `store.test.ts`.)

Create `src/components/SignedOutCard.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativeHello, resetNativeShellForTest } from "@/lib/native-shell";
import { pairAgain } from "./SignedOutCard";

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
});

describe("pairing again", () => {
  it("hands over to the phone app's own re-pair screen when it has one", async () => {
    const rePair = vi.fn(async () => undefined);
    const assign = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["rePair"] }), rePair });
    vi.stubGlobal("location", { assign });
    await nativeHello();
    await pairAgain();
    expect(rePair).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a browser to the door's code page", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    await pairAgain();
    expect(assign).toHaveBeenCalledWith("/enter");
  });

  it("falls back to the code page when the app's re-pair fails", async () => {
    const assign = vi.fn();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["rePair"] }), rePair: async () => { throw new Error("gone"); } });
    vi.stubGlobal("location", { assign });
    await nativeHello();
    await pairAgain();
    expect(assign).toHaveBeenCalledWith("/enter");
  });

  it("is shown over everything once the store says signed out", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain("{state.signedOut && <SignedOutCard />}");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/live-events.test.ts src/state/store.test.ts src/components/SignedOutCard.test.ts -t "signed"`
Expected: FAIL — a new source is opened after the signed-out answer; `initialState.signedOut` is `undefined`; `./SignedOutCard` does not resolve.
- [ ] **Step 3: Write minimal implementation**

`src/lib/live-events.ts` — add to `LiveEventsHandlers` (after `onError?` at line 55):
```ts
  /** Asked after the stream drops. EventSource never reveals the status that
   * ended it, so a dead session looks exactly like a host that went to
   * sleep; false ends the supervisor instead of retrying forever. */
  stillSignedIn?: () => Promise<boolean>;
```
Replace `connectionLost` (lines 371-376) with:
```ts
  const connectionLost = (current: LiveEventSourceLike) => {
    if (stopped || source !== current) return;
    closeSource();
    handlers.onError?.();
    scheduleReconnect();
    // Asked in parallel with the retry, so an asleep host costs no delay;
    // a signed-out answer cancels the retry it is racing.
    if (handlers.stillSignedIn) {
      void handlers.stillSignedIn().then((signedIn) => {
        if (!signedIn) stop();
      }, () => {});
    }
  };
```
Replace the returned closure (lines 529-538) with a named `stop` and return it:
```ts
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(staleTimer);
    clearRetry();
    closeSource();
    platform.windowTarget?.removeEventListener("online", onOnline);
    platform.windowTarget?.removeEventListener("focus", onFocus);
    platform.documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
  return stop;
```
`src/state/store.tsx`:
- import: `import { checkSession, onSignedOut, sessionSignedOut } from "@/lib/session-check";` and `import { callNative, nativeAvailable } from "@/lib/native-shell";`
- `AppState` (after `connected: boolean;` at line 663):
```ts
  /** The door said this browser's session is gone (GET /session → 401).
   * Final for this page: the only way back is pairing again. */
  signedOut?: boolean;
```
- `Action` (after line 921): `| { type: "signedOut" }`
- reducer (after `case "connected":` at lines 1560-1561):
```ts
    case "signedOut":
      return { ...state, signedOut: true, connected: false };
```
- `initialState` (after `connected: false,` at line 1874): `signedOut: false,`
- `api()` — directly after `const body = await res.json().catch(() => ({}));` (line 1911):
```ts
  // Not proof on its own: a harness route answers 401 for a provider it
  // could not sign in to. The door's /session decides (lib/session-check.ts).
  if (res.status === 401) void checkSession();
```
- `schedulePeripheralRetry` — after the `isPermanentlyRefused` block closes (line 2762):
```ts
      // Signed out is as permanent as a surface gate for this page.
      if (sessionSignedOut()) return;
```
- `openLiveEvents({...})` (lines 3050-3064) — add the handler:
```ts
        stillSignedIn: async () => (await checkSession()) !== "signed-out",
```
- after the `stopApprovalClicks` block (line 3070), add:
```ts
    // Signed out: stop every loop that would keep knocking, and let the phone
    // app show its own re-pair screen. A browser gets SignedOutCard.
    const stopSignedOut = onSignedOut(() => {
      rawDispatch({ type: "signedOut" });
      liveClosed = true;
      stopLive?.();
      for (const refresh of peripheralRefresh.values()) {
        if (refresh.timer) clearTimeout(refresh.timer);
        refresh.timer = null;
      }
      void nativeAvailable("rePair")
        .then((available) => (available ? callNative("rePair") : undefined))
        .catch(() => {});
    });
```
  and in the cleanup (line 3080, beside `stopApprovalClicks?.();`): `stopSignedOut();`

Create `src/components/SignedOutCard.tsx`:
```tsx
// SIGNED OUT, SAID ONCE, WITH THE WAY BACK.
//
// Reached only after the door itself answered GET /session with 401
// (src/lib/session-check.ts), never on an API 401 alone. Before this, a phone
// whose session had been revoked or had expired kept its last screen, kept
// reconnecting every ten seconds, and never said why nothing arrived.
//
// Inside the phone app the store has already asked native to re-pair; this
// card is what shows underneath while it does, and the fallback if it cannot.
import { LogIn } from "lucide-react";

import { callNative, nativeHas } from "@/lib/native-shell";
import { PAIR_AGAIN_PATH } from "@/lib/session-check";

export async function pairAgain(): Promise<void> {
  if (nativeHas("rePair")) {
    try {
      await callNative("rePair");
      return;
    } catch {
      /* fall through to the door's own code page */
    }
  }
  globalThis.location.assign(PAIR_AGAIN_PATH);
}

export function SignedOutCard() {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="signed-out-title"
      aria-describedby="signed-out-body"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-app/95 p-4"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
    >
      <div className="w-full max-w-[420px] rounded-2xl border border-hairline/60 bg-panel p-6">
        <h2 id="signed-out-title" className="text-[16px] font-medium text-ink">
          Signed out. Pair again
        </h2>
        <p id="signed-out-body" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          This device is no longer signed in to your Murage. Your conversations are safe on your computer.
          Pair again with the code Murage shows on your computer.
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => void pairAgain()}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <LogIn size={16} aria-hidden="true" />
          Pair again
        </button>
      </div>
    </div>
  );
}
```
`src/App.tsx` — `import { SignedOutCard } from "@/components/SignedOutCard";`; directly after `<ServerLifecycleBanner />` (line 271):
```tsx
      {/* Only after the door itself said 401 (lib/session-check.ts). */}
      {state.signedOut && <SignedOutCard />}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/live-events.test.ts src/state/store.test.ts src/components/SignedOutCard.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/live-events.ts src/lib/live-events.test.ts src/state/store.tsx src/state/store.test.ts src/components/SignedOutCard.tsx src/components/SignedOutCard.test.ts src/App.tsx`
`git commit -m "fix(mobile): a revoked or expired session stops reconnecting and asks to pair again"`

---

### Task D8: Reconnect the event stream when the phone app resumes

**Files:**
- Modify: `src/lib/live-events.ts:38-45` (platform), `:248-294` (`browserPlatform`), `:523-528` + D7's `stop`
- Test: `src/lib/live-events.test.ts`

**Interfaces:**
- Consumes: D1 `onNativeEvent("resume", …)`.
- Produces: `LiveEventsPlatform.resumeSignal?: (listener: () => void) => () => void`.

- [ ] **Step 1: Write the failing test**
```ts
describe("the phone app coming back to the front", () => {
  it("replaces even a stream that looks healthy, since iOS can freeze a socket without an error", () => {
    const fixture = harness();
    let resume: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const onError = vi.fn();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, onError },
      { ...fixture.platform, resumeSignal: (listener) => { resume = listener; return unsubscribe; } },
    );
    fixture.sources[0]!.open();
    resume!();
    expect(fixture.sources[0]!.close).toHaveBeenCalled();
    expect(fixture.sources).toHaveLength(2);
    expect(onError).toHaveBeenCalledOnce(); // the old stream is reported gone, then replaced
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    resume!();
    expect(fixture.sources).toHaveLength(2);
  });

  it("does nothing on resume while offline; the online event reconnects instead", () => {
    const fixture = harness();
    let resume: (() => void) | undefined;
    openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true },
      { ...fixture.platform, resumeSignal: (listener) => { resume = listener; return () => {}; } },
    );
    fixture.setOnline(false);
    resume!();
    expect(fixture.sources).toHaveLength(1);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/live-events.test.ts -t "coming back to the front"`
Expected: FAIL — `resume` is undefined (`TypeError: resume is not a function`).
- [ ] **Step 3: Write minimal implementation**
In `src/lib/live-events.ts`: add `import { onNativeEvent } from "./native-shell";` at the top; add to `LiveEventsPlatform` (after `now` at line 44):
```ts
  /** The phone app's `resume` (spec §3.6). Absent everywhere else. */
  resumeSignal?: (listener: () => void) => () => void;
```
in `browserPlatform`'s returned object (after `now:` at line 292):
```ts
    resumeSignal: overrides.resumeSignal ?? ((listener) => onNativeEvent("resume", listener)),
```
after the three `addEventListener` lines (525-527):
```ts
  // Resume is the phone app's own word that the page is back in front. A
  // suspended iOS WebView can hand back a socket that died without an error,
  // and the 40 s stale watchdog would leave the person looking at old state
  // for that long; replace it now, and forgive earlier backoff.
  const stopResume =
    platform.resumeSignal?.(() => {
      if (stopped) return;
      retryAttempt = 0;
      reconnectNow(source !== null);
    }) ?? null;
```
and add `stopResume?.();` as the last line inside D7's `stop` body.
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/live-events.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/live-events.ts src/lib/live-events.test.ts`
`git commit -m "fix(mobile): the event stream reconnects the moment the phone app comes back"`

---

### Task D9: `openNotificationTarget` accepts a thread with no bot; the store knows it has hydrated

**Files:**
- Modify: `src/state/store.tsx:977-1001` (`openNotificationTarget`), `:1123-1157` (`hydrate` reducer case), `AppState` (`:615-686`), `initialState` (`:1850-1880`)
- Test: `src/state/store.test.ts` (extend `describe("notification routing", …)` at lines 283-352)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `openNotificationTarget(dispatch, target: { botId?: string; threadId: string }, state): boolean` — `true` when something was opened
  - `AppState.hydrated?: boolean`, set by the `hydrate` action

- [ ] **Step 1: Write the failing test**
Add inside `describe("notification routing", …)`:
```ts
  it("finds the bot from a thread id alone (a phone notification or a deep link)", () => {
    const dispatch = vi.fn();
    expect(openNotificationTarget(dispatch, { threadId: "detached-thread" }, { bots, groups })).toBe(true);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("finds the room from a thread id alone", () => {
    const dispatch = vi.fn();
    expect(openNotificationTarget(dispatch, { threadId: "older-room-thread" }, { bots, groups })).toBe(true);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "room-1" },
      { type: "switchGroupTask", groupId: "room-1", threadId: "older-room-thread" },
    ]);
  });

  it("opens nothing for a thread nobody on this device owns, and says so", () => {
    // Hidden from this phone by its visibility scope, or deleted since.
    const dispatch = vi.fn();
    expect(openNotificationTarget(dispatch, { threadId: "someone-elses-thread" }, { bots, groups })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still returns true on the existing botId path", () => {
    expect(openNotificationTarget(vi.fn(), { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups })).toBe(true);
  });
```
and a new block:
```ts
describe("hydration", () => {
  it("is false until the first snapshot lands", () => {
    expect(initialState.hydrated).toBe(false);
    expect(reducer(initialState, { type: "hydrate", bots: [], groups: [], computerControl: {} }).hydrated).toBe(true);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/state/store.test.ts -t "thread id alone|nobody on this device|existing botId path|hydration"`
Expected: FAIL — `select` is dispatched with `id: undefined`; returns `undefined`; `hydrated` is `undefined`.
- [ ] **Step 3: Write minimal implementation**
Replace `openNotificationTarget` (lines 977-1001) with:
```ts
export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: { botId?: string; threadId: string },
  state: NotificationRoutingState,
): boolean {
  // A room's approval/question notification carries the asker bot with the
  // GROUP's thread id; asking the bot to switch to that thread would 404.
  // Open the room itself. A thread that is neither a room nor one of the
  // bot's own lands on a plain bot select instead of an error banner.
  const group = state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
  );
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) {
      dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
    }
    return true;
  }
  // A phone notification and a #open= link carry only the thread (spec
  // §3.5 step 2). Its bot is whoever owns it in the snapshot just loaded;
  // nobody owning it means this device cannot see it, and nothing opens.
  const botId =
    target.botId ??
    state.bots.find(
      (candidate) =>
        candidate.threadId === target.threadId ||
        (candidate.tasks ?? []).some((task) => task.threadId === target.threadId),
    )?.id;
  if (!botId) return false;
  dispatch({ type: "select", id: botId });
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot) return true;
  const known =
    bot.threadId === target.threadId ||
    (bot.tasks ?? []).some((task) => task.threadId === target.threadId);
  if (known) dispatch({ type: "switchTask", botId, threadId: target.threadId });
  return true;
}
```
`AppState` (after `connected: boolean;`): 
```ts
  /** The first REST snapshot has been applied. A deep link waits for it:
   * before then no thread can be placed. */
  hydrated?: boolean;
```
`initialState`: `hydrated: false,`. In the `hydrate` case (lines 1148-1156) add `hydrated: true,` to the object passed to `reconcileSnapshotQueues` (beside `selectedId,`).
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/state/store.test.ts`
Expected: PASS (the four existing routing tests at lines 294-331 are unchanged in their dispatches).
- [ ] **Step 5: Commit**
`git add src/state/store.tsx src/state/store.test.ts`
`git commit -m "feat(mobile): a notification can open a conversation from its thread alone"`

---

### Task D10: Deep links (`#open=<threadId>&msg=<messageId>`) and `notificationOpened`

**Files:**
- Create: `src/lib/deep-link.ts`
- Create: `src/components/useDeepLinks.ts`
- Modify: `src/App.tsx:32-39` (mount the hook in `Shell`)
- Test: `src/lib/deep-link.test.ts`

**Interfaces:**
- Consumes: D9 `openNotificationTarget` (boolean), `AppState.hydrated`; D1 `onNativeEvent("notificationOpened")`, `nativeAvailable`, `callNative("ready")`.
- Produces:
  - `interface DeepLinkTarget { threadId: string; messageId?: string }`
  - `parseOpenHash(hash: string): DeepLinkTarget | null`
  - `openHashHref(pathname: string, search: string): string` (the URL with the fragment removed)
  - `createDeepLinkQueue(open: (target: DeepLinkTarget) => void): { push(target): void; ready(): void }`
  - `openDeepLink(target, state, dispatch): boolean`
  - `useDeepLinks(): void`

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/deep-link.test.ts
// A link into one message: `#open=<threadId>&msg=<messageId>` from the phone
// app or a pasted URL, and the app's notificationOpened event. Nothing can be
// placed until the first snapshot has loaded, so targets wait for it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createDeepLinkQueue, openDeepLink, openHashHref, parseOpenHash } from "./deep-link";

describe("reading the fragment", () => {
  it("reads a thread and a message", () => {
    expect(parseOpenHash("#open=thread-1&msg=message-9")).toEqual({ threadId: "thread-1", messageId: "message-9" });
    expect(parseOpenHash("#open=thread%2F1")).toEqual({ threadId: "thread/1" });
  });

  it("leaves every other fragment alone, including the door's pairing link", () => {
    // /enter#murage_pair_… is the door's; it must never be read or cleared here.
    expect(parseOpenHash("#murage_pair_abcdef")).toBeNull();
    expect(parseOpenHash("")).toBeNull();
    expect(parseOpenHash("#msg=m1&open=t1")).toBeNull();
  });

  it("refuses ids that are empty or absurdly long, and drops a bad message id only", () => {
    expect(parseOpenHash("#open=")).toBeNull();
    expect(parseOpenHash(`#open=${"t".repeat(513)}`)).toBeNull();
    expect(parseOpenHash(`#open=t1&msg=${"m".repeat(513)}`)).toEqual({ threadId: "t1" });
  });

  it("removes the fragment and keeps the path and query", () => {
    expect(openHashHref("/", "?x=1")).toBe("/?x=1");
  });
});

describe("waiting for the snapshot", () => {
  it("holds a target until ready, then opens it once", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.push({ threadId: "t1" });
    expect(open).not.toHaveBeenCalled();
    queue.ready();
    queue.ready();
    expect(open.mock.calls).toEqual([[{ threadId: "t1" }]]);
  });

  it("opens the newest of several early taps, not all of them in a row", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.push({ threadId: "t1" });
    queue.push({ threadId: "t2", messageId: "m2" });
    queue.ready();
    expect(open.mock.calls).toEqual([[{ threadId: "t2", messageId: "m2" }]]);
  });

  it("opens at once after ready", () => {
    const open = vi.fn();
    const queue = createDeepLinkQueue(open);
    queue.ready();
    queue.push({ threadId: "t3" });
    expect(open).toHaveBeenCalledWith({ threadId: "t3" });
  });
});

describe("opening", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }];

  it("opens the thread and lands on the message", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "detached-thread", messageId: "m1" }, { bots, groups: [] }, dispatch)).toBe(true);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
      { type: "focusMessage", threadId: "detached-thread", messageId: "m1" },
    ]);
  });

  it("focuses nothing when the thread cannot be placed", () => {
    const dispatch = vi.fn();
    expect(openDeepLink({ threadId: "gone", messageId: "m1" }, { bots, groups: [] }, dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it("is mounted once, in the shell", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  expect(app).toContain("useDeepLinks();");
  const hook = readFileSync(fileURLToPath(new URL("../components/useDeepLinks.ts", import.meta.url)), "utf8");
  expect(hook).toContain('onNativeEvent("notificationOpened"');
  expect(hook).toContain('window.addEventListener("hashchange"');
  expect(hook).toContain("if (state.hydrated) queue.ready();");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/deep-link.test.ts`
Expected: FAIL with "Failed to resolve import "./deep-link""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/deep-link.ts
// A link to one message: `#open=<threadId>&msg=<messageId>` (spec §3.6).
//
// There was no URL routing at all before this. The fragment is used rather
// than a path because the door serves the same shell for every path and a
// fragment never reaches a server log. Only a fragment that STARTS with
// `open=` is ours: `/enter#murage_pair_…` belongs to the door and is left
// exactly as it is.
import { openNotificationTarget, type Action, type AppState } from "@/state/store";

export interface DeepLinkTarget {
  threadId: string;
  messageId?: string;
}

const MAX_ID = 512;
const id = (value: string | null): value is string => value !== null && value.length > 0 && value.length <= MAX_ID;

export function parseOpenHash(hash: string): DeepLinkTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("open=")) return null;
  const params = new URLSearchParams(raw);
  const threadId = params.get("open");
  const messageId = params.get("msg");
  if (!id(threadId)) return null;
  return id(messageId) ? { threadId, messageId } : { threadId };
}

/** The current URL without its fragment, for history.replaceState. */
export function openHashHref(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

/** Targets that arrive before the first snapshot wait for it. Only the
 * newest waits: three quick taps on three notifications mean the last one. */
export function createDeepLinkQueue(open: (target: DeepLinkTarget) => void) {
  let isReady = false;
  let pending: DeepLinkTarget | null = null;
  return {
    push(target: DeepLinkTarget) {
      if (isReady) open(target);
      else pending = target;
    },
    ready() {
      if (isReady) return;
      isReady = true;
      const target = pending;
      pending = null;
      if (target) open(target);
    },
  };
}

export function openDeepLink(
  target: DeepLinkTarget,
  state: Pick<AppState, "bots" | "groups">,
  dispatch: (action: Action) => void,
): boolean {
  const placed = openNotificationTarget(dispatch, { threadId: target.threadId }, state);
  // focusMessage pages back through scrollback until the message is held
  // (store.tsx, the wrapped "focusMessage" case).
  if (placed && target.messageId) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
  return placed;
}
```
```ts
// src/components/useDeepLinks.ts
// Where a link or a tapped phone notification lands. Mounted once, in Shell.
import { useEffect, useMemo, useRef } from "react";

import { useStore } from "@/state/store";
import { createDeepLinkQueue, openDeepLink, openHashHref, parseOpenHash } from "@/lib/deep-link";
import { callNative, nativeAvailable, onNativeEvent } from "@/lib/native-shell";

export function useDeepLinks() {
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  const queue = useMemo(
    () =>
      createDeepLinkQueue((target) => {
        // Cleared AFTER it is handled, so a crash before hydration reopens it
        // on reload. replaceState fires no hashchange, so it cannot loop.
        if (parseOpenHash(window.location.hash)) {
          history.replaceState(history.state, "", openHashHref(window.location.pathname, window.location.search));
        }
        if (!openDeepLink(target, latest.current, dispatch)) {
          dispatch({ type: "error", message: "That conversation isn't available on this device." });
        }
      }),
    [dispatch],
  );

  useEffect(() => {
    const fromHash = () => {
      const target = parseOpenHash(window.location.hash);
      if (target) queue.push(target);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    // bindingId has already chosen this workspace on the native side
    // (spec §3.5 step 1); the page only needs the thread and message.
    const stopNative = onNativeEvent("notificationOpened", ({ threadId, messageId }) =>
      queue.push(messageId ? { threadId, messageId } : { threadId }));
    return () => {
      window.removeEventListener("hashchange", fromHash);
      stopNative();
    };
  }, [queue]);

  const toldNativeReady = useRef(false);
  useEffect(() => {
    if (state.hydrated) queue.ready();
    // The phone app keeps its splash up until the UI says it is ready and
    // shows "Loading is taking a while" after 20 s (spec §3.2). The first
    // applied snapshot is that moment.
    if (!state.hydrated || toldNativeReady.current) return;
    toldNativeReady.current = true;
    void nativeAvailable("ready").then((available) => (available ? callNative("ready") : undefined)).catch(() => {});
  }, [state.hydrated, queue]);
}
```
In `src/App.tsx`, `import { useDeepLinks } from "@/components/useDeepLinks";` and inside `Shell` right after `const { state, dispatch } = useStore();` (line 33):
```ts
  // #open=<thread>&msg=<message> and the phone app's notificationOpened.
  useDeepLinks();
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/deep-link.test.ts src/state/store.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/deep-link.ts src/lib/deep-link.test.ts src/components/useDeepLinks.ts src/App.tsx`
`git commit -m "feat(mobile): #open= links and tapped phone notifications land on the exact message"`

---

### Task D11: Remote offline banner

**Files:**
- Create: `src/components/RemoteConnectionBanner.tsx`
- Modify: `src/App.tsx:271` (mount), `:334-338` (desktop-only wording)
- Test: `src/components/RemoteConnectionBanner.test.ts`

**Interfaces:**
- Consumes: `state.connected` (set by `openLiveEvents` `onOpen`/`onError`, `store.tsx:3051-3052`), `state.signedOut` (D7), `useDesktopSurface()`.
- Produces: `REMOTE_OFFLINE_GRACE_MS = 3_000`, `remoteConnectionNotice(input): string | null`, `RemoteConnectionBanner`.

- [ ] **Step 1: Write the failing test**
```ts
// src/components/RemoteConnectionBanner.test.ts
// ServerLifecycleBanner speaks for the desktop's own engine and renders
// nothing without the Electron bridge (ServerLifecycleBanner.tsx:33). A
// phone whose computer went to sleep had no sentence at all, and the one
// fallback it could reach said "quit Murage and open it again" — advice for
// a desktop app the phone does not have.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REMOTE_OFFLINE_GRACE_MS, remoteConnectionNotice } from "./RemoteConnectionBanner";

const input = (over: Partial<Parameters<typeof remoteConnectionNotice>[0]> = {}) => ({
  connected: false,
  signedOut: false,
  offlineSince: 0,
  now: REMOTE_OFFLINE_GRACE_MS,
  ...over,
});

describe("what a remote client is told", () => {
  it("says it cannot reach the computer, and that it reconnects by itself", () => {
    const text = remoteConnectionNotice(input());
    expect(text).toMatch(/Can't reach your Murage/);
    expect(text).not.toMatch(/quit|server/i);
  });

  it("stays quiet for a blip shorter than the grace period", () => {
    expect(remoteConnectionNotice(input({ now: REMOTE_OFFLINE_GRACE_MS - 1 }))).toBeNull();
  });

  it("says nothing while connected, and leaves signed-out to its own card", () => {
    expect(remoteConnectionNotice(input({ connected: true }))).toBeNull();
    expect(remoteConnectionNotice(input({ signedOut: true }))).toBeNull();
    expect(remoteConnectionNotice(input({ offlineSince: null }))).toBeNull();
  });
});

describe("where it appears", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("renders on a confirmed remote surface only", () => {
    expect(app).toContain("{desktop === false && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}");
  });

  it("keeps the quit-and-reopen advice for the desktop only", () => {
    expect(app).toMatch(/desktop === true\s*\?\s*"This usually clears on its own\. If it does not, quit Murage and open it again\."/);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/components/RemoteConnectionBanner.test.ts`
Expected: FAIL with "Failed to resolve import "./RemoteConnectionBanner""
- [ ] **Step 3: Write minimal implementation**
```tsx
// src/components/RemoteConnectionBanner.tsx
// WHEN THE COMPUTER CANNOT BE REACHED, SAY SO — ON THE PHONE.
//
// The desktop's banner (ServerLifecycleBanner) reports its own engine through
// the Electron bridge and is silent everywhere else. A phone or another
// browser reaching Murage through the door had nothing: the live stream
// dropped, `connected` went false, and the screen simply stopped changing.
//
// Driven by the same `connected` flag the event stream sets. A short grace
// keeps a resume or a network hand-off from flashing it.
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export const REMOTE_OFFLINE_GRACE_MS = 3_000;

export function remoteConnectionNotice(input: {
  connected: boolean;
  signedOut: boolean;
  offlineSince: number | null;
  now: number;
}): string | null {
  if (input.connected || input.signedOut || input.offlineSince === null) return null;
  if (input.now - input.offlineSince < REMOTE_OFFLINE_GRACE_MS) return null;
  // Not "the server": nobody installed a server. And it answers the real
  // question, which is whether what they typed is lost.
  return "Can't reach your Murage right now. Anything you type is kept, and this reconnects by itself once your computer is awake and online.";
}

export function RemoteConnectionBanner({ connected, signedOut }: { connected: boolean; signedOut: boolean }) {
  const [offlineSince, setOfflineSince] = useState<number | null>(() => (connected ? null : Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connected) {
      setOfflineSince(null);
      return;
    }
    const since = Date.now();
    setOfflineSince((current) => current ?? since);
    const timer = setTimeout(() => setNow(Date.now()), REMOTE_OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const text = remoteConnectionNotice({ connected, signedOut, offlineSince, now });
  if (!text) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 bg-raised px-4 py-2 text-[13px] font-medium text-ink"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.5rem)" }}
    >
      <WifiOff size={14} className="shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
```
`src/App.tsx` — `import { RemoteConnectionBanner } from "@/components/RemoteConnectionBanner";`; after `<ServerLifecycleBanner />` (line 271, before D7's card):
```tsx
      {/* The remote counterpart: a phone or browser whose computer went quiet. */}
      {desktop === false && <RemoteConnectionBanner connected={state.connected} signedOut={state.signedOut === true} />}
```
and replace lines 334-338 with:
```tsx
          {!state.connected && (
            <div className="text-[12px]">
              {desktop === true
                ? "This usually clears on its own. If it does not, quit Murage and open it again."
                : "This usually clears on its own once your computer is awake and online."}
            </div>
          )}
```
(`undefined` gets the neutral remote wording, per the rule in `use-surface.ts:12-20`.)
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/components/RemoteConnectionBanner.test.ts src/lib/user-facing-copy.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/components/RemoteConnectionBanner.tsx src/components/RemoteConnectionBanner.test.ts src/App.tsx`
`git commit -m "feat(mobile): a phone says when it cannot reach the computer, in words for a phone"`

---

### Task D12: Pause interval pollers while the page is hidden

**Files:**
- Modify: `src/components/Inbox.tsx:242-246`
- Modify: `src/components/SidebarPhoneButton.tsx:120-153`
- Modify: `src/components/WorkspacePane.tsx:667-700`
- (No edit) `src/components/ComputerPanel.tsx:590-665` — all three screenshot pollers already gate on `pageVisible` (lines 591, 615, 644); pinned by the test only.
- Test: `src/lib/page-visible.test.ts`

**Interfaces:**
- Consumes: `usePageVisible()` (`src/lib/page-visible.ts`).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/page-visible.test.ts
// Every setInterval poller stops while the page is hidden (spec §3.6). A
// phone that locks with the Inbox open used to wake its radio every 5 s for
// a list nobody could see. The pattern is ComputerPanel's: the effect
// returns early when hidden and lists pageVisible in its deps, so it tears
// its interval down and builds it again on return.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

/** The effect around each setInterval: from its useEffect( to its deps. */
function pollers(source: string): string[] {
  const out: string[] = [];
  for (let at = source.indexOf("setInterval("); at >= 0; at = source.indexOf("setInterval(", at + 1)) {
    const start = source.lastIndexOf("useEffect(", at);
    const end = source.indexOf("]);", at);
    expect(start, "a poller outside an effect").toBeGreaterThan(-1);
    out.push(source.slice(start, end + 3));
  }
  return out;
}

describe("pollers pause while hidden", () => {
  it.each([["Inbox.tsx", 1], ["SidebarPhoneButton.tsx", 1], ["WorkspacePane.tsx", 1], ["ComputerPanel.tsx", 3]])(
    "%s",
    (file, count) => {
      const source = read(file);
      expect(source).toContain("usePageVisible()");
      const found = pollers(source);
      expect(found).toHaveLength(count);
      for (const effect of found) {
        expect(effect).toMatch(/!pageVisible\)?\s*\)?\s*return;|\|\| !pageVisible\) return;/);
        expect(effect).toMatch(/\[[^\]]*\bpageVisible\b[^\]]*\]\);$/);
      }
    },
  );

  it("the Inbox and the file probe look again the moment the page comes back", () => {
    expect(read("Inbox.tsx")).toContain("if (wasHidden.current) { wasHidden.current = false; setRevision(current => current + 1); }");
    expect(read("WorkspacePane.tsx")).toContain("if (probeOnShow.current) { probeOnShow.current = false; void probe(); }");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/page-visible.test.ts`
Expected: FAIL — `Inbox.tsx`, `SidebarPhoneButton.tsx`, `WorkspacePane.tsx` do not contain `usePageVisible()`.
- [ ] **Step 3: Write minimal implementation**
`src/components/Inbox.tsx` — `import { usePageVisible } from "@/lib/page-visible";`; replace lines 242-246 with:
```ts
  // Hidden (a locked phone, a background tab): no 5 s reads nobody can see.
  const pageVisible = usePageVisible();
  const wasHidden = useRef(false);
  useEffect(() => {
    if (view !== "decisions") return;
    if (!pageVisible) { wasHidden.current = true; return; }
    if (wasHidden.current) { wasHidden.current = false; setRevision(current => current + 1); }
    const timer = window.setInterval(() => setRevision(current => current + 1), 5000);
    return () => window.clearInterval(timer);
  }, [view, pageVisible]);
```
`src/components/SidebarPhoneButton.tsx` — `import { usePageVisible } from "@/lib/page-visible";`; in `useSidebarPhoneStatus` add `const pageVisible = usePageVisible();` before the effect, add after the `if (!companion) {…}` block (line 128):
```ts
    // Hidden: the 15 s bridge poll waits; the refresh below runs on return.
    if (!pageVisible) return;
```
and change the deps `}, []);` (line 151) to `}, [pageVisible]);`.
`src/components/WorkspacePane.tsx` — `import { usePageVisible } from "@/lib/page-visible";`; before the effect at line 667 add:
```ts
  const pageVisible = usePageVisible();
  const probeOnShow = useRef(false);
```
change the effect's first line (668) to:
```ts
    if (load.status !== "ready" && load.status !== "editor") return;
    // Hidden: no interval at all. The probe used to skip its work while
    // hidden (below) but the timer still woke every tick.
    if (!pageVisible) { probeOnShow.current = true; return; }
```
after `const probe = async () => { … };` (ends line 694) add:
```ts
    if (probeOnShow.current) { probeOnShow.current = false; void probe(); }
```
and change the deps (line 700) to `}, [load.status, tab.id, probeMs, pageVisible]);`.
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/page-visible.test.ts src/components/WorkspacePane.test.ts src/components/SidebarPhoneButton.test.ts src/components/InboxViews.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/components/Inbox.tsx src/components/SidebarPhoneButton.tsx src/components/WorkspacePane.tsx src/lib/page-visible.test.ts`
`git commit -m "fix(mobile): pollers stop while the page is hidden and look again when it returns"`

---

### Task D13: Reload once when a lazy chunk fails after a host update

**Files:**
- Create: `src/lib/chunk-reload.ts`
- Modify: `src/main.tsx` (install before render)
- Test: `src/lib/chunk-reload.test.ts`

**Interfaces:**
- Consumes: Vite 7's `vite:preloadError` window event (fired by the preload helper when a dynamic import fails; `preventDefault()` stops it rethrowing).
- Produces: `CHUNK_RELOAD_KEY = "murage-chunk-reload-at"`, `CHUNK_RELOAD_WINDOW_MS = 60_000`, `shouldReloadForChunk(lastAt: string | null, now: number): boolean`, `installChunkReload(deps: ChunkReloadDeps): () => void`, `browserChunkReloadDeps(): ChunkReloadDeps`.

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/chunk-reload.test.ts
// The phone keeps a page open for days; the computer updates Murage under
// it. The next lazy screen then asks for a chunk whose hashed name no longer
// exists, and the tap does nothing. One reload fetches the new shell. A
// sessionStorage stamp makes it ONE: a chunk that is genuinely broken must
// surface its error, not reload the page in a loop.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, installChunkReload, shouldReloadForChunk } from "./chunk-reload";

function fixture(initial: Record<string, string> = {}, options: { denied?: boolean } = {}) {
  const values = new Map(Object.entries(initial));
  let handler: ((event: Event) => void) | undefined;
  let now = 1_000_000;
  const reload = vi.fn();
  const target = { addEventListener: vi.fn((_: string, h: any) => { handler = h; }), removeEventListener: vi.fn() };
  const storage = {
    getItem: (key: string) => { if (options.denied) throw new Error("denied"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (options.denied) throw new Error("denied"); values.set(key, value); },
  };
  const stop = installChunkReload({ target, storage: () => storage, reload, now: () => now });
  const fail = () => { const event = { preventDefault: vi.fn() } as unknown as Event; handler!(event); return event; };
  return { fail, reload, values, stop, target, advance: (ms: number) => { now += ms; } };
}

describe("a missing chunk after an update", () => {
  it("reloads once and swallows the error it replaces", () => {
    const f = fixture();
    const event = f.fail();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(f.values.get(CHUNK_RELOAD_KEY)).toBe("1000000");
  });

  it("does not reload again inside the window, so a broken chunk cannot loop", () => {
    const f = fixture({ [CHUNK_RELOAD_KEY]: "1000000" });
    const event = f.fail();
    expect(f.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("reloads again for a later update in the same session", () => {
    const f = fixture({ [CHUNK_RELOAD_KEY]: "1000000" });
    f.advance(CHUNK_RELOAD_WINDOW_MS);
    f.fail();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it("never reloads when the stamp cannot be written — that would be the loop", () => {
    const f = fixture({}, { denied: true });
    f.fail();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("reads a garbled or future stamp as none", () => {
    expect(shouldReloadForChunk("garbage", 5)).toBe(true);
    expect(shouldReloadForChunk("99999999", 5)).toBe(true);
    expect(shouldReloadForChunk(null, 5)).toBe(true);
  });

  it("is installed before the first render", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main.indexOf("installChunkReload(browserChunkReloadDeps());")).toBeGreaterThan(-1);
    expect(main.indexOf("installChunkReload(")).toBeLessThan(main.indexOf("createRoot("));
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/chunk-reload.test.ts`
Expected: FAIL with "Failed to resolve import "./chunk-reload""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/chunk-reload.ts
// A lazy chunk that 404s because the computer updated Murage while this page
// stayed open. Vite reports it as `vite:preloadError` on window; one reload
// fetches the new shell and its new chunk names.
//
// ONE reload. The stamp lives in sessionStorage, and a failure within the
// window after it is left to throw — a chunk that is broken for real must
// reach RootErrorBoundary, not spin the page. No storage, no reload, for
// the same reason.

export const CHUNK_RELOAD_KEY = "murage-chunk-reload-at";
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

export interface ChunkReloadDeps {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  storage: () => Pick<Storage, "getItem" | "setItem"> | undefined;
  reload: () => void;
  now: () => number;
}

export function shouldReloadForChunk(lastAt: string | null, now: number): boolean {
  if (!lastAt) return true;
  const last = Number(lastAt);
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= CHUNK_RELOAD_WINDOW_MS;
}

export function installChunkReload(deps: ChunkReloadDeps): () => void {
  const onPreloadError = (event: Event) => {
    try {
      const store = deps.storage();
      if (!store || !shouldReloadForChunk(store.getItem(CHUNK_RELOAD_KEY), deps.now())) return;
      store.setItem(CHUNK_RELOAD_KEY, String(deps.now()));
    } catch {
      return;
    }
    event.preventDefault();
    deps.reload();
  };
  deps.target.addEventListener("vite:preloadError", onPreloadError);
  return () => deps.target.removeEventListener("vite:preloadError", onPreloadError);
}

export function browserChunkReloadDeps(): ChunkReloadDeps {
  return {
    target: window,
    storage: () => sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}
```
In `src/main.tsx`, `import { browserChunkReloadDeps, installChunkReload } from "./lib/chunk-reload";` and before `createRoot(` (line 26):
```ts
// A lazy screen whose chunk vanished in a host update reloads once.
installChunkReload(browserChunkReloadDeps());
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/chunk-reload.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/chunk-reload.ts src/lib/chunk-reload.test.ts src/main.tsx`
`git commit -m "fix(mobile): a screen whose code vanished in an update reloads once instead of doing nothing"`

---

### Task D14: Composer on touch — Return is a newline, the arrow sends

**Files:**
- Create: `src/lib/composer-enter.ts`
- Modify: `src/lib/media-query.ts` (add `useCoarsePointer`)
- Modify: `src/components/Composer.tsx:9, 227, 1084, 1180-1184`
- Test: `src/lib/composer-enter.test.ts`

**Interfaces:**
- Consumes: `matchMedia("(pointer: coarse)")`.
- Produces: `COARSE_POINTER_QUERY = "(pointer: coarse)"`, `useCoarsePointer(): boolean`, `enterSends(key, touch): boolean`.

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/composer-enter.test.ts
// On a phone the Return key is how you start a new line; the arrow button is
// how you send (spec §3.6). Sending on Return meant every attempt at a
// two-line message went out as one line and a stray second message.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { enterSends } from "./composer-enter";

const key = (over: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...over,
});

describe("what Enter does", () => {
  it("sends with a mouse and keyboard, and Shift+Enter is a newline — unchanged", () => {
    expect(enterSends(key(), false)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false);
    expect(enterSends(key({ metaKey: true }), false)).toBe(true);
  });

  it("is a newline on a touch screen", () => {
    expect(enterSends(key(), true)).toBe(false);
    expect(enterSends(key({ shiftKey: true }), true)).toBe(false);
  });

  it("still sends on ⌘/Ctrl+Enter from a keyboard attached to a tablet", () => {
    expect(enterSends(key({ metaKey: true }), true)).toBe(true);
    expect(enterSends(key({ ctrlKey: true }), true)).toBe(true);
  });

  it("never sends mid-composition (Japanese, Chinese, Korean input)", () => {
    expect(enterSends(key({ isComposing: true }), false)).toBe(false);
    expect(enterSends(key({ isComposing: true, metaKey: true }), true)).toBe(false);
  });

  it("ignores every other key", () => {
    expect(enterSends(key({ key: "a" }), false)).toBe(false);
  });
});

it("the composer asks enterSends, and tells the keyboard what Return does", () => {
  const composer = readFileSync(new URL("../components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("const coarsePointer = useCoarsePointer();");
  expect(composer).toContain("if (enterSends(");
  expect(composer).not.toContain('e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing');
  expect(composer).toContain('enterKeyHint={coarsePointer ? "enter" : "send"}');
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/composer-enter.test.ts`
Expected: FAIL with "Failed to resolve import "./composer-enter""
- [ ] **Step 3: Write minimal implementation**
```ts
// src/lib/composer-enter.ts
/** Whether this Enter sends the message.
 *
 * Mouse and keyboard: Enter sends, Shift+Enter is a newline (unchanged).
 * Touch: Return is a newline and the arrow button sends — a phone keyboard
 * has no Shift+Return, so without this there is no way to write two lines.
 * ⌘/Ctrl+Enter still sends on touch, for a tablet with a keyboard attached.
 * Never mid-composition: that Enter commits an IME candidate. */
export function enterSends(
  key: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean },
  touch: boolean,
): boolean {
  if (key.key !== "Enter" || key.isComposing) return false;
  if (touch) return key.metaKey || key.ctrlKey;
  return !key.shiftKey;
}
```
Append to `src/lib/media-query.ts`:
```ts
/** A finger is the primary pointer: phones, and tablets without a trackpad. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Reactive, for the same reason as useNarrowViewport: an iPad gains and
 * loses a trackpad without reloading the page. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => globalThis.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false);
  useEffect(() => {
    const mql = globalThis.matchMedia?.(COARSE_POINTER_QUERY);
    if (!mql) return;
    const apply = () => setCoarse(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return coarse;
}
```
`src/components/Composer.tsx`: line 9 → `import { useCoarsePointer, useNarrowViewport } from "@/lib/media-query";` plus `import { enterSends } from "@/lib/composer-enter";`; after line 227 (`const narrowPlaceholder = useNarrowViewport();`) add `const coarsePointer = useCoarsePointer();`; on the `<textarea` (line 1084) add the prop `enterKeyHint={coarsePointer ? "enter" : "send"}`; replace lines 1180-1184 with:
```tsx
            // Mouse and keyboard: Enter sends, Shift+Enter is a newline.
            // Touch: Return is a newline and the arrow button sends.
            if (enterSends({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing }, coarsePointer)) {
              e.preventDefault();
              send();
            }
```
(The picker branches above — slash commands and mentions, lines 1136-1172 — still take Enter first on every device.)
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/composer-enter.test.ts src/components/composer-key-guard.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/composer-enter.ts src/lib/composer-enter.test.ts src/lib/media-query.ts src/components/Composer.tsx`
`git commit -m "fix(mobile): on a touch screen Return starts a new line and the arrow sends"`

---

### Task D15: Failed sends survive a reload

**Files:**
- Modify: `src/lib/drafts.ts:39-42, 302-347`
- Test: `src/lib/drafts-outbox.test.ts`

**Interfaces:**
- Consumes: the existing `read`/`getStore` helpers (`drafts.ts:77-86, 365-371`).
- Produces: storage key `murage-draft-failed-sends` (`Record<draftId, FailedComposerSend[]>`), `MAX_FAILED_SENDS_PER_DRAFT = 20`. Public function signatures unchanged.

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/drafts-outbox.test.ts
// A send that failed after the person had already typed something newer
// goes to the composer's "failed" list (recoverFailedComposerSend →
// "outbox"). That list lived only in memory (drafts.ts:39), so a reload —
// or iOS killing a backgrounded WebView — lost the message outright.
import { afterEach, expect, it, vi } from "vitest";

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const load = async () => { vi.resetModules(); return import("./drafts"); };

it("keeps a failed send across a reload, and forgets it for good once dismissed", async () => {
  vi.stubGlobal("localStorage", storage());
  const first = await load();
  const id = "persist-outbox";
  const sent = { draftId: id, revision: first.draftRevision(id), sendId: "send-1", text: "Hello", requestText: "Hello", threadId: "thread-A", attachments: [] };
  first.markDraftEdited(id); // something newer is in the box, so this one goes to the outbox
  expect(first.recoverFailedComposerSend(sent)).toBe("outbox");

  const second = await load();
  const [kept] = second.failedComposerSends(id);
  expect(kept).toMatchObject({ sendId: "send-1", text: "Hello", requestText: "Hello", threadId: "thread-A" });
  second.forgetFailedComposerSend(id, kept!.id);

  expect((await load()).failedComposerSends(id)).toEqual([]);
});

it("drops tampered entries and keeps the valid ones", async () => {
  vi.stubGlobal("localStorage", storage({
    "murage-draft-failed-sends": JSON.stringify({
      d: [
        { id: "a", sendId: "s", text: "ok", requestText: "ok", threadId: "t" },
        { id: "b", sendId: 7, text: "bad", requestText: "bad", threadId: "t" },
        { id: "c", sendId: "s2", text: "mode", requestText: "mode", threadId: "t", channelMode: "shout" },
        "not an object",
      ],
    }),
  }));
  const drafts = await load();
  expect(drafts.failedComposerSends("d").map((send) => send.id)).toEqual(["a"]);
});

it("keeps at most 20 per conversation, newest last", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  for (let i = 0; i < 25; i += 1) {
    drafts.rememberFailedComposerSend("cap", { sendId: `s${i}`, text: `m${i}`, requestText: `m${i}`, threadId: "t" });
  }
  const reloaded = await load();
  const kept = reloaded.failedComposerSends("cap");
  expect(kept).toHaveLength(20);
  expect(kept.at(-1)?.sendId).toBe("s24");
});

it("still works in memory when storage is refused", async () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } });
  const drafts = await load();
  drafts.rememberFailedComposerSend("denied", { sendId: "s", text: "t", requestText: "t", threadId: "th" });
  expect(drafts.failedComposerSends("denied")).toHaveLength(1);
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/drafts-outbox.test.ts`
Expected: FAIL — after `load()` the list is `[]` (memory-only).
- [ ] **Step 3: Write minimal implementation**
In `src/lib/drafts.ts`, after `const CHANNEL_MODES_KEY = …` (line 10):
```ts
const FAILED_SENDS_KEY = "murage-draft-failed-sends";
/** A conversation's failed list is for retrying by hand, not an archive. */
const MAX_FAILED_SENDS_PER_DRAFT = 20;
```
after `let failedSendSequence = 0;` (line 42):
```ts
// Drafts whose stored failed list has been read into `failedSends`. Read
// lazily, per conversation, the way restoredSendId reads its stored id.
const loadedFailedSends = new Set<string>();

function isFailedSend(value: unknown): value is FailedComposerSend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const send = value as Record<string, unknown>;
  return (
    typeof send.id === "string" &&
    typeof send.sendId === "string" &&
    typeof send.text === "string" &&
    typeof send.requestText === "string" &&
    typeof send.threadId === "string" &&
    (send.replyToId === undefined || typeof send.replyToId === "string") &&
    (send.channelMode === undefined || send.channelMode === "chat" || send.channelMode === "goal")
  );
}

/** Best-effort, like every other draft write: a refused write leaves the
 * list in memory for this session, which is what it always was. */
function storeFailedSends(id: string, sends: FailedComposerSend[]): void {
  const store = getStore();
  const all = read(store, FAILED_SENDS_KEY);
  if (sends.length) all[id] = sends.slice(-MAX_FAILED_SENDS_PER_DRAFT);
  else delete all[id];
  try {
    store?.setItem(FAILED_SENDS_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode — the list still lives for this session */
  }
}
```
replace `failedComposerSends` (lines 302-304) with:
```ts
export function failedComposerSends(id: string): FailedComposerSend[] {
  if (!loadedFailedSends.has(id)) {
    loadedFailedSends.add(id);
    const stored = read(getStore(), FAILED_SENDS_KEY)[id];
    if (Array.isArray(stored) && !failedSends.has(id)) {
      const valid = stored.filter(isFailedSend).slice(-MAX_FAILED_SENDS_PER_DRAFT);
      if (valid.length) failedSends.set(id, valid);
    }
  }
  return failedSends.get(id) ?? [];
}
```
in `rememberFailedComposerSend` (lines 306-314) replace the `failedSends.set(…)` line with:
```ts
  const sends = [...failedComposerSends(id), failed].slice(-MAX_FAILED_SENDS_PER_DRAFT);
  failedSends.set(id, sends);
  storeFailedSends(id, sends);
```
and in `forgetFailedComposerSend` (lines 342-347) add `storeFailedSends(id, remaining);` before `publishFailedSends(id);`.
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/drafts-outbox.test.ts src/lib/draft-channel-mode.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
`git add src/lib/drafts.ts src/lib/drafts-outbox.test.ts`
`git commit -m "fix(drafts): a failed send survives a reload and the phone killing the app"`

---

## Notes for the plan author

1. **Two native contracts are defined here, not in the spec, and Plan 2 must implement them
   exactly.** Spec §3.2 lists event names but no delivery mechanism, and says only
   `saveFile(...)`. This plan fixes: events arrive through `murageNative.on(name, listener)`
   returning an unsubscribe function (D1), and `saveFile` takes the `NativeSaveRequest`
   union `{kind:"url"} | {kind:"begin"|"chunk"|"end"|"abort"}` with base64 chunks (D2). If
   Plan 2 prefers DOM `CustomEvent`s, only `onNativeEvent` changes.
2. **ComputerPanel needs no change for the lifecycle item.** All three screenshot pollers
   (`ComputerPanel.tsx:590-665`) already return early on `!pageVisible` and list it in deps.
   `WorkspacePane.tsx:671` already skipped the probe's work when hidden. Only its timer kept
   waking. D12 pins ComputerPanel and fixes the other three.
3. **`SidebarPhoneButton` is desktop-only in practice.** `companionBridge()` is the Electron
   bridge, so its 15 s poll never runs on a phone. D12 still pauses it because the spec names
   it and a hidden desktop window benefits too.
4. **An API 401 alone must never sign out.** `server/avatar-image.ts:297` answers 401 for a
   provider credential failure, and `companion/src/browser.ts:1194-1199` deliberately keeps
   renewal away from 401. D6 treats only `GET /session → 401` as signed out and everything
   else (404 from the dev server, 502, network error) as "unknown". It skips the check
   entirely when `window.muragebox` is present. This is a read of the Electron preload for a
   true-positive desktop signal only, the same way `use-surface.ts` reads it. `native-shell.ts`
   never reads it.
5. **Native URL saves lose the web-side validation.** `downloadConversation` checks 404 and
   `content-type: text/markdown` (`conversation-export.ts:15-20`). The native URL path cannot
   do that. Plan 2's native downloader must treat a non-2xx response as a failed save and
   must not write the door's 401 HTML page to disk as `conversation-….md`.
6. **Synchronous feature checks depend on the boot-time `hello()`.** `openExternalPage`,
   `saveCodeSnippet` and `routeNativeClicks` use synchronous `nativeHas`. This keeps the user
   gesture that popup blockers require, and keeps `saveCodeSnippet`'s boolean return. Before
   `hello()` resolves (at most 1.5 s after boot), they fall back to browser behaviour.
7. **New `AppState` fields are optional** (`signedOut?`, `hydrated?`). Several tests and
   helpers build `AppState`-shaped objects, and required fields would break `pnpm typecheck`
   in files outside this group. `initialState` sets both to `false`.
8. **Out of scope, but they touch these files:**
   - `setBadgeCount`, `backButton`, `haptic`, `appLock`, `signOut`, `registerPush`,
     `pushStatus` and `issuePushTokens` have no web wiring here (Plan 3 and phone polish).
   - `register-sw.ts` still registers the service worker inside the phone app. Whether a
     WKWebView on a remote origin should have one is a Plan 2 decision.
   - The composer placeholders still say "Enter sends this into the running turn"
     (`Composer.tsx:1201-1204`). On touch that is now wrong. It is phone-polish copy.
9. **Same-origin `target=_blank` links are not routed to `openExternal`** (D3). The system
   browser has no session cookie and would show the sign-in page. Native must keep
   same-origin navigations inside the WebView (spec §2 "navigation outside the saved
   origin opens in the system browser" implies this).
10. **Branch skew.** `mobile/v1` is 58 commits behind `next/0160`. Re-verify every cited line
    after rebasing, especially `store.tsx` (3,144 lines, heavily edited upstream).

**Review Focus candidates:**

1. **A harness 401 that is not a sign-out.** A remote user generates an avatar with an
   expired provider key. `/api/…` answers 401, and a naive implementation would show "Signed
   out" to someone who is signed in. Test: `session-check.test.ts` "keeps the app signed in
   when an API 401 turns out to be the harness's own", plus `sessionVerdict(404/502) →
   "unknown"`.
2. **The host asleep at the moment the stream drops.** `GET /session` fails at the network
   level. The page must keep reconnecting and show the offline banner, not the sign-out
   card. Tests: `session-check.test.ts` "treats an unreachable door as unknown", and
   `live-events.test.ts` "keeps reconnecting when the door says signed in, or cannot be
   reached".
3. **A tapped notification for a thread this phone cannot see, or taps before the data
   loads.** The thread may be hidden by `sse-visibility` or deleted. The user taps three
   notifications during a cold start. Tests: `store.test.ts` "opens nothing for a thread
   nobody on this device owns", and `deep-link.test.ts` "holds a target until ready" and
   "opens the newest of several early taps".
