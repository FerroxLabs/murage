// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot PR #2033 (commit 927dae3f, MOCA): when macOS
// Dictation itself is switched off the speech helper reports
// "dictation-disabled", and the person is told to turn Dictation on, not to
// fix microphone or speech permissions that are already granted.
import { t } from "./i18n";

/** The reason speech-helper.swift reports for kLSRErrorDomain error 201. */
export const DICTATION_DISABLED_REASON = "dictation-disabled";

/** The note, in the language the owner chose ("dictation.disabled"). */
export const dictationDisabledNote = (): string => t("dictation.disabled");

export const isDictationDisabled = (reason: string | undefined): boolean => reason === DICTATION_DISABLED_REASON;
