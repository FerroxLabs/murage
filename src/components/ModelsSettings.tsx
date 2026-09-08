import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { extractKeys, modelProviderCandidates } from "../../shared/key-extract";
import type { ProviderCatalog, ProviderConnectionMutation, ProviderModel, ProviderPreset, PublicProviderConnection } from "../../shared/provider-connections";

type Snapshot = { connections: PublicProviderConnection[]; storage: "encrypted" | "local-config" };
const labels: Record<ProviderPreset, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", deepseek: "DeepSeek", mistral: "Mistral", flux: "Flux Router", groq: "Groq", xai: "xAI" };
const presets = Object.keys(labels) as ProviderPreset[];
const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`;
const notifyConnectionsChanged = () => window.dispatchEvent(new Event("murage:provider-connections-changed"));
const input = `min-h-11 min-w-0 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${focus}`;
function chatModels(connection: PublicProviderConnection): ProviderModel[] {
  return connection.catalog.models.filter(model => model.enabled && model.chatEligible && model.capabilities.chat && !model.outputModalities.some(type => type === "image" || type === "video"));
}
function failureMessage(error: unknown, action: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/changed|revision|stale/i.test(message)) return "This connection changed. Refresh the list before saving.";
  if (/admin key/i.test(message)) return "Use an inference API key, not an admin key.";
  if (/different provider|does not match/i.test(message)) return "The key does not match this provider. Check the provider and try again.";
  return `Could not ${action}. Check the connection and try again.`;
}
const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);

/** This editor updates the existing slot; it never reads or copies its saved key. */
function ExistingKey({ id, label, configured, onSaved }: { id: string; label: string; configured: boolean; onSaved: (status: ConfigStatus) => void }) {
  const key = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState(false);
  const running = useRef(false);
  useEffect(() => { const element = key.current; return () => { if (element) element.value = ""; }; }, []);
  const save = async (remove = false) => {
    if (running.current || !remove && !key.current?.value.trim()) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    const value = remove ? "" : key.current!.value.trim();
    try {
      const credential = id === "opencode" ? "opencodeGoApiKey" : id === "legacy-xai" ? "xaiApiKey" : id === "legacy-openai-image" ? "openaiImageApiKey" : null;
      const patch = id === "legacy-flux" ? { flux: { apiKey: value } } : id === "opencode" ? { opencodeGo: { apiKey: value } } : id === "legacy-xai" ? { xai: { key: value } } : id === "legacy-openai-image" ? { imageGen: { key: value } } : { openaiCompat: { key: value } };
      const status: ConfigStatus = credential && window.muragebox?.setCredential
        ? await window.muragebox.setCredential(credential, value)
        : await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
      if (key.current) key.current.value = ""; setHasValue(false); setRemoving(false); onSaved(status); setNotice(remove ? "Saved key removed." : "Existing connection updated.");
    } catch (cause) { setError(failureMessage(cause, "update this existing key")); }
    finally { running.current = false; setBusy(false); }
  };
  return <div className="mt-4 space-y-2">
    <label className="block text-[13px] text-ink">{label}
      <input ref={key} type="password" aria-label={`${label} key`} autoComplete="off" spellCheck={false} maxLength={4096} defaultValue="" placeholder={configured ? "Key saved · paste a replacement" : "Paste a key"} disabled={busy} onInput={() => { setHasValue(Boolean(key.current?.value.trim())); setError(""); }} className={`${input} mt-1.5`} />
    </label>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !hasValue} onClick={() => void save()}>{busy ? "Saving…" : `Save ${label} key`}</button>{configured && <button type="button" className={button} disabled={busy} onClick={() => setRemoving(true)}>Remove {label} key</button>}</div>
    {removing && <div className="rounded-lg bg-card p-3 text-[12px]"><p>Remove the saved {label} key? Bots using it will need another connection.</p><div className="mt-2 flex gap-2"><button type="button" className={button} disabled={busy} onClick={() => void save(true)}>Confirm key removal</button><button type="button" className={button} disabled={busy} onClick={() => setRemoving(false)}>Cancel</button></div></div>}
    {notice && <p role="status" className="text-[12px] text-success">{notice}</p>}{error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div>;
}

export function ModelsSettings() {
  const { state, dispatch } = useStore();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [hints, setHints] = useState<ProviderPreset[]>([]), [chosen, setChosen] = useState<ProviderPreset | null>(null), [hasKey, setHasKey] = useState(false), [keyIssue, setKeyIssue] = useState("");
  const [query, setQuery] = useState(""), [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; label: string; revision: string } | null>(null);
  const key = useRef<HTMLInputElement>(null), name = useRef<HTMLInputElement>(null), rename = useRef<HTMLInputElement>(null), running = useRef(false);
  const mounted = useRef(true);
  const readList = async () => { const next: Snapshot = await api("/api/provider-connections"); if (mounted.current) setSnapshot(next); return next; };
  const reload = async () => {
    if (running.current) return; running.current = true; setBusy("list"); setError("");
    try { await readList(); setRemoving(null); } catch (cause) { setError(failureMessage(cause, "load model connections")); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => {
    mounted.current = true; const element = key.current; void reload();
    const changed = () => { void reload(); }; window.addEventListener("murage:provider-connections-changed", changed);
    return () => { mounted.current = false; if (element) element.value = ""; window.removeEventListener("murage:provider-connections-changed", changed); };
  }, []);
  const recognize = () => {
    const raw = key.current?.value.trim() ?? "", extracted = extractKeys(raw), candidates = modelProviderCandidates(raw);
    setHasKey(Boolean(raw)); setHints(candidates); setChosen(candidates.length === 1 ? candidates[0] : null); setError("");
    setKeyIssue(extracted.length > 1 ? "Paste one API key at a time." : extracted.length === 1 && !candidates.length ? "This key is not a supported model key. Use Tools & Connections for service keys." : "");
  };
  const mutate = async (change: ProviderConnectionMutation): Promise<Snapshot> => {
    if (window.muragebox) {
      if (!window.muragebox.mutateProviderConnection) throw new Error("Secure model connection storage is unavailable.");
      return window.muragebox.mutateProviderConnection(change);
    }
    return api("/api/provider-connections/mutate", { method: "POST", body: JSON.stringify(change) });
  };
  const refresh = async (id: string) => {
    if (running.current) return; running.current = true; setBusy(id); setError(""); setNotice("");
    try { const catalog: ProviderCatalog = await api(`/api/provider-connections/${encodeURIComponent(id)}/refresh`, { method: "POST" }); notifyConnectionsChanged(); await readList(); setNotice(catalog.error ? "The saved connection needs attention. Its last available models are shown below." : "Model list refreshed."); }
    catch (cause) { setError(failureMessage(cause, "refresh this model list")); }
    finally { running.current = false; setBusy(null); }
  };
  const add = async () => {
    if (running.current || !chosen || !hasKey || keyIssue) return;
    const raw = key.current?.value.trim() ?? "", extracted = extractKeys(raw);
    if (!raw || extracted.length > 1) return;
    const value = extracted.length === 1 ? extracted[0].value : raw;
    const label = name.current?.value.trim();
    const oldIds = new Set(snapshot?.connections.map(connection => connection.id));
    running.current = true; setBusy("create"); setError(""); setNotice("");
    try {
      const next = await mutate({ action: "create", preset: chosen, key: value, ...(label ? { label } : {}) });
      if (key.current) key.current.value = ""; if (name.current) name.current.value = "";
      setHasKey(false); setHints([]); setChosen(null); setSnapshot(next); setNotice("Connection saved."); notifyConnectionsChanged();
      const added = next.connections.filter(connection => !connection.legacy && !oldIds.has(connection.id) && connection.preset === chosen);
      if (added.length === 1) {
        try { const catalog: ProviderCatalog = await api(`/api/provider-connections/${encodeURIComponent(added[0].id)}/refresh`, { method: "POST" }); notifyConnectionsChanged(); await readList(); if (catalog.error) setNotice("Connection saved. Check its model list below for details."); }
        catch { setNotice("Connection saved. Refresh its model list below when the provider is available."); }
      }
    } catch (cause) { setError(failureMessage(cause, "save this model connection")); }
    finally { running.current = false; setBusy(null); }
  };
  const changeConnection = async (change: ProviderConnectionMutation) => {
    if (running.current) return; running.current = true; setBusy(change.action === "create" ? "create" : change.id); setError(""); setNotice("");
    try { setSnapshot(await mutate(change)); notifyConnectionsChanged(); setEditing(null); setRemoving(null); setNotice("Connection updated."); }
    catch (cause) { setError(failureMessage(cause, "change this connection")); }
    finally { running.current = false; setBusy(null); }
  };
  const existingSaved = (status: ConfigStatus) => { dispatch({ type: "configStatus", config: status }); notifyConnectionsChanged(); void reload(); };
  const search = query.trim().toLowerCase();
  return <div className="min-w-0 space-y-5">
    <section aria-labelledby="models-heading" className="rounded-xl border border-hairline/40 p-4">
      <h3 id="models-heading" className="text-[15px] font-medium text-ink">Model connections</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Paste one model API key. Recognition happens on this computer; unclear keys need a provider choice.</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">API usage is billed to that provider account, separately from engine subscriptions.</p>
      <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void add(); }}>
        <label className="block text-[13px]">API key<input ref={key} type="password" aria-label="Model API key" defaultValue="" autoComplete="off" spellCheck={false} maxLength={4096} disabled={Boolean(busy)} onInput={recognize} placeholder="Paste a model API key" className={`${input} mt-1.5`} /></label>
        {hasKey && !keyIssue && (hints.length === 1 ? <p className="text-[12px] text-success">Recognized as {labels[hints[0]]}. Nothing is sent until you add the connection.</p> : <fieldset><legend className="text-[12px] text-ink-secondary">Which provider issued this key?</legend><div className="mt-2 grid grid-cols-2 gap-2">{(hints.length ? hints : presets).map(preset => <button key={preset} type="button" aria-pressed={chosen === preset} disabled={Boolean(busy)} onClick={() => setChosen(preset)} className={`${button} ${chosen === preset ? "ring-2 ring-accent" : ""}`}>{labels[preset]}</button>)}</div></fieldset>)}
        {keyIssue && <p role="alert" className="text-[12px] text-danger">{keyIssue}</p>}
        <label className="block text-[13px]">Connection name <span className="text-ink-secondary">(optional)</span><input ref={name} aria-label="Connection name (optional)" defaultValue="" maxLength={80} disabled={Boolean(busy)} placeholder="For example: Work account" className={`${input} mt-1.5`} /></label>
        <button type="submit" disabled={!snapshot || Boolean(busy) || !hasKey || !chosen || Boolean(keyIssue)} className={button}>{busy === "create" ? "Saving connection…" : "Add connection"}</button>
      </form>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">{snapshot?.storage === "encrypted" ? "New connections are encrypted by your operating system. Saved keys are never shown." : snapshot ? "Development mode uses local configuration storage, not OS encryption." : "Loading connection storage…"}</p>
    </section>
    <div className="flex flex-wrap gap-2"><label className="min-w-0 flex-1"><span className="sr-only">Search chat models</span><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search chat models" placeholder="Search chat models or accounts" className={input} /></label><button type="button" disabled={Boolean(busy)} onClick={() => void reload()} className={button}>Refresh connections</button></div>
    {notice && <p role="status" className="text-[12px] text-success">{notice}</p>}{error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {snapshot?.connections.length === 0 && <p className="text-[13px] text-ink-secondary">No additional model connections yet. Existing default keys are managed below.</p>}
    {snapshot?.connections.map(connection => {
      const models = chatModels(connection), matching = models.filter(model => !search || `${model.label} ${model.id} ${connection.label} ${labels[connection.preset]}`.toLowerCase().includes(search));
      return <section key={connection.id} aria-label={`${connection.label} connection`} className="min-w-0 rounded-xl border border-hairline/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h4 className="break-words text-[14px] font-medium">{connection.label}</h4><p className="text-[12px] text-ink-secondary">{labels[connection.preset]} · {connection.legacy ? "Existing default" : connection.enabled ? "Enabled" : "Disabled"}</p></div>{!connection.legacy && <label className="flex min-h-11 items-center gap-2 text-[12px]"><input type="checkbox" aria-label={`Use ${connection.label}`} checked={connection.enabled} disabled={Boolean(busy)} onChange={event => void changeConnection({ action: "update", id: connection.id, revision: connection.revision, enabled: event.target.checked })} className={`size-4 accent-accent ${focus}`} />Use connection</label>}</div>
        <p className="mt-2 text-[12px] text-ink-secondary">{connection.state === "saved" ? "Key saved · model list not fetched" : connection.state === "needs-attention" ? "Model list needs attention" : `${models.length} chat models listed`}</p>
        {connection.catalog.error && <p className="mt-2 break-words text-[12px] text-danger">{connection.catalog.error.message}</p>}
        {connection.catalog.stale && connection.catalog.fetchedAt && <p className="mt-1 text-[12px] text-ink-secondary">Showing last saved models from {new Date(connection.catalog.fetchedAt).toLocaleString()}.</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={Boolean(busy)} onClick={() => void refresh(connection.id)}>Refresh models for {connection.label}</button>{connection.legacy ? <a href="#existing-model-keys" className={`flex min-h-11 items-center rounded-lg px-3 text-[12px] text-accent ${focus}`}>Manage existing key below</a> : <><button type="button" className={button} disabled={Boolean(busy)} onClick={() => setEditing(connection.id)}>Rename {connection.label}</button><button type="button" className={button} disabled={Boolean(busy)} onClick={() => setRemoving({ id: connection.id, label: connection.label, revision: connection.revision })}>Remove {connection.label}</button></>}</div>
        {editing === connection.id && <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); const value = rename.current?.value.trim(); if (value) void changeConnection({ action: "update", id: connection.id, revision: connection.revision, label: value }); }}><input ref={rename} aria-label={`New name for ${connection.label}`} defaultValue={connection.label} maxLength={80} className={`${input} flex-1`} disabled={Boolean(busy)} /><button className={button} disabled={Boolean(busy)}>Save name</button><button type="button" className={button} onClick={() => setEditing(null)}>Cancel rename</button></form>}
        {removing?.id === connection.id && <div className="mt-3 rounded-lg bg-card p-3 text-[12px]"><p>Remove {removing.label}? Its saved key will be removed. Bots using it will need another connection.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={Boolean(busy)} onClick={() => void changeConnection({ action: "remove", id: removing.id, revision: removing.revision })}>Remove saved connection</button><button type="button" className={button} onClick={() => setRemoving(null)}>Cancel removal</button></div></div>}
        <details className="mt-3" open={search ? true : undefined}><summary className={`min-h-11 cursor-pointer py-3 text-[13px] ${focus}`}>{matching.length} matching chat models</summary><div className="max-h-80 overflow-y-auto">{matching.map(model => <div key={model.id} className="border-t border-hairline/30 py-3"><p className="break-words text-[13px]">{model.label}</p><p className="break-all text-[11px] text-ink-secondary">{model.id}</p><p className="mt-1 text-[11px] text-ink-secondary">{model.contextWindow ? `${model.contextWindow.toLocaleString()} context tokens` : "Context not listed"}{model.capabilities.tools ? " · Tools" : ""}{model.capabilities.vision ? " · Image input" : ""}</p><p className="mt-1 text-[11px] text-ink-secondary">{model.pricing ? `${model.pricing.inputPerMillion === undefined ? "Input price not listed" : `Input ${money(model.pricing.inputPerMillion)}`} · ${model.pricing.outputPerMillion === undefined ? "output price not listed" : `output ${money(model.pricing.outputPerMillion)}`} per 1M tokens` : "Price not listed"}</p>{model.pricing && <p className="mt-1 break-words text-[11px] text-ink-secondary">Source: {model.pricing.source} · {new Date(model.pricing.updatedAt).toLocaleDateString()}</p>}</div>)}</div></details>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">Catalog information is not a successful model test. Image and video models are excluded from this chat list.</p>
      </section>;
    })}
    <section id="existing-model-keys" aria-labelledby="existing-keys-heading" className="rounded-xl border border-hairline/40 p-4">
      <h3 id="existing-keys-heading" className="text-[14px] font-medium">Existing/default connections</h3><p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">These update the keys already used by existing setups. No keys are copied into new connections. Saving can reload engines and interrupt running tasks.</p>
      <ExistingKey id="legacy-flux" label="Flux Router default" configured={state.config?.flux?.configured ?? false} onSaved={existingSaved} />
      <ExistingKey id="opencode" label="OpenCode provider" configured={state.config?.opencodeGo?.configured ?? false} onSaved={existingSaved} />
      {snapshot?.connections.filter(connection => connection.legacy && ["legacy-openai-image", "legacy-xai", "legacy-openai-compatible"].includes(connection.id)).map(connection => <ExistingKey key={connection.id} id={connection.id} label={connection.label} configured={connection.configured} onSaved={existingSaved} />)}
    </section>
  </div>;
}
