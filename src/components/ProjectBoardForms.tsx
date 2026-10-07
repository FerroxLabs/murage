// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useRef, useState } from "react";
import type { ProjectBoardRead, ProjectCard, ProjectCardAction, ProjectRead } from "@/lib/project-client";
import { boardColumns, columnsBody, editColumns, isCustomColumn, stateName, type BoardMember, type ColumnEdit } from "@/lib/project-board";
import { projectClient } from "@/lib/use-project";
import { BOARD_BUTTON, BOARD_INPUT, ProjectBoardDialog } from "./ProjectBoardDialog";
export function ProjectCardForm({ groupId, project, board, members, card, onClose, onSaved, onEdit, onNotice }: {
  groupId: string; project: ProjectRead; board: ProjectBoardRead; members: BoardMember[]; card?: ProjectCard;
  onClose: () => void; onSaved: () => Promise<unknown>; onEdit: (body: ProjectCardAction) => Promise<boolean>; onNotice: (line: string, error?: boolean) => void;
}) {
  const [clientId] = useState(() => crypto.randomUUID());
  const [expectedRevision] = useState(card?.revision ?? 0);
  const [title, setTitle] = useState(card?.title ?? ""), [description, setDescription] = useState(card?.description ?? "");
  const [assignee, setAssignee] = useState(card?.assigneeBotId ?? ""), [column, setColumn] = useState("todo");
  const [goalId, setGoalId] = useState(card?.goalId ?? (project.goal && !["done", "stopped", "failed"].includes(project.goal.state) ? project.goal.id : ""));
  const [writes, setWrites] = useState(card?.writes !== false), [root, setRoot] = useState(String(card?.workRootIndex ?? ""));
  const [initialDue] = useState(() => {
    if (card?.dueAt == null) return "";
    const date = new Date(card.dueAt);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  const [due, setDue] = useState(initialDue);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const sending = useRef(false);
  const submit = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const dueAt = due ? new Date(`${due}T12:00:00`).getTime() : null;
      if (card) {
        if (await onEdit({ action: "edit", expectedRevision, title: title.trim(), description, writes, ...(due !== initialDue ? { dueAt } : {}), workRoot: root === "" ? null : Number(root) })) onClose();
        else setError(t("projects.cardForm.notSaved"));
      } else {
        const result = await projectClient.createCard(groupId, { clientId, title: title.trim(), description, writes, ...(assignee ? { assigneeBotId: assignee } : {}), ...(goalId ? { goalId } : {}), ...(column !== "todo" ? { columnId: column } : {}), ...(dueAt !== null ? { dueAt } : {}), ...(root !== "" ? { workRoot: Number(root) } : {}) });
        if (result.ok) { await onSaved(); onNotice(t("projects.cardForm.added",{number:result.data.card.number ?? ""})); onClose(); }
        else setError(result.reason);
      }
    } finally { sending.current = false; setBusy(false); }
  };
  return <ProjectBoardDialog title={card ? t("projects.cardForm.edit",{number:card.number ?? ""}) : t("projects.cardForm.new")} onClose={onClose}>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="block">{t("projects.cardForm.title")}<input autoFocus required minLength={1} maxLength={120} className={BOARD_INPUT} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="block">{t("projects.common.description")}<textarea maxLength={2000} rows={4} className={BOARD_INPUT} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {!card && <><label className="block">{t("projects.cardForm.assignee")}<select className={BOARD_INPUT} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">{t("projects.cardForm.unassigned")}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="block">{t("projects.cardForm.goal")}<select className={BOARD_INPUT} value={goalId} onChange={e => setGoalId(e.target.value)}><option value="">{t("projects.cardForm.noGoal")}</option>{project.goal && !["done", "stopped", "failed"].includes(project.goal.state) && <option value={project.goal.id}>{project.goal.title}</option>}</select></label>
        <label className="block">{t("projects.cardForm.column")}<select className={BOARD_INPUT} value={column} onChange={e => setColumn(e.target.value)}>{boardColumns(board).filter(c => c.state === "todo").map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label></>}
      <label className="block">{t("projects.cardForm.dueDate")}<input type="date" className={BOARD_INPUT} value={due} onChange={e => setDue(e.target.value)} /></label>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={writes} onChange={e => setWrites(e.target.checked)} />{t("projects.cardForm.mayChange")}</label>
      <label className="block">{t("projects.cardForm.workFolder")}<select className={BOARD_INPUT} value={root} onChange={e => setRoot(e.target.value)}><option value="">{t("projects.cardForm.deskFolder")}</option>{project.settings.workRoots?.map((r, i) => <option key={r.path} value={i}>{r.label || r.path}</option>)}</select></label>
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy || !title.trim()} className={BOARD_BUTTON}>{busy ? t("projects.cardForm.saving") : card ? t("projects.cardForm.save") : t("projects.cardForm.create")}</button>
    </form>
  </ProjectBoardDialog>;
}
export function ProjectColumnsEditor({ groupId, board, onClose, onSaved, onNotice }: { groupId: string; board: ProjectBoardRead; onClose: () => void; onSaved: () => Promise<unknown>; onNotice: (line: string, error?: boolean) => void }) {
  // Hold the opening revision. A concurrent board update must never silently
  // rebase an owner's unsaved edit onto a newer revision.
  const [base] = useState(board);
  const [columns, setColumns] = useState(() => boardColumns(board).filter(c => isCustomColumn(c.id)));
  const [title, setTitle] = useState(""), [state, setState] = useState("todo"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState<{ id: string; count: number } | null>(null);
  const sending = useRef(false);
  const edit = (action: ColumnEdit) => {
    const result = editColumns(columns, action, base);
    if (result.ok) { setColumns(result.columns); setError(""); } else setError(result.reason);
  };
  const save = async () => {
    const planned = columnsBody(base, columns);
    if (!planned.ok) { setError(planned.reason); return; }
    if (sending.current) return; sending.current = true; setBusy(true);
    try {
      const result = await projectClient.columns(groupId, planned.body);
      if (result.ok) { await onSaved(); onNotice(t("projects.columns.saved")); onClose(); }
      else if (result.body?.error === "changed") {
        await onSaved(); const line = t("projects.columns.changed"); onNotice(line, true); onClose();
      } else { setError(result.reason); onNotice(result.reason, true); }
    } finally { sending.current = false; setBusy(false); }
  };
  return <ProjectBoardDialog title={t("projects.columns.title")} onClose={onClose}>
    <p className="text-sm text-ink-secondary">{t("projects.columns.hint")}</p>
    {columns.map((col, index) => <fieldset key={col.id} className="space-y-2 rounded-lg border border-hairline/40 p-3"><legend>{col.title || t("projects.columns.fallbackTitle")} ({stateName(col.state)})</legend>
      <label className="block">{t("projects.columns.columnTitle")}<input className={BOARD_INPUT} maxLength={40} value={col.title} onChange={e => setColumns(columns.map(c => c.id === col.id ? { ...c, title: e.target.value } : c))} /></label>
      <div className="flex flex-wrap gap-2"><button className={BOARD_BUTTON} disabled={index === 0} onClick={() => edit({ type: "reorder", id: col.id, index: index - 1 })}>{t("projects.columns.moveLeft")}</button><button className={BOARD_BUTTON} disabled={index === columns.length - 1} onClick={() => edit({ type: "reorder", id: col.id, index: index + 1 })}>{t("projects.columns.moveRight")}</button><button className={BOARD_BUTTON} onClick={() => setDeletion({ id: col.id, count: board.cards.filter(c => c.columnId === col.id).length })}>{t("projects.columns.delete",{title:col.title})}</button></div>
    </fieldset>)}
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); edit({ type: "add", id: crypto.randomUUID(), title, state }); setTitle(""); }}>
      <label className="block">{t("projects.columns.newTitle")}<input className={BOARD_INPUT} required maxLength={40} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="block">{t("projects.columns.state")}<select className={BOARD_INPUT} value={state} onChange={e => setState(e.target.value)}>{["todo", "doing", "waiting", "review", "done"].map(s => <option value={s} key={s}>{stateName(s)}</option>)}</select></label>
      <button type="submit" className={BOARD_BUTTON} disabled={columns.length >= 12 || !title.trim()}>{t("projects.columns.add")}</button>
    </form>
    {error && <p role="alert">{error}</p>}<button type="button" disabled={busy} className={BOARD_BUTTON} onClick={() => void save()}>{t("projects.columns.save")}</button>
    {deletion && <ProjectBoardDialog title={t("projects.columns.deleteTitle")} onClose={() => setDeletion(null)}><p>{deletion.count === 1 ? t("projects.columns.cardMoves",{count:deletion.count}) : t("projects.columns.cardsMove",{count:deletion.count})}</p><button className={BOARD_BUTTON} onClick={() => { edit({ type: "delete", id: deletion.id }); setDeletion(null); }}>{t("projects.columns.deleteTitle")}</button></ProjectBoardDialog>}
  </ProjectBoardDialog>;
}
