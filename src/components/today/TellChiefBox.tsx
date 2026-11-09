// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Tell box (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2): one field and Send, to the Chief. It IS
// the Chief's own Composer (`bot={chief}`, keyed by the Chief's current conversation exactly as ChatView keys it),
// drawn `compact`: so the words go where typing in the Chief's chat goes (`bot.threadId`), through the composer's
// own draft journal, outbox, busy queueing, size refusal and retry. Nothing here sends.
//
// "Sent to {chief}." shows only after the server acknowledged the send (Composer `onSent`, outcome `acked`); until
// then the words stay in the box. Hidden with no Chief and during first run (TodayView draws it only then).
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Composer } from "@/components/Composer";

import { TellSentLine, tellReceiptShows, type TellReceipt } from "./TellSentLine";

export function TellChiefBox({ chief, onOpenChat }: { chief: Bot; onOpenChat: (botId: string, threadId?: string) => void }) {
  // The Chief and conversation the last acknowledged send went to. It holds only while both are still the current
  // destination, so "Open the chat" always opens where the box sends now; a new Chief or task clears it.
  const [sentTo, setSentTo] = useState<TellReceipt | null>(null);
  const threadId = chief.threadId;
  const chiefId = chief.id;
  useEffect(() => setSentTo(null), [chiefId, threadId]);
  const sent = tellReceiptShows(sentTo, chiefId, threadId);
  return (
    <section aria-label={t("ux.l2a.today.tell.placeholder", { chief: chief.name })} data-today="tell" className="rounded-xl border border-hairline/50 bg-panel pt-3">
      <Composer
        key={`${chiefId}:${threadId}`}
        bot={chief}
        compact={{ placeholder: t("ux.l2a.today.tell.placeholder", { chief: chief.name }), sendLabel: t("ux.l2a.today.tell.send") }}
        onSent={() => setSentTo({ chiefId, threadId })}
      />
      <TellSentLine sent={sent} chiefName={chief.name} onOpen={() => onOpenChat(chiefId, threadId)} />
    </section>
  );
}
