// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useStore, type Bot, type Group } from "@/state/store";
import { projectWriteReason, type ProjectActivityRow, type ProjectCard, type ProjectGoal, type ProjectRead } from "@/lib/project-client";
import { activityLine, activityActor, activityTime, mergeActivity, nextActivityPage, type ActivityPage } from "@/lib/project-activity";
import { projectEvents } from "@/lib/project-events";
import { projectClient, refreshProject } from "@/lib/use-project";
import { useDesktopSurface } from "@/lib/use-surface";
import { BOARD_BUTTON } from "./ProjectBoardDialog";
export function ProjectActivityItem({ row, cards, goal, members, now = Date.now() }: { row: ProjectActivityRow; cards: ProjectCard[]; goal: ProjectGoal | null; members: Bot[]; now?: number }) {
  return <li className="min-w-0 space-y-1 break-words border-b border-hairline/30 py-3"><p>{activityLine(row, cards, goal)}</p><p className="text-xs text-ink-secondary">{activityActor(row.actor, members)} · <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()}>{activityTime(row.at, now)}</time></p></li>;
}
export default function ProjectActivity({ group, members, project, digestEnabled = true }: { group: Group; members: Bot[]; project: ProjectRead | null; digestEnabled?: boolean }) {
  const { state } = useStore(), desktop = useDesktopSurface();
  const [items, setItems] = useState<ProjectActivityRow[]>([]), [cards, setCards] = useState<ProjectCard[]>([]);
  const [older, setOlder] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0), pageRead = useRef(0);
  const paging = useRef<ActivityPage | null | undefined>(undefined);
  const heldItems = useRef<ProjectActivityRow[]>([]);
  async function load(before?: number, limit = 30) {
    const visit = generation.current, serial = ++pageRead.current; setLoading(true);
    const result = await projectClient.activity(group.id, { before, limit });
    if (visit !== generation.current || serial !== pageRead.current) return;
    if (result.ok) {
      const page = result.data.items;
      const overlaps = before === undefined && page.some(row => heldItems.current.some(held => held.id === row.id));
      heldItems.current = before !== undefined ? mergeActivity(heldItems.current, page) : overlaps ? mergeActivity(page, heldItems.current) : page;
      setItems(heldItems.current);
      if (!overlaps) paging.current = nextActivityPage(page, limit);
      setOlder(!!paging.current && !paging.current.blocked);
      setError("");
    }
    else setError(result.reason);
    setLoading(false);
  }
  useEffect(() => {
    const visit = ++generation.current; let boardRead = 0;
    const loadCards = async () => { const serial = ++boardRead; const result = await projectClient.board(group.id, { archived: true }); if (visit === generation.current && serial === boardRead && result.ok) setCards(result.data.cards); };
    paging.current = undefined; heldItems.current = []; setOlder(false); setItems([]); setCards([]); void load(); void loadCards();
    const stop = projectEvents.subscribe(group.id, change => { if (change.strip || change.replayGap) void load(); if (change.board || change.replayGap) void loadCards(); });
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { generation.current++; stop(); clearInterval(timer); };
  }, [group.id]);
  const readOnly = projectWriteReason(project);
  async function toggle() {
    if (!project || busy || readOnly || !desktop) return;
    setBusy(true); setError("");
    const result = await projectClient.settings(group.id, { expectedRevision: project.settings.revision, parts: { ...project.settings.parts, digest: !project.settings.parts.digest } });
    if (!result.ok) setError(result.body?.error === "changed" ? t("projects.activity.changed") : result.reason);
    if (result.ok || (!result.ok && result.body?.error === "changed")) await refreshProject(group.id);
    setBusy(false);
  }
  return <section aria-label={t("projects.activity.title")} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 text-sm text-ink"><header className="space-y-2"><h2 className="text-lg font-semibold">{t("projects.activity.title")}</h2>{desktop && digestEnabled && state.config?.features?.projectsDigest !== false && <><button type="button" role="switch" aria-checked={!!project?.settings.parts.digest} disabled={busy || !!readOnly} className={BOARD_BUTTON} onClick={() => void toggle()}>{t("projects.activity.digest")}</button><p className="text-ink-secondary">{t("projects.activity.digestHint")}</p></>}{readOnly && <p>{readOnly}</p>}</header>
    {error && <p role="alert">{error}</p>}{paging.current?.blocked && <p role="status">{t("projects.act.pageLimit")}</p>}<ol aria-label={t("projects.activity.list")}>{items.map(row => <ProjectActivityItem key={row.id} row={row} cards={cards} goal={project?.goal ?? null} members={members} now={now} />)}</ol>
    {loading && <p role="status">{t("projects.activity.loading")}</p>}{!loading && !items.length && !error && <p>{t("projects.activity.empty")}</p>}{older && <button className={`${BOARD_BUTTON} mt-3`} disabled={loading} onClick={() => { const page = paging.current; if (page && !page.blocked) void load(page.before, page.limit); }}>{t("projects.common.showOlder")}</button>}
  </section>;
}
