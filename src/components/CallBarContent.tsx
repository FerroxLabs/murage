// The call bar's content: a pulse dot, the live status line, and Hang up.
//
// Shared by two renderers (callbar-rereview.md N2, N4): CallBarStrip
// (CallControls.tsx), which ChatView/GroupView mount in normal layout
// under their own header, and the fallback Call/GroupCall render
// themselves — fixed, since there is no layout to sit in — for the rare
// case where no chat or room column is mounted at all: Routines, the team
// map, the skill recorder, an empty state, or the call's own bot/room's
// workspace. Both read the SAME status (never a hard-coded "live"), so a
// paused or lost call never claims to be live no matter which one is
// showing it, and the bar's tap always does something (N4): it returns to
// the call's own thread and, for a lost call, hands off to the full
// screen's own "Resume call" offer.
//
// Two sibling buttons, never one nested in another (M2).
import { PhoneOff } from "lucide-react";

import { cn } from "@/lib/cn";
import type { CallBarStatus } from "@/lib/call-bar";

export function CallBarContent({
  name,
  status,
  onReturn,
  onHangUp,
}: {
  name: string;
  status: CallBarStatus;
  onReturn: () => void;
  onHangUp: () => void;
}) {
  const live = status === "live";
  const resumable = status === "paused" || status === "lost";
  const lead =
    status === "connecting" ? `Connecting to ${name}…` : live ? `On a call with ${name}.` : `Call with ${name} paused.`;
  // md+: the full sentence reads as a short phrase without "Tap", which
  // only makes sense where you tap.
  const actionMobile = live ? "Tap to return" : resumable ? "Tap to resume" : "";
  const actionWide = live ? "Return to call" : resumable ? "Resume call" : "";
  return (
    <>
      {/* The pulse means "live": a paused or still-connecting call gets a
          plain dot, never the ping animation. */}
      <span className="relative flex size-2.5 shrink-0">
        {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/60" />}
        <span className={cn("relative inline-flex size-2.5 rounded-full", live ? "bg-accent" : "bg-ink-secondary/50")} />
      </span>
      <button
        type="button"
        onClick={onReturn}
        className="min-w-0 flex-1 truncate text-left text-[13px] text-ink hover:underline"
      >
        {lead}
        {(actionMobile || actionWide) && (
          <>
            {" "}
            {actionMobile && <span className="md:hidden">{actionMobile}</span>}
            {actionWide && <span className="hidden md:inline">{actionWide}</span>}
          </>
        )}
      </button>
      <button
        type="button"
        onClick={onHangUp}
        aria-label="Hang up"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-danger text-white hover:brightness-110"
      >
        <PhoneOff size={13} />
      </button>
    </>
  );
}
