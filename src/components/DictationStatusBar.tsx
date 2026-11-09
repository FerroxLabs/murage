// The stop control for composer dictation when the Composer cannot draw it
// (DICTATION-LIFECYCLE-1018 section 3). The OS recognizer may be running in
// every state but idle, so a stop control must always be reachable:
//   - the Composer draws the same control as a strip when an approval or a
//     locked box hides its mic;
//   - this bar, mounted once in the app shell, draws it when the owner Composer
//     is not mounted (a thread switch, another view) or a layer is open above
//     it. It is portaled INTO the topmost active layer's root, because a modal
//     dialog makes everything outside it inert, else to the end of the body.
import { createPortal } from "react-dom";
import { FAILED_TEXT, dictationStopAgain, dictationStopControl, dictationStopRequest, useDictation, useLayerCover, type DictationKind } from "@/lib/dictation-session";
import { cn } from "@/lib/cn";
import { useHelpDock } from "@/lib/help-dock";

export function DictationControl({
  kind,
  onStop,
  onStopAgain,
  className,
}: {
  kind: DictationKind;
  onStop: () => void;
  onStopAgain: () => void;
  className?: string;
}) {
  const failed = kind === "failed";
  return (
    <div
      role="status"
      data-dictation-control
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]",
        failed ? "border-warning/30 bg-warning/10 text-warning" : "border-hairline/60 bg-raised text-ink-secondary",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{failed ? FAILED_TEXT : kind === "stopping" ? "Stopping dictation" : "Listening"}</span>
      <button
        type="button"
        onClick={failed ? onStopAgain : onStop}
        className="shrink-0 rounded px-2 py-1 font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {failed ? "Stop again" : "Stop dictation"}
      </button>
    </div>
  );
}

const WINDOW_CLASS = "fixed bottom-4 left-1/2 z-[79] w-[min(32rem,92vw)] -translate-x-1/2 shadow-lg";
/** Inside help's own panel while help is open: Stop is then always on screen, never behind the panel. */
const IN_HELP_CLASS = "absolute inset-x-4 bottom-4 shadow-lg";

export function DictationStatusBar() {
  const { state, ownerMounted } = useDictation();
  const cover = useLayerCover();
  const helpDock = useHelpDock();
  const where = dictationStopControl(state.kind, { ownerMounted, covered: cover.covered, approval: false, locked: false, available: true });
  if (where !== "app" || typeof document === "undefined") return null;
  // Help's own element when help belongs to the active layer (or no layer is open); a modal that does not hold help keeps the bar inside itself.
  const target = helpDock !== null && (cover.root === null || cover.root.contains(helpDock)) ? helpDock : cover.root ?? document.body;
  return createPortal(
    <DictationControl
      kind={state.kind}
      onStop={() => state.owner !== null && dictationStopRequest(state.owner)}
      onStopAgain={dictationStopAgain}
      className={target === helpDock ? IN_HELP_CLASS : WINDOW_CLASS}
    />,
    target,
  );
}
