// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { OPEN_PALETTE_EVENT } from "@/lib/app-events";
import { imeComposing } from "@/lib/composer-enter";
import { nextLayerSequence } from "@/lib/layers";
import { openLayers, type TrapElement } from "@/lib/focus-trap";
import { LazyOverlay } from "./LazyOverlay";
import { retryableLazy } from "./LazyBoundary";
import type { CommandPaletteProps } from "./CommandPalette";

const Palette = retryableLazy(() => import("./CommandPalette").then((module) => ({ default: module.CommandPalette })));
export interface PaletteRequest { token: number; query: string; opener: TrapElement | null; openingSequence: number }

export function CommandPaletteHost({ onOpenChange, palette = Palette }: {
  onOpenChange?: (open: boolean) => void;
  /** Isolated chunk gate for mounted lifecycle tests. */
  palette?: { Component: React.ComponentType<CommandPaletteProps>; retry: () => void };
}) {
  const [request, setRequest] = useState<PaletteRequest | null>(null);
  const current = useRef<PaletteRequest | null>(null);
  const generation = useRef(0);
  const closeRequest = useCallback((token: number) => {
    if (current.current?.token !== token) return;
    current.current = null;
    setRequest(null);
  }, []);
  useLayoutEffect(() => {
    current.current = request;
    return () => { if (current.current === request) current.current = null; };
  }, [request]);
  useEffect(() => { onOpenChange?.(Boolean(request)); }, [onOpenChange, request]);
  useEffect(() => {
    const accept = (query: string) => {
      const active = document.activeElement as HTMLElement | null;
      const old = current.current;
      const inOld = old && openLayers().some(layer => layer.kind === 'palette' && layer.container?.contains(active));
      const opener = inOld && old.opener?.isConnected !== false ? old.opener : active;
      const next = { token: ++generation.current, query, opener, openingSequence: nextLayerSequence() };
      current.current = next;
      setRequest(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (imeComposing(e)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey && !e.isComposing) {
        e.preventDefault();
        if (current.current) closeRequest(current.current.token); else accept("");
      }
    };
    const onOpen = (event: Event) => {
      const query = (event as CustomEvent<{ query?: unknown } | undefined>).detail?.query;
      accept(typeof query === "string" ? query.slice(0, 200) : "");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, [closeRequest]);
  if (!request) return null;
  const isCurrent = () => current.current?.token === request.token;
  return <LazyOverlay key={request.token} name="palette" kind="palette" covers="always" fallback={null}
    opener={request.opener} openingSequence={request.openingSequence}
    onRetry={palette.retry} onDismiss={() => closeRequest(request.token)}>
    {({ dismiss }) => <palette.Component request={request} isCurrent={isCurrent} onClose={dismiss} />}
  </LazyOverlay>;
}
