// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// AN APP THAT NEEDS SIGNING IN AGAIN, SAID IN THE CHAT.
//
// When a tool call to one connected app comes back as an authorization
// failure the server remembers it (server/connected-app-health.ts). The chat
// shows which app, with a Reconnect that opens Connected apps, where the
// account's own Reconnect goes through the confirmed label form like every
// other sign-in (#758): nothing is authorized from the chat line itself.
// The same fact reaches the bot as a plain line in its instructions.
import { useCallback, useEffect, useState } from "react";
import { Link2Off } from "lucide-react";

import { useDesktopSurface } from "@/lib/use-surface";
import { api, useStore } from "@/state/store";

export interface ReconnectApp { slug: string; label: string; accounts: Array<{ id: string; alias?: string }> }

export function reconnectNotice(apps: ReadonlyArray<ReconnectApp>): string | null {
  if (!apps.length) return null;
  const labels = apps.map((app) => app.label);
  const list = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `${list} ${labels.length === 1 ? "needs" : "need"} reconnecting.`;
}

export interface ReconnectAppsBannerViewProps {
  apps: ReadonlyArray<ReconnectApp>;
  /** The slug being reconnected, or null. */
  busy: string | null;
  onReconnect: (app: ReconnectApp) => void;
  /** Reconnect opens a browser sign-in, so it is offered on the computer only. */
  desktop?: boolean;
  problem?: string | null;
}

/** The line itself: no state, no requests. Nothing when no app needs it. */
export function ReconnectAppsBannerView({ apps, busy, onReconnect, desktop = true, problem = null }: ReconnectAppsBannerViewProps) {
  const text = reconnectNotice(apps);
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-center gap-2 bg-raised px-4 py-2 text-[13px] font-medium text-ink">
      <Link2Off size={14} className="shrink-0" aria-hidden="true" />
      <span>{text}</span>
      {desktop ? apps.map((app) => (
        <button
          key={app.slug}
          type="button"
          disabled={busy !== null}
          onClick={() => { onReconnect(app); }}
          className="min-h-9 rounded-lg bg-control px-3 py-1 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          aria-label={`Reconnect ${app.label}`}
        >
          {apps.length > 1 ? `Reconnect ${app.label}` : "Reconnect"}
        </button>
      )) : <span className="text-ink-secondary">Reconnect it on your computer.</span>}
      {problem && <span className="text-danger">{problem}</span>}
    </div>
  );
}

export function ReconnectAppsBanner({ enabled }: { enabled: boolean }) {
  const desktop = useDesktopSurface();
  const { dispatch } = useStore();
  const [apps, setApps] = useState<ReconnectApp[]>([]);

  const load = useCallback(async () => {
    try {
      const answer = await api("/api/connectors/needs-reconnect");
      setApps(Array.isArray(answer?.apps) ? answer.apps : []);
    } catch { /* a missed check shows nothing; the next one asks again */ }
  }, []);

  useEffect(() => {
    if (!enabled) { setApps([]); return; }
    void load();
    const timer = setInterval(() => { void load(); }, 20_000);
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [enabled, load]);

  // Reconnect opens Connected apps; the account's Reconnect there asks for
  // the label before any sign-in starts.
  const openConnectedApps = () => { dispatch({ type: "togglePlugins", open: true, surface: "apps" }); };

  if (!enabled) return null;
  return <ReconnectAppsBannerView apps={apps} busy={null} desktop={desktop === true} onReconnect={openConnectedApps} />;
}
