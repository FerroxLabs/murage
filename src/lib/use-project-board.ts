// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectBoardRead, ProjectCardAction, RoomRequest } from "./project-client";
import { projectClient, refreshProject } from "./use-project";
import { projectEvents } from "./project-events";
import { applyOwnerOptimistic, applyOptimistic, boardAnnouncements, boardInvalidation, boardWriteFailure, type BoardTarget, type MovePlan } from "./project-board";

export function useProjectBoard(groupId: string, archived: boolean, enabled: boolean, initialBoard?: ProjectBoardRead) {
  const [board, setBoard] = useState<ProjectBoardRead | null>(initialBoard ?? null);
  const [requests, setRequests] = useState<RoomRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [refusal, setRefusal] = useState("");
  const [busy, setBusy] = useState(false);
  const server = useRef(board), alive = useRef(true), generation = useRef(0), writing = useRef(false);
  const baseline = useRef(false), requestRead = useRef(0);
  const view = useRef({ groupId, archived, enabled });
  view.current = { groupId, archived, enabled };
  const own = useRef(new Set<string>());
  const pendingRead = useRef<Promise<boolean> | null>(null), again = useRef(false);
  const announce = useCallback((line: string, error = false) => { setNotice(line); setRefusal(error ? line : ""); }, []);
  const loadRequests = useCallback(async () => {
    const visit = generation.current, serial = ++requestRead.current;
    const result = await projectClient.requests(groupId, { open: true, limit: 100 });
    if (alive.current && visit === generation.current && serial === requestRead.current && view.current.groupId === groupId && view.current.enabled && result.ok) setRequests(result.data.requests);
  }, [groupId]);
  const load = useCallback((): Promise<boolean> => {
    if (view.current.groupId !== groupId || view.current.archived !== archived || !view.current.enabled) return Promise.resolve(false);
    if (pendingRead.current) { again.current = true; return pendingRead.current; }
    const current = generation.current;
    const read = async () => {
      let succeeded = false;
      do {
        again.current = false;
        const result = await projectClient.board(groupId, { archived });
        if (!alive.current || current !== generation.current || view.current.groupId !== groupId || view.current.archived !== archived || !view.current.enabled) return false;
        if (result.ok) {
          const previous = server.current;
          const remote = { ...result.data, cards: result.data.cards.filter(c => !own.current.has(c.id)) };
          const lines = boardAnnouncements(baseline.current ? previous : null, remote);
          baseline.current = true;
          server.current = result.data; setBoard(result.data); succeeded = true;
          if (lines.length) announce(lines.join(". "));
        } else { announce(result.reason, true); succeeded = false; }
      } while (again.current);
      return succeeded;
    };
    pendingRead.current = read().finally(() => { pendingRead.current = null; });
    return pendingRead.current;
  }, [groupId, archived, announce]);
  const currentReads = useRef({ load, loadRequests });
  currentReads.current = { load, loadRequests };
  useEffect(() => {
    alive.current = true; const visit = ++generation.current; baseline.current = false;
    if (!enabled) return;
    // Wait for a superseded read to finish, then start this archive-filter read.
    void (pendingRead.current ?? Promise.resolve()).then(() => { if (alive.current && generation.current === visit) { void load(); void loadRequests(); } });
    const stop = projectEvents.subscribe(groupId, change => {
      const next = boardInvalidation(server.current, change);
      if (next.board) void load();
      if (next.requests) void loadRequests();
      if (change.replayGap) void refreshProject(groupId);
    });
    return () => { alive.current = false; generation.current++; stop(); };
  }, [groupId, enabled, load, loadRequests]);
  const write = useCallback(async (cardId: string, body: ProjectCardAction, announcement: string, target?: BoardTarget) => {
    if (writing.current) return false;
    writing.current = true; setBusy(true); own.current.add(cardId); setRefusal("");
    if (server.current) setBoard(target ? applyOptimistic(server.current, cardId, target) : applyOwnerOptimistic(server.current, cardId, body));
    try {
      const result = await projectClient.card(groupId, cardId, body);
      if (!alive.current || view.current.groupId !== groupId || !view.current.enabled) return false;
      if (!result.ok) {
        setBoard(server.current);
        const failure = boardWriteFailure(result.body, result.reason);
        if (failure.refetch) {
          const refreshed = await currentReads.current.load();
          announce(refreshed ? failure.line : "This changed. The board could not refresh; try again.", true);
        } else announce(failure.line, true);
        return false;
      }
      const refreshed = await currentReads.current.load();
      await currentReads.current.loadRequests();
      if (refreshed) announce(announcement);
      return true;
    } finally { own.current.delete(cardId); writing.current = false; if (alive.current) setBusy(false); }
  }, [groupId, load, loadRequests, announce]);
  const execute = useCallback((cardId: string, plan: MovePlan, target?: BoardTarget) => {
    if (!plan.ok) { announce(plan.reason, true); return Promise.resolve(false); }
    return write(cardId, plan.body, plan.announcement, target);
  }, [write, announce]);
  const getBoard = useCallback(() => server.current, []);
  return { board, requests, notice, refusal, busy, announce, load, write, execute, getBoard };
}
