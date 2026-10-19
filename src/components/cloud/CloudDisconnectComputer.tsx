// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud Door v2 (design 2.5.4): "Disconnect this computer" in the Cloud window's own Settings. Main revokes this computer at
// the home (with the usual confirmation on this computer), forgets it, closes this window and shows the Connect panel in
// the local window. Renders only inside the Cloud window of the desktop app.
import { useState } from "react";

import { cloudCopy } from "@/lib/cloud-copy";
import { isCloudOrigin } from "@/lib/cloud-workspace";

export const DISCONNECT_COPY = {
  title: "This computer",
  subtitle: "This computer is connected to this Cloud home.",
  detail: "Disconnecting removes this computer from your Cloud home. You can connect it again from the Cloud home switch.",
  failed: "Could not disconnect this computer. Try again.",
  done: "Disconnected. Returning to Connect.",
} as const;

type Bridge = { disconnectThisComputer?: () => Promise<{ disconnected: true }> } | undefined;

export function cloudDisconnectBridge(): Bridge {
  if (typeof window === "undefined" || !isCloudOrigin()) return undefined;
  return window.muragecloud?.disconnectThisComputer ? window.muragecloud : undefined;
}

export function CloudDisconnectComputerView({ busy, error, done, onDisconnect }: { busy: boolean; error: string; done: boolean; onDisconnect(): void }) {
  return (
    <div className="space-y-2">
      <p className="text-[12.5px] text-ink-secondary">{DISCONNECT_COPY.detail}</p>
      <button type="button" disabled={busy || done} onClick={onDisconnect} className="min-h-9 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">{cloudCopy.connectDisconnect}</button>
      {done ? <p role="status" className="text-[12.5px] text-ink-secondary">{DISCONNECT_COPY.done}</p> : null}
      {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
    </div>
  );
}

export function CloudDisconnectComputer({ bridge = cloudDisconnectBridge() }: { bridge?: Bridge }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  if (!bridge?.disconnectThisComputer) return null;
  const disconnect = async () => {
    setBusy(true); setError("");
    try { await bridge.disconnectThisComputer!(); setDone(true); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : DISCONNECT_COPY.failed); }
    finally { setBusy(false); }
  };
  return <CloudDisconnectComputerView busy={busy} error={error} done={done} onDisconnect={() => { void disconnect(); }} />;
}
