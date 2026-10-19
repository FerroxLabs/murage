// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// One gate for "the person pressed a button and something happens". It was
// written about fifteen times as run()/act() in the settings panels; this is
// that pattern once, so every action shows the same four things:
//   1. pending, held in React state (never a ref), so the control disables and
//      its label changes on the next render;
//   2. a hint after ~2 s, and progress when the work can report it;
//   3. a success line that fades;
//   4. a failure line with the plain reason, and a way to try again.
//
// The state machine lives in `createAction` (no React) so it can be tested
// without a DOM; `useAction` only mirrors its snapshot into state.
import { useEffect, useRef, useState } from "react";

export type ActionPhase = "idle" | "pending" | "success" | "error";

/** Progress the work reports: a percent (0 to 100), a line of text, or both. */
export interface ActionProgress { percent?: number; text?: string }

export interface ActionSnapshot {
  phase: ActionPhase;
  /** true from the press until the work settles. Real state, so it re-renders. */
  pending: boolean;
  /** the work has run longer than `slowAfterMs` */
  slow: boolean;
  /** what the control should read right now */
  label: string;
  progress: ActionProgress | null;
  /** the success line, while it shows */
  message: string | null;
  /** the success line is on its way out (fade it) */
  fading: boolean;
  /** the plain reason the last run failed */
  error: string | null;
}

export interface ActionOptions<R = unknown> {
  /** the control's idle label */
  idle?: string;
  /** the control's label while the work runs ("Saving...") */
  pending?: string;
  /** "Done" by default; a function gets the result */
  success?: string | ((result: R) => string) | null;
  /** shown when the failure has no sentence of its own */
  failure?: string;
  /** shown after `slowAfterMs` of pending */
  slowHint?: string;
  slowAfterMs?: number;
  /** how long the success line stays before it is gone */
  successMs?: number;
  /** the last part of that time is the fade */
  fadeMs?: number;
  /** pulled progress: asked every `everyMs` while pending */
  poll?: { read: () => Promise<ActionProgress | null | undefined>; everyMs?: number };
  onError?: (cause: unknown, reason: string) => void;
  onSuccess?: (result: R) => void;
  /** turn a thrown value into a sentence; the default keeps the server's own words */
  describeError?: (cause: unknown, fallback: string) => string;
}

const DEFAULTS = {
  slowAfterMs: 2000,
  successMs: 4000,
  fadeMs: 600,
  pollMs: 1500,
  slowHint: "Still working. This can take a moment.",
  failure: "That did not work. Try again.",
  success: "Done",
};

