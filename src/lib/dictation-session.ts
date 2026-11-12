// Composer dictation lifecycle, owned in one place (DICTATION-LIFECYCLE-1018).
//
// The OS recognizer outlives any one Composer (a thread switch unmounts it
// while the helper may still be running), so the state lives in a per-window
// store, not in a component. `dictationReduce` is a pure transition function;
// a small runner executes its effects against `window.muragebox` and feeds the
// results back. Every async result carries the session token and stop attempt
// it came from and is ignored unless both are still current.
import { useSyncExternalStore } from "react";
import {
  FINISH_DEADLINE_MS,
  applyCleanupResult,
  cleanupEnabled,
  dictatedPortion,
  requestCleanup,
  type CleanupTarget,
  type CleanupUndo,
} from "./dictation-cleanup";
import { dictationDisabledNote, isDictationDisabled } from "./dictation-notes";
import { orderedLayers, subscribeLayers } from "./layers";

export type DictationKind = "idle" | "starting" | "listening" | "stopping" | "failed";

export interface QueuedStart {
  owner: string;
  base: string;
  token: string;
}

export interface DictationNotice {
  seq: number;
  owner: string;
  text: string;
}

export interface DictationState {
  kind: DictationKind;
  /** The native session token of the current session (null when idle). */
  token: string | null;
  /** The draft that owns the session; kept after idle so a late tidy-up is judged against it. */
  owner: string | null;
  /** What was in the box when the mic went on; partials append after it. */
  base: string;
  /** Bumped by every start, send and owner unmount, in any kind including idle. */
  writeGen: number;
  /** Partials and the final line may still be written to the box. */
  keepWords: boolean;
  /** The owner's box no longer takes dictation (a send or an unmount happened). */
  sinkDetached: boolean;
  /** The last stop attempt number issued. */
  attempt: number;
  /** The attempt of the one native stop in flight, or null. */
  stop: number | null;
  /** Waiting for the recognizer's final line after a finish request (1.5 s deadline). */
  finish: boolean;
  /** A start waiting behind a stop. */
  queuedStart: QueuedStart | null;
  notice: DictationNotice | null;
  noticeSeq: number;
}

export type DictationEvent =
  | { t: "press"; owner: string; base: string; token: string }
  | { t: "stopRequest" }
  | { t: "startResolved"; token: string }
  | { t: "startRejected"; token: string }
  | { t: "end"; token: string; code: number | null; reason?: string }
  | { t: "finishDone"; token: string }
  | { t: "stopResolved"; attempt: number }
  | { t: "stopRejected"; attempt: number }
  | { t: "stopAgain" }
  | { t: "send"; owner: string }
  | { t: "unmount"; owner: string };

export type DictationEffect =
  | { t: "start"; token: string }
  | { t: "finish"; token: string }
  | { t: "stop"; token: string; attempt: number }
  | { t: "tidy"; owner: string; base: string; writeGen: number };

export const initialDictationState: DictationState = {
  kind: "idle",
  token: null,
  owner: null,
  base: "",
  writeGen: 0,
  keepWords: false,
  sinkDetached: false,
  attempt: 0,
  stop: null,
  finish: false,
  queuedStart: null,
  notice: null,
  noticeSeq: 0,
};

export const COULD_NOT_START = "Dictation could not start. Try again in a moment.";
export const OFF_DURING_CALL = "Dictation is off while a call is listening.";
export const NEEDS_ACCESS = "Dictation needs Microphone + Speech Recognition access. Turn it on in System Settings → Privacy & Security.";
export const MACOS_ONLY = "Dictation is only available on macOS for now.";
export const FAILED_TEXT = "Dictation did not stop, so the microphone may still be on.";

type Result = { state: DictationState; effects: DictationEffect[] };
const same = (state: DictationState): Result => ({ state, effects: [] });

