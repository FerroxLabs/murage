// What a surface loaded on first use shows while its chunk arrives (spec §6).
// On a desktop that is a frame or two. On a phone over cellular it can be a
// second, and a tap that shows nothing for a second reads as a tap that did
// not land.
import { Loader2 } from "lucide-react";

export function LazyFallback({ inline = false }: { inline?: boolean } = {}) {
  // Inline: a view in the main pane (a group room) spins in its own place, so
  // the rail and banners stay usable while it arrives.
  if (inline) {
    return (
      <div role="status" aria-label="Loading" className="flex h-full min-w-0 flex-1 items-center justify-center bg-app">
        <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div role="status" aria-label="Loading" className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}
