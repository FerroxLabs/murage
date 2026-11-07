// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The line under Today's Tell box once the server acknowledged a send (Today slice 1.0.18): "Sent to {chief}." and
// "Open the chat". Empty until then. Its own file so the test renders it without the Composer's module tree.
import { t } from "@/lib/i18n";

/** Where the last acknowledged Tell box send went. */
export interface TellReceipt { chiefId: string; threadId: string }
/** "Sent to {chief}." shows only while that send's Chief and conversation are still the box's destination. */
export function tellReceiptShows(receipt: TellReceipt | null, chiefId: string, threadId: string): boolean {
  return receipt !== null && receipt.chiefId === chiefId && receipt.threadId === threadId && threadId !== "";
}

export function TellSentLine({ sent, chiefName, onOpen }: { sent: boolean; chiefName: string; onOpen: () => void }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 px-5 text-[13px] text-ink-secondary empty:hidden">
      {sent ? (
        <>
          <span>{t("ux.l2a.today.tell.sent", { chief: chiefName })}</span>
          <button type="button" onClick={onOpen} className="min-h-11 rounded-lg px-2 font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t("ux.l2a.today.tell.open")}
          </button>
        </>
      ) : null}
    </p>
  );
}