function withNotice(s: DictationState, owner: string | null, text: string | null): Pick<DictationState, "notice" | "noticeSeq"> {
  if (text === null || owner === null) return { notice: null, noticeSeq: s.noticeSeq };
  return { notice: { seq: s.noticeSeq + 1, owner, text }, noticeSeq: s.noticeSeq + 1 };
}

/** Back to idle. Retires the finish wait and any queued start. */
function toIdle(s: DictationState, text: string | null, extra: Partial<DictationState> = {}): DictationState {
  return {
    ...s,
    kind: "idle",
    token: null,
    base: "",
    keepWords: false,
    stop: null,
    finish: false,
    queuedStart: null,
    ...withNotice(s, s.owner, text),
    ...extra,
  };
}

/** One native stop attempt, discarding. */
function stopDiscard(s: DictationState, extra: Partial<DictationState> = {}): Result {
  const attempt = s.attempt + 1;
  return {
    state: { ...s, kind: "stopping", keepWords: false, finish: false, attempt, stop: attempt, ...extra },
    effects: [{ t: "stop", token: s.token!, attempt }],
  };
}

function begin(s: DictationState, queued: QueuedStart): Result {
  return {
    state: {
      ...s,
      kind: "starting",
      token: queued.token,
      owner: queued.owner,
      base: queued.base,
      writeGen: s.writeGen + 1,
      keepWords: true,
      sinkDetached: false,
      stop: null,
      finish: false,
      queuedStart: null,
      notice: null,
    },
    effects: [{ t: "start", token: queued.token }],
  };
}

/** A send or an owner unmount: nothing may be written again, and the recognizer is stopped. */
function halt(s: DictationState): Result {
  switch (s.kind) {
    case "idle":
      return same(s);
    case "failed":
    case "starting":
    case "listening":
      return stopDiscard(s, { queuedStart: null });
    case "stopping": {
      const quiet = { ...s, keepWords: false, finish: false, queuedStart: null };
      if (s.stop !== null) return same(quiet); // join the stop already in flight
      return stopDiscard(quiet);
    }
  }
}

function noticeFor(code: number | null, reason: string | undefined): string {
  if (code === 2) return MACOS_ONLY;
  return isDictationDisabled(reason) ? dictationDisabledNote() : NEEDS_ACCESS;
}

