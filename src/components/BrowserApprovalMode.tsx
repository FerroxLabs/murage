// SPDX-License-Identifier: AGPL-3.0-or-later
// How the bot asks in the owner's browser (spec 2.2, 9.7, 9.8, 9.10): the mode selector, the
// danger-zone dialog for Full permissive, the action-check switch and the one-time upgrade notice.
import { useEffect, useState, type ReactNode } from "react";
import { api, type Bot } from "@/state/store";
import { isPhoneClient } from "@/lib/phone-client";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type ApprovalMode = "step" | "task" | "full";
export type ActionCheck = "flux" | "bot";
const control = "min-h-11 rounded-lg bg-control px-3 py-2 text-sm text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const UPGRADE_KEY = "murage.browserExt.upgradeNotice.0.1.63";

export const upgradeNoticeText = (bot: string) => t("browserExt.upgrade.notice", { bot });
type Request = (path: string, init?: RequestInit) => Promise<any>;
/** Full permissive carries the typed bot name; the server (T10) checks it again and refuses anything but the desktop app. */
export function setApprovalMode(request: Request, botId: string, mode: ApprovalMode, confirmName?: string) {
  return request(`/api/bots/${encodeURIComponent(botId)}/browser-extension/mode`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "full" ? { mode, confirmName } : { mode }) });
}

/** The amber and black hazard stripe Sean picked for Full permissive (T30A, variant B); same gradient and token as the page cue. */
export function HazardStripe() {
  return <div data-hazard aria-hidden="true" className="h-1.5 w-full rounded-sm" style={{ background: "repeating-linear-gradient(135deg,var(--color-warning) 0 9px,var(--color-app) 9px 18px)" }} />;
}
export function setActionCheck(request: Request, botId: string, check: ActionCheck) {
  return request(`/api/bots/${encodeURIComponent(botId)}/browser-extension/check`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ check }) });
}

export function FullPermissiveDialog({ botName, typed, pending, error, onTyped, onConfirm, onCancel }: { botName: string; typed: string; pending: boolean; error: string; onTyped: (value: string) => void; onConfirm: () => void; onCancel: () => void }) {
  return <div role="dialog" aria-label={t("browserExt.full.title", { bot: botName })} className="flex flex-col gap-3 rounded-lg bg-card p-3 text-sm text-ink">
    <HazardStripe />
    <h4 className="font-medium">{t("browserExt.full.title", { bot: botName })}</h4>
    <p>{t("browserExt.full.body1", { bot: botName })}</p>
    <p className="text-ink-secondary">{t("browserExt.full.body2", { bot: botName })}</p>
    <p className="text-ink-secondary">{t("browserExt.full.body3")}</p>
    <p className="text-ink-secondary">{t("browserExt.full.body4", { bot: botName })}</p>
    <label className="flex flex-col gap-2">{t("browserExt.full.confirmLabel", { bot: botName })}<input className={control} value={typed} autoComplete="off" spellCheck={false} onChange={event => onTyped(event.target.value)} /></label>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2"><button className={control} disabled={pending || typed !== botName} onClick={onConfirm}>{t("browserExt.full.confirm")}</button><button className={control} disabled={pending} onClick={onCancel}>{t("browserExt.full.cancel")}</button></div>
  </div>;
}

type ViewProps = { botName: string; mode: ApprovalMode; actionCheck: ActionCheck; phone: boolean; pending: boolean; error: string; dialogOpen: boolean; typed: string; checkerAvailable?: boolean; checkerReason?: string; checkerFallback?: boolean;
  onMode: (mode: "step" | "task") => void; onOpenFull: () => void; onTyped: (value: string) => void; onConfirmFull: () => void; onCancelFull: () => void; onTurnOff: () => void; onActionCheck: (value: ActionCheck) => void };
