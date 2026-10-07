// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { projectWriteReason, type ProjectBoardRead, type ProjectCardAction, type ProjectRead, type ProjectResult, type RoomRequest, type UsageRead } from "@/lib/project-client";
import { projectClient, refreshProject } from "@/lib/use-project";
import { useStore } from "@/state/store";
import { projectEvents } from "@/lib/project-events";

const WorkSettings=lazy(()=>import("./ProjectWorkSettings"));
export function projectRequestLabel(request: Pick<RoomRequest, "verb" | "state" | "toBotId">, members: ReadonlyArray<{ id: string; name: string }>): string {
  const name = members.find(member => member.id === request.toBotId)?.name;
  const verbs: Record<RoomRequest["verb"], string> = {
    owner_send: t("projects.request.ownerSend"), room_turn: name ? t("projects.request.roomTurnNamed", { name }) : t("projects.request.roomTurn"),
    ask: name ? t("projects.request.askNamed", { name }) : t("projects.request.ask"), message: name ? t("projects.request.messageNamed", { name }) : t("projects.request.message"),
    assign: name ? t("projects.request.assignNamed", { name }) : t("projects.request.assign"), review: name ? t("projects.request.reviewNamed", { name }) : t("projects.request.review"),
    wake: name ? t("projects.request.wakeNamed", { name }) : t("projects.request.wake"), routine: name ? t("projects.request.routineNamed", { name }) : t("projects.request.routine"),
  };
  const states: Record<RoomRequest["state"], string> = {
    queued: t("projects.requestState.queued"), running: t("projects.requestState.running"), waiting_owner: t("projects.requestState.waitingOwner"), waiting_bot: t("projects.requestState.waitingBot"),
    done: t("projects.requestState.done"), failed: t("projects.requestState.failed"), cancelled: t("projects.requestState.cancelled"), expired: t("projects.requestState.expired"), unknown: t("projects.requestState.unknown"),
  };
  return `${verbs[request.verb]}: ${states[request.state]}`;
}

