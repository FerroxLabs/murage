import { GlobeLock } from "lucide-react";
import { t } from "@/lib/i18n";
import { browserUnavailableKind } from "../../shared/browser-unavailable";

const SUMMARY_KEY = {
  "user-chrome": "browserUnavailable.userChrome",
  "user-chrome-allow": "browserUnavailable.userChromeAllow",
  held: "browserUnavailable.held",
  "timed-out": "browserUnavailable.timedOut",
  failed: "browserUnavailable.failed",
} as const;

/** A turn that ran without the built-in browser, said in plain words, with
 * the engine's own reason one click away. Neutral, like FolderTrustRow: not a
 * tool run (so it stays visible with Settings → Tool calls off) and not an
 * error — the turn itself went ahead.
 *
 * Wrapping is ordinary word wrapping; `overflow-wrap: anywhere` breaks only a
 * token too long for the line (a URL, an error code). The tool chips' shared
 * `break-all` split plain words mid-word on a 390px phone. */
export function BrowserUnavailableRow({ reason }: { reason: string }) {
  const kind = browserUnavailableKind(reason);
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="browser-unavailable-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[3px] shrink-0" aria-hidden="true"><GlobeLock size={12} className="opacity-70" /></span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <span>{t(SUMMARY_KEY[kind])}</span>
          {kind !== "user-chrome" && kind !== "user-chrome-allow" && kind !== "held" && (
            <details className="mt-0.5 text-[12px]">
              <summary className="cursor-pointer select-none">{t("browserUnavailable.details")}</summary>
              <span className="font-mono">{reason}</span>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
