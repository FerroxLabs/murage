import { t } from "@/lib/i18n";
// Auto-update card — centred, opened from the round button beside the account menu (UpdateIndicator), driven by the
// preload's updater bridge. Renders nothing in the browser/dev (no bridge), on the phone app, and while idle/checking.
// It is the same state machine as the button: both read useUpdaterState, and only "is the card open" is shared
// (lib/update-card.ts). The install path (hand-off, deferred backup) is untouched.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDownToLine, Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";
import { closeUpdateCard, useUpdateCardOpen } from "@/lib/update-card";
import { releaseHighlights } from "@/lib/release-highlights";
import { wrapTabTarget } from "@/lib/focus-wrap";
import { cn } from "@/lib/cn";

// The one action button in the card. Disabled drops the accent fill for the
// flat raised grey — the "I heard you" the click needs while the main process
// gets going.
const primaryAction =
  "flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white transition-colors disabled:cursor-default disabled:bg-control disabled:text-ink-secondary";

// electron-updater surfaces failures as a whole HTTP dump — status line,
// every response header, stack trace. That is unreadable in a 300px popup,
// so name the two cases that actually happen and clip anything else to its
// first line.
function friendlyError(message?: string): string {
  if (!message) return "Something went wrong.";
  if (/cannot find .*\.yml|404/i.test(message))
    return "No update has been published for this platform yet.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(message))
    return "Couldn't reach the update server.";
  return message.split("\n")[0].slice(0, 140);
}

