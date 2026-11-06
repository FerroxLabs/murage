// SPDX-License-Identifier: AGPL-3.0-or-later
// App settings > Storage (1.0.3): the free space on this computer and what
// Murage keeps. Opened from the composer's "Manage storage" when the disk is
// the reason an attachment was not saved.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { storageSummary, type StorageReport } from "@/lib/storage-summary";
import { Card } from "./SettingsPrimitives";
import { StorageList } from "./StorageList";

export function StorageSettings() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    (api("/api/storage") as Promise<StorageReport>)
      .then(setReport)
      .catch(() => setError("Storage details could not be loaded. Try again in a moment."));
  }, []);
  useEffect(load, [load]);
  const summary = report ? storageSummary(report) : null;
  return (
    <Card title="Storage" subtitle="How much room is left on this computer, and what Murage keeps.">
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      {!summary && !error && <p className="text-[13px] text-ink-secondary">Checking this disk...</p>}
      {summary && (
        <div className="flex flex-col gap-3 text-[13px]">
          <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5">
            <dt className="text-ink-secondary">Space left on this disk</dt>
            <dd className={summary.low ? "text-right tabular-nums text-warning" : "text-right tabular-nums text-ink"}>{summary.free}</dd>
            <dt className="text-ink-secondary">Attachments</dt>
            <dd className="text-right tabular-nums text-ink">{summary.attachments}</dd>
            <dt className="text-ink-secondary">Files</dt>
            <dd className="text-right tabular-nums text-ink">{summary.files}</dd>
          </dl>
          <p className={summary.low ? "text-warning" : "text-ink-secondary"}>{summary.next}</p>
          <div>
            <button type="button" onClick={load} className="rounded-md border border-hairline/60 px-2.5 py-1 text-[12.5px] text-ink">
              Check again
            </button>
          </div>
        </div>
      )}
      <div className="mt-4"><StorageList /></div>
    </Card>
  );
}
