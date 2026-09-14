import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

export interface DiscordStatus {
  state: "idle" | "verifying" | "pairing" | "connected" | "retry" | "blocked";
  configured: boolean; botConfigured: boolean; paired: boolean; enabled: boolean;
  requiresRevoke: boolean; busy: boolean; pending: number; uncertain: number; rejected: number; needsReview: number;
  error: string | null; nextRetryAt: number | null; applicationId?: string; ownerUserId?: string; targetBotId?: string;
}
const states = new Set(["idle", "verifying", "pairing", "connected", "retry", "blocked"]);
const identityPattern = /^[1-9][0-9]{0,19}$/;
export function discordStatusFrom(value: unknown): DiscordStatus {
  if (!value || typeof value !== "object") throw new Error("Discord status unavailable");
  const v = value as Record<string, unknown>;
  if (!states.has(String(v.state))) throw new Error("Discord status unavailable");
  for (const key of ["configured", "botConfigured", "paired", "enabled", "requiresRevoke", "busy"]) if (typeof v[key] !== "boolean") throw new Error("Discord status unavailable");
  for (const key of ["pending", "uncertain", "rejected", "needsReview"]) if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 0) throw new Error("Discord status unavailable");
  if (v.error !== null && typeof v.error !== "string") throw new Error("Discord status unavailable");
  if (v.nextRetryAt !== null && (typeof v.nextRetryAt !== "number" || !Number.isFinite(v.nextRetryAt))) throw new Error("Discord status unavailable");
  const result: Record<string, unknown> = {};
  for (const key of ["state", "configured", "botConfigured", "paired", "enabled", "requiresRevoke", "busy", "pending", "uncertain", "rejected", "needsReview", "error", "nextRetryAt"]) result[key] = v[key];
  for (const key of ["applicationId", "ownerUserId", "targetBotId"]) {
    if (v[key] !== undefined && (typeof v[key] !== "string" || String(v[key]).length > 180)) throw new Error("Discord status unavailable");
    if (v[key] !== undefined) result[key] = v[key];
  }
  return result as unknown as DiscordStatus;
}
export function discordHealth(status: DiscordStatus | null, expired = false) {
  if (!status) return "Checking Discord…";
  if (status.state === "retry") return "Connection saved · reconnecting";
  if (status.state === "verifying") return "Checking the saved connection…";
  if (status.state === "blocked") return "Connection needs attention";
  if (status.paired && status.enabled) return "Connected to Chief";
  if (expired) return "Pairing code expired";
  if (status.state === "pairing") return "Waiting for your Discord message";
  if (status.paired) return "Pairing saved · receiver offline";
  return status.configured ? "Credentials saved · not paired" : "Save your Discord credentials";
}
export function discordHelp(code: string | null) {
  if (!code) return null;
  const messages: Record<string, string> = {
    "chief-changed": "Your Chief changed. Revoke this connection, then pair with the current Chief.",
    "identity-mismatch": "The credentials do not match the saved app identity. Revoke the connection, then check your application before pairing again.",
    "pair-required": "Pairing was not completed. Revoke the connection and create a new pairing code.",
    "revoke-recovery-required": "Discord is stopped, but revocation could not be saved. Restore access to the local connection data, then retry Revoke.",
    "connection-recovery-required": "The saved connection needs review. Check local data access before retrying or revoking it.",
    "retry-limit": "Automatic reconnect attempts stopped. Check your connection and Discord app access, then retry.",
    "pairing-failed": "Pairing could not complete. Revoke the incomplete connection, then check the bot credential and your Discord app settings.",
    "intake-failed": "A Discord message receipt could not be completed. Check the connection and local data access before sending it again.",
    "delivery-failed": "A reply needs review. Check Discord and the task in Murage before sending it again.",
    "transport-error": "Discord reported a connection problem. Check your app access and refresh status.",
    "gateway-reconnecting": "The saved connection is reconnecting. Pairing is preserved; do not resend a task until you have checked its result.",
    "gateway-blocked": "Discord rejected the Gateway session. Check the bot token and application settings, then revoke and pair again.",
  };
  return messages[code] ?? "Discord needs attention. Refresh status and review the saved connection.";
}

