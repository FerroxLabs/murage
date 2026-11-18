import { afterEach, expect, it } from "vitest";
import { setLocale, t } from "./i18n";
import { RESEND_OFFER_LINE } from "../../shared/resend-offer";
import { resendNoteLabel, toolBudgetLabel } from "./tool-budget-copy";
afterEach(async () => { await setLocale("en"); });
it.each(["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"])("C11 budget and submission copy uses locale %s", async locale => {
  await setLocale(locale);
  expect(toolBudgetLabel("Some tools were left out this turn: this AI accepts at most 40 tools.")).toBe(t("engine.toolLimit.notice", { limit: 40 }));
  expect(toolBudgetLabel("This AI accepts at most 16 tools, which is not enough for OpenCode to work in Murage. Choose another model.")).toBe(t("engine.toolLimit.noRoom", { limit: 16, engine: "OpenCode" }));
  expect(toolBudgetLabel("Murage could not confirm this AI's tool list. The message was not sent with an unverified tool budget.")).toBe(t("engine.toolLimit.catalogUnknown"));
  expect(toolBudgetLabel("Murage could not confirm this AI's tool list or the maximum number of tools it accepts. Your message was not sent.")).toBe(t("engine.toolLimit.catalogUnknown"));
  expect(toolBudgetLabel("The tool list changed while Murage was preparing this turn. Murage could not fit it within this AI's limit.")).toBe(t("engine.toolLimit.catalogChanged"));
  expect(toolBudgetLabel("The original message was submitted. Murage could not send it again because the submission checks failed. It was not automatically sent again.")).toBe(t("engine.submission.afterSubmission"));
  expect(toolBudgetLabel("The earlier submission may have started. Murage could not send it again because the submission checks failed. It was not automatically sent again.")).toBe(t("engine.submission.afterSubmissionUncertain"));
  expect(toolBudgetLabel("An unrelated provider error")).toBeUndefined();
  expect(toolBudgetLabel("Owner quoted: Some tools were left out this turn: this AI accepts at most 40 tools.")).toBeUndefined();
});
it.each(["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"])("M2: a resend row with no Send again button shows the uncertain copy (locale %s), with one the offer", async locale => {
  await setLocale(locale);
  expect(resendNoteLabel(RESEND_OFFER_LINE, false)).toBe(t("engine.submission.afterSubmissionUncertain"));
  expect(resendNoteLabel(RESEND_OFFER_LINE, true)).toBe(t("engine.submission.resendOffer"));
  expect(resendNoteLabel("An unrelated provider error", false)).toBe("An unrelated provider error");
});
