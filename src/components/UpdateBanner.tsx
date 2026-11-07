// Auto-update surface, driven by the preload's updater bridge. Renders nothing in the browser/dev (no bridge), on the phone
// app, and while idle/checking. Two frames, one content (UpdateCardBody):
// - the centred card, opened from the round button beside the account menu (UpdateIndicator);
// - the pop-up: comes up by itself when a download starts, stays through to the restart, and never takes focus or sits over
//   the composer. A download always shows here, so the card never holds the app while one runs. It sits above the sidebar
//   footer, under menus; while a modal window is open (What's New after an update: canary 1.0.16 on a Mac had the pop-up
//   behind it) it moves inside that window as a top-layer popover, so it shows above it and its buttons work.
// All of it is the same state machine as the button: everything reads useUpdaterState, and only "is the card open" and how the
// pop-up stands are shared (lib/update-card.ts). The install path (hand-off, deferred backup) is untouched.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDownToLine, Loader2, PackageOpen, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { createPortal } from "react-dom";
import { closeUpdateCard, closeUpdatePopup, installerOffer, popupFocusReturn, updatePopupPlace, useUpdateCardOpen, useUpdatePopup, useUpdatePopupAnchor, type UpdatePopupPlace } from "@/lib/update-card";
import { watchModalWindow } from "@/lib/modal-window";
import { focusableWithin } from "@/lib/focus-trap";
import { useUndoToast } from "@/lib/undo";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { releaseHighlights } from "@/lib/release-highlights";
import { wrapTabTarget } from "@/lib/focus-wrap";
import { cn } from "@/lib/cn";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

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
  // Mounted beside the terms gate, outside Shell, so it follows a language change itself.
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const s = useUpdaterState();
  const cardOpen = useUpdateCardOpen();
  const popupUp = useUpdatePopup(s);
  const cardRef = useRef<HTMLDivElement>(null);
  const status = s?.status;
  // Closing is just closing: the round button stays while there is anything to do.
  const dismiss = () => {
    closeUpdateCard();
    closeUpdatePopup(status);
  };
  // The card hands a download over to the pop-up, so pressing Download never leaves the app held behind a scrim.
  const cardShows = cardOpen && status !== "downloading";
  useEffect(() => {
    if (cardOpen && status === "downloading") closeUpdateCard();
  }, [cardOpen, status]);
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
    if (event.key === "Escape" && status !== "installing") {
      event.stopPropagation();
      dismiss();
    } else if (event.key === "Tab") {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])")];
      const target = wrapTabTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target !== null) {
        event.preventDefault();
        items[target]?.focus();
      }
    }
  };

  if (!s || s.status === "idle" || s.status === "checking") return null;
  if (cardShows) {
    const busy = s.status === "installing";
    return (
      <div className="overlay-inset fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="update-card-layer">
        <div className="absolute inset-0 bg-black/40" onMouseDown={() => { if (!busy) dismiss(); }} />
        <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={updateTitle(s)} onKeyDown={onCardKeyDown} data-testid="update-card" className={cn(BOX_FRAME, "animate-panel-in relative max-h-[calc(var(--vvh,100dvh)-2rem)] w-[340px] max-w-full rounded-xl border border-hairline/40 bg-panel pb-4 shadow-2xl shadow-black/50 focus:outline-none")}>
          <UpdateCardBody s={s} onDismiss={dismiss} />
        </div>
      </div>
    );
  }
  return popupUp ? <UpdatePopup s={s} onDismiss={dismiss} /> : null;
}

/** The open modal window the pop-up lives in (the one opened last), kept current as windows open and close. The same watch as
 * the "?" help tab (lib/modal-window.ts). */
function useModalHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => watchModalWindow(setHost), []);
  return host;
}

/** Bottom-left, no scrim, no focus. With no modal window open it is a fixed box under menus and overlays (z-40), as before.
 * While a modal window is open (What's New included) it lives inside that window as a manual popover, so it is drawn in the top
 * layer above it and is not inert there. Moves up for the Undo toast. */
function UpdatePopup({ s, onDismiss }: { s: UpdaterState; onDismiss: () => void }) {
  const toast = useUndoToast();
  const frame = useRef<HTMLElement>(null);
  const host = useModalHost();
  const footer = useUpdatePopupAnchor();
  // A new home is a new element: show it again, after any window that just opened, so it is the top of the top layer.
  useLayoutEffect(() => {
    if (!host) return;
    try { frame.current?.showPopover(); } catch { /* already shown, or no popover support: it stays a fixed box */ }
  }, [host]);
  // Where focus was before a keyboard came in, so closing can hand it back there.
  const origin = useRef<HTMLElement | null>(null);
  // It never reaches for focus, but a keyboard that came in and closed it must not be dropped on the page (or on an inert one).
  const close = () => {
    const popup = frame.current;
    const held = popup?.contains(document.activeElement) ?? false;
    onDismiss();
    if (!held) return;
    const choices = popupFocusReturn<HTMLElement>({
      host,
      origin: origin.current,
      inHost: (element) => host?.contains(element) ?? false,
      inPopup: (element) => popup?.contains(element) ?? false,
      hostControls: () => (host ? (focusableWithin(host) as HTMLElement[]) : []),
      button: () => document.querySelector<HTMLElement>('[data-testid="update-indicator"], [data-testid="update-button"]'),
    });
    // The first that really takes focus: one that turned disabled or hidden meanwhile does not, so the next is tried.
    for (const back of choices) {
      if (back === host && !host.hasAttribute("tabindex")) host.tabIndex = -1;
      back.focus();
      if (document.activeElement === back) break;
    }
  };
  const [place, setPlace] = useState<UpdatePopupPlace>({ left: 16, width: 300, bottom: 16 });
  useLayoutEffect(() => {
    const anchor = footer ?? document.querySelector<HTMLElement>("[data-update-popup-anchor]");
    const measure = () => {
      const rect = anchor?.getBoundingClientRect();
      // Off to the left means the drawer is shut.
      const footer = rect && rect.left >= 0 ? { left: rect.left, top: rect.top, width: rect.width } : null;
      const toastHeight = document.querySelector("[data-undo-toast]")?.getBoundingClientRect().height ?? 0;
      setPlace(updatePopupPlace({ footer, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, toastHeight }));
    };
    measure();
    const footerResize = anchor && typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (anchor) footerResize?.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      footerResize?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [toast, footer]);
  const popup = (
    <section
      ref={frame}
      popover={host ? "manual" : undefined}
      aria-label={t("updates.title")}
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) origin.current = from;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Inside a dialog, Escape here closes the pop-up only, not the dialog under it.
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      data-testid="update-popup"
      style={place}
      className={cn(BOX_FRAME, "animate-panel-in fixed inset-auto z-40 m-0 w-auto max-h-[calc(var(--vvh,100dvh)-1.5rem)] rounded-xl border border-hairline/40 bg-panel px-0 pt-0 pb-3.5 text-ink shadow-2xl shadow-black/50")}
    >
      <UpdateCardBody s={s} popup onDismiss={close} />
    </section>
  );
  return host ? createPortal(popup, host) : popup;
}

