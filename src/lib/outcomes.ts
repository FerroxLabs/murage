// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The chat's side of outcomes: the routes (/api/bots/:id/outcomes) behind one
// small hook. A tap records at once; details and Undo come after it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import type { OutcomeAnswer, OutcomeKind, OutcomeView } from "../../shared/outcome-choices";

const key = () => `outcome-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const base = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/outcomes`;

export interface OutcomeDetails { reason?: string; value?: number | null; currency?: string | null }

export async function fetchOutcomes(botId: string, threadId: string): Promise<OutcomeView[]> {
  const answer = await api(`${base(botId)}?threadId=${encodeURIComponent(threadId)}`);
  return Array.isArray(answer?.outcomes) ? answer.outcomes : [];
}
async function send(method: "POST" | "PATCH", path: string, body: Record<string, unknown>): Promise<OutcomeView> {
  const answer = await api(path, { method, headers: { "idempotency-key": key() }, body: JSON.stringify(body) });
  if (!answer?.outcome) throw new Error(typeof answer?.error === "string" ? answer.error : "That did not save.");
  return answer.outcome;
}

/** One tap on a reply: POST, and once more with the revision the server names if the mark changed elsewhere meanwhile. */
export async function markReply(botId: string, threadId: string, messageId: string, kind: OutcomeKind, revision: number): Promise<OutcomeView> {
  const post = (expectedRevision: number) => send("POST", base(botId), { threadId, messageId, kind, expectedRevision });
  try { return await post(revision); }
  catch (error) {
    const current = (error as { status?: number; body?: { revision?: unknown } }).body?.revision;
    if ((error as { status?: number }).status !== 409 || typeof current !== "number") throw error;
    return post(current);
  }
}

export interface ThreadOutcomes {
  /** The confirmed mark on each message of this conversation. */
  marks: ReadonlyMap<string, OutcomeView>;
  /** The question the bot asked, if the owner has not answered it. */
  proposal: OutcomeView | undefined;
  /** `botId` names whose reply it is in a room; a 1:1 chat has only its own bot. */
  mark(messageId: string, kind: OutcomeKind, botId?: string): Promise<OutcomeView>;
  details(outcome: OutcomeView, details: OutcomeDetails): Promise<OutcomeView>;
  undo(outcome: OutcomeView): Promise<void>;
  answer(outcome: OutcomeView, answer: OutcomeAnswer): Promise<OutcomeView | undefined>;
}

/** Reads this conversation's outcomes when it opens and again each time the
 * bot settles (a proposal arrives during a turn). Errors never reach the chat:
 * a failed read is an empty list, a failed save is thrown to the control.
 * `onStored` runs after a mark or an answer is saved, so the chip a win earns
 * can be read at once. */
export function useThreadOutcomes(botId: string, threadId: string, busy: boolean, onStored?: () => void): ThreadOutcomes {
  return useOutcomesOf(useMemo(() => [botId], [botId]), threadId, busy, onStored);
}

/** The same for a room: every member's marks, each tap routed to the bot that wrote the reply. */
export function useRoomOutcomes(botIds: readonly string[], threadId: string, busy: boolean, onStored?: () => void): ThreadOutcomes {
  const key = botIds.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the joined ids are the identity
  const stable = useMemo(() => [...botIds], [key]);
  return useOutcomesOf(stable, threadId, busy, onStored);
}

function useOutcomesOf(botIds: readonly string[], threadId: string, busy: boolean, onStored?: () => void): ThreadOutcomes {
  const [rows, setRows] = useState<OutcomeView[]>([]);
  const ids = botIds.join("|");
  const current = useRef({ ids, threadId });
  current.current = { ids, threadId };
  const stored = useRef(onStored);
  stored.current = onStored;
  const refresh = useCallback(async () => {
    const lists = await Promise.allSettled(botIds.map(id => fetchOutcomes(id, threadId)));
    // A read that failed leaves that bot's marks out: an empty list is the honest fallback.
    if (current.current.ids === ids && current.current.threadId === threadId) setRows(lists.flatMap(list => (list.status === "fulfilled" ? list.value : [])));
  }, [botIds, ids, threadId]);
  useEffect(() => { setRows([]); }, [ids, threadId]);
  useEffect(() => { if (!busy) void refresh(); }, [refresh, busy]);

  const put = useCallback((next: OutcomeView) => setRows(list => [next, ...list.filter(row => row.id !== next.id && !(next.messageId && row.messageId === next.messageId && row.state === "confirmed"))]), []);
  return useMemo<ThreadOutcomes>(() => {
    const marks = new Map<string, OutcomeView>();
    for (const row of rows) if (row.state === "confirmed" && row.messageId && !marks.has(row.messageId)) marks.set(row.messageId, row);
    const proposal = rows.find(row => row.state === "proposed");
    return {
      marks, proposal,
      mark: async (messageId, kind, botId) => {
        const owner = botId ?? botIds[0]!;
        const next = await markReply(owner, threadId, messageId, kind, marks.get(messageId)?.revision ?? 0);
        put(next);
        stored.current?.();
        return next;
      },
      details: async (outcome, details) => {
        const next = await send("PATCH", `${base(outcome.botId)}/${encodeURIComponent(outcome.id)}`, { ...details, expectedRevision: outcome.revision });
        put(next);
        return next;
      },
      undo: async outcome => {
        await send("PATCH", `${base(outcome.botId)}/${encodeURIComponent(outcome.id)}`, { revoke: true, expectedRevision: outcome.revision });
        setRows(list => list.filter(row => row.id !== outcome.id));
      },
      answer: async (outcome, answer) => {
        const next = await send("PATCH", `${base(outcome.botId)}/${encodeURIComponent(outcome.id)}`, { answer, expectedRevision: outcome.revision });
        if (answer === "not-yet") { setRows(list => list.filter(row => row.id !== outcome.id)); return undefined; }
        put(next);
        stored.current?.();
        return next;
      },
    };
  }, [rows, botIds, threadId, put]);
}
