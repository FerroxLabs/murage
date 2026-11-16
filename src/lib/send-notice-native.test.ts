import { afterEach, expect, it } from "vitest";
import { localeLoaders } from "@/locales";
import { setLocale } from "./i18n";
import { sendNoticeFromBody, sendNoticeLabel } from "./send-notice";
import { SEND_NOTICE_ENGLISH, sendNoticeActivityName } from "../../shared/send-notice.ts";

afterEach(() => { delete localeLoaders["zz-native-refusal"]; return setLocale("en"); });
it.each(["en", "zz-native-refusal"])("native refusal notices render a sentence in %s or fall back to English", async locale => {
  // A deliberately partial pack keeps fallback coverage after shipped packs catch up.
  if (locale === "zz-native-refusal") localeLoaders[locale] = async () => ({});
  await setLocale(locale);
  for (const code of ["toolTurnRefused", "stepTurnRefused"] as const) {
    expect(sendNoticeFromBody({ noticeCode: code })).toBe(SEND_NOTICE_ENGLISH[code]);
    expect(sendNoticeLabel(sendNoticeActivityName(code))).toBe(SEND_NOTICE_ENGLISH[code]);
  }
});
