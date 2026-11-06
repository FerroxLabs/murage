// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 copy N (designs/NOLIMITS-MEANS-IT.md section 11): the server words an outside-content card's note in
// English (server/auto-approve.ts outsideTurnNote, also written to the log). The card shows it in the owner's language:
// the sentence and its fixed source name, each from the pack. Any other note is shown as it came.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** The fixed source names the server can put in N (server/email/external-marks.ts OutsideSource, plus "not checked"). */
export const OUTSIDE_SOURCE_KEYS: Record<string, LocaleKey> = {
  "web page": "noLimits.v1.source.webPage",
  "web search": "noLimits.v1.source.webSearch",
  email: "noLimits.v1.source.email",
  "another person": "noLimits.v1.source.anotherPerson",
  "another bot": "noLimits.v1.source.anotherBot",
  "browser page": "noLimits.v1.source.browserPage",
  "outside tool": "noLimits.v1.source.outsideTool",
  "downloaded file": "noLimits.v1.source.downloadedFile",
  "network command": "noLimits.v1.source.networkCommand",
  "package install": "noLimits.v1.source.packageInstall",
  git: "noLimits.v1.source.git",
  archive: "noLimits.v1.source.archive",
  interpreter: "noLimits.v1.source.interpreter",
  helper: "noLimits.v1.source.helper",
  "earlier turn": "noLimits.v1.source.earlierTurn",
  "earlier session": "noLimits.v1.source.earlierSession",
  memory: "noLimits.v1.source.memory",
  "cloned folder": "noLimits.v1.source.clonedFolder",
  "not checked": "noLimits.v1.source.notChecked",
};

const NOTE_N = /^This chat read outside content \(([^()]{1,40})\), so Murage asks before running this\. Allow to run it\.$/;

type Translate = (key: string, params?: Record<string, string>) => string;

/** N in the owner's language; any other note unchanged. An unknown source name keeps the server's words for it. */
export function localizeOutsideNote(held: string, translate: Translate = t as Translate): string {
  const match = NOTE_N.exec(held);
  if (!match) return held;
  const source = match[1]!;
  const key = Object.hasOwn(OUTSIDE_SOURCE_KEYS, source) ? OUTSIDE_SOURCE_KEYS[source] : undefined;
  return translate("noLimits.v1.outsideNote", { source: key ? translate(key) : source });
}

const CALL_NAMED = /^This chat read outside content \(([^()]{1,40})\) first\.$/;
const CALL_UNNAMED = "This chat read outside content first.";

/** A call card's words (server/bot-calls-card.ts) with its outside-content line in the owner's language. Only that exact line of a
 *  source the server can name is translated: every other line, including the older call words, is shown as it came. */
export function localizeCallCardText(text: string, translate: Translate = t as Translate): string {
  return text.split("\n").map((line) => {
    if (line === CALL_UNNAMED) return translate("noLimits.v1.callOutsideUnnamed");
    const source = CALL_NAMED.exec(line)?.[1];
    return source !== undefined && Object.hasOwn(OUTSIDE_SOURCE_KEYS, source) ? translate("noLimits.v1.callOutside", { source: translate(OUTSIDE_SOURCE_KEYS[source]!) }) : line;
  }).join("\n");
}
