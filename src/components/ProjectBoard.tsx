// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useStore, type Bot, type Group } from "@/state/store";
import { projectWriteReason, type ProjectBoardRead, type ProjectCard, type ProjectRead } from "@/lib/project-client";
import { boardColumns, boardLayout, cardColumn, cardFace, cardLane, cardsInColumn, filterCards, isCustomColumn, keyboardBoard, ownerActions, planLaneDrop, planMove, faceCacheKey, stateName, swimlanes, type BoardFilters, type BoardTarget, type CardFace, type KeyboardBoard, type MovePlan, type OwnerAction } from "@/lib/project-board";
import { useProjectBoard } from "@/lib/use-project-board";
import { useBoardPointer, type PointerDrop } from "@/lib/use-board-pointer";
import { ProjectBoardCard } from "./ProjectBoardCard";
import { ProjectCardSheet } from "./ProjectCardSheet";
import { ProjectCardForm, ProjectColumnsEditor } from "./ProjectBoardForms";
import { BOARD_BUTTON, BOARD_INPUT, ProjectBoardDialog } from "./ProjectBoardDialog";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { LazyFallback } from "./LazyFallback";
import "./project-board.css";
const GoalView = retryableLazy(() => import("./ProjectGoalView"));
export default function ProjectBoard({ group, members, project, initialBoard, initialSelectedCardId, boardEnabled = true }: { group: Group; members: Bot[]; project: ProjectRead | null; initialBoard?: ProjectBoardRead; initialSelectedCardId?: string; boardEnabled?: boolean }) {
  const { state } = useStore();
  const enabled = boardEnabled && state.config?.features?.projectsBoard !== false && project?.settings.parts.board !== false;
  const [filters, setFilters] = useState<BoardFilters>(() => initialSelectedCardId ? { showArchived: true } : {}), [byBot, setByBot] = useState(false), [phoneColumn, setPhoneColumn] = useState("todo");
  const [now, setNow] = useState(Date.now);
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedCardId ?? null), [create, setCreate] = useState(false), [editing, setEditing] = useState<string | null>(null), [columnsEditor, setColumnsEditor] = useState(false), [goalSheet, setGoalSheet] = useState(false);
  const [picker, setPicker] = useState<{ kind: "move" | "reassign"; cardId: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ cardId: string; plan: MovePlan; target?: BoardTarget } | null>(null);
  const [keyboard, setKeyboard] = useState<KeyboardBoard | null>(null);
  const viewport = useRef<HTMLDivElement>(null), focusAfter = useRef<string | null>(null);
  const data = useProjectBoard(group.id, !!filters.showArchived, enabled, initialBoard);
  const { board, requests, busy, announce, execute, getBoard } = data;
  const [moveFocusId, setMoveFocusId] = useState<string | null>(null);
  const layout = boardLayout(width), lanesEnabled = byBot && layout !== "phone";
  const readOnlyReason = projectWriteReason(project) ?? (board?.lifecycle === "closed" ? t("projects.common.closedNote") : board?.lifecycle === "ended" ? t("projects.common.nowChannel") : null);
  const readOnly = !!readOnlyReason;
  // Column names, lane names and card faces are built from the catalogue, so they are rebuilt when the language changes.
  const language = useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const columns = useMemo(() => board ? boardColumns(board, !!filters.showArchived) : [], [board, filters.showArchived, language]);
  const lanes = useMemo(() => swimlanes(members), [members, language]);
  const shown = useMemo(() => {
    if (!board) return null;
    const cards = filterCards(board.cards, filters);
    const focused = board.cards.find(c => c.id === moveFocusId);
    // Keep the moved card reachable until the next filter change, even when
    // its new state no longer matches Needs me or its previous assignee.
    if (focused && !cards.some(c => c.id === focused.id)) cards.push(focused);
    return { ...board, cards };
  }, [board, filters, moveFocusId]);
  const visibleColumns = layout === "phone" ? columns.filter(c => c.id === (columns.some(c => c.id === phoneColumn) ? phoneColumn : columns[0]?.id)) : columns;
  useEffect(() => { const resize = () => setWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const focusCard = useCallback((id: string) => {
    focusAfter.current = id;
    requestAnimationFrame(() => {
      const card = viewport.current?.querySelector<HTMLButtonElement>(`[data-board-card="${CSS.escape(id)}"]`);
      if (card) { card.focus(); card.scrollIntoView({ block: "nearest", inline: "nearest" }); focusAfter.current = null; }
    });
  }, []);
  useEffect(() => { if (focusAfter.current) focusCard(focusAfter.current); }, [board, phoneColumn, focusCard]);
  const finishMove = useCallback(async (id: string, plan: MovePlan, target?: BoardTarget) => {
    const ok = await execute(id, plan, target);
    const current = getBoard();
    const card = current?.cards.find(c => c.id === id);
    if (current && card) setPhoneColumn(cardColumn(current, card));
    focusCard(id);
    return ok;
  }, [execute, getBoard, focusCard]);
  const submitMove = useCallback((id: string, plan: MovePlan, target?: BoardTarget) => {
    setMoveFocusId(id);
    if (plan.ok && (plan.body.toState === "cancelled" || plan.body.action === "cancel")) setFilters(held => ({ ...held, showArchived: true }));
    if (plan.ok && plan.confirm) setConfirmation({ cardId: id, plan, target });
    else void finishMove(id, plan, target);
  }, [finishMove]);
  const drop = useCallback((id: string, hit: PointerDrop) => {
    if (!board || readOnly || busy) return;
    const ordered = cardsInColumn(board, hit.columnId).filter(c => c.id !== id);
    const index = hit.beforeId ? ordered.findIndex(c => c.id === hit.beforeId) : ordered.length;
    const target = { columnId: hit.columnId, index: Math.max(0, index) };
    const plan = lanesEnabled ? planLaneDrop(board, id, hit.lane, target, requests) : planMove(board, id, target, requests);
    submitMove(id, plan, plan.ok && ["move", "reorder"].includes(plan.body.action) ? target : undefined);
  }, [board, requests, readOnly, busy, lanesEnabled, submitMove]);
  const pointer = useBoardPointer(viewport, !readOnly && !busy && enabled && layout !== "phone", drop, id => { announce(t("projects.board.cancelled")); focusCard(id); });
  const open = useCallback((id: string) => { if (!pointer.suppressClick.current) setSelectedId(id); }, [pointer.suppressClick]);
  const action = useCallback((id: string, act: OwnerAction) => {
    if (!board || busy || readOnly) return;
    const card = board.cards.find(c => c.id === id); if (!card || !ownerActions(card, requests).includes(act)) return;
    if (act === "reassign") { setPicker({ kind: "reassign", cardId: id }); return; }
    if (act === "edit") { setEditing(id); return; }
    if (act === "send_back") { submitMove(id, planMove(board, id, { columnId: "todo", index: 0 }, requests), { columnId: "todo", index: 0 }); return; }
    const confirm = act === "done" && !card.ownerTookOver;
    const plan: MovePlan = { ok: true, body: { action: act, expectedRevision: card.revision, ...(confirm ? { confirm: true } : {}) }, confirm,
      announcement: act === "start" ? t("projects.board.queuedToStart",{number:card.number ?? ""}) : act === "take_over" ? t("projects.board.tookOver",{number:card.number ?? ""}) : t("projects.board.updated",{number:card.number ?? ""}) };
    submitMove(id, plan);
  }, [board, requests, busy, readOnly, submitMove]);
  const onKey = useCallback((event: KeyboardEvent<HTMLButtonElement>, card: ProjectCard) => {
    if (!board || readOnly || busy || ![" ", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    // Arrows are left to the browser until the owner picks up a card.
    if (!keyboard?.picked && (event.key.startsWith("Arrow") || event.key === "Escape")) return;
    event.preventDefault();
    const held = keyboard?.focusId === card.id ? keyboard : keyboardBoard(null, { type: "focus", cardId: card.id }, board, columns, lanesEnabled ? lanes : undefined, shown ?? board, requests);
    const next = keyboardBoard(held, { type: "key", key: event.key }, board, columns, lanesEnabled ? lanes : undefined, shown ?? board, requests);
    setKeyboard(next);
    if (next) {
      announce(next.announcement, next.drop?.ok === false);
      if (next.picked) { if (layout === "phone") setPhoneColumn(next.target.columnId); focusCard(card.id); }
      if (next.drop) submitMove(card.id, next.drop, next.drop.ok && ["move", "reorder"].includes(next.drop.body.action) ? next.target : undefined);
      if (event.key === "Escape") { setPhoneColumn(cardColumn(board, card)); focusCard(card.id); }
    }
  }, [board, requests, shown, readOnly, busy, keyboard, columns, lanesEnabled, lanes, announce, layout, submitMove, focusCard]);
  const faces = useRef(new Map<string, { revision: number; context: string; signature: string; face: CardFace }>());
  const faceContext = useMemo(() => faceCacheKey({ members, goal: project?.goal, requests, cards: board?.cards, now }, language), [members, project?.goal, requests, board, now, language]);
  const goalOpen = useCallback(() => setGoalSheet(true), []);
  const renderCard = (card: ProjectCard) => {
    const old = faces.current.get(card.id);
    const signature = `${card.assigneeBotId}:${card.ownerTookOver}:${card.usage?.workMs}:${card.usage?.tokens}:${card.usage?.tokensReported}`;
    const face = old?.revision === card.revision && old.context === faceContext && old.signature === signature ? old.face : cardFace(card, members, project?.goal ? [project.goal] : [], requests, board?.cards, now);
    faces.current.set(card.id, { revision: card.revision, context: faceContext, signature, face });
    return <ProjectBoardCard key={card.id} card={card} face={face} bot={members.find(m => m.id === face.avatarId)} readOnly={readOnly || busy} onOpen={open} onAction={action} onGoal={goalOpen} onKeyDown={onKey} onPointerDown={pointer.pointerDown} />;
  };
  useEffect(() => {
    const card = board?.cards.find(c => c.id === selectedId);
    if (board && card) setPhoneColumn(cardColumn(board, card));
  }, [selectedId, board]);
  const selected = board?.cards.find(c => c.id === selectedId), editCard = board?.cards.find(c => c.id === editing), pickerCard = board?.cards.find(c => c.id === picker?.cardId);
  if (!enabled) return <section className="p-4 text-sm text-ink">{t("projects.board.off")}</section>;
  return <section aria-label={t("projects.board.aria")} className="project-board flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-ink" data-layout={layout}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/30 p-3">
      <div role="group" aria-label={t("projects.board.viewAria")} className="flex gap-1"><button className={BOARD_BUTTON} aria-pressed={!lanesEnabled} onClick={() => setByBot(false)}>{t("projects.board.columns")}</button>{layout !== "phone" && <button className={BOARD_BUTTON} aria-pressed={lanesEnabled} onClick={() => setByBot(true)}>{t("projects.board.byBot")}</button>}</div>
      <label className="min-w-0 max-w-full text-xs">{t("projects.board.bot")}<select className={BOARD_INPUT} value={filters.bot ?? ""} onChange={e => { setMoveFocusId(null); setFilters({ ...filters, bot: e.target.value }); }}><option value="">{t("projects.board.allTeammates")}</option>{lanes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label className="min-w-0 max-w-full text-xs">{t("projects.common.goal")}<select className={BOARD_INPUT} value={filters.goal ?? ""} onChange={e => { setMoveFocusId(null); setFilters({ ...filters, goal: e.target.value }); }}><option value="">{t("projects.board.allGoals")}</option>{project?.goal && <option value={project.goal.id}>{project.goal.title}</option>}</select></label>
      {([['needsMe', t("projects.board.needsMe")], ['blocked', t("projects.board.blocked")], ['showArchived', t("projects.board.showArchived")]] as const).map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-2 px-1 text-sm"><input type="checkbox" checked={!!filters[key]} onChange={e => { setMoveFocusId(null); setFilters({ ...filters, [key]: e.target.checked }); }} />{label}</label>)}
      {!readOnly && <><button className={BOARD_BUTTON} disabled={!board} onClick={() => setCreate(true)}>{t("projects.board.newCard")}</button>{layout !== "phone" && <button className={BOARD_BUTTON} disabled={!board} onClick={() => setColumnsEditor(true)}>{t("projects.board.editColumns")}</button>}</>}
      {project?.goal && <button className={`${BOARD_BUTTON} max-w-full break-words`} onClick={goalOpen}>{t("projects.common.goalTitled",{title:project.goal.title})}</button>}
    </div>
    <p id="board-drag-instructions" className="sr-only">{t("projects.board.dragInstructions")}</p>
    {readOnlyReason && <p className="px-3 py-2 text-sm">{readOnlyReason}</p>}
    <p role="status" aria-live="polite" aria-atomic="true" className="px-3 text-sm">{data.refusal ? "" : data.notice}</p>
    <p role="alert" aria-live="assertive" aria-atomic="true" className="px-3 text-sm">{data.refusal}</p>
    {layout === "phone" && board && <label className="block p-3 text-sm">{t("projects.board.column")}<select aria-label={t("projects.board.columnPicker")} className={BOARD_INPUT} value={visibleColumns[0]?.id ?? "todo"} onChange={e => setPhoneColumn(e.target.value)}>{columns.map(c => <option key={c.id} value={c.id}>{c.title} ({cardsInColumn(shown!, c.id).length})</option>)}</select></label>}
    {!board && <p className="p-4 text-sm">{data.notice || t("projects.board.loading")}</p>}
    <div ref={viewport} className="project-board-scroll min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3" role="region" aria-label={t("projects.board.columnsRegion")}>
      {shown && (lanesEnabled ? lanes : [{ id: "", name: "" }]).map(lane => <div key={lane.id} className="project-board-lane" data-board-lane={lane.id}>
        {lanesEnabled && <h2 className="sticky left-0 mb-2 break-words text-sm font-semibold">{lane.name}</h2>}
        <div className="project-board-columns">{visibleColumns.map(column => {
          const cards = cardsInColumn(shown, column.id).filter(c => (!lanesEnabled || cardLane(c) === lane.id) && (!keyboard?.picked || c.id !== keyboard.focusId));
          if (keyboard?.picked && keyboard.target.columnId === column.id && (!lanesEnabled || keyboard.lane === lane.id)) {
            const picked = board!.cards.find(c => c.id === keyboard.focusId);
            if (picked) cards.splice(Math.min(cards.length, keyboard.target.index), 0, picked);
          }
          const pointerTarget = pointer.drag?.target;
          const placeholder = pointerTarget?.columnId === column.id && (!lanesEnabled || pointerTarget.lane === lane.id) ? pointerTarget.beforeId ? cards.findIndex(c => c.id === pointerTarget.beforeId) : cards.length : keyboard?.picked && keyboard.target.columnId === column.id && (!lanesEnabled || keyboard.lane === lane.id) ? keyboard.target.index : -1;
          return <section key={column.id} className="project-board-column rounded-lg border border-hairline/30 bg-raised/40" aria-label={`${column.title}${lane.name ? `, ${lane.name}` : ""}`}>
            <h3 className="flex min-w-0 items-start justify-between gap-2 p-3 text-sm font-semibold"><span className="min-w-0 break-words">{column.title}{isCustomColumn(column.id) && <small className="block font-normal text-ink-secondary">({stateName(column.state)})</small>}</span><span aria-label={t("projects.board.cardCount",{count:cards.length})}>{cards.length}</span></h3>
            <div className="project-board-cell space-y-2 p-2 pt-0" data-board-cell={`${lane.id}:${column.id}`} data-column-id={column.id} data-lane={lane.id}>
              {cards.map((card, index) => <div key={card.id}>{placeholder === index && <div className="project-board-placeholder" aria-hidden="true" />}{renderCard(card)}</div>)}
              {placeholder >= cards.length && <div className="project-board-placeholder" aria-hidden="true" />}
              {!cards.length && <p className="p-3 text-xs text-ink-secondary">{t("projects.board.noCards")}</p>}
            </div>
          </section>;
        })}</div>
      </div>)}
    </div>
    {pointer.drag && <div aria-hidden="true" className="project-board-floating rounded-lg border border-hairline bg-card p-3 text-sm" style={{ transform: `translate(${pointer.drag.x + 12}px, ${pointer.drag.y + 12}px)` }}><span className="block text-xs text-ink-secondary">{pointer.drag.card.ownerTookOver ? t("projects.board.you") : members.find(m => m.id === pointer.drag!.card.assigneeBotId)?.name ?? t("projects.board.unassigned")}</span><span className="block font-medium">{pointer.drag.card.title}</span><span className="block text-xs">#{pointer.drag.card.number} · {stateName(pointer.drag.card.state)}</span></div>}
    {selected && board && project && <ProjectCardSheet groupId={group.id} card={selected} board={board} project={project} members={members} requests={requests} readOnly={readOnly} busy={busy} onClose={() => { setSelectedId(null); focusCard(selected.id); }} onAction={action} onMove={() => setPicker({ kind: "move", cardId: selected.id })} onGoal={goalOpen} notice={data.notice} refusal={data.refusal} />}
    {!readOnly && (create || editCard) && board && project && <ProjectCardForm key={editCard?.id ?? "new"} groupId={group.id} project={project} board={board} members={members} card={editCard} onClose={() => { setCreate(false); setEditing(null); }} onSaved={data.load} onEdit={body => data.write(editCard!.id, body, t("projects.board.cardSaved"))} onNotice={announce} />}
    {!readOnly && columnsEditor && board && <ProjectColumnsEditor groupId={group.id} board={board} onClose={() => setColumnsEditor(false)} onSaved={data.load} onNotice={announce} />}
    {!readOnly && picker && pickerCard && board && <ProjectBoardDialog bottom title={picker.kind === "move" ? t("projects.sheet.moveTo") : t("projects.common.reassign")} onClose={() => setPicker(null)}><div className="flex flex-col gap-2">
      {(picker.kind === "move" ? columns.map(c => ({ id: c.id, name: c.title })) : members).map(option => <button className={`${BOARD_BUTTON} break-words text-left`} key={option.id} disabled={busy} onClick={() => {
        const target = { columnId: picker.kind === "move" ? option.id : cardColumn(board, pickerCard), index: cardsInColumn(board, option.id).filter(c => c.id !== pickerCard.id).length };
        const plan = picker.kind === "move" ? planMove(board, pickerCard.id, target, requests) : planLaneDrop(board, pickerCard.id, option.id, target, requests);
        setPicker(null); setSelectedId(null); submitMove(pickerCard.id, plan, picker.kind === "move" ? target : undefined);
      }}>{option.name}</button>)}
    </div></ProjectBoardDialog>}
    {!readOnly && confirmation && <ProjectBoardDialog title={t("projects.common.doneWithoutReview")} onClose={() => { focusCard(confirmation.cardId); setConfirmation(null); }}><p>{t("projects.board.confirmDone")}</p><div className="flex gap-2"><button className={BOARD_BUTTON} disabled={busy} onClick={() => { const choice = confirmation; setConfirmation(null); void finishMove(choice.cardId, choice.plan, choice.target); }}>{t("projects.common.doneWithoutReview")}</button><button className={BOARD_BUTTON} onClick={() => { focusCard(confirmation.cardId); setConfirmation(null); }}>{t("projects.board.keepWorking")}</button></div></ProjectBoardDialog>}
    {goalSheet && project?.goal && <ProjectBoardDialog side title={t("projects.common.goal")} onClose={() => setGoalSheet(false)}><LazyBoundary inline onRetry={GoalView.retry}><Suspense fallback={<LazyFallback />}><GoalView.Component group={group} members={members} project={project} onNavigate={() => { setGoalSheet(false); setSelectedId(null); }} onCard={id => { setGoalSheet(false); setFilters(held => ({ ...held, showArchived: true })); setSelectedId(id); }} /></Suspense></LazyBoundary></ProjectBoardDialog>}
  </section>;
}
