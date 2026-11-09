// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NEEDSYOU-INLINE-APPROVE on Today (1.0.18, Sean): the one-click answer beside a Today Decide row. Its own chunk,
// loaded on first use (today-quick.tsx), so the card read and the answer buttons stay out of the first paint.
// It reads the row's live card through the Inbox's own helper, says WHAT is asked (requestSummary, so nobody
// approves a blind "Approval requested"), and answers through the Needs you door's own InboxQuickAnswer: one hook,
// one POST /respond, the open card's own bodies. A card that keeps Open only draws nothing.
import { useEffect, useState } from "react";
import type { OptionCardData } from "@/state/store";
import { InboxQuickAnswer, readRequestCard, requestSummary } from "@/components/InboxRequest";
import type { NeedsRequest } from "@/lib/today-needs";
import { rowLine } from "@/lib/approval-row";

export interface TodayQuickAnswerProps {
  request: NeedsRequest;
  /** the row's line, which names the button group */
  labelledBy: string;
  /** the answer was accepted: the row leaves */
  onSettled: () => void;
  /** the card was read: the row's line says what it asks */
  onSaid: (text: string) => void;
}

export function TodayQuickAnswer({ request, labelledBy, onSettled, onSaid }: TodayQuickAnswerProps) {
  const [card, setCard] = useState<OptionCardData | null>(null);
  const { threadId, messageId, version } = request;
  useEffect(() => {
    const controller = new AbortController();
    setCard(null);
    void readRequestCard({ threadId, messageId }, controller.signal).then((found) => {
      if (controller.signal.aborted) return;
      setCard(found);
      // APPROVALS-SIMPLE-1018: "{bot} wants to {wants}" for an approval, the bot's question for a question; never a command
      const said = rowLine(found, request.botName, requestSummary);
      if (said) onSaid(said);
    });
    return () => controller.abort();
    // `version` changes when the card does; onSaid is a fresh closure each render, so it is not a dependency.
  }, [threadId, messageId, version]);
  if (!card) return null;
  return <InboxQuickAnswer threadId={threadId} card={card} botName={request.botName} labelledBy={labelledBy} onSettled={onSettled} />;
}
