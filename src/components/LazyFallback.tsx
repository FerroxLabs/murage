// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// What a surface loaded on first use shows while its chunk arrives (spec §6).
// On a desktop that is a frame or two. On a phone over cellular it can be a
// second, and a tap that shows nothing for a second reads as a tap that did
// not land.
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { PhoneBotListBar } from "@/components/OpenBotListButton";
import { OverlayShell } from "@/components/LazyBoundary";

export function LazyFallback({ inline = false, pane = false, onDismiss, children }: {
  inline?: boolean; pane?: boolean; onDismiss?: () => void;
  /** A caller's own loading content (LazyOverlay fallback). It shows inside the same attached, dismissible shell
   * in place of the spinner, so it can never skip the registered owner or the Close action (Astra r3 Medium 8). */
  children?: ReactNode;
}) {
  // Pane: a part of a page (a project tab, its details, a dialog's body) spins where it will appear. It covers
  // nothing, so it needs no Close and takes no Esc.
  if (pane) {
    return (
      <div role="status" aria-label="Loading" className="flex min-h-12 items-center justify-center p-4">
        <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
      </div>
    );
  }
  // Inline: a view in the main pane (a group room) spins in its own place, so
  // the rail and banners stay usable while it arrives. On a phone the rail is
  // a drawer opened from the view's own header, which is not here yet, so the
  // pane draws that one button above the spinner.
  if (inline) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col bg-app">
        <PhoneBotListBar />
        <div role="status" aria-label="Loading" className="flex min-h-0 flex-1 items-center justify-center">
          <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
        </div>
      </div>
    );
  }
  if (onDismiss) {
    // data-lazy-overlay: a layer over the whole app (escape-layer.ts MODAL_ON_TOP), so a page under it (Health)
    // keeps its Esc while a panel opened over it (Settings) is still on its way. Only a panel that can be closed
    // (onDismiss) marks itself, and it takes that Esc itself and offers Close, so a stalled chunk never leaves Esc dead.
    return (
      <OverlayShell label="Loading" onDismiss={onDismiss} className="overlay-inset fixed inset-0 flex flex-col items-center justify-center gap-2 bg-black/20">
        {children ?? <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />}
        <button type="button" onClick={onDismiss} className="min-h-11 rounded-xl px-4 text-[13px] text-white/80 hover:text-white">
          Close
        </button>
      </OverlayShell>
    );
  }
  return (
    <OverlayShell label="Loading" className="overlay-inset fixed inset-0 flex items-center justify-center bg-black/20">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </OverlayShell>
  );
}
