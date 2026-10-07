// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One plain line and a bar for the import check: "Checking 12 of 41 files…",
// from the real count the server reports, never a spinner that only spins.
import { t } from "@/lib/i18n";
import type { ImportScanProgress as Progress } from "@/lib/importScan";

export function ImportScanProgress({ progress }: { progress: Progress | null }) {
  const known = progress !== null && progress.filesTotal > 0;
  const fraction = known ? (progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : progress.filesDone / progress.filesTotal) : 0;
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return <div role="status" className="mt-3">
    <p className="text-[13px]">{known ? t("importGuard.progress", { done: progress.filesDone, total: progress.filesTotal }) : t("importGuard.starting")}</p>
    <div role="progressbar" aria-label={t("importGuard.progressBar")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-inset">
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
  </div>;
}
