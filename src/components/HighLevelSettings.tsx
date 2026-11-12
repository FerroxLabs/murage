// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Connections > HighLevel (HL-S2). The owner saves a private integration token on this computer, checks one
// location with it, confirms that location, then chooses the bot's family levels.
// The token is never read back: the server reports only whether one is saved.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { HIGHLEVEL_FAMILIES, defaultHighLevelFamilies, effectiveHighLevelAccess, type Family, type FamilyLevel, type HighLevelBotAccess, type EffectiveHighLevelAccess } from "../../shared/highlevel";
import { Card, Switch } from "./SettingsPrimitives";

/** The effective family level shown by Settings. */
export type HighLevelLevel = FamilyLevel;
export interface FamilyScopes { present: string[]; missing: string[]; missingNames: string[]; canRead: boolean; canChange: boolean; canFull: boolean }

export interface HighLevelConnectionView {
  connectionId: string;
  locationId: string;
  locationName?: string;
  state: string;
  confirmedAt: string;
}

export interface HighLevelView {
  tokenSaved: boolean;
  connection: HighLevelConnectionView | null;
  redacted?: boolean;
  familyScopes?: Partial<Record<Family, FamilyScopes>>;
  bots: { botId: string; access?: HighLevelBotAccess | EffectiveHighLevelAccess; offered?: boolean; level?: HighLevelLevel }[];
}

export interface HighLevelCheck { opId: string; locationId: string; locationName?: string; expiresAt: number }

/** Display only effective access: old propose rows never show as change access. */
/** Display-only normalization; server status already validated the real bot binding. */
function displayAccess(access: HighLevelBotAccess | EffectiveHighLevelAccess | undefined | null) {
  return access ? effectiveHighLevelAccess(access, { id: access.grants[0]?.botId ?? "", roleBinding: access.roleBinding }) : null;
}
export function highlevelLevel(access: HighLevelBotAccess | EffectiveHighLevelAccess | undefined | null, connectionId: string | undefined): HighLevelLevel {
  const grant = displayAccess(access)?.grants.find(row => row.accountId === connectionId);
  const levels = Object.values(grant?.families ?? {});
  return levels.includes("full") ? "full" : levels.includes("change") ? "change" : levels.includes("read") ? "read" : "off";
}

/** Simple deliberately cannot produce Full control, including when toggling an
 * existing Full grant. Only families with verified write permissions change. */
export function highlevelSimpleFamilies(enabled: boolean, scopes: Partial<Record<Family, Pick<FamilyScopes, "canChange">>> = {}, previous?: Partial<Record<Family, FamilyLevel>>): Record<Family, FamilyLevel> {
  const families = { ...defaultHighLevelFamilies(), ...previous };
  for (const family of HIGHLEVEL_FAMILIES) if (families[family] === "full" || families[family] === "change") families[family] = "read";
  if (enabled) for (const family of HIGHLEVEL_FAMILIES) if (scopes[family]?.canChange) families[family] = "change";
  return families;
}

export function highlevelGrantsFor(level: HighLevelLevel, connectionId: string, scopes: Partial<Record<Family, FamilyScopes>> = {}, previous?: Partial<Record<Family, FamilyLevel>>) {
  if (level === "off") return { grants: [] };
  // Full is available only in the explicit per-family Advanced control.
  return { grants: [{ connectionId, families: highlevelSimpleFamilies(level === "change", scopes, previous),
    ...(level === "change" ? { broaden: Object.fromEntries(HIGHLEVEL_FAMILIES.filter(family => scopes[family]?.canChange).map(family => [family, true])) } : {}),
  }] };
}

/** The one status line under the title. */
export function highlevelStatus(view: HighLevelView | null): string {
  if (!view) return t("highlevel.loading");
  if (!view.tokenSaved) return t("highlevel.noToken");
  const connection = view.connection;
  if (!connection) return t("highlevel.tokenNoLocation");
  if (connection.state === "pending_browser_confirmation") return t("highlevel.reconfirm");
  if (connection.state !== "connected") return t("highlevel.notReady");
  return t("highlevel.connected", { name: connection.locationName ?? connection.locationId });
}

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const input = "min-h-11 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary disabled:opacity-50 " + focus;
const button = "min-h-11 rounded-lg bg-control px-3 text-[12px] font-medium text-ink disabled:opacity-50 " + focus;

