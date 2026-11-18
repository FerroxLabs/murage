// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boot tolerance D2 (docs/designs/boot-tolerance/ACCEPTANCE.md): the Inbox line for a nearly full disk. `read-only` is a start that opened read-only (the
// owner restarts after freeing space; the button is the existing relaunch action) and `refusing` is the runtime floor, which clears by itself.
import { useState } from "react";
import { t } from "@/lib/i18n";

export interface DiskLow { mode: "read-only" | "refusing"; since?: number }

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

export function DiskLowCard({ diskLow }: { diskLow: DiskLow }) {
  const [restartFailed, setRestartFailed] = useState(false);
  const readOnly = diskLow.mode === "read-only";
  const restart = () => {
    const relaunch = window.muragebox?.restartForFluxKey;
    if (!relaunch) { setRestartFailed(true); return; }
    void relaunch().catch(() => setRestartFailed(true));
  };
  return <section aria-labelledby="inbox-section-disk-low" className="mt-5 first:mt-0">
    <h2 id="inbox-section-disk-low" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{t("ux.l2b.disk.section")}</h2>
    <div role="status" data-disk-low={diskLow.mode} className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
      <p className="text-ink">{readOnly ? t("ux.l2b.disk.readOnly") : t("ux.l2b.disk.refusing")}</p>
      {readOnly && <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={restart}>{t("ux.l2b.disk.restart")}</button>
      </div>}
      {readOnly && restartFailed && <p role="alert" className="mt-2 text-ink-secondary">{t("ux.l2b.disk.restartFallback")}</p>}
    </div>
  </section>;
}
