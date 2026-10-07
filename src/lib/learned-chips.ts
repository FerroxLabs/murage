// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The app's side of the "learned from that" chip: what to ask the harness for
// and what each tap does. A chip only ever comes from the harness's stored
// learning events (GET /api/bots/:id/lessons?threadId=), so nothing here
// invents one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import { REMEMBERED_EVENT, TEMPLATE_COUNTS, type ChipItem } from "../../shared/learned-chip";
import { requestLearningAction } from "./memory-learning";

type Request = (path: string, init?: RequestInit) => Promise<any>;

export const chipsPath = (botId: string, threadId: string) => `/api/bots/${encodeURIComponent(botId)}/lessons?threadId=${encodeURIComponent(threadId)}`;

/** The chips under one thread's replies, by reply id, in the order stored. */
export async function fetchChips(request: Request, botId: string, threadId: string): Promise<Map<string, ChipItem[]>> {
  const answer = await request(chipsPath(botId, threadId));
  const out = new Map<string, ChipItem[]>();
  for (const item of Array.isArray(answer?.chips) ? answer.chips as ChipItem[] : []) {
    if (!item?.eventId || !item.replyMessageId) continue; // no stored event, no chip
    out.set(item.replyMessageId, [...(out.get(item.replyMessageId) ?? []), item]);
  }
  return out;
}

/** A memory the worker just stored, as the live frame carries it, read into a chip item.
 * Null unless every part is there: no event id, no text, no reply to sit under, no chip. */
export function rememberedItemFromFrame(frame: unknown): { botId: string; threadId: string; item: ChipItem } | null {
  const f = (frame ?? {}) as Record<string, unknown>;
  const text = typeof f.text === "string" ? f.text.trim() : "";
  // An automatic skill or routine change (learning.improved): the "improved how it does X" chip, with Undo.
  if (f.kind === "learning.improved") {
    const template = typeof f.template === "number" ? f.template : 0;
    if (typeof f.botId !== "string" || !f.botId || typeof f.threadId !== "string" || !f.threadId || typeof f.eventId !== "string" || !f.eventId
      || typeof f.replyMessageId !== "string" || !f.replyMessageId || !text || !Number.isInteger(template) || template < 1 || template > TEMPLATE_COUNTS.improved) return null;
    return { botId: f.botId, threadId: f.threadId,
      item: { eventId: f.eventId, kind: "improved", group: "improved", template, text, state: "active", undoneAt: null, replyMessageId: f.replyMessageId,
        procedureKind: f.procedureKind === "routine" ? "routine" : "skill", actions: { edit: false, undo: true, forget: false, notQuite: false, notExample: false, restorable: false } } };
  }
  const template = typeof f.template === "number" ? f.template : 0;
  if (typeof f.botId !== "string" || !f.botId || typeof f.threadId !== "string" || !f.threadId || typeof f.eventId !== "string" || !f.eventId
    || typeof f.replyMessageId !== "string" || !f.replyMessageId || !text || !Number.isInteger(template) || template < 1 || template > TEMPLATE_COUNTS.remembered) return null;
  const entry = typeof f.recordId === "string" && f.recordId && Number.isInteger(f.recordVersion) ? { recordId: f.recordId, recordVersion: f.recordVersion as number, edited: false } : null;
  return {
    botId: f.botId, threadId: f.threadId,
    item: { eventId: f.eventId, kind: "remembered", group: "remembered", template, text, state: "active", undoneAt: null, replyMessageId: f.replyMessageId, ...(entry ?? {}),
      // Edit is the Memory view's own correction, so it needs the entry to point at.
      actions: { edit: entry !== null, undo: false, forget: true, notQuite: false, notExample: false, restorable: false } },
  };
}

/** The list with one more item under its reply. An item already there (same event) is not added twice,
 * so a reply keeps one chip and the chip merges its items. */
export function withChipItem(map: ReadonlyMap<string, readonly ChipItem[]>, item: ChipItem): Map<string, readonly ChipItem[]> {
  const next = new Map<string, readonly ChipItem[]>(Array.from(map, ([reply, items]) => [reply, [...items]] as const));
  const list = next.get(item.replyMessageId) ?? [];
  if (!list.some(existing => existing.eventId === item.eventId)) next.set(item.replyMessageId, [...list, item]);
  return next;
}

