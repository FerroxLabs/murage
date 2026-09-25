import { useEffect, useState } from "react";

import { afterSignOut, signOutThisDevice } from "../lib/remote-sign-out";
import { doorSessionConfirmed } from "../lib/session-check";
import { Card } from "./SettingsPrimitives";

/** Shown only once the door's `GET /session` has answered for this device.
 * A plain browser at the harness's own port is `desktop === false` too, but
 * has no door and no device to sign out; there the button could only fail
 * with "no such route" (final review M9). */
export function RemoteSignOut() {
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    let live = true;
    void doorSessionConfirmed().then((confirmed) => {
      if (live) setPaired(confirmed);
    });
    return () => {
      live = false;
    };
  }, []);
  return paired ? <RemoteSignOutCard /> : null;
}

/** The one piece of device management that belongs on the device: removing
 * itself. Everything else about paired devices lives on the computer.
 *
 * Two taps, because the way back is a QR code on a computer that may be at
 * home. */
export function RemoteSignOutCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    const result = await signOutThisDevice();
    if (result.ok) {
      await afterSignOut();
      return;
    }
    setBusy(false);
    setError(result.error);
  };

  return (
    <Card
      title="This device"
      subtitle="Removes this device from your computer. To use Murage here again, scan the code in Settings → Phone on the computer."
    >
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="min-h-11 rounded-lg bg-danger px-4 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="min-h-11 rounded-lg px-4 text-[13px] text-ink-secondary hover:bg-control disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-11 rounded-lg border border-hairline/60 px-4 text-[13px] text-danger hover:bg-control"
        >
          Sign out this device
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
