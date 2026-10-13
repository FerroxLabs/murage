import { Info } from "lucide-react";
import { sendNoticeText } from "@/lib/send-notice";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";
import type { SendNoticeCode } from "../../shared/send-notice";

/** What happened to a message the person sent (shared/send-notice.ts): spelled in their
 * language from the packs. Quiet like a stopped turn: not a tool run (so it shows with
 * Tool calls off) and not an error card. */
export function SendNoticeRow({ code }: { code: SendNoticeCode }) {
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="send-notice-row" className={`${CHIP} text-ink-secondary`}>
        <span className="shrink-0" aria-hidden="true">
          <Info size={11} className="opacity-70" />
        </span>
        <span className={CHIP_NAME}>{sendNoticeText(code)}</span>
      </div>
    </div>
  );
}
