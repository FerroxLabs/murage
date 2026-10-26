// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Devices on a Cloud home opened in a browser: the browsers and computers connected to this home, this one marked,
// each one's owner state (an owner, an owner until a date, or chat only), and two one-click actions: make an owner browser
// chat-only, and disconnect this browser. Other devices are removed on the owner's Murage Cloud page.
import { useEffect, useState } from "react";
import { bindOf, forgetThisBrowser, listDevices, loadDevice, makeChatOnly, type HomeDevice } from "@/lib/cloud-door";

export const DEVICES_COPY = {
  thisBrowser: "This browser",
  forget: "Forget this browser",
  makeChatOnly: "Make chat-only",
  owner: "Owner",
  ownerUntil: "Owner until",
  chatOnly: "Chat only",
  removeOthers: "Remove other devices on your Murage Cloud page under Devices.",
  empty: "No devices to show yet.",
  failed: "Could not load your devices. Try again in a moment.",
} as const;

const label = (device: HomeDevice) => (device.scope === "desktop" ? "Computer" : "Browser");
/** The owner state the row reads: an owner until a date (remembered-owner), an owner with no expiry (passkey), or chat only. */
export function factorText(device: HomeDevice): string {
  if (device.factor === "remembered-owner") return device.factorExpiresAt ? `${DEVICES_COPY.ownerUntil} ${new Date(device.factorExpiresAt).toLocaleDateString()}` : DEVICES_COPY.owner;
  if (device.factor === "passkey") return DEVICES_COPY.owner;
  return DEVICES_COPY.chatOnly;
}

export function CloudDevicesSettingsView({ devices, mine, failed, busy, onForget, onMakeChatOnly }: {
  devices: HomeDevice[] | null; mine: string | null; failed: boolean; busy: boolean; onForget(): void; onMakeChatOnly(deviceId: string): void;
}) {
  return (
    <div className="space-y-3">
      {failed ? <p className="text-[12.5px] text-ink-secondary" role="alert">{DEVICES_COPY.failed}</p> : null}
      {devices && devices.length === 0 ? <p className="text-[12.5px] text-ink-secondary">{DEVICES_COPY.empty}</p> : null}
      {devices ? <ul className="space-y-1.5">{devices.map(device => (
        <li key={device.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span className="flex flex-col">
            <span>{label(device)}{mine && device.keyHash === mine ? <strong className="ml-2 text-[12px] font-medium">{DEVICES_COPY.thisBrowser}</strong> : null}</span>
            <span className="text-[12px] text-ink-secondary">{factorText(device)}</span>
          </span>
          <span className="flex items-center gap-3">
            {device.factor === "remembered-owner" ? (
              <button type="button" disabled={busy} onClick={() => onMakeChatOnly(device.id)} className="min-h-8 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">{DEVICES_COPY.makeChatOnly}</button>
            ) : null}
            <span className="text-[12px] text-ink-secondary">{device.lastSeenAt ? `Last used ${new Date(device.lastSeenAt).toLocaleDateString()}` : ""}</span>
          </span>
        </li>))}</ul> : null}
      <button type="button" disabled={busy} onClick={onForget} className="min-h-9 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50">{DEVICES_COPY.forget}</button>
      <p className="text-[12px] text-ink-secondary">{DEVICES_COPY.removeOthers}</p>
    </div>
  );
}

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
  const chatOnly = async (deviceId: string) => {
    setBusy(true); setFailed(false);
    if (await makeChatOnly(deviceId)) { const listed = await listDevices(); if (listed) setDevices(listed.devices); else setFailed(true); }
    else setFailed(true);
    setBusy(false);
  };
  return <CloudDevicesSettingsView devices={devices} mine={mine} failed={failed} busy={busy} onForget={() => { void forget(); }} onMakeChatOnly={(id) => { void chatOnly(id); }} />;
}
