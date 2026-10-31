// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5A (R1-15): one Undo toast every lane uses, so mistakes are cheap.
// handoffs/UNDO-HOST-DESIGN.md section 8 (the local-only scope for 1.0.12):
// an offer shows a toast for 8 seconds, Undo runs the caller's synchronous
// local undo, and nothing here ever sends a request, writes storage or is
// persisted. Server-backed Undo (revert and delayed delete, with a guarded
// route and a confirming read) is a consumer-led design for 1.0.13; until it
// lands `offerUndo` refuses anything server-shaped, so a request can never
// gain an Undo by accident.

import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { UNDO_WINDOW_MS } from "@/lib/undo-window";

export { UNDO_WINDOW_MS };
/** Leaving the toast resumes its window with at least this long left. */
export const UNDO_RESUME_FLOOR_MS = 2000;
/** How long a "Could not undo" line stays. */
export const UNDO_NOTICE_MS = 8000;

export interface UndoAction {
  label: string;
  run: () => void;
}

export interface LocalOp {
  kind: "local";
  /** What the offer is about, e.g. "tip:today-help". */
  key: string;
  /** Localised headline, e.g. "Tip hidden." */
  message: string;
  /** The window, 8000 ms unless given. */
  ms?: number;
  /** An optional second button: it ends the window, then runs. */
  action?: UndoAction;
  /** Puts the thing back. Synchronous and local: never a request. */
  undo: () => void;
}

export interface UndoHandle {
  id: number;
  /** Ends this offer's window now. A no-op once the window closed. */
  settle(): void;
}

export interface UndoToastView {
  id: number;
  message: string;
  canUndo: boolean;
  /** Always false for local offers (their undo is synchronous); the toast still renders the state. */
  undoing: boolean;
  action: UndoAction | null;
  /** A line about this offer, e.g. "Could not undo: ...". */
  detail: string | null;
  /** Lines about older offers, stacked under this one. */
  extra: { id: number; text: string }[];
}

export type UndoHold = "pointer" | "focus";

export interface UndoHost {
  offerUndo(o: LocalOp): UndoHandle;
  /** Runs Undo on `id`, or on the open offer. True only when the local undo ran
   *  and finished; false when there was nothing to undo, or when the undo threw
   *  or handed back a promise (both show "Could not undo"). */
  undo(id?: number): boolean;
  /** Ends the window of `id`, then runs its action. */
  runAction(id: number): boolean;
  /** Esc or X: hides the toast; the offer keeps its deadline. */
  dismiss(): void;
  /** Pointer over, or focus inside, the toast holds its window while the page is visible. */
  setHold(reason: UndoHold, on: boolean): void;
  setPageVisible(visible: boolean): void;
  /** The page is going away: open offers end without Undo. */
  onPageHide(): void;
  hasOpen(): boolean;
  view(): UndoToastView | null;
  subscribe(listener: () => void): () => void;
}

const SERVER_SHAPED = ["apply", "commit", "revision", "check", "prepare"] as const;

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === "function" && fn.constructor?.name === "AsyncFunction";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.trim() || t("ux.l5a.didNotGoThrough");
}

