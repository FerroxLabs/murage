// The first-run offer of a Flux Router key.
//
// It is an OFFER and the shape enforces that. No overlay, no backdrop, nothing
// to dismiss before the app can be used: a small card in a corner, with a
// button that opens the one place a key is entered and a button that makes it
// go away permanently. Murage works with no Flux key at all, so an invitation
// that interrupted anything would be lying about how important it is.
//
// It does not carry a key field of its own. There is exactly one input, in
// Settings under Connections, and this points at it.
import { Route, X } from "lucide-react";

import { useStore } from "@/state/store";
import { FLUX_COPY } from "@/lib/flux-invite";
import { useFluxInvite } from "@/lib/use-flux-invite";

export interface FluxInviteBodyProps {
  /** Opens Settings at Connections, where the single key field lives. */
  onOpen: () => void;
  /** Remembered. This offer does not come back on the next launch. */
  onDismiss: () => void;
}

/** Rendering only, so the markup can be asserted without a store or a DOM. */
export function FluxInviteBody({ onOpen, onDismiss }: FluxInviteBodyProps) {
  return (
    <div
      role="complementary"
      aria-label={FLUX_COPY.inviteTitle}
      className="animate-panel-in fixed bottom-4 right-4 z-40 w-[320px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Route size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{FLUX_COPY.inviteTitle}</div>
          <div className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{FLUX_COPY.inviteBody}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={FLUX_COPY.inviteDismiss}
          title={FLUX_COPY.inviteDismiss}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {FLUX_COPY.inviteDismiss}
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="rounded-lg bg-control px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          {FLUX_COPY.inviteAction}
        </button>
      </div>
    </div>
  );
}

/**
 * The live invitation.
 *
 * `firstRunGate` is a prop rather than something read here so the mount site
 * stays a bare `<FluxInvite firstRunGate={gated} />` and every rule about when
 * this appears lives in `fluxInviteVisible`, where a test can reach it. Opening
 * it takes the person to the key field and, crucially, also dismisses: they
 * have been shown the door, so the corner card has done its job either way.
 */
export function FluxInvite({ firstRunGate }: { firstRunGate: boolean }) {
  const { dispatch } = useStore();
  const { visible, dismiss } = useFluxInvite(firstRunGate);
  if (!visible) return null;
  return (
    <FluxInviteBody
      onOpen={() => {
        dismiss();
        dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
      }}
      onDismiss={dismiss}
    />
  );
}
