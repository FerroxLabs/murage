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
//
// 1.0.20 (owner report on 1.0.19): the line is a band above the main view,
// never a box floating over the rail and the composer. It names each app once
// (the server groups an app's per-account incidents, server/reconnect-apps.ts),
// and it can be put away: the X or Later. It reminds at the first of Murage
// starting again or a day, at most once a day per app for the restarts; a
// failure that was not there when it was put away (a new app or account)
// brings it back at once (DECISIONS.md). Putting it away changes nothing on
// the server and disconnects nothing. While any app needs signing in again the
// Needs you door carries a dot, Needs you lists the apps with their Reconnect,
// and Settings, Connections lists them above its own per-account Reconnect.
import { t } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch } from "react";
import { Link2Off, X } from "lucide-react";

import { useDesktopSurface } from "@/lib/use-surface";
import { isMacInset, windowDragProps } from "@/hooks/use-window-drag";
import { routeNotification } from "@/lib/attention-offer";
import { showNotification } from "@/lib/notify";
import type { Notification } from "../../server/notify";
import { api, openNotificationTarget, useStore } from "@/state/store";

export interface ReconnectApp { incidentId?: string; incidentIds?: string[]; slug: string; label: string; accounts: Array<{ id: string; alias?: string }> }

export function reconnectNotice(apps: ReadonlyArray<ReconnectApp>): string | null {
  if (!apps.length) return null;
  return apps.map(app => t("connectorHealth.signIn", { connector: app.label })).join(". ");
}

/** How long a put-away line waits before it reminds (DECISIONS.md, 1.0.20). */
export const RECONNECT_LATER_MS = 24 * 60 * 60_000;
export const RECONNECT_LATER_KEY = "murage.reconnectLine.later.v2";
/** This run of Murage: kept across a reload of the window, new when Murage starts again. */
export const RECONNECT_BOOT_KEY = "murage.reconnectLine.boot.v1";

/** One app put away: when, in which run, and the failures it stood for then. */
export interface ReconnectSnooze { at: number; boot: string; keys: string[] }
/** Per app: the put-away waits, and when each app last came back because Murage started again. */
export interface ReconnectAway { snoozed: Record<string, ReconnectSnooze>; reminded: Record<string, number> }
const NOTHING_AWAY: ReconnectAway = { snoozed: {}, reminded: {} };

/** The failures one app stands for: every incident of it. */
export function reconnectAppKeys(app: ReconnectApp): string[] {
  return app.incidentIds?.length ? app.incidentIds : [app.incidentId ?? app.slug];
}
/** The failures the line stands for: every incident of every app. */
export function reconnectKeys(apps: ReadonlyArray<ReconnectApp>): string[] { return apps.flatMap(reconnectAppKeys); }

/**
 * Why an app is due on the line now, or null while its wait holds. Put away (X or Later), it comes back at the
 * first of: Murage starting again, or a day. Starting again reminds at most once a day per app. A failure that
 * was not there when it was put away (a new app, or a new account of one) is due at once.
 */
export function reconnectDue(app: ReconnectApp, away: ReconnectAway, boot: string, now: number): "new" | "day" | "start" | null {
  const held = away.snoozed[app.slug];
  if (!held || reconnectAppKeys(app).some(key => !held.keys.includes(key))) return "new";
  if (now >= held.at + RECONNECT_LATER_MS) return "day";
  const reminded = away.reminded[app.slug];
  if (held.boot !== boot && !(reminded !== undefined && now < reminded + RECONNECT_LATER_MS)) return "start";
  return null;
}

/** Away while no app is due. */
export function reconnectLineAway(away: ReconnectAway, apps: ReadonlyArray<ReconnectApp>, boot: string, now: number): boolean {
  return apps.every(app => reconnectDue(app, away, boot, now) === null);
}

