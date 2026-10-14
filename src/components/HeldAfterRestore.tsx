// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Backups: what a restore kept for the owner. Each item has a Release button; nothing else posts it.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

export interface HeldRestoreItem { id: string; generation: string; bot: string; conversation: string; preview: string; at: number }
export interface HeldRestoreList { restoreGen: string | null; outputs: HeldRestoreItem[]; sharedResults: HeldRestoreItem[] }
type Kind = "output_receipt" | "shared_result";
export interface HeldRow extends HeldRestoreItem { kind: Kind }

/** Both lists as one, oldest first, each row knowing which release route it uses. */
export function heldRows(list: HeldRestoreList | null | undefined): HeldRow[] {
  if (!list) return [];
  return [...list.outputs.map((item): HeldRow => ({ ...item, kind: "output_receipt" })), ...list.sharedResults.map((item): HeldRow => ({ ...item, kind: "shared_result" }))]
    .sort((a, b) => a.at - b.at);
}

const labelOf = (row: HeldRow) => [row.bot, row.conversation].filter(Boolean).join(" / ");
const whenOf = (at: number) => { try { return new Date(at).toLocaleString(); } catch { return ""; } };

/** The list itself. Renders nothing when nothing is held. */
export function HeldAfterRestoreView({ list, busyId, error, onRelease }: { list: HeldRestoreList | null; busyId?: string | null; error?: string | null; onRelease: (row: HeldRow) => void }) {
  const rows = heldRows(list);
  if (rows.length === 0) return null;
  return <section data-held-after-restore className="min-w-0 space-y-3 border-t border-hairline/40 pt-3" aria-labelledby="held-after-restore-title">
    <h4 id="held-after-restore-title" className="text-[13px] font-medium text-ink">{t("restoreHolds.title")}</h4>
    <p className="text-[12px] text-ink-secondary">{t("restoreHolds.intro")}</p>
    <ul className="space-y-2">
      {rows.map(row => {
        const what = labelOf(row) || (row.kind === "output_receipt" ? t("restoreHolds.output") : t("restoreHolds.shared"));
        return <li key={`${row.kind}:${row.id}`} data-held-item={row.kind} className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] text-ink">{what}</p>
            <p className="text-[12px] text-ink-secondary">{row.kind === "output_receipt" ? t("restoreHolds.output") : t("restoreHolds.shared")}{" · "}{whenOf(row.at)}</p>
            <p className="truncate text-[12px] text-ink-secondary">{row.preview || t("restoreHolds.noPreview")}</p>
          </div>
          <button type="button" className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[12px] text-ink disabled:opacity-50" disabled={busyId === row.id} aria-label={t("restoreHolds.releaseFor", { what })} onClick={() => onRelease(row)}>
            {busyId === row.id ? t("restoreHolds.releasing") : t("restoreHolds.release")}
          </button>
        </li>;
      })}
    </ul>
    {error && <p role="status" className="text-[12px] text-ink-secondary">{error}</p>}
  </section>;
}

/** Loads the held list and releases one item at a time, carrying the restore generation the list came with. */
export function HeldAfterRestore() {
  const [list, setList] = useState<HeldRestoreList | null>(null), [busyId, setBusyId] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList(await api("/api/restore-holds") as HeldRestoreList); } catch { /* the list stays as it was */ } }, []);
  useEffect(() => { void load(); }, [load]);
  const release = async (row: HeldRow) => {
    setBusyId(row.id); setError(null);
    try {
      await api(`/api/restore-holds/${row.kind}/${encodeURIComponent(row.id)}/release`, { method: "POST", body: JSON.stringify({ restoreGen: list?.restoreGen ?? "" }) });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(t(status === 409 ? "restoreHolds.refreshed" : "restoreHolds.failed"));
    } finally { setBusyId(null); await load(); }
  };
  return <HeldAfterRestoreView list={list} busyId={busyId} error={error} onRelease={row => void release(row)} />;
}
