// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { useStore } from "@/state/store";
import type { ProjectActivityRow, ProjectBoardRead, ProjectCard, ProjectRead, RoomRequest } from "@/lib/project-client";
import { cardFace, ownerActions, type OwnerAction } from "@/lib/project-board";
import { mergeActivity, nextActivityPage, type ActivityPage } from "@/lib/project-activity";
import { cardHistoryLine } from "@/lib/project-card-history";
import { projectClient } from "@/lib/use-project";
import { openInboxLink } from "@/lib/open-inbox-link";
import { projectRequestLabel } from "./ProjectStripDetails";
import { BOARD_BUTTON, ProjectBoardDialog } from "./ProjectBoardDialog";
export function ProjectCardSheet({ groupId, card, board, project, members, requests, readOnly, busy, onClose, onAction, onMove, onGoal, notice, refusal }: {
  groupId: string; card: ProjectCard; board: ProjectBoardRead; project: ProjectRead; members: Bot[]; requests: RoomRequest[]; readOnly: boolean; busy: boolean;
  onClose: () => void; onAction: (id: string, action: OwnerAction) => void; onMove: () => void; onGoal: () => void; notice: string; refusal: string;
}) {
  const { state, dispatch } = useStore();
  const [history, setHistory] = useState<ProjectActivityRow[]>([]), [older, setOlder] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), paging = useRef<ActivityPage | null>(null);
  const face = cardFace(card, members, project.goal ? [project.goal] : [], requests, board.cards);
  const load = async (before?: number, limit = 30) => {
    const serial = ++generation.current; setLoading(true);
    const result = await projectClient.activity(groupId, { card: card.id, before, limit });
    if (generation.current !== serial) return;
    if (result.ok) { setHistory(old => before === undefined ? result.data.items : mergeActivity(old, result.data.items)); paging.current = nextActivityPage(result.data.items, limit); setOlder(!!paging.current && !paging.current.blocked); setError(""); }
    else setError(result.reason);
    setLoading(false);
  };
  useEffect(() => { void load(); return () => { generation.current++; }; }, [groupId, card.id, card.revision]);
  const open = async (messageId?: string) => {
    if (!card.deskThreadId) return;
    try { await openInboxLink({ threadId: card.deskThreadId, ...(messageId ? { messageId } : {}) }, state, dispatch); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : t("projects.sheet.threadFailed")); }
  };
  const labels: Partial<Record<OwnerAction, string>> = { start: t("projects.sheet.action.start"), reassign: t("projects.common.reassign"), take_over: t("projects.sheet.action.takeOver"), retry: t("projects.boardCard.retry"), interrupt: t("projects.sheet.action.interrupt"), done: card.ownerTookOver ? t("projects.sheet.action.done") : t("projects.common.doneWithoutReview"), accept: t("projects.sheet.action.accept"), send_back: t("projects.common.sendBack"), cancel: t("projects.sheet.action.cancel"), restore: t("projects.sheet.action.restore"), reopen: t("projects.sheet.action.reopen"), edit: t("projects.sheet.action.edit") };
  return <ProjectBoardDialog side title={`${t("projects.common.cardLabel",{number:card.number ?? ""})}: ${card.title}`} onClose={onClose}>
    <p className="whitespace-pre-wrap break-words text-sm">{card.description || t("projects.sheet.noDescription")}</p>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm"><dt>{t("projects.sheet.assignee")}</dt><dd className="break-words">{face.assignee}</dd><dt>{t("projects.sheet.state")}</dt><dd>{face.state}</dd>{face.reason && <><dt>{t("projects.sheet.reason")}</dt><dd className="break-words">{face.reason}</dd></>}
      <dt>{t("projects.sheet.due")}</dt><dd>{card.dueAt ? new Date(card.dueAt).toLocaleDateString() : t("projects.sheet.noDueDate")}{face.pastDue ? ` (${t("projects.common.pastDue")})` : ""}</dd>
      <dt>{t("projects.sheet.dependsOn")}</dt><dd>{card.dependsOn?.length ? card.dependsOn.map(id => { const other = board.cards.find(c => c.id === id); return other ? t("projects.common.cardLabel",{number:other.number ?? ""}) : t("projects.sheet.archivedCard"); }).join(", ") : t("projects.sheet.none")}</dd>
      <dt>{t("projects.sheet.mayChange")}</dt><dd>{card.writes !== false ? t("projects.sheet.yes") : t("projects.sheet.no")}</dd><dt>{t("projects.sheet.workFolder")}</dt><dd className="break-words">{card.workRootIndex != null ? project.settings.workRoots?.[card.workRootIndex]?.label || project.settings.workRoots?.[card.workRootIndex]?.path || t("projects.sheet.folderGone") : t("projects.sheet.deskFolder")}</dd>
      <dt>{t("projects.sheet.usage")}</dt><dd>{face.work}{face.tokens ? ` · ${face.tokens}` : ""}</dd>
    </dl>
    {face.goalTitle && <button className={BOARD_BUTTON} onClick={onGoal}>{t("projects.common.goalTitled",{title:face.goalTitle})}</button>}
    {card.deskThreadId && <div className="flex flex-wrap gap-2"><button className={BOARD_BUTTON} onClick={() => void open()}>{t("projects.sheet.openThread",{name:members.find(m => m.id === card.assigneeBotId)?.name ?? t("projects.sheet.teammate")})}</button>{card.resultMessageId && <button className={BOARD_BUTTON} onClick={() => void open(card.resultMessageId!)}>{t("projects.sheet.openResult")}</button>}</div>}
    {requests.some(r => r.workItemId === card.id) && <section aria-label={t("projects.sheet.currentRun")}><h3 className="font-medium">{t("projects.sheet.currentRun")}</h3>{requests.filter(r => r.workItemId === card.id).map(r => <p className="text-sm" key={r.id}>{projectRequestLabel(r, members)}</p>)}</section>}
    {!readOnly && <section aria-label={t("projects.sheet.cardActions")} className="flex flex-wrap gap-2"><button className={BOARD_BUTTON} disabled={busy} onClick={onMove}>{t("projects.sheet.moveTo")}</button>{ownerActions(card, requests).map(action => <button key={action} className={BOARD_BUTTON} disabled={busy} onClick={() => onAction(card.id, action)}>{labels[action]}</button>)}</section>}
    <p role="status" aria-live="polite" aria-atomic="true">{refusal ? "" : notice}</p><p role="alert" aria-live="assertive" aria-atomic="true">{error || refusal}</p>
    <section aria-label={t("projects.sheet.historyAria")}><h3 className="mb-2 font-medium">{t("projects.sheet.history")}</h3><ol className="space-y-3 text-sm">{history.map(row => <li key={row.id}>{cardHistoryLine(row)}<time className="block text-xs text-ink-secondary" dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleString()}</time></li>)}</ol>{!history.length && !loading && <p>{t("projects.sheet.noHistory")}</p>}{loading && <p>{t("projects.sheet.loadingHistory")}</p>}{paging.current?.blocked && <p>{t("projects.act.pageLimit")}</p>}{older && <button disabled={loading} className={BOARD_BUTTON} onClick={() => { const page = paging.current; if (page && !page.blocked) void load(page.before, page.limit); }}>{t("projects.common.showOlder")}</button>}</section>
  </ProjectBoardDialog>;
}
