// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-LOCKED-1019.md 4.1: the one row every screen uses to say where an engine stands (Settings > Engines, a bot's
// Model card, the picker, Needs you, first run, the NoEngines wall). It reads a `routeState` result and draws it: the
// engine's name, one plain line, and the one fix as a button named for what it does ("Sign in to use Codex"). A route
// that cannot be picked is never a disabled row: its fix is a button. Status is a word, never only a colour (UX bar 4).
import type { ReactNode } from "react";
import type { RouteFixAction, RouteState, RouteTone } from "@/lib/route-state";

const TONE_TEXT: Record<RouteTone, string> = {
  ready: "text-success",
  warning: "text-warning",
  blocked: "text-danger",
  muted: "text-ink-secondary",
};

export interface EngineRowProps {
  /** The engine's name as people read it. */
  name: string;
  state: RouteState;
  /** Runs the fix. Required: a route that cannot be picked always shows its button. A surface that cannot run the fix
   *  (the phone) passes a handler that says where to do it ("Sign in on your computer"), never no button. */
  onFix: (action: RouteFixAction) => void;
  /** The fix is busy (a sign-in is running): the button says so to assistive tech and ignores presses. */
  busy?: boolean;
  /** Something after the line: the model, the account label, Hide, Disable. */
  children?: ReactNode;
  className?: string;
}

export function EngineRow({ name, state, onFix, busy = false, children, className }: EngineRowProps) {
  const { fix } = state;
  return (
    <div
      data-engine-row={name}
      data-route-state={state.state}
      data-route-tone={state.tone}
      data-selectable={state.selectable ? "true" : "false"}
      className={["flex flex-wrap items-center gap-x-3 gap-y-1", className].filter(Boolean).join(" ")}
    >
      <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={name}>{name}</span>
      <span role="status" data-route-line className={`min-w-0 flex-1 basis-full text-[12px] sm:basis-48 ${TONE_TEXT[state.tone]}`}>{state.line}</span>
      {fix && (
        <button
          type="button"
          data-route-fix={fix.action}
          aria-label={fix.name}
          aria-busy={busy || undefined}
          onClick={() => { if (!busy) onFix(fix.action); }}
          className="min-h-8 shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px] text-ink hover:bg-control/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
        >
          {fix.label}
        </button>
      )}
      {children}
    </div>
  );
}
