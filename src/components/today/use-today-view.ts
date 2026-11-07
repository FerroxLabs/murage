// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Calm | Detailed choice (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2b). One owner pref on the
// server (GET/POST /api/owner-prefs/today-view, server/owner-prefs.ts), never kept in the browser.
//   - Read on Today's mount and on window focus, one read in flight (serialRefresh, as the section 2 reads). Calm until
//     it answers.
//   - A press flips at once. Where the server says `canSave` it POSTs; writes are serialized and the latest press wins.
//     A GET that started before the latest press, or overlapped any POST, never moves the view.
//   - A refused or failed save flips back to the last saved view and says `view.saveFailed`.
//   - `canSave: false` (the browser door, a Cloud phone, a keyless app): the press flips this visit only. It never
//     POSTs, never shows an error, and focus re-reads never undo the visit choice.
//   - A press before the first answer is held as the visit's choice; once the answer says `canSave`, it is saved.
//
// Exported:
//   TODAY_VIEW_PATH
//   todayViewController(io, onState): { read(): Promise<void>; press(view): void; dispose(): void }   (pure, for the test)
//   useTodayView(enabled): { view, failed, press }
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { serialRefresh } from "@/lib/inbox-changed";

export type TodayView = "calm" | "detailed";
export const TODAY_VIEW_PATH = "/api/owner-prefs/today-view";

export interface TodayViewState {
  view: TodayView;
  /** the last save failed: the view went back to the saved one */
  failed: boolean;
}

export interface TodayViewIo {
  get: (signal: AbortSignal) => Promise<unknown>;
  post: (view: TodayView, signal: AbortSignal) => Promise<unknown>;
}

const asView = (value: unknown): TodayView => (value === "detailed" ? "detailed" : "calm");

export function todayViewController(io: TodayViewIo, onState: (state: TodayViewState) => void) {
  const controller = new AbortController();
  let view: TodayView = "calm";
  let saved: TodayView = "calm";
  let canSave: boolean | null = null;
  let failed = false;
  /** bumps on every press; a read or write answer from before the latest press never moves the view */
  let press = 0;
  /** the owner chose this visit's view on a surface that cannot save it (or before we knew) */
  let visitChoice = false;
  /** the newest press not yet sent, and whether a write is out */
  let wanted: TodayView | null = null;
  let writing = false;
  /** bumps when each POST is sent; a GET that overlapped any POST never moves the view or the saved value */
  let writes = 0;

  const emit = () => { if (!controller.signal.aborted) onState({ view, failed }); };

  const write = async (): Promise<void> => {
    if (writing || controller.signal.aborted) return;
    writing = true;
    try {
      while (wanted !== null && !controller.signal.aborted) {
        const sending = wanted;
        wanted = null;
        const at = press;
        writes += 1;
        try {
          saved = asView(((await io.post(sending, controller.signal)) as { view?: unknown } | null)?.view);
          if (at === press && wanted === null) { view = saved; failed = false; emit(); }
        } catch {
          if (controller.signal.aborted) return;
          // A newer press is already waiting: it goes next. Otherwise back to the saved view, with the error.
          if (wanted === null) { view = saved; failed = true; emit(); }
        }
      }
    } finally {
      writing = false;
    }
  };

  const read = serialRefresh(async () => {
    if (controller.signal.aborted) return;
    const at = press;
    const gen = writes;
    const busy = writing;
    let answer: { view?: unknown; canSave?: unknown } | null;
    try {
      answer = (await io.get(controller.signal)) as typeof answer;
    } catch { return; /* the last answer stays; the next focus asks again */ }
    if (controller.signal.aborted) return;
    // A GET that ran alongside a POST may hold the value from before it: it never moves the view or `saved`.
    const overlapped = busy || writing || gen !== writes;
    const could = canSave;
    canSave = answer?.canSave === true;
    if (!canSave) {
      // Visit only: keep the owner's own choice for this visit; otherwise show the saved view.
      if (!overlapped) saved = asView(answer?.view);
      if (!visitChoice && at === press && !overlapped) { view = saved; emit(); }
      return;
    }
    if (could !== true && visitChoice) {
      // Pressed before we knew this surface saves: the server's answer is the saved baseline (a failed save of the
      // held choice flips back to it), then the held choice is saved.
      visitChoice = false;
      if (!overlapped) saved = asView(answer?.view);
      wanted = view;
      void write();
      return;
    }
    if (at !== press || overlapped || wanted !== null) return;
    saved = asView(answer?.view);
    view = saved;
    emit();
  });

  return {
    read,
    press: (next: TodayView) => {
      if (controller.signal.aborted) return;
      press += 1;
      failed = false;
      view = next;
      emit();
      if (canSave !== true) { visitChoice = true; return; }
      wanted = next;
      void write();
    },
    dispose: () => controller.abort(),
  };
}

/** Today's view choice. `enabled` false (first run) reads nothing and stays Calm. */
export function useTodayView(enabled: boolean): TodayViewState & { press: (view: TodayView) => void } {
  const [state, setState] = useState<TodayViewState>({ view: "calm", failed: false });
  const ref = useRef<ReturnType<typeof todayViewController> | null>(null);
  useEffect(() => {
    if (!enabled) { setState({ view: "calm", failed: false }); return; }
    const io: TodayViewIo = {
      get: (signal) => api(TODAY_VIEW_PATH, { signal }),
      post: (view, signal) => api(TODAY_VIEW_PATH, { method: "POST", body: JSON.stringify({ view }), signal }),
    };
    const reader = todayViewController(io, setState);
    ref.current = reader;
    void reader.read();
    const onFocus = () => { void reader.read(); };
    window.addEventListener("focus", onFocus);
    return () => { reader.dispose(); ref.current = null; window.removeEventListener("focus", onFocus); };
  }, [enabled]);
  const press = useCallback((view: TodayView) => ref.current?.press(view), []);
  return { ...state, press };
}
