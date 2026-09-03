// The only part of the Flux invitation that touches a browser. Every decision
// it makes lives in `flux-invite.ts`; this reads the facts and remembers a no.
//
// Modelled on `use-install-prompt.ts` deliberately, including the try/catch
// around both localStorage calls: a private window or blocked site data must
// cost the invitation its memory, never a render.
import { useCallback, useState } from "react";

import { useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { FLUX_INVITE_DISMISSED_KEY, fluxInviteVisible } from "@/lib/flux-invite";

const stored = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    // Not remembering a dismissal is a smaller failure than throwing during
    // render. The offer simply returns next launch.
    return false;
  }
};

const remember = (key: string) => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* nothing to do; the offer returns next launch */
  }
};

/** Whether to show the Flux offer, and how to make it go away for good.
 *
 *  `configured` is read as a tri-state on purpose: `state.config` is null until
 *  GET /api/config answers, and collapsing that to "no key" would flash the
 *  offer for a frame on every launch of a machine that already has one. */
export function useFluxInvite(firstRunGate: boolean): { visible: boolean; dismiss: () => void } {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const [dismissed, setDismissed] = useState(() => stored(FLUX_INVITE_DISMISSED_KEY));

  const dismiss = useCallback(() => {
    remember(FLUX_INVITE_DISMISSED_KEY);
    setDismissed(true);
  }, []);

  const visible = fluxInviteVisible({
    desktop,
    configured: state.config ? (state.config.flux?.configured ?? false) : null,
    dismissed,
    firstRunGate,
  });

  return { visible, dismiss };
}
