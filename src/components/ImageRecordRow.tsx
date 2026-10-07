// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { CollapsibleText } from "@/components/CollapsibleText";
import { CHIP_NAME } from "@/lib/transcript-chrome";
import type { Message } from "@/state/store";

/** Is this activity message the record of an image made without asking? */
export function isImageRecordLine(message: Message): boolean {
  return message.kind === "activity" && typeof message.tool?.imageRecord?.prompt === "string";
}

/** A bot on Full access, No limits or the Images setting makes an image with
 * no approval card. This is what stays in the conversation instead: what was
 * made and the whole prompt, folded like the card folds a long prompt, so the
 * owner can always read exactly what was sent. */
export function ImageRecordRow({ message }: { message: Message }) {
  const tool = message.tool;
  const record = tool?.imageRecord;
  if (!tool || !record) return null;
  return (
    <div className="flex justify-start">
      <div data-testid="image-record-row" className="min-w-0 max-w-[min(42rem,78%)] rounded-2xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] max-md:max-w-full">
        <div className={`${CHIP_NAME} text-ink-secondary`}>{tool.name}</div>
        <div className="mt-0.5 text-[12px] text-ink-secondary">{record.summary}</div>
        <CollapsibleText text={record.prompt} className="mt-1 text-[12px] text-ink-secondary" />
      </div>
    </div>
  );
}
