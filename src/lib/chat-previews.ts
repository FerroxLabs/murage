import type { SearchHit } from "./search-hit";
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { chatsEligible, chatsGenSnapshot, chatsGenSession, useChatsGen, compareGen, type ChatsGen } from "./chats-gen";
import { fetchChats, scheduleRefetch, chatsRequestPath, type ChatFilters, type ChatPage, type ChatRow } from "./all-chats";

/** Dispose transcript data while retaining independently known row metadata. */
function retainMetadata<T extends { gen?: ChatsGen }>(data: T): T {
  const page = data as T & { hits?: unknown[]; chats?: ChatRow[]; pinned?: ChatRow[]; next?: string | null };
  const clean = (rows: ChatRow[]) => rows.map(({ snippet, lastRole, lastFrom, ...row }) => row);
  return { ...page, gen: undefined, next: null, ...(page.hits ? { hits: [] } : {}),
    ...(page.chats ? { chats: clean(page.chats) } : {}), ...(page.pinned ? { pinned: clean(page.pinned) } : {}) };
}

/** A view owns its request lifetime. Generation changes reuse its scheduler. */
export function useChatResource<T extends { gen?: ChatsGen }>(path: string | null, request: (path: string) => Promise<T> = api, delay = 0, retainOnInvalidation: (data: T) => T = retainMetadata) {
  const proof = useChatsGen();
  const [held, setHeld] = useState<{ path: string; data: T; listGen: ChatsGen | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [replacement, setReplacement] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const current = useRef(held); current.current = held;
  const attempted = useRef("");
  const attemptKey = () => JSON.stringify([chatsGenSession(), chatsGenSnapshot().known]);
  const control = useRef<{ schedule: () => void; load: (url: string, merge?: (old: T, page: T) => T, accepted?: () => void) => void } | null>(null);
  useEffect(() => {
    const mine = ++generation.current;
    let next: { expect: ChatsGen | null; url: string; merge?: (old: T, page: T) => T; accepted?: () => void } | null = null;
    setHeld(null); setError(null); setLoading(!!path);
    if (!path) { control.current = null; return; }
    const scheduler = scheduleRefetch(async () => {
      const page = next; next = null;
      attempted.current = attemptKey();
      setLoading(true);
      try {
        const old = current.current;
        const answer = await fetchChats<T>(page?.url ?? path, page?.expect ?? null, request);
        if (generation.current !== mine) return;
        if (!answer) { if (chatsGenSnapshot().proven && (attempted.current !== attemptKey() || page)) scheduler.schedule(); return; }
        setHeld({ path, data: page?.merge && old?.path === path && chatsEligible(old.listGen) && answer.listGen && compareGen(old.listGen!, answer.listGen) === "same" ? page.merge(old.data, answer) : answer, listGen: answer.listGen });
        if (!page) setReplacement(value => value + 1);
        page?.accepted?.();
        setError(null);
      } catch (failure) { if (generation.current === mine) {
        setError(failure);
        if (retainOnInvalidation) setHeld(old => old?.listGen && chatsGenSnapshot().known && compareGen(old.listGen, chatsGenSnapshot().known!) !== "same" ? { ...old, data: retainOnInvalidation(old.data), listGen: null } : old);
      } }
      finally { if (generation.current === mine) setLoading(false); }
    }, delay);
    control.current = { schedule() { next = null; scheduler.schedule(); }, load(url, merge, accepted) { next = { url, merge, accepted, expect: current.current?.listGen ? { ...current.current.listGen } : null }; scheduler.schedule(); } };
    scheduler.schedule();
    return () => { generation.current++; scheduler.dispose(); control.current = null; };
  }, [path, request, delay, retainOnInvalidation]);
  useEffect(() => {
    if (held?.listGen && (proof.known && compareGen(held.listGen, proof.known) !== "same"))
      setHeld(old => old ? { ...old, data: retainOnInvalidation(old.data), listGen: null } : null);
  }, [proof, held, retainOnInvalidation]);
  useEffect(() => {
    if (proof.proven && attempted.current !== attemptKey() && (!held || held.path !== path || !chatsEligible(held.listGen, proof))) control.current?.schedule();
  }, [proof, held, path]);
  const data = held?.path === path ? held.data : null;
  return { data, replacement, listGen: held?.path === path ? held.listGen : null, eligible: held?.path === path && chatsEligible(held.listGen, proof), loading, error,
    refresh: () => control.current?.schedule(),
    more: (url: string, merge?: (old: T, page: T) => T, accepted?: () => void) => { if (!loading) control.current?.load(url, merge, accepted); } };
}

export function useChatPreviews(open: boolean, scope: ChatFilters, ids: string, stamp: string): { rows: Record<string, ChatRow>; eligible: boolean; partial: boolean } {
  const path = open && ids && (scope.botId || scope.groupId) ? `${chatsRequestPath({ ...scope, routines: true }, null, "", 200)}&threads=${encodeURIComponent(ids)}&stamp=${encodeURIComponent(stamp)}` : null;
  const held = useChatResource<ChatPage>(path);
  return { rows: Object.fromEntries([...(held.data?.pinned ?? []), ...(held.data?.chats ?? [])].map(row => [row.threadId, row])), eligible: held.eligible, partial: held.data?.partial === true };
}

export interface HitsPage { gen?: ChatsGen; hits: SearchHit[]; next?: string | null; partial?: boolean }
