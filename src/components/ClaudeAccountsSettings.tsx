import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

export interface ClaudeAccount {
  instanceId: string;
  displayName: string;
  managed: boolean;
  isDefault: boolean;
  configDir: string;
  signInCommand: string;
  signInShell: "sh" | "powershell";
  snapshot?: { state: "available" | "unavailable"; authenticated?: boolean; reason?: string };
}
const button = "rounded-lg border border-hairline/40 px-3 py-2 text-xs text-ink hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
const input = "mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";

export function ClaudeAccountsSettings({ onChanged }: { onChanged?: () => Promise<void> }) {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null), [removing, setRemoving] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(""), [configDir, setConfigDir] = useState("");
  const gate = useRef(false);
  const load = async () => {
    const result = await api("/api/claude-accounts") as { accounts: ClaudeAccount[] };
    setAccounts(result.accounts); setLoaded(true);
  };
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, []);
  const change = async (method: string, id?: string, body?: unknown) => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/claude-accounts${id ? `/${encodeURIComponent(id)}` : ""}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setEditing(null); setRemoving(null);
      setNotice(method === "POST" ? "Account added. Sign in explicitly below, then select this account in a model picker. Existing bot choices are unchanged." : method === "DELETE" ? "Removed from Murage. Login and credential files were retained." : "Account settings saved.");
      try { await load(); await onChanged?.(); }
      catch { setError("Saved, but the account list could not refresh. Use Refresh accounts to check its current state."); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Account change failed."); }
    finally { gate.current = false; setBusy(false); }
  };
  const edit = (account?: ClaudeAccount) => {
    setEditing(account?.instanceId ?? "new"); setRemoving(null); setDisplayName(account?.displayName ?? "");
    setConfigDir(account?.configDir ?? ""); setError(""); setNotice("");
  };
  const current = accounts.find(account => account.instanceId === editing);
  const copy = async (account: ClaudeAccount) => {
    try { await navigator.clipboard.writeText(account.signInCommand); setNotice(`Copied sign-in command for ${account.displayName}.`); }
    catch { setError("Could not copy. Select and copy the command above."); }
  };
  return <section aria-label="Claude accounts" className="mt-4 space-y-3 border-t border-hairline/40 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-ink">Claude accounts</h3><div className="flex gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => { setError(""); void load().catch(cause => setError(cause.message)); }}>Refresh accounts</button>
      <button type="button" className={button} disabled={busy} onClick={() => edit()}>Add Claude account</button>
    </div></div>
    <p className="text-xs leading-relaxed text-ink-secondary">Keep your default Claude login and configuration. Additional accounts use separate configuration directories; no credentials are copied. Account changes are available only when no work is running.</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-ink">{notice}</p>}
    {!loaded && !error && <p role="status" className="text-xs text-ink-secondary">Loading accounts...</p>}
    {accounts.map(account => <div key={account.instanceId} data-claude-account={account.instanceId} className="space-y-2 rounded-lg border border-hairline/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="break-words text-sm text-ink">{account.displayName}{account.isDefault ? " · Default" : ""}</p>
        <p className="text-xs text-ink-secondary">{account.snapshot?.state === "unavailable" ? "CLI unavailable" : account.snapshot?.authenticated === true ? "Signed in" : account.snapshot?.authenticated === false ? "Sign-in required" : "Sign-in not verified"}</p></div>
        <div className="flex gap-2"><button type="button" className={button} disabled={busy} aria-label={`Edit ${account.displayName} account`} onClick={() => edit(account)}>Edit</button>
          {!account.isDefault && <button type="button" className={button} disabled={busy} aria-label={`Remove ${account.displayName} account`} onClick={() => { setRemoving(account.instanceId); setEditing(null); }}>Remove</button>}</div></div>
      <p className="break-all text-xs text-ink-secondary">{account.managed ? account.configDir : "Existing default or inherited Claude configuration (unchanged)"}</p>
      {account.signInCommand && <details><summary className="cursor-pointer text-xs text-ink">Sign-in instructions for {account.displayName}</summary>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">Run this command in {account.signInShell === "powershell" ? "PowerShell" : "your terminal"} and complete Claude's sign-in yourself. This does not sign in automatically. Then refresh accounts.</p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-2 text-xs text-ink">{account.signInCommand}</pre>
        <button type="button" className={`${button} mt-2`} onClick={() => void copy(account)}>Copy sign-in command for {account.displayName}</button>
      </details>}
      {removing === account.instanceId && <div className="space-y-2 rounded bg-inset p-3 text-xs text-ink"><p>Remove {account.displayName} from Murage? This does not revoke its login or delete credential files. Accounts referenced by bots or thread history cannot be removed.</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => void change("DELETE", account.instanceId)}>Confirm removal of {account.displayName}</button><button type="button" className={button} disabled={busy} onClick={() => setRemoving(null)}>Cancel removal</button></div></div>}
    </div>)}
    {editing !== null && <form aria-label={editing === "new" ? "Add Claude account" : "Edit Claude account"} className="space-y-3 rounded-lg bg-inset p-3" onSubmit={event => { event.preventDefault(); if (!displayName.trim()) return; void change(editing === "new" ? "POST" : "PATCH", editing === "new" ? undefined : editing, { displayName: displayName.trim(), ...(editing === "new" || (current?.managed && configDir.trim() !== current.configDir) ? { configDir: configDir.trim() } : {}) }); }}>
      <label className="block text-xs text-ink">Account name<input autoFocus className={input} value={displayName} maxLength={80} required disabled={busy} onChange={event => setDisplayName(event.target.value)} /></label>
      {(editing === "new" || current?.managed) && <label className="block text-xs text-ink">Configuration directory{editing === "new" ? " (optional)" : ""}<input className={input} value={configDir} maxLength={4096} spellCheck={false} required={editing !== "new"} disabled={busy} placeholder="Leave blank for a new isolated directory" onChange={event => setConfigDir(event.target.value)} /><span className="mt-1 block text-ink-secondary">Use an absolute path or ~/ path. Existing credentials are never moved or copied.</span></label>}
      <div className="flex gap-2"><button type="submit" className={button} disabled={busy || !displayName.trim()}>{busy ? "Saving..." : editing === "new" ? "Create account" : "Save account"}</button><button type="button" className={button} disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
    </form>}
  </section>;
}
