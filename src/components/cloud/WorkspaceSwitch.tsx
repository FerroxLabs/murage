// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: "This computer" / "Cloud home". Shown ONLY when the desktop Cloud flag is on (main registers the cloud-home
// channels only then; loadCloudWorkspace turns a rejection into "off"), and never inside the Cloud window itself.
// 1.0.23 (Sean's top bar): the Cloud flag is not a Cloud plan. The strip shows only for an owner with Cloud in hand, as main
// reports it: a paired home, a Connect under way for an account that owns a Cloud home (a My Cloud link starts one in main), a
// computer that was disconnected, or a Connect/Disconnect just done on the panel. A link by itself proves nothing: it only makes the switch read main again.
// Anyone else sees nothing. "This computer" is the app as it is. "Cloud home" opens the Cloud window for your one paired home, or
// shows the Cloud home view (the Connect panel) IN PLACE of the app, never stacked above it. E1 (PARITYFIX): with one paired
// home the panel is skipped, so once that home opens and says an engine it has is signed out, the Cloud home view opens too.
// On a Mac the strip is the top of the window: it leaves the inset window buttons their room and moves the window; hidden, the same band stays
// (WindowTopInset). The segments are not clipped by their group, so a keyboard focus ring shows whole (inside the button) and only on :focus-visible.
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cloudCopy } from "@/lib/cloud-copy";
import { cloudChoiceAction, cloudHomeBridge, loadCloudWorkspace, type CloudHomeBridge, type CloudWorkspace } from "@/lib/cloud-workspace";
import { CloudReconnectingBannerView, REATTACH_POLL_MS, RECONNECT_GRACE_MS } from "./CloudUnreachableBanner";
import type { SignInRequest } from "./EngineSignIns";
// The Connect panel (and its engine sign-ins) opens on a click, so it loads then, not with the first paint.
const ConnectHome = lazy(() => import("./ConnectHome").then((module) => ({ default: module.ConnectHome })));

export type WorkspaceView = "computer" | "cloud";

/**
 * The app's rail and main view while the Cloud home view stands over them: inert, so Tab, clicks and screen readers cannot reach
 * what is covered. `display: contents` keeps them laid out as direct children of App's main area.
 */
export function AppUnderCloud({ covered, children }: { covered: boolean; children: ReactNode }) {
  return <div data-app-under-cloud="" style={{ display: "contents" }} inert={covered || undefined}>{children}</div>;
}

/**
 * The top of the window when the strip is hidden: on a Mac the inset window buttons still need their room and the window still
 * needs a handle, so the strip's own band stays (same height, no switch in it). Elsewhere the window's own title bar is the top.
 */
export function WindowTopInset({ macInset }: { macInset: boolean }) {
  if (!macInset) return null;
  return (
    <div data-window-inset="" data-window-drag="" className="flex min-h-11 shrink-0 items-center gap-2 px-3 py-2">
      <div data-window-buttons-space="" aria-hidden="true" className="w-[68px] shrink-0 self-stretch" />
    </div>
  );
}

export function WorkspaceSwitchView({ view, onComputer, onCloud, macInset = false }: { view: WorkspaceView; onComputer(): void; onCloud(): void; macInset?: boolean }) {
  const base = "px-3 py-1 text-[13px] font-medium";
  // The chosen segment is the brighter one with full-white text (a step up from the track in dark; the strongest fill in light);
  // the other is transparent with muted text.
  const tone = (on: boolean) => (on ? "bg-hairline text-white [[data-skin=light]_&]:bg-ink" : "bg-transparent text-ink-secondary hover:text-ink");
  return (
    <div data-workspace-strip="" data-window-drag={macInset ? "" : undefined} className="flex min-h-11 shrink-0 items-center gap-2 px-3 py-2">
      {macInset ? <div data-window-buttons-space="" aria-hidden="true" className="w-[68px] shrink-0 self-stretch" /> : null}
      <div role="group" aria-label="Workspace" className="inline-flex rounded-md bg-control">
        <button type="button" aria-pressed={view === "computer" ? "true" : "false"} onClick={onComputer} className={`${base} rounded-l-md ${tone(view === "computer")}`}>{cloudCopy.switchComputer}</button>
        <button type="button" aria-pressed={view === "cloud" ? "true" : "false"} onClick={onCloud} className={`${base} rounded-r-md ${tone(view === "cloud")}`}>{cloudCopy.switchCloudHome}</button>
      </div>
    </div>
  );
}

