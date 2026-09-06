import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";

type SearchProvider = "engine" | "tavily" | "exa" | "off";
type KeyProvider = "tavily" | "exa";
const labels = { tavily: "Tavily", exa: "Exa" } as const;

/** Credential custody and provider selection are separate writes. Saving a
 * key never probes the paid service or silently changes the chosen provider. */
export function SearchSettings() {
  const { state, dispatch } = useStore();
  const search = state.config?.webSearch;
  const [values, setValues] = useState({ tavily: "", exa: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const gate = useRef(false);
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

  const choose = async (provider: SearchProvider) => {
    if (!search || gate.current || provider === search.provider) return;
    gate.current = true; setBusy("provider"); setError(""); setNotice("");
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { provider } }) }) as ConfigStatus;
      if (config.webSearch?.provider !== provider) throw new Error("Provider save was not confirmed");
      dispatch({ type: "configStatus", config });
      setNotice("Search provider saved.");
    } catch { setError("Could not save the search provider. Check your connection and try again."); }
    finally { gate.current = false; setBusy(null); }
  };
  const saveKey = async (provider: KeyProvider, clear = false) => {
    if (!search || gate.current) return;
    const value = clear ? "" : values[provider].trim();
    if (!clear && !value) return;
    gate.current = true; setBusy(provider + (clear ? "-clear" : "-save")); setError(""); setNotice("");
    try {
      const config: ConfigStatus = window.muragebox?.setCredential
        ? await window.muragebox.setCredential(provider === "tavily" ? "tavilySearchApiKey" : "exaSearchApiKey", value)
        : await api("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: { [provider === "tavily" ? "tavilyApiKey" : "exaApiKey"]: value } }) });
      const configured = config.webSearch?.[provider === "tavily" ? "tavilyConfigured" : "exaConfigured"];
      if (configured !== !clear) throw new Error("Credential save was not confirmed");
      dispatch({ type: "configStatus", config });
      setValues(current => ({ ...current, [provider]: "" }));
      setNotice(labels[provider] + (clear ? " key removed." : " key saved. Search has not been tested."));
    } catch { setError("Could not " + (clear ? "remove" : "save") + " the " + labels[provider] + " key. Check your connection and try again."); }
    finally { gate.current = false; setBusy(null); }
  };
  return <section aria-labelledby="web-search-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="web-search-settings-title" className="text-[15px] font-medium text-ink">Web search</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Use your engine's search tools, or choose a separate search provider. Saving these settings does not run a search.</p>
    {!search && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Search settings are not available yet. Reopen Settings after the connection is restored.</p>}
    <label className="mt-3 block text-[12px] font-medium text-ink" htmlFor="web-search-provider">Search provider</label>
    <select id="web-search-provider" value={search?.provider ?? "engine"} disabled={!search || Boolean(busy)}
      onChange={event => void choose(event.target.value as SearchProvider)}
      className={"mt-1 min-h-11 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50 " + focus}>
      <option value="engine">Engine tools — no separate search account</option>
      <option value="tavily">Tavily</option>
      <option value="exa">Exa</option>
      <option value="off">Off — Murage native search</option>
    </select>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{search?.provider === "off"
      ? "Off disables Murage's native search only. Independent engine and MCP search tools may still be available."
      : search?.provider === "engine"
        ? "Your engine keeps its existing tools. No Tavily or Exa account is required."
        : "Search queries are sent to the selected third-party provider and may incur separate charges. There is no automatic fallback to another provider."}</p>
    <div className="mt-4 space-y-4">
      {(["tavily", "exa"] as const).map(provider => {
        const configured = search?.[provider === "tavily" ? "tavilyConfigured" : "exaConfigured"] === true;
        const name = labels[provider];
        return <div key={provider}>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={provider + "-search-key"} className="text-[13px] font-medium text-ink">{name} API key</label>
            <span className={"text-[11px] " + (configured ? "text-success" : "text-ink-secondary")}>{configured ? "Key saved" : "No key saved"}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input id={provider + "-search-key"} type="password" value={values[provider]} autoComplete="off" spellCheck={false}
              placeholder={configured ? "Paste a replacement key" : "Paste an API key"} disabled={!search || Boolean(busy)}
              onChange={event => { setValues(current => ({ ...current, [provider]: event.target.value })); setError(""); setNotice(""); }}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveKey(provider); } }}
              className={"min-h-11 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary disabled:opacity-50 " + focus} />
            <button type="button" onClick={() => void saveKey(provider)} disabled={!search || Boolean(busy) || !values[provider].trim()}
              aria-label={"Save " + name + " key"} className={"min-h-11 rounded-lg bg-control px-3 text-[12px] font-medium text-ink disabled:opacity-50 " + focus}>
              {busy === provider + "-save" ? "Saving…" : "Save"}
            </button>
            {configured && <button type="button" onClick={() => void saveKey(provider, true)} disabled={!search || Boolean(busy)}
              aria-label={"Clear " + name + " key"} className={"min-h-11 rounded-lg px-2 text-[12px] text-danger disabled:opacity-50 " + focus}>
              {busy === provider + "-clear" ? "Removing…" : "Clear"}
            </button>}
          </div>
          <p className="mt-1 text-[11px] text-ink-secondary">Saved keys are never shown here. Key saved does not confirm service access.</p>
        </div>;
      })}
    </div>
    <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">Tavily and Exa receive search queries when selected and may charge separately. Adding or removing a key does not change your provider choice.</p>
    {busy === "provider" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Saving search provider…</p>}
    {notice && <p role="status" className="mt-3 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
  </section>;
}
