// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { Switch } from "./SettingsPrimitives";
import { api } from "@/state/store";

type Settings = { enabled: boolean; clients: { clientId: string; label: string }[]; profiles: { profileId: string; browser: string }[] };
export function BrowserExternalClients() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState("");
  const [config, setConfig] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const load = async () => setSettings(await api("/api/browser-extension/clients"));
  useEffect(() => { let mounted = true; void api("/api/browser-extension/clients").then(value => { if (mounted) setSettings(value); }).catch(cause => { if (mounted) setError(String(cause.message ?? cause)); }); return () => { mounted = false; }; }, []);
  const act = async (body: Record<string, unknown>) => {
    setPending(true); setError(""); setConfig("");
    try { const response = await api("/api/browser-extension/clients", { method: "POST", body: JSON.stringify(body) }); if (response.config) setConfig(JSON.stringify(response.config, null, 2)); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change browser connections."); }
    finally { setPending(false); }
  };
  const control = "browser-extension-control min-h-11 rounded-lg bg-control px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40";
  const profileId = profile || (settings?.profiles.length === 1 ? settings.profiles[0].profileId : "");
  return <section aria-labelledby="external-browser-title" className="flex flex-col gap-3 rounded-lg border border-hairline p-4">
    <h3 id="external-browser-title" className="text-sm font-medium text-ink">Browser access for other agents</h3>
    <p className="text-sm text-ink-secondary">Let Claude Code, Codex or another MCP client use a connected browser through Murage. Each gets its own conversation and permissions. Murage must stay open.</p>
    <div className="flex min-h-11 items-center justify-between gap-3 text-sm text-ink"><span id="external-browser-enabled">Allow external browser tools</span><Switch aria-labelledby="external-browser-enabled" checked={settings?.enabled ?? false} disabled={!settings || pending} onClick={() => void act({ action: "enabled", enabled: !(settings?.enabled ?? false) })} className="focus-visible:outline-2 focus-visible:outline-accent" /></div>
    {settings?.enabled && <>
      {!settings.profiles.length ? <p role="status" className="text-sm text-ink-secondary">Connect a browser in a bot's Browser panel before pairing an agent.</p> : <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act({ action: "pair", label, profileId }); }}>
        <label className="flex flex-col gap-1 text-sm">Agent name<input className={control} value={label} onChange={event => setLabel(event.target.value)} maxLength={80} placeholder="Claude Code" required disabled={pending} /></label>
        {settings.profiles.length > 1 && <label className="flex flex-col gap-1 text-sm">Browser profile<select className={control} value={profileId} onChange={event => setProfile(event.target.value)} required disabled={pending}><option value="">Choose a profile</option>{settings.profiles.map(item => <option key={item.profileId} value={item.profileId}>{item.browser} · {item.profileId.slice(0, 8)}</option>)}</select></label>}
        <button className={control} disabled={pending || !label.trim() || !profileId}>Pair agent</button>
      </form>}
      {settings.clients.map(client => <div key={client.clientId} className="flex items-center justify-between gap-2 text-sm"><span className="min-w-0 break-words">{client.label}</span><button className={control} disabled={pending} onClick={() => void act({ action: "revoke", clientId: client.clientId })}>Revoke<span className="sr-only"> {client.label}</span></button></div>)}
    </>}
    {config && <label className="flex flex-col gap-2 text-sm">Add this to your agent's MCP configuration<textarea readOnly rows={10} value={config} className="browser-extension-control w-full min-w-0 rounded-lg bg-inset p-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-accent" onFocus={event => event.currentTarget.select()} /><span className="text-xs text-ink-secondary">This points to a private pairing file on this computer. Revoking the connection disables it.</span></label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}
