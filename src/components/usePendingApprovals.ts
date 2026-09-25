import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { signedOutEngineRows } from "@/lib/signed-out-engines";
import { useSetupView } from "./FirstRunChrome";
import { refreshThreadSnoozes, setQuestionThreads } from "@/lib/thread-attention";

/** A snapshot of canonical cards, never notification history. Failed reads retain
 * the last count; reconnect and foregrounding request a fresh snapshot. */
export function usePendingApprovals(enabled: boolean, connected: boolean) {
  const [count, setCount] = useState<number>();
  // Everything waiting on the person, not only tool approvals: the sidebar's
  // "Needs you" row counts the same items its Inbox view lists, so the number
  // on the row and the number inside the dialog can never disagree.
  const [decisions, setDecisions] = useState<number>();
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
        const result = await api("/api/inbox?view=decisions&pageSize=1", { signal: controller.signal });
        if (!disposed) { setCount(result.total); setDecisions(result.decisions); setStale(false); setQuestionThreads(result.questionThreads); }
        // The same beat reads conversation snoozes, and that read is what
        // wakes a snooze whose time has come (server/thread-snooze.ts).
        if (!disposed) await refreshThreadSnoozes(api, controller.signal).catch(() => undefined);
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
  // THE ROW AND THE DIALOG COUNT THE SAME THINGS OR THEY ARE BOTH WRONG.
  //
  // An engine nobody is signed in to is owed and has no message behind it,
  // so the Inbox folds it in on the client. If this row did not, the badge
  // would say two, the Inbox would open saying three, and the number nobody
  // can reconcile is the number nobody reads.
  const { view } = useSetupView();
  const signedOut = signedOutEngineRows(view).length;
  return {
    count,
    decisions: decisions === undefined ? decisions : decisions + signedOut,
    stale: stale || !connected,
  };
}
