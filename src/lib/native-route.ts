// The conversation on screen, told to the phone app (Plan 2, Decision 2).
//
// A WebView whose process died, an Android WebView that had to be recreated,
// and an app the system killed all come back through a fresh page load, and
// this page keeps no route in its URL. So native remembers the last thread it
// was told about and reopens it with `#open=` (spec §3.2 "Persisted state",
// §7 "WebView process killed … back to the same chat").
//
// Only a real thread is reported. Leaving the chat for settings or the inbox
// keeps the last conversation, which is where the person wants to come back.
import { callNative, nativeHas } from "./native-shell";

export function createRouteReporter(send: (threadId: string) => boolean) {
  let last: string | null = null;
  return (threadId: string | null | undefined): void => {
    if (!threadId || threadId === last) return;
    if (send(threadId)) last = threadId;
  };
}

export const reportRoute = createRouteReporter((threadId) => {
  // Synchronous on purpose: before hello() has answered this says "not yet",
  // and the next render reports the same thread again.
  if (!nativeHas("setRoute")) return false;
  void callNative("setRoute", { threadId }).catch(() => {});
  return true;
});
