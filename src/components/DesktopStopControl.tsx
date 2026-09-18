// The stop a person reaches for while a bot is driving their own screen.
//
// Until this existed the only call to the harness's local-computer interrupt
// lived in LinuxLocalControl, which returns null off Linux — so on macOS,
// where Auto hands a bot this very desktop by default, the Computer panel had
// no stop at all. The header Stop did work, but it is in the chat, not in the
// panel the person opens when they are watching their own cursor move.
//
// It is deliberately NOT a second header Stop: it also takes the screen back,
// which is the only lever the harness honours before the engine finishes
// dying. See src/lib/desktop-stop.ts for why the result is reported rather
// than assumed.
import { useCallback, useState } from "react";
import { AlertTriangle, Hand, Loader2, OctagonX } from "lucide-react";

import { cn } from "@/lib/cn";
import { desktopStopMessage, stopDesktopControl, type DesktopStopOutcome } from "@/lib/desktop-stop";

export interface DesktopStopControlProps {
  botName: string;
  /** True only while this bot's turn can reach this screen. */
  usingThisScreen: boolean;
  /** True while the person already holds the screen. */
  held: boolean;
  takeScreen: () => Promise<boolean>;
  stopTurn: () => Promise<void>;
  confirmIdle: () => Promise<boolean>;
}

export function DesktopStopControl({ botName, usingThisScreen, held, takeScreen, stopTurn, confirmIdle }: DesktopStopControlProps) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<DesktopStopOutcome | null>(null);

  const run = useCallback(async () => {
    setPending(true);
    setOutcome(null);
    try {
      // A screen already held is not re-taken: that is the state this control
      // wants, and re-asserting it would report a failure that is not one.
      setOutcome(await stopDesktopControl({ takeScreen: held ? async () => true : takeScreen, stopTurn, confirmIdle }));
    } finally {
      setPending(false);
    }
  }, [confirmIdle, held, stopTurn, takeScreen]);

  // The moment it matters is the only moment it is here.
  if (!usingThisScreen) return null;

  return (
    <section className="mt-4 rounded-xl border border-danger/25 bg-danger/5 p-4" aria-labelledby="desktop-stop-title">
      <div className="flex items-start gap-3">
        <Hand size={16} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div id="desktop-stop-title" className="text-[14px] font-medium text-ink">
            {botName} is using this computer
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            Stop it and take this screen back. An action already underway can still finish, so check the screen
            afterwards.
          </p>
          <button
            type="button"
            onClick={() => void run()}
            disabled={pending}
            aria-label={`Stop ${botName} using this computer`}
            className={cn(
              "mt-3 inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-[12.5px] font-medium text-white",
              "hover:brightness-110 disabled:opacity-50",
            )}
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <OctagonX size={13} />}
            Stop using this computer
          </button>
          {outcome && (
            <div
              role="status"
              className={cn(
                "mt-3 flex gap-1.5 text-[12px] leading-relaxed",
                outcome.kind === "stopped" ? "text-ink-secondary" : "text-danger",
              )}
            >
              {outcome.kind !== "stopped" && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
              <span>{desktopStopMessage(outcome, botName)}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
