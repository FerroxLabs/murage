// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings → Phone: let a script or an outside agent (the MCP server, the
// control CLI) reach ONE bot, and nothing else. One switch. Turning it on
// offers a bot and whether it may also send; the token appears once. Turning it
// off ends every script access. The server keeps only a hash of each token
// (server/mcp-grants.ts).
import { useEffect, useState } from "react";

import { api } from "@/state/store";

interface Grant { id: string; botId: string; botName: string | null; send: boolean; expiresAt: number }
interface Made extends Grant { token: string }

const BUTTON = "min-h-9 rounded-lg px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

export function ScriptAccessSettings({ bots }: { bots: ReadonlyArray<{ id: string; name: string; hidden?: boolean }> }) {
  const choices = bots.filter(bot => !bot.hidden);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState("");
  const [send, setSend] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => (api("/api/mcp-grants") as Promise<{ grants: Grant[] }>)
    .then(result => setGrants(result.grants))
    .catch(() => setError("Script access couldn't be loaded."));
  useEffect(() => { void load(); }, []);

  const on = open || (grants?.length ?? 0) > 0;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : "That didn't work. Try again."); } finally { setBusy(false); }
  };

  const create = () => run(async () => {
    const result = await api("/api/mcp-grants", { method: "POST", body: JSON.stringify({ botId: botId || choices[0]?.id, send }) }) as Made;
    setMade(result);
    setOpen(false);
    await load();
  });
  const revoke = (id: string) => run(async () => {
    await api(`/api/mcp-grants/${id}`, { method: "DELETE" });
    if (made?.id === id) setMade(null);
    await load();
  });
  const turnOff = () => run(async () => {
    for (const grant of grants ?? []) await api(`/api/mcp-grants/${grant.id}`, { method: "DELETE" });
    setMade(null);
    setOpen(false);
    await load();
  });

  return (
    <section aria-labelledby="script-access-heading" className="mt-6 space-y-3 border-t border-hairline/50 pt-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="script-access-heading" className="text-[15px] font-medium text-ink">Scripts and other apps</h3>
          <p className="mt-1 text-[12.5px] text-ink-secondary">Let a script or an outside agent talk to one bot of your choice. It reaches that bot and nothing else.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Let scripts use a bot"
          disabled={busy || grants === null}
          onClick={() => (on ? void turnOff() : setOpen(true))}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-hairline/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 ${on ? "bg-accent" : "bg-control"}`}
        >
          <span aria-hidden="true" className={`inline-block h-4.5 w-4.5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-[3px]"}`} />
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}

      {made && (
        <div role="status" className="rounded-lg border border-hairline/50 bg-inset px-3 py-2.5">
          <p className="text-[12.5px] text-ink">Copy this now. Murage shows it once. Put it in <code>MURAGE_TOKEN</code> for the script.</p>
          <input readOnly aria-label="Script access token" value={made.token} onFocus={event => event.currentTarget.select()} className="mt-2 w-full rounded-lg border border-hairline/50 bg-control px-2 py-1.5 font-mono text-[12px] text-ink" />
        </div>
      )}

      {(grants ?? []).map(grant => (
        <div key={grant.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline/50 px-3 py-2">
          <div className="min-w-0 text-[12.5px] text-ink">
            <span className="font-medium">{grant.botName ?? "A bot that is gone"}</span>
            <span className="text-ink-secondary">{grant.send ? " · reads and sends" : " · reads"} · until {new Date(grant.expiresAt).toLocaleDateString()}</span>
          </div>
          <button type="button" disabled={busy} onClick={() => void revoke(grant.id)} className={`${BUTTON} bg-control text-ink`}>Switch off</button>
        </div>
      ))}

      {open && (
        <div role="group" aria-label="New script access" className="space-y-2 rounded-lg border border-hairline/50 bg-inset px-3 py-3">
          {choices.length === 0 ? <p className="text-[12.5px] text-ink-secondary">Make a bot first, then come back.</p> : (
            <>
              <label className="block text-[12.5px] text-ink">
                Bot
                <select value={botId || choices[0]!.id} onChange={event => setBotId(event.target.value)} className="mt-1 block w-full rounded-lg border border-hairline/50 bg-control px-2 py-1.5 text-[12.5px] text-ink">
                  {choices.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-ink">
                <input type="checkbox" checked={send} onChange={event => setSend(event.target.checked)} />
                Also let it send messages to this bot
              </label>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void create()} className={`${BUTTON} bg-accent text-white`}>Create access</button>
                <button type="button" disabled={busy} onClick={() => setOpen(false)} className={`${BUTTON} bg-control text-ink`}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {on && !open && (grants?.length ?? 0) > 0 && <button type="button" disabled={busy} onClick={() => setOpen(true)} className={`${BUTTON} bg-control text-ink`}>Add another bot</button>}
    </section>
  );
}
