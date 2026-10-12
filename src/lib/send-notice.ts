// The renderer's reading of a send notice (shared/send-notice.ts): the stored
// code is spelled in the person's language from the packs, English when a pack
// has not caught up.
import { t } from "@/lib/i18n";
import { isSendNoticeCode, sendNoticeCode, type SendNoticeCode } from "../../shared/send-notice.ts";

export { sendNoticeCode };

export function sendNoticeText(code: SendNoticeCode): string {
  return t(`sendNotice.${code}`);
}

/** The words for a notice line's activity name; undefined for any other name. */
export function sendNoticeLabel(name: string | undefined | null): string | undefined {
  const code = sendNoticeCode(name);
  return code ? sendNoticeText(code) : undefined;
}

/** The words for a code a refused request carried in its body, if it carried one. */
export function sendNoticeFromBody(body: unknown): string | undefined {
  const code = (body as { noticeCode?: unknown } | null | undefined)?.noticeCode;
  return isSendNoticeCode(code) ? sendNoticeText(code) : undefined;
}
