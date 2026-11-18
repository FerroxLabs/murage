import { t } from "./i18n";
import { RESEND_OFFER_LINE } from "../../shared/resend-offer";

/** M2: the line a resend row shows. With no Send again button (nothing safe to resend) the offer wording would promise a button that is not there,
 * so the row says the earlier submission may have started instead. */
export function resendNoteLabel(text: string, hasAction: boolean): string {
  if (text === RESEND_OFFER_LINE && !hasAction) return t("engine.submission.afterSubmissionUncertain");
  return toolBudgetLabel(text) ?? text;
}

/** Match only Murage's complete stored notice/error sentences, never model prose. */
export function toolBudgetLabel(text: string): string | undefined {
  const notice = /^Some tools were left out this turn: this AI accepts at most (\d+) tools\.$/.exec(text);
  if (notice) return t("engine.toolLimit.notice", { limit: notice[1] });
  const noRoom = /^This AI accepts at most (\d+) tools, which is not enough for (.+) to work in Murage\. Choose another model\.$/.exec(text);
  if (noRoom) return t("engine.toolLimit.noRoom", { limit: noRoom[1], engine: noRoom[2] });
  if (text === "Murage could not confirm this AI's tool list or the maximum number of tools it accepts. Your message was not sent." || text === "Murage could not confirm this AI's tool list. The message was not sent with an unverified tool budget.") return t("engine.toolLimit.catalogUnknown");
  if (text === "The tool list changed while Murage was preparing this turn. Murage could not fit it within this AI's limit.") return t("engine.toolLimit.catalogChanged");
  if (text === RESEND_OFFER_LINE) return t("engine.submission.resendOffer");
  if (text === "The original message was submitted. Murage could not send it again because the submission checks failed. It was not automatically sent again.") return t("engine.submission.afterSubmission");
  if (text === "The earlier submission may have started. Murage could not send it again because the submission checks failed. It was not automatically sent again.") return t("engine.submission.afterSubmissionUncertain");
}
