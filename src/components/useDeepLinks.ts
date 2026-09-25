// Where a link or a tapped phone notification lands. Mounted once, in Shell.
import { useEffect, useMemo, useRef } from "react";

import { useStore } from "@/state/store";
import { createDeepLinkQueue, openDeepLink, openHashHref, parseOpenHash } from "@/lib/deep-link";
import { callNative, nativeAvailable, onNativeEvent } from "@/lib/native-shell";

export function useDeepLinks() {
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  const queue = useMemo(
    () =>
      createDeepLinkQueue((target) => {
        // Cleared AFTER it is handled, so a crash before hydration reopens it
        // on reload. replaceState fires no hashchange, so it cannot loop.
        if (parseOpenHash(window.location.hash)) {
          history.replaceState(history.state, "", openHashHref(window.location.pathname, window.location.search));
        }
        if (!openDeepLink(target, latest.current, dispatch)) {
          dispatch({ type: "error", message: "That conversation isn't available on this device." });
        }
      }),
    [dispatch],
  );

  useEffect(() => {
    const fromHash = () => {
      const target = parseOpenHash(window.location.hash);
      if (target) queue.push(target);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    // bindingId has already chosen this workspace on the native side
    // (spec §3.5 step 1); the page only needs the thread and message.
    const stopNative = onNativeEvent("notificationOpened", ({ threadId, messageId }) =>
      queue.push(messageId ? { threadId, messageId } : { threadId }));
    return () => {
      window.removeEventListener("hashchange", fromHash);
      stopNative();
    };
  }, [queue]);

  const toldNativeReady = useRef(false);
  useEffect(() => {
    if (state.hydrated) queue.ready();
    // The phone app keeps its splash up until the UI says it is ready and
    // shows "Loading is taking a while" after 20 s (spec §3.2). The first
    // applied snapshot is that moment.
    if (!state.hydrated || toldNativeReady.current) return;
    toldNativeReady.current = true;
    void nativeAvailable("ready").then((available) => (available ? callNative("ready") : undefined)).catch(() => {});
  }, [state.hydrated, queue]);
}
