// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { ProjectBoardRead, ProjectCard, ProjectCardAction, ProjectColumn, ProjectErrorBody, ProjectGoal, RoomRequest } from "./project-client";
import type { ProjectInvalidation } from "./project-events";
import { localeCode, t } from "./i18n";
/** The English names. Ids and membership checks use these; what a person reads goes through stateName. */
export const stateNames: Record<ProjectCard["state"], string> = { todo: "To do", doing: "In progress", waiting: "Waiting", review: "In review", done: "Done", failed: "Failed", cancelled: "Archived" };
/** A card state in the language in effect now. Unknown states come back as they are. */
export const stateName = (state: string): string => Object.hasOwn(stateNames, state) ? t(`projects.state.${state as ProjectCard["state"]}`) : state;
const canonical = ["todo", "doing", "waiting", "review", "done"];
export const isCustomColumn = (id: string) => !canonical.includes(id) && id !== "archived";
export type BoardMember = { id: string; name: string };
export type BoardTarget = { columnId: string; index: number };
export type MovePlan = { ok: false; reason: string } | { ok: true; body: ProjectCardAction; confirm: boolean; announcement: string };
export interface BoardFilters { bot?: string; goal?: string; needsMe?: boolean; blocked?: boolean; showArchived?: boolean }
export function boardColumns(board: ProjectBoardRead, archived = false): ProjectColumn[] {
  const columns = [...board.columns];
  for (const [position, id] of canonical.entries()) if (!columns.some(c => c.id === id)) columns.push({ id, state: id, title: stateName(id), position });
  columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return archived ? [...columns, { id: "archived", state: "cancelled", title: stateName("cancelled"), position: Infinity }] : columns;
}
export function cardColumn(board: ProjectBoardRead, card: ProjectCard): string {
  if (card.state === "cancelled") return "archived";
  const column = board.columns.find(c => c.id === card.columnId && c.state === card.state);
  return column?.id ?? (card.state === "failed" ? "waiting" : card.state);
}
export function cardsInColumn(board: ProjectBoardRead, id: string): ProjectCard[] {
  return board.cards.filter(card => cardColumn(board, card) === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.number ?? 0) - (b.number ?? 0));
}
export const cardLane = (card: ProjectCard) => card.ownerTookOver ? "you" : card.assigneeBotId ?? "unassigned";
export function isLiveWait(card: ProjectCard): boolean {
  return card.state === "waiting" && ["owner_approval", "writer_root", "ask", "blocked"].includes(card.waitingOn?.kind ?? "") && !(card.waitingOn?.kind === "blocked" && !card.requestId);
}
export function filterCards(cards: ProjectCard[], filters: BoardFilters): ProjectCard[] {
  return cards.filter(card => {
    if (!filters.showArchived && card.state === "cancelled") return false;
    if (filters.bot && cardLane(card) !== filters.bot) return false;
    if (filters.goal && card.goalId !== filters.goal) return false;
    // The read does not identify an owner-only review. Review alone is not a
    // decision, so needs-me covers failed cards and the four explicit waits.
    if (filters.needsMe && !(card.state === "failed" || card.state === "waiting" && ["owner_approval", "restart", "stopped", "owner"].includes(card.waitingOn?.kind ?? ""))) return false;
    if (filters.blocked && !(card.state === "waiting" && ["blocked", "dependency", "writer_root", "engine_problem"].includes(card.waitingOn?.kind ?? "") || card.state === "todo" && card.waitingOn?.kind === "dependency")) return false;
    return true;
  });
}
export function workTime(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  return min < 60 ? t("projects.time.min", { n: min }) : min % 60 ? t("projects.time.hoursMin", { h: Math.floor(min / 60), m: min % 60 }) : t("projects.time.hours", { n: Math.floor(min / 60) });
}
const queuedCardRun = (card: ProjectCard, requests: readonly RoomRequest[]) => requests.some(r => r.state === "queued" && (r.workItemId === card.id || r.id === card.requestId));
export function cardFace(card: ProjectCard, members: readonly BoardMember[], goals: readonly ProjectGoal[] = [], requests: readonly RoomRequest[] = [], cards: readonly ProjectCard[] = [], now = Date.now()) {
  const bot = members.find(b => b.id === card.assigneeBotId);
  const elapsed = Math.max(0, now - (card.createdAt ?? now));
  const pastDue = card.dueAt != null && card.dueAt < now;
  const time = card.dueAt != null ? pastDue ? t("projects.common.pastDue") : t("projects.face.due", { day: new Intl.DateTimeFormat(localeCode(), { weekday: "short" }).format(card.dueAt) })
    : elapsed >= 86400000 ? t("projects.time.days", { n: Math.floor(elapsed / 86400000) }) : elapsed >= 3600000 ? t("projects.time.hours", { n: Math.floor(elapsed / 3600000) }) : t("projects.time.min", { n: Math.floor(elapsed / 60000) });
  const dependencies = (card.dependsOn ?? []).map(id => cards.find(c => c.id === id)).filter(c => c && c.state !== "done");
  // an open card of a paused goal waits on the goal: say so, and how to go on
  const goalPaused = goals.find(g => g.id === card.goalId)?.state === "paused" && ["todo", "doing", "waiting", "review"].includes(card.state);
  return {
    title: card.title, assignee: card.ownerTookOver ? t("projects.face.you") : bot?.name ?? t("projects.face.unassigned"), avatarId: card.ownerTookOver ? null : bot?.id ?? null,
    state: stateName(card.state), goalTitle: goals.find(g => g.id === card.goalId)?.title ?? null, goalId: card.goalId ?? null, time,
    work: workTime(card.usage?.workMs ?? 0), tokens: card.usage?.tokensReported ? t("projects.face.tokens", { count: card.usage.tokens.toLocaleString(localeCode()) }) : null,
    reason: card.waitingOn?.detail || (goalPaused ? t("projects.face.goalPaused") : card.reason) || null, review: card.state === "review" || !!card.reviewRequestId,
    depends: card.dependsOn?.length ?? 0, queued: card.state === "todo" && queuedCardRun(card, requests),
    dependency: card.waitingOn?.kind === "dependency" ? dependencies.length ? t("projects.face.waitingCards", { numbers: dependencies.map(c => c!.number).join(", ") }) : t("projects.face.waitingDependency") : null,
    failed: card.state === "failed", pastDue,
  };
}
export type CardFace = ReturnType<typeof cardFace>;
/** What a cached card face was built from. The language version is part of it, so a language switch rebuilds every face. */
export function faceCacheKey(inputs: { members: readonly BoardMember[]; goal?: ProjectGoal | null; requests: readonly RoomRequest[]; cards?: readonly ProjectCard[]; now: number }, language: number): string {
  return JSON.stringify([inputs.members.map(m => [m.id, m.name]), inputs.goal, inputs.requests.map(r => [r.id, r.state, r.workItemId]), inputs.cards?.map(c => [c.id, c.number, c.state]), Math.floor(inputs.now / 60000), language]);
}
export function planMove(board: ProjectBoardRead, cardId: string, target: BoardTarget, requests: readonly RoomRequest[] = []): MovePlan {
  const card = board.cards.find(c => c.id === cardId);
  const column = boardColumns(board, true).find(c => c.id === target.columnId);
  if (!card || !column) return { ok: false, reason: t("projects.move.gone") };
  if (board.lifecycle !== "open") return { ok: false, reason: board.lifecycle === "closed" ? t("projects.common.closedNote") : t("projects.common.nowChannel") };
  // Failed cards are displayed in Waiting but keep their failed state when
  // reordered there. A custom Waiting column cannot hold a failed card.
  const destination = column.id === "waiting" && card.state === "failed" ? "failed" : column.state as ProjectCard["state"];
  const same = destination === card.state;
  let confirm = false;
  if (!same) {
    let allowed = false;
    if (destination === "todo") allowed = ["review", "done", "cancelled"].includes(card.state) || (card.state === "failed" || card.state === "waiting" && !isLiveWait(card)) && !!card.assigneeBotId;
    if (destination === "doing") allowed = card.state === "todo" && !!card.assigneeBotId && !card.requestId && !queuedCardRun(card, requests);
    if (destination === "done") { allowed = card.state === "review" || card.state === "doing" && !!card.ownerTookOver || ["todo", "waiting", "failed"].includes(card.state); confirm = allowed && card.state !== "review" && !card.ownerTookOver; }
    if (destination === "cancelled") allowed = !["done", "cancelled"].includes(card.state);
    if (!allowed) return { ok: false, reason: isLiveWait(card) && destination === "todo" ? t("projects.move.answerFirst") : destination === "doing" && !card.assigneeBotId ? t("projects.move.pickTeammate") : t("projects.move.cannotMove", { number: card.number ?? "", state: stateName(destination) }) };
  }
  const others = !same && destination === "doing" ? [] : cardsInColumn(board, column.id).filter(c => c.id !== cardId);
  const index = Math.max(0, Math.min(others.length, target.index));
  const body: ProjectCardAction = { action: same ? "reorder" : "move", expectedRevision: card.revision, toState: destination, columnId: !same && destination === "doing" ? null : isCustomColumn(column.id) ? column.id : null,
    ...(others[index] ? { beforeCardId: others[index].id } : {}), ...(others[index - 1] ? { afterCardId: others[index - 1].id } : {}), ...(confirm ? { confirm: true } : {}) };
  return { ok: true, body, confirm, announcement: !same && destination === "doing" ? t("projects.move.queued", { number: card.number ?? "" }) : t("projects.move.moved", { number: card.number ?? "", title: column.title }) };
}
export function applyOptimistic(board: ProjectBoardRead, cardId: string, target: BoardTarget): ProjectBoardRead {
  const plan = planMove(board, cardId, target);
  if (!plan.ok) return board;
  const before = board.cards.find(c => c.id === plan.body.beforeCardId)?.position;
  const after = board.cards.find(c => c.id === plan.body.afterCardId)?.position;
  const position = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before - 1024 : after !== undefined ? after + 1024 : 0;
  return { ...board, cards: board.cards.map(card => card.id !== cardId ? card : plan.body.toState === "doing" && card.state === "todo" ? card : { ...card, state: plan.body.toState ?? card.state, columnId: plan.body.columnId, position }) };
}
export function applyOwnerOptimistic(board: ProjectBoardRead, id: string, action: ProjectCardAction): ProjectBoardRead {
  if (action.action !== "reassign" && action.action !== "take_over") return board;
  return { ...board, cards: board.cards.map(card => card.id === id ? { ...card,
    state: action.action === "reassign" ? "todo" : "doing", columnId: null,
    assigneeBotId: action.action === "reassign" ? action.assigneeBotId : null,
    ownerTookOver: action.action === "take_over", requestId: null, reviewRequestId: null, waitingOn: null, reason: null,
  } : card) };
}
export const revertOptimistic = (previous: ProjectBoardRead) => previous;
export function boardWriteFailure(body?: ProjectErrorBody, fallback = t("projects.client.couldNot")) {
  return body?.error === "changed" ? { refetch: true, line: t("projects.boardNote.changed") }
    : { refetch: false, line: body && "reason" in body && typeof body.reason === "string" ? body.reason : fallback };
}
export function boardInvalidation(board: ProjectBoardRead | null, change: ProjectInvalidation) {
  return { board: !!change.replayGap || change.board && (!board || change.cards.some(c => c.deleted || c.revision > (board.cards.find(old => old.id === c.id)?.revision ?? -1)) || (change.columnsRevision ?? -1) > board.columnsRevision),
    requests: !!change.replayGap || change.requests, project: !!change.replayGap || change.strip };
}
export function boardAnnouncements(old: ProjectBoardRead | null, next: ProjectBoardRead, own = false): string[] {
  if (!old || own) return [];
  const changes = next.cards.flatMap(card => {
    const previous = old.cards.find(c => c.id === card.id);
    if (!previous) return [t("projects.boardNote.added", { number: card.number ?? "" })];
    if (previous.state !== card.state || cardColumn(old, previous) !== cardColumn(next, card)) return [t("projects.boardNote.movedTitled", { title: card.title, column: boardColumns(next, true).find(c => c.id === cardColumn(next, card))?.title ?? "" })];
    if (cardLane(previous) !== cardLane(card)) return [t("projects.boardNote.reassigned", { number: card.number ?? "" })];
    return [];
  });
  return [...changes.slice(0, 3), ...(changes.length > 3 ? [t("projects.boardNote.more", { count: changes.length - 3 })] : [])];
}
export const swimlanes = (members: readonly BoardMember[]) => [...members].sort((a, b) => a.name.localeCompare(b.name)).concat([{ id: "unassigned", name: t("projects.face.unassigned") }, { id: "you", name: t("projects.face.you") }]);
export function planLaneDrop(board: ProjectBoardRead, cardId: string, lane: string, target: BoardTarget, requests: readonly RoomRequest[] = []): MovePlan {
  const card = board.cards.find(c => c.id === cardId);
  if (!card) return { ok: false, reason: t("projects.lane.noCard") };
  if (cardLane(card) === lane) return planMove(board, cardId, target, requests);
  if (lane === "unassigned") return { ok: false, reason: t("projects.lane.pickTeammate") };
  if (board.lifecycle !== "open" || ["done", "cancelled"].includes(card.state)) return { ok: false, reason: t("projects.lane.reopenFirst") };
  return { ok: true, confirm: false, body: { expectedRevision: card.revision, ...(lane === "you" ? { action: "take_over" as const } : { action: "reassign" as const, assigneeBotId: lane }) }, announcement: lane === "you" ? t("projects.board.tookOver", { number: card.number ?? "" }) : t("projects.lane.reassigned", { number: card.number ?? "", state: stateName("todo") }) };
}
export interface KeyboardBoard { focusId: string; picked: boolean; target: BoardTarget; lane: string; announcement: string; drop: MovePlan | null }
export function keyboardBoard(held: KeyboardBoard | null, event: { type: "focus"; cardId: string } | { type: "key"; key: string }, board: ProjectBoardRead, columns: ProjectColumn[], lanes?: BoardMember[], shown: ProjectBoardRead = board, requests: readonly RoomRequest[] = []): KeyboardBoard | null {
  const visibleCards = (columnId: string, lane: string) => cardsInColumn(shown, columnId).filter(c => !lanes || cardLane(c) === lane);
  if (event.type === "focus") {
    if (held?.picked) return held;
    const c = board.cards.find(c => c.id === event.cardId); if (!c) return null;
    const columnId = cardColumn(board, c);
    return { focusId: c.id, picked: false, target: { columnId, index: Math.max(0, visibleCards(columnId, cardLane(c)).findIndex(x => x.id === c.id)) }, lane: cardLane(c), announcement: "", drop: null };
  }
  if (!held) return null;
  const card = board.cards.find(c => c.id === held.focusId); if (!card) return null;
  if (event.key === "Escape") return { ...keyboardBoard(null, { type: "focus", cardId: card.id }, board, columns, lanes, shown, requests)!, announcement: held.picked ? t("projects.kb.cancelled", { number: card.number ?? "" }) : "", drop: null };
  if (event.key === " " || event.key === "Enter") {
    if (!held.picked) return { ...keyboardBoard(null, { type: "focus", cardId: card.id }, board, columns, lanes, shown, requests)!, picked: true, drop: null, announcement: t("projects.kb.picked", { number: card.number ?? "", title: card.title }) };
    // The preview index belongs to the filtered cell. Resolve its next visible
    // card against the full column, exactly as a pointer drop does.
    const before = visibleCards(held.target.columnId, held.lane).filter(c => c.id !== card.id)[held.target.index];
    const ordered = cardsInColumn(board, held.target.columnId).filter(c => c.id !== card.id);
    const target = { ...held.target, index: before ? ordered.findIndex(c => c.id === before.id) : ordered.length };
    const drop = lanes ? planLaneDrop(board, card.id, held.lane, target, requests) : planMove(board, card.id, target, requests);
    return { ...held, target, picked: false, drop, announcement: drop.ok ? drop.announcement : drop.reason };
  }
  if (!held.picked) return held;
  const visible = columns.filter(c => c.id !== "archived");
  let target = { ...held.target }, lane = held.lane;
  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    const index = Math.max(0, Math.min(visible.length - 1, visible.findIndex(c => c.id === target.columnId) + (event.key === "ArrowRight" ? 1 : -1)));
    target = { columnId: visible[index]?.id ?? target.columnId, index: 0 };
  } else if (["ArrowUp", "ArrowDown"].includes(event.key)) {
    const delta = event.key === "ArrowDown" ? 1 : -1;
    if (lanes) lane = lanes[Math.max(0, Math.min(lanes.length - 1, lanes.findIndex(l => l.id === lane) + delta))]?.id ?? lane;
    else target.index = Math.max(0, Math.min(visibleCards(target.columnId, lane).filter(c => c.id !== card.id).length, target.index + delta));
  }
  return { ...held, target, lane, drop: null, announcement: lanes ? t("projects.kb.positionLane", { column: columns.find(c => c.id === target.columnId)?.title ?? target.columnId, position: target.index + 1, lane: lanes.find(l => l.id === lane)?.name ?? "" }) : t("projects.kb.position", { column: columns.find(c => c.id === target.columnId)?.title ?? target.columnId, position: target.index + 1 }) };
}
export const boardLayout = (width: number): "phone" | "two" | "wide" => width < 640 ? "phone" : width < 1024 ? "two" : "wide";
export type OwnerAction = ProjectCardAction["action"] | "send_back";
export function ownerActions(card: ProjectCard, requests: readonly RoomRequest[] = []): OwnerAction[] {
  if (card.state === "cancelled") return ["restore"];
  if (card.state === "done") return ["reopen"];
  const actions: OwnerAction[] = [];
  if (card.state === "todo" && card.assigneeBotId && !card.requestId && !queuedCardRun(card, requests)) actions.push("start");
  actions.push("reassign");
  if (!card.ownerTookOver) actions.push("take_over");
  if (card.assigneeBotId && (card.state === "failed" || card.state === "waiting" && !isLiveWait(card))) actions.push("retry");
  if ((card.state === "doing" && !card.ownerTookOver || isLiveWait(card)) && card.requestId) actions.push("interrupt");
  if (card.state === "doing" && card.ownerTookOver || ["todo", "waiting", "failed"].includes(card.state)) actions.push("done");
  if (card.state === "review") actions.push("accept", "send_back");
  actions.push("cancel");
  if (card.state === "todo" || card.state === "waiting" && !isLiveWait(card)) actions.push("edit");
  return actions;
}
export type ColumnEdit = { type: "add"; id: string; title: string; state: string } | { type: "rename"; id: string; title: string } | { type: "delete"; id: string } | { type: "reorder"; id: string; index: number };
export function columnsBody(board: ProjectBoardRead, columns: ProjectColumn[]): { ok: false; reason: string } | { ok: true; body: { expectedRevision: number; columns: ProjectColumn[] } } {
  if (columns.length > 12) return { ok: false, reason: t("projects.colErr.max") };
  const ids = new Set<string>();
  for (const col of columns) {
    if (!isCustomColumn(col.id) || !/^[\w-]+$/.test(col.id) || ids.has(col.id)) return { ok: false, reason: t("projects.colErr.distinct") };
    ids.add(col.id);
    if (!col.title.trim() || col.title.trim().length > 40) return { ok: false, reason: t("projects.colErr.title") };
    if (!canonical.includes(col.state) || !Number.isFinite(col.position)) return { ok: false, reason: t("projects.colErr.state") };
    const held = board.columns.find(c => c.id === col.id);
    if (held && held.state !== col.state) return { ok: false, reason: t("projects.colErr.stateLocked") };
  }
  return { ok: true, body: { expectedRevision: board.columnsRevision, columns: columns.map(c => ({ id: c.id, title: c.title.trim(), state: c.state, position: c.position })) } };
}
export function editColumns(columns: ProjectColumn[], edit: ColumnEdit, board: ProjectBoardRead): { ok: false; reason: string } | { ok: true; columns: ProjectColumn[]; displaced: number } {
  let next = columns.map(c => ({ ...c })); let displaced = 0;
  if (edit.type === "add") next.push({ id: edit.id, title: edit.title, state: edit.state, position: Math.max(4, ...next.map(c => c.position)) + 1 });
  else if (edit.type === "rename") next = next.map(c => c.id === edit.id ? { ...c, title: edit.title } : c);
  else if (edit.type === "delete") { next = next.filter(c => c.id !== edit.id); displaced = board.cards.filter(c => c.columnId === edit.id).length; }
  else {
    const index = next.findIndex(c => c.id === edit.id);
    if (index >= 0) { const [col] = next.splice(index, 1); next.splice(Math.max(0, Math.min(next.length, edit.index)), 0, col); next = next.map((c, i) => ({ ...c, position: i + 5 })); }
  }
  const result = columnsBody(board, next);
  return result.ok ? { ok: true, columns: result.body.columns, displaced } : result;
}
