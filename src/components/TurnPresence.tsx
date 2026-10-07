// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. The moment there is an answer, the label is gone and
// the full bubble pops in above the mascot (same left edge).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingTimer } from "@/components/WorkingIndicator";

export function TurnPresence({
  avatar,
  visible,
  label = "Thinking",
  answering = false,
  since = null,
  name,
  children,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  /** Turn start (epoch ms) — shows a self-ticking elapsed readout while working. */
  since?: number | null;
  /** Rooms: who is working. A room has several possible speakers, so the
   * mascot alone does not say whose turn this is. */
  name?: string;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const showAnswer = phase === "answer" && children;
  // An empty label means the live thinking row is saying it: the mascot
  // stays, the words and the timer are the row's.
  const showWorking = phase === "think" && label !== "";
  const speaker = name ? (
    <span data-testid="turn-speaker" className="text-[11px] font-medium text-ink-secondary">{name}</span>
  ) : null;
  return (
    <div className="turn-presence flex flex-col items-start">
      {showAnswer ? (
        <div className="turn-answer flex flex-col items-start gap-1">
          {speaker}
          {children}
        </div>
      ) : null}
      <div
        className={cn(
          "flex items-center gap-2",
          showAnswer && "turn-mascot-tight",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {!showAnswer ? speaker : null}
        {showWorking ? (
          <span className="flex items-baseline gap-2 leading-none">
            <span className="thinking-shimmer animate-shimmer text-[13px]" aria-live="polite">
              {label}
            </span>
            {since !== null && (
              <WorkingTimer since={since} className="text-[11.5px] text-ink-secondary/70" />
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
