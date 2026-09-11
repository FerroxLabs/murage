import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

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
/** GET /api/claude-accounts answers { accounts: [...] } on the desktop. Any
 * other body (an older server, a proxy page, an error sent with 200) becomes a
 * readable error for the section's alert. It must never reach render: an
 * undefined list threw in `accounts.find`, React unmounted the whole Engines
 * settings tree, and an Enable click landed on a button already gone (RED2F). */
const readableAccount = (account: unknown): account is ClaudeAccount => Boolean(account) && typeof account === "object"
  && typeof (account as ClaudeAccount).instanceId === "string" && typeof (account as ClaudeAccount).displayName === "string";
export function claudeAccountsFrom(payload: unknown): ClaudeAccount[] {
  const accounts = payload && typeof payload === "object" ? (payload as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(accounts) || !accounts.every(readableAccount)) throw new Error(t("claudeAccounts.listUnreadable"));
  return accounts;
}
/** A successful change's own receipt, applied before the list refresh. POST and
 * PATCH answer with the account after a full engine probe; the refresh that
 * follows (GET) probes every engine again, and drawing only after it left a
 * created account missing for seconds under "Account added. Sign in explicitly
 * below" (CLAC1). An unreadable receipt keeps the drawn list unchanged, so only
 * a validated body reaches render and the refresh still reconciles it. */