/** Plumbing, not something to say to a person: codes, paths, URLs, stack frames. */
const MACHINERY = /[\n\r\t<>{}[\]|`\\]|https?:|[A-Za-z]:\\|\/[\w.-]+\/|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bat \S+:\d+/;
const RUNTIME_FAULT = /\b(?:undefined|null|NaN|[A-Za-z]*Error)\b|is not (?:a function|iterable|defined)|Cannot read propert|Maximum call stack|Unexpected token/i;
const IPC_REJECTION = /^Error invoking remote method ['"][^'"\r\n]+['"]:\s*(?:Error:\s*)?/i;

/** The reason a failure gives, in its own words when they read as a sentence, and the fallback otherwise. */
export function actionReason(cause: unknown, fallback: string = DEFAULTS.failure): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.replace(IPC_REJECTION, "").replace(/^Error:\s*/i, "").trim();
  if (text.length < 8 || text.length > 300) return fallback;
  if (!/^[A-Z]/.test(text) || !text.includes(" ")) return fallback;
  if (MACHINERY.test(text) || RUNTIME_FAULT.test(text)) return fallback;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export interface ActionController<A extends unknown[], R> {
  snapshot(): ActionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Runs the work. Resolves with the result, or undefined if it failed or a run was already going. */
  run(...args: A): Promise<R | undefined>;
  /** Runs the last call again with the same arguments. */
  retry(): Promise<R | undefined>;
  /** Pushed progress, from inside the work or from outside it. */
  setProgress(progress: ActionProgress | null): void;
  /** Clears a success or failure line. */
  dismiss(): void;
  /** Stops all timers; nothing is reported until the next subscribe. */
  dispose(): void;
}

export function createAction<A extends unknown[], R>(
  work: () => (...args: A) => Promise<R>,
  options: () => ActionOptions<R> = () => ({}),
): ActionController<A, R> {
  const idleSnapshot = (): ActionSnapshot => ({ phase: "idle", pending: false, slow: false, label: options().idle ?? "", progress: null, message: null, fading: false, error: null });
  let state = idleSnapshot();
  let running = false;
  let alive = true;
  let lastArgs: A | null = null;
  let generation = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let poller: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ActionSnapshot>) => { state = { ...state, ...next }; if (alive) listeners.forEach(listener => listener()); };
  const later = (ms: number, fn: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (alive) fn(); }, ms); timers.add(timer); return timer; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); if (poller) { clearInterval(poller); poller = null; } };

  const run = async (...args: A): Promise<R | undefined> => {
    if (running || !alive) return undefined;
    running = true;
    lastArgs = args;
    const mine = ++generation;
    clearTimers();
    const opts = options();
    set({ phase: "pending", pending: true, slow: false, label: opts.pending ?? opts.idle ?? "", progress: null, message: null, fading: false, error: null });
    later(opts.slowAfterMs ?? DEFAULTS.slowAfterMs, () => { if (running && mine === generation) set({ slow: true }); });
    if (opts.poll) {
      const poll = opts.poll;
      let reading = false;
      poller = setInterval(() => {
        if (reading || !alive || mine !== generation) return;
        reading = true;
        poll.read().then(progress => { if (alive && running && mine === generation && progress) set({ progress }); }, () => { /* a missed reading is not a failure of the work */ }).finally(() => { reading = false; });
      }, poll.everyMs ?? DEFAULTS.pollMs);
    }
    try {
      const result = await work()(...args);
      clearTimers();
      running = false;
      const success = opts.success === undefined ? DEFAULTS.success : opts.success;
      const line = typeof success === "function" ? success(result) : success;
      if (line) {
        const total = opts.successMs ?? DEFAULTS.successMs;
        const fade = Math.min(opts.fadeMs ?? DEFAULTS.fadeMs, total);
        set({ phase: "success", pending: false, slow: false, label: opts.idle ?? "", progress: null, message: line, fading: false, error: null });
        later(total - fade, () => set({ fading: true }));
        later(total, () => set({ phase: "idle", message: null, fading: false }));
      } else {
        set({ phase: "idle", pending: false, slow: false, label: opts.idle ?? "", progress: null, message: null, fading: false, error: null });
      }
      opts.onSuccess?.(result);
      return result;
    } catch (cause) {
      clearTimers();
      running = false;
      const fallback = opts.failure ?? DEFAULTS.failure;
      const reason = opts.describeError ? opts.describeError(cause, fallback) : actionReason(cause, fallback);
      set({ phase: "error", pending: false, slow: false, label: opts.idle ?? "", progress: null, message: null, fading: false, error: reason });
      opts.onError?.(cause, reason);
      return undefined;
    }
  };

  return {
    snapshot: () => state,
    subscribe(listener) { alive = true; listeners.add(listener); return () => { listeners.delete(listener); }; },
    run,
    retry: () => (lastArgs ? run(...lastArgs) : Promise.resolve(undefined)),
    setProgress(progress) { if (running) set({ progress }); },
    dismiss() { if (!running) { clearTimers(); set({ phase: "idle", message: null, fading: false, error: null }); } },
    dispose() { alive = false; generation++; clearTimers(); listeners.clear(); },
  };
}

export interface UseAction<A extends unknown[], R> extends ActionSnapshot {
  run: (...args: A) => Promise<R | undefined>;
  retry: () => Promise<R | undefined>;
  setProgress: (progress: ActionProgress | null) => void;
  dismiss: () => void;
}

/**
 * `const save = useAction(async () => { await api(...) }, { idle: "Save", pending: "Saving...", success: "Saved" })`
 *
 * Returns the snapshot (`pending`, `label`, `slow`, `progress`, `message`,
 * `fading`, `error`) and `run(...args)`, `retry()`, `setProgress()`, `dismiss()`.
 * The work always sees the latest closure, so it can read current props and state.
 * Render the result with <ActionStatus action={save} /> or use <ActionButton />.
 */
export function useAction<A extends unknown[], R = void>(work: (...args: A) => Promise<R>, options: ActionOptions<R> = {}): UseAction<A, R> {
  const latest = useRef({ work, options });
  latest.current = { work, options };
  const controller = useRef<ActionController<A, R> | null>(null);
  if (!controller.current) controller.current = createAction<A, R>(() => (...args) => latest.current.work(...args), () => latest.current.options);
  const control = controller.current;
  const [snapshot, setSnapshot] = useState<ActionSnapshot>(() => control.snapshot());
  useEffect(() => {
    const stop = control.subscribe(() => setSnapshot(control.snapshot()));
    setSnapshot(control.snapshot());
    return () => { stop(); control.dispose(); };
  }, [control]);
  // The label follows the latest options while idle (a changed idle label must show).
  const label = snapshot.pending ? snapshot.label : options.idle ?? snapshot.label;
  return { ...snapshot, label, run: control.run, retry: control.retry, setProgress: control.setProgress, dismiss: control.dismiss };
}