export function dictationReduce(s: DictationState, ev: DictationEvent): Result {
  switch (ev.t) {
    case "press": {
      const queued = { owner: ev.owner, base: ev.base, token: ev.token };
      if (s.kind === "idle") return begin(s, queued);
      if (s.kind === "failed") return stopDiscard(s, { queuedStart: queued });
      if (s.kind === "starting" || s.kind === "listening") {
        if (ev.owner === s.owner) return dictationReduce(s, { t: "stopRequest" });
        return stopDiscard(s, { queuedStart: queued });
      }
      return same(s); // stopping: joins the stop in flight
    }
    case "stopRequest": {
      if (s.kind === "starting") return stopDiscard(s);
      if (s.kind === "listening") {
        return { state: { ...s, kind: "stopping", finish: true }, effects: [{ t: "finish", token: s.token! }] };
      }
      return same(s);
    }
    case "startResolved":
      if (s.kind !== "starting" || ev.token !== s.token) return same(s);
      return { state: { ...s, kind: "listening" }, effects: [] };
    case "startRejected":
      if (s.kind !== "starting" || ev.token !== s.token) return same(s);
      return { state: toIdle(s, COULD_NOT_START), effects: [] };
    case "finishDone": {
      if (s.kind !== "stopping" || !s.finish || ev.token !== s.token) return same(s);
      return settleKeep(s);
    }
    case "end": {
      if (s.kind === "idle" || ev.token !== s.token) return same(s);
      const live = s.kind === "starting" || s.kind === "listening" || s.kind === "stopping";
      if (ev.reason === "superseded" && ev.code === 0) {
        return { state: toIdle(s, null, { writeGen: s.writeGen + 1 }), effects: [] };
      }
      if (ev.reason === "speech-busy") {
        return s.kind === "starting" ? { state: toIdle(s, OFF_DURING_CALL), effects: [] } : same(s);
      }
      if (ev.reason === "helper-stop-pending" || ev.reason === "stop-failed") {
        if (!live) return same(s);
        return {
          state: { ...s, kind: "failed", keepWords: false, finish: false, queuedStart: null, stop: null, attempt: s.attempt + 1 },
          effects: [],
        };
      }
      if (ev.code === 0) {
        if (s.kind === "stopping") return s.finish ? settleKeep(s) : same(s);
        // starting or listening: the recognizer ended on its own and its final line is already written.
        return { state: toIdle(s, null), effects: tidy(s) };
      }
      // code 1 or 2: a permission or recognizer error.
      if (s.kind === "stopping") {
        // as a settled finish (the words stay, so the tidy-up still applies), then the real stop
        return s.finish ? settleKeep(s) : same(s);
      }
      return { state: toIdle(s, noticeFor(ev.code, ev.reason)), effects: [] };
    }
    case "stopResolved": {
      if (s.kind !== "stopping" || s.stop !== ev.attempt) return same(s);
      if (s.queuedStart) return begin({ ...s, stop: null }, s.queuedStart);
      return { state: toIdle(s, null), effects: [] };
    }
    case "stopRejected": {
      if (s.kind !== "stopping" || s.stop !== ev.attempt) return same(s);
      return { state: { ...s, kind: "failed", keepWords: false, finish: false, queuedStart: null, stop: null }, effects: [] };
    }
    case "stopAgain":
      return s.kind === "failed" ? stopDiscard(s) : same(s);
    case "send":
    case "unmount": {
      if (s.owner !== null && s.owner !== ev.owner) {
        // a draft waiting behind the stop that sends or unmounts never gets its start
        if (s.queuedStart?.owner === ev.owner) return { state: { ...s, queuedStart: null }, effects: [] };
        return same(s);
      }
      const detached: DictationState = { ...s, writeGen: s.writeGen + 1, sinkDetached: true, base: s.kind === "idle" ? "" : s.base };
      const next = halt(detached);
      return { state: { ...next.state, base: "" }, effects: next.effects };
    }
  }
}

function tidy(s: DictationState): DictationEffect[] {
  return s.owner === null ? [] : [{ t: "tidy", owner: s.owner, base: s.base, writeGen: s.writeGen }];
}

/** The keep path closes (final line, deadline or finish rejection): tidy, then the real stop. */
function settleKeep(s: DictationState): Result {
  const attempt = s.attempt + 1;
  return {
    state: { ...s, keepWords: false, finish: false, attempt, stop: attempt },
    effects: [...tidy(s), { t: "stop", token: s.token!, attempt }],
  };
}

// ---------------------------------------------------------------- selectors

export type StopControl = "mic" | "strip" | "app" | null;

export function dictationStopControl(
  kind: DictationKind,
  inputs: { ownerMounted: boolean; covered: boolean; approval: boolean; locked: boolean; available: boolean },
): StopControl {
  if (kind === "idle") return null;
  if (!inputs.ownerMounted || inputs.covered) return "app";
  const micOk = kind !== "failed" && !inputs.approval && !inputs.locked && inputs.available;
  return micOk ? "mic" : "strip";
}

/** The START button: drawn only when nothing is running and the box can take dictation. */
export function dictationStartEligible(input: {
  kind: DictationKind;
  available: boolean;
  locked: boolean;
  busy: boolean;
  hasContent: boolean;
  approval: boolean;
  covered: boolean;
}): boolean {
  return input.kind === "idle" && input.available && !input.locked && !input.busy && !input.hasContent && !input.approval && !input.covered;
}

// -------------------------------------------------------------------- store

