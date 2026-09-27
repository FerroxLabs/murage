// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The room's finished-reply pop: when a member that was working lands its
// text reply, that reply shows for a beat inside the live presence block
// (and is held out of the transcript), then settles into its time-ordered
// row.
import { useEffect, useRef, useState } from "react";
import type { Message } from "@/state/store";

export type ReplyPop = { id: string; text: string; botId?: string };

export function useReplyPop(resetKey: string, lastMessage: Message | undefined, waiting: boolean): ReplyPop | null {
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<ReplyPop | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    setPopping(null);
  }, [resetKey]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    // A new last row cancels the previous settle timer (the cleanup below),
    // so it must retire that pop too. In an Everyone responds room the next
    // bot's first row lands inside the pop window; without this the first
    // bot's answer stayed held in the presence block (ChatView: 84e43554).
    setPopping(null);
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    setPopping({
      id: lastMessage.id,
      text: lastMessage.text ?? "",
      botId: lastMessage.from?.botId,
    });
    const timer = setTimeout(() => setPopping(null), 520);
    return () => clearTimeout(timer);
  }, [
    lastMessage?.id,
    lastMessage?.role,
    lastMessage?.kind,
    lastMessage?.text,
    lastMessage?.from?.botId,
  ]);
  return popping;
}
