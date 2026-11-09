// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine sign-in on the desktop (design ENGINE-SIGNIN-SIMPLE-1014.md). This is the renderer's side of
// window.muragebox.localEngineLogin. Main starts the engine's own login with no output reaching Murage; the engine opens
// the browser. The window sends only an instance id and a session id, and hears only progress and the final word.
// electron/engine-login-local.d.mts carries the same shape; a test pins the channel list.
// This loads with the dialog. What a button needs at first paint is in engine-signin-surface.ts.

export const LOCAL_ENGINE_LOGIN_CHANNELS = [
  "local-engine-login:preview",
  "local-engine-login:start",
  "local-engine-login:stop",
  "local-engine-login:open-terminal",
  "local-engine-login:data",
  "local-engine-login:closed",
] as const;

/** headless: main runs the sign-in and the engine opens the browser. terminal: one button opens a real terminal with it running. none: the plain line. */
export type LocalEngineLoginKind = "headless" | "terminal" | "none";
export type LocalEngineLoginResultWord = "signed-in" | "not-finished" | "stopped" | "failed";

export type LocalEngineLoginFailure = { ok: false; code: string; message: string };
export type LocalEngineLoginPreview = { ok: true; kind: LocalEngineLoginKind; label: string; accountRoot: string } | LocalEngineLoginFailure;
export type LocalEngineLoginStartResult = { ok: true; id: string } | LocalEngineLoginFailure;
export type LocalEngineLoginActionResult = { ok: true } | LocalEngineLoginFailure;

/** Progress only: the probe saw this engine sign in. */
export interface LocalEngineLoginData { id: string; finishing?: boolean }
export interface LocalEngineLoginClosed { id: string; result: LocalEngineLoginResultWord; message?: string }

export interface LocalEngineLoginBridge {
  /** What the dialog names before anything starts. Starts nothing. */
  preview(request: { instanceId: string }): Promise<LocalEngineLoginPreview>;
  /** The press inside the dialog. */
  start(request: { instanceId: string }): Promise<LocalEngineLoginStartResult>;
  stop(request: { id: string }): Promise<LocalEngineLoginActionResult>;
  /** Takes no command text: main builds what runs, and stops a running sign-in of this engine first. */
  openTerminal(request: { instanceId: string }): Promise<LocalEngineLoginStartResult>;
  onData(listener: (payload: LocalEngineLoginData) => void): () => void;
  onClosed(listener: (payload: LocalEngineLoginClosed) => void): () => void;
}

export interface LocalLoginState {
  /** loading: reading the preview. ready: names the engine, nothing has started. waiting and finishing: the sign-in runs. */
  phase: "loading" | "ready" | "waiting" | "finishing" | "refused" | "closed";
  kind?: LocalEngineLoginKind;
  label?: string;
  accountRoot?: string;
  /** True once the browser has had its 45 seconds: the dialog offers Terminal. */
  slow?: boolean;
  terminal: "idle" | "opening" | "opened" | "failed";
  result?: LocalEngineLoginResultWord;
  /** Main's own plain line for a refusal or a failure, such as an engine's own limit line. */
  message?: string;
}

export const LOCAL_LOGIN_START: LocalLoginState = { phase: "loading", terminal: "idle" };
/** How long the browser gets before the dialog offers Terminal. */
export const LOCAL_LOGIN_TERMINAL_OFFER_MS = 45_000;

export type LocalLoginEvent =
  | { type: "preview"; result: LocalEngineLoginPreview }
  | { type: "started" }
  | { type: "refused"; message: string }
  | { type: "slow" }
  | { type: "finishing" }
  | { type: "closed"; closed: LocalEngineLoginClosed }
  | { type: "terminal"; status: LocalLoginState["terminal"]; message?: string };

