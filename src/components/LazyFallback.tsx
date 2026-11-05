// What a surface loaded on first use shows while its chunk arrives (spec §6).
// On a desktop that is a frame or two. On a phone over cellular it can be a
// second, and a tap that shows nothing for a second reads as a tap that did
// not land.
import { Loader2 } from "lucide-react";
import { PhoneBotListBar } from "@/components/OpenBotListButton";

export function LazyFallback({ inline = false }: { inline?: boolean } = {}) {
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
  return (
    <div role="status" aria-label="Loading" className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}
