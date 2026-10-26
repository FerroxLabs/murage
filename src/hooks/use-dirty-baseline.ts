// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// "Has the person edited this form?" for every field in it, not a chosen few.
// The baseline is taken one tick after the form opens, so a field the form
// fills in on its own while it settles does not count as an edit.
import { useCallback, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";

/** True when any field differs from the baseline (deep compare of plain values). */
export function fieldsChanged(current: Record<string, unknown>, baseline: Record<string, unknown> | null): boolean {
  if (!baseline) return false;
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const key of keys) {
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(baseline[key] ?? null)) return true;
  }
  return false;
}

/** Ask before throwing edits away. */
export function confirmDiscard(): boolean {
  return window.confirm(t("modal.discardChanges"));
}

export function useDirtyBaseline(snapshot: Record<string, unknown>): {
  isDirty: () => boolean;
  /** Close through this: it asks first when there are unsaved edits. */
  closeWithAsk: (close: () => void) => void;
} {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const baseline = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const id = setTimeout(() => { baseline.current = latest.current; }, 0);
    return () => clearTimeout(id);
  }, []);
  const isDirty = useCallback(() => fieldsChanged(latest.current, baseline.current), []);
  const closeWithAsk = useCallback((close: () => void) => {
    if (isDirty() && !confirmDiscard()) return;
    close();
  }, [isDirty]);
  return { isDirty, closeWithAsk };
}
