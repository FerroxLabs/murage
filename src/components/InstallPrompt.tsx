import { useRef } from "react";
import { Share, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { NOTICE_CORNER, useClearOfComposer, useNoticeTurn } from "@/lib/notice-lane";
import { useInstallPrompt } from "@/lib/use-install-prompt";

/** The invitation to put Murage on a home screen.
 *
 * Only ever rendered on a CONFIRMED remote surface — a phone or another
 * computer reaching this app through the browser door. The desktop app is
 * already an app and has nothing to install.
 *
 * It says nothing at all over plain HTTP. Installation is impossible outside
 * a secure context whatever the manifest declares, and the door serves plain
 * HTTP until remote access is turned on — so an invitation there would be
 * instructions for something that cannot happen.
 *
 * One of the corner notices (lib/notice-lane.ts), the lowest: it waits while
 * any other one is up, and never covers the composer. */
export function InstallPrompt() {
  const { invite, install, dismiss } = useInstallPrompt();
  const wants = invite !== "hidden";
  const turn = useNoticeTurn("install", wants);
  const frame = useRef<HTMLDivElement>(null);
  const clear = useClearOfComposer(frame, wants && turn);
  if (!wants || !turn) return null;
  return (
    <div
      ref={frame}
      role="complementary"
      aria-label="Add Murage to your home screen"
      data-testid="install-prompt"
      className={cn(NOTICE_CORNER, "rounded-2xl border border-hairline/50 bg-panel/95 p-4 shadow-2xl shadow-black/50 backdrop-blur")}
      style={clear.bottom === undefined ? { bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" } : clear}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">Add Murage to your home screen</p>
          {invite === "prompt" ? (
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
              Opens like an app, without the browser bars.
            </p>
          ) : (
            // iOS gives no API for this — not to trigger it, not even to ask
            // whether it is possible. Pointing at the Share button is the
            // only honest thing available.
            <p className="mt-1 flex flex-wrap items-center gap-1 text-[12.5px] leading-relaxed text-ink-secondary">
              Tap <Share size={13} className="inline shrink-0" aria-label="the Share button" /> then
              <span className="font-medium text-ink">Add to Home Screen</span>.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          className="-mr-1 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <X size={16} />
        </button>
      </div>
      {invite === "prompt" && (
        <button
          type="button"
          onClick={install}
          className="mt-3 h-11 w-full rounded-xl bg-accent px-4 text-[14px] font-medium text-white focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          Install
        </button>
      )}
    </div>
  );
}
