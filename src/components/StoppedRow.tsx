import { Square } from "lucide-react";
import { t } from "@/lib/i18n";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";

/** A turn the host stopped on its own — the bot's model connection was
 * changed or turned off, or this computer was switched off for it — and
 * why. The same quiet family as the stopped state a person's own Stop
 * leaves (no error card, no Retry, the composer ready), with the reason
 * spelled out because nobody pressed anything (STOP2). Not a tool run, so
 * it stays in a 1:1 thread with Settings → Tool calls off. */
export function StoppedRow({ reason }: { reason: string }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="stopped-row"
        title={t("hostStop.description")}
        className={`${CHIP} text-ink-secondary`}
      >
        <span className="shrink-0" aria-hidden="true">
          <Square size={11} className="fill-current opacity-70" />
        </span>
        <span className={CHIP_NAME}>{t("hostStop.label", { reason })}</span>
      </div>
    </div>
  );
}

/** A stop the person made while a desktop action was already running on
 * their screen (server/host-computer-broker.ts withdrew it). The action may
 * still have finished, so the line says to look before retrying. */
export function StoppedMidActionRow() {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="stopped-mid-action-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[4px] shrink-0" aria-hidden="true">
          <Square size={11} className="fill-current opacity-70" />
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{t("hostStop.midDesktopAction")}</span>
      </div>
    </div>
  );
}
