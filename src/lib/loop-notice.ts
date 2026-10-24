// The renderer's reading of a loop row (shared/loop-notice.ts): the stored key is spelled in the person's language from
// the packs, English when a pack has not caught up.
import { t } from "@/lib/i18n";
import { loopNotice } from "../../shared/loop-notice.ts";

/** The words for a loop row's activity name; undefined for any other name. */
export function loopNoticeLabel(name: string | undefined | null): string | undefined {
  const notice = loopNotice(name);
  if (!notice) return undefined;
  return notice.code === "nudged" ? t("loopNotice.nudged") : t("loopNotice.repeat", { n: notice.count, call: notice.call });
}
