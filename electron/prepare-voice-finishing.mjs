// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D24-SPEECH-SNAPSHOT 1.0.18: Prepare to reinstall waits while a voice reply is finishing (server
// installation-app-schema-downgrade.ts assertNoSpeechHeld). The refusal reaches the main process as a code only,
// DOWNGRADE_VOICE_FINISHING_<minutes left>, so the minutes are read from it here. The words are in the app's 8
// languages, in the main-process packs (electron/locales/step-up/, keys "prepare.*"), in the same language the step-up
// confirmation uses (step-up-locale.mjs). Pure module apart from the pack read.
import { stepUpText } from "./step-up-locale.mjs";

const CODE = /^DOWNGRADE_VOICE_FINISHING_([1-9][0-9]?)$/;

/** The minutes left in a voice-finishing code (1 to 99), or null for any other code. */
export function voiceFinishingMinutes(code) {
  const match = typeof code === "string" ? CODE.exec(code) : null;
  return match ? Number(match[1]) : null;
}

/** The dialog for a voice-finishing refusal, in `language`, or null for any other code. Tests may pass `text` options. */
export function voiceFinishingDialog(code, language = "en", text = {}) {
  const minutes = voiceFinishingMinutes(code);
  if (minutes === null) return null;
  const t = stepUpText(language, text);
  return { type: "info", buttons: [t("prepare.quit")], title: "Murage", message: t("prepare.voiceFinishing"), detail: t("prepare.voiceFinishingDetail", { minutes }) };
}
