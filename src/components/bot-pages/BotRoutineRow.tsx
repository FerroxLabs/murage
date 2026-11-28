// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B7: one routine on the bot's Routines page, with its own switch drawn in its true state.
import type { Routine } from "@/lib/routines";
import { useState } from "react";
import { api } from "@/state/store";
import { Switch } from "../SettingsPrimitives";

export function routineToggleRequest(routine: Pick<Routine, "id" | "enabled">): { path: string; body: { enabled: boolean } } {
  return { path: `/api/routines/${encodeURIComponent(routine.id)}`, body: { enabled: !routine.enabled } };
}

export function BotRoutineRow({ routine, onSaved }: { routine: Pick<Routine, "id" | "name" | "enabled">; onSaved?: (routine: Routine) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    const request = routineToggleRequest(routine);
    setBusy(true);
    setError(null);
    try {
      const response = await api(request.path, { method: "PATCH", body: JSON.stringify(request.body) });
      if (response?.routine) onSaved?.(response.routine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Not saved");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id={`bot-routine-${routine.id}`} data-routine-id={routine.id} className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-medium">{routine.name}</p>
          <p className="mt-1 text-[12px] text-ink-secondary">{routine.enabled ? "On" : "Off. It does not run until you turn it on."}</p>
        </div>
        <Switch checked={routine.enabled} disabled={busy} aria-label={`${routine.name} runs`} onClick={() => void toggle()} />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-ink-secondary">Not saved: {error}</p> : null}
    </div>
  );
}
