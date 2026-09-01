// Shared hook over the preload's updater bridge. Returns null in the
// browser / when the bridge is absent (dev) — callers render nothing then.
// onState emits the current state immediately on subscribe, so a component
// mounted after the download finished still sees "downloaded".
import { useEffect, useState } from "react";
import type { UpdaterState } from "@/types/muragebox";

export type { UpdaterState };

export function useUpdaterState(): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => window.muragebox?.updater?.onState(setState), []);
  return window.muragebox?.updater ? state : null;
}
