// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K / SL-I controls: chats that follow their bot's model, the
// engine that takes over at a limit, the limit offer card, and Refresh
// permissions. The server decides every rule; these only ask it.
import { useState } from "react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Chats of this bot with a model of their own (the loaded window of them). */
export function ownModelChats(bot: Pick<Bot, "tasks">): number {
  return (bot.tasks ?? []).filter((task) => task.followsBotModel === false).length;
}

export function ownModelLine(count: number): string {
  return count === 1 ? t("slik.ownModelOne") : t("slik.ownModelMany", { n: count });
}

/** Bot model section: "{n} chats use their own model" and "Switch them too". */
export function BotFollowModelRow({ bot }: { bot: Bot }) {
  const count = ownModelChats(bot);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!count && !note) return null;
  const run = async () => {
    setBusy(true); setNote("");
    try {
      const result = await api(`/api/bots/${bot.id}/threads/follow-model`, { method: "POST", body: "{}" }) as { switched: number; busy: number };
      setNote(result.busy ? t("slik.switchBusy", { n: result.busy }) : t("slik.switchDone"));
    } catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <div data-follow-model-row className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-secondary">
      {count > 0 && <span>{ownModelLine(count)}</span>}
      {count > 0 && <button type="button" disabled={busy} onClick={() => void run()} className="rounded-lg border border-hairline/50 px-2.5 py-1 text-[13px] text-ink hover:bg-control/60 disabled:opacity-60">{t("slik.switchThemToo")}</button>}
      {note && <span role="status" className="w-full">{note}</span>}
    </div>
  );
}