const BUTTON = "min-h-11 rounded-lg border border-hairline/40 px-3 text-[13px] hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
export function ProjectStripDetails({ groupId, project }: { groupId: string; project: ProjectRead; onBoard: (action?: "reassign" | "take_over") => void }) {
  const { state } = useStore();
  const memberIds = state.groups.find(group => group.id === groupId)?.memberIds ?? [];
  const members = state.bots.filter(bot => memberIds.includes(bot.id));
  const [board, setBoard] = useState<ProjectBoardRead | null>(null);
  const [boardReason, setBoardReason] = useState<string | null>(t("projects.details.loadingCards"));
  const [cardAction, setCardAction] = useState<"reassign" | "take_over" | null>(null);
  const [cardId, setCardId] = useState("");
  const [assignee, setAssignee] = useState("");
  const cardRef = useRef<HTMLSelectElement>(null);
  const cardSelectId = useId();
  const assigneeSelectId = useId();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [more, setMore] = useState(false);
  const [redirect, setRedirect] = useState(false);
  const [note, setNote] = useState("");
  const scopeGoal=project.goal && !["draft","done","stopped","failed"].includes(project.goal.state) ? project.goal.id : undefined;
  const scopePeriod=scopeGoal ? undefined : project.budgets.find(budget=>budget.period && budget.period!=="goal")?.id;
  const [usage, setUsage] = useState<UsageRead | null>(null);
  const [requests, setRequests] = useState<RoomRequest[]>([]);
  const [requestNote, setRequestNote] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreMoreFocus = useRef(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useRef<string | null>(null);
  const reason = projectWriteReason(project) ?? (unavailable ? t("projects.details.controlsUnavailable") : null);
  const boardGeneration = useRef(0);
  const loadBoard = useCallback(async () => {
    const generation = ++boardGeneration.current;
    const result = await projectClient.board(groupId);
    if (generation !== boardGeneration.current) return;
    setBoard(result.ok ? result.data : null);
    setBoardReason(result.ok ? result.data.lifecycle === "open" ? null : result.data.lifecycle === "closed" ? t("projects.common.closedNote") : t("projects.common.nowChannel") : result.unavailable ? t("projects.common.cardsNotAvailable") : result.reason);
  }, [groupId]);
  useEffect(() => {
    let alive = true;
    // StrictMode discards its first setup before this microtask runs.
    void Promise.resolve().then(() => { if (alive) void loadBoard(); });
    const stop = projectEvents.subscribe(groupId, change => { if (change.board || change.replayGap) void loadBoard(); });
    return () => { alive = false; ++boardGeneration.current; stop(); };
  }, [groupId, loadBoard]);
  useEffect(() => { if (cardAction) cardRef.current?.focus(); }, [cardAction]);
  useEffect(() => {
    let alive = true, loading = false, again = false;
    const load = async () => {
      if (loading) { again = true; return; }
      loading = true;
      do {
        again = false;
        const [nextUsage, nextRequests] = await Promise.all([projectClient.usage(groupId,{goal:scopeGoal,period:scopePeriod}), projectClient.requests(groupId, { open: true, limit: 100 })]);
        if (!alive) return;
        setUsage(nextUsage.ok ? nextUsage.data : null);
        setRequests(nextRequests.ok ? nextRequests.data.requests : []);
        setRequestNote(nextRequests.ok ? null : nextRequests.reason);
      } while (again && alive);
      loading = false;
    };
    void load();
    const stop = projectEvents.subscribe(groupId, (change) => { if (change.strip || change.requests || change.replayGap) void load(); });
    return () => { alive = false; stop(); };
  }, [groupId,scopeGoal,scopePeriod]);
  useEffect(() => { if (!busy && restoreMoreFocus.current) { restoreMoreFocus.current = false; moreRef.current?.focus(); } }, [busy]);
  useEffect(() => { if (more) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [more]);
  useEffect(() => { if (redirect) noteRef.current?.focus(); }, [redirect]);
  async function act(action: () => Promise<ProjectResult<unknown>>) {
    if (busy || reason) return;
    setBusy(true); setNotice(null);
    try {
      const result = await action();
      if (!result.ok) { setNotice(result.reason); if (result.unavailable) setUnavailable(true); }
      else { setConfirmStop(false); setRedirect(false); setNote(""); noteId.current = null; }
      await refreshProject(groupId);
      projectEvents.frame({ kind: "room.requests", groupId, threadId: "" });
    } finally { setBusy(false); }
  }
  const cards = board?.cards.filter(card => card.state !== "done" && card.state !== "cancelled") ?? [];
  const cardReason = reason ?? boardReason ?? (cards.length ? null : t("projects.details.noActiveCards"));
  const selectedCard = cards.find(card => card.id === cardId);
  async function runCard(action: ProjectCardAction) {
    if (busy || cardReason || !selectedCard) return;
    setBusy(true); setNotice(null);
    try {
      const result = await projectClient.card(groupId, selectedCard.id, action);
      if (!result.ok) {
        setNotice(result.reason);
        if (result.unavailable) setBoardReason(t("projects.common.cardsNotAvailable"));
        if (result.body?.error === "changed") { setCardId(""); await loadBoard(); }
      } else {
        setCardAction(null); setCardId(""); restoreMoreFocus.current = true;
        await loadBoard(); await refreshProject(groupId);
      }
    } finally { setBusy(false); }
  }
  const total = usage?.totals ?? project.strip.usage;
  return <div className="space-y-3 pb-3 text-[13px]" aria-label={t("projects.details.aria")}>
    <p role="status">{project.strip.line}</p>
    {reason && <p role="status">{reason}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={BUTTON} disabled={busy || !!reason || project.settings.runState === "paused"} onClick={() => void act(() => projectClient.control(groupId, "pause"))}>{t("projects.details.pause")}</button>
      {!project.closing && <button type="button" className={BUTTON} disabled={busy || !!reason || project.settings.runState !== "paused"} onClick={() => void act(() => projectClient.control(groupId, "resume"))}>{t("projects.details.resume")}</button>}
      <button ref={stopRef} type="button" className={BUTTON} disabled={busy || !!reason} onClick={() => setConfirmStop(true)}>{t("projects.details.stopAll")}</button>
      <div className="relative">
        <button ref={moreRef} type="button" className={BUTTON} disabled={busy || !!reason} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>{t("projects.details.more")}</button>
        {more && <div ref={menuRef} role="menu" aria-label={t("projects.details.actions")} className="absolute right-0 top-full z-20 min-w-44 rounded-lg border border-hairline bg-card p-1 shadow-lg"
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setMore(false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMore(false); moreRef.current?.focus(); }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
              const i = buttons.indexOf(event.target as HTMLButtonElement);
              buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
          <button role="menuitem" type="button" className={`${BUTTON} block w-full text-left`} onClick={() => { setMore(false); setRedirect(true); }}>{t("projects.details.redirect")}</button>
          <button role="menuitem" type="button" disabled={!!cardReason || members.length === 0} aria-describedby={cardReason || members.length === 0 ? "project-card-controls-note" : undefined} className={`${BUTTON} block w-full text-left`} onClick={() => { setMore(false); setCardId(""); setCardAction("reassign"); }}>{t("projects.common.reassign")}</button>
          <button role="menuitem" type="button" disabled={!!cardReason} aria-describedby={cardReason || members.length === 0 ? "project-card-controls-note" : undefined} className={`${BUTTON} block w-full text-left`} onClick={() => { setMore(false); setCardId(""); setCardAction("take_over"); }}>{t("projects.details.takeOverCard")}</button>
          {(cardReason || members.length === 0) && <p id="project-card-controls-note" className="px-3 py-2 text-[12px]">{cardReason || t("projects.details.noMembers")}</p>}
        </div>}
      </div>
    </div>
    {cardAction && <form aria-label={cardAction === "reassign" ? t("projects.details.reassignForm") : t("projects.details.takeOverCard")} className="space-y-2" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setCardAction(null); moreRef.current?.focus(); } }} onSubmit={event => {
      event.preventDefault();
      if (!selectedCard || (cardAction === "reassign" && !members.some(member => member.id === assignee))) return;
      void runCard(cardAction === "reassign" ? { action: "reassign", expectedRevision: selectedCard.revision, assigneeBotId: assignee } : { action: "take_over", expectedRevision: selectedCard.revision });
    }}>
      <div><label htmlFor={cardSelectId} className="block">{t("projects.details.card")}</label><select id={cardSelectId} ref={cardRef} className={`${BUTTON} block w-full min-w-0 bg-app`} value={cardId} disabled={busy || !!cardReason} onChange={event => setCardId(event.target.value)}>
        <option value="">{t("projects.details.chooseCard")}</option>{cards.map(card => <option key={card.id} value={card.id}>{card.title}</option>)}
      </select></div>
      {cardAction === "reassign" && <div><label htmlFor={assigneeSelectId} className="block">{t("projects.details.assignTo")}</label><select id={assigneeSelectId} className={`${BUTTON} block w-full bg-app`} value={assignee} disabled={busy || !!cardReason} onChange={event => setAssignee(event.target.value)}>
        <option value="">{t("projects.details.chooseMember")}</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></div>}
      {cardReason && <p role="status">{cardReason}</p>}
      <button type="submit" className={BUTTON} disabled={busy || !!cardReason || !selectedCard || (cardAction === "reassign" && !members.some(member => member.id === assignee))}>{cardAction === "reassign" ? t("projects.details.reassignCard") : t("projects.details.takeOverCardButton")}</button>{" "}
      <button type="button" className={BUTTON} disabled={busy} onClick={() => { setCardAction(null); moreRef.current?.focus(); }}>{t("projects.common.cancel")}</button>
    </form>}
    {confirmStop && <div role="group" aria-label={t("projects.details.confirmStopAria")} className="space-y-2 rounded-lg border border-hairline p-3" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setConfirmStop(false); stopRef.current?.focus(); } }}>
      <p>{t("projects.details.stopPrompt")}</p>
      <div className="flex gap-2"><button autoFocus type="button" className={BUTTON} disabled={busy} onClick={() => void act(() => projectClient.control(groupId, "stop"))}>{t("projects.details.stopWork")}</button>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => { setConfirmStop(false); stopRef.current?.focus(); }}>{t("projects.details.keepWorking")}</button></div>
    </div>}
    {redirect && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (!note.trim()) return; noteId.current ??= crypto.randomUUID(); void act(() => projectClient.redirect(groupId, { clientId: noteId.current!, text: note.trim() })); }}>
      <label className="block">{t("projects.details.noteToLead")}<textarea ref={noteRef} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); noteId.current = null; }} className="mt-1 block min-h-20 w-full rounded-lg border border-hairline bg-app p-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" /></label>
      <button type="submit" className={BUTTON} disabled={busy || !note.trim()}>{t("projects.details.sendNote")}</button>{" "}
      <button type="button" className={BUTTON} onClick={() => { setRedirect(false); moreRef.current?.focus(); }}>{t("projects.common.cancel")}</button>
    </form>}
    {(usage?.budgets ?? project.budgets).some(budget => budget.state === "paused") && <p role="status">{t("projects.details.limitNote")}</p>}
    <p aria-label={t("projects.details.usageAria")}>{total.tokensReported ? t("projects.details.usageReported", { minutes: Math.round(total.workMs / 60000), tokens: (total.input + total.output).toLocaleString() }) : t("projects.details.usageUnreported", { minutes: Math.round(total.workMs / 60000) })}</p>
    {usage?.notReported.map(id=><p key={id}>{t("projects.details.notReportedBy",{name:members.find(bot=>bot.id===id)?.name??t("projects.common.thisMember")})}</p>)}
    {(usage?.interrupted || total.interrupted)&&<p>{t("projects.details.interrupted")}</p>}
    {total.charge!==null&&<p>{t("projects.details.cost",{cost:`$${total.charge.toFixed(4)}`})}</p>}
    <Suspense fallback={<p>{t("projects.details.loadingSettings")}</p>}><WorkSettings groupId={groupId} project={project}/></Suspense>
    {requestNote && <p>{requestNote}</p>}
    {requests.length > 0 && <ul aria-label={t("projects.details.requestsAria")} className="space-y-1">{requests.map((request) => <li key={request.id} className="flex flex-wrap items-center gap-2">
      <span>{request.refusalLine || projectRequestLabel(request, members)}</span>
      {(request.state === "queued" || request.state === "waiting_bot") && <button type="button" className={BUTTON} disabled={busy || !!reason} onClick={() => void act(() => projectClient.cancel(groupId, request.id))}>{t("projects.details.cancelRequest")}</button>}
    </li>)}</ul>}
  </div>;
}
