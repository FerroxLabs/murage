// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the Cloud window's "Your Cloud home isn't reachable". While it shows, every write fails at once (main's proxy
// answers 502 the moment the home does not answer) and NOTHING is queued or replayed when the home comes back: this banner
// says so. It only ever READS reachability from main; it never re-sends anything.
//
// Door v2: after the computer wakes from sleep or the network changes, main reattaches this computer to its home by
// itself. For that short while the banner says "Reconnecting to your Cloud home" instead. Only a refused sign-in
// ("disconnected", the home said this computer was removed) ends it another way: main closes this window and the local
// window shows the Connect panel. A paused account ("suspended") keeps this computer connected and says so.
import { PlugZap, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { cloudCopy } from "@/lib/cloud-copy";
import { checkReachable, isCloudOrigin, type Reachability } from "@/lib/cloud-workspace";

export const REACHABLE_POLL_MS = 30_000;
export const UNREACHABLE_POLL_MS = 8_000;
/** How long after a wake or a network change a failed answer still reads as "reconnecting". */
export const REATTACH_WINDOW_MS = 60_000;
export const REATTACH_POLL_MS = 3_000;
/** A heartbeat that arrives this late means the computer was asleep. */
export const WAKE_HEARTBEAT_MS = 5_000;
export const WAKE_GAP_MS = 30_000;

/** Pure: how long to wait before asking again. */
export const nextReachabilityCheckMs = (reachable: boolean, reattaching = false) => (reachable ? REACHABLE_POLL_MS : reattaching ? REATTACH_POLL_MS : UNREACHABLE_POLL_MS);

export type BannerState = { kind: "ok" } | { kind: "reconnecting" } | { kind: "unreachable"; message?: string } | { kind: "disconnected" } | { kind: "suspended"; message: string };

/** Pure: what the banner shows for main's answer, given until when a reattach is under way. */
export function bannerState(answer: Reachability, reattachingUntil: number, now: number): BannerState {
  if (answer.ok) return { kind: "ok" };
  if (answer.code === "disconnected") return { kind: "disconnected" };
  // The account is paused: this computer stays connected and comes back by itself.
  if (answer.code === "suspended") return { kind: "suspended", message: answer.message };
  if (now < reattachingUntil) return { kind: "reconnecting" };
  return { kind: "unreachable", message: answer.message };
}

/** Pure: a heartbeat this late means the computer slept in between. */
export const wokeFromSleep = (lastBeat: number, now: number) => now - lastBeat > WAKE_GAP_MS;

export function CloudUnreachableBannerView({ message }: { message?: string }) {
  return (
    <div role="alert" aria-live="assertive" className="flex items-center justify-center gap-2 bg-danger px-4 py-2 text-[13px] font-medium text-white">
      <PlugZap size={14} className="shrink-0" aria-hidden="true" />
      <span>{cloudCopy.homeUnreachable}. {cloudCopy.homeUnreachableDetail}{message && message !== cloudCopy.homeUnreachable ? ` (${message})` : ""}</span>
    </div>
  );
}

export function CloudReconnectingBannerView({ text = cloudCopy.reconnecting }: { text?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 bg-control px-4 py-2 text-[13px] font-medium text-ink">
      <RefreshCw size={14} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** Renders nothing outside a Cloud window, and nothing while the home answers. */
export function CloudUnreachableBanner() {
  const [state, setState] = useState<BannerState>({ kind: "ok" });
  const cloud = isCloudOrigin();
  useEffect(() => {
    if (!cloud) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reattachingUntil = 0;
    const tick = async () => {
      const answer = await checkReachable();
      if (stopped) return;
      const next = bannerState(answer, reattachingUntil, Date.now());
      setState(next);
      if (answer.ok) reattachingUntil = 0;
      if (next.kind === "disconnected") return; // main closes this window and shows the Connect panel
      timer = setTimeout(() => void tick(), nextReachabilityCheckMs(answer.ok, next.kind === "reconnecting"));
    };
    // After a wake or a network change: say "Reconnecting" and ask at once, so main reattaches this computer without a click.
    const reattach = () => {
      reattachingUntil = Date.now() + REATTACH_WINDOW_MS;
      setState((current) => (current.kind === "ok" ? current : { kind: "reconnecting" }));
      if (timer) clearTimeout(timer);
      void tick();
    };
    void tick();
    let lastBeat = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (wokeFromSleep(lastBeat, now)) reattach();
      lastBeat = now;
    }, WAKE_HEARTBEAT_MS);
    window.addEventListener("online", reattach);
    window.addEventListener("offline", reattach);
    return () => {
      stopped = true; if (timer) clearTimeout(timer); clearInterval(heartbeat);
      window.removeEventListener("online", reattach); window.removeEventListener("offline", reattach);
    };
  }, [cloud]);
  if (!cloud || state.kind === "ok") return null;
  if (state.kind === "reconnecting") return <CloudReconnectingBannerView />;
  if (state.kind === "disconnected") return <CloudReconnectingBannerView text={cloudCopy.disconnected} />;
  if (state.kind === "suspended") return <CloudReconnectingBannerView text={state.message} />;
  return <CloudUnreachableBannerView message={state.message} />;
}
