// Who is on a call, window-wide.
//
// It lives in lib rather than inside the call UI because two very
// different places need it: the overlay that renders the call, and the SSE
// fold that decides whether a settled reply should be read aloud. Call
// mode does its own speaking, in order, around its own microphone — so
// auto-speak has to stand down for the bot that is on the line, and the
// two would deadlock over the speaker otherwise.
import { useSyncExternalStore } from "react";

import { speaker } from "./tts";

let current: string | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

/** The bot on a call, or null. Safe to read outside React. */
export function currentCall(): string | null {
  return current;
}

export function startCall(botId: string) {
  current = botId;
  notify();
}

export function endCall() {
  current = null;
  speaker.stop();
  void window.ogb?.speechStop();
  notify();
}

export function useOnCall(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