export function BrowserApprovalModeView({ botName, mode, actionCheck, phone, pending, error, dialogOpen, typed, checkerAvailable = true, checkerReason, checkerFallback = false, onMode, onOpenFull, onTyped, onConfirmFull, onCancelFull, onTurnOff, onActionCheck }: ViewProps) {
  const choice = (key: ApprovalMode, label: ReactNode, desc: string, onClick: () => void, locked = false) =>
    <button key={key} type="button" role="radio" aria-checked={mode === key} data-mode={key} disabled={pending || (locked && mode !== key)} onClick={onClick} className={`${control} flex flex-col items-start gap-1 border text-left ${mode === key ? "border-accent" : "border-hairline"}`}><span className="font-medium">{label}</span><span className="text-ink-secondary">{desc}</span></button>;
  return <section aria-label={t("browserExt.mode.label", { bot: botName })} className="flex flex-col gap-3 text-sm text-ink">
    <h4 className="font-medium">{t("browserExt.mode.label", { bot: botName })}</h4>
    {mode === "full" && <div role="status" className="flex flex-col gap-2 rounded-lg bg-card p-3"><HazardStripe /><div className="flex flex-wrap items-center gap-2"><span className="rounded bg-warning px-2 py-0.5 text-xs font-medium text-black">{t("browserExt.mode.full.name")}</span><span>{phone ? t("browserExt.full.phoneOn") : t("browserExt.full.bannerOn", { bot: botName })}</span><button className={control} disabled={pending} onClick={onTurnOff}>{t("browserExt.full.turnOff")}</button></div></div>}
    <div role="radiogroup" aria-label={t("browserExt.mode.label", { bot: botName })} className="flex flex-col gap-2">
      {choice("step", t("browserExt.mode.step.name"), t("browserExt.mode.step.desc", { bot: botName }), () => onMode("step"))}
      {(!phone || mode !== "step") && choice("task", <>{t("browserExt.mode.task.name")} {checkerAvailable && <span className="text-xs text-accent">({t("browserExt.mode.task.recommended")})</span>}</>, t("browserExt.mode.task.desc", { bot: botName }), () => onMode("task"), !checkerAvailable)}
      {(!phone || mode === "full") && choice("full", t("browserExt.mode.full.name"), t("browserExt.mode.full.desc", { bot: botName }), phone ? onTurnOff : onOpenFull)}
    </div>
    {phone && mode !== "full" && <p className="text-xs text-ink-secondary">{t("browserExt.full.errorDesktopOnly")}</p>}
    <p className="text-xs text-ink-secondary">{t("browserExt.mode.floorNote", { bot: botName })}</p>
    {dialogOpen && !phone && <FullPermissiveDialog botName={botName} typed={typed} pending={pending} error={error} onTyped={onTyped} onConfirm={onConfirmFull} onCancel={onCancelFull} />}
    {error && !dialogOpen && <p role="alert" className="text-danger">{error}</p>}
    <div role="radiogroup" aria-label={t("browserExt.actionCheck.label")} className="flex flex-col gap-2">
      <span className="font-medium">{t("browserExt.actionCheck.label")}</span>
      {(["flux", "bot"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={actionCheck === value} data-check={value} disabled={pending || phone} className={`${control} text-left ${actionCheck === value ? "border border-accent" : "border border-hairline"}`} onClick={() => onActionCheck(value)}>{value === "flux" ? t("browserExt.actionCheck.flux") : t("browserExt.actionCheck.bot", { bot: botName })}</button>)}
      <p className="text-xs text-ink-secondary">{t("browserExt.checker.settingsLine")}</p>
      {checkerAvailable && checkerFallback && <p role="status" data-check-fallback className="text-xs text-ink-secondary">{t("browserExt.checker.fallbackBot", { bot: botName })}</p>}
      {!checkerAvailable && <p role="status" className="text-xs text-ink-secondary">{t("browserExt.checker.askEachStepUntil")}{checkerReason ? ` ${checkerReason}` : ""}</p>}
    </div>
  </section>;
}

type Botish = Pick<Bot, "id" | "name">;
export function BrowserApprovalMode({ bot, phone = isPhoneClient() }: { bot: Botish; phone?: boolean }) {
  const [mode, setMode] = useState<ApprovalMode>("task");
  const [actionCheck, setCheckState] = useState<ActionCheck>("flux");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [fallback, setFallback] = useState(false);
  const [notice, setNotice] = useState(false);
  const applyAvailability = (result: { checkerAvailable?: boolean; checkerReason?: string; checkerFallback?: boolean }) => { setAvailable(result.checkerAvailable === true); setFallback(result.checkerFallback === true); setReason(result.checkerReason ? t(result.checkerReason as LocaleKey) : undefined); };
  const url = `/api/bots/${encodeURIComponent(bot.id)}/browser-extension/mode`;
  useEffect(() => {
    let alive = true; setDialogOpen(false); setTyped(""); setError(""); setAvailable(null); setReason(undefined); setFallback(false);
    api(url).then((result: { mode?: ApprovalMode; actionCheck?: ActionCheck; checkerAvailable?: boolean; checkerReason?: string; checkerFallback?: boolean }) => { if (!alive) return; setMode(result.mode ?? "task"); setCheckState(result.actionCheck ?? "flux"); applyAvailability(result); }).catch(() => { if (alive) { setAvailable(false); setReason(t("browserExt.checker.reasonUnavailable")); } });
    try { if (!localStorage.getItem(UPGRADE_KEY)) setNotice(true); } catch { /* no storage: skip the notice */ }
    return () => { alive = false; };
  }, [url]);
  const run = async (next: ApprovalMode, confirmName?: string) => {
    setPending(true); setError("");
    try { const result = await setApprovalMode(api, bot.id, next, confirmName); setMode(result?.mode ?? next); setDialogOpen(false); setTyped(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("browserExt.full.errorConfirmName")); }
    finally { setPending(false); }
  };
  const dismiss = () => { setNotice(false); try { localStorage.setItem(UPGRADE_KEY, "1"); } catch { /* ignore */ } };
  const saveCheck = async (value: ActionCheck) => {
    setPending(true); setError("");
    try { const result = await setActionCheck(api, bot.id, value); setCheckState(value); applyAvailability(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ""); }
    finally { setPending(false); }
  };
  return <>
    {notice && <div role="status" className="flex flex-col gap-2 rounded-lg bg-card p-3 text-sm text-ink"><p>{upgradeNoticeText(bot.name)}</p><button className={control} onClick={dismiss}>{t("browserExt.upgrade.dismiss")}</button></div>}
    <BrowserApprovalModeView botName={bot.name} mode={mode} actionCheck={actionCheck} phone={phone} pending={pending} error={error} dialogOpen={dialogOpen} typed={typed} checkerAvailable={available === true} checkerReason={reason} checkerFallback={fallback}
      onMode={next => void run(next)} onOpenFull={() => { setError(""); setDialogOpen(true); }} onTyped={setTyped} onConfirmFull={() => void run("full", typed)} onCancelFull={() => { setDialogOpen(false); setTyped(""); setError(""); }} onTurnOff={() => void run("task")} onActionCheck={value => void saveCheck(value)} />
  </>;
}
