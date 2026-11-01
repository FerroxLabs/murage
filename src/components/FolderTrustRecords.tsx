import { t } from "@/lib/i18n";
import type { FolderTrustRecordRow, FolderTrustResult, FolderTrustStatus } from "./FolderTrustNote";

/** Every home the note's bots read from: a room's members can run on different
 * Fuigo installs. Routed and Cloud turns have no store and add nothing. */
function ownStores(results: FolderTrustResult[]): FolderTrustStatus[] {
  const seen = new Set<string>();
  return results
    .map((result) => result.status)
    .filter((status) => {
      const file = status.upstreamTrustFile;
      if (status.upstreamStore !== "own" || !file || seen.has(file)) return false;
      seen.add(file);
      return true;
    });
}

/** What a row's state reads. An unstamped trust only asks once more on an
 * engine that gates by consent; an older engine still honours it. */
function rowState(row: FolderTrustRecordRow, generation: FolderTrustStatus["trustGeneration"]): string {
  if (row.decision === "reject") return t("folderTrust.rowRejected");
  return row.consent !== 2 && generation === 2 ? t("folderTrust.rowUnstamped") : t("folderTrust.rowTrusted");
}

/** Said beside the button, so the owner reads it before acting. Only a consent 2
 * trust reached the engine, so only that row names a line in its file. */
function forgetLine(row: FolderTrustRecordRow, files: string[]): string {
  if (row.decision === "reject") return t("folderTrust.forgetReject");
  if (row.consent === 2 && files.length) return t("folderTrust.forgetTrustOwn", { key: row.key, path: files.join(", ") });
  return t("folderTrust.forgetTrust");
}

function RecordRow({ row, generation, files, busy, onForgetKey }: {
  row: FolderTrustRecordRow;
  generation: FolderTrustStatus["trustGeneration"];
  files: string[];
  busy: boolean;
  onForgetKey: (key: string) => void;
}) {
  return (
    <li data-testid="folder-trust-record" data-folder-trust-key={row.key} className="break-all">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11.5px]">{row.key}</span>
        <span data-testid="folder-trust-record-state">{rowState(row, generation)}</span>
        <button
          type="button"
          onClick={() => onForgetKey(row.key)}
          disabled={busy}
          aria-label={t("folderTrust.forgetKey", { key: row.key })}
          data-testid="folder-trust-record-forget"
          className="rounded-md px-1.5 py-0.5 text-[12px] text-ink underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t("folderTrust.forget")}
        </button>
      </div>
      {row.folder !== row.key && <div data-testid="folder-trust-record-folder">{t("folderTrust.decidedIn", { folder: row.folder })}</div>}
      <div data-testid="folder-trust-record-forget-line">{forgetLine(row, files)}</div>
    </li>
  );
}

/** "Folders you decided on" (S6): every stored decision with a Forget by its
 * exact key, the ones on this folder's path open and the rest behind a
 * disclosure, then what the engine's own trust file says for itself. */
export function FolderTrustRecords({ results, busy, onForgetKey }: {
  results: FolderTrustResult[];
  busy: boolean;
  onForgetKey: (key: string) => void;
}) {
  const first = results[0]?.status;
  const records = first?.records ?? [];
  const generation = results.find((result) => result.status.trustGeneration === 2)?.status.trustGeneration ?? first?.trustGeneration;
  const stores = ownStores(results);
  const files = stores.map((status) => status.upstreamTrustFile as string);
  const near = records.filter((row) => row.onPath);
  const other = records.filter((row) => !row.onPath);
  const row = (record: FolderTrustRecordRow) => <RecordRow key={record.key} row={record} generation={generation} files={files} busy={busy} onForgetKey={onForgetKey} />;
  const storedNo = stores.flatMap((status) => (status.upstreamDeclines ?? []).map((key) => ({ key, path: status.upstreamTrustFile as string })));
  const unreadable = stores.filter((status) => status.upstreamUnreadable);
  if (!records.length && !storedNo.length && !unreadable.length) return null;
  return (
    <div className="mt-2" data-testid="folder-trust-records">
      {records.length > 0 && <div className="font-medium">{t("folderTrust.decidedHeading")}</div>}
      {near.length > 0 && <ul className="mt-0.5 flex flex-col gap-1">{near.map(row)}</ul>}
      {other.length > 0 && (
        <details className="mt-1" data-testid="folder-trust-other">
          <summary className="cursor-pointer">{other.length === 1 ? t("folderTrust.otherFolder") : t("folderTrust.otherFolders", { n: other.length })}</summary>
          <ul className="mt-0.5 flex flex-col gap-1">{other.map(row)}</ul>
          <div className="mt-0.5">{t("folderTrust.otherFoldersNote")}</div>
        </details>
      )}
      {storedNo.map(({ key, path }) => (
        <div key={`${path}\n${key}`} className="mt-1 break-all" data-testid="folder-trust-stored-no">{t("folderTrust.storedNo", { key, path })}</div>
      ))}
      {unreadable.map((status) => (
        <div key={status.upstreamTrustFile} className="mt-1 break-all" data-testid="folder-trust-unreadable">{t("folderTrust.unreadable", { path: status.upstreamTrustFile as string })}</div>
      ))}
    </div>
  );
}
