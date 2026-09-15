import { useEffect, useState } from "react";
import { api } from "@/state/store";

/** A snapshot of canonical cards, never notification history. Failed reads retain
 * the last count; reconnect and foregrounding request a fresh snapshot. */
export function usePendingApprovals(enabled: boolean, connected: boolean) {
  const [count, setCount] = useState<number>();
  const [stale, setStale] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = await api("/api/inbox?view=approvals&pageSize=1", { signal: controller.signal });
        if (!disposed) { setCount(result.total); setStale(false); }
      } catch { if (!disposed) setStale(true); }
      finally { running = false; }
    };
    setStale(true);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      disposed = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh);
    };
  }, [enabled, connected]);
  return { count, stale: stale || !connected };
}