/**
 * `onViewChange(true)` while the Cloud home view stands in for the app. `cloudSlot` is where that view goes: App's layer over
 * its main area, under its dialogs, rings and toasts. Without a slot the view follows the strip (order-last: where the main area sits).
 */
export function WorkspaceSwitch({ bridge = cloudHomeBridge(), macInset = false, onViewChange, cloudSlot = null }: { bridge?: CloudHomeBridge; macInset?: boolean; onViewChange?(cloud: boolean): void; cloudSlot?: HTMLElement | null }) {
  const [workspace, setWorkspace] = useState<CloudWorkspace>({ enabled: false });
  const [view, setView] = useState<WorkspaceView>("computer");
  // Main said this owner has Cloud: a Connect under way, a disconnect, or a Connect/Disconnect done on the panel.
  const [cloudInHand, setCloudInHand] = useState(false);
  // What the last read of main said, not latched: a Connect under way or its result shown, or a Cloud plan. A cancelled Connect ends it.
  const [connectLive, setConnectLive] = useState(false);
  const [planOwned, setPlanOwned] = useState(false);
  const [error, setError] = useState("");
  const [openingHome, setOpeningHome] = useState<string | null>(null);
  const [signInRequest, setSignInRequest] = useState<SignInRequest | null>(null);
  const reload = useCallback(() => { void loadCloudWorkspace(bridge).then(setWorkspace); }, [bridge]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => bridge?.onLive?.(() => reload()), [bridge, reload]);
  // This computer was disconnected (from the Cloud window's Settings, or from My Cloud): show the Connect panel.
  useEffect(() => bridge?.onShowConnect?.(() => { reload(); setCloudInHand(true); setView("cloud"); }), [bridge, reload]);
  // The Cloud window asked for a new bot's engine sign-in: show the Connect panel, which opens it.
  useEffect(() => bridge?.onSignInRequested?.((request) => { reload(); setCloudInHand(true); setView("cloud"); setSignInRequest(request); }), [bridge, reload]);
  // A Cloud link main handled (connect-cloud, a door link, an open-cloud for a home not connected here): show the card.
  // A link is not proof of Cloud: read main again (a My Cloud link has started a Connect there, a door link paired a home).
  const [linkSeen, setLinkSeen] = useState(0);
  useEffect(() => bridge?.onLinkEvent?.((event) => { reload(); setLinkSeen((n) => n + 1); if (event.kind !== "open-cloud") setView("cloud"); }), [bridge, reload]);
  // A window opened after a disconnect also lands on the Connect panel. A Connect under way, or the result of one still shown,
  // keeps the strip up (Use copied link lives in the Cloud home view). A signed-in account with a Cloud plan (the control plane
  // lists a home it owns) sees the strip before it has paired anything.
  const signedIn = workspace.enabled && workspace.cpSignedIn;
  useEffect(() => {
    if (!bridge || !workspace.enabled || workspace.paired.length > 0) return;
    let alive = true;
    void bridge.connectStatus().then((status) => {
      if (!alive || !status) return;
      if (status.disconnected) { setCloudInHand(true); setView("cloud"); return; }
      setConnectLive(Boolean(status.pending || status.lastResult));
    }, () => {});
    if (signedIn) void Promise.resolve(bridge.listHomes?.()).then((homes) => { if (alive) setPlanOwned(Array.isArray(homes) && homes.length > 0); }, () => { if (alive) setPlanOwned(false); });
    else setPlanOwned(false);
    return () => { alive = false; };
  }, [bridge, workspace, signedIn, linkSeen]);
  // Connected or disconnected on the panel: Cloud in hand, so the last home going away leaves the panel where it is.
  const panelChanged = useCallback(() => { setCloudInHand(true); reload(); }, [reload]);
  useEffect(() => {
    if (!bridge || !openingHome) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Timers and this deadline use elapsed time, so changing the system clock cannot prolong startup grace.
    const deadline = performance.now() + RECONNECT_GRACE_MS;
    const finish = (message = "") => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      clearTimeout(expiry);
      setError(message);
      setOpeningHome(null);
    };
    const expiry = setTimeout(() => finish(cloudCopy.homeUnreachable), RECONNECT_GRACE_MS);
    const attempt = async () => {
      try {
        const result = await bridge.open(openingHome, true);
        if (stopped) return;
        if (result.opened) {
          finish();
          // E1: the Cloud window cannot sign an engine in (the terminal runs here). Once the home opened, show this
          // computer's sign-in rows beside it when the home says an engine it has is signed out.
          const opened = openingHome;
          void Promise.resolve(bridge.listEngines?.(opened)).then(
            (engines) => { if (Array.isArray(engines) && engines.some((entry) => entry.installed && !entry.signedIn)) setView("cloud"); },
            () => {},
          );
          return;
        }
        if (performance.now() >= deadline) { finish(cloudCopy.homeUnreachable); return; }
        retry = setTimeout(() => void attempt(), REATTACH_POLL_MS);
      } catch (cause) {
        if (!stopped) finish(cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again.");
      }
    };
    void attempt();
    return () => { stopped = true; clearTimeout(expiry); if (retry !== undefined) clearTimeout(retry); };
  }, [bridge, openingHome]);
  const shown = Boolean(bridge) && workspace.enabled && (workspace.paired.length > 0 || cloudInHand || connectLive || planOwned);
  const cloudView = shown && view === "cloud";
  useEffect(() => { if (!shown) setView("computer"); }, [shown]);
  const viewChanged = useRef(onViewChange);
  viewChanged.current = onViewChange;
  useEffect(() => { viewChanged.current?.(cloudView); }, [cloudView]);
  useEffect(() => () => viewChanged.current?.(false), []);
  if (!bridge || !shown) return <WindowTopInset macInset={macInset} />;

  const chooseCloud = () => {
    const action = cloudChoiceAction(workspace);
    if (action.kind === "pair") { setView("cloud"); return; }
    if (openingHome) return;
    setError("");
    setOpeningHome(action.homeId);
  };
  const cloudHomeView = cloudView ? (
    <section aria-label={cloudCopy.switchCloudHome} data-cloud-home-view="" className="order-last flex min-h-0 flex-1 justify-center overflow-auto p-6">
      <div className="w-full max-w-md">
        <Suspense fallback={null}><ConnectHome bridge={bridge} paired={workspace.paired} onChanged={panelChanged} onCancelled={reload} signInRequest={signInRequest} onSignInRequestHandled={() => setSignInRequest(null)} /></Suspense>
      </div>
    </section>
  ) : null;
  return (
    <>
      <div className="flex shrink-0 flex-col">
        <WorkspaceSwitchView view={cloudView ? "cloud" : "computer"} onComputer={() => setView("computer")} onCloud={chooseCloud} macInset={macInset} />
        {openingHome ? <div className="px-3 pb-2"><CloudReconnectingBannerView /></div> : null}
        {error ? <p role="alert" className="px-3 pb-2 text-[13px] text-danger">{error}</p> : null}
      </div>
      {/* The Cloud home view takes the app's place; the app stays mounted under it. */}
      {cloudHomeView && cloudSlot ? createPortal(cloudHomeView, cloudSlot) : cloudHomeView}
    </>
  );
}
