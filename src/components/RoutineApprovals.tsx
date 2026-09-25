// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The routine editor's approval settings: the level this routine's runs are
// judged at (its bot's own level unless the owner picks one here), and the
// approvals "Always allow for this routine" remembered, each removable. The
// server decides what each covers (server/routine-permissions.ts); this only
// shows it. Writing either is the desktop app's alone, like every routine edit.
import { useState } from "react";
import { api, useStore } from "@/state/store";
import { describeGrant } from "@/lib/remembered-grants";
import { PERMISSION_MODES } from "./PermissionModeMenu";
import type { PermissionMode } from "@/lib/permission-mode";
import type { Routine } from "@/lib/routines";

export type RoutineLevelChoice = PermissionMode | "inherit";

export function routineLevelHelp(choice: RoutineLevelChoice, botName: string, botMode: PermissionMode): string {
  const chip = (mode: PermissionMode) => PERMISSION_MODES.find((entry) => entry.mode === mode)!.chip;
  if (choice === "inherit") return `Runs use ${botName}'s level when they start, now ${chip(botMode)}.`;
  const detail = PERMISSION_MODES.find((entry) => entry.mode === choice)!.detail;
  return `Every run of this routine: ${detail.charAt(0).toLowerCase()}${detail.slice(1).replace(/\.$/, "")}.`;
}

export function RoutineApprovalLevel({
  value,
  onChange,
  botName,
  botMode,
}: {
  value: RoutineLevelChoice;
  onChange: (value: RoutineLevelChoice) => void;
  botName: string;
  botMode: PermissionMode;
}) {
  const chip = PERMISSION_MODES.find((entry) => entry.mode === botMode)!.chip;
  return (
    <div>
      <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
        <span>Approvals for this routine</span>
        <select
          aria-label="Approvals for this routine"
          value={value}
          onChange={(event) => onChange(event.target.value as RoutineLevelChoice)}
          className="rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent"
        >
          <option value="inherit">Same as {botName} ({chip})</option>
          {PERMISSION_MODES.map((entry) => <option key={entry.mode} value={entry.mode}>{entry.label}</option>)}
        </select>
      </label>
      <div className="mt-1.5 text-[10.5px] leading-relaxed text-ink-secondary">{routineLevelHelp(value, botName, botMode)} Reading your keys always asks.</div>
    </div>
  );
}

export function RoutineGrants({ routine }: { routine: Pick<Routine, "id" | "alwaysAllow"> }) {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = routine.alwaysAllow ?? [];

  const remove = async (key: string) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const response = await api(`/api/routines/${encodeURIComponent(routine.id)}/always-allow/remove`, { method: "POST", body: JSON.stringify({ key }) });
      if (response?.routine) dispatch({ type: "routinePatched", routine: response.routine });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove it. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Always allowed for this routine" className="mt-3">
      <div className="text-[12px] text-ink">Always allowed for this routine</div>
      <div className="mt-0.5 text-[10.5px] leading-relaxed text-ink-secondary">
        {keys.length
          ? "Runs of this routine do these without asking. Reading your keys still asks."
          : "Nothing yet. Choose Always allow for this routine on an approval from one of its runs."}
      </div>
      {error && <div role="alert" className="mt-1.5 text-[11px] text-danger">{error}</div>}
      {keys.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {keys.map((key) => {
            const grant = describeGrant(key, state.instances);
            const label = grant.kind === "exact" ? grant.command : grant.text;
            return (
              <li key={key} data-routine-grant={grant.kind} className="flex items-start justify-between gap-3 rounded-lg bg-panel px-3 py-2">
                <div className="min-w-0 flex-1">
                  {grant.kind === "exact" ? (
                    <>
                      <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">{grant.command}</pre>
                      <div className="mt-0.5 break-words text-[11px] text-ink-secondary">In <span className="font-mono">{grant.folder}</span> · {grant.engine}</div>
                    </>
                  ) : (
                    <div className="break-words text-[12px] text-ink">{grant.text}</div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void remove(key)}
                  aria-label={`Remove always allow for ${label}`}
                  className="min-h-7 shrink-0 rounded-lg px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
                >
                  {busy === key ? "Removing…" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
