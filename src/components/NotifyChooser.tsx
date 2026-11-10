// STUB (FR19b), see src/lib/notify-surfaces.ts. Frozen contract from NOTIFY19:
// <NotifyChooser onDone={(r:{outcome:"saved"|"kept-inside"})=>void} onError?={(msg:string)=>void} />
import { FIRST_RUN_PRIMARY, FIRST_RUN_QUIET, FIRST_RUN_FOCUS, FirstRunBubble, FirstRunLine } from "./FirstRunChrome";

export interface NotifyChooserResult { outcome: "saved" | "kept-inside" }

export function NotifyChooser({ onDone, onError }: { onDone: (result: NotifyChooserResult) => void; onError?: (message: string) => void }) {
  void onError;
  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">How would you like to be notified?</div>
      <FirstRunLine>Pick how your team reaches you when a job finishes or needs a word. Every one of these stays a switch in Settings, under Notify me.</FirstRunLine>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`} onClick={() => onDone({ outcome: "saved" })}>Continue</button>
        <button type="button" className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`} onClick={() => onDone({ outcome: "kept-inside" })}>Keep everything inside Murage for now</button>
      </div>
    </FirstRunBubble>
  );
}
