// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one Undo toast (L5A, handoffs/UNDO-HOST-DESIGN.md sections 4 and 8).
// Bottom-left like TeamFeedbackToast (bottom-centre would cover Send). It
// never takes focus when it appears; pointer over or focus inside holds the
// 8-second window; Esc or X hides it while the offer keeps its deadline.
// UndoToastHost mounts once, before <main> in DOM order (L4A, App.tsx), so the
// keyboard reaches Undo in a few Tabs.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { connectUndoHost, undoHost, useUndoToast, type UndoHold, type UndoHost, type UndoToastView } from "@/lib/undo";

export interface UndoToastProps {
  view: UndoToastView;
  onUndo: (id: number) => void;
  onAction: (id: number) => void;
  onDismiss: () => void;
  onHold?: (reason: UndoHold, on: boolean) => void;
}

const BUTTON = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 font-medium text-accent hover:bg-raised disabled:opacity-60";

/** The card itself: headline, Undo, the optional action, Dismiss, and any lines underneath. */
export function UndoToast({ view, onUndo, onAction, onDismiss, onHold }: UndoToastProps) {
  return (
    <div
      data-undo-toast=""
      className="fixed bottom-4 left-4 right-4 z-[60] rounded-xl border border-hairline/50 bg-card px-3.5 py-1.5 text-[13px] text-ink shadow-xl sm:right-auto sm:max-w-[300px]"
      onPointerEnter={() => onHold?.("pointer", true)}
      onPointerLeave={() => onHold?.("pointer", false)}
      onFocus={() => onHold?.("focus", true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHold?.("focus", false);
      }}
    >
      <div className="flex items-center gap-1">
        <span className="mr-1 min-w-0 flex-1">{view.message}</span>
        {(view.canUndo || view.undoing) && (
          <button
            type="button"
            onClick={() => onUndo(view.id)}
            disabled={view.undoing}
            aria-disabled={view.undoing || undefined}
            className={BUTTON}
          >
            {view.undoing ? t("ux.l5a.undoing") : t("ux.l5a.undo")}
          </button>
        )}
        {view.action && (
          <button type="button" onClick={() => onAction(view.id)} className={BUTTON}>
            {view.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("ux.l5a.dismiss")}
          title={t("ux.l5a.dismiss")}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {view.detail && <p className="mb-1 text-[12px] leading-snug text-ink-secondary">{view.detail}</p>}
      {view.extra.map((line) => (
        <p key={line.id} className="mb-1 text-[12px] leading-snug text-ink-secondary">
          {line.text}
        </p>
      ))}
    </div>
  );
}

/** Mount once, before <main>. Wires the page lifecycle and Cmd/Ctrl+Z and Esc to the host. */
export function UndoToastHost({ host = undoHost }: { host?: UndoHost }) {
  const view = useUndoToast(host);
  // Re-render on a language change: the copy comes from t().
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const region = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const hadFocus = useRef(false);

  const card = () => region.current?.querySelector("[data-undo-toast]") ?? null;

  useEffect(() => connectUndoHost(window, host, card), [host]);

  // Focus that was inside the toast goes back where it came from when the toast
  // closes (or when the button that held it goes away).
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    const active = document.activeElement;
    const node = card();
    if (node && active && node.contains(active)) return;
    if (active && active !== document.body) {
      hadFocus.current = false;
      return;
    }
    if (node) {
      node.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    hadFocus.current = false;
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) target.focus();
  });

  return (
    <div
      ref={region}
      role="status"
      aria-live="polite"
      onFocus={(event) => {
        if (!hadFocus.current) {
          const from = event.relatedTarget as HTMLElement | null;
          returnTo.current = from && !event.currentTarget.contains(from) ? from : null;
        }
        hadFocus.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
          hadFocus.current = false;
          returnTo.current = null;
        }
      }}
    >
      {view && (
        <UndoToast
          view={view}
          onUndo={(id) => host.undo(id)}
          onAction={(id) => host.runAction(id)}
          onDismiss={() => host.dismiss()}
          onHold={(reason, on) => host.setHold(reason, on)}
        />
      )}
    </div>
  );
}