export function localLoginReducer(state: LocalLoginState, event: LocalLoginEvent): LocalLoginState {
  switch (event.type) {
    case "preview": {
      const { result } = event;
      if (!result.ok) return { ...LOCAL_LOGIN_START, phase: "refused", message: result.message };
      return { ...state, phase: "ready", kind: result.kind, label: result.label, accountRoot: result.accountRoot };
    }
    case "started":
      return { ...state, phase: "waiting", slow: false };
    case "refused":
      return { ...state, phase: "refused", message: event.message };
    case "slow":
      return state.phase === "waiting" ? { ...state, slow: true } : state;
    case "finishing":
      return state.phase === "waiting" ? { ...state, phase: "finishing" } : state;
    case "closed":
      return { ...state, phase: "closed", result: event.closed.result, ...(event.closed.message ? { message: event.closed.message } : {}) };
    case "terminal": {
      const next = { ...state, terminal: event.status, ...(event.message ? { message: event.message } : {}) };
      if (event.status === "opened") return { ...next, phase: "waiting", result: undefined, slow: false };
      // Main stopped a running sign-in before the launch, so nothing is left running: the dialog says Not finished.
      if (event.status === "failed" && (state.phase === "waiting" || state.phase === "finishing")) return { ...next, phase: "closed", result: "not-finished" };
      return next;
    }
  }
}

export interface LocalLoginSession {
  /** The press inside the dialog. */
  open(): Promise<void>;
  openTerminal(): Promise<void>;
  /** Closing the dialog. Safe to call twice; a start still on its way is stopped when it lands. */
  stop(): void;
}

/** One dialog, from its first paint to closing. Reads the preview and starts nothing until open or openTerminal. */
export function openLocalLogin({ bridge, instanceId, onState, timers = globalThis }: { bridge: LocalEngineLoginBridge; instanceId: string; onState(state: LocalLoginState): void; timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> }): LocalLoginSession {
  let state = LOCAL_LOGIN_START;
  let id: string | null = null;
  let stopped = false;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  const apply = (event: LocalLoginEvent) => { if (stopped) return; state = localLoginReducer(state, event); onState(state); };
  const clearSlow = () => { if (slowTimer) timers.clearTimeout(slowTimer); slowTimer = null; };
  // A session's events are read only once its id is known, and main sends nothing of one until after that answer but a
  // child that left at once: those wait here with their id.
  let early: Array<{ from: string; event: LocalLoginEvent }> = [];
  const incoming = (sessionId: string, event: LocalLoginEvent) => {
    if (stopped) return;
    if (id === null) { early.push({ from: sessionId, event }); return; }
    if (sessionId !== id) return;
    if (event.type === "closed") { clearSlow(); id = null; }
    apply(event);
  };
  const adopt = (sessionId: string) => {
    if (stopped) { void bridge.stop({ id: sessionId }).catch(() => {}); return; }
    id = sessionId;
    const waiting = early;
    early = [];
    for (const { from, event } of waiting) incoming(from, event);
  };
  const offData = bridge.onData((data) => { if (data.finishing) incoming(data.id, { type: "finishing" }); });
  const offClosed = bridge.onClosed((closed) => incoming(closed.id, { type: "closed", closed }));

  void bridge.preview({ instanceId }).catch((): LocalEngineLoginPreview => ({ ok: false, code: "failed", message: "" })).then((result) => apply({ type: "preview", result }));

  return {
    async open() {
      if (stopped || state.phase !== "ready") return;
      apply({ type: "started" });
      slowTimer = timers.setTimeout(() => apply({ type: "slow" }), LOCAL_LOGIN_TERMINAL_OFFER_MS);
      const result = await bridge.start({ instanceId }).catch((): LocalEngineLoginStartResult => ({ ok: false, code: "failed", message: "" }));
      if (result.ok) { adopt(result.id); return; }
      clearSlow();
      apply({ type: "refused", message: result.message });
    },
    async openTerminal() {
      if (stopped || state.terminal === "opening") return;
      clearSlow();
      apply({ type: "terminal", status: "opening" });
      // Main stops a running sign-in first; its session closes with no word, because this dialog carries on.
      id = null;
      early = [];
      const result = await bridge.openTerminal({ instanceId }).catch((): LocalEngineLoginStartResult => ({ ok: false, code: "failed", message: "" }));
      if (result.ok) { adopt(result.id); apply({ type: "terminal", status: "opened" }); return; }
      apply({ type: "terminal", status: "failed", message: result.message });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearSlow();
      offData();
      offClosed();
      if (id !== null) void bridge.stop({ id }).catch(() => {});
    },
  };
}
