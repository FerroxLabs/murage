// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Devices on a Cloud home opened in a browser: the browsers and computers connected to this home, this one marked,
// and a way to disconnect this browser. Other devices are removed on the owner's Murage Cloud page.
import { useEffect, useState } from "react";
import { bindOf, forgetThisBrowser, listDevices, loadDevice, type HomeDevice } from "@/lib/cloud-door";

export const DEVICES_COPY = {
  thisBrowser: "This browser",
  forget: "Forget this browser",
  removeOthers: "Remove other devices on your Murage Cloud page under Devices.",
  empty: "No devices to show yet.",
  failed: "Could not load your devices. Try again in a moment.",
} as const;

const label = (device: HomeDevice) => (device.scope === "desktop" ? "Computer" : "Browser");

export function CloudDevicesSettings() {
  const [devices, setDevices] = useState<HomeDevice[] | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [listed, stored] = await Promise.all([listDevices(), loadDevice()]);
      const bind = stored?.publicKey ? await bindOf({ publicKey: stored.publicKey }).catch(() => null) : null;
      if (!alive) return;
      if (!listed) return setFailed(true);
      setDevices(listed.devices); setMine(bind);
    })();
    return () => { alive = false; };
  }, []);
  const forget = async () => {
    setBusy(true);
    const done = await forgetThisBrowser();
    if (done) location.assign("/"); else { setBusy(false); setFailed(true); }
  };
  return (
    <div className="space-y-3">
      {failed ? <p className="text-[12.5px] text-ink-secondary" role="alert">{DEVICES_COPY.failed}</p> : null}
      {devices && devices.length === 0 ? <p className="text-[12.5px] text-ink-secondary">{DEVICES_COPY.empty}</p> : null}
      {devices ? <ul className="space-y-1.5">{devices.map(device => (
        <li key={device.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span>{label(device)}{mine && device.keyHash === mine ? <strong className="ml-2 text-[12px] font-medium">{DEVICES_COPY.thisBrowser}</strong> : null}</span>
          <span className="text-[12px] text-ink-secondary">{device.lastSeenAt ? `Last used ${new Date(device.lastSeenAt).toLocaleDateString()}` : ""}</span>
        </li>))}</ul> : null}
      <button type="button" disabled={busy} onClick={() => { void forget(); }} className="min-h-9 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">{DEVICES_COPY.forget}</button>
      <p className="text-[12px] text-ink-secondary">{DEVICES_COPY.removeOthers}</p>
    </div>
  );
}
