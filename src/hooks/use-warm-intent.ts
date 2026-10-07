// Warm on intent: tell the server the owner is about to use this bot's thread,
// so its idle engine is held warm for one activity window. Debounced, and
// rate limited per thread, so typing never floods the server.
import { useEffect, useRef } from "react";
import { api } from "@/state/store";

const DEBOUNCE_MS = 1_500;
const MIN_GAP_MS = 60_000;
const sentAt = new Map<string, number>();

export function warmIntent(botId: string, threadId: string, now = Date.now()): boolean {
  const key = `${botId}:${threadId}`;
  if (now - (sentAt.get(key) ?? -Infinity) < MIN_GAP_MS) return false;
  sentAt.set(key, now);
  void api(`/api/bots/${botId}/warm`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => undefined);
  return true;
}

/** Window focus and composer typing both start warming; `typed` is the draft text. */
export function useWarmIntent(botId: string | undefined, threadId: string, typed: string): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!botId || !threadId) return;
    const onFocus = () => { warmIntent(botId, threadId); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [botId, threadId]);
  useEffect(() => {
    if (!botId || !threadId || !typed) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { warmIntent(botId, threadId); }, DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [botId, threadId, typed]);
}
