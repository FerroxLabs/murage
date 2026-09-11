import { useEffect, useState } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";

interface FolderTrustStatus {
  gated: boolean;
  sources: string[];
  record: { decision: "trust" | "reject"; decidedAt: number; source: "picker" | "card" } | null;
}

/** The one line under a working-folder picker (FUIGOTRUST1): a folder chosen
 * here is trusted — its AGENTS.md, CLAUDE.md, .mcp.json and skills apply —
 * and, for the folder currently set, what Murage remembers about it with a
 * way to forget it (the next turn there asks again). Reads the record
 * through GET /api/folder-trust; a folder with nothing to trust says so. */
export function FolderTrustNote({ folder }: { folder: string | undefined }) {
  const [status, setStatus] = useState<FolderTrustStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setError(null);
    if (!folder) return;
    api(`/api/folder-trust?folder=${encodeURIComponent(folder)}`)
      .then((result: FolderTrustStatus) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        /* the note is advisory; a failed read shows only the sentence */
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  const forget = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/folder-trust?folder=${encodeURIComponent(folder)}`, { method: "DELETE" });
      setStatus((current) => (current ? { ...current, record: null } : current));
    } catch {
      setError(t("folderTrust.forgetError"));
    } finally {
      setBusy(false);
    }
  };

  const record = status?.record ?? null;
  const statusLabel = !status || !folder
    ? null
    : !status.gated || (!status.sources.length && !record)
      ? t("folderTrust.statusNothing")
      : record
        ? record.decision === "trust" ? t("folderTrust.statusTrusted") : t("folderTrust.statusUntrusted")
        : t("folderTrust.statusUndecided");

  return (
    <div className="mt-2 text-[12px] text-ink-secondary" data-testid="folder-trust-note">
      <div>{t("folderTrust.pickerNote")}</div>
      {statusLabel && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5" data-folder-trust-status={record?.decision ?? (status?.gated ? "undecided" : "none")}>
          <span className="inline-flex items-center gap-1">
            {record?.decision === "reject" ? <ShieldOff size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
            {statusLabel}
          </span>
          {status?.sources.length ? <span className="font-mono text-[11.5px]">{status.sources.join(", ")}</span> : null}
          {record && (
            <button
              type="button"
              onClick={() => void forget()}
              disabled={busy}
              className="rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
            >
              {t("folderTrust.forget")}
            </button>
          )}
        </div>
      )}
      {error && <div className="mt-1 text-danger">{error}</div>}
    </div>
  );
}
