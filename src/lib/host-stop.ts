// The renderer's reading of a host-stop notice (shared/host-stop.ts): the
// transcripts render it as StoppedRow, and every one-line surface (sidebar
// preview, timeline) spells it "Stopped — why" rather than the raw prefix.
import { t } from "@/lib/i18n";
import { hostStoppedReason } from "../../shared/host-stop.ts";

export { hostStoppedReason };

/** "Stopped — <reason>" for a host-stop notice; undefined for any other
 * activity name. */
export function hostStoppedLabel(name: string | undefined | null): string | undefined {
  const reason = hostStoppedReason(name);
  return reason ? t("hostStop.label", { reason }) : undefined;
}
