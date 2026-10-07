// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
export interface CardRevision { id: string; revision: number; state: "todo" | "doing" | "waiting" | "failed" | "review" | "done" | "cancelled"; columnId: string | null; deleted?: boolean }
export type ProjectFrame =
  | { kind: "project.strip"; groupId: string }
  | { kind: "room.requests"; groupId: string; threadId: string }
  | { kind: "project.board"; groupId: string; cards: CardRevision[]; columnsRevision?: number };
export interface ProjectInvalidation { strip: boolean; board: boolean; requests: boolean; replayGap?: boolean; cards: CardRevision[]; columnsRevision?: number }
/** The existing stream owns transport and replay. This bus only batches reads. */
export function createProjectEvents() {
  type Listener = (change: ProjectInvalidation) => void;
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<string, { change: ProjectInvalidation; timer: ReturnType<typeof setTimeout> }>();
  const revisions = new Map<string, Map<string, CardRevision>>();
  const columns = new Map<string, number>();
  const blank = (): ProjectInvalidation => ({ strip: false, board: false, requests: false, cards: [] });
  function frame(value: ProjectFrame) {
    if (!listeners.has(value.groupId)) return;
    const previous = pending.get(value.groupId);
    const change = previous?.change ?? blank();
    if (value.kind === "project.strip") change.strip = true;
    else if (value.kind === "room.requests") change.requests = true;
    else {
      const held = revisions.get(value.groupId) ?? new Map<string, CardRevision>();
      revisions.set(value.groupId, held);
      for (const card of value.cards) {
        const old = held.get(card.id);
        if (old?.deleted || (old && !card.deleted && old.revision >= card.revision)) continue;
        held.set(card.id, card);
        change.cards = [...change.cards.filter((entry) => entry.id !== card.id), card];
        change.board = true;
      }
      if (value.columnsRevision !== undefined && value.columnsRevision > (columns.get(value.groupId) ?? -1)) {
        columns.set(value.groupId, value.columnsRevision);
        change.columnsRevision = value.columnsRevision;
        change.board = true;
      }
    }
    if (previous || (!change.strip && !change.board && !change.requests)) return;
    const timer = setTimeout(() => {
      pending.delete(value.groupId);
      for (const listener of listeners.get(value.groupId) ?? []) listener(change);
    }, 250);
    pending.set(value.groupId, { change, timer });
  }
  return {
    frame,
    subscribe(groupId: string, listener: Listener) {
      const group = listeners.get(groupId) ?? new Set<Listener>();
      group.add(listener); listeners.set(groupId, group);
      return () => {
        group.delete(listener);
        if (group.size) return;
        listeners.delete(groupId); revisions.delete(groupId); columns.delete(groupId);
        const queued = pending.get(groupId); if (queued) clearTimeout(queued.timer);
        pending.delete(groupId);
      };
    },
    replayGap() {
      revisions.clear(); columns.clear();
      for (const queued of pending.values()) clearTimeout(queued.timer);
      pending.clear();
      for (const group of listeners.values()) for (const listener of group) listener({ strip: true, board: true, requests: true, replayGap: true, cards: [] });
    },
  };
}
export const projectEvents = createProjectEvents();
