import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

export interface SlackStatus {
  state: "idle" | "verifying" | "pairing" | "connected" | "retry" | "blocked";
  configured: boolean; appConfigured: boolean; botConfigured: boolean; paired: boolean; enabled: boolean;
  requiresRevoke: boolean; busy: boolean; pending: number; uncertain: number; rejected: number; needsReview: number;
  error: string | null; nextRetryAt: number | null; teamId?: string; appId?: string; ownerUserId?: string; targetBotId?: string;
}
const states = new Set(["idle", "verifying", "pairing", "connected", "retry", "blocked"]);
const identityPattern = /^[A-Z][A-Z0-9]{1,79}$/;
export function slackStatusFrom(value: unknown): SlackStatus {
  if (!value || typeof value !== "object") throw new Error("Slack status unavailable");
  const v = value as Record<string, unknown>;
  if (!states.has(String(v.state))) throw new Error("Slack status unavailable");
  for (const key of ["configured", "appConfigured", "botConfigured", "paired", "enabled", "requiresRevoke", "busy"]) if (typeof v[key] !== "boolean") throw new Error("Slack status unavailable");
  for (const key of ["pending", "uncertain", "rejected", "needsReview"]) if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0) throw new Error("Slack status unavailable");
  if (v.error !== null && typeof v.error !== "string") throw new Error("Slack status unavailable");
  if (v.nextRetryAt !== null && (typeof v.nextRetryAt !== "number" || !Number.isFinite(v.nextRetryAt))) throw new Error("Slack status unavailable");
  const result: Record<string, unknown> = {};
  for (const key of ["state", "configured", "appConfigured", "botConfigured", "paired", "enabled", "requiresRevoke", "busy", "pending", "uncertain", "rejected", "needsReview", "error", "nextRetryAt"]) result[key] = v[key];
  for (const key of ["teamId", "appId", "ownerUserId", "targetBotId"]) {
    if (v[key] !== undefined && (typeof v[key] !== "string" || String(v[key]).length > 180)) throw new Error("Slack status unavailable");
    if (v[key] !== undefined) result[key] = v[key];
  }
  return result as unknown as SlackStatus;
}
export function slackHealth(status: SlackStatus | null, expired = false) {
  if (!status) return "Checking Slack…";
  if (status.state === "retry") return "Connection saved · reconnecting";
  if (status.state === "verifying") return "Checking the saved connection…";
  if (status.state === "blocked") return "Connection needs attention";
  if (status.paired && status.enabled) return "Connected to Chief";
  if (expired) return "Pairing code expired";
  if (status.state === "pairing") return "Waiting for your Slack message";
  if (status.paired) return "Pairing saved · receiver offline";
  return status.configured ? "Credentials saved · not paired" : "Save your Slack credentials";
}
export function slackHelp(code: string | null) {
  if (!code) return null;
  const messages: Record<string, string> = {
    "chief-changed": "Your Chief changed. Revoke this connection, then pair with the current Chief.",
    "identity-mismatch": "The credentials do not match the saved app identity. Revoke the connection, then check your workspace and app before pairing again.",
    "pair-required": "Pairing was not completed. Revoke the connection and create a new pairing code.",
    "revoke-recovery-required": "Slack is stopped, but revocation could not be saved. Restore access to the local connection data, then retry Revoke.",
    "connection-recovery-required": "The saved connection needs review. Check local data access before retrying or revoking it.",
    "retry-limit": "Automatic reconnect attempts stopped. Check your connection and Slack app access, then retry.",
    "pairing-failed": "Pairing could not complete. Revoke the incomplete connection, then check both credentials and your Slack app settings.",
    "intake-failed": "A Slack message receipt could not be completed. Check the connection and local data access before sending it again.",
    "delivery-failed": "A reply needs review. Check Slack and the task in Murage before sending it again.",
    "transport-error": "Slack reported a connection problem. Check your app access and refresh status.",
    "ack-slow": "A Slack receipt was delayed. Check for a reply before sending the message again.",
  };
  return messages[code] ?? "Slack needs attention. Refresh status and review the saved connection.";
}