export interface DictationSink {
  /** Replace the box text. */
  write(text: string): void;
  /** The box text right now. */
  read(): string;
  target(): CleanupTarget;
  /** Show the inline model notice when clean-up starts, without awaiting it. */
  onCleanupStart?(): void;
  /** A tidy-up landed: replace the box and offer the undo. */
  applyCleanup(next: string, undo: CleanupUndo): void;
}

let state: DictationState = initialDictationState;
const sinks = new Map<string, DictationSink>();
const listeners = new Set<() => void>();
const queue: DictationEvent[] = [];
let draining = false;
let tokenCounter = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerToken: string | null = null;
let subscription: { bridge: NonNullable<Window["muragebox"]>; off: () => void } | null = null;

export interface DictationSnapshot {
  state: DictationState;
  ownerMounted: boolean;
}
let snapshot: DictationSnapshot = { state, ownerMounted: false };

function refreshSnapshot() {
  const ownerMounted = state.owner !== null && sinks.has(state.owner);
  if (snapshot.state === state && snapshot.ownerMounted === ownerMounted) return;
  snapshot = { state, ownerMounted };
  for (const listener of listeners) listener();
}

export function subscribeDictation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const getDictationSnapshot = (): DictationSnapshot => snapshot;
export const getDictationState = (): DictationState => state;
export function useDictation(): DictationSnapshot {
  return useSyncExternalStore(subscribeDictation, getDictationSnapshot, getDictationSnapshot);
}

