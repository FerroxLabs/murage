import { useEffect } from "react";
import { useStore } from "@/state/store";
import { onNativeEvent } from "@/lib/native-shell";
import { browserPushDeps, reportBadge, syncPush } from "@/lib/push-enrol";

/** After the first snapshot (so after pairing, B2), and on every return to the app. */
export function usePushEnrol(): void {
  const { state } = useStore();
  useEffect(() => {
    if (!state.hydrated) return;
    const run = (reason: "automatic" | "foreground" = "automatic") => { void syncPush(browserPushDeps, reason).then(() => reportBadge(browserPushDeps)).catch(() => {}); };
    run();
    return onNativeEvent("resume", () => run("foreground"));
  }, [state.hydrated]);
}
