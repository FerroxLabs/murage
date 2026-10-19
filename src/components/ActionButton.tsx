// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The face of useAction (src/lib/use-action.ts): a button that disables and
// changes its label the moment it is pressed, and a status line beside it that
// says what happened. Use <ActionStatus> on its own for a control that is not
// a button (a select, a switch, an icon).
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

import type { UseAction } from "@/lib/use-action";

type Feedback = Pick<UseAction<never[], unknown>, "pending" | "slow" | "progress" | "message" | "fading" | "error" | "retry" | "dismiss">;

export function progressLine(progress: Feedback["progress"]): string {
  if (!progress) return "";
  const percent = typeof progress.percent === "number" ? `${Math.max(0, Math.min(100, Math.round(progress.percent)))}%` : "";
  return [progress.text, percent].filter(Boolean).join(" ");
}

/**
 * The lines next to a control. The wrapper is always rendered so a screen
 * reader hears the line when it appears; a failure is announced as an alert.
 * `slowHint` is the sentence shown after the action has run for a while.
 */
export function ActionStatus({ action, slowHint = "Still working. This can take a moment.", className = "" }: { action: Feedback; slowHint?: string; className?: string }) {
  const progress = progressLine(action.progress);
  return (
    <div aria-live="polite" className={`min-w-0 text-[13px] ${className}`} data-action-status>
      {action.pending && progress && (
        <p className="flex items-center gap-2 text-ink-secondary" data-action-progress>
          <span>{progress}</span>
          {typeof action.progress?.percent === "number" && (
            <span className="h-1 w-24 overflow-hidden rounded bg-control" aria-hidden="true">
              <span className="block h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, action.progress.percent))}%` }} />
            </span>
          )}
        </p>
      )}
      {action.pending && action.slow && !progress && <p className="text-ink-secondary" data-action-slow>{slowHint}</p>}
      {action.message && !action.pending && (
        <p className={`text-success transition-opacity duration-500 ${action.fading ? "opacity-0" : "opacity-100"}`} data-action-success>{action.message}</p>
      )}
      {action.error && !action.pending && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-danger" data-action-error>
          <span>{action.error}</span>
          <button type="button" className="rounded px-1 underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { void action.retry(); }}>Retry</button>
        </p>
      )}
    </div>
  );
}

export interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> {
  action: UseAction<never[], unknown>;
  /** the idle label; falls back to the hook's `idle` option */
  children?: ReactNode;
  slowHint?: string;
  /** where the status line goes; "below" stacks it under the button */
  layout?: "beside" | "below";
  /** extra disabling from the caller (the button is always disabled while pending) */
  blocked?: boolean;
}

export function ActionButton({ action, children, slowHint, layout = "beside", blocked = false, className = "", type = "button", ...rest }: ActionButtonProps) {
  const label = action.pending ? action.label || children : children ?? action.label;
  return (
    <span className={`inline-flex min-w-0 gap-2 ${layout === "below" ? "flex-col items-start" : "flex-wrap items-center"}`}>
      <button
        {...rest}
        type={type}
        className={className}
        disabled={rest.disabled || blocked || action.pending}
        aria-busy={action.pending}
        onClick={() => { void (action.run as () => Promise<unknown>)(); }}
      >
        {action.pending && <Loader2 size={13} className="mr-1.5 inline animate-spin" aria-hidden="true" />}
        {label}
      </button>
      <ActionStatus action={action} slowHint={slowHint} />
    </span>
  );
}
