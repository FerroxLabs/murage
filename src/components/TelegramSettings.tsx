import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

interface TelegramStatus { configured: boolean; targetBotId?: string; enabled: boolean; paired: boolean; pending: number; uncertain: number; error?: string | null; connecting: boolean }
interface PairCode { code: string; expiresAt: number; username?: string; botIdentityId: string }
export function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [pair, setPair] = useState<PairCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(false);
  const refresh = async () => { const next = await api("/api/telegram/status"); setStatus(next); if (next.paired) setPair(null); };
  const run = async (action: string, work: () => Promise<void>) => {
    if (gate.current) return; gate.current = true; setBusy(action); setError(null); setNotice(null);
    try { await work(); } catch { setError("Telegram setup could not be completed. Check the token and connection, then refresh or try again."); }
    finally { gate.current = false; setBusy(null); }
  };
  useEffect(() => { void run("refresh", refresh); }, []);
  const linked = status?.paired || status?.pending || status?.enabled || status?.connecting;
  const save = () => run("save", async () => {
    if (linked) throw new Error("Revoke first");
    if (window.muragebox?.setCredential) await window.muragebox.setCredential("telegramBotToken", token.trim());
    else await api("/api/config", { method: "PUT", body: JSON.stringify({ telegram: { botToken: token.trim() } }) });
    setToken(""); setNotice("Token saved. Pairing has not started."); await refresh();
  });
  const username = pair?.username && /^[A-Za-z0-9_]{5,32}$/.test(pair.username) ? pair.username : null;
  return <section aria-labelledby="telegram-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="telegram-settings-title" className="text-[15px] font-semibold text-ink">Telegram</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Pair your Telegram account with the current Chief of Staff. Messages share the bot's current conversation. Keep Murage running; pair again after restarting. Use owner-only buttons to allow once or deny pending actions. Other reviews stay in Murage.</p>
    <p role="status" className="mt-3 text-[12px] text-ink-secondary">{!status ? "Checking Telegram…" : status.paired ? "Paired" : status.connecting ? "Connecting…" : status.enabled ? "Waiting for pairing" : status.configured ? "Token saved · not paired" : "No token saved"}</p>
    <label className="mt-3 block text-[12px] text-ink-secondary">Bot token
      <input type="password" autoComplete="off" value={token} disabled={Boolean(busy) || Boolean(linked)} onChange={event => setToken(event.target.value)}
        className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50" />
    </label>
    {linked && <p className="mt-1 text-[12px] text-ink-secondary">Revoke the connection before changing its token.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={Boolean(busy) || Boolean(linked) || !status || !token.trim()} onClick={() => void save()} className="rounded-lg bg-control px-3 py-2 text-[12px] text-ink disabled:opacity-50">{busy === "save" ? "Saving…" : "Save token"}</button>
      <button type="button" disabled={Boolean(busy) || !status?.configured || Boolean(linked)} onClick={() => void run("pair", async () => {
        const result = await api("/api/telegram/pair", { method: "POST", body: "{}" });
        if (typeof result.code !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(result.code) || !Number.isFinite(result.expiresAt)) throw new Error("Invalid pairing response");
        setPair(result); await refresh();
      })} className="rounded-lg bg-accent px-3 py-2 text-[12px] text-white disabled:opacity-50">{busy === "pair" ? "Pairing…" : "Pair with Chief"}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run("refresh", refresh)} className="rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink disabled:opacity-50">Refresh status</button>
      <button type="button" disabled={Boolean(busy) || (!linked && !pair)} onClick={() => void run("revoke", async () => { await api("/api/telegram/revoke", { method: "POST", body: "{}" }); setPair(null); await refresh(); setNotice("Telegram connection revoked."); })} className="rounded-lg px-3 py-2 text-[12px] text-danger disabled:opacity-50">Revoke</button>
    </div>
    {pair && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px] text-ink">
      <p>Send this command to your Telegram bot:</p><code className="mt-2 block break-all select-all">/pair {pair.code}</code>
      <p className="mt-1 text-ink-secondary">Expires {new Date(pair.expiresAt).toLocaleTimeString()}. Then refresh status here.</p>
      {username && <a href={`https://t.me/${username}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-accent hover:underline">Open Telegram bot</a>}
    </div>}
    {(status?.uncertain ?? 0) > 0 && <p role="alert" className="mt-2 text-[12px] text-warning">A message delivery is uncertain. Check Telegram before sending it again.</p>}
    {(error || status?.error) && <p role="alert" className="mt-2 text-[12px] text-danger">{error ?? "Telegram reported a connection problem. Refresh status or review your setup."}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{notice}</p>}
    <p className="mt-3 text-[12px] text-ink-secondary">Slack, Discord and WhatsApp: coming soon.</p>
  </section>;
}
