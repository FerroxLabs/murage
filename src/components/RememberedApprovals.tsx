// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings › {bot} › Level: "Things you said yes to for good"
// (UX-TRUST-MOMENTS-1012 2.5). The bot's own keys, then a group per routine,
// each with Take back; payments are never listed (they are never kept); and
// the line "Allowed for the next 12 hours in open conversations: {n}" with
// Clear. Taking back a bot-level key is the computer's alone, so the phone
// (a Cloud home's paired phone too)
// lists those read-only; routine keys and the 12-hour allowances can be taken
// back from the paired phone app too.
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { describeGrant, rememberedGrants, type GrantDescription } from "@/lib/remembered-grants";
import { t } from "@/lib/i18n";
import { approvalSurface } from "@/lib/approval-surface";
import { inNativeShell } from "@/lib/native-shell";

/** 2.3.4: a payment is never kept, so a stray one is never shown either. */
export function listedGrants(keys: readonly string[]): string[] {
  return keys.filter((key) => !key.startsWith("stop:pay:"));
}

const grantWords = (grant: GrantDescription) => (grant.kind === "exact" ? grant.command : grant.text);
const TAKE_BACK = "min-h-11 shrink-0 rounded-lg px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

function GrantRow({ grant, busy, canTakeBack, onTakeBack }: { grant: GrantDescription; busy: boolean; canTakeBack: boolean; onTakeBack: () => void }) {
  return (
    <li data-grant={grant.kind} className="flex items-start justify-between gap-3 rounded-lg bg-inset px-3 py-2">
      <div className="min-w-0 flex-1">
        {grant.kind === "exact" ? (
          <>
            <div className="text-[11.5px] text-ink-secondary">{t("ux.l1.settings.exactCommand")}</div>
            <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-ink">{grant.command}</pre>
            <div className="mt-1 break-words text-[12px] text-ink-secondary">{t("ux.l1.settings.inFolder", { folder: grant.folder, engine: grant.engine })}</div>
          </>
        ) : (
          <div className="break-words text-[13px] text-ink">{grant.text}</div>
        )}
      </div>
      {canTakeBack ? (
        <button type="button" disabled={busy} onClick={onTakeBack} aria-label={t("ux.l1.settings.takeBackLabel", { what: grantWords(grant) })} className={TAKE_BACK}>
          {busy ? t("ux.l1.settings.takingBack") : t("ux.l1.settings.takeBack")}
        </button>
      ) : (
        <span className="shrink-0 py-1 text-[12px] text-ink-secondary">{t("ux.l1.settings.onComputer")}</span>
      )}
    </li>
  );
}

export function RememberedApprovals({ bot, desktop, computer = desktop }: {
  bot: Pick<Bot, "id" | "name" | "alwaysAllow" | "tasks" | "taskAllowanceCount">;
  desktop: boolean | undefined;
  /** the computer running Murage itself (computerHere): a bot-level take-back is its alone; a Cloud home's phone is not it */
  computer?: boolean | undefined;
}) {
  const { state } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [cleared, setCleared] = useState<number | null>(null);
  const surface = approvalSurface(desktop, inNativeShell());
  // routine keys and the 12-hour allowances: the desktop and the paired app
  const companion = surface === "desktop" || surface === "app";
  const held = listedGrants(rememberedGrants(bot));
  const keys = held.filter((key) => !removed.includes(`bot:${key}`));
  const routines = (state.routines ?? [])
    .filter((routine) => routine.botId === bot.id)
    .map((routine) => ({ routine, keys: listedGrants(routine.alwaysAllow ?? []).filter((key) => !removed.includes(`routine:${routine.id}:${key}`)) }))
    .filter((group) => group.keys.length > 0);
  // once the server's update lands, forget what was hidden, so a grant given
  // again later shows up again
  const heldKey = JSON.stringify([held, (state.routines ?? []).map((routine) => routine.alwaysAllow ?? [])]);
  useEffect(() => { setRemoved([]); }, [heldKey]);
  const taskCount = bot.taskAllowanceCount;
  useEffect(() => { setCleared(null); }, [taskCount]);
  if (desktop === undefined) return null;

  const run = async (id: string, path: string, body: Record<string, string> | undefined, failure: string, done: () => void) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      // the bot update arrives over the event stream; hide it now meanwhile
      done();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : failure);
    } finally {
      setBusy(null);
    }
  };
  const takeBackBot = (key: string) => void run(`bot:${key}`, `/api/bots/${encodeURIComponent(bot.id)}/always-allow/remove`, { key }, t("ux.l1.settings.couldNot"), () => setRemoved((current) => [...current, `bot:${key}`]));
  const takeBackRoutine = (routineId: string, key: string) => void run(`routine:${routineId}:${key}`, `/api/routines/${encodeURIComponent(routineId)}/always-allow/remove`, { key }, t("ux.l1.settings.couldNot"), () => setRemoved((current) => [...current, `routine:${routineId}:${key}`]));
  const clearTasks = () => void run("tasks", `/api/bots/${encodeURIComponent(bot.id)}/task-allow/clear`, undefined, t("ux.l1.settings.couldNotClear"), () => setCleared(0));
  const shownCount = cleared ?? taskCount ?? 0;
  const empty = keys.length === 0 && routines.length === 0;

  return (
    <section aria-label={t("ux.l1.settings.title")} data-remembered-grants className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("ux.l1.settings.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {empty ? t("ux.l1.settings.empty") : t("ux.l1.settings.intro", { bot: bot.name })}
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      {keys.length > 0 && (
        <ul className="mt-3 space-y-2" data-grant-list="bot">
          {keys.map((key) => (
            <GrantRow key={key} grant={describeGrant(key, state.instances)} busy={busy === `bot:${key}`} canTakeBack={computer === true} onTakeBack={() => takeBackBot(key)} />
          ))}
        </ul>
      )}
      {routines.map(({ routine, keys: routineKeys }) => (
        <div key={routine.id} className="mt-3" data-grant-list="routine" data-routine-id={routine.id}>
          <div className="text-[12.5px] font-medium text-ink">{t("ux.l1.settings.routineGroup", { routine: routine.name })}</div>
          <ul className="mt-1.5 space-y-2">
            {routineKeys.map((key) => (
              <GrantRow key={key} grant={describeGrant(key, state.instances)} busy={busy === `routine:${routine.id}:${key}`} canTakeBack={companion} onTakeBack={() => takeBackRoutine(routine.id, key)} />
            ))}
          </ul>
        </div>
      ))}
      {taskCount !== undefined && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3 text-[13px] text-ink" data-task-allowances>
          <span>{t("ux.l1.settings.task", { n: shownCount })}</span>
          {companion && (
            <button type="button" disabled={busy !== null || shownCount === 0} onClick={clearTasks} aria-label={t("ux.l1.settings.clearLabel")} className={TAKE_BACK}>
              {busy === "tasks" ? t("ux.l1.settings.clearing") : t("ux.l1.settings.clear")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
