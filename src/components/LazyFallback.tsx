// What a surface loaded on first use shows while its chunk arrives (spec §6).
// On a desktop that is a frame or two. On a phone over cellular it can be a
// second, and a tap that shows nothing for a second reads as a tap that did
// not land.
import { Loader2 } from "lucide-react";

export function LazyFallback() {
  return (
    <div role="status" aria-label="Loading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}
