// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { Suspense, useEffect, useRef, useState } from "react";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { projectWriteReason, type ProjectBoardRead, type ProjectRead, type ProjectGoalAction, type ProjectGoalEvidence, type UsageRead } from "@/lib/project-client";
import { goalStateLabel, goalActions, goalActionLabel, goalActionBody, canEditGoal, criterionTarget, resolveCriterionTarget, goalBudgetLines } from "@/lib/project-goal-view";
import { cardFace, stateName, stateNames } from "@/lib/project-board";
import { projectClient, refreshProject } from "@/lib/use-project";
import { projectEvents } from "@/lib/project-events";
import { openInboxLink } from "@/lib/open-inbox-link";
import { useDesktopSurface } from "@/lib/use-surface";
import { ProjectGoalForm } from "./ProjectGoalForm";
import { BOARD_BUTTON, BOARD_INPUT, ProjectBoardDialog } from "./ProjectBoardDialog";
import { retryableLazy, LazyBoundary } from "./LazyBoundary";
import { LazyFallback } from "./LazyFallback";
import "./project-board.css";
const WorkSettings = retryableLazy(() => import("./ProjectWorkSettings"));
const Board = retryableLazy(() => import("./ProjectBoard"));
export default function ProjectGoalView({ group, members, project, initialBoard, initialUsage, goalsEnabled = true, onCard, onNavigate }: { group: Group; members: Bot[]; project: ProjectRead | null; initialBoard?: ProjectBoardRead; initialUsage?: UsageRead; goalsEnabled?: boolean; onCard?: (id: string) => void; onNavigate?: () => void }) {
  const { state, dispatch } = useStore(), desktop = useDesktopSurface();
  const enabled = goalsEnabled && state.config?.features?.projectsGoals !== false;
  const goal = project?.goal, readOnlyReason = projectWriteReason(project);
  const [board, setBoard] = useState(initialBoard), [usage, setUsage] = useState(initialUsage);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<{ action: ProjectGoalAction; goal: NonNullable<ProjectRead["goal"]> } | null>(null), [note, setNote] = useState("");
  const [workSettings, setWorkSettings] = useState(false);
  const [exported, setExported] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled || !goal) return;
    const serial = ++generation.current;
    let boardRead = 0, usageRead = 0;
    const loadBoard = async () => { const read = ++boardRead; const result = await projectClient.board(group.id, { goal: goal.id, archived: true }); if (generation.current !== serial || read !== boardRead) return; if (result.ok) setBoard(result.data); else setError(result.reason); };
    const loadUsage = async () => { const read = ++usageRead; const result = await projectClient.usage(group.id, { goal: goal.id }); if (generation.current !== serial || read !== usageRead) return; if (result.ok) setUsage(result.data); else setError(result.reason); };
    setBoard(initialBoard); setUsage(initialUsage); void loadBoard(); void loadUsage();
    const stop = projectEvents.subscribe(group.id, change => { if (change.board || change.replayGap) void loadBoard(); if (change.strip || change.replayGap) void loadUsage(); });
    return () => { generation.current++; stop(); };
  }, [group.id, goal?.id, enabled]);
  async function failure(reason: string, changed: boolean) { setError(changed ? t("projects.common.goalChanged") : reason); if (changed) { setPending(null); setEditing(false); await refreshProject(group.id); } }
  async function act(action: ProjectGoalAction, held = goal) {
    if (!held || busy || readOnlyReason) return;
    const body = goalActionBody(held, action, note);
    if ("error" in body) { setError(body.error); return; }
    setBusy(true); setError("");
    const result = await projectClient.goal(group.id, held.id, body);
    if (result.ok) { setPending(null); setNote(""); await refreshProject(group.id); }
    else await failure(result.reason, result.body?.error === "changed");
    setBusy(false);
  }
  async function evidenceOpen(evidence: ProjectGoalEvidence) {
    try {
      const target = await resolveCriterionTarget(evidence, board?.cards ?? [], group.threadId, api, async () => {
        const result = await projectClient.requests(group.id, { limit: 100 });
        if (!result.ok) throw new Error(result.reason);
        return result.data.requests;
      });
      if (!target) { setError(t("projects.goalView.evidenceGone")); return; }
      if ("artifactId" in target && desktop) { const { openFiles } = await import("./Files"); openFiles(target); onNavigate?.(); }
      else { const threadId = "threadId" in target ? target.threadId : board?.cards.find(c => c.id === evidence.workItemId)?.deskThreadId; if (threadId) { await openInboxLink({ threadId, ...("messageId" in target ? { messageId: target.messageId } : {}) }, state, dispatch); onNavigate?.(); } else setError(t("projects.goalView.threadGone")); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("projects.goalView.evidenceFailed")); }
  }
  if (selected) return <div className="flex min-h-0 min-w-0 flex-1 flex-col"><button className={BOARD_BUTTON} onClick={() => setSelected(null)}>{t("projects.goalView.back")}</button><LazyBoundary inline onRetry={Board.retry}><Suspense fallback={<LazyFallback />}><Board.Component group={group} members={members} project={project} initialSelectedCardId={selected} /></Suspense></LazyBoundary></div>;
  const budget = project?.budgets.find(b => b.period === "goal" && b.goalId === goal?.id);
  return <section aria-label={t("projects.common.goal")} className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm text-ink">
    {readOnlyReason && <p>{readOnlyReason}</p>}{error && <p role="alert">{error}</p>}
    {project?.brief && <section aria-label={t("projects.goalView.briefAria")} className="space-y-2"><h2 className="text-lg font-semibold">{t("projects.goalView.brief")}</h2><p className="whitespace-pre-wrap break-words">{project.brief.summary}</p><p className="whitespace-pre-wrap break-words">{project.brief.doneMeans}</p><p className="whitespace-pre-wrap break-words">{project.brief.rules}</p>{desktop && !readOnlyReason && (project.settings.workRoots?.length ? project.settings.workRoots.map((root,index)=><button key={root.path} className={BOARD_BUTTON} disabled={busy} onClick={async()=>{setBusy(true);const result=await projectClient.exportBrief(group.id,index);if(result.ok)setExported(result.data.path);else setError(result.reason);setBusy(false);}}>{t("projects.goalView.exportBrief",{label:root.label || root.path})}</button>) : <p>{t("projects.goalView.chooseFolder")}</p>)}{exported&&<p role="status" className="break-all">{t("projects.goalView.exported",{path:exported})}</p>}</section>}
    {!enabled ? <p>{t("projects.goalView.goalsOff")}</p> : !goal ? <><h2 className="text-lg font-semibold">{t("projects.goalForm.set")}</h2>{!readOnlyReason && <ProjectGoalForm groupId={group.id} onSaved={() => refreshProject(group.id)} onFailure={(reason, changed) => void failure(reason, changed)} />}</> : <>
      <header className="space-y-2"><h2 className="break-words text-lg font-semibold">{goal.title}</h2><p>{goalStateLabel(goal.state)}{goal.stateReason ? `: ${goal.stateReason}` : ""}</p>{goal.description && <p className="whitespace-pre-wrap break-words">{goal.description}</p>}{goal.deadlineAt != null && <p>{t("projects.goalView.deadline")}: <time dateTime={new Date(goal.deadlineAt).toISOString()}>{new Date(goal.deadlineAt).toLocaleDateString()}</time>{goal.deadlineAt < Date.now() ? ` (${t("projects.common.pastDue")})` : ""}</p>}</header>
      <section aria-label={t("projects.goalView.doneCriteria")}><h3 className="mb-2 font-medium">{t("projects.goalView.doneCriteria")}</h3><ul className="space-y-3">{goal.criteria?.map(c => <li key={c.id} className="min-w-0 break-words"><span aria-label={c.met ? t("projects.goalView.met") : t("projects.goalView.notMet")} role="img">{c.met ? "☑" : "☐"}</span> {c.text}<span className="block text-ink-secondary">{c.proposed ? t("projects.goalView.proposedByLead") : t("projects.goalView.setByYou")}{c.metBy ? ` · ${c.metBy === "owner" ? t("projects.goalView.metByYou") : t("projects.goalView.metBy",{name:members.find(m => m.id === c.metBy)?.name ?? c.metBy})}` : ""}</span>{c.met && c.evidence && criterionTarget(c.evidence, board?.cards ?? [], group.threadId) && <button className={BOARD_BUTTON} onClick={() => void evidenceOpen(c.evidence!)}>{t("projects.goalView.openEvidence")}</button>}</li>)}</ul>{!goal.criteria?.length && <p>{t("projects.goalView.noCriteria")}</p>}{!readOnlyReason && canEditGoal(goal.state) && <button className={`${BOARD_BUTTON} mt-2`} onClick={() => setEditing(true)}>{goal.state === "draft" ? t("projects.goalView.edit") : t("projects.goalView.editCriteria")}</button>}</section>
      <section aria-label={t("projects.goalView.planCards")}><h3 className="mb-2 font-medium">{t("projects.goalView.planCards")}</h3>{!board ? <p>{t("projects.goalView.loadingPlan")}</p> : !board.cards.length ? <p>{t("projects.goalView.noPlan")}</p> : Object.keys(stateNames).map(status => { const cards = board.cards.filter(c => c.goalId === goal.id && c.state === status); return cards.length ? <div key={status} className="mb-3"><h4 className="font-medium">{stateName(status)}</h4><ul className="space-y-2">{cards.map(card => { const face = cardFace(card, members, [goal]); return <li key={card.id}><button className={`${BOARD_BUTTON} w-full break-words text-left`} onClick={() => onCard ? onCard(card.id) : setSelected(card.id)}><span className="block">{t("projects.common.cardLabel",{number:card.number ?? ""})}: {card.title}</span><span className="block text-xs text-ink-secondary">{face.assignee} · {face.state} · {face.time} · {face.work}{face.tokens ? ` · ${face.tokens}` : ""}{face.reason ? ` · ${face.reason}` : ""}</span></button></li>; })}</ul></div> : null; })}</section>
      <section aria-label={t("projects.goalView.usage")} className={budget?.state === "warned" ? "text-warning" : ""}><h3 className="mb-2 font-medium">{t("projects.goalView.usage")}</h3>{usage ? <>{budget?.maxWorkMinutes != null && <meter className="w-full" aria-label={t("projects.goalView.workTimeUsed")} min={0} max={budget.maxWorkMinutes * 60000} value={usage.totals.workMs} />}{goalBudgetLines(budget, usage, members).map(line => <p key={line}>{line}</p>)}</> : <p>{t("projects.goalView.loadingUsage")}</p>}{budget && desktop && !readOnlyReason && <button className={`${BOARD_BUTTON} mt-2`} onClick={() => setWorkSettings(true)}>{t("projects.goalView.budgetSettings")}</button>}</section>
      {!readOnlyReason && <div className="flex flex-wrap gap-2">{goalActions(goal.state).map(action => <button key={action} className={BOARD_BUTTON} disabled={busy} onClick={() => { setError(""); if (["stop", "send_back", "change_plan"].includes(action)) { setPending({ action, goal }); setNote(""); } else void act(action); }}>{goalActionLabel(action)}</button>)}</div>}
      {!readOnlyReason && workSettings && project && <ProjectBoardDialog title={t("projects.goalView.budgetSettings")} onClose={() => setWorkSettings(false)}><LazyBoundary inline onRetry={WorkSettings.retry}><Suspense fallback={<LazyFallback />}><WorkSettings.Component groupId={group.id} project={project} /></Suspense></LazyBoundary></ProjectBoardDialog>}
      {!readOnlyReason && editing && <ProjectBoardDialog title={t("projects.goalForm.edit")} onClose={() => setEditing(false)}><ProjectGoalForm groupId={group.id} goal={goal} onSaved={async () => { setEditing(false); await refreshProject(group.id); }} onCancel={() => setEditing(false)} onFailure={(reason, changed) => void failure(reason, changed)} /></ProjectBoardDialog>}
      {!readOnlyReason && pending && <ProjectBoardDialog title={goalActionLabel(pending.action)} onClose={() => setPending(null)}><form className="space-y-3" onSubmit={e => { e.preventDefault(); void act(pending.action, pending.goal); }}>{pending.action === "stop" ? <p>{t("projects.goalView.stopConfirm")}</p> : <label className="block">{t("projects.goalView.note")}<textarea required maxLength={500} className={BOARD_INPUT} value={note} onChange={e => setNote(e.target.value)} /></label>}{error && <p role="alert">{error}</p>}<button className={BOARD_BUTTON} disabled={busy}>{goalActionLabel(pending.action)}</button></form></ProjectBoardDialog>}
    </>}
  </section>;
}
