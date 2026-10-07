// SPDX-License-Identifier: AGPL-3.0-or-later
// Approved sites per bot per browser profile (spec 2.3, 9.9). Desktop edits everything; the phone may only Revoke.
import { useCallback, useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { isPhoneClient } from "@/lib/phone-client";
import { categoryFor, type SiteCategory } from "../../shared/browser-site-categories";
import { t } from "@/lib/i18n";

export type SiteRule = "allow" | "ask" | "never";
export type ApprovedSite = { origin: string; rule: SiteRule; lowered?: boolean };
const control = "min-h-11 rounded-lg bg-control px-3 py-2 text-sm text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BADGES: Partial<Record<SiteCategory, "browserExt.badge.askEveryStep" | "browserExt.badge.neverDefault" | "browserExt.badge.handover">> = { askEveryStep: "browserExt.badge.askEveryStep", neverDefault: "browserExt.badge.neverDefault", handover: "browserExt.badge.handover" };
export function siteCategory(origin: string): SiteCategory {
  try { return categoryFor(new URL(origin).hostname); } catch { return "askEveryStep"; }
}

type ViewProps = { botName: string; sites: ApprovedSite[]; phone: boolean; pending: boolean; error: string; lowering: string | null;
  onSet: (origin: string, rule: SiteRule, lowered?: boolean) => void; onLowerAsk: (origin: string) => void; onLowerKeep: () => void;
  /** Lifting a Never site: the rule the owner asked for, held until they confirm the warning. */
  liftTarget?: { origin: string; rule: "ask" | "allow" } | null; onLiftAsk?: (origin: string, rule: "ask" | "allow") => void; onLiftKeep?: () => void;
  /** Sites the bot used in a task that has ended (spec 2.3, 9.9): offer Allow always. */
  offers?: string[]; onDismissOffer?: (origin: string) => void;
  /** A failed save turned the Allow always sites back to Ask: said once, in plain words, until the owner dismisses it. */
  loweredNote?: boolean; onDismissLowered?: () => void };
export function BrowserApprovedSitesView({ botName, sites, phone, pending, error, lowering, onSet, onLowerAsk, onLowerKeep, liftTarget = null, onLiftAsk, onLiftKeep, offers = [], onDismissOffer, loweredNote = false, onDismissLowered }: ViewProps) {
  const ruleOf = (origin: string) => sites.find(site => site.origin === origin)?.rule;
  const offered = phone ? [] : offers.filter(origin => { const rule = ruleOf(origin); return (rule === undefined || rule === "ask") && siteCategory(origin) === "normal"; });
  const change = (site: ApprovedSite, rule: "ask" | "allow") => site.rule === "never" && onLiftAsk ? onLiftAsk(site.origin, rule) : onSet(site.origin, rule);
  const act = (origin: string, action: string, label: string, onClick: () => void) => <button key={action} type="button" className={control} data-origin={origin} data-action={action} disabled={pending} onClick={onClick}>{label}</button>;
  return <section aria-label={t("browserExt.panel.approvedSites")} className="flex flex-col gap-3 text-sm text-ink">
    <h4 className="font-medium">{t("browserExt.panel.approvedSites")}</h4>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {loweredNote && <div role="status" data-note="lowered" className="flex flex-col gap-2 rounded-lg bg-card p-3"><p>{t("browserExt.sites.loweredNote")}</p><button type="button" className={control} data-action="dismiss-lowered" onClick={onDismissLowered}>{t("browserExt.upgrade.dismiss")}</button></div>}
    {!sites.length && <p className="text-ink-secondary">{t("browserExt.sites.empty", { bot: botName })}</p>}
    {sites.map(site => {
      const category = siteCategory(site.origin); const badge = BADGES[category]; const handover = category === "handover";
      return <div key={site.origin} className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline p-3">
        <span className="break-all">{site.origin}</span>
        <span className="flex flex-wrap gap-2 text-xs text-ink-secondary">{badge && !site.lowered && <span data-badge={category}>{t(badge)}</span>}<span>{site.rule === "allow" ? t("browserExt.site.always") : site.rule === "never" ? t("browserExt.site.neverRow") : t("browserExt.site.ask")}</span></span>
        {!handover && <div className="flex flex-wrap gap-2">
          {site.rule === "allow" && act(site.origin, "revoke", t("browserExt.site.revoke"), () => onSet(site.origin, "ask"))}
          {!phone && site.rule !== "allow" && act(site.origin, "allow", t("browserExt.site.always"), () => change(site, "allow"))}
          {!phone && site.rule !== "ask" && act(site.origin, "ask", t("browserExt.site.ask"), () => change(site, "ask"))}
          {!phone && site.rule !== "never" && act(site.origin, "never", t("browserExt.site.neverRow"), () => onSet(site.origin, "never"))}
          {!phone && category === "askEveryStep" && !site.lowered && site.rule === "ask" && act(site.origin, "lower", t("browserExt.lower.work"), () => onLowerAsk(site.origin))}
        </div>}
      </div>;
    })}
    {offered.map(origin => <div key={origin} role="status" className="flex flex-col gap-2 rounded-lg bg-card p-3">
      <p>{t("browserExt.endOfTask.title", { bot: botName, site: origin })}</p>
      <div className="flex flex-wrap gap-2"><button className={control} data-offer="allow" data-origin={origin} disabled={pending} onClick={() => onSet(origin, "allow")}>{t("browserExt.endOfTask.allow")}</button><button className={control} data-offer="no" data-origin={origin} onClick={() => onDismissOffer?.(origin)}>{t("browserExt.endOfTask.no")}</button></div>
    </div>)}
    {liftTarget && !phone && <div role="dialog" aria-label={t("browserExt.never.title", { bot: botName, site: liftTarget.origin })} className="flex flex-col gap-3 rounded-lg bg-card p-3">
      <h4 className="font-medium">{t("browserExt.never.title", { bot: botName, site: liftTarget.origin })}</h4>
      <p className="text-ink-secondary">{t("browserExt.never.body", { bot: botName, site: liftTarget.origin })}</p>
      <div className="flex flex-wrap gap-2"><button className={control} data-confirm="lift" disabled={pending} onClick={() => onSet(liftTarget.origin, liftTarget.rule)}>{t("browserExt.never.lift")}</button><button className={control} data-confirm="keepNever" disabled={pending} onClick={() => onLiftKeep?.()}>{t("browserExt.never.keep")}</button></div>
    </div>}
    {lowering && !phone && <div role="dialog" aria-label={t("browserExt.lower.title", { bot: botName, site: lowering })} className="flex flex-col gap-3 rounded-lg bg-card p-3">
      <h4 className="font-medium">{t("browserExt.lower.title", { bot: botName, site: lowering })}</h4>
      <p className="text-ink-secondary">{t("browserExt.lower.body", { site: lowering })}</p>
      <div className="flex flex-wrap gap-2"><button className={control} data-confirm="work" disabled={pending} onClick={() => onSet(lowering, "ask", true)}>{t("browserExt.lower.work")}</button><button className={control} data-confirm="keep" disabled={pending} onClick={onLowerKeep}>{t("browserExt.lower.keep")}</button></div>
    </div>}
    <p className="text-xs text-ink-secondary">{t("browserExt.listsNote")}</p>
  </section>;
}

export function BrowserApprovedSites({ bot, profileId, phone = isPhoneClient(), endedBindingIds = [], sitesLowered = false }: { bot: Pick<Bot, "id" | "name">; profileId?: string; phone?: boolean; endedBindingIds?: string[]; /** The status poll says a failed save turned Allow always sites back to Ask: shown without opening the list. */ sitesLowered?: boolean }) {
  const [sites, setSites] = useState<ApprovedSite[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [lowering, setLowering] = useState<string | null>(null);
  const [lift, setLift] = useState<{ origin: string; rule: "ask" | "allow" } | null>(null);
  const [used, setUsed] = useState<string[]>([]);
  const [loweredNote, setLoweredNote] = useState(sitesLowered);
  useEffect(() => { if (sitesLowered) setLoweredNote(true); }, [sitesLowered]);
  const [dismissed, setDismissed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(`murage.browserExt.offerDismissed.${bot.id}`) ?? "[]"); } catch { return []; } });
  const ended = endedBindingIds.join(",");
  useEffect(() => {
    if (!ended || phone) { setUsed([]); return; }
    let alive = true; const ids = new Set(ended.split(","));
    api(`/api/bots/${encodeURIComponent(bot.id)}/browser-extension/activity`).then((result: { activity?: { bindingId: string; site: string }[] }) => {
      if (alive) setUsed([...new Set((result.activity ?? []).filter(line => ids.has(line.bindingId)).map(line => /^https?:\/\//.test(line.site) ? line.site : `https://${line.site}`))]);
    }).catch(() => {});
    return () => { alive = false; };
  }, [bot.id, ended, phone]);
  const dismiss = (origin: string) => { const next = [...dismissed, origin]; setDismissed(next); try { localStorage.setItem(`murage.browserExt.offerDismissed.${bot.id}`, JSON.stringify(next)); } catch { /* no storage */ } };
  const base = `/api/bots/${encodeURIComponent(bot.id)}/browser-extension/sites`;
  const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
  const load = useCallback(async () => { try { const result = await api(base + query); setSites(Array.isArray(result.sites) ? result.sites : []); if (result.sitesLowered === true) setLoweredNote(true); } catch (cause) { setError(cause instanceof Error ? cause.message : ""); } }, [base, query]);
  useEffect(() => { void load(); }, [load]);
  const set = async (origin: string, rule: SiteRule, lowered?: boolean) => {
    setPending(true); setError("");
    try { await api(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(profileId ? { profileId } : {}), origin, rule, ...(lowered ? { lowered } : {}) }) }); setLowering(null); setLift(null); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : ""); } finally { setPending(false); }
  };
  return <BrowserApprovedSitesView botName={bot.name} sites={sites} phone={phone} pending={pending} error={error} lowering={lowering} onSet={(o, r, l) => void set(o, r, l)} onLowerAsk={setLowering} onLowerKeep={() => setLowering(null)} liftTarget={lift} onLiftAsk={(origin, rule) => setLift({ origin, rule })} onLiftKeep={() => setLift(null)} offers={used.filter(origin => !dismissed.includes(origin))} onDismissOffer={dismiss} loweredNote={loweredNote} onDismissLowered={() => setLoweredNote(false)} />;
}
