// The bot's reply, read along as it is spoken: sentences already heard are
// bright, the one audible brightens word by word with the clip's progress,
// the ones still to come are dim. Word brightness is set on the spans each
// frame; React renders the spans only when the sentence changes. Only the
// current sentence is in the accessibility tree: the heard ones were
// already spoken aloud and the queued ones have not sounded yet.
import { useEffect, useMemo, useRef } from "react";

import { auraTicker } from "@/lib/aura-ticker";
import { litWordIndex, readAlongWords, timedProgress } from "@/lib/call-aura";

const DIM = "0.32";

export function ReadAlong({
  spoken = [],
  current,
  queued = [],
  progress,
}: {
  spoken?: string[];
  /** The sentence audible now. */
  current?: string;
  queued?: string[];
  /** How far through the current clip the sound has got, 0..1, or null
   *  when the page has no clip to ask (then time stands in). */
  progress?: (chars: number) => number | null;
}) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  const words = useMemo(() => readAlongWords(current ?? ""), [current]);

  useEffect(() => {
    const line = lineRef.current;
    if (!line || !current) return;
    const spans = Array.from(line.children) as HTMLElement[];
    const ends = words.map((w) => w.end);
    const since = performance.now();
    const chars = current.length;
    let shown = -1;
    const frame = (now: number) => {
      const p = progress?.(chars) ?? timedProgress(now - since, chars);
      // a word once lit stays lit, whatever the clip's clock does
      const lit = litWordIndex(ends, p, shown);
      if (lit === shown) return;
      shown = lit;
      spans.forEach((span, i) => {
        span.style.opacity = i <= lit ? "1" : DIM;
      });
    };
    return auraTicker().subscribe(frame);
  }, [current, words, progress]);

  return (
    <div data-testid="read-along" className="flex max-h-[9.5rem] w-full flex-col gap-1 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_1.2rem,black_calc(100%-0.6rem),transparent)]">
      {spoken.slice(-2).map((line, i) => (
        <p key={`s${spoken.length - 2 + i}`} data-read-along="spoken" aria-hidden="true" className="text-ink/80">
          {line}
        </p>
      ))}
      {current && (
        <p key={current} ref={lineRef} data-read-along="current" className="text-ink">
          {words.map((w, i) => (
            <span key={i} style={{ opacity: DIM, transition: "opacity 140ms ease-out" }}>
              {w.word}{" "}
            </span>
          ))}
        </p>
      )}
      {queued.slice(0, 2).map((line, i) => (
        <p key={`q${i}`} data-read-along="queued" aria-hidden="true" className="text-ink-secondary/55">
          {line}
        </p>
      ))}
    </div>
  );
}
