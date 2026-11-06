// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U4 S3: one muted line under a hand-off row saying what "finished" means for it (server/done-when.ts bounds and checks it).
import { doneWhenText } from "@/lib/done-when-line";
import { t } from "@/lib/i18n";

export function DoneWhenLine({ text }: { text?: string }) {
  const line = doneWhenText(text);
  if (!line) return null;
  return <p data-testid="handoff-done-when" className="min-w-0 max-w-full px-1 text-[12px] leading-relaxed text-ink-secondary [overflow-wrap:anywhere]">{t("handoff.doneWhen", { text: line })}</p>;
}
