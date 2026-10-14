// The ⌘K palette's first-paint stand-in. The palette itself (CommandPalette)
// is a separate chunk: this listens for the same chord and the sidebar's
// open request, loads the chunk on the first one, and hands that request to
// it. From then on the palette owns its chord and its open state.
import { Suspense, useEffect, useState } from "react";
import { OPEN_PALETTE_EVENT } from "@/lib/app-events";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";

const Palette = retryableLazy(() => import("./CommandPalette").then((module) => ({ default: module.CommandPalette })));

export function CommandPaletteHost({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [first, setFirst] = useState<{ query: string } | null>(null);
  useEffect(() => {
    if (first) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setFirst({ query: "" });
      }
    };
    const onOpen = (event: Event) => {
      const query = (event as CustomEvent<{ query?: unknown } | undefined>).detail?.query;
      setFirst({ query: typeof query === "string" ? query.slice(0, 200) : "" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, [first]);
  if (!first) return null;
  return (
    <LazyBoundary onRetry={Palette.retry} onDismiss={() => setFirst(null)}>
      <Suspense fallback={null}>
        <Palette.Component onOpenChange={onOpenChange} initialOpen initialQuery={first.query} />
      </Suspense>
    </LazyBoundary>
  );
}