export function claudeAccountsAfterChange(accounts: ClaudeAccount[], method: string, id: string | undefined, receipt: unknown): ClaudeAccount[] {
  const body = receipt && typeof receipt === "object" ? receipt as { account?: unknown; removed?: unknown } : {};
  if (method === "DELETE") return id && body.removed === true ? accounts.filter(account => account.instanceId !== id) : accounts;
  const account = body.account;
  if (!readableAccount(account) || (method === "PATCH" && account.instanceId !== id)) return accounts;
  const index = accounts.findIndex(entry => entry.instanceId === account.instanceId);
  if (index >= 0) return accounts.map((entry, position) => position === index ? account : entry);
  return method === "POST" ? [...accounts, account] : accounts;
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
    setAccounts(claudeAccountsFrom(await api("/api/claude-accounts"))); setLoaded(true);
  };
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, []);
  const change = async (method: string, id?: string, body?: unknown) => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const receipt = await api(`/api/claude-accounts${id ? `/${encodeURIComponent(id)}` : ""}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setEditing(null); setRemoving(null);
      setAccounts(current => claudeAccountsAfterChange(current, method, id, receipt));
      setNotice(t(method === "POST" ? "claudeAccounts.added" : method === "DELETE" ? "claudeAccounts.removed" : "claudeAccounts.saved"));
      try { await load(); await onChanged?.(); }
      catch { setError(t("claudeAccounts.refreshError")); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("claudeAccounts.changeError")); }
    finally { gate.current = false; setBusy(false); }
  };
  const edit = (account?: ClaudeAccount) => {
    setEditing(account?.instanceId ?? "new"); setRemoving(null); setDisplayName(account?.displayName ?? "");
    setConfigDir(account?.configDir ?? ""); setError(""); setNotice("");
  };
  const current = accounts.find(account => account.instanceId === editing);
  const copy = async (account: ClaudeAccount) => {
    try { await navigator.clipboard.writeText(account.signInCommand); setNotice(t("claudeAccounts.copied", { name: account.displayName })); }
    catch { setError(t("claudeAccounts.copyError")); }
  };
  return <section aria-label="Claude accounts" className="mt-4 space-y-3 border-t border-hairline/40 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-ink">Claude accounts</h3><div className="flex gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => { setError(""); void load().catch(cause => setError(cause.message)); }}>{t("claudeAccounts.refresh")}</button>
      <button type="button" className={button} disabled={busy} onClick={() => edit()}>{t("claudeAccounts.add")}</button>
    </div></div>
    <p className="text-xs leading-relaxed text-ink-secondary">{t("claudeAccounts.safety")}</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-ink">{notice}</p>}
    {!loaded && !error && <p role="status" className="text-xs text-ink-secondary">Loading accounts...</p>}
    {accounts.map(account => <div key={account.instanceId} data-claude-account={account.instanceId} className="space-y-2 rounded-lg border border-hairline/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="break-words text-sm text-ink">{account.displayName}{account.isDefault ? " · Default" : ""}</p>
        <p className="text-xs text-ink-secondary">{account.snapshot?.state === "unavailable" ? "CLI unavailable" : account.snapshot?.authenticated === true ? "Signed in" : account.snapshot?.authenticated === false ? "Sign-in required" : "Sign-in not verified"}</p></div>
        <div className="flex gap-2"><button type="button" className={button} disabled={busy} aria-label={`Edit ${account.displayName} account`} onClick={() => edit(account)}>Edit</button>
          {!account.isDefault && <button type="button" className={button} disabled={busy} aria-label={`Remove ${account.displayName} account`} onClick={() => { setRemoving(account.instanceId); setEditing(null); }}>Remove</button>}</div></div>
      <p className="break-all text-xs text-ink-secondary">{account.managed ? account.configDir : "Existing default or inherited Claude configuration (unchanged)"}</p>
      {account.signInCommand && <details><summary className="cursor-pointer text-xs text-ink">{t("claudeAccounts.instructionsTitle", { name: account.displayName })}</summary>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{t("claudeAccounts.instructions", { shell: account.signInShell === "powershell" ? "PowerShell" : t("claudeAccounts.terminal") })}</p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-2 text-xs text-ink">{account.signInCommand}</pre>
        <button type="button" className={`${button} mt-2`} onClick={() => void copy(account)}>{t("claudeAccounts.copySignIn", { name: account.displayName })}</button>
      </details>}
      {removing === account.instanceId && <div className="space-y-2 rounded bg-inset p-3 text-xs text-ink"><p>{t("claudeAccounts.removeConfirm", { name: account.displayName })}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => void change("DELETE", account.instanceId)}>{t("claudeAccounts.confirmRemoval", { name: account.displayName })}</button><button type="button" className={button} disabled={busy} onClick={() => setRemoving(null)}>{t("claudeAccounts.cancelRemoval")}</button></div></div>}
    </div>)}
    {editing !== null && <form aria-label={editing === "new" ? "Add Claude account" : "Edit Claude account"} className="space-y-3 rounded-lg bg-inset p-3" onSubmit={event => { event.preventDefault(); if (!displayName.trim()) return; void change(editing === "new" ? "POST" : "PATCH", editing === "new" ? undefined : editing, { displayName: displayName.trim(), ...(editing === "new" || (current?.managed && configDir.trim() !== current.configDir) ? { configDir: configDir.trim() } : {}) }); }}>
      <label className="block text-xs text-ink">Account name<input autoFocus className={input} value={displayName} maxLength={80} required disabled={busy} onChange={event => setDisplayName(event.target.value)} /></label>
      {(editing === "new" || current?.managed) && <label className="block text-xs text-ink">Configuration directory{editing === "new" ? " (optional)" : ""}<input className={input} value={configDir} maxLength={4096} spellCheck={false} required={editing !== "new"} disabled={busy} placeholder="Leave blank for a new isolated directory" onChange={event => setConfigDir(event.target.value)} /><span className="mt-1 block text-ink-secondary">Use an absolute path or ~/ path. Existing credentials are never moved or copied.</span></label>}
      <div className="flex gap-2"><button type="submit" className={button} disabled={busy || !displayName.trim()}>{t(busy ? "claudeAccounts.saving" : editing === "new" ? "claudeAccounts.create" : "claudeAccounts.save")}</button><button type="button" className={button} disabled={busy} onClick={() => setEditing(null)}>{t("claudeAccounts.cancel")}</button></div>
    </form>}
  </section>;
}