function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }
function readAway(): ReconnectAway {
  try {
    const held = JSON.parse(storage()?.getItem(RECONNECT_LATER_KEY) ?? "null") as ReconnectAway | null;
    if (!held || typeof held.snoozed !== "object" || typeof held.reminded !== "object" || !held.snoozed || !held.reminded) return NOTHING_AWAY;
    const snoozed: Record<string, ReconnectSnooze> = {}, reminded: Record<string, number> = {};
    for (const [slug, one] of Object.entries(held.snoozed)) {
      if (one && Number.isFinite(one.at) && typeof one.boot === "string" && Array.isArray(one.keys) && one.keys.every(key => typeof key === "string")) snoozed[slug] = one;
    }
    for (const [slug, at] of Object.entries(held.reminded)) if (Number.isFinite(at)) reminded[slug] = at;
    return { snoozed, reminded };
  } catch { return NOTHING_AWAY; }
}
function writeAway(away: ReconnectAway) {
  try {
    if (!Object.keys(away.snoozed).length && !Object.keys(away.reminded).length) storage()?.removeItem(RECONNECT_LATER_KEY);
    else storage()?.setItem(RECONNECT_LATER_KEY, JSON.stringify(away));
  } catch { /* the wait holds for this run only */ }
}
function readBoot(): string {
  try {
    const session = window.sessionStorage;
    const held = session.getItem(RECONNECT_BOOT_KEY);
    if (held) return held;
    const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    session.setItem(RECONNECT_BOOT_KEY, fresh);
    return fresh;
  } catch { return "this-run"; }
}