export function UpdateBanner() {
  const s = useUpdaterState();
  const cardOpen = useUpdateCardOpen();
  const cardRef = useRef<HTMLDivElement>(null);
  // Closing is just closing the card: the round button stays while there is anything to do.
  const setDismissed = (_key: string) => closeUpdateCard();
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  const status = s?.status;
  useEffect(() => setPending(null), [status]);
  const busyNow = status === "downloading" || status === "installing";
  // Focus goes into the card when it opens and back to the control that opened it (the round button) when it closes.
  useEffect(() => {
    if (!cardOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => {
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-testid="update-indicator"]');
      back?.focus();
    };
  }, [cardOpen]);
  // Escape and Tab belong to the card while it is open (handlers on the card, not the document).
  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busyNow) {
      event.stopPropagation();
      closeUpdateCard();
    } else if (event.key === "Tab") {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])")];
      const target = wrapTabTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target !== null) {
        event.preventDefault();
        items[target]?.focus();
      }
    }
  };

  if (!cardOpen || !s || s.status === "idle" || s.status === "checking") return null;
  const key = `${s.status}:${s.version ?? ""}`;
  const highlights = releaseHighlights(s.releaseNotesText);
  const updater = window.muragebox!.updater!;

  // while busy the card owns the moment: no dismissing, no second click
  const installing = s.status === "installing";
  const deferred = s.status === "deferred";
  const busy = s.status === "downloading" || installing;
  // Ubuntu system packages can't be swapped under a running app, so the
  // command is copied and a terminal opens; the user finishes there.
  // Nothing restarts, and the card has to stop promising that it will.
  const handoff = s.installMode === "handoff";
  const verificationRefused = s.status === "error" && s.action === "download-from-murage";

  const title =
    verificationRefused ? t("updates.title") : deferred ? "Update waiting for backup" : s.status === "available"
      ? `Murage ${s.version} is available`
      : s.status === "downloading"
        ? `Downloading ${s.version ?? "update"}…`
        : s.status === "downloaded"
          ? `${s.version} is ready`
          : installing
            ? handoff
              ? "Opening a terminal…"
              : "Restarting to update…"
            : s.status === "handed-off"
              ? "Finish in a terminal"
              : "Update could not finish";
  const subtitle =
    verificationRefused ? t("updates.verificationRefused") : deferred ? "This update is waiting for the pre-upgrade backup flow. Review Settings → Backups if it needs attention." : s.status === "available"
      ? "A newer version is ready to download."
      : s.status === "downloading"
        ? // no percent yet means the transfer hasn't reported in — don't imply 0
          s.percent == null
          ? "Starting download…"
          : `${Math.round(s.percent)}%`
        : s.status === "downloaded"
          ? handoff
            ? "Copy the install command and open a terminal."
            : "Restart to finish updating."
          : installing
            ? handoff
              ? "Copying the command…"
              : "Murage will reopen in a moment."
            : s.status === "handed-off"
              ? s.terminalOpened
                ? "Command copied. Paste it in the terminal that opened."
                : "Command copied. Paste it in a terminal to finish."
              : friendlyError(s.message);

  return (
    <div className="overlay-inset fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="update-card-layer">
    <div className="absolute inset-0 bg-black/40" onMouseDown={() => { if (!busy) closeUpdateCard(); }} />
    <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onKeyDown={onCardKeyDown} data-testid="update-card" className="animate-panel-in relative w-[340px] max-w-full rounded-xl border border-hairline/40 bg-panel p-4 shadow-2xl shadow-black/50 focus:outline-none">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 break-words text-[12.5px] text-ink-secondary" role={s.status === "error" ? "alert" : deferred ? "status" : undefined} title={subtitle}>
            {subtitle}
          </div>
        </div>
        {!busy && (
          <button
            onClick={() => setDismissed(key)}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {highlights.length > 0 && !verificationRefused && s.status !== "error" && (
        <div className="mt-3" data-testid="update-highlights">
          <div className="text-[12px] font-medium text-ink-secondary">{t("updates.whatsNew")}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-ink">
            {highlights.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {s.status === "handed-off" && s.command && (
        <code className="mt-2.5 block overflow-x-auto rounded-lg bg-control px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-secondary">
          {s.command}
        </code>
      )}

      {s.status === "downloading" && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-control">
          <div
            className={cn(
              "h-full rounded-full bg-accent transition-[width]",
              // before the first progress report, a sliver that breathes beats
              // a zero-width bar that looks stalled
              s.percent == null && "w-1/4 animate-pulse",
            )}
            style={s.percent == null ? undefined : { width: `${Math.min(100, Math.max(0, s.percent))}%` }}
          />
        </div>
      )}

      {installing && (
        <div className="mt-2.5 flex gap-2">
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
          </button>
        </div>
      )}

      {!busy && !deferred && (
        <div className="mt-2.5 flex gap-2">
          {s.status === "available" && (
            <button
              onClick={() => {
                setPending("download");
                void updater.download().finally(() => setPending(null));
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "download" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <ArrowDownToLine size={13} /> {t("updates.download")}
                </>
              )}
            </button>
          )}
          {s.status === "downloaded" && (
            <button
              onClick={() => {
                setPending("install");
                void updater.install().finally(() => setPending(null));
              }}
              disabled={pending !== null}
              className={primaryAction}
            >
              {pending === "install" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
                </>
              ) : handoff ? (
                <>
                  <PackageOpen size={13} /> Install
                </>
              ) : (
                <>
                  <RefreshCw size={13} /> {t("updates.restart")}
                </>
              )}
            </button>
          )}
          {s.status === "error" && (
            <button
              onClick={() => {
                if (verificationRefused) {
                  void window.muragebox?.openExternal?.("https://murage.ai/download");
                  return;
                }
                setPending("check");
                void updater.retry().finally(() => setPending(null));
              }}
              disabled={pending !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:text-ink-secondary disabled:hover:bg-control"
            >
              {verificationRefused ? t("updates.downloadFromMurage") : pending === "check" ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Trying again…
                </>
              ) : (
                t("updates.retry")
              )}
            </button>
          )}
          <button
            onClick={() => setDismissed(key)}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {/* after a hand-off there is nothing left to postpone */}
            {s.status === "handed-off" ? "Done" : t("updates.later")}
          </button>
        </div>
      )}
    </div>
    </div>
  );
}