const newKey = () => `chip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export interface LearnedChipHandlers {
  /** Undo a lesson, Forget a memory, or "Not an example": the same two actions the learning list uses. */
  undo(item: ChipItem): Promise<void>;
  /** Keep: brings back what was just undone, within 30 seconds. */
  keep(item: ChipItem): Promise<void>;
  /** Edit the words (lessons). */
  edit(item: ChipItem, text: string): Promise<void>;
  /** "Keep it?": one tap makes a waiting suggestion a lesson. Ignoring it costs nothing. */
  keepSuggestion(item: ChipItem): Promise<void>;
}

/** The default taps. Forget on a memory chip is the same undo as the Memory list's: it archives the entry. */
export function chipHandlers(request: Request, botId: string): LearnedChipHandlers {
  const act = async (action: "learning-undo" | "learning-keep", item: ChipItem) => { await requestLearningAction(request, { action, eventId: item.eventId }); };
  return {
    // Forget on an entry the owner has edited since: the activation no longer matches it, so archive what is there now.
    undo: item => item.kind === "remembered" && item.edited && item.recordId && item.recordVersion !== undefined
      ? request("/api/memory/action", { method: "POST", body: JSON.stringify({ action: "archive", id: item.recordId, version: item.recordVersion }) }).then(() => undefined)
      : act("learning-undo", item),
    keep: item => act("learning-keep", item),
    async keepSuggestion(item) {
      if (!item.lessonId || item.lessonVersion === undefined) throw new Error("This cannot be kept here.");
      await request(`/api/bots/${encodeURIComponent(botId)}/learning/suggestions/${encodeURIComponent(item.lessonId)}/apply`, {
        method: "POST", headers: { "Idempotency-Key": newKey() }, body: JSON.stringify({ expectedRevision: item.lessonVersion }),
      });
    },
    async edit(item, text) {
      if (item.kind === "remembered" && item.recordId && item.recordVersion !== undefined) {
        await request("/api/memory/action", { method: "POST", body: JSON.stringify({ action: "correct", id: item.recordId, version: item.recordVersion, text }) });
        return;
      }
      if (item.kind !== "lesson" || !item.lessonId || item.lessonVersion === undefined) throw new Error("This cannot be edited here.");
      await request(`/api/bots/${encodeURIComponent(botId)}/lessons/${encodeURIComponent(item.lessonId)}`, {
        method: "PATCH", headers: { "Idempotency-Key": newKey() }, body: JSON.stringify({ expectedRevision: item.lessonVersion, text }),
      });
    },
  };
}

export interface ThreadChips {
  /** The stored chips under each reply of this conversation, by reply id. */
  byReply: ReadonlyMap<string, readonly ChipItem[]>;
  handlers: LearnedChipHandlers;
  reload(): void;
}

/** Reads this conversation's chips when it opens and again each time the bot
 * settles (a lesson or a kept moment is stored during or right after a turn).
 * A memory the worker stores seconds or minutes later arrives as a live event
 * and is attached under its own reply at once; `hold` lets the chat keep the
 * reader's place first, because the chip must never scroll the view.
 * A failed read is an empty list: no stored event, no chip. */
export function useThreadChips(botId: string, threadId: string, busy: boolean, hold?: { before(): void }): ThreadChips {
  const [byReply, setByReply] = useState<ReadonlyMap<string, readonly ChipItem[]>>(new Map());
  const current = useRef({ botId, threadId });
  current.current = { botId, threadId };
  const holdRef = useRef(hold);
  holdRef.current = hold;
  // Chips that arrived live, with when. A read that began before one arrived may not know it yet.
  const live = useRef(new Map<string, { item: ChipItem; at: number }>());
  const reload = useCallback(() => {
    const startedAt = Date.now();
    fetchChips(api, botId, threadId).then(map => {
      if (current.current.botId !== botId || current.current.threadId !== threadId) return;
      let merged = map as ReadonlyMap<string, readonly ChipItem[]>;
      for (const [eventId, entry] of live.current) {
        if (entry.at <= startedAt) live.current.delete(eventId);
        else merged = withChipItem(merged, entry.item);
      }
      setByReply(merged);
    }, () => { /* an empty list is the honest fallback */ });
  }, [botId, threadId]);
  useEffect(() => { setByReply(new Map()); live.current.clear(); }, [botId, threadId]);
  useEffect(() => { if (!busy) reload(); }, [reload, busy]);
  useEffect(() => {
    const onRemembered = (event: Event) => {
      const parsed = rememberedItemFromFrame((event as CustomEvent).detail);
      if (!parsed || parsed.botId !== botId || parsed.threadId !== threadId) return;
      live.current.set(parsed.item.eventId, { item: parsed.item, at: Date.now() });
      holdRef.current?.before();
      setByReply(map => withChipItem(map, parsed.item));
    };
    window.addEventListener(REMEMBERED_EVENT, onRemembered);
    return () => window.removeEventListener(REMEMBERED_EVENT, onRemembered);
  }, [botId, threadId]);
  const handlers = useMemo(() => chipHandlers(api, botId), [botId]);
  return useMemo(() => ({ byReply, handlers, reload }), [byReply, handlers, reload]);
}

// ---- Rooms: several member bots share one thread; the ledger is per bot. ----

/** A bot's chips with each item tagged by that bot. */
export function tagChipItems(map: ReadonlyMap<string, readonly ChipItem[]>, botId: string): Map<string, ChipItem[]> {
  return new Map(Array.from(map, ([reply, items]) => [reply, items.map(item => ({ ...item, botId }))] as const));
}

/** Several members' chip maps as one, by reply id; an event already there is not added twice. */
export function mergeChipMaps(maps: ReadonlyArray<ReadonlyMap<string, readonly ChipItem[]>>): Map<string, readonly ChipItem[]> {
  let out = new Map<string, readonly ChipItem[]>();
  for (const map of maps) for (const items of map.values()) for (const item of items) out = withChipItem(out, item);
  return out;
}

/** Every member's stored chips for the room's thread. A member whose read fails adds nothing. */
export async function fetchRoomChips(request: Request, memberBotIds: readonly string[], threadId: string): Promise<Map<string, readonly ChipItem[]>> {
  const maps = await Promise.all(memberBotIds.map(id => fetchChips(request, id, threadId).then(map => tagChipItems(map, id), () => new Map<string, ChipItem[]>())));
  return mergeChipMaps(maps);
}

/** A live "remembered" frame belongs to this room only when it is for the room's thread and from a member. */
export const roomFrameAccepted = (parsed: { botId: string; threadId: string }, memberBotIds: readonly string[], threadId: string): boolean =>
  parsed.threadId === threadId && memberBotIds.includes(parsed.botId);

/** Taps go to the bot that learned the thing; an untagged item goes to `fallbackBotId`. */
export function roomChipHandlers(request: Request, fallbackBotId: string): LearnedChipHandlers {
  const forItem = (item: ChipItem) => chipHandlers(request, item.botId ?? fallbackBotId);
  return { undo: item => forItem(item).undo(item), keep: item => forItem(item).keep(item), edit: (item, text) => forItem(item).edit(item, text), keepSuggestion: item => forItem(item).keepSuggestion(item) };
}

/** `useThreadChips` for a room: the chips of every member under the room's replies. */
export function useRoomChips(memberBotIds: readonly string[], threadId: string, busy: boolean, hold?: { before(): void }): ThreadChips {
  const [byReply, setByReply] = useState<ReadonlyMap<string, readonly ChipItem[]>>(new Map());
  const idsKey = memberBotIds.join("|");
  const ids = useMemo(() => (idsKey ? idsKey.split("|") : []), [idsKey]);
  const current = useRef({ idsKey, threadId });
  current.current = { idsKey, threadId };
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const live = useRef(new Map<string, { item: ChipItem; at: number }>());
  const reload = useCallback(() => {
    const startedAt = Date.now();
    fetchRoomChips(api, ids, threadId).then(map => {
      if (current.current.idsKey !== idsKey || current.current.threadId !== threadId) return;
      let merged = map as ReadonlyMap<string, readonly ChipItem[]>;
      for (const [eventId, entry] of live.current) {
        if (entry.at <= startedAt) live.current.delete(eventId);
        else merged = withChipItem(merged, entry.item);
      }
      setByReply(merged);
    }, () => { /* an empty list is the honest fallback */ });
  }, [ids, idsKey, threadId]);
  useEffect(() => { setByReply(new Map()); live.current.clear(); }, [idsKey, threadId]);
  useEffect(() => { if (!busy && ids.length) reload(); }, [reload, busy, ids.length]);
  useEffect(() => {
    const onRemembered = (event: Event) => {
      const parsed = rememberedItemFromFrame((event as CustomEvent).detail);
      if (!parsed || !roomFrameAccepted(parsed, ids, threadId)) return;
      const item = { ...parsed.item, botId: parsed.botId };
      live.current.set(item.eventId, { item, at: Date.now() });
      holdRef.current?.before();
      setByReply(map => withChipItem(map, item));
    };
    window.addEventListener(REMEMBERED_EVENT, onRemembered);
    return () => window.removeEventListener(REMEMBERED_EVENT, onRemembered);
  }, [ids, threadId]);
  const handlers = useMemo(() => roomChipHandlers(api, ids[0] ?? ""), [ids]);
  return useMemo(() => ({ byReply, handlers, reload }), [byReply, handlers, reload]);
}