function newToken(): string {
  tokenCounter += 1;
  return `dict-${tokenCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

function dispatch(event: DictationEvent) {
  queue.push(event);
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const next = queue.shift()!;
      const result = dictationReduce(state, next);
      state = result.state;
      reconcile();
      for (const effect of result.effects) run(effect);
    }
  } finally {
    draining = false;
  }
  refreshSnapshot();
}

function reconcile() {
  // listeners are attached for as long as a session is not idle
  const bridge = window.muragebox;
  if (subscription && (state.kind === "idle" || subscription.bridge !== bridge)) {
    subscription.off();
    subscription = null;
  }
  if (!subscription && state.kind !== "idle" && bridge?.onDictationTranscript && bridge.onDictationEnd) {
    const offTranscript = bridge.onDictationTranscript(onTranscript);
    const offEnd = bridge.onDictationEnd((info) => dispatch({ t: "end", token: info.session, code: info.code, reason: info.reason }));
    subscription = {
      bridge,
      off: () => {
        offTranscript();
        offEnd();
      },
    };
  }
  // the finish deadline belongs to one session
  const wanted = state.finish ? state.token : null;
  if (timer && timerToken !== wanted) {
    clearTimeout(timer);
    timer = null;
    timerToken = null;
  }
  if (!timer && wanted) {
    timerToken = wanted;
    timer = setTimeout(() => {
      timer = null;
      timerToken = null;
      dispatch({ t: "finishDone", token: wanted });
    }, FINISH_DEADLINE_MS);
  }
}

function onTranscript(line: { text?: string; session: string }) {
  const s = state;
  if (!s.keepWords || s.sinkDetached || line.session !== s.token || typeof line.text !== "string" || s.owner === null) return;
  const sink = sinks.get(s.owner);
  if (!sink) return;
  sink.write(s.base ? `${s.base} ${line.text}` : line.text);
}

function settle<T>(call: () => Promise<T> | T, ok: () => void, fail: () => void) {
  let pending: Promise<T> | T;
  try {
    pending = call();
  } catch {
    fail();
    return;
  }
  void Promise.resolve(pending).then(ok, fail);
}

function run(effect: DictationEffect) {
  const bridge = window.muragebox;
  switch (effect.t) {
    case "start": {
      const { token } = effect;
      if (!bridge) return dispatch({ t: "startRejected", token });
      settle(
        () => bridge.speechStart({ session: token }),
        () => dispatch({ t: "startResolved", token }),
        () => dispatch({ t: "startRejected", token }),
      );
      return;
    }
    case "finish": {
      const { token } = effect;
      if (!bridge?.speechFinish) return dispatch({ t: "finishDone", token });
      settle(
        () => bridge.speechFinish!(token),
        () => {},
        () => dispatch({ t: "finishDone", token }),
      );
      return;
    }
    case "stop": {
      const { token, attempt } = effect;
      if (!bridge) return dispatch({ t: "stopResolved", attempt });
      settle(
        () => bridge.speechStop(token),
        () => dispatch({ t: "stopResolved", attempt }),
        () => dispatch({ t: "stopRejected", attempt }),
      );
      return;
    }
    case "tidy": {
      const { owner, base, writeGen } = effect;
      const sink = sinks.get(owner);
      if (!sink || !cleanupEnabled()) return;
      const atStop = sink.read();
      const said = dictatedPortion(base, atStop);
      if (!said) return;
      sink.onCleanupStart?.();
      void requestCleanup(said, sink.target()).then((result) => {
        // judged at the moment the answer lands: a send, an unmount or a newer start voids it
        if (state.writeGen !== writeGen || sinks.get(owner) !== sink) return;
        const applied = applyCleanupResult({ atStop, base, current: sink.read(), result });
        if (applied) sink.applyCleanup(applied.next, applied.undo);
      });
      return;
    }
  }
}

// ------------------------------------------------------------ public actions

/** A Composer mounts. Returns its unmount, which also ends any session it owns. */
export function registerDictationSink(owner: string, sink: DictationSink): () => void {
  sinks.set(owner, sink);
  refreshSnapshot();
  return () => {
    if (sinks.get(owner) !== sink) return;
    dispatch({ t: "unmount", owner });
    sinks.delete(owner);
    refreshSnapshot();
  };
}

export const dictationPress = (owner: string, base: string) => dispatch({ t: "press", owner, base, token: newToken() });
/** Escape, an approval, a takeover or `locked`: stop, keeping the words, if this draft owns the session. */
export function dictationStopRequest(owner: string) {
  if (state.owner === owner) dispatch({ t: "stopRequest" });
}
export const dictationStopAgain = () => dispatch({ t: "stopAgain" });
export const dictationSend = (owner: string) => dispatch({ t: "send", owner });

/** Test hook: forget everything, including listeners on a previous fake bridge. */
export function resetDictationForTests() {
  subscription?.off();
  subscription = null;
  if (timer) clearTimeout(timer);
  timer = null;
  timerToken = null;
  queue.length = 0;
  draining = false;
  sinks.clear();
  state = initialDictationState;
  snapshot = { state, ownerMounted: false };
  tokenCounter = 0;
}

// ------------------------------------------------------------- layer cover

export interface LayerCover {
  covered: boolean;
  /** The topmost active layer's root, when it is an element; else null (use the body). */
  root: HTMLElement | null;
}

const noCover: LayerCover = { covered: false, root: null };
let lastCover: LayerCover = noCover;

/** Layers above the Composer: windows, dialogs, palettes and native dialogs. Page layers do not cover it.
 *  An entry's container is attached after it registers, so this is recomputed on every read and the
 *  previous object is returned while nothing changed (a stable snapshot for useSyncExternalStore). */
export function layerCover(): LayerCover {
  const above = orderedLayers().filter((entry) => entry.kind !== "page");
  const top = above[above.length - 1];
  const container = top?.container as unknown;
  const root = typeof HTMLElement !== "undefined" && container instanceof HTMLElement ? container : null;
  const covered = above.length > 0;
  if (lastCover.covered === covered && lastCover.root === root) return lastCover;
  lastCover = covered ? { covered, root } : noCover;
  return lastCover;
}

export function useLayerCover(): LayerCover {
  return useSyncExternalStore(subscribeLayers, layerCover, layerCover);
}
