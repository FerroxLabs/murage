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
import { t } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link2Off } from "lucide-react";

import { useDesktopSurface } from "@/lib/use-surface";
import { routeNotification } from "@/lib/attention-offer";
import { showNotification } from "@/lib/notify";
import type { Notification } from "../../server/notify";
import { api, openNotificationTarget, useStore } from "@/state/store";

export interface ReconnectApp { incidentId?: string; slug: string; label: string; accounts: Array<{ id: string; alias?: string }> }

export function reconnectNotice(apps: ReadonlyArray<ReconnectApp>): string | null {
  if (!apps.length) return null;
  return apps.map(app => t("connectorHealth.signIn", { connector: app.label })).join(". ");
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
          aria-label={t("connectorHealth.reconnectApp", { connector: app.label })}
        >
          {apps.length > 1 ? t("connectorHealth.reconnectApp", { connector: app.label }) : t("connectorHealth.reconnect")}
        </button>
      )) : <span className="text-ink-secondary">{t("connectorHealth.computer")}</span>}
      {problem && <span className="text-danger">{problem}</span>}
    </div>
  );
}

export function ReconnectAppsBanner({ enabled }: { enabled: boolean }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  const [apps, setApps] = useState<ReconnectApp[]>([]);

  const load = useCallback(async () => {
    try {
      const answer = await api(desktop === true ? "/api/connectors/needs-reconnect" : "/api/connector-incidents");
      setApps(Array.isArray(answer?.apps) ? answer.apps : []);
      if (desktop === true) for (const frame of (answer.notifications ?? []) as Notification[]) {
        routeNotification({ ...frame }, shown => showNotification(shown as unknown as Notification,
          target => openNotificationTarget(dispatch, target, latest.current)));
      }
    } catch { /* a missed check shows nothing; the next one asks again */ }
  }, [desktop, dispatch]);

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
  const openConnectedApps = (app: ReconnectApp) => {
    if (app.incidentId) { dispatch({ type: "openConnectorReconnect", incidentId: app.incidentId }); return; }
    dispatch({ type: "togglePlugins", open: true, surface: app.slug.startsWith("mcp-") ? "mcp" : "apps",
    reconnect: { slug: app.slug, accountId: app.accounts[0]?.id, alias: app.accounts[0]?.alias } }); };

  if (!enabled) return null;
  return <ReconnectAppsBannerView apps={apps} busy={null} desktop={desktop === true || apps.some(app => app.incidentId && !app.slug.startsWith("mcp-"))} onReconnect={openConnectedApps} />;
}
