// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Routines this version of Murage could not read (a schedule or a file watch
// it does not understand). They are kept as they were stored and never run.
// Shown here so the person can see them and delete one, instead of finding
// out from a log.
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Trash2 } from "lucide-react";
import { api } from "@/state/store";
import { unloadableFromResponse, unloadableRoutineNote, type UnloadableRoutine } from "@/lib/unloadable-routines";

export function UnloadableRoutines({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<UnloadableRoutine[]>([]);
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    const now = Date.now();
    try { setItems(unloadableFromResponse(await api(`/api/routines?from=${now}&to=${now}`))); } catch { /* keep what is shown */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!items.length) return null;
  const remove = async (item: UnloadableRoutine) => {
    if (!window.confirm(`Delete "${item.name || "this routine"}"? This cannot be undone.`)) return;
    try {
      await api(`/api/routines/${item.id}`, { method: "DELETE" });
      setProblem("");
      await load();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "The routine could not be deleted. Try again.");
    }
  };
  return (
    <section data-testid="unloadable-routines" className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-[11.5px] text-ink">
            <CircleAlert size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{item.name || "A routine"}</span>
              <span className="text-ink-secondary">{" "}{unloadableRoutineNote(item.reason)}</span>
            </span>
            {canEdit && (
              <button type="button" onClick={() => void remove(item)} aria-label={`Delete ${item.name || "routine"}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-danger hover:bg-danger/10">
                <Trash2 size={11} aria-hidden />Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {problem && <p role="status" className="mt-1.5 text-[11px] text-danger">{problem}</p>}
    </section>
  );
}
