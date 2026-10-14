// Warm on intent: tell the server the owner is about to use this bot's thread,
// so its idle engine is held warm for one activity window (rate limited per
// thread to once a minute), and tell it the owner is typing, so background work
// holds back while they do (server/owner-first.ts).
//
// The typing beat goes out on the first key and then at most every
// TYPING_BEAT_MS while keys keep coming. The server holds background work for
// 8 s per beat, so a beat every 5 s covers continuous typing without a gap.
// (Before 1.0.2 the only signal was the warm call, debounced to a 1.5 s pause
// and sent at most once a minute: continuous typing never reached the server.)
import { useEffect, useRef } from "react";
import { api } from "@/state/store";

const MIN_GAP_MS = 60_000;
export const TYPING_BEAT_MS = 5_000;
const sentAt = new Map<string, number>();

export function warmIntent(botId: string, threadId: string, now = Date.now()): boolean {
  const key = `${botId}:${threadId}`;
  if (now - (sentAt.get(key) ?? -Infinity) < MIN_GAP_MS) return false;
  sentAt.set(key, now);
  void api(`/api/bots/${botId}/warm`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => undefined);
  return true;
}

/** A throttle for typing beats: the first key sends at once, later keys at most every TYPING_BEAT_MS. */
export function typingBeat(send: () => void, now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < TYPING_BEAT_MS) return false;
    last = at;
    send();
    return true;
  };
}

/** Window focus and composer typing both start warming; `typed` is the draft text. */
export function useWarmIntent(botId: string | undefined, threadId: string, typed: string): void {
  const beat = useRef<{ key: string; fire: () => boolean } | null>(null);
  const previous = useRef(typed);
  useEffect(() => {
    if (!botId || !threadId) return;
    const onFocus = () => { warmIntent(botId, threadId); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [botId, threadId]);
  useEffect(() => {
    const changed = typed !== previous.current;
    previous.current = typed;
    if (!botId || !threadId || !typed || !changed) return;
    const key = `${botId}:${threadId}`;
    if (beat.current?.key !== key) {
      beat.current = { key, fire: typingBeat(() => {
        void api(`/api/bots/${botId}/typing`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => undefined);
      }) };
    }
    beat.current.fire();
    warmIntent(botId, threadId);
  }, [botId, threadId, typed]);
}
