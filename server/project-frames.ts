// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The project SSE frames (SPEC-P 12.3): `project.board` carries card ids and
// revisions only (no text), coalesced 250 ms per group and merged by card id;
// `project.strip` is a pure invalidation, coalesced 500 ms per group. The
// client refetches the aggregate read after either, and after a replay gap.
//
// The emitter takes the server's `broadcast` as a parameter so the coalescing
// is testable without a server; index.ts wires the real one.
export type ProjectFrameBroadcast = (payload: Record<string, unknown>) => void;

export interface ProjectBoardCardFrame {
  id: string;
  revision: number;
  state: string;
  columnId: string | null;
  deleted?: boolean;
}

const BOARD_COALESCE_MS = 250;
const STRIP_COALESCE_MS = 500;

export interface ProjectFrameEmitter {
  /** Any card or column write. `columnsRevision` is project_settings.revision
   * after a column change; the highest wins a merge. */
  board(groupId: string, cards: ProjectBoardCardFrame[], columnsRevision?: number): void;
  /** Settings, goal, budget, usage settled, request state, running-turn start
   * or end, brief version, summary version, activity row. */
  strip(groupId: string): void;
  /** Test and shutdown hook: send anything pending now. */
  flush(): void;
}

interface BoardPending {
  cards: Map<string, ProjectBoardCardFrame>;
  columnsRevision?: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createProjectFrameEmitter(broadcast: ProjectFrameBroadcast): ProjectFrameEmitter {
  const boardPending = new Map<string, BoardPending>();
  const stripPending = new Map<string, ReturnType<typeof setTimeout>>();

  const sendBoard = (groupId: string) => {
    const pending = boardPending.get(groupId);
    if (!pending) return;
    boardPending.delete(groupId);
    broadcast({
      kind: "project.board",
      groupId,
      cards: [...pending.cards.values()],
      ...(pending.columnsRevision !== undefined ? { columnsRevision: pending.columnsRevision } : {}),
    });
  };

  const sendStrip = (groupId: string) => {
    if (!stripPending.delete(groupId)) return;
    broadcast({ kind: "project.strip", groupId });
  };

  return {
    board(groupId, cards, columnsRevision) {
      const existing = boardPending.get(groupId);
      const merged = existing?.cards ?? new Map<string, ProjectBoardCardFrame>();
      for (const card of cards) {
        const held = merged.get(card.id);
        // A deleted entry wins over any revision; otherwise the highest card
        // revision wins (12.3).
        if (held?.deleted === true) continue;
        if (card.deleted === true || !held || card.revision > held.revision) merged.set(card.id, card);
      }
      const columnsMerged = [existing?.columnsRevision, columnsRevision].filter((v): v is number => v !== undefined);
      boardPending.set(groupId, {
        cards: merged,
        columnsRevision: columnsMerged.length ? Math.max(...columnsMerged) : undefined,
        timer: existing?.timer ?? setTimeout(() => sendBoard(groupId), BOARD_COALESCE_MS),
      });
    },
    strip(groupId) {
      if (stripPending.has(groupId)) return;
      stripPending.set(groupId, setTimeout(() => sendStrip(groupId), STRIP_COALESCE_MS));
    },
    flush() {
      for (const [groupId, pending] of [...boardPending]) {
        clearTimeout(pending.timer);
        sendBoard(groupId);
      }
      for (const [groupId, timer] of [...stripPending]) {
        clearTimeout(timer);
        sendStrip(groupId);
      }
    },
  };
}
