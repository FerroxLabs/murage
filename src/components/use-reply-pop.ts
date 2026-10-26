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

/**
 * `turnKey` names who is speaking in which turn (speaker id + turn id). A new
 * one re-arms the pop, so the next member in a room hand-off gets its own pop
 * even when the previous member's text is still the last row.
 */
export function useReplyPop(resetKey: string, lastMessage: Message | undefined, waiting: boolean, turnKey?: string): ReplyPop | null {
  const wasWaiting = useRef(false);
  const seenTurnKey = useRef<string | undefined>(undefined);
  // The reply that already popped: it never pops again, even after a re-arm.
  const consumedId = useRef<string | null>(null);
  const [popping, setPopping] = useState<ReplyPop | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    seenTurnKey.current = undefined;
    consumedId.current = null;
    setPopping(null);
  }, [resetKey]);
  // Armed while the member works; a new row other than a bot's own text, or a
  // new speaker or turn, re-arms it, because the mascot now stays through a
  // mid-turn sentence (upstream #3374) and `waiting` alone no longer turns
  // over between steps or speakers.
  useEffect(() => {
    if (!waiting) return;
    const newTurn = turnKey !== undefined && turnKey !== seenTurnKey.current;
    seenTurnKey.current = turnKey;
    if (newTurn || !(lastMessage?.role === "bot" && lastMessage.kind === "text")) wasWaiting.current = true;
  }, [waiting, lastMessage?.id, lastMessage?.role, lastMessage?.kind, turnKey]);
  useEffect(() => {
    // A new last row cancels the previous settle timer (the cleanup below),
    // so it must retire that pop too. In an Everyone responds room the next
    // bot's first row lands inside the pop window; without this the first
    // bot's answer stayed held in the presence block (ChatView: 84e43554).
    setPopping(null);
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    if (lastMessage.id === consumedId.current) return;
    wasWaiting.current = false;
    consumedId.current = lastMessage.id;
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
