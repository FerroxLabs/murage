// The model's reasoning while the turn runs: a quiet, collapsible row above
// the working mascot, shown to everyone. Collapsed until the person opens it,
// and folded again the moment answer text starts arriving (it can be opened
// again). It is stream state, not a message: it has no copy control, never
// enters the Markdown export, and is gone once the answer settles.
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { CHIP } from "@/lib/transcript-chrome";

/** How much of a long think stays mounted. The newest text is what says the
 * model is still moving; the start of a 100 KB think is not worth the DOM. */
export const THINKING_TAIL_CHARS = 4_000;

/** The end of the reasoning, cut at a line or word boundary when it is long. */
export function thinkingTail(text: string, max = THINKING_TAIL_CHARS): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const tail = text.slice(-max);
  const boundary = tail.search(/[\n ]/);
  return { text: boundary > 0 && boundary < 200 ? tail.slice(boundary + 1) : tail, clipped: true };
}

export interface ThinkingFold {
  open: boolean;
  /** whether answer text was streaming when this state was last updated */
  answering: boolean;
}

/** The row's open state. A click toggles it; the answer starting folds it,
 * once, and a later click may open it again. */
export function thinkingFoldAfter(
  state: ThinkingFold,
  event: { type: "toggle" } | { type: "answering"; value: boolean },
): ThinkingFold {
  if (event.type === "toggle") return { ...state, open: !state.open };
  if (event.value === state.answering) return state;
  return { open: event.value ? false : state.open, answering: event.value };
}

/** The reasoning itself, as the open row shows it. */
export function LiveThinkingText({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  const tail = thinkingTail(text);
  return (
    <div
      ref={body}
      data-testid="live-thinking-text"
      // The transcript is a polite live region; a token-by-token think
      // inside it would be read aloud without end.
      aria-live="off"
      className="max-h-48 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-hairline/40 pl-3 text-[12.5px] italic leading-relaxed text-ink-secondary"
    >
      {tail.clipped ? "…" : null}
      {tail.text}
    </div>
  );
}

export function LiveThinking({
  text,
  answering,
  defaultOpen = false,
}: {
  text: string;
  answering: boolean;
  /** Collapsed unless the person opens it. */
  defaultOpen?: boolean;
}) {
  const [stored, setStored] = useState<ThinkingFold>({ open: defaultOpen, answering });
  // Derived during render (React's "adjust state when a prop changes"), so
  // the fold lands in the same paint as the first answer token.
  let fold = stored;
  const next = thinkingFoldAfter(stored, { type: "answering", value: answering });
  if (next !== stored) {
    fold = next;
    setStored(next);
  }
  const { open } = fold;
  return (
    <div className="flex justify-start" data-testid="live-thinking">
      <div className="flex min-w-0 max-w-[min(42rem,78%)] max-md:max-w-full flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => setStored((current) => thinkingFoldAfter(current, { type: "toggle" }))}
          aria-expanded={open}
          title={open ? "Hide thinking" : "Show thinking"}
          className={cn(CHIP, "text-ink-secondary hover:bg-control")}
        >
          <ChevronRight size={13} className={cn("shrink-0", open && "rotate-90")} />
          <span>{answering ? "Thought" : "Thinking"}</span>
        </button>
        {open ? <LiveThinkingText text={text} /> : null}
      </div>
    </div>
  );
}
