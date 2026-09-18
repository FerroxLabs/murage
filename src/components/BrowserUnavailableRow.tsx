import { GlobeLock } from "lucide-react";
import { t } from "@/lib/i18n";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";

/** A turn that ran without the built-in browser because it could not be
 * started, and the short reason. Neutral, like FolderTrustRow: not a tool run
 * (so it stays visible with Settings → Tool calls off) and not an error — the
 * turn itself went ahead. */
export function BrowserUnavailableRow({ reason }: { reason: string }) {
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="browser-unavailable-row" title={t("browserUnavailable.description")} className={`${CHIP} text-ink-secondary`}>
        <span className="shrink-0" aria-hidden="true"><GlobeLock size={12} className="opacity-70" /></span>
        <span className={CHIP_NAME}>{t("browserUnavailable.label", { reason })}</span>
      </div>
    </div>
  );
}
