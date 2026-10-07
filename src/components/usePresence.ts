// Reports this tab's visibility so phones stay quiet while someone is at the
// desk (spec §3.4). Mounted once, next to useDeepLinks in Shell.
import { useEffect } from "react";
import { browserPresenceDeps, startPresenceReporting } from "@/lib/presence";

export function usePresence(): void {
  useEffect(() => startPresenceReporting(browserPresenceDeps()), []);
}