interface Offer {
  id: number;
  op: LocalOp;
  /** Wall-clock deadline while running; Infinity while held. */
  deadline: number;
  /** Time left while held, else null. */
  remaining: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Notice {
  id: number;
  message: string;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

export function createUndoHost(): UndoHost {
  let nextId = 1;
  /** At most one offer is open: a newer offer ends the older one first. */
  let open: Offer | null = null;
  const notices = new Map<number, Notice>();
  const listeners = new Set<() => void>();
  const holds = new Set<UndoHold>();
  let headId: number | null = null;
  let hidden = false;
  let pageVisible = true;
  let snapshot: UndoToastView | null = null;

  const now = () => Date.now();

  function buildView(): UndoToastView | null {
    if (hidden) return null;
    let id = headId;
    if (id !== null && open?.id !== id && !notices.has(id)) id = null;
    if (id === null) id = open?.id ?? notices.keys().next().value ?? null;
    if (id === null) return null;
    const offer = open?.id === id ? open : null;
    const own = notices.get(id);
    const extra = [...notices.values()].filter((n) => n.id !== id).map((n) => ({ id: n.id, text: n.text }));
    return {
      id,
      message: offer ? offer.op.message : own!.message,
      canUndo: offer !== null,
      undoing: false,
      action: offer?.op.action ?? null,
      detail: own?.text ?? null,
      extra,
    };
  }

  function emit() {
    snapshot = buildView();
    // The toast is gone, so nothing can still be over it or focused in it.
    if (snapshot === null && holds.size > 0) {
      holds.clear();
      applyHold();
      snapshot = buildView();
    }
    for (const listener of [...listeners]) listener();
  }

  function arm(offer: Offer, ms: number) {
    if (offer.timer) clearTimeout(offer.timer);
    offer.deadline = now() + ms;
    offer.remaining = null;
    offer.timer = setTimeout(sweep, ms);
  }

  /** Hold or release the open offer's window to match the toast's holds. */
  function applyHold() {
    if (!open) return;
    const held = holds.size > 0 && pageVisible && !hidden;
    if (held && open.remaining === null) {
      open.remaining = open.deadline - now();
      open.deadline = Infinity;
      if (open.timer) clearTimeout(open.timer);
      open.timer = null;
    } else if (!held && open.remaining !== null) {
      arm(open, Math.max(open.remaining, UNDO_RESUME_FLOOR_MS));
    }
  }

  /** The deadline is checked first on every entry point. */
  function sweep() {
    if (open && open.remaining === null && now() >= open.deadline) close(open);
  }

  /** Ends `offer`'s window without telling anyone; the caller emits. */
  function end(offer: Offer) {
    if (offer.timer) clearTimeout(offer.timer);
    offer.timer = null;
    if (open === offer) open = null;
  }

  function close(offer: Offer) {
    if (open !== offer) return;
    end(offer);
    emit();
  }

  function notify(id: number, message: string, text: string) {
    const old = notices.get(id);
    if (old) clearTimeout(old.timer);
    const notice: Notice = {
      id,
      message,
      text,
      timer: setTimeout(() => {
        if (notices.get(id) !== notice) return;
        notices.delete(id);
        emit();
      }, UNDO_NOTICE_MS),
    };
    notices.set(id, notice);
    if (open === null) headId = id;
    // A line about an offer always reaches the person, even after Esc or X.
    hidden = false;
    emit();
  }

  function handle(offer: Offer): UndoHandle {
    return {
      id: offer.id,
      settle: () => {
        sweep();
        close(offer);
      },
    };
  }

  function offerUndo(o: LocalOp): UndoHandle {
    const shape = (o ?? {}) as unknown as Record<string, unknown>;
    if (
      shape.kind !== "local" ||
      typeof shape.undo !== "function" ||
      isAsyncFunction(shape.undo) ||
      SERVER_SHAPED.some((name) => name in shape)
    ) {
      throw new TypeError("offerUndo is local only: a synchronous undo, and no apply, commit, revision, check or prepare");
    }
    if (typeof o.key !== "string" || !o.key || typeof o.message !== "string" || !o.message.trim()) {
      throw new TypeError("offerUndo needs a key and a message");
    }
    const ms = o.ms ?? UNDO_WINDOW_MS;
    if (!Number.isFinite(ms) || ms <= 0) throw new TypeError("offerUndo: ms must be a positive number");
    sweep();
    // A newer offer ends the older one's window first, so one toast is one live Undo.
    // It ends quietly: the card stays on screen with the new offer, so a pointer
    // over it or focus inside it still holds the new window (no blank frame in
    // between clears the holds).
    if (open) end(open);
    const offer: Offer = { id: nextId++, op: o, deadline: Infinity, remaining: null, timer: null };
    open = offer;
    headId = offer.id;
    hidden = false;
    arm(offer, ms);
    applyHold();
    emit();
    return handle(offer);
  }

  function undo(id?: number): boolean {
    sweep();
    const offer = open;
    if (!offer || (id !== undefined && offer.id !== id)) return false;
    // The first transition out of the window wins: close before running anything.
    end(offer);
    let result: unknown;
    try {
      result = offer.op.undo() as unknown;
    } catch (error) {
      notify(offer.id, offer.op.message, t("ux.l5a.couldNotUndo", { reason: reasonOf(error) }));
      return false;
    }
    if (isThenable(result)) {
      // A promise means work that finishes later, maybe on a server. 1.0.12 Undo is
      // local only, so it never counts as undone: the person sees "Could not undo".
      // A rejection is caught here so it never surfaces as an unhandled error.
      console.error(`[undo] ${offer.op.key}: a local undo returned a promise; server work is not undoable in 1.0.12`);
      Promise.resolve(result).catch(() => undefined);
      notify(offer.id, offer.op.message, t("ux.l5a.couldNotUndo", { reason: t("ux.l5a.didNotGoThrough") }));
      return false;
    }
    emit();
    return true;
  }

  function runAction(id: number): boolean {
    sweep();
    const offer = open;
    if (!offer || offer.id !== id || !offer.op.action) return false;
    const action = offer.op.action;
    close(offer);
    action.run();
    return true;
  }

  function dismiss() {
    sweep();
    hidden = true;
    holds.clear();
    applyHold();
    emit();
  }

  function setHold(reason: UndoHold, on: boolean) {
    sweep();
    // A hold needs a card on screen. One that arrives after the card went (the
    // sweep above may just have closed it) is dropped, so it never pauses the
    // next offer with no leave event to end it.
    if (on && snapshot === null) return;
    if (on) holds.add(reason);
    else holds.delete(reason);
    applyHold();
  }

  function setPageVisible(visible: boolean) {
    sweep();
    pageVisible = visible;
    applyHold();
  }

  function onPageHide() {
    // Nothing is persisted: an open offer ends here, so a slow shutdown never
    // runs anything after its deadline. The change it offered to undo stands.
    if (open) {
      if (open.timer) clearTimeout(open.timer);
      open.timer = null;
      open = null;
    }
    holds.clear();
    emit();
  }

  snapshot = buildView();
  return {
    offerUndo,
    undo,
    runAction,
    dismiss,
    setHold,
    setPageVisible,
    onPageHide,
    hasOpen: () => {
      sweep();
      return open !== null;
    },
    view: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---- keys (F2) ------------------------------------------------------------------

export interface UndoKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** Focus is in an input, textarea, select or contenteditable, empty or not. */
  inEditable: boolean;
  /** An `[aria-modal="true"]` dialog is open. */
  modalOpen: boolean;
  /** An Undo window is open. */
  hasOpen: boolean;
}

/** Whether Cmd/Ctrl+Z runs the toast's Undo (and so prevents the default).
 *  Never inside an editable field, so the composer keeps its own undo. */
export function undoKeyHandled(e: UndoKeyInput): boolean {
  if (e.key.toLowerCase() !== "z") return false;
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false;
  if (e.repeat || e.isComposing || e.defaultPrevented) return false;
  if (e.inEditable || e.modalOpen) return false;
  return e.hasOpen;
}

export interface UndoEscInput {
  key: string;
  isComposing: boolean;
  defaultPrevented: boolean;
  inEditable: boolean;
  modalOpen: boolean;
  /** Focus is inside the toast. */
  inToast: boolean;
  /** The toast is showing. */
  showing: boolean;
}

/** Whether Esc hides the toast. Inside the toast always; elsewhere only when
 *  no dialog is open and focus is not in a field. Never prevents the default. */
export function undoEscHandled(e: UndoEscInput): boolean {
  if (e.key !== "Escape" || !e.showing || e.isComposing || e.defaultPrevented) return false;
  if (e.inToast) return true;
  return !e.modalOpen && !e.inEditable;
}

export function isEditableTarget(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (element as HTMLElement).isContentEditable === true;
}

/** Page lifecycle and keys for one host. The mount component calls this once;
 *  it returns the function that removes every listener. */
export function connectUndoHost(win: Window, host: UndoHost, toast: () => Element | null): () => void {
  const doc = win.document;
  const inToast = () => {
    const card = toast();
    return !!card && !!doc.activeElement && card.contains(doc.activeElement);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const base = {
      isComposing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
      inEditable: isEditableTarget(doc.activeElement),
      modalOpen: doc.querySelector('[aria-modal="true"]') !== null,
    };
    if (undoKeyHandled({ ...base, key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, repeat: event.repeat, hasOpen: host.hasOpen() })) {
      event.preventDefault();
      host.undo();
      return;
    }
    if (undoEscHandled({ ...base, key: event.key, inToast: inToast(), showing: host.view() !== null })) host.dismiss();
  };
  const onPageHide = () => host.onPageHide();
  const onVisibility = () => host.setPageVisible(doc.visibilityState === "visible");
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("pagehide", onPageHide);
  doc.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  return () => {
    win.removeEventListener("keydown", onKeyDown);
    win.removeEventListener("pagehide", onPageHide);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

// ---- the app's one host -----------------------------------------------------------

export const undoHost: UndoHost = createUndoHost();

/** Show an Undo toast for a change the caller can put back locally. */
export const offerUndo = (o: LocalOp): UndoHandle => undoHost.offerUndo(o);

export function useUndoToast(host: UndoHost = undoHost): UndoToastView | null {
  return useSyncExternalStore(host.subscribe, host.view, host.view);
}
