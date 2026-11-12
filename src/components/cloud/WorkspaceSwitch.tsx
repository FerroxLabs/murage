// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: "This computer" / "Cloud home". Shown ONLY when the desktop Cloud flag is on (main registers the cloud-home
// channels only then; loadCloudWorkspace turns a rejection into "off"), and never inside the Cloud window itself.
// "This computer" is where you already are. "Cloud home" opens the Cloud window for your one paired home, or shows the
// Connect panel when there is none (or several to choose from).
import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { cloudCopy } from "@/lib/cloud-copy";
import { cloudChoiceAction, cloudHomeBridge, loadCloudWorkspace, type CloudHomeBridge, type CloudWorkspace } from "@/lib/cloud-workspace";
import { CloudReconnectingBannerView, REATTACH_POLL_MS, RECONNECT_GRACE_MS } from "./CloudUnreachableBanner";
// The Connect panel (and its engine sign-ins) opens on a click, so it loads then, not with the first paint.
const ConnectHome = lazy(() => import("./ConnectHome").then((module) => ({ default: module.ConnectHome })));

export function WorkspaceSwitchView({ onCloud, pairing }: { onCloud(): void; pairing: boolean }) {
  const base = "px-3 py-1 text-[13px] font-medium";
  return (
    <div role="group" aria-label="Workspace" className="inline-flex overflow-hidden rounded-md bg-control">
      <button type="button" aria-pressed="true" className={`${base} bg-inset text-ink`}>{cloudCopy.switchComputer}</button>
      <button type="button" aria-pressed={pairing ? "true" : "false"} onClick={onCloud} className={`${base} text-ink-secondary hover:text-ink`}>{cloudCopy.switchCloudHome}</button>
    </div>
  );
}

export function WorkspaceSwitch({ bridge = cloudHomeBridge() }: { bridge?: CloudHomeBridge }) {
  const [workspace, setWorkspace] = useState<CloudWorkspace>({ enabled: false });
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");
  const [openingHome, setOpeningHome] = useState<string | null>(null);
  const [signInRequest, setSignInRequest] = useState<{ homeId: string; bot: string; engine: string } | null>(null);
  const reload = useCallback(() => { void loadCloudWorkspace(bridge).then(setWorkspace); }, [bridge]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => bridge?.onLive?.(() => reload()), [bridge, reload]);
  // This computer was disconnected (from the Cloud window's Settings, or from My Cloud): show the Connect panel.
  useEffect(() => bridge?.onShowConnect?.(() => { reload(); setPairing(true); }), [bridge, reload]);
  // The Cloud window asked for a new bot's engine sign-in: show the Connect panel, which opens it.
  useEffect(() => bridge?.onSignInRequested?.((request) => { reload(); setPairing(true); setSignInRequest(request); }), [bridge, reload]);
  // A Cloud link main handled (connect-cloud, a door link, an open-cloud for a home not connected here): show the card.
  useEffect(() => bridge?.onLinkEvent?.((event) => { reload(); if (event.kind !== "open-cloud") setPairing(true); }), [bridge, reload]);
  // A window opened after a disconnect also lands on the Connect panel.
  useEffect(() => {
    if (!bridge || !workspace.enabled || workspace.paired.length > 0) return;
    let alive = true;
    void bridge.connectStatus().then((status) => { if (alive && status?.disconnected) setPairing(true); }, () => {});
    return () => { alive = false; };
  }, [bridge, workspace]);
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
        if (result.opened) { finish(); return; }
        if (performance.now() >= deadline) { finish(cloudCopy.homeUnreachable); return; }
        retry = setTimeout(() => void attempt(), REATTACH_POLL_MS);
      } catch (cause) {
        if (!stopped) finish(cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again.");
      }
    };
    void attempt();
    return () => { stopped = true; clearTimeout(expiry); if (retry !== undefined) clearTimeout(retry); };
  }, [bridge, openingHome]);
  if (!bridge || !workspace.enabled) return null;

  const chooseCloud = () => {
    const action = cloudChoiceAction(workspace);
    if (action.kind === "pair") { setPairing((open) => !open); return; }
    if (openingHome) return;
    setError("");
    setOpeningHome(action.homeId);
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <WorkspaceSwitchView onCloud={chooseCloud} pairing={pairing} />
      {openingHome ? <CloudReconnectingBannerView /> : null}
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      {pairing ? <Suspense fallback={null}><ConnectHome bridge={bridge} paired={workspace.paired} onChanged={reload} signInRequest={signInRequest} onSignInRequestHandled={() => setSignInRequest(null)} /></Suspense> : null}
    </div>
  );
}