const inputClass = "mt-1 min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const buttonClass = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink hover:bg-control disabled:opacity-50";
interface Pair { code: string; expiresAt: number }
export function DiscordSettings() {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [botToken, setBotToken] = useState("");
  const [identity, setIdentity] = useState({ applicationId: "", ownerUserId: "" });
  const [pair, setPair] = useState<Pair | null>(null), [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(false), version = useRef(0), dirty = useRef(false), mounted = useRef(true);
  const apply = (value: unknown, expected: number) => {
    const next = discordStatusFrom(value);
    if (!mounted.current || version.current !== expected) return;
    setStatus(next); setRefreshError(false);
    if (next.paired || !next.requiresRevoke) setPair(null);
    if (!dirty.current) setIdentity({ applicationId: next.applicationId ?? "", ownerUserId: next.ownerUserId ?? "" });
  };
  const refresh = async (expected: number) => { apply(await api("/api/discord/status"), expected); };
  const run = async (action: string, work: (expected: number) => Promise<void>) => {
    if (gate.current) return; gate.current = true; const expected = ++version.current;
    setBusy(action); setError(null); setNotice(null);
    try { await work(expected); }
    catch {
      if (mounted.current && expected === version.current) {
        const errors: Record<string, string> = {
          credentials: "Credentials could not be saved. Refresh status to check whether the key was saved, then retry in Murage Desktop.",
          identity: "Application details could not be saved. Check the two IDs and refresh status before retrying.",
          pair: "Pairing could not start. Check that a Chief is selected and the bot credential and application details are saved. Revoke any incomplete connection before trying again.",
          copy: "The command could not be copied. Select the command below and copy it manually.",
          revoke: "Revocation could not complete. Refresh status and restore local data access before retrying Revoke.",
          resume: "Reconnect could not complete. Check your connection and Discord app access, then refresh status.",
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
      try { const next = await api("/api/discord/status"); if (active) apply(next, expected); }
      catch { if (active && version.current === expected) setRefreshError(true); }
      finally { inFlight = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [status]);
  const locked = Boolean(status?.requiresRevoke || status?.enabled || status?.busy);
  const disabled = Boolean(busy) || locked || !status;
  const secure = typeof window.muragebox?.setCredential === "function";
  const detailsSaved = Boolean(status?.applicationId && status.ownerUserId && !dirty.current);
  const expired = Boolean(pair && pair.expiresAt <= now);
  const canRetry = status?.state === "retry" || (status?.state === "blocked" && status.error === "retry-limit");
  const saveCredentials = () => run("credentials", async expected => {
    if (!secure || locked) throw new Error("Secure storage unavailable");
    try {
      if (botToken.trim()) await window.muragebox!.setCredential!("discordBotToken", botToken.trim());
    } finally { setBotToken(""); }
    await refresh(expected); if (mounted.current) setNotice("Credentials saved. Pairing has not started.");
  });
  const saveIdentity = () => run("identity", async expected => {
    if (locked || !Object.values(identity).every(value => identityPattern.test(value))) throw new Error("Invalid identity");
    await api("/api/config", { method: "PATCH", body: JSON.stringify({ discord: identity }) }); dirty.current = false;
    await refresh(expected); if (mounted.current) setNotice("Application details saved. Pairing has not started.");
  });
  return <section aria-labelledby="discord-settings-title" className="min-w-0 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="discord-settings-title" className="text-[15px] font-semibold text-ink">Discord</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Message your Chief from one approved Discord direct message. Keep Murage running to receive messages; messages missed while it is stopped may not be recovered. Long replies are previews with the full result in Murage. Approvals stay in Murage.</p>
    <p role="status" className="mt-3 text-[12px] font-medium text-ink">{discordHealth(status, expired)}</p>
    <details className="mt-3 text-[12px] text-ink-secondary">
      <summary className="min-h-11 cursor-pointer py-3 text-ink">Private Discord app setup</summary>
      <p>Use your own Discord application bot. Choose an installation you control and open a direct message with the bot. Murage reads only direct messages from the owner below; guild messages and Discord approval buttons are not supported.</p>
      <a className="mt-2 inline-flex min-h-11 items-center text-accent-text underline hover:text-ink" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open Discord app settings</a>
    </details>
    <h4 className="mt-4 text-[13px] font-medium text-ink">1. Save credentials securely</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Stored encrypted on this computer. Saved keys are never shown here; leave a saved key blank to keep it.</p>
    <label className="mt-3 block text-[12px] text-ink-secondary">Bot token {status?.botConfigured && <span>(saved)</span>}
      <input name="discord-bot-token" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={botToken} disabled={disabled || !secure} onChange={event => setBotToken(event.target.value)} className={inputClass} />
    </label>
    <button type="button" className={`${buttonClass} mt-3 bg-control`} disabled={disabled || !secure || !botToken.trim()} onClick={() => void saveCredentials()}>{busy === "credentials" ? "Saving credentials…" : "Save credentials"}</button>
    {!secure && <p role="status" className="mt-2 text-[12px] text-warning">Secure storage is unavailable in this window. Open Channels in Murage Desktop to save credentials.</p>}
    {locked && <p className="mt-2 text-[12px] text-ink-secondary">Revoke this connection before changing its credentials or owner.</p>}
    <h4 className="mt-5 text-[13px] font-medium text-ink">2. Choose your application and owner</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Use the application ID from Discord Developer Portal and your own Discord user ID. Only this owner can pair and send messages to Chief.</p>
    {([['applicationId', 'Application ID'], ['ownerUserId', 'Owner user ID']] as const).map(([key, label]) => <label key={key} className="mt-3 block text-[12px] text-ink-secondary">{label}
      <input name={`discord-${key}`} autoComplete="off" spellCheck={false} maxLength={20} value={identity[key]} disabled={disabled || !status?.configured}
        onChange={event => { dirty.current = true; setIdentity(current => ({ ...current, [key]: event.target.value.trim() })); }} className={inputClass} />
    </label>)}
    <button type="button" className={`${buttonClass} mt-3`} disabled={disabled || !status?.configured || !Object.values(identity).every(value => identityPattern.test(value)) || !dirty.current} onClick={() => void saveIdentity()}>{busy === "identity" ? "Saving details…" : "Save application details"}</button>
    <h4 className="mt-5 text-[13px] font-medium text-ink">3. Pair with Chief</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Create a code, then send it to your Discord app in a direct message from the owner above. Saving credentials does not start pairing.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded-lg bg-accent px-3 py-2 text-[12px] text-accent-ink hover:brightness-110 disabled:opacity-50" disabled={disabled || !status?.configured || !detailsSaved}
        onClick={() => void run("pair", async expected => {
          const next = await api("/api/discord/pair", { method: "POST", body: "{}" });
          if (typeof next.code !== "string" || !/^[a-f0-9]{64}$/.test(next.code) || !Number.isFinite(next.expiresAt)) throw new Error("Invalid pairing response");
          setNow(Date.now()); setPair({ code: next.code, expiresAt: next.expiresAt }); await refresh(expected);
        })}>{busy === "pair" ? "Starting pairing…" : "Pair with Chief"}</button>
      {canRetry && <button type="button" className={buttonClass} disabled={Boolean(busy) || status?.busy} onClick={() => void run("resume", async expected => { await api("/api/discord/resume", { method: "POST", body: "{}" }); await refresh(expected); })}>{busy === "resume" ? "Reconnecting…" : "Retry connection"}</button>}
      <button type="button" className={buttonClass} disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)}>Refresh status</button>
      <button type="button" className={`${buttonClass} text-danger`} disabled={Boolean(busy) || !status?.requiresRevoke} onClick={() => void run("revoke", async expected => {
        await api("/api/discord/revoke", { method: "POST", body: "{}" }); setPair(null); await refresh(expected); setNotice("Discord connection revoked. Saved credentials are unchanged.");
      })}>{busy === "revoke" ? "Revoking…" : "Revoke connection"}</button>
    </div>
    {pair && !expired && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] text-ink">
      <p>Send this command in your app’s Discord direct message:</p><code className="mt-2 block break-all select-all">/pair {pair.code}</code>
      <button type="button" className={`${buttonClass} mt-2`} disabled={Boolean(busy)} onClick={() => void run("copy", async () => { await navigator.clipboard.writeText(`/pair ${pair.code}`); setNotice("Pairing command copied."); })}>Copy pairing command</button>
      <p className="mt-2 text-ink-secondary">Expires {new Date(pair.expiresAt).toLocaleTimeString()}. Status updates automatically.</p>
    </div>}
    {expired && <p role="status" className="mt-3 text-[12px] text-warning">The code expired. Revoke the incomplete connection, then create a new pairing code.</p>}
    {!pair && status?.state === "pairing" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Use the code from the window that started pairing. If it is unavailable, revoke and create a new code here.</p>}
    {(status?.pending ?? 0) > 0 && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Discord work is pending. Review the task in Murage.</p>}
    {(status?.uncertain ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A reply delivery is uncertain. Check Discord before sending the message again.</p>}
    {(status?.rejected ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A reply was rejected. Review app access and the task in Murage.</p>}
    {(status?.needsReview ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A saved task receipt needs review in Murage. It will not be rerun automatically.</p>}
    {status?.error && <p role="alert" className="mt-3 text-[12px] text-warning">{discordHelp(status.error)}</p>}
    {refreshError && <p role="alert" className="mt-2 text-[12px] text-warning">Status refresh failed. The last confirmed state is still shown. Check the connection, then use Refresh status.</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p>}
  </section>;
}