/** Bot model section: the engine that takes over when this bot's engine hits its limit. */
export function LimitBackupRow({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [error, setError] = useState("");
  const current = bot.limitBackup;
  const choices = state.instances.filter((instance) => instance.enabled !== false && instance.instanceId !== bot.modelSelection.instanceId
    && (instance.models.default || instance.models.options[0]?.id));
  const save = async (instanceId: string, routines: boolean) => {
    setError("");
    try {
      if (!instanceId) { await api(`/api/bots/${bot.id}/limit-backup`, { method: "DELETE" }); return; }
      const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
      const model = instance?.models.default || instance?.models.options[0]?.id || "";
      await api(`/api/bots/${bot.id}/limit-backup`, { method: "PUT", body: JSON.stringify({ selection: { instanceId, model }, routines }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <div data-limit-backup className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("slik.backupTitle")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("slik.backupDetail")}</div>
      <select aria-label={t("slik.backupTitle")} value={current?.selection.instanceId ?? ""} onChange={(event) => void save(event.target.value, current?.routines === true)} className="mt-3 w-full rounded-md bg-inset px-2 py-1.5 text-sm text-ink">
        <option value="">{t("slik.backupNone")}</option>
        {choices.map((instance) => <option key={instance.instanceId} value={instance.instanceId}>{instance.displayName}</option>)}
      </select>
      {current && (
        <label className="mt-3 flex items-start gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={current.routines} onChange={(event) => void save(current.selection.instanceId, event.target.checked)} className="mt-0.5" />
          <span>{t("slik.backupRoutines")}<span className="block text-ink-secondary">{t("slik.backupRoutinesHint")}</span></span>
        </label>
      )}
      {error && <div role="alert" className="mt-2 text-[13px] text-warning">{error}</div>}
    </div>
  );
}

/** 1.0.4 SL-I I3: a routine run waiting for its engine's limit to reset. */
export function limitWaitLabel(engineKey: string, instances: ReadonlyArray<{ instanceId: string; displayName: string }>): string {
  const id = engineKey.replace(/^(?:engine|connection):/, "");
  const engine = engineKey.startsWith("engine:") ? instances.find((instance) => instance.instanceId === id)?.displayName ?? id : t("slik.connectedAccount");
  return t("slik.waitingForLimit", { engine });
}

export const LIMIT_CARD_TOOL = "murage_limit_offer";
export const isLimitOfferCard = (message: Pick<Message, "card">): boolean => message.card?.tool === LIMIT_CARD_TOOL && Boolean(message.card.limitOffer);

/** The engine hit its limit: pick another engine for this message, or wait. */
export function LimitOfferCard({ threadId, message }: { threadId: string; message: Message }) {
  const card = message.card!;
  const offer = card.limitOffer!;
  const [nextTime, setNextTime] = useState(false);
  const [routines, setRoutines] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const settled = Boolean(card.answered || card.dismissed);
  const answer = async (label: string) => {
    setBusy(true); setError("");
    try {
      await api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, behavior: "answer", message: label, ...(label === "Wait" ? {} : { limitNextTime: nextTime, limitRoutines: nextTime && routines }) }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <div data-limit-offer className="w-full max-w-[840px] rounded-xl border border-hairline/40 bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{card.title}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{card.subtitle}</div>
      {settled ? <div className="mt-3 text-[13px] text-ink-secondary">{card.answered}</div> : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {card.options.map((option) => (
              <button key={option} type="button" disabled={busy} onClick={() => void answer(option)} className={cn("rounded-lg px-3 py-1.5 text-[13px]", option === "Wait" ? "border border-hairline/50 text-ink" : "bg-accent text-white", "disabled:opacity-60")}>{option === "Wait" ? t("slik.wait") : option}</button>
            ))}
          </div>
          {offer.choices.length > 0 && (
            <div className="mt-3 space-y-1 text-[13px] text-ink">
              <label className="flex items-center gap-2"><input type="checkbox" checked={nextTime} onChange={(event) => setNextTime(event.target.checked)} />{t("slik.limitNextTime")}</label>
              {nextTime && <label className="flex items-center gap-2"><input type="checkbox" checked={routines} onChange={(event) => setRoutines(event.target.checked)} />{t("slik.backupRoutines")}</label>}
            </div>
          )}
        </>
      )}
      {error && <div role="alert" className="mt-2 text-[13px] text-warning">{error}</div>}
    </div>
  );
}

const LEVEL_KEYS = { ask: "slik.levelAsk", auto: "slik.levelAuto", full: "slik.levelFull", "no-limits": "slik.levelNoLimits" } as const;
type Level = keyof typeof LEVEL_KEYS;

/** Copy the bot's permissions onto this chat, after showing what changes (desktop only). */
export function RefreshPermissionsButton({ botId, threadId, onDone }: { botId: string; threadId: string; onDone?: () => void }) {
  const [preview, setPreview] = useState<{ previewId: string; level: { from: Level; to: Level }; alwaysAllowAdd: string[] } | null>(null);
  const [error, setError] = useState("");
  const path = `/api/bots/${botId}/tasks/${threadId}/permissions/refresh`;
  const ask = async () => {
    setError("");
    try { setPreview(await api(path, { method: "POST", body: "{}" })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const apply = async () => {
    if (!preview) return;
    try { await api(path, { method: "POST", body: JSON.stringify({ previewId: preview.previewId }) }); setPreview(null); onDone?.(); }
    catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <div data-refresh-permissions className="border-t border-hairline/20 px-4 py-3 text-[13px]">
      {!preview && <button type="button" onClick={() => void ask()} className="text-accent">{t("slik.refreshPermissions")}</button>}
      {preview && (
        <div className="space-y-2">
          <div className="text-ink">{t("slik.refreshPreview", { from: t(LEVEL_KEYS[preview.level.from]), to: t(LEVEL_KEYS[preview.level.to]) })}</div>
          {preview.alwaysAllowAdd.length > 0 && <div className="text-ink-secondary">{t("slik.refreshAdds", { list: preview.alwaysAllowAdd.join(", ") })}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={() => void apply()} className="rounded-lg bg-accent px-3 py-1 text-white">{t("slik.refreshApply")}</button>
            <button type="button" onClick={() => setPreview(null)} className="rounded-lg border border-hairline/50 px-3 py-1 text-ink">{t("slik.refreshCancel")}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="mt-1 text-warning">{error}</div>}
    </div>
  );
}