export function HighLevelSettings() {
  const { state } = useStore();
  const [view, setView] = useState<HighLevelView | null>(null);
  const [token, setToken] = useState("");
  const [locationId, setLocationId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [check, setCheck] = useState<HighLevelCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const gate = useRef(false);

  const load = useCallback(async () => {
    try { setView(await api("/api/highlevel") as HighLevelView); }
    catch { setError(t("highlevel.loadError")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (name: string, step: () => Promise<string | void>, failure: string) => {
    if (gate.current) return;
    gate.current = true; setBusy(name); setError(""); setNotice("");
    try { const done = await step(); if (done) setNotice(done); await load(); }
    catch (caught) { setError(caught instanceof Error && caught.message && name !== "token" ? caught.message : failure); }
    finally { gate.current = false; setBusy(null); }
  };
  const saveToken = (clear = false) => run("token", async () => {
    const value = clear ? "" : token.trim();
    if (!clear && !value) return;
    if (window.muragebox?.setCredential) await window.muragebox.setCredential("highlevelPrivateToken", value);
    else await api("/api/config", { method: "PUT", body: JSON.stringify({ highlevel: { privateToken: value } }) });
    setToken(""); setCheck(null);
    return t(clear ? "highlevel.tokenRemoved" : "highlevel.tokenSavedNotice");
  }, t(clear ? "highlevel.tokenRemoveError" : "highlevel.tokenSaveError"));
  const checkLocation = () => run("check", async () => {
    const id = locationId.trim() || view?.connection?.locationId;
    if (!id) return;
    const result = await api("/api/highlevel/token/check", { method: "POST", body: JSON.stringify({ locationId: id }) }) as { check: HighLevelCheck; familyScopes?: HighLevelView["familyScopes"] };
    setCheck(result.check);
  }, t("highlevel.checkError"));
  const confirm = () => run("confirm", async () => {
    if (!check) return;
    await api(`/api/highlevel/token/${check.opId}/confirm`, { method: "POST" });
    setCheck(null); setLocationId("");
    return t("highlevel.confirmed");
  }, t("highlevel.confirmError"));
  const disconnect = () => run("disconnect", async () => {
    if (!view?.connection) return;
    await api(`/api/highlevel/connections/${view.connection.connectionId}`, { method: "DELETE" });
    return t("highlevel.disconnected");
  }, t("highlevel.disconnectError"));
  const setLevel = (botId: string, level: HighLevelLevel) => run("bot:" + botId, async () => {
    if (!view?.connection) return;
    const access = view.bots.find(bot => bot.botId === botId)?.access;
    const families = displayAccess(access)?.grants.find(grant => grant.accountId === view.connection!.connectionId)?.families;
    await api(`/api/highlevel/bots/${botId}/access`, { method: "PUT", body: JSON.stringify(highlevelGrantsFor(level, view.connection.connectionId, view.familyScopes, families)) });
    return t("highlevel.accessSaved");
  }, t("highlevel.accessError"));

  const setFamily = (botId: string, family: Family, level: FamilyLevel) => run("bot:" + botId, async () => {
    if (!view?.connection) return;
    const access = view.bots.find((bot) => bot.botId === botId)?.access;
    const grant = displayAccess(access)?.grants.find(row => row.accountId === view.connection!.connectionId);
    const families = grant?.families ?? defaultHighLevelFamilies();
    const levels: readonly FamilyLevel[] = ["off", "read", "change", "full"];
    const broadens = levels.indexOf(level) > levels.indexOf(families[family]);
    await api(`/api/highlevel/bots/${botId}/access`, { method: "PUT", body: JSON.stringify({ grants: [{
      connectionId: view.connection.connectionId, families: { ...families, [family]: level },
      ...(broadens ? { broaden: { [family]: true } } : {}),
    }] }) });
    return t("highlevel.accessSaved");
  }, t("highlevel.accessError"));

  const connection = view?.connection && ["connected", "degraded"].includes(view.connection.state) ? view.connection : null;
  const bots = state.bots.filter((bot) => !bot.hidden);
  return <Card title={t("highlevel.title")} subtitle={t("highlevel.intro")}>
    <p role="status" className="text-[12px] text-ink-secondary">{highlevelStatus(view)}</p>

    <label htmlFor="highlevel-token" className="mt-4 block text-[13px] font-medium text-ink">{t("highlevel.tokenLabel")}</label>
    <div className="mt-1.5 flex flex-wrap gap-2">
      <input id="highlevel-token" data-setting-control="highlevel-heading" type="password" value={token} autoComplete="off" spellCheck={false} disabled={!view || Boolean(busy)}
        placeholder={t(view?.tokenSaved ? "highlevel.pasteReplacement" : "highlevel.pasteToken")}
        onChange={(event) => { setToken(event.target.value); setError(""); setNotice(""); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveToken(); } }} className={input} />
      <button type="button" onClick={() => void saveToken()} disabled={!view || Boolean(busy) || !token.trim()} className={button}>
        {t(busy === "token" ? "highlevel.saving" : "highlevel.save")}
      </button>
      {view?.tokenSaved && <button type="button" onClick={() => void saveToken(true)} disabled={Boolean(busy)} className={"min-h-11 rounded-lg px-2 text-[12px] text-danger disabled:opacity-50 " + focus}>
        {t("highlevel.removeToken")}
      </button>}
    </div>
    <p className="mt-1 text-[11px] text-ink-secondary">{t("highlevel.tokenHelp")}</p>

    {view?.tokenSaved && (!connection || advanced) && <>
      <label htmlFor="highlevel-location" className="mt-4 block text-[13px] font-medium text-ink">{t("highlevel.locationLabel")}</label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input id="highlevel-location" value={locationId} autoComplete="off" spellCheck={false} disabled={Boolean(busy)}
          onChange={(event) => { setLocationId(event.target.value); setCheck(null); setError(""); setNotice(""); }} className={input} />
        <button type="button" onClick={() => void checkLocation()} disabled={Boolean(busy) || (!locationId.trim() && !connection)} className={button}>
          {t(busy === "check" ? "highlevel.checking" : "highlevel.check")}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-secondary">{t("highlevel.locationHelp")}</p>
      {check && <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-ink">{t("highlevel.found", { name: check.locationName ?? check.locationId })}</p>
        <button type="button" onClick={() => void confirm()} disabled={Boolean(busy)} className={button}>{t("highlevel.confirm")}</button>
      </div>}
    </>}

    {connection && <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-medium text-ink">{t("highlevel.botsTitle")}</h4>
        <button type="button" onClick={() => void disconnect()} disabled={Boolean(busy)} className={"min-h-11 rounded-lg px-2 text-[12px] text-danger disabled:opacity-50 " + focus}>{t("highlevel.disconnect")}</button>
      </div>
      <p className="text-[11px] text-ink-secondary">{t("highlevel.canChangeHelp")}</p>
      <button type="button" className={button} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t("highlevel.advanced")}</button>
      {advanced && <p className="text-[11px] text-ink-secondary">{t("highlevel.fullHelp")}</p>}
      <ul className="mt-2 space-y-2">
        {bots.map((bot) => {
          const saved = view?.bots.find((row) => row.botId === bot.id);
          const level = saved?.level ?? highlevelLevel(saved?.access, connection.connectionId);
          const canChange = level === "change" || level === "full";
          const desktop = view?.redacted === false;
          const offered = saved?.offered === true;
          const scopes = view?.familyScopes ?? {};
          const hasWrites = Object.values(scopes).some((family) => family?.canChange);
          const families = displayAccess(saved?.access)?.grants.find(grant => grant.accountId === connection.connectionId)?.families;
          return <li key={bot.id} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-ink">{bot.name}</span>
              <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Switch checked={canChange} disabled={Boolean(busy) || !offered || (!canChange && (!desktop || !hasWrites))}
                  aria-label={t("highlevel.canChangeFor", { name: bot.name })} onClick={() => void setLevel(bot.id, canChange ? "read" : "change")} />
                {t("highlevel.canChange")}
              </label>
            </div>
            {!offered && <p className="text-[11px] text-ink-secondary">{t("highlevel.engineUnsupported")}</p>}
            {!desktop && <p className="text-[11px] text-ink-secondary">{t("highlevel.onComputerGrant")}</p>}
            {advanced && <div className="space-y-2">
              <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void setLevel(bot.id, "off")}>{t("highlevel.removeAccess")}</button>
              {HIGHLEVEL_FAMILIES.map((family) => <div key={family}>
                <label className="flex items-center justify-between gap-2 text-[12px] text-ink">
                  {t(`highlevel.family.${family}`)}
                  <select aria-label={t(`highlevel.family.${family}`)} value={families?.[family] ?? "off"}
                    className={input} disabled={Boolean(busy) || !offered || !desktop}
                    onChange={(event) => void setFamily(bot.id, family, event.target.value as FamilyLevel)}>
                    {(["off", "read", "change", "full"] as const).map((value) => <option key={value} value={value}
                      disabled={value === "read" ? !scopes[family]?.canRead : value === "change" ? !scopes[family]?.canChange : value === "full" ? !scopes[family]?.canFull : false}>{t(`highlevel.level.${value}`)}</option>)}
                  </select>
                </label>
                {Boolean(scopes[family]?.missingNames.length) && <p className="text-[11px] text-ink-secondary">{t("highlevel.missingScopes", { names: scopes[family]!.missingNames.join(", ") })}</p>}
                {!scopes[family]?.present.length && !scopes[family]?.missing.length && <p className="text-[11px] text-ink-secondary">{t("highlevel.scopesUnverified")}</p>}
              </div>)}
            </div>}
          </li>;
        })}
      </ul>
    </>}

    {notice && <p role="status" className="mt-3 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </Card>;
}
