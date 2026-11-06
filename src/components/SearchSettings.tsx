import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { InAdvanced } from "./SettingsPrimitives";

type SearchProvider = "engine" | "auto" | "flux" | "tavily" | "exa" | "firecrawl" | "off";
type KeyProvider = "tavily" | "exa" | "firecrawl";
const labels = { tavily: "Tavily", exa: "Exa", firecrawl: "Firecrawl" } as const;
const keyFields = { tavily: "tavilyApiKey", exa: "exaApiKey", firecrawl: "firecrawlApiKey" } as const;
const credentialNames = { tavily: "tavilySearchApiKey", exa: "exaSearchApiKey", firecrawl: "firecrawlSearchApiKey" } as const;
const configuredFields = { tavily: "tavilyConfigured", exa: "exaConfigured", firecrawl: "firecrawlConfigured" } as const;

/** Credential custody and provider selection are separate writes. Saving a
 * key never probes the paid service or silently changes the chosen provider. */
export function SearchSettings() {
  const { state, dispatch } = useStore();
  const search = state.config?.webSearch;
  const [values, setValues] = useState({ tavily: "", exa: "", firecrawl: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Where the last result belongs: a key saved under Advanced reports there, a provider choice reports above it.
  const [where, setWhere] = useState<"provider" | "keys">("provider");
  const gate = useRef(false);
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

  const choose = async (provider: SearchProvider) => {
    if (!search || gate.current || provider === search.provider) return;
    gate.current = true; setBusy("provider"); setWhere("provider"); setError(""); setNotice("");
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { provider } }) }) as ConfigStatus;
      if (config.webSearch?.provider !== provider) throw new Error("Provider save was not confirmed");
      dispatch({ type: "configStatus", config });
      setNotice(t("searchSettings.providerSaved"));
    } catch { setError(t("searchSettings.providerSaveError")); }
    finally { gate.current = false; setBusy(null); }
  };
  const saveKey = async (provider: KeyProvider, clear = false) => {
    if (!search || gate.current) return;
    const value = clear ? "" : values[provider].trim();
    if (!clear && !value) return;
    gate.current = true; setBusy(provider + (clear ? "-clear" : "-save")); setWhere("keys"); setError(""); setNotice("");
    try {
      const config: ConfigStatus = window.muragebox?.setCredential
        ? await window.muragebox.setCredential(credentialNames[provider], value)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { [keyFields[provider]]: value } }) });
      const configured = config.webSearch?.[configuredFields[provider]];
      if (configured !== !clear) throw new Error("Credential save was not confirmed");
      dispatch({ type: "configStatus", config });
      setValues(current => ({ ...current, [provider]: "" }));
      setNotice(t(clear ? "searchSettings.keyRemoved" : "searchSettings.keySavedNotice", { provider: labels[provider] }));
    } catch { setError(t(clear ? "searchSettings.keyRemoveError" : "searchSettings.keySaveError", { provider: labels[provider] })); }
    finally { gate.current = false; setBusy(null); }
  };
  return <><section aria-labelledby="web-search-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="web-search-settings-title" className="text-[15px] font-medium text-ink">{t("searchSettings.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("searchSettings.intro")}</p>
    {!search && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("searchSettings.unavailable")}</p>}
    <label className="mt-3 block text-[12px] font-medium text-ink" htmlFor="web-search-provider">{t("searchSettings.provider")}</label>
    <select id="web-search-provider" value={search?.provider ?? "engine"} disabled={!search || Boolean(busy)}
      onChange={event => void choose(event.target.value as SearchProvider)}
      className={"mt-1 min-h-11 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50 " + focus}>
      <option value="engine">Engine search first, then Parallel and DuckDuckGo if needed</option>
      <option value="auto">No key needed: Parallel, then DuckDuckGo</option>
      <option value="flux">{t("searchSettings.fluxOption")}</option>
      <option value="tavily">Tavily</option>
      <option value="exa">Exa</option>
      <option value="firecrawl">Firecrawl</option>
      <option value="off">{t("searchSettings.offOption")}</option>
    </select>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{search?.provider === "off"
      ? t("searchSettings.offHelp")
      : search?.provider === "auto"
        ? "No API key required. Queries go to Parallel and, if it fails, DuckDuckGo. Either service may change what it offers."
      : search?.provider === "flux"
        ? t(search.fluxConfigured ? "searchSettings.fluxHelp" : "searchSettings.fluxNoKey")
      : search?.provider === "engine"
        ? "Use the engine's own search first. If unavailable, failed or limited, the bot can use Murage's backup: Parallel, then DuckDuckGo. Backup queries are sent to those services; your own search keys are never used automatically."
        : t("searchSettings.externalHelp")}</p>
    {busy === "provider" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("searchSettings.savingProvider")}</p>}
    {where === "provider" && notice && <p role="status" className="mt-3 text-[12px] text-success">{notice}</p>}
    {where === "provider" && error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </section>
  <InAdvanced><section id="search-keys-heading" tabIndex={-1} aria-label={t("settings.l4.searchKeys.title")} className="rounded-xl bg-card p-4 outline-none">
    <h3 className="text-[15px] font-medium text-ink">{t("settings.l4.searchKeys.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("settings.l4.searchKeys.note")}</p>
    <div className="mt-4 space-y-4">
      {(["tavily", "exa", "firecrawl"] as const).map(provider => {
        const configured = search?.[configuredFields[provider]] === true;
        const name = labels[provider];
        return <div key={provider}>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={provider + "-search-key"} className="text-[13px] font-medium text-ink">{t("searchSettings.apiKey", { provider: name })}</label>
            <span className={"text-[11px] " + (configured ? "text-success" : "text-ink-secondary")}>{t(configured ? "searchSettings.keySaved" : "searchSettings.noKey")}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input id={provider + "-search-key"} type="password" value={values[provider]} autoComplete="off" spellCheck={false}
              placeholder={t(configured ? "searchSettings.pasteReplacement" : "searchSettings.pasteKey")} disabled={!search || Boolean(busy)}
              onChange={event => { setValues(current => ({ ...current, [provider]: event.target.value })); setError(""); setNotice(""); }}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveKey(provider); } }}
              className={"min-h-11 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary disabled:opacity-50 " + focus} />
            <button type="button" onClick={() => void saveKey(provider)} disabled={!search || Boolean(busy) || !values[provider].trim()}
              aria-label={t("searchSettings.saveKey", { provider: name })} className={"min-h-11 rounded-lg bg-control px-3 text-[12px] font-medium text-ink disabled:opacity-50 " + focus}>
              {t(busy === provider + "-save" ? "searchSettings.saving" : "searchSettings.save")}
            </button>
            {configured && <button type="button" onClick={() => void saveKey(provider, true)} disabled={!search || Boolean(busy)}
              aria-label={t("searchSettings.clearKey", { provider: name })} className={"min-h-11 rounded-lg px-2 text-[12px] text-danger disabled:opacity-50 " + focus}>
              {t(busy === provider + "-clear" ? "searchSettings.removing" : "searchSettings.clear")}
            </button>}
          </div>
          <p className="mt-1 text-[11px] text-ink-secondary">{t("searchSettings.keyPrivacy")}</p>
        </div>;
      })}
    </div>
    <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">{t("searchSettings.charges")}</p>
    {where === "keys" && notice && <p role="status" className="mt-3 text-[12px] text-success">{notice}</p>}
    {where === "keys" && error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </section></InAdvanced></>;
}
