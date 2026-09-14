import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { shouldPollTelegramStatus, telegramHealthLabel, telegramStatusFrom, type TelegramStatus } from "@/lib/telegram-status";

interface PairCode { code: string; expiresAt: number; username?: string; botIdentityId: string }
export function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [pair, setPair] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const gate = useRef(false);
  const actionVersion = useRef(0);
  const applyStatus = (next: TelegramStatus, version: number) => {
    if (version !== actionVersion.current) return false;
    setStatus(next); if (next.paired) setPair(null); setRefreshError(null);
    return true;
  };
  const refresh = async (version: number) => { applyStatus(telegramStatusFrom(await api("/api/telegram/status")), version); };
  const run = async (action: string, work: (version: number) => Promise<void>) => {
    if (gate.current) return; gate.current = true; const version = ++actionVersion.current; setBusy(action); setError(null); setNotice(null);
    try { await work(version); } catch { if (version === actionVersion.current) setError("Telegram setup could not be completed. Check the token and connection, then refresh or try again."); }
    finally { gate.current = false; setBusy(null); }
  };
  useEffect(() => { void run("refresh", refresh); }, []);
  const expiresAt = pair?.expiresAt ?? status?.pairingExpiresAt;
  const expired = !status?.paired && Boolean(status?.pairingExpired || (expiresAt && expiresAt <= now));
  const waiting = Boolean(status && !["retry", "blocked", "pair-required"].includes(status.resumeState ?? "") && !status.paired && !expired && (pair || status.pending || status.enabled || status.connecting));
  useEffect(() => {
    if (!shouldPollTelegramStatus(status)) return;
    let active = true;
    let inFlight = false;
    const interval = window.setInterval(async () => {
      setNow(Date.now());
      if (inFlight || gate.current) return;
      inFlight = true;
      const version = actionVersion.current;
      try {
        const next = telegramStatusFrom(await api("/api/telegram/status"));
        if (active) applyStatus(next, version);
      } catch {
        if (active && version === actionVersion.current) setRefreshError("Could not refresh Telegram status. The last confirmed status is still shown.");
      } finally { inFlight = false; }
    }, 2000);
    return () => { active = false; window.clearInterval(interval); };
  }, [status]);
  const linked = status?.requiresRevoke || status?.paired || status?.pending || status?.enabled || status?.connecting;
  const save = () => run("save", async version => {
    if (linked) throw new Error("Revoke first");
    if (window.muragebox?.setCredential) await window.muragebox.setCredential("telegramBotToken", token.trim());
    else await api("/api/config", { method: "PUT", body: JSON.stringify({ telegram: { botToken: token.trim() } }) });
    setToken(""); await refresh(version); if (version === actionVersion.current) setNotice("Token saved. Pairing has not started.");
  });
  const startPair = () => run("pair", async version => {
    if (expired) { await api("/api/telegram/revoke", { method: "POST", body: "{}" }); setPair(null); }
    const result = await api("/api/telegram/pair", { method: "POST", body: "{}" });
    if (typeof result.code !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(result.code) || !Number.isFinite(result.expiresAt)) throw new Error("Invalid pairing response");
    if (version !== actionVersion.current) return;
    setNow(Date.now()); setPair(result); await refresh(version);
  });
  const username = pair?.username && /^[A-Za-z0-9_]{5,32}$/.test(pair.username) ? pair.username : null;
  return <section aria-labelledby="telegram-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="telegram-settings-title" className="text-[15px] font-semibold text-ink">Telegram</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Message your Chief of Staff from Telegram. Messages share the Chief's current conversation. Keep Murage running to receive messages. Your completed pairing reconnects automatically after Murage restarts.</p>
    <p role="status" className="mt-3 text-[12px] font-medium text-ink">{telegramHealthLabel(status, expired, waiting)}</p>
    <h4 className="mt-4 text-[13px] font-medium text-ink">1. Create a Telegram bot</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-accent underline">BotFather</a> in Telegram, send <code>/newbot</code> and follow the prompts. Copy the bot token it gives you.</p>
    <h4 className="mt-4 text-[13px] font-medium text-ink">{status?.configured ? "2. Token saved" : "2. Save your token"}</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">{status?.configured ? "Your token is saved securely on this computer. You do not need to enter it again." : "Your token will be stored encrypted on this computer and will not be shown again here."}</p>
    <label className="mt-3 block text-[12px] text-ink-secondary">Bot token
      <input type="password" autoComplete="off" placeholder={status?.configured ? "Token saved" : "Paste your bot token"} value={token} disabled={Boolean(busy) || Boolean(linked)} onChange={event => setToken(event.target.value)}
        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50" />
    </label>
    {linked && <p className="mt-1 text-[12px] text-ink-secondary">Revoke the connection before changing its token.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={Boolean(busy) || Boolean(linked) || !status || !token.trim()} onClick={() => void save()} className="rounded-lg bg-control px-3 py-2 text-[12px] text-ink disabled:opacity-50">{busy === "save" ? "Saving…" : "Save token"}</button>
    </div>
    <h4 className="mt-4 text-[13px] font-medium text-ink">3. Pair with your Chief</h4>
    <p className="mt-1 text-[12px] text-ink-secondary">Create a code, then send the command below to your new bot in a private Telegram chat.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={Boolean(busy) || !status?.configured || (Boolean(linked) && !expired)} onClick={() => void startPair()} className="rounded-lg bg-accent px-3 py-2 text-[12px] text-accent-ink disabled:opacity-50">{busy === "pair" ? "Pairing…" : expired ? "Create new pairing code" : "Pair with Chief"}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)} className="rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink disabled:opacity-50">Refresh status</button>
      <button type="button" disabled={Boolean(busy) || (!linked && !pair)} onClick={() => void run("revoke", async version => { await api("/api/telegram/revoke", { method: "POST", body: "{}" }); if (version !== actionVersion.current) return; setPair(null); await refresh(version); if (version === actionVersion.current) setNotice("Telegram connection revoked."); })} className="rounded-lg px-3 py-2 text-[12px] text-danger disabled:opacity-50">Revoke</button>
    </div>
    {pair && !expired && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] text-ink">
      <p>Send this command to your Telegram bot:</p><code className="mt-2 block break-all select-all">/pair {pair.code}</code>
      <button type="button" className="mt-2 rounded-lg border border-hairline/40 px-3 py-2" onClick={() => void run("copy", async () => { await navigator.clipboard.writeText(`/pair ${pair.code}`); setNotice("Pairing command copied."); })} disabled={Boolean(busy)}>Copy pairing command</button>
      <p className="mt-1 text-ink-secondary">Expires {new Date(pair.expiresAt).toLocaleTimeString()}. Status updates automatically while pairing.</p>
      {username && <a href={`https://t.me/${username}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent hover:underline">Open Telegram bot</a>}
    </div>}
    {status?.resumeMessage && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{status.resumeMessage}</p>}
    {status?.canResume && <button type="button" disabled={Boolean(busy)} onClick={() => void run("resume", async version => { await api("/api/telegram/resume", { method: "POST", body: "{}" }); await refresh(version); })} className="mt-3 rounded-lg bg-accent px-3 py-2 text-[12px] text-accent-ink disabled:opacity-50">{busy === "resume" ? "Reconnecting…" : "Retry now"}</button>}
    {status?.paired && <p className="mt-3 text-[12px] text-success">Connected. Send your bot a message in Telegram to talk to your Chief. Use owner-only buttons to allow once or deny pending actions. Other reviews stay in Murage.</p>}
    {(status?.pending ?? 0) > 0 && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Telegram work is pending. A confirmed delivery will not be sent twice.</p>}
    {(status?.uncertain ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A message delivery is uncertain. Check Telegram before sending it again.</p>}
    {(status?.rejected ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-danger">A message could not be delivered. It will not be retried automatically.</p>}
    {status?.deliveryRetryAt && <p role="status" className="mt-2 text-[12px] text-ink-secondary">A reply is queued for a scheduled delivery retry.</p>}
    {(error || refreshError || status?.error) && <p role="alert" className="mt-2 text-[12px] text-danger">{error ?? refreshError ?? "Telegram reported a connection problem. Refresh status or review your setup."}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p>}
    <p className="mt-3 text-[12px] text-ink-secondary">Discord and WhatsApp: coming soon.</p>
  </section>;
}