// One reading of the line for the whole window: the band polls, Needs you and
// the rail door read the same apps and the same wait.
let line: { apps: ReconnectApp[]; away: ReconnectAway; boot: string } = { apps: [], away: NOTHING_AWAY, boot: "" };
let loaded = false;
const listeners = new Set<() => void>();
function setLine(next: typeof line) { line = next; for (const listener of listeners) listener(); }
function current() {
  if (!loaded) { loaded = true; line = { ...line, away: readAway(), boot: readBoot() }; }
  return line;
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/**
 * A new reading from the server. An app that is due again drops its wait (it shows until put away again); one due
 * because Murage started again is noted, so the next start within a day does not remind it again. Apps that no
 * longer need signing in are forgotten.
 */
export function publishReconnectApps(apps: ReconnectApp[], now = Date.now()) {
  const { away, boot } = current();
  const snoozed: Record<string, ReconnectSnooze> = {}, reminded: Record<string, number> = {};
  for (const app of apps) {
    const due = reconnectDue(app, away, boot, now);
    if (due === null) snoozed[app.slug] = away.snoozed[app.slug];
    if (due === "start") reminded[app.slug] = now;
    else if (away.reminded[app.slug] !== undefined) reminded[app.slug] = away.reminded[app.slug];
  }
  const next = { snoozed, reminded };
  if (JSON.stringify(next) !== JSON.stringify(away)) writeAway(next);
  setLine({ apps, away: next, boot });
}

/** The X or Later: every app on the line waits for its reminder. Asks nothing of the server and disconnects nothing. */
export function putReconnectLineAway(now = Date.now()) {
  const { apps, away, boot } = current();
  const snoozed = { ...away.snoozed };
  for (const app of apps) snoozed[app.slug] = { at: now, boot, keys: reconnectAppKeys(app) };
  const next = { snoozed, reminded: away.reminded };
  writeAway(next);
  setLine({ apps, away: next, boot });
}

/** The apps that need signing in again, and whether the band is put away. */
export function useReconnectLine(): { apps: ReconnectApp[]; away: boolean } {
  const state = useSyncExternalStore(subscribe, current, current);
  return { apps: state.apps, away: state.apps.length > 0 && reconnectLineAway(state.away, state.apps, state.boot, Date.now()) };
}

type ReconnectDispatch = Dispatch<{ type: "openConnectorReconnect"; incidentId?: string } | { type: "togglePlugins"; open?: boolean; surface?: "apps" | "mcp"; reconnect?: { slug: string; accountId?: string; alias?: string } }>;
// Reconnect opens Connected apps; the account's Reconnect there asks for
// the label before any sign-in starts.
export function openReconnect(dispatch: ReconnectDispatch, app: ReconnectApp) {
  if (app.incidentId) { dispatch({ type: "openConnectorReconnect", incidentId: app.incidentId }); return; }
  dispatch({ type: "togglePlugins", open: true, surface: app.slug.startsWith("mcp-") ? "mcp" : "apps",
    reconnect: { slug: app.slug, accountId: app.accounts[0]?.id, alias: app.accounts[0]?.alias } });
}

/** Reconnect is offered where a sign-in can start: the computer, or the phone through an app incident. */
export function reconnectOffered(desktop: boolean | undefined, apps: ReadonlyArray<ReconnectApp>): boolean {
  return desktop === true || apps.some(app => app.incidentId && !app.slug.startsWith("mcp-"));
}

const action = "min-h-9 rounded-lg bg-control px-3 py-1 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";

export interface ReconnectAppsBannerViewProps {
  apps: ReadonlyArray<ReconnectApp>;
  /** The slug being reconnected, or null. */
  busy: string | null;
  onReconnect: (app: ReconnectApp) => void;
  /** Reconnect opens a browser sign-in, so it is offered on the computer only. */
  desktop?: boolean;
  problem?: string | null;
  /** Later: put away until the reminder (Murage starting again, or a day). */
  onLater?: () => void;
  /** The X: the same wait as Later. Nothing is ever disconnected. */
  onClose?: () => void;
  /** The band is the top of a Mac window: the window's own buttons sit inset over its left edge. */
  macInset?: boolean;
}

/** The line itself: no state, no requests. Nothing when no app needs it. One row per app, each with its own Reconnect. */
export function ReconnectAppsBannerView({ apps, busy, onReconnect, desktop = true, problem = null, onLater, onClose, macInset = false }: ReconnectAppsBannerViewProps) {
  if (!apps.length) return null;
  // 1.0.20 (owner report): at the top of a Mac window the band drew its first words under the red, yellow and green
  // window buttons. Leave their width free (the sidebar header and the first-run bar clear them the same way) and let
  // the band move the window; its buttons stay click targets (styles.css, data-window-drag).
  return (
    <div role="status" aria-live="polite" data-reconnect-line {...windowDragProps(macInset)} className="flex items-start gap-3 border-b border-hairline/40 bg-raised px-4 py-2 text-[13px] font-medium text-ink">
      {macInset ? <div data-window-buttons-space="" aria-hidden="true" className="w-[68px] shrink-0 self-stretch" /> : null}
      <Link2Off size={14} className="mt-2.5 shrink-0" aria-hidden="true" />
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {apps.map(app => (
          <li key={app.slug} data-reconnect-app={app.slug} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0">{t("connectorHealth.signIn", { connector: app.label })}</span>
            {desktop && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => { onReconnect(app); }}
                className={action}
                aria-label={t("connectorHealth.reconnectApp", { connector: app.label })}
              >
                {apps.length > 1 ? t("connectorHealth.reconnectApp", { connector: app.label }) : t("connectorHealth.reconnect")}
              </button>
            )}
          </li>
        ))}
        {!desktop && <li className="text-ink-secondary">{t("connectorHealth.computer")}</li>}
        {problem && <li className="text-danger">{problem}</li>}
      </ul>
      {(onLater || onClose) && (
        <div className="flex shrink-0 items-center gap-1">
          {onLater && <button type="button" data-reconnect-later onClick={onLater} className={action}>{t("updates.later")}</button>}
          {onClose && (
            <button type="button" data-reconnect-close onClick={onClose} aria-label={t("composer.dismissNotice")} title={t("composer.dismissNotice")}
              className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The way back while the band is away: Needs you lists the apps with their Reconnect. */
export function ReconnectAppsNeedsYou({ dispatch, label }: { dispatch?: ReconnectDispatch; label: string }) {
  const desktop = useDesktopSurface();
  const { apps } = useReconnectLine();
  if (!apps.length || !dispatch) return null;
  return (
    <section aria-label={label} data-reconnect-needs-you className="mt-5 first:mt-0 rounded-xl border border-warning/30 bg-warning/[0.06]">
      <ReconnectAppsBannerView apps={apps} busy={null} desktop={reconnectOffered(desktop, apps)} onReconnect={app => { openReconnect(dispatch, app); }} />
    </section>
  );
}

export function ReconnectAppsBanner({ enabled }: { enabled: boolean }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  const { apps, away } = useReconnectLine();

  const load = useCallback(async () => {
    try {
      const answer = await api(desktop === true ? "/api/connectors/needs-reconnect" : "/api/connector-incidents");
      publishReconnectApps(Array.isArray(answer?.apps) ? answer.apps : []);
      if (desktop === true) for (const frame of (answer.notifications ?? []) as Notification[]) {
        routeNotification({ ...frame }, shown => showNotification(shown as unknown as Notification,
          target => openNotificationTarget(dispatch, target, latest.current)));
      }
    } catch { /* a missed check shows nothing; the next one asks again */ }
  }, [desktop, dispatch]);

  useEffect(() => {
    if (!enabled) { publishReconnectApps([]); return; }
    void load();
    const timer = setInterval(() => { void load(); }, 20_000);
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [enabled, load]);

  if (!enabled || away) return null;
  return <ReconnectAppsBannerView apps={apps} busy={null} desktop={reconnectOffered(desktop, apps)} onReconnect={app => { openReconnect(dispatch, app); }}
    onLater={() => { putReconnectLineAway(); }} onClose={() => { putReconnectLineAway(); }} macInset={isMacInset()} />;
}
