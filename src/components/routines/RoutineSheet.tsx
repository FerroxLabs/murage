// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L5B: the routine sheet (Desktop.dc.html ~784-797) and the All routines
// list. Open, run, pause, change and delete a routine where you see it. Only
// existing routes: POST /api/routines/:id/run, PATCH /api/routines/:id
// (enabled), DELETE /api/routines/:id. Delete asks first (checklist item 7:
// a card that asks before anything that cannot be taken back); the server
// Undo for routines is its own design-first item.

import { useMemo, useRef, useState } from "react";
import { CircleAlert, Pause, Play, Search, Trash2, X } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "@/components/ui/BoxShell";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Routine, RoutineRun } from "@/lib/routines";
import {
  occurrenceWords,
  routineListModel,
  routineNeedsLook,
  routineSheetModel,
  runStatusWords,
  scheduleWords,
} from "@/lib/routine-sheet-model";
import { api, useStore, type Bot, type Group } from "@/state/store";

const ROW_BUTTON = "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-raised/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const QUIET_BUTTON = "flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";
const PRIMARY_BUTTON = "flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-semibold text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-3">
      <div className="pt-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="min-w-0 text-[12.5px] text-ink">{children}</div>
    </div>
  );
}

export function RoutineSheet({
  routine,
  canEdit,
  onClose,
  onEdit,
  onOpenRun,
}: {
  routine: Routine;
  /** The desktop app: change, pause and delete. Elsewhere Run now only. */
  canEdit: boolean;
  onClose: () => void;
  onEdit: (routine: Routine) => void;
  onOpenRun: (run: RoutineRun) => void;
}) {
  const { state, dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [askDelete, setAskDelete] = useState(false);
  const now = Date.now();
  const model = routineSheetModel(routine, state.routineRuns, state.bots, state.groups, now);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalDialog(modalRef, onClose);

  const call = async (path: string, init: { method: string; body?: unknown }, after?: (response: { routine?: Routine; run?: RoutineRun }) => void) => {
    if (working) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await api(path, { method: init.method, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      if (response?.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response?.run) dispatch({ type: "routineRunPatched", run: response.run });
      after?.(response ?? {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  // A connected-app routine runs when its app event fires: the server refuses Run now and Edit for it.
  const appEvent = routine.schedule.type === "app_event";
  const runNow = () => void call(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" }, () => setNotice(t("ux.l5b.started.toast", { name: routine.name })));
  const togglePause = () => {
    if (!canEdit) return;
    const enabled = !routine.enabled;
    void call(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: { enabled } }, (response) => {
      const next = response.routine ?? { ...routine, enabled };
      const m = routineSheetModel(next, state.routineRuns, state.bots, state.groups, Date.now());
      setNotice(enabled
        ? t("ux.l5b.resumed.toast", { name: routine.name, when: m.nextAt === null ? m.whenText : occurrenceWords(m.nextAt, Date.now()) })
        : t("ux.l5b.paused.toast", { name: routine.name }));
    });
  };
  const confirmDelete = () => {
    if (!canEdit) return;
    void call(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" }, () => {
      dispatch({ type: "routineDeleted", routineId: routine.id });
      onClose();
    });
  };

  const who: Bot | null = state.bots.find((candidate) => candidate.id === routine.botId) ?? null;
  return (
    <div className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-[2px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={routine.name} data-routine-sheet={routine.id} className={cn(BOX_FRAME, "max-h-[calc(var(--vvh,100dvh)-1.5rem)] w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl")}>
        <BoxHead className="items-start justify-start gap-3 border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[18px] font-semibold text-ink">{routine.name}</div>
            {model.needsLook && <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-danger"><CircleAlert size={12} aria-hidden />{t("ux.l5b.needsLook")}</div>}
          </div>
          <button type="button" onClick={onClose} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("ux.l5b.close")}><X size={17} /></button>
        </BoxHead>
        <BoxBody className="space-y-4 px-5 py-4">
          <Field label={t("ux.l5b.who.label")}>
            {who ? <span className="flex items-center gap-2"><BotAvatar bot={who} state="idle" size={24} animated={false} />{who.name}</span> : null}
          </Field>
          <Field label={t("ux.l5b.when.label")}>
            <span className="flex flex-wrap items-center gap-2">
              <span>{model.paused ? `${model.whenText} · ${t("ux.l5b.when.paused")}` : model.whenText}</span>
              {canEdit && !appEvent && <button type="button" onClick={() => onEdit(routine)} className="min-h-11 rounded-lg px-2 text-[12px] font-medium text-accent hover:bg-accent/10">{t("ux.l5b.change")}</button>}
            </span>
          </Field>
          {model.level.text && <Field label={t("ux.l5b.level.label")}>{model.level.text}</Field>}
          <Field label={t("ux.l5b.reports.label")}>{model.reportsTo}</Field>
          <Field label={t("ux.l5b.runs.label")}>
            {model.lastRuns.length === 0
              ? <span className="text-ink-secondary">{model.nextAt === null ? t("ux.l5b.runs.noneNoNext") : t("ux.l5b.runs.none", { when: occurrenceWords(model.nextAt, now) })}</span>
              : <ul className="space-y-1">{model.lastRuns.map((run) => {
                  const at = run.startedAt ?? run.scheduledFor;
                  const when = occurrenceWords(at, now);
                  return (
                    <li key={run.id}>
                      <button type="button" data-routine-run-mark={run.id} onClick={() => onOpenRun(run)} aria-label={t("ux.l5b.runs.open", { when })} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left hover:bg-raised/60">
                        <span className="truncate">{when}</span>
                        <span className={cn("shrink-0 text-[11.5px]", run.status === "failed" || run.status === "missed" ? "text-danger" : "text-ink-secondary")}>{runStatusWords(run.status)}</span>
                      </button>
                    </li>
                  );
                })}</ul>}
          </Field>
          {!canEdit && <p className="text-[12px] text-ink-secondary">{t("ux.l5b.desktopOnly")}</p>}
          {notice && <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-[11.5px] text-success">{notice}</p>}
          {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</p>}
          {askDelete && (
            <div role="alertdialog" aria-label={t("ux.l5b.delete")} className="rounded-xl border border-danger/30 bg-danger/5 p-3">
              <p className="text-[12px] text-ink">{t("ux.l5b.deleteAsk", { name: routine.name })}</p>
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" autoFocus onClick={() => setAskDelete(false)} className={QUIET_BUTTON}>{t("ux.l5b.deleteKeep")}</button>
                <button type="button" disabled={working} onClick={confirmDelete} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-danger px-4 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><Trash2 size={13} aria-hidden />{t("ux.l5b.delete")}</button>
              </div>
            </div>
          )}
        </BoxBody>
        <BoxFoot className="flex-wrap justify-end gap-1 border-t border-hairline/40 px-4 py-3">
          {canEdit && <button type="button" disabled={working} onClick={() => setAskDelete(true)} className={cn(QUIET_BUTTON, "hover:bg-danger/10 hover:text-danger")}><Trash2 size={13} aria-hidden />{t("ux.l5b.delete")}</button>}
          {canEdit && !appEvent && <button type="button" onClick={() => onEdit(routine)} className={QUIET_BUTTON}>{t("ux.l5b.edit")}</button>}
          {canEdit && <button type="button" disabled={working} onClick={togglePause} className={QUIET_BUTTON}>{routine.enabled ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}{routine.enabled ? t("ux.l5b.pause") : t("ux.l5b.resume")}</button>}
          {!appEvent && <button type="button" disabled={working || model.busy} onClick={runNow} className={PRIMARY_BUTTON}><Play size={13} aria-hidden />{t("ux.l5b.runNow")}</button>}
        </BoxFoot>
      </div>
    </div>
  );
}

export function RoutineListSheet({
  onClose,
  onOpen,
  onNew,
  canCreate,
}: {
  onClose: () => void;
  onOpen: (routine: Routine) => void;
  onNew: () => void;
  canCreate: boolean;
}) {
  const { state } = useStore();
  const [filter, setFilter] = useState("");
  const now = Date.now();
  const model = useMemo(() => routineListModel(state.routines, state.routineRuns, state.bots, { filter, now }), [state.routines, state.routineRuns, state.bots, filter, now]);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalDialog(modalRef, onClose);
  const groups: Group[] = state.groups;

  return (
    <div className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("ux.l5b.list.title")} data-routine-list className={cn(BOX_FRAME, "max-h-[calc(var(--vvh,100dvh)-1.5rem)] w-full max-w-[560px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl")}>
        <BoxHead className="border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="text-[16px] font-semibold text-ink">{t("ux.l5b.list.title")}</div>
            {model.total > 0 && <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("ux.l5b.list.count", { count: model.total })}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label={t("ux.l5b.close")} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised"><X size={17} /></button>
        </BoxHead>
        <BoxBody className="space-y-3 p-3">
          {model.large && (
            <label className="flex min-h-11 items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-3">
              <Search size={14} aria-hidden className="text-ink-secondary" />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("ux.l5b.list.filter")} aria-label={t("ux.l5b.list.filter")} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none" />
            </label>
          )}
          {model.total === 0 && <p className="px-3 py-2 text-[12.5px] text-ink-secondary">{t("ux.l5b.list.empty")}</p>}
          {model.total > 0 && model.sections.length === 0 && <p className="px-3 py-2 text-[12.5px] text-ink-secondary">{t("ux.l5b.list.noMatch")}</p>}
          {model.sections.map((section) => (
            <section key={section.key} aria-label={section.title || t("ux.l5b.list.title")}>
              {section.title && <h3 className={cn("px-3 pb-1 text-[11px] font-medium uppercase tracking-wider", section.key === "failed" ? "text-danger" : "text-ink-secondary")}>{section.title}</h3>}
              <ul>{section.routines.map((routine) => {
                const bot = state.bots.find((candidate) => candidate.id === routine.botId);
                const room = routine.target === "room-goal" ? groups.find((group) => group.id === routine.groupId) : undefined;
                const look = routineNeedsLook(routine, state.routineRuns);
                return (
                  <li key={routine.id}>
                    <button type="button" data-routine-row={routine.id} onClick={() => onOpen(routine)} className={ROW_BUTTON}>
                      {bot && <BotAvatar bot={bot} state={routine.enabled ? "idle" : "sleeping"} size={32} animated={false} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                        <span className="block truncate text-[11px] text-ink-secondary">{[room?.name ?? bot?.name, scheduleWords(routine.schedule, now), routine.enabled ? "" : t("ux.l5b.when.paused")].filter(Boolean).join(" · ")}</span>
                      </span>
                      {look && <span className="flex shrink-0 items-center gap-1 text-[11px] text-danger"><CircleAlert size={12} aria-hidden />{t("ux.l5b.needsLook")}</span>}
                    </button>
                  </li>
                );
              })}</ul>
            </section>
          ))}
        </BoxBody>
        {canCreate && (
          <BoxFoot className="justify-end border-t border-hairline/40 px-4 py-3">
            <button type="button" onClick={onNew} className={PRIMARY_BUTTON}>{t("ux.l5b.new.button")}</button>
          </BoxFoot>
        )}
      </div>
    </div>
  );
}
