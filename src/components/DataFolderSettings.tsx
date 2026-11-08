// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Data folder (S5-DATADIR-PATHS r4.1 DR7). One row per linked data root ONLY while it is "changed": the folder's new
// location and "Use this folder". Nothing shows on an unchanged setup (works by default).
import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export type DataRootName = "workspaces" | "providers";
export interface DataRootRow { name: DataRootName; state: string; candidate?: string }

/** The rows to show: a root in state "changed" with a candidate location. */
export const changedDataRoots = (rows: readonly DataRootRow[] | null | undefined): DataRootRow[] =>
  (rows ?? []).filter((row) => row.state === "changed" && typeof row.candidate === "string" && row.candidate.length > 0);

export function DataFolderView({ rows, busy, message, onUse }: { rows: readonly DataRootRow[]; busy?: DataRootName; message?: string; onUse: (name: DataRootName) => void }) {
  const shown = changedDataRoots(rows);
  if (!shown.length && !message) return null;
  return (
    <div data-testid="data-folder-settings">
      <Card title={t("settings.dataFolder.title")} subtitle={t("settings.dataFolder.subtitle")}>
        {message && <p role="alert" className="text-[13px] text-warning">{message}</p>}
        <ul className="flex flex-col gap-3 text-[13px]">
          {shown.map((row) => (
            <li key={row.name} data-root={row.name} className="flex min-w-0 flex-col gap-1.5">
              <span className="text-ink">{t(row.name === "providers" ? "settings.dataFolder.row.providers" : "settings.dataFolder.row.workspaces")}</span>
              <span className="text-ink-secondary">{t("settings.dataFolder.location")}</span>
              <code className="break-all text-[12.5px] text-ink">{row.candidate}</code>
              <div>
                <button type="button" disabled={busy !== undefined} onClick={() => onUse(row.name)} className="min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
                  {t("settings.dataFolder.use")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function DataFolderSettings() {
  const [rows, setRows] = useState<DataRootRow[]>([]);
  const [busy, setBusy] = useState<DataRootName | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const load = useCallback(() => {
    (api("/api/data-dir/roots") as Promise<DataRootRow[]>).then((next) => setRows(Array.isArray(next) ? next : [])).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);
  const use = useCallback((name: DataRootName) => {
    setBusy(name); setMessage(undefined);
    (api("/api/data-dir/confirm-root", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }) as Promise<{ state: string }>)
      .then(() => load())
      .catch((error: { status?: number; body?: { restart?: boolean } }) => setMessage(error?.body?.restart ? t("settings.dataFolder.restart") : t("settings.dataFolder.error")))
      .finally(() => { setBusy(undefined); load(); });
  }, [load]);
  return <DataFolderView rows={rows} busy={busy} message={message} onUse={use} />;
}