function updateTitle(s: UpdaterState): string {
  const installing = s.status === "installing";
  const deferred = s.status === "deferred";
  const handoff = s.installMode === "handoff";
  const verificationRefused = s.status === "error" && s.action === "download-from-murage";
  const installer = installerOffer(s);
  return installer ? t("updates.installerTitle", { version: installer.version }) : verificationRefused ? t("updates.title") : deferred ? "Update waiting for backup" : s.status === "available"
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
}

// What the pop-up reads out: tens of percent, so a screen reader is not talking over the owner for the whole download.
const spokenPercent = (percent: number) => `${Math.floor(percent / 10) * 10}%`;

/** The content of both frames. In the pop-up it drops the highlights (the card has them) and can always be closed. */
function UpdateCardBody({ s, popup = false, onDismiss }: { s: UpdaterState; popup?: boolean; onDismiss: () => void }) {
  // A click has to go renderer → main → broadcast before the real status
  // arrives. Latch the pressed button as busy on the same frame so it greys
  // out immediately; the incoming status clears the latch.
  const [pending, setPending] = useState<"download" | "install" | "check" | null>(null);
  const status = s.status;
  useEffect(() => setPending(null), [status]);
  const highlights = releaseHighlights(s.releaseNotesText);
  const updater = window.muragebox!.updater!;

  // while busy the card owns the moment: no second click, and no dismissing it (the pop-up can always go)
  const installing = s.status === "installing";
  const deferred = s.status === "deferred";
  const busy = s.status === "downloading" || installing;
  // Ubuntu system packages can't be swapped under a running app, so the
  // command is copied and a terminal opens; the user finishes there.
  // Nothing restarts, and the card has to stop promising that it will.
  const handoff = s.installMode === "handoff";
  const verificationRefused = s.status === "error" && s.action === "download-from-murage";

  const installer = installerOffer(s);
  const title = updateTitle(s);
  const subtitle =
    installer ? t("updates.installerSteps", { version: installer.version }) : verificationRefused ? t("updates.verificationRefused") : deferred ? "This update is waiting for the pre-upgrade backup flow. Review Settings → Backups if it needs attention." : s.status === "available"
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

  // The pop-up is a status region, except for an error, which stays the alert it is on the card.
  const liveRegion = popup && s.status !== "error";
  const counting = popup && s.status === "downloading" && s.percent != null;
  const side = popup ? "px-3.5" : "px-4";

  return (
    <>
      <BoxHead className={cn("items-start justify-start gap-2.5", side, popup ? "pt-3.5" : "pt-4")}>
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1" role={liveRegion ? "status" : undefined} aria-live={liveRegion ? "polite" : undefined}>
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
          <div className="mt-0.5 break-words text-[12.5px] text-ink-secondary" role={s.status === "error" ? "alert" : deferred && !liveRegion ? "status" : undefined} title={subtitle} aria-hidden={counting || undefined}>
            {subtitle}
          </div>
          {counting && <span className="sr-only">{spokenPercent(s.percent!)}</span>}
        </div>
        {(popup || !busy) && (
          <button
            onClick={onDismiss}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            title={t("ux.l5a.dismiss")}
            aria-label={t("ux.l5a.dismiss")}
          >
            <X size={14} />
          </button>
        )}
      </BoxHead>

      <BoxBody className={side}>
      {!popup && highlights.length > 0 && !verificationRefused && s.status !== "error" && (
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
      </BoxBody>

      {installing && (
        <BoxFoot className={cn("justify-start pt-2.5", side)}>
          <button
            disabled
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[13px] font-medium text-ink-secondary"
          >
            <Loader2 size={13} className="animate-spin" /> {handoff ? "Opening…" : "Restarting…"}
          </button>
        </BoxFoot>
      )}

      {!busy && !deferred && (
        <BoxFoot className={cn("justify-start pt-2.5", side)}>
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
          {installer && <button onClick={() => void window.muragebox?.openExternal?.(installer.url)} className={primaryAction}><ArrowDownToLine size={13} /> {t("updates.downloadInstaller", { version: installer.version })}</button>}
          {s.status === "error" && !installer && (
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
            onClick={onDismiss}
            disabled={pending !== null}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent"
          >
            {/* after a hand-off there is nothing left to postpone */}
            {s.status === "handed-off" ? "Done" : t("updates.later")}
          </button>
        </BoxFoot>
      )}
    </>
  );
}