const inputClass = "mt-1 min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const buttonClass = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink hover:bg-control disabled:opacity-50";
interface Pair { code: string; expiresAt: number }
export function SlackSettings() {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [appToken, setAppToken] = useState(""), [botToken, setBotToken] = useState("");
  const [identity, setIdentity] = useState({ teamId: "", appId: "", ownerUserId: "" });
  const [pair, setPair] = useState<Pair | null>(null), [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(false), version = useRef(0), dirty = useRef(false), mounted = useRef(true);
  const apply = (value: unknown, expected: number) => {
    const next = slackStatusFrom(value);
    if (!mounted.current || version.current !== expected) return;
    setStatus(next); setRefreshError(false);
    if (next.paired || !next.requiresRevoke) setPair(null);
    if (!dirty.current) setIdentity({ teamId: next.teamId ?? "", appId: next.appId ?? "", ownerUserId: next.ownerUserId ?? "" });
  };
  const refresh = async (expected: number) => { apply(await api("/api/slack/status"), expected); };
  const run = async (action: string, work: (expected: number) => Promise<void>) => {
    if (gate.current) return; gate.current = true; const expected = ++version.current;
    setBusy(action); setError(null); setNotice(null);
    try { await work(expected); }
    catch {
      if (mounted.current && expected === version.current) {
        const errors: Record<string, string> = {
          credentials: "Credentials could not all be saved. Refresh status to check which key was saved, then retry in Murage Desktop.",
          identity: "Workspace details could not be saved. Check the three IDs and refresh status before retrying.",
          pair: "Pairing could not start. Check that a Chief is selected and both credentials and workspace details are saved. Revoke any incomplete connection before trying again.",
          copy: "The command could not be copied. Select the command below and copy it manually.",
          revoke: "Revocation could not complete. Refresh status and restore local data access before retrying Revoke.",
          resume: "Reconnect could not complete. Check your connection and Slack app access, then refresh status.",
          refresh: "Status could not be refreshed. Check that Murage is running, then use Refresh status again.",
        };
        setError(errors[action] ?? errors.refresh);
        if (action !== "refresh" && action !== "copy") try { await refresh(expected); } catch { setRefreshError(true); }
      }
    } finally { gate.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => {
    mounted.current = true; void run("refresh", refresh);
    return () => { mounted.current = false; version.current++; };
  }, []);
  useEffect(() => {
    let active = true, inFlight = false;
    const timer = window.setInterval(async () => {
      setNow(Date.now());
      if (!status || gate.current || inFlight || (!status.configured && !status.requiresRevoke)) return;
      inFlight = true; const expected = version.current;
      try { const next = await api("/api/slack/status"); if (active) apply(next, expected); }
      catch { if (active && version.current === expected) setRefreshError(true); }
      finally { inFlight = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [status]);
  const locked = Boolean(status?.requiresRevoke || status?.enabled || status?.busy);
  const disabled = Boolean(busy) || locked || !status;
  const secure = typeof window.muragebox?.setCredential === "function";
  const detailsSaved = Boolean(status?.teamId && status.appId && status.ownerUserId && !dirty.current);
  const expired = Boolean(pair && pair.expiresAt <= now);
  const canRetry = status?.state === "retry" || (status?.state === "blocked" && status.error === "retry-limit");
  const saveCredentials = () => run("credentials", async expected => {
    if (!secure || locked) throw new Error("Secure storage unavailable");
    try {
      if (appToken.trim()) await window.muragebox!.setCredential!("slackAppToken", appToken.trim());
      if (botToken.trim()) await window.muragebox!.setCredential!("slackBotToken", botToken.trim());
    } finally { setAppToken(""); setBotToken(""); }
    await refresh(expected); if (mounted.current) setNotice("Credentials saved. Pairing has not started.");
  });
  const saveIdentity = () => run("identity", async expected => {
    if (locked || !Object.values(identity).every(value => identityPattern.test(value))) throw new Error("Invalid identity");
    await api("/api/config", { method: "PATCH", body: JSON.stringify({ slack: identity }) }); dirty.current = false;
    await refresh(expected); if (mounted.current) setNotice("Workspace details saved. Pairing has not started.");
  });
  return <section aria-labelledby="slack-settings-title" className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="slack-settings-title" className="text-[15px] font-semibold text-ink">Slack</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Message your Chief from one approved Slack direct message. Keep Murage running to receive messages. Approvals stay in Murage.</p>
    <p role="status" className="mt-3 text-[12px] font-medium text-ink">{slackHealth(status, expired)}</p>
    <details className="mt-3 text-[12px] text-ink-secondary">
      <summary className="min-h-11 cursor-pointer py-3 text-ink">Private Slack app setup</summary>
      <p>Use a private app with Socket Mode enabled. The app-level token needs <code>connections:write</code>. The bot token needs <code>im:history</code> and <code>chat:write</code>, with the <code>message.im</code> event enabled.</p>
      <a className="mt-2 inline-flex min-h-11 items-center text-accent-text underline hover:text-ink" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Open Slack app settings</a>
    </details>
    <h4 className="mt-4 text-[13px] font-medium text-ink">1. Save credentials securely</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Stored encrypted on this computer. Saved keys are never shown here; leave a saved key blank to keep it.</p>
    <label className="mt-3 block text-[12px] text-ink-secondary">App-level token {status?.appConfigured && <span>(saved)</span>}
      <input name="slack-app-token" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={appToken} disabled={disabled || !secure} onChange={event => setAppToken(event.target.value)} className={inputClass} />
    </label>
    <label className="mt-3 block text-[12px] text-ink-secondary">Bot token {status?.botConfigured && <span>(saved)</span>}
      <input name="slack-bot-token" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={botToken} disabled={disabled || !secure} onChange={event => setBotToken(event.target.value)} className={inputClass} />
    </label>
    <button type="button" className={`${buttonClass} mt-3 bg-control`} disabled={disabled || !secure || (!appToken.trim() && !botToken.trim())} onClick={() => void saveCredentials()}>{busy === "credentials" ? "Saving credentials…" : "Save credentials"}</button>
    {!secure && <p role="status" className="mt-2 text-[12px] text-warning">Secure storage is unavailable in this window. Open Channels in Murage Desktop to save credentials.</p>}
    {locked && <p className="mt-2 text-[12px] text-ink-secondary">Revoke this connection before changing its credentials or owner.</p>}
    <h4 className="mt-5 text-[13px] font-medium text-ink">2. Choose your workspace and owner</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Use the IDs from your Slack app and your own member profile. Only this owner can pair and send messages to Chief.</p>
    {([['teamId', 'Workspace ID'], ['appId', 'App ID'], ['ownerUserId', 'Owner member ID']] as const).map(([key, label]) => <label key={key} className="mt-3 block text-[12px] text-ink-secondary">{label}
      <input name={`slack-${key}`} autoComplete="off" spellCheck={false} maxLength={80} value={identity[key]} disabled={disabled || !status?.configured}
        onChange={event => { dirty.current = true; setIdentity(current => ({ ...current, [key]: event.target.value.trim() })); }} className={inputClass} />
    </label>)}
    <button type="button" className={`${buttonClass} mt-3`} disabled={disabled || !status?.configured || !Object.values(identity).every(value => identityPattern.test(value)) || !dirty.current} onClick={() => void saveIdentity()}>{busy === "identity" ? "Saving details…" : "Save workspace details"}</button>
    <h4 className="mt-5 text-[13px] font-medium text-ink">3. Pair with Chief</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Create a code, then send it to your Slack app in a direct message from the owner above. Saving credentials does not start pairing.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded-lg bg-accent px-3 py-2 text-[12px] text-accent-ink hover:brightness-110 disabled:opacity-50" disabled={disabled || !status?.configured || !detailsSaved}
        onClick={() => void run("pair", async expected => {
          const next = await api("/api/slack/pair", { method: "POST", body: "{}" });
          if (typeof next.code !== "string" || !/^[a-f0-9]{64}$/.test(next.code) || !Number.isFinite(next.expiresAt)) throw new Error("Invalid pairing response");
          setNow(Date.now()); setPair({ code: next.code, expiresAt: next.expiresAt }); await refresh(expected);
        })}>{busy === "pair" ? "Starting pairing…" : "Pair with Chief"}</button>
      {canRetry && <button type="button" className={buttonClass} disabled={Boolean(busy) || status?.busy} onClick={() => void run("resume", async expected => { await api("/api/slack/resume", { method: "POST", body: "{}" }); await refresh(expected); })}>{busy === "resume" ? "Reconnecting…" : "Retry connection"}</button>}
      <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}>Refresh status</button>
      <button type="button" className={`${buttonClass} text-danger`} disabled={Boolean(busy) || !status?.requiresRevoke} onClick={() => void run("revoke", async expected => {
        await api("/api/slack/revoke", { method: "POST", body: "{}" }); setPair(null); await refresh(expected); setNotice("Slack connection revoked. Saved credentials are unchanged.");
      })}>{busy === "revoke" ? "Revoking…" : "Revoke connection"}</button>
    </div>
    {pair && !expired && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] text-ink">
      <p>Send this command in your app’s Slack direct message:</p><code className="mt-2 block break-all select-all">/pair {pair.code}</code>
      <button type="button" className={`${buttonClass} mt-2`} disabled={Boolean(busy)} onClick={() => void run("copy", async () => { await navigator.clipboard.writeText(`/pair ${pair.code}`); setNotice("Pairing command copied."); })}>Copy pairing command</button>
      <p className="mt-2 text-ink-secondary">Expires {new Date(pair.expiresAt).toLocaleTimeString()}. Status updates automatically.</p>
    </div>}
    {expired && <p role="status" className="mt-3 text-[12px] text-warning">The code expired. Revoke the incomplete connection, then create a new pairing code.</p>}
    {!pair && status?.state === "pairing" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Use the code from the window that started pairing. If it is unavailable, revoke and create a new code here.</p>}
    {(status?.pending ?? 0) > 0 && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Slack work is pending. Review the task in Murage.</p>}
    {(status?.uncertain ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A reply delivery is uncertain. Check Slack before sending the message again.</p>}
    {(status?.rejected ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A reply was rejected. Review app access and the task in Murage.</p>}
    {(status?.needsReview ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A saved task receipt needs review in Murage. It will not be rerun automatically.</p>}
    {status?.error && <p role="alert" className="mt-3 text-[12px] text-warning">{slackHelp(status.error)}</p>}
    {refreshError && <p role="alert" className="mt-2 text-[12px] text-warning">Status refresh failed. The last confirmed state is still shown. Check the connection, then use Refresh status.</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p>}
  </section>;
}
