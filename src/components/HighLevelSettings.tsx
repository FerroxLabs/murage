// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Connections > HighLevel (HL-S2). The owner saves a private integration token on this computer, checks one
// location with it, confirms that location, then chooses per bot whether it may read the CRM or also suggest changes.
// Every suggested change still waits for the owner's card on this computer. The token is never read back: the server
// reports only whether one is saved.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { HIGHLEVEL_READ_TOOL_NAMES, type HighLevelBotAccess } from "../../shared/highlevel";
import { Card, Switch } from "./SettingsPrimitives";

/** HL-S2 is read only (MurageMain 11-04): a bot can read a location or nothing. */
export type HighLevelLevel = "off" | "read";

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
  bots: { botId: string; access: HighLevelBotAccess }[];
}

export interface HighLevelCheck { opId: string; locationId: string; locationName?: string; expiresAt: number }

/** The level a saved grant gives, for the switch. Any grant on this location reads as read (older data may hold a
 * change level; the server reads that as read too). A grant on another location reads as off here. */
export function highlevelLevel(access: HighLevelBotAccess | undefined | null, connectionId: string | undefined): HighLevelLevel {
  const grant = access?.grants.find((row) => row.accountId === connectionId);
  return grant ? "read" : "off";
}

/** The body PUT /api/highlevel/bots/:botId/access takes for a level. Off sends no grants (the bot loses access). */
export function highlevelGrantsFor(level: HighLevelLevel, connectionId: string): { grants: { connectionId: string; ceiling: string; tools: string[] }[] } {
  if (level === "off") return { grants: [] };
  return { grants: [{ connectionId, ceiling: "read", tools: [...HIGHLEVEL_READ_TOOL_NAMES] }] };
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
    const id = locationId.trim();
    if (!id) return;
    const result = await api("/api/highlevel/token/check", { method: "POST", body: JSON.stringify({ locationId: id }) }) as { check: HighLevelCheck };
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
    await api(`/api/highlevel/bots/${botId}/access`, { method: "PUT", body: JSON.stringify(highlevelGrantsFor(level, view.connection.connectionId)) });
    return t("highlevel.accessSaved");
  }, t("highlevel.accessError"));

  const connection = view?.connection?.state === "connected" ? view.connection : null;
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

    {view?.tokenSaved && !connection && <>
      <label htmlFor="highlevel-location" className="mt-4 block text-[13px] font-medium text-ink">{t("highlevel.locationLabel")}</label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input id="highlevel-location" value={locationId} autoComplete="off" spellCheck={false} disabled={Boolean(busy)}
          onChange={(event) => { setLocationId(event.target.value); setCheck(null); setError(""); setNotice(""); }} className={input} />
        <button type="button" onClick={() => void checkLocation()} disabled={Boolean(busy) || !locationId.trim()} className={button}>
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
      <p className="text-[11px] text-ink-secondary">{t("highlevel.botsHelp")}</p>
      <ul className="mt-2 space-y-2">
        {bots.map((bot) => {
          const level = highlevelLevel(view?.bots.find((row) => row.botId === bot.id)?.access, connection.connectionId);
          return <li key={bot.id} className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-ink">{bot.name}</span>
            <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Switch checked={level === "read"} disabled={Boolean(busy)} aria-label={t("highlevel.canReadFor", { name: bot.name })} onClick={() => void setLevel(bot.id, level === "read" ? "off" : "read")} />
              {t("highlevel.canRead")}
            </label>
          </li>;
        })}
      </ul>
    </>}

    {notice && <p role="status" className="mt-3 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </Card>;
}
