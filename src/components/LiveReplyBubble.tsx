import { memo, useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { paintDelay, paintedText } from "../lib/stream-paint";
import { ChatMarkdown } from "./ChatMarkdown";

/** The live text, repainted at most about 30 times a second. */
export function useStreamPaint(live: string): string {
  const [painted, setPainted] = useState("");
  const lastPaintAt = useRef<number | null>(null);
  useEffect(() => {
    if (!live) {
      lastPaintAt.current = null;
      setPainted("");
      return;
    }
    const paint = () => {
      lastPaintAt.current = performance.now();
      setPainted(live);
    };
    const delay = paintDelay(lastPaintAt.current, performance.now());
    if (delay === 0) {
      paint();
      return;
    }
    const timer = setTimeout(paint, delay);
    return () => clearTimeout(timer);
  }, [live]);
  return paintedText(live, painted);
}

/** The reply as it is being written: the settled assistant bubble's look, the
 * same markdown component, and it is replaced in place by the stored message.
 * Hidden from assistive tech: the settled message is announced once. */
export const LiveReplyBubble = memo(function LiveReplyBubble({
  text,
  scope,
  className,
}: {
  text: string;
  scope: { botId: string; threadId: string };
  className?: string;
}) {
  return (
    <div
      data-testid="live-reply"
      aria-hidden="true"
      className={cn("w-fit max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink", className)}
    >
      <ChatMarkdown text={text} streaming scope={scope} />
    </div>
  );
});
